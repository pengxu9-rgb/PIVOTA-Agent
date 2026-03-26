const {
  createCommerceEntrypoints,
} = require('../../src/commerce/bootstrapCommerceEntrypoints');

describe('bootstrapCommerceEntrypoints', () => {
  test('creates runtime, registers routes, and binds invoke handler through the bridge', () => {
    const invokeHandlerBridge = jest.fn();
    invokeHandlerBridge.set = jest.fn((handler) => handler);

    const runtime = {
      invokeHandlerBridge,
      commerceKernel: { invoke: jest.fn() },
      commerceClient: { type: 'in-process' },
    };

    const createRuntimeBridge = jest.fn(() => runtime);
    const registerRoutes = jest.fn();
    const createInvokeHandler = jest.fn(() => 'bound_handler');

    const result = createCommerceEntrypoints({
      defaultClientChannel: 'creator',
      defaultVersion: 'v2',
      createRuntimeBridge,
      registerRoutes,
      createInvokeHandler,
    });

    expect(createRuntimeBridge).toHaveBeenCalledWith({
      defaultClientChannel: 'creator',
      defaultVersion: 'v2',
    });
    expect(registerRoutes).not.toHaveBeenCalled();

    result.registerHttpRoutes({
      app: { post: jest.fn(), get: jest.fn() },
      requireExternalInvokeAuth: jest.fn(),
      invokeAuthContext: { run: jest.fn() },
      proxyAgentSearchToBackend: jest.fn(),
      buildFindProductsMultiPayloadFromQuery: jest.fn(),
      firstQueryParamValue: jest.fn(),
      buildQueryString: jest.fn(),
    });

    expect(registerRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        handleInvokeRequest: invokeHandlerBridge,
        commerceKernel: runtime.commerceKernel,
      }),
    );

    expect(result).toEqual({
      commerceKernel: runtime.commerceKernel,
      commerceClient: runtime.commerceClient,
      invokeHandlerBridge,
      registerHttpRoutes: expect.any(Function),
      bindInvokeHandler: expect.any(Function),
    });

    const bound = result.bindInvokeHandler({ logger: { info: jest.fn() } });
    expect(createInvokeHandler).toHaveBeenCalledWith({
      logger: { info: expect.any(Function) },
    });
    expect(invokeHandlerBridge.set).toHaveBeenCalledWith('bound_handler');
    expect(bound).toBe('bound_handler');
  });
});
