const request = require('supertest');
const http = require('http');

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
  let server;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LOOK_REPLICATOR_API_KEY = 'test_key';
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://backend.example.com';
    process.env.PIVOTA_API_KEY = 'test-api-key';
    process.env.ACP_MERCHANT_ID = 'merch_test';
    axios.post.mockReset();
  });

  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => {
    process.env = originalEnv;
    try {
      server?.close?.();
    } catch {
      // ignore
    }
  });

  test('rejects missing auth when LOOK_REPLICATOR_API_KEY is set', async () => {
    const res = await request(server).post('/checkout-sessions').send({ market: 'US', items: [{ skuId: 'sku1', qty: 1 }], returnUrl: 'https://x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  test('returns PURCHASE_DISABLED for non-US market', async () => {
    const res = await request(server)
      .post('/checkout-sessions')
      .set(authHeaders())
      .send({ market: 'JP', items: [{ skuId: 'sku1', qty: 1 }], returnUrl: 'https://x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PURCHASE_DISABLED');
  });

  test('accepts legacy skuId body and returns checkoutUrl with return param', async () => {
    axios.post.mockResolvedValueOnce({
      status: 201,
      data: {
        status: 'success',
        valid: true,
        items: [{ product_id: 'sku1', variant_id: 'v1', quantity: 2 }],
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { checkout_url: 'https://checkout.shopify.com/cart/abc123' },
    });

    const res = await request(server)
      .post('/checkout-sessions')
      .set(authHeaders())
      .send({ market: 'US', locale: 'en', items: [{ skuId: 'sku1', qty: 2 }], returnUrl: 'https://return.here' });

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe('https://checkout.shopify.com/cart/abc123');

    expect(axios.post).toHaveBeenCalledTimes(2);
    const [cartUrl, cartBody, cartConfig] = axios.post.mock.calls[0];
    expect(cartUrl).toBe('https://backend.example.com/agent/v1/cart/validate');
    expect(cartBody.items).toEqual([{ product_id: 'sku1', quantity: 2 }]);
    expect(cartBody.merchant_id).toBe('merch_test');
    expect(cartConfig.headers['X-API-Key']).toBe('test-api-key');

    const [quoteUrl, quoteBody, quoteConfig] = axios.post.mock.calls[1];
    expect(quoteUrl).toBe('https://backend.example.com/agent/v1/quotes/preview');
    expect(quoteBody.items).toEqual([{ product_id: 'sku1', variant_id: 'v1', quantity: 2 }]);
    expect(quoteBody.merchant_id).toBe('merch_test');
    expect(quoteConfig.headers['X-API-Key']).toBe('test-api-key');
  });

  test('accepts ACP-style body and passes through buyer/fulfillment', async () => {
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'success',
        valid: true,
        items: [{ product_id: 'skuX', variant_id: 'v9', quantity: 1 }],
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { checkout_url: 'https://checkout.shopify.com/cart/xyz' },
    });

    const res = await request(server)
      .post('/checkout_sessions')
      .set(authHeaders())
      .send({ items: [{ id: 'skuX', quantity: 1 }], buyer: { email: 'x@y.z' }, fulfillment_address: { country: 'US' }, return_url: 'https://ret' });

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe('https://checkout.shopify.com/cart/xyz');
  });

  test('splits multi-merchant items into checkoutUrls[]', async () => {
    axios.post.mockImplementation(async (url, body) => {
      if (String(url).endsWith('/agent/v1/cart/validate')) {
        const mid = body?.merchant_id;
        if (mid === 'm1') {
          return { status: 200, data: { status: 'success', valid: true, items: [{ product_id: 'sku1', variant_id: 'v1', quantity: 1 }] } };
        }
        if (mid === 'm2') {
          return { status: 200, data: { status: 'success', valid: true, items: [{ product_id: 'sku2', variant_id: 'v2', quantity: 1 }] } };
        }
      }
      if (String(url).endsWith('/agent/v1/quotes/preview')) {
        const mid = body?.merchant_id;
        return { status: 200, data: { checkout_url: `https://checkout.shopify.com/cart/${mid}` } };
      }
      return { status: 500, data: { error: 'unexpected' } };
    });

    const res = await request(server)
      .post('/checkout-sessions')
      .set(authHeaders())
      .send({
        market: 'US',
        items: [
          { skuId: 'sku1', qty: 1, merchantId: 'm1' },
          { skuId: 'sku2', qty: 1, merchantId: 'm2' },
        ],
        returnUrl: 'https://return.here',
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checkoutUrls)).toBe(true);
    expect(res.body.checkoutUrls).toEqual(
      expect.arrayContaining([
        { merchantId: 'm1', checkoutUrl: 'https://checkout.shopify.com/cart/m1' },
        { merchantId: 'm2', checkoutUrl: 'https://checkout.shopify.com/cart/m2' },
      ]),
    );
  });
});
