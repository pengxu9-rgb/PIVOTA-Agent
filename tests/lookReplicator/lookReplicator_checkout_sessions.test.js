const request = require('supertest');

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const app = require('../../src/server');

function authHeaders() {
  return { Authorization: 'Bearer test_key' };
}

describe('look replicator checkout_sessions compatibility', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LOOK_REPLICATOR_API_KEY = 'test_key';
    process.env.ACP_BASE_URL = 'https://acp.example.com';
    process.env.ACP_API_KEY = 'acp_test';
    axios.post.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('rejects missing auth when LOOK_REPLICATOR_API_KEY is set', async () => {
    const res = await request(app).post('/checkout-sessions').send({ market: 'US', items: [{ skuId: 'sku1', qty: 1 }], returnUrl: 'https://x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  test('returns PURCHASE_DISABLED for non-US market', async () => {
    const res = await request(app)
      .post('/checkout-sessions')
      .set(authHeaders())
      .send({ market: 'JP', items: [{ skuId: 'sku1', qty: 1 }], returnUrl: 'https://x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PURCHASE_DISABLED');
  });

  test('accepts legacy skuId body and returns checkoutUrl with return param', async () => {
    axios.post.mockResolvedValueOnce({
      status: 201,
      data: { id: 'cs_123' },
    });

    const res = await request(app)
      .post('/checkout-sessions')
      .set(authHeaders())
      .send({ market: 'US', locale: 'en', items: [{ skuId: 'sku1', qty: 2 }], returnUrl: 'https://return.here' });

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe('https://acp.example.com/checkout/cs_123?return=https%3A%2F%2Freturn.here');

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toBe('https://acp.example.com/checkout_sessions');
    expect(body.items).toEqual([{ id: 'sku1', quantity: 2 }]);
    expect(config.headers.Authorization).toBe('Bearer acp_test');
  });

  test('accepts ACP-style body and passes through buyer/fulfillment', async () => {
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { checkout_url: 'https://acp.example.com/checkout/cs_999' },
    });

    const res = await request(app)
      .post('/checkout_sessions')
      .set(authHeaders())
      .send({ items: [{ id: 'skuX', quantity: 1 }], buyer: { email: 'x@y.z' }, fulfillment_address: { country: 'US' }, return_url: 'https://ret' });

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe('https://acp.example.com/checkout/cs_999?return=https%3A%2F%2Fret');
  });
});

