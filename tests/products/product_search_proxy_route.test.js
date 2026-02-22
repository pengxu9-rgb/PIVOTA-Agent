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
      PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      PROXY_SEARCH_RESOLVER_DETAIL_ENABLED: process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      PROXY_SEARCH_AURORA_FORCE_FAST_MODE: process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE,
      PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK:
        process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK,
      PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK:
        process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK,
      PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS:
        process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS,
      PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED:
        process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
      PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY:
        process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
      PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE:
        process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE,
      PROXY_SEARCH_AURORA_UPSTREAM_SOURCE:
        process.env.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE,
      PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED:
        process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED,
      PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES:
        process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER:
        process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER,
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS: process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
      PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS: process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
      PROXY_SEARCH_FALLBACK_TIMEOUT_MS: process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
      PROXY_SEARCH_RESOLVER_TIMEOUT_MS: process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS:
        process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS:
        process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS:
        process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_API_BASE: process.env.PROXY_SEARCH_AURORA_API_BASE,
      PROXY_SEARCH_AURORA_BACKEND_BASE_URL:
        process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    delete process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    delete process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED;
    delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;
    delete process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE;
    delete process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK;
    delete process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK;
    delete process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS;
    delete process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED;
    delete process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY;
    delete process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE;
    delete process.env.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE;
    delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED;
    delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES;
    delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    delete process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_API_BASE;
    delete process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL;
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
    if (prevEnv.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
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
    if (prevEnv.PROXY_SEARCH_AURORA_FORCE_FAST_MODE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE;
    } else {
      process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE =
        prevEnv.PROXY_SEARCH_AURORA_FORCE_FAST_MODE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK;
    } else {
      process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK =
        prevEnv.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK;
    } else {
      process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK =
        prevEnv.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS;
    } else {
      process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS =
        prevEnv.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED;
    } else {
      process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED =
        prevEnv.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY;
    } else {
      process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY =
        prevEnv.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE =
        prevEnv.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE;
    } else {
      process.env.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE =
        prevEnv.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED =
        prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES =
        prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES;
    }
    if (prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    } else {
      process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER =
        prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    }
    if (prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    } else {
      process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS =
        prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    }
    if (prevEnv.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_FALLBACK_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_API_BASE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_API_BASE;
    } else {
      process.env.PROXY_SEARCH_AURORA_API_BASE = prevEnv.PROXY_SEARCH_AURORA_API_BASE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_BACKEND_BASE_URL === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL;
    } else {
      process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL =
        prevEnv.PROXY_SEARCH_AURORA_BACKEND_BASE_URL;
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

  test('beauty search alias reuses generic proxy route with aurora defaults', async () => {
    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === 'Copper peptide serum' &&
          String(q.source || '') === 'aurora-bff' &&
          String(q.catalog_surface || '') === 'beauty' &&
          String(q.fast_mode || '') === 'true' &&
          String(q.allow_stale_cache || '') === 'false' &&
          String(q.allow_external_seed || '') === 'false' &&
          String(q.external_seed_strategy || '') === 'legacy'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper Peptide Serum',
          },
        ],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/beauty/products/search')
      .redirects(1)
      .query({
        query: 'Copper peptide serum',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });

  test('aurora source uses dedicated upstream base for primary and invoke fallback', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_AURORA_API_BASE = 'http://aurora-upstream.test';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'false';

    const auroraPrimaryScope = nock('http://aurora-upstream.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const auroraFallbackScope = nock('http://aurora-upstream.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'find_products_multi' &&
          body.payload &&
          body.payload.search &&
          String(body.payload.search.query || '') === queryText &&
          body.payload.search.fast_mode === true &&
          body.payload.search.allow_stale_cache === false &&
          body.payload.search.allow_external_seed === false &&
          String(body.payload.search.external_seed_strategy || '') === 'legacy' &&
          String(body.metadata?.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_fallback_aurora_base',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum fallback aurora base',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(auroraPrimaryScope.isDone()).toBe(true);
    expect(auroraFallbackScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_fallback_aurora_base',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        fallback_strategy: expect.objectContaining({
          source: 'aurora_force_path',
          aurora_upstream_base: 'http://aurora-upstream.test',
        }),
      }),
    );
  });

  test('aurora source can remap upstream source while preserving internal request source', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_AURORA_API_BASE = 'http://aurora-upstream.test';
    process.env.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE = 'shopping-assistant';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'false';

    const auroraPrimaryScope = nock('http://aurora-upstream.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === queryText &&
          String(q.source || '') === 'shopping-assistant' &&
          String(q.request_source || '') === 'aurora-bff'
        );
      })
      .reply(504, {
        error: 'timeout',
      });

    const auroraFallbackScope = nock('http://aurora-upstream.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'find_products_multi' &&
          body.payload &&
          body.payload.search &&
          String(body.payload.search.query || '') === queryText &&
          body.payload.search.fast_mode === true &&
          body.payload.search.allow_stale_cache === false &&
          body.payload.search.allow_external_seed === false &&
          String(body.payload.search.external_seed_strategy || '') === 'legacy' &&
          String(body.metadata?.source || '') === 'shopping-assistant' &&
          String(body.metadata?.request_source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_fallback_upstream_source',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum fallback',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(auroraPrimaryScope.isDone()).toBe(true);
    expect(auroraFallbackScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_fallback_upstream_source',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        fallback_strategy: expect.objectContaining({
          request_source: 'aurora-bff',
          upstream_source: 'shopping-assistant',
          aurora_upstream_source_override: 'shopping-assistant',
        }),
      }),
    );
  });

  test('aurora upstream source remap bypasses tight aurora primary timeout cap', async () => {
    const queryText = 'niacinamide';
    process.env.PROXY_SEARCH_AURORA_UPSTREAM_SOURCE = 'shopping-assistant';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS = '450';
    process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER = 'true';
    process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = '2500';
    process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS = '2500';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === queryText &&
          String(q.source || '') === 'shopping-assistant' &&
          String(q.request_source || '') === 'aurora-bff'
        );
      })
      .delay(900)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_remap_timeout_cap_ok',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Niacinamide Serum',
          },
        ],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(primaryScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_remap_timeout_cap_ok',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        fallback_strategy: expect.objectContaining({
          request_source: 'aurora-bff',
          upstream_source: 'shopping-assistant',
          aurora_upstream_source_override: 'shopping-assistant',
          aurora_primary_timeout_cap_applied: false,
        }),
      }),
    );
  });

  test('aurora source honors explicit allow_external_seed override from query params', async () => {
    process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED = 'true';
    process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY = 'supplement_internal_first';

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === 'Copper peptide serum' &&
          String(q.source || '') === 'aurora-bff' &&
          String(q.fast_mode || '') === 'true' &&
          String(q.allow_external_seed || '') === 'false' &&
          String(q.external_seed_strategy || '') === 'legacy'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_override_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum',
          },
        ],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'Copper peptide serum',
        source: 'aurora-bff',
        allow_external_seed: 'false',
        external_seed_strategy: 'legacy',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_override_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });

  test('aurora source does not skip secondary fallback after resolver miss', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'upstream_timeout',
        metadata: {
          latency_ms: 12,
          sources: [{ source: 'agent_search_scoped', ok: false, reason: 'upstream_timeout' }],
        },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const secondaryScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.payload.search.fast_mode === true &&
          parsed.payload.search.allow_stale_cache === false &&
          String(parsed.payload.search.catalog_surface || '') === 'beauty' &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_fallback_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum fallback',
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
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(secondaryScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_fallback_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
        }),
        fallback_strategy: expect.objectContaining({
          source: 'aurora_force_path',
          request_source: 'aurora-bff',
          upstream_source: 'aurora-bff',
          aurora_upstream_source_override: null,
          resolver_attempted: true,
          secondary_attempted: true,
          secondary_skipped_reason: null,
          secondary_rejected_reason: null,
          secondary_fallback_duration_ms: expect.any(Number),
          aurora_external_seed_forced: true,
          aurora_external_seed_enabled: false,
          aurora_seed_strategy: 'legacy',
        }),
      }),
    );
  });

  test('aurora source preserves fallback_strategy and attempts secondary fallback on primary 5xx', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 4, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(504, {
        status: 'error',
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message: 'Search timeout',
        },
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.payload.search.fast_mode === true &&
          parsed.payload.search.allow_stale_cache === false &&
          String(parsed.payload.search.external_seed_strategy || '') === 'legacy' &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_timeout_recover_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum fallback',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_timeout_recover_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'empty_or_unusable_primary',
        }),
        fallback_strategy: expect.objectContaining({
          source: 'aurora_force_path',
          resolver_attempted: true,
          secondary_attempted: true,
          secondary_skipped_reason: null,
        }),
      }),
    );
  });

  test('aurora source returns strict_empty with fallback_strategy when primary and secondary both fail', async () => {
    const queryText = 'retinol serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(504, {
        status: 'error',
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message: 'Search timeout',
        },
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.payload.search.fast_mode === true &&
          parsed.payload.search.allow_stale_cache === false &&
          String(parsed.payload.search.external_seed_strategy || '') === 'legacy' &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(504, {
        status: 'error',
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message: 'fallback timeout',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        strict_empty: true,
        strict_empty_reason: 'primary_status_5xx',
        fallback_strategy: expect.objectContaining({
          source: 'aurora_force_path',
          resolver_attempted: true,
          secondary_attempted: true,
          secondary_skipped_reason: null,
        }),
      }),
    );
  });

  test('aurora source treats 429 primary responses as fallback-eligible and adopts invoke fallback', async () => {
    const queryText = 'the ordinary copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(429, {
        status: 'error',
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'alt_429_1',
            merchant_id: 'merch_sigma',
            title: 'Copper Peptide Repair Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'alt_429_1',
        merchant_id: 'merch_sigma',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        fallback_strategy: expect.objectContaining({
          secondary_attempted: true,
          secondary_rejected_reason: null,
        }),
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'empty_or_unusable_primary',
        }),
      }),
    );
  });

  test('aurora source applies low-latency primary/fallback timeouts to avoid long upstream waits', async () => {
    const queryText = 'niacinamide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS = '4200';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS = '450';
    process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS = '450';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .delay(900)
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'slow_primary_hit', merchant_id: 'merch_slow', title: 'Slow Primary' }],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'fast_fallback_hit', merchant_id: 'merch_fast', title: 'Niacinamide Hydrating Serum' }],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'fast_fallback_hit',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        fallback_strategy: expect.objectContaining({
          secondary_attempted: true,
          secondary_rejected_reason: null,
        }),
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'primary_request_failed',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: true,
          primary_latency_ms: expect.any(Number),
        }),
      }),
    );
    expect(resp.body.metadata.route_health.primary_latency_ms).toBeLessThan(900);
  });

  test('aurora resolver timeout budget does not poison non-aurora resolver cache', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS = '1600';
    process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS = '350';

    const resolverSpy = jest.fn().mockResolvedValue({
      resolved: false,
      confidence: 0,
      reason: 'no_candidates',
      reason_code: 'no_candidates',
      metadata: {
        latency_ms: 8,
        sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }],
      },
    });

    jest.doMock('../../src/services/productGroundingResolver', () => {
      const actual = jest.requireActual('../../src/services/productGroundingResolver');
      return {
        ...actual,
        resolveProductRef: resolverSpy,
      };
    });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .times(2)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_anchor_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const auroraResp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });
    const callCountAfterAurora = resolverSpy.mock.calls.length;
    const genericResp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
      });
    const auroraTimeouts = resolverSpy.mock.calls
      .slice(0, callCountAfterAurora)
      .map((call) => Number(call?.[0]?.options?.timeout_ms || 0));
    const genericTimeouts = resolverSpy.mock.calls
      .slice(callCountAfterAurora)
      .map((call) => Number(call?.[0]?.options?.timeout_ms || 0));

    expect(auroraResp.status).toBe(200);
    expect(genericResp.status).toBe(200);
    expect(callCountAfterAurora).toBeGreaterThan(0);
    expect(resolverSpy.mock.calls.length).toBeGreaterThan(callCountAfterAurora);
    expect(auroraTimeouts.every((value) => value === 350)).toBe(true);
    expect(genericTimeouts.some((value) => value === 1600)).toBe(true);
  });

  test('aurora source detects same-brand external monoculture and forces semantic retry fallback', async () => {
    const queryText = 'the ordinary copper peptide serum';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES = '1';

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
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'ord_1', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'The Multi-Peptide Collection' },
          { product_id: 'ord_2', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'Multi-Peptide + HA Serum' },
          { product_id: 'ord_3', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'Multi-Peptide + Copper Peptides 1% Serum' },
        ],
        total: 3,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'ord_fb_1', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'The Multi-Peptide Collection' },
        ],
        total: 1,
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        const queryValue = String(q?.query || '').toLowerCase();
        return String(q?.source || '').toLowerCase() === 'aurora-bff' && queryValue.includes('multi peptide');
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_retry_brand_mix_1',
            merchant_id: 'merch_sigma',
            brand: 'Sigma Beauty',
            title: 'Copper Peptide Recovery Serum',
          },
          {
            product_id: 'cp_retry_brand_mix_2',
            merchant_id: 'merch_rare',
            brand: 'Rare Beauty',
            title: 'Firming Peptide Serum',
          },
          {
            product_id: 'cp_retry_brand_mix_3',
            merchant_id: 'merch_glow',
            brand: 'Glow Recipe',
            title: 'Hydrating Peptide Serum',
          },
        ],
        total: 3,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'cp_retry_brand_mix_1',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'primary_monoculture',
        }),
        fallback_strategy: expect.objectContaining({
          primary_monoculture_detected: true,
          secondary_attempted: true,
          secondary_attempt_count: 2,
          secondary_relevance_passed: true,
          secondary_rejected_reason: null,
        }),
      }),
    );
    expect(String(resp.body?.metadata?.fallback_strategy?.secondary_selected_query || '').toLowerCase()).toContain(
      'multi peptide',
    );
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

  test('aurora source accepts relevant secondary fallback even when usable count is lower than irrelevant primary', async () => {
    const queryText = 'copper peptides serum alternatives';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 9, sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'irrelevant_1', merchant_id: 'm1', title: 'Round Powder Brush' },
          { product_id: 'irrelevant_2', merchant_id: 'm2', title: 'Foundation Makeup Sponge' },
          { product_id: 'irrelevant_3', merchant_id: 'm3', title: 'Eyeliner Brush Kit' },
        ],
        total: 3,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper Peptide Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'cp_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'primary_irrelevant',
        }),
      }),
    );
  });

  test('aurora source retries semantic fallback query for primary_irrelevant and adopts second attempt', async () => {
    const queryText = 'copper peptide serum';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES = '1';

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
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'irrelevant_1', merchant_id: 'm1', title: 'Round Powder Brush' },
          { product_id: 'irrelevant_2', merchant_id: 'm2', title: 'Foundation Makeup Sponge' },
          { product_id: 'irrelevant_3', merchant_id: 'm3', title: 'Eyeliner Brush Kit' },
        ],
        total: 3,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'irrelevant_fb_1', merchant_id: 'm4', title: 'Gentle Hydrating Toner' }],
        total: 1,
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        const queryValue = String(q?.query || '').toLowerCase();
        return String(q?.source || '').toLowerCase() === 'aurora-bff' && queryValue.includes('multi peptide');
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_retry_hit',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Multi-Peptide Lash and Brow Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'cp_retry_hit',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'primary_irrelevant',
        }),
        fallback_strategy: expect.objectContaining({
          secondary_attempted: true,
          secondary_attempt_count: 2,
          secondary_relevance_passed: true,
          secondary_rejected_reason: null,
        }),
      }),
    );
    expect(String(resp.body?.metadata?.fallback_strategy?.secondary_selected_query || '').toLowerCase()).toContain(
      'multi peptide',
    );
  });

  test('aurora semantic retry maps copper tripeptide query to copper peptide fallback', async () => {
    const queryText = 'copper tripeptide serum';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES = '1';

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
      .query((q) => String(q.query || '') === queryText && String(q.source || '') === 'aurora-bff')
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'irrelevant_1', merchant_id: 'm1', title: 'Beauty Sponge Tools Kit' }],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return String(parsed?.payload?.search?.query || '') === queryText;
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'irrelevant_fb_1', merchant_id: 'm4', title: 'Hydrating Toner' }],
        total: 1,
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q?.source || '').toLowerCase() === 'aurora-bff' &&
          String(q?.query || '').toLowerCase().includes('copper peptide')
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'cp_tri_hit', merchant_id: 'merch_efbc46b4619cfbdf', title: 'Copper Peptide Serum' }],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(expect.objectContaining({ product_id: 'cp_tri_hit' }));
    expect(String(resp.body?.metadata?.fallback_strategy?.secondary_selected_query || '').toLowerCase()).toContain(
      'copper peptide',
    );
    expect(resp.body?.metadata?.fallback_strategy?.secondary_attempt_count).toBeGreaterThanOrEqual(1);
  });
});
