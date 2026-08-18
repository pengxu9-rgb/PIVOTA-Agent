const request = require('supertest');

jest.setTimeout(60000);

// ADR-009 — the product-intel route resolves a seed-shaped id WITHOUT a seller.
//
// `resolveProductIntelInvokeContext` used to derive a merchant from the product
// id's prefix. That derived id was not decoration: it was the routing token
// that carried the request into the seed store (whose lookup keys on the
// product id alone), and the 400 guard below the ref construction accepted the
// derivation as if a caller had supplied it. So deleting the derivation on its
// own turned a working 200 into 400 MISSING_PARAMETERS.
//
// The replacement: a seed-shaped id gets a ref with NO merchant_id, the guard
// exempts exactly that shape, and the seller is filled in afterwards from the
// resolved ROW's own column. These tests pin all three, plus the three legacy
// request shapes that must be untouched.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

const SEED_ID = 'ext_seed_routed_seller_less_1';
const OBS_MERCHANT = 'merch_obs_022b65d47a58b87a';

function loadServerWithDb(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    // Unroutable on purpose: every upstream fallback on this path is wrapped in
    // a catch, so a dead base proves the answer came from the seed store.
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
    ...envOverrides,
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

function seedDetailRow() {
  return {
    id: 'eps_seed_routed_seller_less_1',
    external_product_id: SEED_ID,
    status: 'active',
    canonical_url: 'https://example.test/products/seed-routed-probe',
    destination_url: 'https://example.test/products/seed-routed-probe',
    domain: 'example.test',
    title: 'Seed Routed Probe Cream',
    image_url: 'https://cdn.example.test/probe.png',
    price_amount: '58.00',
    price_currency: 'USD',
    availability: 'In Stock',
    seed_data: {
      brand: 'Probe Labs',
      description: 'A cream used only to pin the seed-routed product-intel route.',
      snapshot: {
        canonical_url: 'https://example.test/products/seed-routed-probe',
        image_url: 'https://cdn.example.test/probe.png',
      },
    },
  };
}

// The canonical catalog group query is the only statement on this path that
// takes the requested seller as a bind parameter, so its params are how "did
// this request carry a seller?" is observed end to end.
function isCanonicalGroupQuery(sql) {
  const text = String(sql || '');
  return text.includes('WITH offer_stats AS') && text.includes('FROM catalog_products cp');
}

function isSeedDetailQuery(sql) {
  const text = String(sql || '');
  return text.includes('FROM external_product_seeds') && text.includes('destination_url');
}

function installQueries(db, { seedAnswers = true } = {}) {
  const seen = [];
  db.query.mockImplementation(async (sql, params) => {
    seen.push({ sql: String(sql || ''), params: Array.isArray(params) ? params : [] });
    if (seedAnswers && isSeedDetailQuery(sql)) {
      const requested = Array.isArray(params) ? String(params[0] || '') : '';
      return { rows: requested === SEED_ID ? [seedDetailRow()] : [] };
    }
    return { rows: [] };
  });
  return seen;
}

async function invokeIntel(app, productRef) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'get_product_intel_v1', payload: { product_ref: productRef } });
}

describe('get_product_intel_v1 seed-routed seller-less resolution', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('a seed-shaped id with NO merchant resolves, and its ref names the resolved row’s seller', async () => {
    const { app, db } = loadServerWithDb();
    installQueries(db);

    const res = await invokeIntel(app, { product_id: SEED_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.canonical_product_ref).toEqual(
      expect.objectContaining({ product_id: SEED_ID, merchant_id: 'external_seed' }),
    );
  });

  test('the request carries NO seller into catalog resolution — the id shape derives none', async () => {
    const { app, db } = loadServerWithDb();
    const seen = installQueries(db);

    await invokeIntel(app, { product_id: SEED_ID });

    const groupCalls = seen.filter((call) => isCanonicalGroupQuery(call.sql));
    expect(groupCalls.length).toBeGreaterThan(0);
    for (const call of groupCalls) {
      expect(call.params).toEqual([SEED_ID]);
    }
  });

  // CONTROL for the assertion above: a seller really does reach that query when
  // the CALLER supplies one, so "no seller in the params" is a fact about the
  // request and not about the query never taking one.
  test('a caller-supplied seller DOES reach catalog resolution', async () => {
    const { app, db } = loadServerWithDb();
    const seen = installQueries(db);

    await invokeIntel(app, { merchant_id: OBS_MERCHANT, product_id: SEED_ID });

    const groupCalls = seen.filter((call) => isCanonicalGroupQuery(call.sql));
    expect(groupCalls.length).toBeGreaterThan(0);
    expect(groupCalls.some((call) => call.params.includes(OBS_MERCHANT))).toBe(true);
  });

  test('LEGACY: the shared-bucket seller returns exactly what the seller-less request returns', async () => {
    const legacy = loadServerWithDb();
    installQueries(legacy.db);
    const legacyRes = await invokeIntel(legacy.app, {
      merchant_id: 'external_seed',
      product_id: SEED_ID,
    });

    const sellerLess = loadServerWithDb();
    installQueries(sellerLess.db);
    const sellerLessRes = await invokeIntel(sellerLess.app, { product_id: SEED_ID });

    expect(legacyRes.status).toBe(200);
    expect(sellerLessRes.status).toBe(legacyRes.status);
    expect(sellerLessRes.body.canonical_product_ref).toEqual(legacyRes.body.canonical_product_ref);
  });

  test('LEGACY: an observed seller keeps ITS id on the ref', async () => {
    const { app, db } = loadServerWithDb();
    installQueries(db);

    const res = await invokeIntel(app, { merchant_id: OBS_MERCHANT, product_id: SEED_ID });

    expect(res.status).toBe(200);
    expect(res.body.canonical_product_ref).toEqual(
      expect.objectContaining({ product_id: SEED_ID, merchant_id: OBS_MERCHANT }),
    );
  });

  test('LEGACY: a NON-seed id with no merchant is still 400 MISSING_PARAMETERS', async () => {
    const { app, db } = loadServerWithDb();
    const seen = installQueries(db);

    const res = await invokeIntel(app, { product_id: '9886500749640' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MISSING_PARAMETERS');
    // It fails at the guard, before any detail lookup is attempted.
    expect(seen.some((call) => isSeedDetailQuery(call.sql))).toBe(false);
  });

  test('a seed-shaped id that resolves nothing is 404, NOT the guard’s 400', async () => {
    // This is the exact contract the retired derivation was protecting: an
    // unknown seed id has always been "not found", never "you forgot a
    // parameter". A guard that rejects the seller-less ref reports 400 here.
    const { app, db } = loadServerWithDb();
    installQueries(db, { seedAnswers: false });

    const res = await invokeIntel(app, { product_id: 'ext_nothing_answers_this_1' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PRODUCT_NOT_FOUND');
  });
});
