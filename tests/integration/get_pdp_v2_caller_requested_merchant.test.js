const request = require('supertest');

jest.setTimeout(60000);

// ADR-009 — get_pdp_v2 asks "did the CALLER pin a seller?" against the CALLER's
// value, not the signature-resolved row's.
//
// `requestedMerchantId` is a `let`. The signature block reassigns it with the
// resolved row's own seller, which the A9-4 re-key turned into a `merch_obs_`
// id. Three predicates in the identity-reconstruction region raise
// `PRODUCT_ROUTE_MERCHANT_MISMATCH` from it:
//
//   1. the canonical-catalog-group arm,
//   2. the unscoped product-group arm,
//   3. the external-seed product-id fallback arm,
//
// and on the signature lane all three were comparing the resolved seller
// against a ref derived from that same resolved seller. A `sig_` request that
// named NO merchant came back flagged as a route/merchant mismatch, with the
// true `PIVOTA_SIGNATURE_ID` reason code clobbered on the way out. That reason
// code is not decoration: `shouldSkipSigExternalSeedIdentityGraph` is gated on
// it.
//
// The signature lane reaches those arms through the LAST-RESORT branch of
// resolveCatalogSignatureInner — a bare `SELECT … FROM catalog_products WHERE
// pivota_signature_id = $1` that returns a ref with NO `source` field. That is
// the one signature path that reassigns `requestedMerchantId` without also
// setting `canonicalProductRef`, so every downstream reconstruction arm runs
// with the row's seller in the request's variable. Every fixture below that
// exercises the defect is built on it.
//
// Each defect fixture is paired with a CONTROL in which a caller really did pin
// a different seller, proving `PRODUCT_ROUTE_MERCHANT_MISMATCH` and
// `external_seed_product_id_fallback` can still be produced at all.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

const SEED_ID = 'ext_reqside_probe_1';
const OBS_MERCHANT = 'merch_obs_reqside1';
const OTHER_MERCHANT = 'merch_obs_reqside2';
const SIG_ID = 'sig_reqside00000000000000000001';
const CONTENT_KEY = 'ck_reqside0000000000000000000001';
const SENTINEL = 'external_seed';

function loadServerWithDb(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    // Unroutable on purpose: every upstream leg on this route is wrapped in a
    // catch, so a dead base proves the answer came from the mocked DB.
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
    // ON, as prod is. With it off maybeBuildLiveSyntheticPdp returns at its
    // first line, so every assertion about what the identity graph CONTRIBUTES
    // would pass vacuously while only the skip bookkeeping was really tested.
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
    ...envOverrides,
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

// The identity graph RE-ANCHORS `identity_resolution.resolution_source` to
// `identity_graph_live` whenever it produces a synthetic product, which erases
// the signal that says WHICH reconstruction arm ran. The three mismatch arms
// are upstream of the graph and independent of it, so the arm tests disable it
// to keep that observable sharp. Everything that is ABOUT the graph uses the
// default (on, as prod is) and asserts metadata.identity_graph directly.
const loadServerWithoutIdentityGraph = () =>
  loadServerWithDb({ PDP_IDENTITY_GRAPH_ENABLED: 'false' });

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

// ORDER MATTERS in the dispatcher below. resolveCanonicalCatalogEntityGroup
// builds its target clause as `(cp.source_product_id = $1 OR cp.product_key =
// $1 OR cp.pivota_signature_id = $1)`, so it ALSO contains the exact-signature
// query's fingerprint. Matching the exact-signature probe first swallows every
// canonical-group call and silently makes the group fixtures no-ops (this cost
// one debugging round when the group arms appeared unreachable).
const isCanonicalGroupQuery = (sql) =>
  norm(sql).includes('WITH offer_stats AS') && norm(sql).includes('FROM catalog_products cp');
const isBareSigQuery = (sql) =>
  norm(sql).includes(
    'SELECT merchant_id, platform, source_product_id, product_key FROM catalog_products WHERE pivota_signature_id = $1',
  );
const isExactSigQuery = (sql) => norm(sql).includes('cp.pivota_signature_id = $1');
const isQuarantineQuery = (sql) => norm(sql).includes('surviving_members AS');
const isSeedDetailQuery = (sql) =>
  String(sql || '').includes('FROM external_product_seeds') &&
  String(sql || '').includes('destination_url');
const isEligibilityQuery = (sql) => norm(sql).includes('ips.serving_eligible');

function seedDetailRow() {
  return {
    id: 'eps_reqside_1',
    external_product_id: SEED_ID,
    status: 'active',
    canonical_url: 'https://example.test/products/probe',
    destination_url: 'https://example.test/products/probe',
    domain: 'example.test',
    title: 'Reqside Probe Cream',
    image_url: 'https://cdn.example.test/probe.png',
    price_amount: '58.00',
    price_currency: 'USD',
    availability: 'In Stock',
    seed_data: { brand: 'Probe Labs', description: 'probe' },
  };
}

// The LAST-RESORT signature row: four columns, no `source`, so get_pdp_v2
// reassigns requestedMerchantId + productId from it and leaves
// canonicalProductRef null.
function bareSigRow() {
  return {
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_key: `prod::${OBS_MERCHANT}::external_seed::${SEED_ID}`,
  };
}

// The last-resort sig row resolving onto a row whose merchant_id IS the retired
// sentinel. This is the ONLY shape for which
// shouldSkipSigExternalSeedIdentityGraph's `(!requestedMerchantId || … ===
// sentinel)` conjunct can be true, so it is the only shape in which the OTHER
// conjuncts are observable at all. bareSigRow()'s merch_obs_ seller holds that
// conjunct false and masks everything behind it.
function sentinelBareSigRow() {
  return {
    merchant_id: SENTINEL,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_key: `prod::${SENTINEL}::external_seed::${SEED_ID}`,
  };
}

const isCatalogIdentityQuery = (sql) =>
  norm(sql).includes('LEFT JOIN pdp_identity_listing pil') &&
  norm(sql).includes('cp.category_label_source');

// catalogIdentity?.pivota_signature_id is the sig skip's last conjunct. Without
// it the skip cannot fire at all and every test below would pass vacuously.
function catalogIdentityRow() {
  return {
    merchant_id: SENTINEL,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_key: `prod::${SENTINEL}::external_seed::${SEED_ID}`,
    pivota_signature_id: SIG_ID,
    category: 'beauty',
    product_type: 'Cream',
    category_path: null,
    category_label_source: null,
    category_confidence: null,
    catalog_rating_value: null,
    catalog_rating_count: null,
    sellable_item_group_id: SIG_ID,
    product_line_id: null,
    review_family_id: null,
    identity_confidence: 0.9,
    match_basis: [],
    identity_status: 'approved',
    live_read_enabled: true,
    review_required: false,
  };
}

function installWithCatalogIdentity(db, opts = {}) {
  const seen = install(db, opts);
  const base = db.query.getMockImplementation();
  db.query.mockImplementation(async (sql, params) => {
    if (isCatalogIdentityQuery(sql)) return { rows: [catalogIdentityRow()] };
    return base(sql, params);
  });
  return seen;
}

function groupRow(merchantId) {
  return {
    product_key: `prod::${merchantId}::external_seed::${SEED_ID}`,
    merchant_id: merchantId,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_title: 'Reqside Probe Cream',
    product_description: 'probe',
    brand: 'Probe Labs',
    category: 'beauty',
    product_type: 'Cream',
    category_path: null,
    canonical_url: 'https://example.test/products/probe',
    product_image_url: 'https://cdn.example.test/probe.png',
    product_payload: { title: 'Reqside Probe Cream', brand: 'Probe Labs' },
    pdp_lifecycle_stage: 'published',
    pivota_signature_id: SIG_ID,
    pivota_canonical_url: null,
    pivota_signature_minted_at: '2026-08-01T00:00:00Z',
    content_key: CONTENT_KEY,
    updated_at: '2026-08-01T00:00:00Z',
    merchant_name: 'Probe Labs',
    internal_product_group_id: 'pg_reqside0000000000000000000001',
    is_primary: true,
    offer_count: 1,
  };
}

function eligibleRow() {
  return {
    content_key: CONTENT_KEY,
    product_key: `prod::${OBS_MERCHANT}::external_seed::${SEED_ID}`,
    source_system: 'external_product_seeds_mirror_v1',
    source_product_id: SEED_ID,
    pivota_signature_id: SIG_ID,
    catalog_title: 'Reqside Probe Cream',
    catalog_image_url: 'https://cdn.example.test/probe.png',
    catalog_description: 'probe',
    external_seed_product_family: null,
    catalog_image_urls_count: 1,
    sync_status: 'synced',
    pdp_lifecycle_stage: 'published',
    serving_eligible: true,
    readiness_tier: 'serving',
    pipeline_stage: 'serving',
    blocker_code: null,
    blocker_detail: null,
    content_quality_score: 90,
    active_external_seed_source_match: true,
  };
}

function install(db, opts = {}) {
  const {
    bareSig = null,
    // Answers the canonical-group query only when it carries a merchant bind
    // (3 params) — i.e. the SCOPED call get_pdp_v2 makes with the request's
    // seller.
    scopedGroup = null,
    // Answers the unscoped (1 param) canonical-group call, and only for the
    // given product id, so the signature resolver's own unscoped lookup on the
    // `sig_` id is not accidentally answered too.
    unscopedGroup = null,
    unscopedGroupForProductId = SEED_ID,
    seedDetail = true,
    eligible = true,
    seedStatus = null,
  } = opts;
  const seen = [];
  db.query.mockImplementation(async (sql, params) => {
    const p = Array.isArray(params) ? params : [];
    seen.push({ sql: norm(sql).slice(0, 90), params: p });
    if (isCanonicalGroupQuery(sql)) {
      if (p.length >= 3) return { rows: scopedGroup ? [scopedGroup] : [] };
      if (unscopedGroup && String(p[0] || '') === unscopedGroupForProductId) {
        return { rows: [unscopedGroup] };
      }
      return { rows: [] };
    }
    if (isQuarantineQuery(sql)) {
      // Nothing is quarantined in these fixtures; an empty survivor list would
      // mean "every member is quarantined" and would empty the group.
      const requested = JSON.parse(String(p[0] || '[]'));
      return {
        rows: [
          {
            members: requested.map((m) => ({
              merchant_id: m.merchant_id,
              product_id: m.product_id,
            })),
          },
        ],
      };
    }
    if (isBareSigQuery(sql)) return { rows: bareSig ? [bareSig] : [] };
    if (isExactSigQuery(sql)) return { rows: [] };
    if (isEligibilityQuery(sql)) return { rows: eligible ? [eligibleRow()] : [] };
    if (isSeedDetailQuery(sql)) {
      return { rows: seedDetail && String(p[0] || '') === SEED_ID ? [seedDetailRow()] : [] };
    }
    if (seedStatus && norm(sql).includes('SELECT id, external_product_id, status')) {
      return { rows: [{ id: 7, external_product_id: SEED_ID, status: seedStatus }] };
    }
    return { rows: [] };
  });
  return seen;
}

async function pdp(app, productRef) {
  return request(app)
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'get_pdp_v2', payload: { product_ref: productRef, include: ['offers'] } });
}

const identityOf = (res) => res.body?.metadata?.identity_resolution || {};
const routeHealthOf = (res) => res.body?.metadata?.route_health || {};

describe('get_pdp_v2 request-side merchant is the CALLER’s, not the resolved row’s', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('the external-seed product-id fallback arm', () => {
    test('a sig_ request that named no seller is not reported as a merchant mismatch', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { bareSig: bareSigRow() });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(200);
      const identity = identityOf(res);
      // The caller sent no merchant, so nothing can have mismatched.
      expect(identity.requested_merchant_id).toBeNull();
      expect(identity.canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      expect(identity.resolution_source).toBe('external_seed_product_id');
      // The signature DID canonicalize the id, so the flag itself stays true —
      // only its REASON was wrong.
      expect(identity.canonicalization_applied).toBe(true);
      expect(identity.resolved_product_id).toBe(SEED_ID);
    });

    test('CONTROL: a caller that really did pin another seller still gets the mismatch', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db);

      const res = await pdp(app, { merchant_id: OTHER_MERCHANT, product_id: SEED_ID });

      expect(res.status).toBe(200);
      const identity = identityOf(res);
      expect(identity.requested_merchant_id).toBe(OTHER_MERCHANT);
      expect(identity.canonicalization_reason_code).toBe('PRODUCT_ROUTE_MERCHANT_MISMATCH');
      expect(identity.resolution_source).toBe('external_seed_product_id_fallback');
    });

    test('CONTROL: a legacy client sending the retired sentinel is NOT a mismatch', async () => {
      // The sentinel arm of this predicate is deliberately kept: addressing the
      // seed lane by its retired name is not pinning a real seller. Delete that
      // arm and this flips to `..._fallback` + MISMATCH.
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db);

      const res = await pdp(app, { merchant_id: SENTINEL, product_id: SEED_ID });

      expect(res.status).toBe(200);
      const identity = identityOf(res);
      expect(identity.requested_merchant_id).toBe(SENTINEL);
      expect(identity.canonicalization_reason_code).toBeNull();
      expect(identity.canonicalization_applied).toBe(false);
      expect(identity.resolution_source).toBe('external_seed_product_id');
    });
  });

  describe('the canonical-catalog-group arm', () => {
    test('a sig_ request whose group elects another seller keeps the signature reason', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { bareSig: bareSigRow(), scopedGroup: groupRow(OTHER_MERCHANT) });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(200);
      const identity = identityOf(res);
      expect(identity.requested_merchant_id).toBeNull();
      expect(identity.resolution_source).toBe('canonical_catalog_product_group');
      // The elected seller really is a different one from the row the signature
      // resolved to — the point is that the CALLER did not ask for either.
      expect(identity.resolved_merchant_id).toBe(OTHER_MERCHANT);
      expect(identity.canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
    });

    test('CONTROL: a caller-pinned seller re-elected by the group still mismatches', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { scopedGroup: groupRow(OBS_MERCHANT) });

      const res = await pdp(app, { merchant_id: OTHER_MERCHANT, product_id: SEED_ID });

      expect(res.status).toBe(200);
      const identity = identityOf(res);
      expect(identity.resolution_source).toBe('canonical_catalog_product_group');
      expect(identity.resolved_merchant_id).toBe(OBS_MERCHANT);
      expect(identity.canonicalization_reason_code).toBe('PRODUCT_ROUTE_MERCHANT_MISMATCH');
    });
  });

  describe('the unscoped product-group arm', () => {
    test('a sig_ request resolved unscoped keeps the signature reason', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      // seedDetail:false makes the entry precheck MISS, which is what opens the
      // unscoped resolve for a request that carries a seller.
      install(db, {
        bareSig: bareSigRow(),
        unscopedGroup: groupRow(OTHER_MERCHANT),
        seedDetail: false,
      });

      const res = await pdp(app, { product_id: SIG_ID });

      const identity = identityOf(res);
      expect(identity.requested_merchant_id).toBeNull();
      expect(identity.resolution_source).toBe('product_group_unscoped');
      expect(identity.resolved_merchant_id).toBe(OTHER_MERCHANT);
      expect(identity.canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
    });

    test('CONTROL: a caller-pinned seller resolved unscoped still mismatches', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { unscopedGroup: groupRow(OBS_MERCHANT), seedDetail: false });

      const res = await pdp(app, { merchant_id: OTHER_MERCHANT, product_id: SEED_ID });

      const identity = identityOf(res);
      expect(identity.resolution_source).toBe('product_group_unscoped');
      expect(identity.canonicalization_reason_code).toBe('PRODUCT_ROUTE_MERCHANT_MISMATCH');
    });
  });

  describe('the identity-graph skip stays OFF for signature seed PDPs', () => {
    // Deliberate keep, pinned here because the reason-code fix above removes
    // one of the two things that were holding the skip closed on this lane.
    // `shouldSkipSigExternalSeedIdentityGraph` requires BOTH
    // canonicalizationReasonCode === 'PIVOTA_SIGNATURE_ID' (which the fix now
    // preserves) AND a seller-less/sentinel `requestedMerchantId` (which stays
    // the RESOLVED merch_obs_ seller). If someone later moves that second arm
    // onto the caller binding too, this test fails — which is the intent:
    // pdpIdentityGraph's catalog-entity-group branch exists FOR merch_obs_ rows
    // and contributes product_group_id, offer counts, offer_source
    // `group_fused` and electronics_meta, so skipping it there is an OUTPUT
    // change on the main PDP route, not a latency one.
    test('a merch_obs_ seed sig PDP: held by the request-side merchant conjunct', async () => {
      // This fixture is held open by `(!requestedMerchantId || … === sentinel)`
      // — the resolved seller is a merch_obs_ id, so that conjunct is false and
      // NOTHING behind it is observable here. Kept because it pins the
      // documented KEEP (that conjunct still reads the resolved seller), but it
      // says nothing about the reason-code conjunct; the tests below do that.
      const { app, db } = loadServerWithDb();
      install(db, { bareSig: bareSigRow(), scopedGroup: groupRow(OBS_MERCHANT) });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(identityOf(res).canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      expect(routeHealthOf(res).identity_graph_live_mode).toBe(
        'executed_without_line_member_hydration',
      );
      // Not just "the skip did not fire" — the graph actually produced the
      // block. This is what re-enabling the skip would delete.
      expect(res.body?.metadata?.identity_graph).toEqual(
        expect.objectContaining({ canonical_scope: 'synthetic' }),
      );
    });

    // ---------------------------------------------------------------------
    // The reason code is BOTH an attribution string and a conjunct of this
    // skip. Preserving the attribution (which this PR does, deliberately) hands
    // the skip a conjunct main was holding false by clobbering — so the gate
    // now has its own symbol, canonicalizationGroupElectionApplied.
    //
    // These fixtures use a sentinel-merchant sig row on purpose: it is the only
    // shape where the request-side merchant conjunct is TRUE, hence the only
    // shape where the reason-code conjunct is observable.
    // ---------------------------------------------------------------------
    test('a sentinel-merchant seed sig PDP whose group re-elects still gets its graph', async () => {
      const { app, db } = loadServerWithDb();
      installWithCatalogIdentity(db, {
        bareSig: sentinelBareSigRow(),
        scopedGroup: groupRow(OTHER_MERCHANT),
      });

      const res = await pdp(app, { product_id: SIG_ID });

      // The attribution is preserved — that is the PR's goal...
      expect(identityOf(res).canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      // ...and it must NOT have opened the skip.
      expect(routeHealthOf(res).identity_graph_live_mode).toBe(
        'executed_without_line_member_hydration',
      );
      expect(res.body?.metadata?.identity_graph).toEqual(
        expect.objectContaining({ canonical_scope: 'synthetic' }),
      );
    });

    test('the same via the unscoped group arm', async () => {
      const { app, db } = loadServerWithDb();
      installWithCatalogIdentity(db, {
        bareSig: sentinelBareSigRow(),
        unscopedGroup: groupRow(OTHER_MERCHANT),
        seedDetail: false,
      });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(identityOf(res).canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      expect(res.body?.metadata?.identity_graph).toEqual(
        expect.objectContaining({ canonical_scope: 'synthetic' }),
      );
    });

    test('CONTROL: with NO group election the skip still fires, exactly as on main', async () => {
      // Without this the two tests above could pass by nailing the skip shut.
      // Nothing re-elected the ref here, so the skip is correct and fires —
      // byte-identical to main.
      const { app, db } = loadServerWithDb();
      installWithCatalogIdentity(db, { bareSig: sentinelBareSigRow() });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(identityOf(res).canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      expect(routeHealthOf(res).identity_graph_live_mode).toBe(
        'skipped_sig_external_seed_catalog_identity',
      );
      expect(res.body?.metadata?.identity_graph).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // The sentinel exemption, and the two lanes it separates.
  //
  // All three mismatch arms read ONE normalisation (callerPinnedMerchantId).
  // Two of them used to test truthiness alone, so they disagreed with the third
  // about `{merchant_id:'external_seed', …}` — a shape
  // scripts/audit-pdp-entity-truth.cjs still sends.
  // ---------------------------------------------------------------------------
  describe('a caller addressing the seed lane by its retired name is not a mismatch', () => {
    test('SIGNATURE lane, canonical-catalog-group arm: reason code survives', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      // The group elects the SAME seller the signature resolved to. Without the
      // exemption the arm compares 'external_seed' to that seller and fires.
      install(db, { bareSig: bareSigRow(), scopedGroup: groupRow(OBS_MERCHANT) });

      const res = await pdp(app, { merchant_id: SENTINEL, product_id: SIG_ID });

      const identity = identityOf(res);
      expect(identity.requested_merchant_id).toBe(SENTINEL);
      expect(identity.canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      expect(identity.resolution_source).toBe('canonical_catalog_product_group');
    });

    test('SIGNATURE lane, unscoped product-group arm: reason code survives', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, {
        bareSig: bareSigRow(),
        unscopedGroup: groupRow(OBS_MERCHANT),
        seedDetail: false,
      });

      const res = await pdp(app, { merchant_id: SENTINEL, product_id: SIG_ID });

      const identity = identityOf(res);
      expect(identity.requested_merchant_id).toBe(SENTINEL);
      expect(identity.canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      expect(identity.resolution_source).toBe('product_group_unscoped');
    });

    // THE DIRECT LANE IS NOT TOUCHED, and that is a decision, not an omission.
    //
    // A sentinel caller whose group elects a real seller HAS had its identity
    // moved, and the client is told so. Exempting the sentinel in these two
    // arms — the tidy-looking "make all three obey one rule" edit — was tried
    // and reverted: it flips this lane to canonicalization_applied=false,
    // which frees `!canonicalizationApplied` in
    // shouldSkipDirectExternalSeedIdentityGraph, and MEASURED consequence, the
    // skip then fires and metadata.identity_graph disappears from the
    // response. get_pdp_v2_stability's unscoped external_seed case pins the
    // mismatch these two tests pin.
    //
    // The third arm is genuinely different and keeps its sentinel exemption:
    // its ref is the seed ref itself, so nothing moves and there is nothing to
    // report.
    test('DIRECT lane: a sentinel caller whose group elects a real seller still mismatches', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { scopedGroup: groupRow(OBS_MERCHANT) });

      const res = await pdp(app, { merchant_id: SENTINEL, product_id: SEED_ID });

      const identity = identityOf(res);
      expect(identity.requested_merchant_id).toBe(SENTINEL);
      expect(identity.resolved_merchant_id).toBe(OBS_MERCHANT);
      expect(identity.canonicalization_applied).toBe(true);
      expect(identity.canonicalization_reason_code).toBe('PRODUCT_ROUTE_MERCHANT_MISMATCH');
    });

    test('DIRECT lane: and the identity graph keeps running there', async () => {
      // The companion to the test above: canonicalization_applied staying true
      // is what keeps shouldSkipDirectExternalSeedIdentityGraph shut on this
      // lane. Pinned so the "harmonise the arms" edit cannot come back without
      // this failing.
      const { app, db } = loadServerWithDb();
      install(db, { scopedGroup: groupRow(OBS_MERCHANT) });

      const res = await pdp(app, { merchant_id: SENTINEL, product_id: SEED_ID });

      expect(routeHealthOf(res).identity_graph_live_mode).toBe(
        'executed_without_line_member_hydration',
      );
      expect(res.body?.metadata?.identity_graph).toEqual(
        expect.objectContaining({ canonical_scope: 'synthetic' }),
      );
    });

    test('CONTROL: a REAL pinned seller mismatches on the same fixture', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { scopedGroup: groupRow(OBS_MERCHANT) });

      const res = await pdp(app, { merchant_id: OTHER_MERCHANT, product_id: SEED_ID });

      const identity = identityOf(res);
      expect(identity.canonicalization_applied).toBe(true);
      expect(identity.canonicalization_reason_code).toBe('PRODUCT_ROUTE_MERCHANT_MISMATCH');
    });

    test('CONTROL: the direct skip still fires when nothing was remapped', async () => {
      // Proves the pin above did not simply nail the skip shut: a seller-less
      // request with no group still skips, exactly as on main.
      const { app, db } = loadServerWithDb();
      install(db);

      const res = await pdp(app, { product_id: SEED_ID });

      expect(routeHealthOf(res).identity_graph_live_mode).toBe(
        'skipped_direct_external_seed_no_group',
      );
    });
  });

  describe('the seed-lane routing token on the entry precheck', () => {
    test('a seller-less seed request still prechecks, and skips the upstream group resolve', async () => {
      // precheckMerchantId's sentinel default is a KEEP, and it is OBSERVABLE:
      // without it shouldPrecheckMerchantScoped goes false for this shape, the
      // entry precheck never runs, precheckedMerchantProduct stays null and the
      // request falls through to the upstream group resolve that
      // PDP_EXTERNAL_SEED_UPSTREAM_GROUP_RESOLVE_ENABLED exists to avoid.
      const { app, db } = loadServerWithoutIdentityGraph();
      const seen = install(db);

      const res = await pdp(app, { product_id: SEED_ID });

      expect(res.status).toBe(200);
      expect(identityOf(res).entry_precheck_missing).toBe(false);
      expect(routeHealthOf(res).product_group_resolve_mode).toBe(
        'skipped_external_seed_upstream_disabled',
      );
      // CONTROL: the precheck really did reach the seed store.
      expect(seen.some((q) => q.sql.includes('destination_url'))).toBe(true);
    });
  });

  describe('error bodies report the request at one grain', () => {
    test('a PRODUCT_NOT_FOUND on the signature lane names the requested sig id', async () => {
      // The merchant axis was moved to the frozen value while the product axis
      // still read `entryProductId` — post-resolution on this lane. The body
      // then said requested == resolved while canonicalization_applied was
      // true, which is self-contradictory.
      const { app, db } = loadServerWithoutIdentityGraph();
      // eligible stays TRUE: the serving-eligibility 404 is a DIFFERENT exit
      // that already used the diagnostics expression, so routing through it
      // proved nothing (checked — the mutant survived that fixture).
      install(db, { bareSig: bareSigRow(), seedDetail: false });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(404);
      expect(res.body?.error).toBe('PRODUCT_NOT_FOUND');
      const identity = identityOf(res);
      expect(identity.requested_product_id).toBe(SIG_ID);
      expect(identity.requested_merchant_id).toBeNull();
      // CONTROL: the resolved axis really did move, so requested != resolved is
      // meaningful rather than both being blank.
      expect(identity.resolved_product_id).toBe(SEED_ID);
      expect(identity.canonicalization_applied).toBe(true);
    });
  });

  describe('the seed-status precheck 404 reports the request', () => {
    test('it names the requested sig id, not the resolved seed id', async () => {
      // The fourth error exit. Its merchant axis moved to the frozen value
      // while its product axis still read `entryProductId` — which on this lane
      // is the RESOLVED seed id, so the body claimed requested == resolved.
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { bareSig: sentinelBareSigRow(), seedStatus: 'paused' });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(404);
      expect(res.body?.details?.reason).toBe('external_seed_not_active');
      const identity = identityOf(res);
      expect(identity.requested_product_id).toBe(SIG_ID);
      // CONTROL: the seed id really is what the route resolved to, so requested
      // != resolved is meaningful rather than one of them being blank.
      expect(res.body?.details?.external_product_id).toBe(SEED_ID);
    });
  });

  describe('the entry-precheck-miss log can explain its own miss', () => {
    test('it reports the seller the precheck actually used', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { bareSig: bareSigRow(), seedDetail: false });
      const logger = require('../../src/logger');
      const infoSpy = jest.spyOn(logger, 'info');

      try {
        await pdp(app, { product_id: SIG_ID });

        const miss = infoSpy.mock.calls.find(
          (call) =>
            call[1] === 'get_pdp_v2 entry precheck miss; continuing with canonical/group resolution',
        );
        expect(miss).toBeTruthy();
        // The caller sent no seller...
        expect(miss[0].requested_merchant_id).toBeNull();
        // ...but the lookup that missed was scoped to the resolved one. Without
        // this field the line reports a null seller for a non-null lookup.
        expect(miss[0].precheck_merchant_id).toBe(OBS_MERCHANT);
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe('the completion log reports the request, not the resolved row', () => {
    test('a sig_ PDP logs the requested sig id and a null merchant', async () => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db, { bareSig: bareSigRow() });
      const logger = require('../../src/logger');
      const infoSpy = jest.spyOn(logger, 'info');

      try {
        const res = await pdp(app, { product_id: SIG_ID });
        expect(res.status).toBe(200);

        const completion = infoSpy.mock.calls.find((call) => call[1] === 'get_pdp_v2 completed');
        expect(completion).toBeTruthy();
        const fields = completion[0];
        // The requested/resolved PAIR is the point of this line. Reading the
        // post-resolution values into both columns made every signature PDP
        // look like no canonicalization had happened.
        expect(fields.requested_product_id).toBe(SIG_ID);
        expect(fields.requested_merchant_id).toBeNull();
        // CONTROL for the two assertions above: the resolved columns do carry
        // the row's own identity, so a blanket null/absent expectation could
        // not have passed by accident.
        expect(fields.resolved_product_id).toBe(SEED_ID);
        expect(fields.resolved_merchant_id).toBe(SENTINEL);
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe('the four legacy request shapes are untouched', () => {
    const shapes = [
      [
        'a legacy client still sending the retired sentinel',
        { merchant_id: SENTINEL, product_id: SEED_ID },
        {
          requested_merchant_id: SENTINEL,
          resolved_merchant_id: SENTINEL,
          canonicalization_applied: false,
          canonicalization_reason_code: null,
          resolution_source: 'external_seed_product_id',
        },
      ],
      [
        'an observed-seller request',
        { merchant_id: OBS_MERCHANT, product_id: SEED_ID },
        {
          requested_merchant_id: OBS_MERCHANT,
          resolved_merchant_id: SENTINEL,
          canonicalization_applied: true,
          canonicalization_reason_code: 'PRODUCT_ROUTE_MERCHANT_MISMATCH',
          resolution_source: 'external_seed_product_id_fallback',
        },
      ],
      [
        'a seller-less seed request',
        { product_id: SEED_ID },
        {
          requested_merchant_id: null,
          resolved_merchant_id: SENTINEL,
          canonicalization_applied: false,
          canonicalization_reason_code: null,
          resolution_source: 'external_seed_product_id',
        },
      ],
    ];

    test.each(shapes)('%s', async (_name, productRef, expected) => {
      const { app, db } = loadServerWithoutIdentityGraph();
      install(db);
      const res = await pdp(app, productRef);
      expect(res.status).toBe(200);
      expect(identityOf(res)).toEqual(expect.objectContaining(expected));
    });

    test('a sig_ id that resolves through the exact-signature lane', async () => {
      // The ordinary signature lane: `source` is set, so canonicalProductRef is
      // built inside the signature block and none of the reconstruction arms
      // above run at all.
      const { app, db } = loadServerWithoutIdentityGraph();
      const seen = install(db);
      db.query.mockImplementation(async (sql, params) => {
        const p = Array.isArray(params) ? params : [];
        seen.push({ sql: norm(sql).slice(0, 90), params: p });
        if (isCanonicalGroupQuery(sql)) return { rows: [] };
        if (isBareSigQuery(sql)) return { rows: [] };
        if (isExactSigQuery(sql)) {
          return {
            rows: [
              {
                merchant_id: OBS_MERCHANT,
                platform: 'external_seed',
                source_product_id: SEED_ID,
                product_key: `prod::${OBS_MERCHANT}::external_seed::${SEED_ID}`,
                source_system: 'external_product_seeds_mirror_v1',
                pivota_signature_id: SIG_ID,
                content_key: CONTENT_KEY,
                catalog_title: 'Reqside Probe Cream',
                catalog_brand: 'Probe Labs',
                signature_serving_eligible: true,
                external_seed_id: 1,
                external_seed_external_product_id: SEED_ID,
                external_seed_status: 'active',
                external_seed_route_lane: 0,
              },
            ],
          };
        }
        if (isEligibilityQuery(sql)) return { rows: [eligibleRow()] };
        if (isSeedDetailQuery(sql)) {
          return { rows: String(p[0] || '') === SEED_ID ? [seedDetailRow()] : [] };
        }
        return { rows: [] };
      });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(res.status).toBe(200);
      expect(identityOf(res)).toEqual(
        expect.objectContaining({
          requested_product_id: SIG_ID,
          requested_merchant_id: null,
          resolved_product_id: SEED_ID,
          resolved_merchant_id: OBS_MERCHANT,
          canonicalization_applied: true,
          canonicalization_reason_code: 'PIVOTA_SIGNATURE_ID',
          resolution_source: 'catalog_products_signature_exact',
        }),
      );
    });
  });
});
