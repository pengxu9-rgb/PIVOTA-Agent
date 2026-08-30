const nock = require('nock');
const request = require('supertest');

// ADR-007 op-level citable supplement — OFF the serial path.
//
// Prod fpm_stage_breakdown (PR #1753) measured the supplement's tokenMatch
// canonical query at 5.8-17.2s on EVERY find_products_multi invoke, 60-80% of
// wall time, because handleInvokeRequest awaited it BEFORE the pipeline ran.
// The prefetch is now fire-and-forget: the res.json wrapper appends whatever
// has resolved by send time and fails open to [] (stamping
// metadata.citable_supplement_pending), while the resolved result warms a
// per-query TTL cache so subsequent identical queries append from cache.
//
// The supplement query is the only fetchCanonicalChainRows call with
// eligibility:'index_eligible', so the db mock discriminates on that SQL text.

const ENV_KEYS = [
  'PIVOTA_API_BASE',
  'PIVOTA_API_KEY',
  'API_MODE',
  'DATABASE_URL',
  'INDEX_ELIGIBLE_RECALL',
  'CITABLE_SUPPLEMENT_CACHE_TTL_MS',
  'STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED',
  'FIND_PRODUCTS_MULTI_EXPANSION_MODE',
  'FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE',
  'PROXY_SEARCH_RESOLVER_FIRST_ENABLED',
  'PROXY_SEARCH_INVOKE_FALLBACK_ENABLED',
  'PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED',
];

const isSupplementSql = (sql) => String(sql || '').includes('index_eligible');

function citableRow() {
  return {
    merchant_id: 'external_seed',
    product_key: 'prod::external_seed::external_seed::ext_cit_1',
    source_product_id: 'ext_cit_1',
    product_title: 'Citable Barrier Cream',
    brand: 'CitBrand',
    content_key: 'ck_cit_1',
    pivota_signature_id: 'sig_cit_1',
    product_payload: {
      seed_data: {
        snapshot: { price_amount: 26, price_currency: 'USD' },
      },
    },
  };
}

function mockUpstreamSearch() {
  return nock('http://pivota.test')
    .post('/agent/v2/products/search')
    .query(true)
    .reply(200, {
      status: 'success',
      success: true,
      products: [
        {
          product_id: 'prod_1',
          merchant_id: 'merch_1',
          title: 'Hydrating Face Cream',
          description: 'Fresh upstream result',
          price: 31,
          currency: 'USD',
        },
      ],
      total: 1,
      metadata: { query_source: 'agent_products_search' },
    })
    .persist();
}

function invokeBody(queryText) {
  return {
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
    metadata: { source: 'shopping_agent' },
  };
}

describe('/agent/shop/v1/invoke find_products_multi citable supplement off-path', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });

    prevEnv = {};
    for (const key of ENV_KEYS) prevEnv[key] = process.env[key];

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
    process.env.INDEX_ELIGIBLE_RECALL = 'true';
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
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  test('a slow supplement query no longer blocks the response (fail-open, pending stamped)', async () => {
    let supplementCalls = 0;
    jest.doMock('../../src/db', () => ({
      query: jest.fn((sql) => {
        if (isSupplementSql(sql)) {
          supplementCalls += 1;
          return new Promise(() => {}); // prod-shaped hang: 5.8-17.2s, never inside test window
        }
        return Promise.resolve({ rows: [] });
      }),
    }));
    mockUpstreamSearch();

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send(invokeBody('hydrating face cream'));

    expect(resp.status).toBe(200);
    // The prefetch was issued exactly once, but the response did not wait on it.
    expect(supplementCalls).toBe(1);
    expect(resp.body.products.map((p) => p.product_id)).toContain('prod_1');
    expect(resp.body.products.every((p) => p.source !== 'canonical_citation')).toBe(true);
    expect(resp.body.metadata.citable_supplement_count).toBe(0);
    expect(resp.body.metadata.citable_supplement_pending).toBe(true);
  });

  test('a resolved supplement warms the cache; the next identical query appends without a second DB hit', async () => {
    let supplementCalls = 0;
    jest.doMock('../../src/db', () => ({
      query: jest.fn((sql) => {
        if (isSupplementSql(sql)) {
          supplementCalls += 1;
          return Promise.resolve({ rows: [citableRow()] });
        }
        return Promise.resolve({ rows: [] });
      }),
    }));
    mockUpstreamSearch();

    const app = require('../../src/server');
    const first = await request(app)
      .post('/agent/shop/v1/invoke')
      .send(invokeBody('barrier repair cream'));
    expect(first.status).toBe(200);
    expect(supplementCalls).toBe(1);

    const second = await request(app)
      .post('/agent/shop/v1/invoke')
      .send(invokeBody('barrier repair cream'));

    expect(second.status).toBe(200);
    // Cache hit: no second index_eligible round-trip.
    expect(supplementCalls).toBe(1);
    // Citations remain available to the evidence layer, but must not be
    // returned as Shopping Agent recommendation cards: they cannot be added
    // to bag and can be stale relative to the current PDP offer.
    expect(second.body.products.find((p) => p.source === 'canonical_citation')).toBeUndefined();
    expect(second.body.metadata.citable_supplement_count).toBe(1);
    expect(second.body.metadata.availability_contract).toMatchObject({
      known_unavailable_excluded: true,
      dropped_known_unavailable: 1,
    });
    expect(second.body.metadata.citable_supplement_pending).toBeUndefined();
  });
});
