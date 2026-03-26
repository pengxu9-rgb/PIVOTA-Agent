const {
  handleResolveProductGroupOperation,
} = require('../../src/commerce/pdp/resolveProductGroup');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'resolve_product_group',
    payload: {
      product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
        platform: 'shopify',
      },
      options: {
        debug: true,
      },
    },
    checkoutToken: 'checkout-token',
    resolveProductGroupCached: jest.fn(async () => ({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      canonical_product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
      },
      members: [{ merchant_id: 'm1', product_id: 'p1', is_primary: true }],
      cache: {
        hit: false,
      },
    })),
    extractUpstreamErrorCode: jest.fn(() => ({
      code: 'RESOLVE_PRODUCT_GROUP_FAILED',
      message: 'failed',
      data: null,
    })),
    logger: {
      error: jest.fn(),
    },
    ...overrides,
  };
}

describe('handleResolveProductGroupOperation', () => {
  test('returns handled=false for non resolve_product_group operations', async () => {
    const result = await handleResolveProductGroupOperation(
      createBaseArgs({
        operation: 'get_pdp',
      }),
    );

    expect(result).toEqual({ handled: false });
  });

  test('returns missing-parameter error when product_id is absent', async () => {
    const result = await handleResolveProductGroupOperation(
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

  test('delegates to cached resolver with normalized args', async () => {
    const resolveProductGroupCached = jest.fn(async () => ({
      status: 'success',
      product_group_id: 'pg:m1:p1',
      canonical_product_ref: {
        merchant_id: 'm1',
        product_id: 'p1',
      },
      members: [{ merchant_id: 'm1', product_id: 'p1', is_primary: true }],
    }));

    const result = await handleResolveProductGroupOperation(
      createBaseArgs({
        payload: {
          productRef: {
            merchantId: 'm1',
            productId: 'p1',
            platform: 'shopify',
          },
          options: {
            debug: 'true',
            cache_bypass: 'true',
          },
        },
        resolveProductGroupCached,
      }),
    );

    expect(resolveProductGroupCached).toHaveBeenCalledWith({
      productId: 'p1',
      merchantId: 'm1',
      platform: 'shopify',
      checkoutToken: 'checkout-token',
      bypassCache: true,
      debug: true,
    });
    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        product_group_id: 'pg:m1:p1',
        canonical_product_ref: {
          merchant_id: 'm1',
          product_id: 'p1',
        },
        members: [{ merchant_id: 'm1', product_id: 'p1', is_primary: true }],
      },
    });
  });
});
