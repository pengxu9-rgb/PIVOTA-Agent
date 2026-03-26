const {
  recoverCheckoutUpstreamError,
} = require('../../src/commerce/checkout/recoverUpstreamError');

function createBaseArgs(overrides = {}) {
  return {
    operation: 'create_order',
    err: { response: { status: 422, data: { detail: [{ loc: ['body', 'order_request'] }] } } },
    response: null,
    requestBody: { merchant_id: 'm_123', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] },
    axiosConfig: {
      method: 'POST',
      url: 'http://pivota.test/agent/v1/orders/create',
      data: { merchant_id: 'm_123', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] },
    },
    checkoutToken: 'checkout-token',
    pivotaApiBase: 'http://pivota.test',
    checkoutRetryBaseMs: 100,
    callTrackedUpstream: jest.fn(),
    extractUpstreamErrorCode: jest.fn(() => ({ code: 'QUOTE_EXPIRED' })),
    isRetryableQuoteError: jest.fn((code) => code === 'QUOTE_EXPIRED'),
    isPydanticMissingBodyField: jest.fn(() => true),
    buildInvokeUpstreamAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer token' })),
    getUpstreamTimeoutMs: jest.fn(() => 9000),
    sleep: jest.fn(async () => {}),
    randomFn: jest.fn(() => 0),
    onGatewayRetry: jest.fn(),
    logger: { warn: jest.fn() },
    ...overrides,
  };
}

describe('checkoutRecovery', () => {
  test('retries create_order with order_request wrapper for pydantic body mismatch', async () => {
    const args = createBaseArgs({
      callTrackedUpstream: jest.fn(async () => ({ status: 200, data: { order_id: 'ord_1' } })),
    });

    const result = await recoverCheckoutUpstreamError(args);

    expect(args.callTrackedUpstream).toHaveBeenCalledWith(
      'create_order',
      expect.objectContaining({
        data: {
          order_request: args.requestBody,
        },
      }),
    );
    expect(result.response).toEqual({ status: 200, data: { order_id: 'ord_1' } });
  });

  test('re-quotes and retries create_order when quote has expired', async () => {
    const args = createBaseArgs({
      err: { response: { status: 409 } },
      requestBody: null,
      axiosConfig: {
        method: 'POST',
        url: 'http://pivota.test/agent/v1/orders/create',
        data: {
          merchant_id: 'm_123',
          quote_id: 'q_old',
          items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }],
          discount_codes: ['SAVE10'],
        },
      },
      isPydanticMissingBodyField: jest.fn(() => false),
      callTrackedUpstream: jest.fn(async (operation) => {
        if (operation === 'preview_quote') {
          return { status: 200, data: { quote_id: 'q_new' } };
        }
        if (operation === 'create_order') {
          return { status: 200, data: { order_id: 'ord_retry' } };
        }
        throw new Error(`unexpected operation: ${operation}`);
      }),
    });

    const result = await recoverCheckoutUpstreamError(args);

    expect(args.callTrackedUpstream).toHaveBeenNthCalledWith(
      1,
      'preview_quote',
      expect.objectContaining({
        url: 'http://pivota.test/agent/v1/quotes/preview',
        data: expect.objectContaining({
          merchant_id: 'm_123',
          items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }],
          discount_codes: ['SAVE10'],
        }),
      }),
    );
    expect(args.callTrackedUpstream).toHaveBeenNthCalledWith(
      2,
      'create_order',
      expect.objectContaining({
        data: expect.objectContaining({
          quote_id: 'q_new',
        }),
      }),
    );
    expect(result.response).toEqual({ status: 200, data: { order_id: 'ord_retry' } });
  });

  test('retries submit_payment once after temporary unavailability', async () => {
    const args = createBaseArgs({
      operation: 'submit_payment',
      err: { response: { status: 503 } },
      requestBody: null,
      axiosConfig: {
        method: 'POST',
        url: 'http://pivota.test/agent/v1/payments',
        data: { order_id: 'ord_1' },
      },
      extractUpstreamErrorCode: jest.fn(() => ({ code: 'TEMPORARY_UNAVAILABLE' })),
      isPydanticMissingBodyField: jest.fn(() => false),
      callTrackedUpstream: jest.fn(async () => ({
        status: 200,
        data: { payment_status: 'processing' },
      })),
    });

    const result = await recoverCheckoutUpstreamError(args);

    expect(args.logger.warn).toHaveBeenCalledWith(
      { operation: 'submit_payment', code: 'TEMPORARY_UNAVAILABLE' },
      'Upstream reported temporary unavailability; retrying submit_payment once',
    );
    expect(args.onGatewayRetry).toHaveBeenCalledTimes(1);
    expect(args.sleep).toHaveBeenCalledWith(120);
    expect(args.callTrackedUpstream).toHaveBeenCalledWith(
      'submit_payment',
      expect.objectContaining({
        url: 'http://pivota.test/agent/v1/payments',
      }),
    );
    expect(result.response).toEqual({
      status: 200,
      data: { payment_status: 'processing' },
    });
  });
});
