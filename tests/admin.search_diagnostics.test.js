const nock = require('nock');
const request = require('supertest');

describe('GET /api/admin/search-diagnostics', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });

    prevEnv = {
      ADMIN_API_KEY: process.env.ADMIN_API_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY: process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
    };

    process.env.ADMIN_API_KEY = 'admin_test_key';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'true';

    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total') && text.includes('JOIN merchant_onboarding')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding')) {
          return {
            rows: [
              {
                merchant_id: 'merch_efbc46b4619cfbdf',
                merchant_name: 'Merchant One',
                product_data: {
                  id: '9886500127048',
                  product_id: '9886500127048',
                  merchant_id: 'merch_efbc46b4619cfbdf',
                  title: 'IPSA Time Reset Aqua',
                  description: 'Hydrating toner',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    jest.doMock('../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockImplementation(async ({ options }) => {
        if (options && options.stable_alias_short_circuit === false) {
          return {
            resolved: false,
            product_ref: null,
            confidence: 0,
            reason: 'no_candidates',
            metadata: {
              latency_ms: 7,
              sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }],
            },
          };
        }
        return {
          resolved: true,
          product_ref: {
            merchant_id: 'merch_efbc46b4619cfbdf',
            product_id: '9886500127048',
          },
          confidence: 1,
          reason: 'stable_alias_match',
          metadata: {
            latency_ms: 2,
            sources: [{ source: 'stable_alias_ref', ok: true, reason: 'alias_exact' }],
          },
        };
      }),
      _internals: {
        resolveKnownStableProductRef: ({ query, normalizedQuery, queryTokens }) => {
          const q = String(query || '').toLowerCase();
          if (q.includes('ipsa')) {
            return {
              product_ref: {
                merchant_id: 'merch_efbc46b4619cfbdf',
                product_id: '9886500127048',
              },
              score: 1,
              reason: 'alias_exact',
            };
          }
          return null;
        },
        normalizeTextForResolver: (value) => String(value || '').trim().toLowerCase(),
        tokenizeNormalizedResolverQuery: (value) =>
          String(value || '')
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean),
      },
    }));
  });

  afterEach(() => {
    jest.dontMock('../src/db');
    jest.dontMock('../src/services/productGroundingResolver');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();

    if (!prevEnv) return;
    if (prevEnv.ADMIN_API_KEY === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prevEnv.ADMIN_API_KEY;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    if (prevEnv.PIVOTA_API_BASE === undefined) delete process.env.PIVOTA_API_BASE;
    else process.env.PIVOTA_API_BASE = prevEnv.PIVOTA_API_BASE;
    if (prevEnv.PIVOTA_API_KEY === undefined) delete process.env.PIVOTA_API_KEY;
    else process.env.PIVOTA_API_KEY = prevEnv.PIVOTA_API_KEY;
    if (prevEnv.API_MODE === undefined) delete process.env.API_MODE;
    else process.env.API_MODE = prevEnv.API_MODE;
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    }
  });

  test('requires admin key', async () => {
    const app = require('../src/server');
    const resp = await request(app)
      .get('/api/admin/search-diagnostics')
      .query({ q: 'ipsa', source: 'shopping_agent' });

    expect(resp.status).toBe(401);
    expect(resp.body).toEqual(expect.objectContaining({ error: 'UNAUTHORIZED' }));
  });

  test('returns resolver and cache diagnostics for query', async () => {
    const app = require('../src/server');
    const resp = await request(app)
      .get('/api/admin/search-diagnostics')
      .set('X-ADMIN-KEY', 'admin_test_key')
      .query({ q: 'ipsa', source: 'shopping_agent', in_stock_only: 'true' });

    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.query).toBe('ipsa');
    expect(resp.body.config).toEqual(
      expect.objectContaining({
        resolver_first_enabled: true,
        resolver_first_strong_only: true,
        resolver_first_would_apply: true,
        resolver_query_is_strong: true,
      }),
    );
    expect(resp.body.resolver).toEqual(
      expect.objectContaining({
        alias_dependency: true,
      }),
    );
    expect(resp.body.cross_merchant_cache).toEqual(
      expect.objectContaining({
        ok: true,
        total: 1,
        products_count: 1,
      }),
    );
    expect(resp.body.cross_merchant_cache.sample_products?.[0]).toEqual(
      expect.objectContaining({
        product_id: '9886500127048',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });
});
