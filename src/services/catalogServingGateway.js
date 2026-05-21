const {
  canUseLocalCatalogServingSearch,
  getCatalogServingIndexConfig,
  searchCatalogServingIndex,
} = require('./catalogServingIndex');

const CATALOG_SERVING_GATEWAY_CONTRACT_VERSION = 'pivota.catalog_serving.gateway.v1';
const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
// 'serving_eligible_only' is a stricter form of DB serving that pre-filters
// local DB results to products marked serving_eligible=TRUE in
// index_pipeline_state. Enable only after >=1000 products are eligible.
const VALID_SERVING_MODES = new Set(['auto', 'external_only', 'db_serving', 'serving_eligible_only']);

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

function resolveCatalogServingGatewayServingMode(rawValue, fallback = 'auto') {
  const normalized = asString(rawValue).toLowerCase();
  if (normalized === 'allow_local_shadow' || normalized === 'local_shadow') return 'db_serving';
  if (VALID_SERVING_MODES.has(normalized)) return normalized;
  return VALID_SERVING_MODES.has(fallback) ? fallback : 'auto';
}

function legacyShadowModeForServingMode(servingMode) {
  if (servingMode === 'db_serving') return 'allow_local_shadow';
  if (servingMode === 'serving_eligible_only') return 'serving_eligible_only';
  return 'external_only';
}

function resolveCatalogServingGatewayShadowMode(rawValue) {
  return legacyShadowModeForServingMode(resolveCatalogServingGatewayServingMode(rawValue, 'external_only'));
}

function resolveEffectiveCatalogServingGatewayServingMode(request, env = process.env) {
  const requested = resolveCatalogServingGatewayServingMode(request?.serving_mode, 'auto');
  if (requested !== 'auto') return requested;
  const indexConfig = getCatalogServingIndexConfig(env);
  if (indexConfig.enabled === true) return 'external_only';
  if (canUseLocalCatalogServingSearch(env)) return 'db_serving';
  return 'external_only';
}

function normalizeCatalogServingGatewaySource(rawSource) {
  const source = asString(rawSource) || 'disabled';
  return source === 'local_shadow' ? 'db_serving' : source;
}

function resolveCatalogServingGatewayMode(normalizedSource) {
  if (normalizedSource === 'db_serving') return 'db_serving';
  if (normalizedSource === 'opensearch_compatible') return 'external_index';
  return 'disabled';
}

function normalizeCatalogServingGatewayRequest(input = {}) {
  const requestedMode = resolveCatalogServingGatewayServingMode(
    input.serving_mode || input.servingMode || input.shadow_mode || input.shadowMode,
  );
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
    serving_mode: requestedMode,
    shadow_mode: legacyShadowModeForServingMode(requestedMode),
  };
}

async function searchCatalogServingGateway(input = {}, {
  env = process.env,
  searchCatalogServingIndexFn = searchCatalogServingIndex,
} = {}) {
  const request = normalizeCatalogServingGatewayRequest(input);
  const effectiveServingMode = resolveEffectiveCatalogServingGatewayServingMode(request, env);
  const servingEligibleOnly = effectiveServingMode === 'serving_eligible_only';
  const allowDbServing = servingEligibleOnly || effectiveServingMode === 'db_serving';
  const indexConfig = getCatalogServingIndexConfig(env);
  const dbServingAvailable = canUseLocalCatalogServingSearch(env);
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
      allowLocalShadow: allowDbServing,
      servingEligibleOnly,
    },
  );
  const internalSource = asString(result?.source) || 'disabled';
  const source = normalizeCatalogServingGatewaySource(internalSource);

  return {
    contract_version: CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
    gateway_mode: resolveCatalogServingGatewayMode(source),
    serving_mode: effectiveServingMode,
    requested_serving_mode: request.serving_mode,
    shadow_mode: legacyShadowModeForServingMode(effectiveServingMode),
    source,
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
      db_serving_requested: allowDbServing,
      db_serving_available: dbServingAvailable,
      db_serving_used: internalSource === 'local_shadow',
      local_shadow_requested: allowDbServing,
      local_shadow_available: dbServingAvailable,
      local_shadow_used: internalSource === 'local_shadow',
      serving_eligible_filter: servingEligibleOnly,
    },
  };
}

module.exports = {
  CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
  normalizeCatalogServingGatewayRequest,
  resolveCatalogServingGatewayServingMode,
  resolveCatalogServingGatewayShadowMode,
  searchCatalogServingGateway,
};
