const {
  createProxySearchRuntime,
} = require('../../src/commerce/bootstrapProxySearchRuntime');

describe('bootstrapProxySearchRuntime', () => {
  test('composes guard, dedupe, fallback, and proxy handler owners', () => {
    const searchGuards = {
      normalizeAgentSource: jest.fn(),
      isShoppingSource: jest.fn(),
      isCreatorUiSource: jest.fn(),
      isCatalogGuardSource: jest.fn(),
      isResolverFirstCatalogSource: jest.fn(),
      isAuroraSource: jest.fn(),
      getProxySearchApiBase: jest.fn(),
      getAuroraFallbackOverrides: jest.fn(),
      applyShoppingCatalogQueryGuards: jest.fn(),
    };
    const searchDedupe = {
      buildSearchProductKey: jest.fn(),
      collapseNearDuplicateSearchProducts: jest.fn(),
      resolveSearchDedupePerTitleLimit: jest.fn(),
    };
    const fallbackHelpers = {
      fetchExternalSeedSupplementFromBackend: jest.fn(),
      queryFindProductsMultiFallback: jest.fn(),
    };
    const proxyHandler = jest.fn();

    const factories = {
      createSearchGuardHelpers: jest.fn(() => searchGuards),
      createSearchDedupeHelpers: jest.fn(() => searchDedupe),
      buildResolverQueryCandidates: jest.fn(() => ['candidate']),
      queryResolveSearchFallback: jest.fn(async (args) => args),
      createProxySearchFallbackHelpers: jest.fn(() => fallbackHelpers),
      createProxyAgentSearchToBackend: jest.fn(() => proxyHandler),
    };

    const helpers = {
      firstQueryParamValue: jest.fn(),
      normalizeResolverText: jest.fn(),
      tokenizeResolverQuery: jest.fn(),
      normalizeSearchTextForMatch: jest.fn(),
      sanitizeSearchQueryForRelevance: jest.fn(),
      extractSearchAnchorTokens: jest.fn(),
      extractSearchQueryText: jest.fn(),
      parseQueryStringArray: jest.fn(),
      uniqueStrings: jest.fn(),
      parseQueryBoolean: jest.fn(),
      resolveStableAliasByQuery: jest.fn(),
      resolveProductRef: jest.fn(),
      normalizeAgentProductsListResponse: jest.fn(),
      countUsableSearchProducts: jest.fn(),
      withProxySearchFallbackMetadata: jest.fn(),
      detectBrandEntities: jest.fn(),
      hasExplicitCategoryHint: jest.fn(),
      buildBrandQueryVariants: jest.fn(),
      buildInvokeUpstreamAuthHeaders: jest.fn(),
      getUpstreamTimeoutMs: jest.fn(),
      isExternalSeedProduct: jest.fn(),
      isSupplementCandidateRelevant: jest.fn(),
      buildFindProductsMultiPayloadFromQuery: jest.fn(),
      buildFragranceSemanticRetryQuery: jest.fn(),
      parseQueryNumber: jest.fn(),
      isProxySearchFallbackRelevant: jest.fn(),
      createRequestId: jest.fn(),
      isLookupStyleSearchQuery: jest.fn(),
      isStrongResolverFirstQuery: jest.fn(),
      withSearchDiagnostics: jest.fn(),
      buildSearchRouteHealth: jest.fn(),
      buildSearchTrace: jest.fn(),
      shouldReducePrimaryTimeoutAfterResolverMiss: jest.fn(),
      getSecondaryFallbackSkipReason: jest.fn(),
      shouldAllowSecondaryFallback: jest.fn(),
      shouldAllowResolverFallback: jest.fn(),
      computePrimaryQualityScore: jest.fn(),
      recordAuroraCompPass2Invoked: jest.fn(),
      recordAuroraCompPass2Timeout: jest.fn(),
      hasFragranceQuerySignal: jest.fn(),
      buildProxySearchSoftFallbackResponse: jest.fn(),
      withStrictEmptyFallback: jest.fn(),
      extractUpstreamErrorCode: jest.fn(),
      buildProxySearchResolverCacheKey: jest.fn(),
      getProxySearchResolverCacheEntry: jest.fn(),
      setProxySearchResolverCacheEntry: jest.fn(),
      tokenizeSearchTextForMatch: jest.fn(),
      normalizeSearchQueryParams: jest.fn(),
      normalizeExternalSeedStrategy: jest.fn(),
      evaluateCacheQualityGate: jest.fn(),
    };

    const runtime = createProxySearchRuntime({
      axiosClient: {},
      logger: { warn: jest.fn() },
      config: {
        PIVOTA_API_BASE: 'http://pivota.test',
        PIVOTA_API_KEY: 'key',
        PROXY_SEARCH_AURORA_API_BASE: 'http://aurora.test',
      },
      helpers,
      factories,
    });

    expect(factories.createSearchGuardHelpers).toHaveBeenCalledWith(
      expect.objectContaining({
        pivotaApiBase: 'http://pivota.test',
        proxySearchAuroraApiBase: 'http://aurora.test',
      }),
    );
    expect(factories.createSearchDedupeHelpers).toHaveBeenCalledWith({
      normalizeSearchTextForMatch: helpers.normalizeSearchTextForMatch,
    });
    expect(factories.createProxySearchFallbackHelpers).toHaveBeenCalledWith(
      expect.objectContaining({
        helpers: expect.objectContaining({
          getProxySearchApiBase: searchGuards.getProxySearchApiBase,
          buildSearchProductKey: searchDedupe.buildSearchProductKey,
          isAuroraSource: searchGuards.isAuroraSource,
        }),
      }),
    );
    expect(factories.createProxyAgentSearchToBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        helpers: expect.objectContaining({
          getProxySearchApiBase: searchGuards.getProxySearchApiBase,
          getAuroraFallbackOverrides: searchGuards.getAuroraFallbackOverrides,
          applyShoppingCatalogQueryGuards:
            searchGuards.applyShoppingCatalogQueryGuards,
          queryFindProductsMultiFallback:
            fallbackHelpers.queryFindProductsMultiFallback,
          buildSearchProductKey: searchDedupe.buildSearchProductKey,
          collapseNearDuplicateSearchProducts:
            searchDedupe.collapseNearDuplicateSearchProducts,
        }),
      }),
    );
    expect(runtime.proxyAgentSearchToBackend).toBe(proxyHandler);
    expect(runtime.queryFindProductsMultiFallback).toBe(
      fallbackHelpers.queryFindProductsMultiFallback,
    );
  });

  test('injects resolver runtime defaults into queryResolveSearchFallback wrapper', async () => {
    const queryResolveSearchFallback = jest.fn(async (args) => args);
    const runtime = createProxySearchRuntime({
      axiosClient: {},
      logger: { warn: jest.fn() },
      config: {
        PIVOTA_API_KEY: 'key',
        PROXY_SEARCH_RESOLVER_TIMEOUT_MS: 900,
        PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS: 11,
        PROXY_SEARCH_RESOLVER_CACHE_TTL_MS: 22,
        PROXY_SEARCH_RESOLVER_DETAIL_ENABLED: true,
        PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS: 333,
      },
      helpers: {
        firstQueryParamValue: jest.fn(),
        normalizeResolverText: jest.fn(),
        tokenizeResolverQuery: jest.fn(),
        normalizeSearchTextForMatch: jest.fn(),
        sanitizeSearchQueryForRelevance: jest.fn(),
        extractSearchAnchorTokens: jest.fn(),
        extractSearchQueryText: jest.fn(),
        parseQueryStringArray: jest.fn(),
        uniqueStrings: jest.fn(),
        parseQueryBoolean: jest.fn(),
        resolveStableAliasByQuery: jest.fn(),
        resolveProductRef: jest.fn(),
        normalizeAgentProductsListResponse: jest.fn(),
        countUsableSearchProducts: jest.fn(),
        withProxySearchFallbackMetadata: jest.fn(),
        buildProxySearchResolverCacheKey: jest.fn(),
        getProxySearchResolverCacheEntry: jest.fn(),
        setProxySearchResolverCacheEntry: jest.fn(),
        getProxySearchApiBase: jest.fn(),
      },
      factories: {
        createSearchGuardHelpers: jest.fn(() => ({
          getProxySearchApiBase: jest.fn(() => 'http://proxy.test'),
        })),
        createSearchDedupeHelpers: jest.fn(() => ({
          buildSearchProductKey: jest.fn(),
          collapseNearDuplicateSearchProducts: jest.fn(),
          resolveSearchDedupePerTitleLimit: jest.fn(),
        })),
        buildResolverQueryCandidates: jest.fn(() => ['candidate']),
        queryResolveSearchFallback,
        createProxySearchFallbackHelpers: jest.fn(() => ({
          fetchExternalSeedSupplementFromBackend: jest.fn(),
          queryFindProductsMultiFallback: jest.fn(),
        })),
        createProxyAgentSearchToBackend: jest.fn(() => jest.fn()),
      },
    });

    const result = await runtime.queryResolveSearchFallback({ reason: 'test' });

    expect(queryResolveSearchFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'test',
        pivotaApiKey: 'key',
        proxySearchResolverTimeoutMs: 900,
        proxySearchResolverMissCacheTtlMs: 11,
        proxySearchResolverCacheTtlMs: 22,
        proxySearchResolverDetailEnabled: true,
        proxySearchResolverDetailTimeoutMs: 333,
        buildResolverQueryCandidates: runtime.buildResolverQueryCandidates,
      }),
    );
    expect(result.reason).toBe('test');
  });
});
