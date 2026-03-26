const {
  runInvokeOperationFlow,
} = require('../../src/commerce/runInvokeOperationFlow');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'preview_quote',
    payload: { items: [{ offer_id: 'offer_1', quantity: 1 }] },
    effectivePayload: { items: [{ offer_id: 'offer_1', quantity: 1 }] },
    effectiveIntent: null,
    metadata: { source: 'shopping_agent' },
    policyMetadata: {},
    rawUserQuery: '',
    creatorId: 'creator_1',
    now: new Date('2026-03-22T00:00:00.000Z'),
    shouldUseMock: false,
    defaultMerchantId: 'merchant_default',
    serviceGitSha: 'sha123',
    gatewayRequestId: 'req_1',
    invokeStartedAtMs: 100,
    checkoutToken: 'checkout-token',
    traceQueryClass: null,
    traceRewriteGate: null,
    traceAssociationPlan: null,
    traceFlagsSnapshot: {},
    traceAmbiguityScorePre: null,
    findProductsExpansionMeta: null,
    fpmGateTrace: [],
    addFpmGateTrace: jest.fn(),
    getFpmRemainingBudgetMs: jest.fn(() => 1500),
    hasDatabase: true,
    routeDebugEnabled: true,
    creatorCacheShortCircuitEnabled: true,
    findProductsMultiVectorEnabled: true,
    findProductsMultiCacheStageBudgetMs: 200,
    searchExternalHardRulePrune: true,
    searchExternalFillGated: true,
    proxySearchCacheMissResolverFallbackEnabled: true,
    proxySearchAuroraResolverTimeoutMs: 900,
    proxySearchResolverTimeoutMs: 700,
    proxySearchResolverFirstOnSearchRouteEnabled: true,
    proxySearchAuroraBypassCacheStrictEmpty: false,
    searchForceControlledRecallForScenario: false,
    findProductsMultiExpansionMode: 'conservative',
    findProductsMultiSecondStageExpansionMode: 'conservative',
    searchLimitMax: 50,
    proxySearchCreatorScopeToConfig: true,
    pivotaApiBase: 'http://pivota.test',
    buildQueryString: jest.fn(() => '?query=ipsa'),
    buildInvokeUpstreamAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer token' })),
    getUpstreamTimeoutMs: jest.fn(() => 5000),
    extractSearchQueryText: jest.fn((query) => String(query?.query || '').trim()),
    extractSearchAnchorTokens: jest.fn(() => []),
    isLookupStyleSearchQuery: jest.fn(() => false),
    callUpstreamWithOptionalRetry: jest.fn(),
    checkoutTimingOps: new Set(['create_order', 'submit_payment', 'confirm_payment']),
    onGatewayRetry: jest.fn(),
    onUpstreamElapsed: jest.fn(),
    shouldUseResolverFirstSearch: jest.fn(() => false),
    shouldReducePrimaryTimeoutAfterResolverMiss: jest.fn(() => false),
    fpmGateSimplifyV1: true,
    fpmLatencyGuardResolverMinRemainingMs: 300,
    fpmLatencyGuardSecondStageMinRemainingMs: 300,
    proxySearchPrimaryTimeoutAfterResolverMissMs: 1800,
    checkoutRetryBaseMs: 100,
    extractUpstreamErrorCode: jest.fn(() => ({ code: 'TEMPORARY_UNAVAILABLE' })),
    isRetryableQuoteError: jest.fn(() => false),
    isPydanticMissingBodyField: jest.fn(() => false),
    sleep: jest.fn(async () => {}),
    randomFn: jest.fn(() => 0),
    shouldSkipSecondaryFallbackAfterResolverMiss: jest.fn(() => false),
    shouldAllowResolverFallback: jest.fn(() => true),
    shouldAllowSecondaryFallback: jest.fn(() => true),
    shouldAllowInvokeFallback: jest.fn(() => true),
    shouldBypassSecondaryFallbackSkipOnPrimaryException: jest.fn(() => false),
    findProductsMultiUpstreamLookupTimeoutMs: 3200,
    findProductsMultiUpstreamDefaultTimeoutMs: 6500,
    auroraAllowExternalSeed: false,
    auroraExternalSeedStrategy: 'supplement_internal_first',
    countUsableSearchProducts: jest.fn(() => 0),
    shouldFallbackProxySearch: jest.fn(() => false),
    computePrimaryQualityScore: jest.fn(() => 1),
    detectAuroraExternalSeedMonoculture: jest.fn(() => ({ detected: false })),
    hasFragranceQuerySignal: jest.fn(() => false),
    getSecondaryFallbackSkipReason: jest.fn(() => null),
    buildFindProductsMultiContext: jest.fn(() => ({})),
    axios: {},
    getFallbackAdoptUsableThreshold: jest.fn(() => 1),
    normalizeAgentSource: jest.fn((source) => source),
    normalizeAgentProductsListResponse: jest.fn((data) => data),
    normalizeAgentProductDetailResponse: jest.fn((data) => data),
    withProxySearchFallbackMetadata: jest.fn((data) => data),
    buildProxySearchSoftFallbackResponse: jest.fn((data) => data),
    withSearchDiagnostics: jest.fn((data) => data),
    buildSearchRouteHealth: jest.fn(() => ({})),
    buildSearchTrace: jest.fn(() => ({})),
    buildSearchRelevanceDebug: jest.fn(() => ({})),
    withStrictEmptyFallback: jest.fn((data) => data),
    searchStrictEmptyEnabled: true,
    fpmClarifyNeverEmpty: false,
    searchRelevanceDebugEnabled: false,
    buildPetFallbackQuery: jest.fn(() => null),
    maybeRerankFindProductsMultiResponse: jest.fn(async (response) => response),
    detectBrandEntities: jest.fn(() => ({ brand_like: false })),
    isCreatorUiSource: jest.fn(() => false),
    loadCreatorSellableFromCache: jest.fn(),
    searchCreatorSellableFromCache: jest.fn(),
    probeCreatorCacheDbStats: jest.fn(),
    loadCrossMerchantBrowseFromCache: jest.fn(),
    uniqueStrings: jest.fn((values) => Array.from(new Set(values.filter(Boolean)))),
    withStageBudget: jest.fn(async (promise) => promise),
    searchCrossMerchantFromCache: jest.fn(),
    normalizeSearchTextForMatch: jest.fn((value) => String(value || '').trim()),
    tokenizeSearchTextForMatch: jest.fn(() => []),
    isSupplementCandidateRelevant: jest.fn(() => true),
    hasPetLeashSearchSignal: jest.fn(() => false),
    hasStrictPetHarnessCatalogSignal: jest.fn(() => false),
    buildFallbackCandidateText: jest.fn(() => ''),
    hasPetHarnessSearchSignal: jest.fn(() => false),
    hasFragranceSearchSignal: jest.fn(() => false),
    isCatalogGuardSource: jest.fn(() => false),
    isBeautyGeneralDiversitySupplementCandidate: jest.fn(() => false),
    fetchExternalSeedSupplementFromBackend: jest.fn(),
    firstQueryParamValue: jest.fn(() => null),
    buildSearchProductKey: jest.fn(() => 'key_1'),
    isExternalSeedProduct: jest.fn(() => false),
    blendBeautyDiversitySupplement: jest.fn((products) => products),
    resolveSearchDedupePerTitleLimit: jest.fn(() => 1),
    collapseNearDuplicateSearchProducts: jest.fn((products) => products),
    isProxySearchFallbackRelevant: jest.fn(() => true),
    hasPetSearchSignal: jest.fn(() => false),
    hasBeautyMakeupSearchSignal: jest.fn(() => false),
    hasBeautyCatalogProductSignal: jest.fn(() => false),
    isShoppingSource: jest.fn(() => true),
    normalizeExternalSeedStrategy: jest.fn((strategy) => strategy),
    isUnifiedLikeExternalSeedStrategy: jest.fn(() => false),
    evaluateCacheQualityGate: jest.fn(() => ({ accepted: true })),
    isKnownLookupAliasQuery: jest.fn(() => false),
    queryResolveSearchFallback: jest.fn(),
    queryFindProductsMultiFallback: jest.fn(),
    isAuroraSource: jest.fn(() => false),
    loadMerchantBrowseFromCache: jest.fn(),
    applyShoppingCatalogQueryGuards: jest.fn((query) => query),
    getCreatorConfig: jest.fn(() => null),
    findSimilarCreatorFromCache: jest.fn(),
    getProxySearchApiBase: jest.fn(() => 'http://proxy-search.test'),
    getAuroraFallbackOverrides: jest.fn(() => ({ active: false })),
    isProxySearchRoute: false,
    applyFindProductsMultiPolicy: jest.fn(({ response }) => response),
    handleOffersResolveOperation: jest.fn(),
    inferOffersResolveFailureReasonCode: jest.fn(() => 'resolver_failed'),
    buildOffersResolvePdpTargetExternal: jest.fn(() => ({})),
    buildOffersResolveResponse: jest.fn(() => ({})),
    pdpV2Args: { checkoutToken: 'checkout-token' },
    getPdpArgs: { checkoutToken: 'checkout-token' },
    resolveProductGroupArgs: { checkoutToken: 'checkout-token' },
    resolveProductCandidatesArgs: { checkoutToken: 'checkout-token' },
    handleInvokeShortCircuit: jest.fn(async () => ({ handled: false })),
    maybeHandleFindProductsMultiCachePrelude: jest.fn(async () => ({
      handled: false,
      creatorCacheRouteDebug: null,
      crossMerchantCacheRouteDebug: null,
    })),
    maybeHandleFindProductsMultiCrossMerchantCacheSearch: jest.fn(async () => ({
      handled: false,
      crossMerchantCacheRouteDebug: null,
      crossMerchantCacheProtectedResponse: null,
    })),
    maybeHandleFindProductsCachePrelude: jest.fn(async () => ({ handled: false })),
    prepareInvokeUpstreamRequest: jest.fn(async () => ({
      handled: false,
      route: { method: 'POST', path: '/agent/v1/quote/preview' },
      url: 'http://pivota.test/agent/v1/quote/preview',
      requestBody: { items: [{ offer_id: 'offer_1', quantity: 1 }] },
      queryParams: {},
      resolvedOfferId: null,
      resolvedMerchantId: null,
      productDetail: {
        merchantId: null,
        productId: null,
        cacheKey: null,
        debug: false,
        bypassCache: false,
      },
    })),
    executeInvokeUpstreamFlow: jest.fn(async () => ({
      axiosConfig: { method: 'POST', url: 'http://pivota.test/agent/v1/quote/preview' },
      response: { status: 200, data: { status: 'success', quote_id: 'quote_1' } },
      productDetailCacheMeta: null,
      resolverQueryParams: {},
      resolverTimeoutMs: 700,
      resolverFirstResult: null,
      shouldAttemptResolverFirst: false,
      fpmLatencyGuardApplied: false,
      fpmSkippedGatesDueToBudget: [],
    })),
    finalizeInvokeResponseFlow: jest.fn(async () => ({
      body: { status: 'success', quote_id: 'quote_1' },
      checkoutRuntime: { checkoutTraceId: 'trace_1', paymentStatus: 'processing' },
    })),
    buildInvokeErrorResponse: jest.fn(() => ({
      statusCode: 502,
      body: { error: 'UPSTREAM_UNAVAILABLE' },
      headers: { 'X-Upstream-Request-Id': 'up_req_1' },
    })),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('runInvokeOperationFlow', () => {
  test('returns short-circuit responses immediately', async () => {
    const args = createBaseArgs({
      handleInvokeShortCircuit: jest.fn(async () => ({
        handled: true,
        statusCode: 200,
        body: { status: 'success', products: [] },
      })),
    });

    const result = await runInvokeOperationFlow(args);

    expect(result).toEqual({
      statusCode: 200,
      body: { status: 'success', products: [] },
      headers: null,
      checkoutRuntime: null,
    });
    expect(args.prepareInvokeUpstreamRequest).not.toHaveBeenCalled();
  });

  test('returns cross-merchant cache-search responses before upstream invoke', async () => {
    const args = createBaseArgs({
      operation: 'find_products_multi',
      effectivePayload: { search: { query: 'ipsa toner' } },
      payload: { search: { query: 'ipsa toner' } },
      maybeHandleFindProductsMultiCrossMerchantCacheSearch: jest.fn(async () => ({
        handled: true,
        body: { status: 'success', products: [{ product_id: 'p_1' }] },
        crossMerchantCacheRouteDebug: { cache_hit: true },
        crossMerchantCacheProtectedResponse: { body: { products: [] } },
      })),
    });

    const result = await runInvokeOperationFlow(args);

    expect(args.maybeHandleFindProductsMultiCachePrelude).toHaveBeenCalled();
    expect(args.maybeHandleFindProductsMultiCrossMerchantCacheSearch).toHaveBeenCalled();
    expect(args.prepareInvokeUpstreamRequest).not.toHaveBeenCalled();
    expect(result).toEqual({
      statusCode: 200,
      body: { status: 'success', products: [{ product_id: 'p_1' }] },
      headers: null,
      checkoutRuntime: null,
    });
  });

  test('runs prepare, execute, and finalize for real upstream invoke flows', async () => {
    const args = createBaseArgs();

    const result = await runInvokeOperationFlow(args);

    expect(args.prepareInvokeUpstreamRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'preview_quote',
        payload: args.payload,
      }),
    );
    expect(args.executeInvokeUpstreamFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'preview_quote',
        route: { method: 'POST', path: '/agent/v1/quote/preview' },
        requestBody: { items: [{ offer_id: 'offer_1', quantity: 1 }] },
      }),
    );
    expect(args.finalizeInvokeResponseFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'preview_quote',
        upstreamData: { status: 'success', quote_id: 'quote_1' },
        responseStatus: 200,
      }),
    );
    expect(result).toEqual({
      statusCode: 200,
      body: { status: 'success', quote_id: 'quote_1' },
      headers: null,
      checkoutRuntime: { checkoutTraceId: 'trace_1', paymentStatus: 'processing' },
    });
    expect(args.logger.info).toHaveBeenCalledWith(
      {
        operation: 'preview_quote',
        method: 'POST',
        url: 'http://pivota.test/agent/v1/quote/preview',
        hasQuery: false,
      },
      'Forwarding invoke request',
    );
  });

  test('wraps invoke failures through the extracted error builder', async () => {
    const err = new Error('upstream failed');
    const args = createBaseArgs({
      prepareInvokeUpstreamRequest: jest.fn(async () => {
        throw err;
      }),
    });

    const result = await runInvokeOperationFlow(args);

    expect(args.buildInvokeErrorResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'preview_quote',
        err,
        gatewayRequestId: 'req_1',
      }),
    );
    expect(result).toEqual({
      statusCode: 502,
      body: { error: 'UPSTREAM_UNAVAILABLE' },
      headers: { 'X-Upstream-Request-Id': 'up_req_1' },
      checkoutRuntime: null,
    });
  });
});
