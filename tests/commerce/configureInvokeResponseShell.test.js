const { EventEmitter } = require('events');
const {
  normalizeFindProductsMultiResponseMetadata,
  decorateInvokeJsonBody,
  configureInvokeResponseShell,
} = require('../../src/commerce/configureInvokeResponseShell');

function createResponseDouble() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  res.json = jest.fn((body) => body);
  return res;
}

describe('configureInvokeResponseShell', () => {
  test('normalizeFindProductsMultiResponseMetadata appends orchestrator metadata', () => {
    const body = normalizeFindProductsMultiResponseMetadata({
      body: {
        metadata: {
          search_decision: { domain_filter_dropped_external: 2 },
          semantic_retry_hits: 1,
        },
      },
      routeContext: { orchestrator_path: 'proxy_search_route' },
    });

    expect(body.metadata).toEqual(
      expect.objectContaining({
        orchestrator_path: 'proxy_search_route',
        semantic_retry_applied: false,
        semantic_retry_hits: 1,
        domain_filter_dropped_external: 2,
      }),
    );
  });

  test('decorateInvokeJsonBody attaches debug bundle and metadata for find_products_multi', () => {
    const req = { body: { operation: 'find_products_multi' }, headers: {} };
    const logger = { info: jest.fn(), warn: jest.fn() };
    const debugRuntime = { operation: 'find_products_multi' };

    const body = decorateInvokeJsonBody({
      req,
      body: { metadata: {} },
      routeContext: { orchestrator_path: 'external_invoke_route' },
      gatewayRequestId: 'req_1',
      invokeStartedAtMs: Date.now() - 50,
      debugRuntime,
      buildSearchDebugBundle: jest.fn(() => ({ trace_id: 'dbg_1' })),
      shouldExposeDebugBundle: jest.fn(() => true),
      shouldLogDebugBundle: jest.fn(() => false),
      logger,
    });

    expect(body.debug_bundle).toEqual({ trace_id: 'dbg_1' });
    expect(body.metadata).toEqual(
      expect.objectContaining({
        orchestrator_path: 'external_invoke_route',
      }),
    );
  });

  test('configureInvokeResponseShell wraps json, emits perf headers, and logs on finish', () => {
    const req = { body: { operation: 'submit_payment' }, headers: {} };
    const res = createResponseDouble();
    const logger = { info: jest.fn(), warn: jest.fn() };
    const debugRuntime = { operation: 'submit_payment' };
    const checkoutRuntime = {
      checkoutTraceId: 'trace_1',
      paymentStatus: 'processing',
      confirmationOwner: 'backend',
      requiresClientConfirmation: false,
    };

    configureInvokeResponseShell({
      req,
      res,
      routeContext: { orchestrator_path: 'external_invoke_route' },
      gatewayRequestId: 'req_1',
      invokeStartedAtMs: Date.now() - 100,
      clientChannel: 'shop',
      routeKeyFingerprint: 'fp_1',
      debugRuntime,
      checkoutRuntime,
      checkoutTimingOps: new Set(['submit_payment']),
      getUpstreamElapsedMs: () => 40,
      getGatewayRetryCount: () => 2,
      buildSearchDebugBundle: jest.fn(),
      shouldExposeDebugBundle: jest.fn(() => false),
      shouldLogDebugBundle: jest.fn(() => false),
      logger,
    });

    const body = res.json({ status: 'success' });
    expect(body).toEqual({ status: 'success' });
    expect(res.setHeader).toHaveBeenCalledWith('X-Gateway-Request-Id', 'req_1');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Server-Timing',
      expect.stringContaining('upstream;dur=40'),
    );
    expect(res.setHeader).toHaveBeenCalledWith('x-gateway-retries', '2');

    res.emit('finish');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway_request_id: 'req_1',
        client_channel: 'shop',
        key_fingerprint: 'fp_1',
        operation: 'submit_payment',
        gateway_retries: 2,
        checkout_trace_id: 'trace_1',
      }),
      'invoke request complete',
    );
  });
});
