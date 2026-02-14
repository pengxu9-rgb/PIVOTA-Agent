const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi fallback', () => {
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
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS:
        process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS,
      PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS:
        process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();

    if (!prevEnv) return;
    if (prevEnv.PIVOTA_API_BASE === undefined) delete process.env.PIVOTA_API_BASE;
    else process.env.PIVOTA_API_BASE = prevEnv.PIVOTA_API_BASE;
    if (prevEnv.PIVOTA_API_KEY === undefined) delete process.env.PIVOTA_API_KEY;
    else process.env.PIVOTA_API_KEY = prevEnv.PIVOTA_API_KEY;
    if (prevEnv.API_MODE === undefined) delete process.env.API_MODE;
    else process.env.API_MODE = prevEnv.API_MODE;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS === undefined) {
      delete process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS;
    } else {
      process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS =
        prevEnv.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS;
    }
    if (prevEnv.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS === undefined) {
      delete process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS;
    } else {
      process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS =
        prevEnv.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS;
    }
  });

  test('falls back to resolver when primary and invoke fallback both fail', async () => {
    const queryText = 'Winona';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500749640';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.98,
        reason: 'title_contains_query',
        metadata: { latency_ms: 18 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(500, {
        status: 'error',
        detail: 'Search failed',
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(500, {
        status: 'error',
        detail: 'Search failed',
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: 'Winona Soothing Repair Serum',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: false,
          },
        },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: expect.stringMatching(/^resolver_after_/),
        }),
      }),
    );
  });

  test('skips secondary fallback chain when resolver miss already has no positive sources', async () => {
    const queryText = 'SK-II Facial Treatment Essence';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS = '1800';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: {
          latency_ms: 27,
          sources: [
            { source: 'products_cache', ok: false, reason: 'db_query_timeout' },
            { source: 'agent_search_scoped', ok: false, reason: 'upstream_timeout' },
            { source: 'products_cache_global', ok: false, reason: 'db_query_timeout' },
          ],
        },
      }),
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: false,
          },
        },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(primaryScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: expect.any(String),
        proxy_search_fallback: expect.objectContaining({
          applied: false,
          reason: 'resolver_miss_skip_secondary',
        }),
      }),
    );
  });

  test('skips secondary fallback when resolver miss is upstream timeout', async () => {
    const queryText = 'Winona Soothing Repair Serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS = '1800';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'upstream_timeout',
        metadata: {
          latency_ms: 19,
          sources: [{ source: 'agent_search_scoped', ok: false, reason: 'upstream_timeout' }],
        },
      }),
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: queryText,
            limit: 10,
            in_stock_only: false,
          },
        },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(primaryScope.isDone()).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: false,
          reason: 'resolver_miss_skip_secondary',
        }),
      }),
    );
  });
});
