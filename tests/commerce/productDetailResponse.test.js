const {
  maybeLoadInvokeProductDetailResponse,
  finalizeInvokeProductDetailResponse,
} = require('../../src/commerce/catalog/productDetailResponse');

describe('maybeLoadInvokeProductDetailResponse', () => {
  test('returns memory-cached response for get_product_detail', async () => {
    const result = await maybeLoadInvokeProductDetailResponse({
      operation: 'get_product_detail',
      productDetailCacheKey: 'cache-key',
      productDetailMerchantId: 'm1',
      productDetailProductId: 'p1',
      productDetailBypassCache: false,
      productDetailCacheEnabled: true,
      productDetailCacheTtlMs: 60000,
      productDetailStaleMaxAgeHours: 24,
      hasDatabase: true,
      metrics: {},
      getProductDetailCacheEntry: () => ({
        value: { product: { merchant_id: 'm1', product_id: 'p1' } },
        storedAtMs: Date.now() - 500,
      }),
      safeCloneJson: (value) => JSON.parse(JSON.stringify(value)),
      fetchProductDetailFromProductsCache: jest.fn(),
    });

    expect(result.handled).toBe(true);
    expect(result.response).toEqual({
      status: 200,
      data: { product: { merchant_id: 'm1', product_id: 'p1' } },
    });
    expect(result.productDetailCacheMeta).toMatchObject({
      hit: true,
      source: 'memory',
      ttl_ms: 60000,
    });
  });

  test('returns db-backed response and increments db hits when memory cache misses', async () => {
    const metrics = { db_hits: 0 };
    const result = await maybeLoadInvokeProductDetailResponse({
      operation: 'get_product_detail',
      productDetailCacheKey: 'cache-key',
      productDetailMerchantId: 'm1',
      productDetailProductId: 'p1',
      productDetailBypassCache: false,
      productDetailCacheEnabled: true,
      productDetailCacheTtlMs: 60000,
      productDetailStaleMaxAgeHours: 24,
      hasDatabase: true,
      metrics,
      getProductDetailCacheEntry: () => null,
      safeCloneJson: (value) => value,
      fetchProductDetailFromProductsCache: jest.fn(async () => ({
        product: { merchant_id: 'm1', product_id: 'p1', title: 'Test Product' },
        cached_at: '2026-03-20T00:00:00.000Z',
      })),
    });

    expect(result).toEqual({
      handled: true,
      response: {
        status: 200,
        data: {
          status: 'success',
          success: true,
          product: { merchant_id: 'm1', product_id: 'p1', title: 'Test Product' },
          metadata: {
            query_source: 'products_cache',
            cached_at: '2026-03-20T00:00:00.000Z',
          },
        },
      },
      productDetailCacheMeta: {
        hit: true,
        source: 'products_cache',
        age_ms: 0,
        ttl_ms: 60000,
      },
    });
    expect(metrics.db_hits).toBe(1);
  });
});

describe('finalizeInvokeProductDetailResponse', () => {
  test('normalizes detail response, writes cache, attaches debug cache, and enriches pdp payload', async () => {
    const setProductDetailCache = jest.fn();
    const recommendPdpProducts = jest.fn(async () => ({
      items: [{ merchant_id: 'm2', product_id: 'p2' }],
    }));
    const result = await finalizeInvokeProductDetailResponse({
      operation: 'get_product_detail',
      upstreamData: {
        data: {
          product: {
            merchant_id: 'm1',
            product_id: 'p1',
            currency: 'USD',
          },
        },
      },
      responseStatus: 200,
      payload: {
        include: ['pdp'],
        recommendations: { limit: 4 },
        context: { locale: 'en-US' },
        options: { debug: true },
      },
      productDetailCacheKey: 'cache-key',
      productDetailCacheMeta: {
        hit: false,
        source: 'upstream',
      },
      productDetailDebug: true,
      productDetailBypassCache: false,
      productDetailCacheEnabled: true,
      normalizeAgentProductDetailResponse: (value) => ({
        product: value?.data?.product || value?.product || null,
        metadata: { normalized: true },
      }),
      setProductDetailCache,
      shouldIncludePdp: () => true,
      getPdpOptions: () => ({
        includeRecommendations: true,
        entryPoint: 'detail',
        experiment: 'exp_a',
        templateHint: 'compact',
        includeEmptyReviews: false,
        debug: true,
      }),
      recommendPdpProducts,
      buildPdpPayload: ({ product, relatedProducts }) => ({
        product_id: product.product_id,
        related_count: relatedProducts.length,
      }),
      logger: {
        warn: jest.fn(),
      },
    });

    expect(setProductDetailCache).toHaveBeenCalledWith('cache-key', {
      product: {
        merchant_id: 'm1',
        product_id: 'p1',
        currency: 'USD',
      },
      metadata: { normalized: true },
    });
    expect(recommendPdpProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        pdp_product: expect.objectContaining({
          merchant_id: 'm1',
          product_id: 'p1',
        }),
        k: 4,
      }),
    );
    expect(result).toEqual({
      product: {
        merchant_id: 'm1',
        product_id: 'p1',
        currency: 'USD',
      },
      metadata: { normalized: true },
      cache: {
        hit: false,
        source: 'upstream',
      },
      pdp_payload: {
        product_id: 'p1',
        related_count: 1,
      },
    });
  });
});
