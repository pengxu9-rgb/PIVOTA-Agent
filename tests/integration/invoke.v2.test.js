process.env.PIVOTA_API_BASE = 'http://localhost:8080';
process.env.PIVOTA_API_KEY = 'test-token';

const request = require('supertest');
const nock = require('nock');
const app = require('../../src/server');

describe('/agent/shop/v2/invoke gateway', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it('bridges canonical quote.preview to legacy preview_quote and wraps the response', async () => {
    nock(process.env.PIVOTA_API_BASE)
      .post('/agent/v1/quotes/preview')
      .reply(200, {
        quote_id: 'q_v2',
        pricing: {
          total: '95.00',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v2/invoke')
      .send({
        operation: 'quote.preview',
        payload: {
          merchant_id: 'm_123',
          items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }],
          shipping_address: { country: 'US', postal_code: '94102', city: 'SF', state: 'CA' },
        },
        context: {
          source: 'invoke_v2_test',
        },
      })
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.result.quote_id).toBe('q_v2');
    expect(res.body.meta.contract_version).toBe('v2');
    expect(res.body.meta.canonical_operation).toBe('quote.preview');
    expect(res.body.meta.legacy_operation).toBe('preview_quote');
    expect(res.body.session.commerce_session_id).toBe('q_v2');
  });

  it('rejects unsupported canonical operations', async () => {
    const res = await request(app)
      .post('/agent/shop/v2/invoke')
      .send({
        operation: 'payments.refund',
        payload: {},
      })
      .expect(400);

    expect(res.body.error).toBe('UNSUPPORTED_OPERATION');
  });
});
