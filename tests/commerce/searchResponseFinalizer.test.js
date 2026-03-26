const {
  finalizeInvokeSearchResponse,
  buildInvokeSearchOuterCatchResponse,
} = require('../../src/commerce/catalog/searchResponseFinalizer');

function createFinalizeArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    upstreamData: {
      products: [],
      total: 0,
      metadata: {
        query_source: 'agent_products_search',
        search_decision: {
          final_decision: 'upstream_returned',
        },
      },
    },
    responseStatus: 200,
    queryParams: {
      query: 'ipsa toner',
      limit: 10,
      offset: 0,
    },
    metadata: { source: 'shopping_agent' },
    rawUserQuery: 'ipsa toner',
    effectiveIntent: null,
    effectivePayload: {},
    policyMetadata: {},
    creatorId: null,
    hasDatabase: false,
    promotions: [],
    now: new Date('2026-03-20T00:00:00.000Z'),
    crossMerchantCacheRouteDebug: null,
    shouldAttemptResolverFirst: false,
    resolverFirstResult: null,
    invokeStartedAtMs: Date.now() - 20,
    gatewayRequestId: 'req_1',
    traceQueryClass: 'lookup',
    traceRewriteGate: null,
    traceAssociationPlan: null,
    traceFlagsSnapshot: {},
    traceAmbiguityScorePre: 0.2,
    proxyRouteFallbackStrategy: null,
    findProductsExpansionMeta: null,
    fpmGateTrace: [{ gateId: 'g1', applied: true, decision: 'pass', cost_ms_estimate: 5 }],
    fpmSkippedGatesDueToBudget: ['secondary'],
    fpmLatencyGuardApplied: false,
    searchLimitMax: 50,
    routeDebugEnabled: false,
    searchStrictEmptyEnabled: true,
    fpmClarifyNeverEmpty: false,
    searchRelevanceDebugEnabled: false,
    defaultFindProductsMultiExpansionMode: 'legacy',
    extractSearchQueryText: (queryParams) => queryParams?.query || '',
    extractSearchAnchorTokens: () => [],
    isLookupStyleSearchQuery: () => false,
    isKnownLookupAliasQuery: () => false,
    applyFindProductsMultiPolicy: ({ response }) => response,
    buildPetFallbackQuery: () => 'pet fallback',
    searchCreatorSellableFromCache: jest.fn(),
    maybeRerankFindProductsMultiResponse: jest.fn(async () => ({ applied: false })),
    applyDealsToResponse: (response) => response,
    withSearchDiagnostics: (body, diagnostics) => ({
      ...body,
      metadata: {
        ...((body && body.metadata) || {}),
        ...diagnostics,
      },
    }),
    buildSearchRouteHealth: (value) => value,
    buildSearchTrace: (value) => value,
    buildSearchRelevanceDebug: (value) => value,
    logger: {
      warn: jest.fn(),
    },
    ...overrides,
  };
}

function createOuterCatchArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    err: {
      code: 'ECONNABORTED',
      response: { status: 504 },
    },
    crossMerchantCacheProtectedResponse: {
      products: [{ merchant_id: 'm1', title: 'IPSA Toner' }],
    },
    queryParams: {
      query: 'ipsa toner',
      limit: 10,
      offset: 0,
    },
    rawUserQuery: 'ipsa toner',
    effectiveIntent: null,
    traceQueryClass: 'lookup',
    traceRewriteGate: null,
    traceAssociationPlan: null,
    traceFlagsSnapshot: {},
    traceAmbiguityScorePre: 0.1,
    gatewayRequestId: 'req_2',
    invokeStartedAtMs: Date.now() - 10,
    findProductsExpansionMeta: null,
    defaultFindProductsMultiExpansionMode: 'legacy',
    normalizeAgentProductsListResponse: (body) => body,
    withProxySearchFallbackMetadata: (body, patch) => ({
      ...body,
      metadata: {
        ...((body && body.metadata) || {}),
        proxy_search_fallback: patch,
      },
    }),
    withSearchDiagnostics: (body, diagnostics) => ({
      ...body,
      metadata: {
        ...((body && body.metadata) || {}),
        ...diagnostics,
      },
    }),
    buildSearchRouteHealth: (value) => value,
    buildSearchTrace: (value) => value,
    extractSearchQueryText: (queryParams) => queryParams?.query || '',
    extractUpstreamErrorCode: () => ({ code: 'ECONNABORTED', message: 'timeout' }),
    withStrictEmptyFallback: jest.fn(),
    logger: {
      warn: jest.fn(),
    },
    ...overrides,
  };
}

describe('finalizeInvokeSearchResponse', () => {
  test('returns input unchanged for non-search operations', async () => {
    const upstreamData = { ok: true };
    const result = await finalizeInvokeSearchResponse(
      createFinalizeArgs({
        operation: 'submit_payment',
        upstreamData,
      }),
    );

    expect(result).toBe(upstreamData);
  });

  test('adds strict-empty diagnostics and gate summary for empty search results', async () => {
    const result = await finalizeInvokeSearchResponse(createFinalizeArgs());

    expect(result.metadata?.strict_empty).toBe(true);
    expect(result.metadata?.strict_empty_reason).toBe('no_candidates');
    expect(result.metadata?.search_trace?.finalDecision).toBe('strict_empty');
    expect(result.metadata?.gate_summary).toMatchObject({
      applied_count: 1,
      blocked_count: 0,
    });
    expect(result.metadata?.skipped_gates_due_to_budget).toEqual(['secondary']);
  });
});

describe('buildInvokeSearchOuterCatchResponse', () => {
  test('returns cache-guard response when protected cache data exists', () => {
    const result = buildInvokeSearchOuterCatchResponse(createOuterCatchArgs());

    expect(result).toMatchObject({
      handled: true,
      statusCode: 200,
      body: {
        products: [{ merchant_id: 'm1', title: 'IPSA Toner' }],
        metadata: {
          proxy_search_fallback: {
            reason: 'invoke_outer_cache_guard',
          },
          route_health: {
            primaryPathUsed: 'invoke_outer_cache_guard',
          },
          search_trace: {
            finalDecision: 'cache_returned',
          },
        },
      },
    });
  });
});
