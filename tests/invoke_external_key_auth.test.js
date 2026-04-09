const nock = require('nock');
const request = require('supertest');

describe('invoke external key auth', () => {
  jest.setTimeout(15000);
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

  it('accepts a configured emergency fallback key when introspection is unavailable', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED: 'true',
      AGENT_AUTH_EMERGENCY_API_KEY: `ak_live_${'d'.repeat(64)}`,
      AGENT_AUTH_EMERGENCY_AGENT_ID: 'agent_staging_fallback',
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(503, { error: 'UPSTREAM_DOWN' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'d'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  it('accepts the configured service api key when introspection is unavailable', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      PIVOTA_API_KEY: `ak_live_${'9'.repeat(64)}`,
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(503, { error: 'UPSTREAM_DOWN' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'9'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  it('keeps returning 503 for keys that do not match the configured service api key', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      PIVOTA_API_KEY: `ak_live_${'1'.repeat(64)}`,
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(503, { error: 'UPSTREAM_DOWN' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'2'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'AUTH_INTROSPECT_UNAVAILABLE' });
  });

  it('keeps returning 503 for non-fallback keys when introspection is unavailable', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED: 'true',
      AGENT_AUTH_EMERGENCY_API_KEY: `ak_live_${'e'.repeat(64)}`,
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(503, { error: 'UPSTREAM_DOWN' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'f'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'AUTH_INTROSPECT_UNAVAILABLE' });
  });

  it('accepts configured service api key when introspection returns an error-shaped invalid result', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      PIVOTA_API_KEY: `ak_live_${'7'.repeat(64)}`,
      AGENT_API_KEY: `ak_live_${'7'.repeat(64)}`,
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(200, {
        valid: false,
        agent_id: null,
        is_active: false,
        auth_source: 'error',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'7'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'INVALID_REQUEST' });
  });

  it('keeps returning 401 for unknown keys when introspection returns an error-shaped invalid result', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      PIVOTA_API_KEY: `ak_live_${'8'.repeat(64)}`,
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(200, {
        valid: false,
        agent_id: null,
        is_active: false,
        auth_source: 'error',
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'f'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('uses internal upstream api key for degraded get_product_detail forwarding', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: `ak_live_${'1'.repeat(64)}`,
      AGENT_API_KEY: `ak_live_${'1'.repeat(64)}`,
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(200, {
        valid: false,
        agent_id: null,
        is_active: false,
        auth_source: 'error',
      });

    const backend = nock('https://backend.test')
      .get('/agent/v1/products/external_seed/ext_test_product')
      .matchHeader('X-API-Key', `ak_live_${'1'.repeat(64)}`)
      .reply(200, {
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_test_product',
          title: 'Fallback PDP',
        },
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'1'.repeat(64)}`)
      .send({
        operation: 'get_product_detail',
        payload: {
          product: {
            merchant_id: 'external_seed',
            product_id: 'ext_test_product',
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.product).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_test_product',
      }),
    );
    expect(backend.isDone()).toBe(true);
  });

  it('keeps caller service api key for degraded search forwarding', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: `ak_live_${'2'.repeat(64)}`,
      AGENT_API_KEY: `ak_live_${'2'.repeat(64)}`,
      AGENT_AUTH_EMERGENCY_FALLBACK_ENABLED: 'true',
      AGENT_AUTH_EMERGENCY_FALLBACK_KEYS: `ak_live_${'3'.repeat(64)}`,
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(200, {
        valid: false,
        agent_id: null,
        is_active: false,
        auth_source: 'error',
      });

    const backend = nock('https://backend.test')
      .post('/agent/v2/products/search')
      .query(true)
      .matchHeader('X-API-Key', `ak_live_${'3'.repeat(64)}`)
      .reply(200, {
        status: 'success',
        products: [],
        total: 0,
        page: 1,
        page_size: 0,
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'3'.repeat(64)}`)
      .send({
        operation: 'find_products_multi',
        payload: {
          query: 'Tom Ford Beauty fragrance',
          limit: 12,
          options: { debug: true },
        },
      });

    expect(res.status).toBe(200);
    expect(backend.isDone()).toBe(true);
  });
});
