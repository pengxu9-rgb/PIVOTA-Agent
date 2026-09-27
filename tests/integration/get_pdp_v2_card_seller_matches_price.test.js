const nock = require('nock');
const request = require('supertest');

jest.setTimeout(60000);

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) =>
    fn({
      query: jest.fn(),
    })),
}));

// The canonical card must name the seller whose price it shows.
//
// Prod 2026-09-27 (gateway bf6ae5adf): identity group sig_13336cf3c9eba86550f9f093 holds the same
// Arencia product from two observed sellers — the JP store (2400 JPY) and the US store (15 USD).
// get_pdp_v2 took the card's content from arencia_jp (it sorts first) and its price from the
// buyer's default offer (arencia_us), so the card said the JP seller sells it for $15.

const ORIGINAL_ENV = process.env;

const GROUP_ID = 'sig_13336cf3c9eba86550f9f093';
const JP = {
  merchant_id: 'merch_obs_62ef3242cdba113c',
  product_id: 'arencia_jp_8098508767385',
  merchant_name: 'Arencia Japan',
  currency: 'JPY',
  amount: 2400,
  url: 'https://arencia.jp/products/holy-hyssop-serum',
  // Ranks first for content whichever listing is opened, as the prod group did.
  identity_confidence: 0.97,
};
const US = {
  merchant_id: 'merch_obs_76494d8b4732254b',
  product_id: 'arencia_us_8098508767385',
  merchant_name: 'Arencia',
  currency: 'USD',
  amount: 15,
  url: 'https://arencia.com/products/holy-hyssop-serum',
  identity_confidence: 0.93,
};

function loadServerWithDb() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://localhost:8080',
    PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
    PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE: 'true',
    PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST: 'Arencia',
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

function listing(seller, { inStock = true, bare = false } = {}) {
  const sellerFields = bare ? {} : { merchant_name: seller.merchant_name, url: seller.url };
  return {
    source_listing_ref: `${seller.merchant_id}:${seller.product_id}`,
    merchant_id: seller.merchant_id,
    product_id: seller.product_id,
    source_kind: 'external_seed',
    source_tier: 'brand',
    live_read_enabled: true,
    sellable_item_group_id: GROUP_ID,
    product_line_id: 'pl_arencia_holy_hyssop',
    review_family_id: 'rf_arencia_holy_hyssop',
    identity_status: 'approved',
    identity_confidence: seller.identity_confidence,
    match_basis: ['brand:arencia', 'title_core:holy hyssop serum'],
    strong_identity: {},
    soft_identity: {},
    variant_axes: {},
    source_payload: {
      product_id: seller.product_id,
      merchant_id: seller.merchant_id,
      ...sellerFields,
      title: 'Holy Hyssop Serum 12:1',
      brand: 'Arencia',
      description: 'Soothing hyssop serum.',
      images: [{ url: `https://cdn.example.com/${seller.product_id}.jpg` }],
      price: { amount: seller.amount, currency: seller.currency },
      currency: seller.currency,
      in_stock: inStock,
    },
  };
}

function mockCatalog(db, { usInStock = true, usBare = false } = {}) {
  const us = () => listing(US, { inStock: usInStock, bare: usBare });
  db.query.mockImplementation(async (sql, params) => {
    const normalizedSql = String(sql || '').replace(/\s+/g, ' ').trim();
    if (normalizedSql.includes('surviving_members AS')) {
      const requested = JSON.parse(String((Array.isArray(params) ? params[0] : null) || '[]'));
      return {
        rows: [{ members: requested.map((m) => ({ merchant_id: m.merchant_id, product_id: m.product_id })) }],
      };
    }
    if (normalizedSql.includes('FROM catalog_products cp') && normalizedSql.includes('LEFT JOIN index_pipeline_state ips')) {
      const [contentKey, , productId] = Array.isArray(params) ? params : [];
      return {
        rows: [
          {
            content_key: contentKey || 'ck_698ddc49670eb31aace9a79426c01f9a',
            product_key: `prod::external_seed::external_seed::${productId || JP.product_id}`,
            source_system: 'external_product_seeds_mirror_v1',
            source_product_id: productId || null,
            sync_status: 'live',
            pdp_lifecycle_stage: 'published',
            serving_eligible: true,
            readiness_tier: 'serving',
            pipeline_stage: 'serving',
            content_quality_score: 80,
            active_external_seed_source_match: true,
          },
        ],
      };
    }
    if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('merchant_id = $1')) {
      const productId = (params || []).find((p) => p === JP.product_id || p === US.product_id);
      return { rows: [productId === US.product_id ? us() : listing(JP)] };
    }
    if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('sellable_item_group_id = $1')) {
      // JP first: the content member the prod group resolved to.
      return { rows: [listing(JP), us()] };
    }
    if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('product_line_id = $1')) {
      return { rows: [listing(JP), us()] };
    }
    return { rows: [] };
  });
}

function mockUpstreamGroupMisses() {
  nock(process.env.PIVOTA_API_BASE)
    .get('/agent/v1/product-groups/resolve-by-product-id')
    .query(true)
    .reply(404, { error: 'PRODUCT_GROUP_NOT_FOUND' })
    .persist();
  nock(process.env.PIVOTA_API_BASE)
    .get('/agent/v1/product-groups/resolve')
    .query(true)
    .reply(404, { error: 'PRODUCT_GROUP_NOT_FOUND' })
    .persist();
}

async function getPdp(app, productId, extraPayload = {}) {
  const res = await request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'get_pdp_v2',
      payload: {
        include: ['offers'],
        product_ref: { merchant_id: 'external_seed', product_id: productId },
        ...extraPayload,
      },
    })
    .expect(200);
  const canonical = res.body.modules.find((module) => module.type === 'canonical');
  const offers = res.body.modules.find((module) => module.type === 'offers');
  return { card: canonical?.data?.pdp_payload?.product, canonical: canonical?.data, offers: offers?.data };
}

function currenciesIn(value) {
  const out = new Set();
  JSON.stringify(value, (key, v) => {
    if (key === 'currency' && typeof v === 'string') out.add(v);
    return v;
  });
  return [...out].sort();
}

describe('get_pdp_v2 canonical card: seller identity agrees with the price shown', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  // Two roads to the same wrong card. Opening arencia_jp: the card is the JP content listing and the
  // price was projected from the US default offer. Opening arencia_us: the identity graph overlays the
  // US listing's commerce fields on the JP content, and the JP seller's name stayed behind.
  test.each([
    ['arencia_jp (card projected from the default offer)', JP.product_id],
    ['arencia_us (selected seller overlaid on the JP content)', US.product_id],
  ])('a market-less (US) buyer opening %s sees the US seller at $15, never the JP seller at $15', async (_label, openedProductId) => {
    const { app, db } = loadServerWithDb();
    mockCatalog(db);
    mockUpstreamGroupMisses();

    const { card, canonical, offers } = await getPdp(app, openedProductId);

    const usOffer = (offers?.offers || []).find((offer) => offer.product_id === US.product_id);
    expect(usOffer).toEqual(
      expect.objectContaining({
        merchant_id: US.merchant_id,
        merchant_name: US.merchant_name,
        price: { amount: 15, currency: 'USD' },
      }),
    );
    expect(offers.default_offer_id).toBe(usOffer.offer_id);
    expect(JSON.stringify(usOffer)).not.toContain(JP.url);

    expect(card.price.current).toEqual({ amount: 15, currency: 'USD' });
    expect(card.currency).toBe('USD');
    // The seller named on the card is the one whose price it shows.
    expect(card.product_id).toBe(US.product_id);
    expect(card.merchant_id).toBe(US.merchant_id);
    expect([undefined, US.merchant_name]).toContain(card.merchant_name);
    expect(canonical.canonical_payload_product_ref).toEqual(
      expect.objectContaining({ merchant_id: US.merchant_id, product_id: US.product_id }),
    );
    // Nothing seller-scoped on the card still points at the JP listing, and no JPY is shown.
    expect(JSON.stringify(card)).not.toContain(JP.url);
    expect(JSON.stringify(card)).not.toContain(JP.merchant_name);
    expect(card.default_variant_id).toBe(US.product_id);
    expect((card.variants || []).map((variant) => variant.variant_id)).toEqual([US.product_id]);
    expect(currenciesIn(card)).toEqual(['USD']);
    // The content is still the group's (the JP member's title).
    expect(card.title).toBe('Holy Hyssop Serum 12:1');
    if (openedProductId === JP.product_id) {
      expect(card.merchant_name).toBe(US.merchant_name);
      expect(card.seller_source).toBe('default_offer');
      expect(card.content_product_ref).toEqual({ merchant_id: JP.merchant_id, product_id: JP.product_id });
    }
  });

  test('a US listing whose payload does not restate its seller fields does not inherit the JP seller\'s', async () => {
    const { app, db } = loadServerWithDb();
    mockCatalog(db, { usBare: true });
    mockUpstreamGroupMisses();

    const { card, offers } = await getPdp(app, US.product_id);

    const usOffer = (offers?.offers || []).find((offer) => offer.product_id === US.product_id);
    expect(usOffer).toEqual(expect.objectContaining({ merchant_id: US.merchant_id, price: { amount: 15, currency: 'USD' } }));
    expect(JSON.stringify(usOffer)).not.toMatch(/Arencia Japan|arencia\.jp/);
    expect(card.product_id).toBe(US.product_id);
    expect(JSON.stringify(card)).not.toMatch(/Arencia Japan|arencia\.jp/);
  });

  test('with the US listing out of stock the default offer is the JP one, and a US buyer is still not quoted JPY', async () => {
    const { app, db } = loadServerWithDb();
    mockCatalog(db, { usInStock: false });
    mockUpstreamGroupMisses();

    const { card, offers } = await getPdp(app, JP.product_id);

    const defaultOffer = (offers?.offers || []).find((offer) => offer.offer_id === offers.default_offer_id);
    expect(defaultOffer).toEqual(expect.objectContaining({ product_id: JP.product_id }));
    expect(card.price.current).toEqual({ amount: 15, currency: 'USD' });
    expect(card.product_id).toBe(US.product_id);
    expect(card.merchant_id).toBe(US.merchant_id);
    expect(card.availability).toEqual({ in_stock: false });
    expect(currenciesIn(card)).toEqual(['USD']);
  });

  test('a JP buyer is shown the JP seller at 2400 JPY: the card keeps its own listing', async () => {
    const { app, db } = loadServerWithDb();
    mockCatalog(db);
    mockUpstreamGroupMisses();

    const { card, offers } = await getPdp(app, JP.product_id, { market: 'JP' });

    const defaultOffer = (offers?.offers || []).find((offer) => offer.offer_id === offers.default_offer_id);
    expect(defaultOffer).toEqual(expect.objectContaining({ product_id: JP.product_id }));
    expect(card.price.current).toEqual({ amount: 2400, currency: 'JPY' });
    expect(card.product_id).toBe(JP.product_id);
    expect(card.merchant_id).toBe(JP.merchant_id);
    expect(card.seller_source).toBeUndefined();
    expect(card.content_product_ref).toBeUndefined();
  });
});
