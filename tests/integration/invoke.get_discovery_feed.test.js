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
        scoring_version: 'discovery_v1',
        surface: 'home_hot_deals',
        candidate_source: 'products_search',
        rank_debug: expect.any(Object),
      }),
    );
    expect(Array.isArray(res.body.metadata.rank_debug.top_candidates)).toBe(true);
  });
});
