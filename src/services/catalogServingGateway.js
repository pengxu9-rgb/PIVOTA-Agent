const {
  canUseLocalCatalogServingSearch,
  getCatalogServingIndexConfig,
  searchCatalogServingIndex,
} = require('./catalogServingIndex');

const CATALOG_SERVING_GATEWAY_CONTRACT_VERSION = 'pivota.catalog_serving.gateway.v1';
const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const VALID_SHADOW_MODES = new Set(['external_only', 'allow_local_shadow']);

function asString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.floor(numeric);
  return Math.max(min, Math.min(max, rounded));
}

function uniqStrings(values = [], limit = 24) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const normalized = asString(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function resolveCatalogServingGatewayShadowMode(rawValue) {
  const normalized = asString(rawValue).toLowerCase();
  if (VALID_SHADOW_MODES.has(normalized)) return normalized;
  return 'external_only';
}

function normalizeCatalogServingGatewayRequest(input = {}) {
  return {
    query_text: asString(input.query_text || input.queryText),
    brand_names: uniqStrings(input.brand_names || input.brandNames, 16),
    categories: uniqStrings(input.categories, 16),
    market: asString(input.market).toUpperCase() || DEFAULT_MARKET,
    limit: clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    cursor: asString(input.cursor) || null,
    sort: asString(input.sort) || 'popular',
    timeout_ms: clampInt(input.timeout_ms || input.timeoutMs, 800, 100, 5000),
    local_scan_limit: clampInt(input.local_scan_limit || input.localScanLimit, 1000, 50, 5000),
    shadow_mode: resolveCatalogServingGatewayShadowMode(
      input.shadow_mode || input.shadowMode,
    ),
  };
}

async function searchCatalogServingGateway(input = {}, {
  env = process.env,
  searchCatalogServingIndexFn = searchCatalogServingIndex,
} = {}) {
  const request = normalizeCatalogServingGatewayRequest(input);
  const allowLocalShadow = request.shadow_mode === 'allow_local_shadow';
  const indexConfig = getCatalogServingIndexConfig(env);
  const localShadowAvailable = canUseLocalCatalogServingSearch(env);
  const result = await searchCatalogServingIndexFn(
    {
      query_text: request.query_text,
      brand_names: request.brand_names,
      categories: request.categories,
      market: request.market,
      limit: request.limit,
      cursor: request.cursor,
      sort: request.sort,
      timeout_ms: request.timeout_ms,
      local_scan_limit: request.local_scan_limit,
    },
    {
      env,
      allowLocalShadow,
    },
  );

  return {
    contract_version: CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
    gateway_mode: 'shadow',
    shadow_mode: request.shadow_mode,
    source: asString(result?.source) || 'disabled',
    items: Array.isArray(result?.items) ? result.items : [],
    cursor_info:
      result?.cursor_info && typeof result.cursor_info === 'object'
        ? result.cursor_info
        : {
            next_cursor: null,
            has_next_page: false,
            serving_mode: 'exhaustive',
          },
    applied_filters: {
      query_text: request.query_text || null,
      brand_names: request.brand_names,
      categories: request.categories,
      market: request.market,
      sort: request.sort,
    },
    available_facets: [],
    debug_metadata: {
      external_index_enabled: indexConfig.enabled === true,
      local_shadow_requested: allowLocalShadow,
      local_shadow_available: localShadowAvailable,
      local_shadow_used: asString(result?.source) === 'local_shadow',
    },
  };
}

module.exports = {
  CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
  normalizeCatalogServingGatewayRequest,
  resolveCatalogServingGatewayShadowMode,
  searchCatalogServingGateway,
};
