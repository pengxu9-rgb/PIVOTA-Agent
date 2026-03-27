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
    jest.dontMock('../src/db');
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
    expect(res.headers['x-invoke-auth-degraded']).toBe('true');
    expect(res.headers['x-invoke-auth-degraded-reason']).toBe('AUTH_INTROSPECT_UNAVAILABLE');
    expect(res.headers['x-invoke-introspect-auth-source']).toBe('emergency_fallback');
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

  it('does not accept emergency fallback when introspection is rejected instead of unavailable', async () => {
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
      AGENT_AUTH_EMERGENCY_API_KEY: `ak_live_${'1'.repeat(64)}`,
      AGENT_AUTH_EMERGENCY_AGENT_ID: 'agent_staging_fallback',
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(401, { error: 'BAD_INTERNAL_KEY' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', `ak_live_${'1'.repeat(64)}`)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'AUTH_INTROSPECT_UNAVAILABLE' });
    expect(res.headers['x-invoke-auth-degraded']).toBeUndefined();
    expect(res.headers['x-invoke-introspect-auth-source']).toBeUndefined();
  });

  it('forwards the caller api key to external supplement fetch on authenticated shopping_agent cache hits', async () => {
    const liveKey = `ak_live_${'9'.repeat(64)}`;

    jest.resetModules();
    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 6 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_serum_1',
                  product_id: 'prod_serum_1',
                  merchant_id: 'merch_skin',
                  title: 'Niacinamide Repair Serum',
                  description: '10% niacinamide serum for uneven tone',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_skin',
                merchant_name: 'Skin Shop',
                product_data: {
                  id: 'prod_serum_2',
                  product_id: 'prod_serum_2',
                  merchant_id: 'merch_skin',
                  title: 'Barrier Support Serum',
                  description: 'hydrating skincare serum for daily barrier support',
                  product_type: 'Serum',
                  status: 'published',
                  inventory_quantity: 7,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      AGENT_AUTH_INTROSPECT_URL: `${INTROSPECT_BASE}${INTROSPECT_PATH}`,
      AGENT_AUTH_INTROSPECT_INTERNAL_KEY: 'internal_test_key',
      AGENT_AUTH_INTROSPECT_TIMEOUT_MS: '1200',
      AGENT_AUTH_CACHE_POSITIVE_TTL_MS: '60000',
      AGENT_AUTH_CACHE_NEGATIVE_TTL_MS: '3000',
      PIVOTA_API_BASE: 'http://pivota.test',
      PIVOTA_API_KEY: 'fallback_key_should_not_be_used',
      API_MODE: 'REAL',
      DATABASE_URL: 'postgres://test',
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: 'false',
      FIND_PRODUCTS_MULTI_ROUTE_DEBUG: '1',
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: 'false',
      SEARCH_EXTERNAL_HARD_RULE_PRUNE: 'true',
    };
    app = require('../src/server');

    nock(INTROSPECT_BASE)
      .post(INTROSPECT_PATH, (body) => body?.api_key === liveKey)
      .matchHeader('X-Internal-Key', 'internal_test_key')
      .reply(200, {
        valid: true,
        agent_id: 'agent_live_shopper',
        is_active: true,
        auth_source: 'api_keys',
      });

    const externalSupplement = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .matchHeader('x-api-key', liveKey)
      .matchHeader('authorization', `Bearer ${liveKey}`)
      .query(
        (q) =>
          String(q.merchant_id || '') === 'external_seed' &&
          String(q.query || '')
            .toLowerCase()
            .includes('serum'),
      )
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'ext_serum_1',
            product_id: 'ext_serum_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Niacinamide Barrier Serum',
            description: 'niacinamide serum for daily barrier support',
            product_type: 'external',
            status: 'active',
          },
        ],
        total: 1,
      });

    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', liveKey)
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'serum',
            page: 1,
            limit: 5,
            in_stock_only: true,
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('cache_cross_merchant_search_supplemented');
    expect(resp.body.metadata?.source_breakdown?.external_seed_count).toBeGreaterThan(0);
    expect(externalSupplement.isDone()).toBe(true);
  });
});
