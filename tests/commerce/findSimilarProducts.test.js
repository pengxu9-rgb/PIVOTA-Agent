const {
  handleFindSimilarProductsInvoke,
} = require('../../src/commerce/catalog/findSimilarProducts');

function createArgs(overrides = {}) {
  return {
    payload: {
      product_id: 'prod_1',
    },
    metadata: { source: 'shopping_agent', creator_id: 'creator_1' },
    creatorId: 'creator_1',
    now: new Date('2026-03-20T00:00:00.000Z'),
    checkoutToken: 'token_1',
    hasDatabase: false,
    isCreatorUiSource: () => false,
    findSimilarCreatorFromCache: jest.fn(),
    getActivePromotions: jest.fn(async () => []),
    applyDealsToResponse: (value) => value,
    fetchProductDetailForOffers: jest.fn(async () => ({
      merchant_id: 'm1',
      product_id: 'prod_1',
      currency: 'USD',
    })),
    recommendPdpProducts: jest.fn(async () => ({
      items: [{ merchant_id: 'm2', product_id: 'prod_2' }],
    })),
    logger: {
      warn: jest.fn(),
    },
    ...overrides,
  };
}

describe('handleFindSimilarProductsInvoke', () => {
  test('returns local recommendation response when recommendation engine succeeds', async () => {
    const result = await handleFindSimilarProductsInvoke(createArgs());

    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        strategy: 'related_products',
        products: [{ merchant_id: 'm2', product_id: 'prod_2' }],
        total: 1,
        page: 1,
        page_size: 1,
      },
    });
  });

  test('falls back to upstream request body when local path cannot resolve product id', async () => {
    const result = await handleFindSimilarProductsInvoke(
      createArgs({
        payload: {
          limit: 4,
          strategy: 'hybrid',
          user: { id: 'user_1' },
        },
        recommendPdpProducts: jest.fn(),
      }),
    );

    expect(result).toEqual({
      handled: false,
      requestBody: {
        operation: 'find_similar_products',
        payload: {
          product_id: undefined,
          merchant_id: undefined,
          limit: 4,
          strategy: 'hybrid',
          user: { id: 'user_1' },
          creator_id: 'creator_1',
          metadata: { source: 'shopping_agent', creator_id: 'creator_1' },
        },
        metadata: { source: 'shopping_agent', creator_id: 'creator_1' },
      },
    });
  });
});
