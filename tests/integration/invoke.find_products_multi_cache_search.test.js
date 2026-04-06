const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi cache-first search', () => {
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
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY:
        process.env.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY,
      PROXY_SEARCH_AURORA_API_BASE: process.env.PROXY_SEARCH_AURORA_API_BASE,
      SEARCH_CACHE_VALIDATE: process.env.SEARCH_CACHE_VALIDATE,
      SEARCH_EXTERNAL_HARD_RULE_PRUNE: process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE,
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
      PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      CREATOR_CATALOG_CACHE_TTL_SECONDS: process.env.CREATOR_CATALOG_CACHE_TTL_SECONDS,
      CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES: process.env.CREATOR_CATALOG_AUTO_SYNC_INTERVAL_MINUTES,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    delete process.env.PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY;
    delete process.env.SEARCH_CACHE_VALIDATE;
    delete process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE;
    delete process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_ENABLED;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_UPSTREAM_DISABLED;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_HEADER;
    delete process.env.SEARCH_EVAL_INTERNAL_ONLY_FORCE_NO_EARLY_DECISION;
    delete process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    delete process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
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
    if (prevEnv.PROXY_SEARCH_AURORA_API_BASE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_API_BASE;
    } else {
      process.env.PROXY_SEARCH_AURORA_API_BASE = prevEnv.PROXY_SEARCH_AURORA_API_BASE;
    }
    if (prevEnv.SEARCH_CACHE_VALIDATE === undefined) {
      delete process.env.SEARCH_CACHE_VALIDATE;
    } else {
      process.env.SEARCH_CACHE_VALIDATE = prevEnv.SEARCH_CACHE_VALIDATE;
    }
    if (prevEnv.SEARCH_EXTERNAL_HARD_RULE_PRUNE === undefined) {
      delete process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE;
    } else {
      process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = prevEnv.SEARCH_EXTERNAL_HARD_RULE_PRUNE;
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
    if (prevEnv.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    } else {
      process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
        prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED =
        prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
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
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(String(resp.body.products[0].title || '').toLowerCase()).toContain('ipsa');
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('exact IPSA lookup does not accept brand-only cache hits', async () => {
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
                  id: 'prod_ipsa_generic_1',
                  product_id: 'prod_ipsa_generic_1',
                  merchant_id: 'merch_1',
                  title: 'IPSA Balancing Lotion',
                  description: 'Daily balancing lotion',
                  vendor: 'IPSA',
                  status: 'published',
                  inventory_quantity: 9,
                  price: 39,
                  currency: 'USD',
                },
              },
              {
                merchant_id: 'merch_1',
                merchant_name: 'Merchant One',
                product_data: {
                  id: 'prod_ipsa_generic_2',
                  product_id: 'prod_ipsa_generic_2',
                  merchant_id: 'merch_1',
                  title: 'IPSA Cleansing Foam',
                  description: 'Foaming cleanser',
                  vendor: 'IPSA',
                  status: 'published',
                  inventory_quantity: 8,
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
      .query(
        (q) =>
          String(q.search_all_merchants || '') === 'true' &&
          String(q.query || '') === 'IPSA Time Reset Aqua',
      )
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_ipsa_exact_1',
            product_id: 'prod_ipsa_exact_1',
            merchant_id: 'merch_1',
            title: 'IPSA Time Reset Aqua',
            description: 'Hydrating toner essence',
            status: 'active',
            inventory_quantity: 7,
            price: 42,
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
            query: 'IPSA Time Reset Aqua',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
          entry: 'home',
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(false);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: 'prod_ipsa_exact_1',
          title: 'IPSA Time Reset Aqua',
        }),
      ]),
    );
    expect(String(resp.body.metadata?.query_source || '')).not.toBe('cache_cross_merchant_search');
    expect(String(resp.body.metadata?.search_trace?.final_decision || '')).not.toBe('cache_returned');
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
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
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
    expect(
      ['cache_cross_merchant_search', 'agent_products_search', 'agent_products_error_fallback'].includes(
        String(resp.body.metadata?.query_source || ''),
      ),
    ).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    if (resp.body.products.length > 0) {
      expect(String(resp.body.products[0].title || '').toLowerCase()).toContain('brush');
    }
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache?.query).toBe('有什么化妆刷推荐吗？');
    if (String(resp.body.metadata?.query_source || '') === 'cache_cross_merchant_search') {
      expect(upstreamSearch.isDone()).toBe(false);
    } else {
      expect(
        String(resp.body.metadata?.route_debug?.cross_merchant_cache?.upstream_query || '').toLowerCase(),
      ).toContain('makeup tools');
      expect(upstreamSearch.isDone()).toBe(true);
    }
  });

  test('preserves eligible-only contract for cache-returned agent_api results', async () => {
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
                  id: 'prod_winona_1',
                  product_id: 'prod_winona_1',
                  merchant_id: 'merch_1',
                  title: 'Winona Soothing Repair Serum',
                  vendor: 'Winona',
                  status: 'published',
                  inventory_quantity: 9,
                  price: 39,
                  currency: 'USD',
                  variants: [
                    {
                      id: 'var_winona_1',
                      variant_id: 'var_winona_1',
                      sku: 'sku_winona_1',
                      price: 39,
                      inventory_quantity: 9,
                    },
                  ],
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
            query: 'Winona products',
            page: 1,
            limit: 10,
            in_stock_only: true,
            commerce_surface: 'agent_api',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
        commerce_surface: 'agent_api',
        serving_mode: 'eligible_only',
      }),
    );
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'prod_winona_1',
        merchant_id: 'merch_1',
        commerce_surface: 'agent_api',
        top_offer_summary: expect.objectContaining({
          purchase_route: 'internal_checkout',
          merchant_id: 'merch_1',
          product_id: 'prod_winona_1',
          variant_id: 'var_winona_1',
          sku_id: 'sku_winona_1',
          commerce_surface: 'agent_api',
        }),
        exact_resolution_identifiers: expect.objectContaining({
          merchant_id: 'merch_1',
          product_id: 'prod_winona_1',
          variant_id: 'var_winona_1',
          sku_id: 'sku_winona_1',
        }),
      }),
    );
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

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.merchant_id || '') === 'external_seed' &&
          String(q.external_seed_only || '') === 'true' &&
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          ['unified_relevance', 'supplement_internal_first'].includes(
            String(q.external_seed_strategy || ''),
          ) &&
          String(q.fast_mode || '') === 'true'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const guardedSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.search_all_merchants || '') === 'true' &&
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          ['unified_relevance', 'supplement_internal_first'].includes(
            String(q.external_seed_strategy || ''),
          )
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
    expect(externalSupplement.isDone()).toBe(true);
    expect(guardedSearch.isDone()).toBe(true);
  });

  test('aurora source bypasses cache strict-empty on miss and continues stable upstream search', async () => {
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
          String(q.query || '').includes('repair serum') &&
          String(q.search_all_merchants || '') === 'true' &&
          String(q.limit || '') === '10' &&
          String(q.offset || '') === '0'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'repair_serum_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Barrier Repair Serum',
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
            query: 'repair serum',
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
    expect(resp.body.metadata?.query_source).toBe('agent_products_search');
    expect(resp.body.metadata?.strict_empty).not.toBe(true);
    expect(resp.body.metadata?.strict_empty_reason).toBeUndefined();
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('injects creator catalog guard params on upstream query', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.merchant_id || '') === 'external_seed' &&
          String(q.external_seed_only || '') === 'true' &&
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          ['unified_relevance', 'supplement_internal_first'].includes(
            String(q.external_seed_strategy || ''),
          ) &&
          String(q.fast_mode || '') === 'true'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const guardedSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.search_all_merchants || '') === 'true' &&
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          ['unified_relevance', 'supplement_internal_first'].includes(
            String(q.external_seed_strategy || ''),
          )
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
    expect(externalSupplement.isDone()).toBe(true);
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

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.merchant_id || '') === 'external_seed' &&
          String(q.external_seed_only || '') === 'true' &&
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          ['unified_relevance', 'supplement_internal_first'].includes(
            String(q.external_seed_strategy || ''),
          ) &&
          String(q.fast_mode || '') === 'true'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const guardedSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.search_all_merchants || '') === 'true' &&
          String(q.query || '') === 'ipsa toner' &&
          String(q.allow_external_seed) === 'true' &&
          String(q.allow_stale_cache) === 'false' &&
          ['unified_relevance', 'supplement_internal_first'].includes(
            String(q.external_seed_strategy || ''),
          )
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
    expect(externalSupplement.isDone()).toBe(false);
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
      hasFashionConstraintQuerySignal: jest.fn(() => false),
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

  test('generic serum cache flow prefers internal skincare results over external supplement', async () => {
    process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 6 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_serum_1',
                  product_id: 'prod_serum_1',
                  merchant_id: 'merch_skin',
                  title: 'Niacinamide Repair Serum',
                  description: '10% niacinamide serum for uneven tone',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_serum_2',
                  product_id: 'prod_serum_2',
                  merchant_id: 'merch_skin',
                  title: 'Barrier Support Serum',
                  description: 'hydrating skincare serum for daily barrier support',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 7,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_1',
                  product_id: 'prod_brush_1',
                  merchant_id: 'merch_tools',
                  title: 'Foundation Brush for Serum Application',
                  description: 'makeup brush for applying liquid serum products',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 8,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_2',
                  product_id: 'prod_brush_2',
                  merchant_id: 'merch_tools',
                  title: 'Face Applicator Brush Serum Blend',
                  description: 'applicator brush for serum and foundation',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 8,
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
      .query(
        (q) =>
          String(q.merchant_id || '') === 'external_seed' &&
          String(q.query || '')
            .toLowerCase()
            .includes('serum'),
      )
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'ext_serum_1',
            product_id: 'ext_serum_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Niacinamide Barrier Serum',
            description: 'niacinamide serum for daily barrier support',
            product_type: 'external',
            status: 'active',
          },
          {
            id: 'ext_brush_1',
            product_id: 'ext_brush_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Foundation Brush',
            description: 'makeup brush for base makeup',
            product_type: 'external',
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
            query: 'serum',
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
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search_supplemented');
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect((resp.body.products || []).some((item) => /serum/i.test(String(item?.title || '')))).toBe(true);
    expect((resp.body.products || []).every((item) => !/\bbrush\b/i.test(String(item?.title || '')))).toBe(true);
    expect((resp.body.products || []).some((item) => String(item?.merchant_id || '') === 'external_seed')).toBe(
      true,
    );
    expect(resp.body.metadata?.source_breakdown?.external_seed_count).toBeGreaterThan(0);
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache).toEqual(
      expect.objectContaining({
        beauty_query_bucket: 'skincare',
        cache_query_mode: 'raw_first',
        internal_filtered_irrelevant_count: expect.any(Number),
        timeout_budget_ms: expect.any(Number),
        supplement: expect.objectContaining({
          applied: true,
        }),
      }),
    );
    expect(
      Number(resp.body.metadata?.route_debug?.cross_merchant_cache?.timeout_budget_ms || 0),
    ).toBeGreaterThan(2200);
    expect(
      Array.isArray(resp.body.metadata?.route_debug?.cross_merchant_cache?.cache_query_terms),
    ).toBe(true);
    expect(
      resp.body.metadata?.route_debug?.cross_merchant_cache?.cache_query_terms || [],
    ).not.toEqual(expect.arrayContaining(['brush', 'foundation', 'lipstick', 'palette']));
    expect(
      Number(resp.body.metadata?.route_debug?.cross_merchant_cache?.internal_filtered_irrelevant_count || 0),
    ).toBeGreaterThan(0);
    expect(
      Number(resp.body.metadata?.route_debug?.cross_merchant_cache?.internal_bucket_mix_before?.tools || 0),
    ).toBeGreaterThan(0);
    expect(
      Number(resp.body.metadata?.route_debug?.cross_merchant_cache?.internal_bucket_mix_after?.tools || 0),
    ).toBe(0);
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache?.supplement).toEqual(
      expect.objectContaining({
        applied: true,
      }),
    );
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache?.cache_validation).toEqual(
      expect.objectContaining({
        accepted: expect.any(Boolean),
        min_count: expect.any(Number),
      }),
    );
    expect(
      resp.body.metadata?.route_debug?.cross_merchant_cache?.supplement?.query_variants || [],
    ).not.toEqual(expect.arrayContaining(['perfume', 'fragrance', 'parfum']));
    expect(externalSupplement.isDone()).toBe(true);
  });

  test('public source=search serum contract stays internal-first and emits cache-stage diagnostics', async () => {
    process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 4 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_winona',
                  product_id: 'prod_winona',
                  merchant_id: 'merch_skin',
                  title: 'Winona Soothing Repair Serum',
                  description: 'repair serum for sensitive skin',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_ordinary',
                  product_id: 'prod_ordinary',
                  merchant_id: 'merch_skin',
                  title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                  description: 'niacinamide serum for uneven tone',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 8,
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
      .query((q) => String(q.merchant_id || '') === 'external_seed' && String(q.query || '').includes('serum'))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'ext_serum_1',
            product_id: 'ext_serum_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
            description: 'external niacinamide serum refill',
            product_type: 'external',
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
            query: 'serum',
            page: 1,
            limit: 6,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
        source_breakdown: expect.objectContaining({
          internal_count: 2,
          external_seed_count: 0,
        }),
        service_version: expect.objectContaining({
          service: expect.any(String),
          build_id: expect.any(String),
        }),
        cache_stage_attempted: true,
        cache_stage_selected_source: 'internal_cache',
        cache_stage_beauty_bucket: 'skincare',
      }),
    );
    expect(Array.isArray(resp.body.metadata?.cache_stage_query_terms)).toBe(true);
    expect(resp.body.metadata?.cache_stage_query_terms || []).toEqual(
      expect.arrayContaining(['serum']),
    );
    expect(Number(resp.body.metadata?.cache_stage_strict_total || 0)).toBeGreaterThan(0);
    expect(resp.body.products.map((item) => String(item?.title || ''))).toEqual(
      expect.arrayContaining([
        'Winona Soothing Repair Serum',
        'The Ordinary Niacinamide 10% + Zinc 1%',
      ]),
    );
    expect((resp.body.products || []).every((item) => String(item?.merchant_id || '') !== 'external_seed')).toBe(
      true,
    );
    expect(externalSupplement.isDone()).toBe(false);
  });

  test.each([
    ['unified_relevance'],
    ['supplement_internal_first'],
  ])(
    'public source=search ignores %s override and keeps healthy internal cache hit',
    async (externalSeedStrategy) => {
      process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

      jest.doMock('../../src/db', () => ({
        query: async (sql) => {
          const text = String(sql || '');
          if (text.includes('COUNT(*)::int AS total')) {
            return { rows: [{ total: 4 }] };
          }
          if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
            return {
              rows: [
                {
                  merchant_id: 'merch_skin',
                  merchant_name: 'Skin Shop',
                  product_data: {
                    id: 'prod_winona',
                    product_id: 'prod_winona',
                    merchant_id: 'merch_skin',
                    title: 'Winona Soothing Repair Serum',
                    description: 'repair serum for sensitive skin',
                    product_type: 'Serum',
                    status: 'published',
                    inventory_quantity: 6,
                  },
                },
                {
                  merchant_id: 'merch_skin',
                  merchant_name: 'Skin Shop',
                  product_data: {
                    id: 'prod_ordinary',
                    product_id: 'prod_ordinary',
                    merchant_id: 'merch_skin',
                    title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                    description: 'niacinamide serum for uneven tone',
                    product_type: 'Serum',
                    status: 'published',
                    inventory_quantity: 8,
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
        .query((q) => String(q.merchant_id || '') === 'external_seed' && String(q.query || '').includes('serum'))
        .reply(200, {
          status: 'success',
          success: true,
          products: [
            {
              id: 'ext_serum_1',
              product_id: 'ext_serum_1',
              merchant_id: 'external_seed',
              source: 'external_seed',
              title: 'Multi-Peptide + HA Serum',
              description: 'external serum candidate',
              product_type: 'external',
              status: 'active',
            },
          ],
          total: 1,
        });

      const upstreamSearch = nock('http://pivota.test')
        .get('/agent/v1/products/search')
        .query((q) => String(q.search_all_merchants || '') === 'true' && String(q.query || '') === 'serum')
        .reply(200, {
          status: 'success',
          success: true,
          products: [
            {
              id: 'ext_upstream_1',
              product_id: 'ext_upstream_1',
              merchant_id: 'external_seed',
              source: 'external_seed',
              title: 'Anti-Blemish Serum',
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
              query: 'serum',
              page: 1,
              limit: 5,
              in_stock_only: true,
              external_seed_strategy: externalSeedStrategy,
            },
          },
          metadata: {
            source: 'search',
          },
        });

      expect(resp.status).toBe(200);
      expect(resp.body.metadata).toEqual(
        expect.objectContaining({
          query_source: 'cache_cross_merchant_search',
          source_breakdown: expect.objectContaining({
            internal_count: 2,
            external_seed_count: 0,
            strategy_applied: 'cache_only',
          }),
          cache_stage_selected_source: 'internal_cache',
        }),
      );
      expect(resp.body.metadata?.route_debug?.cross_merchant_cache).toEqual(
        expect.objectContaining({
          cache_hit: true,
          cache_hit_base: true,
          cache_missing_external_for_unified: false,
          cache_strict_empty_bypassed: false,
        }),
      );
      expect(resp.body.products.map((item) => String(item?.title || ''))).toEqual(
        expect.arrayContaining([
          'Winona Soothing Repair Serum',
          'The Ordinary Niacinamide 10% + Zinc 1%',
        ]),
      );
      expect((resp.body.products || []).every((item) => String(item?.merchant_id || '') !== 'external_seed')).toBe(
        true,
      );
      expect(externalSupplement.isDone()).toBe(false);
      expect(upstreamSearch.isDone()).toBe(false);
    },
  );

  test('generic serum cache flow trims mixed skincare noise before the cache quality gate', async () => {
    process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 6 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_skin_a',
                merchant_name: 'Skin Shop A',
                product_data: {
                  id: 'prod_winona',
                  product_id: 'prod_winona',
                  merchant_id: 'merch_skin_a',
                  title: 'Winona Soothing Repair Serum',
                  description: 'repair serum for sensitive skin',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_skin_b',
                merchant_name: 'Skin Shop B',
                product_data: {
                  id: 'prod_ordinary',
                  product_id: 'prod_ordinary',
                  merchant_id: 'merch_skin_b',
                  title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                  description: 'niacinamide serum for uneven tone',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 8,
                },
              },
              {
                merchant_id: 'merch_skin_c',
                merchant_name: 'Skin Shop C',
                product_data: {
                  id: 'prod_cream_1',
                  product_id: 'prod_cream_1',
                  merchant_id: 'merch_skin_c',
                  title: 'Barrier Repair Cream',
                  description: 'barrier cream for dry skin',
                  product_type: 'Cream',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
              {
                merchant_id: 'merch_skin_d',
                merchant_name: 'Skin Shop D',
                product_data: {
                  id: 'prod_toner_1',
                  product_id: 'prod_toner_1',
                  merchant_id: 'merch_skin_d',
                  title: 'Hydration Reset Toner',
                  description: 'hydrating toner for daily skin prep',
                  product_type: 'Toner',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
              {
                merchant_id: 'merch_tools_1',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_tool_1',
                  product_id: 'prod_tool_1',
                  merchant_id: 'merch_tools_1',
                  title: 'Serum Applicator Wand',
                  description: 'beauty tool for applying liquid skincare',
                  product_type: 'Applicator Tool',
                  category: 'beauty tool',
                  status: 'published',
                  inventory_quantity: 9,
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
      .query((q) => String(q.search_all_merchants || '') === 'true' && String(q.query || '') === 'serum')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'upstream_serum_1',
            product_id: 'upstream_serum_1',
            merchant_id: 'merchant_x',
            title: 'Travel Brightening Serum',
            description: 'mini serum set',
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
            query: 'serum',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
        source_breakdown: expect.objectContaining({
          internal_count: 2,
          external_seed_count: 0,
        }),
        cache_stage_selected_source: 'internal_cache',
      }),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).toEqual(
      expect.arrayContaining([
        'Winona Soothing Repair Serum',
        'The Ordinary Niacinamide 10% + Zinc 1%',
      ]),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).not.toEqual(
      expect.arrayContaining(['Barrier Repair Cream', 'Hydration Reset Toner', 'Serum Applicator Wand']),
    );
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('generic serum cache flow tightens to serum-only hits when essence/concentrate noise would fail cache quality', async () => {
    process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 4 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_skin_a',
                merchant_name: 'Skin Shop A',
                product_data: {
                  id: 'prod_winona',
                  product_id: 'prod_winona',
                  merchant_id: 'merch_skin_a',
                  title: 'Winona Soothing Repair Serum',
                  description: 'repair serum for sensitive skin',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_skin_b',
                merchant_name: 'Skin Shop B',
                product_data: {
                  id: 'prod_ordinary',
                  product_id: 'prod_ordinary',
                  merchant_id: 'merch_skin_b',
                  title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                  description: 'niacinamide serum for uneven tone',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 8,
                },
              },
              {
                merchant_id: 'merch_skin_c',
                merchant_name: 'Skin Shop C',
                product_data: {
                  id: 'prod_concentrate_1',
                  product_id: 'prod_concentrate_1',
                  merchant_id: 'merch_skin_c',
                  title: 'Youth Reset Concentrate',
                  description: 'brightening concentrate for smoother skin',
                  product_type: 'Concentrate',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
              {
                merchant_id: 'merch_skin_d',
                merchant_name: 'Skin Shop D',
                product_data: {
                  id: 'prod_essence_1',
                  product_id: 'prod_essence_1',
                  merchant_id: 'merch_skin_d',
                  title: 'Hydra Veil Essence',
                  description: 'daily essence for softer-looking skin',
                  product_type: 'Essence',
                  category: 'skincare',
                  status: 'published',
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
      .query((q) => String(q.search_all_merchants || '') === 'true' && String(q.query || '') === 'serum')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'upstream_travel_1',
            product_id: 'upstream_travel_1',
            merchant_id: 'merchant_x',
            title: 'Rapid Dark Spot Correcting Serum Travel Size',
            description: 'travel serum',
            status: 'active',
          },
          {
            id: 'upstream_travel_2',
            product_id: 'upstream_travel_2',
            merchant_id: 'merchant_y',
            title: 'Vita-C Glycolic Serum Deluxe Travel Size',
            description: 'deluxe travel serum',
            status: 'active',
          },
          {
            id: 'upstream_jumbo_1',
            product_id: 'upstream_jumbo_1',
            merchant_id: 'merchant_z',
            title: 'Vitamin C Super Serum Plus - Jumbo',
            description: 'jumbo serum',
            status: 'active',
          },
        ],
        total: 3,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'serum',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
        source_breakdown: expect.objectContaining({
          internal_count: 2,
          external_seed_count: 0,
        }),
        cache_stage_selected_source: 'internal_cache',
      }),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).toEqual(
      expect.arrayContaining([
        'Winona Soothing Repair Serum',
        'The Ordinary Niacinamide 10% + Zinc 1%',
      ]),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).not.toEqual(
      expect.arrayContaining(['Youth Reset Concentrate', 'Hydra Veil Essence']),
    );
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('generic serum cache flow keeps sparse serum-like skincare titles internal-first', async () => {
    process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 6 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_skin_a',
                merchant_name: 'Skin Shop A',
                product_data: {
                  id: 'prod_winona',
                  product_id: 'prod_winona',
                  merchant_id: 'merch_skin_a',
                  title: 'Winona Soothing Repair Serum',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_skin_b',
                merchant_name: 'Skin Shop B',
                product_data: {
                  id: 'prod_ordinary',
                  product_id: 'prod_ordinary',
                  merchant_id: 'merch_skin_b',
                  title: 'The Ordinary Niacinamide 10% + Zinc 1%',
                  status: 'published',
                  inventory_quantity: 8,
                },
              },
              {
                merchant_id: 'merch_skin_c',
                merchant_name: 'Skin Shop C',
                product_data: {
                  id: 'prod_truth',
                  product_id: 'prod_truth',
                  merchant_id: 'merch_skin_c',
                  title: 'Truth Serum',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
              {
                merchant_id: 'merch_skin_d',
                merchant_name: 'Skin Shop D',
                product_data: {
                  id: 'prod_banana',
                  product_id: 'prod_banana',
                  merchant_id: 'merch_skin_d',
                  title: 'Banana Bright 15% Vitamin C Dark Spot Serum',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
              {
                merchant_id: 'merch_skin_e',
                merchant_name: 'Skin Shop E',
                product_data: {
                  id: 'prod_essence_1',
                  product_id: 'prod_essence_1',
                  merchant_id: 'merch_skin_e',
                  title: 'Hydra Veil Essence',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
              {
                merchant_id: 'merch_skin_f',
                merchant_name: 'Skin Shop F',
                product_data: {
                  id: 'prod_concentrate_1',
                  product_id: 'prod_concentrate_1',
                  merchant_id: 'merch_skin_f',
                  title: 'Youth Reset Concentrate',
                  status: 'published',
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
      .query(
        (q) =>
          String(q.search_all_merchants || '') === 'true' &&
          /serum/i.test(String(q.query || '')),
      )
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'upstream_travel_1',
            product_id: 'upstream_travel_1',
            merchant_id: 'merchant_x',
            title: 'Rapid Dark Spot Correcting Serum Travel Size',
            description: 'travel serum',
            status: 'active',
          },
          {
            id: 'upstream_travel_2',
            product_id: 'upstream_travel_2',
            merchant_id: 'merchant_y',
            title: 'Vita-C Glycolic Serum Deluxe Travel Size',
            description: 'deluxe travel serum',
            status: 'active',
          },
          {
            id: 'upstream_jumbo_1',
            product_id: 'upstream_jumbo_1',
            merchant_id: 'merchant_z',
            title: 'Vitamin C Super Serum Plus - Jumbo',
            description: 'jumbo serum',
            status: 'active',
          },
        ],
        total: 3,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'serum',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
        source_breakdown: expect.objectContaining({
          internal_count: 4,
          external_seed_count: 0,
        }),
        cache_stage_selected_source: 'internal_cache',
      }),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).toEqual(
      expect.arrayContaining([
        'Winona Soothing Repair Serum',
        'The Ordinary Niacinamide 10% + Zinc 1%',
        'Truth Serum',
        'Banana Bright 15% Vitamin C Dark Spot Serum',
      ]),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).not.toEqual(
      expect.arrayContaining(['Hydra Veil Essence', 'Youth Reset Concentrate']),
    );
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('generic serum cache flow widens the cache fetch window before falling back upstream', async () => {
    process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

    const makeNoiseRow = (index) => ({
      merchant_id: `merch_noise_${index}`,
      merchant_name: `Noise Shop ${index}`,
      product_data: {
        id: `prod_noise_${index}`,
        product_id: `prod_noise_${index}`,
        merchant_id: `merch_noise_${index}`,
        title:
          index % 3 === 0
            ? `Barrier Repair Cream ${index}`
            : index % 3 === 1
            ? `Daily Sunscreen SPF ${index}`
            : `Hydration Cleanser ${index}`,
        description: 'recent skincare noise row',
        product_type: index % 2 === 0 ? 'Cream' : 'Cleanser',
        category: 'skincare',
        status: 'published',
        inventory_quantity: 9,
      },
    });

    const serumRows = [
      {
        merchant_id: 'merch_skin_a',
        merchant_name: 'Skin Shop A',
        product_data: {
          id: 'prod_winona',
          product_id: 'prod_winona',
          merchant_id: 'merch_skin_a',
          title: 'Winona Soothing Repair Serum',
          status: 'published',
          inventory_quantity: 6,
        },
      },
      {
        merchant_id: 'merch_skin_b',
        merchant_name: 'Skin Shop B',
        product_data: {
          id: 'prod_ordinary',
          product_id: 'prod_ordinary',
          merchant_id: 'merch_skin_b',
          title: 'The Ordinary Niacinamide 10% + Zinc 1%',
          status: 'published',
          inventory_quantity: 8,
        },
      },
      {
        merchant_id: 'merch_skin_c',
        merchant_name: 'Skin Shop C',
        product_data: {
          id: 'prod_truth',
          product_id: 'prod_truth',
          merchant_id: 'merch_skin_c',
          title: 'Truth Serum',
          status: 'published',
          inventory_quantity: 5,
        },
      },
      {
        merchant_id: 'merch_skin_d',
        merchant_name: 'Skin Shop D',
        product_data: {
          id: 'prod_vitc',
          product_id: 'prod_vitc',
          merchant_id: 'merch_skin_d',
          title: 'Vitamin-C Serum',
          status: 'published',
          inventory_quantity: 5,
        },
      },
      {
        merchant_id: 'merch_skin_e',
        merchant_name: 'Skin Shop E',
        product_data: {
          id: 'prod_banana',
          product_id: 'prod_banana',
          merchant_id: 'merch_skin_e',
          title: 'Banana Bright 15% Vitamin C Dark Spot Serum',
          status: 'published',
          inventory_quantity: 5,
        },
      },
      {
        merchant_id: 'merch_skin_f',
        merchant_name: 'Skin Shop F',
        product_data: {
          id: 'prod_watch',
          product_id: 'prod_watch',
          merchant_id: 'merch_skin_f',
          title: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
          status: 'published',
          inventory_quantity: 5,
        },
      },
    ];

    jest.doMock('../../src/db', () => ({
      query: async (sql, params = []) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 86 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          const fetchLimit = Number(params[params.length - 1] || 0);
          const noiseRows = Array.from({ length: 80 }, (_, index) => makeNoiseRow(index + 1));
          return {
            rows: fetchLimit >= 240 ? noiseRows.concat(serumRows) : noiseRows,
          };
        }
        if (text.includes('FROM products_cache') && !text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.search_all_merchants || '') === 'true' && String(q.query || '') === 'serum')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'upstream_serum_1',
            product_id: 'upstream_serum_1',
            merchant_id: 'merchant_x',
            title: 'Travel Brightening Serum',
            description: 'mini serum set',
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
            query: 'serum',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'cache_cross_merchant_search',
        source_breakdown: expect.objectContaining({
          internal_count: 5,
          external_seed_count: 0,
        }),
        cache_stage_selected_source: 'internal_cache',
      }),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).toEqual(
      expect.arrayContaining([
        'Winona Soothing Repair Serum',
        'The Ordinary Niacinamide 10% + Zinc 1%',
        'Truth Serum',
        'Banana Bright 15% Vitamin C Dark Spot Serum',
      ]),
    );
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache?.cache_query_terms).toEqual(
      expect.arrayContaining(['serum', 'niacinamide', 'vitamin c']),
    );
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache?.cache_query_terms).not.toEqual(
      expect.arrayContaining(['moisturizer', 'sunscreen', 'cleanser', 'cream']),
    );
    expect(upstreamSearch.isDone()).toBe(false);
  });

  test('aurora-bff beauty discovery bypasses legacy internal cache stage and goes to upstream mainline', async () => {
    process.env.SEARCH_EXTERNAL_HARD_RULE_PRUNE = 'true';

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
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_winona',
                  product_id: 'prod_winona',
                  merchant_id: 'merch_skin',
                  title: 'Winona Soothing Repair Serum',
                  description: 'repair serum for sensitive skin',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_wrong',
                merchant_name: 'Wrong Scope Shop',
                product_data: {
                  id: 'prod_wrong',
                  product_id: 'prod_wrong',
                  merchant_id: 'merch_wrong',
                  title: 'Peptide Lip Treatment Strawberry Glaze',
                  description: 'cache pollution candidate',
                  product_type: 'Lip Treatment',
                  status: 'published',
                  inventory_quantity: 8,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    let capturedBody = null;
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/v2/products/search', (body) => {
        capturedBody = body;
        return true;
      })
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'upstream_treat_1',
            product_id: 'upstream_treat_1',
            merchant_id: 'merch_live',
            title: 'Clarifying Oil Control Treatment',
            description: 'fresh upstream treatment result',
            product_type: 'Treatment',
            category: 'skincare',
            status: 'published',
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
          semantic_owner: 'shopping_agent_beauty_mainline',
          decision_owner: 'shopping_agent_beauty_mainline',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'oil control treatment',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'aurora-bff',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(false);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        query: 'oil control treatment',
        catalog_surface: 'beauty',
        commerce_surface: 'beauty',
        semantic_contract: expect.objectContaining({
          owner: 'shopping_agent_beauty_contract_builder',
          target_step_family: 'treatment',
        }),
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_search',
        semantic_owner: 'shopping_agent_beauty_mainline',
        decision_owner: 'shopping_agent_beauty_mainline',
        route_debug: expect.objectContaining({
          cross_merchant_cache: expect.objectContaining({
            attempted: false,
            bypassed: true,
          }),
        }),
      }),
    );
    expect(resp.body.products.map((item) => String(item?.title || ''))).toEqual([
      'Clarifying Oil Control Treatment',
    ]);
  });

  test('source=search budget beauty queries rescue through local external seed direct search before upstream fallback', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'seed_vitc_1',
                external_product_id: 'seed_vitc_1',
                destination_url: 'https://example.com/products/vitamin-c-budget-serum',
                canonical_url: 'https://example.com/products/vitamin-c-budget-serum',
                domain: 'example.com',
                title: 'Vitamin-C Serum',
                image_url: 'https://cdn.example.com/vitamin-c-budget-serum.jpg',
                price_amount: 29,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  title: 'Vitamin-C Serum',
                  description: '15% vitamin c treatment serum.',
                  category: 'serum',
                  product_type: 'serum',
                  brand: 'Rescue Brand',
                  image_url: 'https://cdn.example.com/vitamin-c-budget-serum.jpg',
                  price: 29,
                  currency: 'USD',
                  canonical_url: 'https://example.com/products/vitamin-c-budget-serum',
                  destination_url: 'https://example.com/products/vitamin-c-budget-serum',
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

    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local',
          ingredient_profile_source: 'local',
          ingredient_direct_main_path_status: 'direct_empty_unrecovered',
          recall_source_breakdown: {},
          ingredient_candidate_evidence_breakdown: {
            family_only: 1,
          },
        },
      })),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: {
          ingredient_id: 'ascorbic_acid',
          ingredient_name: 'Vitamin C (Ascorbic acid)',
          exact_phrases: ['vitamin c'],
          alias_phrases: ['ascorbic acid'],
          family_phrases: ['serum'],
          ingredient_class: 'tone_evening_active',
          expected_step_families: ['serum', 'treatment'],
        },
        diagnostics: {
          registry_match: true,
          registry_source: 'local',
          profile_source: 'local',
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'ascorbic_acid',
        ingredient_name: 'Vitamin C (Ascorbic acid)',
        exact_phrases: ['vitamin c'],
        alias_phrases: ['ascorbic acid'],
        family_phrases: ['serum'],
        ingredient_class: 'tone_evening_active',
        expected_step_families: ['serum', 'treatment'],
      })),
      hasIngredientRegistryIntentSignal: jest.fn(() => true),
      getIngredientRecallRegistryHealth: jest.fn(async () => ({ ok: true })),
    }));

    const rawQuery = 'vitamin c serum under €30';
    const rescueQuery = 'vitamin c serum';
    const rescueSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((query) => {
        expect(query.merchant_id).toBe('external_seed');
        expect(query.external_seed_only).toBe('true');
        expect(query.query).toBe(rescueQuery);
        return true;
      })
      .optionally()
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'seed-vitamin-c-serum',
            merchant_id: 'external_seed',
            name: 'Vitamin-C Serum',
            price: 29,
            image_url: 'https://cdn.example.com/vitamin-c-serum.jpg',
            category: 'beauty',
            product_type: 'serum',
            in_stock: true,
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const genericFallbackSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((query) => query.external_seed_only !== 'true')
      .optionally()
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: rawQuery,
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Vitamin-C Serum',
        }),
      ]),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_external_seed_rescue',
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
        ingredient_intents: ['ascorbic_acid'],
        matched_ingredient_ids: ['ascorbic_acid'],
        ingredient_external_seed_rescue_attempted: true,
        ingredient_external_seed_rescue_recovered: true,
        route_health: expect.objectContaining({
          primary_path_used: 'ingredient_external_seed_rescue',
          fallback_triggered: false,
        }),
        search_decision: expect.objectContaining({
          final_decision: 'products_returned',
          primary_path_used: 'ingredient_external_seed_rescue',
          decision_authority: 'agent_products_ingredient_external_seed_rescue',
          decision_locked: true,
        }),
      }),
    );
  });

  test('source=search strict beauty queries use local ingredient direct recall before upstream products search', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    }));

    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            id: 'prod_vitc_direct_1',
            product_id: 'prod_vitc_direct_1',
            merchant_id: 'external_seed',
            title: 'Vitamin-C Serum',
            description: 'Explicit vitamin c treatment serum.',
            category: 'serum',
            product_type: 'serum',
            brand: 'Test Brand',
            price: 29,
            currency: 'USD',
            canonical_url: 'https://example.com/products/vitamin-c-serum',
            destination_url: 'https://example.com/products/vitamin-c-serum',
            url: 'https://example.com/products/vitamin-c-serum',
            image_url: 'https://cdn.example.com/vitamin-c-serum.jpg',
            source: 'external_seed',
          },
          {
            id: 'prod_vitc_direct_2',
            product_id: 'prod_vitc_direct_2',
            merchant_id: 'external_seed',
            title: 'Vitamin-C Serum Premium',
            description: 'Explicit vitamin c serum above budget.',
            category: 'serum',
            product_type: 'serum',
            brand: 'Test Brand',
            price: 40,
            currency: 'USD',
            canonical_url: 'https://example.com/products/vitamin-c-serum-premium',
            destination_url: 'https://example.com/products/vitamin-c-serum-premium',
            url: 'https://example.com/products/vitamin-c-serum-premium',
            image_url: 'https://cdn.example.com/vitamin-c-serum-premium.jpg',
            source: 'external_seed',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local',
          ingredient_profile_source: 'local',
          ingredient_direct_main_path_status: 'direct_hit',
          recall_source_breakdown: {
            products_cache: 1,
          },
          ingredient_candidate_evidence_breakdown: {
            kb_explicit: 0,
            title_exact: 0,
            title_alias: 1,
            ingredient_token_exact: 1,
            ingredient_token_alias: 0,
            url_alias: 0,
            family_only: 0,
          },
        },
      })),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: {
          ingredient_id: 'ascorbic_acid',
          ingredient_name: 'Vitamin C (Ascorbic acid)',
          expected_step_families: ['serum', 'treatment'],
        },
        diagnostics: {
          registry_match: true,
          registry_source: 'local',
          profile_source: 'local',
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'ascorbic_acid',
        ingredient_name: 'Vitamin C (Ascorbic acid)',
        expected_step_families: ['serum', 'treatment'],
      })),
      hasIngredientRegistryIntentSignal: jest.fn(() => true),
      getIngredientRecallRegistryHealth: jest.fn(async () => ({ ok: true })),
    }));

    const app = require('../../src/server');
    const {
      recallIngredientProducts,
      resolveIngredientRecallProfileKnowledge,
    } = require('../../src/services/ingredientProductRecall');

    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'vitamin c serum under €30',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resolveIngredientRecallProfileKnowledge).toHaveBeenCalledTimes(1);
    expect(recallIngredientProducts).toHaveBeenCalledTimes(1);
    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'ascorbic_acid',
        allowFamilyFallback: true,
        limit: 5,
        minimumDirectProductCount: 2,
      }),
    );
    expect(resp.body.products.map((item) => item.product_id)).toEqual(['prod_vitc_direct_1']);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct',
        ingredient_budget_query_rescue_attempted: false,
        ingredient_direct_recall_limit: 5,
        ingredient_direct_minimum_products: 2,
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
        ingredient_intents: ['ascorbic_acid'],
        matched_ingredient_ids: ['ascorbic_acid'],
        budget_fx_applied: true,
        budget_fx_candidate_currency: 'USD',
        budget_fx_unresolved: false,
        contract_bridge: expect.objectContaining({
          resolved_contract: expect.stringMatching(
            /^(shop_invoke_strict|agent_v1_search_beauty_mainline)$/,
          ),
        }),
        route_health: expect.objectContaining({
          fallback_triggered: false,
        }),
        search_decision: expect.objectContaining({
          query_target_step_family: 'serum',
        }),
      }),
    );
  });

  test('source=search brand-like beauty queries preserve healthy upstream results instead of falling back', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    }));

    let capturedQuery = null;
    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((query) => {
        capturedQuery = query;
        return String(query.query || '') === 'fenty';
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'fenty_1',
            product_id: 'fenty_1',
            merchant_id: 'external_seed',
            title: 'Watch Ya Tone Niacinamide Dark Spot Serum',
            description: 'Dark spot serum from Fenty Skin.',
            category: 'serum',
            product_type: 'serum',
            brand: 'Fenty Beauty',
            vendor: 'Fenty Beauty',
            price: 22,
            currency: 'USD',
            canonical_url: 'https://fentybeauty.example/watch-ya-tone',
            destination_url: 'https://fentybeauty.example/watch-ya-tone',
            url: 'https://fentybeauty.example/watch-ya-tone',
            image_url: 'https://cdn.example.com/fenty-watch-ya-tone.jpg',
            source: 'external_seed',
          },
          {
            id: 'fenty_2',
            product_id: 'fenty_2',
            merchant_id: 'external_seed',
            title: 'Fat Water Niacinamide Pore-Refining Toner Serum',
            description: 'Toner serum from Fenty Skin.',
            category: 'toner',
            product_type: 'toner',
            brand: 'Fenty Beauty',
            vendor: 'Fenty Beauty',
            price: 28,
            currency: 'USD',
            canonical_url: 'https://fentybeauty.example/fat-water',
            destination_url: 'https://fentybeauty.example/fat-water',
            url: 'https://fentybeauty.example/fat-water',
            image_url: 'https://cdn.example.com/fenty-fat-water.jpg',
            source: 'external_seed',
          },
        ],
        total: 2,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'fenty',
            page: 1,
            limit: 24,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      })
      .expect(200);

    expect(upstreamSearch.isDone()).toBe(true);
    expect(String(capturedQuery?.catalog_surface || '')).toBe('');
    expect(String(capturedQuery?.commerce_surface || '')).toBe('');
    expect(String(capturedQuery?.allow_external_seed || '')).toBe('true');
    expect(String(capturedQuery?.external_seed_strategy || '')).toBe('unified_relevance');
    expect(resp.body.products).toHaveLength(2);
    expect(resp.body.products.map((item) => item.product_id)).toEqual(['fenty_1', 'fenty_2']);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_search',
        route_health: expect.objectContaining({
          primary_path_used: 'upstream_stage',
          fallback_triggered: false,
        }),
      }),
    );
  });

  test('source=search strict beauty budget queries supplement weak direct hits with stripped-query rescue', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    }));

    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            id: 'prod_vitc_weak_1',
            product_id: 'prod_vitc_weak_1',
            merchant_id: 'external_seed',
            title: 'Watch Ya Tone Niacinamide Dark Spot Serum Refill',
            description: 'Description-parsed ingredient noise candidate.',
            category: 'serum',
            product_type: 'serum',
            brand: 'Fenty Beauty',
            price: 31,
            currency: 'USD',
            canonical_url: 'https://example.com/products/watch-ya-tone-niacinamide-dark-spot-serum-refill',
            destination_url: 'https://example.com/products/watch-ya-tone-niacinamide-dark-spot-serum-refill',
            url: 'https://example.com/products/watch-ya-tone-niacinamide-dark-spot-serum-refill',
            image_url: 'https://cdn.example.com/watch-ya-tone.jpg',
            source: 'external_seed',
            __ingredient_recall_meta: {
              evidence: {
                kb_explicit: 1,
                title_exact: 0,
                title_alias: 0,
                ingredient_token_exact: 0,
                ingredient_token_alias: 1,
                url_alias: 0,
                explicit_hits: 2,
                target_surface_anchor_hits: 0,
                surface_explicit_hits: 1,
                target_anchor_hits: 1,
                strong_target_anchor_hits: 1,
                competing_title_url_hits: 1,
                candidate_step: 'serum',
                family_relation: 'same_family',
              },
              candidate_step: 'serum',
              family_relation: 'same_family',
              source_tag: 'kb_attached_seed',
            },
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local',
          ingredient_profile_source: 'local',
          ingredient_direct_main_path_status: 'direct_hit',
          recall_source_breakdown: {
            kb_attached_seed: 1,
          },
          ingredient_candidate_evidence_breakdown: {
            kb_explicit: 1,
            title_exact: 0,
            title_alias: 0,
            ingredient_token_exact: 0,
            ingredient_token_alias: 1,
            url_alias: 0,
            family_only: 0,
          },
        },
      })),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: {
          ingredient_id: 'ascorbic_acid',
          ingredient_name: 'Vitamin C (Ascorbic acid)',
          exact_phrases: ['ascorbic acid'],
          alias_phrases: ['vitamin c'],
          family_phrases: ['brightening', 'serum'],
          ingredient_class: 'tone_evening_active',
          expected_step_families: ['serum', 'treatment'],
        },
        diagnostics: {
          registry_match: true,
          registry_source: 'local',
          profile_source: 'local',
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'ascorbic_acid',
        ingredient_name: 'Vitamin C (Ascorbic acid)',
        exact_phrases: ['ascorbic acid'],
        alias_phrases: ['vitamin c'],
        family_phrases: ['brightening', 'serum'],
        ingredient_class: 'tone_evening_active',
        expected_step_families: ['serum', 'treatment'],
      })),
      hasIngredientRegistryIntentSignal: jest.fn(() => true),
      getIngredientRecallRegistryHealth: jest.fn(async () => ({ ok: true })),
    }));

    const rescueSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((query) => {
        expect(query.merchant_id).toBe('external_seed');
        expect(query.external_seed_only).toBe('true');
        expect(query.query).toBe('vitamin c serum');
        return true;
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'seed-vitamin-c-serum',
            merchant_id: 'external_seed',
            name: 'Vitamin-C Serum',
            title: 'Vitamin-C Serum',
            price: 29,
            currency: 'USD',
            image_url: 'https://cdn.example.com/vitamin-c-serum.jpg',
            category: 'serum',
            product_type: 'serum',
            in_stock: true,
            canonical_url: 'https://example.com/products/vitamin-c-serum',
            destination_url: 'https://example.com/products/vitamin-c-serum',
            url: 'https://example.com/products/vitamin-c-serum',
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');

    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'vitamin c serum under $30',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Vitamin-C Serum',
        }),
      ]),
    );
    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'ascorbic_acid',
        allowFamilyFallback: true,
        limit: 5,
        minimumDirectProductCount: 2,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct',
        ingredient_budget_query_rescue_attempted: true,
        ingredient_budget_query_rescue_recovered: true,
        ingredient_budget_query_rescue_query: 'vitamin c serum',
        ingredient_direct_recall_limit: 5,
        ingredient_direct_minimum_products: 2,
        strict_constraint_query: true,
        strict_constraint_reason: 'multi_constraint',
      }),
    );
    expect(rescueSearch.isDone()).toBe(true);
  });

  test('serum cache preference helper keeps upstream when beauty mainline contract is active', async () => {
    const app = require('../../src/server');
    const decision = app._debug.decideGenericSkincareCachePreference({
      rawQuery: 'oil control treatment',
      queryClass: 'category',
      beautyBucket: 'skincare',
      strictConstraintQuery: false,
      semanticContract: {
        version: 'beauty_semantic_contract_v1',
        owner: 'aurora_reco_planner',
        planner_mode: 'framework_generic',
        request_class: 'generic_concern',
        target_step_family: 'treatment',
        primary_role_id: 'oil_control_treatment',
        support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
        semantic_family: 'oil_control',
        allowed_step_families: ['treatment', 'serum'],
        blocked_step_families: [],
        ingredient_hypotheses: ['niacinamide'],
        source_surface: 'aurora_beauty_strict',
      },
      catalogSurface: 'beauty',
      source: 'aurora-bff',
      upstreamResponse: {
        products: [{ id: 'ext_1', source: 'external_seed', title: 'External Serum' }],
        metadata: { query_source: 'agent_products_search' },
      },
      cacheResponse: {
        products: [{ id: 'int_1', merchant_id: 'merch_skin', title: 'Winona Soothing Repair Serum' }],
      },
    });

    expect(decision).toEqual(
      expect.objectContaining({
        evaluated: false,
        decision: 'keep_upstream',
        reason: 'beauty_mainline_cache_override_disabled',
        cache_owner_bypass_reason: 'beauty_mainline_contract',
      }),
    );
  });

  test('serum cache preference helper bypasses legacy cache override for beauty discovery when upstream is external-only', async () => {
    const app = require('../../src/server');
    const decision = app._debug.decideGenericSkincareCachePreference({
      rawQuery: 'serum',
      queryClass: 'category',
      beautyBucket: 'skincare',
      strictConstraintQuery: false,
      upstreamResponse: {
        products: [{ id: 'ext_1', source: 'external_seed', title: 'External Serum' }],
        metadata: { query_source: 'agent_products_search' },
      },
      cacheResponse: {
        products: [{ id: 'int_1', merchant_id: 'merch_skin', title: 'Winona Soothing Repair Serum' }],
      },
    });

    expect(decision).toEqual(
      expect.objectContaining({
        evaluated: false,
        decision: 'keep_upstream',
        reason: 'beauty_mainline_cache_override_disabled',
        cache_owner_bypass_reason: 'beauty_mainline_derived_contract',
      }),
    );
  });

  test('serum cache preference helper bypasses legacy cache override for beauty discovery when upstream is sample-biased', async () => {
    const app = require('../../src/server');
    const decision = app._debug.decideGenericSkincareCachePreference({
      rawQuery: 'serum',
      queryClass: 'category',
      beautyBucket: 'skincare',
      strictConstraintQuery: false,
      upstreamResponse: {
        products: [
          {
            id: 'upstream_1',
            merchant_id: 'merchant_a',
            title: 'Rapid Dark Spot Correcting Serum Travel Size',
          },
          {
            id: 'upstream_2',
            merchant_id: 'merchant_b',
            title: 'Vita-C Glycolic Serum Deluxe Travel Size',
          },
          {
            id: 'upstream_3',
            merchant_id: 'merchant_c',
            title: 'Vitamin C Super Serum Plus - Jumbo',
          },
        ],
        metadata: { query_source: 'agent_products_search' },
      },
      cacheResponse: {
        products: [{ id: 'int_1', merchant_id: 'merch_skin', title: 'Winona Soothing Repair Serum' }],
      },
    });

    expect(decision).toEqual(
      expect.objectContaining({
        evaluated: false,
        decision: 'keep_upstream',
        reason: 'beauty_mainline_cache_override_disabled',
        cache_owner_bypass_reason: 'beauty_mainline_derived_contract',
      }),
    );
  });

  test('serum cache preference helper still bypasses legacy cache override when internal skincare cache is empty', async () => {
    const app = require('../../src/server');
    const decision = app._debug.decideGenericSkincareCachePreference({
      rawQuery: 'serum',
      queryClass: 'category',
      beautyBucket: 'skincare',
      strictConstraintQuery: false,
      upstreamResponse: {
        products: [{ id: 'ext_1', source: 'external_seed', title: 'External Serum' }],
        metadata: { query_source: 'agent_products_search' },
      },
      cacheResponse: {
        products: [],
      },
    });

    expect(decision).toEqual(
      expect.objectContaining({
        evaluated: false,
        decision: 'keep_upstream',
        reason: 'beauty_mainline_cache_override_disabled',
        cache_owner_bypass_reason: 'beauty_mainline_derived_contract',
      }),
    );
  });

  test('serum cache preference helper does nothing for strict ingredient queries', async () => {
    const app = require('../../src/server');
    const decision = app._debug.decideGenericSkincareCachePreference({
      rawQuery: 'niacinamide serum',
      queryClass: 'category',
      beautyBucket: 'skincare',
      strictConstraintQuery: true,
      upstreamResponse: {
        products: [{ id: 'ext_1', source: 'external_seed', title: 'Niacinamide Serum' }],
        metadata: { query_source: 'agent_products_search' },
      },
      cacheResponse: {
        products: [{ id: 'int_1', merchant_id: 'merch_skin', title: 'Generic Serum' }],
      },
    });

    expect(decision).toEqual(
      expect.objectContaining({
        evaluated: false,
        decision: 'keep_upstream',
        reason: 'not_generic_skincare_serum_query',
      }),
    );
  });

  test('implicit beauty mainline bypass is disabled for brand-like exploratory beauty queries', async () => {
    const app = require('../../src/server');

    expect(
      app._debug.resolveLegacyBeautyCacheOwnerBypass({
        search: { query: 'fenty beauty' },
        metadata: { source: 'search' },
        rawQuery: 'fenty beauty',
        queryClass: 'exploratory',
        strictConstraintQuery: false,
      }),
    ).toEqual(
      expect.objectContaining({
        bypass: false,
        reason: 'brand_like_search_first',
      }),
    );
  });

  test('generic skincare serum cache stage budget is raised above the baseline budget', async () => {
    const app = require('../../src/server');
    const budgetMs = app._debug.resolveFindProductsMultiCacheStageBudgetMs({
      rawQuery: 'serum',
      queryClass: 'category',
      beautyBucket: 'skincare',
      strictConstraintQuery: false,
    });

    expect(budgetMs).toBe(app._debug.FIND_PRODUCTS_MULTI_GENERIC_SKINCARE_CACHE_STAGE_BUDGET_MS);
    expect(budgetMs).toBeGreaterThan(app._debug.FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS);
  });

  test('strict ingredient queries keep the baseline cache stage budget', async () => {
    const app = require('../../src/server');
    const budgetMs = app._debug.resolveFindProductsMultiCacheStageBudgetMs({
      rawQuery: 'niacinamide serum',
      queryClass: 'category',
      beautyBucket: 'skincare',
      strictConstraintQuery: true,
    });

    expect(budgetMs).toBe(app._debug.FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS);
  });

  test('guidance-only serum discovery gets the raised cache stage budget', async () => {
    const app = require('../../src/server');
    const budgetMs = app._debug.resolveFindProductsMultiCacheStageBudgetMs({
      rawQuery: 'soothing barrier serum sensitive skin',
      queryClass: 'attribute',
      beautyBucket: 'skincare',
      strictConstraintQuery: false,
      guidanceOnlyDiscovery: true,
    });

    expect(budgetMs).toBe(app._debug.FIND_PRODUCTS_MULTI_GENERIC_SKINCARE_CACHE_STAGE_BUDGET_MS);
    expect(budgetMs).toBeGreaterThan(app._debug.FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS);
  });

  test('guidance-only hydration-supportive serum discovery gets the extended cache stage budget', async () => {
    const app = require('../../src/server');
    const budgetMs = app._debug.resolveFindProductsMultiCacheStageBudgetMs({
      rawQuery: 'hydrating serum',
      queryClass: 'attribute',
      beautyBucket: 'skincare',
      strictConstraintQuery: false,
      guidanceOnlyDiscovery: true,
    });

    expect(budgetMs).toBe(
      app._debug.FIND_PRODUCTS_MULTI_GUIDANCE_HYDRATION_SERUM_CACHE_STAGE_BUDGET_MS,
    );
    expect(budgetMs).toBeGreaterThan(
      app._debug.FIND_PRODUCTS_MULTI_GENERIC_SKINCARE_CACHE_STAGE_BUDGET_MS,
    );
  });

  test('guidance-only hydration-supportive serum discovery does not prefer raw-first cache query mode', async () => {
    const app = require('../../src/server');

    expect(
      app._debug.isGuidanceHydrationSupportiveSerumQuery({
        rawQuery: 'hydrating serum',
        queryClass: 'attribute',
        guidanceOnlyDiscovery: true,
      }),
    ).toBe(true);

    expect(
      app._debug.isGuidanceHydrationSupportiveSerumQuery({
        rawQuery: 'soothing barrier serum sensitive skin',
        queryClass: 'attribute',
        guidanceOnlyDiscovery: true,
      }),
    ).toBe(false);
  });

  test('foundation brush query keeps beauty tools results after bucket backstop', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 7 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_a',
                  product_id: 'prod_brush_a',
                  merchant_id: 'merch_tools',
                  title: 'Foundation Brush',
                  description: 'dense makeup brush for liquid base',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_b',
                  product_id: 'prod_brush_b',
                  merchant_id: 'merch_tools',
                  title: 'Foundation Brush Set',
                  description: 'brush set for cream and liquid foundation',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_c',
                  product_id: 'prod_brush_c',
                  merchant_id: 'merch_tools',
                  title: 'Liquid Foundation Brush',
                  description: 'foundation brush for seamless liquid base',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_d',
                  product_id: 'prod_brush_d',
                  merchant_id: 'merch_tools',
                  title: 'Precision Foundation Brush',
                  description: 'precision brush for controlled base application',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_e',
                  product_id: 'prod_brush_e',
                  merchant_id: 'merch_tools',
                  title: 'Foundation Brush Duo',
                  description: 'duo brush set for cream foundation and blending',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'prod_brush_f',
                  product_id: 'prod_brush_f',
                  merchant_id: 'merch_tools',
                  title: 'Travel Foundation Brush',
                  description: 'travel-size brush for foundation touchups',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_serum_noise',
                  product_id: 'prod_serum_noise',
                  merchant_id: 'merch_skin',
                  title: 'Foundation Finish Serum',
                  description: 'skin serum with smoothing finish',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 7,
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
            query: 'foundation brush',
            page: 1,
            limit: 6,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search');
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect((resp.body.products || []).every((item) => /\bbrush\b/i.test(String(item?.title || '')))).toBe(
      true,
    );
    expect(resp.body.metadata?.route_debug?.cross_merchant_cache?.beauty_query_bucket).toBe('tools');
    expect(
      Number(resp.body.metadata?.route_debug?.cross_merchant_cache?.internal_bucket_mix_after?.tools || 0),
    ).toBeGreaterThan(0);
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
    expect(externalSupplement.isDone()).toBe(true);
    expect(
      String(
        resp.body.metadata?.route_debug?.cross_merchant_cache?.supplement?.reason || '',
      ),
    ).toBe('no_external_candidates');
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
      .query((q) => String(q.search_all_merchants || '') === 'true')
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
      .query((q) => String(q.search_all_merchants || '') === 'true')
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

  test('scenario query uses cache early decision when force-controlled-recall is off', async () => {
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
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search_early_decision');
    expect(resp.body.metadata?.search_trace?.upstream_stage?.called).toBe(false);
    expect(
      Boolean(resp.body.metadata?.route_debug?.cross_merchant_cache?.early_decision?.applied),
    ).toBe(true);
    const earlyDecisionReason = String(
      resp.body.metadata?.route_debug?.cross_merchant_cache?.early_decision?.reason || '',
    );
    expect(
      ['cache_miss_ambiguity_sensitive', 'cache_irrelevant_ambiguity_sensitive'].includes(
        earlyDecisionReason,
      ),
    ).toBe(true);
  });

  test('cache products_returned includes stable search trace diagnostics', async () => {
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
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search');
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata?.search_trace).toEqual(
      expect.objectContaining({
        final_decision: 'cache_returned',
        cache_stage: expect.objectContaining({
          hit: true,
        }),
        upstream_stage: expect.objectContaining({
          called: false,
        }),
      }),
    );
    expect(upstreamSearch.isDone()).toBe(false);
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

  test('dog leash query returns fail-open fallback with primary_irrelevant_no_fallback when upstream is irrelevant', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));
    process.env.SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO = 'true';

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_brush_1',
            product_id: 'prod_brush_1',
            merchant_id: 'merch_beauty',
            title: 'Foundation Brush Set',
            description: 'Makeup brush kit',
            status: 'active',
            inventory_quantity: 12,
            price: 19,
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
            query: '中型犬夜间反光防爆冲狗链推荐，预算50',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'codex_debug',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(resp.body.metadata?.query_source).toBe('agent_products_error_fallback');
    expect(resp.body.metadata?.strict_empty).toBe(true);
    expect(
      ['primary_irrelevant_no_fallback', 'semantic_retry_exhausted', 'fallback_not_better'].includes(
        String(resp.body.metadata?.proxy_search_fallback?.reason || ''),
      ),
    ).toBe(true);
    expect(String(resp.body.metadata?.proxy_search_fallback?.route || '').length).toBeGreaterThan(0);
    expect(resp.body.metadata?.route_health?.fallback_triggered).toBe(true);
  });

  test('brand-like public search uses brand-search mainline with real total when upstream returns zero products', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds') && text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 40 }] };
        }
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        const now = new Date().toISOString();
        return {
          rows: Array.from({ length: 40 }, (_, index) => ({
            id: `seed_fenty_${index + 1}`,
            external_product_id: `seed_fenty_${index + 1}`,
            destination_url: `https://fentybeauty.example.com/products/fenty-item-${index + 1}`,
            canonical_url: `https://fentybeauty.example.com/products/fenty-item-${index + 1}`,
            domain: 'fentybeauty.example.com',
            title:
              index % 3 === 0
                ? `Fenty Skin Serum ${index + 1}`
                : index % 3 === 1
                ? `Fenty Beauty Gloss Bomb ${index + 1}`
                : `Fenty Hair Treatment ${index + 1}`,
            image_url: `https://cdn.example.com/fenty-${index + 1}.jpg`,
            price_amount: String(30 + index),
            price_currency: 'USD',
            availability: 'in stock',
            seed_data: {
              brand: 'Fenty',
              category: index % 3 === 0 ? 'serum' : index % 3 === 1 ? 'makeup' : 'haircare',
              snapshot: {
                title:
                  index % 3 === 0
                    ? `Fenty Skin Serum ${index + 1}`
                    : index % 3 === 1
                    ? `Fenty Beauty Gloss Bomb ${index + 1}`
                    : `Fenty Hair Treatment ${index + 1}`,
                brand: 'Fenty',
                category: index % 3 === 0 ? 'serum' : index % 3 === 1 ? 'makeup' : 'haircare',
                product_type: index % 3 === 0 ? 'serum' : index % 3 === 1 ? 'lip gloss' : 'hair treatment',
              },
            },
            updated_at: now,
            created_at: now,
          })),
        };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'fenty')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'fenty',
            page: 1,
            limit: 24,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(false);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products.length).toBe(24);
    expect(resp.body.total).toBeGreaterThan(resp.body.products.length);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
      }),
    );
    expect(
      resp.body.products.some((product) =>
        String(
          product?.external_redirect_url ||
            product?.destination_url ||
            product?.canonical_url ||
            product?.url ||
            '',
        ).includes('fentybeauty'),
      ),
    ).toBe(true);
    expect(resp.body.metadata?.query_source).toBe('agent_products_public_brand_search_mainline');
    expect(resp.body.metadata?.brand_query_mainline_applied).toBe(true);
    expect(resp.body.metadata?.brand_query_mainline_upstream_skipped).toBe(true);
    expect(resp.body.metadata?.semantic_rewrite_result?.fallback_reason).toBe(
      'semantic_rewrite_skipped_brand_search',
    );
    expect(resp.body.metadata?.route_trace?.primary_path_used).toBe('brand_search_multi_source');
    expect(resp.body.metadata?.route_health?.fallback_triggered).toBe(false);
    expect(resp.body.metadata?.route_health?.upstream_search_skipped).toBe(true);
    expect(resp.body.metadata?.search_decision?.final_decision).toBe('products_returned');
    expect(resp.body.metadata?.external_seed_rows_built).toBeGreaterThanOrEqual(resp.body.products.length);
    expect(resp.body.reply).not.toBe('Search is temporarily unavailable. Please retry shortly.');
  });

  test('brand-like public search preserves nested payload metadata source for mainline routing', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds') && text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 40 }] };
        }
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        const now = new Date().toISOString();
        return {
          rows: Array.from({ length: 40 }, (_, index) => ({
            id: `seed_fenty_nested_${index + 1}`,
            external_product_id: `seed_fenty_nested_${index + 1}`,
            destination_url: `https://fentybeauty.example.com/products/fenty-nested-${index + 1}`,
            canonical_url: `https://fentybeauty.example.com/products/fenty-nested-${index + 1}`,
            domain: 'fentybeauty.example.com',
            title:
              index % 2 === 0
                ? `Fenty Beauty Match Stix ${index + 1}`
                : `Fenty Skin Serum ${index + 1}`,
            image_url: `https://cdn.example.com/fenty-nested-${index + 1}.jpg`,
            price_amount: String(28 + index),
            price_currency: 'USD',
            availability: 'in stock',
            seed_data: {
              brand: 'Fenty',
              category: index % 2 === 0 ? 'makeup' : 'serum',
              snapshot: {
                title:
                  index % 2 === 0
                    ? `Fenty Beauty Match Stix ${index + 1}`
                    : `Fenty Skin Serum ${index + 1}`,
                brand: 'Fenty',
                category: index % 2 === 0 ? 'makeup' : 'serum',
                product_type: index % 2 === 0 ? 'makeup stick' : 'serum',
              },
            },
            updated_at: now,
            created_at: now,
          })),
        };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'fenty')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'fenty',
            page: 1,
            limit: 24,
            in_stock_only: true,
          },
          metadata: {
            source: 'search',
          },
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(false);
    expect(resp.body.metadata?.guard_source_normalized).toBe('search');
    expect(resp.body.metadata?.query_source).toBe('agent_products_public_brand_search_mainline');
    expect(resp.body.metadata?.brand_query_mainline_upstream_skipped).toBe(true);
    expect(resp.body.metadata?.semantic_rewrite_result?.fallback_reason).toBe(
      'semantic_rewrite_skipped_brand_search',
    );
    expect(resp.body.metadata?.route_trace?.primary_path_used).toBe('brand_search_multi_source');
    expect(resp.body.metadata?.route_health?.fallback_triggered).toBe(false);
    expect(resp.body.metadata?.route_health?.upstream_search_skipped).toBe(true);
    expect(resp.body.total).toBeGreaterThan(resp.body.page_size || 0);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBe(24);
  });

  test('brand-like public search does not collapse into generic error fallback when upstream returns empty', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds') && text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }
        return { rows: [] };
      },
    }));

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'fenty')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'fenty',
            page: 1,
            limit: 24,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'search',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata?.query_source).not.toBe('agent_products_error_fallback');
    expect(resp.body.metadata?.route_health?.fallback_triggered).not.toBe(true);
    expect(resp.body.reply).not.toBe('Search is temporarily unavailable. Please retry shortly.');
  });

  test('primary unusable nonempty upstream results collapse to strict empty when fallback rails are disabled', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'blue tote bag')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            title: 'Blue Tote Bag',
            description: 'Canvas carryall with no merchant binding',
            price: 29,
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
            query: 'blue tote bag',
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
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata?.strict_empty).toBe(true);
    expect(resp.body.metadata?.strict_empty_reason).toBe('primary_unusable_no_fallback');
    expect(resp.body.metadata?.proxy_search_fallback?.reason).toBe('primary_unusable_no_fallback');
  });

  test('fashion multi-constraint query returns visible intent metadata on generic upstream lane', async () => {
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
      .query((q) => String(q.merchant_id || '') === 'external_seed')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'blue striped sweater' && !String(q.merchant_id || ''))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_sweater_blue_striped_1',
            product_id: 'prod_sweater_blue_striped_1',
            merchant_id: 'merch_live_1',
            title: 'Blue Striped Knitted Sweater',
            description: 'Classic striped knit sweater for women.',
            status: 'active',
            inventory_quantity: 6,
            price: 27.65,
            currency: 'EUR',
            variants: [
              {
                id: 'var_blue_1',
                title: 'Medium / Blue',
                options: { Size: 'Medium', Color: 'Blue' },
              },
            ],
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'blue striped sweater',
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
    expect(externalSupplement.isDone()).toBe(true);
    expect(resp.body.metadata?.visible_category_intents).toEqual(['sweater']);
    expect(resp.body.metadata?.visible_attribute_intents).toEqual(['striped']);
    expect(resp.body.metadata?.visible_option_intents).toEqual(['color_blue']);
    expect(resp.body.metadata?.matched_visible_categories).toEqual(['sweater']);
    expect(resp.body.metadata?.matched_visible_attribute_labels).toEqual(['striped']);
    expect(resp.body.metadata?.matched_visible_option_labels).toEqual(['color_blue']);
  });

  test('second-stage supplement skips risky broadened fashion expansion instead of appending drifted products', async () => {
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
      .query((q) => String(q.merchant_id || '') === 'external_seed')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'blue striped sweater' && !String(q.merchant_id || ''))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_sweater_blue_striped_1',
            product_id: 'prod_sweater_blue_striped_1',
            merchant_id: 'merch_live_1',
            title: 'Blue Striped Knitted Sweater',
            description: 'Classic striped knit sweater for women.',
            status: 'active',
            inventory_quantity: 6,
            price: 27.65,
            currency: 'EUR',
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_search',
        },
      });

    const riskySecondStage = nock('http://pivota.test')
      .get('/agent/v2/products/search')
      .query((q) => {
        const query = String(q.query || '');
        return (
          query.includes('blue striped sweater') &&
          query.includes('dress') &&
          query.includes('skirt') &&
          query.includes('outfit')
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_dress_blue_striped_1',
            product_id: 'prod_dress_blue_striped_1',
            merchant_id: 'merch_live_2',
            title: 'Blue Striped Summer Dress',
            description: 'Blue striped dress for women.',
            status: 'active',
            inventory_quantity: 8,
            price: 31.99,
            currency: 'EUR',
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
            query: 'blue striped sweater',
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
    expect(externalSupplement.isDone()).toBe(true);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(riskySecondStage.isDone()).toBe(false);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'prod_sweater_blue_striped_1',
      }),
    );
    expect(resp.body.metadata?.search_stage_b).toEqual(
      expect.objectContaining({
        attempted: true,
        applied: false,
        reason: 'disabled_for_risky_broadening',
        query_class: 'category',
      }),
    );
    expect(resp.body.metadata?.search_stage_b?.added_tokens || []).toEqual(
      expect.arrayContaining(['dress', 'skirt', 'outfit']),
    );
  });

  test('fashion multi-constraint query filters generic upstream results to strict visible matches', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        return { rows: [] };
      },
    }));

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.merchant_id || '') === 'external_seed')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const mixedUpstreamBody = {
      status: 'success',
      success: true,
      products: [
        {
          id: 'prod_vest_xl_1',
          product_id: 'prod_vest_xl_1',
          merchant_id: 'merch_pet_1',
          title: 'Warm Polar Fleece Vest',
          description: 'Insulated polar fleece vest for cold weather.',
          status: 'active',
          inventory_quantity: 8,
          price: 22.93,
          currency: 'EUR',
          variants: [
            {
              id: 'var_vest_xl_1',
              title: 'XL / Blue',
              options: { Size: 'XL', Color: 'Blue' },
            },
          ],
        },
        {
          id: 'prod_vest_m_1',
          product_id: 'prod_vest_m_1',
          merchant_id: 'merch_pet_1',
          title: 'Warm Polar Fleece Vest',
          description: 'Insulated polar fleece vest for cold weather.',
          status: 'active',
          inventory_quantity: 8,
          price: 22.93,
          currency: 'EUR',
          variants: [
            {
              id: 'var_vest_m_1',
              title: 'M / Blue',
              options: { Size: 'M', Color: 'Blue' },
            },
          ],
        },
        {
          id: 'prod_beauty_1',
          product_id: 'prod_beauty_1',
          merchant_id: 'merch_beauty_1',
          title: 'Supersize Hydrating Milky Mist',
          description: 'Hydrating beauty mist with extra large bottle.',
          status: 'active',
          inventory_quantity: 20,
          price: 25,
          currency: 'USD',
        },
      ],
      total: 3,
      metadata: {
        query_source: 'agent_products_search',
      },
    };

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes('polar fleece vest size xl') && !String(q.merchant_id || ''))
      .reply(200, mixedUpstreamBody);

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'polar fleece vest size xl',
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
    expect(externalSupplement.isDone()).toBe(true);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.map((item) => item.product_id || item.id)).toEqual(['prod_vest_xl_1']);
    expect(resp.body.metadata?.visible_category_intents).toEqual(['vest']);
    expect(resp.body.metadata?.visible_attribute_intents).toEqual(['fleece']);
    expect(resp.body.metadata?.visible_option_intents).toEqual(['size_xl']);
    expect(resp.body.metadata?.matched_visible_categories).toEqual(['vest']);
    expect(resp.body.metadata?.matched_visible_attribute_labels).toEqual(['fleece']);
    expect(resp.body.metadata?.matched_visible_option_labels).toEqual(['size_xl']);
    expect(resp.body.reason_codes || []).toEqual(expect.arrayContaining(['FASHION_VISIBLE_CONSTRAINT_FILTERED']));
  });

  test('fashion raw-query constraints still apply on cache hits when intent extraction misses', async () => {
    jest.doMock('../../src/findProductsMulti/policy', () => {
      const actual = jest.requireActual('../../src/findProductsMulti/policy');
      return {
        ...actual,
        buildFindProductsMultiContext: async ({ payload }) => ({
          adjustedPayload: payload,
          intent: null,
          expansion_meta: null,
          rawUserQuery: payload?.search?.query || payload?.query || '',
        }),
      };
    });
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 3 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_fashion_1',
                merchant_name: 'Fashion One',
                product_data: {
                  id: 'prod_sweater_m_1',
                  product_id: 'prod_sweater_m_1',
                  merchant_id: 'merch_fashion_1',
                  title: 'Classic Knitted Sweater',
                  description: 'Soft knit sweater for everyday wear.',
                  status: 'published',
                  inventory_quantity: 8,
                  variants: [
                    {
                      id: 'var_sweater_m_1',
                      title: 'M / Black',
                      options: { Size: 'M', Color: 'Black' },
                    },
                  ],
                },
              },
              {
                merchant_id: 'merch_fashion_1',
                merchant_name: 'Fashion One',
                product_data: {
                  id: 'prod_sweater_xl_1',
                  product_id: 'prod_sweater_xl_1',
                  merchant_id: 'merch_fashion_1',
                  title: 'Classic Knitted Sweater',
                  description: 'Soft knit sweater for everyday wear.',
                  status: 'published',
                  inventory_quantity: 8,
                  variants: [
                    {
                      id: 'var_sweater_xl_1',
                      title: 'XL / Black',
                      options: { Size: 'XL', Color: 'Black' },
                    },
                  ],
                },
              },
              {
                merchant_id: 'merch_sleepwear_1',
                merchant_name: 'Sleepwear One',
                product_data: {
                  id: 'prod_sleepwear_1',
                  product_id: 'prod_sleepwear_1',
                  merchant_id: 'merch_sleepwear_1',
                  title: "Sweet Satin Lace Plus Size women's sleepwear set 4905",
                  description: 'Velvet lace sleepwear set for women.',
                  status: 'published',
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
            query: 'sweater size m',
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
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search');
    expect(resp.body.metadata?.visible_category_intents).toEqual(['sweater']);
    expect(resp.body.metadata?.visible_attribute_intents).toEqual([]);
    expect(resp.body.metadata?.visible_option_intents).toEqual(['size_m']);
    expect(resp.body.metadata?.matched_visible_categories).toEqual(['sweater']);
    expect(resp.body.metadata?.matched_visible_attribute_labels).toEqual([]);
    expect(resp.body.metadata?.matched_visible_option_labels).toEqual(['size_m']);
    expect(resp.body.products.map((item) => item.product_id || item.id)).toEqual(['prod_sweater_m_1']);
    expect(resp.body.reason_codes || []).toEqual(expect.arrayContaining(['FASHION_VISIBLE_CONSTRAINT_FILTERED']));
  });

  test('fashion raw-query constraints still apply on resolver fallback when intent extraction misses', async () => {
    jest.doMock('../../src/findProductsMulti/policy', () => {
      const actual = jest.requireActual('../../src/findProductsMulti/policy');
      return {
        ...actual,
        buildFindProductsMultiContext: async ({ payload }) => ({
          adjustedPayload: payload,
          intent: null,
          expansion_meta: null,
          rawUserQuery: payload?.search?.query || payload?.query || '',
        }),
      };
    });
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
      .query((q) => String(q.merchant_id || '') === 'external_seed')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const upstreamSearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'striped sweater' && !String(q.merchant_id || ''))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'prod_sweater_striped_1',
            product_id: 'prod_sweater_striped_1',
            merchant_id: 'merch_fashion_1',
            title: 'Warm Fall/Winter Striped Knitted Sweater',
            description: 'Striped knitted sweater for everyday wear.',
            status: 'active',
            inventory_quantity: 6,
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_resolver_fallback',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'striped sweater',
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
    expect(externalSupplement.isDone()).toBe(true);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(resp.body.metadata?.query_source).toBe('agent_products_resolver_fallback');
    expect(resp.body.metadata?.visible_category_intents).toEqual(['sweater']);
    expect(resp.body.metadata?.visible_attribute_intents).toEqual(['striped']);
    expect(resp.body.metadata?.visible_option_intents).toEqual([]);
    expect(resp.body.metadata?.matched_visible_categories).toEqual(['sweater']);
    expect(resp.body.metadata?.matched_visible_attribute_labels).toEqual(['striped']);
    expect(resp.body.metadata?.matched_visible_option_labels).toEqual([]);
    expect(resp.body.products.map((item) => item.product_id || item.id)).toEqual(['prod_sweater_striped_1']);
  });
});
