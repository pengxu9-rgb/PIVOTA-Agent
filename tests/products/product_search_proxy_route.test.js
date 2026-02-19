const nock = require('nock');
const request = require('supertest');

describe('GET /agent/v1/products/search proxy fallback', () => {
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
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      PROXY_SEARCH_RESOLVER_DETAIL_ENABLED: process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    delete process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED;
    delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;
    delete process.env.DATABASE_URL;
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
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
    if (prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    } else {
      process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
        prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED =
        prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED =
        prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('does not run resolver-first on proxy route by default', async () => {
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;

    const resolverSpy = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '9886500749640',
      },
      confidence: 1,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 9 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: resolverSpy,
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'Winona Soothing Repair Serum')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9886500749640',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Winona Soothing Repair Serum',
          },
        ],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'Winona Soothing Repair Serum',
        lang: 'en',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: '9886500749640',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  test('resolver-first retries sanitized candidate for noisy lookup query', async () => {
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'true';
    process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED = 'true';

    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    const resolverSpy = jest.fn().mockImplementation(async ({ query }) => {
      if (String(query || '').trim() === 'ipsa') {
        return {
          resolved: true,
          product_ref: {
            merchant_id: resolvedMerchantId,
            product_id: resolvedProductId,
          },
          confidence: 1,
          reason: 'stable_alias_ref',
          reason_code: 'stable_alias_match',
          metadata: { latency_ms: 10, sources: [{ source: 'stable_alias_ref', ok: true, count: 1 }] },
        };
      }
      return {
        resolved: false,
        reason: 'no_candidates',
        reason_code: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      };
    });

    jest.doMock('../../src/services/productGroundingResolver', () => {
      const actual = jest.requireActual('../../src/services/productGroundingResolver');
      return {
        ...actual,
        resolveProductRef: resolverSpy,
      };
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
          id: resolvedProductId,
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: 'IPSA Time Reset Aqua',
          price: 45,
          currency: 'USD',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'ipsa的商品有吗？',
        lang: 'zh',
        limit: 5,
        offset: 0,
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
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_first',
        }),
      }),
    );
  });

  test('prefers resolver fallback when primary search returns unusable shell rows', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = 'prod_pref_1';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 8 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        total: 1,
        page: 1,
        page_size: 1,
        products: [
          {
            id: null,
            product_id: null,
            merchant_id: null,
            merchant_name: null,
            title: null,
            name: null,
          },
        ],
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
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
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('resolver fallback still works when invoke secondary fallback is disabled', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = 'prod_pref_1';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 8 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        total: 1,
        page: 1,
        page_size: 1,
        products: [
          {
            id: null,
            product_id: null,
            merchant_id: null,
            merchant_name: null,
            title: null,
            name: null,
          },
        ],
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
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
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('keeps primary response when it already contains usable rows', async () => {
    const queryText = 'Winona Soothing Repair Serum';

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
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
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: '9886500749640',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: false,
          reason: 'not_needed',
        }),
      }),
    );
  });

  test('uses resolver fallback when primary and invoke search both fail', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886499864904';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 12 },
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
          title: queryText,
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
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

  test('returns resolver reference-only row when lookup detail cannot be hydrated', async () => {
    const queryText = 'IPSA Time Reset Aqua';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 13 },
      }),
    }));

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
      .reply(404, {
        status: 'error',
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' },
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(500, {
        status: 'error',
        detail: 'Search failed',
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_ref_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_first',
        }),
      }),
    );
  });

  test('skips irrelevant invoke fallback results and uses resolver fallback', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886499864904';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 9 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
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
          title: queryText,
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({ query: queryText, lang: 'en' });

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

  test('supports q alias and triggers resolver fallback on primary error payload', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886499864904';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.96,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 11 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'error',
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Search failed',
        },
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
          title: queryText,
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        q: queryText,
        lang: 'en',
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

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.95,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 10 },
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
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
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

  test('returns empty soft fallback when brand lookup remains irrelevant after fallback chain', async () => {
    const queryText = 'IPSA related products';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 8, sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }] },
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
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710921',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Large Makeup Brush Set',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
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
