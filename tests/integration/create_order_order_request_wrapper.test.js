process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('create_order order_request compatibility wrapper', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('retries once with {order_request:{...}} when upstream returns 422 missing order_request', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/orders', (body) => {
        return body && body.quote_id === 'q_wrapper_123' && !body.order_request;
      })
      .reply(422, {
        detail: [
          {
            type: 'missing',
            loc: ['body', 'order_request'],
            msg: 'Field required',
            input: null,
          },
        ],
      })
      .post('/agent/v2/orders', (body) => {
        return (
          body &&
          body.order_request &&
          body.order_request.quote_id === 'q_wrapper_123'
        );
      })
      .reply(200, {
        status: 'success',
        order: {
          order_id: 'ORD_1',
          quote_id: 'q_wrapper_123',
          amounts: { total: 1000, currency: 'USD' },
        },
        payment: { psp: 'stripe', client_secret: 'cs_test' },
        tracking: { agent_session_id: 's', created_at: new Date().toISOString() },
      });

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'create_order',
        payload: {
          order: {
            quote_id: 'q_wrapper_123',
            customer_email: 'wrapper-test@example.com',
            shipping_address: {
              name: 'A',
              address_line1: '1',
              city: 'SF',
              country: 'US',
              postal_code: '94102',
            },
            items: [
              {
                merchant_id: 'm_123',
                product_id: 'p1',
                variant_id: 'v1',
                product_title: 'T',
                quantity: 1,
                unit_price: 10,
              },
            ],
          },
        },
      })
      .expect(200);
  });
});
