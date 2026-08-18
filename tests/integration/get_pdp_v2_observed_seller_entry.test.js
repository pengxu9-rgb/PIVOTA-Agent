const nock = require('nock');
const request = require('supertest');

jest.setTimeout(60000);

// ADR-009 observed-seller entry serving (Mojawa shape, prod-measured 2026-07-13):
// - `merch_obs_<hash>` sellers have NO products_cache row (source-gated out) and
//   NO upstream API (the backend 404s observed refs). Their only detail store is
//   external_product_seeds — get_pdp_v2 must serve the canonical product from it.
// - The url_audit sibling lane (merch_9678…) has no pdp_identity_listing row of
//   its own; identity resolution canonicalizes onto the live-read-enabled
//   merch_obs_ lane, and the identity rescue must retry with that RESOLVED ref
//   instead of 404ing on the requested lane ref.

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) =>
    fn({
      query: jest.fn(),
    })),
}));

const ORIGINAL_ENV = process.env;

const OBS_MERCHANT = 'merch_obs_022b65d47a58b87a';
const OBS_PRODUCT = 'mojawa_us_8129594163442';
const URL_AUDIT_MERCHANT = 'merch_9678f6352da21473';
const URL_AUDIT_PRODUCT = 'mojawa.com~0b99866a302a';
const GROUP_SIG = 'sig_f5c76a8f7e9b00811b08b897';
const CONTENT_KEY = 'ck_a6dc8c29b854612edc1d71e7d90f8060';

function loadServerWithDb(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://localhost:8080',
    PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
    ...envOverrides,
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

// filterGroupMembersByCatalogSourceQuarantine. It must be answered on its own
// terms: the real query projects `COALESCE(jsonb_agg(...), '[]'::jsonb) AS
// members`, and an empty/absent survivor list means "every member is
// quarantined", which empties the offer group and drops the offers module.
// Nothing is quarantined in these fixtures, so every requested member survives.
function isGroupMemberQuarantineQuery(normalizedSql) {
  return normalizedSql.includes('surviving_members AS');
}

function buildQuarantineSurvivorRows(params) {
  const requested = JSON.parse(String((Array.isArray(params) ? params[0] : null) || '[]'));
  return [
    {
      members: requested.map((member) => ({
        merchant_id: member.merchant_id,
        product_id: member.product_id,
      })),
    },
  ];
}

function canonicalGroupRow(overrides = {}) {
  return {
    product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
    merchant_id: OBS_MERCHANT,
    platform: 'external_seed',
    source_product_id: OBS_PRODUCT,
    product_title: 'HaptiFit Terra Bone Conduction Headphone',
    product_description: 'Bone conduction headphones for sport.',
    brand: 'Mojawa',
    category: 'electronics',
    product_type: 'Headphones',
    category_path: null,
    canonical_url: 'https://mojawa.com/products/bone-conduction-headphone-wireless-waterproof',
    product_image_url: 'https://cdn.example.com/haptifit.png',
    product_payload: {
      title: 'HaptiFit Terra Bone Conduction Headphone',
      brand: 'Mojawa',
      price_amount: 229.99,
      currency: 'USD',
    },
    pdp_lifecycle_stage: 'published',
    pivota_signature_id: 'sig_ca228ffe2b666f5c9e73a364c7bb30ba',
    pivota_canonical_url: null,
    pivota_signature_minted_at: '2026-07-10T00:00:00Z',
    content_key: CONTENT_KEY,
    updated_at: '2026-07-10T00:00:00Z',
    merchant_name: 'Mojawa',
    internal_product_group_id: 'pg_a6dc8c29b854612edc1d71e7d90f8060',
    is_primary: true,
    offer_count: 1,
    ...overrides,
  };
}

function urlAuditGroupRow() {
  return canonicalGroupRow({
    product_key: `prod::${URL_AUDIT_MERCHANT}::url_audit::${URL_AUDIT_PRODUCT}`,
    merchant_id: URL_AUDIT_MERCHANT,
    platform: 'url_audit',
    source_product_id: URL_AUDIT_PRODUCT,
    product_payload: {},
    pdp_lifecycle_stage: 'candidate',
    pivota_signature_id: 'sig_bf3b0ae0d51e745d012b1e40a4c57d85',
    merchant_name: 'Mojawa (Pivota pilot)',
    is_primary: false,
    offer_count: 0,
  });
}

function externalSeedDetailRow() {
  return {
    id: `external_brand_crawl::${OBS_PRODUCT}`,
    external_product_id: OBS_PRODUCT,
    destination_url: 'https://mojawa.com/products/bone-conduction-headphone-wireless-waterproof',
    canonical_url: 'https://mojawa.com/products/bone-conduction-headphone-wireless-waterproof',
    domain: 'mojawa.com',
    title: 'HaptiFit Terra Bone Conduction Headphone',
    image_url: 'https://cdn.example.com/haptifit.png',
    price_amount: 229.99,
    price_currency: 'USD',
    availability: 'in_stock',
    attached_product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
    seed_data: {
      title: 'HaptiFit Terra Bone Conduction Headphone',
      brand: 'Mojawa',
      description: 'Bone conduction headphones for sport. Long battery life.',
      category: 'electronics',
    },
    updated_at: '2026-07-10T00:00:00Z',
    created_at: '2026-07-10T00:00:00Z',
    status: 'active',
  };
}

function identityListingRow() {
  return {
    source_listing_ref: `${OBS_MERCHANT}:${OBS_PRODUCT}`,
    merchant_id: OBS_MERCHANT,
    product_id: OBS_PRODUCT,
    source_kind: 'external_seed',
    source_tier: 'brand',
    identity_status: 'approved',
    live_read_enabled: true,
    review_required: false,
    sellable_item_group_id: GROUP_SIG,
    product_line_id: 'pl_9de56fa0890b0c15998dd67e',
    review_family_id: 'rf_9de56fa0890b0c15998dd67e',
    identity_confidence: 0.92,
    brand_norm: 'mojawa',
    match_basis: ['official_url:https://mojawa.com/products/bone-conduction-headphone-wireless-waterproof'],
    source_payload: {
      title: 'HaptiFit Terra Bone Conduction Headphone',
      brand: 'Mojawa',
      price: { amount: 229.99, currency: 'USD' },
      currency: 'USD',
      in_stock: true,
      destination_url: 'https://mojawa.com/products/bone-conduction-headphone-wireless-waterproof',
    },
    variant_axes: {},
    source_meta: {},
  };
}

function mockDbForObservedSellerGroup(db, { seedDetailAvailable }) {
  db.query.mockImplementation(async (sql, params = []) => {
    const normalizedSql = normalizeSql(sql);
    if (isGroupMemberQuarantineQuery(normalizedSql)) {
      return { rows: buildQuarantineSurvivorRows(params) };
    }

    // Canonical catalog entity group (both lanes, one content_key).
    if (normalizedSql.includes('WITH offer_stats AS')) {
      return { rows: [canonicalGroupRow(), urlAuditGroupRow()] };
    }

    // Serving-eligibility gate, matched on its own `LEFT JOIN
    // index_pipeline_state ips`. A bare `index_pipeline_state` substring also
    // matches the quarantine query's `ips_pick` LATERAL probe, handled above.
    if (
      normalizedSql.includes('FROM catalog_products cp') &&
      normalizedSql.includes('LEFT JOIN index_pipeline_state ips')
    ) {
      return {
        rows: [
          {
            content_key: CONTENT_KEY,
            product_key: `prod::${OBS_MERCHANT}::external_seed::${OBS_PRODUCT}`,
            source_system: 'external_product_seeds_mirror_v1',
            source_product_id: OBS_PRODUCT,
            pivota_signature_id: 'sig_ca228ffe2b666f5c9e73a364c7bb30ba',
            catalog_title: 'HaptiFit Terra Bone Conduction Headphone',
            catalog_image_url: null,
            catalog_description: null,
            external_seed_product_family: null,
            catalog_image_urls_count: 0,
            sync_status: 'live',
            pdp_lifecycle_stage: 'published',
            serving_eligible: true,
            readiness_tier: 'serving',
            pipeline_stage: 'serving',
            blocker_code: null,
            blocker_detail: null,
            content_quality_score: 82,
            active_external_seed_source_match: true,
          },
        ],
      };
    }

    // Observed-seller detail lives in external_product_seeds.
    if (
      normalizedSql.includes('FROM external_product_seeds') &&
      normalizedSql.includes("status = 'active'") &&
      (normalizedSql.includes('external_product_id = $1') || normalizedSql.includes('id::text = $1'))
    ) {
      if (seedDetailAvailable && params[0] === OBS_PRODUCT) {
        return { rows: [externalSeedDetailRow()] };
      }
      return { rows: [] };
    }

    // Identity listing: exact-ref lookup — only the merch_obs_ lane has a row.
    if (
      normalizedSql.includes('FROM pdp_identity_listing') &&
      normalizedSql.includes('merchant_id = $1') &&
      normalizedSql.includes('product_id = $2')
    ) {
      if (params[0] === OBS_MERCHANT && params[1] === OBS_PRODUCT) {
        return { rows: [identityListingRow()] };
      }
      return { rows: [] };
    }

    // Identity listing: sellable-item-group / product-line member lookups.
    if (
      normalizedSql.includes('FROM pdp_identity_listing') &&
      (normalizedSql.includes('sellable_item_group_id = $1') ||
        normalizedSql.includes('product_line_id = $1'))
    ) {
      if (params[0] === GROUP_SIG || params[0] === 'pl_9de56fa0890b0c15998dd67e') {
        return { rows: [identityListingRow()] };
      }
      return { rows: [] };
    }

    // Seller display names.
    if (normalizedSql.includes('FROM catalog_merchants') && normalizedSql.includes('UNION ALL')) {
      return {
        rows: [
          { merchant_id: OBS_MERCHANT, merchant_name: 'Mojawa' },
          { merchant_id: URL_AUDIT_MERCHANT, merchant_name: 'Mojawa (Pivota pilot)' },
        ],
      };
    }

    return { rows: [] };
  });
}

describe('get_pdp_v2 observed-seller (merch_obs_) entry serving', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function mockUpstream404() {
    // No upstream API exists for observed sellers or url_audit lanes — the
    // backend 404s every detail fetch in this shape.
    nock(process.env.PIVOTA_API_BASE)
      .persist()
      .post('/agent/shop/v1/invoke')
      .reply(404, { status: 'error', error: { code: 'PRODUCT_NOT_FOUND' } });
  }

  test('merch_obs_ entry serves the canonical product from the seed store (no rescue, no precheck miss)', async () => {
    const { app, db } = loadServerWithDb();
    mockDbForObservedSellerGroup(db, { seedDetailAvailable: true });
    mockUpstream404();

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: OBS_MERCHANT, product_id: OBS_PRODUCT },
          include: ['offers'],
        },
      });

    expect(res.status).toBe(200);
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.resolved_merchant_id).toBe(OBS_MERCHANT);
    expect(identity.resolved_product_id).toBe(OBS_PRODUCT);
    // The canonical detail now hydrates from external_product_seeds, so the
    // entry precheck passes. (The live identity-graph enrichment may still
    // overlay the resolution source with the richer grouped identity.)
    expect(identity.entry_precheck_missing).not.toBe(true);
    expect(['canonical_catalog_product_group', 'identity_graph_live']).toContain(
      identity.resolution_source,
    );

    const offersModule = (res.body?.modules || []).find((m) => m.type === 'offers');
    expect(offersModule).toBeTruthy();
    const offers = offersModule?.data?.offers || [];
    expect(offers.length).toBeGreaterThanOrEqual(1);
    const observedOffer = offers.find((o) => o.merchant_id === OBS_MERCHANT);
    expect(observedOffer).toBeTruthy();
    // Seller of record, not the raw host and not the merch_obs_ id.
    expect(observedOffer.merchant_name).toBe('Mojawa');
    expect(observedOffer.price).toEqual(
      expect.objectContaining({ amount: 229.99, currency: 'USD' }),
    );
  });
  // ADR-009 task 4 — the catalog PDP-content merge follows the LANE.
  //
  // `enrichProductWithCatalogPdpContentFields` is gated, in the get_pdp_v2
  // route, on the resolved row being seed-routed, and it queries
  // `catalog_products WHERE merchant_id = $1 AND source_product_id = ANY($2)`.
  // Both halves were dead for observed-seller rows after the A9-4 re-key: the
  // gate tested `merchant_id === 'external_seed'` (permanently false), and the
  // lookup was keyed on that same retired sentinel — so even an open gate found
  // nothing. This test would have been RED before the fix on both counts: the
  // query was never issued on this path, and when it ran anywhere it carried
  // the sentinel, not the row's seller.
  test('merch_obs_ entry issues the catalog PDP-content lookup keyed on the OBSERVED seller, not the retired sentinel', async () => {
    const { app, db } = loadServerWithDb();
    mockDbForObservedSellerGroup(db, { seedDetailAvailable: true });
    mockUpstream404();

    const contentLookups = [];
    const inner = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params = []) => {
      const normalized = normalizeSql(sql);
      if (
        normalized.includes('SELECT source_product_id, product_payload, updated_at') &&
        normalized.includes('FROM catalog_products') &&
        normalized.includes('WHERE merchant_id = $1')
      ) {
        contentLookups.push({ merchantId: params[0], sourceProductIds: params[1] });
        return { rows: [] };
      }
      return inner(sql, params);
    });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: OBS_MERCHANT, product_id: OBS_PRODUCT },
          include: ['offers'],
        },
      });

    expect(res.status).toBe(200);
    // The lookup RAN — the lane gate admitted an observed-seller row.
    expect(contentLookups.length).toBeGreaterThanOrEqual(1);
    // ...and it is keyed on the row's real seller. The sentinel would find
    // nothing (0 catalog rows carry it), so this is the difference between
    // "merged" and "silently skipped".
    for (const lookup of contentLookups) {
      expect(lookup.merchantId).toBe(OBS_MERCHANT);
      expect(lookup.merchantId).not.toBe('external_seed');
      expect(Array.isArray(lookup.sourceProductIds)).toBe(true);
      expect(lookup.sourceProductIds).toContain(OBS_PRODUCT);
    }
  });


  test('url_audit lane entry canonicalizes onto the observed seller and serves', async () => {
    const { app, db } = loadServerWithDb();
    mockDbForObservedSellerGroup(db, { seedDetailAvailable: true });
    mockUpstream404();

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: URL_AUDIT_MERCHANT, product_id: URL_AUDIT_PRODUCT },
          include: ['offers'],
        },
      });

    expect(res.status).toBe(200);
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.requested_merchant_id).toBe(URL_AUDIT_MERCHANT);
    expect(identity.resolved_merchant_id).toBe(OBS_MERCHANT);
    expect(identity.resolved_product_id).toBe(OBS_PRODUCT);
    expect(identity.canonicalization_applied).toBe(true);
  });

  test('identity-only rescue: retries with the RESOLVED canonical ref when the requested lane has no listing', async () => {
    const { app, db } = loadServerWithDb();
    // Seed detail unavailable → the canonical fetch misses and the rescue runs.
    // The requested (url_audit) ref has no identity listing; only the resolved
    // canonical merch_obs_ ref does — pre-fix this 404ed as PRODUCT_NOT_FOUND.
    mockDbForObservedSellerGroup(db, { seedDetailAvailable: false });
    mockUpstream404();

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: URL_AUDIT_MERCHANT, product_id: URL_AUDIT_PRODUCT },
        },
      });

    expect(res.status).toBe(200);
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.resolution_source).toBe('identity_graph_live');
    expect(identity.resolved_merchant_id).toBe(OBS_MERCHANT);
  });
});

describe('resolveOfferSellerDisplayName — observed sellers (ADR-009)', () => {
  let debug;

  beforeAll(() => {
    const { app } = loadServerWithDb();
    debug = app._debug;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('real catalog merchant name wins over a raw host string in the seller fields', () => {
    const name = debug.resolveOfferSellerDisplayName({
      product: {
        seller_name: 'mojawa.com',
        destination_url: 'https://mojawa.com/products/x',
        brand: 'Mojawa',
      },
      member: { merchant_id: OBS_MERCHANT, merchant_name: 'Mojawa' },
      merchantId: OBS_MERCHANT,
    });
    expect(name).toBe('Mojawa');
  });

  test('brand-equal observed-seller name is NOT suppressed (the seller IS the brand)', () => {
    const name = debug.resolveOfferSellerDisplayName({
      product: { brand: 'Mojawa', destination_url: 'https://mojawa.com/products/x' },
      member: { merchant_id: OBS_MERCHANT, merchant_name: 'Mojawa' },
      merchantId: OBS_MERCHANT,
    });
    expect(name).toBe('Mojawa');
  });

  test('falls back to the formatted host label when no merchant name resolves', () => {
    const name = debug.resolveOfferSellerDisplayName({
      product: {
        seller_name: 'mojawa.com',
        destination_url: 'https://mojawa.com/products/x',
      },
      member: { merchant_id: OBS_MERCHANT },
      merchantId: OBS_MERCHANT,
    });
    expect(name).toBe('Mojawa');
  });

  test('legacy external_seed lump keeps host-label behavior and brand-name suppression', () => {
    const hostLabel = debug.resolveOfferSellerDisplayName({
      product: {
        seller_name: 'mojawa.com',
        destination_url: 'https://mojawa.com/products/x',
      },
      member: { merchant_id: 'external_seed' },
      merchantId: 'external_seed',
    });
    expect(hostLabel).toBe('Mojawa');

    const brandSuppressed = debug.resolveOfferSellerDisplayName({
      product: {
        brand: 'Acropass',
        merchant_name: 'Acropass',
        destination_url: 'https://acropass.com/products/x',
      },
      member: { merchant_id: 'external_seed' },
      merchantId: 'external_seed',
    });
    // Brand-equal names are fabricated on the anonymous lump — the formatted
    // host label serves instead.
    expect(brandSuppressed).toBe('Acropass');
  });

  test('connected merchants are unaffected (no host-label pass)', () => {
    const name = debug.resolveOfferSellerDisplayName({
      product: { seller_name: 'Krave Beauty Store' },
      member: { merchant_id: 'merch_connected_1', merchant_name: 'Krave Beauty' },
      merchantId: 'merch_connected_1',
    });
    expect(name).toBe('Krave Beauty Store');
  });
});

describe('fetchProductDetailForOffers — observed-seller seed-store routing', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('merch_obs_ refs hydrate from external_product_seeds, re-stamped with the observed seller id', async () => {
    const { app, db } = loadServerWithDb();
    db.query.mockImplementation(async (sql, params = []) => {
      const normalizedSql = normalizeSql(sql);
      if (isGroupMemberQuarantineQuery(normalizedSql)) {
        return { rows: buildQuarantineSurvivorRows(params) };
      }
      if (
        normalizedSql.includes('FROM external_product_seeds') &&
        normalizedSql.includes('external_product_id = $1') &&
        params[0] === OBS_PRODUCT
      ) {
        return { rows: [externalSeedDetailRow()] };
      }
      return { rows: [] };
    });

    const product = await app._debug.fetchProductDetailForOffers({
      merchantId: OBS_MERCHANT,
      productId: OBS_PRODUCT,
    });

    expect(product).toBeTruthy();
    expect(product.merchant_id).toBe(OBS_MERCHANT);
    expect(String(product.title || product.name || '')).toContain('HaptiFit Terra');
    // No upstream call was attempted (nock would have thrown on a real request).
  });
});

// ---------------------------------------------------------------------------
// ADR-009 row-side conversion, part 2 — the review-suppression gate in
// get_pdp_v2 asks the LANE, not the retired seller value.
//
// Unlike the three defects #2006/#2008 fixed (protective gates that went dead
// and LOST content), this one is an EXCLUSION arm that went dead, so the route
// can now do MORE than it used to. Everything below is measured, on prod
// 2026-08-17, not reasoned about:
//
//   * 12,514 catalog rows are seed-routed; 0 still carry the retired seller, so
//     the arm this replaces matches nothing. 12,514 of 12,514 carry
//     platform='external_seed' and a seed source_system — the two columns the
//     A9-4 re-key left untouched, and the two the lane predicate reads.
//   * Only 5,847 carry an `ext_` source id, so the two id arms cover under half
//     the lane.
//   * The `'external'` platform arm reads `canonicalProduct`, and only the seed
//     detail store stamps that value. It answers on the route key for 9,473 of
//     10,339 mirror rows and 0 of 2,175 minted rows.
//
//  REACHABILITY, measured live the same day (probes against the deployed
//  gateway, sig path and direct merchant+product path, minted and mirror rows,
//  with and without a pdp_identity_listing): every serving path resolved
//  through `identity_graph_live`, whose synthetic product always carries a
//  review_summary, so the gate SHORT-CIRCUITS above these arms and the merchant
//  review service is never called for a seed row today (reviews module timing
//  0ms on all four probes). Where the identity graph is absent, an observed
//  seller's canonical product is either seed-built (platform 'external', arm 2
//  covers) or null (the route 404s). So NO currently-serving row changes.
//
//  What the conversion buys is that the suppression stops DEPENDING on those
//  two unrelated accidents. The first test below is the shape that reaches the
//  gate with every other arm false — a seed-lane row (the platform and
//  source_system the mirror writer sets) under a seller that is not an observed
//  one, with a non-`ext_` id. The seller column is precisely what ADR-009 keeps
//  moving, which is why the lane must not be read off it.
// ---------------------------------------------------------------------------

const REVIEWS_BASE = 'http://reviews.test.local';

// Seed-lane row (mirror platform + mirror source_system, brand:hash id) whose
// seller is NOT an observed one, so the canonical detail comes from
// products_cache rather than the seed store.
const LANE_MERCHANT = 'merch_connected_seed_lane';
const LANE_PRODUCT = 'brandx:9f2a11c4d7e60b83';
const LANE_SIG = 'sig_aa11bb22cc33dd44ee55ff66';

// Connected-merchant control lane. Its whole job is to prove the "no review
// lookup happened" assertion is capable of being false: an unpaired absence
// assertion also passes against a route that never fetches anything.
const CTL_MERCHANT = 'merch_connected_reviews_ctl';
const CTL_PRODUCT = '9876543210';

function cacheDetailRow({ merchantId, productId, platform, title }) {
  return {
    product_data: {
      id: productId,
      product_id: productId,
      merchant_id: merchantId,
      platform,
      platform_product_id: productId,
      title,
      brand: 'BrandX',
      price: { amount: 42, currency: 'USD' },
      currency: 'USD',
      in_stock: true,
      image_url: 'https://cdn.example.com/lane.png',
    },
    cached_at: '2026-08-01T00:00:00Z',
  };
}

function isProductsCacheDetailQuery(normalizedSql) {
  return (
    normalizedSql.includes('SELECT product_data, cached_at') &&
    normalizedSql.includes('FROM products_cache')
  );
}

function isServingEligibilityQuery(normalizedSql) {
  return (
    normalizedSql.includes('FROM catalog_products cp') &&
    normalizedSql.includes('LEFT JOIN index_pipeline_state ips')
  );
}

// resolveCatalogIdentityForProductRef's primary read — the one that patches
// `platform` onto the canonical ref just above the reviews block.
function isCatalogIdentityForRefQuery(normalizedSql) {
  return (
    normalizedSql.includes('FROM catalog_products cp') &&
    normalizedSql.includes('LEFT JOIN pdp_identity_listing pil') &&
    normalizedSql.includes('WHERE cp.merchant_id = $1')
  );
}

function servingEligibleRow({ merchantId, productId, platform, sourceSystem, sigId }) {
  return {
    content_key: `ck_${productId.replace(/[^a-z0-9]/gi, '')}`,
    product_key: `prod::${merchantId}::${platform}::${productId}`,
    source_system: sourceSystem,
    source_product_id: productId,
    pivota_signature_id: sigId,
    catalog_title: 'Lane Product',
    catalog_image_url: null,
    catalog_description: null,
    external_seed_product_family: null,
    catalog_image_urls_count: 1,
    sync_status: 'live',
    pdp_lifecycle_stage: 'published',
    serving_eligible: true,
    readiness_tier: 'serving',
    pipeline_stage: 'serving',
    blocker_code: null,
    blocker_detail: null,
    content_quality_score: 88,
    active_external_seed_source_match: sourceSystem !== 'shopify_sync_v1',
  };
}

// Local twin of the first describe's helper (that one is block-scoped).
function mockCommerceUpstream404() {
  nock(process.env.PIVOTA_API_BASE)
    .persist()
    .post('/agent/shop/v1/invoke')
    .reply(404, { status: 'error', error: { code: 'PRODUCT_NOT_FOUND' } });
}

function mockReviewsUpstream() {
  const calls = [];
  nock(REVIEWS_BASE)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => {
      if (body?.operation === 'get_review_summary') {
        calls.push(body?.payload?.sku || {});
        return true;
      }
      return false;
    })
    .reply(200, {
      review_summary: {
        scale: 5,
        rating: 4.6,
        review_count: 31,
        source: 'merchant_review_source',
      },
    });
  return calls;
}

describe('get_pdp_v2 — review suppression follows the seed LANE, not the retired seller value', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('a seed-lane row under a NON-observed seller with a non-ext_ id suppresses the merchant review lookup', async () => {
    const { app, db } = loadServerWithDb({ REVIEWS_API_BASE: REVIEWS_BASE });
    db.query.mockImplementation(async (sql, params = []) => {
      const normalizedSql = normalizeSql(sql);
      if (isGroupMemberQuarantineQuery(normalizedSql)) {
        return { rows: buildQuarantineSurvivorRows(params) };
      }
      // Seed-lane catalog identity: this is what carries platform ='external_seed'
      // and is what the lane predicate reads off the canonical ref.
      if (isCatalogIdentityForRefQuery(normalizedSql) && params[0] === LANE_MERCHANT) {
        return {
          rows: [
            {
              merchant_id: LANE_MERCHANT,
              platform: 'external_seed',
              source_product_id: LANE_PRODUCT,
              product_key: `prod::${LANE_MERCHANT}::external_seed::${LANE_PRODUCT}`,
              pivota_signature_id: LANE_SIG,
              category: 'skincare',
              product_type: 'Serum',
              category_path: null,
              category_label_source: null,
              category_confidence: null,
              catalog_rating_value: null,
              catalog_rating_count: null,
              // No identity listing for this ref — so the identity graph builds
              // nothing and the reviews gate is actually REACHED.
              sellable_item_group_id: null,
              product_line_id: null,
              review_family_id: null,
              identity_confidence: null,
              match_basis: [],
              identity_status: null,
              live_read_enabled: null,
              review_required: null,
            },
          ],
        };
      }
      if (isServingEligibilityQuery(normalizedSql)) {
        return {
          rows: [
            servingEligibleRow({
              merchantId: LANE_MERCHANT,
              productId: LANE_PRODUCT,
              platform: 'external_seed',
              sourceSystem: 'external_product_seeds_mirror_v1',
              sigId: LANE_SIG,
            }),
          ],
        };
      }
      // Not an observed seller, so the detail comes from products_cache and
      // carries the merchant's own platform — NOT the seed store's 'external'.
      if (isProductsCacheDetailQuery(normalizedSql) && params[0] === LANE_MERCHANT) {
        return {
          rows: [
            cacheDetailRow({
              merchantId: LANE_MERCHANT,
              productId: LANE_PRODUCT,
              platform: 'shopify',
              title: 'Lane Product',
            }),
          ],
        };
      }
      return { rows: [] };
    });
    mockCommerceUpstream404();
    const reviewCalls = mockReviewsUpstream();

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: LANE_MERCHANT, product_id: LANE_PRODUCT },
          include: ['reviews_preview'],
        },
      });

    expect(res.status).toBe(200);

    // --- every OTHER arm of this gate is proven FALSE in this fixture ------
    // (a test named after one conjunct that passes because a different conjunct
    // held the gate shut is how green lies in this route).
    const identity = res.body?.metadata?.identity_resolution || {};
    const servedProduct =
      (res.body?.modules || []).find((m) => m?.type === 'canonical')?.data?.pdp_payload?.product ||
      {};
    // arm 1, the one being replaced: the resolved seller is a real seller, not
    // the retired shared bucket.
    expect(identity.resolved_merchant_id).toBe(LANE_MERCHANT);
    expect(identity.resolved_merchant_id).not.toBe('external_seed');
    // arms 2 and 4: read the canonical product this same fixture produces (the
    // projected payload drops `platform`, so assert it at the source). It comes
    // from products_cache, not the seed store, so it carries the merchant's own
    // platform and a non-seed platform_product_id.
    const canonicalDetail = await app._debug.fetchProductDetailForOffers({
      merchantId: LANE_MERCHANT,
      productId: LANE_PRODUCT,
    });
    expect(String(canonicalDetail?.platform || '').toLowerCase()).toBe('shopify');
    expect(String(canonicalDetail?.platform || '').toLowerCase()).not.toBe('external');
    expect(/^ext[_:]/i.test(String(canonicalDetail?.platform_product_id || ''))).toBe(false);
    // arm 3: the resolved ref id carries no seed prefix either.
    expect(/^ext[_:]/i.test(String(identity.resolved_product_id || ''))).toBe(false);
    expect(servedProduct).toBeTruthy();
    // ...and the reviews block is genuinely REACHED (the CONTROL below proves
    // this same fixture shape does call the review service when the row is not
    // seed-lane; here the only thing stopping it is the lane test).

    // --- the assertion the conversion is about ----------------------------
    expect(reviewCalls).toEqual([]);
    const reviewsModule = (res.body?.modules || []).find((m) => m?.type === 'reviews_preview');
    expect(reviewsModule?.data?.review_count || 0).toBe(0);
    expect(reviewsModule?.data?.rating || 0).toBe(0);
    expect(reviewsModule?.data?.source).not.toBe('merchant_review_source');
  });

  // CONTROL — identical fixture shape, identical include, identical reviews
  // upstream; only the lane columns differ. Without this the assertion above
  // would also pass against a route that had simply stopped fetching reviews.
  test('CONTROL: the same shape on a NON-seed lane still fetches and renders its merchant review summary', async () => {
    const { app, db } = loadServerWithDb({ REVIEWS_API_BASE: REVIEWS_BASE });
    db.query.mockImplementation(async (sql, params = []) => {
      const normalizedSql = normalizeSql(sql);
      if (isGroupMemberQuarantineQuery(normalizedSql)) {
        return { rows: buildQuarantineSurvivorRows(params) };
      }
      if (isServingEligibilityQuery(normalizedSql)) {
        return {
          rows: [
            servingEligibleRow({
              merchantId: CTL_MERCHANT,
              productId: CTL_PRODUCT,
              platform: 'shopify',
              sourceSystem: 'shopify_sync_v1',
              sigId: null,
            }),
          ],
        };
      }
      if (isProductsCacheDetailQuery(normalizedSql) && params[0] === CTL_MERCHANT) {
        return {
          rows: [
            cacheDetailRow({
              merchantId: CTL_MERCHANT,
              productId: CTL_PRODUCT,
              platform: 'shopify',
              title: 'Control Serum',
            }),
          ],
        };
      }
      return { rows: [] };
    });
    mockCommerceUpstream404();
    const reviewCalls = mockReviewsUpstream();

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: CTL_MERCHANT, product_id: CTL_PRODUCT },
          include: ['reviews_preview'],
        },
      });

    expect(res.status).toBe(200);
    expect(reviewCalls.length).toBeGreaterThanOrEqual(1);
    expect(reviewCalls[0]).toEqual(
      expect.objectContaining({
        merchant_id: CTL_MERCHANT,
        platform: 'shopify',
        platform_product_id: CTL_PRODUCT,
      }),
    );
    const ctlReviewsModule = (res.body?.modules || []).find((m) => m?.type === 'reviews_preview');
    expect(ctlReviewsModule?.data).toEqual(
      expect.objectContaining({ rating: 4.6, review_count: 31, source: 'merchant_review_source' }),
    );
  });
});

// ---------------------------------------------------------------------------
// ADR-009 row-side conversion, part 2, site 2 — the sibling-offer guard in the
// self-offer fallback. KEPT DELIBERATELY; these two tests exist to make that a
// decision rather than an oversight, and each one fails under the change it
// argues against.
//
// The A9-4 re-key DID widen this call site: seed rows used to be addressed by
// the retired shared seller, which this arm excluded, and now sit under
// per-brand observed sellers, which it admits. Measured on prod 2026-08-17 the
// widening is small and correct — of 4,660 seed-lane rows whose own identity
// listing fails the gate, 65 have ANY approved + live sibling in their
// sellable-item group (43 under a different seller, 87 sibling rows in total,
// before the callee's own serving-eligibility and quarantine filters), and
// every sampled pair is the SAME product under a second observed seller.
// `fetchApprovedLiveIdentityGroupMembersForOffers` was itself rewritten under
// ADR-009 to admit exactly those members, so re-closing this call site on the
// lane would defeat the callee's own change.
// ---------------------------------------------------------------------------

const SIB_OBS_MERCHANT = 'merch_obs_5c1d0e8a77b3f210';
const SIB_PRODUCT = 'brandy:41ba77e0c9d51236';
const SIB_GROUP_SIG = 'sig_bb22cc33dd44ee55ff660011';
const SIB_MEMBER_MERCHANT = 'merch_obs_9a0f2b6c4d8e1357';
const SIB_MEMBER_PRODUCT = 'brandy:772ac0e91f34d885';

// fetchApprovedLiveIdentityGroupMembersForOffers — identified by the exclude
// pair, which no other pdp_identity_listing read carries.
function isSiblingGroupMemberQuery(normalizedSql) {
  return (
    normalizedSql.includes('FROM pdp_identity_listing pil') &&
    normalizedSql.includes('NOT (pil.merchant_id = $2 AND pil.product_id = $3)')
  );
}

function gateFailedCatalogIdentityRow(merchantId, productId) {
  return {
    merchant_id: merchantId,
    platform: 'external_seed',
    source_product_id: productId,
    product_key: `prod::${merchantId}::external_seed::${productId}`,
    pivota_signature_id: SIB_GROUP_SIG,
    category: 'skincare',
    product_type: 'Cream',
    category_path: null,
    category_label_source: null,
    category_confidence: null,
    catalog_rating_value: null,
    catalog_rating_count: null,
    sellable_item_group_id: SIB_GROUP_SIG,
    product_line_id: null,
    review_family_id: null,
    identity_confidence: 0.71,
    match_basis: [],
    // THE GATE FAILS — this row's own listing is not approved for live read,
    // which is the whole precondition for looking at its siblings.
    identity_status: 'pending',
    live_read_enabled: false,
    review_required: true,
  };
}

function seedStoreRow(productId) {
  return {
    id: `external_brand_crawl::${productId}`,
    external_product_id: productId,
    destination_url: 'https://brandy.example/products/cream',
    canonical_url: 'https://brandy.example/products/cream',
    domain: 'brandy.example',
    title: 'Brandy Barrier Cream',
    image_url: 'https://cdn.example.com/brandy.png',
    price_amount: 31.5,
    price_currency: 'USD',
    availability: 'in_stock',
    attached_product_key: null,
    seed_data: { title: 'Brandy Barrier Cream', brand: 'Brandy', category: 'skincare' },
    updated_at: '2026-08-01T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
    status: 'active',
  };
}

// One shared mock; the only difference between the two tests is which seller
// addresses the PDP.
function mockDbForSelfOfferFallback(db, { addressedMerchantId, siblingCalls }) {
  db.query.mockImplementation(async (sql, params = []) => {
    const normalizedSql = normalizeSql(sql);
    if (isGroupMemberQuarantineQuery(normalizedSql)) {
      return { rows: buildQuarantineSurvivorRows(params) };
    }
    if (isSiblingGroupMemberQuery(normalizedSql)) {
      siblingCalls.push({ groupId: params[0], excludeMerchantId: params[1], excludeProductId: params[2] });
      return {
        rows: [
          {
            source_listing_ref: `${SIB_MEMBER_MERCHANT}:${SIB_MEMBER_PRODUCT}`,
            merchant_id: SIB_MEMBER_MERCHANT,
            product_id: SIB_MEMBER_PRODUCT,
            source_kind: 'external_seed',
            source_tier: 'brand',
            source_payload: { title: 'Brandy Barrier Cream', currency: 'USD', in_stock: true },
            variant_axes: {},
            platform: 'external_seed',
            merchant_name: 'Brandy Depot',
            catalog_title: 'Brandy Barrier Cream',
            catalog_brand: 'Brandy',
            catalog_canonical_url: null,
            catalog_image_url: null,
            catalog_electronics_meta: null,
            catalog_offer_id: null,
            catalog_sku_key: null,
            catalog_offer_currency: 'USD',
            catalog_offer_price: 29.0,
            catalog_offer_source_system: null,
            catalog_offer_source_ref: null,
          },
        ],
      };
    }
    if (isCatalogIdentityForRefQuery(normalizedSql)) {
      // Keyed on whatever seller addressed the page — the pre-re-key shape
      // returned a retired-seller row here, the post-re-key shape an observed
      // one. Both reach the gate failure.
      return { rows: [gateFailedCatalogIdentityRow(params[0], params[1] || SIB_PRODUCT)] };
    }
    if (isServingEligibilityQuery(normalizedSql)) {
      return {
        rows: [
          servingEligibleRow({
            merchantId: addressedMerchantId,
            productId: SIB_PRODUCT,
            platform: 'external_seed',
            sourceSystem: 'external_product_seeds_mirror_v1',
            sigId: SIB_GROUP_SIG,
          }),
        ],
      };
    }
    if (
      normalizedSql.includes('FROM external_product_seeds') &&
      normalizedSql.includes("status = 'active'") &&
      (normalizedSql.includes('external_product_id = $1') || normalizedSql.includes('id::text = $1'))
    ) {
      return params[0] === SIB_PRODUCT ? { rows: [seedStoreRow(SIB_PRODUCT)] } : { rows: [] };
    }
    return { rows: [] };
  });
}

describe('get_pdp_v2 self-offer fallback — the sibling-offer guard is the legacy anonymous-lump test', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // Kills the tempting conversion: re-closing this call site on the seed LANE
  // would skip the sibling fetch for every observed seller, which is exactly
  // the cohort the callee's own ADR-009 rewrite exists to serve.
  test('an OBSERVED seller whose identity gate fails DOES fetch sibling group members, keyed on itself', async () => {
    const { app, db } = loadServerWithDb();
    const siblingCalls = [];
    mockDbForSelfOfferFallback(db, { addressedMerchantId: SIB_OBS_MERCHANT, siblingCalls });
    mockCommerceUpstream404();

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: SIB_OBS_MERCHANT, product_id: SIB_PRODUCT },
          include: ['offers'],
        },
      });

    expect(res.status).toBe(200);
    // The other three conjuncts of this guard are all true in this fixture:
    // the identity gate failed (the catalog identity above is pending +
    // review_required + not live-read enabled, with a group id), and the
    // resolved ref carries both a seller and a product id — which the call's
    // own exclude pair proves.
    expect(siblingCalls).toHaveLength(1);
    expect(siblingCalls[0]).toEqual({
      groupId: SIB_GROUP_SIG,
      excludeMerchantId: SIB_OBS_MERCHANT,
      excludeProductId: SIB_PRODUCT,
    });
    expect(siblingCalls[0].excludeMerchantId).not.toBe('external_seed');
  });

  // Kills the other tempting change: deleting the arm as "dead". It is dead on
  // catalog rows (0 carry the retired seller today), but the request-side
  // fallback ref still mints it for a legacy client, and that ref names no
  // seller of record — nothing to attribute a self-offer to, nothing meaningful
  // to exclude siblings by.
  test('a legacy client addressing the retired seller does NOT fetch sibling group members', async () => {
    const { app, db } = loadServerWithDb();
    const siblingCalls = [];
    mockDbForSelfOfferFallback(db, { addressedMerchantId: 'external_seed', siblingCalls });
    mockCommerceUpstream404();

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .set('X-Agent-API-Key', 'test-key')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: { merchant_id: 'external_seed', product_id: SIB_PRODUCT },
          include: ['offers'],
        },
      });

    expect(res.status).toBe(200);
    const identity = res.body?.metadata?.identity_resolution || {};
    expect(identity.resolved_merchant_id).toBe('external_seed');
    expect(siblingCalls).toEqual([]);
  });
});
