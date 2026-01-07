const request = require('supertest');
const http = require('http');

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require('axios');
const app = require('../../src/server');

function authHeaders() {
  return { Authorization: 'Bearer test_key' };
}

describe('look replicator orders proxy', () => {
  const originalEnv = process.env;
  let server;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.LOOK_REPLICATOR_API_KEY = 'test_key';
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://backend.example.com';
    process.env.PIVOTA_API_KEY = 'test-api-key';
    axios.get.mockReset();
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
    const res = await request(server).get('/api/orders?buyer_ref=guest:abc');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  test('proxies orders list and forwards identity headers', async () => {
    axios.get.mockResolvedValueOnce({
      status: 200,
      data: { status: 'success', total: 0, orders: [] },
    });

    const res = await request(server)
      .get('/api/orders?buyer_ref=guest:abc&limit=5&offset=10')
      .set({ ...authHeaders(), 'X-Agent-User-JWT': 'jwt_abc' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, cfg] = axios.get.mock.calls[0];
    expect(url).toBe('https://backend.example.com/agent/v1/orders');
    expect(cfg.headers['X-API-Key']).toBe('test-api-key');
    expect(cfg.headers['X-Agent-User-JWT']).toBe('jwt_abc');
    expect(cfg.headers['X-Buyer-Ref']).toBe('guest:abc');
    expect(cfg.params).toMatchObject({ buyer_ref: 'guest:abc', limit: 5, offset: 10 });
  });

  test('proxies order detail and forwards identity headers', async () => {
    axios.get.mockResolvedValueOnce({
      status: 200,
      data: { status: 'success', order: { order_id: 'ORD_1' } },
    });

    const res = await request(server)
      .get('/api/orders/ORD_1?buyer_ref=user:demo')
      .set({ ...authHeaders(), 'X-Agent-User-JWT': 'jwt_abc' });

    expect(res.status).toBe(200);
    expect(res.body.order.order_id).toBe('ORD_1');

    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, cfg] = axios.get.mock.calls[0];
    expect(url).toBe('https://backend.example.com/agent/v1/orders/ORD_1');
    expect(cfg.headers['X-API-Key']).toBe('test-api-key');
    expect(cfg.headers['X-Agent-User-JWT']).toBe('jwt_abc');
    expect(cfg.headers['X-Buyer-Ref']).toBe('user:demo');
    expect(cfg.params).toMatchObject({ buyer_ref: 'user:demo' });
  });

  test('proxies order events and forwards identity headers', async () => {
    axios.get.mockResolvedValueOnce({
      status: 200,
      data: { status: 'success', after_id: 0, next_after_id: 0, events: [] },
    });

    const res = await request(server)
      .get('/api/orders/events?after_id=0&wait_ms=0&buyer_ref=guest:abc&limit=50')
      .set({ ...authHeaders(), 'X-Agent-User-JWT': 'jwt_abc' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');

    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, cfg] = axios.get.mock.calls[0];
    expect(url).toBe('https://backend.example.com/agent/v1/orders/events');
    expect(cfg.headers['X-API-Key']).toBe('test-api-key');
    expect(cfg.headers['X-Agent-User-JWT']).toBe('jwt_abc');
    expect(cfg.headers['X-Buyer-Ref']).toBe('guest:abc');
    expect(cfg.params).toMatchObject({ after_id: 0, wait_ms: 0, limit: 50, buyer_ref: 'guest:abc' });
  });
});

