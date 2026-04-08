process.env.PIVOTA_API_BASE = 'http://catalog.test';
process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'MOCK';

const nock = require('nock');
const request = require('supertest');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke get_discovery_feed', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('ignores legacy API_MODE=MOCK and still recalls discovery candidates from products/search', async () => {
    nock('http://catalog.test')
      .matchHeader('x-api-key', 'test-token')
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .reply(200, {
        products: [
          {
            merchant_id: 'm1',
            product_id: 'headphone_1',
            title: 'Wireless Bluetooth Headphones',
            brand: 'SonicWave',
            category: 'Electronics',
            product_type: 'Headphones',
            inventory_quantity: 12,
            status: 'active',
          },
          {
            merchant_id: 'm2',
            product_id: 'speaker_1',
            title: 'Portable Bluetooth Speaker',
            brand: 'Voltix',
            category: 'Electronics',
            product_type: 'Speaker',
            inventory_quantity: 9,
            status: 'active',
          },
          {
            merchant_id: 'm3',
            product_id: 'camera_1',
            title: 'Indoor Smart Security Camera',
            brand: 'HomeSight',
            category: 'Electronics',
            product_type: 'Camera',
            inventory_quantity: 7,
            status: 'active',
          },
        ],
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_discovery_feed',
        payload: {
          surface: 'home_hot_deals',
          page: 1,
          limit: 4,
          debug: true,
          context: {
            auth_state: 'authenticated',
            locale: 'en-US',
            recent_views: [
              {
                merchant_id: 'merch_208139f7600dbf42',
                product_id: 'ECHO_DOT_5',
                title: 'Echo Dot (5th Gen) Smart Speaker with Alexa',
                category: 'Electronics',
                product_type: 'Electronics',
                viewed_at: '2026-04-04T10:00:00Z',
              },
            ],
            recent_queries: ['wireless headphones'],
          },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products.map((product) => product.product_id)).not.toContain('ECHO_DOT_5');
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        discovery_strategy: 'personalized_interest',
        personalization_source: 'account_history',
        scoring_version: 'discovery_v2',
        surface: 'home_hot_deals',
        candidate_source: 'multi_provider',
        provider_breakdown: expect.any(Array),
        rank_debug: expect.any(Object),
      }),
    );
    expect(Array.isArray(res.body.metadata.rank_debug.top_candidates)).toBe(true);
    expect(Array.isArray(res.body.metadata.rank_debug.recall_summary)).toBe(true);
  });

  test('fails open with an empty discovery payload when providers are unavailable', async () => {
    const previousApiBase = process.env.PIVOTA_API_BASE;
    const previousBackendBaseUrl = process.env.PIVOTA_BACKEND_BASE_URL;
    const previousDiscoveryBaseUrl = process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;

    delete process.env.PIVOTA_API_BASE;
    delete process.env.PIVOTA_BACKEND_BASE_URL;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    delete process.env.DATABASE_URL;

    try {
      const res = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({
          operation: 'get_discovery_feed',
          payload: {
            surface: 'home_hot_deals',
            page: 1,
            limit: 6,
            context: {
              auth_state: 'anonymous',
              locale: 'en-US',
              recent_views: [],
              recent_queries: [],
            },
          },
        })
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          status: 'success',
          success: true,
          products: [],
          total: 0,
          page: 1,
          page_size: 0,
          metadata: expect.objectContaining({
            surface: 'home_hot_deals',
            locale: 'en-US',
            catalog_status: 'unavailable',
            error_code: 'DISCOVERY_CATALOG_UNAVAILABLE',
            provider_breakdown: expect.any(Array),
            recall_summary: expect.any(Array),
            candidate_counts: expect.objectContaining({
              raw: 0,
              normalized: 0,
              scored: 0,
              eligiblePool: 0,
              returned: 0,
            }),
          }),
        }),
      );
    } finally {
      process.env.PIVOTA_API_BASE = previousApiBase;
      process.env.PIVOTA_BACKEND_BASE_URL = previousBackendBaseUrl;
      if (previousDiscoveryBaseUrl === undefined) delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
      else process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = previousDiscoveryBaseUrl;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  test('fails open with provider diagnostics when products_search is unauthorized', async () => {
    const previousDiscoveryBaseUrl = process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    const previousDiscoveryApiKey = process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
    const previousDatabaseUrl = process.env.DATABASE_URL;

    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'bad-token';
    delete process.env.DATABASE_URL;

    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(401, { error: 'unauthorized' });

    try {
      const res = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({
          operation: 'get_discovery_feed',
          payload: {
            surface: 'home_hot_deals',
            page: 1,
            limit: 6,
            context: {
              auth_state: 'anonymous',
              locale: 'en-US',
              recent_views: [],
              recent_queries: [],
            },
          },
        })
        .expect(200);

      expect(res.body.metadata).toEqual(
        expect.objectContaining({
          catalog_status: 'unavailable',
          provider_breakdown: expect.arrayContaining([
            expect.objectContaining({
              provider: 'products_search',
              successful: false,
              failure_reason: 'http_401',
            }),
          ]),
        }),
      );
    } finally {
      if (previousDiscoveryBaseUrl === undefined) delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
      else process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = previousDiscoveryBaseUrl;
      if (previousDiscoveryApiKey === undefined) delete process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
      else process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = previousDiscoveryApiKey;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  test('browse_products serves warm cache when discovery base URL disappears', async () => {
    const previousDiscoveryBaseUrl = process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
    const previousDiscoveryApiKey = process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
    const previousBackendBaseUrl = process.env.PIVOTA_BACKEND_BASE_URL;
    const previousApiBase = process.env.PIVOTA_API_BASE;

    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'test-token';

    nock('http://catalog.test')
      .get('/agent/v1/products/search')
      .query(true)
      .once()
      .reply(200, {
        products: Array.from({ length: 6 }, (_, idx) => ({
          merchant_id: `m${idx + 1}`,
          product_id: `warm_${idx + 1}`,
          title: `Warm ${idx + 1}`,
          category: 'Skincare',
          product_type: 'Serum',
          inventory_quantity: 8,
          status: 'active',
        })),
      });

    try {
      const basePayload = {
        operation: 'get_discovery_feed',
        payload: {
          surface: 'browse_products',
          page: 1,
          limit: 2,
          debug: true,
          context: {
            auth_state: 'anonymous',
            locale: 'en-US',
            recent_views: [],
            recent_queries: [],
          },
        },
      };

      const firstPage = await request(app).post('/agent/shop/v1/invoke').send(basePayload).expect(200);
      delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
      delete process.env.PIVOTA_BACKEND_BASE_URL;
      delete process.env.PIVOTA_API_BASE;
      const secondPage = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({
          ...basePayload,
          payload: {
            ...basePayload.payload,
            page: 2,
          },
        })
        .expect(200);

      expect(firstPage.body.products).toHaveLength(2);
      expect(secondPage.body.products).toHaveLength(2);
      expect(secondPage.body.metadata.rank_debug.recall_summary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            label: 'browse_pool_cache',
            cache_hit: true,
          }),
        ]),
      );
    } finally {
      if (previousDiscoveryBaseUrl === undefined) delete process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL;
      else process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = previousDiscoveryBaseUrl;
      if (previousDiscoveryApiKey === undefined) delete process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
      else process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = previousDiscoveryApiKey;
      if (previousBackendBaseUrl === undefined) delete process.env.PIVOTA_BACKEND_BASE_URL;
      else process.env.PIVOTA_BACKEND_BASE_URL = previousBackendBaseUrl;
      if (previousApiBase === undefined) delete process.env.PIVOTA_API_BASE;
      else process.env.PIVOTA_API_BASE = previousApiBase;
    }
  });
});
