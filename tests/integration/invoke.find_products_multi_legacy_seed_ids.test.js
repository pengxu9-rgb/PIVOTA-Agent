const ORIGINAL_ENV = { ...process.env };

const request = require('supertest');
const nock = require('nock');

// FIX_PLAN D-06, review G-1: the search doors that do NOT run through the commerce kernel — direct
// POST /agent/shop/v1/invoke find_products_multi and REST GET /agent/v1/products/search — serve legacy
// `<slug>:<hex>` seed rows through the invoke egress. There, a row carrying a signature advertises it
// (the pipeline or the egress), and a row no lane can open is dropped only once the database says so.
// The backend's v2 search is mocked at the process edge; names are placeholders.

const LEGACY_OPEN = 'shop-a:0123456789abcdef';
const LEGACY_SIG = 'shop-b:00000000000000aa';
const LEGACY_DEAD = 'shop-c:00000000000000bb';
const SIG = 'sig_00000000000000000000000000000001';

function v2Row(productId, overrides = {}) {
  return {
    product_id: productId,
    canonical_title: `Placeholder ${productId}`,
    canonical_category: 'external',
    brand: 'Brand A',
    dedupe_group_id: productId,
    variants: [{ variant_id: productId, variant_attributes: {} }],
    offers: [
      {
        offer_id: `offer::external_seed::${productId}`,
        merchant_id: 'external_seed',
        variant_id: productId,
        price: '13.0',
        currency: 'USD',
        availability: { in_stock: true, inventory_quantity: 5 },
        source_type: 'external_seed',
        connector: 'external',
      },
    ],
    provenance: { merchant_id: 'external_seed', merchant_name: 'External', source_type: 'external_seed' },
    ...overrides,
  };
}

function mockUpstream(products) {
  const calls = { count: 0 };
  nock(process.env.PIVOTA_API_BASE)
    .post('/agent/v2/products/search')
    .query(true)
    .times(6)
    .reply(200, () => {
      calls.count += 1;
      return { status: 'success', success: true, total: products.length, metadata: { query_source: 'test_upstream' }, products };
    });
  return calls;
}

const ROWS = () => [v2Row(LEGACY_OPEN), v2Row(LEGACY_SIG, { pivota_signature_id: SIG }), v2Row(LEGACY_DEAD)];

function ids(body) {
  return (body.products || []).map((p) => p.product_id);
}

describe('legacy seed ids on the invoke and REST search doors', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      PIVOTA_API_BASE: 'http://localhost:8080',
      PIVOTA_API_KEY: 'test-token',
      API_MODE: 'REAL',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'false',
    };
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    nock.cleanAll();
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it('direct invoke: the signature row advertises its signature; with no database nothing is dropped', async () => {
    const upstream = mockUpstream(ROWS());
    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation: 'find_products_multi', payload: { search: { query: 'Brand A', page: 1, limit: 10 } } });
    expect(resp.status).toBe(200);
    expect(upstream.count).toBeGreaterThan(0);
    const served = ids(resp.body);
    expect(served).toContain(SIG);
    expect(served).not.toContain(LEGACY_SIG);
    // The probe cannot be asked without a database, so both unsigned legacy rows are kept (fail open).
    expect(served).toEqual(expect.arrayContaining([LEGACY_OPEN, LEGACY_DEAD]));
  });

  it('direct invoke: with the database answering, only the row with no active seed is dropped', async () => {
    process.env.DATABASE_URL = 'postgres://127.0.0.1:1/legacy_seed_stub';
    const realDb = jest.requireActual('../../src/db');
    const probes = [];
    // One statement per page since review GD-2: $1 is the array of ids, one answer row per id (`openable`: the
    // legacy route's own gate passes for some buyer, P2-N1).
    const fakeQuery = async (sql, params) => {
      const text = String(sql || '');
      if (/FROM unnest\(\$1::text\[\]\) AS req\(id\)/.test(text)) {
        const asked = params && Array.isArray(params[0]) ? params[0] : [];
        probes.push(...asked);
        return { rows: asked.map((id) => ({ product_id: id, openable: id === LEGACY_OPEN })) };
      }
      return { rows: [] };
    };
    jest.doMock('../../src/db', () => ({
      ...realDb,
      query: fakeQuery,
      queryWithBudget: (sql, params) => fakeQuery(sql, params),
      withClient: async (fn) => fn({ query: async () => ({ rows: [] }), release() {} }),
    }));
    mockUpstream(ROWS());
    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation: 'find_products_multi', payload: { search: { query: 'Brand A', page: 1, limit: 10 } } });
    expect(resp.status).toBe(200);
    const served = ids(resp.body);
    expect(probes).toEqual(expect.arrayContaining([LEGACY_OPEN, LEGACY_DEAD]));
    expect(served).toContain(LEGACY_OPEN);
    expect(served).toContain(SIG);
    expect(served).not.toContain(LEGACY_DEAD);
    // P3-c: the probe marker is an internal hop marker; a direct caller never sees it.
    expect(resp.headers['x-pivota-legacy-seed-probe']).toBeUndefined();
  });

  // Review GD-2: one statement per page under one total deadline. With a database that never answers, a page
  // of 20 legacy rows waits about the deadline (it used to wait 1.5 s per 4 rows: 7.5 s), and the page is the
  // page a probe that fails at once gives.
  it('direct invoke: a hung database adds at most the deadline, and the page is the fail-open page', async () => {
    const page = Array.from({ length: 20 }, (_, i) => v2Row(`shop-d:${(0xd00 + i).toString(16).padStart(16, '0')}`));
    const run = async (probe) => {
      jest.resetModules();
      process.env.DATABASE_URL = 'postgres://127.0.0.1:1/legacy_seed_stub';
      process.env.SEARCH_LEGACY_SEED_PROBE_DEADLINE_MS = '100';
      const realDb = jest.requireActual('../../src/db');
      let probes = 0;
      const fakeQuery = async (sql) => {
        if (/FROM unnest\(\$1::text\[\]\)/.test(String(sql || ''))) {
          probes += 1;
          return probe();
        }
        return { rows: [] };
      };
      jest.doMock('../../src/db', () => ({
        ...realDb,
        query: fakeQuery,
        queryWithBudget: (sql, params) => fakeQuery(sql, params),
        withClient: async (fn) => fn({ query: async () => ({ rows: [] }), release() {} }),
      }));
      mockUpstream(page);
      const app = require('../../src/server');
      const startedAt = Date.now();
      const resp = await request(app)
        .post('/agent/shop/v1/invoke')
        .send({ operation: 'find_products_multi', payload: { search: { query: 'Brand A', page: 1, limit: 20 } } });
      nock.cleanAll();
      return { resp, elapsed: Date.now() - startedAt, probes };
    };
    const failOpen = await run(async () => { throw new Error('connection refused'); });
    const hung = await run(() => new Promise(() => {}));
    expect(hung.resp.status).toBe(200);
    expect(failOpen.probes).toBe(1);
    expect(hung.probes).toBe(1);
    expect(ids(hung.resp.body)).toEqual(ids(failOpen.resp.body));
    expect(ids(hung.resp.body).length).toBeGreaterThan(0);
    expect(hung.elapsed - failOpen.elapsed).toBeLessThan(100 + 600);
  });

  it('REST GET /agent/v1/products/search: with the database answering, the probe marker does not leave (P3-c)', async () => {
    process.env.DATABASE_URL = 'postgres://127.0.0.1:1/legacy_seed_stub';
    const realDb = jest.requireActual('../../src/db');
    let probes = 0;
    const fakeQuery = async (sql, params) => {
      if (/FROM unnest\(\$1::text\[\]\) AS req\(id\)/.test(String(sql || ''))) {
        probes += 1;
        return { rows: (params[0] || []).map((id) => ({ product_id: id, openable: id === LEGACY_OPEN })) };
      }
      return { rows: [] };
    };
    jest.doMock('../../src/db', () => ({
      ...realDb,
      query: fakeQuery,
      queryWithBudget: (sql, params) => fakeQuery(sql, params),
      withClient: async (fn) => fn({ query: async () => ({ rows: [] }), release() {} }),
    }));
    mockUpstream(ROWS());
    const app = require('../../src/server');
    const resp = await request(app).get('/agent/v1/products/search').query({ query: 'Brand A', limit: 10 });
    expect(resp.status).toBe(200);
    expect(probes).toBe(1);
    expect(ids(resp.body)).not.toContain(LEGACY_DEAD);
    expect(resp.headers['x-pivota-legacy-seed-probe']).toBeUndefined();
  });

  it('REST GET /agent/v1/products/search goes through the same egress', async () => {
    mockUpstream(ROWS());
    const app = require('../../src/server');
    const resp = await request(app).get('/agent/v1/products/search').query({ query: 'Brand A', limit: 10 });
    expect(resp.status).toBe(200);
    const served = ids(resp.body);
    expect(served).toContain(SIG);
    expect(served).not.toContain(LEGACY_SIG);
  });
});
