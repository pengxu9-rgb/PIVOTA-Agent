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
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      CREATOR_CATALOG_CACHE_TTL_SECONDS: process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS,
      CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES: process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
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
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
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
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
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
            limit: 3,
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

  test('skips external-only supplement for lookup query when internal cache is empty', async () => {
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
  });
});
