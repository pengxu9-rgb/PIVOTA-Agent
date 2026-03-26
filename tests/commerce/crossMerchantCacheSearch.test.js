const {
  maybeHandleFindProductsMultiCrossMerchantCacheSearch,
} = require('../../src/commerce/catalog/crossMerchantCacheSearch');

function createBaseOptions(overrides = {}) {
  return {
    metadata: { source: 'shopping_agent' },
    payload: {},
    effectivePayload: {
      search: {
        query: 'ipsa',
        page: 1,
        limit: 1,
        in_stock_only: true,
      },
    },
    effectiveIntent: null,
    policyMetadata: {},
    rawUserQuery: 'ipsa',
    findProductsExpansionMeta: null,
    traceQueryClass: null,
    traceRewriteGate: null,
    traceAssociationPlan: null,
    traceFlagsSnapshot: {},
    traceAmbiguityScorePre: null,
    gatewayRequestId: 'req_1',
    invokeStartedAtMs: Date.now(),
    now: new Date('2026-03-20T00:00:00.000Z'),
    creatorId: null,
    checkoutToken: null,
    hasDatabase: true,
    routeDebugEnabled: false,
    findProductsMultiCacheStageBudgetMs: 500,
    searchExternalHardRulePrune: false,
    searchExternalFillGated: false,
    proxySearchCacheMissResolverFallbackEnabled: true,
    proxySearchAuroraResolverTimeoutMs: 500,
    proxySearchResolverTimeoutMs: 500,
    proxySearchAuroraBypassCacheStrictEmpty: false,
    searchForceControlledRecallForScenario: false,
    findProductsMultiExpansionMode: 'legacy',
    addFpmGateTrace: jest.fn(),
    detectBrandEntities: () => ({ brand_like: false, brands: [] }),
    isCreatorUiSource: () => false,
    withStageBudget: (promise) => promise,
    searchCrossMerchantFromCache: async () => ({
      products: [{ merchant_id: 'm1', title: 'IPSA Toner' }],
      total: 1,
      page: 1,
      retrieval_sources: ['lexical'],
    }),
    extractSearchAnchorTokens: () => [],
    isLookupStyleSearchQuery: () => false,
    normalizeSearchTextForMatch: (text) => text,
    tokenizeSearchTextForMatch: () => [],
    isSupplementCandidateRelevant: () => true,
    hasPetLeashSearchSignal: () => false,
    hasStrictPetHarnessCatalogSignal: () => false,
    buildFallbackCandidateText: (product) => String(product?.title || ''),
    hasPetHarnessSearchSignal: () => false,
    hasFragranceSearchSignal: () => false,
    isCatalogGuardSource: () => false,
    isBeautyGeneralDiversitySupplementCandidate: () => false,
    fetchExternalSeedSupplementFromBackend: jest.fn(),
    firstQueryParamValue: () => null,
    buildSearchProductKey: (product) => `${product?.merchant_id || ''}:${product?.title || ''}`,
    isExternalSeedProduct: () => false,
    blendBeautyDiversitySupplement: (internalProducts) => internalProducts,
    resolveSearchDedupePerTitleLimit: () => 1,
    collapseNearDuplicateSearchProducts: (products) => products,
    isProxySearchFallbackRelevant: () => true,
    hasPetSearchSignal: () => false,
    hasBeautyMakeupSearchSignal: () => false,
    hasBeautyCatalogProductSignal: () => false,
    isShoppingSource: () => false,
    normalizeExternalSeedStrategy: (strategy) => strategy,
    isUnifiedLikeExternalSeedStrategy: () => false,
    uniqueStrings: (values) => Array.from(new Set(values.filter(Boolean))),
    evaluateCacheQualityGate: () => ({ enabled: false, accepted: true }),
    getActivePromotions: async () => [],
    applyDealsToResponse: (response) => response,
    applyFindProductsMultiPolicy: ({ response }) => response,
    withSearchDiagnostics: (body, diagnostics) => ({ ...body, __diagnostics: diagnostics }),
    buildSearchRouteHealth: (value) => value,
    buildSearchTrace: (value) => value,
    isKnownLookupAliasQuery: () => false,
    queryResolveSearchFallback: jest.fn(),
    isAuroraSource: () => false,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    ...overrides,
  };
}

describe('maybeHandleFindProductsMultiCrossMerchantCacheSearch', () => {
  test('skips handling when merchant scope is explicitly present', async () => {
    const result = await maybeHandleFindProductsMultiCrossMerchantCacheSearch(
      createBaseOptions({
        effectivePayload: {
          search: {
            query: 'ipsa',
            merchant_id: 'merchant_1',
          },
        },
      }),
    );

    expect(result).toEqual({
      handled: false,
      crossMerchantCacheRouteDebug: null,
      crossMerchantCacheProtectedResponse: null,
    });
  });

  test('returns diagnosed cache hit response and protected response when cache search succeeds', async () => {
    const result = await maybeHandleFindProductsMultiCrossMerchantCacheSearch(
      createBaseOptions(),
    );

    expect(result.handled).toBe(true);
    expect(result.body).toMatchObject({
      products: [{ merchant_id: 'm1', title: 'IPSA Toner' }],
      metadata: {
        query_source: 'cache_cross_merchant_search',
      },
      __diagnostics: {
        route_health: {
          primaryPathUsed: 'cache_stage',
        },
        search_trace: {
          finalDecision: 'cache_returned',
        },
      },
    });
    expect(result.crossMerchantCacheProtectedResponse).toMatchObject({
      products: [{ merchant_id: 'm1', title: 'IPSA Toner' }],
    });
    expect(result.crossMerchantCacheRouteDebug).toMatchObject({
      attempted: true,
      mode: 'search',
      cache_hit: true,
      products_count: 1,
    });
  });
});
