process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('get_order_status via /agent/shop/v1/invoke', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('preserves canonical pricing breakdown from backend tracking responses', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v2/orders/ORD_TRACK_1/tracking')
      .reply(200, {
        status: 'success',
        tracking: {
          status: 'shipped',
          carrier: 'ups',
          tracking_number: 'TRACK123',
          currency: 'USD',
          pricing: {
            subtotal: '1.69',
            discount_total: '0.16',
            shipping_fee: '8.00',
            tax: '0.00',
            total: '9.53',
            currency: 'USD',
          },
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_order_status',
        payload: {
          status: {
            order_id: 'ORD_TRACK_1',
          },
        },
      })
      .expect(200);

    expect(res.body.status).toBe('shipped');
    expect(res.body.pricing).toEqual({
      subtotal: '1.69',
      discount_total: '0.16',
      shipping_fee: '8.00',
      tax: '0.00',
      total: '9.53',
      currency: 'USD',
    });
    expect(res.body.total).toBe('9.53');
    expect(res.body.discount_total).toBe('0.16');
    expect(res.body.shipping_fee).toBe('8.00');
  });
});
