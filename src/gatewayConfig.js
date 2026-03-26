const http = require('http');
const https = require('https');

const {
  normalizeExternalSeedStrategy,
} = require('./commerce/catalog/searchGuards');

const DEFAULT_MERCHANT_ID = 'merch_208139f7600dbf42';
const SLOW_UPSTREAM_OPS = new Set([
  'preview_quote',
  'create_order',
  'confirm_payment',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
]);

function parseTimeoutMs(envValue, fallbackMs) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

function parsePositiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parsePdpCorePrewarmTargets(raw, defaultMerchantId) {
  const source = String(raw || '').trim();
  if (!source) return [];

  const fallbackMerchantId = String(defaultMerchantId || '').trim();
  const seen = new Set();
  const out = [];

  for (const tokenRaw of source.split(/[,\n]/g)) {
    const token = String(tokenRaw || '').trim();
    if (!token) continue;

    let merchantId = fallbackMerchantId;
    let productId = token;
    const sepIdx = token.indexOf(':');
    if (sepIdx > 0) {
      merchantId = String(token.slice(0, sepIdx)).trim() || fallbackMerchantId;
      productId = String(token.slice(sepIdx + 1)).trim();
    }
    if (!merchantId || !productId) continue;

    const dedupeKey = `${merchantId}:${productId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ merchant_id: merchantId, product_id: productId });
  }

  return out;
}

function configureAxiosKeepAliveDefaults({ env, axiosClient, logger }) {
  const raw = String(env.AGENT_AXIOS_KEEPALIVE_ENABLED || '').trim().toLowerCase();
  const enabled = !raw || ['1', 'true', 'yes', 'y', 'on'].includes(raw);
  if (!enabled || !axiosClient || !axiosClient.defaults) return;

  const keepAliveMsecs = parsePositiveInt(
    env.AGENT_AXIOS_KEEPALIVE_MSECS,
    60_000,
    { min: 1_000, max: 300_000 },
  );
  const maxSockets = parsePositiveInt(
    env.AGENT_AXIOS_KEEPALIVE_MAX_SOCKETS,
    128,
    { min: 8, max: 1024 },
  );
  const maxFreeSockets = parsePositiveInt(
    env.AGENT_AXIOS_KEEPALIVE_MAX_FREE_SOCKETS,
    32,
    { min: 4, max: 256 },
  );
  const scheduling = String(env.AGENT_AXIOS_KEEPALIVE_SCHEDULING || 'lifo')
    .trim()
    .toLowerCase() === 'fifo'
    ? 'fifo'
    : 'lifo';

  axiosClient.defaults.httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs,
    maxSockets,
    maxFreeSockets,
    scheduling,
  });
  axiosClient.defaults.httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs,
    maxSockets,
    maxFreeSockets,
    scheduling,
  });

  if (logger && typeof logger.info === 'function') {
    logger.info(
      {
        event: 'agent_axios_keepalive_enabled',
        keep_alive_msecs: keepAliveMsecs,
        max_sockets: maxSockets,
        max_free_sockets: maxFreeSockets,
        scheduling,
      },
      'enabled axios keep-alive agents',
    );
  }
}

function createGatewayConfig({
  env = process.env,
  logger,
  axiosClient,
  now = () => new Date(),
  defaultMerchantId = DEFAULT_MERCHANT_ID,
} = {}) {
  const PORT = env.PORT || 3000;
  const SERVICE_STARTED_AT = now().toISOString();
  const SERVICE_DEPLOYMENT_ID = String(
    env.RAILWAY_DEPLOYMENT_ID ||
    env.DEPLOYMENT_ID ||
    ''
  ).trim();
  const SERVICE_GIT_SHA = String(
    env.RAILWAY_GIT_COMMIT_SHA ||
    env.AURORA_GIT_SHA ||
    env.GIT_COMMIT_SHA ||
    env.SOURCE_VERSION ||
    ''
  ).trim();
  const SERVICE_GIT_SHA_SHORT = SERVICE_GIT_SHA ? SERVICE_GIT_SHA.slice(0, 12) : null;
  const SERVICE_GIT_BRANCH = String(env.RAILWAY_GIT_BRANCH || env.GIT_BRANCH || '').trim();
  const SERVICE_NAME = String(env.RAILWAY_SERVICE_NAME || env.SERVICE_NAME || 'pivota-agent-gateway').trim();
  const SERVICE_BUILD_ID = SERVICE_GIT_SHA_SHORT || `started-${SERVICE_STARTED_AT}`;
  const PIVOTA_API_BASE = (env.PIVOTA_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
  const PROXY_SEARCH_AURORA_API_BASE = String(
    env.PROXY_SEARCH_AURORA_API_BASE ||
      env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL ||
      '',
  )
    .trim()
    .replace(/\/+$/, '');
  const PIVOTA_API_KEY = env.PIVOTA_API_KEY || '';
  const REVIEWS_API_BASE = (
    env.REVIEWS_API_BASE ||
    env.REVIEWS_BACKEND_URL ||
    env.REVIEWS_BACKEND ||
    'https://web-production-fedb.up.railway.app'
  ).replace(/\/$/, '');
  const UI_GATEWAY_URL = (env.PIVOTA_GATEWAY_URL || 'http://localhost:3000/agent/shop/v1/invoke').replace(/\/$/, '');
  const ADMIN_API_KEY = env.ADMIN_API_KEY || '';
  const AGENT_AUTH_INTROSPECT_URL = String(
    env.AGENT_AUTH_INTROSPECT_URL ||
      `${PIVOTA_API_BASE}/agent/internal/auth/introspect`,
  ).trim();
  const AGENT_AUTH_INTROSPECT_INTERNAL_KEY = String(
    env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY || '',
  ).trim();
  const AGENT_AUTH_INTROSPECT_TIMEOUT_MS = parseTimeoutMs(
    env.AGENT_AUTH_INTROSPECT_TIMEOUT_MS,
    2_500,
  );
  const AGENT_AUTH_CACHE_POSITIVE_TTL_MS = parsePositiveInt(
    env.AGENT_AUTH_CACHE_POSITIVE_TTL_MS,
    60_000,
    { min: 1_000, max: 10 * 60_000 },
  );
  const AGENT_AUTH_CACHE_NEGATIVE_TTL_MS = parsePositiveInt(
    env.AGENT_AUTH_CACHE_NEGATIVE_TTL_MS,
    15_000,
    { min: 1_000, max: 5 * 60_000 },
  );
  const AGENT_AUTH_CACHE_MAX_ENTRIES = parsePositiveInt(
    env.AGENT_AUTH_CACHE_MAX_ENTRIES,
    20_000,
    { min: 100, max: 200_000 },
  );

  const MAX_AGENT_STEPS_PER_TURN = Number(env.AGENT_MAX_STEPS_PER_TURN || 8);
  const MAX_TOOL_CALLS_PER_TURN = Number(env.AGENT_MAX_TOOL_CALLS_PER_TURN || 8);
  const MAX_TOTAL_RUNTIME_MS = Number(env.AGENT_MAX_TOTAL_RUNTIME_MS || 20000);
  const MAX_TOOL_LOOP_DUPLICATES = Number(env.AGENT_MAX_TOOL_LOOP_DUPLICATES || 3);
  const MAX_CONTEXT_MESSAGES = Number(env.AGENT_MAX_CONTEXT_MESSAGES || 40);
  const MAX_TOOL_CONTENT_CHARS = Number(env.AGENT_MAX_TOOL_CONTENT_CHARS || 8000);
  const MAX_TASK_POLL_ATTEMPTS = Number(env.AGENT_MAX_TASK_POLL_ATTEMPTS || 10);
  const TASK_POLL_INTERVAL_MS = Number(env.AGENT_TASK_POLL_INTERVAL_MS || 500);
  const ROUTE_DEBUG_ENABLED =
    env.FIND_PRODUCTS_MULTI_DEBUG_STATS === '1' ||
    env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG === '1';
  const SEARCH_RELEVANCE_DEBUG_ENABLED =
    ROUTE_DEBUG_ENABLED ||
    String(env.SEARCH_RELEVANCE_DEBUG || '').trim().toLowerCase() === '1' ||
    String(env.SEARCH_RELEVANCE_DEBUG || '').trim().toLowerCase() === 'true';

  configureAxiosKeepAliveDefaults({ env, axiosClient, logger });

  const CREATOR_CATALOG_CACHE_TTL_SECONDS = parsePositiveInt(
    env.CREATOR_CATALOG_CACHE_TTL_SECONDS,
    7 * 24 * 60 * 60,
    { min: 300, max: 30 * 24 * 60 * 60 },
  );

  const UPSTREAM_TIMEOUT_SEARCH_MS = parseTimeoutMs(env.UPSTREAM_TIMEOUT_SEARCH_MS, 15000);
  const UPSTREAM_TIMEOUT_SLOW_MS = parseTimeoutMs(env.UPSTREAM_TIMEOUT_SLOW_MS, 60000);
  const UPSTREAM_TIMEOUT_ADMIN_MS = parseTimeoutMs(env.UPSTREAM_TIMEOUT_ADMIN_MS, 15000);
  const UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS = Math.max(
    1200,
    Math.min(
      parseTimeoutMs(
        env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS,
        Math.min(UPSTREAM_TIMEOUT_SEARCH_MS, 5000),
      ),
      6000,
    ),
  );
  const FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS = Math.max(
    1500,
    Math.min(
      parseTimeoutMs(env.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS, 6500),
      10000,
    ),
  );
  const FIND_PRODUCTS_MULTI_TIMEOUT_ALLOW_UNSAFE_LOWER =
    String(env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER || 'false')
      .toLowerCase() === 'true';
  const configuredFindProductsMultiTimeoutMs = parseTimeoutMs(
    env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
    Math.min(UPSTREAM_TIMEOUT_SEARCH_MS, FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS),
  );
  let UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = Math.max(
    1500,
    Math.min(configuredFindProductsMultiTimeoutMs, 10000),
  );
  if (
    !FIND_PRODUCTS_MULTI_TIMEOUT_ALLOW_UNSAFE_LOWER &&
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS < FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS
  ) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        {
          configured_timeout_ms: configuredFindProductsMultiTimeoutMs,
          enforced_timeout_ms: FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS,
          hint: 'Set UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER=true to bypass this floor.',
        },
        'UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS is below safe floor; clamping to reduce timeout-induced empty results',
      );
    }
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS;
  }
  const UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS = parseTimeoutMs(
    env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS,
    Math.min(
      UPSTREAM_TIMEOUT_SLOW_MS,
      Math.max(UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS * 2, 9000),
    ),
  );
  const UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS = parseTimeoutMs(
    env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS,
    Math.min(
      UPSTREAM_TIMEOUT_SLOW_MS,
      Math.max(
        UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS + 1800,
        FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS + 1000,
        8000,
      ),
    ),
  );
  const UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT =
    String(env.UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT || '').toLowerCase() === 'true';
  const CHECKOUT_RETRY_MAX_ATTEMPTS = parsePositiveInt(
    env.CHECKOUT_RETRY_MAX_ATTEMPTS,
    2,
    { min: 1, max: 5 },
  );
  const CHECKOUT_RETRY_BASE_MS = parsePositiveInt(
    env.CHECKOUT_RETRY_BASE_MS,
    140,
    { min: 50, max: 1000 },
  );
  const CHECKOUT_RETRY_MAX_MS = parsePositiveInt(
    env.CHECKOUT_RETRY_MAX_MS,
    500,
    { min: 100, max: 5000 },
  );
  const UPSTREAM_TIMEOUT_REVIEWS_MS = parseTimeoutMs(env.UPSTREAM_TIMEOUT_REVIEWS_MS, 4000);
  const UPSTREAM_TIMEOUT_SEARCH_RETRY_MS = parseTimeoutMs(
    env.UPSTREAM_TIMEOUT_SEARCH_RETRY_MS,
    Math.min(UPSTREAM_TIMEOUT_SLOW_MS, Math.max(UPSTREAM_TIMEOUT_SEARCH_MS * 3, 45_000)),
  );
  const PDP_CORE_PREWARM_ENABLED =
    String(env.PDP_CORE_PREWARM_ENABLED || 'false').toLowerCase() === 'true';
  const PDP_CORE_PREWARM_TIMEOUT_MS = Math.max(
    1000,
    parseTimeoutMs(env.PDP_CORE_PREWARM_TIMEOUT_MS, 6500),
  );
  const PDP_CORE_PREWARM_INTERVAL_MS = Math.max(
    30_000,
    parseTimeoutMs(env.PDP_CORE_PREWARM_INTERVAL_MS, 5 * 60 * 1000),
  );
  const PDP_CORE_PREWARM_INITIAL_DELAY_MS = Math.max(
    0,
    Number(env.PDP_CORE_PREWARM_INITIAL_DELAY_MS || 3000) || 3000,
  );
  const PDP_CORE_PREWARM_GATEWAY_URL = String(env.PDP_CORE_PREWARM_GATEWAY_URL || '').trim();
  const PDP_CORE_PREWARM_TARGETS = parsePdpCorePrewarmTargets(
    env.PDP_CORE_PREWARM_TARGETS || '',
    defaultMerchantId,
  );

  function getUpstreamTimeoutMs(operation) {
    if (operation === 'find_products') return UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS;
    if (operation === 'find_products_multi') return UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    return SLOW_UPSTREAM_OPS.has(operation) ? UPSTREAM_TIMEOUT_SLOW_MS : UPSTREAM_TIMEOUT_SEARCH_MS;
  }

  const PROXY_SEARCH_FALLBACK_TIMEOUT_MS = parseTimeoutMs(
    env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
    Math.max(6500, Math.min(UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS, 10000)),
  );
  const PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS = Math.max(
    450,
    Math.min(
      parseTimeoutMs(
        env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
        Math.min(1600, UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS),
      ),
      Math.max(450, UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS),
    ),
  );
  const PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS = Math.max(
    250,
    Math.min(
      parseTimeoutMs(
        env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
        Math.min(1200, PROXY_SEARCH_FALLBACK_TIMEOUT_MS),
      ),
      Math.max(250, PROXY_SEARCH_FALLBACK_TIMEOUT_MS),
    ),
  );
  const PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS = Math.max(
    200,
    Math.min(
      parseTimeoutMs(env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS, 450),
      3000,
    ),
  );
  const PROXY_SEARCH_RESOLVER_TIMEOUT_MS = parseTimeoutMs(
    env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
    1600,
  );
  const PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS = parseTimeoutMs(
    env.PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS,
    1200,
  );
  const resolverDefaultValue = env.NODE_ENV === 'test' ? 'false' : 'true';
  const PROXY_SEARCH_RESOLVER_DETAIL_ENABLED =
    String(env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED || resolverDefaultValue).toLowerCase() === 'true';
  const PROXY_SEARCH_RESOLVER_FIRST_ENABLED =
    String(env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED || resolverDefaultValue).toLowerCase() === 'true';
  const PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY =
    String(env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY || resolverDefaultValue).toLowerCase() === 'true';
  const PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED =
    String(env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED || resolverDefaultValue)
      .toLowerCase() === 'true';
  const PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA =
    String(env.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA || resolverDefaultValue).toLowerCase() === 'true';
  const PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED =
    String(env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_INVOKE_FALLBACK_ENABLED =
    String(env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
    String(env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS =
    String(env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS || 'true').toLowerCase() ===
    'true';
  const PROXY_SEARCH_AURORA_FORCE_FAST_MODE =
    String(env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK =
    String(env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK =
    String(env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS =
    String(env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS || 'true').toLowerCase() !==
    'false';
  const PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED =
    String(env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED || 'true').toLowerCase() === 'true';
  const PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY = normalizeExternalSeedStrategy(
    env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY || 'supplement_internal_first',
    'supplement_internal_first',
  );
  const PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_ENABLED =
    String(env.PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_ENABLED || 'true')
      .trim()
      .toLowerCase() === 'true';
  const PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_STRATEGY = normalizeExternalSeedStrategy(
    env.PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_STRATEGY || 'supplement_internal_first',
    'supplement_internal_first',
  );
  const CREATOR_CACHE_SHORT_CIRCUIT_ENABLED =
    String(env.CREATOR_CACHE_SHORT_CIRCUIT_ENABLED || 'false').toLowerCase() === 'true';
  const PROXY_SEARCH_CREATOR_SCOPE_TO_CONFIG =
    String(env.PROXY_SEARCH_CREATOR_SCOPE_TO_CONFIG || 'false').toLowerCase() === 'true';
  const PROXY_SEARCH_AURORA_VIEW_DETAILS_MIN_TIMEOUT_MS = Math.max(
    600,
    Math.min(
      parseTimeoutMs(env.PROXY_SEARCH_AURORA_VIEW_DETAILS_MIN_TIMEOUT_MS, 1800),
      5000,
    ),
  );
  const PROXY_SEARCH_AURORA_FORCE_TWO_PASS =
    String(env.PROXY_SEARCH_AURORA_FORCE_TWO_PASS || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS = Math.max(
    250,
    parseTimeoutMs(env.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS, 900),
  );
  const PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS = Math.max(
    200,
    parseTimeoutMs(env.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS, 400),
  );
  const PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS = Math.max(
    800,
    Math.min(parseTimeoutMs(env.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS, 1500), 10000),
  );
  const PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE = Math.max(
    1,
    Math.min(20, Number(env.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE || 3) || 3),
  );
  const PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE =
    String(env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE || 'true').toLowerCase() !==
    'false';
  const PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY =
    String(env.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY || 'true').toLowerCase() !== 'false';
  const PROXY_SEARCH_AURORA_RELAX_PRIMARY_IRRELEVANT_ADOPT =
    String(env.PROXY_SEARCH_AURORA_RELAX_PRIMARY_IRRELEVANT_ADOPT || 'true').toLowerCase() !==
    'false';
  const PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED =
    String(env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED || 'true').toLowerCase() !==
    'false';
  const PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES = Math.max(
    0,
    Math.min(
      3,
      Number(env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES || 1) || 1,
    ),
  );
  const PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS = Math.max(
    1200,
    Math.min(
      parseTimeoutMs(
        env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
        Math.min(
          UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
          Math.max(5000, FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS - 500),
        ),
      ),
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
    ),
  );
  const PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS = Math.max(
    1200,
    Math.min(
      parseTimeoutMs(env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS, UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS),
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
    ),
  );
  const FIND_PRODUCTS_MULTI_EXPANSION_MODE = (() => {
    const raw = String(env.FIND_PRODUCTS_MULTI_EXPANSION_MODE || 'conservative')
      .trim()
      .toLowerCase();
    if (raw === 'off' || raw === 'none' || raw === 'disabled') return 'off';
    if (raw === 'aggressive') return 'aggressive';
    return 'conservative';
  })();
  const FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = (() => {
    const raw = String(env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE || 'aggressive')
      .trim()
      .toLowerCase();
    if (raw === 'off' || raw === 'none' || raw === 'disabled') return 'off';
    if (raw === 'conservative') return 'conservative';
    return 'aggressive';
  })();
  const SEARCH_STRICT_EMPTY_ENABLED =
    String(env.SEARCH_STRICT_EMPTY_ENABLED || 'true').toLowerCase() !== 'false';
  const SEARCH_EXTERNAL_FILL_GATED =
    String(env.SEARCH_EXTERNAL_FILL_GATED || 'true').toLowerCase() !== 'false';
  const SEARCH_LIMIT_MAX = parsePositiveInt(env.SEARCH_LIMIT_MAX, 200, {
    min: 1,
    max: 200,
  });
  const SEARCH_EXTERNAL_HARD_RULE_PRUNE =
    String(env.SEARCH_EXTERNAL_HARD_RULE_PRUNE || 'true').toLowerCase() !== 'false';
  const SEARCH_FRAGRANCE_SEMANTIC_RETRY =
    String(env.SEARCH_FRAGRANCE_SEMANTIC_RETRY || 'true').toLowerCase() !== 'false';
  const SEARCH_CACHE_VALIDATE =
    String(env.SEARCH_CACHE_VALIDATE || 'false').toLowerCase() === 'true';
  const SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO =
    String(env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO || 'false').toLowerCase() ===
    'true';
  const SEARCH_CACHE_MIN_ANCHOR = Math.max(
    0,
    Math.min(1, Number(env.SEARCH_CACHE_MIN_ANCHOR || 0.15)),
  );
  const SEARCH_CACHE_MAX_DOMAIN_ENTROPY = Math.max(
    0,
    Math.min(1, Number(env.SEARCH_CACHE_MAX_DOMAIN_ENTROPY || 0.55)),
  );
  const SEARCH_CACHE_MIN_COUNT = Math.max(
    1,
    Number(env.SEARCH_CACHE_MIN_COUNT || 6) || 6,
  );
  const SEARCH_CACHE_MAX_CROSS_DOMAIN_RATIO = Math.max(
    0,
    Math.min(1, Number(env.SEARCH_CACHE_MAX_CROSS_DOMAIN_RATIO || 0.08)),
  );
  const SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED =
    String(env.SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED || 'true').toLowerCase() !== 'false';
  const SEARCH_UPSTREAM_QUOTA_CLARIFY_QUERY_CLASSES = new Set(
    String(
      env.SEARCH_UPSTREAM_QUOTA_CLARIFY_QUERY_CLASSES ||
        'scenario,mission,gift,exploratory,category,non_shopping',
    )
      .split(',')
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED =
    String(env.PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED || 'false').toLowerCase() ===
    'true';
  const FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS = Math.max(
    100,
    parseTimeoutMs(env.FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS, 2200),
  );
  const FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS = Math.max(
    300,
    parseTimeoutMs(env.FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS, 1200),
  );
  const FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS = Math.max(
    1500,
    parseTimeoutMs(env.FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS, 3500),
  );
  const FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS = Math.max(
    1800,
    parseTimeoutMs(env.FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS, 4500),
  );
  const FPM_GATE_SIMPLIFY_V1 =
    String(env.FPM_GATE_SIMPLIFY_V1 || 'true').toLowerCase() !== 'false';
  const FPM_LOOKUP_ONLY_RESOLVER =
    String(env.FPM_LOOKUP_ONLY_RESOLVER || 'true').toLowerCase() !== 'false';
  const FPM_CLARIFY_NEVER_EMPTY =
    String(env.FPM_CLARIFY_NEVER_EMPTY || 'true').toLowerCase() !== 'false';
  const FPM_GATEWAY_TOTAL_BUDGET_MS = Math.max(
    1200,
    parseTimeoutMs(env.FPM_GATEWAY_TOTAL_BUDGET_MS, 2500),
  );
  const FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS = Math.max(
    300,
    parseTimeoutMs(env.FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS, 550),
  );
  const FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS = Math.max(
    350,
    parseTimeoutMs(env.FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS, 700),
  );
  const OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS = parseTimeoutMs(
    env.OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS,
    1800,
  );
  const OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS = parseTimeoutMs(
    env.OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS,
    2600,
  );
  const OFFERS_RESOLVE_SUBJECT_RETRY_MAX = Math.max(
    0,
    Math.min(3, Number(env.OFFERS_RESOLVE_SUBJECT_RETRY_MAX || 0)),
  );
  const OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX = Math.max(
    0,
    Math.min(3, Number(env.OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX || 0)),
  );
  const OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS = Math.max(
    25,
    Number(env.OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS || 120) || 120,
  );
  const OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS = Math.max(
    25,
    Number(env.OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS || 120) || 120,
  );
  const OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD = Math.max(
    1,
    Math.min(10, Number(env.OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD || 1)),
  );
  const OFFERS_RESOLVE_CIRCUIT_OPEN_MS = Math.max(
    1000,
    Number(env.OFFERS_RESOLVE_CIRCUIT_OPEN_MS || 30000) || 30000,
  );
  const OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT =
    String(env.OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT || 'true').toLowerCase() ===
    'true';
  const OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES =
    String(env.OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES || 'true').toLowerCase() ===
    'true';

  const API_MODE = env.API_MODE || (PIVOTA_API_KEY ? 'REAL' : 'MOCK');
  const USE_MOCK = API_MODE === 'MOCK';
  const USE_HYBRID = API_MODE === 'HYBRID';
  const REAL_API_ENABLED = API_MODE === 'REAL' && Boolean(PIVOTA_API_KEY);
  const FIND_PRODUCTS_MULTI_VECTOR_ENABLED = env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === 'true';
  const HAS_DATABASE = Boolean(env.DATABASE_URL);
  const NODE_ENV = env.NODE_ENV;
  const CREATOR_CATALOG_AUTO_SYNC_INITIAL_DELAY_MS = Math.max(
    Number(env.CREATOR_CATALOG_AUTO_SYNC_INITIAL_DELAY_MS || 15000) || 15000,
    0,
  );

  return {
    parseTimeoutMs,
    parsePositiveInt,
    PORT,
    SERVICE_STARTED_AT,
    SERVICE_DEPLOYMENT_ID,
    SERVICE_GIT_SHA,
    SERVICE_GIT_SHA_SHORT,
    SERVICE_GIT_BRANCH,
    SERVICE_NAME,
    SERVICE_BUILD_ID,
    DEFAULT_MERCHANT_ID: defaultMerchantId,
    PIVOTA_API_BASE,
    PROXY_SEARCH_AURORA_API_BASE,
    PIVOTA_API_KEY,
    REVIEWS_API_BASE,
    UI_GATEWAY_URL,
    ADMIN_API_KEY,
    AGENT_AUTH_INTROSPECT_URL,
    AGENT_AUTH_INTROSPECT_INTERNAL_KEY,
    AGENT_AUTH_INTROSPECT_TIMEOUT_MS,
    AGENT_AUTH_CACHE_POSITIVE_TTL_MS,
    AGENT_AUTH_CACHE_NEGATIVE_TTL_MS,
    AGENT_AUTH_CACHE_MAX_ENTRIES,
    MAX_AGENT_STEPS_PER_TURN,
    MAX_TOOL_CALLS_PER_TURN,
    MAX_TOTAL_RUNTIME_MS,
    MAX_TOOL_LOOP_DUPLICATES,
    MAX_CONTEXT_MESSAGES,
    MAX_TOOL_CONTENT_CHARS,
    MAX_TASK_POLL_ATTEMPTS,
    TASK_POLL_INTERVAL_MS,
    ROUTE_DEBUG_ENABLED,
    SEARCH_RELEVANCE_DEBUG_ENABLED,
    CREATOR_CATALOG_CACHE_TTL_SECONDS,
    UPSTREAM_TIMEOUT_ADMIN_MS,
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS,
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS,
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS,
    UPSTREAM_TIMEOUT_REVIEWS_MS,
    UPSTREAM_TIMEOUT_SEARCH_RETRY_MS,
    UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT,
    CHECKOUT_RETRY_MAX_ATTEMPTS,
    CHECKOUT_RETRY_BASE_MS,
    CHECKOUT_RETRY_MAX_MS,
    PDP_CORE_PREWARM_ENABLED,
    PDP_CORE_PREWARM_TIMEOUT_MS,
    PDP_CORE_PREWARM_INTERVAL_MS,
    PDP_CORE_PREWARM_INITIAL_DELAY_MS,
    PDP_CORE_PREWARM_GATEWAY_URL,
    PDP_CORE_PREWARM_TARGETS,
    getUpstreamTimeoutMs,
    PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
    PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
    PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS,
    PROXY_SEARCH_RESOLVER_DETAIL_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
    PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
    PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
    PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
    PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
    PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS,
    PROXY_SEARCH_AURORA_FORCE_FAST_MODE,
    PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK,
    PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK,
    PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS,
    PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
    PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
    PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_ENABLED,
    PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_STRATEGY,
    CREATOR_CACHE_SHORT_CIRCUIT_ENABLED,
    PROXY_SEARCH_CREATOR_SCOPE_TO_CONFIG,
    PROXY_SEARCH_AURORA_VIEW_DETAILS_MIN_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_FORCE_TWO_PASS,
    PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS,
    PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
    PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE,
    PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY,
    PROXY_SEARCH_AURORA_RELAX_PRIMARY_IRRELEVANT_ADOPT,
    PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED,
    PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
    PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
    PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
    FIND_PRODUCTS_MULTI_EXPANSION_MODE,
    FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
    SEARCH_STRICT_EMPTY_ENABLED,
    SEARCH_EXTERNAL_FILL_GATED,
    SEARCH_LIMIT_MAX,
    SEARCH_EXTERNAL_HARD_RULE_PRUNE,
    SEARCH_FRAGRANCE_SEMANTIC_RETRY,
    SEARCH_CACHE_VALIDATE,
    SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO,
    SEARCH_CACHE_MIN_ANCHOR,
    SEARCH_CACHE_MAX_DOMAIN_ENTROPY,
    SEARCH_CACHE_MIN_COUNT,
    SEARCH_CACHE_MAX_CROSS_DOMAIN_RATIO,
    SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED,
    SEARCH_UPSTREAM_QUOTA_CLARIFY_QUERY_CLASSES,
    PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED,
    FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS,
    FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS,
    FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS,
    FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS,
    FPM_GATE_SIMPLIFY_V1,
    FPM_LOOKUP_ONLY_RESOLVER,
    FPM_CLARIFY_NEVER_EMPTY,
    FPM_GATEWAY_TOTAL_BUDGET_MS,
    FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS,
    FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS,
    OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS,
    OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS,
    OFFERS_RESOLVE_SUBJECT_RETRY_MAX,
    OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX,
    OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS,
    OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS,
    OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD,
    OFFERS_RESOLVE_CIRCUIT_OPEN_MS,
    OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT,
    OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES,
    API_MODE,
    USE_MOCK,
    USE_HYBRID,
    REAL_API_ENABLED,
    FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
    HAS_DATABASE,
    NODE_ENV,
    CREATOR_CATALOG_AUTO_SYNC_INITIAL_DELAY_MS,
  };
}

module.exports = {
  DEFAULT_MERCHANT_ID,
  parseTimeoutMs,
  parsePositiveInt,
  parsePdpCorePrewarmTargets,
  createGatewayConfig,
};
