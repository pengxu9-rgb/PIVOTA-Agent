const { handleGetPdpOperation } = require('../../src/commerce/pdp/getPdp');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'get_pdp',
    payload: {
      product: {
        merchant_id: 'm1',
        product_id: 'p1',
      },
    },
    checkoutToken: 'checkout-token',
    defaultMerchantId: 'default_mid',
    getPdpOptions: jest.fn(() => ({
      includeRecommendations: false,
      includeEmptyReviews: false,
      templateHint: 'compact',
      entryPoint: 'detail',
      experiment: 'exp_a',
      debug: false,
    })),
    fetchProductDetailFromUpstream: jest.fn(async () => ({
      merchant_id: 'm1',
      product_id: 'p1',
      title: 'PDP Product',
      currency: 'USD',
    })),
    recommendPdpProducts: jest.fn(async () => ({
      items: [{ merchant_id: 'm2', product_id: 'p2' }],
    })),
    buildPdpPayload: jest.fn(({ product, relatedProducts }) => ({
      hero: product.product_id,
      related_count: relatedProducts.length,
    })),
    extractUpstreamErrorCode: jest.fn(() => ({
      code: 'GET_PDP_FAILED',
      message: 'failed',
      data: null,
    })),
    logger: {
      warn: jest.fn(),
      error: jest.fn(),
    },
    ...overrides,
  };
}

describe('handleGetPdpOperation', () => {
  test('returns handled=false for non get_pdp operations', async () => {
    const result = await handleGetPdpOperation(
      createBaseArgs({
        operation: 'get_pdp_v2',
      }),
    );

    expect(result).toEqual({ handled: false });
  });

  test('returns missing-parameter error when product reference is incomplete', async () => {
    const result = await handleGetPdpOperation(
      createBaseArgs({
        payload: {},
      }),
    );

    expect(result).toEqual({
      handled: true,
      statusCode: 400,
      body: {
        error: 'MISSING_PARAMETERS',
        message: 'merchant_id and product_id are required for get_pdp',
      },
    });
  });

  test('returns assembled pdp payload for happy path', async () => {
    const result = await handleGetPdpOperation(createBaseArgs());

    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        product: {
          merchant_id: 'm1',
          product_id: 'p1',
          title: 'PDP Product',
          currency: 'USD',
        },
        pdp_payload: {
          hero: 'p1',
          related_count: 0,
        },
      },
    });
  });

  test('swallows recommendation failure and still returns pdp payload', async () => {
    const logger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    const result = await handleGetPdpOperation(
      createBaseArgs({
        payload: {
          product: {
            merchant_id: 'm1',
            product_id: 'p1',
          },
          include: ['recommendations'],
          recommendations: { limit: 4 },
          options: { no_cache: true },
        },
        getPdpOptions: jest.fn(() => ({
          includeRecommendations: true,
          includeEmptyReviews: false,
          templateHint: 'compact',
          entryPoint: 'detail',
          experiment: 'exp_a',
          debug: true,
        })),
        recommendPdpProducts: jest.fn(async () => {
          throw new Error('boom');
        }),
        logger,
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(result.body.pdp_payload).toEqual({
      hero: 'p1',
      related_count: 0,
    });
    expect(logger.warn).toHaveBeenCalled();
  });
});
