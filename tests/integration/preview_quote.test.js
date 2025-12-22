process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('preview_quote via /agent/shop/v1/invoke', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('forwards preview_quote to backend /agent/v1/quotes/preview', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v1/quotes/preview')
      .reply(200, {
        quote_id: 'q_test',
        expires_at: '2025-12-22T00:00:00Z',
        engine: 'shopify_rest_checkout',
        engine_ref: 'tok_123',
        currency: 'USD',
        pricing: {
          subtotal: '100.00',
          discount_total: '10.00',
          shipping_fee: '5.00',
          tax: '0.00',
          total: '95.00',
        },
        promotion_lines: [
          {
            id: 'pl_1',
            source: 'shopify',
            discount_class: 'order',
            method: 'code',
            label: 'SAVE10',
            code: 'SAVE10',
            amount: '-10.00',
            allocations: [],
          },
        ],
        line_items: [
          {
            variant_id: 'v1',
            quantity: 1,
            unit_price_original: '100.00',
            unit_price_effective: '90.00',
            line_discount_total: '10.00',
            compare_at_savings: '0.00',
          },
        ],
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'preview_quote',
        payload: {
          quote: {
            merchant_id: 'm_123',
            items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }],
            discount_codes: ['SAVE10'],
            shipping_address: { country: 'US', postal_code: '94102', city: 'SF', state: 'CA' },
          },
        },
      })
      .expect(200);

    expect(res.body.quote_id).toBe('q_test');
    expect(res.body.pricing).toBeTruthy();
    expect(Array.isArray(res.body.promotion_lines)).toBe(true);
  });
});

