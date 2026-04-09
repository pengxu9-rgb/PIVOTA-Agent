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
  buildExternalSeedProduct,
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
const PDP_RECS_CACHE_VERSION = String(process.env.PDP_RECS_CACHE_VERSION || 'stable_v2');
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
const PDP_RECS_CACHE = new Map(); // cacheKey -> { value, storedAtMs, expiresAtMs }
const PDP_RECS_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
  evictions: 0,
};
const ALLOW_MOCK_RECOMMENDATION_CATALOG =
  String(process.env.API_MODE || '')
    .trim()
    .toUpperCase() === 'MOCK' ||
  process.env.NODE_ENV === 'test' ||
  Boolean(process.env.JEST_WORKER_ID);

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

function shouldCacheRecommendationResult(result) {
  const metadata = result && typeof result === 'object' ? result.metadata : null;
  const status = String(metadata?.similar_status || '').trim().toLowerCase();
  const similarSources = metadata && typeof metadata.similar_sources === 'object' ? metadata.similar_sources : {};
  const hasHardFailure = Object.values(similarSources).some(
    (source) => source && typeof source === 'object' && (source.timed_out === true || Boolean(source.error_code)),
  );
  if (hasHardFailure) return false;
  return status === 'ready' || status === 'empty';
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

function normalizeBrandLookupKey(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
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

function pickLayeredRecommendations({
  baseProduct,
  internalCandidates,
  externalCandidates,
  k,
  baseSemantic = null,
}) {
  const K = Math.max(1, Math.min(Number(k || 6) || 6, 30));
  const base = buildBaseFeatures(baseProduct);
  const preferSource = base.isExternal ? 'external' : 'internal';
  const layers = [
    {
      id: 'L1',
      name: 'same_brand+leaf_category',
      priority: 1,
      predicate: (candidate) => candidate.brandMatch && candidate.leafMatch,
    },
    {
      id: 'L2',
      name: 'same_brand+adjacent_category',
      priority: 2,
      predicate: (candidate) =>
        candidate.brandMatch &&
        (candidate.parentMatch || candidate.verticalMatch || !base.leafCategory),
    },
    {
      id: 'L3',
      name: 'same_brand_only_fallback',
      priority: 3,
      predicate: (candidate) =>
        candidate.brandMatch && !candidate.features.leafCategory && !candidate.features.parentCategory,
    },
  ];
  const layerById = Object.fromEntries(layers.map((layer) => [layer.id, layer]));

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
      const verticalMatch =
        base.vertical !== UNKNOWN_VERTICAL &&
        features.vertical !== UNKNOWN_VERTICAL &&
        base.vertical === features.vertical;
      const matchedLayer =
        layers.find((layer) => layer.predicate({ ...scoreDetail, features, verticalMatch })) || null;
      if (!matchedLayer) {
        return null;
      }

      return {
        product: p,
        features,
        source,
        layerId: matchedLayer.id,
        layerName: matchedLayer.name,
        layerPriority: matchedLayer.priority,
        verticalMatch,
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
      if (a.source === preferSource && b.source !== preferSource) return -1;
      if (b.source === preferSource && a.source !== preferSource) return 1;
      if ((a.relDiff ?? Number.POSITIVE_INFINITY) !== (b.relDiff ?? Number.POSITIVE_INFINITY)) {
        return (a.relDiff ?? Number.POSITIVE_INFINITY) - (b.relDiff ?? Number.POSITIVE_INFINITY);
      }
      if (a.score !== b.score) return b.score - a.score;
      return a.features.productId.localeCompare(b.features.productId);
    })
    .slice(0, 160);

  const layerCounts = {};
  for (const candidate of candidates) {
    layerCounts[candidate.layerId] = (layerCounts[candidate.layerId] || 0) + 1;
  }

  const chosenCandidates = candidates.slice(0, K);
  const selected = chosenCandidates.map((candidate) =>
    toCandidate(candidate.product, {
      source: candidate.source,
      reason: `${candidate.layerId}:${candidate.source}:${layerById[candidate.layerId]?.name || ''}`,
      x_score: Number(candidate.score.toFixed(4)),
      x_confidence:
        candidate.layerId === 'L1' ? 'high' : candidate.layerId === 'L3' ? 'low' : 'moderate',
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

  const signalStrength =
    Number(baseSemantic?.signal_strength) ||
    computeSemanticSignalStrength({
      brand: base.brand,
      leafCategory: base.leafCategory,
      vertical: base.vertical,
    });
  const baseSemanticStrong = signalStrength >= 2;

  const l1Count = chosenCandidates.filter((candidate) => candidate.layerId === 'L1').length;
  const similarConfidence =
    !selected.length ? 'low' : l1Count >= Math.max(1, Math.ceil(selected.length * 0.6)) ? 'high' : 'medium';
  const lowConfidence = selected.length === 0;

  return {
    items: selected.slice(0, K),
    metadata: {
      similar_confidence: similarConfidence,
      low_confidence: lowConfidence,
      low_confidence_reason_codes: selected.length ? [] : ['NO_SAME_BRAND_MATCHES'],
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
      filters: {
        same_brand_only: true,
        semantic_expansion_removed: true,
      },
    },
  };
}

async function fetchInternalCandidates({ merchantId, limit, excludeMerchantId }) {
  const mid = String(merchantId || '').trim();
  const safeLimit = Math.min(Math.max(1, Number(limit || 120)), 400);

  if (!process.env.DATABASE_URL) {
    if (!ALLOW_MOCK_RECOMMENDATION_CATALOG) {
      logger.warn(
        { merchantId: mid || null },
        'recommendations internal candidates skipped: DATABASE_URL missing outside mock/test mode',
      );
      return [];
    }
    try {
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

async function fetchExternalCandidates({ brandHint, categoryHint, limit }) {
  if (!process.env.DATABASE_URL) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit || 180)), 500);
  const market = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US').trim().toUpperCase() || 'US';
  const tool = 'creator_agents';

  const brandAlias = normalizeText(brandHint);
  const brandCompact = normalizeBrandLookupKey(brandHint);
  const category = normalizeText(categoryHint);
  const brandAliases = Array.from(new Set([brandAlias, brandCompact].filter(Boolean)));
  const brandCompacts = Array.from(new Set([brandCompact].filter(Boolean)));

  function buildBrandWhereClause(aliasBind, compactBind, titleBind) {
    return `AND (
              lower(coalesce(seed_data->>'brand', '')) = ANY(${aliasBind}::text[])
              OR lower(coalesce(seed_data->>'brand_name', '')) = ANY(${aliasBind}::text[])
              OR lower(coalesce(seed_data->>'vendor', '')) = ANY(${aliasBind}::text[])
              OR lower(coalesce(seed_data->>'vendor_name', '')) = ANY(${aliasBind}::text[])
              OR lower(coalesce(seed_data->'snapshot'->>'brand', '')) = ANY(${aliasBind}::text[])
              OR lower(coalesce(seed_data->'snapshot'->>'brand_name', '')) = ANY(${aliasBind}::text[])
              OR lower(coalesce(seed_data->'snapshot'->>'vendor', '')) = ANY(${aliasBind}::text[])
              OR lower(coalesce(seed_data->'snapshot'->>'vendor_name', '')) = ANY(${aliasBind}::text[])
              OR lower(
                   regexp_replace(
                     coalesce(
                       seed_data->>'brand',
                       seed_data->'snapshot'->>'brand',
                       split_part(domain, '.', 1),
                       ''
                     ),
                     '[^a-z0-9]+',
                     '',
                     'g'
                   )
                 ) = ANY(${compactBind}::text[])
              OR EXISTS (
                SELECT 1
                FROM unnest(${titleBind}::text[]) AS alias
                WHERE lower(coalesce(seed_data->'snapshot'->>'title', seed_data->>'title', title, '')) LIKE alias || ' %'
              )
            )`;
  }

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
        const p = buildExternalSeedProduct(row);
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

  const queries = [];
  if (brandAliases.length && brandCompacts.length && category) {
    queries.push(
      runQuery(
        `${buildBrandWhereClause('$4', '$5', '$4')}
             AND lower(
               coalesce(
                 seed_data->'derived'->'recall'->>'category',
                 seed_data->>'category',
                 seed_data->'product'->>'category',
                 seed_data->'snapshot'->>'category',
                 seed_data->>'product_type',
                 seed_data->>'productType',
                 seed_data->'snapshot'->>'product_type',
                 seed_data->'snapshot'->>'productType',
                 ''
               )
             ) = $6`,
        [brandAliases, brandCompacts, category],
        Math.min(160, safeLimit),
        'external_brand_category',
      ),
    );
  }
  if (brandAliases.length && brandCompacts.length) {
    queries.push(
      runQuery(
        buildBrandWhereClause('$4', '$5', '$4'),
        [brandAliases, brandCompacts],
        Math.min(180, safeLimit),
        'external_brand',
      ),
    );
  }
  if (!queries.length) return [];
  const resultSets = await Promise.all(queries);
  const out = resultSets.flatMap((items) => (Array.isArray(items) ? items : []));
  return uniqueByKey(out, (p) => `${getMerchantId(p)}::${getProductId(p)}`).slice(0, safeLimit * 2);
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

  const seedBrand = String(seedData?.brand || seedData?.snapshot?.brand || '').trim();
  if (!getBrandName(enriched) && seedBrand) {
    if (!String(enriched.brand || '').trim()) enriched.brand = seedBrand;
    if (!String(enriched.vendor || '').trim()) enriched.vendor = seedBrand;
    rescueFields.push('brand');
  }

  const seedCategory = String(
    seedData?.category ||
      seedData?.product?.category ||
      seedData?.snapshot?.category ||
      seedData?.product_type ||
      seedData?.productType ||
      seedData?.snapshot?.product_type ||
      seedData?.snapshot?.productType ||
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

  const seedDescription = String(seedData?.description || seedData?.snapshot?.description || '').trim();
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

  const baseCurrency = currency || normalizeCurrency(rawBaseProduct, 'USD');
  const cacheKey = JSON.stringify({
    version: PDP_RECS_CACHE_VERSION,
    merchant_id: baseMerchantId || null,
    product_id: baseProductId,
    k: safeK,
    locale: String(locale || 'en-US'),
    currency: baseCurrency,
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
  const baseBrand = getBrandName(baseProduct);
  const baseLeaf = getLeafCategory(baseProduct);
  const baseSemanticStrong = Number(baseSemantic?.signal_strength || 0) >= 2;
  const baseProductIsExternal = isExternalProduct(baseProduct);
  const effectiveExternalFetchTimeoutMs = baseProductIsExternal
    ? Math.max(PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS, 2600)
    : PDP_RECS_EXTERNAL_FETCH_TIMEOUT_MS;

  const providedInternal = Array.isArray(options?.internal_candidates) ? options.internal_candidates : null;
  const providedExternal = Array.isArray(options?.external_candidates) ? options.external_candidates : null;

  let internalTimedOut = false;
  let externalTimedOut = false;
  let internalErrorCode = null;
  let externalErrorCode = null;
  const internalCandidatesPromise = withSoftTimeout(
    (providedInternal
      ? Promise.resolve(providedInternal)
      : fetchInternalCandidates({
          merchantId: getMerchantId(baseProduct),
          limit: Math.max(40, safeK * 8),
          excludeMerchantId: getMerchantId(baseProduct),
        })
    ).catch((err) => {
      internalErrorCode = err?.code || 'internal_fetch_failed';
      return [];
    }),
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

  const externalCandidatesPromise = withSoftTimeout(
    (providedExternal
      ? Promise.resolve(providedExternal)
      : fetchExternalCandidates({
          brandHint: baseBrand,
          categoryHint: baseLeaf,
          limit: Math.max(60, safeK * 10),
        })
    ).catch((err) => {
      externalErrorCode = err?.code || 'external_fetch_failed';
      return [];
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

  const [internalCandidates, externalCandidates] = await Promise.all([
    internalCandidatesPromise,
    externalCandidatesPromise,
  ]);
  const internalCount = Array.isArray(internalCandidates) ? internalCandidates.length : 0;

  const picked = pickLayeredRecommendations({
    baseProduct,
    internalCandidates,
    externalCandidates,
    k: safeK,
    baseSemantic,
  });

  const similarSources = {
    internal: {
      attempted: true,
      timed_out: internalTimedOut,
      returned: internalCount,
      skipped: false,
      error_code: internalErrorCode || undefined,
    },
    external: {
      attempted: true,
      timed_out: externalTimedOut,
      returned: Array.isArray(externalCandidates) ? externalCandidates.length : 0,
      skipped: false,
      error_code: externalErrorCode || undefined,
    },
  };
  const internalHealthy = !internalTimedOut && !internalErrorCode;
  const externalHealthy = !externalTimedOut && !externalErrorCode;
  const anyHealthySource = internalHealthy || externalHealthy;
  const anyHardFailure = internalTimedOut || externalTimedOut || Boolean(internalErrorCode) || Boolean(externalErrorCode);
  let similarStatus = 'ready';
  let emptyReason = null;
  if (!picked.items.length) {
    if (anyHealthySource && !anyHardFailure) {
      similarStatus = 'empty';
      emptyReason = 'no_same_brand_candidates';
    } else if (anyHealthySource) {
      similarStatus = 'degraded';
      emptyReason = 'partial_source_failure';
    } else {
      similarStatus = 'unavailable';
      emptyReason = 'all_sources_failed';
    }
  } else if (anyHardFailure) {
    similarStatus = 'degraded';
  }

  const elapsedMs = Date.now() - start;
  const result = {
    strategy: 'related_products',
    status: similarStatus === 'unavailable' ? 'unavailable' : 'success',
    items: picked.items,
    metadata: {
      ...(picked.metadata || {}),
      similar_status: similarStatus,
      similar_sources: similarSources,
      empty_reason: emptyReason,
      low_confidence: Boolean(picked?.metadata?.low_confidence),
    },
    debug: {
      ...picked.debug,
      timing_ms: elapsedMs,
      fetch_strategy: {
        internal_count: internalCount,
        external_count: Array.isArray(externalCandidates) ? externalCandidates.length : 0,
        internal_timed_out: internalTimedOut,
        external_timed_out: externalTimedOut,
        base_semantic_strong: baseSemanticStrong,
        base_product_is_external: baseProductIsExternal,
        internal_error_code: internalErrorCode,
        external_error_code: externalErrorCode,
      },
      base_semantic: baseSemantic || null,
      cache_key_hash: debugEnabled ? stableHashShort(cacheKey) : undefined,
    },
  };

  if (PDP_RECS_CACHE_ENABLED && !bypassCache && shouldCacheRecommendationResult(result)) {
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
      similar_status: similarStatus,
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
    normalizeBrandLookupKey,
    tokenize,
    jaccard,
    getBrandName,
    getLeafCategory,
    getParentCategory,
    isExternalProduct,
    fetchExternalCandidates,
    enrichExternalBaseProduct,
  },
};
