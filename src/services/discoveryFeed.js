const axios = require('axios');
const logger = require('../logger');
const {
  observeDiscoveryCandidateCount,
  observeDiscoveryFeedLatency,
  recordDiscoveryRecallStep,
  recordDiscoveryFeedRequest,
  setLastDiscoverySnapshot,
} = require('../observability/discoveryMetrics');
const {
  _internals: {
    normalizeText,
    tokenize,
    jaccard,
    getBrandName,
    getLeafCategory,
    getParentCategory,
  },
} = require('./RecommendationEngine');
const { classifyBeautyBucketFromText } = require('../findProductsMulti/beautyQueryProfile');

const SCORING_VERSION = 'discovery_v2';
const MAX_RECENT_VIEWS = 50;
const MAX_RECENT_QUERIES = 8;
const MAX_ANCHORS = 5;
const MAX_CANDIDATE_FETCH = 120;
const DEFAULT_DEBUG_TOP_CANDIDATES = 10;
const PRODUCTS_SEARCH_PAGE_SIZE = 60;
const MAX_PRODUCTS_SEARCH_CALLS = 2;
const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';
const VALID_SURFACES = new Set(['home_hot_deals', 'browse_products']);
const VALID_AUTH_STATES = new Set(['authenticated', 'anonymous']);
const HOME_INTEREST_RECALL_LIMIT = 24;
const HOME_BROWSE_FILL_LIMIT = 24;
const HOME_MIN_BROWSE_FILL_LIMIT = 16;
const BROWSE_PRIMARY_RECALL_LIMIT = 24;
const BROWSE_FILL_RECALL_LIMIT = 24;
const COLD_START_DEFERRED_DOMAINS = new Set(['pet', 'sleepwear', 'apparel']);
const DOMAIN_KEYWORDS = {
  beauty: [
    'beauty',
    'skincare',
    'makeup',
    'serum',
    'toner',
    'cream',
    'cleanser',
    'moisturizer',
    'moisturiser',
    'lotion',
    'essence',
    'ampoule',
    'sunscreen',
    'spf',
    'retinol',
    'hyaluronic',
    'salicylic',
    'peptide',
    'vitamin c',
    'lip oil',
    'lip balm',
    'lipstick',
    'gloss',
  ],
  pet: ['pet', 'dog', 'cat', 'leash', 'harness', 'collar', 'pet toy', 'litter'],
  sleepwear: ['sleepwear', 'nightwear', 'nightgown', 'pajama', 'pyjama', 'robe', 'loungewear'],
  apparel: [
    'apparel',
    'clothing',
    'dress',
    'shirt',
    'blouse',
    'pants',
    'jeans',
    'sweater',
    'hoodie',
    'jacket',
    'coat',
    'vest',
    'skirt',
    'legging',
    'bra',
    'underwear',
    'shoe',
    'sneaker',
    'bag',
    'tote',
  ],
};
const WEAK_CATEGORY_LABELS = new Set(['', 'all', 'catalog', 'external', 'misc', 'other', 'product', 'products', 'unknown']);
const browsePoolCache = new Map();

class DiscoveryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoveryValidationError';
    this.statusCode = 400;
    this.code = 'INVALID_DISCOVERY_REQUEST';
  }
}

class DiscoveryCatalogUnavailableError extends Error {
  constructor(message = 'Discovery catalog is unavailable') {
    super(message);
    this.name = 'DiscoveryCatalogUnavailableError';
    this.statusCode = 503;
    this.code = 'DISCOVERY_CATALOG_UNAVAILABLE';
  }
}

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function uniqStrings(values, limit) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function normalizeAuthState(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return VALID_AUTH_STATES.has(value) ? value : 'anonymous';
}

function parseViewedAt(raw) {
  if (!raw) return null;
  const ts = Date.parse(String(raw));
  return Number.isFinite(ts) ? ts : null;
}

function roundMetric(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function getDiscoveryProductsSearchBaseUrl() {
  return normalizeBaseUrl(process.env.PIVOTA_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE);
}

function getDiscoveryProductsSearchTimeoutMs() {
  return clampInt(process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS, 6500, 1000, 20000);
}

function getDiscoveryRecallBudgetMs() {
  return clampInt(process.env.DISCOVERY_RECALL_BUDGET_MS, 1800, 500, 10000);
}

function getDiscoveryPoolCacheTtlMs() {
  return clampInt(process.env.DISCOVERY_POOL_CACHE_TTL_MS, 45000, 1000, 300000);
}

function buildProductKey(merchantId, productId) {
  const mid = String(merchantId || '').trim();
  const pid = String(productId || '').trim();
  return mid && pid ? `${mid}::${pid}` : '';
}

function normalizeCacheText(value) {
  return normalizeText(value || '').slice(0, 120);
}

function getTopMapKeys(map, limit = 5) {
  return Array.from(map instanceof Map ? map.entries() : [])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
}

function isWeakCategoryLabel(value) {
  return WEAK_CATEGORY_LABELS.has(normalizeText(value || ''));
}

function scoreDomainHints(text, weight = 1) {
  const normalized = normalizeText(text || '');
  if (!normalized) return new Map();
  const scores = new Map();
  Object.entries(DOMAIN_KEYWORDS).forEach(([domain, keywords]) => {
    let score = 0;
    for (const keyword of keywords) {
      if (normalized.includes(normalizeText(keyword))) score += 1;
    }
    if (score > 0) {
      scores.set(domain, roundMetric(score * weight));
    }
  });
  return scores;
}

function mergeDomainScores(target, source) {
  if (!(target instanceof Map) || !(source instanceof Map)) return target;
  for (const [domain, score] of source.entries()) {
    target.set(domain, roundMetric((target.get(domain) || 0) + Number(score || 0)));
  }
  return target;
}

function normalizeBeautyBucket(value) {
  const bucket = String(value || '').trim().toLowerCase();
  return bucket || null;
}

function scoreBeautyBucketHints(text, weight = 1) {
  const bucket = normalizeBeautyBucket(classifyBeautyBucketFromText(text));
  if (!bucket || bucket === 'general' || bucket === 'other') return new Map();
  return new Map([[bucket, roundMetric(weight)]]);
}

function mergeBeautyBucketScores(target, source) {
  if (!(target instanceof Map) || !(source instanceof Map)) return target;
  for (const [bucket, score] of source.entries()) {
    target.set(bucket, roundMetric((target.get(bucket) || 0) + Number(score || 0)));
  }
  return target;
}

function inferDominantDomain(domainScores) {
  const entries = Array.from(domainScores instanceof Map ? domainScores.entries() : []).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return { domain: null, score: 0 };
  const [topDomain, topScore] = entries[0];
  const runnerUp = Number(entries[1]?.[1] || 0);
  if (!(topScore >= 2)) return { domain: null, score: topScore };
  if (topScore < runnerUp * 1.2 && topScore - runnerUp < 1) {
    return { domain: null, score: topScore };
  }
  return { domain: topDomain, score: topScore };
}

function inferPreferredBeautyBucket(beautyBucketScores) {
  const entries = Array.from(beautyBucketScores instanceof Map ? beautyBucketScores.entries() : []).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return { bucket: null, score: 0 };
  const [topBucket, topScore] = entries[0];
  const runnerUp = Number(entries[1]?.[1] || 0);
  if (!(topScore >= 1.5)) return { bucket: null, score: topScore };
  if (topScore < runnerUp * 1.15 && topScore - runnerUp < 0.75) {
    return { bucket: null, score: topScore };
  }
  return { bucket: topBucket, score: topScore };
}

function inferBeautyCategory(text) {
  const normalized = normalizeText(text || '');
  if (!normalized) return null;
  if (normalized.includes('serum') || normalized.includes('ampoule') || normalized.includes('essence')) {
    return 'serum';
  }
  if (normalized.includes('toner')) return 'toner';
  if (normalized.includes('cleanser')) return 'cleanser';
  if (normalized.includes('sunscreen') || normalized.includes('spf')) return 'sunscreen';
  if (normalized.includes('lip')) return 'lip';
  if (
    normalized.includes('cream') ||
    normalized.includes('moisturizer') ||
    normalized.includes('moisturiser') ||
    normalized.includes('lotion')
  ) {
    return 'moisturizer';
  }
  return 'beauty';
}

function inferPetCategory(text) {
  const normalized = normalizeText(text || '');
  if (!normalized) return null;
  if (normalized.includes('leash')) return 'leash';
  if (normalized.includes('harness')) return 'harness';
  if (normalized.includes('collar')) return 'collar';
  return 'pet';
}

function inferApparelCategory(text) {
  const normalized = normalizeText(text || '');
  if (!normalized) return null;
  if (DOMAIN_KEYWORDS.sleepwear.some((keyword) => normalized.includes(normalizeText(keyword)))) {
    return 'sleepwear';
  }
  if (normalized.includes('sweater')) return 'sweater';
  if (normalized.includes('dress')) return 'dress';
  if (normalized.includes('jacket') || normalized.includes('coat') || normalized.includes('vest')) {
    return 'outerwear';
  }
  return 'apparel';
}

function inferExplicitDomainFromLabels(values = []) {
  const normalized = normalizeText((Array.isArray(values) ? values : [values]).filter(Boolean).join(' '));
  if (!normalized) return null;
  if (DOMAIN_KEYWORDS.sleepwear.some((keyword) => normalized.includes(normalizeText(keyword)))) {
    return 'sleepwear';
  }
  if (DOMAIN_KEYWORDS.pet.some((keyword) => normalized.includes(normalizeText(keyword)))) {
    return 'pet';
  }
  if (DOMAIN_KEYWORDS.beauty.some((keyword) => normalized.includes(normalizeText(keyword)))) {
    return 'beauty';
  }
  if (DOMAIN_KEYWORDS.apparel.some((keyword) => normalized.includes(normalizeText(keyword)))) {
    return 'apparel';
  }
  return null;
}

function inferCandidateTaxonomy({ merchantId, title, description, rawCategory, rawProductType }) {
  const signalText = [rawProductType, rawCategory, title, description].filter(Boolean).join(' ');
  const domainScores = scoreDomainHints(signalText, 1);
  const { domain } = inferDominantDomain(domainScores);
  const explicitDomain = inferExplicitDomainFromLabels([rawProductType, rawCategory]);
  const resolvedDomain = domain || explicitDomain;
  const normalizedCategory = normalizeText(rawProductType || rawCategory || '');
  const normalizedParent = normalizeText(rawCategory || '');
  const needsInference =
    merchantId === EXTERNAL_SEED_MERCHANT_ID ||
    isWeakCategoryLabel(normalizedCategory) ||
    isWeakCategoryLabel(normalizedParent);

  let category = !isWeakCategoryLabel(normalizedCategory) ? normalizedCategory : '';
  let parentCategory = !isWeakCategoryLabel(normalizedParent) ? normalizedParent : '';

  if (needsInference) {
    if (resolvedDomain === 'beauty') {
      category = inferBeautyCategory(signalText) || category;
      parentCategory = 'skincare';
    } else if (resolvedDomain === 'pet') {
      category = inferPetCategory(signalText) || category;
      parentCategory = 'pet';
    } else if (resolvedDomain === 'sleepwear') {
      category = 'sleepwear';
      parentCategory = 'apparel';
    } else if (resolvedDomain === 'apparel') {
      category = inferApparelCategory(signalText) || category;
      parentCategory = 'apparel';
    }
  }

  if (!parentCategory && category) {
    if (resolvedDomain === 'beauty') parentCategory = 'skincare';
    if (resolvedDomain === 'pet') parentCategory = 'pet';
    if (resolvedDomain === 'sleepwear' || resolvedDomain === 'apparel') parentCategory = 'apparel';
  }

  return {
    category: category || '',
    parentCategory: parentCategory || '',
    domain: resolvedDomain || 'unknown',
  };
}

function normalizeRecentView(raw, idx) {
  if (!raw || typeof raw !== 'object') return null;
  const merchantId = String(raw.merchant_id || raw.merchantId || '').trim();
  const productId = String(raw.product_id || raw.productId || raw.id || '').trim();
  const title = String(raw.title || raw.name || '').trim();
  const description = String(raw.description || '').trim();
  const brand = String(raw.brand || raw.vendor || '').trim();
  const category = String(raw.category || '').trim();
  const productType = String(raw.product_type || raw.productType || '').trim();
  const source = String(raw.history_source || raw.source || '').trim().toLowerCase();
  const viewedAtMs = parseViewedAt(raw.viewed_at || raw.viewedAt);
  if (!productId && !title && !brand && !category && !productType) return null;
  return {
    merchant_id: merchantId || null,
    product_id: productId || null,
    title,
    description,
    brand,
    category,
    product_type: productType,
    viewed_at: viewedAtMs != null ? new Date(viewedAtMs).toISOString() : null,
    viewed_at_ms: viewedAtMs,
    history_source: source || null,
    original_index: idx,
  };
}

function normalizeDiscoveryDebug(raw) {
  if (raw === true) {
    return {
      enabled: true,
      top_candidates: DEFAULT_DEBUG_TOP_CANDIDATES,
    };
  }
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: false,
      top_candidates: DEFAULT_DEBUG_TOP_CANDIDATES,
    };
  }
  return {
    enabled: raw.enabled !== false,
    top_candidates: clampInt(
      raw.top_candidates ?? raw.topCandidates ?? raw.limit,
      DEFAULT_DEBUG_TOP_CANDIDATES,
      1,
      25,
    ),
  };
}

function normalizeDiscoveryRequest(input = {}) {
  const source = input && typeof input.discovery === 'object' ? { ...input.discovery, ...input } : input;
  const surface = String(source.surface || '').trim();
  if (!VALID_SURFACES.has(surface)) {
    throw new DiscoveryValidationError('surface must be home_hot_deals or browse_products');
  }
  const page = clampInt(source.page, 1, 1, 1000);
  const limit = clampInt(source.limit, 20, 1, 100);
  const context = source.context && typeof source.context === 'object' ? source.context : {};

  const recentViewsRaw = Array.isArray(context.recent_views) ? context.recent_views : [];
  const sortedRecentViews = recentViewsRaw
    .map((view, idx) => normalizeRecentView(view, idx))
    .filter(Boolean)
    .sort((a, b) => {
      const aTs = a.viewed_at_ms;
      const bTs = b.viewed_at_ms;
      if (aTs != null && bTs != null && aTs !== bTs) return bTs - aTs;
      if (aTs != null && bTs == null) return -1;
      if (aTs == null && bTs != null) return 1;
      return a.original_index - b.original_index;
    });

  const dedupedRecentViews = [];
  const seenKeys = new Set();
  for (const view of sortedRecentViews) {
    const key = buildProductKey(view.merchant_id, view.product_id);
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    dedupedRecentViews.push(view);
    if (dedupedRecentViews.length >= MAX_RECENT_VIEWS) break;
  }

  const recentQueries = uniqStrings(context.recent_queries, MAX_RECENT_QUERIES);
  const authState = normalizeAuthState(context.auth_state);
  const locale = String(context.locale || 'en-US').trim() || 'en-US';
  const debug = normalizeDiscoveryDebug(source.debug);

  return {
    surface,
    page,
    limit,
    context: {
      recent_views: dedupedRecentViews,
      recent_queries: recentQueries,
      auth_state: authState,
      locale,
    },
    debug,
  };
}

function buildAnchorFeatures(view) {
  const brand = normalizeText(view.brand || '');
  const category = normalizeText(view.product_type || view.category || '');
  const parentCategory = normalizeText(view.category || '');
  const tokens = tokenize(
    [
      view.title,
      view.description,
      view.brand,
      view.category,
      view.product_type,
    ]
      .filter(Boolean)
      .join(' '),
  );
  return {
    key: buildProductKey(view.merchant_id, view.product_id),
    merchant_id: view.merchant_id,
    product_id: view.product_id,
    brand,
    category,
    parent_category: parentCategory,
    tokens,
  };
}

function mapScore(map, key) {
  if (!map.size || !key) return 0;
  const max = Math.max(...map.values());
  if (!(max > 0)) return 0;
  return (map.get(key) || 0) / max;
}

function inferPersonalizationSource(recentViews, authState) {
  if (!Array.isArray(recentViews) || recentViews.length === 0) return 'none';
  const sources = new Set(
    recentViews
      .map((view) => String(view.history_source || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (sources.has('account') && (sources.has('session') || sources.has('local'))) {
    return 'merged';
  }
  if (sources.has('session') || sources.has('local')) return 'session_history';
  if (sources.has('account')) return 'account_history';
  return authState === 'authenticated' ? 'account_history' : 'session_history';
}

function buildDiscoveryQueryTerms(values, maxTerms = 4) {
  const terms = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim().replace(/\s+/g, ' ');
    const key = normalizeText(normalized);
    if (!normalized || !key || seen.has(key)) continue;
    seen.add(key);
    terms.push(normalized);
    if (terms.length >= maxTerms) break;
  }
  return terms;
}

function buildDiscoveryBucketLabel(bucket) {
  const normalized = normalizeBeautyBucket(bucket);
  if (!normalized) return null;
  if (normalized === 'skincare') return 'skincare';
  if (normalized === 'tools') return 'beauty tools';
  if (normalized === 'fragrance') return 'fragrance';
  return normalized.replace(/_/g, ' ');
}

function buildDiscoveryProfile(context = {}) {
  const recentViews = Array.isArray(context.recent_views) ? context.recent_views : [];
  const recentQueries = uniqStrings(context.recent_queries, MAX_RECENT_QUERIES);
  const brandAffinity = new Map();
  const categoryAffinity = new Map();
  const queryTokens = new Set();
  const domainScores = new Map();
  const beautyBucketScores = new Map();

  recentQueries.forEach((queryText) => {
    tokenize(queryText).forEach((token) => queryTokens.add(token));
    mergeDomainScores(domainScores, scoreDomainHints(queryText, 1.5));
    mergeBeautyBucketScores(beautyBucketScores, scoreBeautyBucketHints(queryText, 1.5));
  });

  recentViews.forEach((view, idx) => {
    const weight = Math.exp(-idx / 8);
    const brandKey = normalizeText(view.brand || '');
    const categoryKeys = uniqStrings(
      [view.product_type, view.category].map((value) => normalizeText(value)),
      2,
    );
    if (brandKey) brandAffinity.set(brandKey, (brandAffinity.get(brandKey) || 0) + weight);
    categoryKeys.forEach((key) => {
      if (!key) return;
      categoryAffinity.set(key, (categoryAffinity.get(key) || 0) + weight);
    });
    const signalText = [view.title, view.description, view.brand, view.category, view.product_type]
      .filter(Boolean)
      .join(' ');
    mergeDomainScores(domainScores, scoreDomainHints(signalText, weight));
    mergeBeautyBucketScores(beautyBucketScores, scoreBeautyBucketHints(signalText, weight));
  });

  const anchors = [];
  const usedBrands = new Set();
  const usedCategories = new Set();
  for (const view of recentViews) {
    const anchor = buildAnchorFeatures(view);
    if (!anchor.product_id && !anchor.tokens.length) continue;
    const brandConflict = anchor.brand && usedBrands.has(anchor.brand);
    const categoryConflict = anchor.category && usedCategories.has(anchor.category);
    if (anchors.length > 0 && brandConflict && categoryConflict) continue;
    anchors.push(anchor);
    if (anchor.brand) usedBrands.add(anchor.brand);
    if (anchor.category) usedCategories.add(anchor.category);
    if (anchors.length >= MAX_ANCHORS) break;
  }

  const historyItemsUsed = recentViews.length;
  const personalizationSource = inferPersonalizationSource(recentViews, context.auth_state);
  const hasInterestSignals =
    historyItemsUsed > 0 && (brandAffinity.size > 0 || categoryAffinity.size > 0 || anchors.length > 0);
  const dominantDomain = inferDominantDomain(domainScores);
  const preferredBeautyBucket = inferPreferredBeautyBucket(beautyBucketScores);

  return {
    brandAffinity,
    categoryAffinity,
    beautyBucketScores,
    domainScores,
    dominantDomain: dominantDomain.domain || (preferredBeautyBucket.bucket ? 'beauty' : null),
    dominantDomainScore: dominantDomain.score,
    preferredBeautyBucket: preferredBeautyBucket.bucket,
    preferredBeautyBucketScore: preferredBeautyBucket.score,
    anchors,
    historyItemsUsed,
    personalizationSource,
    queryTokens,
    hasInterestSignals,
  };
}

function isCandidateSellable(product) {
  if (!product || typeof product !== 'object') return false;
  const status = String(product.status || 'active').trim().toLowerCase();
  if (status && status !== 'active') return false;
  if (product.in_stock === false) return false;
  const inventoryQuantity =
    product.inventory_quantity ??
    product.inventoryQuantity ??
    product.available_quantity ??
    product.availableQuantity;
  if (inventoryQuantity != null) {
    const quantity = Number(inventoryQuantity);
    if (Number.isFinite(quantity) && quantity <= 0) return false;
  }
  return true;
}

function normalizeCandidateProduct(product, browseRank = 0) {
  if (!product || typeof product !== 'object') return null;
  const merchantId = String(product.merchant_id || product.merchantId || '').trim();
  const productId = String(product.product_id || product.productId || product.id || '').trim();
  if (!merchantId || !productId) return null;
  if (!isCandidateSellable(product)) return null;
  const brand = getBrandName(product);
  const title = String(product.title || product.name || '').trim();
  const description = String(product.description || '').trim();
  const rawCategory = String(product.category || '').trim();
  const rawProductType = String(product.product_type || product.productType || '').trim();
  const inferredTaxonomy = inferCandidateTaxonomy({
    merchantId,
    title,
    description,
    rawCategory: getParentCategory(product) || rawCategory,
    rawProductType: getLeafCategory(product) || rawProductType,
  });
  const beautyBucket = normalizeBeautyBucket(
    classifyBeautyBucketFromText(
      [title, description, brand, rawCategory, rawProductType, inferredTaxonomy.category, inferredTaxonomy.parentCategory]
        .filter(Boolean)
        .join(' '),
    ),
  );
  const category = inferredTaxonomy.category || normalizeText(rawProductType || rawCategory || '');
  const parentCategory = inferredTaxonomy.parentCategory || normalizeText(rawCategory || '');
  const tokens = tokenize([title, description, brand, category, parentCategory].filter(Boolean).join(' '));
  const normalizedDomain =
    inferredTaxonomy.domain && inferredTaxonomy.domain !== 'unknown'
      ? inferredTaxonomy.domain
      : beautyBucket && beautyBucket !== 'other'
        ? 'beauty'
        : 'unknown';
  return {
    raw: {
      ...product,
      id: product.id || productId,
      product_id: product.product_id || productId,
      merchant_id: product.merchant_id || merchantId,
      ...(product.product_type || product.productType || !product.category
        ? {}
        : { product_type: product.category }),
    },
    key: buildProductKey(merchantId, productId),
    merchantId,
    productId,
    brand,
    category,
    parentCategory,
    domain: normalizedDomain,
    beautyBucket: beautyBucket && beautyBucket !== 'other' ? beautyBucket : null,
    tokens,
    browseRank,
  };
}

function buildDiscoveryInterestQuery(request, profile) {
  const recentQueries = uniqStrings(request?.context?.recent_queries, 2);
  const topCategories = getTopMapKeys(profile?.categoryAffinity, 3).filter((key) => !isWeakCategoryLabel(key));
  const topBrands = getTopMapKeys(profile?.brandAffinity, profile?.dominantDomain === 'beauty' ? 1 : 2);
  const anchorCategories = (Array.isArray(profile?.anchors) ? profile.anchors : [])
    .map((anchor) => anchor.category || anchor.parent_category)
    .filter(Boolean);
  const terms = buildDiscoveryQueryTerms(
    [
      ...recentQueries,
      buildDiscoveryBucketLabel(profile?.preferredBeautyBucket),
      ...topCategories,
      ...anchorCategories,
      ...(profile?.dominantDomain === 'beauty' ? [] : topBrands),
      ...(profile?.dominantDomain === 'beauty' && topCategories.length === 0 ? topBrands : []),
    ],
    4,
  );

  return terms.join(' ').trim();
}

function buildDiscoverySeededBrowseQuery(request, profile) {
  const topCategories = getTopMapKeys(profile?.categoryAffinity, 3).filter((key) => !isWeakCategoryLabel(key));
  const recentQueries = uniqStrings(request?.context?.recent_queries, 1);
  const topBrands = getTopMapKeys(profile?.brandAffinity, 1);
  const terms = buildDiscoveryQueryTerms(
    [
      buildDiscoveryBucketLabel(profile?.preferredBeautyBucket),
      ...topCategories,
      ...(profile?.dominantDomain === 'beauty' ? ['beauty'] : []),
      ...(profile?.dominantDomain === 'beauty' ? [] : recentQueries),
      ...(profile?.dominantDomain === 'beauty' ? [] : topBrands),
    ],
    3,
  );

  return terms.join(' ').trim();
}

function resolveDiscoveryCandidateLimit(request) {
  if (request?.surface === 'browse_products') {
    const pageNeed = request.page * request.limit + Math.max(request.limit, 24);
    return clampInt(pageNeed, 72, 24, MAX_CANDIDATE_FETCH);
  }
  const homeNeed = Math.max(request?.limit * 4, 48);
  return clampInt(homeNeed, 48, 24, MAX_CANDIDATE_FETCH);
}

function buildDiscoveryContextCacheKey(request) {
  return JSON.stringify({
    surface: request?.surface || 'unknown',
    locale: String(request?.context?.locale || '').trim(),
    auth_state: String(request?.context?.auth_state || '').trim(),
    recent_queries: uniqStrings(request?.context?.recent_queries, 6).map(normalizeCacheText),
    recent_views: (Array.isArray(request?.context?.recent_views) ? request.context.recent_views : [])
      .slice(0, 12)
      .map((view) => ({
        merchant_id: String(view?.merchant_id || '').trim(),
        product_id: String(view?.product_id || '').trim(),
        brand: normalizeCacheText(view?.brand),
        category: normalizeCacheText(view?.product_type || view?.category),
      })),
  });
}

function getBrowsePoolCache(request, requiredLimit) {
  const key = buildDiscoveryContextCacheKey(request);
  const entry = browsePoolCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > getDiscoveryPoolCacheTtlMs()) {
    browsePoolCache.delete(key);
    return null;
  }
  const minimumPagePool = Math.max((request?.page || 1) * (request?.limit || 0), request?.limit || 0);
  const minimumRequired = Math.min(requiredLimit, Math.max(minimumPagePool, request?.limit || 0));
  if (!Array.isArray(entry.products) || entry.products.length < minimumRequired) {
    return null;
  }
  return {
    key,
    products: entry.products.slice(0, requiredLimit),
    recallSummary: Array.isArray(entry.recallSummary) ? entry.recallSummary : [],
    storedAt: entry.storedAt,
  };
}

function setBrowsePoolCache(request, products, recallSummary) {
  const key = buildDiscoveryContextCacheKey(request);
  browsePoolCache.set(key, {
    storedAt: Date.now(),
    products: Array.isArray(products) ? [...products] : [],
    recallSummary: Array.isArray(recallSummary) ? [...recallSummary] : [],
  });
  if (browsePoolCache.size > 50) {
    const oldestKey = Array.from(browsePoolCache.entries()).sort((a, b) => a[1].storedAt - b[1].storedAt)[0]?.[0];
    if (oldestKey) browsePoolCache.delete(oldestKey);
  }
}

function buildDiscoveryRecallPlan(request, profile, limit) {
  const safeLimit = clampInt(limit, resolveDiscoveryCandidateLimit(request), 24, MAX_CANDIDATE_FETCH);
  if (request?.surface === 'browse_products') {
    const seededBrowseQuery = buildDiscoverySeededBrowseQuery(request, profile);
    const firstLimit = Math.min(BROWSE_PRIMARY_RECALL_LIMIT, safeLimit);
    const remaining = Math.max(0, safeLimit - firstLimit);
    return [
      {
        label: 'browse_pool',
        query: seededBrowseQuery,
        offset: 0,
        limit: firstLimit,
        allow_early_exit: remaining <= 0,
      },
      ...(remaining > 0
        ? [
            {
              label: 'browse_pool',
              query: '',
              offset: seededBrowseQuery ? 0 : firstLimit,
              limit: Math.min(BROWSE_FILL_RECALL_LIMIT, remaining),
              allow_early_exit: true,
            },
          ]
        : []),
    ];
  }

  const interestQuery = buildDiscoveryInterestQuery(request, profile);
  if (!interestQuery) {
    return [
      {
        label: 'cold_start_curated',
        query: '',
        offset: 0,
        limit: Math.min(PRODUCTS_SEARCH_PAGE_SIZE, safeLimit),
        allow_early_exit: true,
      },
    ];
  }

  const interestLimit = Math.min(HOME_INTEREST_RECALL_LIMIT, safeLimit);
  const remaining = Math.max(0, safeLimit - interestLimit);
  const fillQuery = buildDiscoverySeededBrowseQuery(request, profile);
  return [
    {
      label: 'interest_pool',
      query: interestQuery,
      offset: 0,
      limit: interestLimit,
      allow_early_exit: remaining <= 0,
    },
    ...(remaining > 0
      ? [
          {
            label: 'browse_pool',
            query: fillQuery,
            offset: 0,
            limit: Math.min(Math.max(HOME_MIN_BROWSE_FILL_LIMIT, remaining), HOME_BROWSE_FILL_LIMIT),
            allow_early_exit: true,
          },
        ]
      : []),
  ].slice(0, clampInt(process.env.DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS, MAX_PRODUCTS_SEARCH_CALLS, 1, 4));
}

function getRecallEnoughThreshold(request, safeLimit) {
  if (request?.surface === 'browse_products') {
    return Math.min(safeLimit, request.page * request.limit + Math.max(request.limit, 12));
  }
  return Math.min(safeLimit, Math.max(request.limit * 2, 24));
}

async function fetchDiscoveryRecallStep({
  baseUrl,
  request,
  step,
  requestHeaders,
} = {}) {
  const stepStartedAt = Date.now();
  try {
    const resp = await axios.get(`${baseUrl}/agent/v1/products/search`, {
      params: {
        ...(step?.query ? { query: step.query } : {}),
        in_stock_only: false,
        limit: step?.limit,
        offset: step?.offset,
      },
      headers: requestHeaders,
      timeout: getDiscoveryProductsSearchTimeoutMs(),
      validateStatus: () => true,
    });

    const products = Array.isArray(resp.data?.products)
      ? resp.data.products
      : Array.isArray(resp.data?.results)
        ? resp.data.results
        : [];
    const stepLatencyMs = Date.now() - stepStartedAt;
    const summary = {
      label: step?.label || 'unknown',
      query: step?.query || null,
      offset: Number(step?.offset || 0),
      limit: Number(step?.limit || 0),
      status: Number(resp.status || 0) || null,
      returned: products.length,
      latency_ms: stepLatencyMs,
      cache_hit: false,
    };

    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: step?.label,
      status: resp.status >= 200 && resp.status < 300 ? 'success' : `http_${resp.status}`,
      latencyMs: stepLatencyMs,
      cacheHit: false,
    });

    return {
      success: resp.status >= 200 && resp.status < 300,
      products,
      summary,
    };
  } catch (err) {
    const stepLatencyMs = Date.now() - stepStartedAt;
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: step?.label,
      status: 'error',
      latencyMs: stepLatencyMs,
      cacheHit: false,
    });
    return {
      success: false,
      products: [],
      summary: {
        label: step?.label || 'unknown',
        query: step?.query || null,
        offset: Number(step?.offset || 0),
        limit: Number(step?.limit || 0),
        status: null,
        returned: 0,
        latency_ms: stepLatencyMs,
        cache_hit: false,
        error: err?.message || String(err),
      },
    };
  }
}

async function loadProductsSearchCandidates({ request, profile, limit = MAX_CANDIDATE_FETCH } = {}) {
  const safeLimit = clampInt(limit, resolveDiscoveryCandidateLimit(request), 24, MAX_CANDIDATE_FETCH);
  const baseUrl = getDiscoveryProductsSearchBaseUrl();
  if (!baseUrl) {
    throw new DiscoveryCatalogUnavailableError(
      'PIVOTA_BACKEND_BASE_URL or PIVOTA_API_BASE is not configured for discovery feed',
    );
  }

  if (request?.surface === 'browse_products') {
    const cacheEntry = getBrowsePoolCache(request, safeLimit);
    if (cacheEntry) {
      const cacheAgeMs = Date.now() - cacheEntry.storedAt;
      recordDiscoveryRecallStep({
        surface: request.surface,
        step: 'browse_pool_cache',
        status: 'cache_hit',
        latencyMs: 0,
        cacheHit: true,
      });
      return {
        products: cacheEntry.products,
        recallSummary: [
          {
            label: 'browse_pool_cache',
            query: null,
            offset: 0,
            limit: safeLimit,
            status: 200,
            returned: cacheEntry.products.length,
            latency_ms: 0,
            cache_hit: true,
            cache_age_ms: cacheAgeMs,
          },
          ...cacheEntry.recallSummary.map((step) => ({ ...step, cache_hit: true })),
        ],
      };
    }
  }

  const requestHeaders = {};
  const apiKey = String(process.env.PIVOTA_API_KEY || '').trim();
  if (apiKey) {
    requestHeaders['X-API-Key'] = apiKey;
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }

  const recallPlan = buildDiscoveryRecallPlan(request, profile, safeLimit);
  const mergedProducts = [];
  const seenKeys = new Set();
  const recallSummary = [];
  let successCount = 0;
  const recallStartedAt = Date.now();
  const recallBudgetMs = getDiscoveryRecallBudgetMs();
  const enoughThreshold = getRecallEnoughThreshold(request, safeLimit);
  let truncatedByBudget = false;

  const mergeProducts = (products) => {
    for (const product of Array.isArray(products) ? products : []) {
      const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
      const productId = String(product?.product_id || product?.productId || product?.id || '').trim();
      const key = buildProductKey(merchantId, productId);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      mergedProducts.push(product);
      if (mergedProducts.length >= safeLimit) break;
    }
  };

  if (request?.surface === 'home_hot_deals' && recallPlan.length > 1) {
    const stepResults = await Promise.all(
      recallPlan.map((step) =>
        fetchDiscoveryRecallStep({
          baseUrl,
          request,
          step,
          requestHeaders,
        }),
      ),
    );

    for (const result of stepResults) {
      recallSummary.push(result.summary);
      if (!result.success) continue;
      successCount += 1;
      mergeProducts(result.products);
    }

    if (successCount <= 0) {
      logger.warn(
        {
          base_url: baseUrl,
          surface: request?.surface || 'unknown',
          recall_summary: recallSummary,
        },
        'discovery feed products/search recall failed',
      );
      throw new DiscoveryCatalogUnavailableError('Failed to load discovery candidates from products/search');
    }

    return {
      products: mergedProducts,
      recallSummary,
    };
  }

  for (const step of recallPlan) {
    if (Date.now() - recallStartedAt >= recallBudgetMs) {
      truncatedByBudget = true;
      break;
    }
    const result = await fetchDiscoveryRecallStep({
      baseUrl,
      request,
      step,
      requestHeaders,
    });
    recallSummary.push(result.summary);

    if (!result.success) continue;

    successCount += 1;
    mergeProducts(result.products);
    if (mergedProducts.length >= safeLimit) break;
    if (step.allow_early_exit !== false && mergedProducts.length >= enoughThreshold) break;
    if (Date.now() - recallStartedAt >= recallBudgetMs) {
      truncatedByBudget = true;
      break;
    }
  }

  if (successCount <= 0) {
    logger.warn(
      {
        base_url: baseUrl,
        surface: request?.surface || 'unknown',
        recall_summary: recallSummary,
      },
      'discovery feed products/search recall failed',
    );
    throw new DiscoveryCatalogUnavailableError('Failed to load discovery candidates from products/search');
  }

  if (truncatedByBudget && recallSummary.length > 0) {
    recallSummary[recallSummary.length - 1] = {
      ...recallSummary[recallSummary.length - 1],
      truncated_by_budget: true,
    };
  }

  if (request?.surface === 'browse_products' && mergedProducts.length > 0) {
    setBrowsePoolCache(request, mergedProducts, recallSummary);
  }

  return {
    products: mergedProducts,
    recallSummary,
  };
}

async function loadCatalogCandidates({
  request = null,
  profile = null,
  limit = MAX_CANDIDATE_FETCH,
} = {}) {
  const safeLimit = clampInt(limit, resolveDiscoveryCandidateLimit(request), 24, MAX_CANDIDATE_FETCH);
  return loadProductsSearchCandidates({
    request,
    profile,
    limit: safeLimit,
  });
}

function scoreAnchorSimilarity(candidate, anchors) {
  let best = 0;
  for (const anchor of anchors) {
    const tokenOverlap = jaccard(anchor.tokens || [], candidate.tokens || []);
    const score =
      (anchor.brand && candidate.brand && anchor.brand === candidate.brand ? 0.5 : 0) +
      (anchor.category && candidate.category && anchor.category === candidate.category ? 0.35 : 0) +
      (anchor.parent_category && candidate.parentCategory && anchor.parent_category === candidate.parentCategory ? 0.1 : 0) +
      tokenOverlap * 0.35;
    if (score > best) best = score;
  }
  return Math.min(1, best);
}

function scoreRecentQueryOverlap(candidate, queryTokens) {
  if (!(queryTokens instanceof Set) || queryTokens.size === 0) return 0;
  const candidateTokens = new Set(candidate.tokens || []);
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap / queryTokens.size;
}

function scoreBeautyBucketAlignment(candidate, profile) {
  if (!profile?.preferredBeautyBucket || profile?.dominantDomain !== 'beauty') return 0;
  if (candidate.domain !== 'beauty') return -0.2;
  if (!candidate.beautyBucket) return 0.1;
  if (candidate.beautyBucket === profile.preferredBeautyBucket) return 1;
  return -0.65;
}

function scoreCandidate(candidate, profile, surface) {
  const brandScore = mapScore(profile.brandAffinity, candidate.brand);
  const categoryScore = Math.max(
    mapScore(profile.categoryAffinity, candidate.category),
    mapScore(profile.categoryAffinity, candidate.parentCategory),
  );
  const anchorScore = scoreAnchorSimilarity(candidate, profile.anchors);
  const recentQueryScore = scoreRecentQueryOverlap(candidate, profile.queryTokens);
  const bucketScore = scoreBeautyBucketAlignment(candidate, profile);
  const interestScore =
    brandScore * 0.46 +
    categoryScore * 0.31 +
    anchorScore * 0.18 +
    recentQueryScore * 0.05;
  const browseBase = Math.max(0, 1 - candidate.browseRank / MAX_CANDIDATE_FETCH);
  const domainScore =
    profile?.dominantDomain && candidate.domain
      ? profile.dominantDomain === candidate.domain
        ? 1
        : candidate.domain === 'unknown'
          ? 0.2
          : 0
      : 0;
  const finalScore =
    surface === 'home_hot_deals'
      ? interestScore * 0.84 + browseBase * 0.08 + domainScore * 0.16 + bucketScore * 0.2
      : browseBase * 0.68 + interestScore * 0.34 + domainScore * 0.12 + bucketScore * 0.22;
  return {
    brandScore,
    categoryScore,
    anchorScore,
    recentQueryScore,
    bucketScore,
    interestScore,
    browseBase,
    domainScore,
    finalScore,
  };
}

function getDiscoveryRejectReason(entry, profile, surface) {
  if (!entry || !profile?.dominantDomain) return null;
  const strongBeautySignal =
    entry.scores.categoryScore >= 0.35 ||
    entry.scores.anchorScore >= 0.22 ||
    entry.scores.recentQueryScore >= 0.34 ||
    entry.scores.interestScore >= 0.28;

  if (profile.dominantDomain !== 'beauty') return null;
  if (
    profile.preferredBeautyBucket &&
    entry.candidate.domain === 'beauty' &&
    entry.candidate.beautyBucket &&
    entry.candidate.beautyBucket !== profile.preferredBeautyBucket
  ) {
    if (surface === 'home_hot_deals') return 'filtered_beauty_bucket';
    if (strongBeautySignal || entry.scores.bucketScore <= -0.4) return 'filtered_beauty_bucket';
  }
  if (entry.candidate.domain === 'beauty') return null;

  if (entry.candidate.domain === 'pet' || entry.candidate.domain === 'sleepwear') {
    return 'filtered_dominant_domain';
  }
  if (entry.candidate.domain === 'apparel') {
    return strongBeautySignal ? null : 'filtered_dominant_domain';
  }
  if (entry.candidate.domain === 'unknown') {
    return strongBeautySignal ? null : 'filtered_relevance_floor';
  }
  return strongBeautySignal ? null : 'filtered_relevance_floor';
}

function compareHomeEntries(a, b) {
  if (b.scores.finalScore !== a.scores.finalScore) return b.scores.finalScore - a.scores.finalScore;
  if (b.scores.interestScore !== a.scores.interestScore) return b.scores.interestScore - a.scores.interestScore;
  if (a.candidate.browseRank !== b.candidate.browseRank) return a.candidate.browseRank - b.candidate.browseRank;
  return a.candidate.key.localeCompare(b.candidate.key);
}

function getColdStartHomeDomainPriority(candidate) {
  switch (candidate?.domain) {
    case 'beauty':
      return 4;
    case 'unknown':
      return 3;
    case 'apparel':
      return 1;
    case 'sleepwear':
    case 'pet':
      return 0;
    default:
      return 2;
  }
}

function compareColdStartHomeEntries(a, b) {
  const priorityDiff =
    getColdStartHomeDomainPriority(b?.candidate) - getColdStartHomeDomainPriority(a?.candidate);
  if (priorityDiff !== 0) return priorityDiff;
  return compareHomeEntries(a, b);
}

function compareBrowseEntries(a, b) {
  if (b.scores.finalScore !== a.scores.finalScore) return b.scores.finalScore - a.scores.finalScore;
  if (b.scores.browseBase !== a.scores.browseBase) return b.scores.browseBase - a.scores.browseBase;
  if (a.candidate.browseRank !== b.candidate.browseRank) return a.candidate.browseRank - b.candidate.browseRank;
  return a.candidate.key.localeCompare(b.candidate.key);
}

function selectHomeProducts(scoredCandidates, viewedKeys, limit, options = {}) {
  const collectDebug = options.collectDebug === true;
  const profile = options.profile || null;
  const coldStartCuration = !profile?.hasInterestSignals;
  const ranked = [...scoredCandidates].sort(
    coldStartCuration ? compareColdStartHomeEntries : compareHomeEntries,
  );

  const selected = [];
  const decisions = collectDebug ? new Map() : null;
  const brandCounts = new Map();
  const rankedEligible = [];
  const coldStartDeferred = [];
  for (const entry of ranked) {
    const rejectReason = getDiscoveryRejectReason(entry, profile, 'home_hot_deals');
    if (rejectReason) {
      if (decisions) decisions.set(entry.candidate.key, rejectReason);
      continue;
    }
    if (viewedKeys.has(entry.candidate.key)) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_recent_view');
      continue;
    }
    if (coldStartCuration && COLD_START_DEFERRED_DOMAINS.has(entry.candidate.domain)) {
      coldStartDeferred.push(entry);
      if (decisions) decisions.set(entry.candidate.key, 'filtered_cold_start_domain');
      continue;
    }
    rankedEligible.push(entry);
    if (selected.length >= limit) continue;
    const brandKey = entry.candidate.brand;
    const nextBrandCount = brandKey ? (brandCounts.get(brandKey) || 0) + 1 : 0;
    if (brandKey && nextBrandCount > 2) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_brand_cap');
      continue;
    }
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected');
    if (brandKey) brandCounts.set(brandKey, nextBrandCount);
  }

  for (const entry of rankedEligible) {
    if (selected.length >= limit) break;
    if (selected.some((picked) => picked.candidate.key === entry.candidate.key)) continue;
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected_fill');
  }

  for (const entry of coldStartDeferred) {
    if (selected.length >= limit) break;
    if (selected.some((picked) => picked.candidate.key === entry.candidate.key)) continue;
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected_cold_start_backfill');
  }

  const selectedItems = selected.slice(0, limit);
  if (!collectDebug) return selectedItems;

  for (const entry of rankedEligible) {
    if (!decisions.has(entry.candidate.key)) {
      decisions.set(entry.candidate.key, 'not_selected_limit');
    }
  }

  return {
    ranked,
    selected: selectedItems,
    eligiblePool: rankedEligible,
    decisions,
  };
}

function selectBrowseProducts(scoredCandidates, viewedKeys, page, limit, options = {}) {
  const collectDebug = options.collectDebug === true;
  const profile = options.profile || null;
  const ranked = [...scoredCandidates].sort(compareBrowseEntries);
  const decisions = collectDebug ? new Map() : null;

  const orderedPool = [];
  for (const entry of ranked) {
    const rejectReason = getDiscoveryRejectReason(entry, profile, 'browse_products');
    if (rejectReason) {
      if (decisions) decisions.set(entry.candidate.key, rejectReason);
      continue;
    }
    if (page <= 1 && viewedKeys.has(entry.candidate.key)) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_recent_view');
      continue;
    }
    orderedPool.push(entry);
  }

  const start = (page - 1) * limit;
  const pageItems = orderedPool.slice(start, start + limit);
  if (!collectDebug) {
    return {
      orderedPool,
      pageItems,
    };
  }

  const selectedKeys = new Set(pageItems.map((entry) => entry.candidate.key));
  for (const entry of orderedPool) {
    if (decisions.has(entry.candidate.key)) continue;
    decisions.set(
      entry.candidate.key,
      selectedKeys.has(entry.candidate.key) ? 'selected' : 'page_window_excluded',
    );
  }

  return {
    ranked,
    orderedPool,
    pageItems,
    decisions,
  };
}

function formatDiscoveryResponseProduct(candidate) {
  return {
    ...candidate.raw,
    id: candidate.raw.id || candidate.productId,
    product_id: candidate.raw.product_id || candidate.productId,
    merchant_id: candidate.raw.merchant_id || candidate.merchantId,
    ...(candidate.raw.brand ? {} : candidate.brand ? { brand: candidate.brand } : {}),
    ...(candidate.raw.category ? {} : candidate.category ? { category: candidate.category } : {}),
    ...(candidate.raw.product_type || !candidate.category ? {} : { product_type: candidate.category }),
  };
}

function buildCandidateCounts({
  raw,
  normalized,
  scored,
  eligiblePool,
  returned,
} = {}) {
  return {
    raw: Number(raw || 0),
    normalized: Number(normalized || 0),
    scored: Number(scored || 0),
    eligible_pool: Number(eligiblePool || 0),
    returned: Number(returned || 0),
  };
}

function getCandidateSource(options = {}) {
  if (Array.isArray(options.candidateProducts)) return 'override';
  return 'products_search';
}

function topMapEntries(map, limit = 5) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, score]) => ({
      key,
      score: roundMetric(score),
    }));
}

function buildRankDebug({
  ranked,
  orderedPool,
  decisions,
  profile,
  topCandidates,
  recallSummary,
} = {}) {
  const decisionMap = decisions instanceof Map ? decisions : new Map();
  const poolRanks = new Map(
    Array.isArray(orderedPool)
      ? orderedPool.map((entry, idx) => [entry.candidate.key, idx + 1])
      : [],
  );

  return {
    top_candidates: (Array.isArray(ranked) ? ranked : []).slice(0, topCandidates).map((entry, idx) => ({
      rank: idx + 1,
      pool_rank: poolRanks.get(entry.candidate.key) || null,
      decision: decisionMap.get(entry.candidate.key) || 'not_selected',
      merchant_id: entry.candidate.merchantId,
      product_id: entry.candidate.productId,
      title: entry.candidate.raw.title || '',
      brand: entry.candidate.raw.brand || entry.candidate.brand || null,
      category: entry.candidate.raw.category || entry.candidate.parentCategory || null,
      product_type: entry.candidate.raw.product_type || entry.candidate.category || null,
      domain: entry.candidate.domain || 'unknown',
      beauty_bucket: entry.candidate.beautyBucket || null,
      scores: {
        final_score: roundMetric(entry.scores.finalScore),
        interest_score: roundMetric(entry.scores.interestScore),
        browse_base: roundMetric(entry.scores.browseBase),
        brand_score: roundMetric(entry.scores.brandScore),
        category_score: roundMetric(entry.scores.categoryScore),
        anchor_score: roundMetric(entry.scores.anchorScore),
        recent_query_score: roundMetric(entry.scores.recentQueryScore),
        domain_score: roundMetric(entry.scores.domainScore),
        bucket_score: roundMetric(entry.scores.bucketScore),
      },
    })),
    profile_summary: {
      top_brands: topMapEntries(profile.brandAffinity, 5),
      top_categories: topMapEntries(profile.categoryAffinity, 5),
      dominant_domain: profile.dominantDomain || null,
      dominant_domain_score: roundMetric(profile.dominantDomainScore || 0),
      preferred_beauty_bucket: profile.preferredBeautyBucket || null,
      preferred_beauty_bucket_score: roundMetric(profile.preferredBeautyBucketScore || 0),
      beauty_bucket_scores: topMapEntries(profile.beautyBucketScores || new Map(), 4),
      domain_scores: topMapEntries(profile.domainScores || new Map(), 4),
      anchors: (profile.anchors || []).slice(0, MAX_ANCHORS).map((anchor) => ({
        merchant_id: anchor.merchant_id || null,
        product_id: anchor.product_id || null,
        brand: anchor.brand || null,
        category: anchor.category || anchor.parent_category || null,
      })),
      recent_query_tokens: Array.from(profile.queryTokens || []).sort((a, b) => a.localeCompare(b)),
    },
    recall_summary: (Array.isArray(recallSummary) ? recallSummary : []).map((step) => ({
      label: String(step?.label || '').trim() || 'unknown',
      query: step?.query ? String(step.query) : null,
      offset: Number(step?.offset || 0),
      limit: Number(step?.limit || 0),
      status: step?.status == null ? null : Number(step.status),
      returned: Number(step?.returned || 0),
      latency_ms: Number(step?.latency_ms || 0),
      cache_hit: step?.cache_hit === true,
      ...(step?.cache_age_ms != null ? { cache_age_ms: Number(step.cache_age_ms || 0) } : {}),
      ...(step?.truncated_by_budget ? { truncated_by_budget: true } : {}),
      ...(step?.error ? { error: String(step.error) } : {}),
    })),
  };
}

async function getDiscoveryFeed(payload = {}, options = {}) {
  const startedAt = Date.now();
  let request = null;
  let profile = null;
  let strategy = 'unknown';
  let personalizationSource = 'unknown';
  const candidateSource = getCandidateSource(options);
  let candidateCounts = buildCandidateCounts();
  let recallSummary = [];

  try {
    request = normalizeDiscoveryRequest(payload);
    profile = buildDiscoveryProfile(request.context);
    strategy = profile.hasInterestSignals ? 'personalized_interest' : 'cold_start_curated';
    personalizationSource =
      strategy === 'personalized_interest' ? profile.personalizationSource : 'none';

    const candidateLoadResult = Array.isArray(options.candidateProducts)
      ? {
          products: options.candidateProducts,
          recallSummary: [],
        }
      : await loadCatalogCandidates({
          request,
          profile,
          limit: options.candidateLimit || resolveDiscoveryCandidateLimit(request),
        });
    const rawCandidates = Array.isArray(candidateLoadResult?.products)
      ? candidateLoadResult.products
      : [];
    recallSummary = Array.isArray(candidateLoadResult?.recallSummary)
      ? candidateLoadResult.recallSummary
      : [];
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'raw',
      count: rawCandidates.length,
    });

    const normalizedCandidates = [];
    const seenKeys = new Set();
    for (let idx = 0; idx < rawCandidates.length; idx += 1) {
      const normalized = normalizeCandidateProduct(rawCandidates[idx], idx);
      if (!normalized || seenKeys.has(normalized.key)) continue;
      seenKeys.add(normalized.key);
      normalizedCandidates.push(normalized);
    }
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'normalized',
      count: normalizedCandidates.length,
    });

    const viewedKeys = new Set(
      (request.context.recent_views || [])
        .map((view) => buildProductKey(view.merchant_id, view.product_id))
        .filter(Boolean),
    );

    const scoredCandidates = normalizedCandidates.map((candidate) => ({
      candidate,
      scores: scoreCandidate(candidate, profile, request.surface),
    }));
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'scored',
      count: scoredCandidates.length,
    });

    let selectedEntries;
    let total;
    let eligiblePoolCount = 0;
    let ranked = [];
    let orderedPool = [];
    let decisions = new Map();

    if (request.surface === 'home_hot_deals') {
      const homeSelection = selectHomeProducts(
        scoredCandidates,
        viewedKeys,
        request.limit,
        { collectDebug: request.debug.enabled, profile },
      );
      if (request.debug.enabled) {
        selectedEntries = homeSelection.selected;
        total = homeSelection.eligiblePool.length;
        eligiblePoolCount = homeSelection.eligiblePool.length;
        ranked = homeSelection.ranked;
        orderedPool = homeSelection.eligiblePool;
        decisions = homeSelection.decisions;
      } else {
        selectedEntries = homeSelection;
        total = scoredCandidates.filter((entry) => !viewedKeys.has(entry.candidate.key)).length;
        eligiblePoolCount = total;
      }
    } else {
      const browseSelection = selectBrowseProducts(
        scoredCandidates,
        viewedKeys,
        request.page,
        request.limit,
        { collectDebug: request.debug.enabled, profile },
      );
      selectedEntries = browseSelection.pageItems;
      total = browseSelection.orderedPool.length;
      eligiblePoolCount = browseSelection.orderedPool.length;
      if (request.debug.enabled) {
        ranked = browseSelection.ranked;
        orderedPool = browseSelection.orderedPool;
        decisions = browseSelection.decisions;
      }
    }

    candidateCounts = buildCandidateCounts({
      raw: rawCandidates.length,
      normalized: normalizedCandidates.length,
      scored: scoredCandidates.length,
      eligiblePool: eligiblePoolCount,
      returned: selectedEntries.length,
    });

    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'eligible_pool',
      count: eligiblePoolCount,
    });
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'returned',
      count: selectedEntries.length,
    });

    const latencyMs = Date.now() - startedAt;
    const metadata = {
      discovery_strategy: strategy,
      personalization_source: personalizationSource,
      history_items_used: profile.historyItemsUsed,
      anchor_count: profile.anchors.length,
      scoring_version: SCORING_VERSION,
      surface: request.surface,
      locale: request.context.locale,
      candidate_source: candidateSource,
      candidate_counts: candidateCounts,
      request_latency_ms: latencyMs,
      ...(profile.dominantDomain ? { dominant_domain: profile.dominantDomain } : {}),
    };

    if (request.debug.enabled) {
      metadata.rank_debug = buildRankDebug({
        ranked,
        orderedPool,
        decisions,
        profile,
        topCandidates: request.debug.top_candidates,
        recallSummary,
      });
    }

    const response = {
      status: 'success',
      success: true,
      products: selectedEntries.map((entry) => formatDiscoveryResponseProduct(entry.candidate)),
      total,
      page: request.page,
      page_size: selectedEntries.length,
      metadata,
    };

    recordDiscoveryFeedRequest({
      surface: request.surface,
      status: 'success',
      strategy,
      personalizationSource,
      candidateSource,
      reason: 'none',
    });
    observeDiscoveryFeedLatency({
      surface: request.surface,
      status: 'success',
      latencyMs,
    });
    setLastDiscoverySnapshot({
      surface: request.surface,
      status: 'success',
      strategy,
      personalization_source: personalizationSource,
      candidate_source: candidateSource,
      candidate_counts: candidateCounts,
      history_items_used: profile.historyItemsUsed,
      anchor_count: profile.anchors.length,
      total,
      page: request.page,
      limit: request.limit,
      returned_count: selectedEntries.length,
      latency_ms: latencyMs,
      dominant_domain: profile.dominantDomain || null,
    });
    logger.info(
      {
        surface: request.surface,
        page: request.page,
        limit: request.limit,
        strategy,
        personalization_source: personalizationSource,
        candidate_source: candidateSource,
        candidate_counts: candidateCounts,
        latency_ms: latencyMs,
      },
      'discovery feed built',
    );

    return response;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const status =
      err instanceof DiscoveryValidationError || Number(err?.statusCode) === 400
        ? 'validation_error'
        : err instanceof DiscoveryCatalogUnavailableError || Number(err?.statusCode) === 503
          ? 'catalog_unavailable'
          : 'error';
    const surface =
      request?.surface || String(payload?.surface || payload?.discovery?.surface || '').trim() || 'unknown';

    recordDiscoveryFeedRequest({
      surface,
      status,
      strategy,
      personalizationSource,
      candidateSource,
      reason: err?.code || err?.name || 'unknown_error',
    });
    observeDiscoveryFeedLatency({
      surface,
      status,
      latencyMs,
    });
    setLastDiscoverySnapshot({
      surface,
      status,
      strategy,
      personalization_source: personalizationSource,
      candidate_source: candidateSource,
      candidate_counts: candidateCounts,
      latency_ms: latencyMs,
      dominant_domain: profile?.dominantDomain || null,
      error_code: err?.code || err?.name || 'UNKNOWN_ERROR',
      error_message: err?.message || 'Unknown discovery error',
    });
    throw err;
  }
}

module.exports = {
  DiscoveryCatalogUnavailableError,
  DiscoveryValidationError,
  buildDiscoveryProfile,
  getDiscoveryFeed,
  _internals: {
    buildDiscoveryContextCacheKey,
    buildDiscoveryRecallPlan,
    getDiscoveryPoolCacheTtlMs,
    normalizeDiscoveryRequest,
    normalizeCandidateProduct,
    resolveDiscoveryCandidateLimit,
    scoreCandidate,
    selectBrowseProducts,
    selectHomeProducts,
    buildProductKey,
    resetBrowsePoolCache: () => browsePoolCache.clear(),
  },
};
