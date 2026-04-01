const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke creator human apparel external seed main path', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/findProductsMulti/policy');
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
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/findProductsMulti/policy');
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
    if (prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    } else {
      process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = prevEnv.FIND_PRODUCTS_MULTI_ROUTE_DEBUG;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('returns direct external seed results on creator cache miss without calling upstream search', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'sleepwear-seed-1',
                external_product_id: 'ext_sleepwear_1',
                market: 'US',
                tool: 'creator_agents',
                destination_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                canonical_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                domain: 'shop.example.com',
                title: "Velvet Plus Size Padded Push-Up women's sleepwear set 4786",
                image_url: 'https://cdn.example.com/sleepwear.jpg',
                price_amount: '39.90',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  brand: 'Velvet',
                  category: 'sleepwear',
                  description: 'Plus size sleepwear lounge set with matching bottoms.',
                  snapshot: {
                    title: "Velvet Plus Size Padded Push-Up women's sleepwear set 4786",
                    brand: 'Velvet',
                    category: 'sleepwear',
                    description: 'Plus size sleepwear lounge set with matching bottoms.',
                    destination_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                    canonical_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
                  },
                },
                updated_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
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
            query: 'plus size sleepwear',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: {
          source: 'creator-agent-ui',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_sleepwear_1',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_creator_external_seed_direct',
        external_seed_returned_count: expect.any(Number),
      }),
    );
    expect(upstreamSearch.isDone()).toBe(false);
    expect(String(resp.body.reply || '')).not.toContain('Search is temporarily unavailable');
  });

  test('returns a direct empty contract on creator cache miss without falling back to upstream unavailable', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) return { rows: [] };
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
            query: 'zara blazer',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: {
          source: 'creator-agent-ui',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata?.query_source).toBe('agent_products_creator_external_seed_direct');
    expect(resp.body.metadata?.query_source).not.toBe('agent_products_error_fallback');
    expect(String(resp.body.reply || '')).not.toContain('Search is temporarily unavailable');
    expect(upstreamSearch.isDone()).toBe(false);
  });
});
