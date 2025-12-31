const request = require('supertest');

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const app = require('../../src/server');

function authHeaders() {
  return { Authorization: 'Bearer test_key' };
}

describe('look replicator commerce invoke wrapper', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LOOK_REPLICATOR_API_KEY = 'test_key';
    axios.post.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('rejects missing auth when LOOK_REPLICATOR_API_KEY is set', async () => {
    const res = await request(app).post('/api/look-replicate/commerce/invoke').send({
      operation: 'preview_quote',
      payload: { market: 'US', quote: { merchant_id: 'm_test', items: [] } },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  test('returns PURCHASE_DISABLED for non-US (JP)', async () => {
    const res = await request(app)
      .post('/api/look-replicate/commerce/invoke')
      .set(authHeaders())
      .send({
        operation: 'preview_quote',
        payload: { market: 'JP', quote: { merchant_id: 'm_test', items: [] } },
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PURCHASE_DISABLED');
  });

  test('rejects unsupported operations', async () => {
    const res = await request(app)
      .post('/api/look-replicate/commerce/invoke')
      .set(authHeaders())
      .send({ operation: 'find_products', payload: { market: 'US', search: { query: 'x' } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_OPERATION');
    expect(res.body.operation).toBe('find_products');
  });

  test('proxies allowed operation to /agent/shop/v1/invoke', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { ok: true } });

    const reqBody = { operation: 'preview_quote', payload: { market: 'US', quote: { merchant_id: 'm_test', items: [] } } };
    const res = await request(app).post('/api/look-replicate/commerce/invoke').set(authHeaders()).send(reqBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = axios.post.mock.calls[0];
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/agent\/shop\/v1\/invoke$/);
    expect(body).toEqual(reqBody);
    expect(config.timeout).toBe(20_000);
  });

  test('returns UPSTREAM_UNREACHABLE when proxy fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app)
      .post('/api/look-replicate/commerce/invoke')
      .set(authHeaders())
      .send({ operation: 'create_order', payload: { market: 'US', order: { items: [] } } });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('UPSTREAM_UNREACHABLE');
  });
});

