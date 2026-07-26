const nock = require('nock');
const request = require('supertest');

jest.setTimeout(60000);

// Dedupe-loser canonical, driven through the real get_pdp_v2 route.
//
// The unit test (tests/pdp_dedupe_keeper_canonical.test.js) pins the shaper.
// THIS suite exists because the shaper is not where this breaks: the keeper sig
// has to survive the trip from the signature resolver to
// applyRequestedPivotaSignatureToPdpProduct, and the obvious wiring — hanging
// it off canonicalProductRef — silently loses it. That ref is rebuilt from a
// field whitelist right after the resolve and reassigned twice more downstream
// (identity-group alias, fetched group). A green unit test and a correct SQL
// column would both still ship a PDP that self-canonicalizes.
//
// Prod context (2026-07-25): 431 tombstoned step-5 dedupe losers render HTTP
// 200, all self-canonical, and 362 of them are the sig the live sitemap
// advertises. The row layer elected a keeper on 2026-07-10
// (suppression_metadata.keeper_product_key, the minted twin, 431/431); the
// render layer never read it.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

// Real prod values for the Merit "The Color Duo" group, which carries FIVE
// tombstoned mirrors against one minted keeper.
const MIRROR_SIG = 'sig_896c979cc15718bbcba72421cc34b067';
const KEEPER_SIG = 'sig_31e1e9fb2325ed7293a6fe71339d0b18';
const SEED_EPID = 'merit:7dde4d5c44aa57ba';
const CONTENT_KEY = 'ck_57491440e9dd53a3e9d526b06afa0283';

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function normalizeSqlWithoutComments(sql) {
  return normalizeSql(
    String(sql || '')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n'),
  );
}

function loadServerWithDb() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://localhost:8080',
    PIVOTA_API_KEY: 'test-token',
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

// get_pdp_v2 fails closed for external_seed refs unless the serving-eligibility
// gate finds a row, so every case here has to answer it.
function isServingEligibilityQuery(normalizedSql) {
  return (
    normalizedSql.includes('FROM catalog_products cp') &&
    normalizedSql.includes('index_pipeline_state') &&
    !normalizedSql.includes('cp.pivota_signature_id = $1')
  );
}

function servingEligibleRow() {
  return {
    content_key: CONTENT_KEY,
    product_key: `prod::external_seed::external_seed::${SEED_EPID}`,
    source_system: 'external_product_seeds_mirror_v1',
    source_product_id: SEED_EPID,
    pivota_signature_id: MIRROR_SIG,
    sync_status: 'live',
    pdp_lifecycle_stage: 'published',
    serving_eligible: true,
    readiness_tier: 'serving',
    pipeline_stage: 'serving',
    content_quality_score: 82,
    catalog_image_urls_count: 1,
    active_external_seed_source_match: true,
  };
}

function tombstonedMirrorRow(overrides = {}) {
  return {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_product_id: SEED_EPID,
    product_key: `prod::external_seed::external_seed::${SEED_EPID}`,
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: MIRROR_SIG,
    content_key: CONTENT_KEY,
    catalog_title: 'The Color Duo',
    catalog_brand: 'Merit',
    signature_serving_eligible: true,
    external_seed_id: 8181,
    external_seed_external_product_id: SEED_EPID,
    external_seed_status: 'active',
    external_seed_route_lane: 0,
    catalog_suppression_reason: 'd2_tier3_judge',
    tombstone_keeper_sig_id: KEEPER_SIG,
    ...overrides,
  };
}

// An external_seed PDP composes its content from external_product_seeds, not
// from the upstream get_product_detail invoke — without this row the route
// answers 404 PRODUCT_NOT_FOUND before it ever reaches the canonical shaping.
function activeSeedRow() {
  return {
    id: 8181,
    external_product_id: SEED_EPID,
    destination_url: 'https://meritbeauty.com/products/the-color-duo',
    canonical_url: 'https://meritbeauty.com/products/the-color-duo',
    domain: 'meritbeauty.com',
    title: 'The Color Duo',
    image_url: 'https://cdn.example.com/color-duo.jpg',
    price_amount: '48.00',
    price_currency: 'USD',
    availability: 'in_stock',
    attached_product_key: null,
    seed_data: {
      title: 'The Color Duo',
      brand: 'Merit',
      image_urls: ['https://cdn.example.com/color-duo.jpg'],
      description: 'A two-in-one cream blush and lip.',
    },
    updated_at: '2026-07-01T00:00:00Z',
    created_at: '2026-06-30T00:00:00Z',
    status: 'active',
  };
}

function upstreamProduct() {
  return {
    product_id: SEED_EPID,
    merchant_id: 'external_seed',
    title: 'The Color Duo',
    brand: 'Merit',
    description: 'A two-in-one cream blush and lip.',
    images: [{ url: 'https://cdn.example.com/color-duo.jpg' }],
    price: { amount: 48, currency: 'USD' },
    destination_url: 'https://meritbeauty.com/products/the-color-duo',
  };
}

async function invokeMirrorPdp({ app, db, signatureRow }) {
  const seen = [];
  db.query.mockImplementation(async (sql) => {
    const normalized = normalizeSql(sql);
    seen.push(String(sql || ''));
    if (normalized.includes('cp.pivota_signature_id = $1')) {
      return { rows: signatureRow ? [signatureRow] : [] };
    }
    if (isServingEligibilityQuery(normalized)) {
      return { rows: [servingEligibleRow()] };
    }
    if (normalized.includes('FROM external_product_seeds') && normalized.includes("status = 'active'")) {
      return { rows: [activeSeedRow()] };
    }
    return { rows: [] };
  });
  nock(process.env.PIVOTA_API_BASE)
    .post('/agent/shop/v1/invoke', (payload) => payload?.operation === 'get_product_detail')
    .times(4)
    .reply(200, { product: upstreamProduct() });

  const res = await request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'get_pdp_v2',
      payload: { product_ref: { product_id: MIRROR_SIG } },
    });
  return { res, seen };
}

function readProduct(res) {
  const canonicalModule = (res.body?.modules || []).find((module) => module.type === 'canonical');
  return canonicalModule?.data?.pdp_payload?.product || {};
}

describe('get_pdp_v2 dedupe-keeper canonical', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('the signature query resolves the keeper sig, guarded three ways', async () => {
    const { app, db } = loadServerWithDb();
    const { seen } = await invokeMirrorPdp({ app, db, signatureRow: tombstonedMirrorRow() });
    const rawSql = seen.find((sql) => normalizeSql(sql).includes('cp.pivota_signature_id = $1'));
    expect(rawSql).toBeTruthy();
    const sql = normalizeSqlWithoutComments(rawSql);

    expect(sql).toContain("keeper_cp.product_key = cp.suppression_metadata->>'keeper_product_key'");
    // Same product, keeper not itself a loser, keeper actually addressable.
    // Dropping any one of these turns a bad keeper pointer into a canonical
    // that advertises the wrong product, another tombstone, or a URL that 500s.
    expect(sql).toContain('keeper_cp.content_key = cp.content_key');
    expect(sql).toContain('keeper_cp.suppression_reason IS NULL');
    expect(sql).toContain('keeper_cp.pivota_signature_id IS NOT NULL');
  });

  test('a tombstoned mirror canonicalizes onto its keeper but keeps its own URL', async () => {
    const { app, db } = loadServerWithDb();
    const { res } = await invokeMirrorPdp({ app, db, signatureRow: tombstonedMirrorRow() });
    expect(res.status).toBe(200);
    const product = readProduct(res);

    expect(product.canonical_url).toBe(`https://agent.pivota.cc/products/${KEEPER_SIG}`);
    expect(product.pivota_canonical_url).toBe(`https://agent.pivota.cc/products/${KEEPER_SIG}`);
    expect(product.canonical_route_basis).toBe('dedupe_keeper');
    expect(product.canonical_route_sig_id).toBe(KEEPER_SIG);

    // The page still answers as itself. Moving `product_id` here would change which
    // variant preselects; moving `url` would desync the sitemap, which still
    // advertises this sig by incumbency.
    expect(product.product_id).toBe(MIRROR_SIG);
    expect(product.url).toBe(`https://agent.pivota.cc/products/${MIRROR_SIG}`);
  });

  test('an untombstoned row is byte-identical to pre-change output', async () => {
    const { app, db } = loadServerWithDb();
    const { res } = await invokeMirrorPdp({
      app,
      db,
      signatureRow: tombstonedMirrorRow({
        catalog_suppression_reason: null,
        tombstone_keeper_sig_id: null,
      }),
    });
    expect(res.status).toBe(200);
    const product = readProduct(res);

    expect(product.canonical_url).toBe(`https://agent.pivota.cc/products/${MIRROR_SIG}`);
    expect(product.url).toBe(`https://agent.pivota.cc/products/${MIRROR_SIG}`);
    expect(product.canonical_route_basis).toBeUndefined();
  });

  test('a tombstone whose keeper did not resolve stays self-canonical', async () => {
    // The keeper LATERAL returns NULL whenever any guard fails (keeper itself
    // tombstoned, sig-less, or on a different content_key). Suppression alone
    // must never be enough to move the canonical somewhere unverified.
    const { app, db } = loadServerWithDb();
    const { res } = await invokeMirrorPdp({
      app,
      db,
      signatureRow: tombstonedMirrorRow({ tombstone_keeper_sig_id: null }),
    });
    expect(res.status).toBe(200);
    const product = readProduct(res);

    expect(product.canonical_url).toBe(`https://agent.pivota.cc/products/${MIRROR_SIG}`);
    expect(product.canonical_route_basis).toBeUndefined();
  });
});
