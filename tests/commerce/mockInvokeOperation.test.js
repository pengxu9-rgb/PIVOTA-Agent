const { handleMockInvokeOperation } = require('../../src/commerce/mock/mockInvokeOperation');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'find_products_multi',
    payload: {
      search: {
        query: 'serum',
      },
    },
    effectivePayload: {
      search: {
        query: 'serum',
      },
    },
    metadata: { source: 'mock_client' },
    defaultMerchantId: 'merchant_1',
    serviceGitSha: 'abcdef1234567890',
    getProductById: jest.fn(() => ({
      merchant_id: 'merchant_1',
      product_id: 'prod_1',
      title: 'Mock Product',
      price: 42,
      currency: 'USD',
      in_stock: true,
    })),
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
    searchProducts: jest.fn((merchantId, query) => [
      {
        merchant_id: merchantId,
        product_id: `${merchantId}_${query || 'prod'}`,
      },
    ]),
    mockProducts: {
      merchant_1: [],
      merchant_2: [],
    },
    pickSimilarProducts: jest.fn((products) => products.slice(0, 1)),
    extractMerchantIdFromOfferId: jest.fn(() => 'merchant_1'),
    buildOrderLineSnapshots: jest.fn(() => [{ line_id: 'line_1' }]),
    ...overrides,
  };
}

describe('handleMockInvokeOperation', () => {
  test('returns handled=false for unsupported operations', async () => {
    const result = await handleMockInvokeOperation(
      createBaseArgs({
        operation: 'unsupported_op',
      }),
    );

    expect(result).toEqual({ handled: false });
  });

  test('builds mock find_products_multi response', async () => {
    const result = await handleMockInvokeOperation(createBaseArgs());

    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        success: true,
        products: [
          { merchant_id: 'merchant_1', product_id: 'merchant_1_serum' },
          { merchant_id: 'merchant_2', product_id: 'merchant_2_serum' },
        ],
        results: [
          { merchant_id: 'merchant_1', product_id: 'merchant_1_serum' },
          { merchant_id: 'merchant_2', product_id: 'merchant_2_serum' },
        ],
        data: {
          products: [
            { merchant_id: 'merchant_1', product_id: 'merchant_1_serum' },
            { merchant_id: 'merchant_2', product_id: 'merchant_2_serum' },
          ],
        },
        total: 2,
        count: 2,
        page: 1,
        page_size: 2,
        metadata: {
          query_source: 'mock_multi',
          merchants_searched: 2,
        },
      },
    });
  });

  test('builds mock create_order response with order lines', async () => {
    const result = await handleMockInvokeOperation(
      createBaseArgs({
        operation: 'create_order',
        payload: {
          order: {
            offer_id: 'of:test',
            items: [{ unit_price: 5, quantity: 2 }],
          },
        },
      }),
    );

    expect(result.handled).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      order_status: 'pending',
      resolved_offer_id: 'of:test',
      resolved_merchant_id: 'merchant_1',
      total: 10,
      order_lines: [{ line_id: 'line_1' }],
    });
  });

  test('uses shared helpers when server does not inject snapshot or similar pickers', async () => {
    const similarResult = await handleMockInvokeOperation(
      createBaseArgs({
        operation: 'find_similar_products',
        payload: {
          similar: {
            product_id: 'base',
            limit: 2,
            exclude_ids: ['excluded'],
          },
        },
        searchProducts: jest.fn(() => [
          { product_id: 'base', price: 100 },
          { product_id: 'near_1', price: 95 },
          { product_id: 'near_2', price: 105 },
          { product_id: 'excluded', price: 101 },
        ]),
        pickSimilarProducts: undefined,
      }),
    );

    expect(similarResult.body.products).toEqual([
      { product_id: 'near_1', price: 95 },
      { product_id: 'near_2', price: 105 },
    ]);

    const createOrderResult = await handleMockInvokeOperation(
      createBaseArgs({
        operation: 'create_order',
        payload: {
          order: {
            merchant_id: 'merchant_1',
            items: [{ product_id: 'prod_1', unit_price: 5, quantity: 2 }],
          },
        },
        buildOrderLineSnapshots: undefined,
      }),
    );

    expect(createOrderResult.body.order_lines).toEqual([
      expect.objectContaining({
        line_id: expect.stringMatching(/^line_ORD_/),
        merchant_id: 'merchant_1',
        product_id: 'prod_1',
        product_group_id: 'pg:merchant_1:prod_1',
        quantity: 2,
      }),
    ]);
  });
});
