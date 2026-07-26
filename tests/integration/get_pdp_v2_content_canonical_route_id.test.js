const nock = require('nock');
const request = require('supertest');

jest.setTimeout(60000);

// The DELIVERABLE, driven through the real get_pdp_v2 route.
//
// tests/content_canonical_route_id.test.js pins the resolver and the identity
// builder. It does NOT pin the thing the consumer actually reads:
// `modules[canonical].data.content_canonical_route_id`. Deleting that emission
// left all of it green — the field could have shipped resolved, threaded, and
// never published.
//
// That is the same failure mode #1833 wrote its own integration suite for: the
// value has to survive a trip through objects that are rebuilt from field
// whitelists, and a green unit test plus a correct SQL column will both still
// ship a PDP that self-canonicalizes.
//
// Prod context (2026-07-25): 474 content_keys serve identical content under 2-7
// sitemap-eligible sigs, every page self-canonical. pivota-backend migration
// 181 elects one winner per content_key; this field is how the losing sig's PDP
// learns which one, so it can point rel=canonical there instead of at itself.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

// A measured duplicate pair: the mirror sig the sitemap advertises, and the
// minted twin sharing its content_key.
const LOSING_SIG = 'sig_2f057569e49bcc11a33e54dcac6d9dca';
const ELECTED_SIG = 'sig_c1ae6bae3c95e29035cf91b46a81b224';
const SEED_EPID = 'acme:9f10bb27ce4d8812';
const CONTENT_KEY = 'ck_7f02a883e39e2529c8299393cf8e9669';

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
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
// gate finds a row, so every case has to answer it.
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
    pivota_signature_id: LOSING_SIG,
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

// The row the signature query returns. `content_canonical_sig_id` is what the
// cce_valid LATERAL produces — already validated in SQL, so a value here means
// "elected AND still advertisable".
function duplicateMirrorRow(overrides = {}) {
  return {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_product_id: SEED_EPID,
    product_key: `prod::external_seed::external_seed::${SEED_EPID}`,
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: LOSING_SIG,
    content_key: CONTENT_KEY,
    catalog_title: 'Acme Glow Serum',
    catalog_brand: 'Acme',
    signature_serving_eligible: true,
    external_seed_id: 9191,
    external_seed_external_product_id: SEED_EPID,
    external_seed_status: 'active',
    external_seed_route_lane: 0,
    content_canonical_sig_id: ELECTED_SIG,
    ...overrides,
  };
}

function activeSeedRow() {
  return {
    id: 9191,
    external_product_id: SEED_EPID,
    destination_url: 'https://acme.example/products/glow-serum',
    canonical_url: 'https://acme.example/products/glow-serum',
    domain: 'acme.example',
    title: 'Acme Glow Serum',
    image_url: 'https://cdn.example.com/glow-serum.jpg',
    price_amount: '32.00',
    price_currency: 'USD',
    availability: 'in_stock',
    attached_product_key: null,
    seed_data: {
      title: 'Acme Glow Serum',
      brand: 'Acme',
      image_urls: ['https://cdn.example.com/glow-serum.jpg'],
      description: 'A brightening serum.',
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
    title: 'Acme Glow Serum',
    brand: 'Acme',
    description: 'A brightening serum.',
    images: [{ url: 'https://cdn.example.com/glow-serum.jpg' }],
    price: { amount: 32, currency: 'USD' },
    destination_url: 'https://acme.example/products/glow-serum',
  };
}

async function invokePdp({ app, db, signatureRow }) {
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
      payload: { product_ref: { product_id: LOSING_SIG } },
    });
  return { res, seen };
}

function readCanonicalData(res) {
  return (res.body?.modules || []).find((module) => module.type === 'canonical')?.data || {};
}

describe('get_pdp_v2 content_canonical_route_id emission', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('THE DELIVERABLE: the canonical module publishes the elected sig', async () => {
    const { app, db } = loadServerWithDb();
    const { res } = await invokePdp({ app, db, signatureRow: duplicateMirrorRow() });

    expect(res.status).toBe(200);
    expect(readCanonicalData(res).content_canonical_route_id).toBe(ELECTED_SIG);
  });

  test('null when the content_key has no valid election', async () => {
    // Never absent-and-undefined vs null ambiguity, and never the row's own
    // sig: the consumer distinguishes "somebody elected a winner" from "here is
    // a URL", and falls back to a self-referential canonical on null.
    const { app, db } = loadServerWithDb();
    const { res } = await invokePdp({
      app,
      db,
      signatureRow: duplicateMirrorRow({ content_canonical_sig_id: null }),
    });

    expect(res.status).toBe(200);
    expect(readCanonicalData(res).content_canonical_route_id).toBeNull();
  });

  test('the emission does not disturb the sig the PDP actually serves', async () => {
    // Canonicalising elsewhere must not change WHICH row renders or which id
    // the payload claims — #1833 makes the same promise for its keeper, and
    // this is the half that would silently break it.
    const { app, db } = loadServerWithDb();
    const { res } = await invokePdp({ app, db, signatureRow: duplicateMirrorRow() });

    const data = readCanonicalData(res);
    const product = data?.pdp_payload?.product || {};
    expect(data.content_canonical_route_id).toBe(ELECTED_SIG);
    expect(product.pivota_signature_id || product.product_id).toBe(LOSING_SIG);
  });
});
