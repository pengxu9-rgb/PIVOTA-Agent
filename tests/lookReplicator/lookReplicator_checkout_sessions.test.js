const request = require('supertest');
const http = require('http');

jest.mock('axios', () => ({
  defaults: {},
  post: jest.fn(),
}));

const axios = require('axios');
const app = require('../../src/server');

function authHeaders() {
  return { Authorization: 'Bearer test_key' };
}

describe('creator checkout_sessions compatibility', () => {
  const originalEnv = process.env;
  let server;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LOOK_REPLICATOR_API_KEY = 'test_key';
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://backend.example.com';
    process.env.PIVOTA_API_KEY = 'test-api-key';
    process.env.ACP_MERCHANT_ID = 'merch_test';
    process.env.LOOK_REPLICATOR_CHECKOUT_PROVIDER = 'quote';
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
    expect(cartUrl).toContain('https://backend.example.com/agent/v1/cart/validate');
    expect(cartUrl).toContain('merchant_id=merch_test');
    expect(cartUrl).toContain('shipping_country=US');
    expect(cartBody).toEqual([{ product_id: 'sku1', quantity: 2 }]);
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
      if (String(url).includes('/agent/v1/cart/validate')) {
        const parsed = new URL(String(url));
        const mid = parsed.searchParams.get('merchant_id');
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

  test('supports creator checkout provider through UCP session creation by default', async () => {
    process.env.LOOK_REPLICATOR_CHECKOUT_PROVIDER = 'creator';
    process.env.UCP_WEB_BASE_URL = 'https://agent.pivota.cc';
    process.env.UCP_INTERNAL_OFFER_MINT_KEY = 'internal_ucp_key';
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'success',
        valid: true,
        items: [{
          product_id: 'sku1',
          variant_id: 'v1',
          sku: 'S1',
          product_title: 'My Product',
          image_url: 'https://cdn.example.com/p1.png',
          unit_price: '12.50',
          quantity: 1,
        }],
        pricing: { currency: 'USD' },
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        offer_id: 'offer_v1.creator_123',
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'chk_creator_123',
        continue_url:
          'https://agent.pivota.cc/order?ucp_checkout_session_id=chk_creator_123',
      },
    });

    const res = await request(server)
      .post('/creator-agent/checkout-sessions')
      .set(authHeaders())
      .send({ market: 'US', items: [{ skuId: 'sku1', qty: 1, merchantId: 'm1' }], returnUrl: 'https://look-replicator.pivota.cc/result/abc?market=US' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('creator');
    expect(res.body.checkoutUrl).toBe(
      'https://agent.pivota.cc/order?ucp_checkout_session_id=chk_creator_123&entry=creator_agent&source=creator_agent&entry_mode=ucp_session&return=https%3A%2F%2Flook-replicator.pivota.cc%2Fresult%2Fabc%3Fmarket%3DUS',
    );
    expect(res.body.checkoutToken).toBeUndefined();
    expect(res.body.checkoutSessionId).toBe('chk_creator_123');
    expect(res.body.expiresAt).toBeUndefined();

    expect(axios.post).toHaveBeenCalledTimes(3);
    const [mintUrl, mintBody, mintConfig] = axios.post.mock.calls[1];
    expect(mintUrl).toBe('https://agent.pivota.cc/internal/ucp/mint-offer');
    expect(mintConfig.headers['X-Pivota-Internal-Key']).toBe('internal_ucp_key');
    expect(mintBody).toMatchObject({
      merchant_id: 'm1',
      product_id: 'sku1',
      variant_id: 'v1',
      title: 'My Product',
      image_url: 'https://cdn.example.com/p1.png',
      currency: 'USD',
      price_minor: 1250,
    });

    const [createUrl, createBody, createConfig] = axios.post.mock.calls[2];
    expect(createUrl).toBe(
      'https://agent.pivota.cc/ucp/v1/checkout-sessions?return=https%3A%2F%2Flook-replicator.pivota.cc%2Fresult%2Fabc%3Fmarket%3DUS',
    );
    expect(createBody).toEqual({
      currency: 'USD',
      line_items: [
        {
          item: {
            id: 'offer_v1.creator_123',
            title: 'My Product',
            image_url: 'https://cdn.example.com/p1.png',
            price: 1250,
          },
          quantity: 1,
        },
      ],
    });
    expect(createConfig.headers['Content-Type']).toBe('application/json');
  });

  test('creator checkout provider does not silently fall back to legacy order items URL when UCP minting fails', async () => {
    process.env.LOOK_REPLICATOR_CHECKOUT_PROVIDER = 'creator';
    process.env.UCP_WEB_BASE_URL = 'https://agent.pivota.cc';
    process.env.UCP_INTERNAL_OFFER_MINT_KEY = 'internal_ucp_key';
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'success',
        valid: true,
        items: [{ product_id: 'sku1', variant_id: 'v1', sku: 'S1', product_title: 'My Product', quantity: 1 }],
        pricing: { currency: 'USD' },
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 503,
      data: {
        error: 'OFFER_TOKEN_NOT_CONFIGURED',
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 503,
      data: {
        error: 'OFFER_TOKEN_NOT_CONFIGURED',
      },
    });

    const res = await request(server)
      .post('/checkout-sessions')
      .set(authHeaders())
      .send({ market: 'US', items: [{ skuId: 'sku1', qty: 1, merchantId: 'm1' }], returnUrl: 'https://look-replicator.pivota.cc/result/abc?market=US' });

    expect([502, 503]).toContain(res.status);
    expect(res.body.error).toBe('UPSTREAM_ERROR');
    expect(Array.isArray(res.body.failures)).toBe(true);
    expect(res.body.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          merchantId: 'm1',
          stage: 'creator_offer_mint',
          status: 503,
        }),
      ]),
    );
    expect(JSON.stringify(res.body)).not.toContain('/order?items=');
  });

  test('creator checkout provider falls back to legacy checkout token only when the feature flag is enabled', async () => {
    process.env.LOOK_REPLICATOR_CHECKOUT_PROVIDER = 'creator';
    process.env.UCP_WEB_BASE_URL = 'https://agent.pivota.cc';
    process.env.UCP_INTERNAL_OFFER_MINT_KEY = 'internal_ucp_key';
    process.env.LOOK_REPLICATOR_ALLOW_LEGACY_CHECKOUT_FALLBACK = '1';
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'success',
        valid: true,
        items: [{ product_id: 'sku1', variant_id: 'v1', sku: 'S1', product_title: 'My Product', quantity: 1 }],
        pricing: { currency: 'USD' },
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 503,
      data: {
        error: 'UCP_UNAVAILABLE',
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 503,
      data: {
        error: 'UCP_UNAVAILABLE',
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        checkout_url:
          'https://agent.pivota.cc/order?checkout_token=tok_creator_fallback',
        checkout_token: 'tok_creator_fallback',
        checkout_session_id: 'ci_creator_fallback',
        expires_at: 1773989020,
      },
    });

    const res = await request(server)
      .post('/checkout-sessions')
      .set(authHeaders())
      .send({ market: 'US', items: [{ skuId: 'sku1', qty: 1, merchantId: 'm1' }], returnUrl: 'https://look-replicator.pivota.cc/result/abc?market=US' });

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toBe(
      'https://agent.pivota.cc/order?checkout_token=tok_creator_fallback&entry=creator_agent&source=creator_agent&return=https%3A%2F%2Flook-replicator.pivota.cc%2Fresult%2Fabc%3Fmarket%3DUS',
    );
    expect(res.body.checkoutToken).toBe('tok_creator_fallback');
    expect(res.body.checkoutSessionId).toBe('ci_creator_fallback');
    expect(res.body.expiresAt).toBe(1773989020);
  });

  test('creator legacy checkout fallback does not activate for multi-merchant requests', async () => {
    process.env.LOOK_REPLICATOR_CHECKOUT_PROVIDER = 'creator';
    process.env.UCP_WEB_BASE_URL = 'https://agent.pivota.cc';
    process.env.UCP_INTERNAL_OFFER_MINT_KEY = 'internal_ucp_key';
    process.env.LOOK_REPLICATOR_ALLOW_LEGACY_CHECKOUT_FALLBACK = '1';

    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'success',
        valid: true,
        items: [{ product_id: 'sku1', variant_id: 'v1', sku: 'S1', product_title: 'Product 1', quantity: 1 }],
        pricing: { currency: 'USD' },
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'success',
        valid: true,
        items: [{ product_id: 'sku2', variant_id: 'v2', sku: 'S2', product_title: 'Product 2', quantity: 1 }],
        pricing: { currency: 'USD' },
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 503,
      data: {
        error: 'UCP_UNAVAILABLE',
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 503,
      data: {
        error: 'UCP_UNAVAILABLE',
      },
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
        returnUrl: 'https://look-replicator.pivota.cc/result/abc?market=US',
      });

    expect([502, 503]).toContain(res.status);
    expect(res.body.error).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('checkout_token=');
    expect(JSON.stringify(res.body)).not.toContain('/order?items=');
    expect(
      axios.post.mock.calls.some(([url]) =>
        String(url).includes('/agent/v1/checkout/intents'),
      ),
    ).toBe(false);
  });
  test('forwards X-Agent-User-JWT to ACP checkout session creation', async () => {
    process.env.LOOK_REPLICATOR_CHECKOUT_PROVIDER = 'acp';
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        status: 'success',
        valid: true,
        items: [{ product_id: 'sku1', variant_id: 'v1', quantity: 1 }],
      },
    });
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { checkout_url: 'https://pivota-acp.example.com/checkout/sess_1' },
    });

    const res = await request(server)
      .post('/checkout-sessions')
      .set({ ...authHeaders(), 'X-Agent-User-JWT': 'jwt_abc', 'X-Buyer-Ref': 'user:demo' })
      .send({ market: 'US', items: [{ skuId: 'sku1', qty: 1, merchantId: 'm1' }], returnUrl: 'https://return.here' });

    expect(res.status).toBe(200);
    expect(res.body.checkoutUrl).toContain('https://pivota-acp.example.com/checkout/sess_1');

    expect(axios.post).toHaveBeenCalledTimes(2);
    const [acpUrl, acpBody, acpConfig] = axios.post.mock.calls[1];
    expect(acpUrl).toBe('https://backend.example.com/agent/v1/checkout/acp-session');
    expect(acpBody).toMatchObject({
      merchant_id: 'm1',
      items: [{ id: 'v1', quantity: 1 }],
      return_url: 'https://return.here',
      buyer_ref: 'user:demo',
    });
    expect(acpConfig.headers['X-API-Key']).toBe('test-api-key');
    expect(acpConfig.headers['X-Agent-User-JWT']).toBe('jwt_abc');
    expect(acpConfig.headers['X-Buyer-Ref']).toBe('user:demo');
  });
});
