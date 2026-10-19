const request = require('supertest');
const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');
const { readSignatureSeedNotActive } = require('../../src/services/signatureSeedNotActive');

jest.setTimeout(60000);

// A retired product behind a RE-KEYED sig_ row must 404 with a settled reason.
//
// Prod, 2026-10-18: GET agent.pivota.cc/products/sig_bec7d573… (and sig_d839dd6f…)
// answered 500 to every bingbot crawl. get_pdp_v2 resolved the sig through the
// exact-signature lane onto a `merch_obs_` seller and a `<domain>:<hash>` seed id,
// found no ACTIVE seed, and returned `404 PRODUCT_NOT_FOUND` with `details: null`.
// The ext_ seed-status precheck that names `external_seed_not_active` never ran
// (it is keyed on an `ext_`-shaped id), and a reason-less 404 is
// indistinguishable from a swallowed DB error, so the frontend kept it a 500.
// The exact-signature row already carried the seed's status; this names it.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

// The prod shape: an ADR-009 re-keyed seed id, NOT ext_-prefixed.
const SEED_ID = 'coscorea-com:d26860c6915342c2';
const OBS_MERCHANT = 'merch_obs_5a931cc7ff5382e9';
const SIG_ID = 'sig_bec7d5736761a4cbba05e35d7d9ab4d3';
const CONTENT_KEY = 'ck_rekeyedseed000000000000000001';

function loadServer() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
    // ON, as prod is: the rescue must also come up empty before the 404.
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();
const isCanonicalGroupQuery = (sql) =>
  norm(sql).includes(CANONICAL_ENTITY_GROUP_SQL_TAG) && norm(sql).includes('FROM catalog_products cp');
const isBareSigQuery = (sql) =>
  norm(sql).includes(
    'SELECT merchant_id, platform, source_product_id, product_key FROM catalog_products WHERE pivota_signature_id = $1',
  );
const isExactSigQuery = (sql) => norm(sql).includes('cp.pivota_signature_id = $1');

function exactSigRow(overrides = {}) {
  return {
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_key: `prod::${OBS_MERCHANT}::external_seed::${SEED_ID}`,
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: SIG_ID,
    content_key: CONTENT_KEY,
    catalog_title: 'Retired Cream',
    catalog_brand: 'Probe Labs',
    signature_serving_eligible: true,
    external_seed_id: 'eps_rekeyed_1',
    external_seed_external_product_id: SEED_ID,
    external_seed_status: 'inactive',
    external_seed_route_lane: 0,
    ...overrides,
  };
}

// Every content store misses: no active seed answers the re-keyed id, nothing is
// cached, the identity graph has nothing. Exactly what the prod trace shows.
function install(db, row) {
  db.query.mockImplementation(async (sql) => {
    if (isCanonicalGroupQuery(sql)) return { rows: [] };
    if (isBareSigQuery(sql)) return { rows: [] };
    if (isExactSigQuery(sql)) return { rows: row ? [row] : [] };
    return { rows: [] };
  });
}

async function pdp(app, productRef) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'get_pdp_v2', payload: { product_ref: productRef, include: ['offers'] } });
}

const identityOf = (res) => res.body?.metadata?.identity_resolution || {};

describe('get_pdp_v2: a re-keyed sig_ row whose seed is retired', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('404s with the settled external_seed_not_active reason', async () => {
    const { app, db } = loadServer();
    install(db, exactSigRow());

    const res = await pdp(app, { product_id: SIG_ID });

    expect(res.status).toBe(404);
    expect(res.body?.error).toBe('PRODUCT_NOT_FOUND');
    expect(res.body?.details).toEqual({
      reason: 'external_seed_not_active',
      external_seed_status: 'inactive',
      external_seed_id: 'eps_rekeyed_1',
      external_product_id: SEED_ID,
    });
    // CONTROL: this really is the prod lane, not the ext_ precheck exit.
    expect(identityOf(res)).toEqual(
      expect.objectContaining({
        requested_product_id: SIG_ID,
        resolved_product_id: SEED_ID,
        resolved_merchant_id: OBS_MERCHANT,
        resolution_source: 'catalog_products_signature_exact',
        entry_precheck_missing: true,
      }),
    );
  });

  test('CONTROL: an ACTIVE seed that still fails to build stays reason-less', async () => {
    // The status says nothing is wrong with the product, so the miss may be the
    // read path's fault. No reason is invented; the frontend keeps its 500.
    const { app, db } = loadServer();
    install(db, exactSigRow({ external_seed_status: 'active' }));

    const res = await pdp(app, { product_id: SIG_ID });

    expect(res.status).toBe(404);
    expect(res.body?.details).toBeNull();
  });

  test('CONTROL: a sig row with no seed joined stays reason-less', async () => {
    const { app, db } = loadServer();
    install(
      db,
      exactSigRow({
        external_seed_status: null,
        external_seed_id: null,
        external_seed_external_product_id: null,
        external_seed_route_lane: null,
      }),
    );

    const res = await pdp(app, { product_id: SIG_ID });

    expect(res.status).toBe(404);
    expect(res.body?.details).toBeNull();
  });
});

describe('readSignatureSeedNotActive', () => {
  const ref = (overrides = {}) => ({
    source: 'catalog_products_signature_exact',
    external_seed_status: 'paused',
    external_seed_id: 'eps_1',
    external_seed_external_product_id: SEED_ID,
    ...overrides,
  });
  const ctx = { resolvedMerchantId: OBS_MERCHANT, resolvedProductId: SEED_ID };

  test('names the settled reason for a re-keyed seed-supply row', () => {
    expect(readSignatureSeedNotActive(ref(), ctx)).toEqual({
      reason: 'external_seed_not_active',
      external_seed_status: 'paused',
      external_seed_id: 'eps_1',
      external_product_id: SEED_ID,
    });
  });

  test.each([
    ['an active seed', ref({ external_seed_status: 'active' }), ctx],
    ['no seed status', ref({ external_seed_status: '' }), ctx],
    ['a ref from another resolver lane', ref({ source: 'canonical_catalog_signature' }), ctx],
    ['a seed that is not the resolved id', ref({ external_seed_external_product_id: 'other-com:1' }), ctx],
    ['a connected (non-seed) seller', ref(), { ...ctx, resolvedMerchantId: 'merch_shopify_1' }],
    // The ext_ seed precheck already answers these; its exit stays untouched.
    ['an ext_ id', ref({ external_seed_external_product_id: 'ext_abc' }), { ...ctx, resolvedProductId: 'ext_abc' }],
    ['no ref', null, ctx],
  ])('returns null for %s', (_name, signatureRef, context) => {
    expect(readSignatureSeedNotActive(signatureRef, context)).toBeNull();
  });
});
