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
    ...envOverrides,
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

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
      const { app, db } = loadServerWithDb();
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
      const { app, db } = loadServerWithDb();
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
      const { app, db } = loadServerWithDb();
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
    test('a sig_ request whose group elects another seller is not a merchant mismatch', async () => {
      const { app, db } = loadServerWithDb();
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
      const { app, db } = loadServerWithDb();
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
    test('a sig_ request resolved unscoped is not a merchant mismatch', async () => {
      const { app, db } = loadServerWithDb();
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
      const { app, db } = loadServerWithDb();
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
    test('the graph still runs on the signature lane', async () => {
      const { app, db } = loadServerWithDb();
      install(db, { bareSig: bareSigRow() });

      const res = await pdp(app, { product_id: SIG_ID });

      expect(identityOf(res).canonicalization_reason_code).toBe('PIVOTA_SIGNATURE_ID');
      expect(routeHealthOf(res).identity_graph_live_mode).toBe(
        'executed_without_line_member_hydration',
      );
    });
  });

  describe('the completion log reports the request, not the resolved row', () => {
    test('a sig_ PDP logs the requested sig id and a null merchant', async () => {
      const { app, db } = loadServerWithDb();
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
      const { app, db } = loadServerWithDb();
      install(db);
      const res = await pdp(app, productRef);
      expect(res.status).toBe(200);
      expect(identityOf(res)).toEqual(expect.objectContaining(expected));
    });

    test('a sig_ id that resolves through the exact-signature lane', async () => {
      // The ordinary signature lane: `source` is set, so canonicalProductRef is
      // built inside the signature block and none of the reconstruction arms
      // above run at all.
      const { app, db } = loadServerWithDb();
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
