const {
  resolveInvokeUpstreamTimeout,
  buildInvokeAxiosConfig,
  createTrackedUpstreamCaller,
} = require('../../src/commerce/invokeTransport');

describe('invokeTransport', () => {
  test('uses lookup timeout budget for lookup-style find_products_multi queries', () => {
    const timeout = resolveInvokeUpstreamTimeout({
      operation: 'find_products_multi',
      queryParams: { query: 'ipsa 流金水' },
      rawUserQuery: '',
      traceQueryClass: 'lookup',
      extractSearchQueryText: (query) => String(query?.query || '').trim(),
      extractSearchAnchorTokens: () => ['ipsa'],
      isLookupStyleSearchQuery: () => true,
      getUpstreamTimeoutMs: () => 6000,
      findProductsMultiUpstreamLookupTimeoutMs: 3500,
      findProductsMultiUpstreamDefaultTimeoutMs: 4500,
    });

    expect(timeout).toBe(3500);
  });

  test('uses default timeout for non-search operations', () => {
    const timeout = resolveInvokeUpstreamTimeout({
      operation: 'create_order',
      getUpstreamTimeoutMs: () => 9000,
    });

    expect(timeout).toBe(9000);
  });

  test('builds axios config with auth headers and request body for post operations', () => {
    const config = buildInvokeAxiosConfig({
      operation: 'create_order',
      route: { method: 'POST' },
      url: 'http://pivota.test/agent/v1/orders',
      queryParams: {},
      requestBody: { order_id: 'ord_1' },
      checkoutToken: 'checkout-token',
      buildQueryString: () => '',
      buildInvokeUpstreamAuthHeaders: () => ({ Authorization: 'Bearer token' }),
      getUpstreamTimeoutMs: () => 9000,
    });

    expect(config).toEqual({
      method: 'POST',
      url: 'http://pivota.test/agent/v1/orders',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      timeout: 9000,
      data: { order_id: 'ord_1' },
    });
  });

  test('tracked upstream caller records retry and elapsed only for checkout ops', async () => {
    const onRetry = jest.fn();
    const onElapsed = jest.fn();
    const now = jest.fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(160);
    const callUpstreamWithOptionalRetry = jest.fn(async (_op, _config, hooks) => {
      hooks.onRetry();
      return { status: 200 };
    });
    const callTrackedUpstream = createTrackedUpstreamCaller({
      callUpstreamWithOptionalRetry,
      checkoutTimingOps: new Set(['create_order']),
      onRetry,
      onElapsed,
      now,
    });

    const result = await callTrackedUpstream('create_order', { url: 'http://pivota.test' });

    expect(result).toEqual({ status: 200 });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onElapsed).toHaveBeenCalledWith(60);
  });

  test('tracked upstream caller skips timing hooks for non-checkout ops', async () => {
    const onRetry = jest.fn();
    const onElapsed = jest.fn();
    const callUpstreamWithOptionalRetry = jest.fn(async (_op, _config, hooks) => {
      hooks.onRetry();
      return { status: 200 };
    });
    const callTrackedUpstream = createTrackedUpstreamCaller({
      callUpstreamWithOptionalRetry,
      checkoutTimingOps: new Set(['create_order']),
      onRetry,
      onElapsed,
    });

    await callTrackedUpstream('find_products_multi', { url: 'http://pivota.test' });

    expect(onRetry).not.toHaveBeenCalled();
    expect(onElapsed).not.toHaveBeenCalled();
  });

  test('tracked upstream caller disables timeout retry for generic find_products fail-open', async () => {
    const callUpstreamWithOptionalRetry = jest.fn(async () => ({ status: 200 }));
    const callTrackedUpstream = createTrackedUpstreamCaller({
      callUpstreamWithOptionalRetry,
      checkoutTimingOps: new Set(['create_order']),
    });

    await callTrackedUpstream('find_products', { url: 'http://pivota.test' });

    expect(callUpstreamWithOptionalRetry).toHaveBeenCalledWith(
      'find_products',
      { url: 'http://pivota.test' },
      expect.objectContaining({
        disableTimeoutRetry: true,
      }),
    );
  });
});
