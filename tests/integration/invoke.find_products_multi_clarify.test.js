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

  test('explicit scenario query does not ask scenario again', async () => {
    jest.doMock('../../src/db', () => ({
      query: async () => ({ rows: [] }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '今晚要出去约会，有什么推荐用的',
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
        slot: 'category',
        dedup_key: expect.stringMatching(/^category:/),
      }),
    );
    expect(resp.body.clarification.reason_code).not.toBe('CLARIFY_SCENARIO');
    const slotState =
      resp.body.metadata?.search_trace?.slot_state ||
      resp.body.metadata?.search_decision?.slot_state;
    expect(slotState).toEqual(
      expect.objectContaining({
        asked_slots: expect.arrayContaining(['category']),
      }),
    );
  });

  test('category answer after clarify returns products without second clarify', async () => {
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
                  id: 'perfume_1',
                  product_id: 'perfume_1',
                  merchant_id: 'merch_1',
                  title: 'Floral Perfume',
                  description: 'fragrance perfume for date night',
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
            query: '香水',
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
    expect(resp.body.clarification).toBeUndefined();
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(['products_returned', 'cache_returned']).toContain(
      resp.body.metadata?.search_trace?.final_decision,
    );
    expect(resp.body.metadata?.search_trace?.query_class).toBe('category');
  });

  test('agent_sdk_fixed_delegate treats category answer as shopping search and keeps external seed enabled', async () => {
    jest.doMock('../../src/db', () => ({
      query: async () => ({ rows: [] }),
    }));

    const seenQueries = [];
    const upstreamScope = nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply((uri) => {
        const query = new URLSearchParams(String(uri || '').split('?')[1] || '');
        seenQueries.push(Object.fromEntries(query.entries()));
        return [
          200,
          {
            status: 'success',
            success: true,
            total: 1,
            page: 1,
            page_size: 1,
            products: [
              {
                id: 'tom_ford_1',
                product_id: 'tom_ford_1',
                merchant_id: 'external_seed',
                source: 'external_seed',
                title: 'Tom Ford Noir Extreme Eau de Parfum',
                description: 'fragrance perfume for date night',
                price: 168,
                currency: 'USD',
                inventory_quantity: 8,
                status: 'published',
              },
            ],
            metadata: {
              source: 'agent_sdk_fixed_delegate',
              query_source: 'agent_products_search',
            },
          },
        ];
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '香水',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification).toBeUndefined();
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
      }),
    );
    expect(String(resp.body.products[0].title || '')).toMatch(/tom ford/i);
    expect(
      seenQueries.some(
        (q) =>
          String(q.allow_external_seed || '').toLowerCase() === 'true' &&
          String(q.external_seed_strategy || '') === 'supplement_internal_first' &&
          String(q.query || '').includes('香水'),
      ),
    ).toBe(true);
    expect(
      seenQueries.some((q) => String(q.merchant_id || '') === 'external_seed'),
    ).toBe(true);
    expect(upstreamScope.isDone()).toBe(true);
    nock.cleanAll();
  });

  test('fragrance category with irrelevant primary results backfills external-seed perfumes', async () => {
    jest.doMock('../../src/db', () => ({
      query: async () => ({ rows: [] }),
    }));

    let primaryCalled = false;
    let externalSeedCalled = false;
    const upstreamScope = nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply((uri) => {
        const query = new URLSearchParams(String(uri || '').split('?')[1] || '');
        const merchantId = String(query.get('merchant_id') || '');
        if (merchantId === 'external_seed') {
          externalSeedCalled = true;
          return [
            200,
            {
              status: 'success',
              success: true,
              total: 1,
              page: 1,
              page_size: 1,
              products: [
                {
                  id: 'tom_ford_2',
                  product_id: 'tom_ford_2',
                  merchant_id: 'external_seed',
                  source: 'external_seed',
                  title: 'Tom Ford Black Orchid Eau de Parfum',
                  description: 'fragrance perfume',
                  price: 172,
                  currency: 'USD',
                  inventory_quantity: 6,
                  status: 'published',
                },
              ],
            },
          ];
        }
        primaryCalled = true;
        return [
          200,
          {
            status: 'success',
            success: true,
            total: 2,
            page: 1,
            page_size: 2,
            products: [
              {
                id: 'brush_1',
                product_id: 'brush_1',
                merchant_id: 'merch_efbc46b4619cfbdf',
                title: 'Contour Brush',
                description: 'makeup contour brush',
                price: 19,
                currency: 'USD',
                inventory_quantity: 12,
                status: 'published',
              },
            ],
          },
        ];
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '香水',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification).toBeUndefined();
    expect(primaryCalled || externalSeedCalled).toBe(true);
    expect(externalSeedCalled).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(
      (resp.body.products || []).some(
        (product) =>
          String(product.merchant_id || '') === 'external_seed' &&
          /tom ford/i.test(String(product.title || '')),
      ),
    ).toBe(true);
    nock.cleanAll();
    expect(upstreamScope.isDone()).toBe(true);
  });

  test('fragrance supplement retries external seed with brand hints when first pass is irrelevant', async () => {
    jest.doMock('../../src/db', () => ({
      query: async () => ({ rows: [] }),
    }));

    const externalSeedQueries = [];
    const upstreamScope = nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply((uri) => {
        const query = new URLSearchParams(String(uri || '').split('?')[1] || '');
        const merchantId = String(query.get('merchant_id') || '');
        const queryText = String(query.get('query') || '');

        if (merchantId !== 'external_seed') {
          return [
            200,
            {
              status: 'success',
              success: true,
              total: 1,
              page: 1,
              page_size: 1,
              products: [
                {
                  id: 'brush_2',
                  product_id: 'brush_2',
                  merchant_id: 'merch_efbc46b4619cfbdf',
                  title: 'Contour Brush',
                  description: 'makeup contour brush',
                  price: 19,
                  currency: 'USD',
                  inventory_quantity: 12,
                  status: 'published',
                },
              ],
            },
          ];
        }

        externalSeedQueries.push(queryText);
        if (externalSeedQueries.length === 1) {
          return [
            200,
            {
              status: 'success',
              success: true,
              total: 1,
              page: 1,
              page_size: 1,
              products: [
                {
                  id: 'non_perfume_1',
                  product_id: 'non_perfume_1',
                  merchant_id: 'external_seed',
                  source: 'external_seed',
                  title: 'The Ordinary Collection Set',
                  description: 'hydration skincare set',
                  price: 68,
                  currency: 'USD',
                  inventory_quantity: 10,
                  status: 'published',
                },
              ],
            },
          ];
        }

        return [
          200,
          {
            status: 'success',
            success: true,
            total: 1,
            page: 1,
            page_size: 1,
            products: [
              {
                id: 'tom_ford_retry_1',
                product_id: 'tom_ford_retry_1',
                merchant_id: 'external_seed',
                source: 'external_seed',
                title: 'Tom Ford Noir Extreme Eau de Parfum',
                description: 'fragrance perfume for date night',
                price: 168,
                currency: 'USD',
                inventory_quantity: 8,
                status: 'published',
              },
            ],
          },
        ];
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '香水',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification).toBeUndefined();
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(
      (resp.body.products || []).some(
        (product) =>
          String(product.merchant_id || '') === 'external_seed' &&
          /tom ford/i.test(String(product.title || '')),
      ),
    ).toBe(true);
    expect(externalSeedQueries.length).toBeGreaterThanOrEqual(2);
    nock.cleanAll();
    expect(upstreamScope.isDone()).toBe(true);
  });

  test('external-seed fragrance result backfills image_url from image_urls and prefers https', async () => {
    jest.doMock('../../src/db', () => ({
      query: async () => ({ rows: [] }),
    }));

    const upstreamScope = nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .reply((uri) => {
        const query = new URLSearchParams(String(uri || '').split('?')[1] || '');
        const merchantId = String(query.get('merchant_id') || '');
        if (merchantId === 'external_seed') {
          return [
            200,
            {
              status: 'success',
              success: true,
              total: 1,
              page: 1,
              page_size: 1,
              products: [
                {
                  id: 'tom_ford_img_1',
                  product_id: 'tom_ford_img_1',
                  merchant_id: 'external_seed',
                  source: 'external_seed',
                  title: 'Tom Ford Noir Extreme Eau de Parfum',
                  description: 'fragrance perfume for date night',
                  image_url: null,
                  images: [],
                  image_urls: [
                    'http://sdcdn.io/tf/tf_sku_T14Q01_3000x3000_0.png?width=2048',
                    'https://sdcdn.io/tf/tf_sku_T14Q01_3000x3000_0.png?width=1200',
                    'https://sdcdn.io/tf/tf_sku_T14Q01_2000x2000_1.jpg',
                  ],
                  price: 168,
                  currency: 'USD',
                  inventory_quantity: 8,
                  status: 'published',
                },
              ],
            },
          ];
        }
        return [
          200,
          {
            status: 'success',
            success: true,
            total: 1,
            page: 1,
            page_size: 1,
            products: [
              {
                id: 'brush_for_image_test',
                product_id: 'brush_for_image_test',
                merchant_id: 'merch_efbc46b4619cfbdf',
                title: 'Contour Brush',
                description: 'makeup contour brush',
                price: 19,
                currency: 'USD',
                inventory_quantity: 12,
                status: 'published',
              },
            ],
          },
        ];
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '香水',
            page: 1,
            limit: 10,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    expect(resp.status).toBe(200);
    const externalSeedProduct = (resp.body.products || []).find(
      (product) => String(product.merchant_id || '') === 'external_seed',
    );
    expect(externalSeedProduct).toBeTruthy();
    expect(String(externalSeedProduct.image_url || '')).toBe(
      'https://sdcdn.io/tf/tf_sku_T14Q01_3000x3000_0.png?width=1200',
    );
    expect(Array.isArray(externalSeedProduct.images)).toBe(true);
    expect(String(externalSeedProduct.images[0] || '')).toBe(
      'https://sdcdn.io/tf/tf_sku_T14Q01_3000x3000_0.png?width=1200',
    );
    nock.cleanAll();
    expect(upstreamScope.isDone()).toBe(true);
  });

  test('fragrance query can recover products from beauty fallback without extra clarify', async () => {
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => {
        const text = String(sql || '');

        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }

        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          const firstParam = Array.isArray(params) ? String(params[0] || '') : '';
          const isBeautyFallbackRegex = /perfume|fragrance|cologne/i.test(firstParam);
          if (isBeautyFallbackRegex) {
            return {
              rows: [
                {
                  merchant_id: 'merch_1',
                  merchant_name: 'Merchant One',
                  product_data: {
                    id: 'perfume_fb_1',
                    product_id: 'perfume_fb_1',
                    merchant_id: 'merch_1',
                    title: 'Night Bloom Perfume',
                    description: 'eau de parfum fragrance for date night',
                    status: 'published',
                    inventory_quantity: 6,
                  },
                },
              ],
            };
          }
          return { rows: [] };
        }

        if (text.includes('FROM products_cache')) {
          return { rows: [] };
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
            query: '香水',
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
    expect(resp.body.clarification).toBeUndefined();
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products[0].title || '').toMatch(/perfume/i);
    expect(['products_returned', 'cache_returned']).toContain(
      resp.body.metadata?.search_trace?.final_decision,
    );
  });
});
