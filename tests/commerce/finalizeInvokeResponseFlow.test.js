const {
  attachInvokeRouteDebugMetadata,
  finalizeInvokeResponseFlow,
} = require('../../src/commerce/finalizeInvokeResponseFlow');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    upstreamData: { products: [{ product_id: 'p_1' }], metadata: {} },
    responseStatus: 200,
    payload: { search: { query: 'ipsa toner' } },
    queryParams: { query: 'ipsa toner', limit: 10, offset: 0 },
    metadata: { source: 'shopping_agent' },
    rawUserQuery: 'ipsa toner',
    effectiveIntent: null,
    traceQueryClass: 'lookup',
    checkoutToken: 'checkout-token',
    resolverFirstResult: null,
    resolverTimeoutMs: 700,
    shouldAttemptResolverFirst: false,
    isProxySearchRoute: false,
    proxyRouteFallbackStrategy: null,
    auroraFallbackOverrides: { active: false },
    auroraExternalSeedEnabled: false,
    auroraExternalSeedStrategy: 'supplement_internal_first',
    auroraUpstreamBase: 'http://pivota.test',
    fpmLatencyGuardApplied: false,
    fpmSkippedGatesDueToBudget: [],
    addFpmGateTrace: jest.fn(),
    getFpmRemainingBudgetMs: jest.fn(() => 1500),
    searchLimitMax: 50,
    findProductsMultiSecondStageExpansionMode: 'conservative',
    fpmGateSimplifyV1: true,
    fpmLatencyGuardSecondStageMinRemainingMs: 300,
    searchExternalHardRulePrune: true,
    detectBrandEntities: jest.fn(() => ({ brand_like: false })),
    extractSearchQueryText: jest.fn((query) => String(query?.query || '').trim()),
    extractSearchAnchorTokens: jest.fn(() => []),
    isLookupStyleSearchQuery: jest.fn(() => true),
    normalizeAgentProductsListResponse: jest.fn((data) => ({
      ...data,
      normalized: true,
    })),
    countUsableSearchProducts: jest.fn(() => 1),
    shouldFallbackProxySearch: jest.fn(() => false),
    isProxySearchFallbackRelevant: jest.fn(() => true),
    evaluateCacheQualityGate: jest.fn(() => ({ enabled: true, accepted: true })),
    computePrimaryQualityScore: jest.fn(() => 1),
    isExternalSeedProduct: jest.fn(() => false),
    detectAuroraExternalSeedMonoculture: jest.fn(() => ({ detected: false })),
    hasFragranceQuerySignal: jest.fn(() => false),
    getSecondaryFallbackSkipReason: jest.fn(() => null),
    shouldAllowResolverFallback: jest.fn(() => true),
    shouldAllowSecondaryFallback: jest.fn(() => true),
    shouldAllowInvokeFallback: jest.fn(() => true),
    buildFindProductsMultiContext: jest.fn(() => ({})),
    axios: {},
    url: 'http://pivota.test/agent/v1/products/search',
    buildQueryString: jest.fn(() => '?query=ipsa%20toner'),
    axiosConfig: { method: 'GET', url: 'http://pivota.test/agent/v1/products/search', timeout: 5000 },
    buildSearchProductKey: jest.fn(() => 'key_1'),
    isSupplementCandidateRelevant: jest.fn(() => true),
    queryResolveSearchFallback: jest.fn(),
    queryFindProductsMultiFallback: jest.fn(),
    getFallbackAdoptUsableThreshold: jest.fn(() => 1),
    buildProxySearchSoftFallbackResponse: jest.fn(),
    withProxySearchFallbackMetadata: jest.fn((data) => data),
    normalizeAgentSource: jest.fn((source) => source),
    requestBody: {},
    resolvedOfferId: null,
    resolvedMerchantId: null,
    gatewayRequestId: 'req_1',
    productDetailCacheKey: null,
    productDetailCacheMeta: null,
    productDetailDebug: false,
    productDetailBypassCache: false,
    normalizeAgentProductDetailResponse: jest.fn((data) => data),
    effectivePayload: { search: { query: 'ipsa toner' } },
    policyMetadata: {},
    creatorId: 'creator_1',
    hasDatabase: true,
    now: new Date('2026-03-22T00:00:00.000Z'),
    creatorCacheRouteDebug: { stage: 'creator_cache' },
    crossMerchantCacheRouteDebug: { stage: 'cross_cache' },
    invokeStartedAtMs: 100,
    traceRewriteGate: 'none',
    traceAssociationPlan: null,
    traceFlagsSnapshot: {},
    traceAmbiguityScorePre: 0,
    findProductsExpansionMeta: {},
    fpmGateTrace: [],
    routeDebugEnabled: true,
    searchStrictEmptyEnabled: true,
    fpmClarifyNeverEmpty: false,
    searchRelevanceDebugEnabled: false,
    defaultFindProductsMultiExpansionMode: 'conservative',
    isKnownLookupAliasQuery: jest.fn(() => false),
    applyFindProductsMultiPolicy: jest.fn(({ response }) => response),
    buildPetFallbackQuery: jest.fn(() => null),
    searchCreatorSellableFromCache: jest.fn(),
    maybeRerankFindProductsMultiResponse: jest.fn(async (response) => response),
    withSearchDiagnostics: jest.fn((response) => response),
    buildSearchRouteHealth: jest.fn(() => ({})),
    buildSearchTrace: jest.fn(() => ({})),
    buildSearchRelevanceDebug: jest.fn(() => ({})),
    applyInvokeSearchPostUpstreamFlow: jest.fn(async ({ upstreamData }) => ({
      upstreamData: { ...upstreamData, postProcessed: true },
      proxyRouteFallbackStrategy: 'primary',
      fpmLatencyGuardApplied: true,
      fpmSkippedGatesDueToBudget: ['second_stage'],
    })),
    finalizeInvokeSuccessResponse: jest.fn(async ({ upstreamData }) => ({
      body: { status: 'success', upstreamData },
      upstreamData,
      checkoutRuntime: { paymentStatus: 'processing' },
    })),
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('finalizeInvokeResponseFlow', () => {
  test('attaches route debug metadata only for cross-merchant search', () => {
    const result = attachInvokeRouteDebugMetadata({
      operation: 'find_products_multi',
      upstreamData: { metadata: {} },
      routeDebugEnabled: true,
      creatorCacheRouteDebug: { hit: true },
      crossMerchantCacheRouteDebug: { hit: false },
    });

    expect(result.metadata.route_debug).toEqual({
      creator_cache: { hit: true },
      cross_merchant_cache: { hit: false },
    });
  });

  test('normalizes search data, runs post-upstream flow, and finalizes success response', async () => {
    const args = createBaseArgs();

    const result = await finalizeInvokeResponseFlow(args);

    expect(args.normalizeAgentProductsListResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          route_debug: expect.objectContaining({
            creator_cache: { stage: 'creator_cache' },
            cross_merchant_cache: { stage: 'cross_cache' },
          }),
        }),
      }),
      { limit: 10, offset: 0 },
    );
    expect(args.applyInvokeSearchPostUpstreamFlow).toHaveBeenCalled();
    expect(args.finalizeInvokeSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamData: expect.objectContaining({
          postProcessed: true,
        }),
        proxyRouteFallbackStrategy: 'primary',
      }),
    );
    expect(result.checkoutRuntime).toEqual({ paymentStatus: 'processing' });
    expect(result.fpmSkippedGatesDueToBudget).toEqual(['second_stage']);
  });

  test('skips search-only flow for non-search operations', async () => {
    const args = createBaseArgs({
      operation: 'preview_quote',
      applyInvokeSearchPostUpstreamFlow: jest.fn(),
    });

    await finalizeInvokeResponseFlow(args);

    expect(args.normalizeAgentProductsListResponse).not.toHaveBeenCalled();
    expect(args.applyInvokeSearchPostUpstreamFlow).not.toHaveBeenCalled();
    expect(args.finalizeInvokeSuccessResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamData: args.upstreamData,
      }),
    );
  });
});
