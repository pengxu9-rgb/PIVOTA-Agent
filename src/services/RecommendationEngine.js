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
const PDP_RECS_EXTERNAL_BASE_FETCH_TIMEOUT_MS = Math.max(
  PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS,
  parseTimeoutMs(process.env.PDP_RECS_EXTERNAL_BASE_FETCH_TIMEOUT_MS, 5000),
);
const PDP_RECS_IDENTITY_DEDUPE_TIMEOUT_MS = Math.max(
  100,
  parseTimeoutMs(process.env.PDP_RECS_IDENTITY_DEDUPE_TIMEOUT_MS, 450),
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

function buildRecommendationTitleDedupeKey(product) {
  return normalizeText(product?.title || product?.name);
}

function buildExcludedCandidateState(items = []) {
  const exactKeys = new Set();
  const productIds = new Set();
  const titleKeys = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const productId = getProductId(item);
    const titleKey = buildRecommendationTitleDedupeKey(item);
    if (titleKey) titleKeys.add(titleKey);
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

  return { exactKeys, productIds, titleKeys };
}

function mergeExcludedCandidateStates(...states) {
  const exactKeys = new Set();
  const productIds = new Set();
  const titleKeys = new Set();

  for (const state of states) {
    if (!state || typeof state !== 'object') continue;
    for (const key of state.exactKeys || []) exactKeys.add(key);
    for (const productId of state.productIds || []) productIds.add(productId);
    for (const titleKey of state.titleKeys || []) titleKeys.add(titleKey);
  }

  return { exactKeys, productIds, titleKeys };
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
    snapshot.destination_url,
    seedData.destination_url,
  );
  const canonicalUrl = firstNonEmptyText(
    row.canonical_url,
    snapshot.canonical_url,
    seedData.canonical_url,
  );
  const sourceUrl = firstNonEmptyText(
    row.source_url,
    seedData.source_url,
    snapshot.source_url,
    canonicalUrl,
    destinationUrl,
  );
  const externalProductId = firstNonEmptyText(
    row.external_product_id,
    seedData.external_product_id,
    seedData.product_id,
    snapshot.product_id,
  );
  const parentExternalProductId = firstNonEmptyText(
    seedData.parent_external_product_id,
    snapshot.parent_external_product_id,
  );
  const sourceListingScope = firstNonEmptyText(seedData.source_listing_scope, snapshot.source_listing_scope);
  const variantTitle = firstNonEmptyText(seedData.variant_title, snapshot.variant_title);

  if (!externalProductId) return null;

  const title = firstNonEmptyText(
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
    row.seed_vendor,
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
    seedData.product_type,
    seedData.productType,
    snapshot.product_type,
    snapshot.productType,
  );
  const category = firstNonEmptyText(
    row.seed_category,
    seedData.category,
    seedData.product?.category,
    snapshot.category,
    productType,
    fallbackCategory,
  );
  const imageUrl = firstImageUrl(
    row.image_url,
    snapshot.image_url,
    snapshot.image,
    seedData.image_url,
    seedData.image,
    Array.isArray(snapshot.images) ? snapshot.images[0] : null,
    Array.isArray(seedData.images) ? seedData.images[0] : null,
  );
  const rawPriceAmount =
    row.price_amount ??
    seedData.price_amount ??
    seedData.price ??
    snapshot.price_amount ??
    snapshot.price ??
    null;
  const priceAmount =
    rawPriceAmount == null || rawPriceAmount === '' ? null : normalizeAmount(rawPriceAmount);
  const priceCurrency = firstNonEmptyText(
    row.price_currency,
    seedData.price_currency,
    snapshot.price_currency,
    'USD',
  ).toUpperCase();
  const availability = firstNonEmptyText(
    row.availability,
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
  };
}

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

function buildBaseFeatures(baseProduct) {
  const brand = getBrandName(baseProduct);
  const leafCategory = getLeafCategory(baseProduct);
  const parentCategory = getParentCategory(baseProduct);
  const priceAmount = getPriceAmount(baseProduct);
  const verticalSignal = inferVerticalFromProduct(baseProduct);
  const tokens = tokenize([baseProduct.title, baseProduct.name, brand, leafCategory, parentCategory].filter(Boolean).join(' '));
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
  };
}

function buildCandidateFeatures(candidateProduct, baseCurrency) {
  const brand = getBrandName(candidateProduct);
  const leafCategory = getLeafCategory(candidateProduct);
  const parentCategory = getParentCategory(candidateProduct);
  const priceAmount = getPriceAmount(candidateProduct);
  const currency = normalizeCurrency(candidateProduct, baseCurrency);
  const verticalSignal = inferVerticalFromProduct(candidateProduct);
  const tokens = tokenize([candidateProduct.title, candidateProduct.name, brand, leafCategory, parentCategory].filter(Boolean).join(' '));
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
  };
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
      if (candidate.source !== 'external' || !candidate.brandMatch) continue;
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
  const K = Math.max(1, Math.min(Number(k || 6) || 6, 30));
  const base = buildBaseFeatures(baseProduct);

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
      name: 'same_brand_external_synthetic',
      priority: 2.5,
      predicate: (c, features, baseFeatures) =>
        baseFeatures.isExternal &&
        c.brandMatch &&
        (
          features.isExternal ||
          c.leafMatch ||
          c.parentMatch ||
          c.tokenOverlap >= 0.05 ||
          baseFeatures.vertical === UNKNOWN_VERTICAL ||
          features.vertical === UNKNOWN_VERTICAL ||
          baseFeatures.vertical === features.vertical
        ),
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
      name: 'same_vertical_token_overlap',
      priority: 5,
      predicate: (c, features, baseFeatures) =>
        baseFeatures.vertical !== UNKNOWN_VERTICAL &&
        features.vertical !== UNKNOWN_VERTICAL &&
        baseFeatures.vertical === features.vertical &&
        c.tokenOverlap >= 0.12,
    },
  ];

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

      if (
        base.isExternal &&
        base.brand &&
        source === 'internal' &&
        !scoreDetail.brandMatch
      ) {
        filteredByExternalBrandAuthority += 1;
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
  if (filteredByExternalBrandAuthority > 0) {
    lowConfidenceReasonCodes.push('EXTERNAL_BASE_BLOCKED_OTHER_BRAND_INTERNAL');
  }
  if (selected.length < K) lowConfidenceReasonCodes.push('UNDERFILL_FOR_QUALITY');
  if (!lowConfidenceReasonCodes.length && lowConfidence) lowConfidenceReasonCodes.push('INSUFFICIENT_HIGH_CONFIDENCE');

  return {
    items: selected.slice(0, K),
    metadata: {
      similar_confidence: similarConfidence,
      low_confidence: lowConfidence,
      low_confidence_reason_codes: lowConfidenceReasonCodes,
      retrieval_mix: {
        internal: sourceCounts.internal,
        external: sourceCounts.external,
      },
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
      candidates_total: candidates.length,
      sources: sourceCounts,
      confidence: confidenceCounts,
      filters: {
        by_vertical: filteredByVertical,
        by_confidence: filteredByConfidence,
        by_external_brand_authority: filteredByExternalBrandAuthority,
      },
    },
  };
}

async function fetchInternalCandidates({ merchantId, limit, excludeMerchantId, categoryHint }) {
  const mid = String(merchantId || '').trim();
  const safeLimit = Math.min(Math.max(1, Number(limit || 120)), 400);
  const categoryAliases = buildNormalizedAliases(categoryHint);

  // In MOCK mode we may not have DATABASE_URL configured; use in-memory mock catalog
  // so PDP recommendations are still non-empty and fast locally.
  if (!process.env.DATABASE_URL) {
    try {
      // Lazy require to avoid impacting production paths.
      // eslint-disable-next-line global-require
      const { mockProducts } = require('../mockProducts');
      const out = [];

      if (mid && Array.isArray(mockProducts?.[mid])) {
        for (const p of mockProducts[mid]) out.push(toCandidate(p, { merchant_id: mid }));
      }

      for (const [merchant_id, products] of Object.entries(mockProducts || {})) {
        if (!Array.isArray(products)) continue;
        if (merchant_id === EXTERNAL_SEED_MERCHANT_ID) continue;
        if (excludeMerchantId && merchant_id === String(excludeMerchantId || '').trim()) continue;
        for (const p of products) out.push(toCandidate(p, { merchant_id }));
      }

      return uniqueByKey(out.filter(Boolean), (p) => `${getMerchantId(p)}::${getProductId(p)}`).slice(0, safeLimit * 4);
    } catch {
      return [];
    }
  }
  const out = [];

  try {
    if (mid && mid !== EXTERNAL_SEED_MERCHANT_ID && categoryAliases.length) {
      const res = await query(
        `
          SELECT product_data
          FROM products_cache
          WHERE merchant_id = $1
            AND (expires_at IS NULL OR expires_at > now())
            AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
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

  try {
    // Global recent internal fallback (keeps cold-start non-empty).
    const res = await query(
      `
        SELECT merchant_id, product_data
        FROM products_cache
        WHERE (expires_at IS NULL OR expires_at > now())
          AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
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

  return uniqueByKey(out.filter(Boolean), (p) => `${getMerchantId(p)}::${getProductId(p)}`).slice(0, safeLimit * 4);
}

async function fetchExternalCandidates({
  brandHint,
  categoryHint,
  domainHints = [],
  limit,
  minFocusedCandidates = 6,
}) {
  if (!process.env.DATABASE_URL) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit || 180)), 500);
  const safeMinFocusedCandidates = Math.max(
    1,
    Math.min(30, Number(minFocusedCandidates || 6) || 6),
  );
  const market = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US').trim().toUpperCase() || 'US';
  const tool = 'creator_agents';

  const brand = normalizeText(brandHint);
  const category = normalizeText(categoryHint);
  const normalizedDomainHints = uniqueByKey(
    (Array.isArray(domainHints) ? domainHints : [domainHints])
      .flatMap((value) => buildDomainLookupAliases(value))
      .filter(Boolean),
    (value) => value,
  );
  const brandAliases = buildNormalizedAliases(brandHint);
  const compactBrand = brandAliases.find((value) => !/\s/.test(value)) || brand.replace(/\s+/g, '');
  const categoryAliases = buildNormalizedAliases(categoryHint);

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
            seed_data,
            updated_at,
            created_at
          FROM external_product_seeds
          WHERE status = 'active'
            AND market = $1
            AND (tool = '*' OR tool = $2)
            ${whereSql}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $3
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
            seed_data,
            updated_at,
            created_at
          FROM external_product_seeds
          WHERE status = 'active'
            AND market = $1
            AND (tool = '*' OR tool = $2)
            AND lower(coalesce(domain, '')) = ANY($4)
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $3
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

  const out = [];
  const domainMatches = await runDomainQuery(Math.min(safeLimit, Math.max(12, safeMinFocusedCandidates * 2)));
  out.push(...domainMatches);
  const domainFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
  if (domainFocusedCandidates.length >= safeMinFocusedCandidates) {
    return domainFocusedCandidates.slice(0, safeLimit * 3);
  }

  if (brand) {
    const brandFieldMatches = await runQuery(
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
    );
    out.push(...brandFieldMatches);
    const brandFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
    if (brandFocusedCandidates.length >= safeMinFocusedCandidates) {
      return brandFocusedCandidates.slice(0, safeLimit * 3);
    }

    const brandTitleMatches = compactBrand
      ? await runQuery(
          `AND regexp_replace(lower(coalesce(seed_data->'snapshot'->>'title','')), '[^a-z0-9]+', '', 'g') LIKE '%' || $4 || '%'`,
          [compactBrand],
          Math.min(80, safeLimit),
          'external_brand_title',
        )
      : [];
    out.push(...brandTitleMatches);
    const titleFocusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
    if (titleFocusedCandidates.length >= safeMinFocusedCandidates) {
      return titleFocusedCandidates.slice(0, safeLimit * 3);
    }
  }

  const categoryMatches = category
    ? await runQuery(
        `AND (
            lower(coalesce(seed_data->>'category','')) = ANY($4)
            OR lower(coalesce(seed_data->>'product_type','')) = ANY($4)
            OR lower(coalesce(seed_data->>'productType','')) = ANY($4)
            OR lower(coalesce(seed_data->'product'->>'category','')) = ANY($4)
            OR lower(coalesce(seed_data->'snapshot'->>'category','')) = ANY($4)
            OR lower(coalesce(seed_data->'snapshot'->>'product_type','')) = ANY($4)
            OR lower(coalesce(seed_data->'snapshot'->>'productType','')) = ANY($4)
          )`,
        [categoryAliases],
        Math.min(120, safeLimit),
        'external_category',
      )
    : [];

  out.push(...categoryMatches);
  const focusedCandidates = uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`);
  const hasFocusedCandidates = focusedCandidates.length > 0;
  if (!hasFocusedCandidates) {
    const recent = await runQuery('', [], Math.min(240, safeLimit), 'external_recent');
    out.push(...recent);
  }

  return uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`).slice(0, safeLimit * 3);
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
        SELECT id, external_product_id, title, seed_data, updated_at
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
    seedData?.category ||
      seedData?.product?.category ||
      seedData?.product_type ||
      seedData?.productType ||
      snapshot?.category ||
      snapshot?.product_type ||
      snapshot?.productType ||
      '',
  ).trim();
  if (!getLeafCategory(enriched) && seedCategory) {
    if (!String(enriched.category || '').trim()) enriched.category = seedCategory;
    if (!String(enriched.product_type || '').trim()) enriched.product_type = seedCategory;
    rescueFields.push('category');
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

  if (!String(enriched.external_seed_id || '').trim() && seedRecord?.id) {
    enriched.external_seed_id = String(seedRecord.id);
  }
  if (!String(enriched.external_product_id || '').trim() && seedRecord?.external_product_id) {
    enriched.external_product_id = String(seedRecord.external_product_id);
  }

  const inferred = inferVerticalFromProduct(enriched);
  return {
    product: enriched,
    semantic: {
      vertical: inferred.vertical,
      vertical_inferred: inferred.inferred,
      signal_strength: computeSemanticSignalStrength({
        brand: getBrandName(enriched),
        leafCategory: getLeafCategory(enriched),
        vertical: inferred.vertical,
      }),
      rescue_applied: rescueFields.length > 0,
      rescue_fields: rescueFields,
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
    merchant_id: baseMerchantId || null,
    product_id: baseProductId,
    k: safeK,
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
  const baseDomains = extractProductDomains(baseProduct);
  const baseSemanticStrong = Number(baseSemantic?.signal_strength || 0) >= 2;
  const baseProductIsExternal = isExternalProduct(baseProduct);
  const effectiveExternalFetchTimeoutMs = baseProductIsExternal
    ? PDP_RECS_EXTERNAL_BASE_FETCH_TIMEOUT_MS
    : PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS;

  const providedInternal = Array.isArray(options?.internal_candidates) ? options.internal_candidates : null;
  const providedExternal = Array.isArray(options?.external_candidates) ? options.external_candidates : null;
  const shouldFetchInternalCandidates = Boolean(providedInternal) || !baseProductIsExternal;

  let internalTimedOut = false;
  let externalTimedOut = false;
  const internalCandidatesTask = withSoftTimeout(
    providedInternal
      ? Promise.resolve(providedInternal)
      : shouldFetchInternalCandidates
        ? fetchInternalCandidates({
            merchantId: getMerchantId(baseProduct),
            limit: Math.max(60, safeK * 10),
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
          domainHints: baseDomains,
          limit: Math.max(120, safeK * 15),
          minFocusedCandidates: safeK,
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
    Math.ceil(safeK * PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_MULTIPLIER),
  );
  const shouldSkipExternal =
    !providedExternal &&
    externalSkipEligibleInternalCount >= skipExternalMin &&
    baseSemanticStrong &&
    !baseProductIsExternal;

  const externalCandidates = shouldSkipExternal
    ? []
    : await externalCandidatesTask;

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
    k: safeK,
    baseSemantic,
  });

  let finalItems = Array.isArray(picked.items) ? picked.items.slice(0, safeK) : [];
  const historyFallbackDebug = {
    used: false,
    anchors_considered: normalizedRecentViews.length,
    anchors_used: [],
    added_count: 0,
  };

  if (finalItems.length === 0 && normalizedRecentViews.length > 0) {
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
  };

  if (historyFallbackDebug.used) {
    finalMetadata.low_confidence = true;
    finalMetadata.similar_confidence = 'low';
    finalMetadata.low_confidence_reason_codes = appendReasonCode(
      finalMetadata.low_confidence_reason_codes,
      'RECENT_VIEWS_FALLBACK_USED',
    );
  }

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
      },
      sources: finalSourceCounts,
      history_fallback: historyFallbackDebug,
      base_semantic: baseSemantic || null,
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
    fetchExternalCandidates,
    fetchInternalCandidates,
    enrichExternalBaseProduct,
    extractProductDomains,
    normalizeHostname,
  },
};
