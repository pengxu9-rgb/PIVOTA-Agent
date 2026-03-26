const {
  buildInvokeAxiosConfig: buildInvokeAxiosConfigBase,
  createTrackedUpstreamCaller: createTrackedUpstreamCallerBase,
} = require('./invokeTransport');
const {
  runInvokeSearchPrelude: runInvokeSearchPreludeBase,
} = require('./catalog/invokeSearchPrelude');
const {
  handleInvokeSearchExceptionFallback: handleInvokeSearchExceptionFallbackBase,
} = require('./catalog/invokeSearchExceptionFallback');
const {
  maybeLoadInvokeProductDetailResponse: maybeLoadInvokeProductDetailResponseBase,
} = require('./catalog/productDetailResponse');
const {
  recoverCheckoutUpstreamError: recoverCheckoutUpstreamErrorBase,
} = require('./checkout/recoverUpstreamError');

async function executeInvokeUpstreamFlow({
  operation,
  route,
  url,
  queryParams,
  requestBody,
  metadata,
  rawUserQuery,
  traceQueryClass,
  checkoutToken,
  effectiveIntent,
  isProxySearchRoute,
  auroraFallbackOverrides,
  crossMerchantCacheProtectedResponse,
  productDetailCacheKey,
  productDetailMerchantId,
  productDetailProductId,
  productDetailBypassCache,
  hasDatabase,
  fpmLatencyGuardApplied = false,
  fpmSkippedGatesDueToBudget = [],
  buildQueryString,
  buildInvokeUpstreamAuthHeaders,
  getUpstreamTimeoutMs,
  extractSearchQueryText,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  callUpstreamWithOptionalRetry,
  checkoutTimingOps,
  onGatewayRetry,
  onUpstreamElapsed,
  getFpmRemainingBudgetMs,
  addFpmGateTrace,
  queryResolveSearchFallback,
  shouldUseResolverFirstSearch,
  shouldReducePrimaryTimeoutAfterResolverMiss,
  detectBrandEntities,
  proxySearchAuroraResolverTimeoutMs,
  proxySearchResolverTimeoutMs,
  proxySearchResolverFirstOnSearchRouteEnabled,
  fpmGateSimplifyV1,
  fpmLatencyGuardResolverMinRemainingMs,
  proxySearchPrimaryTimeoutAfterResolverMissMs,
  pivotaApiBase,
  checkoutRetryBaseMs,
  extractUpstreamErrorCode,
  isRetryableQuoteError,
  isPydanticMissingBodyField,
  sleep,
  randomFn = Math.random,
  shouldSkipSecondaryFallbackAfterResolverMiss,
  shouldAllowResolverFallback,
  shouldAllowSecondaryFallback,
  shouldAllowInvokeFallback,
  shouldBypassSecondaryFallbackSkipOnPrimaryException,
  queryFindProductsMultiFallback,
  isProxySearchFallbackRelevant,
  normalizeAgentProductsListResponse,
  withProxySearchFallbackMetadata,
  buildProxySearchSoftFallbackResponse,
  findProductsMultiUpstreamLookupTimeoutMs,
  findProductsMultiUpstreamDefaultTimeoutMs,
  buildInvokeAxiosConfig = buildInvokeAxiosConfigBase,
  createTrackedUpstreamCaller = createTrackedUpstreamCallerBase,
  runInvokeSearchPrelude = runInvokeSearchPreludeBase,
  maybeLoadInvokeProductDetailResponse = maybeLoadInvokeProductDetailResponseBase,
  recoverCheckoutUpstreamError = recoverCheckoutUpstreamErrorBase,
  handleInvokeSearchExceptionFallback = handleInvokeSearchExceptionFallbackBase,
  logger,
} = {}) {
  const axiosConfig = buildInvokeAxiosConfig({
    operation,
    route,
    url,
    queryParams,
    requestBody,
    checkoutToken,
    buildQueryString,
    buildInvokeUpstreamAuthHeaders,
    getUpstreamTimeoutMs,
    rawUserQuery,
    traceQueryClass,
    extractSearchQueryText,
    extractSearchAnchorTokens,
    isLookupStyleSearchQuery,
    findProductsMultiUpstreamLookupTimeoutMs,
    findProductsMultiUpstreamDefaultTimeoutMs,
  });
  const callTrackedUpstream = createTrackedUpstreamCaller({
    callUpstreamWithOptionalRetry,
    checkoutTimingOps,
    onRetry: () => {
      if (typeof onGatewayRetry === 'function') onGatewayRetry();
    },
    onElapsed: (elapsedMs) => {
      if (typeof onUpstreamElapsed === 'function') onUpstreamElapsed(elapsedMs);
    },
  });

  let response;
  let productDetailCacheMeta = null;
  let searchQueryText = '';
  let resolverQueryText = '';
  let resolverQueryParams = queryParams;
  let resolverTimeoutMs = auroraFallbackOverrides?.active
    ? proxySearchAuroraResolverTimeoutMs
    : proxySearchResolverTimeoutMs;
  let resolverFirstResult = null;
  let shouldAttemptResolverFirst = false;

  const searchPrelude = await runInvokeSearchPrelude({
    operation,
    metadata,
    queryParams,
    rawUserQuery,
    checkoutToken,
    traceQueryClass,
    isProxySearchRoute,
    auroraFallbackOverrides,
    currentTimeoutMs: axiosConfig.timeout,
    fpmLatencyGuardApplied,
    fpmSkippedGatesDueToBudget,
    getFpmRemainingBudgetMs,
    addFpmGateTrace,
    queryResolveSearchFallback,
    shouldUseResolverFirstSearch,
    shouldReducePrimaryTimeoutAfterResolverMiss,
    detectBrandEntities,
    extractSearchQueryText,
    logger,
    proxySearchAuroraResolverTimeoutMs,
    proxySearchResolverTimeoutMs,
    proxySearchResolverFirstOnSearchRouteEnabled,
    fpmGateSimplifyV1,
    fpmLatencyGuardResolverMinRemainingMs,
    proxySearchPrimaryTimeoutAfterResolverMissMs,
  });
  searchQueryText = searchPrelude.searchQueryText;
  resolverQueryText = searchPrelude.resolverQueryText;
  resolverQueryParams = searchPrelude.resolverQueryParams;
  resolverTimeoutMs = searchPrelude.resolverTimeoutMs;
  resolverFirstResult = searchPrelude.resolverFirstResult;
  shouldAttemptResolverFirst = searchPrelude.shouldAttemptResolverFirst;
  response = searchPrelude.response || response;
  axiosConfig.timeout = searchPrelude.nextTimeoutMs;
  fpmLatencyGuardApplied = searchPrelude.fpmLatencyGuardApplied;
  fpmSkippedGatesDueToBudget = searchPrelude.fpmSkippedGatesDueToBudget;

  try {
    const productDetailPrelude = await maybeLoadInvokeProductDetailResponse({
      operation,
      productDetailCacheKey,
      productDetailMerchantId,
      productDetailProductId,
      productDetailBypassCache,
      hasDatabase,
    });
    if (productDetailPrelude.handled) {
      response = productDetailPrelude.response;
      productDetailCacheMeta = productDetailPrelude.productDetailCacheMeta;
    }

    if (!response) {
      response = await callTrackedUpstream(operation, axiosConfig);
      if (operation === 'get_product_detail') {
        productDetailCacheMeta = { hit: false, source: 'upstream' };
      }
    }
  } catch (err) {
    const checkoutRecovery = await recoverCheckoutUpstreamError({
      operation,
      err,
      response,
      requestBody,
      axiosConfig,
      checkoutToken,
      pivotaApiBase,
      checkoutRetryBaseMs,
      callTrackedUpstream,
      extractUpstreamErrorCode,
      isRetryableQuoteError,
      isPydanticMissingBodyField,
      buildInvokeUpstreamAuthHeaders,
      getUpstreamTimeoutMs,
      sleep,
      randomFn,
      onGatewayRetry,
      logger,
    });
    response = checkoutRecovery.response;
    err = checkoutRecovery.err;

    if (!response && (operation === 'find_products' || operation === 'find_products_multi')) {
      const searchExceptionFallback = await handleInvokeSearchExceptionFallback({
        operation,
        err,
        metadata,
        traceQueryClass,
        effectiveIntent,
        queryParams,
        queryText: resolverQueryText || searchQueryText,
        resolverQueryParams,
        resolverFirstResult,
        auroraFallbackOverrides,
        checkoutToken,
        resolverTimeoutMs,
        crossMerchantCacheProtectedResponse,
        extractUpstreamErrorCode,
        detectBrandEntities,
        shouldSkipSecondaryFallbackAfterResolverMiss,
        shouldAllowResolverFallback,
        shouldAllowSecondaryFallback,
        shouldAllowInvokeFallback,
        shouldBypassSecondaryFallbackSkipOnPrimaryException,
        queryResolveSearchFallback,
        queryFindProductsMultiFallback,
        isProxySearchFallbackRelevant,
        normalizeAgentProductsListResponse,
        withProxySearchFallbackMetadata,
        buildProxySearchSoftFallbackResponse,
        logger,
      });
      if (searchExceptionFallback.handled) {
        response = searchExceptionFallback.response;
      }
    }

    if (!response) throw err;
  }

  return {
    axiosConfig,
    response,
    productDetailCacheMeta,
    searchQueryText,
    resolverQueryText,
    resolverQueryParams,
    resolverTimeoutMs,
    resolverFirstResult,
    shouldAttemptResolverFirst,
    fpmLatencyGuardApplied,
    fpmSkippedGatesDueToBudget,
  };
}

module.exports = {
  executeInvokeUpstreamFlow,
};
