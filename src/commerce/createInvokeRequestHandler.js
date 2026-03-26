function createInvokeRequestHandler(config = {}) {
  return async function handleInvokeRequest(req, res, routeContext = {}) {
    const clientChannel =
      String(routeContext.client_channel || 'shop').trim().toLowerCase() || 'shop';
    const isProxySearchRoute = routeContext.proxy_search_route === true;
    const routeKeyFingerprint =
      routeContext.key_fingerprint || req?.invokeAuth?.key_fingerprint || null;
    const gatewayRequestId = config.createRequestId();
    const invokeStartedAtMs = config.nowMs();
    const debugRuntime = {
      operation: String(req?.body?.operation || '').trim().toLowerCase() || null,
      invokeStartedAtMs,
      nluLatencyMs: 0,
      vectorLatencyMs: 0,
      behaviorLatencyMs: 0,
      rankLatencyMs: 0,
      rawUserQuery: String(
        req?.body?.payload?.search?.query || req?.body?.payload?.query || '',
      ).trim(),
      intent: null,
      expansionMode: null,
    };
    const checkoutRuntime = {
      checkoutTraceId: null,
      paymentStatus: null,
      confirmationOwner: null,
      requiresClientConfirmation: null,
    };
    let upstreamElapsedMs = 0;
    let gatewayRetryCount = 0;

    config.configureInvokeResponseShell({
      req,
      res,
      routeContext,
      gatewayRequestId,
      invokeStartedAtMs,
      clientChannel,
      routeKeyFingerprint,
      debugRuntime,
      checkoutRuntime,
      checkoutTimingOps: config.checkoutTimingOps,
      getUpstreamElapsedMs: () => upstreamElapsedMs,
      getGatewayRetryCount: () => gatewayRetryCount,
      logger: config.logger,
    });

    try {
      const invokeContext = await config.initializeInvokeRequestContext({
        reqBody: req.body,
        gatewayRequestId,
        invokeStartedAtMs,
        invokeRequestSchema: config.invokeRequestSchema,
        operationEnum: config.operationEnum,
        creatorConfigs: config.creatorConfigs,
        isCreatorUiSource: config.isCreatorUiSource,
        buildFindProductsMultiContext: config.buildFindProductsMultiContext,
        defaultFindProductsMultiExpansionMode:
          config.defaultFindProductsMultiExpansionMode,
        searchCacheValidate: config.searchCacheValidate,
        searchForceControlledRecallForScenario:
          config.searchForceControlledRecallForScenario,
        searchCacheMinAnchor: config.searchCacheMinAnchor,
        searchCacheMaxDomainEntropy: config.searchCacheMaxDomainEntropy,
        searchCacheMinCount: config.searchCacheMinCount,
        searchCacheMaxCrossDomainRatio: config.searchCacheMaxCrossDomainRatio,
        searchUpstreamQuotaClarifyEnabled:
          config.searchUpstreamQuotaClarifyEnabled,
        searchUpstreamQuotaClarifyQueryClasses:
          config.searchUpstreamQuotaClarifyQueryClasses,
        logger: config.logger,
      });
      if (invokeContext.handled) {
        return res.status(invokeContext.statusCode).json(invokeContext.body);
      }

      const {
        operation,
        payload,
        metadata,
        creatorId,
        now,
        effectivePayload,
        effectiveIntent,
        findProductsExpansionMeta,
        rawUserQuery,
        policyMetadata,
        traceQueryClass,
        traceRewriteGate,
        traceAssociationPlan,
        traceFlagsSnapshot,
        traceAmbiguityScorePre,
        fpmGateTrace,
        addFpmGateTrace,
        getFpmRemainingBudgetMs: getFpmRemainingBudgetMsBase,
        debugRuntimePatch,
      } = invokeContext;
      Object.assign(debugRuntime, debugRuntimePatch);
      const getFpmRemainingBudgetMs = () =>
        getFpmRemainingBudgetMsBase(config.fpmGatewayTotalBudgetMs);

      const executionMode = config.prepareInvokeExecutionMode({
        req,
        operation,
        payload,
        effectivePayload,
        metadata,
        apiMode: config.apiMode,
        useMock: config.useMock,
        useHybrid: config.useHybrid,
        applyGatewayGuardrails: config.applyGatewayGuardrails,
        logger: config.logger,
      });
      if (executionMode.handled) {
        if (executionMode.headers && typeof executionMode.headers === 'object') {
          Object.entries(executionMode.headers).forEach(([headerName, headerValue]) => {
            if (headerValue != null) {
              res.setHeader(headerName, headerValue);
            }
          });
        }
        return res.status(executionMode.statusCode).json(executionMode.body);
      }

      const invokeResult = await config.runInvokeOperationFlow({
        operation,
        payload,
        effectivePayload,
        effectiveIntent,
        metadata,
        policyMetadata,
        rawUserQuery,
        creatorId,
        now,
        shouldUseMock: executionMode.shouldUseMock,
        defaultMerchantId: config.defaultMerchantId,
        serviceGitSha: config.serviceGitSha,
        gatewayRequestId,
        invokeStartedAtMs,
        checkoutToken: executionMode.checkoutToken,
        traceQueryClass,
        traceRewriteGate,
        traceAssociationPlan,
        traceFlagsSnapshot,
        traceAmbiguityScorePre,
        findProductsExpansionMeta,
        fpmGateTrace,
        addFpmGateTrace,
        getFpmRemainingBudgetMs,
        hasDatabase: config.hasDatabase,
        routeDebugEnabled: config.routeDebugEnabled,
        creatorCacheShortCircuitEnabled: config.creatorCacheShortCircuitEnabled,
        findProductsMultiVectorEnabled: config.findProductsMultiVectorEnabled,
        findProductsMultiCacheStageBudgetMs:
          config.findProductsMultiCacheStageBudgetMs,
        searchExternalHardRulePrune: config.searchExternalHardRulePrune,
        searchExternalFillGated: config.searchExternalFillGated,
        proxySearchCacheMissResolverFallbackEnabled:
          config.proxySearchCacheMissResolverFallbackEnabled,
        proxySearchAuroraResolverTimeoutMs:
          config.proxySearchAuroraResolverTimeoutMs,
        proxySearchResolverTimeoutMs: config.proxySearchResolverTimeoutMs,
        proxySearchResolverFirstOnSearchRouteEnabled:
          config.proxySearchResolverFirstOnSearchRouteEnabled,
        proxySearchAuroraBypassCacheStrictEmpty:
          config.proxySearchAuroraBypassCacheStrictEmpty,
        searchForceControlledRecallForScenario:
          config.searchForceControlledRecallForScenario,
        findProductsMultiExpansionMode: config.findProductsMultiExpansionMode,
        findProductsMultiSecondStageExpansionMode:
          config.findProductsMultiSecondStageExpansionMode,
        searchLimitMax: config.searchLimitMax,
        proxySearchCreatorScopeToConfig: config.proxySearchCreatorScopeToConfig,
        pivotaApiBase: config.pivotaApiBase,
        buildQueryString: config.buildQueryString,
        buildInvokeUpstreamAuthHeaders: config.buildInvokeUpstreamAuthHeaders,
        getUpstreamTimeoutMs: config.getUpstreamTimeoutMs,
        extractSearchQueryText: config.extractSearchQueryText,
        extractSearchAnchorTokens: config.extractSearchAnchorTokens,
        isLookupStyleSearchQuery: config.isLookupStyleSearchQuery,
        callUpstreamWithOptionalRetry: config.callUpstreamWithOptionalRetry,
        checkoutTimingOps: config.checkoutTimingOps,
        onGatewayRetry: () => {
          gatewayRetryCount += 1;
        },
        onUpstreamElapsed: (elapsedMs) => {
          upstreamElapsedMs += Math.max(0, Number(elapsedMs || 0) || 0);
        },
        shouldUseResolverFirstSearch: config.shouldUseResolverFirstSearch,
        shouldReducePrimaryTimeoutAfterResolverMiss:
          config.shouldReducePrimaryTimeoutAfterResolverMiss,
        fpmGateSimplifyV1: config.fpmGateSimplifyV1,
        fpmLatencyGuardResolverMinRemainingMs:
          config.fpmLatencyGuardResolverMinRemainingMs,
        fpmLatencyGuardSecondStageMinRemainingMs:
          config.fpmLatencyGuardSecondStageMinRemainingMs,
        proxySearchPrimaryTimeoutAfterResolverMissMs:
          config.proxySearchPrimaryTimeoutAfterResolverMissMs,
        checkoutRetryBaseMs: config.checkoutRetryBaseMs,
        extractUpstreamErrorCode: config.extractUpstreamErrorCode,
        isRetryableQuoteError: config.isRetryableQuoteError,
        isPydanticMissingBodyField: config.isPydanticMissingBodyField,
        sleep: config.sleep,
        randomFn: config.randomFn,
        shouldSkipSecondaryFallbackAfterResolverMiss:
          config.shouldSkipSecondaryFallbackAfterResolverMiss,
        shouldAllowResolverFallback: config.shouldAllowResolverFallback,
        shouldAllowSecondaryFallback: config.shouldAllowSecondaryFallback,
        shouldAllowInvokeFallback: config.shouldAllowInvokeFallback,
        shouldBypassSecondaryFallbackSkipOnPrimaryException:
          config.shouldBypassSecondaryFallbackSkipOnPrimaryException,
        findProductsMultiUpstreamLookupTimeoutMs:
          config.findProductsMultiUpstreamLookupTimeoutMs,
        findProductsMultiUpstreamDefaultTimeoutMs:
          config.findProductsMultiUpstreamDefaultTimeoutMs,
        auroraAllowExternalSeed: config.auroraAllowExternalSeed,
        auroraExternalSeedStrategy: config.auroraExternalSeedStrategy,
        countUsableSearchProducts: config.countUsableSearchProducts,
        shouldFallbackProxySearch: config.shouldFallbackProxySearch,
        computePrimaryQualityScore: config.computePrimaryQualityScore,
        detectAuroraExternalSeedMonoculture:
          config.detectAuroraExternalSeedMonoculture,
        hasFragranceQuerySignal: config.hasFragranceQuerySignal,
        getSecondaryFallbackSkipReason: config.getSecondaryFallbackSkipReason,
        buildFindProductsMultiContext: config.buildFindProductsMultiContext,
        axios: config.axios,
        getFallbackAdoptUsableThreshold:
          config.getFallbackAdoptUsableThreshold,
        normalizeAgentSource: config.normalizeAgentSource,
        normalizeAgentProductsListResponse:
          config.normalizeAgentProductsListResponse,
        normalizeAgentProductDetailResponse:
          config.normalizeAgentProductDetailResponse,
        withProxySearchFallbackMetadata: config.withProxySearchFallbackMetadata,
        buildProxySearchSoftFallbackResponse:
          config.buildProxySearchSoftFallbackResponse,
        withSearchDiagnostics: config.withSearchDiagnostics,
        buildSearchRouteHealth: config.buildSearchRouteHealth,
        buildSearchRelevanceDebug: config.buildSearchRelevanceDebug,
        withStrictEmptyFallback: config.withStrictEmptyFallback,
        searchStrictEmptyEnabled: config.searchStrictEmptyEnabled,
        fpmClarifyNeverEmpty: config.fpmClarifyNeverEmpty,
        searchRelevanceDebugEnabled: config.searchRelevanceDebugEnabled,
        buildPetFallbackQuery: config.buildPetFallbackQuery,
        maybeRerankFindProductsMultiResponse:
          config.maybeRerankFindProductsMultiResponse,
        detectBrandEntities: config.detectBrandEntities,
        isCreatorUiSource: config.isCreatorUiSource,
        loadCreatorSellableFromCache: config.loadCreatorSellableFromCache,
        searchCreatorSellableFromCache: config.searchCreatorSellableFromCache,
        probeCreatorCacheDbStats: config.probeCreatorCacheDbStats,
        loadCrossMerchantBrowseFromCache:
          config.loadCrossMerchantBrowseFromCache,
        uniqueStrings: config.uniqueStrings,
        withStageBudget: config.withStageBudget,
        searchCrossMerchantFromCache: config.searchCrossMerchantFromCache,
        normalizeSearchTextForMatch: config.normalizeSearchTextForMatch,
        tokenizeSearchTextForMatch: config.tokenizeSearchTextForMatch,
        isSupplementCandidateRelevant: config.isSupplementCandidateRelevant,
        hasPetLeashSearchSignal: config.hasPetLeashSearchSignal,
        hasStrictPetHarnessCatalogSignal:
          config.hasStrictPetHarnessCatalogSignal,
        buildFallbackCandidateText: config.buildFallbackCandidateText,
        hasPetHarnessSearchSignal: config.hasPetHarnessSearchSignal,
        hasFragranceSearchSignal: config.hasFragranceSearchSignal,
        isCatalogGuardSource: config.isCatalogGuardSource,
        isBeautyGeneralDiversitySupplementCandidate:
          config.isBeautyGeneralDiversitySupplementCandidate,
        fetchExternalSeedSupplementFromBackend:
          config.fetchExternalSeedSupplementFromBackend,
        firstQueryParamValue: config.firstQueryParamValue,
        buildSearchProductKey: config.buildSearchProductKey,
        isExternalSeedProduct: config.isExternalSeedProduct,
        blendBeautyDiversitySupplement:
          config.blendBeautyDiversitySupplement,
        resolveSearchDedupePerTitleLimit:
          config.resolveSearchDedupePerTitleLimit,
        collapseNearDuplicateSearchProducts:
          config.collapseNearDuplicateSearchProducts,
        isProxySearchFallbackRelevant: config.isProxySearchFallbackRelevant,
        hasPetSearchSignal: config.hasPetSearchSignal,
        hasBeautyMakeupSearchSignal: config.hasBeautyMakeupSearchSignal,
        hasBeautyCatalogProductSignal: config.hasBeautyCatalogProductSignal,
        isShoppingSource: config.isShoppingSource,
        normalizeExternalSeedStrategy: config.normalizeExternalSeedStrategy,
        isUnifiedLikeExternalSeedStrategy:
          config.isUnifiedLikeExternalSeedStrategy,
        evaluateCacheQualityGate: config.evaluateCacheQualityGate,
        isKnownLookupAliasQuery: config.isKnownLookupAliasQuery,
        queryResolveSearchFallback: config.queryResolveSearchFallback,
        queryFindProductsMultiFallback:
          config.queryFindProductsMultiFallback,
        isAuroraSource: config.isAuroraSource,
        loadMerchantBrowseFromCache: config.loadMerchantBrowseFromCache,
        applyShoppingCatalogQueryGuards:
          config.applyShoppingCatalogQueryGuards,
        getCreatorConfig: config.getCreatorConfig,
        findSimilarCreatorFromCache: config.findSimilarCreatorFromCache,
        getProxySearchApiBase: config.getProxySearchApiBase,
        getAuroraFallbackOverrides: config.getAuroraFallbackOverrides,
        isProxySearchRoute,
        applyFindProductsMultiPolicy: config.applyFindProductsMultiPolicy,
        handleOffersResolveOperation: config.handleOffersResolveOperation,
        inferOffersResolveFailureReasonCode:
          config.inferOffersResolveFailureReasonCode,
        buildOffersResolvePdpTargetExternal:
          config.buildOffersResolvePdpTargetExternal,
        buildOffersResolveResponse: config.buildOffersResolveResponse,
        pdpV2Args: {
          metadata,
          checkoutToken: executionMode.checkoutToken,
          gatewayRequestId,
          defaultMerchantId: config.defaultMerchantId,
          serviceGitSha: config.serviceGitSha,
          normalizeAgentProductDetailResponse:
            config.normalizeAgentProductDetailResponse,
          resolveProductGroupCached: config.resolveProductGroupCached,
          logger: config.logger,
        },
        getPdpArgs: {
          checkoutToken: executionMode.checkoutToken,
          defaultMerchantId: config.defaultMerchantId,
          logger: config.logger,
        },
        resolveProductGroupArgs: {
          checkoutToken: executionMode.checkoutToken,
          resolveProductGroupCached: config.resolveProductGroupCached,
          logger: config.logger,
        },
        resolveProductCandidatesArgs: {
          checkoutToken: executionMode.checkoutToken,
          pivotaApiBase: config.pivotaApiBase,
          resolveCatalogSyncMerchantIds: config.resolveCatalogSyncMerchantIds,
          buildQueryString: config.buildQueryString,
          buildInvokeUpstreamAuthHeaders:
            config.buildInvokeUpstreamAuthHeaders,
          getUpstreamTimeoutMs: config.getUpstreamTimeoutMs,
          callUpstreamWithOptionalRetry: config.callUpstreamWithOptionalRetry,
          normalizeAgentProductsListResponse:
            config.normalizeAgentProductsListResponse,
          getResolveProductCandidatesCacheEntry:
            config.getResolveProductCandidatesCacheEntry,
          setResolveProductCandidatesCache:
            config.setResolveProductCandidatesCache,
          resolveProductCandidatesCacheEnabled:
            config.resolveProductCandidatesCacheEnabled,
          resolveProductCandidatesCacheMetrics:
            config.resolveProductCandidatesCacheMetrics,
          resolveProductCandidatesTtlMs:
            config.resolveProductCandidatesTtlMs,
          logger: config.logger,
          nodeEnv: config.nodeEnv,
        },
        logger: config.logger,
      });

      return config.sendInvokeOperationResponse({
        res,
        invokeResult,
        checkoutRuntime,
      });
    } catch (err) {
      return config.handleUnhandledInvokeRequestError({
        err,
        res,
        gatewayRequestId,
        logger: config.logger,
      });
    }
  };
}

module.exports = {
  createInvokeRequestHandler,
};
