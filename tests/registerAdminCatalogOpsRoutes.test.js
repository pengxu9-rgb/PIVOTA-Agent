const { registerAdminCatalogOpsRoutes } = require('../src/registerAdminCatalogOpsRoutes');

function createApp() {
  return {
    get: jest.fn(),
    post: jest.fn(),
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
    send(payload) {
      this.body = payload;
      return payload;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function getRouteHandler(app, method, path) {
  const routeCall = app[method].mock.calls.find((call) => call[0] === path);
  if (!routeCall) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  return routeCall[routeCall.length - 1];
}

describe('registerAdminCatalogOpsRoutes', () => {
  test('registers missing catalog products route with json and csv responses', async () => {
    const app = createApp();
    const listMissingCatalogProducts = jest.fn().mockResolvedValue({
      ok: true,
      rows: [{ merchant_id: 'm_1', product_id: 'p_1' }],
    });
    const missingCatalogProductsToCsv = jest.fn(() => 'merchant_id,product_id\nm_1,p_1\n');
    const requireAdmin = jest.fn((req, res, next) => next());

    registerAdminCatalogOpsRoutes({
      app,
      requireAdmin,
      listMissingCatalogProducts,
      missingCatalogProductsToCsv,
      creatorCatalogAutoSyncEnabled: false,
      adminApiKey: 'admin_key',
      creatorCatalogCacheTtlSeconds: 3600,
      creatorCatalogAutoSyncTimeoutMs: 5000,
      pivotaApiBase: 'http://pivota.test',
      axiosClient: { post: jest.fn() },
      parsePositiveInt: jest.fn(),
      getCreatorCatalogAutoSyncLimitConfig: jest.fn(() => ({ limitEffective: 100 })),
      resolveCatalogSyncMerchantIds: jest.fn(),
      getCatalogSyncSuppressionStatus: jest.fn(() => ({ suppressed: false })),
      catalogSyncState: { per_merchant: {} },
      isCatalogSyncTimeoutError: jest.fn(() => false),
      isCatalogSyncInvalidMerchantError: jest.fn(() => false),
    });

    expect(app.get).toHaveBeenCalledWith(
      '/api/admin/missing-catalog-products',
      requireAdmin,
      expect.any(Function),
    );

    const jsonRes = createRes();
    await getRouteHandler(app, 'get', '/api/admin/missing-catalog-products')(
      { query: { limit: '25', sort: 'cached_at', since: '2026-03-01T00:00:00.000Z' } },
      jsonRes,
    );
    expect(listMissingCatalogProducts).toHaveBeenCalledWith({
      limit: '25',
      offset: undefined,
      sort: 'cached_at',
      since: '2026-03-01T00:00:00.000Z',
    });
    expect(jsonRes.body).toEqual({
      ok: true,
      rows: [{ merchant_id: 'm_1', product_id: 'p_1' }],
    });

    const csvRes = createRes();
    await getRouteHandler(app, 'get', '/api/admin/missing-catalog-products')(
      { query: { format: 'csv' } },
      csvRes,
    );
    expect(missingCatalogProductsToCsv).toHaveBeenCalledWith([{ merchant_id: 'm_1', product_id: 'p_1' }]);
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(csvRes.headers['Content-Disposition']).toMatch(/^attachment; filename="missing_catalog_products_/);
    expect(csvRes.body).toContain('merchant_id,product_id');
  });

  test('catalog sync route fails closed when auto sync is disabled', async () => {
    const app = createApp();
    const requireAdmin = jest.fn((req, res, next) => next());

    registerAdminCatalogOpsRoutes({
      app,
      requireAdmin,
      listMissingCatalogProducts: jest.fn(),
      missingCatalogProductsToCsv: jest.fn(),
      creatorCatalogAutoSyncEnabled: false,
      adminApiKey: 'admin_key',
      creatorCatalogCacheTtlSeconds: 3600,
      creatorCatalogAutoSyncTimeoutMs: 5000,
      pivotaApiBase: 'http://pivota.test',
      axiosClient: { post: jest.fn() },
      parsePositiveInt: jest.fn(() => null),
      getCreatorCatalogAutoSyncLimitConfig: jest.fn(() => ({ limitEffective: 100 })),
      resolveCatalogSyncMerchantIds: jest.fn(),
      getCatalogSyncSuppressionStatus: jest.fn(() => ({ suppressed: false })),
      catalogSyncState: { per_merchant: {} },
      isCatalogSyncTimeoutError: jest.fn(() => false),
      isCatalogSyncInvalidMerchantError: jest.fn(() => false),
    });

    const res = createRes();
    await getRouteHandler(app, 'post', '/api/admin/catalog-sync/run')({ body: {} }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      error: 'CATALOG_SYNC_DISABLED',
      message: 'Creator catalog auto-sync is disabled',
    });
  });

  test('catalog sync route syncs eligible merchants and tracks suppression', async () => {
    const app = createApp();
    const requireAdmin = jest.fn((req, res, next) => next());
    const axiosClient = {
      post: jest.fn().mockResolvedValue({
        status: 202,
        data: { summary: { synced: 3 } },
      }),
    };
    const catalogSyncState = { per_merchant: {}, last_error: null };

    registerAdminCatalogOpsRoutes({
      app,
      requireAdmin,
      listMissingCatalogProducts: jest.fn(),
      missingCatalogProductsToCsv: jest.fn(),
      creatorCatalogAutoSyncEnabled: true,
      adminApiKey: 'admin_key',
      creatorCatalogCacheTtlSeconds: 1800,
      creatorCatalogAutoSyncTimeoutMs: 6500,
      pivotaApiBase: 'http://pivota.test',
      axiosClient,
      parsePositiveInt: jest.fn(() => 12),
      getCreatorCatalogAutoSyncLimitConfig: jest.fn(() => ({ limitEffective: 100 })),
      resolveCatalogSyncMerchantIds: jest.fn().mockResolvedValue({
        merchantIds: ['m_ok', 'm_suppressed'],
        source: 'catalog_auto_sync',
      }),
      getCatalogSyncSuppressionStatus: jest.fn((merchantId) =>
        merchantId === 'm_suppressed'
          ? {
              suppressed: true,
              reason: 'timeout_backoff',
              blocked_until: '2026-03-23T00:00:00.000Z',
              invalid_merchant: false,
            }
          : {
              suppressed: false,
              reason: null,
              blocked_until: null,
              invalid_merchant: false,
            },
      ),
      catalogSyncState,
      isCatalogSyncTimeoutError: jest.fn(() => false),
      isCatalogSyncInvalidMerchantError: jest.fn(() => false),
    });

    const res = createRes();
    await getRouteHandler(app, 'post', '/api/admin/catalog-sync/run')(
      {
        body: {
          limit_override: 12,
        },
      },
      res,
    );

    expect(axiosClient.post).toHaveBeenCalledWith(
      'http://pivota.test/agent/internal/shopify/products/sync/m_ok?limit=12&ttl_seconds=1800',
      null,
      {
        headers: { 'X-ADMIN-KEY': 'admin_key' },
        timeout: 6500,
      },
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toEqual(
      expect.objectContaining({
        ok: true,
        target_source: 'catalog_auto_sync',
        target_count: 2,
        target_eligible_count: 1,
        target_suppressed_count: 1,
        limit_effective: 12,
      }),
    );
    expect(catalogSyncState.target_source).toBe('catalog_auto_sync');
    expect(catalogSyncState.target_suppressed_sample).toEqual([
      {
        merchant_id: 'm_suppressed',
        reason: 'timeout_backoff',
        blocked_until: '2026-03-23T00:00:00.000Z',
        invalid_merchant: false,
      },
    ]);
    expect(catalogSyncState.per_merchant.m_ok).toEqual(
      expect.objectContaining({
        ok: true,
        status: 202,
        summary: { synced: 3 },
      }),
    );
  });
});
