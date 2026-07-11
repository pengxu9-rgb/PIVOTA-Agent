const nock = require('nock');
const request = require('supertest');

// Guards the #1753 parallel-recall behavior: resolver-first races the primary
// upstream (FPM_PARALLEL_RESOLVER_PRIMARY, default on). Strong-resolver queries
// (known stable-alias / UUID-style lookups) adopt the resolver hit almost every
// time, so racing the primary is a pure wasted upstream call — the guard skips
// speculation for them. Weaker lookup queries, where the resolver can miss,
// still race the primary so the in-flight result earns the tail-latency win.
describe('/agent/shop/v1/invoke find_products_multi speculative-primary guard', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/services/productGroundingResolver');
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
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY: process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED: process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      FIND_PRODUCTS_MULTI_EXPANSION_MODE: process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE,
      FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE:
        process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
      STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED:
        process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED,
      FPM_PARALLEL_RESOLVER_PRIMARY: process.env.FPM_PARALLEL_RESOLVER_PRIMARY,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'true';
    process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = 'off';
    process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = 'off';
    process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED = 'false';
    // Parallel recall on (the prod default under test here).
    process.env.FPM_PARALLEL_RESOLVER_PRIMARY = 'true';
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    jest.dontMock('../../src/services/productGroundingResolver');
    jest.resetModules();
    if (!prevEnv) return;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const invoke = (app, queryText) =>
    request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: queryText, limit: 10, in_stock_only: false } },
        metadata: {
          scope: { catalog: 'global', region: 'US', language: 'en-US' },
          entry: 'home',
          source: 'creator_agent',
          legacy_contracts: true,
        },
      });

  test('strong-resolver (UUID) query does NOT race a wasted primary upstream when the resolver adopts', async () => {
    // A 32-hex UUID-style token is a strong-resolver query: isStrongResolverFirstQuery
    // returns true, so the guard must skip the speculative primary.
    const queryText = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: { merchant_id: resolvedMerchantId, product_id: resolvedProductId },
        confidence: 0.99,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 10 },
      }),
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { status: 'success', success: true, products: [], total: 0 });

    const app = require('../../src/server');
    const resp = await invoke(app, queryText);

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({ product_id: resolvedProductId, merchant_id: resolvedMerchantId }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_fallback',
        proxy_search_fallback: expect.objectContaining({ applied: true, reason: 'resolver_first' }),
      }),
    );
    // The guard skipped speculation: the primary upstream was never called.
    expect(primaryScope.isDone()).toBe(false);
  });

  test('weak lookup query still races the primary so a resolver MISS pays no extra serial latency', async () => {
    // Non-strong query: the resolver may miss, so speculation is worthwhile.
    const queryText = 'barrier repair serum';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      // Resolver misses -> the in-flight speculative primary must be adopted.
      resolveProductRef: jest.fn().mockResolvedValue({ resolved: false, reason: 'no_match' }),
    }));

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'primary_1', merchant_id: 'merch_primary', title: 'Barrier Repair Serum' },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await invoke(app, queryText);

    expect(resp.status).toBe(200);
    // The primary WAS raced and its result served the request.
    expect(primaryScope.isDone()).toBe(true);
    expect((resp.body.products || []).map((p) => p.product_id)).toContain('primary_1');
  });
});
