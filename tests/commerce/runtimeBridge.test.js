const {
  createInvokeHandlerBridge,
  createCommerceRuntimeBridge,
} = require('../../src/commerce/runtimeBridge');

describe('runtimeBridge', () => {
  test('createInvokeHandlerBridge throws until a handler is bound', () => {
    const bridge = createInvokeHandlerBridge();

    expect(() => bridge({}, {}, {})).toThrow('INVOKE_HANDLER_NOT_READY');
    expect(() => bridge({}, {}, {})).toThrow(
      expect.objectContaining({ code: 'INVOKE_HANDLER_NOT_READY' }),
    );
  });

  test('createInvokeHandlerBridge delegates after set', async () => {
    const bridge = createInvokeHandlerBridge();
    const handler = jest.fn(async () => ({ status: 'ok' }));
    const req = { body: { operation: 'preview_quote' } };
    const res = {};
    const routeContext = { client_channel: 'shop' };

    expect(bridge.set(handler)).toBe(handler);
    expect(bridge.get()).toBe(handler);
    await expect(bridge(req, res, routeContext)).resolves.toEqual({ status: 'ok' });
    expect(handler).toHaveBeenCalledWith(req, res, routeContext);
  });

  test('createCommerceRuntimeBridge wires kernel legacy invoke through bridge and client defaults', async () => {
    const createKernel = jest.fn((config) => ({
      invokeLegacy: config.executeLegacyInvoke,
      config,
    }));
    const createInProcessClient = jest.fn((config) => ({
      type: 'in-process',
      config,
    }));
    const executeExpressJson = jest.fn(async (handler, args) => {
      const req = { body: args.body, headers: args.headers, invokeAuth: args.invokeAuth };
      const res = { locals: {} };
      return handler(req, res, args.routeContext);
    });

    const runtime = createCommerceRuntimeBridge({
      defaultClientChannel: 'creator',
      defaultVersion: 'v2',
      createKernel,
      createInProcessClient,
      executeExpressJson,
    });

    expect(createKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultClientChannel: 'creator',
        executeLegacyInvoke: expect.any(Function),
      }),
    );
    expect(createInProcessClient).toHaveBeenCalledWith({
      kernel: runtime.commerceKernel,
      defaultVersion: 'v2',
      defaultClientChannel: 'creator',
    });

    const boundHandler = jest.fn(async () => ({ ok: true }));
    runtime.invokeHandlerBridge.set(boundHandler);

    await expect(
      runtime.commerceKernel.invokeLegacy({
        body: { operation: 'preview_quote' },
        headers: { authorization: 'Bearer token' },
        routeContext: { client_channel: 'shop' },
        invokeAuth: { agent_id: 'agent_1' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(executeExpressJson).toHaveBeenCalledWith(
      runtime.invokeHandlerBridge,
      {
        body: { operation: 'preview_quote' },
        headers: { authorization: 'Bearer token' },
        routeContext: { client_channel: 'shop' },
        invokeAuth: { agent_id: 'agent_1' },
      },
    );
    expect(boundHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { operation: 'preview_quote' },
        headers: { authorization: 'Bearer token' },
        invokeAuth: { agent_id: 'agent_1' },
      }),
      expect.any(Object),
      { client_channel: 'shop' },
    );
  });
});
