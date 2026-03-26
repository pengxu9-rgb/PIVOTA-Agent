const {
  handleMockProductDetailOperation,
} = require('../../src/commerce/catalog/mockProductDetail');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'get_product_detail',
    payload: {
      product: {
        merchant_id: 'merchant_1',
        product_id: 'prod_1',
      },
    },
    metadata: { source: 'mock_client' },
    defaultMerchantId: 'merchant_1',
    serviceGitSha: 'abcdef1234567890',
    getProductById: () => ({
      merchant_id: 'merchant_1',
      product_id: 'prod_1',
      title: 'Mock Product',
      price: 42,
      currency: 'USD',
      in_stock: true,
    }),
    buildProductGroupId: ({ merchant_id, product_id, platform, platform_product_id }) =>
      platform && platform_product_id
        ? `pg:${platform}:${platform_product_id}`
        : `pg:${merchant_id}:${product_id}`,
    buildOfferId: ({ merchant_id, product_group_id, tier }) =>
      `of:${merchant_id}:${product_group_id}:${tier}`,
    getPdpOptions: () => ({
      includeRecommendations: true,
      entryPoint: 'detail',
      experiment: 'exp_a',
      templateHint: 'compact',
      includeEmptyReviews: false,
      debug: true,
    }),
    shouldIncludePdp: () => true,
    recommendPdpProducts: jest.fn(async () => ({
      items: [{ merchant_id: 'merchant_2', product_id: 'prod_2' }],
    })),
    buildPdpPayload: ({ product, relatedProducts }) => ({
      hero: product.product_id,
      related_count: relatedProducts.length,
      modules: [],
    }),
    ...overrides,
  };
}

describe('handleMockProductDetailOperation', () => {
  test('returns product-not-found response for unknown get_product_detail product', async () => {
    const result = await handleMockProductDetailOperation(
      createBaseArgs({
        getProductById: () => null,
      }),
    );

    expect(result).toEqual({
      handled: true,
      statusCode: 404,
      body: {
        error: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      },
    });
  });

  test('builds mock get_product_detail response with offers and pdp payload', async () => {
    const result = await handleMockProductDetailOperation(createBaseArgs());

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      product_group_id: 'pg:merchant_1:prod_1',
      offers_count: 1,
      default_offer_id: 'of:merchant_1:pg:merchant_1:prod_1:single',
      best_price_offer_id: 'of:merchant_1:pg:merchant_1:prod_1:single',
      pdp_payload: {
        hero: 'prod_1',
        related_count: 1,
      },
    });
  });

  test('builds mock get_pdp_v2 modules and missing metadata', async () => {
    const result = await handleMockProductDetailOperation(
      createBaseArgs({
        operation: 'get_pdp_v2',
        payload: {
          product: {
            merchant_id: 'merchant_1',
            product_id: 'prod_1',
          },
          include: ['offers', 'reviews_preview', 'similar'],
        },
        buildPdpPayload: ({ product }) => ({
          hero: product.product_id,
          modules: [
            { type: 'reviews_preview', data: { rating: 4.6 } },
            { type: 'recommendations', data: null },
          ],
        }),
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      pdp_version: '2.0',
      subject: { type: 'product', id: 'prod_1' },
      modules: [
        {
          type: 'canonical',
          data: {
            pdp_payload: expect.objectContaining({ hero: 'prod_1' }),
          },
        },
        {
          type: 'offers',
        },
        {
          type: 'reviews_preview',
          data: { rating: 4.6 },
        },
        {
          type: 'similar',
          data: null,
          reason: 'unavailable',
        },
      ],
      missing: [{ type: 'similar', reason: 'unavailable' }],
      metadata: {
        detail_source: 'mock',
        module_degrade: {
          applied: true,
        },
      },
    });
  });

  test('builds mock resolve_product_candidates response through extracted helper', async () => {
    const result = await handleMockProductDetailOperation(
      createBaseArgs({
        operation: 'resolve_product_candidates',
        payload: {
          product_ref: {
            merchant_id: 'merchant_1',
            product_id: 'prod_1',
          },
          options: {
            debug: true,
          },
        },
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      success: true,
      product_group_id: 'pg:merchant_1:prod_1',
      offers_count: 1,
      default_offer_id: 'of:merchant_1:pg:merchant_1:prod_1:single',
      best_price_offer_id: 'of:merchant_1:pg:merchant_1:prod_1:single',
      cache: {
        hit: false,
      },
    });
    expect(Array.isArray(result.body.offers)).toBe(true);
  });
});
