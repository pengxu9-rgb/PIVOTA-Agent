const request = require('supertest');
const { createLookReplicatorApp } = require('../../src/lookReplicator/app');

function authHeaders() {
  return { Authorization: 'Bearer test_key' };
}

describe('look replicator commerce invoke wrapper', () => {
  const originalEnv = process.env;
  let commerceClient;
  let app;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LOOK_REPLICATOR_API_KEY = 'test_key';
    commerceClient = {
      invoke: jest.fn(),
    };
    app = createLookReplicatorApp({
      logger: null,
      commerceClient,
    });
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

  test('dispatches allowed operation through CommerceClient', async () => {
    commerceClient.invoke.mockResolvedValueOnce({
      statusCode: 200,
      body: { ok: true },
      headers: {},
    });

    const reqBody = {
      operation: 'preview_quote',
      payload: { market: 'US', quote: { merchant_id: 'm_test', items: [] } },
    };
    const res = await request(app)
      .post('/api/look-replicate/commerce/invoke')
      .set(authHeaders())
      .send(reqBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(commerceClient.invoke).toHaveBeenCalledTimes(1);
    expect(commerceClient.invoke).toHaveBeenCalledWith(
      reqBody,
      expect.objectContaining({
        version: 'v1',
        clientChannel: 'shop',
        routeContext: {
          path: '/api/look-replicate/commerce/invoke',
        },
      }),
    );
  });

  test('returns UPSTREAM_UNREACHABLE when CommerceClient fails', async () => {
    commerceClient.invoke.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app)
      .post('/api/look-replicate/commerce/invoke')
      .set(authHeaders())
      .send({ operation: 'create_order', payload: { market: 'US', order: { items: [] } } });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('UPSTREAM_UNREACHABLE');
  });
});
