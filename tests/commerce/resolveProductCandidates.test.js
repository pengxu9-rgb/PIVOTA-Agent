const {
  handleResolveProductCandidatesOperation,
} = require('../../src/commerce/pdp/resolveProductCandidates');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'resolve_product_candidates',
    payload: {
      product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
      },
      options: {},
    },
    checkoutToken: 'checkout-token',
    pivotaApiBase: 'http://upstream.test',
    resolveCatalogSyncMerchantIds: jest.fn(async () => ({ merchantIds: [] })),
    buildQueryString: (params) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params || {})) {
        if (Array.isArray(value)) {
          value.forEach((item) => search.append(key, String(item)));
        } else if (value !== undefined && value !== null) {
          search.set(key, String(value));
        }
      }
      const query = search.toString();
      return query ? `?${query}` : '';
    },
    buildInvokeUpstreamAuthHeaders: jest.fn(() => ({})),
    getUpstreamTimeoutMs: jest.fn(() => 1200),
    callUpstreamWithOptionalRetry: jest.fn(async () => ({
      data: {
        products: [
          {
            merchant_id: 'm1',
            product_id: 'p1',
            platform: 'shopify',
            platform_product_id: 'gid://shopify/Product/1',
            price: 12.5,
            currency: 'USD',
            in_stock: true,
          },
        ],
      },
    })),
    normalizeAgentProductsListResponse: jest.fn((value) => value),
    resolveProductGroupCached: jest.fn(async () => null),
    fetchProductDetailForOffers: jest.fn(async () => null),
    buildOffersFromGroupMembers: jest.fn(async () => null),
    buildProductGroupId: jest.fn(({ merchant_id, product_id, platform, platform_product_id }) =>
      platform && platform_product_id
        ? `pg:${platform}:${platform_product_id}`
        : `pg:${merchant_id}:${product_id}`,
    ),
    buildOfferId: jest.fn(
      ({ merchant_id, product_group_id, fulfillment_type, tier }) =>
        `of:v1:${merchant_id}:${product_group_id}:${fulfillment_type}:${tier}`,
    ),
    normalizeOfferMoney: jest.fn((amount, currency) => ({
      amount: Number(amount) || 0,
      currency: currency || 'USD',
    })),
    getResolveProductCandidatesCacheEntry: jest.fn(() => null),
    setResolveProductCandidatesCache: jest.fn(),
    resolveProductCandidatesCacheEnabled: true,
    resolveProductCandidatesCacheMetrics: { bypasses: 0 },
    resolveProductCandidatesTtlMs: 60000,
    extractUpstreamErrorCode: jest.fn(() => ({
      code: 'RESOLVE_PRODUCT_CANDIDATES_FAILED',
      message: 'failed',
      data: null,
    })),
    logger: {
      info: jest.fn(),
      error: jest.fn(),
    },
    nodeEnv: 'test',
    ...overrides,
  };
}

describe('handleResolveProductCandidatesOperation', () => {
  test('returns handled=false for non resolve_product_candidates operations', async () => {
    const result = await handleResolveProductCandidatesOperation(
      createBaseArgs({
        operation: 'get_pdp',
      }),
    );

    expect(result).toEqual({ handled: false });
  });

  test('returns missing-parameter error when product_id is absent', async () => {
    const result = await handleResolveProductCandidatesOperation(
      createBaseArgs({
        payload: {},
      }),
    );

    expect(result).toEqual({
      handled: true,
      statusCode: 400,
      body: {
        error: 'MISSING_PARAMETERS',
        message: 'product_ref.product_id is required',
      },
    });
  });

  test('returns cached response with debug cache metadata', async () => {
    const cachedValue = {
      status: 'success',
      offers_count: 2,
      default_offer_id: 'offer_1',
    };
    const result = await handleResolveProductCandidatesOperation(
      createBaseArgs({
        payload: {
          product_ref: {
            merchant_id: 'm1',
            product_id: 'p1',
          },
          options: {
            debug: true,
          },
        },
        getResolveProductCandidatesCacheEntry: jest.fn(() => ({
          value: cachedValue,
          storedAtMs: Date.now() - 250,
        })),
        nodeEnv: 'production',
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      offers_count: 2,
      cache: {
        hit: true,
        ttl_ms: 60000,
      },
    });
  });

  test('uses search path for requested merchant and builds fallback offers', async () => {
    const resolveProductGroupCached = jest.fn(async () => null);
    const callUpstreamWithOptionalRetry = jest.fn(async () => ({
      data: {
        products: [
          {
            merchant_id: 'm1',
            product_id: 'p1',
            platform: 'shopify',
            platform_product_id: 'gid://shopify/Product/1',
            price: 12.5,
            currency: 'USD',
            in_stock: true,
          },
        ],
      },
    }));

    const result = await handleResolveProductCandidatesOperation(
      createBaseArgs({
        resolveProductGroupCached,
        callUpstreamWithOptionalRetry,
      }),
    );

    expect(callUpstreamWithOptionalRetry).toHaveBeenCalledWith(
      'find_products_multi',
      expect.objectContaining({
        method: 'GET',
        url: expect.stringContaining('/agent/v1/products/search'),
      }),
    );
    expect(resolveProductGroupCached).toHaveBeenCalledWith({
      productId: 'p1',
      merchantId: 'm1',
      platform: 'shopify',
      checkoutToken: 'checkout-token',
      bypassCache: false,
      debug: false,
    });
    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        product_group_id: 'pg:shopify:gid://shopify/Product/1',
        canonical_product_ref: null,
        offers_count: 1,
        offers: [
          expect.objectContaining({
            merchant_id: 'm1',
            product_id: 'p1',
          }),
        ],
        default_offer_id:
          'of:v1:m1:pg:shopify:gid://shopify/Product/1:merchant:default',
        best_price_offer_id:
          'of:v1:m1:pg:shopify:gid://shopify/Product/1:merchant:default',
      },
    });
  });

  test('skips search when product group resolution already provides group members', async () => {
    const callUpstreamWithOptionalRetry = jest.fn();
    const buildOffersFromGroupMembers = jest.fn(async () => ({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      canonical_product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
      },
      offers_count: 1,
      offers: [{ offer_id: 'offer_1', merchant_id: 'm1', product_id: 'p1' }],
      default_offer_id: 'offer_1',
      best_price_offer_id: 'offer_1',
    }));
    const setResolveProductCandidatesCache = jest.fn();

    const result = await handleResolveProductCandidatesOperation(
      createBaseArgs({
        payload: {
          product_ref: {
            product_id: 'p1',
          },
          options: {
            debug: true,
          },
        },
        callUpstreamWithOptionalRetry,
        resolveProductGroupCached: jest.fn(async () => ({
          product_group_id: 'pg:m1:p1',
          members: [{ merchant_id: 'm1', product_id: 'p1', is_primary: true }],
        })),
        buildOffersFromGroupMembers,
        setResolveProductCandidatesCache,
      }),
    );

    expect(callUpstreamWithOptionalRetry).not.toHaveBeenCalled();
    expect(buildOffersFromGroupMembers).toHaveBeenCalledWith({
      productGroupId: 'pg:m1:p1',
      members: [{ merchant_id: 'm1', product_id: 'p1', is_primary: true }],
      checkoutToken: 'checkout-token',
      limit: 10,
      preferredMerchantId: 'm1',
    });
    expect(setResolveProductCandidatesCache).toHaveBeenCalled();
    expect(result.body).toMatchObject({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      offers_count: 1,
      cache: {
        hit: false,
        ttl_ms: 60000,
      },
    });
  });
});
