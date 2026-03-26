const {
  handleInvokeShortCircuit: handleInvokeShortCircuitBase,
} = require('./handleInvokeShortCircuit');
const {
  prepareInvokeUpstreamRequest: prepareInvokeUpstreamRequestBase,
} = require('./prepareInvokeUpstreamRequest');
const {
  executeInvokeUpstreamFlow: executeInvokeUpstreamFlowBase,
} = require('./executeInvokeUpstreamFlow');
const {
  finalizeInvokeResponseFlow: finalizeInvokeResponseFlowBase,
} = require('./finalizeInvokeResponseFlow');
const {
  buildInvokeErrorResponse: buildInvokeErrorResponseBase,
} = require('./buildInvokeErrorResponse');
const {
  maybeHandleFindProductsMultiCachePrelude: maybeHandleFindProductsMultiCachePreludeBase,
  maybeHandleFindProductsCachePrelude: maybeHandleFindProductsCachePreludeBase,
} = require('./catalog/preUpstreamCacheRoutes');
const {
  maybeHandleFindProductsMultiCrossMerchantCacheSearch:
    maybeHandleFindProductsMultiCrossMerchantCacheSearchBase,
} = require('./catalog/crossMerchantCacheSearch');
const {
  buildSearchTrace: buildSearchTraceBase,
} = require('./catalog/searchTrace');

async function runInvokeOperationFlow({
  operation,
  payload,
  effectivePayload,
  effectiveIntent,
  metadata,
  policyMetadata,
  rawUserQuery,
  creatorId,
  now,
  shouldUseMock,
  defaultMerchantId,
  serviceGitSha,
  gatewayRequestId,
  invokeStartedAtMs,
  checkoutToken,
  traceQueryClass,
  traceRewriteGate,
  traceAssociationPlan,
  traceFlagsSnapshot,
  traceAmbiguityScorePre,
  findProductsExpansionMeta,
  fpmGateTrace = [],
  addFpmGateTrace,
  getFpmRemainingBudgetMs,
  hasDatabase,
  routeDebugEnabled,
  creatorCacheShortCircuitEnabled,
  findProductsMultiVectorEnabled,
  findProductsMultiCacheStageBudgetMs,
  searchExternalHardRulePrune,
  searchExternalFillGated,
  proxySearchCacheMissResolverFallbackEnabled,
  proxySearchAuroraResolverTimeoutMs,
  proxySearchResolverTimeoutMs,
  proxySearchResolverFirstOnSearchRouteEnabled,
  proxySearchAuroraBypassCacheStrictEmpty,
  searchForceControlledRecallForScenario,
  findProductsMultiExpansionMode,
  findProductsMultiSecondStageExpansionMode,
  searchLimitMax,
  proxySearchCreatorScopeToConfig,
  pivotaApiBase,
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
  shouldUseResolverFirstSearch,
  shouldReducePrimaryTimeoutAfterResolverMiss,
  fpmGateSimplifyV1,
  fpmLatencyGuardResolverMinRemainingMs,
  fpmLatencyGuardSecondStageMinRemainingMs,
  proxySearchPrimaryTimeoutAfterResolverMissMs,
  checkoutRetryBaseMs,
  extractUpstreamErrorCode,
  isRetryableQuoteError,
  isPydanticMissingBodyField,
  sleep,
  randomFn,
  shouldSkipSecondaryFallbackAfterResolverMiss,
  shouldAllowResolverFallback,
  shouldAllowSecondaryFallback,
  shouldAllowInvokeFallback,
  shouldBypassSecondaryFallbackSkipOnPrimaryException,
  findProductsMultiUpstreamLookupTimeoutMs,
  findProductsMultiUpstreamDefaultTimeoutMs,
  auroraAllowExternalSeed,
  auroraExternalSeedStrategy,
  countUsableSearchProducts,
  shouldFallbackProxySearch,
  computePrimaryQualityScore,
  detectAuroraExternalSeedMonoculture,
  hasFragranceQuerySignal,
  getSecondaryFallbackSkipReason,
  buildFindProductsMultiContext,
  axios,
  getFallbackAdoptUsableThreshold,
  normalizeAgentSource,
  normalizeAgentProductsListResponse,
  normalizeAgentProductDetailResponse,
  withProxySearchFallbackMetadata,
  buildProxySearchSoftFallbackResponse,
  withSearchDiagnostics,
  buildSearchRouteHealth,
  buildSearchTrace = buildSearchTraceBase,
  buildSearchRelevanceDebug,
  withStrictEmptyFallback,
  searchStrictEmptyEnabled,
  fpmClarifyNeverEmpty,
  searchRelevanceDebugEnabled,
  buildPetFallbackQuery,
  maybeRerankFindProductsMultiResponse,
  detectBrandEntities,
  isCreatorUiSource,
  loadCreatorSellableFromCache,
  searchCreatorSellableFromCache,
  probeCreatorCacheDbStats,
  loadCrossMerchantBrowseFromCache,
  uniqueStrings,
  withStageBudget,
  searchCrossMerchantFromCache,
  normalizeSearchTextForMatch,
  tokenizeSearchTextForMatch,
  isSupplementCandidateRelevant,
  hasPetLeashSearchSignal,
  hasStrictPetHarnessCatalogSignal,
  buildFallbackCandidateText,
  hasPetHarnessSearchSignal,
  hasFragranceSearchSignal,
  isCatalogGuardSource,
  isBeautyGeneralDiversitySupplementCandidate,
  fetchExternalSeedSupplementFromBackend,
  firstQueryParamValue,
  buildSearchProductKey,
  isExternalSeedProduct,
  blendBeautyDiversitySupplement,
  resolveSearchDedupePerTitleLimit,
  collapseNearDuplicateSearchProducts,
  isProxySearchFallbackRelevant,
  hasPetSearchSignal,
  hasBeautyMakeupSearchSignal,
  hasBeautyCatalogProductSignal,
  isShoppingSource,
  normalizeExternalSeedStrategy,
  isUnifiedLikeExternalSeedStrategy,
  evaluateCacheQualityGate,
  isKnownLookupAliasQuery,
  queryResolveSearchFallback,
  queryFindProductsMultiFallback,
  isAuroraSource,
  loadMerchantBrowseFromCache,
  applyShoppingCatalogQueryGuards,
  getCreatorConfig,
  findSimilarCreatorFromCache,
  getProxySearchApiBase,
  getAuroraFallbackOverrides,
  isProxySearchRoute,
  applyFindProductsMultiPolicy,
  handleOffersResolveOperation,
  inferOffersResolveFailureReasonCode,
  buildOffersResolvePdpTargetExternal,
  buildOffersResolveResponse,
  pdpV2Args,
  getPdpArgs,
  resolveProductGroupArgs,
  resolveProductCandidatesArgs,
  handleInvokeShortCircuit = handleInvokeShortCircuitBase,
  maybeHandleFindProductsMultiCachePrelude =
    maybeHandleFindProductsMultiCachePreludeBase,
  maybeHandleFindProductsMultiCrossMerchantCacheSearch =
    maybeHandleFindProductsMultiCrossMerchantCacheSearchBase,
  maybeHandleFindProductsCachePrelude = maybeHandleFindProductsCachePreludeBase,
  prepareInvokeUpstreamRequest = prepareInvokeUpstreamRequestBase,
  executeInvokeUpstreamFlow = executeInvokeUpstreamFlowBase,
  finalizeInvokeResponseFlow = finalizeInvokeResponseFlowBase,
  buildInvokeErrorResponse = buildInvokeErrorResponseBase,
  logger,
} = {}) {
  const shortCircuitResult = await handleInvokeShortCircuit({
    operation,
    payload,
    effectivePayload,
    effectiveIntent,
    metadata,
    policyMetadata,
    rawUserQuery,
    creatorId,
    now,
    shouldUseMock,
    defaultMerchantId,
    serviceGitSha,
    applyFindProductsMultiPolicy,
    handleOffersResolveOperation,
    inferOffersResolveFailureReasonCode,
    buildOffersResolvePdpTargetExternal,
    buildOffersResolveResponse,
    pdpV2Args,
    getPdpArgs,
    resolveProductGroupArgs,
    resolveProductCandidatesArgs,
    logger,
  });
  if (shortCircuitResult.handled) {
    return {
      statusCode: shortCircuitResult.statusCode || 200,
      body: shortCircuitResult.body,
      headers: null,
      checkoutRuntime: null,
    };
  }

  let crossMerchantCacheProtectedResponse = null;
  let queryParams = {};

  try {
    let creatorCacheRouteDebug = null;
    let crossMerchantCacheRouteDebug = null;
    let resolvedOfferId = null;
    let resolvedMerchantId = null;
    let productDetailMerchantId = null;
    let productDetailProductId = null;
    let productDetailCacheKey = null;
    let productDetailDebug = false;
    let productDetailBypassCache = false;
    let productDetailCacheMeta = null;
    let fpmSkippedGatesDueToBudget = [];
    let fpmLatencyGuardApplied = false;

    if (operation === 'find_products_multi') {
      const prelude = await maybeHandleFindProductsMultiCachePrelude({
        metadata,
        effectivePayload,
        effectiveIntent,
        policyMetadata,
        rawUserQuery,
        now,
        creatorId,
        hasDatabase,
        routeDebugEnabled,
        creatorCacheShortCircuitEnabled,
        findProductsMultiVectorEnabled,
        detectBrandEntities,
        isCreatorUiSource,
        loadCreatorSellableFromCache,
        searchCreatorSellableFromCache,
        probeCreatorCacheDbStats,
        loadCrossMerchantBrowseFromCache,
        applyFindProductsMultiPolicy,
        uniqueStrings,
        logger,
      });
      creatorCacheRouteDebug = prelude.creatorCacheRouteDebug;
      crossMerchantCacheRouteDebug = prelude.crossMerchantCacheRouteDebug;
      if (prelude.handled) {
        return {
          statusCode: 200,
          body: prelude.body,
          headers: null,
          checkoutRuntime: null,
        };
      }

      const crossMerchantSearchPrelude =
        await maybeHandleFindProductsMultiCrossMerchantCacheSearch({
          metadata,
          payload,
          effectivePayload,
          effectiveIntent,
          policyMetadata,
          rawUserQuery,
          findProductsExpansionMeta,
          traceQueryClass,
          traceRewriteGate,
          traceAssociationPlan,
          traceFlagsSnapshot,
          traceAmbiguityScorePre,
          gatewayRequestId,
          invokeStartedAtMs,
          now,
          creatorId,
          checkoutToken,
          hasDatabase,
          routeDebugEnabled,
          findProductsMultiCacheStageBudgetMs,
          searchExternalHardRulePrune,
          searchExternalFillGated,
          proxySearchCacheMissResolverFallbackEnabled,
          proxySearchAuroraResolverTimeoutMs,
          proxySearchResolverTimeoutMs,
          proxySearchAuroraBypassCacheStrictEmpty,
          searchForceControlledRecallForScenario,
          findProductsMultiExpansionMode,
          addFpmGateTrace,
          detectBrandEntities,
          isCreatorUiSource,
          withStageBudget,
          searchCrossMerchantFromCache,
          extractSearchAnchorTokens,
          isLookupStyleSearchQuery,
          normalizeSearchTextForMatch,
          tokenizeSearchTextForMatch,
          isSupplementCandidateRelevant,
          hasPetLeashSearchSignal,
          hasStrictPetHarnessCatalogSignal,
          buildFallbackCandidateText,
          hasPetHarnessSearchSignal,
          hasFragranceSearchSignal,
          isCatalogGuardSource,
          isBeautyGeneralDiversitySupplementCandidate,
          fetchExternalSeedSupplementFromBackend,
          firstQueryParamValue,
          buildSearchProductKey,
          isExternalSeedProduct,
          blendBeautyDiversitySupplement,
          resolveSearchDedupePerTitleLimit,
          collapseNearDuplicateSearchProducts,
          isProxySearchFallbackRelevant,
          hasPetSearchSignal,
          hasBeautyMakeupSearchSignal,
          hasBeautyCatalogProductSignal,
          isShoppingSource,
          normalizeExternalSeedStrategy,
          isUnifiedLikeExternalSeedStrategy,
          uniqueStrings,
          evaluateCacheQualityGate,
          applyFindProductsMultiPolicy,
          withSearchDiagnostics,
          buildSearchRouteHealth,
          buildSearchTrace,
          isKnownLookupAliasQuery,
          queryResolveSearchFallback,
          isAuroraSource,
          logger,
        });
      crossMerchantCacheRouteDebug =
        crossMerchantSearchPrelude.crossMerchantCacheRouteDebug;
      crossMerchantCacheProtectedResponse =
        crossMerchantSearchPrelude.crossMerchantCacheProtectedResponse;
      if (crossMerchantSearchPrelude.handled) {
        return {
          statusCode: 200,
          body: crossMerchantSearchPrelude.body,
          headers: null,
          checkoutRuntime: null,
        };
      }
    }

    if (operation === 'find_products') {
      const prelude = await maybeHandleFindProductsCachePrelude({
        metadata,
        effectivePayload,
        now,
        creatorId,
        hasDatabase,
        routeDebugEnabled,
        searchLimitMax,
        loadMerchantBrowseFromCache,
        logger,
      });
      if (prelude.handled) {
        return {
          statusCode: 200,
          body: prelude.body,
          headers: null,
          checkoutRuntime: null,
        };
      }
    }

    const invokePreparation = await prepareInvokeUpstreamRequest({
      operation,
      payload,
      effectivePayload,
      metadata,
      creatorId,
      checkoutToken,
      pivotaApiBase,
      searchLimitMax,
      applyShoppingCatalogQueryGuards,
      getCreatorConfig,
      uniqueStrings,
      isCreatorUiSource,
      proxySearchCreatorScopeToConfig,
      now,
      hasDatabase,
      findSimilarCreatorFromCache,
      getProxySearchApiBase,
      logger,
    });
    if (invokePreparation.handled) {
      return {
        statusCode: invokePreparation.statusCode || 200,
        body: invokePreparation.body,
        headers: null,
        checkoutRuntime: null,
      };
    }

    const route = invokePreparation.route;
    const url = invokePreparation.url;
    const requestBody = invokePreparation.requestBody || {};
    queryParams = invokePreparation.queryParams || {};
    resolvedOfferId = invokePreparation.resolvedOfferId || null;
    resolvedMerchantId = invokePreparation.resolvedMerchantId || null;
    productDetailMerchantId = invokePreparation.productDetail?.merchantId || null;
    productDetailProductId = invokePreparation.productDetail?.productId || null;
    productDetailCacheKey = invokePreparation.productDetail?.cacheKey || null;
    productDetailDebug = invokePreparation.productDetail?.debug === true;
    productDetailBypassCache =
      invokePreparation.productDetail?.bypassCache === true;

    logger?.info?.(
      {
        operation,
        method: route.method,
        url,
        hasQuery: Object.keys(queryParams).length > 0,
      },
      'Forwarding invoke request',
    );

    let proxyRouteFallbackStrategy = null;
    const auroraFallbackOverrides = getAuroraFallbackOverrides(
      metadata?.source,
      operation,
    );
    const invokeUpstreamFlow = await executeInvokeUpstreamFlow({
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
      fpmLatencyGuardApplied,
      fpmSkippedGatesDueToBudget,
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
      randomFn,
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
      logger,
    });
    const response = invokeUpstreamFlow.response;
    const axiosConfig = invokeUpstreamFlow.axiosConfig;
    productDetailCacheMeta = invokeUpstreamFlow.productDetailCacheMeta;
    const resolverQueryParams = invokeUpstreamFlow.resolverQueryParams;
    const resolverTimeoutMs = invokeUpstreamFlow.resolverTimeoutMs;
    const resolverFirstResult = invokeUpstreamFlow.resolverFirstResult;
    const shouldAttemptResolverFirst =
      invokeUpstreamFlow.shouldAttemptResolverFirst;
    fpmLatencyGuardApplied = invokeUpstreamFlow.fpmLatencyGuardApplied;
    fpmSkippedGatesDueToBudget =
      invokeUpstreamFlow.fpmSkippedGatesDueToBudget;

    const finalizedResponse = await finalizeInvokeResponseFlow({
      operation,
      upstreamData: response.data,
      responseStatus: response.status,
      payload,
      queryParams,
      metadata,
      rawUserQuery,
      effectiveIntent,
      traceQueryClass,
      checkoutToken,
      resolverFirstResult,
      resolverTimeoutMs,
      shouldAttemptResolverFirst,
      isProxySearchRoute,
      proxyRouteFallbackStrategy,
      auroraFallbackOverrides,
      auroraExternalSeedEnabled: auroraAllowExternalSeed,
      auroraExternalSeedStrategy,
      auroraUpstreamBase: getProxySearchApiBase(metadata?.source),
      fpmLatencyGuardApplied,
      fpmSkippedGatesDueToBudget,
      addFpmGateTrace,
      getFpmRemainingBudgetMs,
      searchLimitMax,
      findProductsMultiSecondStageExpansionMode,
      fpmGateSimplifyV1,
      fpmLatencyGuardSecondStageMinRemainingMs:
        fpmLatencyGuardSecondStageMinRemainingMs,
      searchExternalHardRulePrune,
      detectBrandEntities,
      extractSearchQueryText,
      extractSearchAnchorTokens,
      isLookupStyleSearchQuery,
      normalizeAgentProductsListResponse,
      countUsableSearchProducts,
      shouldFallbackProxySearch,
      isProxySearchFallbackRelevant,
      evaluateCacheQualityGate,
      computePrimaryQualityScore,
      isExternalSeedProduct,
      detectAuroraExternalSeedMonoculture,
      hasFragranceQuerySignal,
      getSecondaryFallbackSkipReason,
      shouldAllowResolverFallback,
      shouldAllowSecondaryFallback,
      shouldAllowInvokeFallback,
      buildFindProductsMultiContext,
      axios,
      url,
      buildQueryString,
      axiosConfig,
      buildSearchProductKey,
      isSupplementCandidateRelevant,
      queryResolveSearchFallback,
      queryFindProductsMultiFallback,
      getFallbackAdoptUsableThreshold,
      buildProxySearchSoftFallbackResponse,
      withProxySearchFallbackMetadata,
      normalizeAgentSource,
      requestBody,
      resolvedOfferId,
      resolvedMerchantId,
      gatewayRequestId,
      productDetailCacheKey,
      productDetailCacheMeta,
      productDetailDebug,
      productDetailBypassCache,
      normalizeAgentProductDetailResponse,
      effectivePayload,
      policyMetadata,
      creatorId,
      hasDatabase,
      now,
      creatorCacheRouteDebug,
      crossMerchantCacheRouteDebug,
      invokeStartedAtMs,
      traceRewriteGate,
      traceAssociationPlan,
      traceFlagsSnapshot,
      traceAmbiguityScorePre,
      findProductsExpansionMeta,
      fpmGateTrace,
      routeDebugEnabled,
      searchStrictEmptyEnabled,
      fpmClarifyNeverEmpty,
      searchRelevanceDebugEnabled,
      defaultFindProductsMultiExpansionMode: findProductsMultiExpansionMode,
      isKnownLookupAliasQuery,
      applyFindProductsMultiPolicy,
      buildPetFallbackQuery,
      searchCreatorSellableFromCache,
      maybeRerankFindProductsMultiResponse,
      withSearchDiagnostics,
      buildSearchRouteHealth,
      buildSearchTrace,
      buildSearchRelevanceDebug,
      logger,
    });

    return {
      statusCode: response.status,
      body: finalizedResponse.body,
      headers: null,
      checkoutRuntime: finalizedResponse.checkoutRuntime || null,
    };
  } catch (err) {
    const invokeError = buildInvokeErrorResponse({
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
      defaultFindProductsMultiExpansionMode: findProductsMultiExpansionMode,
      normalizeAgentProductsListResponse,
      withProxySearchFallbackMetadata,
      withSearchDiagnostics,
      buildSearchRouteHealth,
      buildSearchTrace,
      extractSearchQueryText,
      withStrictEmptyFallback,
      logger,
    });
    return {
      statusCode: invokeError.statusCode,
      body: invokeError.body,
      headers: invokeError.headers || null,
      checkoutRuntime: null,
    };
  }
}

module.exports = {
  runInvokeOperationFlow,
};
