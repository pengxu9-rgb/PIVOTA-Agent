const {
  createAgentProductsSearchViaInvokeHandler,
  createBeautyProductsSearchRedirectHandler,
  registerCommerceHttpRoutes,
} = require('../../src/commerce/registerCommerceHttpRoutes');

describe('registerCommerceHttpRoutes', () => {
  test('createAgentProductsSearchViaInvokeHandler rejects invalid query payloads', async () => {
    const req = { query: { q: 'serum' } };
    const res = {
      status: jest.fn(function status(code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn(function json(body) {
        this.body = body;
        return body;
      }),
    };
    const handleInvokeRequest = jest.fn();

    const handler = createAgentProductsSearchViaInvokeHandler({
      buildFindProductsMultiPayloadFromQuery: jest.fn(() => null),
      handleInvokeRequest,
    });

    const result = await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INVALID_QUERY',
      message: 'query payload is invalid',
    });
    expect(handleInvokeRequest).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: 'INVALID_QUERY',
      message: 'query payload is invalid',
    });
  });

  test('createAgentProductsSearchViaInvokeHandler maps valid queries to find_products_multi invoke', async () => {
    const req = { query: { q: 'serum' } };
    const res = {};
    const payload = {
      q: 'serum',
      metadata: { source: 'aurora-bff' },
    };
    const handleInvokeRequest = jest.fn(async () => ({ status: 'ok' }));

    const handler = createAgentProductsSearchViaInvokeHandler({
      buildFindProductsMultiPayloadFromQuery: jest.fn(() => payload),
      handleInvokeRequest,
    });

    const result = await handler(req, res);

    expect(req.body).toEqual({
      operation: 'find_products_multi',
      payload,
      metadata: { source: 'aurora-bff' },
    });
    expect(handleInvokeRequest).toHaveBeenCalledWith(req, res, {
      client_channel: 'shop',
      orchestrator_path: 'external_invoke_route',
      proxy_search_route: true,
    });
    expect(result).toEqual({ status: 'ok' });
  });

  test('createBeautyProductsSearchRedirectHandler applies default aurora beauty query params', () => {
    const req = {
      query: {
        q: 'lip oil',
      },
    };
    const res = {
      redirect: jest.fn(),
    };

    const handler = createBeautyProductsSearchRedirectHandler({
      firstQueryParamValue: jest.fn((value) => (Array.isArray(value) ? value[0] : value)),
      buildQueryString: jest.fn((query) => `?${new URLSearchParams(query).toString()}`),
    });

    handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      307,
      '/agent/v1/products/search?q=lip+oil&source=aurora-bff&catalog_surface=beauty',
    );
  });

  test('createBeautyProductsSearchRedirectHandler preserves provided source and catalog surface', () => {
    const req = {
      query: {
        q: 'lip oil',
        source: 'custom-source',
        catalog_surface: 'fragrance',
      },
    };
    const res = {
      redirect: jest.fn(),
    };

    const handler = createBeautyProductsSearchRedirectHandler({
      firstQueryParamValue: jest.fn((value) => (Array.isArray(value) ? value[0] : value)),
      buildQueryString: jest.fn((query) => `?${new URLSearchParams(query).toString()}`),
    });

    handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      307,
      '/agent/v1/products/search?q=lip+oil&source=custom-source&catalog_surface=fragrance',
    );
  });

  test('registerCommerceHttpRoutes mounts invoke and proxy routes through provided factories', () => {
    const app = {
      post: jest.fn(),
      get: jest.fn(),
    };
    const requireExternalInvokeAuth = jest.fn();
    const handleInvokeRequest = jest.fn();
    const commerceKernel = {};
    const invokeAuthContext = {};
    const proxyAgentSearchToBackend = jest.fn();
    const createExternalInvokeRoute = jest.fn(({ path, ...rest } = {}) => ({
      path,
      ...rest,
    }));
    const buildQueryString = jest.fn(() => '?source=aurora-bff&catalog_surface=beauty');
    const firstQueryParamValue = jest.fn((value) => (Array.isArray(value) ? value[0] : value));

    const result = registerCommerceHttpRoutes({
      app,
      requireExternalInvokeAuth,
      handleInvokeRequest,
      commerceKernel,
      invokeAuthContext,
      proxyAgentSearchToBackend,
      buildFindProductsMultiPayloadFromQuery: jest.fn(),
      firstQueryParamValue,
      buildQueryString,
      createExternalInvokeRoute,
    });

    expect(createExternalInvokeRoute).toHaveBeenCalledTimes(4);
    expect(createExternalInvokeRoute).toHaveBeenNthCalledWith(1, {
      version: 'v1',
      clientChannel: 'shop',
      handleInvokeRequest,
      commerceKernel,
      invokeAuthContext,
    });
    expect(createExternalInvokeRoute).toHaveBeenNthCalledWith(2, {
      version: 'v2',
      clientChannel: 'shop',
      handleInvokeRequest,
      commerceKernel,
      invokeAuthContext,
    });
    expect(createExternalInvokeRoute).toHaveBeenNthCalledWith(3, {
      version: 'v1',
      clientChannel: 'creator',
      handleInvokeRequest,
      commerceKernel,
      invokeAuthContext,
    });
    expect(createExternalInvokeRoute).toHaveBeenNthCalledWith(4, {
      version: 'v2',
      clientChannel: 'creator',
      handleInvokeRequest,
      commerceKernel,
      invokeAuthContext,
    });

    expect(app.post).toHaveBeenNthCalledWith(
      1,
      '/agent/shop/v1/invoke',
      requireExternalInvokeAuth,
      expect.any(Object),
    );
    expect(app.post).toHaveBeenNthCalledWith(
      2,
      '/agent/shop/v2/invoke',
      requireExternalInvokeAuth,
      expect.any(Object),
    );
    expect(app.post).toHaveBeenNthCalledWith(
      3,
      '/agent/creator/v1/invoke',
      requireExternalInvokeAuth,
      expect.any(Object),
    );
    expect(app.post).toHaveBeenNthCalledWith(
      4,
      '/agent/creator/v2/invoke',
      requireExternalInvokeAuth,
      expect.any(Object),
    );

    expect(app.get).toHaveBeenNthCalledWith(
      1,
      '/agent/v1/products/search',
      proxyAgentSearchToBackend,
    );
    expect(app.get).toHaveBeenNthCalledWith(
      2,
      '/agent/v1/beauty/products/search',
      expect.any(Function),
    );
    expect(result).toEqual({
      registerExternalInvokeRoute: expect.any(Function),
      handleAgentProductsSearchViaInvoke: expect.any(Function),
    });
  });
});
