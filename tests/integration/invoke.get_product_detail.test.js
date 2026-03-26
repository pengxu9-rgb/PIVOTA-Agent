process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke get_product_detail', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('returns normalized product detail and debug cache metadata after upstream fetch', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/merchant_1/prod_1')
      .reply(200, {
        status: 'success',
        product: {
          id: 'prod_1',
          product_id: 'prod_1',
          merchant_id: 'merchant_1',
          title: 'Test Product',
          price: 42,
          currency: 'USD',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_product_detail',
        payload: {
          product: {
            merchant_id: 'merchant_1',
            product_id: 'prod_1',
          },
          options: {
            debug: true,
          },
        },
      })
      .expect(200);

    expect(res.body.product).toEqual(
      expect.objectContaining({
        product_id: 'prod_1',
        merchant_id: 'merchant_1',
        title: 'Test Product',
      }),
    );
    expect(res.body.cache).toEqual({
      hit: false,
      source: 'upstream',
    });
  });
});
