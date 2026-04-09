const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke find_products_multi shopping mainline', () => {
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
      STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED:
        process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED,
      FIND_PRODUCTS_MULTI_EXPANSION_MODE: process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE,
      FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE:
        process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED: process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
    process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED = 'false';
    process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = 'off';
    process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = 'off';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
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
    if (prevEnv.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED === undefined) {
      delete process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED;
    } else {
      process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED =
        prevEnv.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED;
    }
    if (prevEnv.FIND_PRODUCTS_MULTI_EXPANSION_MODE === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE;
    } else {
      process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = prevEnv.FIND_PRODUCTS_MULTI_EXPANSION_MODE;
    }
    if (prevEnv.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE === undefined) {
      delete process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE;
    } else {
      process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE =
        prevEnv.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    } else {
      process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
        prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    }
  });

  test('keeps shopping search on fresh upstream with unified external seed blending', async () => {
    const queryText = 'hydrating face cream';
    let capturedBody = null;
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            {
              product_id: 'prod_1',
              merchant_id: 'merch_1',
              title: 'Hydrating Face Cream',
              description: 'Fresh upstream result',
            },
          ],
          total: 1,
          metadata: {
            query_source: 'agent_products_search',
          },
        };
      });

    const legacySearch = nock('http://pivota.test')
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
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        search_all_merchants: true,
        allow_external_seed: true,
        allow_stale_cache: false,
        external_seed_strategy: 'unified_relevance',
        query: queryText,
        request_context: expect.objectContaining({
          channel: 'shopping_agent',
        }),
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: 'agent_products_search',
      }),
    );
  });

  test('returns strict empty instead of adopting cache or resolver fallback on upstream failure', async () => {
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(500, {
        error: 'UPSTREAM_FAILURE',
        message: 'backend failed',
      });

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'legacy_1',
            merchant_id: 'legacy_merchant',
            title: 'Legacy fallback product',
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
            query: 'barrier repair cream',
            limit: 10,
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: 'agent_products_search',
        strict_empty: true,
        strict_empty_reason: expect.stringMatching(/^shopping_mainline_(exception|upstream_5xx)$/),
        route_health: expect.objectContaining({
          fallback_triggered: false,
        }),
      }),
    );
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  test('does not bridge authoritative shopping v2 contract mismatch back to legacy v1 search', async () => {
    const queryText = 'hydrating face cream';
    const upstreamSearch = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(422, {
        detail: [
          {
            loc: ['body', 'search'],
            msg: 'Field required',
            type: 'missing',
          },
        ],
      });

    const legacySearch = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'legacy_422_should_not_run',
            merchant_id: 'legacy_merchant',
            title: 'Legacy bridge should not run',
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
            page: 1,
            in_stock_only: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
          },
        },
        metadata: {
          source: 'shopping_agent',
        },
      });

    expect(resp.status).toBe(200);
    expect(upstreamSearch.isDone()).toBe(true);
    expect(legacySearch.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        strict_empty: true,
        strict_empty_reason: 'shopping_mainline_exception',
      }),
    );
    expect(String(resp.body.metadata?.contract_bridge?.resolved_contract || '')).not.toBe('agent_v1');
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });
});
