process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('create_order quote_id passthrough', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  function createOrderPayload(overrides = {}) {
    return {
      operation: 'create_order',
      payload: {
        order: {
          quote_id: 'q_123',
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
          ...overrides,
        },
      },
    };
  }

  it('requires quote_id before creating an order', async () => {
    const reqBody = createOrderPayload({ quote_id: undefined });
    delete reqBody.payload.order.quote_id;

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send(reqBody);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      status: 'failure',
      code: 'quote_required',
      message: 'create_order requires a locked quote_id',
    });
  });

  it('passes quote_id and buyer context to backend v2 orders', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/orders', body => {
        return (
          body &&
          body.quote_id === 'q_123' &&
          body.buyer_context?.customer_email === 'quote-test@example.com' &&
          body.buyer_context?.shipping_address?.country === 'US'
        );
      })
      .reply(200, {
        status: 'success',
        order: {
          order_id: 'ORD_1',
          quote_id: 'q_123',
          amounts: { total: 1000, currency: 'USD' },
        },
        payment: { psp: 'stripe', client_secret: 'cs_test' },
        tracking: { agent_session_id: 's', created_at: new Date().toISOString() },
      });

    await request(app)
      .post('/agent/shop/v1/invoke')
      .send(createOrderPayload())
      .expect(200);
  });

  it.each([
    ['omits order_lines when upstream omits them', { status: 'success', order: { order_id: 'ORD_NO_LINES', quote_id: 'q_123' } }, false],
    [
      'preserves order_lines when upstream provides them',
      {
        status: 'success',
        order: { order_id: 'ORD_WITH_LINES', quote_id: 'q_123' },
        order_lines: [{ line_id: 'line_1', product_id: 'p1', quantity: 1 }],
      },
      true,
    ],
    [
      'does not map upstream order.line_items to order_lines',
      {
        status: 'success',
        order: {
          order_id: 'ORD_WITH_LINE_ITEMS',
          quote_id: 'q_123',
          line_items: [{ line_id: 'line_1', product_id: 'p1', quantity: 1 }],
        },
      },
      false,
    ],
  ])('%s', async (_name, upstreamBody, shouldHaveOrderLines) => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/orders', body => body?.quote_id === 'q_123')
      .reply(200, upstreamBody);

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send(createOrderPayload())
      .expect(200);

    expect(Object.prototype.hasOwnProperty.call(res.body, 'order_lines')).toBe(shouldHaveOrderLines);
  });
});
