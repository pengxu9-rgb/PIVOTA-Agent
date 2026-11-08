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
    jest.doMock('../../src/db', () => ({
      ...realDb,
      query: async (sql, params) => {
        const text = String(sql || '');
        if (/EXISTS \(SELECT 1 FROM external_product_seeds WHERE status = 'active'/.test(text)) {
          probes.push(params && params[0]);
          const open = params && params[0] === LEGACY_OPEN;
          return {
            rows: [{
              external_product_id: open, seed_id: false, seed_data_external_product_id: false,
              seed_data_product_id: false, seed_snapshot_product_id: false,
            }],
          };
        }
        return { rows: [] };
      },
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
