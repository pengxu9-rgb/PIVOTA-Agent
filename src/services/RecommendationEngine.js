const crypto = require('node:crypto');

const logger = require('../logger');
const { query } = require('../db');
const {
  inferVerticalFromProduct,
  computeSemanticSignalStrength,
  UNKNOWN_VERTICAL,
} = require('./recoSemanticSignals');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';

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

  if (layerId === 'L4' && candidate.tokenOverlap >= 0.24) return 'medium';
  if (layerId === 'L5' && candidate.tokenOverlap >= 0.28) return 'medium';
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

  const nextFromSource = (source) => {
    const queue = source === 'internal' ? internalQueue : externalQueue;
    while (pointers[source] < queue.length) {
      const candidate = queue[pointers[source]];
      pointers[source] += 1;
      const key = `${candidate.features.merchantId}::${candidate.features.productId}`;
      if (used.has(key)) continue;
      used.add(key);
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
      selected.push(next);
      progress = true;
    }
    if (!progress) break;
  }

  if (selected.length < K) {
    for (const candidate of candidates) {
      if (selected.length >= K) break;
      const key = `${candidate.features.merchantId}::${candidate.features.productId}`;
      if (used.has(key)) continue;
      used.add(key);
      selected.push(candidate);
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
      name: 'fallback_recent_or_popular',
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
      // Exclude the base product even if multiple merchants share the same product_id.
      // (In multi-offer scenarios those belong in offers[], not recommendations.)
      if (pid === base.productId) return null;
      const features = buildCandidateFeatures(p, base.currency);
      const source = features.isExternal ? 'external' : 'internal';
      const scoreDetail = scoreCandidate(base, features);
      const matchedLayer = layers.find((layer) => layer.predicate(scoreDetail)) || layers[layers.length - 1];

      if (base.vertical === 'fragrance') {
        const candidateVertical = features.vertical;
        const allowByVertical = candidateVertical === 'fragrance';
        const allowByToken = scoreDetail.tokenOverlap >= 0.18 && candidateVertical !== 'tools';
        if (!allowByVertical && !allowByToken) {
          filteredByVertical += 1;
          return null;
        }
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
      },
    },
  };
}

async function fetchInternalCandidates({ merchantId, limit, excludeMerchantId }) {
  const mid = String(merchantId || '').trim();
  const safeLimit = Math.min(Math.max(1, Number(limit || 120)), 400);

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

function normalizeSeedAvailability(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'in stock' || v === 'instock' || v === 'in_stock' || v === 'available') return 'in_stock';
  if (v === 'out of stock' || v === 'outofstock' || v === 'out_of_stock' || v === 'oos') return 'out_of_stock';
  return v;
}

function availabilityToInStock(availability) {
  const a = normalizeSeedAvailability(availability);
  if (!a || a === 'in_stock') return true;
  if (a === 'out_of_stock') return false;
  return true;
}

function ensureJsonObject(val) {
  if (!val) return {};
  if (typeof val === 'object') return val;
  if (typeof val !== 'string') return {};
  const trimmed = val.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function stableExternalProductId(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  const hash = crypto.createHash('sha256').update(u).digest('hex').slice(0, 24);
  return `ext_${hash}`;
}

function normalizeSeedImageUrls(seedData, row) {
  const out = [];
  const candidates = [];
  if (seedData && typeof seedData === 'object') {
    if (typeof seedData.image_url === 'string') candidates.push(seedData.image_url);
    if (Array.isArray(seedData.image_urls)) candidates.push(...seedData.image_urls);
    if (Array.isArray(seedData.images)) candidates.push(...seedData.images);
    if (seedData.snapshot && typeof seedData.snapshot === 'object') {
      if (typeof seedData.snapshot.image_url === 'string') candidates.push(seedData.snapshot.image_url);
      if (Array.isArray(seedData.snapshot.images)) candidates.push(...seedData.snapshot.images);
    }
  }
  if (row && typeof row === 'object' && typeof row.image_url === 'string') candidates.push(row.image_url);
  for (const c of candidates) {
    const u = String(c || '').trim();
    if (!u) continue;
    if (!u.startsWith('http://') && !u.startsWith('https://')) continue;
    if (out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

function buildExternalSeedProduct(row) {
  if (!row || typeof row !== 'object') return null;
  const seedData = ensureJsonObject(row.seed_data);
  const destinationUrl = String(row.destination_url || seedData.destination_url || '').trim();
  const canonicalUrl =
    String(row.canonical_url || seedData.canonical_url || seedData.snapshot?.canonical_url || '').trim() || '';
  const externalProductId =
    String(row.external_product_id || seedData.external_product_id || seedData.product_id || '').trim() ||
    stableExternalProductId(canonicalUrl || destinationUrl);
  if (!externalProductId) return null;

  const title =
    seedData.title ||
    row.title ||
    seedData.snapshot?.title ||
    canonicalUrl ||
    destinationUrl ||
    externalProductId;
  const description = String(seedData.description || seedData.snapshot?.description || '').trim();
  const brand = String(seedData.brand || '').trim() || undefined;
  const category = String(seedData.category || seedData.product?.category || '').trim() || undefined;

  const rawAmount = row.price_amount ?? seedData.price_amount ?? seedData.snapshot?.price_amount ?? undefined;
  const price = normalizeAmount(rawAmount);
  const currency = normalizeCurrency({ currency: row.price_currency || seedData.price_currency || seedData.snapshot?.price_currency }, 'USD');

  const availability = normalizeSeedAvailability(row.availability || seedData.availability || seedData.snapshot?.availability);
  const inStock = availabilityToInStock(availability);

  const imageUrls = normalizeSeedImageUrls(seedData, row);
  const imageUrl = imageUrls[0] || undefined;

  const merchantName = String(seedData.merchant_display_name || seedData.brand || row.domain || 'External').trim() || 'External';
  return {
    id: externalProductId,
    product_id: externalProductId,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    merchant_name: merchantName,
    platform: 'external',
    platform_product_id: externalProductId,
    title: String(title || '').trim() || externalProductId,
    description,
    price,
    currency,
    image_url: imageUrl,
    images: imageUrls,
    inventory_quantity: inStock ? 999 : 0,
    in_stock: inStock,
    product_type: category || 'external',
    source: 'external_seed',
    external_seed_id: row.id ? String(row.id) : undefined,
    ...(brand ? { vendor: brand, brand } : {}),
    ...(category ? { category } : {}),
  };
}

async function fetchExternalCandidates({ brandHint, categoryHint, limit }) {
  if (!process.env.DATABASE_URL) return [];
  const safeLimit = Math.min(Math.max(1, Number(limit || 180)), 500);
  const market = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US').trim().toUpperCase() || 'US';
  const tool = 'creator_agents';

  const brand = normalizeText(brandHint);
  const category = normalizeText(categoryHint);

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
            AND attached_product_key IS NULL
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

  const [brandMatches, categoryMatches] = await Promise.all([
    brand
      ? runQuery(
          `AND lower(coalesce(seed_data->>'brand','')) = $4`,
          [brand],
          Math.min(120, safeLimit),
          'external_brand',
        )
      : Promise.resolve([]),
    category
      ? runQuery(
          `AND lower(coalesce(seed_data->>'category','')) = $4`,
          [category],
          Math.min(120, safeLimit),
          'external_category',
        )
      : Promise.resolve([]),
  ]);

  const out = [...brandMatches, ...categoryMatches];
  const enoughFocusedCandidates = out.length >= Math.max(safeLimit, 80);
  if (!enoughFocusedCandidates) {
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

  const seedBrand = String(seedData?.brand || seedData?.snapshot?.brand || '').trim();
  if (!getBrandName(enriched) && seedBrand) {
    if (!String(enriched.brand || '').trim()) enriched.brand = seedBrand;
    if (!String(enriched.vendor || '').trim()) enriched.vendor = seedBrand;
    rescueFields.push('brand');
  }

  const seedCategory = String(
    seedData?.category || seedData?.product?.category || seedData?.snapshot?.category || '',
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
  const internalCandidates = await withSoftTimeout(
    providedInternal
      ? Promise.resolve(providedInternal)
      : fetchInternalCandidates({
          merchantId: getMerchantId(baseProduct),
          limit: Math.max(60, safeK * 10),
          excludeMerchantId: getMerchantId(baseProduct),
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

  const internalCount = Array.isArray(internalCandidates) ? internalCandidates.length : 0;
  const skipExternalMin = Math.max(
    PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_ABS,
    Math.ceil(safeK * PDP_RECS_EXTERNAL_SKIP_INTERNAL_MIN_MULTIPLIER),
  );
  const shouldSkipExternal =
    !providedExternal &&
    internalCount >= skipExternalMin &&
    baseSemanticStrong &&
    !baseProductIsExternal;

  const externalCandidates = shouldSkipExternal
    ? []
      : await withSoftTimeout(
        providedExternal
          ? Promise.resolve(providedExternal)
          : fetchExternalCandidates({
              brandHint: baseBrand,
              categoryHint: baseLeaf,
              limit: Math.max(120, safeK * 15),
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
  });

  const elapsedMs = Date.now() - start;
  const result = {
    items: picked.items,
    metadata: {
      ...(picked.metadata || {}),
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
        external_skipped: shouldSkipExternal,
        external_skip_min_candidates: skipExternalMin,
        base_semantic_strong: baseSemanticStrong,
        base_product_is_external: baseProductIsExternal,
      },
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
  },
};
