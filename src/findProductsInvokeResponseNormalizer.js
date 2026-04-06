function createFindProductsInvokeResponseNormalizerRuntime(deps = {}) {
  const {
    normalizeInvokeSearchOperationResponseData,
    ROUTE_DEBUG_ENABLED,
    extractSearchQueryText,
    normalizeAgentProductsListResponse,
    normalizeShoppingFreshMainlineCacheResponse,
    recoverStrictMainPathResponseFromPrefetch,
    normalizeStrictCacheMainPathFallbackMetadata,
    normalizeShoppingStrictMainlineCacheResponse,
    normalizeStrictMainlineResponseMetadata,
  } = deps;

  function normalizeInvokeSearchResponse({
    responseBody,
    operation,
    queryParamsOverride,
    requestBodyOverride,
    includeRouteDebug = false,
    creatorCacheRouteDebug = null,
    creatorHumanApparelDirectRouteDebug = null,
    crossMerchantCacheRouteDebug = null,
    searchContractBridgeMeta = null,
    shoppingFreshMainlineSearch = false,
    metadata = null,
    effectiveIntent = null,
    traceQueryClass = null,
    rawUserQuery = '',
    strictCommerceFindProductsMulti = false,
    strictFindProductsMultiDecision = null,
  } = {}) {
    return normalizeInvokeSearchOperationResponseData({
      responseBody,
      operation,
      queryParamsOverride,
      requestBodyOverride,
      includeRouteDebug,
      routeDebugEnabled: ROUTE_DEBUG_ENABLED,
      creatorCacheRouteDebug,
      creatorHumanApparelDirectRouteDebug,
      crossMerchantCacheRouteDebug,
      searchContractBridgeMeta,
      shoppingFreshMainlineSearch,
      metadata,
      effectiveIntent,
      traceQueryClass,
      rawUserQuery,
      strictCommerceFindProductsMulti,
      strictFindProductsMultiDecision,
      extractSearchQueryText,
      normalizeAgentProductsListResponse,
      normalizeShoppingFreshMainlineCacheResponse,
      recoverStrictMainPathResponseFromPrefetch,
      normalizeStrictCacheMainPathFallbackMetadata,
      normalizeShoppingStrictMainlineCacheResponse,
      normalizeStrictMainlineResponseMetadata,
    });
  }

  return {
    normalizeInvokeSearchResponse,
  };
}

module.exports = {
  createFindProductsInvokeResponseNormalizerRuntime,
};
