const {
  handleInvokeSearchExceptionFallback,
} = require('../../src/commerce/catalog/invokeSearchExceptionFallback');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    err: {
      response: { status: 504 },
      code: 'ECONNABORTED',
      message: 'upstream timed out',
    },
    metadata: { source: 'shopping_agent' },
    traceQueryClass: 'lookup',
    effectiveIntent: { scenario: { name: 'shopping' } },
    queryParams: { query: 'ipsa 流金水', limit: 10, offset: 0 },
    queryText: 'ipsa 流金水',
    resolverQueryParams: { query: 'ipsa 流金水' },
    resolverFirstResult: { usableCount: 0, resolve_reason_code: 'no_candidates' },
    auroraFallbackOverrides: {
      disableSkipAfterResolverMiss: false,
      forceSecondaryFallback: false,
      forceInvokeFallback: false,
    },
    checkoutToken: 'checkout-token',
    resolverTimeoutMs: 700,
    crossMerchantCacheProtectedResponse: null,
    extractUpstreamErrorCode: jest.fn(() => ({
      code: 'UPSTREAM_TIMEOUT',
      message: 'Request failed with status code 504',
    })),
    detectBrandEntities: jest.fn(() => ({ brand_like: false })),
    shouldSkipSecondaryFallbackAfterResolverMiss: jest.fn(() => false),
    shouldAllowResolverFallback: jest.fn(() => true),
    shouldAllowSecondaryFallback: jest.fn(() => true),
    shouldAllowInvokeFallback: jest.fn(() => true),
    shouldBypassSecondaryFallbackSkipOnPrimaryException: jest.fn(() => false),
    queryResolveSearchFallback: jest.fn(async () => null),
    queryFindProductsMultiFallback: jest.fn(async () => null),
    isProxySearchFallbackRelevant: jest.fn(() => true),
    normalizeAgentProductsListResponse: jest.fn((value) => value),
    withProxySearchFallbackMetadata: jest.fn((body, patch) => ({
      ...(body || {}),
      metadata: {
        ...((body && body.metadata) || {}),
        proxy_search_fallback: patch,
      },
    })),
    buildProxySearchSoftFallbackResponse: jest.fn((payload) => ({
      status: 'success',
      success: true,
      products: [],
      total: 0,
      metadata: payload,
    })),
    logger: { warn: jest.fn() },
    ...overrides,
  };
}

describe('invokeSearchExceptionFallback', () => {
  test('adopts resolver fallback result after upstream exception', async () => {
    const args = createBaseArgs({
      queryResolveSearchFallback: jest.fn(async () => ({
        status: 200,
        usableCount: 1,
        data: { products: [{ product_id: 'resolver-hit' }] },
      })),
    });

    const result = await handleInvokeSearchExceptionFallback(args);

    expect(result.handled).toBe(true);
    expect(args.queryResolveSearchFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'resolver_after_exception',
        timeoutMs: 700,
        checkoutToken: 'checkout-token',
      }),
    );
    expect(result.response).toEqual({
      status: 200,
      data: expect.objectContaining({
        products: [{ product_id: 'resolver-hit' }],
        metadata: expect.objectContaining({
          proxy_search_fallback: expect.objectContaining({
            route: 'invoke_exception_resolver',
          }),
        }),
      }),
    });
  });

  test('adopts invoke fallback when resolver fallback does not return usable products', async () => {
    const args = createBaseArgs({
      queryResolveSearchFallback: jest.fn(async () => ({
        status: 200,
        usableCount: 0,
        data: { products: [] },
      })),
      queryFindProductsMultiFallback: jest.fn(async () => ({
        status: 200,
        usableCount: 1,
        data: { products: [{ product_id: 'invoke-hit' }] },
      })),
    });

    const result = await handleInvokeSearchExceptionFallback(args);

    expect(args.queryFindProductsMultiFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'upstream_status_504',
        checkoutToken: 'checkout-token',
      }),
    );
    expect(result.response).toEqual({
      status: 200,
      data: expect.objectContaining({
        products: [{ product_id: 'invoke-hit' }],
        metadata: expect.objectContaining({
          proxy_search_fallback: expect.objectContaining({
            route: 'invoke_exception_fallback_invoke',
          }),
        }),
      }),
    });
  });

  test('uses protected cache response when exception fallbacks do not produce usable results', async () => {
    const args = createBaseArgs({
      shouldAllowResolverFallback: jest.fn(() => false),
      queryFindProductsMultiFallback: jest.fn(async () => null),
      crossMerchantCacheProtectedResponse: {
        products: [{ product_id: 'cache-hit' }],
        total: 1,
      },
    });

    const result = await handleInvokeSearchExceptionFallback(args);

    expect(args.normalizeAgentProductsListResponse).toHaveBeenCalledWith(
      args.crossMerchantCacheProtectedResponse,
      { limit: 10, offset: 0 },
    );
    expect(result.response).toEqual({
      status: 200,
      data: expect.objectContaining({
        products: [{ product_id: 'cache-hit' }],
        metadata: expect.objectContaining({
          proxy_search_fallback: expect.objectContaining({
            route: 'invoke_exception_cache_guard',
            applied: false,
          }),
        }),
      }),
    });
  });

  test('returns soft fallback payload when no exception fallback succeeds', async () => {
    const args = createBaseArgs({
      shouldAllowResolverFallback: jest.fn(() => false),
      shouldAllowSecondaryFallback: jest.fn(() => false),
      shouldAllowInvokeFallback: jest.fn(() => false),
    });

    const result = await handleInvokeSearchExceptionFallback(args);

    expect(args.buildProxySearchSoftFallbackResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'error_soft_fallback',
        route: 'invoke_exception',
        queryText: 'ipsa 流金水',
      }),
    );
    expect(result.response).toEqual({
      status: 200,
      data: expect.objectContaining({
        status: 'success',
        success: true,
        products: [],
        metadata: expect.objectContaining({
          reason: 'error_soft_fallback',
        }),
      }),
    });
    expect(args.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'find_products_multi',
        upstream_status: 504,
      }),
      'find_products_multi upstream failed; returning soft fallback empty payload',
    );
  });

  test('does not attempt invoke fallback for generic find_products exception soft-open', async () => {
    const args = createBaseArgs({
      operation: 'find_products',
      shouldAllowResolverFallback: jest.fn(() => true),
      shouldAllowSecondaryFallback: jest.fn(() => true),
      shouldAllowInvokeFallback: jest.fn(() => true),
    });

    const result = await handleInvokeSearchExceptionFallback(args);

    expect(args.queryResolveSearchFallback).not.toHaveBeenCalled();
    expect(args.queryFindProductsMultiFallback).not.toHaveBeenCalled();
    expect(result.response).toEqual({
      status: 200,
      data: expect.objectContaining({
        products: [],
        metadata: expect.objectContaining({
          reason: 'error_soft_fallback',
        }),
      }),
    });
  });
});
