const {
  applyInvokeSearchPostUpstreamFlow,
} = require('../../src/commerce/catalog/postUpstreamFallback');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    upstreamData: {
      products: [{ merchant_id: 'm1', title: 'Generic Product' }],
      total: 1,
      metadata: { query_source: 'agent_products_search' },
    },
    responseStatus: 200,
    payload: {},
    queryParams: {
      query: 'ipsa',
      limit: 10,
      offset: 0,
    },
    metadata: { source: 'shopping_agent' },
    rawUserQuery: 'ipsa',
    effectiveIntent: null,
    traceQueryClass: null,
    checkoutToken: null,
    resolverFirstResult: null,
    resolverTimeoutMs: 500,
    shouldAttemptResolverFirst: false,
    isProxySearchRoute: false,
    proxyRouteFallbackStrategy: null,
    auroraFallbackOverrides: {
      active: false,
      strategySource: 'default',
      disableSkipAfterResolverMiss: false,
      forceSecondaryFallback: false,
      forceInvokeFallback: false,
    },
    auroraExternalSeedEnabled: false,
    auroraExternalSeedStrategy: null,
    auroraUpstreamBase: null,
    fpmLatencyGuardApplied: false,
    fpmSkippedGatesDueToBudget: [],
    addFpmGateTrace: jest.fn(),
    getFpmRemainingBudgetMs: () => 5000,
    searchLimitMax: 50,
    findProductsMultiSecondStageExpansionMode: 'off',
    fpmGateSimplifyV1: false,
    fpmLatencyGuardSecondStageMinRemainingMs: 0,
    searchExternalHardRulePrune: false,
    detectBrandEntities: () => ({ brand_like: false }),
    extractSearchQueryText: (queryParams) => queryParams?.query || '',
    extractSearchAnchorTokens: () => [],
    isLookupStyleSearchQuery: () => false,
    normalizeAgentProductsListResponse: (value) => value,
    countUsableSearchProducts: (products) => (Array.isArray(products) ? products.length : 0),
    shouldFallbackProxySearch: () => false,
    isProxySearchFallbackRelevant: () => true,
    evaluateCacheQualityGate: () => ({ enabled: false, accepted: true }),
    computePrimaryQualityScore: () => 1,
    isExternalSeedProduct: () => false,
    detectAuroraExternalSeedMonoculture: () => ({ detected: false }),
    hasFragranceQuerySignal: () => false,
    getSecondaryFallbackSkipReason: () => null,
    shouldAllowResolverFallback: () => false,
    shouldAllowSecondaryFallback: () => false,
    shouldAllowInvokeFallback: () => false,
    buildFindProductsMultiContext: jest.fn(),
    axios: jest.fn(),
    url: 'http://pivota.test/agent/v1/products/search',
    buildQueryString: () => '',
    axiosConfig: { headers: {}, timeout: 1000 },
    buildSearchProductKey: (product) => `${product?.merchant_id || ''}:${product?.title || ''}`,
    isSupplementCandidateRelevant: () => true,
    queryResolveSearchFallback: jest.fn(),
    queryFindProductsMultiFallback: jest.fn(),
    getFallbackAdoptUsableThreshold: () => 1,
    buildProxySearchSoftFallbackResponse: jest.fn((args) => ({
      products: [],
      total: 0,
      metadata: {
        query_source: args?.querySource || 'agent_products_error_fallback',
        proxy_search_fallback: {
          applied: true,
          reason: args?.reason || null,
        },
      },
    })),
    withProxySearchFallbackMetadata: jest.fn((body, patch) => ({
      ...(body || {}),
      metadata: {
        ...((body && body.metadata) || {}),
        proxy_search_fallback: patch,
      },
    })),
    normalizeAgentSource: (source) => String(source || '').trim().toLowerCase() || null,
    logger: {
      warn: jest.fn(),
    },
    ...overrides,
  };
}

describe('applyInvokeSearchPostUpstreamFlow', () => {
  test('returns input unchanged for non-search operations', async () => {
    const upstreamData = { ok: true };
    const result = await applyInvokeSearchPostUpstreamFlow(
      createBaseArgs({
        operation: 'submit_payment',
        upstreamData,
      }),
    );

    expect(result).toEqual({
      upstreamData,
      proxyRouteFallbackStrategy: null,
      fpmLatencyGuardApplied: false,
      fpmSkippedGatesDueToBudget: [],
    });
  });

  test('converts irrelevant primary search into soft fallback response', async () => {
    const result = await applyInvokeSearchPostUpstreamFlow(
      createBaseArgs({
        isProxySearchFallbackRelevant: () => false,
      }),
    );

    expect(result.upstreamData).toMatchObject({
      products: [],
      metadata: {
        query_source: 'agent_products_error_fallback',
        proxy_search_fallback: {
          reason: 'primary_irrelevant_no_fallback',
        },
        guard_source_normalized: 'shopping_agent',
        low_quality_nonempty_detected: false,
      },
    });
  });

  test('records explicit second-stage skip when expansion does not change the query', async () => {
    const args = createBaseArgs({
      countUsableSearchProducts: () => 1,
      findProductsMultiSecondStageExpansionMode: 'aggressive',
      buildFindProductsMultiContext: jest.fn(async () => ({
        adjustedPayload: {
          search: {
            query: 'ipsa',
          },
        },
      })),
    });

    const result = await applyInvokeSearchPostUpstreamFlow(args);

    expect(result.upstreamData.metadata.search_stage_b).toMatchObject({
      attempted: true,
      applied: false,
      reason: 'second_stage_query_unchanged',
    });
    expect(args.addFpmGateTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gateId: 'second_stage_expansion_result',
        reason: 'second_stage_query_unchanged',
      }),
    );
  });

  test('does not attempt invoke fallback for generic find_products after weak primary result', async () => {
    const args = createBaseArgs({
      operation: 'find_products',
      shouldFallbackProxySearch: () => true,
      countUsableSearchProducts: () => 0,
      shouldAllowSecondaryFallback: () => true,
      shouldAllowInvokeFallback: () => true,
    });

    await applyInvokeSearchPostUpstreamFlow(args);

    expect(args.queryFindProductsMultiFallback).not.toHaveBeenCalled();
  });
});
