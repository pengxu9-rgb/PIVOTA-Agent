const {
  createUpstreamRetryRuntime,
  isRetryableQuoteError,
  isPydanticMissingBodyField,
} = require('../../src/commerce/upstreamRetryRuntime');

describe('upstreamRetryRuntime', () => {
  test('helper predicates stay stable', () => {
    expect(isRetryableQuoteError('QUOTE_EXPIRED')).toBe(true);
    expect(isRetryableQuoteError('QUOTE_MISMATCH')).toBe(true);
    expect(isRetryableQuoteError('OTHER')).toBe(false);

    expect(
      isPydanticMissingBodyField(
        {
          response: {
            status: 422,
            data: {
              detail: [{ loc: ['body', 'order_request'] }],
            },
          },
        },
        'order_request',
      ),
    ).toBe(true);
    expect(
      isPydanticMissingBodyField(
        {
          response: {
            status: 422,
            data: {
              detail: [{ loc: ['body', 'other_field'] }],
            },
          },
        },
        'order_request',
      ),
    ).toBe(false);
  });

  test('retries timed out find_products once with expanded timeout', async () => {
    const axiosClient = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ECONNABORTED' })
      .mockResolvedValueOnce({ status: 200, data: { products: [] } });
    const logger = { warn: jest.fn() };
    const onRetry = jest.fn();
    const runtime = createUpstreamRetryRuntime({
      axiosClient,
      logger,
      upstreamTimeoutFindProductsMs: 8000,
      upstreamTimeoutFindProductsRetryMs: 12000,
    });
    const axiosConfig = {
      method: 'POST',
      url: 'http://pivota.test/agent/v1/products/search',
      timeout: 8000,
    };

    const response = await runtime.callUpstreamWithOptionalRetry(
      'find_products',
      axiosConfig,
      { onRetry },
    );

    expect(response).toEqual({ status: 200, data: { products: [] } });
    expect(axiosClient).toHaveBeenCalledTimes(2);
    expect(axiosConfig.timeout).toBe(9000);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'find_products',
        previous_timeout_ms: 8000,
        retry_timeout_ms: 9000,
      }),
      'Upstream timeout, retrying once',
    );
    expect(onRetry).toHaveBeenCalledWith({
      operation: 'find_products',
      reason: 'timeout',
      attempt: 1,
      max_attempts: 2,
      delay_ms: 0,
    });
  });

  test('retries temporary unavailable checkout once with bounded backoff', async () => {
    const err = {
      response: {
        status: 503,
        data: {
          error: {
            message: 'TEMPORARY_UNAVAILABLE',
          },
        },
      },
    };
    const axiosClient = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ status: 200, data: { payment_status: 'processing' } });
    const logger = { warn: jest.fn() };
    const sleep = jest.fn(async () => {});
    const onRetry = jest.fn();
    const runtime = createUpstreamRetryRuntime({
      axiosClient,
      logger,
      sleep,
      randomFn: () => 0,
      checkoutRetryMaxAttempts: 2,
      checkoutRetryBaseMs: 120,
      checkoutRetryMaxMs: 800,
    });

    const response = await runtime.callUpstreamWithOptionalRetry(
      'submit_payment',
      {
        method: 'POST',
        url: 'http://pivota.test/agent/v1/payments',
      },
      { onRetry },
    );

    expect(response).toEqual({
      status: 200,
      data: { payment_status: 'processing' },
    });
    expect(axiosClient).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(120);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'submit_payment',
        attempt: 1,
        max_attempts: 2,
        delay_ms: 120,
      }),
      'Upstream temporary unavailable, retrying',
    );
    expect(onRetry).toHaveBeenCalledWith({
      operation: 'submit_payment',
      reason: 'temporary_unavailable',
      attempt: 1,
      max_attempts: 2,
      delay_ms: 120,
    });
  });
});
