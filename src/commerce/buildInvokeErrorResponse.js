const {
  buildInvokeSearchOuterCatchResponse: buildInvokeSearchOuterCatchResponseBase,
} = require('./catalog/searchResponseFinalizer');
const {
  buildSearchTrace: buildSearchTraceBase,
} = require('./catalog/searchTrace');

function buildInvokeErrorResponse({
  operation,
  err,
  crossMerchantCacheProtectedResponse,
  queryParams,
  rawUserQuery,
  effectiveIntent,
  traceQueryClass,
  traceRewriteGate,
  traceAssociationPlan,
  traceFlagsSnapshot,
  traceAmbiguityScorePre,
  gatewayRequestId,
  invokeStartedAtMs,
  findProductsExpansionMeta,
  defaultFindProductsMultiExpansionMode,
  normalizeAgentProductsListResponse,
  withProxySearchFallbackMetadata,
  withSearchDiagnostics,
  buildSearchRouteHealth,
  buildSearchTrace = buildSearchTraceBase,
  extractSearchQueryText,
  withStrictEmptyFallback,
  buildInvokeSearchOuterCatchResponse = buildInvokeSearchOuterCatchResponseBase,
  logger,
} = {}) {
  const searchOuterCatch = buildInvokeSearchOuterCatchResponse({
    operation,
    err,
    crossMerchantCacheProtectedResponse,
    queryParams,
    rawUserQuery,
    effectiveIntent,
    traceQueryClass,
    traceRewriteGate,
    traceAssociationPlan,
    traceFlagsSnapshot,
    traceAmbiguityScorePre,
    gatewayRequestId,
    invokeStartedAtMs,
    findProductsExpansionMeta,
    defaultFindProductsMultiExpansionMode,
    normalizeAgentProductsListResponse,
    withProxySearchFallbackMetadata,
    withSearchDiagnostics,
    buildSearchRouteHealth,
    buildSearchTrace,
    extractSearchQueryText,
    withStrictEmptyFallback,
    logger,
  });
  if (searchOuterCatch.handled) {
    return {
      handled: true,
      statusCode: searchOuterCatch.statusCode,
      body: searchOuterCatch.body,
      headers: null,
    };
  }

  if (err?.response) {
    const upstreamStatus = err.response.status || 502;
    const upstreamUrl = err.config?.url || null;
    const upstreamRequestId =
      err.response.headers?.['x-request-id'] ||
      err.response.headers?.['x-requestid'] ||
      err.response.headers?.['x-railway-request-id'] ||
      null;

    logger?.warn?.(
      {
        gateway_request_id: gatewayRequestId,
        operation,
        upstream_status: upstreamStatus,
        upstream_url: upstreamUrl,
        upstream_request_id: upstreamRequestId,
      },
      'Upstream error',
    );

    const data = err.response.data;
    if (typeof data === 'string') {
      return {
        handled: true,
        statusCode: upstreamStatus,
        headers: upstreamRequestId ? { 'X-Upstream-Request-Id': upstreamRequestId } : null,
        body: {
          error: 'UPSTREAM_ERROR',
          upstream_status: upstreamStatus,
          upstream_request_id: upstreamRequestId,
          detail: data,
        },
      };
    }

    return {
      handled: true,
      statusCode: upstreamStatus,
      headers: upstreamRequestId ? { 'X-Upstream-Request-Id': upstreamRequestId } : null,
      body: data || { error: 'UPSTREAM_ERROR' },
    };
  }

  if (err?.code === 'ECONNABORTED') {
    const upstreamUrl = err.config?.url || null;
    logger?.error?.(
      {
        operation,
        url: upstreamUrl,
        timeout_ms: err.config?.timeout,
      },
      'Upstream timeout',
    );
    return {
      handled: true,
      statusCode: 504,
      headers: null,
      body: {
        error: 'UPSTREAM_TIMEOUT',
        operation,
        upstream_url: upstreamUrl,
        timeout_ms: err.config?.timeout || null,
      },
    };
  }

  const transportCode = err?.code ? String(err.code) : null;
  const transportMessage = err?.message ? String(err.message) : null;
  const upstreamUrl = err?.config?.url || null;
  logger?.error?.(
    { err: transportMessage, code: transportCode, upstream_url: upstreamUrl },
    'Unexpected upstream error',
  );
  return {
    handled: true,
    statusCode: 502,
    headers: null,
    body: {
      error: 'UPSTREAM_UNAVAILABLE',
      upstream_url: upstreamUrl,
      transport_code: transportCode,
      transport_message: transportMessage,
    },
  };
}

module.exports = {
  buildInvokeErrorResponse,
};
