process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'MOCK';

const request = require('supertest');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke get_discovery_feed', () => {
  test('serves a discovery feed in explicit mock mode without upstream search fallback', async () => {
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
        candidate_source: 'mock_catalog',
        rank_debug: expect.any(Object),
      }),
    );
    expect(Array.isArray(res.body.metadata.rank_debug.top_candidates)).toBe(true);
  });
});
