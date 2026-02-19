const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi fallback', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
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
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
      PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS:
        process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS,
      PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS:
        process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS:
        process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
      FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS:
        process.env.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS,
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER:
        process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
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
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    }
    if (prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    } else {
      process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
        prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
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
    if (prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    } else {
      process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS =
        prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    }
    if (prevEnv.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS;
    } else {
      process.env.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS =
        prevEnv.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS;
    }
    if (prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    } else {
      process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER =
        prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    }
  });

  test('uses resolver-first fallback for creator_agent source', async () => {
    const queryText = 'ipsa';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.99,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 10 },
      }),
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
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
          source: 'creator_agent',
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
          reason: 'resolver_first',
        }),
      }),
    );
    expect(primaryScope.isDone()).toBe(false);
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

  test('does not run resolver-first for non-strong shopping queries when strong-only is enabled', async () => {
    const queryText = 'ipsa toner for dry skin';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'true';

    const resolverSpy = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '9886500127048',
      },
      confidence: 0.98,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 11 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: resolverSpy,
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'prod_ipsa_toner_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'IPSA toner for dry skin',
          },
        ],
        total: 1,
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
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resolverSpy).not.toHaveBeenCalled();
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

  test('still runs invoke fallback on primary timeout when resolver miss skip is enabled', async () => {
    const queryText = 'Winona Soothing Repair Serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS = '1800';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'upstream_timeout',
        metadata: {
          latency_ms: 16,
          sources: [{ source: 'agent_search_scoped', ok: false, reason: 'upstream_timeout' }],
        },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .delay(2500)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9886500749640',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: queryText,
          },
        ],
        total: 1,
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
        product_id: '9886500749640',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: expect.stringMatching(/^upstream_/),
          route: 'invoke_exception_fallback_invoke',
        }),
      }),
    );
  });

  test('enforces safe timeout floor for find_products_multi when configured timeout is too low', async () => {
    const queryText = 'IPSA Time Reset Aqua';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = '3200';
    process.env.FIND_PRODUCTS_MULTI_TIMEOUT_SAFE_MIN_MS = '6500';
    delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .delay(3800)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9886500127048',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'IPSA Time Reset Aqua',
          },
        ],
        total: 1,
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
        product_id: '9886500127048',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });

  test('resolver fallback remains available when secondary invoke fallback is disabled', async () => {
    const queryText = 'IPSA related products';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.97,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 12 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710920',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
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
          title: 'IPSA Time Reset Aqua',
          brand: 'IPSA',
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
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('uses resolver fallback when primary rows are usable but irrelevant for brand lookup', async () => {
    const queryText = 'IPSA related products';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.96,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 14 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710920',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
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
          title: 'IPSA Time Reset Aqua',
          brand: 'IPSA',
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
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('returns empty soft fallback when invoke lookup stays irrelevant and resolver misses', async () => {
    const queryText = 'IPSA related products';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: {
          latency_ms: 12,
          sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }],
        },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710920',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
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
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'primary_irrelevant_no_fallback',
        }),
      }),
    );
  });
});
