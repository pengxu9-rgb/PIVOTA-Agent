process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('/agent/shop/v1/invoke track_product_click', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('forwards track_product_click payload to the upstream click endpoint', async () => {
    const upstreamScope = nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v1/events/product-click', (body) => {
        return (
          body &&
          body.merchant_id === 'merchant_1' &&
          body.platform === 'shopify' &&
          body.platform_product_id === 'prod_1' &&
          body.position === 3 &&
          body.ranking_score === 0.91 &&
          body.quality_content_score === 0.66 &&
          body.quality_model_readiness === 0.72 &&
          body.query === 'serum' &&
          body.event_type === 'click'
        );
      })
      .reply(200, { status: 'ok' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'track_product_click',
        payload: {
          product: {
            merchant_id: 'merchant_1',
            platform: 'shopify',
            product_id: 'prod_1',
            position: 3,
            ranking_score: 0.91,
            cq: 0.66,
            mr: 0.72,
            query: 'serum',
            event_type: 'click',
          },
        },
      })
      .expect(200);

    expect(res.body).toEqual({ status: 'ok' });
    expect(upstreamScope.isDone()).toBe(true);
  });
});
