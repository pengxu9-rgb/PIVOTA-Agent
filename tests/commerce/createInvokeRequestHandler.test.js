const {
  createInvokeRequestHandler,
} = require('../../src/commerce/createInvokeRequestHandler');

function createResponse() {
  return {
    setHeader: jest.fn(),
    status: jest.fn(function status(code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn(function json(body) {
      this.body = body;
      return body;
    }),
  };
}

function createBaseConfig(overrides = {}) {
  return {
    createRequestId: jest.fn(() => 'req_1'),
    nowMs: jest.fn(() => 1000),
    configureInvokeResponseShell: jest.fn(),
    initializeInvokeRequestContext: jest.fn(async () => ({
      handled: false,
      operation: 'preview_quote',
      payload: { items: [] },
      metadata: { source: 'shopping_agent' },
      creatorId: 'creator_1',
      now: new Date('2026-03-22T00:00:00.000Z'),
      effectivePayload: { items: [] },
      effectiveIntent: null,
      findProductsExpansionMeta: null,
      rawUserQuery: '',
      policyMetadata: {},
      traceQueryClass: null,
      traceRewriteGate: null,
      traceAssociationPlan: null,
      traceFlagsSnapshot: {},
      traceAmbiguityScorePre: null,
      fpmGateTrace: [],
      addFpmGateTrace: jest.fn(),
      getFpmRemainingBudgetMs: jest.fn(() => 1200),
      debugRuntimePatch: {
        intent: 'quote',
      },
    })),
    prepareInvokeExecutionMode: jest.fn(() => ({
      handled: false,
      statusCode: null,
      body: null,
      headers: null,
      checkoutToken: 'checkout_1',
      shouldUseMock: false,
    })),
    runInvokeOperationFlow: jest.fn(async () => ({
      statusCode: 200,
      body: { status: 'success' },
      headers: null,
      checkoutRuntime: null,
    })),
    sendInvokeOperationResponse: jest.fn(() => 'sent_result'),
    handleUnhandledInvokeRequestError: jest.fn(() => 'error_result'),
    invokeRequestSchema: { safeParse: jest.fn() },
    operationEnum: { options: [] },
    creatorConfigs: [],
    isCreatorUiSource: jest.fn(() => false),
    buildFindProductsMultiContext: jest.fn(),
    defaultFindProductsMultiExpansionMode: 'conservative',
    searchCacheValidate: true,
    searchForceControlledRecallForScenario: false,
    searchCacheMinAnchor: 1,
    searchCacheMaxDomainEntropy: 0.5,
    searchCacheMinCount: 2,
    searchCacheMaxCrossDomainRatio: 0.25,
    searchUpstreamQuotaClarifyEnabled: true,
    searchUpstreamQuotaClarifyQueryClasses: ['browse'],
    fpmGatewayTotalBudgetMs: 2500,
    apiMode: 'REAL',
    useMock: false,
    useHybrid: false,
    applyGatewayGuardrails: jest.fn(),
    defaultMerchantId: 'merchant_default',
    serviceGitSha: 'sha_1',
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
    findProductsMultiExpansionMode: 'conservative',
    findProductsMultiSecondStageExpansionMode: 'aggressive',
    searchLimitMax: 20,
    proxySearchCreatorScopeToConfig: true,
    pivotaApiBase: 'http://pivota.test',
    buildQueryString: jest.fn(),
    buildInvokeUpstreamAuthHeaders: jest.fn(),
    getUpstreamTimeoutMs: jest.fn(),
    extractSearchQueryText: jest.fn(),
    extractSearchAnchorTokens: jest.fn(),
    isLookupStyleSearchQuery: jest.fn(),
    callUpstreamWithOptionalRetry: jest.fn(),
    checkoutTimingOps: new Set(['preview_quote', 'create_order', 'submit_payment']),
    shouldUseResolverFirstSearch: jest.fn(),
    shouldReducePrimaryTimeoutAfterResolverMiss: jest.fn(),
    fpmGateSimplifyV1: true,
    fpmLatencyGuardResolverMinRemainingMs: 300,
    fpmLatencyGuardSecondStageMinRemainingMs: 300,
    proxySearchPrimaryTimeoutAfterResolverMissMs: 1800,
    checkoutRetryBaseMs: 100,
    extractUpstreamErrorCode: jest.fn(),
    isRetryableQuoteError: jest.fn(),
    isPydanticMissingBodyField: jest.fn(),
    sleep: jest.fn(),
    randomFn: jest.fn(() => 0),
    shouldSkipSecondaryFallbackAfterResolverMiss: jest.fn(),
    shouldAllowResolverFallback: jest.fn(),
    shouldAllowSecondaryFallback: jest.fn(),
    shouldAllowInvokeFallback: jest.fn(),
    shouldBypassSecondaryFallbackSkipOnPrimaryException: jest.fn(),
    findProductsMultiUpstreamLookupTimeoutMs: 3200,
    findProductsMultiUpstreamDefaultTimeoutMs: 6500,
    auroraAllowExternalSeed: false,
    auroraExternalSeedStrategy: 'supplement_internal_first',
    countUsableSearchProducts: jest.fn(),
    shouldFallbackProxySearch: jest.fn(),
    computePrimaryQualityScore: jest.fn(),
    detectAuroraExternalSeedMonoculture: jest.fn(),
    hasFragranceQuerySignal: jest.fn(),
    getSecondaryFallbackSkipReason: jest.fn(),
    axios: {},
    getFallbackAdoptUsableThreshold: jest.fn(),
    normalizeAgentSource: jest.fn(),
    normalizeAgentProductsListResponse: jest.fn(),
    normalizeAgentProductDetailResponse: jest.fn(),
    withProxySearchFallbackMetadata: jest.fn(),
    buildProxySearchSoftFallbackResponse: jest.fn(),
    withSearchDiagnostics: jest.fn(),
    buildSearchRouteHealth: jest.fn(),
    buildSearchTrace: jest.fn(),
    buildSearchRelevanceDebug: jest.fn(),
    withStrictEmptyFallback: jest.fn(),
    searchStrictEmptyEnabled: true,
    fpmClarifyNeverEmpty: false,
    searchRelevanceDebugEnabled: false,
    buildPetFallbackQuery: jest.fn(),
    maybeRerankFindProductsMultiResponse: jest.fn(),
    detectBrandEntities: jest.fn(),
    loadCreatorSellableFromCache: jest.fn(),
    searchCreatorSellableFromCache: jest.fn(),
    probeCreatorCacheDbStats: jest.fn(),
    loadCrossMerchantBrowseFromCache: jest.fn(),
    uniqueStrings: jest.fn(),
    withStageBudget: jest.fn(),
    searchCrossMerchantFromCache: jest.fn(),
    normalizeSearchTextForMatch: jest.fn(),
    tokenizeSearchTextForMatch: jest.fn(),
    isSupplementCandidateRelevant: jest.fn(),
    hasPetLeashSearchSignal: jest.fn(),
    hasStrictPetHarnessCatalogSignal: jest.fn(),
    buildFallbackCandidateText: jest.fn(),
    hasPetHarnessSearchSignal: jest.fn(),
    hasFragranceSearchSignal: jest.fn(),
    isCatalogGuardSource: jest.fn(),
    isBeautyGeneralDiversitySupplementCandidate: jest.fn(),
    fetchExternalSeedSupplementFromBackend: jest.fn(),
    firstQueryParamValue: jest.fn(),
    buildSearchProductKey: jest.fn(),
    isExternalSeedProduct: jest.fn(),
    blendBeautyDiversitySupplement: jest.fn(),
    resolveSearchDedupePerTitleLimit: jest.fn(),
    collapseNearDuplicateSearchProducts: jest.fn(),
    isProxySearchFallbackRelevant: jest.fn(),
    hasPetSearchSignal: jest.fn(),
    hasBeautyMakeupSearchSignal: jest.fn(),
    hasBeautyCatalogProductSignal: jest.fn(),
    isShoppingSource: jest.fn(),
    normalizeExternalSeedStrategy: jest.fn(),
    isUnifiedLikeExternalSeedStrategy: jest.fn(),
    evaluateCacheQualityGate: jest.fn(),
    isKnownLookupAliasQuery: jest.fn(),
    queryResolveSearchFallback: jest.fn(),
    queryFindProductsMultiFallback: jest.fn(),
    isAuroraSource: jest.fn(),
    loadMerchantBrowseFromCache: jest.fn(),
    applyShoppingCatalogQueryGuards: jest.fn(),
    getCreatorConfig: jest.fn(),
    findSimilarCreatorFromCache: jest.fn(),
    getProxySearchApiBase: jest.fn(),
    getAuroraFallbackOverrides: jest.fn(),
    applyFindProductsMultiPolicy: jest.fn(),
    handleOffersResolveOperation: jest.fn(),
    inferOffersResolveFailureReasonCode: jest.fn(),
    buildOffersResolvePdpTargetExternal: jest.fn(),
    buildOffersResolveResponse: jest.fn(),
    resolveProductGroupCached: jest.fn(),
    resolveCatalogSyncMerchantIds: jest.fn(),
    getResolveProductCandidatesCacheEntry: jest.fn(),
    setResolveProductCandidatesCache: jest.fn(),
    resolveProductCandidatesCacheEnabled: true,
    resolveProductCandidatesCacheMetrics: {},
    resolveProductCandidatesTtlMs: 60000,
    nodeEnv: 'test',
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('createInvokeRequestHandler', () => {
  test('returns validation-handled responses before execution mode or invoke flow', async () => {
    const res = createResponse();
    const config = createBaseConfig({
      initializeInvokeRequestContext: jest.fn(async () => ({
        handled: true,
        statusCode: 400,
        body: { error: 'INVALID_REQUEST' },
      })),
    });

    const handler = createInvokeRequestHandler(config);
    const result = await handler({ body: {} }, res, { client_channel: 'shop' });

    expect(config.configureInvokeResponseShell).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'INVALID_REQUEST' });
    expect(config.prepareInvokeExecutionMode).not.toHaveBeenCalled();
    expect(config.runInvokeOperationFlow).not.toHaveBeenCalled();
    expect(result).toEqual({ error: 'INVALID_REQUEST' });
  });

  test('returns execution-mode handled response and applies headers', async () => {
    const res = createResponse();
    const config = createBaseConfig({
      prepareInvokeExecutionMode: jest.fn(() => ({
        handled: true,
        statusCode: 429,
        body: { error: 'RATE_LIMITED' },
        headers: { 'Retry-After': '5' },
      })),
    });

    const handler = createInvokeRequestHandler(config);
    const result = await handler({ body: { operation: 'preview_quote' } }, res, {
      client_channel: 'shop',
    });

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'RATE_LIMITED' });
    expect(config.runInvokeOperationFlow).not.toHaveBeenCalled();
    expect(result).toEqual({ error: 'RATE_LIMITED' });
  });

  test('delegates successful invokes to runInvokeOperationFlow and sendInvokeOperationResponse', async () => {
    const res = createResponse();
    const config = createBaseConfig();
    const handler = createInvokeRequestHandler(config);

    const result = await handler(
      {
        body: { operation: 'preview_quote', payload: { items: [] } },
        invokeAuth: { key_fingerprint: 'fp_1' },
      },
      res,
      { client_channel: 'creator', proxy_search_route: true },
    );

    expect(config.createRequestId).toHaveBeenCalled();
    expect(config.nowMs).toHaveBeenCalled();
    expect(config.configureInvokeResponseShell).toHaveBeenCalledWith(
      expect.objectContaining({
        clientChannel: 'creator',
        routeKeyFingerprint: 'fp_1',
      }),
    );
    expect(config.runInvokeOperationFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'preview_quote',
        shouldUseMock: false,
        checkoutToken: 'checkout_1',
        isProxySearchRoute: true,
        defaultMerchantId: 'merchant_default',
        pdpV2Args: expect.objectContaining({
          checkoutToken: 'checkout_1',
          gatewayRequestId: 'req_1',
        }),
      }),
    );
    expect(config.sendInvokeOperationResponse).toHaveBeenCalledWith({
      res,
      invokeResult: {
        statusCode: 200,
        body: { status: 'success' },
        headers: null,
        checkoutRuntime: null,
      },
      checkoutRuntime: expect.objectContaining({
        checkoutTraceId: null,
        paymentStatus: null,
      }),
    });
    expect(result).toBe('sent_result');
  });

  test('delegates unhandled exceptions to the invoke error handler', async () => {
    const res = createResponse();
    const boom = new Error('boom');
    const config = createBaseConfig({
      runInvokeOperationFlow: jest.fn(async () => {
        throw boom;
      }),
    });
    const handler = createInvokeRequestHandler(config);

    const result = await handler({ body: { operation: 'preview_quote' } }, res, {
      client_channel: 'shop',
    });

    expect(config.handleUnhandledInvokeRequestError).toHaveBeenCalledWith({
      err: boom,
      res,
      gatewayRequestId: 'req_1',
      logger: config.logger,
    });
    expect(result).toBe('error_result');
  });
});
