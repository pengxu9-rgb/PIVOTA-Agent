const {
  runInvokeSearchPrelude,
} = require('../../src/commerce/catalog/invokeSearchPrelude');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    metadata: { source: 'shopping_agent' },
    queryParams: { query: 'ipsa 流金水' },
    rawUserQuery: '',
    checkoutToken: 'checkout-token',
    traceQueryClass: 'lookup',
    isProxySearchRoute: false,
    auroraFallbackOverrides: { active: false },
    currentTimeoutMs: 5000,
    fpmLatencyGuardApplied: false,
    fpmSkippedGatesDueToBudget: [],
    getFpmRemainingBudgetMs: jest.fn(() => 1200),
    addFpmGateTrace: jest.fn(),
    queryResolveSearchFallback: jest.fn(),
    shouldUseResolverFirstSearch: jest.fn(() => true),
    shouldReducePrimaryTimeoutAfterResolverMiss: jest.fn(() => false),
    detectBrandEntities: jest.fn(() => ({ brand_like: false })),
    extractSearchQueryText: jest.fn((query) => String(query?.query || '').trim()),
    logger: { warn: jest.fn() },
    proxySearchAuroraResolverTimeoutMs: 900,
    proxySearchResolverTimeoutMs: 700,
    proxySearchResolverFirstOnSearchRouteEnabled: false,
    fpmGateSimplifyV1: true,
    fpmLatencyGuardResolverMinRemainingMs: 300,
    proxySearchPrimaryTimeoutAfterResolverMissMs: 1800,
    ...overrides,
  };
}

describe('invokeSearchPrelude', () => {
  test('adopts resolver-first result when it returns usable products', async () => {
    const args = createBaseArgs({
      queryResolveSearchFallback: jest.fn(async () => ({
        status: 200,
        usableCount: 2,
        data: { products: [{ product_id: 'p1' }] },
      })),
    });

    const result = await runInvokeSearchPrelude(args);

    expect(args.queryResolveSearchFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        queryParams: { query: 'ipsa 流金水' },
        checkoutToken: 'checkout-token',
        reason: 'resolver_first',
        requestSource: 'shopping_agent',
        timeoutMs: 700,
      }),
    );
    expect(result.response).toEqual({
      status: 200,
      data: { products: [{ product_id: 'p1' }] },
    });
    expect(result.shouldAttemptResolverFirst).toBe(true);
    expect(result.nextTimeoutMs).toBe(5000);
  });

  test('applies budget guard and skips resolver-first when remaining budget is too low', async () => {
    const args = createBaseArgs({
      getFpmRemainingBudgetMs: jest.fn(() => 150),
    });

    const result = await runInvokeSearchPrelude(args);

    expect(result.shouldAttemptResolverFirst).toBe(false);
    expect(result.fpmLatencyGuardApplied).toBe(true);
    expect(result.fpmSkippedGatesDueToBudget).toContain('resolver_first');
    expect(args.queryResolveSearchFallback).not.toHaveBeenCalled();
    expect(args.addFpmGateTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        gateId: 'resolver_first',
        decision: 'skipped',
        reason: 'budget_guard',
      }),
    );
  });

  test('reduces primary timeout after resolver miss for find_products_multi', async () => {
    const args = createBaseArgs({
      queryResolveSearchFallback: jest.fn(async () => ({
        status: 200,
        usableCount: 0,
        data: { products: [] },
      })),
      shouldReducePrimaryTimeoutAfterResolverMiss: jest.fn(() => true),
    });

    const result = await runInvokeSearchPrelude(args);

    expect(result.response).toBeNull();
    expect(result.resolverFirstResult).toMatchObject({ usableCount: 0 });
    expect(result.nextTimeoutMs).toBe(1800);
  });
});
