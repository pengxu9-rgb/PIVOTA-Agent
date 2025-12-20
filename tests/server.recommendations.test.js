const nock = require('nock');
const request = require('supertest');

describe('products.recommendations routing', () => {
  const apiBase = process.env.PIVOTA_API_BASE || 'http://localhost:8080';

  beforeEach(() => {
    nock.cleanAll();
    jest.resetModules();
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_KEY = process.env.PIVOTA_API_KEY || 'test_key_for_jest';
    process.env.PIVOTA_API_BASE = apiBase;
  });

  it('forwards products.recommendations to GET /agent/v1/products/recommendations with query params', async () => {
    const app = require('../src/server');
    const merchantId = 'merch_test';
    const platformProductId = 'p123';

    const upstreamScope = nock(apiBase)
      .get('/agent/v1/products/recommendations')
      .query((qs) => qs.merchant_id === merchantId && qs.platform_product_id === platformProductId)
      .reply(200, {
        status: 'success',
        merchant_id: merchantId,
        platform_product_id: platformProductId,
        recommendations: [],
      });

    const payload = {
      operation: 'products.recommendations',
      payload: {
        search: {
          merchant_id: merchantId,
          platform_product_id: platformProductId,
        },
      },
    };

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send(payload)
      .expect(200);

    expect(upstreamScope.isDone()).toBe(true);
  });
});
