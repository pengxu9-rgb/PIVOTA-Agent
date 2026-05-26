#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  BEAUTY_ATTRIBUTE_FIELDS,
  SPF_OTC_VALUES,
  CLAIM_RISK_VALUES,
  upsertBeautyAttributes,
  validateExtractionPayload,
} = require('../src/auroraBff/productBeautyAttributes');

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_DRY_RUN_LIMIT = 5;
const DEFAULT_REPORT_PATH = '/tmp/codex_relation_graph_phase_c2_result.md';
const DEFAULT_BUDGET_LIMIT_USD = 25;

const NULL_MARKERS = new Set([
  '',
  'null',
  'none',
  'n/a',
  'na',
  'not_applicable',
  'not applicable',
  'unknown',
  'unspecified',
]);

const ATTRIBUTE_SOURCE_FIELDS = new Set([
  'name',
  'brand',
  'category_taxonomy',
  'url',
  'price',
  'description',
  'claims',
  'ingredients',
  'snapshot',
  'inferred_from_name',
  'inferred_from_category_taxonomy',
]);

const PRICE_HINTS_USD_PER_1M_TOKENS = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeSnake(value, max = 120) {
  const text = normalizeString(value, max)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return text || '';
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortedObject(value[key]);
  }
  return out;
}

function stableStringify(value, spaces = 2) {
  return JSON.stringify(sortedObject(value), null, spaces);
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}_${mm}_${dd}`;
}

function modelSlug(value) {
  return normalizeSnake(value || 'model', 80).replace(/^_+|_+$/g, '') || 'model';
}

function buildExtractorVersion(provider, model) {
  const explicit = normalizeString(process.env.BEAUTY_ATTRIBUTE_EXTRACTOR_VERSION, 160);
  if (explicit) return explicit;
  const providerSlug = modelSlug(provider || 'llm');
  const modelPart = model ? `_${modelSlug(model)}` : '';
  return `${providerSlug}${modelPart}_v1_${todayStamp()}`;
}

function snapshotProductKey(snapshot) {
  const src = isPlainObject(snapshot) && isPlainObject(snapshot.snapshot) ? snapshot.snapshot : snapshot;
  return normalizeString(
    snapshot?.product_key ||
      snapshot?.productKey ||
      src?.product_key ||
      src?.productKey ||
      src?.product_id ||
      src?.productId,
    260,
  ).replace(/^product:/, '');
}

function countPopulatedFields(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countPopulatedFields(item), value.length ? 1 : 0);
  }
  if (isPlainObject(value)) {
    let sum = 0;
    for (const v of Object.values(value)) sum += countPopulatedFields(v);
    return sum;
  }
  if (value == null) return 0;
  const text = String(value).trim();
  return text ? 1 : 0;
}

function snapshotRichness(snapshot) {
  if (!isPlainObject(snapshot)) return 0;
  return countPopulatedFields(snapshot) * 1000 + stableStringify(snapshot, 0).length;
}

function normalizeSnapshot(snapshot) {
  return isPlainObject(snapshot) ? snapshot : {};
}

function buildPrompt(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const productKey = snapshotProductKey(normalized) || 'unknown_product';
  const productJson = stableStringify(normalized, 2);

  return [
    'You are classifying one beauty product for a relation-graph preflight gate.',
    'Return JSON only. Do not include markdown, comments, prose, or extra top-level keys.',
    '',
    'Task:',
    `Classify product_key "${productKey}" using only the product snapshot below.`,
    '',
    'Output schema:',
    '{',
    '  "product_form": string|null,',
    '  "product_form_source": string|null,',
    '  "product_form_confidence": number,',
    '  "category_leaf": string|null,',
    '  "category_leaf_source": string|null,',
    '  "category_leaf_confidence": number,',
    '  "target_area": string|null,',
    '  "target_area_source": string|null,',
    '  "target_area_confidence": number,',
    '  "shade_or_color_family": string|null,',
    '  "shade_or_color_family_source": string|null,',
    '  "shade_or_color_family_confidence": number,',
    '  "scent_family": string|null,',
    '  "scent_family_source": string|null,',
    '  "scent_family_confidence": number,',
    `  "spf_or_otc_flag": ${Array.from(SPF_OTC_VALUES).join('|')},`,
    '  "spf_or_otc_flag_source": string|null,',
    '  "spf_or_otc_flag_confidence": number,',
    '  "skin_concern": string[]|null,',
    '  "skin_concern_source": string|null,',
    '  "skin_concern_confidence": number,',
    `  "claim_risk_level": ${Array.from(CLAIM_RISK_VALUES).join('|')},`,
    '  "claim_risk_level_source": string|null,',
    '  "claim_risk_level_confidence": number',
    '}',
    '',
    'Rules:',
    '- Use concise lowercase snake_case labels for non-enum strings, for example: serum, cream, lipstick, matte_lipstick, face, lips, floral, warm_brown.',
    '- product_form = physical/product format such as serum, cream, gel, oil, stick, powder, palette, spray, cleanser, mask, brush, shampoo, conditioner, fragrance.',
    '- category_leaf = the most specific product category you can infer, such as hydrating_serum, matte_lipstick, tinted_moisturizer, sunscreen_lotion, eau_de_parfum.',
    '- target_area = where it is used: face, lips, eyes, hair, body, nails, fragrance, brows, cheeks, multi_area, unknown.',
    '- shade_or_color_family is for makeup shade/color families. Use null when shade is irrelevant or clearly not applicable.',
    '- scent_family is for fragrance or materially scented products. Use null for unscented products or when scent is irrelevant.',
    '- spf_or_otc_flag must be exactly one of: cosmetic, spf, otc_drug, spf_otc, unknown.',
    '- skin_concern should be an array such as acne, anti_aging, brightening, hydration, redness, sensitivity, oiliness, dryness, hyperpigmentation, barrier_repair. Use [] when no concern is implied. Use null only when the concept is not applicable.',
    '- claim_risk_level must be exactly low, medium, or high. High means explicit drug-like treatment/prevention claims; medium means strong cosmetic efficacy claims; low means ordinary cosmetic/category claims.',
    '- Each *_confidence must be a number from 0 to 1. Sparse snapshots should lower confidence, especially shade and scent.',
    '- null means the attribute is not applicable, not low confidence. If you are certain null is correct, set confidence near 1.0.',
    '- Each *_source should name the input field that drove the inference, for example name, category_taxonomy, url, brand, description, snapshot.',
    '',
    'Product snapshot JSON:',
    productJson,
  ].join('\n');
}

function stripJsonFence(text) {
  return String(text || '')
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseJsonOnly(text) {
  const cleaned = stripJsonFence(text);
  return JSON.parse(cleaned);
}

function normalizeNullish(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const raw = value.trim();
    const snake = normalizeSnake(raw, 160);
    if (NULL_MARKERS.has(raw.toLowerCase()) || NULL_MARKERS.has(snake)) return null;
  }
  return value;
}

function normalizeScalarAttribute(value) {
  const v = normalizeNullish(value);
  if (v == null) return null;
  if (Array.isArray(v)) {
    const joined = v.map((x) => normalizeSnake(x, 80)).filter(Boolean).join('_');
    return joined || null;
  }
  if (isPlainObject(v)) return null;
  return normalizeSnake(v, 120) || null;
}

function normalizeSource(value) {
  const v = normalizeNullish(value);
  if (v == null) return null;
  const source = normalizeSnake(v, 120);
  if (!source) return null;
  if (ATTRIBUTE_SOURCE_FIELDS.has(source)) return source;
  return source.slice(0, 120);
}

function normalizeConfidence(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const text = value.trim();
    const pct = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/);
    if (pct) return Number(pct[1]) / 100;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  if (n > 1 && n <= 100) return Math.round((n / 100) * 1000) / 1000;
  return Math.round(n * 1000) / 1000;
}

function normalizeSkinConcern(value) {
  const v = normalizeNullish(value);
  if (v == null) return null;
  const list = Array.isArray(v) ? v : String(v).split(/[,;/]+/);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const normalized = normalizeScalarAttribute(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeEnum(value, allowed) {
  const normalized = normalizeScalarAttribute(value);
  if (!normalized) return null;
  return allowed.has(normalized) ? normalized : normalized;
}

function parseLlmResponse(text, productKey, options = {}) {
  let raw;
  try {
    raw = parseJsonOnly(text);
  } catch (err) {
    return { ok: false, value: null, errors: [`malformed_json:${err.message}`] };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, value: null, errors: ['json_not_object'] };
  }

  const value = {
    product_key: normalizeString(productKey, 260).replace(/^product:/, ''),
    extractor_version: normalizeString(options.extractorVersion, 160) || buildExtractorVersion(options.provider, options.model),
    audit_status: 'pending',
    extracted_at: options.extractedAt || new Date().toISOString(),
  };

  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    if (field === 'skin_concern') value[field] = normalizeSkinConcern(raw[field]);
    else if (field === 'spf_or_otc_flag') value[field] = normalizeEnum(raw[field], SPF_OTC_VALUES);
    else if (field === 'claim_risk_level') value[field] = normalizeEnum(raw[field], CLAIM_RISK_VALUES);
    else value[field] = normalizeScalarAttribute(raw[field]);

    value[`${field}_source`] = normalizeSource(raw[`${field}_source`]);
    value[`${field}_confidence`] = normalizeConfidence(raw[`${field}_confidence`]);
  }

  const completenessErrors = [];
  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    if (value[`${field}_confidence`] == null) completenessErrors.push(`missing_confidence:${field}`);
  }
  if (completenessErrors.length) return { ok: false, value, errors: completenessErrors };

  const validation = validateExtractionPayload(value);
  if (!validation.ok) return { ok: false, value, errors: validation.errors };
  return { ok: true, value, errors: [] };
}

async function loadCandidateUniverse({ queryFn = query } = {}) {
  const res = await queryFn(`
    SELECT
      CASE
        WHEN anchor_type = 'product' THEN regexp_replace(anchor_ref, '^product:', '')
      END AS product_key,
      anchor_snapshot AS snapshot
    FROM relationship_candidate_labels
    WHERE anchor_type = 'product'
    UNION ALL
    SELECT
      regexp_replace(candidate_product_ref, '^product:', '') AS product_key,
      candidate_snapshot AS snapshot
    FROM relationship_candidate_labels
    WHERE candidate_product_ref LIKE 'product:%'
  `);

  const bestByKey = new Map();
  for (const row of res.rows || []) {
    const key = normalizeString(row.product_key, 260).replace(/^product:/, '');
    if (!key) continue;
    const snapshot = normalizeSnapshot(row.snapshot);
    const enriched = { ...snapshot, product_id: snapshot.product_id || key };
    const richness = snapshotRichness(enriched);
    const prior = bestByKey.get(key);
    if (!prior || richness > prior.richness) {
      bestByKey.set(key, { product_key: key, snapshot: enriched, richness });
    }
  }

  return Array.from(bestByKey.values())
    .sort((a, b) => a.product_key.localeCompare(b.product_key))
    .map(({ product_key, snapshot }) => ({ product_key, snapshot }));
}

function unwrapLlmText(response) {
  if (typeof response === 'string') return { text: response, meta: {} };
  if (isPlainObject(response)) {
    return {
      text: String(response.text || response.content || response.output || ''),
      meta: { ...response },
    };
  }
  return { text: String(response || ''), meta: {} };
}

async function extractOne(input, { llmFn, extractorVersion, provider, model } = {}) {
  if (typeof llmFn !== 'function') throw new Error('extractOne requires llmFn');
  const row = isPlainObject(input) && isPlainObject(input.snapshot) ? input : { snapshot: input };
  const snapshot = normalizeSnapshot(row.snapshot);
  const productKey = normalizeString(row.product_key || snapshotProductKey(snapshot), 260).replace(/^product:/, '');
  if (!productKey) throw new Error('missing_product_key');

  const prompt = buildPrompt({ ...snapshot, product_id: snapshot.product_id || productKey });
  const llmResponse = await llmFn(prompt, { productKey, snapshot });
  const { text, meta } = unwrapLlmText(llmResponse);
  const parsed = parseLlmResponse(text, productKey, {
    extractorVersion,
    provider: meta.provider || provider,
    model: meta.model || model,
  });
  if (!parsed.ok) {
    const err = new Error(`extraction_parse_or_validation_failed:${parsed.errors.join(',')}`);
    err.code = 'EXTRACTION_INVALID';
    err.errors = parsed.errors;
    err.raw_response = text;
    throw err;
  }

  const payload = {
    ...parsed.value,
    raw_extraction: {
      llm_response: text,
      llm_usage: meta.usage || null,
      llm_provider: meta.provider || provider || null,
      llm_model: meta.model || model || null,
      normalized: parsed.value,
    },
  };
  const validation = validateExtractionPayload(payload);
  if (!validation.ok) {
    const err = new Error(`invalid_extraction_payload:${validation.errors.join(',')}`);
    err.code = 'INVALID_EXTRACTION_PAYLOAD';
    err.errors = validation.errors;
    throw err;
  }
  return payload;
}

function argValue(argv, name, fallback = '') {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const v = argv[idx + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function parseArgs(argv = process.argv) {
  const dryRun = hasFlag(argv, 'dry-run');
  const apply = hasFlag(argv, 'apply');
  const limitArg = argValue(argv, 'limit', '');
  const limit = limitArg
    ? parseInteger(limitArg, null, { min: 1 })
    : dryRun
      ? DEFAULT_DRY_RUN_LIMIT
      : null;
  return {
    dryRun,
    apply,
    limit,
    concurrency: parseInteger(argValue(argv, 'concurrency', DEFAULT_CONCURRENCY), DEFAULT_CONCURRENCY, { min: 1, max: 25 }),
    reportsDir: argValue(argv, 'reports-dir', ''),
    reportPath: argValue(argv, 'report-path', DEFAULT_REPORT_PATH),
  };
}

function normalizeOpenAiBaseUrl(raw) {
  const base = normalizeString(raw || 'https://api.openai.com', 300).replace(/\/+$/, '');
  return base.replace(/\/v1$/i, '');
}

function resolveProviderConfig(env = process.env) {
  const explicit = normalizeString(env.BEAUTY_LLM_PROVIDER || env.PIVOTA_BEAUTY_LLM_PROVIDER, 80).toLowerCase();
  if (explicit === 'deepseek' || (!explicit && env.DEEPSEEK_API_KEY)) {
    const model = normalizeString(env.BEAUTY_LLM_MODEL || env.DEEPSEEK_MODEL || 'deepseek-chat', 120);
    return {
      provider: 'deepseek',
      model,
      baseUrl: normalizeOpenAiBaseUrl(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'),
      apiKey: env.DEEPSEEK_API_KEY,
      kind: 'openai_compatible',
    };
  }
  if (explicit === 'openai' || (!explicit && env.OPENAI_API_KEY)) {
    const model = normalizeString(env.BEAUTY_LLM_MODEL || env.PIVOTA_LAYER2_MODEL_OPENAI || env.OPENAI_MODEL || 'gpt-4o-mini', 120);
    return {
      provider: 'openai',
      model,
      baseUrl: normalizeOpenAiBaseUrl(env.OPENAI_BASE_URL || 'https://api.openai.com'),
      apiKey: env.OPENAI_API_KEY,
      kind: 'openai_compatible',
    };
  }
  if (explicit === 'openai_compatible' || explicit === 'llm' || (!explicit && env.LLM_API_KEY && env.LLM_BASE_URL && env.LLM_MODEL_NAME)) {
    const model = normalizeString(env.BEAUTY_LLM_MODEL || env.LLM_MODEL_NAME, 120);
    return {
      provider: 'openai_compatible',
      model,
      baseUrl: normalizeOpenAiBaseUrl(env.LLM_BASE_URL),
      apiKey: env.LLM_API_KEY,
      kind: 'openai_compatible',
    };
  }
  if (explicit === 'gemini' || (!explicit && (env.GEMINI_API_KEY || env.GOOGLE_API_KEY))) {
    const model = normalizeString(env.BEAUTY_LLM_MODEL || env.GEMINI_MODEL || 'gemini-2.0-flash', 120);
    return {
      provider: 'gemini',
      model,
      baseUrl: normalizeString(env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com', 300).replace(/\/+$/, ''),
      apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
      kind: 'gemini',
    };
  }
  return {
    provider: explicit || 'unconfigured',
    model: normalizeString(env.BEAUTY_LLM_MODEL, 120) || null,
    baseUrl: null,
    apiKey: null,
    kind: 'missing',
  };
}

function extractOpenAiContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || '').filter(Boolean).join('\n');
  }
  return '';
}

function tokenUsageFromOpenAi(data) {
  const usage = data?.usage || {};
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
  };
}

function tokenUsageFromGemini(data) {
  const usage = data?.usageMetadata || {};
  const prompt = Number(usage.promptTokenCount || 0);
  const output = Number(usage.candidatesTokenCount || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: Number(usage.totalTokenCount || prompt + output || 0),
  };
}

function getPriceHint(model, env = process.env) {
  const inputOverride = Number(env.BEAUTY_LLM_INPUT_COST_PER_1M || env.LLM_INPUT_COST_PER_1M);
  const outputOverride = Number(env.BEAUTY_LLM_OUTPUT_COST_PER_1M || env.LLM_OUTPUT_COST_PER_1M);
  if (Number.isFinite(inputOverride) && Number.isFinite(outputOverride)) {
    return { input: inputOverride, output: outputOverride, source: 'env_override' };
  }
  const normalizedModel = String(model || '').toLowerCase();
  const key = Object.keys(PRICE_HINTS_USD_PER_1M_TOKENS)
    .find((candidate) => normalizedModel === candidate || normalizedModel.includes(candidate));
  if (!key) return null;
  return { ...PRICE_HINTS_USD_PER_1M_TOKENS[key], source: 'script_price_hint' };
}

function estimateCostUsd(usage, model, env = process.env) {
  const price = getPriceHint(model, env);
  if (!price) return null;
  const prompt = Number(usage?.prompt_tokens || 0);
  const completion = Number(usage?.completion_tokens || 0);
  if (!prompt && !completion) return null;
  return ((prompt * price.input) + (completion * price.output)) / 1_000_000;
}

function createDefaultLlmFn(config = resolveProviderConfig()) {
  if (!config.apiKey || config.kind === 'missing') {
    const err = new Error('Missing LLM credentials. Set DEEPSEEK_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or LLM_API_KEY/LLM_BASE_URL/LLM_MODEL_NAME.');
    err.code = 'LLM_CONFIG_MISSING';
    throw err;
  }

  if (config.kind === 'openai_compatible') {
    const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
    return async (prompt) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are a strict JSON generator. Output JSON only. No markdown, no extra keys, no prose.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = data?.error?.message || data?.message || response.statusText;
        const err = new Error(`LLM request failed (${response.status}): ${String(msg).slice(0, 240)}`);
        err.code = 'LLM_REQUEST_FAILED';
        throw err;
      }
      return {
        text: extractOpenAiContent(data),
        provider: config.provider,
        model: config.model,
        usage: tokenUsageFromOpenAi(data),
      };
    };
  }

  if (config.kind === 'gemini') {
    const modelPath = config.model.startsWith('models/') ? config.model.slice('models/'.length) : config.model;
    const endpoint = `${config.baseUrl}/v1beta/models/${encodeURIComponent(modelPath)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    return async (prompt) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 1200,
            responseMimeType: 'application/json',
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = data?.error?.message || data?.message || response.statusText;
        const err = new Error(`LLM request failed (${response.status}): ${String(msg).slice(0, 240)}`);
        err.code = 'LLM_REQUEST_FAILED';
        throw err;
      }
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((part) => part?.text || '')
        .filter(Boolean)
        .join('\n');
      return {
        text,
        provider: config.provider,
        model: config.model,
        usage: tokenUsageFromGemini(data),
      };
    };
  }

  throw new Error(`Unsupported LLM provider kind: ${config.kind}`);
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  let stopReason = null;
  async function runWorker() {
    while (next < items.length && !stopReason) {
      const idx = next;
      next += 1;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        if (err && err.code === 'BUDGET_LIMIT_EXCEEDED') {
          stopReason = err.message;
        }
        results[idx] = { ok: false, error: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return { results, stopReason };
}

function failureReason(err) {
  if (!err) return 'unknown';
  if (Array.isArray(err.errors) && err.errors.length) return err.errors[0];
  if (err.code) return err.code;
  return normalizeString(err.message || err, 160) || 'unknown';
}

function increment(map, key, by = 1) {
  const k = key == null || key === '' ? '(null)' : Array.isArray(key) ? key.join(',') : String(key);
  map.set(k, (map.get(k) || 0) + by);
}

function topEntries(map, limit = 10) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function histogramBucket(confidence) {
  const n = Number(confidence);
  if (!Number.isFinite(n)) return 'missing';
  const clamped = Math.max(0, Math.min(1, n));
  const start = Math.floor(clamped * 10) / 10;
  if (clamped === 1) return '1.0';
  return `${start.toFixed(1)}-${(start + 0.1).toFixed(1)}`;
}

function summarizeExtractions(values) {
  const distributions = {};
  const confidenceHistograms = {};
  const lowConfidenceRows = [];

  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    distributions[field] = new Map();
    confidenceHistograms[field] = new Map();
  }

  for (const value of values) {
    let low = false;
    for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
      const attr = value[field];
      if (field === 'skin_concern' && Array.isArray(attr)) {
        if (!attr.length) increment(distributions[field], '[]');
        for (const item of attr) increment(distributions[field], item);
      } else {
        increment(distributions[field], attr);
      }
      const conf = value[`${field}_confidence`];
      increment(confidenceHistograms[field], histogramBucket(conf));
      if (Number.isFinite(Number(conf)) && Number(conf) < 0.6) low = true;
    }
    if (low) lowConfidenceRows.push(value.product_key);
  }

  const out = { distributions: {}, confidenceHistograms: {}, lowConfidenceRows };
  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    out.distributions[field] = topEntries(distributions[field], field === 'spf_or_otc_flag' || field === 'claim_risk_level' ? 20 : 10);
    out.confidenceHistograms[field] = Object.fromEntries(
      Array.from(confidenceHistograms[field].entries()).sort((a, b) => a[0].localeCompare(b[0])),
    );
  }
  return out;
}

function markdownTable(rows, columns) {
  if (!rows.length) return '_None._';
  const header = `| ${columns.join(' | ')} |`;
  const sep = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((col) => String(row[col] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

function formatDistribution(entries) {
  return markdownTable(entries.map((e) => ({ value: e.value, count: e.count })), ['value', 'count']);
}

function buildMarkdownReport(summary) {
  const lines = [];
  lines.push('# Relation Graph Phase C.2 Beauty Attribute Extractor');
  lines.push('');
  lines.push(`- Mode: ${summary.mode}`);
  lines.push(`- LLM provider/model: ${summary.provider || 'unconfigured'} / ${summary.model || 'unknown'}`);
  lines.push(`- Extractor version: ${summary.extractor_version || 'n/a'}`);
  lines.push(`- Total products in universe: ${summary.total_products}`);
  lines.push(`- Products attempted: ${summary.attempted}`);
  lines.push(`- Successful classifications: ${summary.successful}`);
  lines.push(`- Failures: ${summary.failed}`);
  lines.push(`- Estimated LLM cost: ${summary.estimated_cost_usd == null ? 'unknown' : `$${summary.estimated_cost_usd.toFixed(4)}`} (${summary.cost_source || 'no usage pricing available'})`);
  if (summary.stop_reason) lines.push(`- Stop reason: ${summary.stop_reason}`);
  lines.push('');
  lines.push('## Failure Breakdown');
  lines.push(formatDistribution(Object.entries(summary.failures_by_reason || {}).map(([value, count]) => ({ value, count }))));
  lines.push('');
  lines.push('## Attribute Distributions');
  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    lines.push(`### ${field}`);
    lines.push(formatDistribution(summary.distributions?.[field] || []));
    lines.push('');
  }
  lines.push('## Confidence Histograms');
  for (const field of BEAUTY_ATTRIBUTE_FIELDS) {
    const rows = Object.entries(summary.confidence_histograms?.[field] || {})
      .map(([bucket, count]) => ({ bucket, count }));
    lines.push(`### ${field}`);
    lines.push(markdownTable(rows, ['bucket', 'count']));
    lines.push('');
  }
  lines.push('## Low Confidence Audit Targets');
  const low = summary.low_confidence_rows || [];
  lines.push(`Rows with any attribute confidence < 0.6: ${low.length}`);
  lines.push(low.slice(0, 200).join('\n') || '_None._');
  if (low.length > 200) lines.push(`... ${low.length - 200} more omitted from report.`);
  lines.push('');
  lines.push('## Sample Rows');
  lines.push('```json');
  lines.push(JSON.stringify(summary.sample_rows || [], null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Anomalies');
  lines.push((summary.anomalies || []).length ? summary.anomalies.map((a) => `- ${a}`).join('\n') : '_None observed._');
  lines.push('');
  lines.push(summary.pass ? 'PASS' : `FAIL: ${summary.fail_reason || 'success rate below threshold or run incomplete'}`);
  lines.push('');
  return lines.join('\n');
}

async function runExtraction(options = {}) {
  const apply = Boolean(options.apply);
  const dryRun = !apply;
  const config = options.providerConfig || resolveProviderConfig();
  const extractorVersion = options.extractorVersion || buildExtractorVersion(config.provider, config.model);
  const llmFn = options.llmFn || createDefaultLlmFn(config);
  const universe = await loadCandidateUniverse({ queryFn: options.queryFn || query });
  const selected = options.limit ? universe.slice(0, options.limit) : universe;
  const failures = [];
  const successes = [];
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let estimatedCostUsd = 0;
  let hasCostEstimate = false;
  const budgetLimit = Number(options.budgetLimitUsd || process.env.BEAUTY_LLM_BUDGET_LIMIT_USD || DEFAULT_BUDGET_LIMIT_USD);
  const costSource = getPriceHint(config.model)?.source || null;

  const wrappedLlmFn = async (prompt, ctx) => {
    const response = await llmFn(prompt, ctx);
    const { meta } = unwrapLlmText(response);
    const usage = meta.usage || {};
    usageTotals.prompt_tokens += Number(usage.prompt_tokens || 0);
    usageTotals.completion_tokens += Number(usage.completion_tokens || 0);
    usageTotals.total_tokens += Number(usage.total_tokens || 0);
    const cost = estimateCostUsd(usage, meta.model || config.model);
    if (cost != null) {
      hasCostEstimate = true;
      estimatedCostUsd += cost;
      if (Number.isFinite(budgetLimit) && estimatedCostUsd > budgetLimit) {
        const err = new Error(`Estimated LLM cost exceeded $${budgetLimit}`);
        err.code = 'BUDGET_LIMIT_EXCEEDED';
        throw err;
      }
    }
    return response;
  };

  const { stopReason } = await runWithConcurrency(
    selected,
    options.concurrency || DEFAULT_CONCURRENCY,
    async (item) => {
      try {
        const extracted = await extractOne(item, {
          llmFn: wrappedLlmFn,
          extractorVersion,
          provider: config.provider,
          model: config.model,
        });
        if (apply) {
          await upsertBeautyAttributes(extracted, { queryFn: options.queryFn || query });
        }
        successes.push(extracted);
        if (dryRun) process.stdout.write(`${JSON.stringify(extracted, null, 2)}\n`);
        return { ok: true, value: extracted };
      } catch (err) {
        failures.push({
          product_key: item.product_key,
          reason: failureReason(err),
          message: normalizeString(err.message || err, 500),
        });
        if (err && err.code === 'BUDGET_LIMIT_EXCEEDED') throw err;
        return { ok: false, error: err };
      }
    },
  );

  const failureMap = new Map();
  for (const f of failures) increment(failureMap, f.reason);
  const extractionSummary = summarizeExtractions(successes);
  const attempted = successes.length + failures.length;
  const successRate = attempted ? successes.length / attempted : 0;
  const anomalies = [];
  if (stopReason) anomalies.push(stopReason);
  if (dryRun) anomalies.push('Dry run only; no rows were written.');
  if (config.kind === 'missing') anomalies.push('No LLM provider was configured.');

  return {
    mode: apply ? 'apply' : 'dry-run',
    provider: config.provider,
    model: config.model,
    extractor_version: extractorVersion,
    total_products: universe.length,
    attempted,
    successful: successes.length,
    failed: failures.length,
    failures,
    failures_by_reason: Object.fromEntries(Array.from(failureMap.entries()).sort((a, b) => b[1] - a[1])),
    usage_totals: usageTotals,
    estimated_cost_usd: hasCostEstimate ? estimatedCostUsd : null,
    cost_source: costSource,
    stop_reason: stopReason,
    distributions: extractionSummary.distributions,
    confidence_histograms: extractionSummary.confidenceHistograms,
    low_confidence_rows: extractionSummary.lowConfidenceRows,
    sample_rows: successes.slice(0, 5),
    anomalies,
    pass: successRate >= 0.95 && !stopReason && (!apply || failures.length === 0 || successRate >= 0.95),
    fail_reason: successRate >= 0.95 ? stopReason : `success rate ${(successRate * 100).toFixed(1)}% below 95%`,
  };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.reportsDir) {
    process.stderr.write('--reports-dir is accepted for CLI compatibility but ignored; this extractor reads relationship_candidate_labels from the database.\n');
  }
  if (args.dryRun === args.apply) {
    throw new Error('Pass exactly one of --dry-run or --apply');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to read relationship_candidate_labels');
  }

  const providerConfig = resolveProviderConfig();
  if (!providerConfig.apiKey || providerConfig.kind === 'missing') {
    const universe = await loadCandidateUniverse({ queryFn: query });
    const emptyExtractionSummary = summarizeExtractions([]);
    const summary = {
      mode: args.apply ? 'apply' : 'dry-run',
      provider: providerConfig.provider,
      model: providerConfig.model,
      extractor_version: buildExtractorVersion(providerConfig.provider, providerConfig.model),
      total_products: universe.length,
      attempted: 0,
      successful: 0,
      failed: universe.length,
      failures: universe.map((item) => ({
        product_key: item.product_key,
        reason: 'LLM_CONFIG_MISSING',
        message: 'Missing non-Railway LLM credentials',
      })),
      failures_by_reason: { LLM_CONFIG_MISSING: universe.length },
      usage_totals: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      estimated_cost_usd: null,
      cost_source: 'no LLM calls made',
      stop_reason: 'Missing LLM credentials',
      distributions: emptyExtractionSummary.distributions,
      confidence_histograms: emptyExtractionSummary.confidenceHistograms,
      low_confidence_rows: [],
      sample_rows: [],
      anomalies: ['Missing non-Railway LLM credentials. Set DEEPSEEK_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or LLM_API_KEY/LLM_BASE_URL/LLM_MODEL_NAME.'],
      pass: false,
      fail_reason: 'missing_llm_credentials',
    };
    const report = buildMarkdownReport(summary);
    if (args.reportPath) {
      fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
      fs.writeFileSync(args.reportPath, report, 'utf8');
    }
    process.stdout.write(`${JSON.stringify({
      mode: summary.mode,
      provider: summary.provider,
      model: summary.model,
      extractor_version: summary.extractor_version,
      total_products: summary.total_products,
      attempted: summary.attempted,
      successful: summary.successful,
      failed: summary.failed,
      estimated_cost_usd: summary.estimated_cost_usd,
      report_path: args.reportPath,
      pass: summary.pass,
      fail_reason: summary.fail_reason,
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const summary = await runExtraction({
    apply: args.apply,
    limit: args.limit,
    concurrency: args.concurrency,
    providerConfig,
  });

  const report = buildMarkdownReport(summary);
  if (args.reportPath) {
    fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
    fs.writeFileSync(args.reportPath, report, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({
    mode: summary.mode,
    provider: summary.provider,
    model: summary.model,
    extractor_version: summary.extractor_version,
    total_products: summary.total_products,
    attempted: summary.attempted,
    successful: summary.successful,
    failed: summary.failed,
    estimated_cost_usd: summary.estimated_cost_usd,
    report_path: args.reportPath,
    pass: summary.pass,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closePool();
      } catch {
        // no pool in offline tests
      }
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  ATTRIBUTE_SOURCE_FIELDS,
  DEFAULT_REPORT_PATH,
  buildMarkdownReport,
  buildPrompt,
  createDefaultLlmFn,
  estimateCostUsd,
  extractOne,
  loadCandidateUniverse,
  parseArgs,
  parseLlmResponse,
  resolveProviderConfig,
  runExtraction,
  stableStringify,
};
