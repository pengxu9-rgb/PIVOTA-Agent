const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi clarify', () => {
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
      FIND_PRODUCTS_MULTI_ROUTE_DEBUG: process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      SEARCH_AMBIGUITY_GATE_ENABLED: process.env.SEARCH_AMBIGUITY_GATE_ENABLED,
      SEARCH_CLARIFY_ON_MEDIUM_AMBIGUITY: process.env.SEARCH_CLARIFY_ON_MEDIUM_AMBIGUITY,
      SEARCH_AMBIGUITY_THRESHOLD_CLARIFY: process.env.SEARCH_AMBIGUITY_THRESHOLD_CLARIFY,
      SEARCH_AMBIGUITY_THRESHOLD_STRICT_EMPTY: process.env.SEARCH_AMBIGUITY_THRESHOLD_STRICT_EMPTY,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.SEARCH_AMBIGUITY_GATE_ENABLED = 'true';
    process.env.SEARCH_CLARIFY_ON_MEDIUM_AMBIGUITY = 'true';
    process.env.SEARCH_AMBIGUITY_THRESHOLD_CLARIFY = '0.3';
    process.env.SEARCH_AMBIGUITY_THRESHOLD_STRICT_EMPTY = '0.95';
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();

    Object.entries(prevEnv || {}).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  test('returns clarification instead of strict-empty when ambiguity is medium', async () => {
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
                  id: 'prod_generic_1',
                  product_id: 'prod_generic_1',
                  merchant_id: 'merch_1',
                  title: 'Generic Product Bundle',
                  description: 'A generic product card',
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

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '随便推荐点商品',
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
    expect(resp.body.clarification).toEqual(
      expect.objectContaining({
        question: expect.any(String),
        options: expect.any(Array),
      }),
    );
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata?.route_health?.clarify_triggered).toBe(true);
    expect(resp.body.metadata?.search_trace?.final_decision).toBe('clarify');
    expect(resp.body.metadata?.strict_empty).not.toBe(true);
  });
});
