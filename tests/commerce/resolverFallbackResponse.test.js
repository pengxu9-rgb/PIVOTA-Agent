const {
  buildResolverReferenceOnlyResult,
  finalizeResolveSearchFallbackResult,
} = require('../../src/commerce/catalog/resolverFallbackResponse');

function createBaseArgs(overrides = {}) {
  return {
    queryText: 'IPSA Time Reset Aqua',
    resolved: {
      resolved: true,
      reason: 'stable_alias_ref',
      reason_code: 'stable_alias_match',
      confidence: 1,
      candidates: [{ title: 'IPSA Time Reset Aqua' }],
      metadata: {
        latency_ms: 12,
        sources: [{ source: 'stable_alias_ref', ok: true, count: 1 }],
      },
    },
    resolvedQueryUsed: 'ipsa',
    resolvedMerchantId: 'merchant_1',
    resolvedProductId: 'product_1',
    resolveSources: [{ source: 'stable_alias_ref', ok: true, count: 1 }],
    reason: 'resolver_after_primary',
    resolverCacheKey: 'resolver-cache-key',
    resolverMissCacheTtlMs: 5000,
    resolverCacheTtlMs: 15000,
    fetchDetail: true,
    resolverDetailEnabled: true,
    resolverDetailTimeoutMs: 1200,
    checkoutToken: 'checkout-token',
    setProxySearchResolverCacheEntry: jest.fn(),
    isLookupStyleSearchQuery: jest.fn(() => false),
    extractSearchAnchorTokens: jest.fn(() => []),
    normalizeAgentProductsListResponse: jest.fn((value) => value),
    countUsableSearchProducts: jest.fn((products) => (Array.isArray(products) ? products.length : 0)),
    withProxySearchFallbackMetadata: jest.fn((body, patch) => ({
      ...(body || {}),
      metadata: {
        ...((body && body.metadata) || {}),
        proxy_search_fallback: patch,
      },
    })),
    fetchProductDetailFromProductsCache: jest.fn(async () => null),
    fetchProductDetailFromUpstream: jest.fn(async () => null),
    productDetailStaleMaxAgeHours: 720,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    ...overrides,
  };
}

describe('buildResolverReferenceOnlyResult', () => {
  test('builds a reference-only normalized search result', () => {
    const result = buildResolverReferenceOnlyResult({
      ...createBaseArgs(),
      normalizeAgentProductsListResponse: (value) => value,
      countUsableSearchProducts: (products) => (Array.isArray(products) ? products.length : 0),
      withProxySearchFallbackMetadata: (body, patch) => ({
        ...(body || {}),
        metadata: {
          ...((body && body.metadata) || {}),
          proxy_search_fallback: patch,
        },
      }),
    });

    expect(result).toMatchObject({
      status: 200,
      usableCount: 1,
      resolved: true,
      resolve_reason_code: 'stable_alias_match',
      data: {
        products: [
          {
            product_id: 'product_1',
            merchant_id: 'merchant_1',
            canonical_product_ref: {
              merchant_id: 'merchant_1',
              product_id: 'product_1',
            },
          },
        ],
        metadata: {
          query_source: 'agent_products_resolver_ref_fallback',
          resolve_detail_source: 'reference_only',
          proxy_search_fallback: {
            applied: true,
            reason: 'resolver_after_primary',
          },
        },
      },
    });
  });
});

describe('finalizeResolveSearchFallbackResult', () => {
  test('hydrates resolver fallback from products cache and caches the success envelope', async () => {
    const args = createBaseArgs({
      fetchProductDetailFromProductsCache: jest.fn(async () => ({
        product: {
          merchant_id: 'merchant_1',
          product_id: 'product_1',
          title: 'IPSA Time Reset Aqua',
          price: 45,
        },
        stale_fallback_used: false,
      })),
    });

    const result = await finalizeResolveSearchFallbackResult(args);

    expect(args.fetchProductDetailFromProductsCache).toHaveBeenCalledWith({
      merchantId: 'merchant_1',
      productId: 'product_1',
      includeExpired: true,
      staleMaxAgeHours: 720,
    });
    expect(args.fetchProductDetailFromUpstream).not.toHaveBeenCalled();
    expect(args.setProxySearchResolverCacheEntry).toHaveBeenCalledWith(
      'resolver-cache-key',
      expect.objectContaining({
        status: 200,
        usableCount: 1,
        resolved: true,
      }),
      15000,
    );
    expect(result).toMatchObject({
      status: 200,
      usableCount: 1,
      data: {
        metadata: {
          query_source: 'agent_products_resolver_fallback',
          resolve_detail_source: 'products_cache',
        },
      },
    });
  });

  test('returns reference-only result for lookup queries when detail cannot be hydrated', async () => {
    const args = createBaseArgs({
      isLookupStyleSearchQuery: jest.fn(() => true),
    });

    const result = await finalizeResolveSearchFallbackResult(args);

    expect(args.fetchProductDetailFromUpstream).toHaveBeenCalledWith({
      merchantId: 'merchant_1',
      productId: 'product_1',
      checkoutToken: 'checkout-token',
      timeoutMs: 1200,
      noRetry: true,
    });
    expect(args.setProxySearchResolverCacheEntry).toHaveBeenCalledWith(
      'resolver-cache-key',
      expect.objectContaining({
        status: 200,
        usableCount: 1,
        resolved: true,
      }),
      5000,
    );
    expect(result).toMatchObject({
      status: 200,
      usableCount: 1,
      data: {
        metadata: {
          query_source: 'agent_products_resolver_ref_fallback',
          resolve_detail_source: 'reference_only',
        },
      },
    });
    expect(args.logger.info).toHaveBeenCalled();
  });
});
