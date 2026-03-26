const {
  registerAdminDiagnosticsRoutes,
} = require('../src/registerAdminDiagnosticsRoutes');

function createApp() {
  return {
    get: jest.fn(),
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

function getRouteHandler(app, path) {
  const routeCall = app.get.mock.calls.find((call) => call[0] === path);
  if (!routeCall) {
    throw new Error(`Route not found: GET ${path}`);
  }
  return routeCall[routeCall.length - 1];
}

describe('registerAdminDiagnosticsRoutes', () => {
  test('registers admin diagnostics routes', () => {
    const app = createApp();
    const requireAdmin = jest.fn((req, res, next) => next());

    registerAdminDiagnosticsRoutes({
      app,
      requireAdmin,
      parseQueryNumber: jest.fn(),
      parseQueryBoolean: jest.fn(),
      shouldUseResolverFirstSearch: jest.fn(),
      isStrongResolverFirstQuery: jest.fn(),
      resolveProductRef: jest.fn(),
      proxySearchResolverTimeoutMs: 1800,
      pivotaApiBase: 'http://pivota.test',
      pivotaApiKey: 'test_key',
      hasDatabase: true,
      creatorCatalogAutoSyncEnabled: true,
      buildCatalogSyncSnapshot: jest.fn(() => ({ ok: true })),
      searchCrossMerchantFromCache: jest.fn(),
      getCreatorCatalogMerchantIds: jest.fn(() => []),
      resolveCatalogSyncMerchantIds: jest.fn(),
      queryDb: jest.fn(),
      buildSellableStatusPredicate: jest.fn(() => 'TRUE'),
      createHashFn: jest.fn(),
      proxySearchResolverFirstEnabled: true,
      proxySearchResolverFirstStrongOnly: true,
      proxySearchResolverFirstDisableAurora: false,
    });

    expect(app.get).toHaveBeenCalledWith(
      '/api/admin/search-diagnostics',
      requireAdmin,
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/api/admin/catalog-cache-diagnostics',
      requireAdmin,
      expect.any(Function),
    );
  });

  test('search diagnostics route fails closed on missing query', async () => {
    const app = createApp();
    const requireAdmin = jest.fn((req, res, next) => next());

    registerAdminDiagnosticsRoutes({
      app,
      requireAdmin,
      parseQueryNumber: jest.fn(),
      parseQueryBoolean: jest.fn(),
      shouldUseResolverFirstSearch: jest.fn(),
      isStrongResolverFirstQuery: jest.fn(),
      resolveProductRef: jest.fn(),
      proxySearchResolverTimeoutMs: 1800,
      pivotaApiBase: 'http://pivota.test',
      pivotaApiKey: 'test_key',
      hasDatabase: true,
      creatorCatalogAutoSyncEnabled: true,
      buildCatalogSyncSnapshot: jest.fn(() => ({ ok: true })),
      searchCrossMerchantFromCache: jest.fn(),
      getCreatorCatalogMerchantIds: jest.fn(() => []),
      resolveCatalogSyncMerchantIds: jest.fn(),
      queryDb: jest.fn(),
      buildSellableStatusPredicate: jest.fn(() => 'TRUE'),
      createHashFn: jest.fn(),
      proxySearchResolverFirstEnabled: true,
      proxySearchResolverFirstStrongOnly: true,
      proxySearchResolverFirstDisableAurora: false,
    });

    const res = createRes();
    await getRouteHandler(app, '/api/admin/search-diagnostics')({ query: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'MISSING_QUERY',
      message: 'Provide q or query parameter',
    });
  });

  test('search diagnostics route returns resolver and cache view', async () => {
    const app = createApp();
    const requireAdmin = jest.fn((req, res, next) => next());
    const resolveProductRef = jest
      .fn()
      .mockResolvedValueOnce({
        resolved: true,
        reason: 'stable_alias_match',
        product_ref: { merchant_id: 'm_1', product_id: 'p_1' },
        confidence: 1,
        metadata: { latency_ms: 4, sources: [{ source: 'stable_alias_ref', ok: true }] },
      })
      .mockResolvedValueOnce({
        resolved: false,
        reason: 'no_candidates',
        product_ref: null,
        confidence: 0,
        metadata: { latency_ms: 7, sources: [{ source: 'products_cache_global', ok: false }] },
      });

    registerAdminDiagnosticsRoutes({
      app,
      requireAdmin,
      parseQueryNumber: jest.fn(() => 3),
      parseQueryBoolean: jest.fn(() => true),
      shouldUseResolverFirstSearch: jest.fn(() => true),
      isStrongResolverFirstQuery: jest.fn(() => true),
      resolveProductRef,
      proxySearchResolverTimeoutMs: 1800,
      pivotaApiBase: 'http://pivota.test',
      pivotaApiKey: 'test_key',
      hasDatabase: true,
      creatorCatalogAutoSyncEnabled: true,
      buildCatalogSyncSnapshot: jest.fn(() => ({ last_run_at: '2026-03-22T00:00:00.000Z' })),
      searchCrossMerchantFromCache: jest.fn().mockResolvedValue({
        total: 1,
        retrieval_sources: ['products_cache_global'],
        products: [
          {
            product_id: 'p_1',
            merchant_id: 'm_1',
            title: 'IPSA Time Reset Aqua',
            status: 'published',
          },
        ],
      }),
      getCreatorCatalogMerchantIds: jest.fn(() => []),
      resolveCatalogSyncMerchantIds: jest.fn(),
      queryDb: jest.fn(),
      buildSellableStatusPredicate: jest.fn(() => 'TRUE'),
      createHashFn: jest.fn(),
      proxySearchResolverFirstEnabled: true,
      proxySearchResolverFirstStrongOnly: true,
      proxySearchResolverFirstDisableAurora: false,
    });

    const res = createRes();
    await getRouteHandler(app, '/api/admin/search-diagnostics')(
      { query: { q: 'ipsa', in_stock_only: 'true' } },
      res,
    );

    expect(resolveProductRef).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        query: 'ipsa',
        config: expect.objectContaining({
          resolver_first_enabled: true,
          resolver_first_strong_only: true,
          resolver_first_disable_aurora: false,
          resolver_first_would_apply: true,
          resolver_query_is_strong: true,
          db_configured: true,
        }),
        resolver: expect.objectContaining({
          alias_dependency: true,
        }),
        cross_merchant_cache: expect.objectContaining({
          ok: true,
          total: 1,
          products_count: 1,
        }),
      }),
    );
  });

  test('catalog cache diagnostics route fails closed when db is missing', async () => {
    const app = createApp();
    const requireAdmin = jest.fn((req, res, next) => next());

    registerAdminDiagnosticsRoutes({
      app,
      requireAdmin,
      parseQueryNumber: jest.fn(),
      parseQueryBoolean: jest.fn(),
      shouldUseResolverFirstSearch: jest.fn(),
      isStrongResolverFirstQuery: jest.fn(),
      resolveProductRef: jest.fn(),
      proxySearchResolverTimeoutMs: 1800,
      pivotaApiBase: 'http://pivota.test',
      pivotaApiKey: 'test_key',
      hasDatabase: false,
      creatorCatalogAutoSyncEnabled: true,
      buildCatalogSyncSnapshot: jest.fn(() => ({ ok: true })),
      searchCrossMerchantFromCache: jest.fn(),
      getCreatorCatalogMerchantIds: jest.fn(() => []),
      resolveCatalogSyncMerchantIds: jest.fn(),
      queryDb: jest.fn(),
      buildSellableStatusPredicate: jest.fn(() => 'TRUE'),
      createHashFn: jest.fn(),
      proxySearchResolverFirstEnabled: true,
      proxySearchResolverFirstStrongOnly: true,
      proxySearchResolverFirstDisableAurora: false,
    });

    const res = createRes();
    await getRouteHandler(app, '/api/admin/catalog-cache-diagnostics')(
      { query: { q: 'ipsa' } },
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      error: 'DB_NOT_CONFIGURED',
      message: 'DATABASE_URL is not configured on gateway',
    });
  });
});
