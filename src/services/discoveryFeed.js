const axios = require('axios');
const logger = require('../logger');
const { query } = require('../db');
const {
  observeDiscoveryCandidateCount,
  observeDiscoveryFeedLatency,
  recordDiscoveryRecallStep,
  recordDiscoveryFeedRequest,
  setLastDiscoverySnapshot,
} = require('../observability/discoveryMetrics');
const recommendationEngine = require('./RecommendationEngine');
const {
  recommend,
  _internals: {
    normalizeText,
    tokenize,
    jaccard,
    getBrandName,
    getLeafCategory,
    getParentCategory,
  },
} = recommendationEngine;
const {
  EXTERNAL_SEED_MERCHANT_ID,
  buildExternalSeedProduct,
} = require('./externalSeedProducts');
const { classifyBeautyBucketFromText } = require('../findProductsMulti/beautyQueryProfile');
const {
  buildBrandQueryVariants,
  detectBrandEntities,
  normalizeBrandText,
} = require('../findProductsMulti/brandLexicon');

const SCORING_VERSION = 'discovery_v2';
const MAX_RECENT_VIEWS = 50;
const MAX_RECENT_QUERIES = 8;
const MAX_ANCHORS = 5;
const MAX_CANDIDATE_FETCH = 120;
const DEFAULT_DEBUG_TOP_CANDIDATES = 10;
const PRODUCTS_SEARCH_PAGE_SIZE = 60;
const MAX_PRODUCTS_SEARCH_CALLS = 2;
const DISCOVERY_PROVIDER_ORDER = ['products_search', 'internal_catalog', 'external_seeds'];
const VALID_SURFACES = new Set(['home_hot_deals', 'browse_products']);
const VALID_DISCOVERY_RESPONSE_DETAILS = new Set(['full', 'card']);
const VALID_AUTH_STATES = new Set(['authenticated', 'anonymous']);
const VALID_DISCOVERY_SORTS = new Set(['popular', 'price_desc', 'price_asc']);
const HOME_INTEREST_RECALL_LIMIT = 24;
const HOME_BROWSE_FILL_LIMIT = 24;
const HOME_MIN_BROWSE_FILL_LIMIT = 16;
const COLD_START_PRIMARY_RECALL_LIMIT = 24;
const COLD_START_FILL_RECALL_LIMIT = 24;
const BROWSE_PRIMARY_RECALL_LIMIT = 24;
const BROWSE_FILL_RECALL_LIMIT = 24;
const MIN_COLD_START_NON_DEFERRED_RESULTS = 2;
const COLD_START_DEFERRED_DOMAINS = new Set(['pet', 'sleepwear', 'apparel']);
const COLD_START_DEFERRED_BEAUTY_BUCKETS = new Set(['tools']);
const DEFAULT_COLD_START_QUERY_BASKET = [
  'beauty skincare serum',
  'niacinamide serum',
  'vitamin c serum',
  'barrier moisturizer',
  'gentle cleanser sunscreen',
];
const GENERIC_DISCOVERY_QUERY_TOKENS = new Set([
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
  'treatment',
  'products',
  'product',
]);
const DISCOVERY_DESCRIPTOR_STOP_TOKENS = new Set([
  ...GENERIC_DISCOVERY_QUERY_TOKENS,
  'skin',
  'care',
  'daily',
  'routine',
  'recommended',
  'recommendation',
  'best',
]);
const DISCOVERY_BEAUTY_QUERY_FALLBACKS = {
  serum: ['barrier repair serum', 'niacinamide serum', 'vitamin c serum'],
  toner: ['hydrating toner', 'barrier toner', 'gentle toner'],
  moisturizer: ['barrier moisturizer', 'ceramide moisturizer', 'repair cream'],
  cleanser: ['gentle cleanser', 'hydrating cleanser', 'cream cleanser'],
  sunscreen: ['daily sunscreen', 'mineral sunscreen', 'spf 50 sunscreen'],
  lip: ['lip treatment', 'lip balm', 'lip oil'],
  beauty: ['barrier repair skincare', 'niacinamide skincare', 'hydrating skincare'],
};
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
    'lingerie',
    'bra',
    'bralette',
    'underwear',
    'panty',
    'panties',
    'shapewear',
    'bodysuit',
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

function normalizeDiscoverySort(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return VALID_DISCOVERY_SORTS.has(value) ? value : 'popular';
}

function normalizeDiscoveryQuery(raw) {
  if (typeof raw === 'string') {
    return { text: String(raw).trim() };
  }
  if (!raw || typeof raw !== 'object') {
    return { text: '' };
  }
  return {
    text: String(raw.text || raw.query || '').trim(),
  };
}

function normalizeDiscoveryCategories(values, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeText(value || '');
    if (!normalized || isWeakCategoryLabel(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (limit && out.length >= limit) break;
  }
  return out;
}

function normalizeDiscoveryScope(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const brandNames = uniqStrings(
    [
      ...(Array.isArray(source.brand_names) ? source.brand_names : []),
      ...(Array.isArray(source.brandNames) ? source.brandNames : []),
      source.brand_name,
      source.brandName,
    ],
    4,
  );
  const categories = normalizeDiscoveryCategories(
    [
      ...(Array.isArray(source.categories) ? source.categories : []),
      ...(Array.isArray(source.category_names) ? source.category_names : []),
      ...(Array.isArray(source.product_types) ? source.product_types : []),
      source.category,
      source.category_name,
      source.product_type,
      source.productType,
    ],
    12,
  );
  return {
    brand_names: brandNames,
    categories,
  };
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
  return normalizeBaseUrl(
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL ||
      process.env.PIVOTA_BACKEND_BASE_URL ||
      process.env.PIVOTA_API_BASE,
  );
}

function getDiscoveryProductsSearchApiKey() {
  return String(
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY ||
      process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
      process.env.PIVOTA_API_KEY ||
      process.env.SHOP_GATEWAY_AGENT_API_KEY ||
      process.env.PIVOTA_AGENT_API_KEY ||
      process.env.AGENT_API_KEY ||
      '',
  ).trim();
}

function getDiscoveryProductsSearchTimeoutMs() {
  return clampInt(process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS, 6500, 1000, 20000);
}

function getDiscoveryRecallBudgetMs() {
  return clampInt(process.env.DISCOVERY_RECALL_BUDGET_MS, 1800, 500, 10000);
}

function getDiscoveryColdStartQuery() {
  const configured = String(process.env.DISCOVERY_COLD_START_QUERY || '').trim();
  return configured || 'beauty skincare serum';
}

function getDiscoveryColdStartQueries() {
  const configured = String(process.env.DISCOVERY_COLD_START_QUERY_BASKET || '')
    .split(/[|\n]+/)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const queries = uniqStrings(configured.length > 0 ? configured : DEFAULT_COLD_START_QUERY_BASKET, 8);
  return queries.length > 0 ? queries : [getDiscoveryColdStartQuery()];
}

function getDiscoveryPoolCacheTtlMs() {
  return clampInt(process.env.DISCOVERY_POOL_CACHE_TTL_MS, 45000, 1000, 300000);
}

function buildProductKey(merchantId, productId) {
  const mid = String(merchantId || '').trim();
  const pid = String(productId || '').trim();
  return mid && pid ? `${mid}::${pid}` : '';
}

function normalizeProductUrlForDedupe(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function buildExternalSemanticProductKey(product) {
  const canonicalUrl = normalizeProductUrlForDedupe(
    product?.canonical_url || product?.url || product?.destination_url,
  );
  if (canonicalUrl) return `external_url::${canonicalUrl}`;

  const brand = normalizeBrandText(
    product?.brand ||
      product?.brand_name ||
      product?.vendor ||
      product?.vendor_name ||
      product?.manufacturer ||
      '',
  );
  const title = normalizeText(product?.title || product?.name || '');
  if (brand && title) return `external_title::${brand}::${title}`;
  if (title) return `external_title::${title}`;
  return '';
}

function buildDiscoverySemanticProductKey(product) {
  const canonicalUrl = normalizeProductUrlForDedupe(
    product?.canonical_url || product?.url || product?.destination_url,
  );
  if (canonicalUrl) return `semantic_url::${canonicalUrl}`;

  const brand = normalizeBrandText(
    product?.brand ||
      product?.brand_name ||
      product?.vendor ||
      product?.vendor_name ||
      product?.manufacturer ||
      '',
  );
  const title = normalizeText(product?.title || product?.name || '');
  const category = normalizeText(
    product?.product_type || product?.productType || product?.category || product?.parent_category || '',
  );
  if (brand && title) return `semantic_brand_title::${brand}::${title}`;
  if (title && category) return `semantic_title_category::${title}::${category}`;
  if (title) return `semantic_title::${title}`;
  return '';
}

function buildDiscoveryDedupKey(product, { brandScoped = false } = {}) {
  const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
  const productId = String(product?.product_id || product?.productId || product?.id || '').trim();
  const baseKey = buildProductKey(merchantId, productId);
  if (!brandScoped || merchantId !== EXTERNAL_SEED_MERCHANT_ID) return baseKey;
  return buildExternalSemanticProductKey(product) || baseKey;
}

function normalizeCacheText(value) {
  return normalizeText(value || '').slice(0, 120);
}

function tokenizeDiscoverySearchText(value) {
  return uniqStrings(
    tokenize(String(value || ''))
      .map((token) => String(token || '').trim().toLowerCase())
      .filter((token) => token.length >= 3),
    24,
  );
}

function buildDiscoverySearchPhraseSet(values = [], limit = 6) {
  return uniqStrings(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value || '').trim().replace(/\s+/g, ' '))
      .filter(Boolean),
    limit,
  );
}

function buildDiscoverySearchTerms(values = []) {
  const phrases = buildDiscoverySearchPhraseSet(values, 8);
  const tokens = uniqStrings(
    phrases.flatMap((phrase) => tokenizeDiscoverySearchText(phrase)),
    24,
  );
  return {
    phrases,
    tokens,
  };
}

function buildDiscoveryDatabaseSearchTerms(values = [], options = {}) {
  const maxPhrases = clampInt(options.maxPhrases, 4, 1, 8);
  const maxTokens = clampInt(options.maxTokens, 24, 4, 24);
  const phrases = buildDiscoverySearchPhraseSet(values, 8);
  const specificPhrases = phrases.filter((phrase) => isSpecificDiscoveryQueryText(phrase));
  const effectivePhrases = uniqStrings(
    (specificPhrases.length > 0 ? specificPhrases : phrases).slice(0, maxPhrases),
    maxPhrases,
  );
  const tokens = uniqStrings(
    effectivePhrases
      .flatMap((phrase) => tokenizeDiscoverySearchText(phrase))
      .filter((token) => !GENERIC_DISCOVERY_QUERY_TOKENS.has(token)),
    maxTokens,
  );
  return {
    phrases: effectivePhrases,
    tokens,
  };
}

function compactBrandToken(value) {
  return normalizeBrandText(value).replace(/\s+/g, '');
}

function buildBrandScopeAliases(brandNames = []) {
  const aliases = new Set();
  for (const rawBrand of Array.isArray(brandNames) ? brandNames : []) {
    const brandName = String(rawBrand || '').trim();
    if (!brandName) continue;
    const detected = detectBrandEntities(brandName, { candidateProducts: [] });
    const variants = buildBrandQueryVariants(
      brandName,
      Array.isArray(detected?.brands) && detected.brands.length ? detected.brands : [brandName],
    );
    variants.forEach((variant) => {
      const normalized = normalizeBrandText(variant);
      if (normalized) aliases.add(normalized);
    });
  }
  return Array.from(aliases);
}

function resolveBrandDirectCandidateLimit(request, limit) {
  const safeLimit = clampInt(limit, resolveDiscoveryCandidateLimit(request), 24, MAX_CANDIDATE_FETCH);
  const pageNeed = Math.max(
    request?.page * request?.limit + request?.limit * 3,
    safeLimit * 3,
    120,
  );
  return clampInt(pageNeed, 120, 48, 360);
}

function getBrandDirectPrefetchDelayMs() {
  return clampInt(process.env.DISCOVERY_BRAND_DIRECT_PREFETCH_DELAY_MS, 75, 0, 1000);
}

function buildCandidateBrandAliases(candidate) {
  const aliases = new Set();
  const directSignals = [
    candidate?.brand,
    candidate?.raw?.brand,
    candidate?.raw?.brand_name,
    candidate?.raw?.vendor,
    candidate?.raw?.vendor_name,
    candidate?.raw?.manufacturer,
  ];

  directSignals.forEach((value) => {
    const normalized = normalizeBrandText(value);
    if (normalized) aliases.add(normalized);
  });

  const detectionText = [
    candidate?.raw?.title,
    candidate?.raw?.name,
    candidate?.raw?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (detectionText) {
    const detected = detectBrandEntities(detectionText, { candidateProducts: [] });
    const detectedBrands = Array.isArray(detected?.brands) ? detected.brands : [];
    detectedBrands.forEach((brandName) => {
      buildBrandQueryVariants(brandName, [brandName]).forEach((variant) => {
        const normalized = normalizeBrandText(variant);
        if (normalized) aliases.add(normalized);
      });
    });
  }

  return Array.from(aliases);
}

function matchesNormalizedBrandAlias(candidateBrand, normalizedAlias) {
  if (!candidateBrand || !normalizedAlias) return false;
  if (
    candidateBrand === normalizedAlias ||
    candidateBrand.startsWith(`${normalizedAlias} `) ||
    candidateBrand.endsWith(` ${normalizedAlias}`) ||
    normalizedAlias.startsWith(`${candidateBrand} `) ||
    normalizedAlias.endsWith(` ${candidateBrand}`)
  ) {
    return true;
  }

  const candidateCompact = compactBrandToken(candidateBrand);
  const aliasCompact = compactBrandToken(normalizedAlias);
  if (!candidateCompact || !aliasCompact) return false;
  if (candidateCompact === aliasCompact) return true;
  if (candidateCompact.startsWith(aliasCompact)) return true;
  if (aliasCompact.startsWith(candidateCompact) && candidateCompact.length >= 8) return true;
  return false;
}

function matchesBrandScopeCandidate(candidate, aliases = []) {
  if (!Array.isArray(aliases) || aliases.length === 0) return true;
  const candidateAliases = buildCandidateBrandAliases(candidate);
  if (candidateAliases.length === 0) return false;
  return aliases.some((alias) => {
    const normalizedAlias = normalizeBrandText(alias);
    if (!normalizedAlias) return false;
    return candidateAliases.some((candidateBrand) =>
      matchesNormalizedBrandAlias(candidateBrand, normalizedAlias),
    );
  });
}

function parseCandidatePriceAmount(rawPrice) {
  const amount =
    rawPrice?.amount ??
    rawPrice?.current?.amount ??
    rawPrice?.price ??
    rawPrice;
  const numeric = Number(amount);
  return Number.isFinite(numeric) ? numeric : null;
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
  if (/\b(lingerie|underwear|bralette|panty|panties|shapewear|bodysuit)\b/.test(normalized)) {
    return 'lingerie';
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

function normalizeDiscoveryResponseDetail(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_DISCOVERY_RESPONSE_DETAILS.has(normalized)) return normalized;
  return 'full';
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
  const responseDetail = normalizeDiscoveryResponseDetail(
    source.response_detail ?? source.responseDetail ?? source.detail_level ?? source.detailLevel,
  );
  const scope = normalizeDiscoveryScope(source.scope);
  const query = normalizeDiscoveryQuery(source.query ?? source.query_text ?? source.queryText);
  const sort = normalizeDiscoverySort(source.sort);
  const sourceProductRef =
    source.source_product_ref && typeof source.source_product_ref === 'object'
      ? {
          product_id: String(source.source_product_ref.product_id || source.source_product_ref.id || '').trim() || null,
          merchant_id: String(source.source_product_ref.merchant_id || '').trim() || null,
        }
      : {
          product_id: null,
          merchant_id: null,
        };

  return {
    surface,
    page,
    limit,
    sort,
    scope,
    query,
    context: {
      recent_views: dedupedRecentViews,
      recent_queries: recentQueries,
      auth_state: authState,
      locale,
    },
    source_product_ref: sourceProductRef,
    debug,
    response_detail: responseDetail,
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

function pickFirstNonEmptyString(values = []) {
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function isSpecificDiscoveryQueryText(value) {
  const tokens = tokenize(String(value || ''));
  if (!tokens.length) return false;
  return tokens.some((token) => !GENERIC_DISCOVERY_QUERY_TOKENS.has(String(token || '').trim().toLowerCase()));
}

function buildDiscoveryBucketLabel(bucket) {
  const normalized = normalizeBeautyBucket(bucket);
  if (!normalized) return null;
  if (normalized === 'skincare') return 'skincare';
  if (normalized === 'tools') return 'beauty tools';
  if (normalized === 'fragrance') return 'fragrance';
  return normalized.replace(/_/g, ' ');
}

function buildBeautyDiscoveryDescriptorTokens(request, profile, maxTokens = 4) {
  const topBrands = new Set(
    buildDiscoveryQueryTerms(
      [
        ...getTopMapKeys(profile?.brandAffinity, 2),
        ...(Array.isArray(profile?.anchors) ? profile.anchors.map((anchor) => anchor.brand) : []),
      ],
      6,
    ).flatMap((value) => tokenizeDiscoverySearchText(value)),
  );
  const orderedTokens = [];
  const seen = new Set();
  const pushTokens = (values = []) => {
    for (const value of Array.isArray(values) ? values : []) {
      for (const token of tokenizeDiscoverySearchText(value)) {
        if (
          !token ||
          DISCOVERY_DESCRIPTOR_STOP_TOKENS.has(token) ||
          topBrands.has(token) ||
          seen.has(token)
        ) {
          continue;
        }
        seen.add(token);
        orderedTokens.push(token);
        if (orderedTokens.length >= maxTokens) return;
      }
    }
  };

  const recentQueries = uniqStrings(request?.context?.recent_queries, 3);
  pushTokens(recentQueries.filter((queryText) => isSpecificDiscoveryQueryText(queryText)));
  pushTokens(
    (Array.isArray(profile?.anchors) ? profile.anchors : []).map((anchor) =>
      [anchor?.category, anchor?.parent_category].filter(Boolean).join(' '),
    ),
  );
  pushTokens(
    (Array.isArray(profile?.anchors) ? profile.anchors : []).map((anchor) =>
      Array.isArray(anchor?.tokens) ? anchor.tokens.join(' ') : '',
    ),
  );
  return orderedTokens.slice(0, maxTokens);
}

function getPreferredBeautyDiscoveryCategory(profile) {
  const candidates = [
    ...(Array.isArray(profile?.anchors)
      ? profile.anchors.flatMap((anchor) => [anchor.category, anchor.parent_category])
      : []),
    ...getTopMapKeys(profile?.categoryAffinity, 4),
  ]
    .map((value) => normalizeText(value || ''))
    .filter((value) => value && !isWeakCategoryLabel(value));

  const prioritized = candidates.find((value) => value !== 'skincare');
  return prioritized || candidates[0] || 'beauty';
}

function buildBeautyPersonalizedQueries(request, profile) {
  const preferredCategory = getPreferredBeautyDiscoveryCategory(profile);
  const topBrand = getTopMapKeys(profile?.brandAffinity, 1)[0] || '';
  const recentQueries = uniqStrings(request?.context?.recent_queries, 2);
  const specificRecentQuery = recentQueries.find((queryText) => isSpecificDiscoveryQueryText(queryText)) || '';
  const descriptorTokens = buildBeautyDiscoveryDescriptorTokens(request, profile, 4);
  const descriptorPhrase = buildDiscoveryQueryTerms(
    [...descriptorTokens.slice(0, 2), preferredCategory],
    3,
  ).join(' ');
  const brandPhrase = buildDiscoveryQueryTerms([topBrand, preferredCategory], 2).join(' ');
  const fallbackQueries = buildDiscoverySearchPhraseSet(
    DISCOVERY_BEAUTY_QUERY_FALLBACKS[preferredCategory] || DISCOVERY_BEAUTY_QUERY_FALLBACKS.beauty,
    3,
  );

  const primary = pickFirstNonEmptyString([
    specificRecentQuery,
    descriptorPhrase,
    brandPhrase,
    fallbackQueries[0],
  ]);
  const expansion = pickFirstNonEmptyString([
    fallbackQueries.find((queryText) => queryText !== primary),
    descriptorPhrase !== primary ? descriptorPhrase : '',
    brandPhrase !== primary ? brandPhrase : '',
  ]);
  const browse = pickFirstNonEmptyString([
    descriptorPhrase,
    brandPhrase,
    fallbackQueries.find((queryText) => queryText !== primary && queryText !== expansion),
    fallbackQueries[1],
    fallbackQueries[0],
  ]);

  return {
    primary,
    expansion,
    browse,
    providerQueries: buildDiscoverySearchPhraseSet(
      [primary, expansion, browse, brandPhrase, ...fallbackQueries],
      5,
    ),
    preferredCategory,
    descriptorTokens,
  };
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
  const priceAmount = parseCandidatePriceAmount(product.price);
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
    provider: String(product.__discovery_provider || '').trim() || 'unknown',
    brand,
    category,
    parentCategory,
    domain: normalizedDomain,
    beautyBucket: beautyBucket && beautyBucket !== 'other' ? beautyBucket : null,
    tokens,
    priceAmount,
    browseRank,
  };
}

function buildDiscoveryBrandScopedQuery(request) {
  const brandNames = Array.isArray(request?.scope?.brand_names) ? request.scope.brand_names : [];
  const primaryBrand = brandNames[0] || '';
  const queryText = String(request?.query?.text || '').trim();
  return buildDiscoveryQueryTerms([primaryBrand, queryText], 2).join(' ').trim();
}

function buildDiscoveryInterestQuery(request, profile) {
  if (profile?.dominantDomain === 'beauty') {
    return buildBeautyPersonalizedQueries(request, profile).primary;
  }
  const recentQueries = uniqStrings(request?.context?.recent_queries, 2);
  const specificRecentQueries = recentQueries.filter((queryText) => isSpecificDiscoveryQueryText(queryText));
  const genericRecentQueries = recentQueries.filter((queryText) => !isSpecificDiscoveryQueryText(queryText));
  const topCategories = getTopMapKeys(profile?.categoryAffinity, 3).filter((key) => !isWeakCategoryLabel(key));
  const topBrands = getTopMapKeys(profile?.brandAffinity, 2);
  const anchorCategories = (Array.isArray(profile?.anchors) ? profile.anchors : [])
    .map((anchor) => anchor.category || anchor.parent_category)
    .filter((key) => !isWeakCategoryLabel(key))
    .slice(0, 2);
  const bucketLabel = buildDiscoveryBucketLabel(profile?.preferredBeautyBucket);
  const terms = buildDiscoveryQueryTerms(
    profile?.dominantDomain === 'beauty'
      ? [
          specificRecentQueries[0],
          bucketLabel,
          topCategories[0],
          anchorCategories[0],
          genericRecentQueries[0],
          topBrands[0],
        ]
      : [
          recentQueries[0],
          topCategories[0],
          anchorCategories[0],
          topBrands[0],
          bucketLabel,
        ],
    3,
  );

  if (terms.length < 2 && profile?.dominantDomain === 'beauty') {
    return buildDiscoveryQueryTerms([bucketLabel, topCategories[0], 'skincare'], 3).join(' ').trim();
  }
  return terms.join(' ').trim();
}

function buildDiscoveryExpansionQuery(request, profile) {
  if (profile?.dominantDomain === 'beauty') {
    return buildBeautyPersonalizedQueries(request, profile).expansion;
  }
  const topCategories = getTopMapKeys(profile?.categoryAffinity, 3).filter((key) => !isWeakCategoryLabel(key));
  const anchorCategories = (Array.isArray(profile?.anchors) ? profile.anchors : [])
    .map((anchor) => anchor.category || anchor.parent_category)
    .filter(Boolean);
  const recentQueries = uniqStrings(request?.context?.recent_queries, 2);
  const bucketLabel = buildDiscoveryBucketLabel(profile?.preferredBeautyBucket);
  const topBrands = getTopMapKeys(profile?.brandAffinity, 1);
  const terms = buildDiscoveryQueryTerms(
    profile?.dominantDomain === 'beauty'
      ? [
          bucketLabel,
          topCategories[0],
          anchorCategories[0],
          'beauty skincare',
          recentQueries[0],
        ]
      : [
          topCategories[0],
          anchorCategories[0],
          recentQueries[0],
          topBrands[0],
          bucketLabel,
        ],
    3,
  );

  return terms.join(' ').trim();
}

function buildDiscoverySeededBrowseQuery(request, profile) {
  if (profile?.dominantDomain === 'beauty') {
    return buildBeautyPersonalizedQueries(request, profile).browse;
  }
  const recentQueries = uniqStrings(request?.context?.recent_queries, 2);
  const topCategories = getTopMapKeys(profile?.categoryAffinity, 3).filter((key) => !isWeakCategoryLabel(key));
  const bucketLabel = buildDiscoveryBucketLabel(profile?.preferredBeautyBucket);
  const topBrands = getTopMapKeys(profile?.brandAffinity, 1);
  const terms = buildDiscoveryQueryTerms(
    profile?.dominantDomain === 'beauty'
      ? [
          bucketLabel,
          topCategories[0],
          'beauty skincare',
          recentQueries[0],
          topBrands[0],
        ]
      : [
          topCategories[0],
          recentQueries[0],
          topBrands[0],
          bucketLabel,
        ],
    3,
  );

  return terms.join(' ').trim();
}

function buildDiscoveryProviderQueries(request, profile) {
  const brandQuery = buildDiscoveryBrandScopedQuery(request);
  if (Array.isArray(request?.scope?.brand_names) && request.scope.brand_names.length > 0) {
    return buildDiscoverySearchPhraseSet([brandQuery], 2);
  }

  if (!profile?.hasInterestSignals) {
    return getDiscoveryColdStartQueries();
  }

  if (profile?.dominantDomain === 'beauty') {
    return buildBeautyPersonalizedQueries(request, profile).providerQueries;
  }

  if (request?.surface === 'browse_products') {
    return buildDiscoverySearchPhraseSet(
      [
        buildDiscoverySeededBrowseQuery(request, profile),
        buildDiscoveryExpansionQuery(request, profile),
        buildDiscoveryInterestQuery(request, profile),
      ],
      4,
    );
  }

  return buildDiscoverySearchPhraseSet(
    [
      buildDiscoveryInterestQuery(request, profile),
      buildDiscoveryExpansionQuery(request, profile),
      buildDiscoverySeededBrowseQuery(request, profile),
    ],
    4,
  );
}

function prioritizeDiscoveryRecallQueries(queries = []) {
  const normalized = buildDiscoverySearchPhraseSet(queries, 8);
  const specific = normalized.filter((queryText) => isSpecificDiscoveryQueryText(queryText));
  const broad = normalized.filter((queryText) => !isSpecificDiscoveryQueryText(queryText));
  return [...specific, ...broad];
}

function resolveDiscoveryCandidateLimit(request) {
  if (request?.surface === 'browse_products') {
    const pageNeed = request.page * request.limit + Math.max(request.limit, 24);
    if (hasBrandScope(request)) {
      return clampInt(Math.max(pageNeed, 48), 72, 48, MAX_CANDIDATE_FETCH);
    }
    return clampInt(pageNeed, 72, 24, MAX_CANDIDATE_FETCH);
  }
  const homeNeed = Math.max(request?.limit * 4, 48);
  return clampInt(homeNeed, 48, 24, MAX_CANDIDATE_FETCH);
}

function buildDiscoveryContextCacheKey(request) {
  return JSON.stringify({
    surface: request?.surface || 'unknown',
    sort: request?.sort || 'popular',
    locale: String(request?.context?.locale || '').trim(),
    auth_state: String(request?.context?.auth_state || '').trim(),
    scope: {
      brand_names: uniqStrings(request?.scope?.brand_names, 4).map((value) => normalizeCacheText(value)),
    },
    query: {
      text: normalizeCacheText(request?.query?.text),
    },
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
  const hasBrandScope = Array.isArray(request?.scope?.brand_names) && request.scope.brand_names.length > 0;
  if (hasBrandScope) {
    const brandQuery = buildDiscoveryBrandScopedQuery(request);
    const firstLimit = Math.min(PRODUCTS_SEARCH_PAGE_SIZE, safeLimit);
    const remaining = Math.max(0, safeLimit - firstLimit);
    return [
      {
        label: 'brand_pool',
        query: brandQuery,
        offset: 0,
        limit: firstLimit,
        allow_early_exit: remaining <= 0,
      },
      ...(remaining > 0
        ? [
            {
              label: 'brand_pool',
              query: brandQuery,
              offset: firstLimit,
              limit: Math.min(PRODUCTS_SEARCH_PAGE_SIZE, remaining),
              allow_early_exit: true,
            },
          ]
        : []),
    ];
  }
  const providerQueries = buildDiscoveryProviderQueries(request, profile);
  if (request?.surface === 'browse_products') {
    const seededBrowseQuery = providerQueries[0] || buildDiscoverySeededBrowseQuery(request, profile);
    const expansionQuery = providerQueries[1] || buildDiscoveryExpansionQuery(request, profile);
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
              label: 'expansion_pool',
              query: expansionQuery,
              offset: 0,
              limit: Math.min(BROWSE_FILL_RECALL_LIMIT, remaining),
              allow_early_exit: true,
            },
          ]
        : []),
    ];
  }

  if (!profile?.hasInterestSignals) {
    const coldStartQueries = prioritizeDiscoveryRecallQueries(providerQueries).slice(0, 2);
    const firstLimit = Math.min(COLD_START_PRIMARY_RECALL_LIMIT, safeLimit);
    const remaining = Math.max(0, safeLimit - firstLimit);
    return [
      {
        label: 'cold_start_curated',
        query: coldStartQueries[0] || getDiscoveryColdStartQuery(),
        offset: 0,
        limit: firstLimit,
        allow_early_exit: remaining <= 0,
      },
      ...(remaining > 0 && coldStartQueries[1]
        ? [
            {
              label: 'cold_start_fill',
              query: coldStartQueries[1],
              offset: 0,
              limit: Math.min(COLD_START_FILL_RECALL_LIMIT, remaining),
              allow_early_exit: true,
            },
          ]
        : []),
    ].slice(0, clampInt(process.env.DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS, MAX_PRODUCTS_SEARCH_CALLS, 1, 4));
  }

  const interestQuery = providerQueries[0] || buildDiscoveryInterestQuery(request, profile);
  const fillQuery = providerQueries[1] || buildDiscoveryExpansionQuery(request, profile);
  const interestLimit = Math.min(HOME_INTEREST_RECALL_LIMIT, safeLimit);
  const remaining = Math.max(0, safeLimit - interestLimit);
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
            label: 'expansion_pool',
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

function hasBrandScope(request) {
  return Array.isArray(request?.scope?.brand_names) && request.scope.brand_names.length > 0;
}

function shouldSkipBrandScopedProviderExpansion(products = [], { request, profile, enoughThreshold, qualityThreshold } = {}) {
  if (request?.surface !== 'browse_products' || !hasBrandScope(request)) return false;
  return hasSufficientProviderCandidates(products, { request, profile, enoughThreshold, qualityThreshold });
}

function shouldUseBrandDirectPoolInsteadOfGenericBrandExpansion(request) {
  return request?.surface === 'browse_products' && hasBrandScope(request);
}

function shouldSkipBrandDirectPool(scopedCandidates = [], { request, limit } = {}) {
  if (request?.surface !== 'browse_products' || !hasBrandScope(request)) return false;
  const safeLimit = clampInt(limit, resolveDiscoveryCandidateLimit(request), 24, MAX_CANDIDATE_FETCH);
  const enoughThreshold = getRecallEnoughThreshold(request, safeLimit);
  return Array.isArray(scopedCandidates) && scopedCandidates.length >= enoughThreshold;
}

async function fetchDiscoveryRecallStep({
  baseUrl,
  request,
  step,
  requestHeaders,
  provider = 'products_search',
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
      provider,
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
        provider,
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
  const provider = 'products_search';
  if (!baseUrl) {
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'products_search_pool',
          query: null,
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: 0,
          error:
            'DISCOVERY_PRODUCTS_SEARCH_BASE_URL, PIVOTA_BACKEND_BASE_URL, or PIVOTA_API_BASE is not configured for discovery feed',
        }),
      ],
    };
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
  const apiKey = getDiscoveryProductsSearchApiKey();
  if (apiKey) {
    requestHeaders['X-Agent-API-Key'] = apiKey;
    requestHeaders['X-API-Key'] = apiKey;
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }

  const recallPlan = buildDiscoveryRecallPlan(request, profile, safeLimit);
  const mergedProducts = [];
  const seenKeys = new Set();
  const brandScoped = Array.isArray(request?.scope?.brand_names) && request.scope.brand_names.length > 0;
  const recallSummary = [];
  let successCount = 0;
  const recallStartedAt = Date.now();
  const recallBudgetMs = getDiscoveryRecallBudgetMs();
  const enoughThreshold = getRecallEnoughThreshold(request, safeLimit);
  let truncatedByBudget = false;

  const mergeProducts = (products) => {
    for (const product of Array.isArray(products) ? products : []) {
      const key = buildDiscoveryDedupKey(product, { brandScoped });
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

function buildDiscoveryProviderStepSummary({
  provider,
  label,
  query,
  limit,
  returned,
  status,
  latencyMs,
  error,
  skipped,
  skipReason,
} = {}) {
  return {
    provider,
    label,
    query,
    offset: 0,
    limit: Number(limit || 0),
    status: status == null ? null : Number(status),
    returned: Number(returned || 0),
    latency_ms: Number(latencyMs || 0),
    cache_hit: false,
    ...(skipped ? { skipped: true } : {}),
    ...(skipReason ? { skip_reason: skipReason } : {}),
    ...(error ? { error: String(error) } : {}),
  };
}

function annotateProviderProducts(provider, products = []) {
  return (Array.isArray(products) ? products : []).map((product) => ({
    ...product,
    __discovery_provider: provider,
  }));
}

function buildDiscoveryProviderMergeKey(product) {
  if (!product || typeof product !== 'object') return '';
  return (
    buildDiscoverySemanticProductKey(product) ||
    buildProductKey(
      product?.merchant_id || product?.merchantId,
      product?.product_id || product?.productId || product?.id,
    )
  );
}

function buildSkippedProviderResult(provider, { label, query, limit, skipReason } = {}) {
  return {
    provider,
    products: [],
    recallSummary: [
      buildDiscoveryProviderStepSummary({
        provider,
        label,
        query,
        limit,
        returned: 0,
        status: null,
        latencyMs: 0,
        skipped: true,
        skipReason,
      }),
    ],
  };
}

async function fetchInternalCatalogCandidates({
  request,
  profile,
  queries = [],
  limit = MAX_CANDIDATE_FETCH,
  fetchFn = null,
} = {}) {
  const provider = 'internal_catalog';
  const stepStartedAt = Date.now();
  const safeLimit = clampInt(limit, Math.max(limit, 24), 12, 240);
  const searchTerms = buildDiscoveryDatabaseSearchTerms(queries, { maxPhrases: 4 });
  const phrases = searchTerms.phrases;

  if (typeof fetchFn === 'function') {
    try {
      const products = annotateProviderProducts(
        provider,
        await fetchFn({ request, profile, queries: phrases, limit: safeLimit }),
      );
      recordDiscoveryRecallStep({
        surface: request?.surface,
        step: 'internal_catalog_pool',
        status: 'success',
        latencyMs: Date.now() - stepStartedAt,
        cacheHit: false,
      });
      return {
        products,
        recallSummary: [
          buildDiscoveryProviderStepSummary({
            provider,
            label: 'internal_catalog_pool',
            query: phrases.join(' | '),
            limit: safeLimit,
            returned: products.length,
            status: 200,
            latencyMs: Date.now() - stepStartedAt,
          }),
        ],
      };
    } catch (err) {
      recordDiscoveryRecallStep({
        surface: request?.surface,
        step: 'internal_catalog_pool',
        status: 'error',
        latencyMs: Date.now() - stepStartedAt,
        cacheHit: false,
      });
      return {
        products: [],
        recallSummary: [
          buildDiscoveryProviderStepSummary({
            provider,
            label: 'internal_catalog_pool',
            query: phrases.join(' | '),
            limit: safeLimit,
            returned: 0,
            status: null,
            latencyMs: Date.now() - stepStartedAt,
            error: err?.message || String(err),
          }),
        ],
      };
    }
  }

  if (!process.env.DATABASE_URL) {
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'internal_catalog_pool',
      status: 'skipped',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'internal_catalog_pool',
          query: phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          skipped: true,
          skipReason: 'missing_database',
        }),
      ],
    };
  }

  try {
    const res = await query(
      `
        WITH source AS (
          SELECT
            id,
            merchant_id,
            product_data,
            cached_at,
            lower(
              concat_ws(
                ' ',
                coalesce(product_data->>'title', ''),
                coalesce(product_data->>'name', ''),
                coalesce(product_data->>'description', ''),
                coalesce(product_data->>'brand', ''),
                coalesce(product_data->>'brand_name', ''),
                coalesce(product_data->>'vendor', ''),
                coalesce(product_data->>'vendor_name', ''),
                coalesce(product_data->>'manufacturer', ''),
                coalesce(product_data->>'category', ''),
                coalesce(product_data->>'product_type', '')
              )
            ) AS search_text
          FROM products_cache
          WHERE (expires_at IS NULL OR expires_at > now())
            AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
            AND merchant_id <> $1
        )
        SELECT merchant_id, product_data
        FROM (
          SELECT
            merchant_id,
            product_data,
            cached_at,
            id,
            (
              (SELECT count(*)::int FROM unnest($2::text[]) phrase WHERE phrase <> '' AND search_text LIKE '%' || phrase || '%') * 6
              +
              (SELECT count(*)::int FROM unnest($3::text[]) token WHERE token <> '' AND search_text LIKE '%' || token || '%')
            ) AS match_score
          FROM source
        ) ranked
        WHERE ($4::boolean = false OR match_score > 0)
        ORDER BY match_score DESC, cached_at DESC NULLS LAST, id DESC
        LIMIT $5
      `,
      [
        EXTERNAL_SEED_MERCHANT_ID,
        searchTerms.phrases,
        searchTerms.tokens,
        searchTerms.phrases.length > 0 || searchTerms.tokens.length > 0,
        safeLimit,
      ],
    );
    const products = annotateProviderProducts(
      provider,
      (res.rows || [])
        .map((row) =>
          row?.product_data && row?.merchant_id
            ? {
                ...row.product_data,
                merchant_id: String(row.merchant_id).trim(),
              }
            : null,
        )
        .filter(Boolean),
    );
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'internal_catalog_pool',
      status: 'success',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products,
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'internal_catalog_pool',
          query: phrases.join(' | '),
          limit: safeLimit,
          returned: products.length,
          status: 200,
          latencyMs: Date.now() - stepStartedAt,
        }),
      ],
    };
  } catch (err) {
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'internal_catalog_pool',
      status: 'error',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'internal_catalog_pool',
          query: phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          error: err?.message || String(err),
        }),
      ],
    };
  }
}

async function fetchExternalSeedCandidates({
  request,
  profile,
  queries = [],
  limit = MAX_CANDIDATE_FETCH,
  fetchFn = null,
} = {}) {
  const provider = 'external_seeds';
  const stepStartedAt = Date.now();
  const safeLimit = clampInt(limit, Math.max(limit, 24), 12, 240);
  const effectiveQueries = buildExternalSeedProviderQueries(request, profile, queries);
  const searchTerms = buildDiscoveryDatabaseSearchTerms(effectiveQueries, {
    maxPhrases: request?.surface === 'home_hot_deals' ? 2 : 3,
    maxTokens: profile?.dominantDomain === 'beauty' ? 10 : 12,
  });
  const phrases = searchTerms.phrases;
  const market =
    String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US')
      .trim()
      .toUpperCase() || 'US';
  const tool = 'creator_agents';

  if (typeof fetchFn === 'function') {
    try {
      const products = annotateProviderProducts(
        provider,
        await fetchFn({ request, profile, queries: phrases, limit: safeLimit }),
      );
      recordDiscoveryRecallStep({
        surface: request?.surface,
        step: 'external_seed_pool',
        status: 'success',
        latencyMs: Date.now() - stepStartedAt,
        cacheHit: false,
      });
      return {
        products,
        recallSummary: [
          buildDiscoveryProviderStepSummary({
            provider,
            label: 'external_seed_pool',
            query: phrases.join(' | '),
            limit: safeLimit,
            returned: products.length,
            status: 200,
            latencyMs: Date.now() - stepStartedAt,
          }),
        ],
      };
    } catch (err) {
      recordDiscoveryRecallStep({
        surface: request?.surface,
        step: 'external_seed_pool',
        status: 'error',
        latencyMs: Date.now() - stepStartedAt,
        cacheHit: false,
      });
      return {
        products: [],
        recallSummary: [
          buildDiscoveryProviderStepSummary({
            provider,
            label: 'external_seed_pool',
            query: phrases.join(' | '),
            limit: safeLimit,
            returned: 0,
            status: null,
            latencyMs: Date.now() - stepStartedAt,
            error: err?.message || String(err),
          }),
        ],
      };
    }
  }

  if (!process.env.DATABASE_URL) {
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'external_seed_pool',
      status: 'skipped',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'external_seed_pool',
          query: phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          skipped: true,
          skipReason: 'missing_database',
        }),
      ],
    };
  }

  try {
    const res = await query(
      `
        WITH source AS (
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
            created_at,
            lower(
              concat_ws(
                ' ',
                coalesce(seed_data->>'title', ''),
                coalesce(seed_data->'snapshot'->>'title', ''),
                coalesce(title, ''),
                coalesce(seed_data->>'description', ''),
                coalesce(seed_data->'snapshot'->>'description', ''),
                coalesce(seed_data->>'brand', ''),
                coalesce(seed_data->>'brand_name', ''),
                coalesce(seed_data->>'vendor', ''),
                coalesce(seed_data->>'vendor_name', ''),
                coalesce(seed_data->'snapshot'->>'brand', ''),
                coalesce(seed_data->'snapshot'->>'brand_name', ''),
                coalesce(seed_data->'snapshot'->>'vendor', ''),
                coalesce(seed_data->'snapshot'->>'vendor_name', ''),
                coalesce(seed_data->>'category', ''),
                coalesce(seed_data->>'product_type', ''),
                coalesce(seed_data->'snapshot'->>'category', ''),
                coalesce(seed_data->'snapshot'->>'product_type', '')
              )
            ) AS search_text
          FROM external_product_seeds
          WHERE status = 'active'
            AND market = $1
            AND (tool = '*' OR tool = $2)
        )
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
        FROM (
          SELECT
            *,
            (
              (SELECT count(*)::int FROM unnest($3::text[]) phrase WHERE phrase <> '' AND search_text LIKE '%' || phrase || '%') * 6
              +
              (SELECT count(*)::int FROM unnest($4::text[]) token WHERE token <> '' AND search_text LIKE '%' || token || '%')
            ) AS match_score
          FROM source
        ) ranked
        WHERE ($5::boolean = false OR match_score > 0)
        ORDER BY match_score DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        LIMIT $6
      `,
      [
        market,
        tool,
        searchTerms.phrases,
        searchTerms.tokens,
        searchTerms.phrases.length > 0 || searchTerms.tokens.length > 0,
        safeLimit,
      ],
    );
    const products = annotateProviderProducts(
      provider,
      (res.rows || [])
        .map((row) => buildExternalSeedProduct(row))
        .filter(Boolean),
    );
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'external_seed_pool',
      status: 'success',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products,
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'external_seed_pool',
          query: phrases.join(' | '),
          limit: safeLimit,
          returned: products.length,
          status: 200,
          latencyMs: Date.now() - stepStartedAt,
        }),
      ],
    };
  } catch (err) {
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'external_seed_pool',
      status: 'error',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'external_seed_pool',
          query: phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          error: err?.message || String(err),
        }),
      ],
    };
  }
}

function buildProviderBreakdown(results = []) {
  return DISCOVERY_PROVIDER_ORDER.map((provider) => {
    const result = (Array.isArray(results) ? results : []).find((entry) => entry?.provider === provider) || null;
    const recallSummary = Array.isArray(result?.recallSummary) ? result.recallSummary : [];
    const attempted = recallSummary.length > 0;
    const successfulSteps = recallSummary.filter((step) => Number(step?.status || 0) >= 200 && Number(step?.status || 0) < 300);
    return {
      provider,
      attempted,
      successful: successfulSteps.length > 0,
      returned: Array.isArray(result?.products) ? result.products.length : 0,
      steps: recallSummary.length,
      skipped: recallSummary.every((step) => step?.skipped === true),
    };
  });
}

function isHighQualityProviderCandidate(candidate, request, profile) {
  if (!candidate) return false;

  if (request?.surface === 'home_hot_deals' && !profile?.hasInterestSignals) {
    return candidate.domain === 'beauty' && candidate.beautyBucket !== 'tools';
  }

  if (profile?.dominantDomain === 'beauty') {
    if (candidate.domain !== 'beauty') return false;
    if (profile?.preferredBeautyBucket && profile.preferredBeautyBucket !== 'tools') {
      return candidate.beautyBucket !== 'tools';
    }
    return true;
  }

  if (profile?.dominantDomain && profile.dominantDomain !== 'unknown') {
    return candidate.domain === profile.dominantDomain || candidate.domain === 'unknown';
  }

  return candidate.domain !== 'pet' && candidate.domain !== 'sleepwear';
}

function countHighQualityProviderCandidates(products = [], { request, profile } = {}) {
  let count = 0;
  for (let idx = 0; idx < products.length; idx += 1) {
    const candidate = normalizeCandidateProduct(products[idx], idx);
    if (!candidate) continue;
    if (isHighQualityProviderCandidate(candidate, request, profile)) count += 1;
  }
  return count;
}

function getProviderQualityThreshold(request) {
  if (request?.surface === 'browse_products') {
    return Math.min(Math.max((request?.page || 1) * (request?.limit || 0), request?.limit || 0), 12);
  }
  return Math.max(1, Math.min(request?.limit || 0, 6));
}

function hasSufficientProviderCandidates(products = [], { request, profile, enoughThreshold, qualityThreshold } = {}) {
  return (
    Array.isArray(products) &&
    products.length >= Number(enoughThreshold || 0) &&
    countHighQualityProviderCandidates(products, { request, profile }) >= Number(qualityThreshold || 0)
  );
}

function resolveExternalSeedProviderLimit(request, safeLimit) {
  const cappedSafeLimit = clampInt(safeLimit, MAX_CANDIDATE_FETCH, 12, MAX_CANDIDATE_FETCH);
  if (request?.surface === 'browse_products') {
    const browseNeed = Math.max((request?.page || 1) * (request?.limit || 0) + (request?.limit || 0), 18);
    return clampInt(browseNeed, Math.min(cappedSafeLimit, 24), 12, Math.min(cappedSafeLimit, 36));
  }
  const homeNeed = Math.max((request?.limit || 0) * 3, 18);
  return clampInt(homeNeed, Math.min(cappedSafeLimit, 24), 12, Math.min(cappedSafeLimit, 30));
}

function buildExternalSeedProviderQueries(request, profile, queries = []) {
  const prioritized = prioritizeDiscoveryRecallQueries(queries);
  if (!prioritized.length) return [];
  if (!profile?.hasInterestSignals) return prioritized.slice(0, 2);
  if (profile?.dominantDomain === 'beauty') return prioritized.slice(0, 3);
  if (request?.surface === 'browse_products') return prioritized.slice(0, 3);
  return prioritized.slice(0, 2);
}

async function loadCatalogCandidates({
  request = null,
  profile = null,
  limit = MAX_CANDIDATE_FETCH,
  providerOverrides = null,
} = {}) {
  const safeLimit = clampInt(limit, resolveDiscoveryCandidateLimit(request), 24, MAX_CANDIDATE_FETCH);
  const providerQueries = buildDiscoveryProviderQueries(request, profile);
  const enoughThreshold = getRecallEnoughThreshold(request, safeLimit);
  const qualityThreshold = getProviderQualityThreshold(request);
  const providerResults = [];
  const mergedProducts = [];
  const seenKeys = new Set();
  const internalProviderLimit = Math.min(safeLimit, 72);
  const externalProviderLimit = resolveExternalSeedProviderLimit(request, safeLimit);
  const externalProviderQueries = buildExternalSeedProviderQueries(request, profile, providerQueries);

  const mergeProducts = (products = []) => {
    for (const product of Array.isArray(products) ? products : []) {
      const key = buildDiscoveryProviderMergeKey(product);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      mergedProducts.push(product);
      if (mergedProducts.length >= safeLimit) break;
    }
  };

  const buildProviderErrorResult = (provider, err) => ({
    provider,
    products: [],
    recallSummary: [
      buildDiscoveryProviderStepSummary({
        provider,
        label:
          provider === 'products_search'
            ? 'products_search_pool'
            : provider === 'internal_catalog'
              ? 'internal_catalog_pool'
              : 'external_seed_pool',
        query: providerQueries.join(' | '),
        limit: safeLimit,
        returned: 0,
        status: null,
        latencyMs: 0,
        error: err?.message || String(err),
      }),
    ],
  });

  try {
    const searchResult = await loadProductsSearchCandidates({
      request,
      profile,
      limit: safeLimit,
    });
    const productsSearchResult = {
      provider: 'products_search',
      products: annotateProviderProducts('products_search', searchResult?.products || []),
      recallSummary: Array.isArray(searchResult?.recallSummary)
        ? searchResult.recallSummary.map((step) => ({ provider: 'products_search', ...step }))
        : [],
    };
    providerResults.push(productsSearchResult);
    mergeProducts(productsSearchResult.products);
  } catch (err) {
    providerResults.push(buildProviderErrorResult('products_search', err));
  }

  const shouldSkipBrandScopedExpansion = shouldSkipBrandScopedProviderExpansion(mergedProducts, {
    request,
    profile,
    enoughThreshold,
    qualityThreshold,
  });
  const shouldBypassGenericBrandExpansion = shouldUseBrandDirectPoolInsteadOfGenericBrandExpansion(request);
  if (shouldSkipBrandScopedExpansion || shouldBypassGenericBrandExpansion) {
    const skipReason = shouldSkipBrandScopedExpansion
      ? 'sufficient_brand_primary_candidates'
      : 'brand_direct_pool_supersedes_brand_expansion';
    providerResults.push(
      buildSkippedProviderResult('internal_catalog', {
        label: 'internal_catalog_pool',
        query: providerQueries.join(' | '),
        limit: internalProviderLimit,
        skipReason,
      }),
    );
    providerResults.push(
      buildSkippedProviderResult('external_seeds', {
        label: 'external_seed_pool',
        query: externalProviderQueries.join(' | '),
        limit: externalProviderLimit,
        skipReason,
      }),
    );
    const recallSummary = providerResults.flatMap((result) =>
      (Array.isArray(result?.recallSummary) ? result.recallSummary : []).map((step) => ({
        provider: result.provider,
        ...step,
      })),
    );
    const providerBreakdown = buildProviderBreakdown(providerResults);
    return {
      products: mergedProducts,
      recallSummary,
      providerBreakdown,
    };
  }

  const shouldSkipExternalSeeds = hasSufficientProviderCandidates(mergedProducts, {
    request,
    profile,
    enoughThreshold,
    qualityThreshold,
  });

  const internalPromise = fetchInternalCatalogCandidates({
    request,
    profile,
    queries: providerQueries,
    limit: internalProviderLimit,
    fetchFn: providerOverrides?.internal_catalog || null,
  });
  const externalPromise = shouldSkipExternalSeeds
    ? null
    : fetchExternalSeedCandidates({
        request,
        profile,
        queries: externalProviderQueries,
        limit: externalProviderLimit,
        fetchFn: providerOverrides?.external_seeds || null,
      });

  try {
    const internalResult = await internalPromise;
    const normalizedInternalResult = {
      provider: 'internal_catalog',
      products: internalResult.products,
      recallSummary: internalResult.recallSummary,
    };
    providerResults.push(normalizedInternalResult);
    mergeProducts(normalizedInternalResult.products);
  } catch (err) {
    providerResults.push(buildProviderErrorResult('internal_catalog', err));
  }

  if (shouldSkipExternalSeeds) {
    providerResults.push(
      buildSkippedProviderResult('external_seeds', {
        label: 'external_seed_pool',
        query: externalProviderQueries.join(' | '),
        limit: externalProviderLimit,
        skipReason: 'sufficient_primary_candidates',
      }),
    );
  } else {
    try {
      const externalResult = await externalPromise;
      const normalizedExternalResult = {
        provider: 'external_seeds',
        products: externalResult.products,
        recallSummary: externalResult.recallSummary,
      };
      providerResults.push(normalizedExternalResult);
      mergeProducts(normalizedExternalResult.products);
    } catch (err) {
      providerResults.push(buildProviderErrorResult('external_seeds', err));
    }
  }

  const recallSummary = providerResults.flatMap((result) =>
    (Array.isArray(result?.recallSummary) ? result.recallSummary : []).map((step) => ({
      provider: result.provider,
      ...step,
    })),
  );
  const providerBreakdown = buildProviderBreakdown(providerResults);
  const successfulProviders = providerBreakdown.filter((entry) => entry.successful);

  if (successfulProviders.length <= 0) {
    throw new DiscoveryCatalogUnavailableError('Failed to load discovery candidates from discovery providers');
  }

  return {
    products: mergedProducts,
    recallSummary,
    providerBreakdown,
  };
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

function matchesQueryTextCandidate(candidate, queryText) {
  const normalizedQuery = normalizeText(queryText || '');
  if (!normalizedQuery) return true;

  const candidateText = normalizeText(
    [
      candidate?.raw?.title,
      candidate?.raw?.name,
      candidate?.raw?.description,
      candidate?.raw?.brand,
      candidate?.brand,
      candidate?.category,
      candidate?.parentCategory,
    ]
      .filter(Boolean)
      .join(' '),
  );
  if (!candidateText) return false;
  if (candidateText.includes(normalizedQuery)) return true;

  const queryTokens = tokenize(normalizedQuery).filter((token) => token.length >= 2);
  if (!queryTokens.length) return candidateText.includes(normalizedQuery);
  const candidateTokens = new Set(candidate?.tokens || tokenize(candidateText));
  const tokenHits = queryTokens.filter((token) => candidateTokens.has(token) || candidateText.includes(token)).length;
  return tokenHits >= Math.max(1, Math.ceil(queryTokens.length * 0.6));
}

function getDiscoveryCategoryFacetKey(candidate) {
  const normalized = normalizeText(
    candidate?.raw?.product_type ||
      candidate?.raw?.productType ||
      candidate?.category ||
      candidate?.raw?.category ||
      candidate?.parentCategory ||
      '',
  );
  return !normalized || isWeakCategoryLabel(normalized) ? '' : normalized;
}

function buildDiscoveryCategoryLabel(value) {
  return normalizeText(value || '').replace(/\b\w/g, (match) => match.toUpperCase());
}

function matchesCategoryScopeCandidate(candidate, categories = []) {
  const allowed = normalizeDiscoveryCategories(categories, 12);
  if (!allowed.length) return true;
  const candidateCategory = getDiscoveryCategoryFacetKey(candidate);
  return candidateCategory ? allowed.includes(candidateCategory) : false;
}

function buildDiscoveryCategoryFacets(entries = []) {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const candidate = entry?.candidate || entry;
    const key = getDiscoveryCategoryFacetKey(candidate);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({
      value,
      label: buildDiscoveryCategoryLabel(value),
      count,
    }));
}

async function loadBrandScopedRecommendationFallback({
  request,
  limit = 24,
  recommendFn = recommend,
} = {}) {
  const sourceProductId = String(request?.source_product_ref?.product_id || '').trim();
  const merchantId = String(request?.source_product_ref?.merchant_id || '').trim() || null;
  const brandName = Array.isArray(request?.scope?.brand_names) ? String(request.scope.brand_names[0] || '').trim() : '';
  const safeLimit = clampInt(limit, Math.max(limit, 24), 1, 180);
  const baseProduct = {
    ...(sourceProductId ? { product_id: sourceProductId } : {}),
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(brandName ? { brand: brandName, vendor: brandName } : {}),
  };

  if (!sourceProductId || typeof recommendFn !== 'function') return [];
  try {
    const result = await recommendFn({
      pdp_product: baseProduct,
      k: clampInt(limit, Math.max(limit, 24), 1, 72),
      locale: request?.context?.locale || 'en-US',
      options: {
        no_cache: true,
        cache_bypass: true,
      },
    });
    return Array.isArray(result?.items) ? result.items : [];
  } catch (err) {
    logger.warn(
      {
        err: err?.message || String(err),
        product_id: sourceProductId,
        merchant_id: merchantId,
      },
      'brand scoped discovery fallback failed',
    );
    return [];
  }
}

async function fetchBrandScopedExternalSeedCandidates({ brandAliases = [], limit = 120 } = {}) {
  if (!process.env.DATABASE_URL) return [];
  const normalizedAliases = uniqStrings(
    brandAliases.map((alias) => normalizeBrandText(alias)).filter(Boolean),
    16,
  );
  if (!normalizedAliases.length) return [];

  const safeLimit = clampInt(limit, Math.max(limit, 120), 24, 500);
  const market = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US').trim().toUpperCase() || 'US';
  const tool = 'creator_agents';

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
          AND (
            lower(coalesce(seed_data->>'brand', '')) = ANY($3::text[])
            OR lower(coalesce(seed_data->>'brand_name', '')) = ANY($3::text[])
            OR lower(coalesce(seed_data->>'vendor', '')) = ANY($3::text[])
            OR lower(coalesce(seed_data->>'vendor_name', '')) = ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'brand', '')) = ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'brand_name', '')) = ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'vendor', '')) = ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'vendor_name', '')) = ANY($3::text[])
            OR EXISTS (
              SELECT 1
              FROM unnest($3::text[]) AS alias
              WHERE lower(coalesce(seed_data->'snapshot'->>'title', seed_data->>'title', title, '')) LIKE alias || ' %'
            )
          )
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT $4
      `,
      [market, tool, normalizedAliases, safeLimit],
    );
    return (res.rows || [])
      .map((row) => buildExternalSeedProduct(row))
      .filter(Boolean);
  } catch (err) {
    logger.warn(
      {
        err: err?.message || String(err),
        brand_aliases: normalizedAliases,
      },
      'brand scoped discovery external query failed',
    );
    return [];
  }
}

async function fetchBrandScopedInternalCatalogCandidates({ brandAliases = [], limit = 120 } = {}) {
  if (!process.env.DATABASE_URL) return [];
  const normalizedAliases = uniqStrings(
    brandAliases.map((alias) => normalizeBrandText(alias)).filter(Boolean),
    16,
  );
  if (!normalizedAliases.length) return [];

  const safeLimit = clampInt(limit, Math.max(limit, 120), 24, 400);

  try {
    const res = await query(
      `
        SELECT merchant_id, product_data
        FROM products_cache
        WHERE (expires_at IS NULL OR expires_at > now())
          AND COALESCE(lower(product_data->>'status'), 'active') = 'active'
          AND merchant_id <> $1
          AND (
            lower(coalesce(product_data->>'brand', '')) = ANY($2::text[])
            OR lower(coalesce(product_data->>'brand_name', '')) = ANY($2::text[])
            OR lower(coalesce(product_data->>'vendor', '')) = ANY($2::text[])
            OR lower(coalesce(product_data->>'vendor_name', '')) = ANY($2::text[])
            OR lower(coalesce(product_data->>'manufacturer', '')) = ANY($2::text[])
            OR EXISTS (
              SELECT 1
              FROM unnest($2::text[]) AS alias
              WHERE lower(coalesce(product_data->>'title', product_data->>'name', '')) LIKE alias || ' %'
            )
          )
        ORDER BY cached_at DESC NULLS LAST, id DESC
        LIMIT $3
      `,
      [EXTERNAL_SEED_MERCHANT_ID, normalizedAliases, safeLimit],
    );
    return (res.rows || [])
      .map((row) => {
        if (!row?.product_data || !row?.merchant_id) return null;
        return {
          ...row.product_data,
          merchant_id: String(row.merchant_id).trim(),
        };
      })
      .filter(Boolean);
  } catch (err) {
    logger.warn(
      {
        err: err?.message || String(err),
        brand_aliases: normalizedAliases,
      },
      'brand scoped discovery internal query failed',
    );
    return [];
  }
}

async function loadBrandScopedDirectCandidates({
  request,
  brandAliases = [],
  limit = 120,
  fetchExternalCandidatesFn = null,
  fetchInternalCandidatesFn = null,
} = {}) {
  const normalizedAliases = uniqStrings(
    brandAliases.map((alias) => normalizeBrandText(alias)).filter(Boolean),
    16,
  );
  if (!normalizedAliases.length) {
    return {
      products: [],
      recallSummary: [],
    };
  }

  const safeLimit = clampInt(limit, Math.max(limit, 120), 24, 360);
  const stepStartedAt = Date.now();

  try {
    const [internalCandidates, externalCandidates] = await Promise.all([
      typeof fetchInternalCandidatesFn === 'function'
        ? fetchInternalCandidatesFn({
            brandAliases: normalizedAliases,
            limit: safeLimit,
            request,
          })
        : fetchBrandScopedInternalCatalogCandidates({
            brandAliases: normalizedAliases,
            limit: safeLimit,
          }),
      typeof fetchExternalCandidatesFn === 'function'
        ? fetchExternalCandidatesFn({
            brandAliases: normalizedAliases,
            limit: safeLimit,
            request,
          })
        : fetchBrandScopedExternalSeedCandidates({
            brandAliases: normalizedAliases,
            limit: safeLimit,
          }),
    ]);

    const merged = [...(Array.isArray(internalCandidates) ? internalCandidates : []), ...(Array.isArray(externalCandidates) ? externalCandidates : [])];
    const deduped = [];
    const seen = new Set();
    for (const item of merged) {
      const key = buildProductKey(
        item?.merchant_id || item?.merchantId,
        item?.product_id || item?.productId || item?.id,
      );
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    return {
      products: deduped,
      recallSummary: [
        {
          label: 'brand_direct_pool',
          query: normalizedAliases.join(' | '),
          offset: 0,
          limit: safeLimit,
          status: 200,
          returned: deduped.length,
          latency_ms: Date.now() - stepStartedAt,
          cache_hit: false,
        },
      ],
    };
  } catch (err) {
    return {
      products: [],
      recallSummary: [
        {
          label: 'brand_direct_pool',
          query: normalizedAliases.join(' | '),
          offset: 0,
          limit: safeLimit,
          status: null,
          returned: 0,
          latency_ms: Date.now() - stepStartedAt,
          cache_hit: false,
          error: err?.message || String(err),
        },
      ],
    };
  }
}

function scheduleBrandScopedDirectCandidatesLoad(args = {}, delayMs = getBrandDirectPrefetchDelayMs()) {
  let timer = null;
  let started = false;
  let resolved = false;
  let resolveScheduled;
  const startLoad = () => {
    if (started || resolved) return;
    started = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    loadBrandScopedDirectCandidates(args)
      .then((result) => resolveScheduled(result))
      .catch((err) =>
        resolveScheduled({
          products: [],
          recallSummary: [
            {
              label: 'brand_direct_pool',
              query: Array.isArray(args.brandAliases) ? args.brandAliases.join(' | ') : null,
              offset: 0,
              limit: Number(args.limit || 0),
              status: null,
              returned: 0,
              latency_ms: 0,
              cache_hit: false,
              error: err?.message || String(err),
            },
          ],
        }),
      );
  };

  const promise = new Promise((resolve) => {
    resolveScheduled = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    timer = setTimeout(startLoad, Math.max(0, Number(delayMs || 0)));
  });

  return {
    promise,
    startNow: () => {
      startLoad();
      return promise;
    },
    cancel: () => {
      if (started || resolved) return false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolveScheduled(null);
      return true;
    },
  };
}

function scoreBeautyBucketAlignment(candidate, profile) {
  if (!profile?.preferredBeautyBucket || profile?.dominantDomain !== 'beauty') return 0;
  if (candidate.domain !== 'beauty') return -0.2;
  if (!candidate.beautyBucket) return 0.1;
  if (candidate.beautyBucket === profile.preferredBeautyBucket) return 1;
  if (profile.preferredBeautyBucket !== 'tools' && candidate.beautyBucket === 'tools') return -1.2;
  return -0.65;
}

function isExternalSeedMerchantCandidate(candidate) {
  return String(candidate?.merchantId || '').trim() === EXTERNAL_SEED_MERCHANT_ID;
}

function scoreColdStartCandidateQuality(candidate, surface) {
  if (!candidate) return 0;
  if (candidate.domain === 'beauty') {
    if (candidate.beautyBucket === 'tools') {
      return surface === 'browse_products' ? -1.7 : -1.35;
    }
    return candidate.beautyBucket === 'skincare' ? 1.15 : 0.92;
  }
  if (candidate.domain === 'unknown') {
    return surface === 'home_hot_deals' ? 0.18 : 0.04;
  }
  if (candidate.domain === 'apparel') return -0.85;
  if (candidate.domain === 'sleepwear' || candidate.domain === 'pet') return -1.4;
  return -0.2;
}

function scoreColdStartSourceBias(candidate) {
  if (!candidate) return 0;
  if (isExternalSeedMerchantCandidate(candidate)) return 0.42;
  if (candidate.provider === 'internal_catalog') return -0.16;
  if (candidate.provider === 'products_search') return -0.08;
  return 0;
}

function scoreCandidate(candidate, profile, surface, options = {}) {
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
  const coldStartGenericSurface =
    !profile?.hasInterestSignals &&
    options?.brandScoped !== true &&
    !String(options?.queryText || '').trim() &&
    normalizeDiscoveryCategories(options?.categories, 12).length === 0;
  const coldStartQualityScore = coldStartGenericSurface
    ? scoreColdStartCandidateQuality(candidate, surface)
    : 0;
  const coldStartSourceScore = coldStartGenericSurface
    ? scoreColdStartSourceBias(candidate)
    : 0;
  const finalScore =
    coldStartGenericSurface
      ? surface === 'home_hot_deals'
        ? browseBase * 0.14 + coldStartQualityScore * 0.76 + coldStartSourceScore * 0.42
        : browseBase * 0.32 + coldStartQualityScore * 0.86 + coldStartSourceScore * 0.46
      : surface === 'home_hot_deals'
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
    coldStartQualityScore,
    coldStartSourceScore,
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

function shouldDeferColdStartCandidate(candidate) {
  if (!candidate) return false;
  if (COLD_START_DEFERRED_DOMAINS.has(candidate.domain)) return true;
  return (
    candidate.domain === 'beauty' &&
    candidate.beautyBucket &&
    COLD_START_DEFERRED_BEAUTY_BUCKETS.has(candidate.beautyBucket)
  );
}

function getColdStartHomeDomainPriority(candidate) {
  if (candidate?.domain === 'beauty' && candidate?.beautyBucket === 'tools') return 1;
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

function compareBrowseEntriesBySort(sort = 'popular') {
  if (sort === 'price_desc') {
    return (a, b) => {
      const aPrice = Number.isFinite(a?.candidate?.priceAmount) ? a.candidate.priceAmount : Number.NEGATIVE_INFINITY;
      const bPrice = Number.isFinite(b?.candidate?.priceAmount) ? b.candidate.priceAmount : Number.NEGATIVE_INFINITY;
      if (bPrice !== aPrice) return bPrice - aPrice;
      return compareBrowseEntries(a, b);
    };
  }
  if (sort === 'price_asc') {
    return (a, b) => {
      const aPrice = Number.isFinite(a?.candidate?.priceAmount) ? a.candidate.priceAmount : Number.POSITIVE_INFINITY;
      const bPrice = Number.isFinite(b?.candidate?.priceAmount) ? b.candidate.priceAmount : Number.POSITIVE_INFINITY;
      if (aPrice !== bPrice) return aPrice - bPrice;
      return compareBrowseEntries(a, b);
    };
  }
  return compareBrowseEntries;
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
  const recentViewDeferred = [];
  for (const entry of ranked) {
    const rejectReason = getDiscoveryRejectReason(entry, profile, 'home_hot_deals');
    if (rejectReason) {
      if (decisions) decisions.set(entry.candidate.key, rejectReason);
      continue;
    }
    if (viewedKeys.has(entry.candidate.key)) {
      recentViewDeferred.push(entry);
      if (decisions) decisions.set(entry.candidate.key, 'filtered_recent_view');
      continue;
    }
    if (coldStartCuration && shouldDeferColdStartCandidate(entry.candidate)) {
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
    if (entry.candidate.domain !== 'beauty') {
      if (decisions) decisions.set(entry.candidate.key, 'not_selected_cold_start_deferred');
      continue;
    }
    if (coldStartCuration && selected.length >= Math.min(limit, MIN_COLD_START_NON_DEFERRED_RESULTS)) {
      if (decisions) decisions.set(entry.candidate.key, 'not_selected_cold_start_deferred');
      continue;
    }
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected_cold_start_backfill');
  }

  for (const entry of recentViewDeferred) {
    if (selected.length >= limit) break;
    if (selected.some((picked) => picked.candidate.key === entry.candidate.key)) continue;
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected_recent_view_backfill');
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
  const sort = normalizeDiscoverySort(options.sort);
  const brandScoped = options.brandScoped === true;
  const queryText = String(options.queryText || '').trim();
  const categoryScope = normalizeDiscoveryCategories(options.categories, 12);
  const ranked = [...scoredCandidates].sort(compareBrowseEntriesBySort(sort));
  const decisions = collectDebug ? new Map() : null;
  const coldStartCuration =
    !profile?.hasInterestSignals &&
    sort === 'popular' &&
    !brandScoped &&
    !queryText &&
    categoryScope.length === 0;

  const preCategoryPool = [];
  const recentViewDeferred = [];
  for (const entry of ranked) {
    const rejectReason = getDiscoveryRejectReason(entry, profile, 'browse_products');
    if (rejectReason) {
      if (decisions) decisions.set(entry.candidate.key, rejectReason);
      continue;
    }
    if (page <= 1 && viewedKeys.has(entry.candidate.key) && !brandScoped) {
      recentViewDeferred.push(entry);
      if (decisions) decisions.set(entry.candidate.key, 'filtered_recent_view');
      continue;
    }
    if (queryText && !matchesQueryTextCandidate(entry.candidate, queryText)) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_query_text');
      continue;
    }
    preCategoryPool.push(entry);
  }

  const preferredPool = [];
  const coldStartDeferredPool = [];
  for (const entry of preCategoryPool) {
    if (categoryScope.length > 0 && !matchesCategoryScopeCandidate(entry.candidate, categoryScope)) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_category_scope');
      continue;
    }
    if (coldStartCuration && shouldDeferColdStartCandidate(entry.candidate)) {
      coldStartDeferredPool.push(entry);
      continue;
    }
    preferredPool.push(entry);
  }
  const orderedPool = coldStartCuration
    ? preferredPool.concat(coldStartDeferredPool)
    : preferredPool;

  const start = (page - 1) * limit;
  const pageItems = orderedPool.slice(start, start + limit);
  if (page <= 1 && pageItems.length < limit) {
    for (const entry of recentViewDeferred) {
      if (pageItems.length >= limit) break;
      if (pageItems.some((picked) => picked.candidate.key === entry.candidate.key)) continue;
      pageItems.push(entry);
      if (decisions) decisions.set(entry.candidate.key, 'selected_recent_view_backfill');
    }
  }
  if (!collectDebug) {
    return {
      preCategoryPool,
      orderedPool,
      pageItems,
    };
  }

  const selectedKeys = new Set(pageItems.map((entry) => entry.candidate.key));
  for (const entry of orderedPool) {
    if (decisions.has(entry.candidate.key)) continue;
    decisions.set(
      entry.candidate.key,
      selectedKeys.has(entry.candidate.key)
        ? 'selected'
        : coldStartCuration && shouldDeferColdStartCandidate(entry.candidate)
          ? 'page_window_excluded_cold_start_domain'
          : 'page_window_excluded',
    );
  }

  return {
    ranked,
    preCategoryPool,
    orderedPool,
    pageItems,
    decisions,
  };
}

function formatDiscoveryResponseProduct(candidate, request = null) {
  const { __discovery_provider, ...raw } = candidate.raw || {};
  if (request?.response_detail === 'card') {
    const imageUrl = String(raw.image_url || raw.imageUrl || '').trim();
    const title = String(raw.title || raw.name || '').trim();
    const category = raw.category || candidate.parentCategory || candidate.category || undefined;
    const productType = raw.product_type || raw.productType || candidate.category || undefined;
    const brand = raw.brand || candidate.brand || undefined;
    const price =
      raw.price != null
        ? raw.price
        : Number.isFinite(candidate?.priceAmount)
          ? candidate.priceAmount
          : undefined;
    const inStock = isCandidateSellable(raw);

    return {
      id: raw.id || candidate.productId,
      product_id: raw.product_id || candidate.productId,
      merchant_id: raw.merchant_id || candidate.merchantId,
      ...(raw.merchant_name ? { merchant_name: raw.merchant_name } : {}),
      ...(raw.external_redirect_url ? { external_redirect_url: raw.external_redirect_url } : {}),
      ...(raw.external_seed_id ? { external_seed_id: raw.external_seed_id } : {}),
      ...(raw.source ? { source: raw.source } : {}),
      ...(raw.disclosure_text ? { disclosure_text: raw.disclosure_text } : {}),
      ...(raw.platform ? { platform: raw.platform } : {}),
      ...(raw.platform_product_id ? { platform_product_id: raw.platform_product_id } : {}),
      ...(raw.variant_id ? { variant_id: raw.variant_id } : {}),
      ...(raw.sku_id ? { sku_id: raw.sku_id } : {}),
      ...(raw.sku ? { sku: raw.sku } : {}),
      title: title || candidate.productId,
      price,
      currency: raw.currency || 'USD',
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(brand ? { brand } : {}),
      ...(category ? { category } : {}),
      ...(productType ? { product_type: productType } : {}),
      in_stock: inStock,
      ...(Array.isArray(raw.tags) && raw.tags.length ? { tags: raw.tags } : {}),
      ...(raw.department ? { department: raw.department } : {}),
      ...(raw.review_summary && typeof raw.review_summary === 'object'
        ? { review_summary: raw.review_summary }
        : {}),
      ...(raw.attributes && typeof raw.attributes === 'object' ? { attributes: raw.attributes } : {}),
      ...(raw.seller_feedback_summary && typeof raw.seller_feedback_summary === 'object'
        ? { seller_feedback_summary: raw.seller_feedback_summary }
        : {}),
    };
  }

  return {
    ...raw,
    id: raw.id || candidate.productId,
    product_id: raw.product_id || candidate.productId,
    merchant_id: raw.merchant_id || candidate.merchantId,
    ...(raw.brand ? {} : candidate.brand ? { brand: candidate.brand } : {}),
    ...(raw.category ? {} : candidate.category ? { category: candidate.category } : {}),
    ...(raw.product_type || !candidate.category ? {} : { product_type: candidate.category }),
  };
}

function buildNormalizedCandidateKey(candidate, { brandScoped = false } = {}) {
  if (!candidate || typeof candidate !== 'object') return '';
  return buildDiscoveryDedupKey(
    {
      merchant_id: candidate.raw?.merchant_id || candidate.merchantId,
      product_id: candidate.raw?.product_id || candidate.productId,
      id: candidate.raw?.id || candidate.productId,
      canonical_url: candidate.raw?.canonical_url,
      destination_url: candidate.raw?.destination_url,
      url: candidate.raw?.url,
      brand: candidate.raw?.brand || candidate.brand,
      brand_name: candidate.raw?.brand_name,
      vendor: candidate.raw?.vendor,
      vendor_name: candidate.raw?.vendor_name,
      manufacturer: candidate.raw?.manufacturer,
      title: candidate.raw?.title || candidate.raw?.name,
      name: candidate.raw?.name,
    },
    { brandScoped },
  );
}

function buildNormalizedCandidateSemanticKey(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';
  return buildDiscoverySemanticProductKey({
    canonical_url: candidate.raw?.canonical_url,
    destination_url: candidate.raw?.destination_url,
    url: candidate.raw?.url,
    brand: candidate.raw?.brand || candidate.brand,
    brand_name: candidate.raw?.brand_name,
    vendor: candidate.raw?.vendor,
    vendor_name: candidate.raw?.vendor_name,
    manufacturer: candidate.raw?.manufacturer,
    title: candidate.raw?.title || candidate.raw?.name,
    name: candidate.raw?.name,
    product_type: candidate.raw?.product_type || candidate.category,
    category: candidate.raw?.category || candidate.parentCategory,
    parent_category: candidate.parentCategory,
  });
}

function buildCandidateCounts({
  raw,
  normalized,
  scored,
  eligiblePool,
  returned,
  sameDomain,
  semanticDeduped,
} = {}) {
  return {
    raw: Number(raw || 0),
    normalized: Number(normalized || 0),
    scored: Number(scored || 0),
    eligible_pool: Number(eligiblePool || 0),
    returned: Number(returned || 0),
    ...(sameDomain != null ? { same_domain: Number(sameDomain || 0) } : {}),
    ...(semanticDeduped != null ? { semantic_deduped: Number(semanticDeduped || 0) } : {}),
  };
}

function getCandidateSource(options = {}) {
  if (Array.isArray(options.candidateProducts)) return 'override';
  return 'multi_provider';
}

function countSameDomainCandidates(candidates = [], profile = null) {
  if (!Array.isArray(candidates) || candidates.length === 0) return 0;
  const dominantDomain = String(profile?.dominantDomain || '').trim();
  if (dominantDomain) {
    return candidates.filter((candidate) => candidate?.domain === dominantDomain).length;
  }
  return candidates.filter((candidate) => candidate?.domain === 'beauty').length;
}

function buildFilterCounts(decisions = new Map()) {
  const counts = {};
  for (const decision of decisions instanceof Map ? decisions.values() : []) {
    const key = String(decision || '').trim();
    if (!key) continue;
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
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
  providerBreakdown,
  filterCounts,
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
      provider: entry.candidate.provider || null,
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
        cold_start_quality_score: roundMetric(entry.scores.coldStartQualityScore),
        cold_start_source_score: roundMetric(entry.scores.coldStartSourceScore),
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
      provider: String(step?.provider || '').trim() || null,
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
      ...(step?.skipped ? { skipped: true } : {}),
      ...(step?.skip_reason ? { skip_reason: String(step.skip_reason) } : {}),
      ...(step?.error ? { error: String(step.error) } : {}),
    })),
    provider_breakdown: Array.isArray(providerBreakdown) ? providerBreakdown : [],
    filter_counts: filterCounts && typeof filterCounts === 'object' ? filterCounts : {},
  };
}

async function getDiscoveryFeed(payload = {}, options = {}) {
  const startedAt = Date.now();
  let request = null;
  let profile = null;
  let strategy = 'unknown';
  let personalizationSource = 'unknown';
  const candidateSource = getCandidateSource(options);
  let effectiveCandidateSource = candidateSource;
  let candidateCounts = buildCandidateCounts();
  let recallSummary = [];
  let providerBreakdown = [];

  try {
    request = normalizeDiscoveryRequest(payload);
    profile = buildDiscoveryProfile(request.context);
    strategy = profile.hasInterestSignals ? 'personalized_interest' : 'cold_start_curated';
    personalizationSource =
      strategy === 'personalized_interest' ? profile.personalizationSource : 'none';
    const candidateLimit = options.candidateLimit || resolveDiscoveryCandidateLimit(request);
    const brandScopeAliases = buildBrandScopeAliases(request.scope?.brand_names || []);
    const brandDirectLimit = resolveBrandDirectCandidateLimit(request, candidateLimit);
    const scheduledBrandDirectLoad =
      !Array.isArray(options.candidateProducts) &&
      brandScopeAliases.length > 0 &&
      shouldUseBrandDirectPoolInsteadOfGenericBrandExpansion(request)
        ? scheduleBrandScopedDirectCandidatesLoad({
            request,
            brandAliases: brandScopeAliases,
            limit: brandDirectLimit,
            fetchExternalCandidatesFn: options.brandFallbackFetchExternalCandidatesFn,
            fetchInternalCandidatesFn: options.brandFallbackFetchInternalCandidatesFn,
          })
        : null;

    const candidateLoadResult = Array.isArray(options.candidateProducts)
      ? {
          products: options.candidateProducts,
          recallSummary: [],
        }
      : await loadCatalogCandidates({
          request,
          profile,
          limit: candidateLimit,
          providerOverrides: options.providerOverrides || null,
        });
    const rawCandidates = Array.isArray(candidateLoadResult?.products)
      ? candidateLoadResult.products
      : [];
    recallSummary = Array.isArray(candidateLoadResult?.recallSummary)
      ? candidateLoadResult.recallSummary
      : [];
    providerBreakdown = Array.isArray(candidateLoadResult?.providerBreakdown)
      ? candidateLoadResult.providerBreakdown
      : [];
    let effectiveRawCandidates = rawCandidates;
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'raw',
      count: effectiveRawCandidates.length,
    });

    let normalizedCandidates = [];
    const seenKeys = new Set();
    const seenSemanticKeys = new Set();
    const brandScoped = brandScopeAliases.length > 0;
    let semanticDeduped = 0;
    for (let idx = 0; idx < effectiveRawCandidates.length; idx += 1) {
      const normalized = normalizeCandidateProduct(effectiveRawCandidates[idx], idx);
      if (!normalized) continue;
      const dedupKey = buildNormalizedCandidateKey(normalized, { brandScoped });
      if (!dedupKey || seenKeys.has(dedupKey)) continue;
      const semanticKey = buildNormalizedCandidateSemanticKey(normalized);
      if (semanticKey && seenSemanticKeys.has(semanticKey)) {
        semanticDeduped += 1;
        continue;
      }
      seenKeys.add(dedupKey);
      if (semanticKey) seenSemanticKeys.add(semanticKey);
      normalizedCandidates.push(normalized);
    }
    let scopedCandidates =
      brandScopeAliases.length > 0
        ? normalizedCandidates.filter((candidate) => matchesBrandScopeCandidate(candidate, brandScopeAliases))
        : normalizedCandidates;
    const skipBrandDirectPool = shouldSkipBrandDirectPool(scopedCandidates, {
      request,
      limit: candidateLimit,
    });

    if (brandScopeAliases.length > 0 && !skipBrandDirectPool) {
      const directBrandLoadResult =
        scheduledBrandDirectLoad
          ? await scheduledBrandDirectLoad.startNow()
          : await loadBrandScopedDirectCandidates({
              request,
              brandAliases: brandScopeAliases,
              limit: brandDirectLimit,
              fetchExternalCandidatesFn: options.brandFallbackFetchExternalCandidatesFn,
              fetchInternalCandidatesFn: options.brandFallbackFetchInternalCandidatesFn,
            });
      if (Array.isArray(directBrandLoadResult?.products) && directBrandLoadResult.products.length > 0) {
        effectiveCandidateSource = `${effectiveCandidateSource}+brand_direct`;
        effectiveRawCandidates = effectiveRawCandidates.concat(directBrandLoadResult.products);
        normalizedCandidates = [];
        seenKeys.clear();
        seenSemanticKeys.clear();
        semanticDeduped = 0;
        for (let idx = 0; idx < effectiveRawCandidates.length; idx += 1) {
          const normalized = normalizeCandidateProduct(effectiveRawCandidates[idx], idx);
          if (!normalized) continue;
          const dedupKey = buildNormalizedCandidateKey(normalized, { brandScoped });
          if (!dedupKey || seenKeys.has(dedupKey)) continue;
          const semanticKey = buildNormalizedCandidateSemanticKey(normalized);
          if (semanticKey && seenSemanticKeys.has(semanticKey)) {
            semanticDeduped += 1;
            continue;
          }
          seenKeys.add(dedupKey);
          if (semanticKey) seenSemanticKeys.add(semanticKey);
          normalizedCandidates.push(normalized);
        }
        scopedCandidates =
          brandScopeAliases.length > 0
            ? normalizedCandidates.filter((candidate) => matchesBrandScopeCandidate(candidate, brandScopeAliases))
            : normalizedCandidates;
      }
      if (Array.isArray(directBrandLoadResult?.recallSummary) && directBrandLoadResult.recallSummary.length > 0) {
        recallSummary = recallSummary.concat(directBrandLoadResult.recallSummary);
      }
    }
    if (brandScopeAliases.length > 0 && skipBrandDirectPool) {
      scheduledBrandDirectLoad?.cancel();
      recallSummary = recallSummary.concat([
        {
          provider: null,
          label: 'brand_direct_pool',
          query: brandScopeAliases.join(' | '),
          offset: 0,
          limit: brandDirectLimit,
          status: null,
          returned: 0,
          latency_ms: 0,
          cache_hit: false,
          skipped: true,
          skip_reason: 'sufficient_brand_primary_candidates',
        },
      ]);
    }

    if (brandScopeAliases.length > 0 && scopedCandidates.length === 0) {
      const fallbackProducts = await loadBrandScopedRecommendationFallback({
        request,
        limit: options.candidateLimit || resolveDiscoveryCandidateLimit(request),
        recommendFn: options.brandFallbackRecommendFn,
      });
      if (fallbackProducts.length > 0) {
        effectiveCandidateSource = `${effectiveCandidateSource}+brand_recommendation_fallback`;
        effectiveRawCandidates = effectiveRawCandidates.concat(fallbackProducts);
        normalizedCandidates = [];
        seenKeys.clear();
        for (let idx = 0; idx < effectiveRawCandidates.length; idx += 1) {
          const normalized = normalizeCandidateProduct(effectiveRawCandidates[idx], idx);
          if (!normalized) continue;
          const dedupKey = buildNormalizedCandidateKey(normalized, { brandScoped });
          if (!dedupKey || seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);
          normalizedCandidates.push(normalized);
        }
        scopedCandidates = normalizedCandidates.filter((candidate) =>
          matchesBrandScopeCandidate(candidate, brandScopeAliases),
        );
      }
    }
    observeDiscoveryCandidateCount({
      surface: request.surface,
      stage: 'normalized',
      count: scopedCandidates.length,
    });

    const viewedKeys = new Set(
      (request.context.recent_views || [])
        .map((view) => buildProductKey(view.merchant_id, view.product_id))
        .filter(Boolean),
    );

    const scoredCandidates = scopedCandidates.map((candidate) => ({
      candidate,
      scores: scoreCandidate(candidate, profile, request.surface, {
        brandScoped: brandScopeAliases.length > 0,
        queryText: request.query.text,
        categories: request.scope.categories,
      }),
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
    let categoryFacets = [];
    let decisions = new Map();
    let filterCounts = {};

    if (request.surface === 'home_hot_deals') {
      const homeSelection = selectHomeProducts(
        scoredCandidates,
        viewedKeys,
        request.limit,
        { collectDebug: true, profile },
      );
      selectedEntries = homeSelection.selected;
      total = homeSelection.eligiblePool.length;
      eligiblePoolCount = homeSelection.eligiblePool.length;
      ranked = homeSelection.ranked;
      orderedPool = homeSelection.eligiblePool;
      decisions = homeSelection.decisions;
      filterCounts = buildFilterCounts(decisions);
    } else {
      const browseSelection = selectBrowseProducts(
        scoredCandidates,
        viewedKeys,
        request.page,
        request.limit,
        {
          collectDebug: true,
          profile,
          sort: request.sort,
          brandScoped: brandScopeAliases.length > 0,
          queryText: request.query.text,
          categories: request.scope.categories,
        },
      );
      selectedEntries = browseSelection.pageItems;
      total = browseSelection.orderedPool.length;
      eligiblePoolCount = browseSelection.orderedPool.length;
      categoryFacets =
        brandScopeAliases.length > 0
          ? buildDiscoveryCategoryFacets(browseSelection.preCategoryPool)
          : [];
      ranked = browseSelection.ranked;
      orderedPool = browseSelection.orderedPool;
      decisions = browseSelection.decisions;
      filterCounts = buildFilterCounts(decisions);
    }

    candidateCounts = buildCandidateCounts({
      raw: effectiveRawCandidates.length,
      normalized: normalizedCandidates.length,
      scored: scoredCandidates.length,
      eligiblePool: eligiblePoolCount,
      returned: selectedEntries.length,
      sameDomain: countSameDomainCandidates(scopedCandidates, profile),
      semanticDeduped,
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
    const hasMore = total > request.page * request.limit;
    const metadata = {
      discovery_strategy: strategy,
      personalization_source: personalizationSource,
      history_items_used: profile.historyItemsUsed,
      anchor_count: profile.anchors.length,
      scoring_version: SCORING_VERSION,
      surface: request.surface,
      locale: request.context.locale,
      candidate_source: effectiveCandidateSource,
      provider_breakdown: providerBreakdown,
      candidate_counts: candidateCounts,
      request_latency_ms: latencyMs,
      sort_applied: request.sort,
      brand_scope_applied: request.scope.brand_names,
      category_scope_applied: request.scope.categories,
      query_text: request.query.text,
      has_more: hasMore,
      facets: {
        categories: categoryFacets,
      },
      filter_counts: filterCounts,
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
        providerBreakdown,
        filterCounts,
      });
    }

    const response = {
      status: 'success',
      success: true,
      products: selectedEntries.map((entry) => formatDiscoveryResponseProduct(entry.candidate, request)),
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
      candidateSource: effectiveCandidateSource,
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
      candidate_source: effectiveCandidateSource,
      candidate_counts: candidateCounts,
      provider_breakdown: providerBreakdown,
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
        candidate_source: effectiveCandidateSource,
        candidate_counts: candidateCounts,
        provider_breakdown: providerBreakdown,
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
      candidateSource: effectiveCandidateSource,
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
      candidate_source: effectiveCandidateSource,
      candidate_counts: candidateCounts,
      provider_breakdown: providerBreakdown,
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
    buildBrandScopeAliases,
    buildBeautyPersonalizedQueries,
    buildDiscoveryContextCacheKey,
    buildDiscoveryDatabaseSearchTerms,
    buildDiscoveryInterestQuery,
    buildDiscoveryRecallPlan,
    buildDiscoveryProviderMergeKey,
    buildDiscoverySeededBrowseQuery,
    buildDiscoveryExpansionQuery,
    getDiscoveryProductsSearchApiKey,
    getDiscoveryProductsSearchBaseUrl,
    getDiscoveryPoolCacheTtlMs,
    loadBrandScopedRecommendationFallback,
    matchesQueryTextCandidate,
    matchesBrandScopeCandidate,
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
