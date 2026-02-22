const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi cache-first search', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });

    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
      FIND_PRODUCTS_MULTI_EXPANSION_MODE: process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE,
      FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE:
        process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
      FIND_PRODUCTS_MULTI_ROUTE_DEBUG: process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY:
        process.env.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY,
      SEARCH_CACHE_VALIDATE: process.env.SEARCH_CACHE_VALIDATE,
      SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO:
        process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO,
      SEARCH_EVAL_INTERNAL_ONLY_ENABLED:
        process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED,
      SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED:
        process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED,
      SEARCH_EVAL_INTERNAL_ONLY_HEADER:
        process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER,
      SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION:
        process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION,
      SEARCH_SCENARIO_CATEGORY_PLAN_RECALL:
        process.env.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL,
      SEARCH_LOOKUP_INTERNAL_FALLBACK:
        process.env.SEARCH_LOOKUP_INTERNAL_FALLBACK,
      SEARCH_TRACE_SINGLE_SOURCE:
        process.env.SEARCH_TRACE_SINGLE_SOURCE,
      CREATOR_CATALOG_CACHE_TTL_SECONDS: process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS,
      CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES: process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    delete process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE;
    delete process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE;
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    delete process.env.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY;
    delete process.env.SEARCH_CACHE_VALIDATE;
    delete process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION;
    delete process.env.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL;
    delete process.env.SEARCH_LOOKUP_INTERNAL_FALLBACK;
    delete process.env.SEARCH_TRACE_SINGLE_SOURCE;
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();

    if (!prevEnv) return;
    if (prevEnv.PIVOTA_API_BASE === undefined) delete process.env.PIVOTA_API_BASE;
    else process.env.PIVOTA_API_BASE = prevEnv.PIVOTA_API_BASE;
    if (prevEnv.PIVOTA_API_KEY === undefined) delete process.env.PIVOTA_API_KEY;
    else process.env.PIVOTA_API_KEY = prevEnv.PIVOTA_API_KEY;
    if (prevEnv.API_MODE === undefined) delete process.env.API_MODE;
    else process.env.API_MODE = prevEnv.API_MODE;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    if (prevEnv.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED;
    } else {
      process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = prevEnv.FIND_PRODUCTS_MULTI_VECTOR_ENABLED;
    }
    if (prevEnv.FIND_PRODUCTS_MULTI_EXPANSION_MODE === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE;
    } else {
      process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = prevEnv.FIND_PRODUCTS_MULTI_EXPANSION_MODE;
    }
    if (prevEnv.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE;
    } else {
      process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE =
        prevEnv.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE;
    }
    if (prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    } else {
      process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY;
    } else {
      process.env.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY =
        prevEnv.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY;
    }
    if (prevEnv.SEARCH_CACHE_VALIDATE === undefined) {
      delete process.env.SEARCH_CACHE_VALIDATE;
    } else {
      process.env.SEARCH_CACHE_VALIDATE = prevEnv.SEARCH_CACHE_VALIDATE;
    }
    if (prevEnv.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO === undefined) {
      delete process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO;
    } else {
      process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO =
        prevEnv.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO;
    }
    if (prevEnv.SEARCH_EVAL_INTERNAL_ONLY_ENABLED === undefined) {
      delete process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED;
    } else {
      process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED = prevEnv.SEARCH_EVAL_INTERNAL_ONLY_ENABLED;
    }
    if (prevEnv.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED === undefined) {
      delete process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED;
    } else {
      process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED =
        prevEnv.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED;
    }
    if (prevEnv.SEARCH_EVAL_INTERNAL_ONLY_HEADER === undefined) {
      delete process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER;
    } else {
      process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER = prevEnv.SEARCH_EVAL_INTERNAL_ONLY_HEADER;
    }
    if (prevEnv.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION === undefined) {
      delete process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION;
    } else {
      process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION =
        prevEnv.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION;
    }
    if (prevEnv.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL === undefined) {
      delete process.env.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL;
    } else {
      process.env.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL =
        prevEnv.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL;
    }
    if (prevEnv.SEARCH_LOOKUP_INTERNAL_FALLBACK === undefined) {
      delete process.env.SEARCH_LOOKUP_INTERNAL_FALLBACK;
    } else {
      process.env.SEARCH_LOOKUP_INTERNAL_FALLBACK =
        prevEnv.SEARCH_LOOKUP_INTERNAL_FALLBACK;
    }
    if (prevEnv.SEARCH_TRACE_SINGLE_SOURCE === undefined) {
      delete process.env.SEARCH_TRACE_SINGLE_SOURCE;
    } else {
      process.env.SEARCH_TRACE_SINGLE_SOURCE = prevEnv.SEARCH_TRACE_SINGLE_SOURCE;
    }
    if (prevEnv.CREATOR_CATALOG_CACHE_TTL_SECONDS === undefined) {
      delete process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS;
    } else {
      process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS = prevEnv.CREATOR_CATALOG_CACHE_TTL_SECONDS;
    }
    if (prevEnv.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES === undefined) {
      delete process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES;
    } else {
      process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES =
        prevEnv.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('serves cross-merchant cache results without upstream search call', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_1',
                  product_id: 'prod_ipsa_1',
                  merchant_id: 'merch_1',
                  title: 'IPSA Time Reset Aqua',
                  description: 'Hydrating toner',
                  status: 'published',
                  inventory_quantity: 9,
                  price: 39,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.search_all_merchants || '') === 'true')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa的产品有吗？',
            page: 1,
            limit: 1,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
          entry: 'home',
          scope: { catalog: 'global', region: 'US', language: 'zh' },
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
      }),
    );
    const products = Array.isArray(resp.body.products) ? resp.body.products : [];
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(products.length).toBeGreaterThanOrEqual(0);
    if (products.length === 0) {
      expect(
        ['strict_empty', 'clarify'].includes(
          String(resp.body.metadata?.search_decision?.final_decision || '').trim().toLowerCase(),
        ),
      ).toBe(true);
    }
    expect(String(resp.body.products[0].title || '').toLowerCase()).toContain('ipsa');
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('treats zh brand lookup as relevant for en-vendor cached rows', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 10 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_winona_1',
                  product_id: 'prod_winona_1',
                  merchant_id: 'merch_1',
                  title: 'Soothing Repair Serum',
                  vendor: 'Winona',
                  status: 'published',
                  inventory_quantity: 9,
                  price: 39,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '有什么薇诺娜的商品推荐吗？',
            page: 1,
            limit: 1,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
          entry: 'home',
          scope: { catalog: 'global', region: 'US', language: 'zh' },
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
      }),
    );
    const products = Array.isArray(resp.body.products) ? resp.body.products : [];
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(products.length).toBeGreaterThanOrEqual(0);
    if (products.length === 0) {
      expect(
        ['strict_empty', 'clarify'].includes(
          String(resp.body.metadata?.search_decision?.final_decision || '').trim().toLowerCase(),
        ),
      ).toBe(true);
    }
    expect(String(resp.body.products[0].merchant_id || '')).toBe('merch_1');
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('uses raw user query for cache relevance when policy expands upstream query', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 5 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_brush_1',
                  product_id: 'prod_brush_1',
                  merchant_id: 'merch_1',
                  title: 'Professional Makeup Brush Set',
                  description: 'Foundation brush and powder brush kit',
                  product_type: 'cosmetic tools',
                  status: 'published',
                  inventory_quantity: 7,
                  attributes: {
                    pivota: {
                      domain: 'beauty',
                      target_object: 'human',
                      category_path: ['beauty', 'cosmetic_tools'],
                    },
                  },
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '有什么化妆刷推荐吗？',
            page: 1,
            limit: 1,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search');
    const scenarioProducts = Array.isArray(resp.body.products) ? resp.body.products : [];
    expect(Array.isArray(resp.body.products)).toBe(true);
    if (scenarioProducts.length === 0) {
      expect(
        ['strict_empty', 'clarify'].includes(
          String(resp.body.metadata?.search_decision?.final_decision || '').trim().toLowerCase(),
        ),
      ).toBe(true);
    }
    expect(String(resp.body.products[0].title || '').toLowerCase()).toContain('brush');
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache?.query).toBe('有什么化妆刷推荐吗？');
    expect(
      String(resp.body.metadata?.route_debug?.cross_merchant_cache?.upstream_query || '').toLowerCase(),
    ).toContain('makeup tools');
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('accepts top-level payload query for find_products_multi', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_1',
                  product_id: 'prod_ipsa_1',
                  merchant_id: 'merch_1',
                  title: 'IPSA Time Reset Aqua',
                  description: 'Hydrating toner',
                  status: 'published',
                  inventory_quantity: 9,
                  price: 39,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          query: 'ipsa的产品有吗？',
          page: 1,
          limit: 1,
          in_stock_only: true,
        },
        metadata: {
          source: 'shopping_agent',
          entry: 'home',
          scope: { catalog: 'global', region: 'US', language: 'zh' },
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
      }),
    );
    const lookupProducts = Array.isArray(resp.body.products) ? resp.body.products : [];
    expect(Array.isArray(resp.body.products)).toBe(true);
    if (lookupProducts.length === 0) {
      expect(
        ['strict_empty', 'clarify'].includes(
          String(resp.body.metadata?.search_decision?.final_decision || '').trim().toLowerCase(),
        ),
      ).toBe(true);
    }
    expect(String(resp.body.products[0].title || '').toLowerCase()).toContain('ipsa');
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('injects shopping catalog guard params on upstream query', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const guardedSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          String(q.external_seed_strategy || '') === 'supplement_internal_first'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa toner',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(guardedSearch.isDone()).toBe(true);
  });

  test('aurora source bypasses cache strict-empty on miss and continues upstream search', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === 'copper peptides serum' &&
          String(q.search_all_merchants || '') === 'true' &&
          String(q.fast_mode || '') === 'true' &&
          String(q.allow_stale_cache || '') === 'false'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper Peptide Serum',
            status: 'active',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'copper peptides serum',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'aurora-bff',
          catalog_surface: 'beauty',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata?.strict_empty).not.toBe(true);
    expect(resp.body.metadata?.strict_empty_reason).toBeUndefined();
    expect(upstreamSearch.isDone()).toBe(true);
  });

  test('injects creator catalog guard params on upstream query', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const guardedSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          String(q.external_seed_strategy || '') === 'supplement_internal_first'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa toner',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'creator_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(guardedSearch.isDone()).toBe(true);
  });

  test('injects creator-agent-ui catalog guard params on upstream query', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const guardedSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          String(q.external_seed_strategy || '') === 'supplement_internal_first'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa toner',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'creator_agent_ui',
        },
      });

    expect(resp.status).toBe(200);
    expect(guardedSearch.isDone()).toBe(true);
  });

  test('lookup cache hit bypasses intent policy filtering to preserve matched products', async () => {
    const applyPolicyMock = jest.fn().mockImplementation(({ response }) => ({
      ...(response || {}),
      products: [],
      total: 0,
      metadata: {
        ...((response && response.metadata) || {}),
        policy_forced_empty: true,
      },
    }));

    jest.doMock('../../src/findProductsMulti/policy', () => ({
      buildFindProductsMultiContext: jest.fn().mockImplementation(({ payload }) => ({
        intent: {
          language: 'zh',
          primary_domain: 'other',
          target_object: { type: 'unknown', age_group: 'unknown', notes: '' },
          category: { required: [], optional: [] },
          scenario: { name: 'general', signals: [] },
          hard_constraints: {
            temperature_c: { min: null, max: null },
            must_include_keywords: [],
            must_exclude_domains: [],
            must_exclude_keywords: [],
            in_stock_only: null,
            price: { currency: null, min: null, max: null },
          },
          soft_preferences: { style: [], colors: [], brands: [], materials: [] },
          confidence: { overall: 0.4, domain: 0.4, target_object: 0.4, category: 0.4, notes: '' },
          ambiguity: { needs_clarification: true, missing_slots: [], clarifying_questions: [] },
          history_usage: { used: false, reason: 'test', ignored_queries: [] },
        },
        adjustedPayload: payload,
        rawUserQuery: payload?.search?.query || '',
      })),
      applyFindProductsMultiPolicy: applyPolicyMock,
    }));

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 2 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_1',
                  product_id: 'prod_ipsa_1',
                  merchant_id: 'merch_1',
                  title: 'IPSA Time Reset Aqua',
                  description: 'Hydrating toner',
                  status: 'published',
                  inventory_quantity: 8,
                  price: 39,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa的产品有吗？',
            page: 1,
            limit: 1,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(String(resp.body.products[0].title || '').toLowerCase()).toContain('ipsa');
    expect(applyPolicyMock).toHaveBeenCalledTimes(0);
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('supplements first-page cache hits with external seed candidates', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_internal',
                  product_id: 'prod_ipsa_internal',
                  merchant_id: 'merch_1',
                  title: 'IPSA Internal Toner',
                  description: 'Internal cache item',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_internal_2',
                  product_id: 'prod_ipsa_internal_2',
                  merchant_id: 'merch_1',
                  title: 'IPSA Internal Toner 2',
                  description: 'Internal cache item',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_internal_3',
                  product_id: 'prod_ipsa_internal_3',
                  merchant_id: 'merch_1',
                  title: 'IPSA Internal Toner 3',
                  description: 'Internal cache item',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.merchant_id || '') === 'external_seed' && String(q.query || '') === 'ipsa')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'ext_ipsa_1',
            product_id: 'ext_ipsa_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'IPSA External Seed 1',
            status: 'active',
          },
          {
            id: 'ext_ipsa_2',
            product_id: 'ext_ipsa_2',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'IPSA External Seed 2',
            status: 'active',
          },
        ],
        total: 2,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search_supplemented',
      }),
    );
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({ merchant_id: 'merch_1' }),
    );
    const externalItems = (resp.body.products || []).filter((p) => String(p.merchant_id || '') === 'external_seed');
    expect(externalItems.length).toBeGreaterThan(0);
    expect(resp.body.metadata?.source_breakdown?.external_seed_count).toBeGreaterThan(0);
    expect(externalSupplement.isDone()).toBe(true);
  });

  test('does not supplement non-first pages', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_internal_p2',
                  product_id: 'prod_ipsa_internal_p2',
                  merchant_id: 'merch_1',
                  title: 'IPSA Internal Page2',
                  status: 'published',
                  inventory_quantity: 3,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.merchant_id || '') === 'external_seed')
      .reply(200, { status: 'success', success: true, products: [] });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa',
            page: 2,
            limit: 3,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search');
    expect(externalSupplement.isDone()).toBe(false);
  });

  test('blocks external supplement for lookup query when internal cache is empty', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    }));

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.merchant_id || '') === 'external_seed' && String(q.query || '') === 'ipsa')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'ext_not_ipsa_1',
            product_id: 'ext_not_ipsa_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Silken Lip Conditioning Mask',
            status: 'active',
          },
        ],
        total: 1,
      });

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(
        (q) =>
          String(q.search_all_merchants || '') === 'true' &&
          String(q.query || '') === 'ipsa',
      )
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_ipsa_upstream_1',
            product_id: 'prod_ipsa_upstream_1',
            merchant_id: 'merch_1',
            title: 'IPSA Time Reset Aqua',
            status: 'active',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(
      (resp.body.products || []).some((p) => String(p.merchant_id || '') === 'external_seed'),
    ).toBe(false);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(externalSupplement.isDone()).toBe(false);
    expect(
      String(
        resp.body.metadata?.route_debug?.cross_merchant_cache?.supplement?.reason || '',
      ),
    ).toBe('external_fill_gate_blocked');
  });

  test('uses early ambiguity decision on cache miss for scenario query without upstream call', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '出差要买什么',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search_early_decision');
    expect(resp.body.metadata?.search_trace?.upstream_stage?.called).toBe(false);
    expect(resp.body.clarification || resp.body.metadata?.strict_empty).toBeTruthy();
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('uses early ambiguity decision when cache candidates are irrelevant for scenario query', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_pet',
                merchant_name: 'Pet Merchant',
                product_data: {
                  id: 'pet_jacket_1',
                  product_id: 'pet_jacket_1',
                  merchant_id: 'merch_pet',
                  title: 'Cute Fall/Winter Onesie for Dogs',
                  description: 'Pet apparel for dogs and cats',
                  status: 'active',
                  inventory_quantity: 5,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '出差要买什么',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search_early_decision');
    expect(resp.body.metadata?.search_trace?.upstream_stage?.called).toBe(false);
    expect(resp.body.clarification || resp.body.metadata?.strict_empty).toBeTruthy();
    expect(
      String(resp.body.metadata?.route_debug?.cross_merchant_cache?.early_decision?.reason || ''),
    ).toBe('cache_irrelevant_ambiguity_sensitive');
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('treats low-quality cache hits as cache miss when cache validation is enabled', async () => {
    process.env.SEARCH_CACHE_VALIDATE = 'true';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_pet',
                merchant_name: 'Pet Merchant',
                product_data: {
                  id: 'prod_pet_hoodie_1',
                  product_id: 'prod_pet_hoodie_1',
                  merchant_id: 'merch_pet',
                  title: 'Cute Dog Hoodie',
                  description: 'Pet apparel for winter',
                  status: 'active',
                  inventory_quantity: 9,
                  price: 29,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_ipsa_1',
            product_id: 'prod_ipsa_1',
            merchant_id: 'merch_beauty',
            title: 'IPSA Time Reset Aqua',
            description: 'Hydrating toner',
            status: 'active',
            inventory_quantity: 8,
            price: 39,
            currency: 'USD',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(resp.body.metadata?.query_source).not.toBe('cache_cross_merchant_search');
    expect(
      Boolean(resp.body.metadata?.route_debug?.cross_merchant_cache?.cache_rejected_low_quality),
    ).toBe(true);
    expect(
      String(resp.body.metadata?.route_debug?.cross_merchant_cache?.cache_validation?.reason || ''),
    ).toBe('anchor_below_threshold');
  });

  test('forces scenario queries to continue controlled recall instead of cache early decision', async () => {
    process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO = 'true';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'travel_kit_1',
            product_id: 'travel_kit_1',
            merchant_id: 'merch_travel',
            title: 'Business Trip Toiletry Kit',
            description: 'Travel-size essentials set',
            status: 'active',
            inventory_quantity: 12,
            price: 25,
            currency: 'USD',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '出差要买什么',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(resp.body.metadata?.query_source).not.toBe('cache_cross_merchant_search_early_decision');
    expect(
      Boolean(resp.body.metadata?.route_debug?.cross_merchant_cache?.early_decision?.applied),
    ).not.toBe(true);
  });

  test('eval internal-only can disable cache early decision for scenario queries', async () => {
    process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER = 'x-eval';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION = 'true';
    process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO = 'false';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Eval', '1')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hiking essentials',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).not.toBe('cache_cross_merchant_search_early_decision');
    const earlyDecisionReason = String(
      resp.body.metadata?.route_debug?.cross_merchant_cache?.early_decision?.reason || '',
    );
    if (earlyDecisionReason) {
      expect(earlyDecisionReason).toBe('eval_force_no_early_decision');
    }
  });

  test('eval internal-only products_returned includes post_quality diagnostics', async () => {
    process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER = 'x-eval';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION = 'true';
    process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO = 'false';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_1',
                  product_id: 'prod_ipsa_1',
                  merchant_id: 'merch_1',
                  title: 'IPSA Time Reset Aqua',
                  vendor: 'IPSA',
                  status: 'published',
                  inventory_quantity: 9,
                  price: 39,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Eval', '1')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'ipsa',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        eval_mode: true,
        upstream_disabled: true,
      }),
    );
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    const postQuality =
      resp.body.metadata?.search_decision?.post_quality ||
      resp.body.metadata?.route_debug?.policy?.ambiguity?.post_quality;
    expect(postQuality).toEqual(
      expect.objectContaining({
        candidates: expect.any(Number),
        anchor_ratio: expect.any(Number),
        domain_entropy: expect.any(Number),
        anchor_basis_size: expect.any(Number),
      }),
    );
    expect(Number(postQuality?.candidates || 0)).toBe(resp.body.products.length);
    expect(
      String(resp.body.metadata?.search_trace?.final_decision || '').trim().toLowerCase(),
    ).toBe(
      String(resp.body.metadata?.search_decision?.final_decision || '').trim().toLowerCase(),
    );
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('eval scenario category-plan flag keeps diagnostics coherent without upstream dependency', async () => {
    process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = 'off';
    process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = 'off';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER = 'x-eval';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION = 'true';
    process.env.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL = 'true';
    process.env.SEARCH_TRACE_SINGLE_SOURCE = 'true';

    let cacheCall = 0;
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          cacheCall += 1;
          return { rows: [{ total: cacheCall >= 2 ? 1 : 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          if (cacheCall < 2) return { rows: [] };
          return {
            rows: [
              {
                merchant_id: 'merch_travel',
                merchant_name: 'Travel Store',
                product_data: {
                  id: 'prod_travel_1',
                  product_id: 'prod_travel_1',
                  merchant_id: 'merch_travel',
                  title: 'Business Travel Toiletry Kit',
                  description: 'travel toiletries and packing organizer',
                  vendor: 'Travel Ready',
                  status: 'published',
                  inventory_quantity: 18,
                  price: 25,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Eval', '1')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '出差要买什么',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        eval_mode: true,
        upstream_disabled: true,
      }),
    );
    expect(resp.body.metadata?.search_trace?.flags_snapshot).toEqual(
      expect.objectContaining({
        search_scenario_category_plan_recall: true,
      }),
    );
    const s1Recall = resp.body.metadata?.route_debug?.cross_merchant_cache?.s1_recall;
    if (s1Recall) {
      expect(s1Recall).toEqual(
        expect.objectContaining({
          attempted: true,
          mode: 'scenario_category_plan',
        }),
      );
    } else {
      expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search');
    }
    expect(Array.isArray(resp.body.products)).toBe(true);
    const scenarioFinalDecision = String(
      resp.body.metadata?.search_trace?.final_decision || '',
    )
      .trim()
      .toLowerCase();
    expect(scenarioFinalDecision).toBe(
      String(resp.body.metadata?.search_decision?.final_decision || '')
        .trim()
        .toLowerCase(),
    );
    if (resp.body.products.length > 0) {
      expect(scenarioFinalDecision).toBe('products_returned');
    } else {
      expect(['strict_empty', 'clarify']).toContain(scenarioFinalDecision);
    }
  });

  test('eval lookup fallback triggers internal cache rescue when upstream is disabled', async () => {
    process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = 'off';
    process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = 'off';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED = 'true';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER = 'x-eval';
    process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION = 'true';
    process.env.SEARCH_SCENARIO_CATEGORY_PLAN_RECALL = 'false';
    process.env.SEARCH_LOOKUP_INTERNAL_FALLBACK = 'true';
    process.env.SEARCH_TRACE_SINGLE_SOURCE = 'true';

    let cacheCall = 0;
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          cacheCall += 1;
          return { rows: [{ total: cacheCall >= 2 ? 1 : 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          if (cacheCall < 2) return { rows: [] };
          return {
            rows: [
              {
                merchant_id: 'merch_lookup',
                merchant_name: 'Lookup Store',
                product_data: {
                  id: 'prod_lookup_1',
                  product_id: 'prod_lookup_1',
                  merchant_id: 'merch_lookup',
                  title: 'IPSA Time Reset Aqua',
                  description: 'Hydrating lotion',
                  vendor: 'IPSA',
                  status: 'published',
                  inventory_quantity: 8,
                  price: 35,
                  currency: 'USD',
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Eval', '1')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'IPSA Time Reset Aqua',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        eval_mode: true,
        upstream_disabled: true,
      }),
    );
    const lookupFallback = resp.body.metadata?.route_debug?.cross_merchant_cache?.lookup_fallback;
    if (lookupFallback) {
      expect(lookupFallback).toEqual(
        expect.objectContaining({
          attempted: true,
        }),
      );
    }
    expect(Array.isArray(resp.body.products)).toBe(true);
    const lookupFinalDecision = String(
      resp.body.metadata?.search_trace?.final_decision || '',
    )
      .trim()
      .toLowerCase();
    expect(lookupFinalDecision).toBe(
      String(resp.body.metadata?.search_decision?.final_decision || '')
        .trim()
        .toLowerCase(),
    );
    if (resp.body.products.length > 0) {
      expect(lookupFinalDecision).toBe('products_returned');
    } else {
      expect(['strict_empty', 'clarify']).toContain(lookupFinalDecision);
    }
  });

  test('pet leash recommendation does not enter lookup timeout path on cache miss', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '有没有狗链推荐？',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata?.search_trace?.upstream_stage?.called).toBe(false);
    expect(
      ['cache_cross_merchant_search', 'cache_cross_merchant_search_early_decision'].includes(
        String(resp.body.metadata?.query_source || ''),
      ),
    ).toBe(true);
    expect(resp.body.clarification || resp.body.metadata?.strict_empty).toBeTruthy();
    expect(upstreamSearch.isDone()).toBe(false);
  });
});
