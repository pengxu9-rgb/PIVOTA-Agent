const { handleGetPdpV2Operation } = require('../../src/commerce/pdp/getPdpV2');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product: {
        merchant_id: 'm1',
        product_id: 'p1',
      },
      include: ['offers', 'reviews_preview', 'similar'],
    },
    metadata: { source: 'unit_test_client' },
    checkoutToken: 'checkout-token',
    gatewayRequestId: 'req_pdp_1',
    defaultMerchantId: 'default_mid',
    serviceGitSha: 'abcdef1234567890',
    parseOfferId: () => null,
    extractMerchantIdFromOfferId: () => null,
    fetchVariantDetailFromUpstream: jest.fn(),
    normalizeAgentProductDetailResponse: (value) => value,
    fetchProductGroupMembersFromUpstream: jest.fn(),
    fetchProductDetailForOffers: jest.fn(async () => ({
      merchant_id: 'm1',
      product_id: 'p1',
      title: 'PDP Product',
      currency: 'USD',
      price: 42,
      platform: 'shopify',
      platform_product_id: 'gid://shopify/Product/1',
    })),
    resolveProductGroupCached: jest.fn(async () => ({
      product_group_id: 'pg:m1:p1',
      members: [{ merchant_id: 'm1', product_id: 'p1', is_primary: true }],
      canonical_product_ref: { merchant_id: 'm1', product_id: 'p1' },
    })),
    getPdpOptions: () => ({
      entryPoint: 'detail',
      experiment: 'exp_a',
      templateHint: 'compact',
      includeEmptyReviews: false,
      debug: false,
    }),
    fetchReviewSummaryCached: jest.fn(async () => ({ rating_average: 4.8 })),
    fetchSimilarProductsDeduped: jest.fn(async () => [{ merchant_id: 'm2', product_id: 'p2' }]),
    buildPdpPayload: ({ product, relatedProducts }) => ({
      hero: product.product_id,
      related_count: relatedProducts.length,
      modules: [
        { type: 'reviews_preview', data: { rating_average: 4.8 } },
        { type: 'recommendations', data: { count: relatedProducts.length } },
      ],
    }),
    buildProductGroupId: ({ merchant_id, product_id, platform, platform_product_id }) =>
      platform && platform_product_id
        ? `pg:${platform}:${platform_product_id}`
        : `pg:${merchant_id}:${product_id}`,
    buildOffersFromGroupMembers: jest.fn(async () => ({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      offers_count: 1,
      offers: [{ offer_id: 'offer_1', merchant_id: 'm1', product_id: 'p1' }],
      default_offer_id: 'offer_1',
      best_price_offer_id: 'offer_1',
    })),
    buildOfferId: jest.fn(() => 'offer_fallback'),
    normalizeOfferMoney: (amount, currency) => ({
      amount: Number(amount) || 0,
      currency: currency || 'USD',
    }),
    getProductDetailSource: () => 'fresh_cache',
    extractUpstreamErrorCode: () => ({
      code: 'GET_PDP_V2_FAILED',
      message: 'failed',
      data: null,
    }),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    ...overrides,
  };
}

describe('handleGetPdpV2Operation', () => {
  test('returns handled=false for non get_pdp_v2 operations', async () => {
    const result = await handleGetPdpV2Operation(
      createBaseArgs({
        operation: 'get_pdp',
      }),
    );

    expect(result).toEqual({ handled: false });
  });

  test('returns missing-parameter error when no product reference is provided', async () => {
    const result = await handleGetPdpV2Operation(
      createBaseArgs({
        payload: {},
      }),
    );

    expect(result).toEqual({
      handled: true,
      statusCode: 400,
      body: {
        error: 'MISSING_PARAMETERS',
        message:
          'product_ref.product_id (or product_ref.variant_id + merchant_id, or product_ref.offer_id, or subject=product_group) is required for get_pdp_v2',
      },
    });
  });

  test('returns assembled pdp v2 response for canonical happy path', async () => {
    const result = await handleGetPdpV2Operation(createBaseArgs());

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      pdp_version: '2.0',
      request_id: 'req_pdp_1',
      subject: {
        type: 'product_group',
        id: 'pg:m1:p1',
        canonical_product_ref: {
          merchant_id: 'm1',
          product_id: 'p1',
        },
      },
      modules: [
        {
          type: 'canonical',
          data: {
            product_group_id: 'pg:m1:p1',
            canonical_product_ref: {
              merchant_id: 'm1',
              product_id: 'p1',
            },
            pdp_payload: {
              hero: 'p1',
              related_count: 1,
            },
          },
        },
        {
          type: 'offers',
          data: {
            offers_count: 1,
          },
        },
        {
          type: 'reviews_preview',
          data: {
            rating_average: 4.8,
          },
        },
        {
          type: 'similar',
          data: {
            count: 1,
          },
        },
      ],
      missing: [],
      metadata: {
        detail_source: 'fresh_cache',
        module_degrade: {
          applied: false,
        },
      },
    });
  });
});
