const crypto = require('node:crypto');

const logger = require('../logger');
const { query } = require('../db');
const {
  inferVerticalFromProduct,
  computeSemanticSignalStrength,
  UNKNOWN_VERTICAL,
} = require('./recoSemanticSignals');
const {
  EXTERNAL_SEED_MERCHANT_ID,
  ensureJsonObject,
} = require('./externalSeedProducts');
const {
  activeCatalogProductSourceWhere,
  activeProductsCacheSourceWhere,
} = require('./activeCatalogSourceSql');

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
const PDP_RECS_CARD_KB_CONTRACT_VERSION = 'pdp_recs_kb_card_v1';
const PDP_RECS_DEFAULT_K = Math.max(
  6,
  Math.min(60, Number(process.env.PDP_RECS_DEFAULT_K || 12) || 12),
);
const PDP_RECS_READY_MIN_COUNT = Math.max(
  1,
  Math.min(
    PDP_RECS_DEFAULT_K,
    Number(process.env.PDP_RECS_READY_MIN_COUNT || 6) || 6,
  ),
);
const PDP_RECS_EXTERNAL_FOCUSED_TARGET_RATIO = Math.max(
  0.25,
  Math.min(1, Number(process.env.PDP_RECS_EXTERNAL_FOCUSED_TARGET_RATIO || 0.65) || 0.65),
);
const PDP_RECS_MAX_K = Math.max(
  PDP_RECS_DEFAULT_K,
  Math.min(60, Number(process.env.PDP_RECS_MAX_K || 60) || 60),
);
const PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS = Math.max(
  300,
  parseTimeoutMs(process.env.PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS, 2200),
);
const PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS = Math.max(
  300,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS, 1200),
);
const PDP_RECS_EXTERNAL_BASE_FETCH_TIMEOUT_MS = Math.max(
  PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_BASE_FETCH_TIMEOUT_MS, 5000),
);
const PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS = Math.max(
  50,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS, 2200),
);
const PDP_RECS_EXTERNAL_DOMAIN_QUERY_TIMEOUT_MS = Math.max(
  PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_DOMAIN_QUERY_TIMEOUT_MS, 2200),
);
const PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS = Math.max(
  PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS, 3800),
);
const PDP_RECS_IDENTITY_DEDUPE_TIMEOUT_MS = Math.max(
  100,
  parseTimeoutMs(process.env.PDP_RECS_IDENTITY_DEDUPE_TIMEOUT_MS, 1800),
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
const PDP_RECS_EXTERNAL_FETCH_LIMIT_MIN = Math.max(
  24,
  Math.min(240, Number(process.env.PDP_RECS_EXTERNAL_FETCH_LIMIT_MIN || 48) || 48),
);
const PDP_RECS_EXTERNAL_FETCH_LIMIT_MULTIPLIER = Math.max(
  2,
  Math.min(15, Number(process.env.PDP_RECS_EXTERNAL_FETCH_LIMIT_MULTIPLIER || 4) || 4),
);
const PDP_RECS_EXTERNAL_RECALL_QUERY_CAP_MAX = Math.max(
  48,
  Math.min(240, Number(process.env.PDP_RECS_EXTERNAL_RECALL_QUERY_CAP_MAX || 144) || 144),
);
const PDP_RECS_CACHE = new Map(); // cacheKey -> { value, storedAtMs, expiresAtMs }
const PDP_RECS_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
  evictions: 0,
};

function visibleFallbacksEnabled() {
  return String(process.env.PDP_RECS_VISIBLE_FALLBACKS_ENABLED || '').trim().toLowerCase() === 'true';
}

function visibleBroadTitleLayerEnabled() {
  return (
    visibleFallbacksEnabled() ||
    String(process.env.PDP_RECS_VISIBLE_BROAD_TITLE_LAYER_ENABLED || '').trim().toLowerCase() === 'true'
  );
}

function recommendationFallbackPolicy() {
  const visibleFallbacks = visibleFallbacksEnabled();
  return {
    visible_fallbacks_enabled: visibleFallbacks,
    broad_title_layer_enabled: visibleBroadTitleLayerEnabled(),
    blocked_visible_fallbacks: visibleFallbacks
      ? []
      : [
          'external_recent',
          'recent_views_history_fallback',
          'title_token_overlap',
          'category_title_like',
          'global_recent_internal',
        ],
  };
}
const STORED_SEMANTIC_VERTICALS = new Set([
  'fragrance',
  'skincare',
  'haircare',
  'bodycare',
  'makeup',
  'tools',
]);
const STORED_SEMANTIC_VERTICAL_ALIASES = Object.freeze({
  beauty_tools: 'tools',
  beauty_tool: 'tools',
  tool: 'tools',
  skin_care: 'skincare',
  body_care: 'bodycare',
  hair_care: 'haircare',
});

function getCacheStats() {
  return {
    enabled: PDP_RECS_CACHE_ENABLED,
    ttl_ms: PDP_RECS_CACHE_TTL_MS,
    max_entries: PDP_RECS_CACHE_MAX_ENTRIES,
    size: PDP_RECS_CACHE.size,
    ...PDP_RECS_CACHE_METRICS,
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

function buildDatabaseNotConfiguredError(route = 'pdp_recommendations') {
  const err = new Error('DATABASE_URL is required for authority-grounded recommendations');
  err.code = 'DATABASE_NOT_CONFIGURED';
  err.route = route;
  return err;
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

function normalizeStoredSemanticVertical(value) {
  const normalized = normalizeText(value).replace(/\s+/g, '_');
  if (!normalized || normalized === UNKNOWN_VERTICAL) return '';
  const aliased = STORED_SEMANTIC_VERTICAL_ALIASES[normalized] || normalized;
  return STORED_SEMANTIC_VERTICALS.has(aliased) ? aliased : '';
}

function normalizeHostname(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function buildNormalizedAliases(input) {
  const normalized = normalizeText(input);
  if (!normalized) return [];
  return uniqueByKey(
    [
      normalized,
      normalized.replace(/\s+/g, ''),
    ],
    (value) => value,
  );
}

const BROAD_RECALL_TITLE_SCAN_CATEGORIES = new Set([
  'beauty',
  'makeup',
  'product',
  'products',
  'skin care',
  'skincare',
  'treatment',
]);

function buildCategoryTitleLikePatterns(input) {
  if (BROAD_RECALL_TITLE_SCAN_CATEGORIES.has(normalizeText(input))) return [];
  const aliases = buildNormalizedAliases(input);
  const patterns = [];
  for (const alias of aliases) {
    if (!alias || alias.length < 3) continue;
    patterns.push(`%${alias}%`);
    const tokens = alias.split(/[\s-]+/g).filter((token) => token.length >= 2);
    if (tokens.length > 1) patterns.push(`%${tokens.join('%')}%`);
  }
  return uniqueByKey(patterns, (value) => value);
}

function buildDomainLookupAliases(input) {
  const host = normalizeHostname(input);
  if (!host) return [];
  return uniqueByKey(
    [
      host,
      host.startsWith('www.') ? host.replace(/^www\./, '') : `www.${host}`,
    ],
    (value) => value,
  );
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

const BEAUTY_ACCESSORY_TITLE_RE =
  /\b(pouch|bag|holder|keychain|keyring|sticker|stickers|soap saver|gua sha|gwalsa|brush|tool|applicator|spatula|mirror|sharpener|headband|puff|sponge|towel|sachet|trial\s*kit|sample)\b/i;
const BEAUTY_SET_OR_BUNDLE_TITLE_RE =
  /\b(?:bundle|set|kit|duo|trio|collection|routine|campaign\s+look|look\s+bundle)\b/i;
const REFILL_TITLE_RE = /\brefill\b/i;
const STRICT_EXTERNAL_SAME_BRAND_LEAF_CATEGORIES = new Set([
  'brow pencil',
  'brow gel',
  'concealer',
  'foundation',
  'highlighter',
  'lip gloss',
  'lip oil',
  'lipstick',
  'mascara',
  'primer',
]);
const IDENTITY_COLLAPSE_PROTECTION_CATEGORIES = new Set([
  ...STRICT_EXTERNAL_SAME_BRAND_LEAF_CATEGORIES,
  'blush',
  'bronzer',
  'cushion',
  'eyeliner',
  'eyeshadow',
  'lip liner',
  'skin tint',
  'tinted moisturizer',
]);

const SIMILAR_INTENT_FAMILY_RULES = Object.freeze([
  {
    id: 'sunscreen',
    js: /\b(?:sunscreen|spf|sun\s*(?:cream|stick|milk|screen|fluid|lotion)?|uv)\b/i,
    sql: '\\m(sunscreen|spf|sun\\s*(cream|stick|milk|screen|fluid|lotion)?|uv)\\M',
  },
  {
    id: 'hand_cream',
    js: /\b(?:hand\s*cream|handhero)\b/i,
    sql: '\\m(hand\\s*cream|handhero)\\M',
  },
  {
    id: 'fragrance',
    js: /\b(?:fragrance|perfume|parfum|eau\s+de\s+(?:parfum|toilette)|cologne|roll\s+on\s+perfume)\b/i,
    sql: '\\m(fragrance|perfume|parfum|eau\\s+de\\s+(parfum|toilette)|cologne|roll\\s+on\\s+perfume)\\M',
  },
  {
    id: 'face_oil',
    js: /\b(?:face\s+oil|facial\s+oil)\b/i,
    sql: '\\m(face\\s+oil|facial\\s+oil)\\M',
  },
  {
    id: 'body_oil',
    js: /\b(?:body\s+(?:oil|lotion|cream|balm|moisturi[sz]er)|massage\s+oil)\b/i,
    sql: '\\m(body\\s+(oil|lotion|cream|balm|moisturi[sz]er)|massage\\s+oil)\\M',
  },
  {
    id: 'eye_cream',
    js: /\b(?:eye\s+cream|eye\s+creme|eye\s+cr[eè]me)\b/i,
    sql: '\\m(eye\\s+cream|eye\\s+creme|eye\\s+cr[eè]me)\\M',
  },
  {
    id: 'moisturizer',
    js: /\b(?:moisturi[sz](?:er|ing)|day\s+cream|face\s+cream|facial\s+cream|hydrating\s+cream|replenishing\s+cream)\b/i,
    sql: '\\m(moisturi[sz](er|ing)|day\\s+cream|face\\s+cream|facial\\s+cream|hydrating\\s+cream|replenishing\\s+cream)\\M',
  },
  {
    id: 'lip_oil',
    js: /\b(?:lip\s+oil|lip\s+glaze)\b/i,
    sql: '\\m(lip\\s+oil|lip\\s+glaze)\\M',
  },
  {
    id: 'highlighter',
    js: /\b(?:highlighter|illuminator)\b/i,
    sql: '\\m(highlighter|illuminator)\\M',
  },
  {
    id: 'foundation',
    js: /\b(?:foundation|cushion|skinveil|concealer)\b/i,
    sql: '\\m(foundation|cushion|skinveil|concealer)\\M',
  },
  {
    id: 'mask',
    js: /\b(?:hydrogel\s*mask|sheet\s*mask|gel\s*mask|sleeping\s*mask|wash\s*off\s*mask|eye\s*patch|mask)\b/i,
    sql: '\\m(hydrogel\\s*mask|sheet\\s*mask|gel\\s*mask|sleeping\\s*mask|wash\\s*off\\s*mask|eye\\s*patch|mask)\\M',
  },
  {
    id: 'micellar_cleansing_water',
    js: /\b(?:micellar|cleansing\s*water|make\s*up\s*remover|makeup\s*remover)\b/i,
    sql: '\\m(micellar|cleansing\\s*water|make\\s*up\\s*remover|makeup\\s*remover)\\M',
  },
]);

function getBeautyAccessoryKindFromText(text) {
  const normalized = normalizeText(text);
  if (!normalized || !BEAUTY_ACCESSORY_TITLE_RE.test(normalized)) return '';
  if (/\b(?:puff|sponge|applicator)\b/.test(normalized)) return 'applicator';
  if (/\b(?:brush|tool|spatula|mirror|sharpener|headband|gua sha|gwalsa)\b/.test(normalized)) return 'tool';
  if (/\b(?:pouch|bag|holder|keychain|keyring|soap saver|towel)\b/.test(normalized)) return 'storage';
  if (/\b(?:sticker|stickers)\b/.test(normalized)) return 'sticker';
  if (/\b(?:sachet|trial\s*kit|sample)\b/.test(normalized)) return 'sample';
  return 'accessory';
}

function getBeautyAccessoryKindFromFeatures(features) {
  return getBeautyAccessoryKindFromText(
    [
      features?.normalizedTitle,
      features?.leafCategory,
      features?.parentCategory,
    ].filter(Boolean).join(' '),
  );
}

function isSetOrBundleLikeFromText(text) {
  return BEAUTY_SET_OR_BUNDLE_TITLE_RE.test(normalizeText(text));
}

function isSetOrBundleLikeFromFeatures(features) {
  return isSetOrBundleLikeFromText(
    [
      features?.normalizedTitle,
      features?.leafCategory,
      features?.parentCategory,
      features?.productFamily,
      features?.sourceListingScope,
    ].filter(Boolean).join(' '),
  );
}

function isRefillLikeFromFeatures(features) {
  return REFILL_TITLE_RE.test(
    normalizeText(
      [
        features?.normalizedTitle,
        features?.leafCategory,
        features?.parentCategory,
        features?.productFamily,
        features?.sourceListingScope,
      ].filter(Boolean).join(' '),
    ),
  );
}

function accessoryKindsAreCompatible(baseKind, candidateKind) {
  if (!baseKind) return true;
  if (!candidateKind) return false;
  if (baseKind === candidateKind) return true;
  if (baseKind === 'tool') return candidateKind === 'applicator';
  return false;
}

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

function getParentExternalProductId(product) {
  return firstNonEmptyText(
    product?.parent_external_product_id,
    product?.parentExternalProductId,
    product?.seed_data?.parent_external_product_id,
  );
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

function getCategoryPath(product) {
  const raw = product?.category_path || product?.categoryPath;
  if (Array.isArray(raw)) return raw.map((v) => String(v || '').trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const category = String(product?.category || product?.product_type || product?.productType || '').trim();
  if (!category) return [];
  return category.split('/').map((s) => s.trim()).filter(Boolean);
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

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function recCardString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function extractRecommendationProductIntelBundle(kbEntry) {
  const analysis = asPlainObject(kbEntry?.analysis);
  if (!analysis) return null;
  return (
    asPlainObject(analysis.product_intel_v1) ||
    asPlainObject(analysis.product_intel) ||
    asPlainObject(analysis.bundle) ||
    null
  );
}

function collectRecommendationProductIntelKbKeys(product) {
  const keys = [];
  const add = (value) => {
    const id = recCardString(value);
    if (!id) return;
    const key = `product:${id}`;
    if (!keys.includes(key)) keys.push(key);
  };
  add(getProductId(product));
  add(product?.external_product_id);
  add(product?.sellable_item_group_id);
  add(product?.signature_id);
  add(product?.pivota_signature_id);
  add(product?.parent_external_product_id);
  add(product?.parent_product_id);
  return keys;
}

function pickReviewedRecommendationProductIntelEntry(product, entriesByKey) {
  if (!entriesByKey || typeof entriesByKey.get !== 'function') return null;
  for (const kbKey of collectRecommendationProductIntelKbKeys(product)) {
    const kbEntry = entriesByKey.get(kbKey);
    const bundle = extractRecommendationProductIntelBundle(kbEntry);
    if (!bundle) continue;
    return { kbEntry, bundle };
  }
  return null;
}

function isReviewedRecommendationProductIntel(kbEntry, bundle) {
  const sourceMeta = asPlainObject(kbEntry?.source_meta) || {};
  const provenance = asPlainObject(bundle?.provenance) || {};
  const core = asPlainObject(bundle?.product_intel_core) || {};
  const qualityState = recCardString(
    sourceMeta.quality_state ||
      provenance.quality_state ||
      bundle?.quality_state ||
      core.quality_state,
  ).toLowerCase();
  const reviewStatus = recCardString(sourceMeta.review_status || provenance.review_status).toLowerCase();
  const reviewerKind = recCardString(sourceMeta.reviewer_kind || provenance.reviewer_kind).toLowerCase();
  const source = recCardString(kbEntry?.source || provenance.source).toLowerCase();
  return (
    qualityState === 'reviewed' ||
    qualityState === 'verified' ||
    reviewStatus === 'completed' ||
    reviewerKind === 'human' ||
    source.includes('pivota_product_intel_pilot_selected')
  );
}

async function readProductIntelKbEntriesDirect(kbKeys) {
  const keys = Array.from(new Set((Array.isArray(kbKeys) ? kbKeys : []).map((key) => String(key || '').trim()).filter(Boolean)));
  if (!keys.length || !process.env.DATABASE_URL || typeof query !== 'function') return new Map();
  try {
    const res = await query(
      `
        SELECT kb_key, analysis, source, source_meta, last_success_at, last_error, created_at, updated_at
        FROM aurora_product_intel_kb
        WHERE kb_key = ANY($1::text[])
      `,
      [keys],
    );
    const out = new Map();
    for (const row of res?.rows || []) {
      const kbKey = recCardString(row?.kb_key);
      if (!kbKey) continue;
      out.set(kbKey, {
        kb_key: kbKey,
        analysis: asPlainObject(row.analysis) || null,
        source: recCardString(row.source) || null,
        source_meta: asPlainObject(row.source_meta) || null,
        last_success_at: row.last_success_at || null,
        last_error: asPlainObject(row.last_error) || null,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
      });
    }
    return out;
  } catch (err) {
    const message = String(err?.message || err || '');
    if (!message.includes('aurora_product_intel_kb') || !message.includes('does not exist')) {
      logger.warn(
        { err: err?.message || String(err), keys: keys.length },
        'recommendations product intel direct KB fallback failed',
      );
    }
    return new Map();
  }
}

function applyRecommendationProductIntelBundle(product, bundle) {
  const shoppingCard = asPlainObject(bundle?.shopping_card);
  const searchCard = asPlainObject(bundle?.search_card);
  const cardTitle = recCardString(shoppingCard?.title || searchCard?.title_candidate);
  const cardSubtitle = recCardString(shoppingCard?.subtitle || searchCard?.compact_candidate);
  const cardHighlight = recCardString(shoppingCard?.highlight || searchCard?.highlight_candidate);
  const cardBadge = recCardString(shoppingCard?.proof_badge || searchCard?.proof_badge_candidate);
  const cardIntro = recCardString(shoppingCard?.intro || searchCard?.intro_candidate);
  if (!shoppingCard && !searchCard && !cardHighlight && !cardSubtitle && !cardIntro) return product;
  return {
    ...product,
    product_intel: bundle,
    ...(shoppingCard ? { shopping_card: shoppingCard } : {}),
    ...(searchCard ? { search_card: searchCard } : {}),
    ...(cardTitle && !recCardString(product?.card_title) ? { card_title: cardTitle } : {}),
    ...(cardSubtitle && !recCardString(product?.card_subtitle) ? { card_subtitle: cardSubtitle } : {}),
    ...(cardHighlight && !recCardString(product?.card_highlight) ? { card_highlight: cardHighlight } : {}),
    ...(cardBadge && !recCardString(product?.card_badge) ? { card_badge: cardBadge } : {}),
    ...(cardIntro && !recCardString(product?.card_intro) ? { card_intro: cardIntro } : {}),
  };
}

async function hydrateRecommendationItemsWithReviewedProductIntel(items) {
  const list = Array.isArray(items) ? items : [];
  const stats = {
    attempted_count: 0,
    hydrated_count: 0,
    skipped_unreviewed_count: 0,
    failed: false,
    db_fallback_attempted_count: 0,
    db_fallback_hit_count: 0,
  };
  const kbKeysByItem = list.map((item) => collectRecommendationProductIntelKbKeys(item));
  const kbKeys = Array.from(new Set(kbKeysByItem.flat()));
  if (!kbKeys.length) return { items: list, stats };

  let getProductIntelKbEntries = null;
  try {
    ({ getProductIntelKbEntries } = require('../auroraBff/productIntelKbStore'));
  } catch {
    return { items: list, stats };
  }
  if (typeof getProductIntelKbEntries !== 'function') return { items: list, stats };

  let entriesByKey = null;
  try {
    entriesByKey = await getProductIntelKbEntries(kbKeys);
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err), items: list.length },
      'recommendations product intel card hydration failed',
    );
    return { items: list, stats: { ...stats, failed: true } };
  }
  if (!entriesByKey || typeof entriesByKey.get !== 'function') return { items: list, stats };

  stats.attempted_count = kbKeysByItem.filter((keys) => keys.length > 0).length;
  const missingKbKeys = Array.from(new Set(
    kbKeysByItem.flatMap((keys) => {
      const hasBundleForItem = keys.some((kbKey) =>
        extractRecommendationProductIntelBundle(entriesByKey.get(kbKey)),
      );
      if (hasBundleForItem) return [];
      return keys.filter((kbKey) => !extractRecommendationProductIntelBundle(entriesByKey.get(kbKey)));
    }),
  ));
  if (missingKbKeys.length) {
    stats.db_fallback_attempted_count = missingKbKeys.length;
    const directEntries = await readProductIntelKbEntriesDirect(missingKbKeys);
    if (directEntries?.size) {
      for (const [kbKey, entry] of directEntries.entries()) {
        if (!extractRecommendationProductIntelBundle(entry)) continue;
        entriesByKey.set(kbKey, entry);
        stats.db_fallback_hit_count += 1;
      }
    }
  }
  const hydrated = list.map((item) => {
    const picked = pickReviewedRecommendationProductIntelEntry(item, entriesByKey);
    if (!picked?.bundle) return item;
    const { kbEntry, bundle } = picked;
    if (!isReviewedRecommendationProductIntel(kbEntry, bundle)) {
      stats.skipped_unreviewed_count += 1;
      return item;
    }
    const next = applyRecommendationProductIntelBundle(item, bundle);
    if (next !== item) stats.hydrated_count += 1;
    return next;
  });
  return { items: hydrated, stats };
}

function buildCandidateKey(product) {
  return `${getMerchantId(product)}::${getProductId(product)}`;
}

function buildSourceListingRef(product) {
  const merchantId = getMerchantId(product);
  const productId = getProductId(product);
  if (!merchantId || !productId) return '';
  return `${merchantId}:${productId}`;
}

function buildRecommendationSemanticDedupeKey(product) {
  const brand = getBrandName(product);
  const title = normalizeText(product?.title || product?.name);
  if (!brand || !title) return '';
  return `${brand}::${title}`;
}

function normalizeRecommendationTitleForDedupe(title) {
  return normalizeText(title)
    .replace(/^(?:deal|sale|clearance)\s+/, '')
    .replace(/\s+(?:deal|sale|clearance)$/, '')
    .trim();
}

function buildRecommendationTitleDedupeKey(product) {
  return normalizeRecommendationTitleForDedupe(product?.title || product?.name);
}

function stripTerminalVariantToken(title) {
  const normalized = normalizeText(title);
  if (!normalized) return '';
  return normalized
    .replace(/\b(?:shade|color|colour|tone)\s+[a-z]{1,4}\d{1,4}$/i, '')
    .replace(/\b[a-z]{1,4}\d{1,4}$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildVariantAgnosticTitleKey(product) {
  const titleKey = buildRecommendationTitleDedupeKey(product);
  if (!titleKey) return '';
  const brand = getBrandName(product);
  const titleWithoutBrand =
    brand && titleKey.startsWith(`${brand} `)
      ? titleKey.slice(brand.length + 1).trim()
      : titleKey;
  const strippedTitle = stripTerminalVariantToken(titleWithoutBrand);
  if (!strippedTitle || strippedTitle === titleKey) return '';
  return brand ? `${brand}::${strippedTitle}` : strippedTitle;
}

function buildExcludedCandidateState(items = []) {
  const exactKeys = new Set();
  const productIds = new Set();
  const titleKeys = new Set();
  const variantAgnosticTitleKeys = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const productId = getProductId(item);
    const titleKey = buildRecommendationTitleDedupeKey(item);
    const variantAgnosticTitleKey = buildVariantAgnosticTitleKey(item);
    if (titleKey) titleKeys.add(titleKey);
    if (variantAgnosticTitleKey) variantAgnosticTitleKeys.add(variantAgnosticTitleKey);
    if (!productId) continue;
    const merchantId = getMerchantId(item);
    const parentExternalProductId = getParentExternalProductId(item);
    if (merchantId) {
      exactKeys.add(`${merchantId}::${productId}`);
    } else {
      productIds.add(productId);
    }
    if (parentExternalProductId) productIds.add(parentExternalProductId);
  }

  return { exactKeys, productIds, titleKeys, variantAgnosticTitleKeys };
}

function mergeExcludedCandidateStates(...states) {
  const exactKeys = new Set();
  const productIds = new Set();
  const titleKeys = new Set();
  const variantAgnosticTitleKeys = new Set();

  for (const state of states) {
    if (!state || typeof state !== 'object') continue;
    for (const key of state.exactKeys || []) exactKeys.add(key);
    for (const productId of state.productIds || []) productIds.add(productId);
    for (const titleKey of state.titleKeys || []) titleKeys.add(titleKey);
    for (const variantAgnosticTitleKey of state.variantAgnosticTitleKeys || []) {
      variantAgnosticTitleKeys.add(variantAgnosticTitleKey);
    }
  }

  return { exactKeys, productIds, titleKeys, variantAgnosticTitleKeys };
}

function isExcludedCandidate(product, state) {
  if (!product || !state) return false;
  const productId = getProductId(product);
  if (!productId) return false;
  if (state.productIds?.has(productId)) return true;
  const parentExternalProductId = getParentExternalProductId(product);
  if (parentExternalProductId && state.productIds?.has(parentExternalProductId)) return true;
  const titleKey = buildRecommendationTitleDedupeKey(product);
  if (titleKey && state.titleKeys?.has(titleKey)) return true;
  const variantAgnosticTitleKey = buildVariantAgnosticTitleKey(product);
  if (variantAgnosticTitleKey && state.variantAgnosticTitleKeys?.has(variantAgnosticTitleKey)) return true;
  const merchantId = getMerchantId(product);
  return merchantId ? state.exactKeys?.has(`${merchantId}::${productId}`) === true : false;
}

function filterCandidateCollection(candidates, state) {
  if (!state) return Array.isArray(candidates) ? candidates : [];
  return (Array.isArray(candidates) ? candidates : []).filter((candidate) => !isExcludedCandidate(candidate, state));
}

function normalizeRecentView(input) {
  const productId = String(input?.product_id || input?.productId || '').trim();
  if (!productId) return null;
  const merchantId =
    String(input?.merchant_id || input?.merchantId || '').trim() ||
    (productId.startsWith('ext_') ? EXTERNAL_SEED_MERCHANT_ID : '');

  return {
    product_id: productId,
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(input?.title ? { title: String(input.title).trim() } : {}),
    ...(input?.description ? { description: String(input.description).trim() } : {}),
    ...(input?.brand ? { brand: String(input.brand).trim() } : {}),
    ...(input?.category ? { category: String(input.category).trim() } : {}),
    ...(input?.product_type || input?.productType
      ? { product_type: String(input?.product_type || input?.productType).trim() }
      : {}),
    ...(input?.viewed_at || input?.viewedAt
      ? { viewed_at: String(input?.viewed_at || input?.viewedAt).trim() }
      : {}),
  };
}

function normalizeRecentViews(input, { excludeProductId = '', limit = 6 } = {}) {
  const excludedProductId = String(excludeProductId || '').trim();
  const out = [];
  const seen = new Set();

  for (const item of Array.isArray(input) ? input : []) {
    const normalized = normalizeRecentView(item);
    if (!normalized) continue;
    if (excludedProductId && normalized.product_id === excludedProductId) continue;
    const key = buildCandidateKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Math.min(Number(limit || 6) || 6, 12))) break;
  }

  return out;
}

function countRecommendationSources(items) {
  return (Array.isArray(items) ? items : []).reduce(
    (acc, item) => {
      const source = isExternalProduct(item) ? 'external' : 'internal';
      acc[source] += 1;
      return acc;
    },
    { internal: 0, external: 0 },
  );
}

function appendReasonCode(existingCodes, nextCode) {
  const codes = new Set(
    (Array.isArray(existingCodes) ? existingCodes : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  );
  if (nextCode) codes.add(String(nextCode).trim());
  return Array.from(codes);
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

function normalizeIdentityRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const sourceListingRef = String(row?.source_listing_ref || '').trim();
      const sellableItemGroupId = String(row?.sellable_item_group_id || '').trim();
      const productLineId = String(row?.product_line_id || '').trim();
      if (!sourceListingRef || (!sellableItemGroupId && !productLineId)) return null;
      return {
        source_listing_ref: sourceListingRef,
        sellable_item_group_id: sellableItemGroupId || null,
        product_line_id: productLineId || null,
        review_family_id: String(row?.review_family_id || '').trim() || null,
        identity_confidence:
          row?.identity_confidence == null ? null : Number(row.identity_confidence) || null,
      };
    })
    .filter(Boolean);
}

async function loadLiveIdentityRowsForRecommendationProducts(products, options = {}) {
  const queryFn = typeof options.queryFn === 'function' ? options.queryFn : query;
  const refs = uniqueByKey(
    (Array.isArray(products) ? products : []).map((product) => buildSourceListingRef(product)).filter(Boolean),
    (value) => value,
  ).slice(0, 600);
  if (!refs.length || !process.env.DATABASE_URL || typeof queryFn !== 'function') return [];

  try {
    const result = await queryFn(
      `
        SELECT
          source_listing_ref,
          sellable_item_group_id,
          product_line_id,
          review_family_id,
          identity_confidence
        FROM pdp_identity_listing
        WHERE source_listing_ref = ANY($1::text[])
          AND identity_status = 'approved'
          AND live_read_enabled = true
      `,
      [refs],
    );
    return normalizeIdentityRows(result?.rows);
  } catch (err) {
    const msg = String(err?.message || err || '');
    if (msg.includes('pdp_identity_listing') && msg.includes('does not exist')) return [];
    logger.warn(
      { err: err?.message || String(err), refs: refs.length },
      'recommendations identity dedupe lookup failed',
    );
    return [];
  }
}

function attachIdentityRow(product, row) {
  if (!product || !row) return product;
  return {
    ...product,
    ...(row.sellable_item_group_id && !product.sellable_item_group_id
      ? { sellable_item_group_id: row.sellable_item_group_id }
      : {}),
    ...(row.product_line_id && !product.product_line_id ? { product_line_id: row.product_line_id } : {}),
    ...(row.review_family_id && !product.review_family_id ? { review_family_id: row.review_family_id } : {}),
    ...(row.identity_confidence != null && product.identity_confidence == null
      ? { identity_confidence: row.identity_confidence }
      : {}),
  };
}

async function dedupeRecommendationCandidatesByIdentity({
  baseProduct,
  internalCandidates = [],
  externalCandidates = [],
  identityRows = null,
  identityRowsResolverFn = null,
} = {}) {
  const productsForLookup = [
    baseProduct,
    ...(Array.isArray(internalCandidates) ? internalCandidates : []),
    ...(Array.isArray(externalCandidates) ? externalCandidates : []),
  ].filter(Boolean);
  const stats = {
    applied: false,
    matched_candidates: 0,
    duplicate_candidates_dropped: 0,
    semantic_duplicates_dropped: 0,
    base_identity_excluded: 0,
    rows_loaded: 0,
  };

  let rows = normalizeIdentityRows(identityRows);
  if (!rows.length) {
    if (typeof identityRowsResolverFn === 'function') {
      rows = normalizeIdentityRows(await identityRowsResolverFn(productsForLookup));
    } else if (process.env.DATABASE_URL) {
      rows = normalizeIdentityRows(
        await withSoftTimeout(
          loadLiveIdentityRowsForRecommendationProducts(productsForLookup),
          PDP_RECS_IDENTITY_DEDUPE_TIMEOUT_MS,
          [],
          () => {
            logger.warn(
              { timeout_ms: PDP_RECS_IDENTITY_DEDUPE_TIMEOUT_MS },
              'recommendations identity dedupe lookup timed out',
            );
          },
        ),
      );
    }
  }

  if (!rows.length) {
    return {
      internalCandidates,
      externalCandidates,
      stats,
    };
  }

  const rowByRef = new Map(rows.map((row) => [row.source_listing_ref, row]));
  const baseRow = rowByRef.get(buildSourceListingRef(baseProduct)) || null;
  const baseSellableGroup = String(baseRow?.sellable_item_group_id || '').trim();
  const baseProductLine = String(baseRow?.product_line_id || '').trim();
  const baseSemanticKey = buildRecommendationSemanticDedupeKey(baseProduct);
  const seenSellableGroups = new Set();
  const seenProductLines = new Set();
  const seenSemanticKeys = new Set();
  stats.applied = true;
  stats.rows_loaded = rows.length;

  const processCandidates = (candidates) => {
    const out = [];
    const orderedCandidates = (Array.isArray(candidates) ? candidates : []).slice().sort((left, right) => {
      const leftHasIdentity = rowByRef.has(buildSourceListingRef(left)) ? 1 : 0;
      const rightHasIdentity = rowByRef.has(buildSourceListingRef(right)) ? 1 : 0;
      return rightHasIdentity - leftHasIdentity;
    });
    for (const candidate of orderedCandidates) {
      const row = rowByRef.get(buildSourceListingRef(candidate)) || null;
      const sellableGroup = String(row?.sellable_item_group_id || candidate?.sellable_item_group_id || '').trim();
      const productLine = String(row?.product_line_id || candidate?.product_line_id || '').trim();
      const semanticKey = buildRecommendationSemanticDedupeKey(candidate);

      if (row) stats.matched_candidates += 1;
      if (sellableGroup && baseSellableGroup && sellableGroup === baseSellableGroup) {
        stats.base_identity_excluded += 1;
        continue;
      }
      if (productLine && baseProductLine && productLine === baseProductLine) {
        stats.base_identity_excluded += 1;
        continue;
      }
      if (semanticKey && baseSemanticKey && semanticKey === baseSemanticKey) {
        stats.base_identity_excluded += 1;
        continue;
      }
      if (sellableGroup && seenSellableGroups.has(sellableGroup)) {
        stats.duplicate_candidates_dropped += 1;
        continue;
      }
      if (productLine && seenProductLines.has(productLine)) {
        stats.duplicate_candidates_dropped += 1;
        continue;
      }
      if (semanticKey && seenSemanticKeys.has(semanticKey)) {
        stats.semantic_duplicates_dropped += 1;
        continue;
      }
      if (sellableGroup) seenSellableGroups.add(sellableGroup);
      if (productLine) seenProductLines.add(productLine);
      if (semanticKey) seenSemanticKeys.add(semanticKey);
      out.push(row ? attachIdentityRow(candidate, row) : candidate);
    }
    return out;
  };

  return {
    internalCandidates: processCandidates(internalCandidates),
    externalCandidates: processCandidates(externalCandidates),
    stats,
  };
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function firstImageUrl(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const text = firstNonEmptyText(value.url, value.image_url, value.src);
      if (text) return text;
    }
  }
  return '';
}

function buildExternalSeedRecommendationCandidate(row, options = {}) {
  if (!row || typeof row !== 'object') return null;

  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const fallbackBrand = firstNonEmptyText(options.fallbackBrand);
  const fallbackCategory = firstNonEmptyText(options.fallbackCategory);
  const destinationUrl = firstNonEmptyText(
    row.destination_url,
    row.seed_destination_url,
    row.snapshot_destination_url,
    snapshot.destination_url,
    seedData.destination_url,
  );
  const canonicalUrl = firstNonEmptyText(
    row.canonical_url,
    row.seed_canonical_url,
    row.snapshot_canonical_url,
    snapshot.canonical_url,
    seedData.canonical_url,
  );
  const sourceUrl = firstNonEmptyText(
    row.source_url,
    row.seed_source_url,
    row.snapshot_source_url,
    seedData.source_url,
    snapshot.source_url,
    canonicalUrl,
    destinationUrl,
  );
  const externalProductId = firstNonEmptyText(
    row.external_product_id,
    row.seed_external_product_id,
    seedData.external_product_id,
    seedData.product_id,
    row.snapshot_product_id,
    snapshot.product_id,
  );
  const parentExternalProductId = firstNonEmptyText(
    row.seed_parent_external_product_id,
    row.snapshot_parent_external_product_id,
    seedData.parent_external_product_id,
    snapshot.parent_external_product_id,
  );
  const sourceListingScope = firstNonEmptyText(
    row.seed_source_listing_scope,
    row.snapshot_source_listing_scope,
    seedData.source_listing_scope,
    snapshot.source_listing_scope,
  );
  const variantTitle = firstNonEmptyText(
    row.seed_variant_title,
    row.snapshot_variant_title,
    seedData.variant_title,
    snapshot.variant_title,
  );
  const recallCategory = firstNonEmptyText(
    row.recall_category,
    seedData.recall_category,
    seedData.derived?.recall?.category,
  );
  const recallVertical = normalizeStoredSemanticVertical(
    firstNonEmptyText(
      row.recall_vertical,
      seedData.recall_vertical,
      seedData.semantic_vertical,
      seedData.derived?.recall?.vertical,
    ),
  );
  const catalogCategoryPath = normalizeCatalogCategoryPath(
    firstNonEmptyText(
      row.catalog_category_path,
      seedData.catalog_category_path,
      seedData.category_path,
      snapshot.catalog_category_path,
      snapshot.category_path,
    ),
  );
  const catalogPathVertical = semanticVerticalFromCatalogCategoryPath(catalogCategoryPath);

  if (!externalProductId) return null;

  const title = firstNonEmptyText(
    row.seed_title,
    row.snapshot_title,
    seedData.title,
    snapshot.title,
    row.title,
    canonicalUrl,
    destinationUrl,
    externalProductId,
  );
  const description = firstNonEmptyText(
    row.seed_description,
    row.description,
    seedData.description,
    snapshot.description,
  );
  const brand = firstNonEmptyText(
    row.seed_brand,
    row.seed_brand_name,
    row.seed_vendor,
    row.seed_vendor_name,
    row.snapshot_brand,
    row.snapshot_brand_name,
    row.snapshot_vendor,
    row.snapshot_vendor_name,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    seedData.vendor_name,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
    snapshot.vendor_name,
    fallbackBrand,
  );
  const productType = firstNonEmptyText(
    row.seed_product_type,
    row.seed_product_type_camel,
    row.snapshot_product_type,
    row.snapshot_product_type_camel,
    recallCategory,
    seedData.product_type,
    seedData.productType,
    snapshot.product_type,
    snapshot.productType,
  );
  const category = firstNonEmptyText(
    row.seed_category,
    row.snapshot_category,
    recallCategory,
    seedData.category,
    seedData.product?.category,
    snapshot.category,
    productType,
    categoryLeafFromCatalogPath(catalogCategoryPath),
    fallbackCategory,
  );
  const imageUrl = firstImageUrl(
    row.image_url,
    row.seed_image_url,
    row.snapshot_image_url,
    row.snapshot_image,
    row.snapshot_first_image,
    row.seed_first_image,
    snapshot.image_url,
    snapshot.image,
    seedData.image_url,
    seedData.image,
    Array.isArray(snapshot.images) ? snapshot.images[0] : null,
    Array.isArray(seedData.images) ? seedData.images[0] : null,
  );
  const rawPriceAmount =
    row.price_amount ??
    row.seed_price_amount ??
    row.seed_price ??
    row.snapshot_price_amount ??
    row.snapshot_price ??
    seedData.price_amount ??
    seedData.price ??
    snapshot.price_amount ??
    snapshot.price ??
    null;
  const priceAmount =
    rawPriceAmount == null || rawPriceAmount === '' ? null : normalizeAmount(rawPriceAmount);
  const priceCurrency = firstNonEmptyText(
    row.price_currency,
    row.seed_price_currency,
    row.snapshot_price_currency,
    seedData.price_currency,
    snapshot.price_currency,
    'USD',
  ).toUpperCase();
  const availability = firstNonEmptyText(
    row.availability,
    row.seed_availability,
    row.snapshot_availability,
    seedData.availability,
    snapshot.availability,
  );
  const normalizedAvailability = availability.toLowerCase();
  const inStock =
    normalizedAvailability
      ? !['out_of_stock', 'sold_out', 'unavailable', 'discontinued'].includes(normalizedAvailability)
      : true;

  return {
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    product_id: externalProductId,
    external_product_id: externalProductId,
    title,
    name: title,
    ...(brand ? { brand, vendor: brand } : {}),
    ...(category ? { category } : {}),
    ...(productType ? { product_type: productType } : category ? { product_type: category } : {}),
    ...(catalogCategoryPath ? { category_path: catalogCategoryPath, catalog_category_path: catalogCategoryPath } : {}),
    ...(description ? { description } : {}),
    ...(imageUrl ? { image_url: imageUrl, image: imageUrl } : {}),
    ...(priceAmount != null ? { price: priceAmount, price_amount: priceAmount } : {}),
    ...(priceCurrency ? { currency: priceCurrency, price_currency: priceCurrency } : {}),
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    ...(destinationUrl ? { destination_url: destinationUrl } : {}),
    ...(sourceUrl ? { source_url: sourceUrl, url: sourceUrl } : {}),
    ...(firstNonEmptyText(row.domain) ? { domain: firstNonEmptyText(row.domain) } : {}),
    ...(availability ? { availability } : {}),
    in_stock: inStock,
    status: 'active',
    platform: 'external',
    source: 'external_seed',
    ...(parentExternalProductId ? { parent_external_product_id: parentExternalProductId } : {}),
    ...(sourceListingScope ? { source_listing_scope: sourceListingScope } : {}),
    ...(variantTitle ? { variant_title: variantTitle } : {}),
    ...(catalogPathVertical || recallVertical
      ? {
          semantic_vertical: catalogPathVertical || recallVertical,
          recall_vertical: catalogPathVertical || recallVertical,
        }
      : {}),
  };
}

function normalizeCatalogCategoryPath(value) {
  const raw = Array.isArray(value) ? value.join('/') : String(value || '');
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\/{2,}/g, '/');
}

function getCatalogCategoryPathHint(product = {}) {
  const seedData = ensureJsonObject(product?.seed_data);
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return normalizeCatalogCategoryPath(
    firstNonEmptyText(
      product?.catalog_category_path,
      product?.catalogCategoryPath,
      product?.category_path,
      product?.categoryPath,
      seedData.catalog_category_path,
      seedData.category_path,
      snapshot.catalog_category_path,
      snapshot.category_path,
    ),
  );
}

function categoryLeafFromCatalogPath(path) {
  const normalized = normalizeCatalogCategoryPath(path);
  if (!normalized) return '';
  const parts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function semanticVerticalFromCatalogCategoryPath(path) {
  const normalized = normalizeCatalogCategoryPath(path);
  if (normalized.startsWith('beauty/makeup/')) return 'makeup';
  if (normalized.startsWith('beauty/skincare/')) return 'skincare';
  if (normalized.startsWith('beauty/fragrance/')) return 'fragrance';
  if (normalized.startsWith('beauty/hair') || normalized.startsWith('beauty/haircare/')) return 'haircare';
  return '';
}

function buildCatalogProductRecommendationCandidate(row, options = {}) {
  if (!row || typeof row !== 'object') return null;
  const productPayload = ensureJsonObject(row.product_payload);
  const seedData = ensureJsonObject(productPayload.seed_data || productPayload.external_seed?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const catalogCategoryPath = normalizeCatalogCategoryPath(
    firstNonEmptyText(row.category_path, productPayload.category_path, seedData.category_path, snapshot.category_path),
  );
  const sourceProductId = firstNonEmptyText(
    row.source_product_id,
    seedData.external_product_id,
    seedData.product_id,
    snapshot.product_id,
  );
  const isExternalSeedCatalogRow =
    String(row.merchant_id || '').trim() === EXTERNAL_SEED_MERCHANT_ID ||
    String(row.platform || '').trim() === EXTERNAL_SEED_MERCHANT_ID ||
    sourceProductId.startsWith('ext_') ||
    sourceProductId.includes(':');
  const productId = isExternalSeedCatalogRow
    ? sourceProductId
    : firstNonEmptyText(row.source_product_id, row.product_key, row.pivota_signature_id);
  if (!productId) return null;

  const leafCategory = categoryLeafFromCatalogPath(catalogCategoryPath);
  const recall = ensureJsonObject(seedData?.derived?.recall);
  const title = firstNonEmptyText(
    row.product_title,
    row.title,
    seedData.title,
    snapshot.title,
    row.canonical_url,
    row.product_key,
  );
  const brand = firstNonEmptyText(
    row.brand,
    recall.brand_name,
    recall.brand,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    snapshot.brand,
    snapshot.vendor,
    options.fallbackBrand,
  );
  const category = firstNonEmptyText(
    recall.category,
    row.category,
    row.product_type,
    seedData.category,
    seedData.product_type,
    snapshot.category,
    snapshot.product_type,
    leafCategory,
    options.fallbackCategory,
  );
  const semanticVertical = normalizeStoredSemanticVertical(
    firstNonEmptyText(recall.vertical, semanticVerticalFromCatalogCategoryPath(catalogCategoryPath)),
  );
  const imageUrl = firstImageUrl(
    row.product_image_url,
    row.image_url,
    productPayload.image_url,
    seedData.image_url,
    snapshot.image_url,
    snapshot.image,
    Array.isArray(seedData.images) ? seedData.images[0] : null,
    Array.isArray(snapshot.images) ? snapshot.images[0] : null,
  );
  const rawPriceAmount =
    productPayload.price_amount ??
    productPayload.price ??
    seedData.price_amount ??
    seedData.price ??
    snapshot.price_amount ??
    snapshot.price ??
    null;
  const priceAmount =
    rawPriceAmount == null || rawPriceAmount === '' ? null : normalizeAmount(rawPriceAmount);
  const priceCurrency = firstNonEmptyText(
    productPayload.price_currency,
    seedData.price_currency,
    snapshot.price_currency,
    'USD',
  ).toUpperCase();
  const availability = firstNonEmptyText(
    productPayload.availability,
    seedData.availability,
    snapshot.availability,
  );
  const normalizedAvailability = availability.toLowerCase();
  const inStock = normalizedAvailability
    ? !['out_of_stock', 'sold_out', 'unavailable', 'discontinued', 'out of stock'].includes(normalizedAvailability)
    : true;
  const pivotaSignatureId = firstNonEmptyText(row.pivota_signature_id, productPayload.pivota_signature_id);
  const pivotaCanonicalUrl = firstNonEmptyText(
    row.pivota_canonical_url,
    productPayload.pivota_canonical_url,
    pivotaSignatureId ? `https://agent.pivota.cc/products/${pivotaSignatureId}` : '',
  );
  const canonicalUrl = firstNonEmptyText(
    pivotaCanonicalUrl,
    row.canonical_url,
    seedData.canonical_url,
    snapshot.canonical_url,
    seedData.destination_url,
    snapshot.destination_url,
  );

  return {
    merchant_id: isExternalSeedCatalogRow ? EXTERNAL_SEED_MERCHANT_ID : firstNonEmptyText(row.merchant_id),
    product_id: productId,
    id: productId,
    ...(isExternalSeedCatalogRow ? { external_product_id: productId, source_product_id: productId } : {}),
    ...(pivotaSignatureId ? { pivota_signature_id: pivotaSignatureId, signature_id: pivotaSignatureId } : {}),
    ...(firstNonEmptyText(row.product_key) ? { product_key: firstNonEmptyText(row.product_key), catalog_product_key: firstNonEmptyText(row.product_key) } : {}),
    title,
    name: title,
    ...(brand ? { brand, vendor: brand } : {}),
    ...(category ? { category, product_type: firstNonEmptyText(row.product_type, category) } : {}),
    ...(catalogCategoryPath ? { category_path: catalogCategoryPath, catalog_category_path: catalogCategoryPath } : {}),
    ...(imageUrl ? { image_url: imageUrl, image: imageUrl } : {}),
    ...(priceAmount != null ? { price: priceAmount, price_amount: priceAmount } : {}),
    ...(priceCurrency ? { currency: priceCurrency, price_currency: priceCurrency } : {}),
    ...(canonicalUrl ? { canonical_url: canonicalUrl, url: canonicalUrl } : {}),
    ...(firstNonEmptyText(seedData.destination_url, snapshot.destination_url) ? { destination_url: firstNonEmptyText(seedData.destination_url, snapshot.destination_url) } : {}),
    ...(firstNonEmptyText(seedData.domain, snapshot.domain) ? { domain: firstNonEmptyText(seedData.domain, snapshot.domain) } : {}),
    ...(availability ? { availability } : {}),
    in_stock: inStock,
    status: 'active',
    platform: isExternalSeedCatalogRow ? 'external' : firstNonEmptyText(row.platform, 'catalog'),
    source: isExternalSeedCatalogRow ? 'external_seed' : 'catalog_products',
    retrieval_source: 'catalog_category_path',
    ...(semanticVertical ? { semantic_vertical: semanticVertical, recall_vertical: semanticVertical } : {}),
  };
}

const EXTERNAL_SEED_RECOMMENDATION_SELECT = `
            id,
            external_product_id,
            destination_url,
            canonical_url,
            domain,
            (SELECT catalog_seed_product.category_path
               FROM catalog_products catalog_seed_product
              WHERE catalog_seed_product.merchant_id = 'external_seed'
                AND catalog_seed_product.platform = 'external_seed'
                AND catalog_seed_product.source_product_id = external_product_seeds.external_product_id
              LIMIT 1) AS catalog_category_path,
            title,
            image_url,
            price_amount,
            price_currency,
            availability,
            updated_at,
            created_at,
            seed_data->>'title' AS seed_title,
            coalesce(seed_data->>'brand', seed_data->'derived'->'recall'->>'brand') AS seed_brand,
            seed_data->>'brand_name' AS seed_brand_name,
            seed_data->>'vendor' AS seed_vendor,
            seed_data->>'vendor_name' AS seed_vendor_name,
            coalesce(seed_data->>'category', seed_data->'derived'->'recall'->>'category') AS seed_category,
            coalesce(seed_data->>'product_type', seed_data->'derived'->'recall'->>'category') AS seed_product_type,
            seed_data->>'productType' AS seed_product_type_camel,
            seed_data->'derived'->'recall'->>'category' AS recall_category,
            seed_data->'derived'->'recall'->>'vertical' AS recall_vertical,
            seed_data->>'image_url' AS seed_image_url,
            seed_data->>'price_amount' AS seed_price_amount,
            seed_data->>'price' AS seed_price,
            seed_data->>'price_currency' AS seed_price_currency,
            seed_data->>'availability' AS seed_availability,
            seed_data->>'canonical_url' AS seed_canonical_url,
            seed_data->>'destination_url' AS seed_destination_url,
            seed_data->>'source_url' AS seed_source_url,
            seed_data->>'external_product_id' AS seed_external_product_id,
            seed_data->>'parent_external_product_id' AS seed_parent_external_product_id,
            seed_data->>'source_listing_scope' AS seed_source_listing_scope,
            seed_data->>'variant_title' AS seed_variant_title,
            seed_data->'snapshot'->>'title' AS snapshot_title,
            seed_data->'snapshot'->>'brand' AS snapshot_brand,
            seed_data->'snapshot'->>'brand_name' AS snapshot_brand_name,
            seed_data->'snapshot'->>'vendor' AS snapshot_vendor,
            seed_data->'snapshot'->>'vendor_name' AS snapshot_vendor_name,
            seed_data->'snapshot'->>'category' AS snapshot_category,
            seed_data->'snapshot'->>'product_type' AS snapshot_product_type,
            seed_data->'snapshot'->>'productType' AS snapshot_product_type_camel,
            seed_data->'snapshot'->>'image_url' AS snapshot_image_url,
            seed_data->'snapshot'->>'image' AS snapshot_image,
            CASE
              WHEN jsonb_typeof(seed_data->'snapshot'->'images') = 'array'
              THEN seed_data->'snapshot'->'images'->>0
              ELSE NULL
            END AS snapshot_first_image,
            CASE
              WHEN jsonb_typeof(seed_data->'images') = 'array'
              THEN seed_data->'images'->>0
              ELSE NULL
            END AS seed_first_image,
            seed_data->'snapshot'->>'price_amount' AS snapshot_price_amount,
            seed_data->'snapshot'->>'price' AS snapshot_price,
            seed_data->'snapshot'->>'price_currency' AS snapshot_price_currency,
            seed_data->'snapshot'->>'availability' AS snapshot_availability,
            seed_data->'snapshot'->>'canonical_url' AS snapshot_canonical_url,
            seed_data->'snapshot'->>'destination_url' AS snapshot_destination_url,
            seed_data->'snapshot'->>'source_url' AS snapshot_source_url,
            seed_data->'snapshot'->>'product_id' AS snapshot_product_id,
            seed_data->'snapshot'->>'parent_external_product_id' AS snapshot_parent_external_product_id,
            seed_data->'snapshot'->>'source_listing_scope' AS snapshot_source_listing_scope,
            seed_data->'snapshot'->>'variant_title' AS snapshot_variant_title
`;

const EXTERNAL_SEED_FAST_RECOMMENDATION_SELECT = `
            id,
            external_product_id,
            destination_url,
            canonical_url,
            domain,
            (SELECT catalog_seed_product.category_path
               FROM catalog_products catalog_seed_product
              WHERE catalog_seed_product.merchant_id = 'external_seed'
                AND catalog_seed_product.platform = 'external_seed'
                AND catalog_seed_product.source_product_id = external_product_seeds.external_product_id
              LIMIT 1) AS catalog_category_path,
            title,
            image_url,
            price_amount,
            price_currency,
            availability,
            updated_at,
            created_at
`;

const EXTERNAL_SEED_LIGHT_RECOMMENDATION_SELECT = `
            id,
            external_product_id,
            destination_url,
            canonical_url,
            domain,
            (SELECT catalog_seed_product.category_path
               FROM catalog_products catalog_seed_product
              WHERE catalog_seed_product.merchant_id = 'external_seed'
                AND catalog_seed_product.platform = 'external_seed'
                AND catalog_seed_product.source_product_id = external_product_seeds.external_product_id
              LIMIT 1) AS catalog_category_path,
            title,
            image_url,
            price_amount,
            price_currency,
            availability,
            updated_at,
            created_at,
            coalesce(seed_data->>'brand', seed_data->'derived'->'recall'->>'brand') AS seed_brand,
            seed_data->>'brand_name' AS seed_brand_name,
            seed_data->>'vendor' AS seed_vendor,
            seed_data->>'vendor_name' AS seed_vendor_name,
            coalesce(seed_data->>'category', seed_data->'derived'->'recall'->>'category') AS seed_category,
            coalesce(seed_data->>'product_type', seed_data->'derived'->'recall'->>'category') AS seed_product_type,
            seed_data->'derived'->'recall'->>'category' AS recall_category,
            seed_data->'derived'->'recall'->>'vertical' AS recall_vertical,
            seed_data->>'image_url' AS seed_image_url,
            seed_data->>'price_amount' AS seed_price_amount,
            seed_data->>'price' AS seed_price,
            seed_data->>'price_currency' AS seed_price_currency,
            seed_data->>'availability' AS seed_availability,
            seed_data->>'canonical_url' AS seed_canonical_url,
            seed_data->>'destination_url' AS seed_destination_url
`;

const EXTERNAL_SEED_SEMANTIC_SELECT = `
        id,
        external_product_id,
        title,
        destination_url,
        canonical_url,
        domain,
        image_url,
        price_amount,
        price_currency,
        availability,
        (SELECT catalog_seed_product.category_path
           FROM catalog_products catalog_seed_product
          WHERE catalog_seed_product.merchant_id = 'external_seed'
            AND catalog_seed_product.platform = 'external_seed'
            AND catalog_seed_product.source_product_id = external_product_seeds.external_product_id
          LIMIT 1) AS catalog_category_path,
        jsonb_strip_nulls(jsonb_build_object(
          'title', seed_data->>'title',
          'brand', coalesce(seed_data->>'brand', seed_data->'derived'->'recall'->>'brand'),
          'brand_name', seed_data->>'brand_name',
          'vendor', seed_data->>'vendor',
          'vendor_name', seed_data->>'vendor_name',
          'category', coalesce(seed_data->>'category', seed_data->'derived'->'recall'->>'category'),
          'product_type', coalesce(seed_data->>'product_type', seed_data->'derived'->'recall'->>'category'),
          'productType', seed_data->>'productType',
          'catalog_category_path', (SELECT catalog_seed_product.category_path
             FROM catalog_products catalog_seed_product
            WHERE catalog_seed_product.merchant_id = 'external_seed'
              AND catalog_seed_product.platform = 'external_seed'
              AND catalog_seed_product.source_product_id = external_product_seeds.external_product_id
            LIMIT 1),
          'category_path', coalesce(seed_data->>'category_path', seed_data->>'catalog_category_path'),
          'recall_category', seed_data->'derived'->'recall'->>'category',
          'recall_vertical', seed_data->'derived'->'recall'->>'vertical',
          'description', seed_data->>'description',
          'canonical_url', seed_data->>'canonical_url',
          'destination_url', seed_data->>'destination_url',
          'domain', seed_data->>'domain',
          'image_url', seed_data->>'image_url',
          'price_amount', seed_data->>'price_amount',
          'price', seed_data->>'price',
          'price_currency', seed_data->>'price_currency',
          'availability', seed_data->>'availability',
          'snapshot', jsonb_strip_nulls(jsonb_build_object(
            'title', seed_data->'snapshot'->>'title',
            'brand', seed_data->'snapshot'->>'brand',
            'brand_name', seed_data->'snapshot'->>'brand_name',
            'vendor', seed_data->'snapshot'->>'vendor',
            'vendor_name', seed_data->'snapshot'->>'vendor_name',
            'category', seed_data->'snapshot'->>'category',
            'product_type', seed_data->'snapshot'->>'product_type',
            'productType', seed_data->'snapshot'->>'productType',
            'description', seed_data->'snapshot'->>'description',
            'canonical_url', seed_data->'snapshot'->>'canonical_url',
            'destination_url', seed_data->'snapshot'->>'destination_url',
            'domain', seed_data->'snapshot'->>'domain',
            'image_url', seed_data->'snapshot'->>'image_url',
            'image', seed_data->'snapshot'->'image',
            'price_amount', seed_data->'snapshot'->>'price_amount',
            'price', seed_data->'snapshot'->>'price',
            'price_currency', seed_data->'snapshot'->>'price_currency',
            'availability', seed_data->'snapshot'->>'availability'
          ))
        )) AS seed_data,
        updated_at
`;

function extractProductDomains(product) {
  return uniqueByKey(
    [
      product?.canonical_url,
      product?.canonicalUrl,
      product?.destination_url,
      product?.destinationUrl,
      product?.external_redirect_url,
      product?.externalRedirectUrl,
      product?.url,
      product?.source_url,
      product?.sourceUrl,
      product?.domain,
      product?.source_domain,
      product?.sourceDomain,
    ]
      .map((value) => normalizeHostname(value))
      .filter(Boolean),
    (value) => value,
  );
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

function resolveSemanticVerticalOverride(product, semantic = null) {
  return (
    normalizeStoredSemanticVertical(semantic?.vertical) ||
    normalizeStoredSemanticVertical(product?.semantic_vertical) ||
    normalizeStoredSemanticVertical(product?.recall_vertical)
  );
}

function buildBaseFeatures(baseProduct, semantic = null) {
  const brand = getBrandName(baseProduct);
  const leafCategory = getLeafCategory(baseProduct);
  const parentCategory = getParentCategory(baseProduct);
  const priceAmount = getPriceAmount(baseProduct);
  const semanticVertical = resolveSemanticVerticalOverride(baseProduct, semantic);
  const verticalSignal = semanticVertical
    ? { vertical: semanticVertical, inferred: false, matched_keywords: [] }
    : inferVerticalFromProduct(baseProduct);
  const tokens = tokenize([baseProduct.title, baseProduct.name, brand, leafCategory, parentCategory].filter(Boolean).join(' '));
  const normalizedTitle = normalizeText(baseProduct.title || baseProduct.name);
  const rawCategory = normalizeText(baseProduct.category || baseProduct.product_type || baseProduct.productType);
  const productType = normalizeText(baseProduct.product_type || baseProduct.productType || baseProduct.category);
  const accessoryKind = getBeautyAccessoryKindFromFeatures({ normalizedTitle, leafCategory, parentCategory });
  const productFamily = normalizeText(baseProduct.product_family || baseProduct.external_seed_product_family);
  const sourceListingScope = normalizeText(baseProduct.source_listing_scope || baseProduct.listing_scope);
  return {
    productId: getProductId(baseProduct),
    merchantId: getMerchantId(baseProduct),
    brand,
    leafCategory,
    parentCategory,
    priceAmount,
    currency: normalizeCurrency(baseProduct, 'USD'),
    tokens,
    normalizedTitle,
    rawCategory,
    productType,
    isExternal: isExternalProduct(baseProduct),
    vertical: verticalSignal.vertical || UNKNOWN_VERTICAL,
    verticalInferred: Boolean(verticalSignal.inferred),
    verticalKeywords: verticalSignal.matched_keywords || [],
    accessoryKind,
    productFamily,
    sourceListingScope,
    bundleLike: isSetOrBundleLikeFromFeatures({
      normalizedTitle,
      leafCategory,
      parentCategory,
      productFamily,
      sourceListingScope,
    }),
    refillLike: isRefillLikeFromFeatures({
      normalizedTitle,
      leafCategory,
      parentCategory,
      productFamily,
      sourceListingScope,
    }),
  };
}

function buildCandidateFeatures(candidateProduct, baseCurrency) {
  const brand = getBrandName(candidateProduct);
  const leafCategory = getLeafCategory(candidateProduct);
  const parentCategory = getParentCategory(candidateProduct);
  const priceAmount = getPriceAmount(candidateProduct);
  const currency = normalizeCurrency(candidateProduct, baseCurrency);
  const semanticVertical = resolveSemanticVerticalOverride(candidateProduct);
  const verticalSignal = semanticVertical
    ? { vertical: semanticVertical, inferred: false, matched_keywords: [] }
    : inferVerticalFromProduct(candidateProduct);
  const tokens = tokenize([candidateProduct.title, candidateProduct.name, brand, leafCategory, parentCategory].filter(Boolean).join(' '));
  const normalizedTitle = normalizeText(candidateProduct.title || candidateProduct.name);
  const rawCategory = normalizeText(candidateProduct.category || candidateProduct.product_type || candidateProduct.productType);
  const productType = normalizeText(candidateProduct.product_type || candidateProduct.productType || candidateProduct.category);
  const accessoryKind = getBeautyAccessoryKindFromFeatures({ normalizedTitle, leafCategory, parentCategory });
  const productFamily = normalizeText(candidateProduct.product_family || candidateProduct.external_seed_product_family);
  const sourceListingScope = normalizeText(candidateProduct.source_listing_scope || candidateProduct.listing_scope);
  return {
    productId: getProductId(candidateProduct),
    merchantId: getMerchantId(candidateProduct),
    brand,
    leafCategory,
    parentCategory,
    priceAmount,
    currency,
    tokens,
    normalizedTitle,
    rawCategory,
    productType,
    isExternal: isExternalProduct(candidateProduct),
    vertical: verticalSignal.vertical || UNKNOWN_VERTICAL,
    verticalInferred: Boolean(verticalSignal.inferred),
    accessoryKind,
    productFamily,
    sourceListingScope,
    bundleLike: isSetOrBundleLikeFromFeatures({
      normalizedTitle,
      leafCategory,
      parentCategory,
      productFamily,
      sourceListingScope,
    }),
    refillLike: isRefillLikeFromFeatures({
      normalizedTitle,
      leafCategory,
      parentCategory,
      productFamily,
      sourceListingScope,
    }),
  };
}

function titleSupportsLeafCategory(features) {
  const leaf = String(features?.leafCategory || '').trim();
  const title = String(features?.normalizedTitle || '').trim();
  if (!leaf || !title) return true;
  if (leaf === 'sunscreen') {
    return /\b(sunscreen|spf|sun\s*(?:milk|cream|lotion|fluid|stick|serum|gel|screen)?|uv)\b/i.test(title);
  }
  return true;
}

function requiresStrictExternalSameBrandIntent(features) {
  const title = String(features?.normalizedTitle || '').trim();
  const leaf = normalizeText(features?.leafCategory || '');
  if (leaf && STRICT_EXTERNAL_SAME_BRAND_LEAF_CATEGORIES.has(leaf)) return true;
  if (!title) return false;
  return /\b(sunscreen|spf|sun\s*(?:milk|cream|lotion|fluid|stick|serum|gel|screen)?|uv)\b/i.test(title);
}

function requiresIdentityCollapseProtectionForExternalRecall({ categoryHint = '', intentFamilyHint = '' } = {}) {
  const category = normalizeText(categoryHint);
  const intentFamily = normalizeText(intentFamilyHint);
  return (
    intentFamily === 'foundation' ||
    (category && IDENTITY_COLLAPSE_PROTECTION_CATEGORIES.has(category))
  );
}

function focusedRecallTargetCount(safeMinFocusedCandidates) {
  return Math.max(
    PDP_RECS_READY_MIN_COUNT,
    Math.min(
      PDP_RECS_DEFAULT_K,
      Math.max(1, Number(safeMinFocusedCandidates || 0) || PDP_RECS_READY_MIN_COUNT),
    ),
  );
}

function focusedExternalRecallTargetCount(requestedCount) {
  const safeRequestedCount = Math.max(1, Math.min(Number(requestedCount || 0) || 0, PDP_RECS_MAX_K));
  if (!safeRequestedCount) return PDP_RECS_READY_MIN_COUNT;
  return Math.max(
    1,
    Math.min(
      safeRequestedCount,
      Math.max(PDP_RECS_READY_MIN_COUNT, Math.ceil(safeRequestedCount * PDP_RECS_EXTERNAL_FOCUSED_TARGET_RATIO)),
    ),
  );
}

function titleIntentMatches(baseFeatures, candidateFeatures) {
  const baseTitle = String(baseFeatures?.normalizedTitle || '').trim();
  const candidateTitle = String(candidateFeatures?.normalizedTitle || '').trim();
  if (!baseTitle || !candidateTitle) return false;
  const sunscreenTitleRe = /\b(sunscreen|spf|sun\s*(?:milk|cream|lotion|fluid|stick|serum|gel|screen)?|uv)\b/i;
  if (sunscreenTitleRe.test(baseTitle)) return sunscreenTitleRe.test(candidateTitle);
  return jaccard(tokenize(baseTitle), tokenize(candidateTitle)) >= 0.18;
}

function buildSimilarIntentFamilyTextFromFeatures(features) {
  return [
    features?.normalizedTitle,
    features?.rawCategory,
    features?.productType,
    features?.leafCategory,
    features?.parentCategory,
  ].filter(Boolean).join(' ');
}

function getSimilarIntentFamilyFromText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  if (BEAUTY_ACCESSORY_TITLE_RE.test(normalized)) return '';
  for (const rule of SIMILAR_INTENT_FAMILY_RULES) {
    if (rule.js.test(normalized)) return rule.id;
  }
  return '';
}

function getSimilarIntentFamilyFromFeatures(features, { titleOnly = false } = {}) {
  if (titleOnly) return getSimilarIntentFamilyFromText(features?.normalizedTitle || '');
  const direct = getSimilarIntentFamilyFromText(buildSimilarIntentFamilyTextFromFeatures(features));
  if (direct) return direct;
  const leaf = normalizeText(features?.leafCategory || '');
  const parent = normalizeText(features?.parentCategory || '');
  if (parent === 'moisturize' && ['cream', 'lotion', 'moisturizer', 'moisturiser'].includes(leaf)) {
    return 'moisturizer';
  }
  return '';
}

function getSimilarIntentFamilyFromProduct(product) {
  const direct = getSimilarIntentFamilyFromText(
    [
      product?.title,
      product?.name,
      product?.category,
      product?.product_type,
      product?.productType,
      getLeafCategory(product),
      getParentCategory(product),
    ].filter(Boolean).join(' '),
  );
  if (direct) return direct;
  const leaf = getLeafCategory(product);
  const parent = getParentCategory(product);
  if (parent === 'moisturize' && ['cream', 'lotion', 'moisturizer', 'moisturiser'].includes(leaf)) {
    return 'moisturizer';
  }
  return '';
}

function getSimilarIntentFamilySqlPattern(intentFamily) {
  const id = String(intentFamily || '').trim();
  return SIMILAR_INTENT_FAMILY_RULES.find((rule) => rule.id === id)?.sql || '';
}

function getSimilarIntentFamilySqlLikePatterns(intentFamily) {
  const id = String(intentFamily || '').trim();
  if (id === 'sunscreen') {
    return [
      '%sunscreen%',
      '%sun screen%',
      '%suncream%',
      '%sun cream%',
      '%sun stick%',
      '%spf%',
      '%uv%',
    ];
  }
  if (id === 'foundation') {
    return [
      '%foundation%',
      '%cushion%',
      '%skinveil%',
      '%skin veil%',
      '%concealer%',
    ];
  }
  if (id === 'mask') {
    return [
      '%mask%',
      '%eye patch%',
      '%eye patches%',
      '%hydrogel%',
      '%sheet mask%',
      '%sleeping mask%',
      '%wash off mask%',
      '%wash-off mask%',
    ];
  }
  if (id === 'fragrance') {
    return [
      '%fragrance%',
      '%perfume%',
      '%parfum%',
      '%eau de parfum%',
      '%eau de toilette%',
      '%cologne%',
      '%roll on perfume%',
    ];
  }
  if (id === 'face_oil') return ['%face oil%', '%facial oil%'];
  if (id === 'body_oil') {
    return [
      '%body oil%',
      '%body lotion%',
      '%body cream%',
      '%body balm%',
      '%body moisturizer%',
      '%body moisturiser%',
      '%massage oil%',
    ];
  }
  if (id === 'eye_cream') return ['%eye cream%', '%eye creme%', '%eye crème%'];
  if (id === 'moisturizer') {
    return [
      '%moisturizer%',
      '%moisturiser%',
      '%moisturizing%',
      '%moisturising%',
      '%day cream%',
      '%face cream%',
      '%facial cream%',
      '%hydrating cream%',
      '%replenishing cream%',
    ];
  }
  if (id === 'highlighter') return ['%highlighter%', '%illuminator%'];
  if (id === 'lip_oil') return ['%lip oil%', '%lip glaze%'];
  if (id === 'hand_cream') return ['%hand cream%', '%hand balm%', '%hand lotion%'];
  if (id === 'micellar_cleansing_water') return ['%micellar%', '%cleansing water%'];
  return [];
}

function hasSharedSimilarIntentFamily(baseFeatures, candidateFeatures) {
  const baseFamily = getSimilarIntentFamilyFromFeatures(baseFeatures);
  if (!baseFamily) return false;
  const candidateTitleFamily = getSimilarIntentFamilyFromFeatures(candidateFeatures, { titleOnly: true });
  if (candidateTitleFamily) return candidateTitleFamily === baseFamily;
  if (!titleSupportsLeafCategory(candidateFeatures)) return false;
  return getSimilarIntentFamilyFromFeatures(candidateFeatures) === baseFamily;
}

function supportsSparseHaircareExpansion(features) {
  const text = normalizeText(
    [
      features?.normalizedTitle,
      features?.leafCategory,
      features?.parentCategory,
    ].filter(Boolean).join(' '),
  );
  if (!text) return false;
  if (/\b(?:clip|clips|claw|barrette|headband|scrunchie|fragrance|mist|body|beard|shower gel|ingrown|lash|eyelash|mascara|brow)\b/.test(text)) {
    return false;
  }
  return /\b(?:shampoo|conditioner|scalp|hair oil|hair mask|leave in|leave-in|detangling|edge control|styling|curl|bonding|hair treatment|haircare|hair care)\b/.test(text);
}

function allowsSparseExternalVerticalExpansion(baseFeatures, candidateFeatures) {
  if (!baseFeatures?.isExternal || !candidateFeatures?.isExternal) return false;
  if (baseFeatures.vertical === UNKNOWN_VERTICAL || candidateFeatures.vertical === UNKNOWN_VERTICAL) return false;
  if (baseFeatures.vertical !== candidateFeatures.vertical) return false;
  if (baseFeatures.vertical !== 'haircare') return false;
  return supportsSparseHaircareExpansion(baseFeatures) && supportsSparseHaircareExpansion(candidateFeatures);
}

function isWeakExternalSeedCategory(value) {
  const normalized = normalizeText(value);
  return (
    !normalized ||
    normalized === 'product' ||
    normalized === 'products' ||
    normalized === 'beauty' ||
    normalized === 'skincare' ||
    normalized === 'skin care' ||
    normalized === 'makeup' ||
    normalized === 'cosmetics' ||
    normalized === 'external' ||
    normalized === 'external seed' ||
    normalized === 'catalog'
  );
}

function countExternalSkipEligibleInternalCandidates(baseProduct, internalCandidates) {
  const base = buildBaseFeatures(baseProduct);
  if (!Array.isArray(internalCandidates) || !internalCandidates.length) return 0;
  const seen = new Set();
  let count = 0;

  for (const candidate of internalCandidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (!isSellable(candidate, { inStockOnly: true })) continue;
    const key = buildCandidateKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const features = buildCandidateFeatures(candidate, base.currency);
    const scoreDetail = scoreCandidate(base, features);
    const sameKnownVertical =
      base.vertical !== UNKNOWN_VERTICAL &&
      features.vertical !== UNKNOWN_VERTICAL &&
      base.vertical === features.vertical;
    if (
      scoreDetail.brandMatch ||
      scoreDetail.leafMatch ||
      (sameKnownVertical && scoreDetail.tokenOverlap >= 0.12)
    ) {
      count += 1;
    }
  }

  return count;
}

function confidenceRank(level) {
  if (level === 'high') return 3;
  if (level === 'medium') return 2;
  return 1;
}

function classifyConfidenceLevel(base, candidate, layerId) {
  const nearPriceTight = candidate.relDiff != null && candidate.relDiff <= 0.25;
  if (candidate.brandMatch && candidate.leafMatch && nearPriceTight) return 'high';
  if (candidate.brandMatch && candidate.parentMatch && candidate.relDiff != null && candidate.relDiff <= 0.6) return 'high';
  if (candidate.leafMatch && nearPriceTight) return 'high';

  if (layerId === 'L3I' && base.isExternal && candidate.features.isExternal) {
    return hasSharedSimilarIntentFamily(base, candidate.features) ? 'medium' : 'low';
  }

  if (layerId === 'L3E' && base.isExternal && candidate.features.isExternal && candidate.leafMatch) {
    const sameKnownVertical =
      base.vertical !== UNKNOWN_VERTICAL &&
      candidate.features.vertical !== UNKNOWN_VERTICAL &&
      base.vertical === candidate.features.vertical;
    const missingCandidateVertical = candidate.features.vertical === UNKNOWN_VERTICAL;
    if (sameKnownVertical && candidate.relDiff != null && candidate.relDiff <= 0.6) return 'medium';
    if (sameKnownVertical && candidate.tokenOverlap >= 0.08) return 'medium';
    if (missingCandidateVertical && candidate.relDiff != null && candidate.relDiff <= 0.35) return 'medium';
  }

  if (base.vertical !== UNKNOWN_VERTICAL && candidate.features.vertical !== UNKNOWN_VERTICAL) {
    if (base.vertical === candidate.features.vertical && candidate.tokenOverlap >= 0.12) return 'medium';
    if (base.vertical !== candidate.features.vertical) return 'low';
  }

  if (layerId === 'L2E' && base.isExternal && candidate.brandMatch) {
    if (base.vertical !== UNKNOWN_VERTICAL && candidate.features.vertical !== UNKNOWN_VERTICAL) {
      return base.vertical === candidate.features.vertical ? 'medium' : 'low';
    }
    return candidate.features.isExternal ? 'medium' : 'low';
  }

  if (layerId === 'L2P' && base.isExternal && candidate.features.isExternal && candidate.brandMatch) {
    if (requiresStrictExternalSameBrandIntent(base)) return 'low';
    if (base.vertical !== UNKNOWN_VERTICAL && candidate.features.vertical !== UNKNOWN_VERTICAL) {
      return base.vertical === candidate.features.vertical ? 'medium' : 'low';
    }
    return 'low';
  }

  if (layerId === 'L3B' && base.isExternal && candidate.features.isExternal && candidate.brandMatch) {
    if (base.vertical !== UNKNOWN_VERTICAL && candidate.features.vertical !== UNKNOWN_VERTICAL) {
      return base.vertical === candidate.features.vertical ? 'medium' : 'low';
    }
    return 'low';
  }

  if (layerId === 'L3V' && base.isExternal && candidate.features.isExternal) {
    return allowsSparseExternalVerticalExpansion(base, candidate.features) ? 'medium' : 'low';
  }

  if (layerId === 'L4' && candidate.tokenOverlap >= 0.24) return 'medium';
  return 'low';
}

function pickBalancedCandidates(candidates, k, baseIsExternal) {
  const K = Math.max(1, Math.min(Number(k || 6) || 6, 30));
  const internalQueue = candidates.filter((c) => c.source === 'internal');
  const externalQueue = candidates.filter((c) => c.source === 'external');
  if (!internalQueue.length || !externalQueue.length) {
    return candidates.slice(0, K);
  }

  const pattern = baseIsExternal ? ['internal', 'external'] : ['internal', 'internal', 'external'];
  const pointers = { internal: 0, external: 0 };
  const selected = [];
  const used = new Set();

  const appendCandidate = (candidate) => {
    if (!candidate || selected.length >= K) return false;
    const key = `${candidate.features.merchantId}::${candidate.features.productId}`;
    if (used.has(key)) return false;
    used.add(key);
    selected.push(candidate);
    return true;
  };

  if (baseIsExternal) {
    for (const candidate of candidates) {
      if (selected.length >= K) break;
      if (candidate.source !== 'external' || !candidate.brandMatch || candidate.layerPriority > 2) continue;
      appendCandidate(candidate);
    }
  }

  const nextFromSource = (source) => {
    const queue = source === 'internal' ? internalQueue : externalQueue;
    while (pointers[source] < queue.length) {
      const candidate = queue[pointers[source]];
      pointers[source] += 1;
      const key = `${candidate.features.merchantId}::${candidate.features.productId}`;
      if (used.has(key)) continue;
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
      appendCandidate(next);
      progress = true;
    }
    if (!progress) break;
  }

  if (selected.length < K) {
    for (const candidate of candidates) {
      if (selected.length >= K) break;
      appendCandidate(candidate);
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
}) {
  const K = Math.max(1, Math.min(Number(k || PDP_RECS_DEFAULT_K) || PDP_RECS_DEFAULT_K, PDP_RECS_MAX_K));
  const base = buildBaseFeatures(baseProduct, baseSemantic);
  const allowBroadTitleLayer = visibleBroadTitleLayerEnabled();

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
      id: 'L2E',
      name: 'same_brand_external_intent_match',
      priority: 2.55,
      predicate: (c, features, baseFeatures) =>
        baseFeatures.isExternal &&
        c.brandMatch &&
        (
          c.leafMatch ||
          c.parentMatch ||
          titleIntentMatches(baseFeatures, features)
        ),
    },
    {
      id: 'L2P',
      name: 'same_brand_external_parent_category',
      priority: 2.58,
      predicate: (c, features, baseFeatures) =>
        baseFeatures.isExternal &&
        features.isExternal &&
        c.brandMatch &&
        c.parentMatch &&
        baseFeatures.vertical !== UNKNOWN_VERTICAL &&
        features.vertical !== UNKNOWN_VERTICAL &&
        baseFeatures.vertical === features.vertical &&
        !requiresStrictExternalSameBrandIntent(baseFeatures),
    },
    {
      id: 'L3',
      name: 'leaf_category+near_price',
      priority: 2.4,
      predicate: (c) => c.leafMatch && nearPriceTight(c.relDiff),
    },
    {
      id: 'L3E',
      name: 'external_leaf_category',
      priority: 2.6,
      predicate: (c, features, baseFeatures) =>
        baseFeatures.isExternal &&
        features.isExternal &&
        c.leafMatch &&
        (
          nearPriceLoose(c.relDiff) ||
          baseFeatures.vertical === UNKNOWN_VERTICAL ||
          features.vertical === UNKNOWN_VERTICAL ||
          baseFeatures.vertical === features.vertical
        ),
    },
    {
      id: 'L3I',
      name: 'external_intent_family',
      priority: 2.65,
      predicate: (_c, features, baseFeatures) =>
        baseFeatures.isExternal &&
        features.isExternal &&
        hasSharedSimilarIntentFamily(baseFeatures, features),
    },
    {
      id: 'L3B',
      name: 'same_brand_external_same_vertical',
      priority: 3.4,
      predicate: (c, features, baseFeatures) =>
        baseFeatures.isExternal &&
        features.isExternal &&
        c.brandMatch &&
        baseFeatures.vertical !== UNKNOWN_VERTICAL &&
        features.vertical !== UNKNOWN_VERTICAL &&
        baseFeatures.vertical === features.vertical &&
        !requiresStrictExternalSameBrandIntent(baseFeatures),
    },
    {
      id: 'L3V',
      name: 'external_sparse_vertical_family',
      priority: 3.45,
      predicate: (c, features, baseFeatures) =>
        !c.brandMatch &&
        allowsSparseExternalVerticalExpansion(baseFeatures, features) &&
        !requiresStrictExternalSameBrandIntent(baseFeatures),
    },
    {
      id: 'L4',
      name: 'title_token_overlap',
      priority: 4,
      predicate: (c) => c.tokenOverlap >= 0.18,
      fallback: true,
    },
    {
      id: 'L5',
      name: 'same_vertical_token_overlap',
      priority: 5,
      predicate: (c, features, baseFeatures) =>
        baseFeatures.vertical !== UNKNOWN_VERTICAL &&
        features.vertical !== UNKNOWN_VERTICAL &&
        baseFeatures.vertical === features.vertical &&
        c.tokenOverlap >= 0.12,
    },
  ].filter((layer) => !layer.fallback || allowBroadTitleLayer);

  const layerById = Object.fromEntries(layers.map((layer) => [layer.id, layer]));

  let filteredByVertical = 0;
  let filteredByConfidence = 0;
  let filteredByExternalBrandAuthority = 0;

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
      // Exclude the base product even if multiple merchants share the same product_id.
      // (In multi-offer scenarios those belong in offers[], not recommendations.)
      if (pid === base.productId) return null;
      const features = buildCandidateFeatures(p, base.currency);
      const source = features.isExternal ? 'external' : 'internal';
      const scoreDetail = scoreCandidate(base, features);
      const baseIntentFamily = getSimilarIntentFamilyFromFeatures(base);
      const candidateTitleIntentFamily = getSimilarIntentFamilyFromFeatures(features, { titleOnly: true });
      const sharedIntentFamily = hasSharedSimilarIntentFamily(base, features);

      if (
        base.isExternal &&
        base.accessoryKind &&
        !accessoryKindsAreCompatible(base.accessoryKind, features.accessoryKind)
      ) {
        filteredByConfidence += 1;
        return null;
      }
      const allowSameBrandFragranceBundle =
        baseIntentFamily === 'fragrance' &&
        source === 'external' &&
        scoreDetail.brandMatch &&
        features.vertical === 'fragrance' &&
        (titleIntentMatches(base, features) || hasSharedSimilarIntentFamily(base, features));
      if (base.isExternal && !base.bundleLike && features.bundleLike && !allowSameBrandFragranceBundle) {
        filteredByConfidence += 1;
        return null;
      }
      if (
        base.isExternal &&
        baseIntentFamily &&
        source === 'external' &&
        features.bundleLike &&
        !scoreDetail.brandMatch &&
        candidateTitleIntentFamily !== baseIntentFamily
      ) {
        filteredByConfidence += 1;
        return null;
      }
      if (base.isExternal && !base.refillLike && features.refillLike) {
        filteredByConfidence += 1;
        return null;
      }

      if (
        base.isExternal &&
        base.brand &&
        source === 'internal' &&
        !scoreDetail.brandMatch
      ) {
        filteredByExternalBrandAuthority += 1;
        return null;
      }

      if (
        base.isExternal &&
        base.vertical !== UNKNOWN_VERTICAL &&
        base.vertical !== 'tools' &&
        BEAUTY_ACCESSORY_TITLE_RE.test(features.normalizedTitle || '')
      ) {
        filteredByConfidence += 1;
        return null;
      }
      if (
        base.isExternal &&
        !scoreDetail.brandMatch &&
        scoreDetail.leafMatch &&
        !titleSupportsLeafCategory(features)
      ) {
        filteredByConfidence += 1;
        return null;
      }
      if (
        base.isExternal &&
        baseIntentFamily &&
        source === 'external' &&
        !sharedIntentFamily
      ) {
        filteredByConfidence += 1;
        return null;
      }
      if (
        base.isExternal &&
        baseIntentFamily &&
        scoreDetail.brandMatch &&
        !scoreDetail.leafMatch &&
        !scoreDetail.parentMatch &&
        !sharedIntentFamily
      ) {
        filteredByConfidence += 1;
        return null;
      }
      if (
        base.isExternal &&
        base.vertical === 'skincare' &&
        scoreDetail.brandMatch &&
        !scoreDetail.leafMatch &&
        !scoreDetail.parentMatch &&
        !titleIntentMatches(base, features) &&
        !(
          source === 'external' &&
          features.vertical !== UNKNOWN_VERTICAL &&
          base.vertical === features.vertical &&
          !requiresStrictExternalSameBrandIntent(base)
        )
      ) {
        filteredByConfidence += 1;
        return null;
      }
      if (
        base.isExternal &&
        scoreDetail.brandMatch &&
        requiresStrictExternalSameBrandIntent(base) &&
        !scoreDetail.leafMatch &&
        !scoreDetail.parentMatch &&
        !titleIntentMatches(base, features) &&
        !sharedIntentFamily
      ) {
        filteredByConfidence += 1;
        return null;
      }

      const matchedLayer = layers.find((layer) => layer.predicate(scoreDetail, features, base)) || null;

      if (base.vertical === 'fragrance') {
        const candidateVertical = features.vertical;
        const allowByVertical = candidateVertical === 'fragrance';
        const allowByToken = scoreDetail.tokenOverlap >= 0.18 && candidateVertical !== 'tools';
        if (!allowByVertical && !allowByToken) {
          filteredByVertical += 1;
          return null;
        }
      }

      if (!matchedLayer) {
        filteredByConfidence += 1;
        return null;
      }

      const confidence = classifyConfidenceLevel(base, { ...scoreDetail, features }, matchedLayer.id);
      if (confidence === 'low') {
        filteredByConfidence += 1;
        return null;
      }

      return {
        product: p,
        features,
        source,
        layerId: matchedLayer.id,
        layerName: matchedLayer.name,
        layerPriority: matchedLayer.priority,
        confidence,
        ...scoreDetail,
      };
    })
    .filter(Boolean);

  // Stable, deterministic de-dupe by merchant_id+product_id.
  const uniqueCandidates = uniqueByKey(rawCandidates, (c) => `${c.features.merchantId}::${c.features.productId}`);

  // Avoid excessive work.
  const sortedCandidates = uniqueCandidates
    .sort((a, b) => {
      if (a.layerPriority !== b.layerPriority) return a.layerPriority - b.layerPriority;
      if (confidenceRank(a.confidence) !== confidenceRank(b.confidence)) {
        return confidenceRank(b.confidence) - confidenceRank(a.confidence);
      }
      if (a.score !== b.score) return b.score - a.score;
      return a.features.productId.localeCompare(b.features.productId);
    });
  const titleUniqueCandidates = uniqueByKey(
    sortedCandidates,
    (c) => buildRecommendationTitleDedupeKey(c.product) || `${c.features.merchantId}::${c.features.productId}`,
  );
  const candidates = titleUniqueCandidates
    .slice(0, 400);

  const layerCounts = {};
  for (const candidate of candidates) {
    layerCounts[candidate.layerId] = (layerCounts[candidate.layerId] || 0) + 1;
  }

  const chosenCandidates = pickBalancedCandidates(candidates, K, base.isExternal);
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

  const signalStrength =
    Number(baseSemantic?.signal_strength) ||
    computeSemanticSignalStrength({
      brand: base.brand,
      leafCategory: base.leafCategory,
      vertical: base.vertical,
    });
  const baseSemanticStrong = signalStrength >= 2;
  const readyMinCount = Math.min(K, PDP_RECS_READY_MIN_COUNT);

  const similarConfidence =
    !selected.length
      ? 'low'
      : confidenceCounts.high >= Math.max(1, Math.ceil(selected.length * 0.7))
        ? 'high'
        : confidenceCounts.high + confidenceCounts.medium >= Math.max(1, Math.ceil(selected.length * 0.8))
          ? 'medium'
          : 'low';
  const lowConfidence = selected.length < readyMinCount || similarConfidence === 'low';

  const lowConfidenceReasonCodes = [];
  if (!baseSemanticStrong) lowConfidenceReasonCodes.push('BASE_SEMANTIC_WEAK');
  if (filteredByVertical > 0) lowConfidenceReasonCodes.push('CATEGORY_MISMATCH_FILTERED');
  if (filteredByExternalBrandAuthority > 0) {
    lowConfidenceReasonCodes.push('EXTERNAL_BASE_BLOCKED_OTHER_BRAND_INTERNAL');
  }
  if (selected.length < readyMinCount) lowConfidenceReasonCodes.push('UNDERFILL_FOR_QUALITY');
  if (!lowConfidenceReasonCodes.length && lowConfidence) lowConfidenceReasonCodes.push('INSUFFICIENT_HIGH_CONFIDENCE');

  return {
    items: selected.slice(0, K),
    metadata: {
      similar_confidence: similarConfidence,
      low_confidence: lowConfidence,
      low_confidence_reason_codes: lowConfidenceReasonCodes,
      similar_status: selected.length
        ? selected.length < readyMinCount
          ? 'underfilled'
          : 'ready'
        : 'empty',
      retrieval_mix: {
        internal: sourceCounts.internal,
        external: sourceCounts.external,
      },
      fallback_policy: recommendationFallbackPolicy(),
      base_semantic: {
        brand: base.brand || null,
        vertical: base.vertical || UNKNOWN_VERTICAL,
        inferred: Boolean(baseSemantic?.vertical_inferred ?? base.verticalInferred),
        signal_strength: signalStrength,
        ready_min_count: readyMinCount,
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
      candidates_total: candidates.length,
      sources: sourceCounts,
      confidence: confidenceCounts,
      filters: {
        by_vertical: filteredByVertical,
        by_confidence: filteredByConfidence,
        by_external_brand_authority: filteredByExternalBrandAuthority,
      },
      fallback_policy: recommendationFallbackPolicy(),
    },
  };
}

async function fetchInternalCandidates({ merchantId, limit, excludeMerchantId, categoryHint }) {
  const mid = String(merchantId || '').trim();
  const safeLimit = Math.min(Math.max(1, Number(limit || 120)), 400);
  const categoryAliases = buildNormalizedAliases(categoryHint);
  const allowVisibleFallbacks = visibleFallbacksEnabled();

  if (!process.env.DATABASE_URL) {
    throw buildDatabaseNotConfiguredError('pdp_recommendations_internal_candidates');
  }
  const out = [];
  const activeCacheWhere = activeProductsCacheSourceWhere('products_cache');

  try {
    if (mid && mid !== EXTERNAL_SEED_MERCHANT_ID && categoryAliases.length) {
      const res = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE merchant_id = $1
            AND (expires_at IS NULL OR expires_at > now())
            AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
            AND ${activeCacheWhere}
            AND (
              lower(coalesce(product_data->>'category', '')) = ANY($3)
              OR lower(coalesce(product_data->>'product_type', '')) = ANY($3)
              OR lower(coalesce(product_data->>'productType', '')) = ANY($3)
              OR lower(coalesce(product_data->'platform_metadata'->>'product_type', '')) = ANY($3)
            )
          ORDER BY cached_at DESC NULLS LAST, id DESC
          LIMIT $2
        `,
        [mid, Math.min(safeLimit * 2, 200), categoryAliases],
      );
      for (const row of res.rows || []) {
        if (row?.product_data) out.push(toCandidate(row.product_data, { merchant_id: mid }));
      }
      const focused = uniqueByKey(out.filter(Boolean), (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      if (focused.length > 0) return focused.slice(0, safeLimit * 4);
    }
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err), merchantId: mid, categoryHint },
      'recommendations internal focused query failed',
    );
  }

  try {
    if (mid && mid !== EXTERNAL_SEED_MERCHANT_ID) {
      const res = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE merchant_id = $1
            AND (expires_at IS NULL OR expires_at > now())
            AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
            AND ${activeCacheWhere}
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

  if (allowVisibleFallbacks) {
    try {
    // Global recent internal fallback (keeps cold-start non-empty).
      const res = await query(
        `
          SELECT merchant_id, product_data
          FROM products_cache
          WHERE (expires_at IS NULL OR expires_at > now())
            AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
            AND ${activeCacheWhere}
            AND merchant_id <> $1
            ${excludeMerchantId ? 'AND merchant_id <> $2' : ''}
          ORDER BY cached_at DESC NULLS LAST, id DESC
          LIMIT $3
        `,
        excludeMerchantId
          ? [EXTERNAL_SEED_MERCHANT_ID, String(excludeMerchantId || '').trim(), Math.min(safeLimit * 3, 600)]
          : [EXTERNAL_SEED_MERCHANT_ID, Math.min(safeLimit * 3, 600), Math.min(safeLimit * 3, 600)],
      );

      for (const row of res.rows || []) {
        const p = row?.product_data;
        const merchant_id = String(row?.merchant_id || '').trim();
        if (!p || !merchant_id) continue;
        out.push(toCandidate(p, { merchant_id }));
      }
    } catch (err) {
      logger.warn({ err: err?.message || String(err) }, 'recommendations internal global query failed');
    }
  }

  return uniqueByKey(out.filter(Boolean), (p) => `${getMerchantId(p)}::${getProductId(p)}`).slice(0, safeLimit * 4);
}

async function fetchExternalCandidates({
  brandHint,
  categoryHint,
  categoryPathHint = '',
  verticalHint = '',
  intentFamilyHint = '',
  domainHints = [],
  limit,
  minFocusedCandidates = 6,
  deepDomainRecall = false,
}) {
  if (!process.env.DATABASE_URL) {
    throw buildDatabaseNotConfiguredError('pdp_recommendations_external_candidates');
  }
  const safeLimit = Math.min(Math.max(1, Number(limit || 180)), 500);
  const safeMinFocusedCandidates = Math.max(
    1,
    Math.min(30, Number(minFocusedCandidates || 6) || 6),
  );
  const market = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US').trim().toUpperCase() || 'US';
  const tool = 'creator_agents';

  const brand = normalizeText(brandHint);
  const category = normalizeText(categoryHint);
  const catalogCategoryPath = normalizeCatalogCategoryPath(categoryPathHint);
  const vertical = normalizeStoredSemanticVertical(verticalHint);
  const allowVisibleFallbacks = visibleFallbacksEnabled();
  const normalizedDomainHints = uniqueByKey(
    (Array.isArray(domainHints) ? domainHints : [domainHints])
      .flatMap((value) => buildDomainLookupAliases(value))
      .filter(Boolean),
    (value) => value,
  );
  const brandAliases = buildNormalizedAliases(brandHint);
  const compactBrand = brandAliases.find((value) => !/\s/.test(value)) || brand.replace(/\s+/g, '');
  const categoryAliases = buildNormalizedAliases(categoryHint);
  const categoryTitleLikePatterns = buildCategoryTitleLikePatterns(categoryHint);
  const intentFamily = String(intentFamilyHint || '').trim();
  const intentFamilyPattern = getSimilarIntentFamilySqlPattern(intentFamily);
  const intentFamilyLikePatterns = getSimilarIntentFamilySqlLikePatterns(intentFamily);
  const identityCollapseProtection = requiresIdentityCollapseProtectionForExternalRecall({
    categoryHint: category,
    intentFamilyHint: intentFamily,
  });
  const focusedRecallTarget = focusedRecallTargetCount(safeMinFocusedCandidates);
  const returnCap = Math.min(
    safeLimit * 3,
    Math.max(safeLimit, safeMinFocusedCandidates * 3),
  );
  const verticalTitleCategoryPattern =
    vertical === 'haircare'
      ? '\\m(hair\\s*care|haircare|shampoo|conditioner|hair\\s*oil|hair\\s*mask|scalp|scalp\\s*treatment|scalp\\s*tonic|scalp\\s*oil)\\M'
      : '';
  const sellableExternalSeedSql = `
              AND lower(coalesce(
                availability,
                seed_data->>'availability',
                seed_data->'snapshot'->>'availability',
                ''
              )) NOT IN ('out_of_stock', 'sold_out', 'unavailable', 'discontinued')
  `;

  function boundedRecallCap(multiplier, floor = 24) {
    return Math.min(
      safeLimit,
      PDP_RECS_EXTERNAL_RECALL_QUERY_CAP_MAX,
      Math.max(floor, Math.ceil(safeMinFocusedCandidates * multiplier)),
    );
  }

  function externalSeedCategorySqlExpression() {
    return `coalesce(
      seed_data->'derived'->'recall'->>'category',
      seed_data->>'category',
      seed_data->'product'->>'category',
      seed_data->'snapshot'->>'category',
      seed_data->>'product_type',
      seed_data->'product'->>'product_type',
      seed_data->'snapshot'->>'product_type',
      ''
    )`;
  }

  function externalSeedCategoryAliasPredicate(paramIndex) {
    const expression = externalSeedCategorySqlExpression();
    return `(
      lower(${expression}) = ANY($${paramIndex})
      OR lower(regexp_replace(${expression}, '^.*/', '')) = ANY($${paramIndex})
    )`;
  }

  const fetchStats = {
    market,
    tool,
    deep_domain_recall: Boolean(deepDomainRecall),
    focused_target_count: focusedRecallTarget,
    min_focused_candidates: safeMinFocusedCandidates,
    safe_limit: safeLimit,
    return_cap: returnCap,
    brand_hint: brand || null,
    category_hint: category || null,
    category_path_hint: catalogCategoryPath || null,
    vertical_hint: vertical || null,
    intent_family_hint: intentFamily || null,
    domain_hint_count: normalizedDomainHints.length,
    stages: [],
  };

  function attachExternalFetchStats(products) {
    const out = Array.isArray(products) ? products : [];
    const stats = {
      ...fetchStats,
      total_returned_count: out.length,
      total_elapsed_ms: fetchStats.stages.reduce((sum, stage) => sum + (Number(stage.elapsed_ms) || 0), 0),
      timed_out_count: fetchStats.stages.filter((stage) => stage.timed_out).length,
    };
    try {
      Object.defineProperty(out, '__externalFetchStats', {
        value: stats,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // Non-critical debug attachment.
    }
    return out;
  }

  function displayUniqueCandidateCount(products) {
    return uniqueByKey(
      (Array.isArray(products) ? products : []).filter((product) => isSellable(product, { inStockOnly: true })),
      (product) =>
        buildVariantAgnosticTitleKey(product) ||
        buildRecommendationTitleDedupeKey(product) ||
        `${getMerchantId(product)}::${getProductId(product)}`,
    ).length;
  }

  function hasDisplayCoverage(products, targetCount) {
    return displayUniqueCandidateCount(products) >= targetCount;
  }

  function timedOutStageCount(stageNames) {
    const allowed = new Set(Array.isArray(stageNames) ? stageNames : []);
    return fetchStats.stages.filter((stage) => allowed.has(stage.name) && stage.timed_out).length;
  }

  async function runQuery(whereSql, params, cap, queryName) {
    try {
      const res = await query(
        `
          WITH recall_ids AS (
            SELECT id
            FROM external_product_seeds
            WHERE status = 'active'
              AND market = $1
              AND (tool = '*' OR tool = $2)
              AND attached_product_key IS NULL
              ${sellableExternalSeedSql}
              ${whereSql}
            ORDER BY updated_at DESC, created_at DESC
            LIMIT $3
          )
          SELECT
${EXTERNAL_SEED_LIGHT_RECOMMENDATION_SELECT}
          FROM external_product_seeds
          WHERE id IN (SELECT id FROM recall_ids)
          ORDER BY updated_at DESC, created_at DESC
        `,
        [market, tool, cap, ...params],
      );
      const products = [];
      for (const row of res.rows || []) {
        const p = buildExternalSeedRecommendationCandidate(row);
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

  async function runDomainQuery(cap) {
    if (!normalizedDomainHints.length) return [];
    try {
      const res = await query(
        `
          WITH recall_ids AS (
            SELECT id
            FROM external_product_seeds
            WHERE status = 'active'
              AND market = $1
              AND (tool = '*' OR tool = $2)
              AND attached_product_key IS NULL
              AND domain = ANY($4)
              ${sellableExternalSeedSql}
            ORDER BY updated_at DESC, created_at DESC
            LIMIT $3
          )
          SELECT
${EXTERNAL_SEED_RECOMMENDATION_SELECT}
          FROM external_product_seeds
          WHERE id IN (SELECT id FROM recall_ids)
          ORDER BY updated_at DESC, created_at DESC
        `,
        [market, tool, cap, normalizedDomainHints],
      );
      const products = [];
      for (const row of res.rows || []) {
        const p = buildExternalSeedRecommendationCandidate(row, {
          fallbackBrand: brandHint,
        });
        if (p) products.push(p);
      }
      return products;
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: 'external_domain' },
        'recommendations external query failed',
      );
      return [];
    }
  }

  async function runDomainCategoryQuery(cap) {
    if (!normalizedDomainHints.length || !categoryAliases.length) return [];
    try {
      const res = await query(
        `
          SELECT
${EXTERNAL_SEED_LIGHT_RECOMMENDATION_SELECT}
          FROM external_product_seeds
          WHERE status = 'active'
            AND market = $1
            AND (tool = '*' OR tool = $2)
            AND attached_product_key IS NULL
            AND domain = ANY($4)
            ${sellableExternalSeedSql}
            AND ${externalSeedCategoryAliasPredicate(5)}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $3
        `,
        [market, tool, cap, normalizedDomainHints, categoryAliases],
      );
      const products = [];
      for (const row of res.rows || []) {
        const p = buildExternalSeedRecommendationCandidate(row, {
          fallbackBrand: brandHint,
          fallbackCategory: categoryHint,
        });
        if (p) products.push(p);
      }
      return products;
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: 'external_domain_category' },
        'recommendations external query failed',
      );
      return [];
    }
  }

  async function runDomainTitleCategoryQuery(cap) {
    if (!normalizedDomainHints.length || !categoryTitleLikePatterns.length) return [];
    try {
      const res = await query(
        `
          SELECT
${EXTERNAL_SEED_FAST_RECOMMENDATION_SELECT}
          FROM external_product_seeds
          WHERE status = 'active'
            AND market = $1
            AND (tool = '*' OR tool = $2)
            AND attached_product_key IS NULL
            AND domain = ANY($4)
            ${sellableExternalSeedSql}
            AND lower(coalesce(title, '')) LIKE ANY($5::text[])
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $3
        `,
        [market, tool, cap, normalizedDomainHints, categoryTitleLikePatterns],
      );
      const products = [];
      for (const row of res.rows || []) {
        const p = buildExternalSeedRecommendationCandidate(row, {
          fallbackBrand: brandHint,
          fallbackCategory: categoryHint,
        });
        if (p) products.push(p);
      }
      return products;
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: 'external_domain_title_category' },
        'recommendations external query failed',
      );
      return [];
    }
  }

  async function runTitleCategoryQuery(cap) {
    if (!categoryTitleLikePatterns.length) return [];
    try {
      const res = await query(
        `
          SELECT
${EXTERNAL_SEED_RECOMMENDATION_SELECT}
          FROM external_product_seeds
          WHERE status = 'active'
            AND market = $1
            AND (tool = '*' OR tool = $2)
            AND attached_product_key IS NULL
            ${sellableExternalSeedSql}
            AND lower(coalesce(title, '')) LIKE ANY($4::text[])
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $3
        `,
        [market, tool, cap, categoryTitleLikePatterns],
      );
      const products = [];
      for (const row of res.rows || []) {
        const p = buildExternalSeedRecommendationCandidate(row, {
          fallbackCategory: categoryHint,
        });
        if (p) products.push(p);
      }
      return products;
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: 'external_title_category' },
        'recommendations external query failed',
      );
      return [];
    }
  }

  async function runCatalogCategoryPathQuery(cap) {
    if (!catalogCategoryPath) return [];
    try {
      const res = await query(
        `
          SELECT
            cp.product_key,
            cp.merchant_id,
            cp.platform,
            cp.source_product_id,
            cp.title AS product_title,
            cp.description AS product_description,
            cp.brand,
            cp.product_type,
            cp.category,
            cp.category_path,
            cp.canonical_url,
            cp.image_url AS product_image_url,
            cp.product_payload,
            cp.pivota_signature_id,
            cp.pivota_canonical_url,
            cp.updated_at
          FROM catalog_products cp
          LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
          WHERE cp.sync_status = 'live'
            AND ${activeCatalogProductSourceWhere('cp', 'cm')}
            AND cp.category_path = $1
          ORDER BY
            CASE WHEN lower(coalesce(cp.brand, '')) = ANY($2::text[]) THEN 0 ELSE 1 END,
            cp.updated_at DESC NULLS LAST
          LIMIT $3
        `,
        [catalogCategoryPath, brandAliases.length ? brandAliases : [''], cap],
      );
      const rows = Array.isArray(res.rows) ? res.rows : [];
      const products = [];
      for (const row of rows) {
        const p = buildCatalogProductRecommendationCandidate(row, {
          fallbackBrand: brandHint,
          fallbackCategory: categoryHint,
        });
        if (p) products.push(p);
      }
      return products;
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: 'catalog_category_path', category_path: catalogCategoryPath },
        'recommendations catalog category path query failed',
      );
      return [];
    }
  }

  async function runTimedExternalQuery(queryName, task, timeoutMs = PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS) {
    const startedAt = Date.now();
    let timedOut = false;
    const products = await withSoftTimeout(
      Promise.resolve().then(task),
      timeoutMs,
      [],
      (timeoutMs) => {
        timedOut = true;
        logger.warn(
          { timeout_ms: timeoutMs, query: queryName, brand, category },
          'recommendations external query timed out',
        );
      },
    );
    fetchStats.stages.push({
      name: queryName,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      returned_count: Array.isArray(products) ? products.length : 0,
      timed_out: timedOut,
      timeout_ms: timeoutMs,
    });
    return products;
  }

  const loadCategoryMatches = () =>
    runTimedExternalQuery(
      'external_category',
      () => runQuery(
        `AND ${externalSeedCategoryAliasPredicate(4)}`,
        [categoryAliases],
        deepDomainRecall
          ? boundedRecallCap(6, 96)
          : Math.min(120, safeLimit),
        'external_category',
      ),
      deepDomainRecall ? PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS : PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS,
    );

  const loadVerticalMatches = () =>
    vertical && verticalTitleCategoryPattern
      ? runTimedExternalQuery(
          'external_vertical',
          () => runQuery(
            `AND (
              lower(coalesce(seed_data->'derived'->'recall'->>'vertical', seed_data->>'semantic_vertical', seed_data->>'recall_vertical', '')) = $4
              OR lower(coalesce(
                seed_data->'derived'->'recall'->>'category',
                seed_data->>'category',
                seed_data->'snapshot'->>'category',
                seed_data->>'product_type',
                seed_data->'snapshot'->>'product_type',
                title,
                ''
              )) ~ $5
              OR lower(coalesce(title, '')) ~ $5
            )`,
            [vertical, verticalTitleCategoryPattern],
            deepDomainRecall
              ? boundedRecallCap(6, 96)
              : Math.min(120, safeLimit),
            'external_vertical',
          ),
          deepDomainRecall ? PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS : PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS,
        )
      : Promise.resolve([]);

  const loadIntentFamilyMatches = () =>
    intentFamilyPattern
      ? runTimedExternalQuery(
          'external_intent_family',
          () => runQuery(
            intentFamilyLikePatterns.length
              ? `AND (
                  lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_title', '')) LIKE ANY($4::text[])
                  OR lower(coalesce(seed_data#>>'{derived,recall,alias_tokens}', '')) LIKE ANY($4::text[])
                )`
              : `AND (
                  lower(coalesce(title, '')) ~ $4
                  OR lower(coalesce(seed_data->'snapshot'->>'title', '')) ~ $4
                )`,
            [intentFamilyLikePatterns.length ? intentFamilyLikePatterns : intentFamilyPattern],
            deepDomainRecall
              ? Math.min(96, boundedRecallCap(2, 72))
              : Math.min(120, safeLimit),
            'external_intent_family',
          ),
          deepDomainRecall ? PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS : PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS,
        )
      : Promise.resolve([]);

  const loadTitleCategoryMatches = () =>
    categoryTitleLikePatterns.length
      ? runTimedExternalQuery(
          'external_title_category',
          () => runTitleCategoryQuery(boundedRecallCap(3, 48)),
          Math.min(PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS, 2000),
        )
      : Promise.resolve([]);

  const loadCatalogCategoryPathMatches = () =>
    catalogCategoryPath
      ? runTimedExternalQuery(
          'catalog_category_path',
          () => runCatalogCategoryPathQuery(boundedRecallCap(3, 48)),
          Math.min(PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS, 1200),
        )
      : Promise.resolve([]);

  const out = [];
  let preloadedCategoryMatches = null;
  let preloadedDomainMatches = null;
  let preloadedIntentFamilyMatches = null;
  let exactDomainCategoryFocusedEnough = false;
  let exactDomainCategoryCandidateCount = 0;
  const exactDomainCategoryGoodEnoughCount = Math.min(focusedRecallTarget, 9);
  if (deepDomainRecall && normalizedDomainHints.length && category) {
    if (catalogCategoryPath && !intentFamilyPattern) {
      const deepRecallDomainCategoryCap = boundedRecallCap(3, 48);
      const preloadedTitleCategoryMatches = await loadTitleCategoryMatches();
      out.push(...preloadedTitleCategoryMatches);
      const titleCategoryFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      if (hasDisplayCoverage(titleCategoryFocusedCandidates, safeMinFocusedCandidates)) {
        return attachExternalFetchStats(titleCategoryFocusedCandidates.slice(0, returnCap));
      }
      const preloadedCatalogCategoryPathMatches = await loadCatalogCategoryPathMatches();
      out.push(...preloadedCatalogCategoryPathMatches);
      const catalogPathFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      if (hasDisplayCoverage(catalogPathFocusedCandidates, safeMinFocusedCandidates)) {
        return attachExternalFetchStats(catalogPathFocusedCandidates.slice(0, returnCap));
      }
      const preloadedDomainTitleCategoryMatches = await runTimedExternalQuery(
        'external_domain_title_category',
        () => runDomainTitleCategoryQuery(deepRecallDomainCategoryCap),
        PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
      );
      out.push(...preloadedDomainTitleCategoryMatches);
      exactDomainCategoryCandidateCount = displayUniqueCandidateCount(out);
      const catalogFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      exactDomainCategoryFocusedEnough = exactDomainCategoryCandidateCount >= safeMinFocusedCandidates;
      if (hasDisplayCoverage(catalogFocusedCandidates, safeMinFocusedCandidates)) {
        return attachExternalFetchStats(catalogFocusedCandidates.slice(0, returnCap));
      }
      if (
        catalogFocusedCandidates.length === 0 &&
        timedOutStageCount(['external_domain_title_category', 'catalog_category_path']) >= 2
      ) {
        return attachExternalFetchStats([]);
      }
    } else {
      const deepRecallDomainCategoryCap = boundedRecallCap(3, 48);
      const [
        preloadedDomainTitleCategoryMatches,
        preloadedDomainCategoryMatches,
      ] = await Promise.all([
        runTimedExternalQuery(
          'external_domain_title_category',
          () => runDomainTitleCategoryQuery(deepRecallDomainCategoryCap),
          PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
        ),
        runTimedExternalQuery(
          'external_domain_category',
          () => runDomainCategoryQuery(deepRecallDomainCategoryCap),
          PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
        ),
      ]);
      out.push(...preloadedDomainTitleCategoryMatches);
      let domainCategoryFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      out.push(...preloadedDomainCategoryMatches);
      domainCategoryFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      exactDomainCategoryCandidateCount = displayUniqueCandidateCount(domainCategoryFocusedCandidates);
      const domainIntentCandidates = intentFamilyPattern
        ? domainCategoryFocusedCandidates.filter((product) => getSimilarIntentFamilyFromProduct(product) === intentFamily)
        : domainCategoryFocusedCandidates;
      const exactDomainIntentCandidateCount = displayUniqueCandidateCount(domainIntentCandidates);
      exactDomainCategoryFocusedEnough = exactDomainCategoryCandidateCount >= safeMinFocusedCandidates;
      if (
        intentFamilyPattern &&
        (
          !identityCollapseProtection
            ? Math.max(exactDomainIntentCandidateCount, domainIntentCandidates.length) >= exactDomainCategoryGoodEnoughCount
            : exactDomainIntentCandidateCount >= safeMinFocusedCandidates
        )
      ) {
        return attachExternalFetchStats(domainIntentCandidates.slice(0, returnCap));
      }
      if (
        exactDomainCategoryFocusedEnough &&
        !intentFamilyPattern &&
        !identityCollapseProtection
      ) {
        return attachExternalFetchStats(domainCategoryFocusedCandidates.slice(0, returnCap));
      }
      if (
        domainCategoryFocusedCandidates.length === 0 &&
        timedOutStageCount(['external_domain_title_category', 'external_domain_category']) >= 2
      ) {
        return attachExternalFetchStats([]);
      }
    }
  }
  if (deepDomainRecall && normalizedDomainHints.length && !category) {
    const deepRecallDomainCap = boundedRecallCap(2, 48);
    preloadedDomainMatches = await runTimedExternalQuery(
      'external_domain',
      () => runDomainQuery(deepRecallDomainCap),
      PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
    );
    out.push(...preloadedDomainMatches);
    const domainFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
    if (!category && !intentFamilyPattern && hasDisplayCoverage(domainFocusedCandidates, safeMinFocusedCandidates)) {
      return attachExternalFetchStats(domainFocusedCandidates.slice(0, returnCap));
    }
  }

  if (deepDomainRecall && category && !preloadedCategoryMatches) {
    if (!identityCollapseProtection && normalizedDomainHints.length && !preloadedDomainMatches) {
      const domainBeforeCategoryCap = boundedRecallCap(2, 48);
      preloadedDomainMatches = await runTimedExternalQuery(
        'external_domain_pre_category',
        () => runDomainQuery(domainBeforeCategoryCap),
        PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
      );
      out.push(...preloadedDomainMatches);
      const domainExpandedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      const domainIntentCandidates = intentFamily
        ? domainExpandedCandidates.filter((product) => getSimilarIntentFamilyFromProduct(product) === intentFamily)
        : domainExpandedCandidates;
      const sameDomainCoverageCandidates = intentFamilyPattern ? domainIntentCandidates : domainExpandedCandidates;
      if (hasDisplayCoverage(sameDomainCoverageCandidates, focusedRecallTarget)) {
        return attachExternalFetchStats(sameDomainCoverageCandidates.slice(0, returnCap));
      }
    }
    if (intentFamily === 'foundation' && !preloadedDomainMatches) {
      const foundationDomainCap = boundedRecallCap(2, 48);
      const shouldPreloadIntentWithDomain =
        intentFamilyPattern &&
        !preloadedIntentFamilyMatches &&
        exactDomainCategoryCandidateCount > 0 &&
        exactDomainCategoryCandidateCount < focusedRecallTarget;
      const domainMatchesTask = runTimedExternalQuery(
        'external_domain',
        () => runDomainQuery(foundationDomainCap),
        PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
      );
      const intentMatchesTask = shouldPreloadIntentWithDomain
        ? loadIntentFamilyMatches()
        : null;
      preloadedDomainMatches = await domainMatchesTask;
      const filteredDomainMatches = preloadedDomainMatches.filter((product) => {
        if (BEAUTY_ACCESSORY_TITLE_RE.test(normalizeText(product?.title || product?.name || ''))) return false;
        return getSimilarIntentFamilyFromProduct(product) === intentFamily;
      });
      out.push(...filteredDomainMatches);
      const domainIntentCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
      if (intentMatchesTask && !preloadedIntentFamilyMatches) {
        preloadedIntentFamilyMatches = await intentMatchesTask;
      }
      if (!identityCollapseProtection && hasDisplayCoverage(domainIntentCandidates, focusedRecallTarget)) {
        return attachExternalFetchStats(domainIntentCandidates.slice(0, returnCap));
      }
      if (preloadedIntentFamilyMatches) {
        out.push(...preloadedIntentFamilyMatches);
        const intentFocusedCandidates = uniqueByKey(
          [...preloadedIntentFamilyMatches, ...out],
          (p) => `${getMerchantId(p)}::${getProductId(p)}`,
        );
        const exactIntentFocusedCandidates = intentFocusedCandidates.filter(
          (product) => getSimilarIntentFamilyFromProduct(product) === intentFamily,
        );
        if (hasDisplayCoverage(exactIntentFocusedCandidates, focusedRecallTarget)) {
          return attachExternalFetchStats(exactIntentFocusedCandidates.slice(0, returnCap));
        }
      }
    }
    if (intentFamilyPattern && !preloadedIntentFamilyMatches) {
      preloadedIntentFamilyMatches = await loadIntentFamilyMatches();
      out.push(...preloadedIntentFamilyMatches);
      const intentFocusedCandidates = uniqueByKey(
        [...preloadedIntentFamilyMatches, ...out],
        (p) => `${getMerchantId(p)}::${getProductId(p)}`,
      );
      const exactIntentFocusedCandidates = intentFocusedCandidates.filter(
        (product) => getSimilarIntentFamilyFromProduct(product) === intentFamily,
      );
      if (hasDisplayCoverage(exactIntentFocusedCandidates, focusedRecallTarget)) {
        return attachExternalFetchStats(exactIntentFocusedCandidates.slice(0, returnCap));
      }
    }
    preloadedCategoryMatches = await loadCategoryMatches();
    out.push(...preloadedCategoryMatches);
    const categoryFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
    if (exactDomainCategoryFocusedEnough) {
      const safeCategoryFocusedCandidates = intentFamilyPattern
        ? categoryFocusedCandidates.filter((product) => getSimilarIntentFamilyFromProduct(product) === intentFamily)
        : categoryFocusedCandidates;
      return attachExternalFetchStats(safeCategoryFocusedCandidates.slice(0, returnCap));
    }
    if (hasDisplayCoverage(categoryFocusedCandidates, safeMinFocusedCandidates) && !normalizedDomainHints.length) {
      return attachExternalFetchStats(categoryFocusedCandidates.slice(0, returnCap));
    }
  }

  const domainCap = deepDomainRecall
    ? boundedRecallCap(2, 48)
    : Math.min(safeLimit, Math.max(12, safeMinFocusedCandidates * 2));
  const domainMatches =
    preloadedDomainMatches ||
    (await runTimedExternalQuery(
      'external_domain',
      () => runDomainQuery(domainCap),
      deepDomainRecall ? PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS : PDP_RECS_EXTERNAL_UNDERFILL_QUERY_TIMEOUT_MS,
    ));
  out.push(...domainMatches);
  const domainFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
  if (!deepDomainRecall && hasDisplayCoverage(domainFocusedCandidates, safeMinFocusedCandidates)) {
    return attachExternalFetchStats(domainFocusedCandidates.slice(0, returnCap));
  }

  if (brand && deepDomainRecall && !hasDisplayCoverage(domainFocusedCandidates, focusedRecallTarget)) {
    const brandFieldMatches = await runTimedExternalQuery(
      'external_brand_fields_deep',
      () => runQuery(
        `AND (
              lower(coalesce(seed_data->>'brand','')) = ANY($4)
              OR lower(coalesce(seed_data->>'brand_name','')) = ANY($4)
              OR lower(coalesce(seed_data->>'vendor','')) = ANY($4)
              OR lower(coalesce(seed_data->>'vendor_name','')) = ANY($4)
              OR lower(coalesce(seed_data->'snapshot'->>'brand','')) = ANY($4)
              OR lower(coalesce(seed_data->'snapshot'->>'vendor','')) = ANY($4)
              OR regexp_replace(lower(coalesce(seed_data->>'brand','')), '[^a-z0-9]+', '', 'g') = ANY($4)
              OR regexp_replace(lower(coalesce(seed_data->>'vendor','')), '[^a-z0-9]+', '', 'g') = ANY($4)
            )`,
        [brandAliases],
        boundedRecallCap(3, 48),
        'external_brand_fields_deep',
      ),
      PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
    );
    out.push(...brandFieldMatches);
    const brandFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
    if (hasDisplayCoverage(brandFocusedCandidates, focusedRecallTarget)) {
      return attachExternalFetchStats(brandFocusedCandidates.slice(0, returnCap));
    }
  }

  if (brand && !deepDomainRecall) {
    const brandFieldMatches = await runTimedExternalQuery(
      'external_brand_fields',
      () => runQuery(
        `AND (
              lower(coalesce(seed_data->>'brand','')) = ANY($4)
              OR lower(coalesce(seed_data->>'brand_name','')) = ANY($4)
              OR lower(coalesce(seed_data->>'vendor','')) = ANY($4)
              OR lower(coalesce(seed_data->>'vendor_name','')) = ANY($4)
              OR lower(coalesce(seed_data->'snapshot'->>'brand','')) = ANY($4)
              OR lower(coalesce(seed_data->'snapshot'->>'vendor','')) = ANY($4)
              OR regexp_replace(lower(coalesce(seed_data->>'brand','')), '[^a-z0-9]+', '', 'g') = ANY($4)
              OR regexp_replace(lower(coalesce(seed_data->>'vendor','')), '[^a-z0-9]+', '', 'g') = ANY($4)
            )`,
        [brandAliases],
        Math.min(120, safeLimit),
        'external_brand_fields',
      ),
    );
    out.push(...brandFieldMatches);
    const brandFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
    if (!deepDomainRecall && hasDisplayCoverage(brandFocusedCandidates, safeMinFocusedCandidates)) {
      return attachExternalFetchStats(brandFocusedCandidates.slice(0, returnCap));
    }

    const brandTitleMatches = compactBrand
      ? await runTimedExternalQuery(
          'external_brand_title',
          () => runQuery(
            `AND regexp_replace(lower(coalesce(seed_data->'snapshot'->>'title','')), '[^a-z0-9]+', '', 'g') LIKE '%' || $4 || '%'`,
            [compactBrand],
            Math.min(80, safeLimit),
            'external_brand_title',
          ),
        )
      : [];
    out.push(...brandTitleMatches);
    const titleFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
    if (!deepDomainRecall && hasDisplayCoverage(titleFocusedCandidates, safeMinFocusedCandidates)) {
      return attachExternalFetchStats(titleFocusedCandidates.slice(0, returnCap));
    }
  }

  const categoryMatches = category
    ? (preloadedCategoryMatches ? [] : await loadCategoryMatches())
    : [];

  out.push(...categoryMatches);
  if (deepDomainRecall && intentFamilyPattern && !preloadedIntentFamilyMatches) {
    out.push(...(await loadIntentFamilyMatches()));
  }
  if (deepDomainRecall && vertical) {
    out.push(...(await loadVerticalMatches()));
  }
  let focusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
  if (allowVisibleFallbacks && category && focusedCandidates.length < safeMinFocusedCandidates) {
    const categoryLikePatterns = categoryAliases
      .filter((value) => String(value || '').trim().length >= 3)
      .map((value) => `%${value}%`);
    const categoryTitleMatches = categoryLikePatterns.length
      ? await runTimedExternalQuery(
          'external_category_title',
          () => runQuery(
            `AND attached_product_key IS NULL
              AND (
                lower(coalesce(seed_data->'derived'->'recall'->>'retrieval_title','')) LIKE ANY($4::text[])
              )`,
            [categoryLikePatterns],
            Math.min(180, safeLimit),
            'external_category_title',
          ),
          PDP_RECS_EXTERNAL_RECALL_QUERY_TIMEOUT_MS,
        )
      : [];
    out.push(...categoryTitleMatches);
    focusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
  }
  const hasFocusedCandidates = hasDisplayCoverage(focusedCandidates, safeMinFocusedCandidates);
  if (allowVisibleFallbacks && !hasFocusedCandidates) {
    const recent = await runTimedExternalQuery(
      'external_recent',
      () => runQuery('', [], Math.min(240, safeLimit), 'external_recent'),
    );
    out.push(...recent);
  }

  return attachExternalFetchStats(
    uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`).slice(0, returnCap),
  );
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

  try {
    if (externalSeedId) {
      const res = await query(
        `
          SELECT
${EXTERNAL_SEED_SEMANTIC_SELECT}
          FROM external_product_seeds
          WHERE status = 'active'
            AND id::text = $1
          LIMIT 1
        `,
        [externalSeedId],
      );
      if (res.rows?.[0]) return res.rows[0];
    }

    if (externalProductIds.length) {
      const res = await query(
        `
          SELECT
${EXTERNAL_SEED_SEMANTIC_SELECT}
          FROM external_product_seeds
          WHERE status = 'active'
            AND external_product_id = ANY($1::text[])
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT 1
        `,
        [externalProductIds],
      );
      if (res.rows?.[0]) return res.rows[0];
    }

    const clauses = [];
    const params = [];
    for (const externalProductId of externalProductIds) {
      params.push(externalProductId);
      const bind = `$${params.length}`;
      clauses.push(`(seed_data->>'external_product_id' = ${bind} OR seed_data->>'product_id' = ${bind})`);
    }
    if (!clauses.length) return null;

    const res = await query(
      `
        SELECT
${EXTERNAL_SEED_SEMANTIC_SELECT}
        FROM external_product_seeds
        WHERE status = 'active'
          AND (${clauses.join(' OR ')})
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
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
  const existingRecall = ensureJsonObject(
    baseProduct?.external_seed_recall ||
      baseProduct?.externalSeedRecall ||
      baseProduct?.recall_doc ||
      baseProduct?.recall,
  );
  const existingStoredVertical = normalizeStoredSemanticVertical(
    baseProduct?.semantic_vertical ||
      baseProduct?.recall_vertical ||
      existingRecall?.vertical,
  );
  const existingCatalogPathVertical = semanticVerticalFromCatalogCategoryPath(getCatalogCategoryPathHint(enriched));
  const existingInferred = inferVerticalFromProduct(enriched);
  const existingEffectiveVertical = existingCatalogPathVertical || existingStoredVertical || existingInferred.vertical;
  const existingBrand = getBrandName(enriched);
  const existingLeafCategory = getLeafCategory(enriched);
  const existingSignalStrength = computeSemanticSignalStrength({
    brand: existingBrand,
    leafCategory: existingLeafCategory,
    vertical: existingEffectiveVertical,
  });
  if (
    existingBrand &&
    !isWeakExternalSeedCategory(existingLeafCategory) &&
    String(enriched.title || enriched.name || '').trim() &&
    existingEffectiveVertical !== UNKNOWN_VERTICAL &&
    existingSignalStrength >= 2
  ) {
    if (existingCatalogPathVertical || existingStoredVertical) {
      enriched.semantic_vertical = existingCatalogPathVertical || existingStoredVertical;
      enriched.recall_vertical = existingCatalogPathVertical || existingStoredVertical;
    }
    return {
      product: enriched,
      semantic: {
        vertical: existingEffectiveVertical,
        vertical_inferred: existingCatalogPathVertical || existingStoredVertical ? false : existingInferred.inferred,
        signal_strength: existingSignalStrength,
        rescue_applied: false,
        rescue_fields: [],
      },
    };
  }

  const seedRecord = await loadExternalSeedSemanticRecord(baseProduct);
  const seedData = ensureJsonObject(seedRecord?.seed_data);
  const snapshot = ensureJsonObject(seedData?.snapshot);

  const seedBrand = String(
    seedData?.brand ||
      seedData?.brand_name ||
      seedData?.vendor ||
      seedData?.vendor_name ||
      snapshot?.brand ||
      snapshot?.brand_name ||
      snapshot?.vendor ||
      snapshot?.vendor_name ||
      '',
  ).trim();
  if (!getBrandName(enriched) && seedBrand) {
    if (!String(enriched.brand || '').trim()) enriched.brand = seedBrand;
    if (!String(enriched.vendor || '').trim()) enriched.vendor = seedBrand;
    rescueFields.push('brand');
  }

  const seedCategory = String(
    seedData?.recall_category ||
      seedData?.derived?.recall?.category ||
      seedData?.category ||
      seedData?.product?.category ||
      seedData?.product_type ||
      seedData?.productType ||
      snapshot?.category ||
      snapshot?.product_type ||
    snapshot?.productType ||
    '',
  ).trim();
  if (seedCategory && isWeakExternalSeedCategory(getLeafCategory(enriched))) {
    const rawCategoryPath = enriched.category_path || enriched.categoryPath;
    if (Array.isArray(rawCategoryPath) && rawCategoryPath.length > 0) {
      enriched.category_path = [seedCategory];
    }
    if (!String(enriched.category || '').trim()) enriched.category = seedCategory;
    if (!String(enriched.product_type || '').trim()) enriched.product_type = seedCategory;
    if (isWeakExternalSeedCategory(enriched.category)) enriched.category = seedCategory;
    if (isWeakExternalSeedCategory(enriched.product_type)) enriched.product_type = seedCategory;
    rescueFields.push('category');
  }

  const seedCategoryPath = normalizeCatalogCategoryPath(
    firstNonEmptyText(
      seedRecord?.catalog_category_path,
      seedData?.catalog_category_path,
      seedData?.category_path,
      snapshot?.catalog_category_path,
      snapshot?.category_path,
    ),
  );
  if (seedCategoryPath && !getCatalogCategoryPathHint(enriched)) {
    enriched.category_path = seedCategoryPath;
    enriched.catalog_category_path = seedCategoryPath;
    rescueFields.push('category_path');
  }

  const seedTitle = String(seedData?.title || seedRecord?.title || '').trim();
  if (!String(enriched.title || '').trim() && seedTitle) {
    enriched.title = seedTitle;
    rescueFields.push('title');
  }

  const seedDescription = String(seedData?.description || snapshot?.description || '').trim();
  if (!String(enriched.description || '').trim() && seedDescription) {
    enriched.description = seedDescription;
    rescueFields.push('description');
  }

  const seedPriceAmount = normalizeAmount(
    seedRecord?.price_amount ??
      seedData?.price_amount ??
      seedData?.price ??
      snapshot?.price_amount ??
      snapshot?.price,
  );
  if (!(getPriceAmount(enriched) > 0) && seedPriceAmount > 0) {
    enriched.price_amount = seedPriceAmount;
    enriched.price = seedPriceAmount;
    rescueFields.push('price');
  }

  const seedCurrency = String(
    seedRecord?.price_currency ||
      seedData?.price_currency ||
      snapshot?.price_currency ||
      '',
  ).trim();
  if (!String(enriched.currency || enriched.price_currency || '').trim() && seedCurrency) {
    enriched.currency = seedCurrency.toUpperCase();
    enriched.price_currency = seedCurrency.toUpperCase();
    rescueFields.push('currency');
  }

  const seedAvailability = String(
    seedRecord?.availability ||
      seedData?.availability ||
      snapshot?.availability ||
      '',
  ).trim();
  if (!String(enriched.availability || '').trim() && seedAvailability) {
    enriched.availability = seedAvailability;
    const normalizedAvailability = seedAvailability.toLowerCase();
    enriched.in_stock = !['out_of_stock', 'sold_out', 'unavailable', 'discontinued'].includes(
      normalizedAvailability,
    );
    rescueFields.push('availability');
  }

  const seedImageUrl = firstImageUrl(
    seedRecord?.image_url,
    seedData?.image_url,
    seedData?.image,
    snapshot?.image_url,
    snapshot?.image,
    Array.isArray(seedData?.images) ? seedData.images[0] : null,
    Array.isArray(snapshot?.images) ? snapshot.images[0] : null,
  );
  if (!String(enriched.image_url || enriched.image || '').trim() && seedImageUrl) {
    enriched.image_url = seedImageUrl;
    enriched.image = seedImageUrl;
    rescueFields.push('image');
  }

  const seedCanonicalUrl = firstNonEmptyText(
    seedRecord?.canonical_url,
    seedData?.canonical_url,
    snapshot?.canonical_url,
  );
  if (!String(enriched.canonical_url || enriched.canonicalUrl || '').trim() && seedCanonicalUrl) {
    enriched.canonical_url = seedCanonicalUrl;
    rescueFields.push('canonical_url');
  }

  const seedDestinationUrl = firstNonEmptyText(
    seedRecord?.destination_url,
    seedData?.destination_url,
    snapshot?.destination_url,
  );
  if (!String(enriched.destination_url || enriched.destinationUrl || '').trim() && seedDestinationUrl) {
    enriched.destination_url = seedDestinationUrl;
    if (!String(enriched.url || '').trim()) enriched.url = seedDestinationUrl;
    rescueFields.push('destination_url');
  }

  const seedDomain = firstNonEmptyText(seedRecord?.domain, seedData?.domain, snapshot?.domain);
  if (!String(enriched.domain || '').trim() && seedDomain) {
    enriched.domain = seedDomain;
    rescueFields.push('domain');
  }

  if (!String(enriched.external_seed_id || '').trim() && seedRecord?.id) {
    enriched.external_seed_id = String(seedRecord.id);
  }
  if (!String(enriched.external_product_id || '').trim() && seedRecord?.external_product_id) {
    enriched.external_product_id = String(seedRecord.external_product_id);
  }

  const inferred = inferVerticalFromProduct(enriched);
  const storedRecallVertical = normalizeStoredSemanticVertical(
    seedData?.recall_vertical ||
      seedData?.semantic_vertical ||
      seedData?.derived?.recall?.vertical,
  );
  const catalogPathVertical = semanticVerticalFromCatalogCategoryPath(getCatalogCategoryPathHint(enriched));
  const effectiveVertical = catalogPathVertical || storedRecallVertical || inferred.vertical;
  if (catalogPathVertical || storedRecallVertical) {
    enriched.semantic_vertical = catalogPathVertical || storedRecallVertical;
    enriched.recall_vertical = catalogPathVertical || storedRecallVertical;
  }
  return {
    product: enriched,
    semantic: {
      vertical: effectiveVertical,
      vertical_inferred: catalogPathVertical || storedRecallVertical ? false : inferred.inferred,
      signal_strength: computeSemanticSignalStrength({
        brand: getBrandName(enriched),
        leafCategory: getLeafCategory(enriched),
        vertical: effectiveVertical,
      }),
      rescue_applied: rescueFields.length > 0,
      rescue_fields: rescueFields,
    },
  };
}

async function recommend({
  pdp_product,
  k = PDP_RECS_DEFAULT_K,
  locale = 'en-US',
  currency = null,
  options = {},
}) {
  const rawBaseProduct = pdp_product || {};
  const baseProductId = getProductId(rawBaseProduct);
  if (!baseProductId) {
    return { items: [], debug: { error: 'missing_product_id' } };
  }
  const providedInternal = Array.isArray(options?.internal_candidates) ? options.internal_candidates : null;
  const providedExternal = Array.isArray(options?.external_candidates) ? options.external_candidates : null;
  if (!process.env.DATABASE_URL && !providedInternal && !providedExternal) {
    throw buildDatabaseNotConfiguredError('pdp_recommendations');
  }
  const baseMerchantId = getMerchantId(rawBaseProduct);
  const safeK = Math.max(1, Math.min(Number(k || PDP_RECS_DEFAULT_K) || PDP_RECS_DEFAULT_K, PDP_RECS_MAX_K));
  const candidateK = Math.max(
    safeK,
    Math.min(
      PDP_RECS_MAX_K,
      Number(options?.candidate_limit || options?.candidateLimit || safeK) || safeK,
    ),
  );
  const fallbackPolicy = recommendationFallbackPolicy();
  const normalizedRecentViews = normalizeRecentViews(
    options?.recent_views || options?.recentViews,
    {
      excludeProductId: baseProductId,
      limit: Math.max(3, Math.min(safeK, 6)),
    },
  );
  const excludeItems = Array.isArray(options?.exclude_items)
    ? options.exclude_items
    : Array.isArray(options?.exclude_ids)
      ? options.exclude_ids.map((productId) => ({ product_id: String(productId || '').trim() }))
      : [];
  const excludedCandidates = buildExcludedCandidateState(excludeItems);

  const baseCurrency = currency || normalizeCurrency(rawBaseProduct, 'USD');
  const cacheKey = JSON.stringify({
    contract: PDP_RECS_CARD_KB_CONTRACT_VERSION,
    merchant_id: baseMerchantId || null,
    product_id: baseProductId,
    k: safeK,
    candidate_k: candidateK,
    locale: String(locale || 'en-US'),
    currency: baseCurrency,
    recent_view_keys: normalizedRecentViews.map((item) => buildCandidateKey(item)),
    exclude_product_ids: Array.from(excludedCandidates.productIds).sort(),
    exclude_exact_keys: Array.from(excludedCandidates.exactKeys).sort(),
  });

  const bypassCache = options?.no_cache === true || options?.cache_bypass === true || options?.bypass_cache === true;
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
  const effectiveExcludedCandidates = mergeExcludedCandidateStates(
    excludedCandidates,
    buildExcludedCandidateState([baseProduct]),
  );
  const baseBrand = getBrandName(baseProduct);
  const baseLeaf = getLeafCategory(baseProduct);
  const baseCategoryPath = getCatalogCategoryPathHint(baseProduct);
  const baseDomains = extractProductDomains(baseProduct);
  const baseIntentFamily = getSimilarIntentFamilyFromProduct(baseProduct);
  const baseSemanticStrong = Number(baseSemantic?.signal_strength || 0) >= 2;
  const baseProductIsExternal = isExternalProduct(baseProduct);
  const effectiveExternalFetchTimeoutMs = baseProductIsExternal
    ? PDP_RECS_EXTERNAL_BASE_FETCH_TIMEOUT_MS
    : PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS;

  const shouldFetchInternalCandidates = Boolean(providedInternal) || !baseProductIsExternal;
  const externalFetchLimit = Math.max(
    PDP_RECS_EXTERNAL_FETCH_LIMIT_MIN,
    Math.ceil(candidateK * PDP_RECS_EXTERNAL_FETCH_LIMIT_MULTIPLIER),
  );
  const externalFocusedRecallTarget = focusedExternalRecallTargetCount(safeK);

  let internalTimedOut = false;
  let externalTimedOut = false;
  const internalCandidatesTask = withSoftTimeout(
    providedInternal
      ? Promise.resolve(providedInternal)
      : shouldFetchInternalCandidates
        ? fetchInternalCandidates({
            merchantId: getMerchantId(baseProduct),
            limit: Math.max(60, candidateK * 10),
            excludeMerchantId: getMerchantId(baseProduct),
            categoryHint: baseLeaf,
          })
        : Promise.resolve([]),
    PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS,
    [],
    () => {
      internalTimedOut = true;
      logger.warn(
        {
          product_id: baseProductId,
          timeout_ms: PDP_RECS_INTERNAL_FETCH_TIMEOUT_MS,
        },
        'PDP recommendations internal candidate fetch timed out',
      );
    },
  );
  const externalCandidatesTask = withSoftTimeout(
    providedExternal
      ? Promise.resolve(providedExternal)
      : fetchExternalCandidates({
          brandHint: baseBrand,
          categoryHint: baseLeaf,
          categoryPathHint: baseCategoryPath,
          verticalHint: baseSemantic?.vertical || '',
          intentFamilyHint: baseIntentFamily,
          domainHints: baseDomains,
          limit: externalFetchLimit,
          minFocusedCandidates: externalFocusedRecallTarget,
          deepDomainRecall: baseProductIsExternal,
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
  ).catch((err) => {
    logger.warn(
      { err: err?.message || String(err), product_id: baseProductId },
      'PDP recommendations external candidate fetch failed',
    );
    return [];
  });
  const internalCandidates = await internalCandidatesTask;

  const internalCount = Array.isArray(internalCandidates) ? internalCandidates.length : 0;
  const externalSkipEligibleInternalCount = countExternalSkipEligibleInternalCandidates(
    baseProduct,
    internalCandidates,
  );
  const skipExternalMin = Math.max(
    PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_ABS,
    Math.ceil(candidateK * PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_MULTIPLIER),
  );
  const shouldSkipExternal =
    !providedExternal &&
    externalSkipEligibleInternalCount >= skipExternalMin &&
    baseSemanticStrong &&
    !baseProductIsExternal;

  const externalCandidates = shouldSkipExternal
    ? []
    : await externalCandidatesTask;
  const externalFetchStats =
    externalCandidates && typeof externalCandidates === 'object'
      ? externalCandidates.__externalFetchStats || null
      : null;

  let filteredInternalCandidates = filterCandidateCollection(internalCandidates, effectiveExcludedCandidates);
  let filteredExternalCandidates = filterCandidateCollection(externalCandidates, effectiveExcludedCandidates);
  const identityDedupe = await dedupeRecommendationCandidatesByIdentity({
    baseProduct,
    internalCandidates: filteredInternalCandidates,
    externalCandidates: filteredExternalCandidates,
    identityRows: options?.identity_rows,
    identityRowsResolverFn: options?.identity_rows_resolver_fn,
  });
  filteredInternalCandidates = identityDedupe.internalCandidates;
  filteredExternalCandidates = identityDedupe.externalCandidates;

  const picked = pickLayeredRecommendations({
    baseProduct,
    internalCandidates: filteredInternalCandidates,
    externalCandidates: filteredExternalCandidates,
    k: candidateK,
    baseSemantic,
  });

  let finalItems = Array.isArray(picked.items) ? picked.items.slice(0, safeK) : [];
  const historyFallbackDebug = {
    used: false,
    anchors_considered: normalizedRecentViews.length,
    anchors_used: [],
    added_count: 0,
  };

  if (finalItems.length === 0 && normalizedRecentViews.length > 0 && visibleFallbacksEnabled()) {
    const historyExcludedCandidates = mergeExcludedCandidateStates(
      excludedCandidates,
      buildExcludedCandidateState(
        normalizedRecentViews.map((item) => ({
          product_id: item.product_id,
          ...(item.merchant_id ? { merchant_id: item.merchant_id } : {}),
        })),
      ),
    );
    let historyItems = [];

    for (const recentView of normalizedRecentViews) {
      const remaining = safeK - historyItems.length;
      if (remaining <= 0) break;

      const { product: historyBaseProduct, semantic: historyBaseSemantic } = await enrichExternalBaseProduct({
        merchant_id: recentView.merchant_id || null,
        product_id: recentView.product_id,
        title: recentView.title,
        description: recentView.description,
        brand: recentView.brand,
        category: recentView.category,
        product_type: recentView.product_type,
      });

      const perAnchorExcluded = mergeExcludedCandidateStates(
        effectiveExcludedCandidates,
        historyExcludedCandidates,
        buildExcludedCandidateState(historyItems),
      );
      const historyPicked = pickLayeredRecommendations({
        baseProduct: historyBaseProduct,
        internalCandidates: filterCandidateCollection(filteredInternalCandidates, perAnchorExcluded),
        externalCandidates: filterCandidateCollection(filteredExternalCandidates, perAnchorExcluded),
        k: remaining,
        baseSemantic: historyBaseSemantic,
      });

      if (!Array.isArray(historyPicked.items) || historyPicked.items.length === 0) continue;

      historyItems = uniqueByKey(
        [...historyItems, ...historyPicked.items],
        (item) => buildCandidateKey(item),
      ).slice(0, safeK);

      historyFallbackDebug.anchors_used.push({
        product_id: getProductId(historyBaseProduct),
        merchant_id: getMerchantId(historyBaseProduct) || null,
        added_count: historyPicked.items.length,
      });
    }

    if (historyItems.length > 0) {
      finalItems = historyItems;
      historyFallbackDebug.used = true;
      historyFallbackDebug.added_count = historyItems.length;
    }
  }

  let productIntelCardHydration = {
    items: finalItems,
    stats: {
      attempted_count: 0,
      hydrated_count: 0,
      skipped_unreviewed_count: 0,
      failed: false,
      db_fallback_attempted_count: 0,
      db_fallback_hit_count: 0,
      skipped: true,
      reason: 'disabled_by_caller',
    },
  };
  if (options?.hydrate_product_intel_cards !== false) {
    productIntelCardHydration = await hydrateRecommendationItemsWithReviewedProductIntel(finalItems);
    finalItems = productIntelCardHydration.items;
  }

  const elapsedMs = Date.now() - start;
  const finalSourceCounts = countRecommendationSources(finalItems);
  const finalMetadata = {
    ...(picked.metadata || {}),
    retrieval_mix: finalSourceCounts,
    underfill: Math.max(0, safeK - finalItems.length),
    low_confidence: Boolean(picked?.metadata?.low_confidence),
    similar_status: finalItems.length > 0 ? 'ready' : internalTimedOut || externalTimedOut ? 'unavailable' : 'empty',
    ...(identityDedupe?.stats?.applied
      ? { identity_dedupe: identityDedupe.stats }
      : {}),
    product_intel_card_hydration: productIntelCardHydration.stats,
  };

  if (historyFallbackDebug.used) {
    finalMetadata.low_confidence = true;
    finalMetadata.similar_confidence = 'low';
    finalMetadata.low_confidence_reason_codes = appendReasonCode(
      finalMetadata.low_confidence_reason_codes,
      'RECENT_VIEWS_FALLBACK_USED',
    );
  }
  if (!historyFallbackDebug.used && normalizedRecentViews.length > 0 && !visibleFallbacksEnabled()) {
    historyFallbackDebug.disabled = true;
  }

  const finalUnderfill = Math.max(0, safeK - finalItems.length);
  const finalReadyMinCount = Math.min(safeK, PDP_RECS_READY_MIN_COUNT);
  if (finalItems.length > 0 && finalItems.length < finalReadyMinCount) {
    finalMetadata.similar_status = 'underfilled';
    finalMetadata.low_confidence_reason_codes = appendReasonCode(
      finalMetadata.low_confidence_reason_codes,
      'UNDERFILL_MAINLINE_RECALL',
    );
  }
  if (finalItems.length === 0 && !internalTimedOut && !externalTimedOut) {
    finalMetadata.similar_status = 'empty';
  }
  finalMetadata.fallback_policy = fallbackPolicy;

  const result = {
    items: finalItems,
    metadata: finalMetadata,
    debug: {
      ...picked.debug,
      timing_ms: elapsedMs,
      fetch_strategy: {
        internal_count: Array.isArray(filteredInternalCandidates) ? filteredInternalCandidates.length : 0,
        external_count: Array.isArray(filteredExternalCandidates) ? filteredExternalCandidates.length : 0,
        internal_timed_out: internalTimedOut,
        external_timed_out: externalTimedOut,
        external_skipped: shouldSkipExternal,
        external_skip_min_candidates: skipExternalMin,
        external_skip_internal_quality_count: externalSkipEligibleInternalCount,
        base_semantic_strong: baseSemanticStrong,
        base_product_is_external: baseProductIsExternal,
        base_intent_family: baseIntentFamily || null,
        external_fetch_limit: externalFetchLimit,
        external_focused_recall_target: externalFocusedRecallTarget,
        external_recall_debug: externalFetchStats,
        ready_min_count: finalReadyMinCount,
        requested_count: safeK,
        candidate_count: candidateK,
      },
      sources: finalSourceCounts,
      history_fallback: historyFallbackDebug,
      product_intel_card_hydration: productIntelCardHydration.stats,
      base_semantic: baseSemantic || null,
      fallback_policy: fallbackPolicy,
      cache_key_hash: debugEnabled ? stableHashShort(cacheKey) : undefined,
    },
  };

  if (PDP_RECS_CACHE_ENABLED && !bypassCache) {
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
      sources: finalSourceCounts,
      similar_confidence: finalMetadata.similar_confidence || null,
      low_confidence: Boolean(finalMetadata.low_confidence),
      underfill: Math.max(0, safeK - finalItems.length),
      history_fallback_used: historyFallbackDebug.used,
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
  hydrateRecommendationItemsWithReviewedProductIntel,
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
    applyRecommendationProductIntelBundle,
    extractRecommendationProductIntelBundle,
    hydrateRecommendationItemsWithReviewedProductIntel,
    fetchExternalCandidates,
    fetchInternalCandidates,
    enrichExternalBaseProduct,
    extractProductDomains,
    normalizeHostname,
    recommendationFallbackPolicy,
    getSimilarIntentFamilyFromText,
    getSimilarIntentFamilyFromFeatures,
  },
};
