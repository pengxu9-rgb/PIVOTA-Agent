const request = require('supertest');

jest.setTimeout(60000);

// P3 — Path-C MINTED CANONICALS (source_system='catalog_enrichment_agent_v1').
//
// Measured on prod 2026-07-25: 1,375 of these were trust-`public` and every one
// of their PDPs returned HTTP 500. Root cause was a missing lookup, not missing
// data — 0 of 2,175 minted rows resolve a seed on the route key
// (external_product_seeds.external_product_id = catalog_products
// .source_product_id) because their source_product_id is a canonical NAME SLUG,
// while 2,063 of them DO carry a seed attached by attached_product_key whose
// external_product_id is a `brand:hash`. The gateway only ever tried the route
// key, so the content route never resolved and fetch_canonical_product 404'd.
//
// The fix adds a SECOND arm to the seed LATERAL in
// resolveCatalogProductRefFromPivotaSignatureInner and, when that arm is what
// answered, presents the SEED's external_product_id as the resolved product id
// — which is exactly the shape the mirror lane already has (there
// source_product_id IS the seed id, which is why that lane renders).
//
// Verified end-to-end against the real prod database before merge: 12/12
// sampled minted sigs went 404 -> 200 with real title/brand/image/price, while
// 8 mirror / 4 shopify / 3 url_audit control sigs answered byte-identically.
// This suite is the regression pin for the two properties that made it work.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

const MINTED_SIG = 'sig_dbf96ad0c3adb0cdb9aa649660823ba0';
const MINTED_SLUG = '9wishes-centella-pdrn-calm-ampule';
const MINTED_PRODUCT_KEY = 'ext:9wishes-centella-pdrn-calm-ampule::39ab3948';
const ATTACHED_SEED_EPID = '9wishes:cef37dd6593847ed';

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

// Same, minus the `-- …` comments. The query text really is sent with them —
// they are newline-terminated and harmless to Postgres — but collapsing the SQL
// to one line makes every comment swallow the clause after it, so shape
// assertions have to strip them first.
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

// The row the patched signature query returns for a minted canonical: the seed
// came from LANE 1, so external_seed_external_product_id is the attached seed's
// brand:hash id and NOT the row's own source_product_id.
function mintedSignatureRow() {
  return {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_product_id: MINTED_SLUG,
    product_key: MINTED_PRODUCT_KEY,
    source_system: 'catalog_enrichment_agent_v1',
    pivota_signature_id: MINTED_SIG,
    content_key: 'ck_9914ba952dff8ee59443480b2038e2e9',
    catalog_title: 'Centella PDRN Calm Ampule',
    catalog_brand: '9wishes',
    signature_serving_eligible: true,
    external_seed_id: 4242,
    external_seed_external_product_id: ATTACHED_SEED_EPID,
    external_seed_status: 'active',
    external_seed_route_lane: 1,
  };
}

async function invokeMintedPdp({ app, db, signatureRow }) {
  const seen = [];
  db.query.mockImplementation(async (sql) => {
    seen.push(String(sql || ''));
    if (normalizeSql(sql).includes('cp.pivota_signature_id = $1')) {
      return { rows: signatureRow ? [signatureRow] : [] };
    }
    return { rows: [] };
  });
  const res = await request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'get_pdp_v2',
      payload: {
        product_ref: { product_id: MINTED_SIG },
        include: ['offers'],
      },
    });
  return { res, seen };
}

describe('get_pdp_v2 minted-canonical seed route (P3)', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('the signature seed lookup carries BOTH lanes, ranked lane-first', async () => {
    const { app, db } = loadServerWithDb();
    const { seen } = await invokeMintedPdp({ app, db, signatureRow: mintedSignatureRow() });
    const rawSignatureSql = seen.find((sql) =>
      normalizeSql(sql).includes('cp.pivota_signature_id = $1'),
    );
    expect(rawSignatureSql).toBeTruthy();
    const signatureSql = normalizeSqlWithoutComments(rawSignatureSql);

    // LANE 0 — unchanged route key, still gated on the external_seed platform.
    expect(signatureSql).toContain(
      "WHERE cp.platform = 'external_seed' AND eps.external_product_id = cp.source_product_id",
    );
    // LANE 1 — the minted arm, keyed on attached_product_key like
    // services/catalog_row_trust_upserter.minted_seed_one.
    expect(signatureSql).toContain(
      "WHERE cp.source_system = 'catalog_enrichment_agent_v1' " +
        'AND eps.attached_product_key = cp.product_key',
    );

    // LANE ORDER IS THE SAFETY PROPERTY. Ranking lane before status is what
    // makes this purely additive: whenever lane 0 answers at all, ITS best row
    // wins exactly as before, and lane 1 is reachable only when lane 0 is
    // empty. services/pdpRenderability's seedRouteResolvesSql predicts
    // renderability from the same rule, so if these two ever disagree the
    // sitemap starts advertising URLs the gateway 404s.
    const laneRank = signatureSql.indexOf('ORDER BY seed_pick.seed_route_lane ASC,');
    const statusRank = signatureSql.indexOf("CASE WHEN seed_pick.status = 'active'");
    expect(laneRank).toBeGreaterThan(-1);
    expect(statusRank).toBeGreaterThan(laneRank);
    // Total order, so a minted product_key carrying several equally-fresh
    // seeds (31 on the widest row in prod) renders the same one every time.
    expect(signatureSql).toContain('seed_pick.id DESC');
    // LIMIT 1 inside the LATERAL is what stops a multi-offer product fanning
    // out into duplicate catalog rows.
    expect(signatureSql).toContain('LIMIT 1 ) eps ON true');
  });

  test('a lane-1 minted row resolves onto the attached seed id, not its name slug', async () => {
    const { app, db } = loadServerWithDb();
    const { res } = await invokeMintedPdp({ app, db, signatureRow: mintedSignatureRow() });
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.requested_product_id).toBe(ATTACHED_SEED_EPID);
    expect(identity.resolved_product_id).toBe(ATTACHED_SEED_EPID);
    // The slug answers nothing anywhere; carrying it forward is the 500.
    expect(identity.resolved_product_id).not.toBe(MINTED_SLUG);
    expect(identity.resolution_source).toBe('catalog_products_signature_exact');
  });

  test('a lane-0 row keeps its own source_product_id, byte-identically', async () => {
    // The mirror lane and every other pre-P3 lane must be untouched: the swap
    // is conditioned on external_seed_route_lane === 1 and nothing else.
    const { app, db } = loadServerWithDb();
    const mirrorRow = {
      ...mintedSignatureRow(),
      source_product_id: 'ext_406df819ae18fad866eff5b8',
      source_system: 'external_product_seeds_mirror_v1',
      external_seed_external_product_id: 'ext_406df819ae18fad866eff5b8',
      external_seed_route_lane: 0,
    };
    const { res } = await invokeMintedPdp({ app, db, signatureRow: mirrorRow });
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.resolved_product_id).toBe('ext_406df819ae18fad866eff5b8');
  });

  test('a minted row with NO seed on either lane keeps its slug and does not render', async () => {
    // The 112 prod rows P3 does not rescue. The swap must not invent an id
    // out of a NULL seed — that would send the gateway chasing "null".
    const { app, db } = loadServerWithDb();
    const orphanRow = {
      ...mintedSignatureRow(),
      external_seed_id: null,
      external_seed_external_product_id: null,
      external_seed_status: null,
      external_seed_route_lane: null,
    };
    const { res } = await invokeMintedPdp({ app, db, signatureRow: orphanRow });
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.resolved_product_id).toBe(MINTED_SLUG);
    expect(res.status).toBe(404);
  });
});
