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
