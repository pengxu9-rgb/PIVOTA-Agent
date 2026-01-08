process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('request_after_sales cancel routing', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('routes requested_action=cancel to /agent/v1/orders/{id}/cancel', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v1/orders/ORD_1/cancel')
      .reply(200, { status: 'success', order_id: 'ORD_1' });

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'request_after_sales',
        payload: {
          status: {
            order_id: 'ORD_1',
            requested_action: 'cancel',
          },
        },
      })
      .expect(200);
  });
});

