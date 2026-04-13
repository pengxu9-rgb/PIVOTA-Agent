const request = require('supertest');

describe('POST /api/admin/catalog-serving/search', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../src/auroraBff/routes');
    jest.dontMock('../src/services/catalogServingGateway');
    jest.resetModules();
    if (!prevEnv) return;
    if (prevEnv.ADMIN_API_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevEnv.ADMIN_API_KEY;
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED =
        prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('requires admin key', async () => {
    const app = require('../src/server');
    const resp = await request(app).post('/api/admin/catalog-serving/search');

    expect(resp.status).toBe(401);
    expect(resp.body).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED' }));
  });

  test('returns the shadow gateway contract and forwards explicit local-shadow intent', async () => {
    const searchCatalogServingGateway = jest.fn(async () => ({
      contract_version: 'pivota.catalog_serving.gateway.v1',
      gateway_mode: 'shadow',
      shadow_mode: 'allow_local_shadow',
      source: 'local_shadow',
      items: [{ doc_id: 'sellable:sig_1', title: 'Barrier Serum' }],
      cursor_info: {
        next_cursor: 'cursor_1',
        has_next_page: true,
        serving_mode: 'exhaustive',
      },
      applied_filters: {
        query_text: 'barrier serum',
        brand_names: ['KraveBeauty'],
        categories: [],
        market: 'US',
        sort: 'popular',
      },
      available_facets: [],
      debug_metadata: {
        local_shadow_requested: true,
      },
    }));
    jest.doMock('../src/services/catalogServingGateway', () => ({
      searchCatalogServingGateway,
    }));

    const app = require('../src/server');
    const resp = await request(app)
      .post('/api/admin/catalog-serving/search')
      .set('X-ADMIN-KEY', 'admin_test_key')
      .send({
        query_text: 'barrier serum',
        brand_names: ['KraveBeauty'],
        shadow_mode: 'allow_local_shadow',
      });

    expect(resp.status).toBe(200);
    expect(resp.body).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          gateway_mode: 'shadow',
          shadow_mode: 'allow_local_shadow',
          source: 'local_shadow',
        }),
      }),
    );
    expect(searchCatalogServingGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        query_text: 'barrier serum',
        brand_names: ['KraveBeauty'],
        shadow_mode: 'allow_local_shadow',
      }),
    );
  });
});
