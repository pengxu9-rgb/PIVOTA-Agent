const fs = require('fs');
const path = require('path');

const axios = require('axios');
const OpenAI = require('openai');

const DEFAULT_PROMPT_PATH = path.join(__dirname, '..', '..', 'prompts', 'product_rerank_prompt_v1.txt');
const DEFAULT_MODEL_OPENAI = process.env.PIVOTA_RERANK_MODEL || 'gpt-5.1-mini';
const DEFAULT_MODEL_GEMINI = process.env.PIVOTA_RERANK_MODEL_GEMINI || process.env.PIVOTA_RERANK_MODEL || 'gemini-1.5-flash';

const MAX_CANDIDATES_PER_SOURCE = Math.min(
  200,
  Math.max(10, Number(process.env.FIND_PRODUCTS_MULTI_RERANK_LLM_MAX_CANDIDATES || 60))
);
const MAX_OUTPUT_ITEMS = Math.min(
  50,
  Math.max(5, Number(process.env.FIND_PRODUCTS_MULTI_RERANK_LLM_MAX_OUTPUT || 20))
);

function isEnabled() {
  return process.env.FIND_PRODUCTS_MULTI_RERANK_LLM_ENABLED === 'true';
}

let cachedPrompt = null;
function loadPromptTemplate() {
  if (cachedPrompt) return cachedPrompt;
  const promptPath = process.env.FIND_PRODUCTS_MULTI_RERANK_LLM_PROMPT_PATH || DEFAULT_PROMPT_PATH;
  cachedPrompt = fs.readFileSync(promptPath, 'utf8');
  return cachedPrompt;
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...(baseURL ? { baseURL } : {}) });
}

function getProviderChain() {
  const primary = (process.env.PIVOTA_RERANK_LLM_PROVIDER || 'openai').toLowerCase();
  const fallback = (process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER || 'gemini').toLowerCase();
  // Keep stable order and de-dupe.
  const out = [];
  for (const p of [primary, fallback]) {
    if (!p) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.length ? out : ['openai'];
}

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
    ordered.push(p);
  }

  // Preserve the remainder in original order (stable) so pagination/total stays intact.
  for (const p of products || []) {
    const pid = getProductId(p);
    if (!pid || seen.has(pid)) continue;
    ordered.push(p);
  }

  return ordered;
}

async function callOpenAI({ prompt }) {
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
  });
  const content = completion?.choices?.[0]?.message?.content || '';
  return JSON.parse(content);
}

async function callGemini({ prompt }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

  const baseURL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const url = `${baseURL}/v1beta/models/${encodeURIComponent(DEFAULT_MODEL_GEMINI)}:generateContent?key=${encodeURIComponent(
    process.env.GEMINI_API_KEY
  )}`;

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

  const resp = await axios.post(url, body, { timeout: 12_000 });
  const text =
    resp?.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ||
    resp?.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    '';
  return JSON.parse(String(text || '').trim());
}

async function callRerankLlm({ prompt }) {
  const providers = getProviderChain();
  let lastErr = null;
  for (const provider of providers) {
    try {
      if (provider === 'openai') return { provider, json: await callOpenAI({ prompt }) };
      if (provider === 'gemini') return { provider, json: await callGemini({ prompt }) };
      // Unknown provider -> skip
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr || 'unknown_error');
  throw new Error(`rerank_llm_failed: ${msg}`);
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

async function maybeRerankFindProductsMultiResponse({ response, userQuery, limit }) {
  if (!isEnabled()) return { response, applied: false };
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
  const { provider, json } = await callRerankLlm({ prompt });
  const items = parseRerankResponse(json);
  if (!items.length) return { response, applied: false, provider };

  const reordered = applyRerankToProducts(list, items, n);
  return {
    response: setProductsOnResponse(response, key, reordered),
    applied: true,
    provider,
    items_count: items.length,
    duration_ms: Date.now() - t0,
  };
}

module.exports = {
  maybeRerankFindProductsMultiResponse,
};

