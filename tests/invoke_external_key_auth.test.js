const nock = require('nock');
const request = require('supertest');

describe('invoke external key auth', () => {
  const ORIGINAL_ENV = { ...process.env };
  const INTROSPECT_BASE = 'https://auth.test';
  const INTROSPECT_PATH = '/agent/internal/auth/introspect';
  let app;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
    };
    app = require('../src/server');
  });

  afterEach(() => {
    nock.cleanAll();
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns 401 when shop invoke is missing api key', async () => {
    const res = await request(app).post('/agent/shop/v1/invoke').send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('returns 401 when creator invoke key format is invalid', async () => {
    const res = await request(app)
      .post('/agent/creator/v1/invoke')
      .set('X-Agent-API-Key', 'invalid_key')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('returns 403 when introspected agent is inactive', async () => {
    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH, (body) => body?.api_key === `ak_live_${'a'.repeat(64)}`)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(200, {
        valid: true,
        agent_id: 'agent_123',
        is_active: false,
        auth_source: 'api_keys',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'a'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'FORBIDDEN' });
  });

  it('accepts same key for both shop and creator invoke routes', async () => {
    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH, (body) => body?.api_key === `ak_live_${'b'.repeat(64)}`)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(200, {
        valid: true,
        agent_id: 'agent_same',
        is_active: true,
        auth_source: 'api_keys',
      });

    const shopRes = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'b'.repeat(64)}`)
      .send({});
    expect(shopRes.status).toBe(400);
    expect(shopRes.body).toMatchObject({ error: 'INVALID_REQUEST' });

    const creatorRes = await request(app)
      .post('/agent/creator/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'b'.repeat(64)}`)
      .send({});
    expect(creatorRes.status).toBe(400);
    expect(creatorRes.body).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  it('returns 503 when introspection service is unavailable', async () => {
    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(503, { error: 'UPSTREAM_DOWN' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'c'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'AUTH_INTROSPECT_UNAVAILABLE' });
  });
});
