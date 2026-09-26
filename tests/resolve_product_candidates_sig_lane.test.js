'use strict';

// resolve_product_candidates could not consume sig_* ids — the id namespace
// find_products_multi emits — so the advertised "resolve what you found" flow
// returned a hollow `status: success` / 0 offers / `pg:pid:<input>` echo for
// every sig input (live-verified 2026-08-08 against three inputs, including
// the openapi.json example). These tests pin the sig lane: resolve the
// signature to its catalog anchor first, run the normal legs on the anchor's
// source ids, and answer honestly (404, not hollow success) for an unknown
// signature.

const nock = require('nock');
const request = require('supertest');

const ORIGINAL_ENV = process.env;

const SIG = 'sig_000348608dab8c172868d835c91b3cf4';

// Shape of the one row resolveCatalogProductRefFromPivotaSignature's exact
// query returns. Only the fields these tests reason about are populated.
function signatureRow(overrides = {}) {
  return {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_product_id: 'ext_foot_mask_1',
    product_key: 'prod::external_seed::external_seed::ext_foot_mask_1',
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: SIG,
    content_key: 'ck_f672d701254659ae980efd8ab412cb73',
    catalog_title: 'Lovely Peach Foot Mask',
    ...overrides,
  };
}

function loadServer(rows, envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    INVOKE_AUTH_BYPASS_IN_TEST: '1',
    PIVOTA_API_BASE: 'https://backend.test',
    PIVOTA_API_KEY: 'test-token',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '2000',
    // Cache off so each test observes its own resolution, not a prior test's.
    RESOLVE_PRODUCT_CANDIDATES_CACHE_ENABLED: '0',
    ...envOverrides,
  };
  const seenSql = [];
  const query = jest.fn(async (sql) => {
    seenSql.push(String(sql));
    // Only the FIRST query (the exact signature lookup) returns the row; the
    // identity-listing and group-member follow-ups return nothing, which keeps
    // the resolver on its single-row path.
    return { rows: seenSql.length === 1 ? rows : [] };
  });
  jest.doMock('../src/db', () => ({
    query,
    queryWithStatementTimeout: query,
    withClient: jest.fn(),
    getPool: jest.fn(() => ({})),
    closePool: jest.fn(),
  }));
  return { app: require('../src/server'), seenSql, query };
}

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('resolve_product_candidates sig_* lane', () => {
  test('resolves a sig id to its catalog anchor and returns its offer', async () => {
    const { app } = loadServer([signatureRow()]);

    // The search leg must be asked about the RESOLVED source id, scoped to the
    // resolved merchant — not the sig id as a keyword query.
    const search = nock('https://backend.test')
      .get('/agent/v1/products/search')
      .query((q) => q.query === 'ext_foot_mask_1' && q.merchant_id === 'external_seed')
      .reply(200, {
        status: 'success',
        products: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_foot_mask_1',
            platform: 'external_seed',
            platform_product_id: 'ext_foot_mask_1',
            title: 'Lovely Peach Foot Mask',
            price: 5.5,
            currency: 'USD',
            in_stock: true,
          },
        ],
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'resolve_product_candidates',
        payload: { product_ref: { product_id: SIG }, include_offers: true, limit: 5 },
      });

    expect(res.status).toBe(200);
    expect(search.isDone()).toBe(true);
    expect(res.body.status).toBe('success');
    // The sig-lane translation is disclosed, not silent.
    expect(res.body.pivota_signature_id).toBe(SIG);
    expect(res.body.resolved_product_id).toBe('ext_foot_mask_1');
    // The old failure sentinel — the input echoed back — must be gone.
    expect(res.body.product_group_id).not.toBe(`pg:pid:${SIG}`);
    expect(res.body.offers_count).toBe(1);
    expect(res.body.canonical_product_ref).not.toBeNull();
  });

  test('unknown signature answers an honest 404, not a hollow success', async () => {
    const { app } = loadServer([]);

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'resolve_product_candidates',
        payload: { product_ref: { product_id: 'sig_00000000000000000000000000000000' } },
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
    // Never the hollow shape agents were caching as "index has no offers".
    expect(res.body.status).not.toBe('success');
  });

  test('non-sig ids do not touch the signature resolver (lane unchanged)', async () => {
    const { app, seenSql } = loadServer([signatureRow()]);

    nock('https://backend.test')
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query(true)
      .reply(200, { status: 'success', members: [] });
    nock('https://backend.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { status: 'success', products: [] });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'resolve_product_candidates',
        payload: { product_ref: { product_id: '9886499864904' } },
      });

    expect(res.status).toBe(200);
    // Other lanes may hit the db (merchant scoping etc.) — the assertion is
    // that the SIGNATURE lookup specifically never ran for a non-sig id.
    expect(seenSql.some((sql) => sql.includes('pivota_signature_id = $1'))).toBe(false);
    expect(res.body.pivota_signature_id).toBeUndefined();
  });
});
