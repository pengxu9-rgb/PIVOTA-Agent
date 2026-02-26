const request = require('supertest');

describe('POST /api/admin/catalog-sync/run', () => {
  const buildAxiosMock = (postImpl) => {
    const axiosFn = jest.fn(async () => ({ data: {} }));
    axiosFn.post = postImpl;
    axiosFn.defaults = {};
    axiosFn.create = jest.fn(() => ({
      request: jest.fn(async () => ({ data: {} })),
    }));
    return axiosFn;
  };

  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      CREATOR_CATALOG_AUTO_SYNC_ENABLED: process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED,
      CREATOR_CATALOG_AUTO_SYNC_LIMIT: process.env.CREATOR_CATALOG_AUTO_SYNC_LIMIT,
      CREATOR_CATALOG_SYNC_ADMIN_KEY: process.env.CREATOR_CATALOG_SYNC_ADMIN_KEY,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.CREATOR_CATALOG_AUTO_SYNC_ENABLED = 'true';
    process.env.CREATOR_CATALOG_AUTO_SYNC_LIMIT = '5000';
    process.env.CREATOR_CATALOG_SYNC_ADMIN_KEY = 'sync_admin_key';
    process.env.PIVOTA_API_BASE = 'https://example-pivota.test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('axios');
    jest.resetModules();
    if (!prevEnv) return;

    const restore = (key) => {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    };

    restore('ADMIN_API_KEY');
    restore('CREATOR_CATALOG_AUTO_SYNC_ENABLED');
    restore('CREATOR_CATALOG_AUTO_SYNC_LIMIT');
    restore('CREATOR_CATALOG_SYNC_ADMIN_KEY');
    restore('PIVOTA_API_BASE');
    restore('AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED');
  });

  test('requires admin key', async () => {
    const app = require('../src/server');
    const resp = await request(app).post('/api/admin/catalog-sync/run');

    expect(resp.status).toBe(401);
    expect(resp.body).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED' }));
  });

  test('runs scoped sync with limit override', async () => {
    const axiosPost = jest.fn().mockResolvedValue({
      status: 200,
      data: { summary: { productsFetched: 1200, productsUpserted: 1200, nextPageToken: null } },
    });
    jest.doMock('axios', () => buildAxiosMock(axiosPost));

    const app = require('../src/server');
    const resp = await request(app)
      .post('/api/admin/catalog-sync/run')
      .set('X-ADMIN-KEY', 'admin_test_key')
      .send({
        merchant_id: 'merch_efbc46b4619cfbdf',
        limit_override: 1200,
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        ok: true,
        requested: expect.objectContaining({
          merchant_id: 'merch_efbc46b4619cfbdf',
          limit_override: 1200,
          ignore_suppression: false,
        }),
        result: expect.objectContaining({
          ok: true,
          trigger_source: 'admin_manual',
          target_count: 1,
          target_eligible_count: 1,
          limit_effective: 1200,
        }),
      }),
    );
    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost.mock.calls[0][0]).toContain(
      '/agent/internal/shopify/products/sync/merch_efbc46b4619cfbdf?limit=1200&ttl_seconds=604800',
    );
    expect(axiosPost.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        headers: { 'X-ADMIN-KEY': 'sync_admin_key' },
      }),
    );
  });
});
