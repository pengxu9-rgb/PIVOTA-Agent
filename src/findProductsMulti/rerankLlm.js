const vertexGemini = require('../llm/vertexGemini');
const fs = require('fs');
const path = require('path');

const axios = require('axios');
const OpenAI = require('openai');
const logger = require('../logger');
const {
  resolveFindProductsGeminiApiKey,
  resolveFindProductsLlmRuntime,
  resolveFindProductsOpenAiApiKey,
} = require('./llmRuntime');
const { resolveNonImageGeminiModel } = require('../lib/geminiModelFloor');
const {
  acquireModelCall,
  isModelBreakerOpen,
  recordModelFailure,
  recordModelSuccess,
} = require('./llmModelBreaker');

const DEFAULT_PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'product_rerank_prompt_v1.txt');
// OpenAI model for the rerank pass: PIVOTA_RERANK_MODEL_OPENAI, else the legacy shared PIVOTA_RERANK_MODEL, else
// the built-in default. The default is NOT known to exist for every OpenAI-compatible endpoint — when the
// provider answers model-not-found, the breaker in ./llmModelBreaker skips this provider until its cooldown
// probe (one WARN per opening, no per-search retries) and the search keeps its deterministic order. Set
// PIVOTA_RERANK_MODEL_OPENAI to a model the configured endpoint serves to turn the pass back on.
const DEFAULT_MODEL_OPENAI =
  process.env.PIVOTA_RERANK_MODEL_OPENAI || process.env.PIVOTA_RERANK_MODEL || 'gpt-5.1-mini';
const DEFAULT_MODEL_GEMINI = resolveNonImageGeminiModel({
  model: process.env.PIVOTA_RERANK_MODEL_GEMINI || process.env.PIVOTA_RERANK_MODEL,
  fallbackModel: 'gemini-3-flash-preview',
  envSource: process.env.PIVOTA_RERANK_MODEL_GEMINI ? 'PIVOTA_RERANK_MODEL_GEMINI' : 'PIVOTA_RERANK_MODEL',
  callPath: 'find_products_rerank',
}).effectiveModel;

const MAX_CANDIDATES_PER_SOURCE = Math.min(
  200,
  Math.max(10, Number(process.env.FIND_PRODUCTS_MULTI_RERANK_LLM_MAX_CANDIDATES || 60))
);
const MAX_OUTPUT_ITEMS = Math.min(
  50,
  Math.max(5, Number(process.env.FIND_PRODUCTS_MULTI_RERANK_LLM_MAX_OUTPUT || 20))
);
// Hard per-provider deadline. Without this the OpenAI SDK default applies
// (600s + retries), which turns a slow rerank into a multi-minute
// find_products_multi response; the rerank is an optional quality pass and
// must fail open fast.
const RERANK_LLM_TIMEOUT_MS = Math.min(
  15_000,
  Math.max(500, Number(process.env.PIVOTA_RERANK_LLM_TIMEOUT_MS || 2500) || 2500)
);

function isEnabled() {
  return resolveFindProductsLlmRuntime('rerank').enabled;
}

let cachedPrompt = null;
function loadPromptTemplate() {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = process.env.FIND_PRODUCTS_MULTI_RERANK_LLM_PROMPT_PATH || DEFAULT_PROMPT_PATH;
  cachedPrompt = fs.readFileSync(promptPath, 'utf8');
  return cachedPrompt;
}

function getOpenAIClient() {
  const apiKey = resolveFindProductsOpenAiApiKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY or LLM_API_KEY is not set');
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  return new OpenAI({
    apiKey,
    timeout: RERANK_LLM_TIMEOUT_MS,
    maxRetries: 0,
    ...(baseURL ? { baseURL } : {}),
  });
}

function getProviderChain() {
  const runtime = resolveFindProductsLlmRuntime('rerank');
  return Array.isArray(runtime.providerChain) && runtime.providerChain.length
    ? runtime.providerChain
    : ['openai'];
}

function modelForProvider(provider) {
  if (provider === 'openai') return DEFAULT_MODEL_OPENAI;
  if (provider === 'gemini') return DEFAULT_MODEL_GEMINI;
  return null;
}

const MODEL_ENV_HINT = Object.freeze({
  openai: 'PIVOTA_RERANK_MODEL_OPENAI',
  gemini: 'PIVOTA_RERANK_MODEL_GEMINI',
});

const BREAKER_FEATURE = 'rerank';

function breakerOpenFor(provider) {
  return isModelBreakerOpen(BREAKER_FEATURE, provider, modelForProvider(provider));
}

// The chain minus any provider whose configured model the provider already said does not exist.
function liveProviderChain() {
  return getProviderChain().filter((provider) => !breakerOpenFor(provider));
}

// When a fallback provider is still live, the provider before it gets this share of the remaining budget, so
// the fallback is not handed an already-spent deadline. A single-provider chain keeps the full budget.
const PRIMARY_BUDGET_SHARE = 0.6;

function getProductId(product) {
  return String(product?.product_id || product?.productId || product?.id || '').trim();
}

function classifySource(product) {
  const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
  const source = String(product?.source || '').trim();
  const rankingSource = String(product?.ranking_features?.source || '').trim();
  if (merchantId === 'external_seed' || source === 'external_seed' || rankingSource === 'external_seed') return 'external';
  return 'internal';
}

function compactProduct(product) {
  const product_id = getProductId(product);
  const title = String(product?.title || product?.name || '').trim();
  const brandName =
    String(product?.brand?.name || product?.brand?.brand_name || product?.brand || product?.vendor || '').trim() ||
    null;
  const vendor = String(product?.vendor || '').trim() || null;
  const category =
    String(product?.category?.name || product?.category || product?.product_type || product?.productType || '').trim() ||
    null;

  const availabilityStatus = String(product?.availability?.status || '').trim() || null;
  const inStock =
    typeof product?.in_stock === 'boolean'
      ? product.in_stock
      : typeof product?.inStock === 'boolean'
        ? product.inStock
        : availabilityStatus
          ? availabilityStatus !== 'OUT_OF_STOCK'
          : null;

  const priceAmount =
    product?.price?.amount ??
    product?.price?.value ??
    product?.price_amount ??
    product?.priceAmount ??
    product?.price ??
    null;
  const priceCurrency =
    String(product?.price?.currency || product?.currency || product?.price_currency || '').trim() || null;
  const priceDisplay =
    String(product?.price?.display || product?.price_display || product?.priceDisplay || '').trim() || null;

  const tagsRaw = product?.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .map((t) => String(t || '').trim())
        .filter(Boolean)
        .slice(0, 20)
    : null;

  return {
    product_id,
    title: title || null,
    brand: brandName,
    vendor,
    category,
    price: {
      amount: typeof priceAmount === 'number' ? priceAmount : priceAmount != null ? Number(priceAmount) : null,
      currency: priceCurrency,
      display: priceDisplay,
    },
    in_stock: inStock,
    availability_status: availabilityStatus,
    ...(tags && tags.length ? { tags } : {}),
  };
}

function splitCandidates(products) {
  const internal = [];
  const external = [];
  for (const p of products || []) {
    const pid = getProductId(p);
    if (!pid) continue;
    const src = classifySource(p);
    const compact = compactProduct(p);
    if (!compact.product_id) continue;
    if (src === 'external') external.push(compact);
    else internal.push(compact);
  }
  return {
    internal: internal.slice(0, MAX_CANDIDATES_PER_SOURCE),
    external: external.slice(0, MAX_CANDIDATES_PER_SOURCE),
  };
}

function safeJsonStringify(value, maxChars = 120_000) {
  let out = '';
  try {
    out = JSON.stringify(value);
  } catch {
    out = '[]';
  }
  if (out.length > maxChars) {
    // Trim oversized payloads to avoid blowing model limits.
    return out.slice(0, maxChars) + '…';
  }
  return out;
}

function cleanRerankProvenance(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, 240) : null;
}

function buildPrompt({ userQuery, n, internalProductsJson, externalProductsJson }) {
  const template = loadPromptTemplate();
  return String(template || '')
    .replace('{user_query}', String(userQuery || ''))
    .replace('{N}', String(n))
    .replace('{internal_products_json}', internalProductsJson)
    .replace('{external_products_json}', externalProductsJson);
}

function parseRerankResponse(raw) {
  const obj = raw && typeof raw === 'object' ? raw : null;
  const items = Array.isArray(obj?.items) ? obj.items : [];
  return items
    .map((it) => ({
      product_id: String(it?.product_id || '').trim(),
      source: String(it?.source || '').trim(),
      reason: typeof it?.reason === 'string' ? it.reason : null,
      rationale: cleanRerankProvenance(it?.rationale),
      criteria: cleanRerankProvenance(it?.criteria),
    }))
    .filter((it) => Boolean(it.product_id) && (it.source === 'internal' || it.source === 'external'));
}

function applyRerankToProducts(products, rerankedItems, limit) {
  const byId = new Map();
  for (const p of products || []) {
    const pid = getProductId(p);
    if (!pid) continue;
    if (!byId.has(pid)) byId.set(pid, p);
  }

  const ordered = [];
  const seen = new Set();
  for (const it of rerankedItems) {
    if (ordered.length >= limit) break;
    const pid = it.product_id;
    if (!pid || seen.has(pid)) continue;
    const p = byId.get(pid);
    if (!p) continue;
    seen.add(pid);
    const rerankRationale = it.rationale || it.criteria || null;
    ordered.push(rerankRationale ? { ...p, rerank_rationale: rerankRationale } : p);
  }

  // Preserve the remainder in original order (stable) so pagination/total stays intact.
  for (const p of products || []) {
    const pid = getProductId(p);
    if (!pid || seen.has(pid)) continue;
    ordered.push(p);
  }

  return ordered;
}

// Returns the model's raw text. Parsing happens in the chain, AFTER the call is recorded as reaching the model.
async function callOpenAI({ prompt, signal, timeoutMs }) {
  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL_OPENAI,
    messages: [
      {
        role: 'system',
        content:
          'You are a product reranking component. Output MUST be valid JSON only and follow the requested schema exactly.',
      },
      { role: 'user', content: String(prompt || '') },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  }, { signal, timeout: timeoutMs });
  return completion?.choices?.[0]?.message?.content || '';
}

async function callGemini({ prompt, signal, timeoutMs }) {
  const apiKey = resolveFindProductsGeminiApiKey();
  // Vertex authenticates via ADC, where apiKey is empty and unused; gate on the
  // seam so a retired GEMINI_API_KEY doesn't false-negative a working call.
  if (!vertexGemini.credentialsAvailable(apiKey)) throw new Error(vertexGemini.missingCredentialMessage());

  const { url, headers: geminiHeaders } = await vertexGemini.restTarget({
    model: DEFAULT_MODEL_GEMINI,
    apiKey,
    baseUrl: process.env.GEMINI_BASE_URL || null,
  });

  const body = {
    systemInstruction: {
      parts: [
        {
          text:
            'You are a product reranking component. Output MUST be valid JSON only and follow the requested schema exactly.',
        },
      ],
    },
    contents: [{ role: 'user', parts: [{ text: String(prompt || '') }] }],
    generationConfig: { temperature: 0, topK: 1, topP: 0.1, maxOutputTokens: 1024 },
  };

  const resp = await axios.post(url, body, {
    headers: geminiHeaders,
    timeout: Math.min(12_000, timeoutMs),
    signal,
  });
  const text =
    resp?.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
    resp?.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    '';
  return String(text || '').trim();
}

const PROVIDER_CALLS = Object.freeze({ openai: callOpenAI, gemini: callGemini });

async function callRerankChain({ prompt, providers, signal, deadlineAt }) {
  let lastErr = null;
  for (let i = 0; i < providers.length; i += 1) {
    const provider = providers[i];
    const call = PROVIDER_CALLS[provider];
    if (!call) continue; // Unknown provider -> skip
    // The deadline fired while an earlier provider was in flight: stop here, never dial the next provider in
    // the background of a search that has already moved on.
    if (signal.aborted) break;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) break;
    const model = modelForProvider(provider);
    // Re-checked per provider (and the half-open probe granted here, not at chain build): another request may
    // have opened this breaker, or taken its probe, while this one was on the provider before.
    if (!acquireModelCall(BREAKER_FEATURE, provider, model)) continue;
    const hasLiveFallback = providers.slice(i + 1).some((next) => PROVIDER_CALLS[next] && !breakerOpenFor(next));
    const timeoutMs = hasLiveFallback
      ? Math.max(1, Math.floor(remaining * PRIMARY_BUDGET_SHARE))
      : RERANK_LLM_TIMEOUT_MS;
    let text;
    try {
      text = await call({ prompt, signal, timeoutMs });
    } catch (err) {
      lastErr = err;
      recordModelFailure({ feature: BREAKER_FEATURE, provider, model, err, envHint: MODEL_ENV_HINT[provider] || null });
      continue;
    }
    // The model answered: whatever its text says, it exists.
    recordModelSuccess(BREAKER_FEATURE, provider, model);
    try {
      return { provider, json: JSON.parse(text) };
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr || 'unknown_error');
  throw new Error(`rerank_llm_failed: ${msg}`);
}

// ONE deadline for the whole provider chain. Each provider call also carries a transport timeout, but a chain
// of two providers (plus Vertex's access-token fetch, which sits outside the HTTP timeout) could otherwise
// spend a multiple of it. The rerank is an optional quality pass: its failure must cost the search no more
// than its budget. When the deadline fires the chain is CANCELLED: the in-flight provider call is aborted
// through its signal and the loop dials no further provider.
function callRerankLlm({ prompt, providers }) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + RERANK_LLM_TIMEOUT_MS;
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`rerank_llm_failed: deadline ${RERANK_LLM_TIMEOUT_MS}ms exceeded`));
    }, RERANK_LLM_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([callRerankChain({ prompt, providers, signal: controller.signal, deadlineAt }), deadline])
    .finally(() => clearTimeout(timer));
}

function extractProductsFromResponse(response) {
  if (Array.isArray(response?.products)) return { key: 'products', products: response.products };
  if (Array.isArray(response?.result?.products)) return { key: 'result.products', products: response.result.products };
  if (Array.isArray(response?.data?.products)) return { key: 'data.products', products: response.data.products };
  return { key: 'products', products: [] };
}

function setProductsOnResponse(response, key, products) {
  if (!response || typeof response !== 'object') return response;
  if (key === 'products') return { ...response, products };
  if (key === 'result.products') return { ...response, result: { ...(response.result || {}), products } };
  if (key === 'data.products') return { ...response, data: { ...(response.data || {}), products } };
  return { ...response, products };
}

function setEvidenceProfileOnResponse(response, evidenceProfile) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  return { ...response, evidence_profile: evidenceProfile };
}

async function maybeRerankFindProductsMultiResponse({ response, userQuery, limit }) {
  if (!isEnabled()) return { response, applied: false };
  // Every configured provider has told this process its model does not exist: skip without dialling. Logged
  // when the breaker opened (llmModelBreaker), not per search. `breaker_open` keeps the skip visible to the
  // caller's stage telemetry, where a failed rerank has always counted as an error.
  const providers = liveProviderChain();
  if (!providers.length) {
    return { response, applied: false, skipped_reason: 'model_unavailable', breaker_open: true };
  }
  const q = String(userQuery || '').trim();
  if (!q) return { response, applied: false };

  const { key, products } = extractProductsFromResponse(response);
  const list = Array.isArray(products) ? products : [];
  if (list.length === 0) return { response, applied: false };

  const { internal, external } = splitCandidates(list);
  // Only run rerank when we have external candidates (brand hard constraints often matter here).
  if (!external.length) return { response, applied: false };

  const n = Math.min(Math.max(1, Number(limit || list.length) || list.length), MAX_OUTPUT_ITEMS);
  const prompt = buildPrompt({
    userQuery: q,
    n,
    internalProductsJson: safeJsonStringify(internal),
    externalProductsJson: safeJsonStringify(external),
  });

  const t0 = Date.now();
  const { provider, json } = await callRerankLlm({ prompt, providers });
  const items = parseRerankResponse(json);
  if (!items.length) return { response, applied: false, provider };

  const missingProvenanceCount = items.filter((it) => !it.rationale && !it.criteria).length;
  const evidenceProfile = missingProvenanceCount > 0
    ? 'llm_rerank_unprovenanced'
    : 'llm_rerank_with_rationale';
  if (missingProvenanceCount > 0) {
    logger.warn(
      {
        provider,
        items_count: items.length,
        missing_count: missingProvenanceCount,
        evidence_profile: evidenceProfile,
      },
      'find_products_multi llm rerank missing provenance',
    );
  }

  const reordered = applyRerankToProducts(list, items, n);
  const responseWithProducts = setProductsOnResponse(response, key, reordered);
  return {
    response: setEvidenceProfileOnResponse(responseWithProducts, evidenceProfile),
    applied: true,
    provider,
    items_count: items.length,
    duration_ms: Date.now() - t0,
    evidence_profile: evidenceProfile,
  };
}

module.exports = {
  maybeRerankFindProductsMultiResponse,
};
