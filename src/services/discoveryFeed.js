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
  buildExternalSeedBrandSearchProduct,
} = require('./externalSeedProducts');
const { EXTERNAL_SEED_RECALL_SQL_FIELDS } = require('./externalSeedRecall');
const { classifyBeautyBucketFromText } = require('../findProductsMulti/beautyQueryProfile');
const {
  buildBrandQueryVariants,
  detectBrandEntities,
  normalizeBrandText,
} = require('../findProductsMulti/brandLexicon');
const {
  buildDisplayableProofBadge,
  filterDisplayableMarketSignalBadges,
  normalizeMarketSignalBadges,
  normalizeReviewSummary: normalizeEvidenceReviewSummary,
  pickSurfaceableExternalHighlightSignal,
  normalizeSurfaceText,
} = require('./pivotaEvidenceSignals');
const {
  buildSourceListingRef,
  listLivePdpIdentityRowsForRefs,
} = require('./pdpIdentityGraph');
const {
  buildCatalogServingDoc,
  getCatalogServingIndexConfig,
  isCatalogServingIndexEnabled,
  searchCatalogServingIndex,
} = require('./catalogServingIndex');
const {
  normalizeCardIntroCandidate,
  resolveDisplayableCompactHighlight,
} = require('./pivotaShoppingCard');
const {
  _internals: productGroundingResolverInternals = {},
} = require('./productGroundingResolver');
let productIntelKbStore = null;

const SCORING_VERSION = 'discovery_v2';
const MAX_RECENT_VIEWS = 50;
const MAX_RECENT_QUERIES = 8;
const MAX_ANCHORS = 5;
const MAX_CANDIDATE_FETCH = 120;
const DEFAULT_MAX_BROWSE_CANDIDATE_FETCH = 720;
const DEFAULT_DEBUG_TOP_CANDIDATES = 10;
const PRODUCTS_SEARCH_PAGE_SIZE = 60;
const MAX_PRODUCTS_SEARCH_CALLS = 2;
const DISCOVERY_CURSOR_VERSION = 'pivota.discovery.cursor.v1';
const DISCOVERY_SERVING_CONTRACT_VERSION = 'pivota.discovery.serving.v1';
const DISCOVERY_CURATED_HEAD_LIMIT = 120;
const DEFAULT_DISCOVERY_SERVING_SHADOW_TIMEOUT_MS = 600;
const DISCOVERY_PRODUCTS_SEARCH_PRIMARY_BASE_URL_ENV = 'DISCOVERY_PRODUCTS_SEARCH_BASE_URL';
const DISCOVERY_PRODUCTS_SEARCH_PRIMARY_API_KEY_ENV = 'DISCOVERY_PRODUCTS_SEARCH_API_KEY';
const DISCOVERY_PRODUCTS_SEARCH_FALLBACK_BASE_URL_ENVS = ['PIVOTA_BACKEND_BASE_URL', 'PIVOTA_API_BASE'];
const DISCOVERY_PRODUCTS_SEARCH_FALLBACK_API_KEY_ENVS = [
  'PIVOTA_BACKEND_AGENT_API_KEY',
  'PIVOTA_API_KEY',
  'SHOP_GATEWAY_AGENT_API_KEY',
  'PIVOTA_AGENT_API_KEY',
  'AGENT_API_KEY',
];
const DEFAULT_DISCOVERY_EXTERNAL_SEED_MARKET = 'US';
const DISCOVERY_STEP_TIMEOUT_RESERVE_MS = 150;
const DISCOVERY_STEP_TIMEOUT_MIN_MS = 250;
const DISCOVERY_SCHEMA_PROBE_TTL_MS = 30000;
const DISCOVERY_EXTERNAL_SEED_REQUIRED_INDEXES = [
  'idx_external_product_seeds_recall_title_trgm',
  'idx_external_product_seeds_recall_summary_trgm',
  'idx_external_product_seeds_recall_category_vertical_recency',
  'idx_external_product_seeds_recall_vertical_recency',
  'idx_external_product_seeds_recall_ingredient_tokens_trgm',
  'idx_external_product_seeds_recall_alias_tokens_trgm',
];
const DISCOVERY_EXTERNAL_SEED_INDEXED_RECALL_CATEGORY_SQL =
  "lower(coalesce(seed_data->'derived'->'recall'->>'category', ''))";
const DISCOVERY_PROVIDER_ORDER = [
  'beauty_interest_mainline',
  'products_search',
  'internal_catalog',
  'external_seeds',
];
const VALID_SURFACES = new Set(['home_hot_deals', 'browse_products']);
const VALID_DISCOVERY_RESPONSE_DETAILS = new Set(['full', 'card']);
const VALID_DISCOVERY_SERVING_MODES = new Set(['curated_head', 'exhaustive']);
const VALID_AUTH_STATES = new Set(['authenticated', 'anonymous']);
const VALID_DISCOVERY_SORTS = new Set(['popular', 'price_desc', 'price_asc']);
const SELLABLE_PRODUCT_STATUS_VALUES = ['active', 'published', 'online', 'live', 'enabled', 'available'];
const HOME_INTEREST_RECALL_LIMIT = 24;
const HOME_BROWSE_FILL_LIMIT = 24;
const HOME_MIN_BROWSE_FILL_LIMIT = 16;
const COLD_START_PRIMARY_RECALL_LIMIT = 24;
const COLD_START_FILL_RECALL_LIMIT = 24;
const BROWSE_PRIMARY_RECALL_LIMIT = 24;
const BROWSE_FILL_RECALL_LIMIT = 24;
const BRAND_RECOMMENDATION_FALLBACK_LIMIT = 12;
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
const normalizeResolverLookupText =
  typeof productGroundingResolverInternals.normalizeTextForResolver === 'function'
    ? productGroundingResolverInternals.normalizeTextForResolver
    : (value) => String(value || '').trim().toLowerCase();
const tokenizeResolverLookupQuery =
  typeof productGroundingResolverInternals.tokenizeNormalizedResolverQuery === 'function'
    ? productGroundingResolverInternals.tokenizeNormalizedResolverQuery
    : (value) =>
        String(value || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
const DISCOVERY_EXACT_TITLE_FORM_FACTOR_TOKENS = new Set([
  'serum',
  'essence',
  'ampoule',
  'toner',
  'tonic',
  'lotion',
  'cleanser',
  'cleanse',
  'wash',
  'cream',
  'moisturizer',
  'moisturiser',
  'mask',
  'balm',
  'oil',
  'sunscreen',
  'sunblock',
  'gel',
  'mist',
  'treatment',
]);
const DISCOVERY_EXACT_TITLE_GENERIC_TOKENS = new Set([
  'face',
  'facial',
  'skin',
  'skincare',
  'care',
  'body',
  'eye',
  'hand',
  'travel',
  'size',
  'jumbo',
  'mini',
  'daily',
  'gentle',
  'repair',
  'hydrating',
  'hydration',
  'barrier',
  'foam',
  'foaming',
  'with',
  'and',
  'plus',
  'default',
  'title',
  ...DISCOVERY_EXACT_TITLE_FORM_FACTOR_TOKENS,
]);
const BEAUTY_INTEREST_SKINCARE_HINT_TOKENS = new Set([
  'skincare',
  'skin',
  'serum',
  'toner',
  'cleanser',
  'moisturizer',
  'moisturiser',
  'cream',
  'lotion',
  'essence',
  'ampoule',
  'treatment',
  'sunscreen',
  'spf',
  'niacinamide',
  'vitamin',
  'barrier',
  'repair',
  'retinol',
  'peptide',
  'peptides',
  'ceramide',
  'ceramides',
  'salicylic',
  'hyaluronic',
  'hydrating',
  'hydration',
  'brightening',
]);
const BEAUTY_INTEREST_CATEGORY_BY_TOKEN = Object.freeze({
  serum: ['serum', 'skincare'],
  essence: ['essence', 'serum', 'skincare'],
  ampoule: ['ampoule', 'serum', 'skincare'],
  toner: ['toner', 'skincare'],
  mist: ['toner', 'skincare'],
  cleanser: ['cleanser', 'skincare'],
  cleansing: ['cleanser', 'skincare'],
  wash: ['cleanser', 'skincare'],
  moisturizer: ['moisturizer', 'cream', 'skincare'],
  moisturiser: ['moisturizer', 'cream', 'skincare'],
  cream: ['cream', 'moisturizer', 'skincare'],
  lotion: ['lotion', 'moisturizer', 'skincare'],
  treatment: ['treatment', 'skincare'],
  sunscreen: ['sunscreen', 'skincare'],
  spf: ['sunscreen', 'skincare'],
  niacinamide: ['serum', 'treatment', 'skincare'],
  retinol: ['serum', 'treatment', 'skincare'],
  peptide: ['serum', 'treatment', 'skincare'],
  peptides: ['serum', 'treatment', 'skincare'],
  ceramide: ['cream', 'moisturizer', 'skincare'],
  ceramides: ['cream', 'moisturizer', 'skincare'],
  barrier: ['cream', 'moisturizer', 'treatment', 'skincare'],
  repair: ['treatment', 'serum', 'skincare'],
  salicylic: ['treatment', 'serum', 'skincare'],
  hyaluronic: ['serum', 'skincare'],
  vitamin: ['serum', 'treatment', 'skincare'],
  brightening: ['serum', 'treatment', 'skincare'],
  hydrating: ['serum', 'moisturizer', 'skincare'],
  hydration: ['serum', 'moisturizer', 'skincare'],
  lip: ['lip balm', 'lipstick', 'makeup'],
  lipstick: ['lipstick', 'makeup'],
  gloss: ['lipstick', 'makeup'],
  mascara: ['mascara', 'makeup'],
  concealer: ['concealer', 'makeup'],
  foundation: ['foundation', 'makeup'],
  powder: ['powder', 'makeup'],
  fragrance: ['fragrance'],
  perfume: ['fragrance'],
  shampoo: ['shampoo', 'hair care'],
  conditioner: ['conditioner', 'hair care'],
  hair: ['hair care'],
});
const BEAUTY_INTEREST_CATEGORY_BY_PHRASE = Object.freeze({
  'hair oil': {
    categories: ['hair oil', 'hair treatment', 'hair care', 'haircare'],
    verticals: ['haircare'],
  },
  'haircare': {
    categories: ['hair care', 'haircare'],
    verticals: ['haircare'],
  },
  'hair care': {
    categories: ['hair care', 'haircare'],
    verticals: ['haircare'],
  },
  'lip balm': {
    categories: ['lip balm', 'lip treatment', 'lip care', 'lip oil', 'makeup'],
    verticals: ['makeup'],
  },
  'lip oil': {
    categories: ['lip oil', 'lip balm', 'lip treatment', 'makeup'],
    verticals: ['makeup'],
  },
});
const EXPLICIT_BEAUTY_COMPOUND_INTENT_RULES = Object.freeze({
  hair_oil: Object.freeze({
    id: 'hair_oil',
    label: 'hair oil',
    phrases: ['hair oil'],
    primaryPositive: ['hair oil'],
    weakPositive: ['hair treatment', 'hair care', 'haircare'],
    verticals: ['haircare'],
    conjunctionTokens: ['hair', 'oil'],
    positiveTitleTokens: ['oil', 'huile'],
    suppressedTokenCategories: ['hair', 'oil'],
    negativeClasses: [
      'shampoo',
      'conditioner',
      'moisturizer',
      'moisturiser',
      'cream',
      'toner',
      'mist',
      'fragrance',
      'fragrance mist',
      'hair styling',
      'styling',
      'clip',
      'clips',
      'pin',
      'pins',
      'scrunchie',
      'scrunchies',
      'brush',
      'comb',
      'accessory',
      'accessories',
    ],
  }),
  lip_balm: Object.freeze({
    id: 'lip_balm',
    label: 'lip balm',
    phrases: ['lip balm'],
    primaryPositive: ['lip balm'],
    weakPositive: ['lip treatment', 'lip care'],
    verticals: ['makeup'],
    conjunctionTokens: ['lip', 'balm'],
    positiveTitleTokens: ['balm'],
    suppressedTokenCategories: ['lip', 'balm'],
    negativeClasses: [
      'lipstick',
      'mascara',
      'foundation',
      'fragrance',
      'brush',
      'clip',
      'pins',
      'giftset',
      'gift set',
      'set',
      'kit',
      'bundle',
      'duo',
      'trio',
      'routine',
      'essentials',
      'pr box',
      'box',
      'bag',
      'pouch',
      'keychain',
    ],
  }),
  lip_oil: Object.freeze({
    id: 'lip_oil',
    label: 'lip oil',
    phrases: ['lip oil'],
    primaryPositive: ['lip oil'],
    weakPositive: ['lip treatment', 'lip care'],
    verticals: ['makeup'],
    conjunctionTokens: ['lip', 'oil'],
    positiveTitleTokens: ['oil'],
    suppressedTokenCategories: ['lip', 'oil'],
    negativeClasses: [
      'lipstick',
      'mascara',
      'foundation',
      'fragrance',
      'brush',
      'clip',
      'pins',
      'giftset',
      'gift set',
      'set',
      'kit',
      'bundle',
      'duo',
      'trio',
      'routine',
      'essentials',
      'pr box',
      'box',
      'bag',
      'pouch',
      'keychain',
    ],
  }),
});
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
const browseCatalogCountCache = new Map();
const discoveryDbDependencyProbeCache = {
  value: null,
  expiresAt: 0,
  pending: null,
};

class DiscoveryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DiscoveryValidationError';
    this.statusCode = 400;
    this.code = 'INVALID_DISCOVERY_REQUEST';
  }
}

class DiscoveryCatalogUnavailableError extends Error {
  constructor(message = 'Discovery catalog is unavailable', details = null) {
    super(message);
    this.name = 'DiscoveryCatalogUnavailableError';
    this.statusCode = 503;
    this.code = 'DISCOVERY_CATALOG_UNAVAILABLE';
    this.details =
      details && typeof details === 'object' && !Array.isArray(details)
        ? details
        : {};
  }
}

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function getDiscoveryCandidateFetchCap(request) {
  if (request?.surface !== 'browse_products') return MAX_CANDIDATE_FETCH;
  return clampInt(
    process.env.DISCOVERY_BROWSE_MAX_CANDIDATE_FETCH,
    DEFAULT_MAX_BROWSE_CANDIDATE_FETCH,
    MAX_CANDIDATE_FETCH,
    2400,
  );
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

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

function pickConfiguredEnvValue(primaryEnv, fallbackEnvs = [], normalize = (value) => String(value || '').trim()) {
  const primaryValue = normalize(process.env[primaryEnv]);
  if (primaryValue) {
    return {
      value: primaryValue,
      source: primaryEnv,
      usesLegacyFallback: false,
      configured: true,
    };
  }
  for (const envName of Array.isArray(fallbackEnvs) ? fallbackEnvs : []) {
    const fallbackValue = normalize(process.env[envName]);
    if (!fallbackValue) continue;
    return {
      value: fallbackValue,
      source: envName,
      usesLegacyFallback: true,
      configured: true,
    };
  }
  return {
    value: normalize(''),
    source: null,
    usesLegacyFallback: false,
    configured: false,
  };
}

function resolveDiscoveryProductsSearchBaseUrlConfig() {
  return pickConfiguredEnvValue(
    DISCOVERY_PRODUCTS_SEARCH_PRIMARY_BASE_URL_ENV,
    DISCOVERY_PRODUCTS_SEARCH_FALLBACK_BASE_URL_ENVS,
    normalizeBaseUrl,
  );
}

function getDiscoveryProductsSearchBaseUrl() {
  return resolveDiscoveryProductsSearchBaseUrlConfig().value;
}

function resolveDiscoveryProductsSearchApiKeyConfig() {
  return pickConfiguredEnvValue(
    DISCOVERY_PRODUCTS_SEARCH_PRIMARY_API_KEY_ENV,
    DISCOVERY_PRODUCTS_SEARCH_FALLBACK_API_KEY_ENVS,
    (value) => String(value || '').trim(),
  );
}

function getDiscoveryProductsSearchApiKey() {
  return resolveDiscoveryProductsSearchApiKeyConfig().value;
}

function getDiscoveryProductsSearchTimeoutMs() {
  return clampInt(process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS, 6500, 1000, 20000);
}

function getDiscoveryRecallBudgetMs() {
  return clampInt(process.env.DISCOVERY_RECALL_BUDGET_MS, 1800, 500, 10000);
}

function resolveDiscoveryExternalSeedMarketConfig() {
  const configured = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || '')
    .trim()
    .toUpperCase();
  if (configured) {
    return {
      market: configured,
      source: 'CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET',
      isDefault: false,
    };
  }
  return {
    market: DEFAULT_DISCOVERY_EXTERNAL_SEED_MARKET,
    source: 'default',
    isDefault: true,
  };
}

function computeDiscoveryStepTimeoutMs(remainingBudgetMs, providerTimeoutMs = getDiscoveryProductsSearchTimeoutMs()) {
  const configuredTimeout = clampInt(providerTimeoutMs, getDiscoveryProductsSearchTimeoutMs(), 250, 20000);
  const numericRemaining = Number(remainingBudgetMs);
  if (!Number.isFinite(numericRemaining)) return configuredTimeout;
  const cappedBudget = Math.max(0, Math.floor(numericRemaining) - DISCOVERY_STEP_TIMEOUT_RESERVE_MS);
  if (cappedBudget <= 0) return 0;
  return Math.min(configuredTimeout, Math.max(DISCOVERY_STEP_TIMEOUT_MIN_MS, cappedBudget));
}

function classifyDiscoveryHttpFailure(status) {
  const numericStatus = Number(status || 0);
  if (numericStatus === 401) return 'http_401';
  if (numericStatus === 403) return 'http_403';
  if (numericStatus >= 500) return 'http_5xx';
  if (numericStatus >= 400) return 'http_4xx';
  return 'provider_error';
}

function classifyDiscoveryQueryError(err) {
  const code = String(err?.code || '').trim().toUpperCase();
  if (code === 'NO_DATABASE') return 'missing_database';
  if (code === '42P01' || code === '42703') return 'schema_missing';
  return 'query_error';
}

function hasRequiredColumns(columnsMap, tableName, requiredColumns = []) {
  const present = columnsMap.get(String(tableName || '').trim()) || new Set();
  const missingColumns = requiredColumns.filter((column) => !present.has(String(column || '').trim()));
  return {
    ready: missingColumns.length === 0,
    missingColumns,
  };
}

async function probeDiscoveryDatabaseDependencies({ force = false, queryFn = query } = {}) {
  const now = Date.now();
  if (!force && discoveryDbDependencyProbeCache.value && discoveryDbDependencyProbeCache.expiresAt > now) {
    return discoveryDbDependencyProbeCache.value;
  }
  if (!force && discoveryDbDependencyProbeCache.pending) {
    return discoveryDbDependencyProbeCache.pending;
  }

  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  if (!databaseConfigured) {
    const snapshot = {
      database_configured: false,
      ok: false,
      code: 'missing_database',
      internal_catalog: {
        ready: false,
        code: 'missing_database',
        missing_tables: ['products_cache'],
        missing_columns: [],
      },
      external_seeds: {
        ready: false,
        code: 'missing_database',
        missing_tables: ['external_product_seeds'],
        missing_columns: [],
        missing_indexes: [],
        warnings: [],
      },
      beauty_interest_mainline: {
        ready: false,
        code: 'missing_database',
        missing_tables: ['external_product_seeds'],
        missing_columns: [],
        missing_indexes: [],
        warnings: [],
      },
    };
    discoveryDbDependencyProbeCache.value = snapshot;
    discoveryDbDependencyProbeCache.expiresAt = now + DISCOVERY_SCHEMA_PROBE_TTL_MS;
    return snapshot;
  }

  discoveryDbDependencyProbeCache.pending = (async () => {
    try {
      const [columnsResult, indexesResult] = await Promise.all([
        queryFn(
          `
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = ANY(current_schemas(false))
              AND table_name = ANY($1::text[])
          `,
          [['products_cache', 'external_product_seeds']],
        ),
        queryFn(
          `
            SELECT tablename, indexname
            FROM pg_indexes
            WHERE schemaname = ANY(current_schemas(false))
              AND tablename = ANY($1::text[])
          `,
          [['external_product_seeds']],
        ),
      ]);

      const columnsMap = new Map();
      for (const row of Array.isArray(columnsResult?.rows) ? columnsResult.rows : []) {
        const tableName = String(row?.table_name || '').trim();
        const columnName = String(row?.column_name || '').trim();
        if (!tableName || !columnName) continue;
        if (!columnsMap.has(tableName)) columnsMap.set(tableName, new Set());
        columnsMap.get(tableName).add(columnName);
      }

      const indexNames = new Set(
        (Array.isArray(indexesResult?.rows) ? indexesResult.rows : [])
          .map((row) => String(row?.indexname || '').trim())
          .filter(Boolean),
      );

      const internalColumns = hasRequiredColumns(columnsMap, 'products_cache', [
        'id',
        'merchant_id',
        'product_data',
        'expires_at',
        'cached_at',
      ]);
      const externalColumns = hasRequiredColumns(columnsMap, 'external_product_seeds', [
        'id',
        'external_product_id',
        'destination_url',
        'canonical_url',
        'title',
        'seed_data',
        'market',
        'tool',
        'status',
        'attached_product_key',
        'updated_at',
        'created_at',
      ]);
      const missingIndexes = DISCOVERY_EXTERNAL_SEED_REQUIRED_INDEXES.filter(
        (indexName) => !indexNames.has(indexName),
      );
      const externalWarnings = missingIndexes.length > 0 ? ['missing_recall_indexes'] : [];

      const snapshot = {
        database_configured: true,
        ok: internalColumns.ready && externalColumns.ready,
        code: internalColumns.ready && externalColumns.ready ? null : 'schema_missing',
        internal_catalog: {
          ready: internalColumns.ready,
          code: internalColumns.ready ? null : 'schema_missing',
          missing_tables: columnsMap.has('products_cache') ? [] : ['products_cache'],
          missing_columns: internalColumns.missingColumns,
        },
        external_seeds: {
          ready: externalColumns.ready,
          code: externalColumns.ready ? null : 'schema_missing',
          missing_tables: columnsMap.has('external_product_seeds') ? [] : ['external_product_seeds'],
          missing_columns: externalColumns.missingColumns,
          missing_indexes: missingIndexes,
          warnings: externalWarnings,
        },
        beauty_interest_mainline: {
          ready: externalColumns.ready,
          code: externalColumns.ready ? null : 'schema_missing',
          missing_tables: columnsMap.has('external_product_seeds') ? [] : ['external_product_seeds'],
          missing_columns: externalColumns.missingColumns,
          missing_indexes: missingIndexes,
          warnings: externalWarnings,
        },
      };
      discoveryDbDependencyProbeCache.value = snapshot;
      discoveryDbDependencyProbeCache.expiresAt = Date.now() + DISCOVERY_SCHEMA_PROBE_TTL_MS;
      return snapshot;
    } catch (err) {
      const code = classifyDiscoveryQueryError(err);
      const snapshot = {
        database_configured: true,
        ok: false,
        code,
        internal_catalog: {
          ready: false,
          code,
          missing_tables: [],
          missing_columns: [],
          error: err?.message || String(err),
        },
        external_seeds: {
          ready: false,
          code,
          missing_tables: [],
          missing_columns: [],
          missing_indexes: [],
          warnings: [],
          error: err?.message || String(err),
        },
        beauty_interest_mainline: {
          ready: false,
          code,
          missing_tables: [],
          missing_columns: [],
          missing_indexes: [],
          warnings: [],
          error: err?.message || String(err),
        },
      };
      discoveryDbDependencyProbeCache.value = snapshot;
      discoveryDbDependencyProbeCache.expiresAt = Date.now() + DISCOVERY_SCHEMA_PROBE_TTL_MS;
      return snapshot;
    } finally {
      discoveryDbDependencyProbeCache.pending = null;
    }
  })();

  return discoveryDbDependencyProbeCache.pending;
}

async function getDiscoveryProviderDatabaseState(providerName, options = {}) {
  const snapshot = await probeDiscoveryDatabaseDependencies(options);
  const provider = String(providerName || '').trim();
  if (provider === 'internal_catalog') return snapshot.internal_catalog;
  if (provider === 'external_seeds') return snapshot.external_seeds;
  if (provider === 'beauty_interest_mainline') return snapshot.beauty_interest_mainline;
  return null;
}

async function getDiscoveryHealthSnapshot(options = {}) {
  const baseUrlConfig = resolveDiscoveryProductsSearchBaseUrlConfig();
  const apiKeyConfig = resolveDiscoveryProductsSearchApiKeyConfig();
  const marketConfig = resolveDiscoveryExternalSeedMarketConfig();
  const databaseSnapshot = await probeDiscoveryDatabaseDependencies(options);
  const productsSearchReady = Boolean(baseUrlConfig.configured && apiKeyConfig.configured);
  const dbBackedProvidersReady = Boolean(
    databaseSnapshot?.internal_catalog?.ready && databaseSnapshot?.external_seeds?.ready,
  );
  const singleProviderMode = productsSearchReady && !dbBackedProvidersReady;

  return {
    products_search_ready: productsSearchReady,
    db_backed_providers_ready: dbBackedProvidersReady,
    single_provider_mode: singleProviderMode,
    discovery_ready: productsSearchReady && dbBackedProvidersReady,
    products_search: {
      base_url_configured: baseUrlConfig.configured,
      api_key_configured: apiKeyConfig.configured,
      base_url_source: baseUrlConfig.source,
      api_key_source: apiKeyConfig.source,
      legacy_base_url_fallback: baseUrlConfig.usesLegacyFallback,
      legacy_api_key_fallback: apiKeyConfig.usesLegacyFallback,
      timeout_ms: getDiscoveryProductsSearchTimeoutMs(),
      recall_budget_ms: getDiscoveryRecallBudgetMs(),
      degraded: baseUrlConfig.usesLegacyFallback || apiKeyConfig.usesLegacyFallback,
    },
    db_backed_providers: {
      database_configured: Boolean(databaseSnapshot?.database_configured),
      code: databaseSnapshot?.code || null,
      internal_catalog: databaseSnapshot?.internal_catalog || null,
      external_seeds: databaseSnapshot?.external_seeds || null,
      beauty_interest_mainline: databaseSnapshot?.beauty_interest_mainline || null,
    },
    market: {
      value: marketConfig.market,
      source: marketConfig.source,
      is_default: marketConfig.isDefault,
    },
  };
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

function buildDiscoveryLikePatternsFromTerms(phrases = [], tokens = [], { phraseOnlyForMultiword = false } = {}) {
  const phrasePatterns = [];
  const tokenPatterns = [];
  let hasMultiwordPhrase = false;

  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const normalized = normalizeText(phrase || '');
    if (!normalized || normalized.length < 3) continue;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length > 1) hasMultiwordPhrase = true;
    phrasePatterns.push(`%${normalized}%`);
    if (words.length > 1) {
      phrasePatterns.push(`%${words.join('%')}%`);
    }
  }

  for (const token of Array.isArray(tokens) ? tokens : []) {
    const normalized = normalizeText(token || '');
    if (!normalized || normalized.length < 3) continue;
    tokenPatterns.push(`%${normalized}%`);
  }

  return uniqStrings(
    phraseOnlyForMultiword && hasMultiwordPhrase
      ? phrasePatterns
      : phrasePatterns.concat(tokenPatterns),
    16,
  );
}

function resolveBeautyInterestPhraseHint(phrase) {
  const normalized = normalizeText(phrase || '');
  if (!normalized) return { categories: [], verticals: [] };
  const compoundIntent = resolveExplicitBeautyCompoundIntent(normalized);
  const compoundRule = compoundIntent ? EXPLICIT_BEAUTY_COMPOUND_INTENT_RULES[compoundIntent] : null;
  if (compoundRule) {
    return {
      categories: [...compoundRule.primaryPositive, ...compoundRule.weakPositive],
      primaryCategories: compoundRule.primaryPositive,
      weakCategories: compoundRule.weakPositive,
      verticals: compoundRule.verticals,
      compoundIntent,
    };
  }
  const exactHint = BEAUTY_INTEREST_CATEGORY_BY_PHRASE[normalized];
  if (exactHint) return exactHint;

  const tokens = new Set(tokenizeDiscoverySearchText(normalized));
  if (tokens.has('hair') && tokens.has('oil')) {
    return BEAUTY_INTEREST_CATEGORY_BY_PHRASE['hair oil'];
  }
  if (tokens.has('lip') && tokens.has('balm')) {
    return BEAUTY_INTEREST_CATEGORY_BY_PHRASE['lip balm'];
  }
  if (tokens.has('lip') && tokens.has('oil')) {
    return BEAUTY_INTEREST_CATEGORY_BY_PHRASE['lip oil'];
  }
  return { categories: [], verticals: [] };
}

function resolveExplicitBeautyCompoundIntent(queryText) {
  const normalized = normalizeText(queryText || '');
  if (!normalized) return null;
  const tokens = new Set(tokenizeDiscoverySearchText(normalized));
  if (normalized === 'hair oil' || (tokens.has('hair') && tokens.has('oil'))) return 'hair_oil';
  if (normalized === 'lip balm' || (tokens.has('lip') && tokens.has('balm'))) return 'lip_balm';
  if (normalized === 'lip oil' || (tokens.has('lip') && tokens.has('oil'))) return 'lip_oil';
  return null;
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

function buildSellableStatusPredicate(statusExpr) {
  const expr = `lower(coalesce(${statusExpr}, ''))`;
  const allowed = SELLABLE_PRODUCT_STATUS_VALUES.map((value) => `'${value}'`).join(', ');
  return `(${expr} = '' OR ${expr} IN (${allowed}))`;
}

function getDiscoveryBrowseCatalogCountCacheTtlMs() {
  return clampInt(process.env.DISCOVERY_BROWSE_COUNT_CACHE_TTL_MS, 60000, 1000, 300000);
}

function buildDiscoveryBrowseCatalogCountCacheKey(request, { market = '' } = {}) {
  return JSON.stringify({
    surface: request?.surface || 'unknown',
    market: String(market || '').trim().toUpperCase(),
    scope: {
      brand_aliases: buildBrandScopeAliases(request?.scope?.brand_names || []),
      categories: normalizeDiscoveryCategories(request?.scope?.categories, 12),
    },
    query: {
      text: String(request?.query?.text || '').trim().toLowerCase().replace(/\s+/g, ' '),
    },
  });
}

function readBrowseCatalogCountCache(cacheKey) {
  const entry = browseCatalogCountCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    browseCatalogCountCache.delete(cacheKey);
    return null;
  }
  return entry.value || null;
}

function writeBrowseCatalogCountCache(cacheKey, value) {
  browseCatalogCountCache.set(cacheKey, {
    value,
    storedAt: Date.now(),
    expiresAt: Date.now() + getDiscoveryBrowseCatalogCountCacheTtlMs(),
  });
  if (browseCatalogCountCache.size > 100) {
    const oldestKey = Array.from(browseCatalogCountCache.entries()).sort((a, b) => a[1].storedAt - b[1].storedAt)[0]?.[0];
    if (oldestKey) browseCatalogCountCache.delete(oldestKey);
  }
}

function buildStableBrowseCatalogCountQuery(request, { includeIdentityJoin = true } = {}) {
  const marketConfig = resolveDiscoveryExternalSeedMarketConfig();
  const market = marketConfig.market;
  const tool = 'creator_agents';
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const marketBind = bind(market);
  const toolBind = bind(tool);
  const normalizedCategories = normalizeDiscoveryCategories(request?.scope?.categories, 12);
  const brandAliases = buildBrandScopeAliases(request?.scope?.brand_names || []);
  const brandCompacts = uniqStrings(
    brandAliases.map((value) => compactBrandToken(value)).filter(Boolean),
    12,
  );
  const brandPatterns = uniqStrings(
    brandAliases
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .map((value) => `%${value}%`),
    12,
  );
  const rawQueryText = String(request?.query?.text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const queryTerms = buildDiscoveryDatabaseSearchTerms(rawQueryText ? [rawQueryText] : [], {
    maxPhrases: 4,
    maxTokens: 8,
  });
  const filteredClauses = ['TRUE'];

  if (brandCompacts.length > 0 || brandPatterns.length > 0) {
    const brandClauses = [];
    if (brandCompacts.length > 0) {
      brandClauses.push(`brand_compact = ANY(${bind(brandCompacts)}::text[])`);
    }
    if (brandPatterns.length > 0) {
      brandClauses.push(`search_text LIKE ANY(${bind(brandPatterns)}::text[])`);
    }
    filteredClauses.push(`(${brandClauses.join(' OR ')})`);
  }

  if (normalizedCategories.length > 0) {
    filteredClauses.push(`category_text = ANY(${bind(normalizedCategories)}::text[])`);
  }

  if (rawQueryText) {
    const queryClauses = [`search_text LIKE ${bind(`%${rawQueryText}%`)}`];
    if (queryTerms.phrases.length > 0) {
      const phrasesBind = bind(queryTerms.phrases);
      queryClauses.push(
        `(SELECT count(*)::int FROM unnest(${phrasesBind}::text[]) phrase WHERE phrase <> '' AND search_text LIKE '%' || phrase || '%') > 0`,
      );
    }
    if (queryTerms.tokens.length > 0) {
      const tokensBind = bind(queryTerms.tokens);
      const minTokenHitsBind = bind(Math.max(1, Math.ceil(queryTerms.tokens.length * 0.6)));
      queryClauses.push(
        `(SELECT count(*)::int FROM unnest(${tokensBind}::text[]) token WHERE token <> '' AND search_text LIKE '%' || token || '%') >= ${minTokenHitsBind}`,
      );
    }
    filteredClauses.push(`(${queryClauses.join(' OR ')})`);
  }

  const internalListingIdExpr = `
    coalesce(
      nullif(pc.product_data->>'product_id', ''),
      nullif(pc.product_data->>'id', ''),
      nullif(pc.platform_product_id, '')
    )
  `;
  const internalBrandTextExpr = `
    lower(trim(coalesce(
      pc.product_data #>> '{brand,name}',
      pc.product_data->>'brand',
      pc.product_data->>'brand_name',
      pc.product_data->>'vendor',
      pc.product_data->>'vendor_name',
      pc.product_data->>'manufacturer',
      ''
    )))
  `;
  const internalCategoryExpr = `
    lower(trim(coalesce(
      pc.product_data->>'product_type',
      pc.product_data->>'productType',
      pc.product_data->>'category',
      pc.product_data->>'category_name',
      ''
    )))
  `;
  const internalSearchTextExpr = `
    lower(concat_ws(' ',
      coalesce(pc.product_data->>'title', ''),
      coalesce(pc.product_data->>'name', ''),
      coalesce(pc.product_data->>'description', ''),
      coalesce(pc.product_data #>> '{brand,name}', ''),
      coalesce(pc.product_data->>'brand', ''),
      coalesce(pc.product_data->>'brand_name', ''),
      coalesce(pc.product_data->>'vendor', ''),
      coalesce(pc.product_data->>'vendor_name', ''),
      coalesce(pc.product_data->>'manufacturer', ''),
      coalesce(pc.product_data->>'category', ''),
      coalesce(pc.product_data->>'product_type', '')
    ))
  `;
  const externalListingIdExpr = `
    coalesce(
      nullif(eps.external_product_id, ''),
      nullif(eps.seed_data->>'external_product_id', ''),
      nullif(eps.seed_data->>'product_id', ''),
      nullif(eps.canonical_url, ''),
      nullif(eps.destination_url, ''),
      concat('row:', eps.id::text)
    )
  `;
  const externalSearchTextExpr = `
    lower(concat_ws(' ',
      coalesce(eps.seed_data->'derived'->'recall'->>'retrieval_title', ''),
      coalesce(eps.seed_data->'derived'->'recall'->>'retrieval_summary', ''),
      coalesce(eps.title, ''),
      coalesce(eps.seed_data->>'title', ''),
      coalesce(eps.seed_data->>'description', ''),
      coalesce(eps.seed_data->'snapshot'->>'description', ''),
      coalesce(eps.seed_data->>'brand', ''),
      coalesce(eps.seed_data->>'brand_name', ''),
      coalesce(eps.seed_data->>'vendor', ''),
      coalesce(eps.seed_data->>'vendor_name', ''),
      coalesce(eps.seed_data->>'category', ''),
      coalesce(eps.seed_data->'snapshot'->>'category', ''),
      coalesce(eps.seed_data->>'product_type', ''),
      coalesce(eps.seed_data->'snapshot'->>'product_type', '')
    ))
  `;

  const dedupeExpr = includeIdentityJoin
    ? `coalesce('sellable:' || pil.sellable_item_group_id, 'source:' || filtered.source_listing_ref)`
    : `'source:' || filtered.source_listing_ref`;
  const identityJoinSql = includeIdentityJoin
    ? `
      LEFT JOIN pdp_identity_listing pil
        ON pil.source_listing_ref = filtered.source_listing_ref
       AND pil.identity_status = 'approved'
       AND pil.live_read_enabled = true
    `
    : '';

  return {
    market,
    params,
    sql: `
      WITH internal_source AS (
        SELECT DISTINCT ON (pc.merchant_id, ${internalListingIdExpr})
          pc.merchant_id,
          ${internalListingIdExpr} AS product_id,
          pc.merchant_id || ':' || ${internalListingIdExpr} AS source_listing_ref,
          regexp_replace(${internalBrandTextExpr}, '[^a-z0-9]+', '', 'g') AS brand_compact,
          ${internalCategoryExpr} AS category_text,
          ${internalSearchTextExpr} AS search_text
        FROM products_cache pc
        JOIN merchant_onboarding mo
          ON mo.merchant_id = pc.merchant_id
        WHERE (pc.expires_at IS NULL OR pc.expires_at > now())
          AND ${buildSellableStatusPredicate("pc.product_data->>'status'")}
          AND COALESCE(lower(pc.product_data->>'orderable'), 'true') <> 'false'
          AND mo.status NOT IN ('deleted', 'rejected')
          AND mo.psp_connected = true
          AND ${internalListingIdExpr} IS NOT NULL
        ORDER BY
          pc.merchant_id,
          ${internalListingIdExpr},
          pc.cached_at DESC NULLS LAST,
          pc.id DESC
      ),
      external_source AS (
        SELECT DISTINCT ON (${externalListingIdExpr})
          '${EXTERNAL_SEED_MERCHANT_ID}'::text AS merchant_id,
          ${externalListingIdExpr} AS product_id,
          '${EXTERNAL_SEED_MERCHANT_ID}'::text || ':' || ${externalListingIdExpr} AS source_listing_ref,
          regexp_replace(${EXTERNAL_SEED_RECALL_SQL_FIELDS.brand}, '[^a-z0-9]+', '', 'g') AS brand_compact,
          trim(${EXTERNAL_SEED_RECALL_SQL_FIELDS.category}) AS category_text,
          ${externalSearchTextExpr} AS search_text
        FROM external_product_seeds eps
        WHERE eps.status = 'active'
          AND eps.attached_product_key IS NULL
          AND eps.market = ${marketBind}
          AND (eps.tool = '*' OR eps.tool = ${toolBind})
          AND coalesce(lower(eps.seed_data#>>'{suppression_flags,exclude_from_recall}'), 'false') <> 'true'
          AND coalesce(lower(eps.seed_data#>>'{derived,recall,suppression_flags,exclude_from_recall}'), 'false') <> 'true'
          AND ${externalListingIdExpr} IS NOT NULL
        ORDER BY
          ${externalListingIdExpr},
          eps.updated_at DESC NULLS LAST,
          eps.created_at DESC NULLS LAST,
          eps.id DESC
      ),
      corpus_source AS (
        SELECT * FROM internal_source
        UNION ALL
        SELECT * FROM external_source
      ),
      filtered AS (
        SELECT *
        FROM corpus_source
        WHERE ${filteredClauses.join('\n          AND ')}
      )
      SELECT COUNT(DISTINCT ${dedupeExpr})::int AS total
      FROM filtered
      ${identityJoinSql}
    `,
  };
}

async function countStableBrowseCatalogTotal(request, { queryFn = query, useCache = true } = {}) {
  if (!request || request.surface !== 'browse_products' || typeof queryFn !== 'function' || !process.env.DATABASE_URL) {
    return null;
  }

  const { market } = resolveDiscoveryExternalSeedMarketConfig();
  const cacheEnabled = useCache !== false && queryFn === query;
  const cacheKey = buildDiscoveryBrowseCatalogCountCacheKey(request, { market });
  if (cacheEnabled) {
    const cached = readBrowseCatalogCountCache(cacheKey);
    if (cached) return cached;
  }

  const attempts = [true, false];
  let lastError = null;
  for (const includeIdentityJoin of attempts) {
    const statement = buildStableBrowseCatalogCountQuery(request, { includeIdentityJoin });
    try {
      const result = await queryFn(statement.sql, statement.params);
      const total = Math.max(0, Number(result?.rows?.[0]?.total || 0) || 0);
      const output = {
        total,
        source: includeIdentityJoin ? 'stable_catalog_identity_grouped' : 'stable_catalog_source_listing',
      };
      if (cacheEnabled) writeBrowseCatalogCountCache(cacheKey, output);
      return output;
    } catch (err) {
      lastError = err;
      const failureReason = classifyDiscoveryQueryError(err);
      if (includeIdentityJoin && failureReason === 'schema_missing') {
        continue;
      }
      break;
    }
  }

  logger.warn(
    {
      err: lastError?.message || String(lastError),
      surface: request?.surface,
      scope: request?.scope || null,
      query_text: request?.query?.text || '',
    },
    'stable browse catalog count failed; falling back to runtime corpus size',
  );
  return null;
}

function shouldUseStableBrowseCatalogTotal(request) {
  if (!request || request.surface !== 'browse_products') return false;
  // Public /products?q= already has a bounded recall pool and cursor. The
  // stable total query scans broad JSON text and can dominate live latency.
  if (isExplicitQueryScopedBrowseRequest(request)) return false;
  return true;
}

function resolveBrandDirectCandidateLimit(request, limit) {
  const safeLimit = clampInt(
    limit,
    resolveDiscoveryCandidateLimit(request),
    24,
    getDiscoveryCandidateFetchCap(request),
  );
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

function encodeDiscoveryCursorPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeDiscoveryCursorPayload(raw) {
  const normalized = String(raw || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized) return null;
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function buildDiscoveryCursorContextSignature(request = {}) {
  return JSON.stringify({
    surface: String(request?.surface || '').trim() || 'unknown',
    sort: normalizeDiscoverySort(request?.sort),
    query_text: normalizeCacheText(request?.query?.text),
    scope: {
      brand_names: uniqStrings(request?.scope?.brand_names, 8).map((value) => normalizeCacheText(value)),
      categories: normalizeDiscoveryCategories(request?.scope?.categories, 12).map((value) => normalizeCacheText(value)),
    },
    source_product_ref: {
      merchant_id: String(request?.source_product_ref?.merchant_id || '').trim(),
      product_id: String(request?.source_product_ref?.product_id || '').trim(),
    },
  });
}

function getDiscoveryCursorAbsoluteOffset(cursor, limit) {
  if (!cursor) return 0;
  const safeLimit = clampInt(limit, 20, 1, 100);
  const baseOffset = clampInt(cursor.offset, 0, 0, 500000);
  if (cursor.mode === 'exhaustive' && cursor.absolute_offset == null) {
    return Math.max(DISCOVERY_CURATED_HEAD_LIMIT, safeLimit) + baseOffset;
  }
  return clampInt(cursor.absolute_offset, baseOffset, 0, 500000);
}

function normalizeDiscoveryCursor(rawCursor, { signature, limit } = {}) {
  const raw = String(rawCursor || '').trim();
  if (!raw) return null;
  let decoded = null;
  try {
    decoded = decodeDiscoveryCursorPayload(raw);
  } catch (err) {
    throw new DiscoveryValidationError('cursor is invalid');
  }
  const version = String(decoded?.v || '').trim();
  const mode = String(decoded?.mode || '').trim();
  const offset = Number(decoded?.offset);
  const absoluteOffset = Number(decoded?.absolute_offset);
  const cursorSignature = String(decoded?.sig || '').trim();
  if (version !== DISCOVERY_CURSOR_VERSION) {
    throw new DiscoveryValidationError('cursor version is not supported');
  }
  if (!VALID_DISCOVERY_SERVING_MODES.has(mode)) {
    throw new DiscoveryValidationError('cursor mode is invalid');
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new DiscoveryValidationError('cursor offset is invalid');
  }
  if (signature && cursorSignature !== signature) {
    throw new DiscoveryValidationError('cursor does not match the current discovery scope');
  }
  const safeLimit = clampInt(limit, 20, 1, 100);
  const resolvedAbsoluteOffset =
    Number.isFinite(absoluteOffset) && absoluteOffset >= 0
      ? Math.floor(absoluteOffset)
      : mode === 'exhaustive'
        ? Math.max(DISCOVERY_CURATED_HEAD_LIMIT, safeLimit) + Math.floor(offset)
        : Math.floor(offset);
  return {
    raw,
    mode,
    offset: Math.floor(offset),
    absolute_offset: resolvedAbsoluteOffset,
    signature: cursorSignature,
    derived_page: Math.max(1, Math.floor(resolvedAbsoluteOffset / safeLimit) + 1),
  };
}

function buildDiscoveryCursor(request, mode, offset, absoluteOffset) {
  return encodeDiscoveryCursorPayload({
    v: DISCOVERY_CURSOR_VERSION,
    mode,
    offset: Math.max(0, Math.floor(Number(offset || 0) || 0)),
    absolute_offset: Math.max(0, Math.floor(Number(absoluteOffset || 0) || 0)),
    sig: buildDiscoveryCursorContextSignature(request),
  });
}

function buildDiscoveryCursorInfo({ request, servingMode, nextOffset, nextAbsoluteOffset, hasNextPage }) {
  const nextCursor =
    hasNextPage && VALID_DISCOVERY_SERVING_MODES.has(String(servingMode || '').trim())
      ? buildDiscoveryCursor(request, servingMode, nextOffset, nextAbsoluteOffset)
      : null;
  return {
    next_cursor: nextCursor,
    has_next_page: Boolean(nextCursor),
    serving_mode: VALID_DISCOVERY_SERVING_MODES.has(String(servingMode || '').trim())
      ? servingMode
      : 'exhaustive',
  };
}

function getDiscoveryServingShadowTimeoutMs() {
  return clampInt(
    process.env.DISCOVERY_SERVING_SHADOW_TIMEOUT_MS,
    DEFAULT_DISCOVERY_SERVING_SHADOW_TIMEOUT_MS,
    100,
    5000,
  );
}

function canRunCatalogServingShadowRead(request) {
  const config = getCatalogServingIndexConfig();
  return Boolean(
      request?.surface === 'browse_products' &&
      request?.debug?.enabled &&
      isCatalogServingIndexEnabled() &&
      config.shadow_read_enabled &&
      !request?.cursor &&
      Number(request?.page || 1) === 1,
  );
}

function buildDiscoveryRuntimeServingDocIds(selectedEntries = []) {
  return uniqStrings(
    (Array.isArray(selectedEntries) ? selectedEntries : []).map((entry) =>
      buildCatalogServingDoc(entry?.candidate?.raw || entry?.candidate || {}).doc_id,
    ),
    64,
  );
}

async function maybeReadCatalogServingShadow(request, selectedEntries = []) {
  if (!canRunCatalogServingShadowRead(request)) return null;
  const market = resolveDiscoveryExternalSeedMarketConfig().market;

  try {
    const shadowResponse = await searchCatalogServingIndex({
      query_text: request?.query?.text,
      brand_names: request?.scope?.brand_names,
      categories: request?.scope?.categories,
      market,
      limit: request?.limit,
      sort: request?.sort,
      timeout_ms: getDiscoveryServingShadowTimeoutMs(),
    });

    const runtimeDocIds = buildDiscoveryRuntimeServingDocIds(selectedEntries);
    const shadowDocIds = uniqStrings(
      (Array.isArray(shadowResponse?.items) ? shadowResponse.items : []).map((item) => item?.doc_id),
      64,
    );
    const shadowDocIdSet = new Set(shadowDocIds);
    const overlapCount = runtimeDocIds.filter((docId) => shadowDocIdSet.has(docId)).length;
    return {
      mode: 'shadow',
      status: 'ok',
      source: shadowResponse?.source || 'opensearch_compatible',
      market,
      runtime_returned: selectedEntries.length,
      shadow_returned: shadowDocIds.length,
      overlap_count: overlapCount,
      overlap_ratio:
        runtimeDocIds.length > 0 ? Number((overlapCount / runtimeDocIds.length).toFixed(4)) : null,
      runtime_sample_doc_ids: runtimeDocIds.slice(0, 5),
      shadow_sample_doc_ids: shadowDocIds.slice(0, 5),
      cursor_info: shadowResponse?.cursor_info || null,
    };
  } catch (err) {
    const httpStatus = Number(err?.response?.status || 0) || null;
    return {
      mode: 'shadow',
      status: 'error',
      market,
      error_code:
        err?.code === 'ECONNABORTED'
          ? 'timeout'
          : httpStatus
            ? classifyDiscoveryHttpFailure(httpStatus)
            : 'request_failed',
      http_status: httpStatus,
      message: err?.message || String(err),
    };
  }
}

function normalizeDiscoveryRequest(input = {}) {
  const source = input && typeof input.discovery === 'object' ? { ...input.discovery, ...input } : input;
  const surface = String(source.surface || '').trim();
  if (!VALID_SURFACES.has(surface)) {
    throw new DiscoveryValidationError('surface must be home_hot_deals or browse_products');
  }
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
  const cursorSignature = buildDiscoveryCursorContextSignature({
    surface,
    sort,
    scope,
    query,
    source_product_ref: sourceProductRef,
  });
  const cursor = normalizeDiscoveryCursor(
    source.cursor ?? source.next_cursor ?? source.nextCursor,
    { signature: cursorSignature, limit },
  );
  const page = cursor?.derived_page || clampInt(source.page, 1, 1, 1000);

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
    cursor,
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

function inferPersonalizationSource(recentViews, recentQueries, authState) {
  const queryCount = Array.isArray(recentQueries) ? recentQueries.length : 0;
  if ((!Array.isArray(recentViews) || recentViews.length === 0) && queryCount <= 0) return 'none';
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
  if (queryCount > 0) return authState === 'authenticated' ? 'account_history' : 'session_history';
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
  const queryHistoryItemsUsed = recentQueries.length;
  const personalizationSource = inferPersonalizationSource(recentViews, recentQueries, context.auth_state);
  const hasViewInterestSignals =
    historyItemsUsed > 0 && (brandAffinity.size > 0 || categoryAffinity.size > 0 || anchors.length > 0);
  const hasQueryInterestSignals =
    queryHistoryItemsUsed > 0 && (queryTokens.size > 0 || domainScores.size > 0 || beautyBucketScores.size > 0);
  const hasInterestSignals = hasViewInterestSignals || hasQueryInterestSignals;
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
    queryHistoryItemsUsed,
    queryItemsUsed: queryHistoryItemsUsed,
    personalizationSource,
    queryTokens,
    hasInterestSignals,
  };
}

function shouldUseBeautyInterestMainline(request, profile) {
  return (
    profile?.hasInterestSignals === true &&
    profile?.dominantDomain === 'beauty' &&
    (!Array.isArray(request?.scope?.brand_names) || request.scope.brand_names.length === 0)
  );
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

function getExplicitDiscoveryQueryText(request) {
  return buildDiscoverySearchPhraseSet([request?.query?.text], 1)[0] || '';
}

function isExplicitQueryScopedBrowseRequest(request) {
  return (
    request?.surface === 'browse_products' &&
    Boolean(getExplicitDiscoveryQueryText(request)) &&
    !hasBrandScope(request) &&
    !hasDiscoveryCategoryScope(request)
  );
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
  const explicitQuery = getExplicitDiscoveryQueryText(request);
  const withExplicitQuery = (queries = [], limit = 4) =>
    explicitQuery
      ? buildDiscoverySearchPhraseSet([explicitQuery, ...(Array.isArray(queries) ? queries : [queries])], limit)
      : buildDiscoverySearchPhraseSet(queries, limit);

  if (Array.isArray(request?.scope?.brand_names) && request.scope.brand_names.length > 0) {
    return withExplicitQuery([brandQuery], 3);
  }

  if (isExplicitQueryScopedBrowseRequest(request)) {
    return [explicitQuery];
  }

  if (!profile?.hasInterestSignals) {
    return explicitQuery ? withExplicitQuery(getDiscoveryColdStartQueries(), 4) : getDiscoveryColdStartQueries();
  }

  if (profile?.dominantDomain === 'beauty') {
    return withExplicitQuery(buildBeautyPersonalizedQueries(request, profile).providerQueries, 4);
  }

  if (request?.surface === 'browse_products') {
    return withExplicitQuery(
      [
        buildDiscoverySeededBrowseQuery(request, profile),
        buildDiscoveryExpansionQuery(request, profile),
        buildDiscoveryInterestQuery(request, profile),
      ],
      4,
    );
  }

  return withExplicitQuery(
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
  const fetchCap = getDiscoveryCandidateFetchCap(request);
  if (request?.surface === 'browse_products') {
    const pageNeed = request.page * request.limit + Math.max(request.limit, 24);
    const genericBrowsePrefetchFloor = resolveGenericBrowsePrefetchFloor(request);
    const explicitBrowseCursorPrefetch = resolveExplicitBrowseCursorPrefetchNeed(request);
    if (hasBrandScope(request)) {
      return clampInt(Math.max(pageNeed, 48), 72, 48, fetchCap);
    }
    return clampInt(
      Math.max(pageNeed, genericBrowsePrefetchFloor, explicitBrowseCursorPrefetch),
      72,
      24,
      fetchCap,
    );
  }
  const homeNeed = Math.max(request?.limit * 4, 48);
  return clampInt(homeNeed, 48, 24, fetchCap);
}

function resolveExplicitBrowseCursorPrefetchNeed(request, multiplier = 4) {
  if (!isExplicitQueryScopedBrowseRequest(request)) return 0;
  if (!request?.cursor) return 0;
  const fetchCap = getDiscoveryCandidateFetchCap(request);
  const safeLimit = clampInt(request?.limit, 24, 1, 120);
  const safeMultiplier = clampInt(multiplier, 4, 1, 8);
  const absoluteOffset = getDiscoveryCursorAbsoluteOffset(request.cursor, safeLimit);
  return Math.min(fetchCap, absoluteOffset + safeLimit * safeMultiplier);
}

function resolveExplicitBrowseCursorQualifiedTarget(request, safeLimit) {
  const target = resolveExplicitBrowseCursorPrefetchNeed(request, 2);
  if (!target) return 0;
  return Math.min(Math.max(0, Number(safeLimit || 0) || 0), target);
}

function isBehaviorlessGenericBrowseRequest(request) {
  if (request?.surface !== 'browse_products') return false;
  if (hasBrandScope(request) || hasDiscoveryQueryText(request) || hasDiscoveryCategoryScope(request)) {
    return false;
  }
  const recentViews = Array.isArray(request?.context?.recent_views) ? request.context.recent_views : [];
  const recentQueries = Array.isArray(request?.context?.recent_queries) ? request.context.recent_queries : [];
  return recentViews.length <= 0 && recentQueries.length <= 0;
}

function resolveGenericBrowsePrefetchFloor(request) {
  if (!isBehaviorlessGenericBrowseRequest(request)) return 0;
  const fetchCap = getDiscoveryCandidateFetchCap(request);
  const pageLimit = clampInt(request?.limit, 24, 1, 120);
  const defaultFloor = Math.max(pageLimit * 4, 120);
  return clampInt(
    process.env.DISCOVERY_GENERIC_BROWSE_PREFETCH_FLOOR,
    defaultFloor,
    120,
    fetchCap,
  );
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
  const safeLimit = clampInt(
    limit,
    resolveDiscoveryCandidateLimit(request),
    24,
    getDiscoveryCandidateFetchCap(request),
  );
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
  if (request?.surface === 'browse_products' && !profile?.hasInterestSignals) {
    const coldStartQueries = prioritizeDiscoveryRecallQueries(providerQueries).slice(0, 2);
    const firstLimit = Math.min(BROWSE_PRIMARY_RECALL_LIMIT, safeLimit);
    const remaining = Math.max(0, safeLimit - firstLimit);
    return [
      {
        label: 'browse_pool',
        query: coldStartQueries[0] || getDiscoveryColdStartQuery(),
        offset: 0,
        limit: firstLimit,
        allow_early_exit: remaining <= 0,
      },
      ...(remaining > 0 && coldStartQueries[1]
        ? [
            {
              label: 'expansion_pool',
              query: coldStartQueries[1],
              offset: 0,
              limit: Math.min(BROWSE_FILL_RECALL_LIMIT, remaining),
              allow_early_exit: true,
            },
          ]
        : []),
    ].slice(0, clampInt(process.env.DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS, MAX_PRODUCTS_SEARCH_CALLS, 1, 4));
  }

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
    if (request?.surface === 'home_hot_deals') {
      return [
        {
          label: 'cold_start_curated',
          query: coldStartQueries[0] || getDiscoveryColdStartQuery(),
          offset: 0,
          limit: firstLimit,
          allow_early_exit: true,
        },
      ];
    }
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

function shouldUseBrandDirectPoolAsPrimary(request) {
  return (
    request?.surface === 'browse_products' &&
    hasBrandScope(request) &&
    !hasDiscoveryQueryText(request) &&
    !hasDiscoveryCategoryScope(request) &&
    Boolean(String(request?.source_product_ref?.product_id || '').trim())
  );
}

function shouldSkipBrandDirectPool(scopedCandidates = [], { request, limit } = {}) {
  if (request?.surface !== 'browse_products' || !hasBrandScope(request)) return false;
  const safeLimit = clampInt(
    limit,
    resolveDiscoveryCandidateLimit(request),
    24,
    getDiscoveryCandidateFetchCap(request),
  );
  const enoughThreshold = getRecallEnoughThreshold(request, safeLimit);
  return Array.isArray(scopedCandidates) && scopedCandidates.length >= enoughThreshold;
}

function hasDiscoveryQueryText(request) {
  return Boolean(String(request?.query?.text || '').trim());
}

function hasDiscoveryCategoryScope(request) {
  return normalizeDiscoveryCategories(request?.scope?.categories, 12).length > 0;
}

function isGenericNoSignalDiscoveryRequest(request, profile) {
  if (profile?.hasInterestSignals) return false;
  if (hasBrandScope(request) || hasDiscoveryQueryText(request) || hasDiscoveryCategoryScope(request)) {
    return false;
  }
  if (request?.surface === 'browse_products') {
    return isGenericAnonymousBrowseColdStart(profile, {
      sort: request?.sort,
      brandScoped: false,
      queryText: request?.query?.text,
      categoryScope: request?.scope?.categories,
    });
  }
  return request?.surface === 'home_hot_deals';
}

function getNoSignalPrimaryProviderThreshold(request) {
  const requestedLimit = clampInt(request?.limit, 12, 1, 48);
  if (request?.surface === 'browse_products') {
    const page = Math.max(1, Number(request?.page || 1));
    return Math.max(Math.min(page * requestedLimit, 24), 8);
  }
  return Math.max(Math.min(requestedLimit, 6), 4);
}

function hasNoSignalRequestedPageCoverage(highQualityCount, request) {
  if (request?.surface !== 'browse_products') return false;
  const page = Math.max(1, Number(request?.page || 1));
  if (page <= 1) return false;
  const requestedLimit = clampInt(request?.limit, 12, 1, 48);
  const pageOffset = (page - 1) * requestedLimit;
  return Number(highQualityCount || 0) > pageOffset;
}

function shouldSkipNoSignalProviderExpansion(products = [], { request, profile } = {}) {
  if (!isGenericNoSignalDiscoveryRequest(request, profile)) return false;
  const highQualityCount = countHighQualityProviderCandidates(products, { request, profile });
  if (hasNoSignalRequestedPageCoverage(highQualityCount, request)) return true;
  const threshold = getNoSignalPrimaryProviderThreshold(request);
  return highQualityCount >= threshold;
}

function isQueryOnlyPersonalizedDiscoveryRequest(request, profile) {
  if (!profile?.hasInterestSignals) return false;
  if (Number(profile?.historyItemsUsed || 0) > 0) return false;
  if (Number(profile?.queryHistoryItemsUsed || 0) <= 0) return false;
  if (hasBrandScope(request) || hasDiscoveryQueryText(request) || hasDiscoveryCategoryScope(request)) {
    return false;
  }
  return request?.surface === 'browse_products' || request?.surface === 'home_hot_deals';
}

function isGenericPersonalizedDiscoveryRequest(request, profile) {
  if (!profile?.hasInterestSignals) return false;
  if (hasBrandScope(request) || hasDiscoveryQueryText(request) || hasDiscoveryCategoryScope(request)) {
    return false;
  }
  return request?.surface === 'browse_products' || request?.surface === 'home_hot_deals';
}

function getPersonalizedPrimaryProviderThreshold(request) {
  const requestedLimit = clampInt(request?.limit, 12, 1, 48);
  if (request?.surface === 'browse_products') {
    const page = Math.max(1, Number(request?.page || 1));
    return page * requestedLimit;
  }
  return requestedLimit;
}

function shouldSkipPersonalizedProviderExpansion(products = [], { request, profile } = {}) {
  if (!isGenericPersonalizedDiscoveryRequest(request, profile)) return false;
  const highQualityCount = countHighQualityProviderCandidates(products, { request, profile });
  if (
    profile?.dominantDomain === 'beauty' &&
    request?.surface === 'home_hot_deals' &&
    highQualityCount >= Math.max(4, Math.min(Number(request?.limit || 0) || 0, 6))
  ) {
    return true;
  }
  if (isQueryOnlyPersonalizedDiscoveryRequest(request, profile)) {
    return highQualityCount >= getPersonalizedPrimaryProviderThreshold(request);
  }
  return request?.surface === 'browse_products'
    ? highQualityCount >= Math.max(Number(request?.limit || 0) || 0, 6)
    : false;
}

async function fetchDiscoveryRecallStep({
  baseUrl,
  request,
  step,
  requestHeaders,
  provider = 'products_search',
  timeoutMs = getDiscoveryProductsSearchTimeoutMs(),
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
      timeout: timeoutMs,
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
      ...(resp.status >= 200 && resp.status < 300 ? {} : { failure_reason: classifyDiscoveryHttpFailure(resp.status) }),
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
        failure_reason:
          err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''))
            ? 'timeout'
            : 'request_error',
        error: err?.message || String(err),
      },
    };
  }
}

async function loadProductsSearchCandidates({ request, profile, limit = MAX_CANDIDATE_FETCH } = {}) {
  const safeLimit = clampInt(
    limit,
    resolveDiscoveryCandidateLimit(request),
    24,
    getDiscoveryCandidateFetchCap(request),
  );
  const provider = 'products_search';
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
            provider,
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

  const baseUrlConfig = resolveDiscoveryProductsSearchBaseUrlConfig();
  const apiKeyConfig = resolveDiscoveryProductsSearchApiKeyConfig();
  const baseUrl = baseUrlConfig.value;
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
          failureReason: 'missing_base_url',
          configSource: baseUrlConfig.source,
          legacyConfigFallback: baseUrlConfig.usesLegacyFallback,
          error:
            'DISCOVERY_PRODUCTS_SEARCH_BASE_URL is not configured for discovery feed',
        }),
      ],
    };
  }
  if (!apiKeyConfig.value) {
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
          failureReason: 'missing_api_key',
          configSource: apiKeyConfig.source,
          legacyConfigFallback: apiKeyConfig.usesLegacyFallback,
          error: 'DISCOVERY_PRODUCTS_SEARCH_API_KEY is not configured for discovery feed',
        }),
      ],
    };
  }

  const requestHeaders = {};
  const apiKey = apiKeyConfig.value;
  requestHeaders['X-Agent-API-Key'] = apiKey;
  requestHeaders['X-API-Key'] = apiKey;
  requestHeaders.Authorization = `Bearer ${apiKey}`;

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

  if (
    request?.surface === 'home_hot_deals' &&
    recallPlan.length > 1 &&
    !isQueryOnlyPersonalizedDiscoveryRequest(request, profile)
  ) {
    const parallelTimeoutMs = computeDiscoveryStepTimeoutMs(recallBudgetMs, getDiscoveryProductsSearchTimeoutMs());
    if (!(parallelTimeoutMs > 0)) {
      return {
        products: [],
        recallSummary: [
          buildDiscoveryProviderStepSummary({
            provider,
            label: 'products_search_pool',
            query: provider,
            limit: safeLimit,
            returned: 0,
            status: null,
            latencyMs: 0,
            failureReason: 'budget_truncated',
            error: 'discovery recall budget exhausted before products_search execution',
          }),
        ],
      };
    }
    const stepResults = await Promise.all(
      recallPlan.map((step) =>
        fetchDiscoveryRecallStep({
          baseUrl,
          request,
          step,
          requestHeaders,
          timeoutMs: parallelTimeoutMs,
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
    const remainingBudgetMs = recallBudgetMs - (Date.now() - recallStartedAt);
    if (remainingBudgetMs <= 0) {
      truncatedByBudget = true;
      break;
    }
    const stepTimeoutMs = computeDiscoveryStepTimeoutMs(
      remainingBudgetMs,
      getDiscoveryProductsSearchTimeoutMs(),
    );
    if (!(stepTimeoutMs > 0)) {
      truncatedByBudget = true;
      break;
    }
    const result = await fetchDiscoveryRecallStep({
      baseUrl,
      request,
      step,
      requestHeaders,
      timeoutMs: stepTimeoutMs,
    });
    recallSummary.push(result.summary);

    if (!result.success) continue;

    successCount += 1;
    mergeProducts(result.products);
    if (shouldSkipPersonalizedProviderExpansion(mergedProducts, { request, profile })) break;
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
  failureReason,
  configSource,
  legacyConfigFallback,
  market,
  marketSource,
  warningCodes,
  compoundIntent,
  externalSeedStageCounts,
  externalSeedRawCount,
  externalSeedQualifiedCount,
  externalSeedFilteredCompoundCount,
  externalSeedFilteredQueryTextCount,
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
    ...(failureReason ? { failure_reason: String(failureReason) } : {}),
    ...(configSource ? { config_source: String(configSource) } : {}),
    ...(legacyConfigFallback ? { legacy_config_fallback: true } : {}),
    ...(market ? { market: String(market) } : {}),
    ...(marketSource ? { market_source: String(marketSource) } : {}),
    ...(Array.isArray(warningCodes) && warningCodes.length > 0
      ? { warning_codes: uniqStrings(warningCodes, 12) }
      : {}),
    ...(compoundIntent ? { compound_intent: String(compoundIntent) } : {}),
    ...(Array.isArray(externalSeedStageCounts) && externalSeedStageCounts.length > 0
      ? { external_seed_stage_counts: externalSeedStageCounts }
      : {}),
    ...(externalSeedRawCount != null
      ? { external_seed_raw_count: Number(externalSeedRawCount || 0) }
      : {}),
    ...(externalSeedQualifiedCount != null
      ? { external_seed_qualified_count: Number(externalSeedQualifiedCount || 0) }
      : {}),
    ...(externalSeedFilteredCompoundCount != null
      ? { external_seed_filtered_compound_count: Number(externalSeedFilteredCompoundCount || 0) }
      : {}),
    ...(externalSeedFilteredQueryTextCount != null
      ? { external_seed_filtered_query_text_count: Number(externalSeedFilteredQueryTextCount || 0) }
      : {}),
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

  const providerDatabaseState = await getDiscoveryProviderDatabaseState(provider);
  if (providerDatabaseState && providerDatabaseState.ready !== true) {
    const failureReason = providerDatabaseState.code || 'schema_missing';
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'internal_catalog_pool',
      status: failureReason === 'schema_missing' ? 'schema_missing' : 'error',
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
          skipped: failureReason === 'schema_missing',
          skipReason: failureReason === 'schema_missing' ? 'schema_missing' : undefined,
          failureReason,
          warningCodes: providerDatabaseState?.warnings,
          error: providerDatabaseState?.error,
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
    const failureReason = classifyDiscoveryQueryError(err);
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'internal_catalog_pool',
      status: failureReason,
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
          failureReason,
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
  const marketConfig = resolveDiscoveryExternalSeedMarketConfig();
  const market = marketConfig.market;
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
	            market,
	            marketSource: marketConfig.source,
	            compoundIntent: isExplicitQueryScopedBrowseRequest(request)
	              ? resolveExplicitBeautyCompoundIntent(request?.query?.text)
	              : null,
	          }),
	        ],
	      };
    } catch (err) {
      const failureReason = classifyDiscoveryQueryError(err);
      recordDiscoveryRecallStep({
        surface: request?.surface,
        step: 'external_seed_pool',
        status: failureReason,
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
            failureReason,
            market,
            marketSource: marketConfig.source,
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
          market,
          marketSource: marketConfig.source,
          skipped: true,
          skipReason: 'missing_database',
        }),
      ],
    };
  }

  const exactTitleFastpathResult = await fetchExternalSeedExactTitleCandidates({
    request,
    profile,
    limit: safeLimit,
  });
  if (exactTitleFastpathResult?.products?.length) {
    return exactTitleFastpathResult;
  }

  const providerDatabaseState = await getDiscoveryProviderDatabaseState(provider);
  if (providerDatabaseState && providerDatabaseState.ready !== true) {
    const failureReason = providerDatabaseState.code || 'schema_missing';
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'external_seed_pool',
      status: failureReason === 'schema_missing' ? 'schema_missing' : 'error',
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
          skipped: failureReason === 'schema_missing',
          skipReason: failureReason === 'schema_missing' ? 'schema_missing' : undefined,
          failureReason,
          market,
          marketSource: marketConfig.source,
          warningCodes: providerDatabaseState?.warnings,
          error: providerDatabaseState?.error,
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
          market,
          marketSource: marketConfig.source,
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
          market,
          marketSource: marketConfig.source,
          error: err?.message || String(err),
        }),
      ],
    };
  }
}

function buildBeautyInterestRecallTerms(request, profile, queries = []) {
  const effectiveQueries = buildExternalSeedProviderQueries(request, profile, queries);
  const searchTerms = buildDiscoveryDatabaseSearchTerms(effectiveQueries, {
    maxPhrases: request?.surface === 'home_hot_deals' ? 2 : 3,
    maxTokens: 10,
  });
  const tokens = uniqStrings(
    [
      ...searchTerms.tokens,
      ...searchTerms.phrases.flatMap((phrase) => tokenizeDiscoverySearchText(phrase)),
      normalizeBeautyBucket(profile?.preferredBeautyBucket),
    ],
    24,
  ).map((token) => String(token || '').trim().toLowerCase()).filter(Boolean);
  const tokenSet = new Set(tokens);
  const categoryTerms = new Set();
  const verticalTerms = new Set();
  const primaryCategoryTerms = new Set();
  const weakCategoryTerms = new Set();
  const compoundIntent = isExplicitQueryScopedBrowseRequest(request)
    ? resolveExplicitBeautyCompoundIntent(request?.query?.text)
    : null;
  const compoundRule = compoundIntent ? EXPLICIT_BEAUTY_COMPOUND_INTENT_RULES[compoundIntent] : null;

  const addCategoryTerms = (items = []) => {
    for (const item of Array.isArray(items) ? items : []) {
      const normalized = normalizeText(item || '');
      if (normalized) categoryTerms.add(normalized);
    }
  };

  const addVerticalTerms = (items = []) => {
    for (const item of Array.isArray(items) ? items : []) {
      const normalized = normalizeText(item || '');
      if (normalized) verticalTerms.add(normalized);
    }
  };

  const addCompoundCategoryTerms = (items = [], targetSet) => {
    for (const item of Array.isArray(items) ? items : []) {
      const normalized = normalizeText(item || '');
      if (!normalized) continue;
      categoryTerms.add(normalized);
      targetSet.add(normalized);
    }
  };

  for (const phrase of uniqStrings([...effectiveQueries, ...searchTerms.phrases], 12)) {
    const hint = resolveBeautyInterestPhraseHint(phrase);
    if (hint.compoundIntent && hint.compoundIntent === compoundIntent) {
      addCompoundCategoryTerms(hint.primaryCategories, primaryCategoryTerms);
      addCompoundCategoryTerms(hint.weakCategories, weakCategoryTerms);
      addVerticalTerms(hint.verticals);
      continue;
    }
    addCategoryTerms(hint.categories);
    addVerticalTerms(hint.verticals);
  }

  for (const token of tokenSet) {
    if (
      compoundRule &&
      Array.isArray(compoundRule.suppressedTokenCategories) &&
      compoundRule.suppressedTokenCategories.includes(token)
    ) {
      continue;
    }
    addCategoryTerms(BEAUTY_INTEREST_CATEGORY_BY_TOKEN[token] || []);
  }

  if (tokens.some((token) => BEAUTY_INTEREST_SKINCARE_HINT_TOKENS.has(token))) {
    verticalTerms.add('skincare');
    categoryTerms.add('skincare');
  }

  const preferredBucket = normalizeBeautyBucket(profile?.preferredBeautyBucket);
  if (preferredBucket && preferredBucket !== 'general' && preferredBucket !== 'other') {
    if (preferredBucket === 'makeup') verticalTerms.add('makeup');
    else if (preferredBucket === 'fragrance') verticalTerms.add('fragrance');
    else if (preferredBucket === 'haircare' || preferredBucket === 'hair') verticalTerms.add('haircare');
    else if (preferredBucket !== 'tools') verticalTerms.add(preferredBucket);
  }

  if (verticalTerms.size === 0 && profile?.dominantDomain === 'beauty') {
    verticalTerms.add('skincare');
  }
  if (categoryTerms.size === 0 && verticalTerms.has('skincare')) {
    categoryTerms.add('skincare');
    categoryTerms.add('serum');
  }

  const patternTerms = buildDiscoveryLikePatternsFromTerms(searchTerms.phrases, searchTerms.tokens, {
    phraseOnlyForMultiword: isExplicitQueryScopedBrowseRequest(request),
  });

  return {
    queries: effectiveQueries,
    phrases: searchTerms.phrases,
    tokens: searchTerms.tokens,
    patterns: patternTerms,
    categoryTerms: Array.from(categoryTerms).slice(0, 12),
    primaryCategoryTerms: Array.from(primaryCategoryTerms).slice(0, 8),
    weakCategoryTerms: Array.from(weakCategoryTerms).slice(0, 8),
    verticalTerms: Array.from(verticalTerms).slice(0, 6),
    compoundIntent,
    compoundPhrases: compoundRule ? compoundRule.phrases.slice() : [],
    compoundConjunctionTokens: compoundRule ? compoundRule.conjunctionTokens.slice() : [],
    compoundPositiveTitleTokens: compoundRule ? compoundRule.positiveTitleTokens.slice() : [],
    compoundNegativeClasses: compoundRule ? compoundRule.negativeClasses.slice() : [],
  };
}

const EXPLICIT_QUERY_BROAD_STAGE_STOPWORDS = new Set([
  'and',
  'for',
  'with',
  'the',
  'a',
  'an',
  'of',
  'to',
]);

function shouldSkipBroadStructuredSeedStagesForExplicitQuery(request, recallTerms = {}) {
  if (!isExplicitQueryScopedBrowseRequest(request)) return false;
  if (recallTerms?.compoundIntent) return false;
  const normalizedQuery = normalizeText(request?.query?.text || '');
  if (!normalizedQuery) return false;
  const queryTokens = tokenizeDiscoverySearchText(normalizedQuery).filter(
    (token) => !EXPLICIT_QUERY_BROAD_STAGE_STOPWORDS.has(token),
  );
  return queryTokens.length >= 3;
}

function resolveExplicitIndexedCategoryHeadTerms(request, recallTerms = {}) {
  if (!isExplicitQueryScopedBrowseRequest(request)) return [];
  if (recallTerms?.compoundIntent) return [];
  if (shouldSkipBroadStructuredSeedStagesForExplicitQuery(request, recallTerms)) return [];

  const normalizedQuery = normalizeText(request?.query?.text || '');
  if (!normalizedQuery) return [];

  const exactTerms = new Set(
    [
      ...(Array.isArray(recallTerms?.primaryCategoryTerms) ? recallTerms.primaryCategoryTerms : []),
      ...(Array.isArray(recallTerms?.categoryTerms) ? recallTerms.categoryTerms : []),
    ]
      .map((term) => normalizeText(term || ''))
      .filter(Boolean),
  );

  // Keep this stage exact-only. Broad expansions like "skincare" and "hair care"
  // are useful later, but they should not preempt the title/summary mainline.
  return exactTerms.has(normalizedQuery) ? [normalizedQuery] : [];
}

function buildBeautyInterestSeedSelect() {
  return `
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
    updated_at,
    created_at,
    seed_data->'derived'->'recall' AS seed_recall,
    coalesce(
      seed_data->'derived'->'recall'->>'brand',
      seed_data->>'brand',
      seed_data->'snapshot'->>'brand',
      seed_data->>'merchant_display_name',
      seed_data->'snapshot'->>'merchant_display_name',
      seed_data->>'vendor',
      seed_data->'snapshot'->>'vendor',
      ''
    ) AS seed_brand,
    coalesce(
      seed_data->>'merchant_display_name',
      seed_data->'snapshot'->>'merchant_display_name',
      ''
    ) AS seed_merchant_display_name,
    coalesce(
      seed_data->>'vendor',
      seed_data->'snapshot'->>'vendor',
      ''
    ) AS seed_vendor,
    coalesce(
      seed_data->'derived'->'recall'->>'category',
      seed_data->>'category',
      seed_data->'snapshot'->>'category',
      seed_data->>'product_type',
      seed_data->'snapshot'->>'product_type',
      ''
    ) AS seed_category,
    coalesce(
      seed_data->>'product_type',
      seed_data->'snapshot'->>'product_type',
      seed_data->'derived'->'recall'->>'category',
      ''
    ) AS seed_product_type,
    left(coalesce(
      seed_data->'derived'->'recall'->>'retrieval_summary',
      seed_data->>'description',
      seed_data->'snapshot'->>'description',
      ''
    ), 1200) AS seed_description
  `;
}

function buildExternalSeedCompoundLikePatterns(values = []) {
  return uniqStrings(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeText(value || ''))
      .filter(Boolean)
      .flatMap((value) => {
        const words = value.split(/\s+/).filter(Boolean);
        return words.length > 1 ? [`%${value}%`, `%${words.join('%')}%`] : [`%${value}%`];
      }),
    12,
  );
}

function buildExternalSeedTitlePositiveSql(stageBind, recallTerms, options = {}) {
  const positivePatterns = buildExternalSeedCompoundLikePatterns(recallTerms.compoundPositiveTitleTokens);
  if (positivePatterns.length <= 0) return '';
  const patternBind = stageBind(positivePatterns);
  const includeSummary = options?.includeSummary === true;
  return `(
    ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitle} LIKE ANY(${patternBind}::text[])
    ${includeSummary ? `OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummary} LIKE ANY(${patternBind}::text[])` : ''}
  )`;
}

function buildExternalSeedConjunctionSql(stageBind, recallTerms) {
  const tokens = uniqStrings(recallTerms.compoundConjunctionTokens, 4);
  if (tokens.length <= 0) return '';
  return tokens
    .map((token) => {
      const bind = stageBind(`%${normalizeText(token)}%`);
      return `(
        ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitle} LIKE ${bind}
        OR ${DISCOVERY_EXTERNAL_SEED_INDEXED_RECALL_CATEGORY_SQL} LIKE ${bind}
      )`;
    })
    .join(' AND ');
}

function resolveExplicitBrowseStageQueryCap(request, safeLimit, options = {}) {
  const numericSafeLimit = Math.max(1, Number(safeLimit || 0) || 1);
  const defaultCap = Math.max(numericSafeLimit, Math.min(numericSafeLimit * 2, 48));
  if (!isExplicitQueryScopedBrowseRequest(request)) return defaultCap;

  const compoundIntent = String(options?.compoundIntent || '').trim();
  if (compoundIntent === 'hair_oil') {
    return Math.max(numericSafeLimit, Math.min(numericSafeLimit * 2, 120));
  }

  const requestedLimit = clampInt(request?.limit, 12, 1, 120);
  const cursorOffset = request?.cursor
    ? getDiscoveryCursorAbsoluteOffset(request.cursor, requestedLimit)
    : null;
  const page = Math.max(1, Number(request?.page || 0) || 1);
  const pageOffset =
    cursorOffset != null && Number.isFinite(cursorOffset)
      ? Math.max(0, cursorOffset)
      : (page - 1) * requestedLimit;
  const pageBufferedNeed = pageOffset + requestedLimit * 3;
  const floor = Math.max(requestedLimit * 2, 24);
  const maxCap = Math.max(numericSafeLimit, Math.min(getDiscoveryCandidateFetchCap(request), 120));
  return Math.min(maxCap, Math.max(floor, pageBufferedNeed));
}

function buildCompoundBeautySeedStageDefinitions(recallTerms, safeLimit, options = {}) {
  const stageCap = resolveExplicitBrowseStageQueryCap(options?.request, safeLimit, {
    compoundIntent: recallTerms?.compoundIntent,
  });
  const definitions = [];
  const exactPatterns = buildExternalSeedCompoundLikePatterns(
    recallTerms.compoundPhrases && recallTerms.compoundPhrases.length > 0
      ? recallTerms.compoundPhrases
      : recallTerms.phrases,
  );
  const primaryCategoryTerms = uniqStrings(recallTerms.primaryCategoryTerms, 8);
  const weakCategoryTerms = uniqStrings(recallTerms.weakCategoryTerms, 8);
  const verticalTerms = uniqStrings(recallTerms.verticalTerms, 6);
  const includeSummaryPositive = recallTerms.compoundIntent === 'hair_oil';

  if (recallTerms.compoundIntent === 'hair_oil') {
    const hairCategoryTerms = uniqStrings([...primaryCategoryTerms, ...weakCategoryTerms], 12);
    const positivePatterns = buildExternalSeedCompoundLikePatterns(recallTerms.compoundPositiveTitleTokens);
    if ((hairCategoryTerms.length > 0 || verticalTerms.length > 0) && positivePatterns.length > 0) {
      definitions.push({
        score: 70,
        stage: 'recall_compound_hair_oil_main',
        cap: stageCap,
        buildWhereSql: (stageBind) => {
          const positiveWhereSql = buildExternalSeedTitlePositiveSql(stageBind, recallTerms, {
            includeSummary: true,
          });
          if (!positiveWhereSql) return '';
          const categoryClauses = [];
          if (hairCategoryTerms.length > 0) {
            categoryClauses.push(
              `${DISCOVERY_EXTERNAL_SEED_INDEXED_RECALL_CATEGORY_SQL} = ANY(${stageBind(hairCategoryTerms)}::text[])`,
            );
          }
          if (verticalTerms.length > 0) {
            categoryClauses.push(
              `${EXTERNAL_SEED_RECALL_SQL_FIELDS.vertical} = ANY(${stageBind(verticalTerms)}::text[])`,
            );
          }
          if (categoryClauses.length <= 0) return '';
          return `(
            (${categoryClauses.join(' OR ')})
            AND ${positiveWhereSql}
          )`;
        },
      });
    }
    return definitions;
  }

  if (primaryCategoryTerms.length > 0) {
    definitions.push({
      score: 92,
      stage: 'recall_compound_primary_category',
      cap: stageCap,
      buildWhereSql: (stageBind) =>
        `${DISCOVERY_EXTERNAL_SEED_INDEXED_RECALL_CATEGORY_SQL} = ANY(${stageBind(primaryCategoryTerms)}::text[])`,
    });
    definitions.push({
      score: 91,
      stage: 'recall_compound_coalesced_primary_category',
      cap: stageCap,
      buildWhereSql: (stageBind) =>
        `${EXTERNAL_SEED_RECALL_SQL_FIELDS.category} = ANY(${stageBind(primaryCategoryTerms)}::text[])`,
    });
  }

  if (exactPatterns.length > 0) {
    definitions.push({
      score: 90,
      stage: 'recall_compound_exact_title',
      cap: stageCap,
      buildWhereSql: (stageBind) => {
        const patternBind = stageBind(exactPatterns);
        return `(
          ${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitle} LIKE ANY(${patternBind}::text[])
        )`;
      },
    });
  }

  if (weakCategoryTerms.length > 0) {
    definitions.push({
      score: 70,
      stage: 'recall_compound_weak_category',
      cap: stageCap,
      buildWhereSql: (stageBind) => {
        const positiveSql = buildExternalSeedTitlePositiveSql(stageBind, recallTerms, {
          includeSummary: includeSummaryPositive,
        });
        if (!positiveSql) return '';
        return `(
          ${DISCOVERY_EXTERNAL_SEED_INDEXED_RECALL_CATEGORY_SQL} = ANY(${stageBind(weakCategoryTerms)}::text[])
          AND ${positiveSql}
        )`;
      },
    });
  }

  if (verticalTerms.length > 0) {
    definitions.push({
      score: 60,
      stage: 'recall_compound_weak_vertical',
      cap: stageCap,
      buildWhereSql: (stageBind) => {
        const positiveSql = buildExternalSeedTitlePositiveSql(stageBind, recallTerms, {
          includeSummary: includeSummaryPositive,
        });
        if (!positiveSql) return '';
        return `(
          ${EXTERNAL_SEED_RECALL_SQL_FIELDS.vertical} = ANY(${stageBind(verticalTerms)}::text[])
          AND ${positiveSql}
        )`;
      },
    });
  }

  definitions.push({
    score: 50,
    stage: 'recall_compound_title_conjunction',
    cap: stageCap,
    buildWhereSql: (stageBind) => buildExternalSeedConjunctionSql(stageBind, recallTerms),
  });

  if (recallTerms.compoundIntent === 'hair_oil' && exactPatterns.length > 0) {
    definitions.push({
      score: 30,
      stage: 'recall_compound_summary',
      cap: stageCap,
      buildWhereSql: (stageBind) =>
        `${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummary} LIKE ANY(${stageBind(exactPatterns)}::text[])`,
    });
  }

  return definitions;
}

function buildDiscoverySeedStageRowKey(row) {
  const id = String(row?.id ?? '').trim();
  if (id) return `id:${id}`;
  const externalProductId = String(row?.external_product_id || '').trim();
  if (externalProductId) return `external:${externalProductId}`;
  const canonicalUrl = String(row?.canonical_url || row?.destination_url || '').trim().toLowerCase();
  if (canonicalUrl) return `url:${canonicalUrl}`;
  const title = normalizeText(row?.title || row?.seed_title || row?.seed_data?.title || row?.seed_data?.snapshot?.title || '');
  if (title) return `title:${title}`;
  return '';
}

function buildDiscoverySeedStageSqlId(row) {
  const id = String(row?.id ?? '').trim();
  return /^\d+$/.test(id) ? id : null;
}

function normalizeDiscoveryExactTitleSqlText(value) {
  return normalizeResolverLookupText(value);
}

function buildDiscoveryExactTitleSqlNormalizationExpr(sourceExpr) {
  const expr = String(sourceExpr || '').trim();
  if (!expr) {
    return "''";
  }
  return [
    'lower(trim(',
    "regexp_replace(",
    "regexp_replace(",
    "regexp_replace(",
    "regexp_replace(",
    `regexp_replace(coalesce(${expr}, ''), E'[＋+]', ' plus ', 'g'),`,
    "E'[%％]', ' percent ', 'g'),",
    "E'&', ' and ', 'g'),",
    "E'[^[:alnum:]]+', ' ', 'g'),",
    "E'\\\\s+', ' ', 'g')",
    '))',
  ].join(' ');
}

function buildDiscoveryExactTitleLookupVariants(queryText) {
  const rawQuery = String(queryText || '').trim();
  const rawNormalizedQuery = normalizeDiscoveryExactTitleSqlText(queryText);
  const normalizedQuery = normalizeResolverLookupText(queryText);
  const brandDetection = detectBrandEntities(rawQuery, { candidateProducts: [] });
  const brandVariants = buildBrandQueryVariants(rawQuery, brandDetection?.brands || []);
  const rawVariants = [];
  const normalizedVariants = [];
  const seenRaw = new Set();
  const seenNormalized = new Set();

  const pushVariant = (rawValue, normalizedValue) => {
    const rawNormalizedValue = normalizeDiscoveryExactTitleSqlText(rawValue);
    const resolverNormalizedValue = normalizeResolverLookupText(normalizedValue || rawValue);
    if (rawNormalizedValue && !seenRaw.has(rawNormalizedValue)) {
      seenRaw.add(rawNormalizedValue);
      rawVariants.push(rawNormalizedValue);
    }
    if (resolverNormalizedValue && !seenNormalized.has(resolverNormalizedValue)) {
      seenNormalized.add(resolverNormalizedValue);
      normalizedVariants.push(resolverNormalizedValue);
    }
  };

  pushVariant(rawQuery, queryText);

  for (const brandVariant of brandVariants) {
    const rawBrandVariant = normalizeDiscoveryExactTitleSqlText(brandVariant);
    const normalizedBrandVariant = normalizeResolverLookupText(brandVariant);

    if (rawNormalizedQuery && rawBrandVariant && rawNormalizedQuery.startsWith(`${rawBrandVariant} `)) {
      pushVariant(rawNormalizedQuery.slice(rawBrandVariant.length).trim());
    }
    if (
      normalizedQuery &&
      normalizedBrandVariant &&
      normalizedQuery.startsWith(`${normalizedBrandVariant} `)
    ) {
      pushVariant(
        normalizedQuery.slice(normalizedBrandVariant.length).trim(),
        normalizedQuery.slice(normalizedBrandVariant.length).trim(),
      );
    }
  }

  const rawQueryTokens = rawNormalizedQuery.split(/\s+/).filter(Boolean);
  for (const prefixLength of [1, 2]) {
    if (rawQueryTokens.length - prefixLength < 3) continue;
    const candidateTokens = rawQueryTokens.slice(prefixLength);
    const hasFormFactor = candidateTokens.some((token) =>
      DISCOVERY_EXACT_TITLE_FORM_FACTOR_TOKENS.has(String(token || '').toLowerCase()),
    );
    if (!hasFormFactor) continue;
    const informativeTokens = candidateTokens.filter((token) => {
      const normalizedToken = String(token || '').trim().toLowerCase();
      return (
        normalizedToken &&
        !DISCOVERY_EXACT_TITLE_GENERIC_TOKENS.has(normalizedToken) &&
        normalizedToken.length >= 3
      );
    });
    if (informativeTokens.length < 2) continue;
    pushVariant(candidateTokens.join(' '), candidateTokens.join(' '));
  }

  return {
    rawVariants,
    normalizedVariants,
    rawPrefixPatterns: rawVariants.map((value) => `${value} %`),
  };
}

function shouldUseDiscoveryExternalSeedExactTitleFastpath(request, profile) {
  void profile;
  if (request?.surface !== 'browse_products') return false;
  const rawQuery = String(request?.query?.text || '').trim();
  if (!rawQuery || rawQuery.length > 96) return false;
  if (/[?？]/.test(rawQuery)) return false;

  const loweredQuery = rawQuery.toLowerCase();
  if (
    /推荐|best|for\s|适合|怎么|如何|教程|guide|tips|budget|under\s|above\s|at least|gift|礼物|清单|what to buy|need to buy|checklist/i.test(
      loweredQuery,
    )
  ) {
    return false;
  }

  const normalizedQuery = normalizeResolverLookupText(rawQuery);
  const queryTokens = tokenizeResolverLookupQuery(normalizedQuery);
  if (queryTokens.length < 3 || queryTokens.length > 8) return false;

  const hasFormFactor = queryTokens.some((token) =>
    DISCOVERY_EXACT_TITLE_FORM_FACTOR_TOKENS.has(String(token || '').toLowerCase()),
  );
  if (!hasFormFactor) return false;

  const informativeTokens = queryTokens.filter((token) => {
    const normalizedToken = String(token || '').trim().toLowerCase();
    return (
      normalizedToken &&
      !DISCOVERY_EXACT_TITLE_GENERIC_TOKENS.has(normalizedToken) &&
      normalizedToken.length >= 3
    );
  });
  if (!informativeTokens.length) return false;

  const hasStrongTitleSignal =
    /[-/+]/.test(rawQuery) ||
    /\d/.test(rawQuery) ||
    ((rawQuery.match(/\b[A-Z][A-Za-z0-9'’+-]*\b/g) || []).length >= 2);
  return hasStrongTitleSignal ? informativeTokens.length >= 1 : informativeTokens.length >= 2;
}

function getDiscoveryExternalSeedExactTitleMatchRank(product, normalizedVariants = []) {
  const variants = (Array.isArray(normalizedVariants) ? normalizedVariants : []).filter(Boolean);
  if (!variants.length || !product || typeof product !== 'object') return Number.POSITIVE_INFINITY;

  const candidateTitles = [
    product?.title,
    product?.name,
    product?.title && product?.brand ? `${product.brand} ${product.title}` : '',
    product?.name && product?.brand ? `${product.brand} ${product.name}` : '',
  ]
    .map((value) => normalizeResolverLookupText(value))
    .filter(Boolean);
  if (!candidateTitles.length) return Number.POSITIVE_INFINITY;

  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidateTitle of candidateTitles) {
    for (const variant of variants) {
      if (candidateTitle === variant) bestRank = Math.min(bestRank, 0);
      else if (candidateTitle.startsWith(`${variant} `)) bestRank = Math.min(bestRank, 1);
      else if (candidateTitle.includes(variant)) bestRank = Math.min(bestRank, 2);
    }
  }
  return bestRank;
}

async function fetchExternalSeedExactTitleCandidates({
  request,
  profile,
  limit = MAX_CANDIDATE_FETCH,
} = {}) {
  void profile;
  const provider = 'external_seeds';
  const stepStartedAt = Date.now();
  const safeLimit = clampInt(limit, Math.max(limit, 24), 12, MAX_CANDIDATE_FETCH);
  const queryText = String(request?.query?.text || '').trim();
  const marketConfig = resolveDiscoveryExternalSeedMarketConfig();
  const market = marketConfig.market;
  const tool = 'creator_agents';

  if (!process.env.DATABASE_URL) {
    return null;
  }
  if (!shouldUseDiscoveryExternalSeedExactTitleFastpath(request, profile)) {
    return null;
  }

  const lookupVariants = buildDiscoveryExactTitleLookupVariants(queryText);
  if (!lookupVariants.rawVariants.length || !lookupVariants.normalizedVariants.length) {
    return null;
  }

  const titleExpr = buildDiscoveryExactTitleSqlNormalizationExpr('title');
  const snapshotTitleExpr = buildDiscoveryExactTitleSqlNormalizationExpr(
    "seed_data->'snapshot'->>'title'",
  );
  const retrievalTitleExpr = buildDiscoveryExactTitleSqlNormalizationExpr(
    "seed_data->'derived'->'recall'->>'retrieval_title'",
  );

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
          created_at,
          CASE
            WHEN ${titleExpr} = ANY($3::text[])
              OR ${snapshotTitleExpr} = ANY($3::text[])
              OR ${retrievalTitleExpr} = ANY($3::text[])
            THEN 0
            WHEN ${titleExpr} LIKE ANY($4::text[])
              OR ${snapshotTitleExpr} LIKE ANY($4::text[])
              OR ${retrievalTitleExpr} LIKE ANY($4::text[])
            THEN 1
            ELSE 2
          END AS exact_match_rank
        FROM external_product_seeds
        WHERE status = 'active'
          AND market = $1
          AND (tool = '*' OR tool = $2)
          AND (
            ${titleExpr} = ANY($3::text[])
            OR ${snapshotTitleExpr} = ANY($3::text[])
            OR ${retrievalTitleExpr} = ANY($3::text[])
            OR ${titleExpr} LIKE ANY($4::text[])
            OR ${snapshotTitleExpr} LIKE ANY($4::text[])
            OR ${retrievalTitleExpr} LIKE ANY($4::text[])
          )
        ORDER BY exact_match_rank ASC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        LIMIT $5
      `,
      [market, tool, lookupVariants.rawVariants, lookupVariants.rawPrefixPatterns, safeLimit],
    );

    const products = annotateProviderProducts(
      provider,
      (res.rows || [])
        .map((row) => buildExternalSeedProduct(row, { matchSource: 'exact_title' }))
        .filter(Boolean),
    )
      .map((product) => ({
        product,
        matchRank: getDiscoveryExternalSeedExactTitleMatchRank(
          product,
          lookupVariants.normalizedVariants,
        ),
      }))
      .filter((entry) => Number.isFinite(entry.matchRank))
      .sort((a, b) => {
        if (a.matchRank !== b.matchRank) return a.matchRank - b.matchRank;
        const aTitle = String(a.product?.title || '').trim();
        const bTitle = String(b.product?.title || '').trim();
        return aTitle.localeCompare(bTitle);
      })
      .map((entry) => entry.product);

    if (products.length <= 0) return null;

    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: 'external_seed_exact_title_pool',
      status: 'success',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products,
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label: 'external_seed_exact_title_pool',
          query: lookupVariants.rawVariants.join(' | '),
          limit: safeLimit,
          returned: products.length,
          status: 200,
          latencyMs: Date.now() - stepStartedAt,
          market,
          marketSource: marketConfig.source,
        }),
      ],
    };
  } catch (err) {
    return null;
  }
}

async function fetchBeautyInterestExternalSeedFastpathCandidates({
  request,
  profile,
  queries = [],
  limit = MAX_CANDIDATE_FETCH,
  fetchFn = null,
  providerName = 'external_seeds',
  productProvider = 'beauty_interest_mainline',
  stepName = 'beauty_interest_mainline',
  label = 'beauty_interest_mainline',
} = {}) {
  const provider = String(providerName || 'external_seeds').trim() || 'external_seeds';
  const stepStartedAt = Date.now();
  const safeLimit = clampInt(limit, Math.max(limit, 24), 12, getDiscoveryCandidateFetchCap(request));
  const recallTerms = buildBeautyInterestRecallTerms(request, profile, queries);
  const marketConfig = resolveDiscoveryExternalSeedMarketConfig();
  const market = marketConfig.market;
  const tool = 'creator_agents';

  if (typeof fetchFn === 'function') {
    try {
      const products = annotateProviderProducts(
        productProvider,
        await fetchFn({ request, profile, queries: recallTerms.phrases, limit: safeLimit }),
      );
      recordDiscoveryRecallStep({
        surface: request?.surface,
        step: stepName,
        status: 'success',
        latencyMs: Date.now() - stepStartedAt,
        cacheHit: false,
      });
      return {
        products,
        recallSummary: [
          buildDiscoveryProviderStepSummary({
            provider,
            label,
            query: recallTerms.phrases.join(' | '),
            limit: safeLimit,
            returned: products.length,
            status: 200,
            latencyMs: Date.now() - stepStartedAt,
            market,
            marketSource: marketConfig.source,
          }),
        ],
      };
    } catch (err) {
      const failureReason = classifyDiscoveryQueryError(err);
      recordDiscoveryRecallStep({
        surface: request?.surface,
        step: stepName,
        status: failureReason,
        latencyMs: Date.now() - stepStartedAt,
        cacheHit: false,
      });
      return {
        products: [],
        recallSummary: [
          buildDiscoveryProviderStepSummary({
            provider,
            label,
            query: recallTerms.phrases.join(' | '),
            limit: safeLimit,
            returned: 0,
            status: null,
            latencyMs: Date.now() - stepStartedAt,
            failureReason,
            market,
            marketSource: marketConfig.source,
            error: err?.message || String(err),
          }),
        ],
      };
    }
  }

  if (!process.env.DATABASE_URL) {
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: stepName,
      status: 'skipped',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label,
          query: recallTerms.phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          market,
          marketSource: marketConfig.source,
          skipped: true,
          skipReason: 'missing_database',
        }),
      ],
    };
  }

  const providerDatabaseState = await getDiscoveryProviderDatabaseState(productProvider);
  if (providerDatabaseState && providerDatabaseState.ready !== true) {
    const failureReason = providerDatabaseState.code || 'schema_missing';
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: stepName,
      status: failureReason === 'schema_missing' ? 'schema_missing' : 'error',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label,
          query: recallTerms.phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          skipped: failureReason === 'schema_missing',
          skipReason: failureReason === 'schema_missing' ? 'schema_missing' : undefined,
          failureReason,
          market,
          marketSource: marketConfig.source,
          warningCodes: providerDatabaseState?.warnings,
          error: providerDatabaseState?.error,
        }),
      ],
    };
  }

  const selectSql = buildBeautyInterestSeedSelect();
  const baseWhereSql = `
    status = 'active'
      AND attached_product_key IS NULL
      AND market = $1
      AND (tool = '*' OR tool = $2)
  `;
  const explicitQueryScopedRecall = isExplicitQueryScopedBrowseRequest(request);
  const compoundIntent = explicitQueryScopedRecall ? recallTerms.compoundIntent : null;
  const explicitStageQueryCap = resolveExplicitBrowseStageQueryCap(request, safeLimit, {
    compoundIntent,
  });
  const stageDefinitions = compoundIntent
    ? buildCompoundBeautySeedStageDefinitions(recallTerms, safeLimit, { request })
    : [];
  const skipBroadStructuredStages = shouldSkipBroadStructuredSeedStagesForExplicitQuery(
    request,
    recallTerms,
  );
  const indexedCategoryHeadTerms = resolveExplicitIndexedCategoryHeadTerms(request, recallTerms);
  if (!compoundIntent) {
    if (indexedCategoryHeadTerms.length > 0) {
      stageDefinitions.push({
        score: 56,
        stage: 'recall_indexed_category_head',
        cap: explicitStageQueryCap,
        buildWhereSql: (stageBind) =>
          `${DISCOVERY_EXTERNAL_SEED_INDEXED_RECALL_CATEGORY_SQL} = ANY(${stageBind(indexedCategoryHeadTerms)}::text[])`,
      });
      stageDefinitions.push({
        score: 55,
        stage: 'recall_exact_category_head',
        cap: explicitStageQueryCap,
        buildWhereSql: (stageBind) =>
          `${EXTERNAL_SEED_RECALL_SQL_FIELDS.category} = ANY(${stageBind(indexedCategoryHeadTerms)}::text[])`,
      });
    }

    if (recallTerms.patterns.length > 0) {
      stageDefinitions.push({
        score: 48,
        stage: 'recall_title',
        cap: explicitStageQueryCap,
        buildWhereSql: (stageBind) =>
          `${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalTitle} LIKE ANY(${stageBind(recallTerms.patterns)}::text[])`,
      });
      if (explicitQueryScopedRecall) {
        stageDefinitions.push({
          score: 42,
          stage: 'recall_summary',
          cap: explicitStageQueryCap,
          buildWhereSql: (stageBind) =>
            `${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummary} LIKE ANY(${stageBind(recallTerms.patterns)}::text[])`,
        });
      }
      stageDefinitions.push({
        score: 40,
        stage: 'recall_tokens',
        cap: explicitStageQueryCap,
        buildWhereSql: (stageBind) => {
          const patternBind = stageBind(recallTerms.patterns);
          return `(
            ${EXTERNAL_SEED_RECALL_SQL_FIELDS.ingredientTokens} LIKE ANY(${patternBind}::text[])
            OR ${EXTERNAL_SEED_RECALL_SQL_FIELDS.aliasTokens} LIKE ANY(${patternBind}::text[])
          )`;
        },
      });
    }

    if (recallTerms.categoryTerms.length > 0 && !skipBroadStructuredStages) {
      stageDefinitions.push({
        score: 36,
        stage: 'recall_category',
        cap: explicitStageQueryCap,
        buildWhereSql: (stageBind) =>
          `${EXTERNAL_SEED_RECALL_SQL_FIELDS.category} = ANY(${stageBind(recallTerms.categoryTerms)}::text[])`,
      });
    }

    if (recallTerms.verticalTerms.length > 0 && !skipBroadStructuredStages) {
      stageDefinitions.push({
        score: 18,
        stage: 'recall_vertical',
        cap: Math.min(explicitStageQueryCap, Math.max(safeLimit, 36)),
        buildWhereSql: (stageBind) =>
          `${EXTERNAL_SEED_RECALL_SQL_FIELDS.vertical} = ANY(${stageBind(recallTerms.verticalTerms)}::text[])`,
      });
    }
  }

  const shouldRunSummaryFallback =
    recallTerms.patterns.length > 0 && !explicitQueryScopedRecall && !isGenericNoSignalDiscoveryRequest(request, profile);
  if (stageDefinitions.length === 0 && !shouldRunSummaryFallback) {
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: stepName,
      status: 'skipped',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label,
          query: recallTerms.phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          failureReason: 'empty_recall_terms',
          market,
          marketSource: marketConfig.source,
          skipped: true,
          skipReason: 'empty_recall_terms',
        }),
      ],
    };
  }

  try {
    const stagedRows = [];
    const seenRowKeys = new Set();
    const seenSqlIds = new Set();
    const externalSeedStageCounts = [];
    let externalSeedRawCount = 0;
    let externalSeedFilteredCompoundCount = 0;
    let externalSeedFilteredQueryTextCount = 0;
    const baseSummaryThreshold =
      request?.surface === 'browse_products' && isGenericNoSignalDiscoveryRequest(request, profile)
        ? safeLimit
        : Math.min(safeLimit, Math.max(4, getPrimaryPathEnoughThreshold(request)));
    const requestedLimit = Math.max(1, Number(request?.limit || 0) || 12);
    const requestedPage = Math.max(1, Number(request?.page || 0) || 1);
    const currentPageAbsoluteOffset = request?.cursor
      ? getDiscoveryCursorAbsoluteOffset(request.cursor, requestedLimit)
      : (requestedPage - 1) * requestedLimit;
    const currentPageCoverageTarget = Math.min(
      safeLimit,
      Math.max(requestedLimit, currentPageAbsoluteOffset + requestedLimit),
    );
    const cursorQualifiedTarget = resolveExplicitBrowseCursorQualifiedTarget(request, safeLimit);
    const explicitQueryMainlineThreshold =
      explicitQueryScopedRecall && !compoundIntent
        ? resolveExplicitQueryExternalSeedMainlineAcceptThreshold(request, safeLimit)
        : baseSummaryThreshold;
    const summaryThreshold = Math.min(
      safeLimit,
      Math.max(explicitQueryMainlineThreshold, cursorQualifiedTarget),
    );
    const qualifiedTarget = compoundIntent
      ? Math.min(safeLimit, Math.max(requestedLimit * 2, 24, cursorQualifiedTarget))
      : summaryThreshold;
    let compoundExactStageSatisfiedCurrentPage = false;
    let explicitNarrowTitleStageSatisfied = false;
    const shouldStopStages = () =>
      compoundExactStageSatisfiedCurrentPage ||
      explicitNarrowTitleStageSatisfied ||
      stagedRows.length >= (compoundIntent ? qualifiedTarget : summaryThreshold);
    const appendRows = (rows = [], stage = 'unknown') => {
      const metrics = {
        stage,
        raw_rows: Array.isArray(rows) ? rows.length : 0,
        compound_qualified_rows: 0,
        query_qualified_rows: 0,
        deduped_rows: 0,
        final_eligible_rows: stagedRows.length,
      };
      externalSeedRawCount += metrics.raw_rows;
      for (const row of Array.isArray(rows) ? rows : []) {
        if (compoundIntent || explicitQueryScopedRecall) {
          const product = buildExternalSeedBrandSearchProduct(row);
          const normalized = product
            ? normalizeCandidateProduct(
                {
                  ...product,
                  __discovery_provider: productProvider,
                },
                stagedRows.length,
              )
            : null;
          if (!normalized) {
            externalSeedFilteredQueryTextCount += 1;
            continue;
          }
          if (compoundIntent && !matchesBeautyCompoundQueryIntent(normalized, compoundIntent)) {
            externalSeedFilteredCompoundCount += 1;
            externalSeedFilteredQueryTextCount += 1;
            continue;
          }
          if (!compoundIntent && !matchesQueryTextCandidate(normalized, request?.query?.text)) {
            externalSeedFilteredQueryTextCount += 1;
            continue;
          }
          metrics.compound_qualified_rows += 1;
          metrics.query_qualified_rows += 1;
        } else {
          metrics.compound_qualified_rows += 1;
          metrics.query_qualified_rows += 1;
        }
        const rowKey = buildDiscoverySeedStageRowKey(row);
        if (!rowKey || seenRowKeys.has(rowKey)) continue;
        seenRowKeys.add(rowKey);
        const sqlId = buildDiscoverySeedStageSqlId(row);
        if (sqlId) seenSqlIds.add(sqlId);
        stagedRows.push(row);
        metrics.deduped_rows += 1;
        if (stagedRows.length >= safeLimit) break;
      }
      metrics.final_eligible_rows = stagedRows.length;
      externalSeedStageCounts.push(metrics);
      if (
        compoundIntent &&
        (
          stage === 'recall_compound_exact_title' ||
          stage === 'recall_compound_primary_category' ||
          stage === 'recall_compound_coalesced_primary_category'
        ) &&
        stagedRows.length >= currentPageCoverageTarget
      ) {
        compoundExactStageSatisfiedCurrentPage = true;
      }
      if (!compoundIntent && skipBroadStructuredStages && stage === 'recall_title' && stagedRows.length > 0) {
        explicitNarrowTitleStageSatisfied = true;
      }
    };
    const runStage = async ({ buildWhereSql, score, stage, cap }) => {
      if (typeof buildWhereSql !== 'function' || stagedRows.length >= safeLimit || shouldStopStages()) return;
      const stageParams = [market, tool];
      const stageBind = (value) => {
        stageParams.push(value);
        return `$${stageParams.length}`;
      };
      const stageWhereSql = buildWhereSql(stageBind);
      if (!stageWhereSql) return;
      let sql = `
        SELECT
          ${selectSql},
          ${Number(score || 0)}::int AS match_score,
          '${stage}'::text AS match_stage
        FROM external_product_seeds
        WHERE ${baseWhereSql}
          AND ${stageWhereSql}
      `;
      if (seenSqlIds.size > 0) {
        const excludedIdsBind = stageBind(Array.from(seenSqlIds));
        sql += `
          AND id <> ALL(${excludedIdsBind}::bigint[])
        `;
      }
      const limitBind = stageBind(clampInt(cap, safeLimit, 12, Math.max(safeLimit, cap)));
      sql += `
        ORDER BY match_score DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        LIMIT ${limitBind}
      `;
      const res = await query(sql, stageParams);
      appendRows(Array.isArray(res?.rows) ? res.rows : [], stage);
    };

    for (const stageDefinition of stageDefinitions) {
      await runStage(stageDefinition);
      if (shouldStopStages()) break;
    }

    if (shouldRunSummaryFallback && stagedRows.length < summaryThreshold) {
      await runStage({
        score: 30,
        stage: 'recall_summary',
        cap: explicitStageQueryCap,
        buildWhereSql: (stageBind) =>
          `${EXTERNAL_SEED_RECALL_SQL_FIELDS.retrievalSummary} LIKE ANY(${stageBind(recallTerms.patterns)}::text[])`,
      });
    }

    const rows = stagedRows.slice(0, safeLimit);
    const products = annotateProviderProducts(
      productProvider,
      rows.map((row) => buildExternalSeedBrandSearchProduct(row)).filter(Boolean),
    );
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: stepName,
      status: 'success',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products,
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label,
          query: recallTerms.phrases.join(' | '),
          limit: safeLimit,
          returned: products.length,
          status: 200,
          latencyMs: Date.now() - stepStartedAt,
          market,
          marketSource: marketConfig.source,
          compoundIntent,
          externalSeedStageCounts,
          externalSeedRawCount,
          externalSeedQualifiedCount: stagedRows.length,
          externalSeedFilteredCompoundCount,
          externalSeedFilteredQueryTextCount,
        }),
      ],
    };
  } catch (err) {
    recordDiscoveryRecallStep({
      surface: request?.surface,
      step: stepName,
      status: 'error',
      latencyMs: Date.now() - stepStartedAt,
      cacheHit: false,
    });
    return {
      products: [],
      recallSummary: [
        buildDiscoveryProviderStepSummary({
          provider,
          label,
          query: recallTerms.phrases.join(' | '),
          limit: safeLimit,
          returned: 0,
          status: null,
          latencyMs: Date.now() - stepStartedAt,
          market,
          marketSource: marketConfig.source,
          error: err?.message || String(err),
        }),
      ],
    };
  }
}

async function fetchBeautyInterestMainlineCandidates({
  request,
  profile,
  queries = [],
  limit = MAX_CANDIDATE_FETCH,
  fetchFn = null,
} = {}) {
  if (typeof fetchFn !== 'function') {
    return fetchBeautyInterestExternalSeedFastpathCandidates({
      request,
      profile,
      queries,
      limit,
    });
  }

  const result = await fetchExternalSeedCandidates({
    request,
    profile,
    queries,
    limit,
    fetchFn,
  });
  return {
    products: annotateProviderProducts('beauty_interest_mainline', result?.products || []),
    recallSummary: (Array.isArray(result?.recallSummary) ? result.recallSummary : []).map((step) => ({
      ...step,
      label: 'beauty_interest_mainline',
    })),
  };
}

function buildProviderBreakdown(results = []) {
  return DISCOVERY_PROVIDER_ORDER.map((provider) => {
    const result = (Array.isArray(results) ? results : []).find((entry) => entry?.provider === provider) || null;
    const recallSummary = Array.isArray(result?.recallSummary) ? result.recallSummary : [];
    const attempted = recallSummary.length > 0;
    const successfulSteps = recallSummary.filter((step) => Number(step?.status || 0) >= 200 && Number(step?.status || 0) < 300);
    const skipped = attempted && recallSummary.every((step) => step?.skipped === true);
    const latencyMs = recallSummary.reduce((sum, step) => sum + Math.max(0, Number(step?.latency_ms || 0)), 0);
    const skipReason = recallSummary.find((step) => typeof step?.skip_reason === 'string')?.skip_reason || null;
    const failureReason =
      recallSummary.find((step) => typeof step?.failure_reason === 'string')?.failure_reason ||
      (['missing_database', 'schema_missing', 'query_error', 'budget_truncated'].includes(skipReason)
        ? skipReason
        : null);
    let zeroRecallReason = null;
    if (attempted && !skipped && (Array.isArray(result?.products) ? result.products.length : 0) === 0) {
      if (recallSummary.some((step) => step?.truncated_by_budget === true)) {
        zeroRecallReason = 'budget_truncated';
      } else if (failureReason) {
        zeroRecallReason = failureReason;
      } else if (recallSummary.some((step) => step?.error)) {
        zeroRecallReason = 'provider_error';
      } else if (successfulSteps.length > 0) {
        zeroRecallReason = 'zero_products';
      } else {
        zeroRecallReason = 'unavailable';
      }
    }
    return {
      provider,
      attempted,
      successful: successfulSteps.length > 0,
      returned: Array.isArray(result?.products) ? result.products.length : 0,
      steps: recallSummary.length,
      skipped,
      latency_ms: latencyMs,
      ...(skipReason ? { skip_reason: skipReason } : {}),
      ...(failureReason ? { failure_reason: failureReason } : {}),
      ...(zeroRecallReason ? { zero_recall_reason: zeroRecallReason } : {}),
    };
  });
}

function isHighQualityProviderCandidate(candidate, request, profile) {
  if (!candidate) return false;
  if (
    isExplicitQueryScopedBrowseRequest(request) &&
    resolveExplicitBeautyCompoundIntent(request?.query?.text) &&
    !matchesBeautyCompoundQueryIntent(candidate, resolveExplicitBeautyCompoundIntent(request?.query?.text))
  ) {
    return false;
  }

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

function getPrimaryPathEnoughThreshold(request) {
  const limit = Math.max(1, Number(request?.limit || 0) || 0);
  if (request?.surface === 'browse_products') {
    const page = Math.max(1, Number(request?.page || 0) || 1);
    return Math.max(limit, page * limit);
  }
  return limit;
}

function hasSufficientProviderCandidates(products = [], { request, profile, enoughThreshold, qualityThreshold } = {}) {
  return (
    Array.isArray(products) &&
    products.length >= Number(enoughThreshold || 0) &&
    countHighQualityProviderCandidates(products, { request, profile }) >= Number(qualityThreshold || 0)
  );
}

function resolveExplicitQueryInternalSkipEnoughThreshold(request, enoughThreshold) {
  if (!isExplicitQueryScopedBrowseRequest(request)) return enoughThreshold;
  const requestedLimit = Math.max(1, Number(request?.limit || 0) || 12);
  const requestedPage = Math.max(1, Number(request?.page || 0) || 1);
  const currentPageNeed = requestedPage * requestedLimit;
  const bufferedNeed = currentPageNeed + Math.ceil(requestedLimit * 0.5);
  return Math.min(
    Number(enoughThreshold || bufferedNeed) || bufferedNeed,
    Math.max(requestedLimit, bufferedNeed),
  );
}

function resolveExplicitQueryExternalSeedMainlineAcceptThreshold(request, safeLimit) {
  if (!isExplicitQueryScopedBrowseRequest(request)) return Number.POSITIVE_INFINITY;
  const fetchCap = Math.max(1, Number(safeLimit || 0) || getDiscoveryCandidateFetchCap(request));
  const requestedLimit = clampInt(request?.limit, 12, 1, 48);
  const minAcceptCount = requestedLimit >= 8 ? 8 : requestedLimit;
  const cursorOffset = request?.cursor
    ? getDiscoveryCursorAbsoluteOffset(request.cursor, requestedLimit)
    : null;
  const page = Math.max(1, Number(request?.page || 0) || 1);
  const pageOffset =
    cursorOffset != null && Number.isFinite(cursorOffset)
      ? Math.max(0, cursorOffset)
      : (page - 1) * requestedLimit;
  return Math.min(fetchCap, Math.max(minAcceptCount, pageOffset + minAcceptCount));
}

function hasSufficientExplicitQueryExternalSeedMainline(products = [], { request, safeLimit } = {}) {
  if (!isExplicitQueryScopedBrowseRequest(request)) return false;
  const threshold = resolveExplicitQueryExternalSeedMainlineAcceptThreshold(request, safeLimit);
  return Array.isArray(products) && products.length >= threshold;
}

function resolveExternalSeedProviderLimit(request, safeLimit) {
  const fetchCap = getDiscoveryCandidateFetchCap(request);
  const cappedSafeLimit = clampInt(safeLimit, fetchCap, 12, fetchCap);
  const compoundIntent = isExplicitQueryScopedBrowseRequest(request)
    ? resolveExplicitBeautyCompoundIntent(request?.query?.text)
    : null;
  if (compoundIntent) {
    const requestedLimit = Math.max(1, Number(request?.limit || 0) || 12);
    const page = Math.max(1, Number(request?.page || 0) || 1);
    const providerLimit = Math.max(
      page * requestedLimit + requestedLimit * 2,
      resolveExplicitBrowseCursorPrefetchNeed(request),
      120,
    );
    return Math.min(fetchCap, providerLimit);
  }
  if (request?.surface === 'browse_products') {
    const prefetchFloor = Math.min(resolveGenericBrowsePrefetchFloor(request), cappedSafeLimit);
    const explicitBrowseCursorPrefetch = resolveExplicitBrowseCursorPrefetchNeed(request);
    const browseNeed = Math.max(
      (request?.page || 1) * (request?.limit || 0) + (request?.limit || 0),
      prefetchFloor,
      explicitBrowseCursorPrefetch,
      18,
    );
    return clampInt(browseNeed, Math.min(cappedSafeLimit, 48), 12, cappedSafeLimit);
  }
  const homeNeed = Math.max((request?.limit || 0) * 3, 18);
  return clampInt(homeNeed, Math.min(cappedSafeLimit, 24), 12, Math.min(cappedSafeLimit, 30));
}

function buildExternalSeedProviderQueries(request, profile, queries = []) {
  const explicitQuery = getExplicitDiscoveryQueryText(request);
  if (explicitQuery && isExplicitQueryScopedBrowseRequest(request)) {
    return [explicitQuery];
  }
  const prioritized = prioritizeDiscoveryRecallQueries(queries);
  if (!prioritized.length) return [];
  if (!profile?.hasInterestSignals) return prioritized.slice(0, 2);
  if (profile?.dominantDomain === 'beauty') return prioritized.slice(0, 3);
  if (request?.surface === 'browse_products') return prioritized.slice(0, 3);
  return prioritized.slice(0, 2);
}

function shouldDeferInternalCatalogCandidate(candidate, profile) {
  return (
    profile?.hasInterestSignals === true &&
    profile?.dominantDomain === 'beauty' &&
    String(candidate?.provider || '').trim() === 'internal_catalog'
  );
}

async function loadCatalogCandidates({
  request = null,
  profile = null,
  limit = MAX_CANDIDATE_FETCH,
  providerOverrides = null,
} = {}) {
  const safeLimit = clampInt(
    limit,
    resolveDiscoveryCandidateLimit(request),
    24,
    getDiscoveryCandidateFetchCap(request),
  );
  const providerQueries = buildDiscoveryProviderQueries(request, profile);
  const enoughThreshold = getRecallEnoughThreshold(request, safeLimit);
  const qualityThreshold = getProviderQualityThreshold(request);
  const primaryPathEnoughThreshold = getPrimaryPathEnoughThreshold(request);
  const providerResults = [];
  const mergedProducts = [];
  const seenKeys = new Set();
  const useBeautyInterestMainline = shouldUseBeautyInterestMainline(request, profile);
  const internalProviderLimit = Math.min(safeLimit, 72);
  const externalProviderLimit = resolveExternalSeedProviderLimit(request, safeLimit);
  const externalProviderQueries = buildExternalSeedProviderQueries(request, profile, providerQueries);
  let candidateSource = useBeautyInterestMainline ? 'beauty_interest_mainline' : 'multi_provider';
  let primaryPathUsed = useBeautyInterestMainline ? 'beauty_interest_mainline' : 'multi_provider';
  let fallbackTriggered = false;
  let fallbackReason = null;
  const explicitQueryScoped = isExplicitQueryScopedBrowseRequest(request);
  const compoundIntent = explicitQueryScoped
    ? resolveExplicitBeautyCompoundIntent(request?.query?.text)
    : null;

  const mergeProducts = (products = []) => {
    for (const product of Array.isArray(products) ? products : []) {
      if (compoundIntent) {
        const normalized = normalizeCandidateProduct(product, mergedProducts.length);
        if (!normalized || !matchesBeautyCompoundQueryIntent(normalized, compoundIntent)) continue;
      }
      const key = buildDiscoveryProviderMergeKey(product);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      mergedProducts.push(product);
      if (mergedProducts.length >= safeLimit) break;
    }
  };

  const getProviderLabel = (provider) => {
    if (provider === 'beauty_interest_mainline') return 'beauty_interest_mainline';
    if (provider === 'products_search') return 'products_search_pool';
    if (provider === 'internal_catalog') return 'internal_catalog_pool';
    return 'external_seed_pool';
  };

  const buildProviderErrorResult = (provider, err) => ({
    provider,
    products: [],
    recallSummary: [
      buildDiscoveryProviderStepSummary({
        provider,
        label: getProviderLabel(provider),
        query: providerQueries.join(' | '),
        limit: safeLimit,
        returned: 0,
        status: null,
        latencyMs: 0,
        failureReason: classifyDiscoveryQueryError(err),
        error: err?.message || String(err),
      }),
    ],
  });

  const appendProviderResult = (result) => {
    if (!result || typeof result !== 'object') return;
    providerResults.push(result);
    mergeProducts(result.products);
  };

  const fetchProductsSearchProviderResult = async () => {
    try {
      const searchResult = await loadProductsSearchCandidates({
        request,
        profile,
        limit: safeLimit,
      });
      return {
        provider: 'products_search',
        products: annotateProviderProducts('products_search', searchResult?.products || []),
        recallSummary: Array.isArray(searchResult?.recallSummary)
          ? searchResult.recallSummary.map((step) => ({ provider: 'products_search', ...step }))
          : [],
      };
    } catch (err) {
      return buildProviderErrorResult('products_search', err);
    }
  };

  const finalizeProviderResult = () => {
    const recallSummary = providerResults.flatMap((result) =>
      (Array.isArray(result?.recallSummary) ? result.recallSummary : []).map((step) => ({
        provider: result.provider,
        ...step,
      })),
    );
    const providerBreakdown = buildProviderBreakdown(providerResults);
    const successfulProviders = providerBreakdown.filter((entry) => entry.successful);
    const unavailableError = new DiscoveryCatalogUnavailableError(
      'Failed to load discovery candidates from discovery providers',
      {
        providerBreakdown,
        recallSummary,
        candidateSource,
        primaryPathUsed,
        fallbackTriggered,
        fallbackReason,
      },
    );

    if (successfulProviders.length <= 0) {
      if (shouldUseBrandDirectPoolInsteadOfGenericBrandExpansion(request)) {
        return {
          products: mergedProducts,
          recallSummary,
          providerBreakdown,
          candidateSource,
          primaryPathUsed,
          fallbackTriggered,
          fallbackReason,
          catalogUnavailableError: unavailableError,
        };
      }
      throw unavailableError;
    }

    return {
      products: mergedProducts,
      recallSummary,
      providerBreakdown,
      candidateSource,
      primaryPathUsed,
      fallbackTriggered,
      fallbackReason,
      catalogUnavailableError: null,
    };
  };

  const exactTitlePrimaryResult = await fetchExternalSeedExactTitleCandidates({
    request,
    profile,
    limit: externalProviderLimit,
  });
  if (exactTitlePrimaryResult?.products?.length) {
    candidateSource = 'exact_title_primary';
    primaryPathUsed = 'exact_title_primary';
    providerResults.push({
      provider: 'external_seeds',
      products: exactTitlePrimaryResult.products,
      recallSummary: exactTitlePrimaryResult.recallSummary,
    });
    mergeProducts(exactTitlePrimaryResult.products);
    providerResults.push(
      buildSkippedProviderResult('products_search', {
        label: getProviderLabel('products_search'),
        query: providerQueries.join(' | '),
        limit: safeLimit,
        skipReason: 'exact_title_primary_used',
      }),
    );
    providerResults.push(
      buildSkippedProviderResult('internal_catalog', {
        label: getProviderLabel('internal_catalog'),
        query: providerQueries.join(' | '),
        limit: internalProviderLimit,
        skipReason: 'exact_title_primary_used',
      }),
    );
    return finalizeProviderResult();
  }

  if (useBeautyInterestMainline) {
    try {
      const beautyMainlineResult = await fetchBeautyInterestMainlineCandidates({
        request,
        profile,
        queries: externalProviderQueries,
        limit: externalProviderLimit,
        fetchFn: providerOverrides?.beauty_interest_mainline || providerOverrides?.external_seeds || null,
      });
      const normalizedBeautyMainlineResult = {
        provider: 'beauty_interest_mainline',
        products: beautyMainlineResult.products,
        recallSummary: beautyMainlineResult.recallSummary,
      };
      providerResults.push(normalizedBeautyMainlineResult);
      mergeProducts(normalizedBeautyMainlineResult.products);
    } catch (err) {
      providerResults.push(buildProviderErrorResult('beauty_interest_mainline', err));
    }

    const beautyMainlineEnough = hasSufficientProviderCandidates(mergedProducts, {
      request,
      profile,
      enoughThreshold: primaryPathEnoughThreshold,
      qualityThreshold,
    });
    if (beautyMainlineEnough) {
      providerResults.push(
        buildSkippedProviderResult('products_search', {
          label: getProviderLabel('products_search'),
          query: providerQueries.join(' | '),
          limit: safeLimit,
          skipReason: 'beauty_interest_mainline_sufficient',
        }),
      );
      providerResults.push(
        buildSkippedProviderResult('internal_catalog', {
          label: getProviderLabel('internal_catalog'),
          query: providerQueries.join(' | '),
          limit: internalProviderLimit,
          skipReason: 'beauty_interest_mainline_sufficient',
        }),
      );
      providerResults.push(
        buildSkippedProviderResult('external_seeds', {
          label: getProviderLabel('external_seeds'),
          query: externalProviderQueries.join(' | '),
          limit: externalProviderLimit,
          skipReason: 'beauty_interest_mainline_primary_used',
        }),
      );
      return finalizeProviderResult();
    }
    candidateSource = 'beauty_interest_mainline+multi_provider';
    fallbackTriggered = true;
    fallbackReason =
      mergedProducts.length > 0
        ? 'beauty_interest_mainline_insufficient'
        : 'beauty_interest_mainline_zero_recall';
  }

  const shouldUseNoSignalExternalSeedFastpath = isGenericNoSignalDiscoveryRequest(request, profile);
  if (shouldUseNoSignalExternalSeedFastpath) {
    try {
      const externalResult = await fetchBeautyInterestExternalSeedFastpathCandidates({
        request,
        profile,
        queries: externalProviderQueries,
        limit: externalProviderLimit,
        fetchFn: providerOverrides?.external_seeds || null,
        providerName: 'external_seeds',
        productProvider: 'external_seeds',
        stepName: 'external_seed_pool_fastpath',
        label: 'external_seed_pool_fastpath',
      });
      providerResults.push({
        provider: 'external_seeds',
        products: externalResult.products,
        recallSummary: externalResult.recallSummary,
      });
      mergeProducts(externalResult.products);
    } catch (err) {
      providerResults.push(buildProviderErrorResult('external_seeds', err));
    }

    if (shouldSkipNoSignalProviderExpansion(mergedProducts, { request, profile })) {
      candidateSource = 'external_seed_fastpath';
      primaryPathUsed = 'external_seed_fastpath';
      providerResults.push(
        buildSkippedProviderResult('products_search', {
          label: getProviderLabel('products_search'),
          query: providerQueries.join(' | '),
          limit: safeLimit,
          skipReason: 'anonymous_cold_start_fastpath_sufficient',
        }),
      );
      providerResults.push(
        buildSkippedProviderResult('internal_catalog', {
          label: getProviderLabel('internal_catalog'),
          query: providerQueries.join(' | '),
          limit: internalProviderLimit,
          skipReason: 'anonymous_cold_start_internal_disabled',
        }),
      );
      return finalizeProviderResult();
    }

    candidateSource = 'external_seed_fastpath+products_search';
    primaryPathUsed = 'external_seed_fastpath';
    fallbackTriggered = true;
    fallbackReason =
      mergedProducts.length > 0
        ? 'anonymous_cold_start_fastpath_insufficient'
        : 'anonymous_cold_start_fastpath_zero_recall';

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

    providerResults.push(
      buildSkippedProviderResult('internal_catalog', {
        label: getProviderLabel('internal_catalog'),
        query: providerQueries.join(' | '),
        limit: internalProviderLimit,
        skipReason: 'anonymous_cold_start_internal_disabled',
      }),
    );

    return finalizeProviderResult();
  }

  if (compoundIntent) {
    providerResults.push(
      buildSkippedProviderResult('products_search', {
        label: getProviderLabel('products_search'),
        query: providerQueries.join(' | '),
        limit: safeLimit,
        skipReason: 'explicit_compound_external_seed_mainline',
      }),
    );
  } else if (!explicitQueryScoped) {
    appendProviderResult(await fetchProductsSearchProviderResult());
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
    return finalizeProviderResult();
  }

  const shouldSkipAnonymousExpansion = shouldSkipNoSignalProviderExpansion(mergedProducts, {
    request,
    profile,
  });
  if (shouldSkipAnonymousExpansion) {
    providerResults.push(
      buildSkippedProviderResult('internal_catalog', {
        label: 'internal_catalog_pool',
        query: providerQueries.join(' | '),
        limit: internalProviderLimit,
        skipReason: 'sufficient_no_signal_primary_candidates',
      }),
    );
    providerResults.push(
      buildSkippedProviderResult('external_seeds', {
        label: 'external_seed_pool',
        query: externalProviderQueries.join(' | '),
        limit: externalProviderLimit,
        skipReason: 'sufficient_no_signal_primary_candidates',
      }),
    );
    return finalizeProviderResult();
  }

  const shouldSkipPersonalizedExpansion = shouldSkipPersonalizedProviderExpansion(mergedProducts, {
    request,
    profile,
  });
  if (shouldSkipPersonalizedExpansion) {
    providerResults.push(
      buildSkippedProviderResult('internal_catalog', {
        label: 'internal_catalog_pool',
        query: providerQueries.join(' | '),
        limit: internalProviderLimit,
        skipReason: 'sufficient_personalized_primary_candidates',
      }),
    );
    providerResults.push(
      buildSkippedProviderResult('external_seeds', {
        label: 'external_seed_pool',
        query: externalProviderQueries.join(' | '),
        limit: externalProviderLimit,
        skipReason: 'sufficient_personalized_primary_candidates',
      }),
    );
    return finalizeProviderResult();
  }

  const shouldSkipInternal =
    useBeautyInterestMainline &&
    hasSufficientProviderCandidates(mergedProducts, {
      request,
      profile,
      enoughThreshold,
      qualityThreshold,
    });
  const shouldSkipExternalSeeds =
    useBeautyInterestMainline ||
    hasSufficientProviderCandidates(mergedProducts, {
      request,
      profile,
      enoughThreshold,
      qualityThreshold,
    });

  const pushSkippedInternalProviderResult = (skipReason) => {
    providerResults.push(
      buildSkippedProviderResult('internal_catalog', {
        label: getProviderLabel('internal_catalog'),
        query: providerQueries.join(' | '),
        limit: internalProviderLimit,
        skipReason,
      }),
    );
  };

  const pushSkippedExternalSeedProviderResult = (skipReason) => {
    providerResults.push(
      buildSkippedProviderResult('external_seeds', {
        label: getProviderLabel('external_seeds'),
        query: externalProviderQueries.join(' | '),
        limit: externalProviderLimit,
        skipReason,
      }),
    );
  };

  const fetchInternalProviderResult = async () => {
    try {
      const internalResult = await fetchInternalCatalogCandidates({
        request,
        profile,
        queries: providerQueries,
        limit: internalProviderLimit,
        fetchFn: providerOverrides?.internal_catalog || null,
      });
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
  };

  const loadExternalSeedProviderResult = async () => {
    try {
      const externalResult = explicitQueryScoped
        ? await fetchBeautyInterestExternalSeedFastpathCandidates({
            request,
            profile,
            queries: externalProviderQueries,
            limit: externalProviderLimit,
            fetchFn: providerOverrides?.external_seeds || null,
            providerName: 'external_seeds',
            productProvider: 'external_seeds',
            stepName: 'external_seed_pool',
            label: 'external_seed_pool',
          })
        : await fetchExternalSeedCandidates({
            request,
            profile,
            queries: externalProviderQueries,
            limit: externalProviderLimit,
            fetchFn: providerOverrides?.external_seeds || null,
          });
      return {
        provider: 'external_seeds',
        products: externalResult.products,
        recallSummary: externalResult.recallSummary,
      };
    } catch (err) {
      return buildProviderErrorResult('external_seeds', err);
    }
  };

  const fetchExternalSeedProviderResult = async () => {
    appendProviderResult(await loadExternalSeedProviderResult());
  };

  const externalSkipReason = useBeautyInterestMainline
    ? 'beauty_interest_mainline_primary_used'
    : 'sufficient_primary_candidates';
  const explicitNarrowQueryMainline = shouldSkipBroadStructuredSeedStagesForExplicitQuery(request, {
    compoundIntent,
  });

  if (explicitQueryScoped) {
    if (compoundIntent) {
      await fetchExternalSeedProviderResult();
    } else if (explicitNarrowQueryMainline) {
      await fetchExternalSeedProviderResult();
    } else {
      await fetchExternalSeedProviderResult();
      if (
        hasSufficientExplicitQueryExternalSeedMainline(mergedProducts, {
          request,
          safeLimit,
        })
      ) {
        candidateSource = 'external_seed_query_mainline';
        primaryPathUsed = 'external_seed_query_mainline';
        providerResults.push(
          buildSkippedProviderResult('products_search', {
            label: getProviderLabel('products_search'),
            query: providerQueries.join(' | '),
            limit: safeLimit,
            skipReason: 'sufficient_explicit_query_external_seed_mainline',
          }),
        );
        pushSkippedInternalProviderResult('sufficient_explicit_query_external_seed_mainline');
        return finalizeProviderResult();
      }
      appendProviderResult(await fetchProductsSearchProviderResult());
    }

    if (compoundIntent && mergedProducts.length > 0) {
      candidateSource = 'external_seed_compound_intent';
      primaryPathUsed = 'external_seed_compound_intent';
      pushSkippedInternalProviderResult('explicit_compound_external_seed_mainline');
      return finalizeProviderResult();
    }

    if (explicitNarrowQueryMainline && mergedProducts.length > 0) {
      candidateSource = 'external_seed_narrow_query';
      primaryPathUsed = 'external_seed_narrow_query';
      providerResults.push(
        buildSkippedProviderResult('products_search', {
          label: getProviderLabel('products_search'),
          query: providerQueries.join(' | '),
          limit: safeLimit,
          skipReason: 'explicit_narrow_external_seed_mainline',
        }),
      );
      pushSkippedInternalProviderResult('explicit_narrow_external_seed_mainline');
      return finalizeProviderResult();
    }

    const internalSkipEnoughThreshold = resolveExplicitQueryInternalSkipEnoughThreshold(
      request,
      enoughThreshold,
    );
    const shouldSkipInternalAfterExternal =
      shouldSkipInternal ||
      hasSufficientProviderCandidates(mergedProducts, {
        request,
        profile,
        enoughThreshold: internalSkipEnoughThreshold,
        qualityThreshold,
      });
    if (shouldSkipInternalAfterExternal) {
      pushSkippedInternalProviderResult(
        shouldSkipInternal ? 'sufficient_primary_candidates' : 'sufficient_explicit_query_external_candidates',
      );
    } else {
      await fetchInternalProviderResult();
    }
    return finalizeProviderResult();
  }

  if (shouldSkipInternal) {
    pushSkippedInternalProviderResult('sufficient_primary_candidates');
  } else {
    await fetchInternalProviderResult();
  }

  if (shouldSkipExternalSeeds) {
    pushSkippedExternalSeedProviderResult(externalSkipReason);
  } else {
    await fetchExternalSeedProviderResult();
  }

  return finalizeProviderResult();
}

function buildBrandDirectPrimaryCandidateResult({
  request,
  profile,
  limit = MAX_CANDIDATE_FETCH,
  directLoadResult = null,
} = {}) {
  const safeLimit = clampInt(
    limit,
    resolveDiscoveryCandidateLimit(request),
    24,
    getDiscoveryCandidateFetchCap(request),
  );
  const providerQueries = buildDiscoveryProviderQueries(request, profile);
  const externalProviderQueries = buildExternalSeedProviderQueries(request, profile, providerQueries);
  const internalProviderLimit = Math.min(safeLimit, 72);
  const externalProviderLimit = resolveExternalSeedProviderLimit(request, safeLimit);
  const brandQuery = buildDiscoveryBrandScopedQuery(request);
  const skippedProviderResults = [
    buildSkippedProviderResult('products_search', {
      label: 'brand_pool',
      query: brandQuery,
      limit: safeLimit,
      skipReason: 'brand_direct_pool_primary_used',
    }),
    buildSkippedProviderResult('internal_catalog', {
      label: 'internal_catalog_pool',
      query: providerQueries.join(' | '),
      limit: internalProviderLimit,
      skipReason: 'brand_direct_pool_primary_used',
    }),
    buildSkippedProviderResult('external_seeds', {
      label: 'external_seed_pool',
      query: externalProviderQueries.join(' | '),
      limit: externalProviderLimit,
      skipReason: 'brand_direct_pool_primary_used',
    }),
  ];

  return {
    products: annotateProviderProducts('brand_direct_pool', directLoadResult?.products || []),
    recallSummary: [
      ...((Array.isArray(directLoadResult?.recallSummary) ? directLoadResult.recallSummary : []).map((step) => ({
        provider: null,
        ...step,
      }))),
      ...skippedProviderResults.flatMap((result) =>
        (Array.isArray(result?.recallSummary) ? result.recallSummary : []).map((step) => ({
          provider: result.provider,
          ...step,
        })),
      ),
    ],
    providerBreakdown: buildProviderBreakdown(skippedProviderResults),
    candidateSource: 'brand_direct_primary',
    primaryPathUsed: 'brand_direct_pool',
    fallbackTriggered: false,
    fallbackReason: null,
    catalogUnavailableError: null,
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
      candidate?.raw?.external_seed_recall?.retrieval_title,
      candidate?.raw?.external_seed_recall?.retrieval_summary,
      candidate?.raw?.external_seed_recall?.category,
      candidate?.raw?.external_seed_recall?.vertical,
      candidate?.raw?.external_seed_recall?.ingredient_tokens,
      candidate?.raw?.external_seed_recall?.alias_tokens,
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

function textHasNormalizedToken(text, token) {
  const normalized = normalizeText(text || '');
  const normalizedToken = normalizeText(token || '');
  if (!normalized || !normalizedToken) return false;
  return new RegExp(`(?:^|\\s)${normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(normalized);
}

function hasAnyNormalizedClassToken(text, items = []) {
  const normalized = normalizeText(text || '');
  if (!normalized) return false;
  return (Array.isArray(items) ? items : []).some((item) => {
    const value = normalizeText(item || '');
    if (!value) return false;
    if (value.includes(' ')) return normalized.includes(value);
    return textHasNormalizedToken(normalized, value);
  });
}

function hasOilIntentToken(text) {
  return (
    textHasNormalizedToken(text, 'oil') ||
    textHasNormalizedToken(text, 'oils') ||
    textHasNormalizedToken(text, 'huile')
  );
}

function matchesBeautyCompoundQueryIntent(candidate, intent) {
  if (!intent) return true;
  const rule = EXPLICIT_BEAUTY_COMPOUND_INTENT_RULES[intent] || null;
  const raw = candidate?.raw || {};
  const titleText = normalizeText([raw.title, raw.name, raw.external_seed_recall?.retrieval_title].filter(Boolean).join(' '));
  const summaryText = normalizeText(
    [
      raw.description,
      raw.external_seed_recall?.retrieval_summary,
      raw.external_seed_recall?.retrieval_body,
    ]
      .filter(Boolean)
      .join(' '),
  );
  const categoryText = normalizeText(
    [
      candidate?.category,
      candidate?.parentCategory,
      raw.category,
      raw.product_type,
      raw.productType,
      raw.external_seed_recall?.category,
    ]
      .filter(Boolean)
      .join(' '),
  );
  const verticalText = normalizeText(raw.external_seed_recall?.vertical || '');
  const combinedCategoryText = normalizeText([categoryText, verticalText].filter(Boolean).join(' '));
  const negativeClasses = rule?.negativeClasses || [];

  if (intent === 'hair_oil') {
    if (hasAnyNormalizedClassToken([combinedCategoryText, titleText].join(' '), negativeClasses)) return false;
    if (titleText.includes('hair oil')) return true;
    if (hasAnyNormalizedClassToken(combinedCategoryText, rule?.primaryPositive || [])) return true;
    const structuredCategoryLooksHair =
      categoryText.includes('haircare') ||
      categoryText.includes('hair care') ||
      textHasNormalizedToken(categoryText, 'hair');
    const verticalLooksHair =
      verticalText.includes('haircare') ||
      verticalText.includes('hair care') ||
      textHasNormalizedToken(verticalText, 'hair');
    const titleOrSummaryMentionsHair =
      textHasNormalizedToken(titleText, 'hair') || textHasNormalizedToken(summaryText, 'hair');
    const hasOilSignal = hasOilIntentToken(titleText) || hasOilIntentToken(summaryText);
    return Boolean(
      (structuredCategoryLooksHair && hasOilSignal) ||
        (verticalLooksHair && titleOrSummaryMentionsHair && hasOilSignal),
    );
  }

  if (intent === 'lip_balm') {
    if (hasAnyNormalizedClassToken([combinedCategoryText, titleText].join(' '), negativeClasses)) return false;
    if (titleText.includes('lip balm')) return true;
    const categoryLooksLip =
      textHasNormalizedToken(combinedCategoryText, 'lip') ||
      combinedCategoryText.includes('lip care') ||
      hasAnyNormalizedClassToken(combinedCategoryText, rule?.primaryPositive || []);
    return categoryLooksLip && textHasNormalizedToken(titleText, 'balm');
  }

  if (intent === 'lip_oil') {
    if (hasAnyNormalizedClassToken([combinedCategoryText, titleText].join(' '), negativeClasses)) return false;
    if (titleText.includes('lip oil')) return true;
    const categoryLooksLip =
      textHasNormalizedToken(combinedCategoryText, 'lip') ||
      combinedCategoryText.includes('lip care') ||
      hasAnyNormalizedClassToken(combinedCategoryText, rule?.primaryPositive || []);
    return categoryLooksLip && hasOilIntentToken(titleText);
  }

  return true;
}

function matchesExternalSeedCompoundQueryIntent(candidate, intent) {
  return matchesBeautyCompoundQueryIntent(candidate, intent);
}

function shouldFilterBrowseCandidateByQueryText(candidate, queryText, options = {}) {
  if (!String(queryText || '').trim()) return false;
  if (options?.explicitQueryScoped === true) {
    const domain = String(candidate?.domain || 'unknown').trim();
    if (!COLD_START_DEFERRED_DOMAINS.has(domain) && candidate?.beautyBucket !== 'tools') {
      const compoundIntent = resolveExplicitBeautyCompoundIntent(queryText);
      return compoundIntent
        ? !matchesBeautyCompoundQueryIntent(candidate, compoundIntent)
        : !matchesQueryTextCandidate(candidate, queryText);
    }
  }
  return !matchesQueryTextCandidate(candidate, queryText);
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
  const safeLimit = clampInt(limit, BRAND_RECOMMENDATION_FALLBACK_LIMIT, 1, BRAND_RECOMMENDATION_FALLBACK_LIMIT);
  const baseProduct = {
    ...(sourceProductId ? { product_id: sourceProductId } : {}),
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(brandName ? { brand: brandName, vendor: brandName } : {}),
  };

  if (!sourceProductId || typeof recommendFn !== 'function') return [];
  try {
    const result = await recommendFn({
      pdp_product: baseProduct,
      k: safeLimit,
      locale: request?.context?.locale || 'en-US',
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

function shouldDeferColdStartInternalSourceCandidate(candidate) {
  if (!candidate || candidate.domain !== 'beauty') return false;
  if (candidate.beautyBucket === 'tools') return false;
  return !isExternalSeedMerchantCandidate(candidate);
}

function isGenericAnonymousBrowseColdStart(profile, options = {}) {
  const brandScoped = options.brandScoped === true;
  const sort = normalizeDiscoverySort(options.sort);
  const queryText = String(options.queryText || '').trim();
  const categoryScope = Array.isArray(options.categoryScope) ? options.categoryScope : [];
  return !profile?.hasInterestSignals && sort === 'popular' && !brandScoped && !queryText && categoryScope.length === 0;
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

function getColdStartHomeBrandCap(candidate) {
  return isExternalSeedMerchantCandidate(candidate) && candidate?.domain === 'beauty' ? 8 : 2;
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
  const externalSeedBeautyCandidateCount = coldStartCuration
    ? ranked.filter(
        (entry) =>
          isExternalSeedMerchantCandidate(entry.candidate) &&
          entry.candidate?.domain === 'beauty' &&
          entry.candidate?.beautyBucket !== 'tools',
      ).length
    : 0;
  const hasExternalSeedBeautyCandidate =
    coldStartCuration &&
    externalSeedBeautyCandidateCount >= Math.max(MIN_COLD_START_NON_DEFERRED_RESULTS, limit - 1);

  const selected = [];
  const decisions = collectDebug ? new Map() : null;
  const brandCounts = new Map();
  const rankedEligible = [];
  const internalDeferred = [];
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
    if (hasExternalSeedBeautyCandidate && shouldDeferColdStartInternalSourceCandidate(entry.candidate)) {
      coldStartDeferred.push(entry);
      if (decisions) decisions.set(entry.candidate.key, 'filtered_cold_start_internal_source');
      continue;
    }
    if (shouldDeferInternalCatalogCandidate(entry.candidate, profile)) {
      internalDeferred.push(entry);
      if (decisions) decisions.set(entry.candidate.key, 'deferred_internal_catalog');
      continue;
    }
    rankedEligible.push(entry);
    if (selected.length >= limit) continue;
    const brandKey = entry.candidate.brand;
    const nextBrandCount = brandKey ? (brandCounts.get(brandKey) || 0) + 1 : 0;
    const brandCap = coldStartCuration ? getColdStartHomeBrandCap(entry.candidate) : 2;
    if (brandKey && nextBrandCount > brandCap) {
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
    if (hasExternalSeedBeautyCandidate && shouldDeferColdStartInternalSourceCandidate(entry.candidate)) {
      if (decisions) decisions.set(entry.candidate.key, 'not_selected_cold_start_internal_source');
      continue;
    }
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

  for (const entry of internalDeferred) {
    if (selected.length >= limit) break;
    if (selected.some((picked) => picked.candidate.key === entry.candidate.key)) continue;
    selected.push(entry);
    if (decisions) decisions.set(entry.candidate.key, 'selected_internal_catalog_backfill');
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
    eligiblePool: rankedEligible.concat(internalDeferred),
    decisions,
  };
}

function selectBrowseProducts(scoredCandidates, viewedKeys, page, limit, options = {}) {
  const collectDebug = options.collectDebug === true;
  const profile = options.profile || null;
  const sort = normalizeDiscoverySort(options.sort);
  const brandScoped = options.brandScoped === true;
  const explicitQueryScoped = options.explicitQueryScoped === true;
  const queryText = String(options.queryText || '').trim();
  const categoryScope = normalizeDiscoveryCategories(options.categories, 12);
  const coldStartCuration = isGenericAnonymousBrowseColdStart(profile, {
    sort,
    brandScoped,
    queryText,
    categoryScope,
  });
  const ranked = [...scoredCandidates].sort(compareBrowseEntriesBySort(sort));
  const decisions = collectDebug ? new Map() : null;

  const preCategoryPool = [];
  const internalDeferred = [];
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
    if (shouldFilterBrowseCandidateByQueryText(entry.candidate, queryText, { explicitQueryScoped })) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_query_text');
      continue;
    }
    if (shouldDeferInternalCatalogCandidate(entry.candidate, profile)) {
      internalDeferred.push(entry);
      if (decisions) decisions.set(entry.candidate.key, 'deferred_internal_catalog');
      continue;
    }
    preCategoryPool.push(entry);
  }

  const preferredPool = [];
  const coldStartDeferredPool = [];
  const coldStartDeferredReasons = collectDebug ? new Map() : null;
  const hasExternalSeedBeautyCandidate =
    coldStartCuration &&
    preCategoryPool.some(
      (entry) =>
        isExternalSeedMerchantCandidate(entry.candidate) &&
        entry.candidate?.domain === 'beauty' &&
        entry.candidate?.beautyBucket !== 'tools',
    );
  const orderedInternalDeferred = [];
  for (const entry of preCategoryPool) {
    if (categoryScope.length > 0 && !matchesCategoryScopeCandidate(entry.candidate, categoryScope)) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_category_scope');
      continue;
    }
    if (coldStartCuration && shouldDeferColdStartCandidate(entry.candidate)) {
      coldStartDeferredPool.push(entry);
      if (coldStartDeferredReasons) {
        coldStartDeferredReasons.set(entry.candidate.key, 'filtered_cold_start_domain');
      }
      continue;
    }
    if (hasExternalSeedBeautyCandidate && shouldDeferColdStartInternalSourceCandidate(entry.candidate)) {
      coldStartDeferredPool.push(entry);
      if (coldStartDeferredReasons) {
        coldStartDeferredReasons.set(entry.candidate.key, 'filtered_cold_start_internal_source');
      }
      continue;
    }
    preferredPool.push(entry);
  }
  const orderedPool =
    coldStartCuration && preferredPool.length > 0
      ? preferredPool
      : preferredPool.concat(coldStartDeferredPool);

  if (coldStartCuration && preferredPool.length > 0 && decisions) {
    for (const entry of coldStartDeferredPool) {
      decisions.set(
        entry.candidate.key,
        coldStartDeferredReasons?.get(entry.candidate.key) || 'filtered_cold_start_domain',
      );
    }
  }
  for (const entry of internalDeferred) {
    if (categoryScope.length > 0 && !matchesCategoryScopeCandidate(entry.candidate, categoryScope)) {
      if (decisions) decisions.set(entry.candidate.key, 'filtered_category_scope');
      continue;
    }
    orderedInternalDeferred.push(entry);
  }
  const rankedOrderedPool = orderedPool.concat(orderedInternalDeferred);
  const corpusPreferredPool = [...preferredPool];
  const corpusColdStartDeferredPool = [...coldStartDeferredPool];
  const corpusOrderedInternalDeferred = [...orderedInternalDeferred];

  for (const entry of recentViewDeferred) {
    if (shouldFilterBrowseCandidateByQueryText(entry.candidate, queryText, { explicitQueryScoped })) {
      continue;
    }
    if (shouldDeferInternalCatalogCandidate(entry.candidate, profile)) {
      if (categoryScope.length > 0 && !matchesCategoryScopeCandidate(entry.candidate, categoryScope)) {
        continue;
      }
      corpusOrderedInternalDeferred.push(entry);
      continue;
    }
    if (categoryScope.length > 0 && !matchesCategoryScopeCandidate(entry.candidate, categoryScope)) {
      continue;
    }
    if (coldStartCuration && shouldDeferColdStartCandidate(entry.candidate)) {
      corpusColdStartDeferredPool.push(entry);
      continue;
    }
    if (hasExternalSeedBeautyCandidate && shouldDeferColdStartInternalSourceCandidate(entry.candidate)) {
      corpusColdStartDeferredPool.push(entry);
      continue;
    }
    corpusPreferredPool.push(entry);
  }

  const corpusOrderedPool =
    (
      coldStartCuration && corpusPreferredPool.length > 0
        ? corpusPreferredPool
        : corpusPreferredPool.concat(corpusColdStartDeferredPool)
    ).concat(corpusOrderedInternalDeferred);

  const start = (page - 1) * limit;
  const pageItems = rankedOrderedPool.slice(start, start + limit);
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
      corpusPool: corpusOrderedPool,
      preCategoryPool,
      orderedPool,
      pageItems,
    };
  }

  const selectedKeys = new Set(pageItems.map((entry) => entry.candidate.key));
  for (const entry of rankedOrderedPool) {
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
    corpusPool: corpusOrderedPool,
    ranked,
    preCategoryPool,
    orderedPool: rankedOrderedPool,
    pageItems,
    decisions,
  };
}

function selectBrowseServingWindow(browseSelection, request, options = {}) {
  const limit = clampInt(request?.limit, 20, 1, 100);
  const brandScoped = options.brandScoped === true;
  const queryText = String(options.queryText || '').trim();
  const categoryScope = normalizeDiscoveryCategories(options.categories, 12);
  const explicitIntent = brandScoped || Boolean(queryText) || categoryScope.length > 0;
  const genericCurated = isGenericAnonymousBrowseColdStart(options.profile, {
    sort: request?.sort,
    brandScoped,
    queryText,
    categoryScope,
  });
  const orderedPool = Array.isArray(browseSelection?.orderedPool) ? browseSelection.orderedPool : [];
  const corpusPool = Array.isArray(browseSelection?.corpusPool) ? browseSelection.corpusPool : [];
  const defaultExhaustivePool = genericCurated ? corpusPool : orderedPool;
  const curatedHeadPool = genericCurated ? orderedPool.slice(0, DISCOVERY_CURATED_HEAD_LIMIT) : [];
  const curatedHeadKeys = new Set(
    curatedHeadPool.map((entry) => String(entry?.candidate?.key || '').trim()).filter(Boolean),
  );
  const exhaustivePool =
    genericCurated && curatedHeadKeys.size > 0
      ? defaultExhaustivePool.filter((entry) => !curatedHeadKeys.has(String(entry?.candidate?.key || '').trim()))
      : defaultExhaustivePool;
  const legacyPageMode = !request?.cursor && Number(request?.page || 1) > 1;

  if (legacyPageMode) {
    const currentOffset = Math.max(0, (Number(request.page || 1) - 1) * limit);
    const activeMode = genericCurated ? 'curated_head' : 'exhaustive';
    const activePool = genericCurated ? curatedHeadPool : defaultExhaustivePool;
    const hasNextPage = currentOffset + limit < activePool.length;
    return {
      selectedEntries: Array.isArray(browseSelection?.pageItems) ? browseSelection.pageItems : [],
      servingMode: activeMode,
      cursorInfo: buildDiscoveryCursorInfo({
        request,
        servingMode: activeMode,
        nextOffset: currentOffset + limit,
        nextAbsoluteOffset: currentOffset + limit,
        hasNextPage,
      }),
      hasMore: hasNextPage,
      eligiblePoolCount: orderedPool.length,
      runtimeCorpusCount: corpusPool.length,
    };
  }

  if (!request?.cursor && genericCurated) {
    const selectedEntries = curatedHeadPool.slice(0, limit);
    const hasMoreInHead = limit < curatedHeadPool.length;
    const cursorInfo = hasMoreInHead
      ? buildDiscoveryCursorInfo({
          request,
          servingMode: 'curated_head',
          nextOffset: limit,
          nextAbsoluteOffset: limit,
          hasNextPage: true,
        })
      : buildDiscoveryCursorInfo({
          request,
          servingMode: 'exhaustive',
          nextOffset: 0,
          nextAbsoluteOffset: DISCOVERY_CURATED_HEAD_LIMIT,
          hasNextPage: exhaustivePool.length > 0,
        });
    return {
      selectedEntries,
      servingMode: 'curated_head',
      cursorInfo,
      hasMore: cursorInfo.has_next_page,
      eligiblePoolCount: curatedHeadPool.length,
      runtimeCorpusCount: corpusPool.length,
    };
  }

  const cursorMode =
    request?.cursor?.mode === 'curated_head' && genericCurated ? 'curated_head' : 'exhaustive';
  const selectedPool = cursorMode === 'curated_head' ? curatedHeadPool : exhaustivePool;
  const selectedOffset = request?.cursor?.mode === cursorMode ? request.cursor.offset : 0;
  const slice = selectedPool.slice(selectedOffset, selectedOffset + limit);
  const nextOffset = selectedOffset + limit;
  let cursorInfo = null;

  if (cursorMode === 'curated_head') {
    const hasMoreInHead = nextOffset < curatedHeadPool.length;
    cursorInfo = hasMoreInHead
      ? buildDiscoveryCursorInfo({
          request,
          servingMode: 'curated_head',
          nextOffset,
          nextAbsoluteOffset: nextOffset,
          hasNextPage: true,
        })
      : buildDiscoveryCursorInfo({
          request,
          servingMode: 'exhaustive',
          nextOffset: 0,
          nextAbsoluteOffset: DISCOVERY_CURATED_HEAD_LIMIT,
          hasNextPage: exhaustivePool.length > 0,
        });
  } else {
    cursorInfo = buildDiscoveryCursorInfo({
      request,
      servingMode: 'exhaustive',
      nextOffset,
      nextAbsoluteOffset: getDiscoveryCursorAbsoluteOffset(request?.cursor, limit) + limit,
      hasNextPage: nextOffset < exhaustivePool.length,
    });
  }

  return {
    selectedEntries: slice,
    servingMode: cursorMode,
    cursorInfo,
    hasMore: cursorInfo.has_next_page,
    eligiblePoolCount: selectedPool.length,
    runtimeCorpusCount: corpusPool.length,
  };
}

const SHOPPING_CARD_CONTRACT_VERSION = 'pivota.shopping_card.v1';

function discoveryCardString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function firstDiscoveryCardString(...values) {
  for (const value of values) {
    const text = discoveryCardString(value);
    if (text) return text;
  }
  return '';
}

function discoveryCardArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatDiscoveryCompactCount(count) {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count >= 1000000) return `${(count / 1000000).toFixed(count >= 10000000 ? 0 : 1)}m`;
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`;
  return String(Math.round(count));
}

function formatDiscoveryTitleCase(value) {
  return discoveryCardString(value)
    .split(/\s+/)
    .map((token) => {
      if (!token) return token;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

function formatDiscoveryCategoryLabel(value) {
  return discoveryCardString(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeDiscoveryReviewSummary(value) {
  const source = value && typeof value === 'object' ? value : {};
  const scale = Number(source.scale || source.rating_scale || 5) || 5;
  const rawRating =
    Number(source.rating || source.average_rating || source.avg_rating || source.value || 0) || 0;
  const normalizedRating =
    rawRating > 0 ? Math.min(5, scale === 5 ? rawRating : (rawRating / scale) * 5) : null;
  const reviewCount =
    Number(source.review_count || source.reviewCount || source.count || source.total_reviews || 0) || 0;
  if (!normalizedRating && !reviewCount) return null;
  return {
    rating: normalizedRating,
    review_count: reviewCount,
  };
}

function buildDiscoveryReviewBadge(reviewSummary) {
  return buildDisplayableProofBadge(
    {
      review_summary: normalizeDiscoveryReviewSummary(reviewSummary),
    },
    { formatCompactCount: formatDiscoveryCompactCount },
  );
}

function normalizeDiscoveryBadgeLabel(value) {
  return discoveryCardString(value)
    .split(/\s+/)
    .map((token) => {
      if (!token) return token;
      if (/^[A-Z0-9]+$/.test(token)) return token;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

function normalizeDiscoveryMarketSignalBadges(value) {
  const seen = new Set();
  const out = [];
  for (const item of normalizeMarketSignalBadges(discoveryCardArray(value))) {
    const row = item && typeof item === 'object' ? item : null;
    const label = firstDiscoveryCardString(row?.badge_label, row?.label);
    if (!label) continue;
    const badge = {
      badge_type: discoveryCardString(row?.badge_type || row?.type),
      badge_label: label,
    };
    const key = `${badge.badge_type}::${badge.badge_label}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(badge);
  }
  return out;
}

function getProductIntelKbStore() {
  if (productIntelKbStore !== null) return productIntelKbStore;
  try {
    // Lazy-load so tests can stub the store without depending on discoveryFeed module init order.
    // eslint-disable-next-line global-require
    productIntelKbStore = require('../auroraBff/productIntelKbStore');
  } catch {
    productIntelKbStore = {};
  }
  return productIntelKbStore;
}

function extractDiscoveryProductIntelBundle(entry) {
  const analysis = asPlainObject(entry?.analysis);
  if (!analysis) return null;
  return (
    asPlainObject(analysis.product_intel_v1) ||
    asPlainObject(analysis.product_intel) ||
    asPlainObject(analysis.bundle) ||
    null
  );
}

function applyDiscoveryProductIntelBundle(candidate, bundle) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const raw = asPlainObject(candidate.raw);
  if (!raw || !bundle || typeof bundle !== 'object') return candidate;

  const shoppingCard = asPlainObject(bundle.shopping_card);
  const searchCard = asPlainObject(bundle.search_card);
  const marketSignalBadges = Array.isArray(bundle.market_signal_badges)
    ? bundle.market_signal_badges
    : undefined;
  const reviewSummary =
    bundle.review_summary && typeof bundle.review_summary === 'object' ? bundle.review_summary : undefined;
  const communitySignals =
    bundle.community_signals && typeof bundle.community_signals === 'object'
      ? bundle.community_signals
      : undefined;

  return {
    ...candidate,
    raw: {
      ...raw,
      product_intel: bundle,
      ...(shoppingCard ? { shopping_card: shoppingCard } : {}),
      ...(searchCard ? { search_card: searchCard } : {}),
      ...(marketSignalBadges ? { market_signal_badges: marketSignalBadges } : {}),
      ...(reviewSummary ? { review_summary: reviewSummary } : {}),
      ...(communitySignals ? { community_signals: communitySignals } : {}),
      ...(discoveryCardString(bundle.evidence_profile)
        ? { evidence_profile: discoveryCardString(bundle.evidence_profile) }
        : {}),
      ...(discoveryCardString(shoppingCard?.title) ? { card_title: discoveryCardString(shoppingCard.title) } : {}),
      ...(discoveryCardString(shoppingCard?.subtitle)
        ? { card_subtitle: discoveryCardString(shoppingCard.subtitle) }
        : {}),
      ...(discoveryCardString(shoppingCard?.proof_badge)
        ? { card_badge: discoveryCardString(shoppingCard.proof_badge) }
        : {}),
      ...(discoveryCardString(shoppingCard?.highlight)
        ? { card_highlight: discoveryCardString(shoppingCard.highlight) }
        : {}),
      ...(discoveryCardString(shoppingCard?.intro) ? { card_intro: discoveryCardString(shoppingCard.intro) } : {}),
    },
  };
}

async function hydrateDiscoveryCandidateProductIntel(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const raw = asPlainObject(candidate.raw);
  if (!raw) return candidate;

  const productId = String(raw.product_id || candidate.productId || '').trim();
  if (!productId) return candidate;

  const { getProductIntelKbEntry } = getProductIntelKbStore();
  if (typeof getProductIntelKbEntry !== 'function') return candidate;

  let kbEntry = null;
  try {
    kbEntry = await getProductIntelKbEntry(`product:${productId}`);
  } catch {
    return candidate;
  }

  const bundle = extractDiscoveryProductIntelBundle(kbEntry);
  if (!bundle) return candidate;
  return applyDiscoveryProductIntelBundle(candidate, bundle);
}

function buildDiscoveryProductIntelKbKey(candidate) {
  const raw = asPlainObject(candidate?.raw);
  const productId = String(raw?.product_id || candidate?.productId || '').trim();
  return productId ? `product:${productId}` : '';
}

async function hydrateDiscoveryCandidatesProductIntel(candidates, request) {
  if (!Array.isArray(candidates) || !candidates.length) return candidates;
  const responseDetail = String(request?.response_detail || '').trim().toLowerCase();
  if (responseDetail && responseDetail !== 'card' && responseDetail !== 'full') return candidates;
  const { getProductIntelKbEntries } = getProductIntelKbStore();
  if (typeof getProductIntelKbEntries === 'function') {
    let kbEntriesByKey = null;
    try {
      kbEntriesByKey = await getProductIntelKbEntries(
        candidates.map((candidate) => buildDiscoveryProductIntelKbKey(candidate)).filter(Boolean),
      );
    } catch {
      kbEntriesByKey = null;
    }
    if (kbEntriesByKey && typeof kbEntriesByKey.get === 'function') {
      return candidates.map((candidate) => {
        const kbKey = buildDiscoveryProductIntelKbKey(candidate);
        const kbEntry = kbKey ? kbEntriesByKey.get(kbKey) : null;
        const bundle = extractDiscoveryProductIntelBundle(kbEntry);
        return bundle ? applyDiscoveryProductIntelBundle(candidate, bundle) : candidate;
      });
    }
  }
  return Promise.all(candidates.map((candidate) => hydrateDiscoveryCandidateProductIntel(candidate)));
}

function readDiscoveryConfiguredBadge(raw) {
  const attributes = raw?.attributes && typeof raw.attributes === 'object' ? raw.attributes : null;
  const merchandising =
    raw?.raw_detail?.merchandising && typeof raw.raw_detail.merchandising === 'object'
      ? raw.raw_detail.merchandising
      : null;
  const label = firstDiscoveryCardString(
    raw?.card_badge,
    raw?.badge,
    raw?.editorial_badge,
    attributes?.card_badge,
    attributes?.card_label,
    attributes?.badge,
    attributes?.editorial_badge,
    merchandising?.card_badge,
    merchandising?.card_label,
    merchandising?.badge,
    merchandising?.editorial_badge,
  );
  if (!label) return null;
  return {
    badge_type: 'configured_badge',
    badge_label: label,
  };
}

function readDiscoveryBadgeFromTags(tags) {
  for (const rawTag of discoveryCardArray(tags)) {
    const tag = discoveryCardString(rawTag);
    if (!tag) continue;
    const match = tag.match(/^(editorial|media|award|creator)\s*:\s*(.+)$/i);
    if (!match) continue;
    const type = `${String(match[1]).toLowerCase()}_signal`;
    const label = normalizeDiscoveryBadgeLabel(match[2] || '');
    if (!label) continue;
    return {
      badge_type: type,
      badge_label: label,
    };
  }
  return null;
}

function buildDiscoveryMarketSignalBadges(raw, candidate) {
  const reviewSummary = normalizeEvidenceReviewSummary(raw?.review_summary || candidate?.raw?.review_summary);
  const communitySignals =
    raw?.community_signals ||
    raw?.communitySignals ||
    raw?.shopping_card?.community_signals ||
    raw?.shoppingCard?.community_signals ||
    candidate?.raw?.community_signals;
  const explicit = normalizeDiscoveryMarketSignalBadges(
    filterDisplayableMarketSignalBadges(
      raw?.market_signal_badges ||
        raw?.marketSignalBadges ||
        raw?.shopping_card?.market_signal_badges ||
        raw?.shoppingCard?.marketSignalBadges,
      {
        review_summary: reviewSummary,
        community_signals: communitySignals,
      },
    ),
  );
  if (explicit.length) return explicit;

  const synthetic = [];
  const reviewBadge = buildDiscoveryReviewBadge(reviewSummary);
  if (reviewBadge) synthetic.push(reviewBadge);
  return normalizeDiscoveryMarketSignalBadges(synthetic);
}

function buildDiscoveryCardSubtitle(raw, candidate) {
  const explicit = firstDiscoveryCardString(
    raw?.card_subtitle,
    raw?.search_card?.compact_candidate,
    raw?.searchCard?.compact_candidate,
    raw?.search_card_compact_candidate,
    raw?.shopping_card?.subtitle,
    raw?.shoppingCard?.subtitle,
  );
  if (explicit) return explicit;

  const category = firstDiscoveryCardString(
    raw?.product_type,
    raw?.productType,
    raw?.category,
    raw?.department,
    candidate?.category,
    candidate?.parentCategory,
  );
  if (!category) return '';
  const formatted = formatDiscoveryCategoryLabel(category);
  if (!formatted || /^(General|External)$/i.test(formatted)) return '';
  return formatted.slice(0, 48);
}

function buildDiscoveryCardHighlight(raw) {
  const bundle = raw?.product_intel || raw?.productIntel || null;
  const title = firstDiscoveryCardString(
    raw?.card_title,
    raw?.search_card?.title_candidate,
    raw?.searchCard?.title_candidate,
    raw?.shopping_card?.title,
    raw?.shoppingCard?.title,
    raw?.title,
    raw?.name,
  );
  const subtitle = firstDiscoveryCardString(
    raw?.card_subtitle,
    raw?.search_card?.compact_candidate,
    raw?.searchCard?.compact_candidate,
    raw?.shopping_card?.subtitle,
    raw?.shoppingCard?.subtitle,
  );
  const explicit = normalizeSurfaceText(
    firstDiscoveryCardString(
      raw?.card_highlight,
      raw?.search_card?.highlight_candidate,
      raw?.searchCard?.highlight_candidate,
      raw?.search_card_highlight_candidate,
      raw?.shopping_card?.highlight,
      raw?.shoppingCard?.highlight,
    ),
  );
  const resolvedExplicit = resolveDisplayableCompactHighlight(explicit, {
    bundle,
    title,
    subtitle,
  });
  if (resolvedExplicit) return resolvedExplicit;

  const signal = pickSurfaceableExternalHighlightSignal(
    bundle?.external_highlight_signals ||
      raw?.shopping_card?.external_highlight_signals ||
      raw?.shoppingCard?.external_highlight_signals,
    {
      surfaceTarget: 'shopping_card_highlight',
    },
  );

  return resolveDisplayableCompactHighlight(
    normalizeSurfaceText(signal?.surface_text) || normalizeSurfaceText(signal?.claim_text),
    {
      bundle,
      title,
      subtitle,
    },
  );
}

function buildDiscoveryCardPayload(raw, candidate) {
  const marketSignalBadges = buildDiscoveryMarketSignalBadges(raw, candidate);
  const title = firstDiscoveryCardString(
    raw?.card_title,
    raw?.search_card?.title_candidate,
    raw?.searchCard?.title_candidate,
    raw?.search_card_title_candidate,
    raw?.shopping_card?.title,
    raw?.shoppingCard?.title,
    raw?.title,
    raw?.name,
    candidate?.productId,
  );
  const subtitle = buildDiscoveryCardSubtitle(raw, candidate);
  const highlight = buildDiscoveryCardHighlight(raw);
  const proofBadge = firstDiscoveryCardString(marketSignalBadges[0]?.badge_label);
  const intro = normalizeCardIntroCandidate(
    firstDiscoveryCardString(
      raw?.search_card?.intro_candidate,
      raw?.searchCard?.intro_candidate,
      raw?.search_card_intro_candidate,
      raw?.card_intro,
      raw?.shopping_card?.intro,
      raw?.shoppingCard?.intro,
    ),
    {
      fallback: firstDiscoveryCardString(
        raw?.product_intel?.product_intel_core?.what_it_is?.body,
        raw?.productIntel?.product_intel_core?.what_it_is?.body,
        raw?.description,
        raw?.summary,
      ),
    },
  );
  const evidenceProfile = firstDiscoveryCardString(
    raw?.evidence_profile,
    raw?.product_intel?.evidence_profile,
    raw?.productIntel?.evidence_profile,
  );

  return {
    contract_version: SHOPPING_CARD_CONTRACT_VERSION,
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(highlight ? { highlight } : {}),
    ...(proofBadge ? { proof_badge: proofBadge } : {}),
    ...(intro ? { intro } : {}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
    ...(evidenceProfile ? { evidence_profile: evidenceProfile } : {}),
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
    const shoppingCard = buildDiscoveryCardPayload(raw, candidate);
    const marketSignalBadges = normalizeDiscoveryMarketSignalBadges(shoppingCard.market_signal_badges);
    const searchCard = {
      title_candidate: shoppingCard.title,
      ...(shoppingCard.subtitle ? { compact_candidate: shoppingCard.subtitle } : {}),
      ...(shoppingCard.highlight ? { highlight_candidate: shoppingCard.highlight } : {}),
      ...(shoppingCard.proof_badge ? { proof_badge_candidate: shoppingCard.proof_badge } : {}),
      ...(shoppingCard.intro ? { intro_candidate: shoppingCard.intro } : {}),
    };

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
      ...(raw.sellable_item_group_id ? { sellable_item_group_id: raw.sellable_item_group_id } : {}),
      ...(raw.product_line_id ? { product_line_id: raw.product_line_id } : {}),
      ...(raw.review_family_id ? { review_family_id: raw.review_family_id } : {}),
      ...(raw.identity_confidence != null ? { identity_confidence: raw.identity_confidence } : {}),
      ...(Array.isArray(raw.match_basis) ? { match_basis: raw.match_basis } : {}),
      ...(raw.canonical_scope ? { canonical_scope: raw.canonical_scope } : {}),
      ...(raw.identity_graph && typeof raw.identity_graph === 'object'
        ? { identity_graph: raw.identity_graph }
        : {}),
      ...(Array.isArray(raw.group_members) ? { group_members: raw.group_members } : {}),
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
      card_title: shoppingCard.title,
      ...(shoppingCard.subtitle ? { card_subtitle: shoppingCard.subtitle } : {}),
      ...(shoppingCard.highlight ? { card_highlight: shoppingCard.highlight } : {}),
      ...(shoppingCard.proof_badge ? { card_badge: shoppingCard.proof_badge } : {}),
      ...(shoppingCard.intro ? { card_intro: shoppingCard.intro } : {}),
      search_card: searchCard,
      shopping_card: shoppingCard,
      ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
    };
  }

  const shoppingCard = buildDiscoveryCardPayload(raw, candidate);
  const marketSignalBadges = normalizeDiscoveryMarketSignalBadges(shoppingCard.market_signal_badges);
  const searchCard = {
    title_candidate: shoppingCard.title,
    ...(shoppingCard.subtitle ? { compact_candidate: shoppingCard.subtitle } : {}),
    ...(shoppingCard.highlight ? { highlight_candidate: shoppingCard.highlight } : {}),
    ...(shoppingCard.proof_badge ? { proof_badge_candidate: shoppingCard.proof_badge } : {}),
    ...(shoppingCard.intro ? { intro_candidate: shoppingCard.intro } : {}),
  };
  const hasNormalizedCardFields =
    Boolean(shoppingCard.title) ||
    Boolean(shoppingCard.subtitle) ||
    Boolean(shoppingCard.highlight) ||
    Boolean(shoppingCard.proof_badge) ||
    Boolean(shoppingCard.intro);

  return {
    ...raw,
    id: raw.id || candidate.productId,
    product_id: raw.product_id || candidate.productId,
    merchant_id: raw.merchant_id || candidate.merchantId,
    ...(raw.brand ? {} : candidate.brand ? { brand: candidate.brand } : {}),
    ...(raw.category ? {} : candidate.category ? { category: candidate.category } : {}),
    ...(raw.product_type || !candidate.category ? {} : { product_type: candidate.category }),
    ...(hasNormalizedCardFields ? { card_title: shoppingCard.title } : {}),
    ...(shoppingCard.subtitle ? { card_subtitle: shoppingCard.subtitle } : {}),
    ...(shoppingCard.proof_badge ? { card_badge: shoppingCard.proof_badge } : {}),
    ...(shoppingCard.highlight ? { card_highlight: shoppingCard.highlight } : {}),
    ...(shoppingCard.intro ? { card_intro: shoppingCard.intro } : {}),
    ...(hasNormalizedCardFields ? { search_card: searchCard } : {}),
    ...(hasNormalizedCardFields ? { shopping_card: shoppingCard } : {}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
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

function buildCandidateSourceListingRef(candidate) {
  return buildSourceListingRef({
    merchantId: candidate?.raw?.merchant_id || candidate?.merchantId,
    productId: candidate?.raw?.product_id || candidate?.productId,
  });
}

function normalizeIdentityGraphRowForDiscovery(row) {
  if (!row || typeof row !== 'object') return null;
  const sourceListingRef = String(row.source_listing_ref || '').trim();
  const sellableItemGroupId = String(row.sellable_item_group_id || '').trim();
  if (!sourceListingRef || !sellableItemGroupId) return null;
  return {
    ...row,
    source_listing_ref: sourceListingRef,
    sellable_item_group_id: sellableItemGroupId,
    product_line_id: String(row.product_line_id || '').trim() || null,
    review_family_id: String(row.review_family_id || '').trim() || null,
    merchant_id: String(row.merchant_id || '').trim(),
    product_id: String(row.product_id || '').trim(),
    source_kind: String(row.source_kind || '').trim(),
    source_tier: String(row.source_tier || '').trim(),
    identity_confidence: Number(row.identity_confidence || 0) || 0,
    match_basis: Array.isArray(row.match_basis) ? row.match_basis : [],
  };
}

function scoreIdentityDiscoveryCanonicalCandidate(candidate, row, { requestedSourceRef = '', index = 0 } = {}) {
  let score = 0;
  if (row?.source_tier === 'brand') score += 100;
  if (row?.source_kind === 'external_seed') score += 25;
  if (row?.source_listing_ref && requestedSourceRef && row.source_listing_ref === requestedSourceRef) score += 5;
  if (candidate?.raw?.external_redirect_url || candidate?.raw?.canonical_url || candidate?.raw?.destination_url) {
    score += 4;
  }
  if (candidate?.raw?.image_url || candidate?.raw?.imageUrl) score += 2;
  if (Number.isFinite(Number(candidate?.priceAmount)) && Number(candidate.priceAmount) > 0) score += 1;
  score += Math.min(10, Number(row?.identity_confidence || 0) * 10);
  score -= index / 1000;
  return score;
}

function annotateIdentityDiscoveryCandidate(candidate, row, groupMembers) {
  if (!candidate || !row) return candidate;
  const safeGroupMembers = Array.isArray(groupMembers) ? groupMembers : [];
  return {
    ...candidate,
    raw: {
      ...(candidate.raw || {}),
      sellable_item_group_id: row.sellable_item_group_id,
      product_line_id: row.product_line_id,
      review_family_id: row.review_family_id,
      identity_confidence: row.identity_confidence,
      match_basis: row.match_basis,
      canonical_scope: 'synthetic',
      identity_graph: {
        source_listing_ref: row.source_listing_ref,
        sellable_item_group_id: row.sellable_item_group_id,
        product_line_id: row.product_line_id,
        review_family_id: row.review_family_id,
        grouped_candidate_count: safeGroupMembers.length,
      },
      group_members: safeGroupMembers,
    },
  };
}

async function applyIdentityGraphDiscoveryDedupe(candidates, {
  request = null,
  identityGraphRowsResolverFn = listLivePdpIdentityRowsForRefs,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length < 1 || typeof identityGraphRowsResolverFn !== 'function') {
    return {
      candidates,
      stats: {
        applied: false,
        matched_candidates: 0,
        groups_collapsed: 0,
        duplicate_candidates_dropped: 0,
      },
    };
  }

  const sourceRefs = candidates.map((candidate) => buildCandidateSourceListingRef(candidate)).filter(Boolean);
  const uniqueSourceRefs = uniqStrings(sourceRefs, 500);
  if (!uniqueSourceRefs.length) {
    return {
      candidates,
      stats: {
        applied: false,
        matched_candidates: 0,
        groups_collapsed: 0,
        duplicate_candidates_dropped: 0,
      },
    };
  }

  let rows = [];
  try {
    rows = await identityGraphRowsResolverFn({ sourceListingRefs: uniqueSourceRefs });
  } catch (err) {
    logger.warn(
      {
        err: err?.message || String(err),
        refs_count: uniqueSourceRefs.length,
      },
      'PDP identity graph discovery dedupe skipped after resolver failure',
    );
    return {
      candidates,
      stats: {
        applied: false,
        matched_candidates: 0,
        groups_collapsed: 0,
        duplicate_candidates_dropped: 0,
        error: err?.code || err?.name || 'IDENTITY_GRAPH_DISCOVERY_RESOLVER_FAILED',
      },
    };
  }

  const rowsByRef = new Map();
  for (const rawRow of rows || []) {
    const row = normalizeIdentityGraphRowForDiscovery(rawRow);
    if (!row) continue;
    rowsByRef.set(row.source_listing_ref, row);
  }
  if (!rowsByRef.size) {
    return {
      candidates,
      stats: {
        applied: false,
        matched_candidates: 0,
        groups_collapsed: 0,
        duplicate_candidates_dropped: 0,
      },
    };
  }

  const requestedSourceRef = buildSourceListingRef({
    merchantId: request?.source_product_ref?.merchant_id,
    productId: request?.source_product_ref?.product_id,
  });
  const buckets = [];
  const groupedBuckets = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const sourceRef = buildCandidateSourceListingRef(candidate);
    const row = rowsByRef.get(sourceRef) || null;
    if (!row?.sellable_item_group_id) {
      buckets.push({ key: `candidate:${index}`, entries: [{ candidate, row: null, index }] });
      continue;
    }
    const key = `sellable:${row.sellable_item_group_id}`;
    let bucket = groupedBuckets.get(key);
    if (!bucket) {
      bucket = { key, entries: [] };
      groupedBuckets.set(key, bucket);
      buckets.push(bucket);
    }
    bucket.entries.push({ candidate, row, index });
  }

  let matchedCandidates = 0;
  let groupsCollapsed = 0;
  let duplicateCandidatesDropped = 0;
  const deduped = [];
  for (const bucket of buckets) {
    const entries = Array.isArray(bucket.entries) ? bucket.entries : [];
    const identityEntries = entries.filter((entry) => entry.row?.sellable_item_group_id);
    matchedCandidates += identityEntries.length;
    if (!identityEntries.length) {
      deduped.push(entries[0]?.candidate);
      continue;
    }

    const groupMembers = identityEntries.map(({ row }) => ({
      merchant_id: row.merchant_id,
      product_id: row.product_id,
      source_kind: row.source_kind,
      source_tier: row.source_tier,
      source_listing_ref: row.source_listing_ref,
    }));
    let best = identityEntries[0];
    let bestScore = scoreIdentityDiscoveryCanonicalCandidate(best.candidate, best.row, {
      requestedSourceRef,
      index: best.index,
    });
    for (const entry of identityEntries.slice(1)) {
      const score = scoreIdentityDiscoveryCanonicalCandidate(entry.candidate, entry.row, {
        requestedSourceRef,
        index: entry.index,
      });
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }

    if (identityEntries.length > 1) {
      groupsCollapsed += 1;
      duplicateCandidatesDropped += identityEntries.length - 1;
    }
    deduped.push(annotateIdentityDiscoveryCandidate(best.candidate, best.row, groupMembers));
  }

  return {
    candidates: deduped.filter(Boolean),
    stats: {
      applied: true,
      matched_candidates: matchedCandidates,
      groups_collapsed: groupsCollapsed,
      duplicate_candidates_dropped: duplicateCandidatesDropped,
    },
  };
}

function buildCandidateCounts({
  raw,
  normalized,
  scored,
  eligiblePool,
  returned,
  sameDomain,
  semanticDeduped,
  identityGraphDeduped,
} = {}) {
  return {
    raw: Number(raw || 0),
    normalized: Number(normalized || 0),
    scored: Number(scored || 0),
    eligible_pool: Number(eligiblePool || 0),
    returned: Number(returned || 0),
    ...(sameDomain != null ? { same_domain: Number(sameDomain || 0) } : {}),
    ...(semanticDeduped != null ? { semantic_deduped: Number(semanticDeduped || 0) } : {}),
    ...(identityGraphDeduped != null ? { identity_graph_deduped: Number(identityGraphDeduped || 0) } : {}),
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
      ...(step?.failure_reason ? { failure_reason: String(step.failure_reason) } : {}),
      ...(step?.config_source ? { config_source: String(step.config_source) } : {}),
      ...(step?.legacy_config_fallback ? { legacy_config_fallback: true } : {}),
      ...(step?.market ? { market: String(step.market) } : {}),
      ...(step?.market_source ? { market_source: String(step.market_source) } : {}),
      ...(Array.isArray(step?.warning_codes) && step.warning_codes.length > 0
        ? { warning_codes: uniqStrings(step.warning_codes, 12) }
        : {}),
      ...(step?.compound_intent ? { compound_intent: String(step.compound_intent) } : {}),
      ...(Array.isArray(step?.external_seed_stage_counts) && step.external_seed_stage_counts.length > 0
        ? { external_seed_stage_counts: step.external_seed_stage_counts }
        : {}),
      ...(step?.external_seed_raw_count != null
        ? { external_seed_raw_count: Number(step.external_seed_raw_count || 0) }
        : {}),
      ...(step?.external_seed_qualified_count != null
        ? { external_seed_qualified_count: Number(step.external_seed_qualified_count || 0) }
        : {}),
      ...(step?.external_seed_filtered_compound_count != null
        ? { external_seed_filtered_compound_count: Number(step.external_seed_filtered_compound_count || 0) }
        : {}),
      ...(step?.external_seed_filtered_query_text_count != null
        ? { external_seed_filtered_query_text_count: Number(step.external_seed_filtered_query_text_count || 0) }
        : {}),
      ...(step?.error ? { error: String(step.error) } : {}),
    })),
    provider_breakdown: Array.isArray(providerBreakdown) ? providerBreakdown : [],
    filter_counts: filterCounts && typeof filterCounts === 'object' ? filterCounts : {},
  };
}

function summarizeExternalSeedRecallTelemetry(recallSummary = []) {
  const summary = {
    compound_intent: null,
    external_seed_stage_counts: [],
    external_seed_raw_count: 0,
    external_seed_qualified_count: 0,
    external_seed_filtered_compound_count: 0,
    external_seed_filtered_query_text_count: 0,
  };
  for (const step of Array.isArray(recallSummary) ? recallSummary : []) {
    if (!step || typeof step !== 'object') continue;
    if (!summary.compound_intent && step.compound_intent) {
      summary.compound_intent = String(step.compound_intent);
    }
    if (Array.isArray(step.external_seed_stage_counts)) {
      summary.external_seed_stage_counts.push(...step.external_seed_stage_counts);
    }
    summary.external_seed_raw_count += Math.max(0, Number(step.external_seed_raw_count || 0) || 0);
    summary.external_seed_qualified_count += Math.max(0, Number(step.external_seed_qualified_count || 0) || 0);
    summary.external_seed_filtered_compound_count += Math.max(
      0,
      Number(step.external_seed_filtered_compound_count || 0) || 0,
    );
    summary.external_seed_filtered_query_text_count += Math.max(
      0,
      Number(step.external_seed_filtered_query_text_count || 0) || 0,
    );
  }
  return summary;
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
    const useStableBrowseCatalogCount = shouldUseStableBrowseCatalogTotal(request);
    const stableBrowseCatalogCountPromise =
      useStableBrowseCatalogCount
        ? countStableBrowseCatalogTotal(request)
        : Promise.resolve(null);
    const shouldUseBrandDirectPrimary =
      !Array.isArray(options.candidateProducts) &&
      brandScopeAliases.length > 0 &&
      shouldUseBrandDirectPoolAsPrimary(request);
    const brandDirectLimit = resolveBrandDirectCandidateLimit(request, candidateLimit);
    const scheduledBrandDirectLoad =
      !Array.isArray(options.candidateProducts) &&
      brandScopeAliases.length > 0 &&
      shouldUseBrandDirectPrimary
        ? scheduleBrandScopedDirectCandidatesLoad({
            request,
            brandAliases: brandScopeAliases,
            limit: brandDirectLimit,
            fetchExternalCandidatesFn: options.brandFallbackFetchExternalCandidatesFn,
            fetchInternalCandidatesFn: options.brandFallbackFetchInternalCandidatesFn,
          })
        : null;
    let prefetchedBrandDirectLoadResult = null;
    if (shouldUseBrandDirectPrimary) {
      prefetchedBrandDirectLoadResult = scheduledBrandDirectLoad
        ? await scheduledBrandDirectLoad.startNow()
        : await loadBrandScopedDirectCandidates({
            request,
            brandAliases: brandScopeAliases,
            limit: brandDirectLimit,
            fetchExternalCandidatesFn: options.brandFallbackFetchExternalCandidatesFn,
            fetchInternalCandidatesFn: options.brandFallbackFetchInternalCandidatesFn,
          });
    }
    const brandDirectAppliedPrimary =
      shouldUseBrandDirectPrimary &&
      Array.isArray(prefetchedBrandDirectLoadResult?.products) &&
      prefetchedBrandDirectLoadResult.products.length > 0;

    const candidateLoadResult = Array.isArray(options.candidateProducts)
      ? {
          products: options.candidateProducts,
          recallSummary: [],
          catalogUnavailableError: null,
        }
      : brandDirectAppliedPrimary
        ? buildBrandDirectPrimaryCandidateResult({
            request,
            profile,
            limit: candidateLimit,
            directLoadResult: prefetchedBrandDirectLoadResult,
          })
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
    if (typeof candidateLoadResult?.candidateSource === 'string' && candidateLoadResult.candidateSource.trim()) {
      effectiveCandidateSource = candidateLoadResult.candidateSource.trim();
    }
    const primaryPathUsed =
      typeof candidateLoadResult?.primaryPathUsed === 'string' && candidateLoadResult.primaryPathUsed.trim()
        ? candidateLoadResult.primaryPathUsed.trim()
        : 'multi_provider';
    const fallbackTriggered = candidateLoadResult?.fallbackTriggered === true;
    const fallbackReason =
      typeof candidateLoadResult?.fallbackReason === 'string' && candidateLoadResult.fallbackReason.trim()
        ? candidateLoadResult.fallbackReason.trim()
        : null;
    const catalogUnavailableError =
      candidateLoadResult?.catalogUnavailableError instanceof DiscoveryCatalogUnavailableError
        ? candidateLoadResult.catalogUnavailableError
        : null;
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
    let identityGraphDedupeStats = {
      applied: false,
      matched_candidates: 0,
      groups_collapsed: 0,
      duplicate_candidates_dropped: 0,
    };
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

    if (brandScopeAliases.length > 0 && !skipBrandDirectPool && !brandDirectAppliedPrimary) {
      const directBrandLoadResult =
        prefetchedBrandDirectLoadResult ||
        (scheduledBrandDirectLoad
          ? await scheduledBrandDirectLoad.startNow()
          : await loadBrandScopedDirectCandidates({
              request,
              brandAliases: brandScopeAliases,
              limit: brandDirectLimit,
              fetchExternalCandidatesFn: options.brandFallbackFetchExternalCandidatesFn,
              fetchInternalCandidatesFn: options.brandFallbackFetchInternalCandidatesFn,
            }));
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
    if (brandScopeAliases.length > 0 && scopedCandidates.length === 0 && catalogUnavailableError) {
      throw catalogUnavailableError;
    }
    const identityGraphDedupe = await applyIdentityGraphDiscoveryDedupe(scopedCandidates, {
      request,
      identityGraphRowsResolverFn: options.identityGraphRowsResolverFn,
    });
    scopedCandidates = identityGraphDedupe.candidates;
    identityGraphDedupeStats = identityGraphDedupe.stats;
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
    let corpusTotalCount = 0;
    let runtimeCorpusCount = 0;
    let countSource = null;
    let shadowServingSummary = null;
    let cursorInfo = buildDiscoveryCursorInfo({
      request,
      servingMode: 'exhaustive',
      nextOffset: 0,
      nextAbsoluteOffset: 0,
      hasNextPage: false,
    });
    let servingMode = 'exhaustive';
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
          explicitQueryScoped: isExplicitQueryScopedBrowseRequest(request),
          queryText: request.query.text,
          categories: request.scope.categories,
        },
      );
      const browseServingWindow = selectBrowseServingWindow(browseSelection, request, {
        profile,
        sort: request.sort,
        brandScoped: brandScopeAliases.length > 0,
        queryText: request.query.text,
        categories: request.scope.categories,
      });
      selectedEntries = browseServingWindow.selectedEntries;
      runtimeCorpusCount = browseServingWindow.runtimeCorpusCount;
      eligiblePoolCount = browseServingWindow.eligiblePoolCount;
      cursorInfo = browseServingWindow.cursorInfo;
      servingMode = browseServingWindow.servingMode;
      categoryFacets =
        brandScopeAliases.length > 0
          ? buildDiscoveryCategoryFacets(browseSelection.preCategoryPool)
          : [];
      ranked = browseSelection.ranked;
      orderedPool = browseSelection.orderedPool;
      decisions = browseSelection.decisions;
      filterCounts = buildFilterCounts(decisions);
      const stableBrowseCatalogCount = await stableBrowseCatalogCountPromise;
      total = stableBrowseCatalogCount?.total ?? runtimeCorpusCount;
      corpusTotalCount = total;
      countSource =
        stableBrowseCatalogCount?.source ||
        (!useStableBrowseCatalogCount && isExplicitQueryScopedBrowseRequest(request)
          ? 'runtime_corpus_query_scoped'
          : 'runtime_corpus_fallback');
      shadowServingSummary = await maybeReadCatalogServingShadow(request, selectedEntries);
    }

    candidateCounts = buildCandidateCounts({
      raw: effectiveRawCandidates.length,
      normalized: normalizedCandidates.length,
      scored: scoredCandidates.length,
      eligiblePool: eligiblePoolCount,
      returned: selectedEntries.length,
      sameDomain: countSameDomainCandidates(scopedCandidates, profile),
      semanticDeduped,
      identityGraphDeduped: identityGraphDedupeStats?.duplicate_candidates_dropped,
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

	    const selectionLatencyMs = Date.now() - startedAt;
	    const hasMore =
	      request.surface === 'browse_products'
	        ? cursorInfo.has_next_page
	        : eligiblePoolCount > request.page * request.limit;
	    const selectedSourceBreakdown = selectedEntries.reduce(
	      (acc, entry) => {
	        const provider = String(entry?.candidate?.provider || '').trim() || 'unknown';
	        acc[provider] = Number(acc[provider] || 0) + 1;
	        return acc;
	      },
	      {},
	    );
	    const externalSeedRecallTelemetry = summarizeExternalSeedRecallTelemetry(recallSummary);
	    const compoundIntent = isExplicitQueryScopedBrowseRequest(request)
	      ? resolveExplicitBeautyCompoundIntent(request?.query?.text)
	      : null;
	    const exactIntentUnderfilled =
	      Boolean(compoundIntent) &&
	      request.surface === 'browse_products' &&
	      selectedEntries.length > 0 &&
	      selectedEntries.length < request.limit;
	    const underfilledReason = exactIntentUnderfilled
	      ? 'public_search_underfilled_exact_intent'
	      : null;
	    const metadata = {
	      discovery_strategy: strategy,
      personalization_source: personalizationSource,
      history_items_used: profile.historyItemsUsed,
      query_items_used: Number(profile.queryItemsUsed || 0),
      anchor_count: profile.anchors.length,
      scoring_version: SCORING_VERSION,
      serving_contract_version: DISCOVERY_SERVING_CONTRACT_VERSION,
      serving_engine: isCatalogServingIndexEnabled()
        ? 'opensearch_compatible_shadow'
        : 'runtime_discovery',
      surface: request.surface,
      locale: request.context.locale,
      candidate_source: effectiveCandidateSource,
      primary_path_used: primaryPathUsed,
      fallback_triggered: fallbackTriggered,
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      provider_breakdown: providerBreakdown,
      candidate_counts: candidateCounts,
      eligible_pool_count: eligiblePoolCount,
      corpus_total_count: corpusTotalCount || total,
      ...(request.surface === 'browse_products' ? { runtime_corpus_count: runtimeCorpusCount } : {}),
      ...(countSource ? { count_source: countSource } : {}),
      ...(request.surface === 'browse_products'
        ? {
            serving_mode: servingMode,
            cursor_info: cursorInfo,
            ...(shadowServingSummary ? { shadow_serving_summary: shadowServingSummary } : {}),
          }
        : {}),
      selected_source_breakdown: selectedSourceBreakdown,
      sort_applied: request.sort,
      brand_scope_applied: request.scope.brand_names,
      category_scope_applied: request.scope.categories,
      query_text: request.query.text,
      has_more: hasMore,
      facets: {
        categories: categoryFacets,
      },
      filter_counts: filterCounts,
      ...(compoundIntent || externalSeedRecallTelemetry.compound_intent
        ? { compound_intent: compoundIntent || externalSeedRecallTelemetry.compound_intent }
        : {}),
      ...(externalSeedRecallTelemetry.external_seed_stage_counts.length > 0
        ? { external_seed_stage_counts: externalSeedRecallTelemetry.external_seed_stage_counts }
        : {}),
      ...(externalSeedRecallTelemetry.external_seed_raw_count > 0
        ? { external_seed_raw_count: externalSeedRecallTelemetry.external_seed_raw_count }
        : {}),
      ...(externalSeedRecallTelemetry.external_seed_qualified_count > 0
        ? { external_seed_qualified_count: externalSeedRecallTelemetry.external_seed_qualified_count }
        : {}),
      ...(externalSeedRecallTelemetry.external_seed_filtered_compound_count > 0
        ? {
            external_seed_filtered_compound_count:
              externalSeedRecallTelemetry.external_seed_filtered_compound_count,
          }
        : {}),
      ...(externalSeedRecallTelemetry.external_seed_filtered_query_text_count > 0
        ? {
            external_seed_filtered_query_text_count:
              externalSeedRecallTelemetry.external_seed_filtered_query_text_count,
          }
        : {}),
      ...(underfilledReason ? { underfilled_reason: underfilledReason } : {}),
      route_health: {
        primary_path_used: primaryPathUsed,
        fallback_triggered: fallbackTriggered,
        fallback_reason: fallbackReason,
        primary_quality_gate_passed:
          selectedEntries.length > 0 && !exactIntentUnderfilled,
        ...(compoundIntent ? { compound_intent: compoundIntent } : {}),
        ...(underfilledReason ? { underfilled_reason: underfilledReason } : {}),
      },
      search_decision: {
        primary_path_used: primaryPathUsed,
        fallback_triggered: fallbackTriggered,
        final_decision: selectedEntries.length > 0 ? 'products_returned' : 'empty',
      },
      selection_latency_ms: selectionLatencyMs,
      ...(profile.dominantDomain ? { dominant_domain: profile.dominantDomain } : {}),
      ...(identityGraphDedupeStats?.applied
        ? {
            identity_graph: identityGraphDedupeStats,
          }
        : {}),
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

    const hydrationStartedAt = Date.now();
    const hydratedSelectedCandidates = await hydrateDiscoveryCandidatesProductIntel(
      selectedEntries.map((entry) => entry.candidate),
      request,
    );
    const hydrateLatencyMs = Math.max(0, Date.now() - hydrationStartedAt);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    metadata.hydrate_latency_ms = hydrateLatencyMs;
    metadata.request_latency_ms = latencyMs;

    const response = {
      status: 'success',
      success: true,
      products: hydratedSelectedCandidates.map((candidate) => formatDiscoveryResponseProduct(candidate, request)),
      total,
      page: request.page,
      page_size: selectedEntries.length,
      metadata,
      ...(request.surface === 'browse_products' ? { cursor_info: cursorInfo } : {}),
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
      selection_latency_ms: selectionLatencyMs,
      hydrate_latency_ms: hydrateLatencyMs,
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
  getDiscoveryHealthSnapshot,
  getDiscoveryFeed,
  _internals: {
    buildBrandScopeAliases,
    buildBeautyPersonalizedQueries,
    computeDiscoveryStepTimeoutMs,
    fetchExternalSeedCandidates,
    fetchExternalSeedExactTitleCandidates,
    fetchBeautyInterestExternalSeedFastpathCandidates,
    buildDiscoveryExactTitleLookupVariants,
    buildDiscoveryContextCacheKey,
    buildDiscoveryDatabaseSearchTerms,
    buildBeautyInterestRecallTerms,
    buildCompoundBeautySeedStageDefinitions,
    shouldSkipBroadStructuredSeedStagesForExplicitQuery,
    resolveExplicitIndexedCategoryHeadTerms,
    buildDiscoveryInterestQuery,
    buildDiscoveryRecallPlan,
    buildDiscoveryProviderMergeKey,
    buildDiscoverySeededBrowseQuery,
    buildDiscoveryExpansionQuery,
    getDiscoveryHealthSnapshot,
    getDiscoveryProductsSearchApiKey,
    getDiscoveryProductsSearchBaseUrl,
    getDiscoveryPoolCacheTtlMs,
    probeDiscoveryDatabaseDependencies,
    resolveDiscoveryExternalSeedMarketConfig,
    resolveDiscoveryProductsSearchApiKeyConfig,
    resolveDiscoveryProductsSearchBaseUrlConfig,
    loadBrandScopedRecommendationFallback,
    loadCatalogCandidates,
    hydrateDiscoveryCandidateProductIntel,
    matchesQueryTextCandidate,
    matchesBeautyCompoundQueryIntent,
    resolveExplicitBeautyCompoundIntent,
    resolveExplicitBrowseStageQueryCap,
    resolveExplicitQueryExternalSeedMainlineAcceptThreshold,
    resolveExternalSeedProviderLimit,
    shouldFilterBrowseCandidateByQueryText,
    matchesBrandScopeCandidate,
    shouldUseDiscoveryExternalSeedExactTitleFastpath,
    normalizeDiscoveryRequest,
    normalizeDiscoveryCursor,
    normalizeCandidateProduct,
    applyIdentityGraphDiscoveryDedupe,
    resolveDiscoveryCandidateLimit,
    buildStableBrowseCatalogCountQuery,
    buildDiscoveryCursor,
    buildDiscoveryCursorContextSignature,
    countStableBrowseCatalogTotal,
    scoreCandidate,
    selectBrowseProducts,
    selectBrowseServingWindow,
    selectHomeProducts,
    buildProductKey,
    resetDiscoveryDependencyProbeCache: () => {
      discoveryDbDependencyProbeCache.value = null;
      discoveryDbDependencyProbeCache.expiresAt = 0;
      discoveryDbDependencyProbeCache.pending = null;
    },
    resetProductIntelKbStoreCache: () => {
      productIntelKbStore = null;
    },
    resetBrowsePoolCache: () => browsePoolCache.clear(),
    resetBrowseCatalogCountCache: () => browseCatalogCountCache.clear(),
  },
};
