const {
  registerGlobalErrorHandler,
  registerRecommendRoute,
  runPdpCorePrewarmPass,
} = require('../src/serverTail');

describe('serverTail', () => {
  test('registerGlobalErrorHandler handles invalid json and internal errors', () => {
    const app = { use: jest.fn() };
    const logger = { error: jest.fn() };

    registerGlobalErrorHandler({ app, logger });

    const middleware = app.use.mock.calls[0][0];
    const invalidJsonRes = {
      headersSent: false,
      status: jest.fn(function status(code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn(function json(body) {
        this.body = body;
        return body;
      }),
    };

    expect(
      middleware({ message: 'Invalid JSON' }, {}, invalidJsonRes, jest.fn()),
    ).toEqual({ error: 'Invalid JSON' });
    expect(invalidJsonRes.status).toHaveBeenCalledWith(400);

    const internalRes = {
      headersSent: false,
      status: jest.fn(function status(code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn(function json(body) {
        this.body = body;
        return body;
      }),
    };

    expect(
      middleware({ message: 'boom', stack: 'trace' }, {}, internalRes, jest.fn()),
    ).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      service: 'pivota-agent-gateway',
    });
    expect(logger.error).toHaveBeenCalledWith(
      { err: 'boom', stack: 'trace' },
      'Unhandled error',
    );
    expect(internalRes.status).toHaveBeenCalledWith(500);
  });

  test('registerGlobalErrorHandler passes through when headers are already sent', () => {
    const app = { use: jest.fn() };
    const next = jest.fn();

    registerGlobalErrorHandler({
      app,
      logger: { error: jest.fn() },
    });

    const middleware = app.use.mock.calls[0][0];
    const err = new Error('boom');
    middleware(err, {}, { headersSent: true }, next);

    expect(next).toHaveBeenCalledWith(err);
  });

  test('registerRecommendRoute delegates to recommend handler', async () => {
    const app = { post: jest.fn() };
    const recommendHandler = jest.fn(async () => ({ ok: true }));
    const req = { body: { q: 'ipsa' } };
    const res = {};

    registerRecommendRoute({ app, recommendHandler });

    const handler = app.post.mock.calls[0][1];
    await expect(handler(req, res)).resolves.toEqual({ ok: true });
    expect(app.post).toHaveBeenCalledWith('/recommend', expect.any(Function));
    expect(recommendHandler).toHaveBeenCalledWith(req, res);
  });

  test('runPdpCorePrewarmPass skips empty target lists', async () => {
    await expect(
      runPdpCorePrewarmPass({
        targets: [],
        gatewayUrl: '',
        port: 8080,
        timeoutMs: 1000,
        intervalMs: 5000,
        axios: { post: jest.fn() },
        logger: { info: jest.fn(), warn: jest.fn() },
      }),
    ).resolves.toEqual({ attempted: 0, succeeded: 0, failed: 0 });
  });

  test('runPdpCorePrewarmPass uses default gateway url and tracks success/failure counts', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, data: { request_id: 'req_1' } })
      .mockRejectedValueOnce({
        message: 'timeout',
        response: { status: 504 },
      });
    const logger = { info: jest.fn(), warn: jest.fn() };
    let now = 1000;
    const nowMs = jest.fn(() => {
      now += 10;
      return now;
    });

    await expect(
      runPdpCorePrewarmPass({
        targets: [
          { merchant_id: 'm_1', product_id: 'p_1' },
          { merchant_id: 'm_2', product_id: 'p_2' },
        ],
        gatewayUrl: '',
        port: 8090,
        timeoutMs: 6500,
        intervalMs: 300000,
        axios: { post },
        logger,
        nowMs,
      }),
    ).resolves.toEqual({ attempted: 2, succeeded: 1, failed: 1 });

    expect(post).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8090/agent/shop/v1/invoke',
      expect.objectContaining({
        operation: 'get_pdp_v2',
        payload: expect.objectContaining({
          product_ref: { merchant_id: 'm_1', product_id: 'p_1' },
        }),
      }),
      expect.objectContaining({
        timeout: 6500,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        attempted: 2,
        succeeded: 1,
        failed: 1,
        timeout_ms: 6500,
        interval_ms: 300000,
      }),
      'PDP core prewarm pass summary',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        merchant_id: 'm_2',
        product_id: 'p_2',
        status: 504,
      }),
      'PDP core prewarm request failed',
    );
  });
});
