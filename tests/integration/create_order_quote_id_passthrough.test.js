process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('create_order quote_id passthrough', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('passes quote_id/discount_codes/selected_delivery_option to backend', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v1/orders/create', body => {
        return (
          body &&
          body.quote_id === 'q_123' &&
          Array.isArray(body.discount_codes) &&
          body.discount_codes[0] === 'SAVE10' &&
          body.selected_delivery_option &&
          body.selected_delivery_option.id === 'ship_1'
        );
      })
      .reply(200, {
        status: 'success',
        order_id: 'ORD_1',
        total_amount: 10,
        currency: 'USD',
        payment: { psp: 'stripe', client_secret: 'cs_test' },
        tracking: { agent_session_id: 's', created_at: new Date().toISOString() },
      });

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'create_order',
        payload: {
          order: {
            quote_id: 'q_123',
            discount_codes: ['SAVE10'],
            selected_delivery_option: { id: 'ship_1' },
            customer_email: 'quote-test@example.com',
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

