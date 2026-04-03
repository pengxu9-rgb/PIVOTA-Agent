const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi shopping mainline', () => {
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
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED: process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
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
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    } else {
      process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
        prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    }
  });

  test('keeps shopping search on fresh upstream with unified external seed blending', async () => {
    let capturedBody = null;
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .query(true)
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            {
              product_id: 'prod_1',
              merchant_id: 'merch_1',
              title: 'Niacinamide Serum',
              description: 'Fresh upstream result',
            },
          ],
          total: 1,
          metadata: {
            query_source: 'agent_products_search',
          },
        };
      });

    const legacySearch = nock('http://pivota.test')
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
            query: 'niacinamide serum',
            limit: 10,
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        operation: 'find_products_multi',
        payload: expect.objectContaining({
          search: expect.objectContaining({
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
            query: 'niacinamide serum',
            request_context: expect.objectContaining({
              channel: 'shopping_agent',
            }),
          }),
        }),
        metadata: expect.objectContaining({
          source: 'shopping_agent',
        }),
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_search',
      }),
    );
  });

  test('returns strict empty instead of adopting cache or resolver fallback on upstream failure', async () => {
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(500, {
        error: 'UPSTREAM_FAILURE',
        message: 'backend failed',
      });

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'legacy_1',
            merchant_id: 'legacy_merchant',
            title: 'Legacy fallback product',
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
            query: 'barrier repair cream',
            limit: 10,
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        strict_empty: true,
        strict_empty_reason: expect.stringMatching(/^shopping_mainline_(exception|upstream_5xx)$/),
      }),
    );
  });

  test('does not recover shopping strict queries from prefetched external seed cache', async () => {
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'agent_products_error_fallback',
          strict_empty: true,
          strict_empty_reason: 'shopping_mainline_timeout',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'niacinamide serum',
            limit: 10,
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'shopping_agent',
          external_seed_candidates: [
            {
              product_id: 'ext_prefetched_1',
              merchant_id: 'external_seed',
              title: 'Prefetched recovery product',
              price: 12.5,
              currency: 'USD',
            },
          ],
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        strict_empty: true,
      }),
    );
    expect(resp.body.metadata.query_source).not.toBe('cache_multi_intent');
  });

  test('does not let shopping cache-stage short-circuit fresh upstream search', async () => {
    process.env.DATABASE_URL = 'postgres://test';

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
                merchant_id: 'merch_cache_1',
                merchant_name: 'Cache Merchant',
                product_data: {
                  id: 'cache_only_product',
                  product_id: 'cache_only_product',
                  merchant_id: 'merch_cache_1',
                  title: 'Cached Niacinamide Serum',
                  description: 'Should not short-circuit shopping mainline',
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

    let capturedBody = null;
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .query(true)
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            {
              product_id: 'fresh_upstream_1',
              merchant_id: 'merch_fresh_1',
              title: 'Fresh Niacinamide Serum',
              description: 'Fresh upstream result',
            },
          ],
          total: 1,
          metadata: {
            query_source: 'agent_products_search',
          },
        };
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'niacinamide serum',
            limit: 10,
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        operation: 'find_products_multi',
        metadata: expect.objectContaining({
          source: 'shopping_agent',
        }),
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_search',
      }),
    );
  });
});
