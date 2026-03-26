const {
  ALLOWED_INVOKE_PROXY_HEADERS,
  copyInvokeHeaders,
  buildInvokeRouteContext,
  buildInvokeAuthContextValue,
  handleExternalInvokeRoute,
  createExternalInvokeRouteHandler,
} = require('../../src/commerce/externalInvokeRoute');

describe('externalInvokeRoute', () => {
  test('copyInvokeHeaders only forwards allowlisted headers', () => {
    const res = {
      setHeader: jest.fn(),
    };

    copyInvokeHeaders(res, {
      'x-gateway-request-id': 'gw_1',
      'x-upstream-request-id': 'up_1',
      'content-type': 'application/json',
    });

    expect(ALLOWED_INVOKE_PROXY_HEADERS).toEqual([
      'x-gateway-request-id',
      'server-timing',
      'x-gateway-retries',
      'x-upstream-request-id',
    ]);
    expect(res.setHeader).toHaveBeenCalledTimes(2);
    expect(res.setHeader).toHaveBeenCalledWith('x-gateway-request-id', 'gw_1');
    expect(res.setHeader).toHaveBeenCalledWith('x-upstream-request-id', 'up_1');
  });

  test('buildInvokeRouteContext preserves invoke auth and request metadata', () => {
    const req = {
      path: '/agent/shop/v2/invoke',
      query: { q: 'ipsa' },
      params: { id: '1' },
      socket: { remoteAddress: '127.0.0.1' },
      invokeAuth: {
        key_fingerprint: 'fp_1',
        agent_id: 'agent_1',
        auth_mode: 'api_key',
        auth_source: 'header',
      },
    };

    expect(buildInvokeRouteContext(req, 'shop', 'external_invoke_route_v2')).toEqual({
      client_channel: 'shop',
      orchestrator_path: 'external_invoke_route_v2',
      key_fingerprint: 'fp_1',
      agent_id: 'agent_1',
      auth_mode: 'api_key',
      auth_source: 'header',
      path: '/agent/shop/v2/invoke',
      query: { q: 'ipsa' },
      params: { id: '1' },
      socket: { remoteAddress: '127.0.0.1' },
    });
  });

  test('handleExternalInvokeRoute delegates v1 to handleInvokeRequest', async () => {
    const req = {
      path: '/agent/shop/v1/invoke',
      query: {},
      params: {},
      invokeAuth: {},
    };
    const res = {};
    const handleInvokeRequestMock = jest.fn(async () => 'v1_result');

    const result = await handleExternalInvokeRoute({
      req,
      res,
      version: 'v1',
      clientChannel: 'shop',
      handleInvokeRequest: handleInvokeRequestMock,
      commerceKernel: {},
    });

    expect(handleInvokeRequestMock).toHaveBeenCalledWith(
      req,
      res,
      expect.objectContaining({
        client_channel: 'shop',
        orchestrator_path: 'external_invoke_route',
      }),
    );
    expect(result).toBe('v1_result');
  });

  test('handleExternalInvokeRoute proxies v2 kernel response and copies headers', async () => {
    const req = {
      body: { operation: 'quote.preview' },
      headers: { authorization: 'Bearer token' },
      invokeAuth: { agent_id: 'agent_1' },
      path: '/agent/shop/v2/invoke',
      query: {},
      params: {},
    };
    const res = {
      setHeader: jest.fn(),
      status: jest.fn(function status() {
        return this;
      }),
      json: jest.fn(function json(body) {
        return body;
      }),
    };
    const commerceKernel = {
      invoke: jest.fn(async () => ({
        statusCode: 200,
        headers: {
          'x-gateway-request-id': 'gw_1',
          'x-upstream-request-id': 'up_1',
        },
        body: { status: 'success' },
      })),
    };

    const result = await handleExternalInvokeRoute({
      req,
      res,
      version: 'v2',
      clientChannel: 'shop',
      handleInvokeRequest: jest.fn(),
      commerceKernel,
    });

    expect(commerceKernel.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        body: req.body,
        headers: req.headers,
        version: 'v2',
        clientChannel: 'shop',
        invokeAuth: req.invokeAuth,
        routeContext: expect.objectContaining({
          orchestrator_path: 'external_invoke_route_v2',
        }),
      }),
    );
    expect(res.setHeader).toHaveBeenCalledWith('x-gateway-request-id', 'gw_1');
    expect(res.setHeader).toHaveBeenCalledWith('x-upstream-request-id', 'up_1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'success' });
    expect(result).toEqual({ status: 'success' });
  });

  test('handleExternalInvokeRoute maps v2 invoke errors to stable envelope', async () => {
    const res = {
      status: jest.fn(function status() {
        return this;
      }),
      json: jest.fn(function json(body) {
        return body;
      }),
    };
    const commerceKernel = {
      invoke: jest.fn(async () => {
        const err = new Error('Unsupported');
        err.code = 'UNSUPPORTED_OPERATION';
        err.statusCode = 422;
        throw err;
      }),
    };

    const result = await handleExternalInvokeRoute({
      req: { body: {}, headers: {}, invokeAuth: {}, path: '/agent/shop/v2/invoke', query: {}, params: {} },
      res,
      version: 'v2',
      clientChannel: 'shop',
      handleInvokeRequest: jest.fn(),
      commerceKernel,
    });

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: 'UNSUPPORTED_OPERATION',
      message: 'Unsupported',
    });
    expect(result).toEqual({
      error: 'UNSUPPORTED_OPERATION',
      message: 'Unsupported',
    });
  });

  test('createExternalInvokeRouteHandler wraps execution in invoke auth context', async () => {
    const invokeAuthContext = {
      run: jest.fn(async (_value, callback) => callback()),
    };
    const handleExternalInvoke = jest.fn(async () => 'handled');
    const req = {
      invokeAuth: {
        raw_token: 'ak_live_x',
        agent_id: 'agent_1',
        auth_mode: 'api_key',
        auth_source: 'header',
      },
    };

    const handler = createExternalInvokeRouteHandler({
      version: 'v2',
      clientChannel: 'creator',
      handleInvokeRequest: jest.fn(),
      commerceKernel: {},
      invokeAuthContext,
      handleExternalInvoke,
    });

    const result = await handler(req, {});

    expect(buildInvokeAuthContextValue(req)).toEqual({
      api_key: 'ak_live_x',
      agent_id: 'agent_1',
      auth_mode: 'api_key',
      auth_source: 'header',
    });
    expect(invokeAuthContext.run).toHaveBeenCalledWith(
      {
        api_key: 'ak_live_x',
        agent_id: 'agent_1',
        auth_mode: 'api_key',
        auth_source: 'header',
      },
      expect.any(Function),
    );
    expect(handleExternalInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        res: {},
        version: 'v2',
        clientChannel: 'creator',
      }),
    );
    expect(result).toBe('handled');
  });
});
