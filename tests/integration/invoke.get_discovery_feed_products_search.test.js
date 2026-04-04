process.env.PIVOTA_API_BASE = 'http://catalog.test';
process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'LIVE';

const nock = require('nock');
const request = require('supertest');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke get_discovery_feed via products/search', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  test('serves discovery feed through the stable invoke contract while recalling from products/search', async () => {
    const capturedParams = [];
    nock('http://catalog.test')
      .matchHeader('x-api-key', 'test-token')
      .get('/agent/v1/products/search')
      .query((params) => {
        capturedParams.push(params);
        return true;
      })
      .times(2)
      .reply(200, {
        products: [
          {
            merchant_id: 'm1',
            product_id: 'alpha_serum',
            title: 'Alpha Repair Serum',
            brand: 'Alpha',
            category: 'Skincare',
            product_type: 'Serum',
            inventory_quantity: 12,
            status: 'active',
          },
          {
            merchant_id: 'm2',
            product_id: 'beta_toner',
            title: 'Beta Repair Toner',
            brand: 'Beta',
            category: 'Skincare',
            product_type: 'Toner',
            inventory_quantity: 8,
            status: 'active',
          },
          {
            merchant_id: 'm3',
            product_id: 'gamma_cream',
            title: 'Gamma Barrier Cream',
            brand: 'Gamma',
            category: 'Skincare',
            product_type: 'Cream',
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
          limit: 3,
          debug: true,
          context: {
            auth_state: 'authenticated',
            locale: 'en-US',
            recent_views: [
              {
                merchant_id: 'm1',
                product_id: 'seed_alpha',
                title: 'Alpha Repair Serum',
                brand: 'Alpha',
                category: 'Skincare',
                product_type: 'Serum',
                viewed_at: '2026-04-04T10:00:00Z',
              },
            ],
            recent_queries: ['repair serum'],
          },
        },
      })
      .expect(200);

    expect(res.body.products).toHaveLength(3);
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        candidate_source: 'products_search',
        discovery_strategy: 'personalized_interest',
        personalization_source: 'account_history',
        rank_debug: expect.any(Object),
      }),
    );
    expect(res.body.metadata.rank_debug.recall_summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'interest_pool', status: 200 }),
        expect.objectContaining({ label: 'browse_pool', status: 200 }),
      ]),
    );
    expect(capturedParams.some((params) => String(params.query || '').trim().length > 0)).toBe(true);
    expect(
      capturedParams.some((params) => !Object.prototype.hasOwnProperty.call(params, 'query') || !String(params.query || '').trim()),
    ).toBe(true);
  });
});
