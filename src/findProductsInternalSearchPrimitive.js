const INTERNAL_PRODUCTS_SEARCH_PATH = '/agent/internal/products/search';

const INTERNAL_PRODUCTS_SEARCH_ALLOWED_FIELDS = [
  'query',
  'limit',
  'offset',
  'merchant_id',
  'merchant_ids',
  'search_all_merchants',
  'catalog_surface',
  'in_stock_only',
  'allow_external_seed',
  'external_seed_strategy',
  'fast_mode',
  'target_step_family',
  'semantic_family',
  'query_step_strength',
  'product_only',
  'trace_id',
];

const INTERNAL_PRODUCTS_SEARCH_FORBIDDEN_FIELDS = [
  'semantic_contract',
  'semanticContract',
  'search_request_contract',
  'searchRequestContract',
  'primary_lane',
  'primary_retrieval_contract',
  'primaryRetrievalContract',
  'supplement_lanes',
  'supplementLanes',
  'local_mainline_child',
  'localMainlineChild',
  'ui_surface',
  'uiSurface',
  'decision_mode',
  'decisionMode',
  'payload',
  'metadata',
  'search',
  'request_context',
  'requestContext',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function parseBooleanLike(value) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(Array.isArray(value) ? value[0] : value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function normalizeStringArray(value) {
  const list = Array.isArray(value)
    ? value
    : value == null
      ? []
      : [value];
  return Array.from(
    new Set(
      list
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizeNonNegativeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function pruneEmptyFields(value) {
  if (!isPlainObject(value)) return {};
  return Object.entries(value).reduce((out, [key, entry]) => {
    if (entry == null) return out;
    if (typeof entry === 'string' && !entry.trim()) return out;
    if (Array.isArray(entry) && entry.length <= 0) return out;
    out[key] = entry;
    return out;
  }, {});
}

function sanitizeInternalProductsSearchRequest(
  rawInput,
  {
    rejectUnknown = true,
    rejectForbidden = true,
    defaultSearchAllMerchants = true,
  } = {},
) {
  const input = isPlainObject(rawInput) ? rawInput : {};
  const allowed = new Set(INTERNAL_PRODUCTS_SEARCH_ALLOWED_FIELDS);
  const forbidden = new Set(INTERNAL_PRODUCTS_SEARCH_FORBIDDEN_FIELDS);
  const unknownFields = [];
  const forbiddenFields = [];

  for (const key of Object.keys(input)) {
    if (forbidden.has(key)) {
      forbiddenFields.push(key);
      continue;
    }
    if (!allowed.has(key)) unknownFields.push(key);
  }

  if ((rejectForbidden && forbiddenFields.length > 0) || (rejectUnknown && unknownFields.length > 0)) {
    return {
      ok: false,
      search: null,
      forbidden_fields: forbiddenFields,
      unknown_fields: unknownFields,
      invalid_fields: Array.from(new Set([...forbiddenFields, ...unknownFields])),
    };
  }

  const merchantId = firstNonEmptyString(input.merchant_id);
  const merchantIds = normalizeStringArray(input.merchant_ids).filter((value) => value !== merchantId);
  const explicitSearchAllMerchants = parseBooleanLike(input.search_all_merchants);
  const query = firstNonEmptyString(input.query);
  const limit = normalizeNonNegativeInteger(input.limit, { min: 1, max: 50 });
  const offset = normalizeNonNegativeInteger(input.offset, { min: 0 });
  const inStockOnly = parseBooleanLike(input.in_stock_only);
  const allowExternalSeed = parseBooleanLike(input.allow_external_seed);
  const fastMode = parseBooleanLike(input.fast_mode);
  const productOnly = parseBooleanLike(input.product_only);
  const normalized = pruneEmptyFields({
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(!merchantId && merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
    ...(
      explicitSearchAllMerchants !== undefined
        ? { search_all_merchants: explicitSearchAllMerchants }
        : !merchantId && merchantIds.length <= 0 && defaultSearchAllMerchants
          ? { search_all_merchants: true }
          : {}
    ),
    ...(firstNonEmptyString(input.catalog_surface)
      ? { catalog_surface: firstNonEmptyString(input.catalog_surface).toLowerCase() }
      : {}),
    ...(inStockOnly !== undefined ? { in_stock_only: inStockOnly } : {}),
    ...(allowExternalSeed !== undefined ? { allow_external_seed: allowExternalSeed } : {}),
    ...(firstNonEmptyString(input.external_seed_strategy)
      ? { external_seed_strategy: firstNonEmptyString(input.external_seed_strategy).toLowerCase() }
      : {}),
    ...(fastMode !== undefined ? { fast_mode: fastMode } : {}),
    ...(firstNonEmptyString(input.target_step_family)
      ? { target_step_family: firstNonEmptyString(input.target_step_family).toLowerCase() }
      : {}),
    ...(firstNonEmptyString(input.semantic_family)
      ? { semantic_family: firstNonEmptyString(input.semantic_family).toLowerCase() }
      : {}),
    ...(firstNonEmptyString(input.query_step_strength)
      ? { query_step_strength: firstNonEmptyString(input.query_step_strength).toLowerCase() }
      : {}),
    ...(productOnly !== undefined ? { product_only: productOnly } : {}),
    ...(firstNonEmptyString(input.trace_id) ? { trace_id: firstNonEmptyString(input.trace_id) } : {}),
  });

  return {
    ok: Boolean(normalized.query),
    search: normalized,
    forbidden_fields: [],
    unknown_fields: [],
    invalid_fields: normalized.query ? [] : ['query'],
  };
}

function buildInternalProductsSearchUpstreamBody({
  search = null,
  buildSearchProductsV2Body = null,
  traceId = null,
} = {}) {
  const normalizedSearch = isPlainObject(search) ? search : {};
  if (typeof buildSearchProductsV2Body === 'function') {
    return buildSearchProductsV2Body({
      payload: {
        search: normalizedSearch,
        metadata: {
          source: 'internal_products_search_primitive',
          ...(traceId ? { trace_id: traceId } : {}),
        },
      },
      search: normalizedSearch,
      metadata: {
        source: 'internal_products_search_primitive',
        ...(traceId ? { trace_id: traceId } : {}),
      },
      clientChannel: 'internal',
      gatewayRequestId: traceId || null,
      defaultSearchAllMerchants:
        !firstNonEmptyString(normalizedSearch.merchant_id) &&
        normalizeStringArray(normalizedSearch.merchant_ids).length <= 0,
    });
  }
  return normalizedSearch;
}

function resolveInternalSearchTimeoutMs(headerValue, fallbackTimeoutMs) {
  const requested = normalizeNonNegativeInteger(headerValue, { min: 200, max: 20000 });
  if (requested !== undefined) return requested;
  const fallback = normalizeNonNegativeInteger(fallbackTimeoutMs, { min: 200, max: 20000 });
  return fallback !== undefined ? fallback : 5000;
}

function createFindProductsInternalSearchPrimitiveRuntime(deps = {}) {
  const buildSearchProductsV2Body =
    typeof deps.buildSearchProductsV2Body === 'function' ? deps.buildSearchProductsV2Body : null;
  const normalizeAgentProductsListResponse =
    typeof deps.normalizeAgentProductsListResponse === 'function'
      ? deps.normalizeAgentProductsListResponse
      : (value) => value;
  const callUpstreamWithOptionalRetry =
    typeof deps.callUpstreamWithOptionalRetry === 'function'
      ? deps.callUpstreamWithOptionalRetry
      : null;
  const buildInvokeUpstreamAuthHeaders =
    typeof deps.buildInvokeUpstreamAuthHeaders === 'function'
      ? deps.buildInvokeUpstreamAuthHeaders
      : () => ({});
  const getUpstreamUrl =
    typeof deps.getUpstreamUrl === 'function'
      ? deps.getUpstreamUrl
      : () => String(deps.upstreamUrl || '').trim();
  const getDefaultTimeoutMs =
    typeof deps.getDefaultTimeoutMs === 'function'
      ? deps.getDefaultTimeoutMs
      : () => Number(deps.defaultTimeoutMs || 5000) || 5000;

  async function handleInternalProductsSearch(req, res) {
    if (!callUpstreamWithOptionalRetry) {
      return res.status(503).json({
        error: 'INTERNAL_PRODUCTS_SEARCH_UNAVAILABLE',
        message: 'internal products search primitive is not configured',
      });
    }

    const validation = sanitizeInternalProductsSearchRequest(req.body, {
      rejectUnknown: true,
      rejectForbidden: true,
      defaultSearchAllMerchants: true,
    });
    if (!validation.ok) {
      return res.status(400).json({
        error: 'INVALID_INTERNAL_PRODUCTS_SEARCH_REQUEST',
        message: 'request body must contain only thin search fields',
        invalid_fields: validation.invalid_fields,
        forbidden_fields: validation.forbidden_fields,
        unknown_fields: validation.unknown_fields,
      });
    }

    const checkoutToken = String(
      req.header('X-Checkout-Token') || req.header('x-checkout-token') || '',
    ).trim();
    const traceId = firstNonEmptyString(validation.search.trace_id, req.header('X-Trace-ID'));
    const upstreamUrl = firstNonEmptyString(getUpstreamUrl());
    if (!upstreamUrl) {
      return res.status(503).json({
        error: 'INTERNAL_PRODUCTS_SEARCH_UPSTREAM_MISSING',
        message: 'internal products search upstream is not configured',
      });
    }

    const timeoutMs = resolveInternalSearchTimeoutMs(
      req.header('X-Internal-Search-Timeout-Ms') || req.header('x-internal-search-timeout-ms'),
      getDefaultTimeoutMs(),
    );
    const upstreamBody = buildInternalProductsSearchUpstreamBody({
      search: validation.search,
      buildSearchProductsV2Body,
      traceId,
    });

    let response;
    try {
      response = await callUpstreamWithOptionalRetry(
        'find_products_multi',
        {
          method: 'POST',
          url: upstreamUrl,
          data: upstreamBody,
          timeout: timeoutMs,
          validateStatus: () => true,
          headers: {
            'Content-Type': 'application/json',
            ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
            ...(traceId ? { 'X-Trace-ID': traceId } : {}),
          },
        },
        {
          disableTimeoutRetry: true,
        },
      );
    } catch (err) {
      const statusCode = err?.code === 'ECONNABORTED' ? 504 : 502;
      return res.status(statusCode).json({
        error:
          err?.code === 'ECONNABORTED'
            ? 'INTERNAL_PRODUCTS_SEARCH_TIMEOUT'
            : 'INTERNAL_PRODUCTS_SEARCH_UPSTREAM_ERROR',
        message: err?.message || String(err),
      });
    }

    const limit = normalizeNonNegativeInteger(validation.search.limit, { min: 1, max: 50 }) || 20;
    const offset = normalizeNonNegativeInteger(validation.search.offset, { min: 0 }) || 0;
    const normalizedBody = normalizeAgentProductsListResponse(response?.data, { limit, offset });
    const responseBody = isPlainObject(normalizedBody)
      ? normalizedBody
      : {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          page: 1,
          page_size: 0,
          reply: null,
        };
    const metadata = pruneEmptyFields({
      ...(isPlainObject(responseBody.metadata) ? responseBody.metadata : {}),
      query_source: 'internal_products_search_primitive',
      transport_owner: 'internal_products_search_primitive',
      endpoint_kind: 'internal_primitive',
      thin_search_primitive: true,
    });
    return res.status(Number(response?.status || 200) || 200).json({
      ...responseBody,
      metadata,
    });
  }

  return {
    handleInternalProductsSearch,
  };
}

module.exports = {
  INTERNAL_PRODUCTS_SEARCH_PATH,
  INTERNAL_PRODUCTS_SEARCH_ALLOWED_FIELDS,
  INTERNAL_PRODUCTS_SEARCH_FORBIDDEN_FIELDS,
  sanitizeInternalProductsSearchRequest,
  buildInternalProductsSearchUpstreamBody,
  createFindProductsInternalSearchPrimitiveRuntime,
};
