const nock = require('nock');

describe('Aurora commerce core search contracts', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    prevEnv = {
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
      AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS: process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS,
      AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE: process.env.AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE,
      AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED: process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED,
    };
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS = 'http://catalog.test';
    process.env.AURORA_BFF_RECO_CATALOG_MULTI_SOURCE_ENABLED = 'false';
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    jest.resetModules();
    if (!prevEnv) return;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('aurora-bff main-path retrieval defaults to shopping-agent downstream source', async () => {
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE = 'aurora-bff';

    const seen = [];
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        seen.push({ ...q });
        return String(q.query || '') === 'serum' && String(q.source || '') === 'shopping-agent';
      })
      .reply(200, {
        ok: true,
        products: [{ product_id: 'aurora_serum_1', title: 'Aurora Serum' }],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.searchPivotaBackendProducts({
      query: 'serum',
      logger: { warn: jest.fn(), info: jest.fn() },
      timeoutMs: 1200,
    });

    expect(out.ok).toBe(true);
    expect(out.search_source).toBe('shopping-agent');
    expect(seen[0].source).toBe('shopping-agent');
  });

  test('aurora-bff can explicitly align downstream retrieval to shopping_agent semantics', async () => {
    process.env.AURORA_BFF_RECO_CATALOG_SEARCH_SOURCE = 'aurora-bff';

    const seen = [];
    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        seen.push({ ...q });
        return String(q.query || '') === 'serum' && String(q.source || '') === 'shopping_agent';
      })
      .reply(200, {
        ok: true,
        products: [{ product_id: 'shopping_agent_serum_1', title: 'Shopping Agent Serum' }],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.searchPivotaBackendProducts({
      query: 'serum',
      searchSourceOverride: 'shopping_agent',
      logger: { warn: jest.fn(), info: jest.fn() },
      timeoutMs: 1200,
    });

    expect(out.ok).toBe(true);
    expect(out.search_source).toBe('shopping_agent');
    expect(seen[0].source).toBe('shopping_agent');
  });

  test('aurora child transport preserves local mainline child metadata', async () => {
    const seen = [];
    const semanticContract = {
      planner_mode: 'step_aware',
      target_step_family: 'serum',
      semantic_family: 'serum',
    };

    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        seen.push({ ...q });
        return (
          String(q.query || '') === 'niacinamide serum under 30' &&
          String(q.source || '') === 'shopping-agent' &&
          String(q.local_mainline_child || '') === 'true' &&
          String(q.query_index || '') === '2' &&
          String(q.query_total || '') === '5' &&
          JSON.parse(String(q.semantic_contract || '{}')).target_step_family === 'serum'
        );
      })
      .reply(200, {
        ok: true,
        products: [{ product_id: 'serum_child_1', title: 'Serum Child Result' }],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.searchPivotaBackendProducts({
      query: 'niacinamide serum under 30',
      semanticContract,
      queryIndex: 2,
      queryTotal: 5,
      localMainlineChild: true,
      logger: { warn: jest.fn(), info: jest.fn() },
      timeoutMs: 1200,
    });

    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
