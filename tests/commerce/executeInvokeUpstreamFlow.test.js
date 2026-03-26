const {
  executeInvokeUpstreamFlow,
} = require('../../src/commerce/executeInvokeUpstreamFlow');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    route: { method: 'GET', path: '/agent/v1/products/search', paramType: 'query' },
    url: 'http://pivota.test/agent/v1/products/search',
    queryParams: { query: 'ipsa toner' },
    requestBody: {},
    metadata: { source: 'shopping_agent' },
    rawUserQuery: '',
    traceQueryClass: 'lookup',
    checkoutToken: 'checkout-token',
    effectiveIntent: null,
    isProxySearchRoute: false,
    auroraFallbackOverrides: { active: false },
    crossMerchantCacheProtectedResponse: null,
    productDetailCacheKey: null,
    productDetailMerchantId: null,
    productDetailProductId: null,
    productDetailBypassCache: false,
    hasDatabase: true,
    fpmLatencyGuardApplied: false,
    fpmSkippedGatesDueToBudget: [],
    buildQueryString: jest.fn(() => '?query=ipsa%20toner'),
    buildInvokeUpstreamAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer token' })),
    getUpstreamTimeoutMs: jest.fn(() => 5000),
    extractSearchQueryText: jest.fn((query) => String(query?.query || '').trim()),
    extractSearchAnchorTokens: jest.fn(() => []),
    isLookupStyleSearchQuery: jest.fn(() => true),
    callUpstreamWithOptionalRetry: jest.fn(),
    checkoutTimingOps: new Set(['create_order', 'submit_payment', 'confirm_payment']),
    onGatewayRetry: jest.fn(),
    onUpstreamElapsed: jest.fn(),
    getFpmRemainingBudgetMs: jest.fn(() => 1500),
    addFpmGateTrace: jest.fn(),
    queryResolveSearchFallback: jest.fn(),
    shouldUseResolverFirstSearch: jest.fn(() => true),
    shouldReducePrimaryTimeoutAfterResolverMiss: jest.fn(() => false),
    detectBrandEntities: jest.fn(() => ({ brand_like: false })),
    proxySearchAuroraResolverTimeoutMs: 900,
    proxySearchResolverTimeoutMs: 700,
    proxySearchResolverFirstOnSearchRouteEnabled: false,
    fpmGateSimplifyV1: true,
    fpmLatencyGuardResolverMinRemainingMs: 300,
    proxySearchPrimaryTimeoutAfterResolverMissMs: 1800,
    pivotaApiBase: 'http://pivota.test',
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
    queryFindProductsMultiFallback: jest.fn(),
    isProxySearchFallbackRelevant: jest.fn(() => true),
    normalizeAgentProductsListResponse: jest.fn((data) => data),
    withProxySearchFallbackMetadata: jest.fn((data) => data),
    buildProxySearchSoftFallbackResponse: jest.fn(),
    findProductsMultiUpstreamLookupTimeoutMs: 3200,
    findProductsMultiUpstreamDefaultTimeoutMs: 6500,
    buildInvokeAxiosConfig: jest.fn(() => ({
      method: 'GET',
      url: 'http://pivota.test/agent/v1/products/search?query=ipsa%20toner',
      timeout: 5000,
      headers: {},
    })),
    createTrackedUpstreamCaller: jest.fn(() => jest.fn()),
    runInvokeSearchPrelude: jest.fn(async () => ({
      searchQueryText: 'ipsa toner',
      resolverQueryText: '',
      resolverQueryParams: { query: 'ipsa toner' },
      resolverTimeoutMs: 700,
      resolverFirstResult: null,
      shouldAttemptResolverFirst: false,
      response: null,
      nextTimeoutMs: 5000,
      fpmLatencyGuardApplied: false,
      fpmSkippedGatesDueToBudget: [],
    })),
    maybeLoadInvokeProductDetailResponse: jest.fn(async () => ({ handled: false })),
    recoverCheckoutUpstreamError: jest.fn(async ({ err }) => ({ response: null, err })),
    handleInvokeSearchExceptionFallback: jest.fn(async () => ({ handled: false })),
    logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

describe('executeInvokeUpstreamFlow', () => {
  test('uses resolver/search prelude response without calling upstream', async () => {
    const callTrackedUpstream = jest.fn();
    const args = createBaseArgs({
      createTrackedUpstreamCaller: jest.fn(() => callTrackedUpstream),
      runInvokeSearchPrelude: jest.fn(async () => ({
        searchQueryText: 'ipsa toner',
        resolverQueryText: 'ipsa toner',
        resolverQueryParams: { query: 'ipsa toner' },
        resolverTimeoutMs: 700,
        resolverFirstResult: { usableCount: 1 },
        shouldAttemptResolverFirst: true,
        response: { status: 200, data: { products: [{ product_id: 'p_1' }] } },
        nextTimeoutMs: 4300,
        fpmLatencyGuardApplied: true,
        fpmSkippedGatesDueToBudget: ['resolver_first'],
      })),
    });

    const result = await executeInvokeUpstreamFlow(args);

    expect(callTrackedUpstream).not.toHaveBeenCalled();
    expect(result.response).toEqual({
      status: 200,
      data: { products: [{ product_id: 'p_1' }] },
    });
    expect(result.axiosConfig.timeout).toBe(4300);
    expect(result.shouldAttemptResolverFirst).toBe(true);
    expect(result.fpmSkippedGatesDueToBudget).toEqual(['resolver_first']);
  });

  test('loads upstream response and stamps product detail upstream cache metadata', async () => {
    const callTrackedUpstream = jest.fn(async () => ({
      status: 200,
      data: { product_id: 'prod_1' },
    }));
    const args = createBaseArgs({
      operation: 'get_product_detail',
      createTrackedUpstreamCaller: jest.fn(() => callTrackedUpstream),
    });

    const result = await executeInvokeUpstreamFlow(args);

    expect(callTrackedUpstream).toHaveBeenCalledWith(
      'get_product_detail',
      expect.objectContaining({
        url: 'http://pivota.test/agent/v1/products/search?query=ipsa%20toner',
      }),
    );
    expect(result.response).toEqual({ status: 200, data: { product_id: 'prod_1' } });
    expect(result.productDetailCacheMeta).toEqual({ hit: false, source: 'upstream' });
  });

  test('uses search exception fallback when upstream call and checkout recovery do not produce a response', async () => {
    const upstreamErr = new Error('upstream timeout');
    upstreamErr.code = 'ECONNABORTED';
    const callTrackedUpstream = jest.fn(async () => {
      throw upstreamErr;
    });
    const handleInvokeSearchExceptionFallback = jest.fn(async () => ({
      handled: true,
      response: { status: 200, data: { products: [] } },
    }));
    const args = createBaseArgs({
      createTrackedUpstreamCaller: jest.fn(() => callTrackedUpstream),
      recoverCheckoutUpstreamError: jest.fn(async ({ err }) => ({ response: null, err })),
      handleInvokeSearchExceptionFallback,
    });

    const result = await executeInvokeUpstreamFlow(args);

    expect(handleInvokeSearchExceptionFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'find_products_multi',
        err: upstreamErr,
        queryText: 'ipsa toner',
      }),
    );
    expect(result.response).toEqual({ status: 200, data: { products: [] } });
  });
});
