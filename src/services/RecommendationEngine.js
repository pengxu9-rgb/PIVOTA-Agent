const crypto = require('node:crypto');
const axios = require('axios');

const logger = require('../logger');
const { query } = require('../db');
const {
  inferVerticalFromProduct,
  computeSemanticSignalStrength,
  UNKNOWN_VERTICAL,
} = require('./recoSemanticSignals');
const {
  EXTERNAL_SEED_MERCHANT_ID,
  buildExternalSeedProduct,
  buildExternalSeedBrandSearchProduct,
  ensureJsonObject,
} = require('./externalSeedProducts');
const { EXTERNAL_SEED_RECALL_SQL_FIELDS } = require('./externalSeedRecall');

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function getProductsSearchBaseUrl() {
  return normalizeBaseUrl(process.env.PIVOTA_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE);
}

function buildProductsSearchHeaders() {
  const headers = {};
  const apiKey = String(process.env.PIVOTA_API_KEY || '').trim();
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function parseTimeoutMs(raw, fallbackMs) {
  const s = String(raw ?? '').trim();
  if (!s) return fallbackMs;
  const direct = Number(s);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) return fallbackMs;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return fallbackMs;
  const unit = m[2].toLowerCase();
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return Math.floor(value * mult);
}

const PDP_RECS_CACHE_ENABLED = process.env.PDP_RECS_CACHE_ENABLED !== 'false';
const PDP_RECS_CACHE_TTL_MS = parseTimeoutMs(process.env.PDP_RECS_CACHE_TTL_MS, 10 * 60 * 1000);
const PDP_RECS_CACHE_MAX_ENTRIES = Math.max(0, Number(process.env.PDP_RECS_CACHE_MAX_ENTRIES || 2000) || 2000);
const PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS = Math.max(
  300,
  parseTimeoutMs(process.env.PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS, 2200),
);
const PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS = Math.max(
  300,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS, 1200),
);
const PDP_RECS_EXTERNAL_QUERY_TIMEOUT_MS = Math.max(
  500,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_QUERY_TIMEOUT_MS, 4200),
);
const PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_MULTIPLIER = Math.max(
  1,
  Math.min(
    6,
    Number(process.env.PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_MULTIPLIER || 2.5) || 2.5,
  ),
);
const PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_ABS = Math.max(
  4,
  Math.min(120, Number(process.env.PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_ABS || 14) || 14),
);
const PDP_RECS_CACHE = new Map(); // cacheKey -> { value, storedAtMs, expiresAtMs }
const PDP_RECS_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
  evictions: 0,
};

function getCacheStats() {
  return {
    enabled: PDP_RECS_CACHE_ENABLED,
    ttl_ms: PDP_RECS_CACHE_TTL_MS,
    max_entries: PDP_RECS_CACHE_MAX_ENTRIES,
    size: PDP_RECS_CACHE.size,
    ...PDP_RECS_CACHE_METRICS,
  };
}

function shouldCacheRecommendationResult({
  bypassCache = false,
  internalTimedOut = false,
  externalTimedOut = false,
  requestedCount = 0,
  returnedCount = 0,
}) {
  if (!PDP_RECS_CACHE_ENABLED || bypassCache) return false;
  const timedOut = internalTimedOut || externalTimedOut;
  if (!timedOut) return true;
  return Number(returnedCount || 0) >= Number(requestedCount || 0);
}

function shouldSkipExternalFetch({
  hasProvidedExternal = false,
  baseProductIsExternal = false,
  baseSemanticStrong = false,
  internalCount = 0,
  internalQualifiedCount = 0,
  skipExternalMin = 0,
  requestedCount = 0,
}) {
  if (hasProvidedExternal) return false;
  if (baseProductIsExternal) return false;
  if (!baseSemanticStrong) return false;

  const rawInternalCount = Math.max(0, Number(internalCount || 0));
  const qualifiedInternalCount = Math.max(0, Number(internalQualifiedCount || 0));
  const minInternalCount = Math.max(1, Number(skipExternalMin || 0));
  const wantedCount = Math.max(1, Number(requestedCount || 0));

  if (rawInternalCount < minInternalCount) return false;
  return qualifiedInternalCount >= wantedCount;
}

function buildExternalRecommendationFetchPlan({ baseProductIsExternal = false, safeK = 6 } = {}) {
  const requestedCount = Math.max(1, Number(safeK || 6) || 6);
  if (!baseProductIsExternal) {
    return {
      internal_fetch_timeout_ms: PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS,
      external_fetch_limit: Math.max(120, requestedCount * 15),
      external_fetch_timeout_ms: PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS,
      external_query_timeout_ms: PDP_RECS_EXTERNAL_QUERY_TIMEOUT_MS,
      same_domain_cap: Math.min(120, Math.max(48, requestedCount * 4)),
      same_domain_enough_threshold: Math.min(
        Math.min(120, Math.max(48, requestedCount * 4)),
        Math.max(18, requestedCount * 3),
      ),
      brand_exact_cap: Math.min(40, requestedCount),
      brand_pattern_cap: Math.min(40, requestedCount),
      category_exact_cap: Math.min(120, requestedCount),
      category_semantic_cap: Math.min(160, requestedCount),
      vertical_cap: Math.min(180, requestedCount),
    };
  }

  const externalFetchLimit = Math.max(48, requestedCount * 8);
  const sameDomainCap = Math.min(48, Math.max(24, externalFetchLimit));
  return {
    internal_fetch_timeout_ms: Math.max(
      400,
      Math.min(PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS, 900),
    ),
    external_fetch_limit: externalFetchLimit,
    external_fetch_timeout_ms: Math.max(
      2200,
      Math.min(Math.max(PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS, 3200), 3200),
    ),
    external_query_timeout_ms: Math.max(
      1200,
      Math.min(PDP_RECS_EXTERNAL_QUERY_TIMEOUT_MS, 2200),
    ),
    same_domain_cap: sameDomainCap,
    same_domain_enough_threshold: Math.min(
      sameDomainCap,
      Math.max(12, requestedCount * 2),
    ),
    brand_exact_cap: Math.min(24, externalFetchLimit),
    brand_pattern_cap: Math.min(24, externalFetchLimit),
    category_exact_cap: Math.min(48, externalFetchLimit),
    category_semantic_cap: Math.min(60, externalFetchLimit),
    vertical_cap: Math.min(72, externalFetchLimit),
  };
}

function getCacheEntry(cacheKey) {
  const entry = PDP_RECS_CACHE.get(cacheKey);
  if (!entry) {
    PDP_RECS_CACHE_METRICS.misses += 1;
    return null;
  }
  if (typeof entry.expiresAtMs !== 'number' || entry.expiresAtMs <= Date.now()) {
    PDP_RECS_CACHE.delete(cacheKey);
    PDP_RECS_CACHE_METRICS.misses += 1;
    return null;
  }
  PDP_RECS_CACHE_METRICS.hits += 1;
  return entry;
}

function setCacheEntry(cacheKey, value, ttlMs = PDP_RECS_CACHE_TTL_MS) {
  const ttl = Number(ttlMs) || PDP_RECS_CACHE_TTL_MS;
  const storedAtMs = Date.now();
  PDP_RECS_CACHE.set(cacheKey, { value, storedAtMs, expiresAtMs: storedAtMs + ttl });
  PDP_RECS_CACHE_METRICS.sets += 1;

  if (!PDP_RECS_CACHE_MAX_ENTRIES || PDP_RECS_CACHE.size <= PDP_RECS_CACHE_MAX_ENTRIES) return;
  // Evict oldest entries (in insertion order) to cap memory growth.
  while (PDP_RECS_CACHE.size > PDP_RECS_CACHE_MAX_ENTRIES) {
    const oldestKey = PDP_RECS_CACHE.keys().next().value;
    if (!oldestKey) break;
    PDP_RECS_CACHE.delete(oldestKey);
    PDP_RECS_CACHE_METRICS.evictions += 1;
  }
}

function stableHashShort(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex').slice(0, 12);
}

async function withSoftTimeout(promise, timeoutMs, fallbackValue, onTimeout) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return promise;
  }
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (typeof onTimeout === 'function') {
        try {
          onTimeout(timeout);
        } catch {
          // Ignore timeout callback errors.
        }
      }
      resolve(fallbackValue);
    }, timeout);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

const CATEGORY_SEMANTIC_ALIASES = [
  {
    key: 'cleanser',
    terms: ['cleanser', 'cleansing', 'face wash', 'facial wash', 'cleansing gel', 'cleansing milk'],
  },
  {
    key: 'toner',
    terms: ['toner', 'mist', 'toning pad', 'toner pad'],
  },
  {
    key: 'moisturizer',
    terms: ['moisturizer', 'moisturiser', 'cream', 'lotion', 'emulsion', 'gel cream', 'gel-cream'],
  },
  {
    key: 'serum',
    terms: ['serum', 'essence', 'ampoule', 'concentrate'],
  },
  {
    key: 'fragrance',
    terms: ['fragrance', 'perfume', 'parfum', 'eau de parfum', 'eau de toilette', 'cologne'],
  },
  {
    key: 'concealer',
    terms: ['concealer'],
  },
  {
    key: 'foundation',
    terms: ['foundation', 'skin tint', 'tinted serum'],
  },
  {
    key: 'lip balm',
    terms: ['lip balm', 'lip treatment'],
  },
  {
    key: 'lip stain',
    terms: ['lip stain', 'lip tint', 'hydrating lip stain'],
  },
  {
    key: 'lip gloss',
    terms: ['lip gloss', 'lip luminizer', 'gloss bomb', 'lip plumper'],
  },
  {
    key: 'lip oil',
    terms: ['lip oil'],
  },
  {
    key: 'lipstick',
    terms: ['lipstick', 'lip color', 'lip colour', 'lip stick'],
  },
  {
    key: 'brush',
    terms: ['brush', 'makeup brush', 'foundation brush', 'powder brush', 'blush brush'],
  },
];

const PLACEHOLDER_CATEGORY_VALUES = new Set(['external', 'unknown', 'uncategorized', 'n/a', 'na', 'none']);

function tokenize(text) {
  const s = normalizeText(text);
  if (!s) return [];
  const tokens = s.split(/\s+/g).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 24) break;
  }
  return out;
}

function appendUniquePhrase(out, seen, value) {
  const normalized = normalizeText(value);
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  out.push(normalized);
}

function expandCategorySemanticTerms(...hints) {
  const out = [];
  const seen = new Set();
  const normalizedHints = hints.map((value) => normalizeText(value)).filter(Boolean);

  for (const hint of normalizedHints) {
    appendUniquePhrase(out, seen, hint);

    for (const alias of CATEGORY_SEMANTIC_ALIASES) {
      const matched = alias.terms.some((term) => {
        const normalizedTerm = normalizeText(term);
        return normalizedTerm === hint || normalizedTerm.includes(hint) || hint.includes(normalizedTerm);
      });
      if (!matched) continue;
      for (const term of alias.terms) appendUniquePhrase(out, seen, term);
    }

    for (const token of tokenize(hint)) appendUniquePhrase(out, seen, token);
  }

  return out.slice(0, 8);
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  let inter = 0;
  for (const t of b) if (setA.has(t)) inter += 1;
  const union = new Set([...a, ...b]).size;
  if (!union) return 0;
  return inter / union;
}

function normalizeCurrency(input, fallback = 'USD') {
  const cur =
    input?.currency ||
    input?.price_currency ||
    input?.price?.currency ||
    input?.price?.current?.currency ||
    fallback;
  return String(cur || fallback).toUpperCase();
}

function normalizeAmount(input) {
  if (input == null) return 0;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string') {
    const n = Number(input);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof input === 'object') {
    const a = input.amount ?? input.current?.amount ?? input.price_amount ?? input.value;
    return normalizeAmount(a);
  }
  return 0;
}

function getProductId(product) {
  return String(product?.product_id || product?.productId || product?.id || '').trim();
}

function getMerchantId(product) {
  return String(product?.merchant_id || product?.merchantId || product?.merchant?.id || '').trim();
}

function isExternalProduct(product) {
  const mid = getMerchantId(product);
  if (mid === EXTERNAL_SEED_MERCHANT_ID) return true;
  const platform = String(product?.platform || '').trim().toLowerCase();
  if (platform === 'external') return true;
  const source = String(product?.source || product?.source_type || '').trim().toLowerCase();
  if (source === 'external_seed' || source === 'external') return true;
  const pid = getProductId(product);
  return pid.startsWith('ext_');
}

function getBrandName(product) {
  const b =
    product?.brand?.name ||
    product?.brand ||
    product?.vendor ||
    product?.vendor_name ||
    product?.manufacturer ||
    '';
  const norm = normalizeText(b);
  return norm || '';
}

function getDisplayTitle(product) {
  return String(product?.title || product?.name || '').trim();
}

function getRecommendationSemanticKey(product, brandOverride = null) {
  const brand = normalizeText(brandOverride || getBrandName(product));
  let title = normalizeText(getDisplayTitle(product));
  if (brand && title.startsWith(`${brand} `)) {
    title = title.slice(brand.length).trim();
  }
  if (!title) return '';
  return brand ? `${brand}::${title}` : title;
}

function getRecommendationTitleKey(product) {
  return normalizeText(getDisplayTitle(product));
}

function isLipFocusedProduct(product) {
  const recall = ensureJsonObject(product?.external_seed_recall || product?.seed_data?.derived?.recall);
  const text = normalizeText(
    [
      product?.title,
      product?.name,
      product?.category,
      product?.product_type,
      product?.productType,
      product?.description,
      recall.retrieval_title,
      recall.retrieval_summary,
      ...(Array.isArray(recall.alias_tokens) ? recall.alias_tokens : []),
    ]
      .filter(Boolean)
      .join(' '),
  );
  return /\blip(?:stick)?\b|\blip\s+(?:stain|tint|gloss|oil|luminizer|plumper|balm|treatment|colou?r|stick)\b/.test(text);
}

function buildRecommendationExclusionState(items) {
  const productKeys = new Set();
  const productIdsWithoutMerchant = new Set();
  const merchantTitleKeys = new Set();
  const looseTitleKeys = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const productId = getProductId(item);
    const merchantId = getMerchantId(item);
    const titleKey = getRecommendationTitleKey(item);

    if (productId) {
      if (merchantId) {
        productKeys.add(`${merchantId}::${productId}`);
      } else {
        productIdsWithoutMerchant.add(productId);
      }
    }

    if (titleKey) {
      if (merchantId) {
        merchantTitleKeys.add(`${merchantId}::${titleKey}`);
      } else {
        looseTitleKeys.add(titleKey);
      }
    }
  }

  return {
    productKeys,
    productIdsWithoutMerchant,
    merchantTitleKeys,
    looseTitleKeys,
  };
}

function shouldExcludeRecommendationProduct(product, exclusionState) {
  if (!exclusionState) return false;
  const productId = getProductId(product);
  const merchantId = getMerchantId(product);

  if (productId) {
    const productKey = merchantId ? `${merchantId}::${productId}` : '';
    if (productKey && exclusionState.productKeys.has(productKey)) return true;
    if (exclusionState.productIdsWithoutMerchant.has(productId)) return true;
  }

  const titleKey = getRecommendationTitleKey(product);
  if (!titleKey) return false;
  const merchantTitleKey = merchantId ? `${merchantId}::${titleKey}` : '';
  if (merchantTitleKey && exclusionState.merchantTitleKeys.has(merchantTitleKey)) return true;
  if (exclusionState.looseTitleKeys.has(titleKey)) return true;
  return false;
}

function getCategoryPath(product) {
  const raw = product?.category_path || product?.categoryPath;
  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter((value) => !PLACEHOLDER_CATEGORY_VALUES.has(value.toLowerCase()));
  }
  const category = String(product?.category || product?.product_type || product?.productType || '').trim();
  if (!category || PLACEHOLDER_CATEGORY_VALUES.has(category.toLowerCase())) return [];
  return category
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !PLACEHOLDER_CATEGORY_VALUES.has(segment.toLowerCase()));
}

function normalizeSpecificCategory(value) {
  const normalized = String(value || '').trim();
  if (!normalized || PLACEHOLDER_CATEGORY_VALUES.has(normalized.toLowerCase())) return '';
  return normalized;
}

function inferRecallCategory(recall) {
  const recallObj = ensureJsonObject(recall);
  const explicitCategory = normalizeSpecificCategory(recallObj.category);
  if (explicitCategory) return explicitCategory;
  const text = normalizeText(
    [
      recallObj.retrieval_title,
      recallObj.retrieval_summary,
      ...(Array.isArray(recallObj.alias_tokens) ? recallObj.alias_tokens : []),
    ]
      .filter(Boolean)
      .join(' '),
  );
  if (!text) return '';
  if (/\blip\s+(?:stain|tint)\b/.test(text)) return 'lip stain';
  if (/\blip\s+(?:gloss|luminizer|plumper)\b|\bgloss\s+bomb\b/.test(text)) return 'lip gloss';
  if (/\blip\s+oil\b/.test(text)) return 'lip oil';
  if (/\blip\s+(?:balm|treatment)\b/.test(text)) return 'lip balm';
  if (/\blipstick\b|\blip\s+colou?r\b|\blip\s+stick\b/.test(text)) return 'lipstick';
  return '';
}

function getLeafCategory(product) {
  const path = getCategoryPath(product);
  if (path.length) return normalizeText(path[path.length - 1]);
  return '';
}

function getParentCategory(product) {
  const path = getCategoryPath(product);
  if (path.length >= 2) return normalizeText(path[path.length - 2]);
  if (path.length === 1) return normalizeText(path[0]);
  return '';
}

function getPriceAmount(product) {
  const variantPrice =
    product?.variants?.[0]?.price ||
    product?.variants?.[0]?.price_amount ||
    product?.variants?.[0]?.priceAmount ||
    null;
  const p =
    product?.price?.current?.amount ??
    product?.price?.amount ??
    product?.price_amount ??
    product?.priceAmount ??
    product?.price ??
    variantPrice ??
    0;
  return normalizeAmount(p);
}

function isStatusActive(status) {
  return String(status || 'active').toLowerCase() === 'active';
}

function isSellable(product, options = {}) {
  if (!product || typeof product !== 'object') return false;
  if (!isStatusActive(product.status)) return false;
  const inStockOnly = options.inStockOnly !== false;
  if (inStockOnly) {
    const rawInv =
      product.inventory_quantity ??
      product.inventoryQuantity ??
      product.available_quantity ??
      product.availableQuantity ??
      (product.inventory && product.inventory.quantity);
    if (rawInv != null) {
      const inv = Number(rawInv);
      if (Number.isFinite(inv) && inv <= 0) return false;
    }
    if (Object.prototype.hasOwnProperty.call(product, 'in_stock')) {
      if (product.in_stock === false) return false;
    }
  }
  return true;
}

function toCandidate(product, overrides = {}) {
  const pid = getProductId(product);
  const mid = getMerchantId(product);
  if (!pid || !mid) return null;
  return {
    ...product,
    ...(product.merchant_id ? {} : { merchant_id: mid }),
    ...(product.product_id ? {} : { product_id: pid }),
    ...overrides,
  };
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const key = keyFn(it);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function scoreCandidate(base, cand) {
  const baseBrand = base.brand;
  const candBrand = cand.brand;
  const brandMatch = Boolean(baseBrand && candBrand && baseBrand === candBrand);
  const leafMatch = Boolean(base.leafCategory && cand.leafCategory && base.leafCategory === cand.leafCategory);
  const parentMatch = Boolean(
    base.parentCategory && cand.parentCategory && base.parentCategory === cand.parentCategory,
  );
  const basePrice = base.priceAmount;
  const candPrice = cand.priceAmount;
  const relDiff =
    basePrice > 0 && candPrice > 0 ? Math.abs(candPrice - basePrice) / Math.max(basePrice, 1) : null;
  const priceProximity = relDiff == null ? 0 : Math.max(0, 1 - Math.min(relDiff, 1));
  const tokenOverlap = jaccard(base.tokens, cand.tokens);

  // Lightweight score. Keep simple and stable.
  const score =
    (brandMatch ? 3.0 : 0) +
    (leafMatch ? 2.0 : 0) +
    (parentMatch ? 0.75 : 0) +
    priceProximity * 2.0 +
    tokenOverlap * 1.25;

  return {
    score,
    brandMatch,
    leafMatch,
    parentMatch,
    relDiff,
    tokenOverlap,
  };
}

function buildBaseFeatures(baseProduct) {
  const brand = getBrandName(baseProduct);
  const leafCategory = getLeafCategory(baseProduct);
  const parentCategory = getParentCategory(baseProduct);
  const priceAmount = getPriceAmount(baseProduct);
  const verticalSignal = inferVerticalFromProduct(baseProduct);
  const tokens = tokenize(
    [baseProduct.title, baseProduct.name, leafCategory, parentCategory].filter(Boolean).join(' '),
  );
  return {
    productId: getProductId(baseProduct),
    merchantId: getMerchantId(baseProduct),
    brand,
    leafCategory,
    parentCategory,
    priceAmount,
    currency: normalizeCurrency(baseProduct, 'USD'),
    tokens,
    isExternal: isExternalProduct(baseProduct),
    vertical: verticalSignal.vertical || UNKNOWN_VERTICAL,
    verticalInferred: Boolean(verticalSignal.inferred),
    verticalKeywords: verticalSignal.matched_keywords || [],
    lipFocused: isLipFocusedProduct(baseProduct),
  };
}

function buildCandidateFeatures(candidateProduct, baseCurrency) {
  const brand = getBrandName(candidateProduct);
  const leafCategory = getLeafCategory(candidateProduct);
  const parentCategory = getParentCategory(candidateProduct);
  const priceAmount = getPriceAmount(candidateProduct);
  const currency = normalizeCurrency(candidateProduct, baseCurrency);
  const verticalSignal = inferVerticalFromProduct(candidateProduct);
  const tokens = tokenize(
    [candidateProduct.title, candidateProduct.name, leafCategory, parentCategory].filter(Boolean).join(' '),
  );
  return {
    productId: getProductId(candidateProduct),
    merchantId: getMerchantId(candidateProduct),
    brand,
    leafCategory,
    parentCategory,
    priceAmount,
    currency,
    tokens,
    isExternal: isExternalProduct(candidateProduct),
    vertical: verticalSignal.vertical || UNKNOWN_VERTICAL,
    verticalInferred: Boolean(verticalSignal.inferred),
    lipFocused: isLipFocusedProduct(candidateProduct),
  };
}

function confidenceRank(level) {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  return 1;
}

function getExternalSeedSuppressionFlags(product) {
  return ensureJsonObject(
    product?.external_seed_suppression_flags ||
      product?.suppression_flags ||
      product?.external_seed_recall?.suppression_flags,
  );
}

function classifyConfidenceLevel(base, candidate, layerId) {
  const nearPriceTight = candidate.relDiff != null && candidate.relDiff <= 0.25;
  if (candidate.brandMatch && candidate.leafMatch && nearPriceTight) return 'high';
  if (candidate.brandMatch && candidate.parentMatch && candidate.relDiff != null && candidate.relDiff <= 0.6) return 'high';
  if (candidate.leafMatch && nearPriceTight) return 'high';

  if (base.vertical !== UNKNOWN_VERTICAL && candidate.features.vertical !== UNKNOWN_VERTICAL) {
    if (
      base.vertical === candidate.features.vertical &&
      candidate.brandMatch &&
      candidate.relDiff != null &&
      candidate.relDiff <= 0.75
    ) {
      return 'medium';
    }
    if (base.vertical === candidate.features.vertical && candidate.tokenOverlap >= 0.12) return 'medium';
    if (base.vertical !== candidate.features.vertical) return 'low';
  }

  if (layerId === 'L4' && candidate.tokenOverlap >= 0.24) return 'medium';
  if (layerId === 'L5' && candidate.tokenOverlap >= 0.28) return 'medium';
  return 'low';
}

function classifySemanticFamily(base, candidate) {
  const sameVertical =
    base.vertical !== UNKNOWN_VERTICAL &&
    candidate?.features?.vertical !== UNKNOWN_VERTICAL &&
    base.vertical === candidate.features.vertical;

  if (candidate.brandMatch && candidate.leafMatch) return 'same_brand_same_category';
  if (
    candidate.brandMatch &&
    !candidate.leafMatch &&
    (
      candidate.parentMatch ||
      sameVertical ||
      (base.vertical === UNKNOWN_VERTICAL && candidate.tokenOverlap >= 0.18)
    )
  ) {
    return 'same_brand_other_category';
  }
  if (!candidate.brandMatch && (candidate.leafMatch || candidate.parentMatch)) return 'other_brand_same_category';
  if (!candidate.brandMatch && sameVertical) return 'other_brand_same_vertical';
  return 'semantic_peer';
}

function shouldFilterKnownVerticalMismatch(base, candidate) {
  const candidateVertical = candidate?.features?.vertical || UNKNOWN_VERTICAL;
  if (base.lipFocused && !candidate?.features?.lipFocused) return true;
  if (base.vertical === 'fragrance') {
    const allowByVertical = candidateVertical === 'fragrance';
    const allowByToken = candidate.tokenOverlap >= 0.18 && candidateVertical !== 'tools';
    return !allowByVertical && !allowByToken;
  }
  if (!['skincare', 'makeup', 'haircare', 'bodycare'].includes(base.vertical)) return false;
  if (candidateVertical !== UNKNOWN_VERTICAL && candidateVertical !== base.vertical) {
    if ((candidate.leafMatch || candidate.parentMatch) && candidate.tokenOverlap >= 0.24) return false;
    return true;
  }
  if (candidate.leafMatch || candidate.parentMatch) return false;
  if (candidateVertical === base.vertical) return false;
  if (candidateVertical === UNKNOWN_VERTICAL && candidate.tokenOverlap >= 0.18) return false;
  return true;
}

function pickBalancedCandidates(candidates, k, baseIsExternal) {
  const K = Math.max(1, Math.min(Number(k || 6) || 6, 30));
  const selected = [];
  const used = new Set();

  const trySelectCandidate = (candidate) => {
    if (!candidate) return false;
    const key = `${candidate.features.merchantId}::${candidate.features.productId}`;
    if (!key || used.has(key)) return false;
    used.add(key);
    selected.push(candidate);
    return true;
  };

  const reserveFamilies = [];
  if (candidates.some((candidate) => candidate.semanticFamily === 'same_brand_same_category')) {
    reserveFamilies.push('same_brand_same_category');
  }
  if (K >= 5 && candidates.some((candidate) => candidate.semanticFamily === 'other_brand_same_category')) {
    reserveFamilies.push('other_brand_same_category');
  }
  if (K >= 5 && candidates.some((candidate) => candidate.semanticFamily === 'same_brand_other_category')) {
    reserveFamilies.push('same_brand_other_category');
  }
  if (K >= 6 && candidates.some((candidate) => candidate.semanticFamily === 'other_brand_same_vertical')) {
    reserveFamilies.push('other_brand_same_vertical');
  }

  for (const family of reserveFamilies) {
    const next = candidates.find(
      (candidate) =>
        candidate.semanticFamily === family &&
        !used.has(`${candidate.features.merchantId}::${candidate.features.productId}`),
    );
    trySelectCandidate(next);
    if (selected.length >= K) return selected.slice(0, K);
  }

  const remainingCandidates = candidates.filter(
    (candidate) => !used.has(`${candidate.features.merchantId}::${candidate.features.productId}`),
  );
  const internalQueue = remainingCandidates.filter((c) => c.source === 'internal');
  const externalQueue = remainingCandidates.filter((c) => c.source === 'external');
  if (!internalQueue.length || !externalQueue.length) {
    for (const candidate of remainingCandidates) {
      if (!trySelectCandidate(candidate)) continue;
      if (selected.length >= K) break;
    }
    return selected.slice(0, K);
  }

  const pattern = baseIsExternal ? ['internal', 'external'] : ['internal', 'internal', 'external'];
  const pointers = { internal: 0, external: 0 };

  const nextFromSource = (source) => {
    const queue = source === 'internal' ? internalQueue : externalQueue;
    while (pointers[source] < queue.length) {
      const candidate = queue[pointers[source]];
      pointers[source] += 1;
      if (used.has(`${candidate.features.merchantId}::${candidate.features.productId}`)) continue;
      return candidate;
    }
    return null;
  };

  while (selected.length < K) {
    let progress = false;
    for (const source of pattern) {
      if (selected.length >= K) break;
      const next = nextFromSource(source);
      if (!next) continue;
      trySelectCandidate(next);
      progress = true;
    }
    if (!progress) break;
  }

  if (selected.length < K) {
    for (const candidate of remainingCandidates) {
      if (selected.length >= K) break;
      trySelectCandidate(candidate);
    }
  }

  return selected.slice(0, K);
}

function pickLayeredRecommendations({
  baseProduct,
  internalCandidates,
  externalCandidates,
  k,
  baseSemantic = null,
  excludeItems = [],
}) {
  const K = Math.max(1, Math.min(Number(k || 6) || 6, 30));
  const base = buildBaseFeatures(baseProduct);
  const baseSemanticKey = getRecommendationSemanticKey(baseProduct, base.brand);
  const exclusionState = buildRecommendationExclusionState(excludeItems);

  const nearPriceTight = (relDiff) => relDiff != null && relDiff <= 0.25;
  const nearPriceLoose = (relDiff) => relDiff != null && relDiff <= 0.6;
  const layers = [
    {
      id: 'L1',
      name: 'same_brand+leaf_category+near_price',
      priority: 1,
      predicate: (c) => c.brandMatch && c.leafMatch && nearPriceTight(c.relDiff),
    },
    {
      id: 'L2',
      name: 'same_brand+parent_category+loose_price',
      priority: 2,
      predicate: (c) => c.brandMatch && c.parentMatch && nearPriceLoose(c.relDiff),
    },
    {
      id: 'L3',
      name: 'leaf_category+near_price',
      priority: 3,
      predicate: (c) => c.leafMatch && nearPriceTight(c.relDiff),
    },
    {
      id: 'L4',
      name: 'title_token_overlap',
      priority: 4,
      predicate: (c) => c.tokenOverlap >= 0.18,
    },
    {
      id: 'L5',
      name: 'semantic_fill',
      priority: 5,
      predicate: () => true,
    },
  ];

  const layerById = Object.fromEntries(layers.map((layer) => [layer.id, layer]));

  let filteredByVertical = 0;
  let filteredByConfidence = 0;

  const rawCandidates = [
    ...(Array.isArray(internalCandidates) ? internalCandidates : []),
    ...(Array.isArray(externalCandidates) ? externalCandidates : []),
  ]
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      if (!isSellable(p, { inStockOnly: true })) return null;
      const pid = getProductId(p);
      const mid = getMerchantId(p);
      if (!pid || !mid) return null;
      const suppressionFlags = getExternalSeedSuppressionFlags(p);
      if (suppressionFlags.exclude_from_similar === true || suppressionFlags.exclude_from_recall === true) {
        return null;
      }
      // Exclude the base product even if multiple merchants share the same product_id.
      // (In multi-offer scenarios those belong in offers[], not recommendations.)
      if (pid === base.productId) return null;
      if (shouldExcludeRecommendationProduct(p, exclusionState)) return null;
      const features = buildCandidateFeatures(p, base.currency);
      const source = features.isExternal ? 'external' : 'internal';
      const scoreDetail = scoreCandidate(base, features);
      const matchedLayer = layers.find((layer) => layer.predicate(scoreDetail)) || layers[layers.length - 1];

      if (shouldFilterKnownVerticalMismatch(base, { ...scoreDetail, features })) {
        filteredByVertical += 1;
        return null;
      }

      const confidence = classifyConfidenceLevel(base, { ...scoreDetail, features }, matchedLayer.id);
      const candidateHasSpecificCategory = Boolean(
        features.leafCategory && !['external', 'beauty'].includes(features.leafCategory),
      );
      const candidateRecall = ensureJsonObject(p.external_seed_recall);
      const candidateRecallExclusionFlags = ensureJsonObject(candidateRecall.exclusion_flags);
      const candidateExternalSimilarSloExempt =
        features.vertical === 'gift_card' ||
        Boolean(candidateRecallExclusionFlags.gift_card) ||
        Boolean(candidateRecallExclusionFlags.donation_bundle) ||
        Boolean(candidateRecallExclusionFlags.non_merchandise);
      const verticalCompatibleBrandFallback =
        scoreDetail.leafMatch ||
        scoreDetail.parentMatch ||
        (base.vertical !== UNKNOWN_VERTICAL && features.vertical === base.vertical) ||
        (base.vertical === UNKNOWN_VERTICAL && scoreDetail.tokenOverlap >= 0.18);
      const allowLowConfidenceExternalFallback =
        base.isExternal &&
        source === 'external' &&
        ((scoreDetail.brandMatch &&
          candidateHasSpecificCategory &&
          !candidateExternalSimilarSloExempt &&
          verticalCompatibleBrandFallback) ||
          (scoreDetail.brandMatch && candidateHasSpecificCategory && features.vertical === base.vertical) ||
          scoreDetail.leafMatch ||
          scoreDetail.parentMatch ||
          (base.vertical !== UNKNOWN_VERTICAL &&
            features.vertical === base.vertical &&
            (candidateHasSpecificCategory || scoreDetail.brandMatch || scoreDetail.tokenOverlap >= 0.08)));
      if (confidence === 'low') {
        if (allowLowConfidenceExternalFallback) {
          return {
            product: p,
            features,
            semanticKey: getRecommendationSemanticKey(p, features.brand),
            source,
            layerId: matchedLayer.id,
            layerName: matchedLayer.name,
            layerPriority: matchedLayer.priority,
            confidence,
            semanticFamily: classifySemanticFamily(base, { ...scoreDetail, features }),
            ...scoreDetail,
          };
        }
        filteredByConfidence += 1;
        return null;
      }

      return {
        product: p,
        features,
        semanticKey: getRecommendationSemanticKey(p, features.brand),
        source,
        layerId: matchedLayer.id,
        layerName: matchedLayer.name,
        layerPriority: matchedLayer.priority,
        confidence,
        semanticFamily: classifySemanticFamily(base, { ...scoreDetail, features }),
        ...scoreDetail,
      };
    })
    .filter(Boolean);

  // Stable, deterministic de-dupe by merchant_id+product_id.
  const uniqueCandidates = uniqueByKey(rawCandidates, (c) => `${c.features.merchantId}::${c.features.productId}`);

  // Avoid excessive work.
  const candidates = uniqueCandidates
    .sort((a, b) => {
      if (a.layerPriority !== b.layerPriority) return a.layerPriority - b.layerPriority;
      if (confidenceRank(a.confidence) !== confidenceRank(b.confidence)) {
        return confidenceRank(b.confidence) - confidenceRank(a.confidence);
      }
      if (a.score !== b.score) return b.score - a.score;
      return a.features.productId.localeCompare(b.features.productId);
    })
    .slice(0, 400);

  const seenSemanticKeys = new Set(baseSemanticKey ? [baseSemanticKey] : []);
  const semanticallyDedupedCandidates = [];
  for (const candidate of candidates) {
    const semanticKey = String(candidate.semanticKey || '').trim();
    if (semanticKey && seenSemanticKeys.has(semanticKey)) {
      continue;
    }
    if (semanticKey) {
      seenSemanticKeys.add(semanticKey);
    }
    semanticallyDedupedCandidates.push(candidate);
  }

  const layerCounts = {};
  for (const candidate of semanticallyDedupedCandidates) {
    layerCounts[candidate.layerId] = (layerCounts[candidate.layerId] || 0) + 1;
  }

  let chosenCandidates = pickBalancedCandidates(semanticallyDedupedCandidates, K, base.isExternal);
  const externalSeedMin = Math.min(4, K);
  if (base.isExternal && chosenCandidates.length < externalSeedMin) {
    const chosenKeys = new Set(
      chosenCandidates.map((candidate) => `${candidate.features.merchantId}::${candidate.features.productId}`),
    );
    const supplemental = semanticallyDedupedCandidates
      .filter((candidate) => {
        const key = `${candidate.features.merchantId}::${candidate.features.productId}`;
        if (chosenKeys.has(key)) return false;
        if (candidate.source !== 'external') return false;
        const sameDomainBrandVerticalFallback =
          candidate.brandMatch &&
          base.vertical !== UNKNOWN_VERTICAL &&
          candidate.features.vertical === base.vertical &&
          sharesExternalSeedDomain(baseProduct, candidate.product);
        return (
          (candidate.brandMatch &&
            candidate.features.leafCategory &&
            !['external', 'beauty'].includes(candidate.features.leafCategory) &&
            candidate.features.vertical === base.vertical) ||
          sameDomainBrandVerticalFallback ||
          candidate.leafMatch ||
          candidate.parentMatch ||
          (base.vertical !== UNKNOWN_VERTICAL && candidate.features.vertical === base.vertical)
        );
      })
      .slice(0, externalSeedMin - chosenCandidates.length);
    chosenCandidates = [...chosenCandidates, ...supplemental].slice(0, K);
  }
  const selected = chosenCandidates.map((candidate) =>
    toCandidate(candidate.product, {
      source: candidate.source,
      reason: `${candidate.layerId}:${candidate.source}:${layerById[candidate.layerId]?.name || ''}`,
      x_score: Number(candidate.score.toFixed(4)),
      x_confidence: candidate.confidence,
    }),
  );

  const sourceCounts = chosenCandidates.reduce(
    (acc, p) => {
      const s = p.source === 'external' ? 'external' : 'internal';
      acc[s] += 1;
      return acc;
    },
    { internal: 0, external: 0 },
  );

  const confidenceCounts = chosenCandidates.reduce(
    (acc, candidate) => {
      const level = candidate.confidence || 'low';
      acc[level] = (acc[level] || 0) + 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0 },
  );

  const familyCounts = chosenCandidates.reduce(
    (acc, candidate) => {
      const family = String(candidate.semanticFamily || 'semantic_peer');
      acc[family] = (acc[family] || 0) + 1;
      return acc;
    },
    {
      same_brand_same_category: 0,
      same_brand_other_category: 0,
      other_brand_same_category: 0,
      other_brand_same_vertical: 0,
      semantic_peer: 0,
    },
  );

  const signalStrength =
    Number(baseSemantic?.signal_strength) ||
    computeSemanticSignalStrength({
      brand: base.brand,
      leafCategory: base.leafCategory,
      vertical: base.vertical,
    });
  const baseSemanticStrong = signalStrength >= 2;

  const similarConfidence =
    !selected.length
      ? 'low'
      : confidenceCounts.high >= Math.max(1, Math.ceil(selected.length * 0.7))
        ? 'high'
        : confidenceCounts.high + confidenceCounts.medium >= Math.max(1, Math.ceil(selected.length * 0.8))
          ? 'medium'
          : 'low';
  const lowConfidence = selected.length < K || similarConfidence === 'low';

  const lowConfidenceReasonCodes = [];
  if (!baseSemanticStrong) lowConfidenceReasonCodes.push('BASE_SEMANTIC_WEAK');
  if (filteredByVertical > 0) lowConfidenceReasonCodes.push('CATEGORY_MISMATCH_FILTERED');
  if (selected.length < K) lowConfidenceReasonCodes.push('UNDERFILL_FOR_QUALITY');
  if (!lowConfidenceReasonCodes.length && lowConfidence) lowConfidenceReasonCodes.push('INSUFFICIENT_HIGH_CONFIDENCE');

  return {
    items: selected.slice(0, K),
    metadata: {
      has_more: semanticallyDedupedCandidates.length > chosenCandidates.length,
      similar_confidence: similarConfidence,
      low_confidence: lowConfidence,
      low_confidence_reason_codes: lowConfidenceReasonCodes,
      underfill: Math.max(0, K - selected.length),
      retrieval_mix: {
        internal: sourceCounts.internal,
        external: sourceCounts.external,
      },
      selection_mix: familyCounts,
      base_semantic: {
        brand: base.brand || null,
        vertical: base.vertical || UNKNOWN_VERTICAL,
        inferred: Boolean(baseSemantic?.vertical_inferred ?? base.verticalInferred),
        signal_strength: signalStrength,
      },
    },
    debug: {
      base: {
        product_id: base.productId,
        merchant_id: base.merchantId,
        brand: base.brand || null,
        leaf_category: base.leafCategory || null,
        parent_category: base.parentCategory || null,
        price_amount: base.priceAmount || null,
        currency: base.currency,
        is_external: base.isExternal,
        vertical: base.vertical || UNKNOWN_VERTICAL,
      },
      layers: layerCounts,
      families: familyCounts,
      candidates_total: semanticallyDedupedCandidates.length,
      sources: sourceCounts,
      confidence: confidenceCounts,
      filters: {
        by_vertical: filteredByVertical,
        by_confidence: filteredByConfidence,
      },
    },
  };
}

function buildProductsSearchRecallQuery(baseProduct) {
  const terms = [];
  const seen = new Set();
  const pushTerm = (value) => {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    const key = normalizeText(normalized);
    if (!normalized || !key || seen.has(key)) return;
    seen.add(key);
    terms.push(normalized);
  };

  pushTerm(getBrandName(baseProduct));
  pushTerm(getLeafCategory(baseProduct));
  pushTerm(getParentCategory(baseProduct));

  tokenize(String(baseProduct?.title || ''))
    .filter((token) => token.length >= 3 && !/^\d+$/.test(token))
    .slice(0, 3)
    .forEach(pushTerm);

  return terms.slice(0, 4).join(' ').trim();
}

function buildProductsSearchRecallQueries(baseProduct) {
  const queries = [];
  const seen = new Set();
  const brand = getBrandName(baseProduct);
  const leafCategory = getLeafCategory(baseProduct);
  const parentCategory = getParentCategory(baseProduct);
  const titleTokens = tokenize(String(baseProduct?.title || '')).slice(0, 2);

  const pushQuery = (...parts) => {
    const normalized = parts
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const key = normalizeText(normalized);
    if (!normalized || !key || seen.has(key)) return;
    seen.add(key);
    queries.push(normalized);
  };

  pushQuery(brand, leafCategory);
  pushQuery(brand);
  pushQuery(leafCategory, titleTokens);
  pushQuery(leafCategory);
  if (parentCategory && parentCategory !== leafCategory) pushQuery(brand, parentCategory);
  if (!queries.length) pushQuery(buildProductsSearchRecallQuery(baseProduct));

  return queries.slice(0, 4);
}

function buildSemanticSearchPatterns(...hints) {
  return expandCategorySemanticTerms(...hints).map((term) => `%${term}%`);
}

async function fetchInternalCandidates({ merchantId, limit, excludeMerchantId, baseProduct = null }) {
  const mid = String(merchantId || '').trim();
  const safeLimit = Math.min(Math.max(1, Number(limit || 120)), 400);
  const maxResults = safeLimit * 4;

  async function fetchFromProductsSearch(baseProduct) {
    const baseUrl = getProductsSearchBaseUrl();
    if (!baseUrl) return [];

    const headers = buildProductsSearchHeaders();
    const queryTexts = buildProductsSearchRecallQueries(baseProduct);
    const primaryQuery = queryTexts[0] || buildProductsSearchRecallQuery(baseProduct);
    const requests = [];
    if (mid && mid !== EXTERNAL_SEED_MERCHANT_ID) {
      requests.push({
        merchantId: mid,
        query: primaryQuery || '',
        limit: Math.min(80, maxResults),
      });
    }
    for (const [index, queryText] of queryTexts.entries()) {
      requests.push({
        merchantId: null,
        query: queryText,
        limit: index === 0 ? Math.min(140, maxResults) : Math.min(100, maxResults),
      });
    }
    if (!requests.length) {
      requests.push({
        merchantId: null,
        query: primaryQuery || '',
        limit: Math.min(140, maxResults),
      });
    }

    const out = [];
    const seen = new Set();
    const responses = await Promise.all(
      requests.map(async (step) => {
        const resp = await axios.get(`${baseUrl}/agent/v1/products/search`, {
          params: {
            ...(step.merchantId ? { merchant_id: step.merchantId } : {}),
            ...(step.query ? { query: step.query } : {}),
            in_stock_only: false,
            limit: step.limit,
            offset: 0,
          },
          headers,
          timeout: Math.max(500, PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS),
          validateStatus: () => true,
        });
        return { step, resp };
      }).map((task) =>
        task.catch((err) => ({ err })),
      ),
    );

    for (const response of responses) {
      if (response?.err) {
        logger.warn(
          {
            err: response.err?.message || String(response.err),
            merchant_id: response?.step?.merchantId || null,
            query: response?.step?.query || null,
          },
          'recommendations internal focused products/search failed',
        );
        continue;
      }
      const { step, resp } = response;
      if (!(resp.status >= 200 && resp.status < 300)) continue;

      const products = Array.isArray(resp.data?.products)
        ? resp.data.products
        : Array.isArray(resp.data?.results)
          ? resp.data.results
          : [];

      for (const product of products) {
        const candidate = toCandidate(product, {
          merchant_id: product?.merchant_id || step?.merchantId || undefined,
        });
        if (!candidate) continue;
        const candidateMerchantId = String(getMerchantId(candidate) || '').trim();
        if (!candidateMerchantId || candidateMerchantId === EXTERNAL_SEED_MERCHANT_ID) continue;
        if (!step?.merchantId && excludeMerchantId && candidateMerchantId === String(excludeMerchantId || '').trim()) {
          continue;
        }
        const key = `${candidateMerchantId}::${getProductId(candidate)}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(candidate);
        if (out.length >= maxResults) break;
      }
      if (out.length >= maxResults) break;
    }

    return out.slice(0, maxResults);
  }

  if (!process.env.DATABASE_URL) {
    return fetchFromProductsSearch(baseProduct);
  }
  const out = [];

  try {
    if (mid && mid !== EXTERNAL_SEED_MERCHANT_ID) {
      const res = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE merchant_id = $1
            AND (expires_at IS NULL OR expires_at > now())
            AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
          ORDER BY cached_at DESC NULLS LAST, id DESC
          LIMIT $2
        `,
        [mid, Math.min(safeLimit, 200)],
      );
      for (const row of res.rows || []) {
        if (row?.product_data) out.push(toCandidate(row.product_data, { merchant_id: mid }));
      }
    }
  } catch (err) {
    logger.warn({ err: err?.message || String(err), merchantId: mid }, 'recommendations internal merchant query failed');
  }

  const focusedSearchCandidates = await fetchFromProductsSearch(baseProduct);
  return uniqueByKey([...out, ...focusedSearchCandidates].filter(Boolean), (p) => `${getMerchantId(p)}::${getProductId(p)}`).slice(
    0,
    maxResults,
  );
}

function matchesFocusedCategoryRecall(
  product,
  { leafCategory = '', parentCategory = '', semanticPatterns = [], vertical = UNKNOWN_VERTICAL } = {},
) {
  const candidateLeaf = getLeafCategory(product);
  const candidateParent = getParentCategory(product);
  const candidateVertical = inferVerticalFromProduct(product).vertical || UNKNOWN_VERTICAL;
  if (leafCategory && candidateLeaf === leafCategory) return true;
  if (parentCategory && candidateParent === parentCategory && candidateVertical === vertical) return true;
  if (!semanticPatterns.length) {
    return vertical !== UNKNOWN_VERTICAL && candidateVertical === vertical;
  }
  const haystack = normalizeText(
    [
      product?.title,
      product?.category,
      product?.product_type,
      product?.description,
      product?.destination_url,
      product?.canonical_url,
    ]
      .filter(Boolean)
      .join(' '),
  );
  return semanticPatterns.some((pattern) => {
    const token = String(pattern || '').replace(/^%+|%+$/g, '').trim();
    return token && haystack.includes(token);
  });
}

function buildExternalBrandSearchPatterns(brandHint) {
  const normalized = normalizeText(brandHint);
  if (!normalized) return [];
  const compact = normalized.replace(/\s+/g, '');
  const core = normalized
    .replace(/\b(?:beauty|hair|skin\s+care|skincare|cosmetics|official)\b/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return Array.from(new Set([normalized, compact, core].filter((value) => value && value.length >= 3))).map(
    (value) => `%${value}%`,
  );
}

function parseDomainHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    return String(new URL(withProtocol).hostname || '').trim().toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0].trim().toLowerCase();
  }
}

function buildDomainVariants(value) {
  const host = parseDomainHost(value);
  if (!host) return [];
  const bare = host.replace(/^www\./i, '');
  return Array.from(new Set([host, bare, bare ? `www.${bare}` : ''].filter(Boolean)));
}

function getExternalSeedDomainHints(product) {
  return Array.from(
    new Set(
      [
        product?.domain,
        product?.external_seed_domain,
        product?.merchant_domain,
        product?.canonical_url,
        product?.destination_url,
      ]
        .flatMap((value) => buildDomainVariants(value))
        .filter(Boolean),
    ),
  );
}

function sharesExternalSeedDomain(baseProduct, candidateProduct) {
  const baseHints = new Set(getExternalSeedDomainHints(baseProduct));
  if (!baseHints.size) return false;
  return getExternalSeedDomainHints(candidateProduct).some((hint) => baseHints.has(hint));
}

async function fetchExternalCandidates({ brandHint, categoryHint, limit, baseProduct = null }) {
  if (!process.env.DATABASE_URL) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit || 180)), 500);
  const market = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US').trim().toUpperCase() || 'US';
  const tool = 'creator_agents';
  const baseProductIsExternal = isExternalProduct(baseProduct);
  const fetchPlan = buildExternalRecommendationFetchPlan({
    baseProductIsExternal,
    safeK: safeLimit,
  });

  const brand = normalizeText(brandHint);
  const brandPatterns = buildExternalBrandSearchPatterns(brand);
  const domainHints = baseProductIsExternal ? getExternalSeedDomainHints(baseProduct) : [];
  const leafCategory = normalizeText(categoryHint);
  const parentCategory = normalizeText(getParentCategory(baseProduct));
  const vertical = inferVerticalFromProduct(baseProduct || {}).vertical || UNKNOWN_VERTICAL;
  const exactCategoryTerms = [leafCategory, parentCategory]
    .filter(Boolean)
    .filter((value, index, self) => self.indexOf(value) === index);
  const semanticPatterns = buildSemanticSearchPatterns(categoryHint, parentCategory, vertical);

  async function runQuery(whereSql, params, cap, queryName) {
    try {
      const res = await query(
        `
          SELECT
            id,
            external_product_id,
            destination_url,
            canonical_url,
            domain,
            title,
            image_url,
            price_amount,
            price_currency,
            availability,
            jsonb_strip_nulls(jsonb_build_object(
              'derived',
              jsonb_strip_nulls(jsonb_build_object('recall', seed_data->'derived'->'recall'))
            )) AS seed_data,
            coalesce(
              seed_data->>'brand',
              seed_data->>'brand_name',
              seed_data->>'vendor',
              seed_data->>'vendor_name',
              seed_data->'snapshot'->>'brand',
              seed_data->'snapshot'->>'brand_name',
              seed_data->'snapshot'->>'vendor',
              seed_data->'snapshot'->>'vendor_name',
              ''
            ) as seed_brand,
            coalesce(
              seed_data->>'merchant_display_name',
              seed_data->'snapshot'->>'merchant_display_name',
              ''
            ) as seed_merchant_display_name,
            coalesce(
              seed_data->>'vendor',
              seed_data->'snapshot'->>'vendor',
              ''
            ) as seed_vendor,
            coalesce(
              seed_data->>'category',
              seed_data->'product'->>'category',
              seed_data->'snapshot'->>'category',
              ''
            ) as seed_category,
            coalesce(
              seed_data->>'product_type',
              seed_data->'product'->>'product_type',
              seed_data->'snapshot'->>'product_type',
              ''
            ) as seed_product_type,
            coalesce(
              seed_data->'snapshot'->>'category',
              ''
            ) as snapshot_category,
            coalesce(
              seed_data->'snapshot'->>'product_type',
              ''
            ) as snapshot_product_type,
            left(coalesce(seed_data->>'description', seed_data->'snapshot'->>'description', ''), 1200) as seed_description,
            updated_at,
            created_at
          FROM external_product_seeds
          WHERE status = 'active'
            AND market = $1
            AND (tool = '*' OR tool = $2)
            ${whereSql}
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT $3
        `,
        [market, tool, cap, ...params],
      );
      const products = [];
      for (const row of res.rows || []) {
        const p = buildExternalSeedBrandSearchProduct(row) || buildExternalSeedProduct(row);
        if (p) products.push(p);
      }
      return products;
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: queryName || 'external_recent' },
        'recommendations external query failed',
      );
      return [];
    }
  }

  function runQueryWithBudget(whereSql, params, cap, queryName) {
    return withSoftTimeout(
      runQuery(whereSql, params, cap, queryName),
      fetchPlan.external_query_timeout_ms,
      [],
      () => {
        logger.warn(
          {
            query: queryName || 'external_recent',
            timeout_ms: fetchPlan.external_query_timeout_ms,
            product_id: getProductId(baseProduct),
          },
          'recommendations external subquery timed out',
        );
      },
    );
  }

  const categorySurfaceSql = `
    lower(concat_ws(' ',
      coalesce(title, ''),
      coalesce(destination_url, ''),
      coalesce(canonical_url, ''),
      coalesce(seed_data->'derived'->'recall'->>'retrieval_title', ''),
      coalesce(seed_data->'derived'->'recall'->>'brand', ''),
      coalesce(
        seed_data->'derived'->'recall'->>'category',
        seed_data->>'category',
        seed_data->'product'->>'category',
        seed_data->'snapshot'->>'category',
        ''
      ),
      coalesce(
        seed_data->>'product_type',
        seed_data->'product'->>'product_type',
        seed_data->'snapshot'->>'product_type',
        ''
      ),
      coalesce(seed_data#>>'{derived,recall,ingredient_tokens}', ''),
      coalesce(seed_data#>>'{derived,recall,alias_tokens}', '')
    ))
  `;
  const brandExactSurfaceSql = `
    (
      ${EXTERNAL_SEED_RECALL_SQL_FIELDS.brand} = $4
      OR lower(coalesce(seed_data->>'brand', '')) = $4
      OR lower(coalesce(seed_data->>'brand_name', '')) = $4
      OR lower(coalesce(seed_data->>'vendor', '')) = $4
      OR lower(coalesce(seed_data->>'vendor_name', '')) = $4
      OR lower(coalesce(seed_data->'snapshot'->>'brand', '')) = $4
      OR lower(coalesce(seed_data->'snapshot'->>'brand_name', '')) = $4
      OR lower(coalesce(seed_data->'snapshot'->>'vendor', '')) = $4
      OR lower(coalesce(seed_data->'snapshot'->>'vendor_name', '')) = $4
      OR lower(coalesce(seed_data->'snapshot'->>'title', seed_data->>'title', title, '')) LIKE $4 || ' %'
    )
  `;
  const brandPatternSurfaceSql = `
    lower(concat_ws(' ',
        coalesce(domain, ''),
        coalesce(destination_url, ''),
        coalesce(canonical_url, ''),
        coalesce(title, ''),
        coalesce(seed_data->>'brand', ''),
        coalesce(seed_data->>'brand_name', ''),
        coalesce(seed_data->>'vendor', ''),
        coalesce(seed_data->>'vendor_name', ''),
        coalesce(seed_data->>'merchant_display_name', ''),
        coalesce(seed_data->'snapshot'->>'brand', ''),
        coalesce(seed_data->'snapshot'->>'brand_name', ''),
        coalesce(seed_data->'snapshot'->>'vendor', ''),
        coalesce(seed_data->'snapshot'->>'vendor_name', ''),
        coalesce(seed_data->'snapshot'->>'merchant_display_name', ''),
        coalesce(seed_data->'derived'->'recall'->>'brand', '')
      )) LIKE ANY($4::text[])
  `;
  const sameDomainCap = fetchPlan.same_domain_cap;
  const sameDomainEnoughThreshold = fetchPlan.same_domain_enough_threshold;
  const sameDomainMatches = domainHints.length
    ? await runQueryWithBudget(
        `AND lower(coalesce(domain, '')) = ANY($4::text[])`,
        [domainHints],
        sameDomainCap,
        'external_same_domain',
      )
    : [];
  const focusedSameDomainMatches = sameDomainMatches.filter((product) =>
    matchesFocusedCategoryRecall(product, {
      leafCategory,
      parentCategory,
      semanticPatterns,
      vertical,
    }),
  );
  if (
    focusedSameDomainMatches.length >= Math.min(8, safeLimit) ||
    sameDomainMatches.length >= sameDomainEnoughThreshold
  ) {
    return uniqueByKey(
      [...focusedSameDomainMatches, ...sameDomainMatches],
      (p) => `${getMerchantId(p)}::${getProductId(p)}`,
    ).slice(0, safeLimit * 3);
  }

  const brandExactMatches = brand
      ? await runQueryWithBudget(
        `AND ${brandExactSurfaceSql}`,
        [brand],
        fetchPlan.brand_exact_cap,
        'external_brand_exact',
      )
    : [];
  const focusedBrandExactMatches = brandExactMatches.filter((product) =>
    matchesFocusedCategoryRecall(product, {
      leafCategory,
      parentCategory,
      semanticPatterns,
      vertical,
    }),
  );
  if (focusedBrandExactMatches.length >= Math.min(8, safeLimit)) {
    return uniqueByKey(
      [...focusedBrandExactMatches, ...brandExactMatches],
      (p) => `${getMerchantId(p)}::${getProductId(p)}`,
    ).slice(0, safeLimit * 3);
  }

  const needsBrandPatternFallback = brandPatterns.length > 0;
  const brandPatternMatchesPromise = needsBrandPatternFallback
    ? runQueryWithBudget(
        `AND ${brandPatternSurfaceSql}`,
        [brandPatterns],
        fetchPlan.brand_pattern_cap,
        'external_brand_pattern',
      )
    : Promise.resolve([]);
  const categoryExactMatchesPromise = exactCategoryTerms.length
    ? runQueryWithBudget(
        `AND ${EXTERNAL_SEED_RECALL_SQL_FIELDS.category} = ANY($4::text[])`,
        [exactCategoryTerms],
        fetchPlan.category_exact_cap,
        'external_category_exact',
      )
    : Promise.resolve([]);
  const categorySemanticMatchesPromise = semanticPatterns.length
    ? runQueryWithBudget(
        `AND ${categorySurfaceSql} LIKE ANY($4::text[])`,
        [semanticPatterns],
        fetchPlan.category_semantic_cap,
        'external_category_semantic',
      )
    : Promise.resolve([]);
  const verticalMatchesPromise = vertical && vertical !== UNKNOWN_VERTICAL
    ? runQueryWithBudget(
        `AND ${EXTERNAL_SEED_RECALL_SQL_FIELDS.vertical} = $4`,
        [vertical],
        fetchPlan.vertical_cap,
        'external_same_vertical',
      )
    : Promise.resolve([]);

  const [brandPatternMatches, categoryExactMatches, categorySemanticMatches, verticalMatches] = await Promise.all([
    brandPatternMatchesPromise,
    categoryExactMatchesPromise,
    categorySemanticMatchesPromise,
    verticalMatchesPromise,
  ]);
  const brandMatches = uniqueByKey(
    [...brandExactMatches, ...brandPatternMatches],
    (p) => `${getMerchantId(p)}::${getProductId(p)}`,
  );

  const focusedCategoryMatches = uniqueByKey(
    [...categoryExactMatches, ...categorySemanticMatches],
    (p) => `${getMerchantId(p)}::${getProductId(p)}`,
  ).filter((product) =>
    matchesFocusedCategoryRecall(product, {
      leafCategory,
      parentCategory,
      semanticPatterns,
      vertical,
    }),
  );

  return uniqueByKey(
    [...focusedSameDomainMatches, ...sameDomainMatches, ...brandMatches, ...focusedCategoryMatches, ...verticalMatches],
    (p) => `${getMerchantId(p)}::${getProductId(p)}`,
  ).slice(0, safeLimit * 3);
}

function collectExternalLookupKeys(baseProduct) {
  const baseProductId = String(getProductId(baseProduct) || '').trim();
  const externalSeedId = String(
    baseProduct?.external_seed_id || baseProduct?.externalSeedId || '',
  ).trim();
  const externalProductIds = [
    String(baseProduct?.external_product_id || baseProduct?.externalProductId || '').trim(),
    String(baseProduct?.platform_product_id || baseProduct?.platformProductId || '').trim(),
    baseProductId.startsWith('ext_') ? baseProductId : '',
  ]
    .filter(Boolean)
    .filter((value, index, self) => self.indexOf(value) === index);

  return { externalSeedId, externalProductIds };
}

async function loadExternalSeedSemanticRecord(baseProduct) {
  if (!process.env.DATABASE_URL) return null;
  const { externalSeedId, externalProductIds } = collectExternalLookupKeys(baseProduct);
  if (!externalSeedId && !externalProductIds.length) return null;

  const clauses = [];
  const params = [];

  if (externalSeedId) {
    params.push(externalSeedId);
    clauses.push(`id::text = $${params.length}`);
  }

  for (const externalProductId of externalProductIds) {
    params.push(externalProductId);
    const bind = `$${params.length}`;
    clauses.push(
      `(external_product_id = ${bind} OR seed_data->>'external_product_id' = ${bind} OR seed_data->>'product_id' = ${bind})`,
    );
  }

  if (!clauses.length) return null;

  try {
    const res = await query(
      `
        SELECT id, external_product_id, title, seed_data, canonical_url, destination_url, domain, updated_at
        FROM external_product_seeds
        WHERE status = 'active'
          AND (${clauses.join(' OR ')})
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 1
      `,
      params,
    );
    return res.rows?.[0] || null;
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (msg.includes('external_product_seeds') && msg.includes('does not exist')) {
      return null;
    }
    logger.warn(
      {
        err: err?.message || String(err),
        product_id: getProductId(baseProduct),
      },
      'recommendations external semantic lookup failed',
    );
    return null;
  }
}

async function enrichExternalBaseProduct(baseProduct) {
  if (!isExternalProduct(baseProduct)) {
    const inferred = inferVerticalFromProduct(baseProduct);
    return {
      product: baseProduct,
      semantic: {
        vertical: inferred.vertical,
        vertical_inferred: inferred.inferred,
        signal_strength: computeSemanticSignalStrength({
          brand: getBrandName(baseProduct),
          leafCategory: getLeafCategory(baseProduct),
          vertical: inferred.vertical,
        }),
        rescue_applied: false,
        rescue_fields: [],
      },
    };
  }

  const enriched = { ...baseProduct };
  const rescueFields = [];
  const seedRecord = await loadExternalSeedSemanticRecord(baseProduct);
  const seedData = ensureJsonObject(seedRecord?.seed_data);
  const seedCanonicalProduct = seedRecord ? buildExternalSeedProduct(seedRecord) : null;
  const seedRecall = ensureJsonObject(seedCanonicalProduct?.external_seed_recall || seedData?.derived?.recall);

  const seedBrand = String(
    seedCanonicalProduct?.brand ||
    seedCanonicalProduct?.vendor ||
    seedRecall?.brand ||
    seedData?.brand ||
    seedData?.snapshot?.brand ||
    '',
  ).trim();
  if (!getBrandName(enriched) && seedBrand) {
    if (!String(enriched.brand || '').trim()) enriched.brand = seedBrand;
    if (!String(enriched.vendor || '').trim()) enriched.vendor = seedBrand;
    rescueFields.push('brand');
  }

  const seedCategory = String(
    normalizeSpecificCategory(seedCanonicalProduct?.category) ||
    normalizeSpecificCategory(seedCanonicalProduct?.product_type) ||
    inferRecallCategory(seedRecall) ||
    normalizeSpecificCategory(seedData?.category) ||
    normalizeSpecificCategory(seedData?.product?.category) ||
    normalizeSpecificCategory(seedData?.snapshot?.category) ||
    '',
  ).trim();
  if (!getLeafCategory(enriched) && seedCategory) {
    if (!String(enriched.category || '').trim()) enriched.category = seedCategory;
    if (!String(enriched.product_type || '').trim()) enriched.product_type = seedCategory;
    rescueFields.push('category');
  }

  const seedTitle = String(seedCanonicalProduct?.title || seedData?.title || seedRecord?.title || '').trim();
  if (!String(enriched.title || '').trim() && seedTitle) {
    enriched.title = seedTitle;
    rescueFields.push('title');
  }

  const seedDescription = String(
    seedCanonicalProduct?.description ||
    seedData?.description ||
    seedData?.snapshot?.description ||
    '',
  ).trim();
  if (!String(enriched.description || '').trim() && seedDescription) {
    enriched.description = seedDescription;
    rescueFields.push('description');
  }

  if (!String(enriched.external_seed_id || '').trim() && seedRecord?.id) {
    enriched.external_seed_id = String(seedRecord.id);
  }
  if (!String(enriched.external_product_id || '').trim() && seedRecord?.external_product_id) {
    enriched.external_product_id = String(seedRecord.external_product_id);
  }
  if (!enriched.external_seed_recall && Object.keys(seedRecall).length > 0) {
    enriched.external_seed_recall = seedRecall;
  }

  const inferred = inferVerticalFromProduct(enriched);
  const recallVertical = String(seedRecall?.vertical || '').trim();
  const vertical =
    inferred.vertical && inferred.vertical !== UNKNOWN_VERTICAL
      ? inferred.vertical
      : recallVertical || inferred.vertical;
  return {
    product: enriched,
    semantic: {
      vertical,
      vertical_inferred: inferred.inferred || Boolean(recallVertical),
      signal_strength: computeSemanticSignalStrength({
        brand: getBrandName(enriched),
        leafCategory: getLeafCategory(enriched),
        vertical,
      }),
      rescue_applied: rescueFields.length > 0,
      rescue_fields: rescueFields,
      external_seed_recall: seedRecall,
    },
  };
}

async function recommend({
  pdp_product,
  k = 6,
  locale = 'en-US',
  currency = null,
  options = {},
}) {
  const rawBaseProduct = pdp_product || {};
  const baseProductId = getProductId(rawBaseProduct);
  if (!baseProductId) {
    return { items: [], debug: { error: 'missing_product_id' } };
  }
  const baseMerchantId = getMerchantId(rawBaseProduct);
  const safeK = Math.max(1, Math.min(Number(k || 6) || 6, 30));

  const baseCurrency = currency || normalizeCurrency(rawBaseProduct, 'USD');
  const excludeItems = Array.isArray(options?.exclude_items) ? options.exclude_items : [];
  const cacheKey = JSON.stringify({
    merchant_id: baseMerchantId || null,
    product_id: baseProductId,
    k: safeK,
    locale: String(locale || 'en-US'),
    currency: baseCurrency,
  });

  const bypassCache =
    excludeItems.length > 0 ||
    options?.no_cache === true ||
    options?.cache_bypass === true ||
    options?.bypass_cache === true;
  const debugEnabled = options?.debug === true;

  if (!PDP_RECS_CACHE_ENABLED || bypassCache) {
    PDP_RECS_CACHE_METRICS.bypasses += 1;
  } else {
    const cached = getCacheEntry(cacheKey);
    if (cached?.value) {
      const ageMs = typeof cached.storedAtMs === 'number' ? Math.max(0, Date.now() - cached.storedAtMs) : 0;
      return debugEnabled
        ? { ...cached.value, cache: { hit: true, age_ms: ageMs, ttl_ms: PDP_RECS_CACHE_TTL_MS } }
        : cached.value;
    }
  }

  const start = Date.now();
  const { product: baseProduct, semantic: baseSemantic } = await enrichExternalBaseProduct(rawBaseProduct);
  const baseBrand = getBrandName(baseProduct);
  const baseLeaf = getLeafCategory(baseProduct);
  const baseSemanticStrong = Number(baseSemantic?.signal_strength || 0) >= 2;
  const baseProductIsExternal = isExternalProduct(baseProduct);
  const baseRecall = ensureJsonObject(baseProduct?.external_seed_recall);
  const baseRecallExclusionFlags = ensureJsonObject(baseRecall?.exclusion_flags);
  const baseExternalSimilarSloExempt =
    Boolean(baseRecallExclusionFlags.gift_card) ||
    Boolean(baseRecallExclusionFlags.donation_bundle) ||
    Boolean(baseRecallExclusionFlags.non_merchandise);
  const fetchPlan = buildExternalRecommendationFetchPlan({
    baseProductIsExternal,
    safeK,
  });
  const effectiveExternalFetchTimeoutMs = fetchPlan.external_fetch_timeout_ms;

  const providedInternal = Array.isArray(options?.internal_candidates) ? options.internal_candidates : null;
  const providedExternal = Array.isArray(options?.external_candidates) ? options.external_candidates : null;

  let internalTimedOut = false;
  let externalTimedOut = false;
  const internalCandidatesPromise = withSoftTimeout(
    providedInternal
      ? Promise.resolve(providedInternal)
      : fetchInternalCandidates({
          merchantId: getMerchantId(baseProduct),
          limit: Math.max(60, safeK * 10),
          excludeMerchantId: getMerchantId(baseProduct),
          baseProduct,
        }),
    fetchPlan.internal_fetch_timeout_ms,
    [],
    () => {
      internalTimedOut = true;
      logger.warn(
        {
          product_id: baseProductId,
          timeout_ms: fetchPlan.internal_fetch_timeout_ms,
        },
        'PDP recommendations internal candidate fetch timed out',
      );
    },
  );
  const parallelExternalCandidatesPromise =
    baseProductIsExternal && !providedExternal
      ? withSoftTimeout(
          fetchExternalCandidates({
            brandHint: baseBrand,
            categoryHint: baseLeaf,
            baseProduct,
            limit: fetchPlan.external_fetch_limit,
          }),
          effectiveExternalFetchTimeoutMs,
          [],
          () => {
            externalTimedOut = true;
            logger.warn(
              {
                product_id: baseProductId,
                timeout_ms: effectiveExternalFetchTimeoutMs,
              },
              'PDP recommendations external candidate fetch timed out',
            );
          },
        )
      : null;

  const internalCandidates = await internalCandidatesPromise;

  const internalCount = Array.isArray(internalCandidates) ? internalCandidates.length : 0;
  const skipExternalMin = Math.max(
    PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_ABS,
    Math.ceil(safeK * PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_MULTIPLIER),
  );
  const internalOnlyPreview =
    !providedExternal && !baseProductIsExternal
      ? pickLayeredRecommendations({
          baseProduct,
          internalCandidates,
          externalCandidates: [],
          k: safeK,
          baseSemantic,
          excludeItems,
        })
      : null;
  const internalQualifiedCount = Array.isArray(internalOnlyPreview?.items)
    ? internalOnlyPreview.items.length
    : 0;
  const shouldSkipExternal = shouldSkipExternalFetch({
    hasProvidedExternal: Boolean(providedExternal),
    baseProductIsExternal,
    baseSemanticStrong,
    internalCount,
    internalQualifiedCount,
    skipExternalMin,
    requestedCount: safeK,
  });

  const externalCandidates = shouldSkipExternal
    ? []
      : parallelExternalCandidatesPromise
        ? await parallelExternalCandidatesPromise
      : await withSoftTimeout(
        providedExternal
          ? Promise.resolve(providedExternal)
          : fetchExternalCandidates({
              brandHint: baseBrand,
              categoryHint: baseLeaf,
              baseProduct,
              limit: fetchPlan.external_fetch_limit,
            }),
        effectiveExternalFetchTimeoutMs,
        [],
        () => {
          externalTimedOut = true;
          logger.warn(
            {
              product_id: baseProductId,
              timeout_ms: effectiveExternalFetchTimeoutMs,
            },
            'PDP recommendations external candidate fetch timed out',
          );
        },
      );

  const picked = pickLayeredRecommendations({
    baseProduct,
    internalCandidates,
    externalCandidates,
    k: safeK,
    baseSemantic,
    excludeItems,
  });

  const elapsedMs = Date.now() - start;
  const result = {
    items: picked.items,
    metadata: {
      ...(picked.metadata || {}),
      low_confidence: Boolean(picked?.metadata?.low_confidence),
      ...(baseProductIsExternal
        ? {
            external_seed_recall_doc_version: String(baseRecall.version || 'v1'),
            external_seed_quality_status: baseExternalSimilarSloExempt ? 'similar_slo_exempt' : 'eligible',
          }
        : {}),
      ...(baseProductIsExternal &&
      !baseExternalSimilarSloExempt &&
      (picked.items?.length || 0) < Math.min(Math.max(4, safeK), safeK)
        ? {
            underfill_reason:
              (picked.items?.length || 0) === 0
                ? 'external_seed_similar_underfill'
                : 'external_seed_similar_partial_underfill',
          }
        : {}),
    },
    debug: {
      ...picked.debug,
      timing_ms: elapsedMs,
      fetch_strategy: {
        internal_count: internalCount,
        internal_qualified_count: internalQualifiedCount,
        external_count: Array.isArray(externalCandidates) ? externalCandidates.length : 0,
        internal_timed_out: internalTimedOut,
        external_timed_out: externalTimedOut,
        external_skipped: shouldSkipExternal,
        external_skip_min_candidates: skipExternalMin,
        base_semantic_strong: baseSemanticStrong,
        base_product_is_external: baseProductIsExternal,
        excluded_items_count: excludeItems.length,
      },
      base_semantic: baseSemantic || null,
      cache_key_hash: debugEnabled ? stableHashShort(cacheKey) : undefined,
    },
  };

  if (
    shouldCacheRecommendationResult({
      bypassCache,
      internalTimedOut,
      externalTimedOut,
      requestedCount: safeK,
      returnedCount: picked.items?.length || 0,
    })
  ) {
    setCacheEntry(cacheKey, result);
  }

  // Structured log for observability (no secrets).
  logger.info(
    {
      event: 'pdp_recommendations',
      product_id: baseProductId,
      k: safeK,
      timing_ms: elapsedMs,
      candidates_total: picked.debug?.candidates_total,
      layers: picked.debug?.layers,
      sources: picked.debug?.sources,
      similar_confidence: picked?.metadata?.similar_confidence || null,
      low_confidence: Boolean(picked?.metadata?.low_confidence),
      underfill: Math.max(0, safeK - (picked.items?.length || 0)),
    },
    'PDP recommendations generated',
  );

  return debugEnabled
    ? { ...result, cache: { hit: false, age_ms: 0, ttl_ms: PDP_RECS_CACHE_TTL_MS } }
    : result;
}

module.exports = {
  recommend,
  pickLayeredRecommendations,
  getCacheStats,
  // Exposed for tests.
  _internals: {
    resetCache: () => {
      PDP_RECS_CACHE.clear();
      PDP_RECS_CACHE_METRICS.hits = 0;
      PDP_RECS_CACHE_METRICS.misses = 0;
      PDP_RECS_CACHE_METRICS.sets = 0;
      PDP_RECS_CACHE_METRICS.bypasses = 0;
      PDP_RECS_CACHE_METRICS.evictions = 0;
    },
    normalizeText,
    tokenize,
    jaccard,
    getBrandName,
    getLeafCategory,
    getParentCategory,
    isExternalProduct,
    enrichExternalBaseProduct,
    fetchInternalCandidates,
    fetchExternalCandidates,
    shouldCacheRecommendationResult,
    shouldSkipExternalFetch,
    buildExternalRecommendationFetchPlan,
  },
};
