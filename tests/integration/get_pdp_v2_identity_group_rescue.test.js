/**
 * The PDP must serve the group the CATALOG converged, not zero offers.
 *
 * The signature PDP lane resolves its group through `pdp_identity_listing` alone — by
 * `source_listing_ref`, then by that row's `sellable_item_group_id`. Nothing in it is keyed on the
 * `content_key` the catalog actually converged the listings on. With no approved live identity
 * row, members come back empty, `catalogIdentity.sellable_item_group_id` has already defaulted to
 * the request's OWN signature, and the blocked arm answers `offers_count: 0`,
 * `product_group_id: <its own sig>`, `offer_source: 'multi_offer_blocked'`.
 *
 * Measured in prod 2026-09-17 on the Pyunkang Yul two-retailer canary: `get_offers` returned both
 * sellers while `get_product` on either listing reported zero. Before this file, the entire
 * blocked branch had no test in the repo.
 *
 * THIS FILE TESTS THE WIRING, not the decision. `tests/pdp_identity_group_rescue.node.test.cjs`
 * pins `resolveMissingIdentityGroupMembers` itself; a seam can be perfect and still be unreachable,
 * so here the request goes through the route and the assertions are on what an agent receives.
 */
const request = require('supertest');
const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');

jest.setTimeout(60000);

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;

const SIG_ID = 'sig_rescue0000000000000000000001';
// The sibling is the group's PRIMARY, so the elected canonical signature is NOT the one requested.
// With both fixtures pointing at the requested sig, "the group id changed" could not be observed.
const SIBLING_SIG_ID = 'sig_rescue0000000000000000000002';
const CONTENT_KEY = 'ck_rescue00000000000000000000001';
const GROUP_ID = 'pg_rescue00000000000000000000001';
const SEED_ID = 'ext:retailer:rescue1';
const SIBLING_SEED_ID = 'ext:retailer:rescue2';
const OBS_MERCHANT = 'merch_obs_rescue1';
const SIBLING_MERCHANT = 'merch_obs_rescue2';

const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

// ORDER MATTERS: the canonical-group SQL also contains the exact-signature query's fingerprint,
// so it must be matched FIRST or its fixtures become silent no-ops.
const isCanonicalGroupQuery = (sql) =>
  norm(sql).includes(CANONICAL_ENTITY_GROUP_SQL_TAG) && norm(sql).includes('FROM catalog_products cp');
const isExactSigQuery = (sql) => norm(sql).includes('cp.pivota_signature_id = $1');
const isIdentityListingQuery = (sql) => norm(sql).includes('FROM pdp_identity_listing pil');
const isQuarantineQuery = (sql) => norm(sql).includes('surviving_members AS');
const isSeedDetailQuery = (sql) =>
  String(sql || '').includes('FROM external_product_seeds') && String(sql || '').includes('destination_url');

function loadServerWithDb() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    // Unroutable on purpose: every upstream leg here is wrapped in a catch, so a dead base proves
    // the answer came from the mocked DB and not from an upstream service.
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'false',
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

function exactSigRow() {
  return {
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: SEED_ID,
    product_key: `prod::${OBS_MERCHANT}::external_seed::${SEED_ID}`,
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: SIG_ID,
    content_key: CONTENT_KEY,
    catalog_title: 'Rescue Probe Cleansing Balm',
    catalog_brand: 'Rescue Labs',
    catalog_image_url: 'https://cdn.example.test/rescue.png',
    catalog_description: 'probe',
    catalog_canonical_url: 'https://example.test/products/rescue1',
    catalog_pivota_canonical_url: null,
    catalog_product_payload: { title: 'Rescue Probe Cleansing Balm', brand: 'Rescue Labs' },
    catalog_sync_status: 'synced',
    catalog_pdp_lifecycle_stage: 'published',
    category: 'beauty',
    product_type: 'Cleansing Balm',
    category_path: 'beauty/skincare/cleanse/cleanser',
    signature_serving_eligible: true,
    signature_readiness_tier: 'serving',
    signature_pipeline_stage: 'serving',
    external_seed_id: 'eps_rescue_1',
    external_seed_external_product_id: SEED_ID,
    external_seed_status: 'active',
  };
}

function seedDetailRow(externalProductId, price) {
  return {
    id: `eps_${externalProductId}`,
    external_product_id: externalProductId,
    status: 'active',
    canonical_url: `https://example.test/products/${externalProductId}`,
    destination_url: `https://example.test/products/${externalProductId}`,
    domain: 'example.test',
    title: 'Rescue Probe Cleansing Balm',
    image_url: 'https://cdn.example.test/rescue.png',
    price_amount: price,
    price_currency: 'USD',
    availability: 'In Stock',
    seed_data: { brand: 'Rescue Labs', description: 'probe' },
  };
}

function groupRow(merchantId, sourceProductId, isPrimary, lifecycleStage = 'published') {
  return {
    product_key: `prod::${merchantId}::external_seed::${sourceProductId}`,
    merchant_id: merchantId,
    platform: 'external_seed',
    source_product_id: sourceProductId,
    product_title: 'Rescue Probe Cleansing Balm',
    product_description: 'probe',
    brand: 'Rescue Labs',
    category: 'beauty',
    product_type: 'Cleansing Balm',
    category_path: null,
    canonical_url: `https://example.test/products/${sourceProductId}`,
    product_image_url: 'https://cdn.example.test/rescue.png',
    product_payload: { title: 'Rescue Probe Cleansing Balm', brand: 'Rescue Labs' },
    pdp_lifecycle_stage: lifecycleStage,
    pivota_signature_id: isPrimary ? SIBLING_SIG_ID : SIG_ID,
    pivota_canonical_url: null,
    pivota_signature_minted_at: '2026-09-01T00:00:00Z',
    content_key: CONTENT_KEY,
    updated_at: '2026-09-01T00:00:00Z',
    merchant_name: merchantId,
    internal_product_group_id: GROUP_ID,
    is_primary: isPrimary,
    offer_count: 2,
  };
}

/**
 * @param {'shared'|'solo'|'same_merchant'|'sibling_draft'} shape what the catalog holds besides the
 *   requested listing. Everything but `shared` must leave the old answer alone.
 */
function install(db, { shape = 'shared' } = {}) {
  const seen = [];
  db.query.mockImplementation(async (sql, params) => {
    const p = Array.isArray(params) ? params : [];
    seen.push({ sql: norm(sql).slice(0, 80), params: p });
    if (isCanonicalGroupQuery(sql)) {
      const self = groupRow(OBS_MERCHANT, SEED_ID, false);
      const rows =
        shape === 'solo'
          ? [self]
          : shape === 'same_merchant'
            ? [self, groupRow(OBS_MERCHANT, `${SEED_ID}-relisted`, true)]
            : shape === 'sibling_draft'
              ? [self, groupRow(SIBLING_MERCHANT, SIBLING_SEED_ID, true, 'draft')]
              : [self, groupRow(SIBLING_MERCHANT, SIBLING_SEED_ID, true)];
      return { rows };
    }
    if (isExactSigQuery(sql)) return { rows: [exactSigRow()] };
    // The defect's precondition: no approved live identity listing, so the identity lane has no
    // members to offer and no group id but the request's own signature.
    if (isIdentityListingQuery(sql)) return { rows: [] };
    if (isQuarantineQuery(sql)) {
      const requested = JSON.parse(String(p[0] || '[]'));
      return {
        rows: [{ members: requested.map((m) => ({ merchant_id: m.merchant_id, product_id: m.product_id })) }],
      };
    }
    if (isSeedDetailQuery(sql)) {
      const id = String(p[0] || '');
      if (id === SEED_ID) return { rows: [seedDetailRow(SEED_ID, '14.50')] };
      if (id === SIBLING_SEED_ID) return { rows: [seedDetailRow(SIBLING_SEED_ID, '19.99')] };
      return { rows: [] };
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

function offersData(res) {
  return (res.body?.modules || []).find((module) => module.type === 'offers')?.data || null;
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('get_pdp_v2 identity group rescue', () => {
  it('serves the catalog group when the identity lane found no members', async () => {
    const { app, db } = loadServerWithDb();
    const seen = install(db, { shape: 'shared' });

    const res = await pdp(app, { product_id: SIG_ID });
    expect(res.status).toBe(200);

    const offers = offersData(res);
    expect(offers).toBeTruthy();
    // The defect's signature, gone: these two values are what prod served for a product with two
    // priced sellers in the catalog.
    expect(offers.offer_source).not.toBe('multi_offer_blocked');
    expect(offers.reason_codes || []).not.toContain('identity_group_members_missing');
    // BOTH SELLERS, not "more than zero": with the group id alone the blocked arm stops firing and
    // the self-offer fallback answers with ONE offer, which an `offers_count > 0` assertion would
    // accept as a fix. That mutant survived the first version of this test.
    expect(offers.offers_count).toBe(2);
    expect(offers.offer_source).toBe('group_fused');
    expect((offers.offers || []).map((offer) => offer.merchant_id).sort()).toEqual(
      [OBS_MERCHANT, SIBLING_MERCHANT].sort(),
    );
    // The GROUP's elected signature, not the one the caller asked with — and the same id every
    // other lane reading this resolver reports.
    expect(offers.product_group_id).toBe(SIBLING_SIG_ID);
    expect(offers.product_group_id).not.toBe(SIG_ID);

    expect(
      seen.some((entry) => entry.sql.includes('canonical_catalog_entity_group_resolve')),
    ).toBe(true);
  });

  it('does not serve one merchant twice as two sellers', async () => {
    // content_key is brand+title+GTIN with no merchant component: 30 content_keys in prod hold 2+
    // listings from ONE merchant. Serving those would show one store twice and, because the count
    // then exceeds one, label the PDP multi-merchant.
    const { app, db } = loadServerWithDb();
    install(db, { shape: 'same_merchant' });

    const res = await pdp(app, { product_id: SIG_ID });
    expect(res.status).toBe(200);
    expect(offersData(res)?.product_group_id).toBe(SIG_ID);
    expect(offersData(res)?.offers_count).toBe(0);
  });

  it('does not serve a sibling the catalog is withholding', async () => {
    // Of 348 catalog rows sharing a content_key with another row, only 85 are published. This lane
    // is not behind the identity lane's approval gate, so the stage is the only thing standing
    // between a draft listing and a live PDP.
    const { app, db } = loadServerWithDb();
    install(db, { shape: 'sibling_draft' });

    const res = await pdp(app, { product_id: SIG_ID });
    expect(res.status).toBe(200);
    expect(offersData(res)?.product_group_id).toBe(SIG_ID);
    expect(offersData(res)?.offers_count).toBe(0);
  });

  it('keeps the old answer when the catalog holds only this listing', async () => {
    // One member is the listing itself. Rescuing that would change every solo seed listing's
    // answer on the strength of a query that found nothing new.
    const { app, db } = loadServerWithDb();
    install(db, { shape: 'solo' });

    const res = await pdp(app, { product_id: SIG_ID });
    expect(res.status).toBe(200);

    const offers = offersData(res);
    expect(offers?.product_group_id).toBe(SIG_ID);
    expect(offers?.offers_count).toBe(0);
  });
});
