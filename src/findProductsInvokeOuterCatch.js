function createFindProductsInvokeOuterCatchRuntime(deps = {}) {
  const {
    buildInvokeOuterCacheGuardResponse,
    buildInvokeOuterStrictEmptyResponse,
    extractUpstreamErrorCode,
  } = deps;

  function maybeBuildInvokeOuterSearchFailureResponse({
    operation = '',
    shoppingFreshMainlineSearch = false,
    crossMerchantCacheProtectedResponse = null,
    queryParams = null,
    metadata = null,
    effectivePayload = null,
    err = null,
    invokeStartedAtMs = 0,
    traceAmbiguityScorePre = null,
    gatewayRequestId = null,
    rawUserQuery = '',
    findProductsExpansionMeta = null,
    traceQueryClass = null,
    traceRewriteGate = null,
    traceAssociationPlan = null,
    traceFlagsSnapshot = null,
    effectiveIntent = null,
    crossMerchantCacheRouteDebug = null,
    FIND_PRODUCTS_MULTI_EXPANSION_MODE = '',
    logger = null,
  } = {}) {
    if (!(operation === 'find_products' || operation === 'find_products_multi')) {
      return null;
    }
    if (
      operation === 'find_products_multi' &&
      !shoppingFreshMainlineSearch &&
      crossMerchantCacheProtectedResponse &&
      Array.isArray(crossMerchantCacheProtectedResponse.products) &&
      crossMerchantCacheProtectedResponse.products.length > 0
    ) {
      return buildInvokeOuterCacheGuardResponse({
        crossMerchantCacheProtectedResponse,
        queryParams,
        metadata,
        effectivePayload,
        err,
        invokeStartedAtMs,
        traceAmbiguityScorePre,
        gatewayRequestId,
        rawUserQuery,
        findProductsExpansionMeta,
        traceQueryClass,
        traceRewriteGate,
        traceAssociationPlan,
        traceFlagsSnapshot,
        effectiveIntent,
        crossMerchantCacheRouteDebug,
        FIND_PRODUCTS_MULTI_EXPANSION_MODE,
      });
    }
    const { code, message } = extractUpstreamErrorCode(err);
    const upstreamStatus =
      err?.response?.status || err?.status || (err?.code === 'ECONNABORTED' ? 504 : 502);
    logger?.warn(
      {
        gateway_request_id: gatewayRequestId,
        operation,
        upstream_status: upstreamStatus,
        upstream_code: code || err?.code || null,
        upstream_message: message || err?.message || null,
      },
      'search operation failed in invoke outer catch; returning soft fallback',
    );
    const reason = err?.code === 'ECONNABORTED' ? 'invoke_outer_timeout' : 'invoke_outer_exception';
    return buildInvokeOuterStrictEmptyResponse({
      queryParams,
      err,
      upstreamStatus,
      upstreamCode: code || err?.code || null,
      upstreamMessage: message || err?.message || null,
      reason,
      invokeStartedAtMs,
      traceAmbiguityScorePre,
      gatewayRequestId,
      rawUserQuery,
      findProductsExpansionMeta,
      traceQueryClass,
      traceRewriteGate,
      traceAssociationPlan,
      traceFlagsSnapshot,
      effectiveIntent,
      crossMerchantCacheRouteDebug,
      FIND_PRODUCTS_MULTI_EXPANSION_MODE,
    });
  }

  return {
    maybeBuildInvokeOuterSearchFailureResponse,
  };
}

module.exports = {
  createFindProductsInvokeOuterCatchRuntime,
};
