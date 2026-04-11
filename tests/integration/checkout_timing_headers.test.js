process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

function expectServerTimingMetrics(headerValue, expectedMetrics) {
  expect(typeof headerValue).toBe('string');
  for (const metric of expectedMetrics) {
    expect(headerValue).toContain(`${metric};dur=`);
  }
}

describe('checkout timing headers', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('emits checkout timing spans for preview_quote', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/quotes/preview', (body) => body && body.merchant_id === 'm_timing')
      .reply(200, {
        status: 'success',
        quote: {
          quote_id: 'q_timing_123',
          expires_at: '2026-04-11T12:00:00Z',
          currency: 'USD',
          price_breakdown: {
            subtotal: '29.00',
            discount_total: '0.00',
            total: '29.00',
            currency: 'USD',
          },
          shipping_breakdown: {
            shipping_fee: '0.00',
            delivery_options: [{ id: 'ship_timing', label: 'Standard' }],
          },
          tax_breakdown: {
            tax: '0.00',
          },
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'preview_quote',
        payload: {
          quote: {
            merchant_id: 'm_timing',
            items: [{ product_id: 'p_timing', variant_id: 'v_timing', quantity: 1 }],
            shipping_address: {
              country: 'US',
              postal_code: '94105',
              city: 'San Francisco',
              state: 'CA',
            },
          },
        },
      })
      .expect(200);

    expect(res.body.quote_id).toBe('q_timing_123');
    expectServerTimingMetrics(res.headers['server-timing'], [
      'upstream',
      'proxy',
      'gateway',
      'upprimary',
      'normalize',
    ]);
    expect(res.headers['x-gateway-retries']).toBe('0');
  });

  it('emits requote and recreate spans for create_order quote recovery', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/orders', (body) => body && body.quote_id === 'q_expired_123')
      .reply(409, {
        detail: {
          error: 'QUOTE_EXPIRED',
          message: 'Quote expired before order creation',
        },
      })
      .post('/agent/v2/quotes/preview', (body) => body && body.merchant_id === 'm_timing')
      .reply(200, {
        status: 'success',
        quote: {
          quote_id: 'q_retry_456',
          expires_at: '2026-04-11T12:10:00Z',
          currency: 'USD',
        },
      })
      .post('/agent/v2/orders', (body) => body && body.quote_id === 'q_retry_456')
      .reply(200, {
        status: 'success',
        order: {
          order_id: 'ORD_TIMING_RETRY',
          quote_id: 'q_retry_456',
          merchant_id: 'm_timing',
        },
        payment: {
          psp: 'stripe',
          client_secret: 'cs_retry_timing',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'create_order',
        payload: {
          order: {
            quote_id: 'q_expired_123',
            customer_email: 'timing@example.com',
            shipping_address: {
              name: 'Timing Buyer',
              address_line1: '1 Market St',
              city: 'San Francisco',
              state: 'CA',
              postal_code: '94105',
              country: 'US',
            },
            items: [
              {
                merchant_id: 'm_timing',
                product_id: 'p_timing',
                variant_id: 'v_timing',
                product_title: 'Timing Serum',
                quantity: 1,
                unit_price: 29,
              },
            ],
          },
        },
      })
      .expect(200);

    expect(res.body.order_id).toBe('ORD_TIMING_RETRY');
    expect(res.body.quote_id).toBe('q_retry_456');
    expectServerTimingMetrics(res.headers['server-timing'], [
      'upstream',
      'proxy',
      'gateway',
      'upprimary',
      'requote',
      'recreate',
      'lines',
      'normalize',
    ]);
    expect(res.headers['x-gateway-retries']).toBe('0');
  });

  it('emits retry span for submit_payment temporary unavailability recovery', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v2/payments/checkout-sessions', (body) => body && body.order_id === 'ORD_PAY_TIMING')
      .reply(503, {
        detail: {
          error: 'TEMPORARY_UNAVAILABLE',
          message: 'checkout session store warming up',
        },
      })
      .post('/agent/v2/payments/checkout-sessions', (body) => body && body.order_id === 'ORD_PAY_TIMING')
      .reply(200, {
        status: 'requires_action',
        payment_id: 'pay_timing_123',
        payment_intent_id: 'pi_timing_123',
        psp: 'stripe',
        client_secret: 'pi_timing_123_secret_456',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'submit_payment',
        payload: {
          payment: {
            order_id: 'ORD_PAY_TIMING',
            currency: 'USD',
          },
        },
      })
      .expect(200);

    expect(res.body).toMatchObject({
      payment_status: 'requires_action',
      confirmation_owner: 'client',
      requires_client_confirmation: true,
      payment_intent_id: 'pi_timing_123',
      payment_action: {
        type: 'stripe_client_secret',
        client_secret: 'pi_timing_123_secret_456',
      },
    });
    expectServerTimingMetrics(res.headers['server-timing'], [
      'upstream',
      'proxy',
      'gateway',
      'upprimary',
      'payretry',
      'normalize',
    ]);
    expect(res.headers['x-gateway-retries']).toBe('1');
  });
});
