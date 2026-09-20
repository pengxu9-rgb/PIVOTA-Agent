const { Client } = require('pg');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { getProductEntityIndexFeed } = require('../../src/services/productEntityIndexFeed');

// A disposable PostgreSQL database is opt-in, as in the other canonical SQL
// suites. Without the URL this suite skips; CI supplies its own test database.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('representative offer availability on real PostgreSQL', () => {
  let db;
  let schema;
  let previousFlags;

  beforeAll(async () => {
    previousFlags = {
      CANONICAL_CATALOG_RANK_V2: process.env.CANONICAL_CATALOG_RANK_V2,
      CANONICAL_CATALOG_RECALL_DOC_MATCH: process.env.CANONICAL_CATALOG_RECALL_DOC_MATCH,
      CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: process.env.CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION,
      CANONICAL_CATALOG_SET_DIVERSITY: process.env.CANONICAL_CATALOG_SET_DIVERSITY,
      SEARCH_NAME_EVIDENCE_ADMISSION: process.env.SEARCH_NAME_EVIDENCE_ADMISSION,
      INDEX_FEED_ELECTED_CANONICAL: process.env.INDEX_FEED_ELECTED_CANONICAL,
    };
    for (const flag of Object.keys(previousFlags)) process.env[flag] = 'off';
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `offer_availability_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // These are the actual production statements with only their fixture
    // tables reduced to the columns they read. No JavaScript sort substitutes
    // for either LATERAL or the feed's representative-offer selection.
    await db.query(`
      CREATE TABLE catalog_products(product_key text, content_key text, merchant_id text, platform text,
        source_product_id text, title text, description text, brand text, product_type text, category text,
        category_path text, canonical_url text, image_url text, catalog_track text, truth_tier text,
        readiness_tier text, pdp_scope text, source_system text, product_payload jsonb, freshness_json jsonb,
        pivota_signature_id text, pivota_canonical_url text, pivota_signature_minted_at timestamptz,
        pdp_lifecycle_stage text, material text, material_source text, material_confidence numeric,
        care text, care_source text, care_confidence numeric, size_guide text, size_guide_source text,
        size_guide_confidence numeric, updated_at timestamptz, recall_doc text, recall_market text,
        source_domain text, status text, suppressed_at timestamptz);
      CREATE TABLE index_pipeline_state(content_key text, serving_eligible boolean, index_eligible boolean);
      CREATE TABLE catalog_merchants(merchant_id text, merchant_name text, primary_platform text, status text);
      CREATE TABLE catalog_skus(sku_key text, product_key text, source_variant_id text, sku text, barcode text,
        title text, visible_attributes jsonb, visible_option_labels jsonb, ingredient_ids jsonb,
        image_url text, suppressed_at timestamptz);
      CREATE TABLE catalog_offers(offer_id text, sku_key text, product_key text, catalog_track text,
        truth_tier text, readiness_tier text, offer_mode text, availability text, inventory_quantity numeric,
        currency text, list_price numeric, merchant_effective_price numeric, estimated_best_price numeric,
        price_confidence numeric, source_system text, offer_payload jsonb, market text,
        suppressed_at timestamptz, updated_at timestamptz);
      CREATE TABLE external_product_seeds(id text, external_product_id text, market text, tool text,
        destination_url text, canonical_url text, domain text, title text, image_url text,
        price_amount numeric, price_currency text, availability text, seed_data jsonb,
        updated_at timestamptz, created_at timestamptz, status text, attached_product_key text);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text,
        product_group_id text, is_primary boolean);
    `);
    await db.query(`INSERT INTO catalog_merchants(merchant_id, merchant_name, status)
      VALUES ('merchant_fixture', 'Fixture Seller', 'active')`);
    await db.query(`INSERT INTO catalog_products(product_key, content_key, merchant_id, platform,
      source_product_id, title, brand, category_path, canonical_url, image_url,
      pivota_signature_id, product_payload, updated_at)
      VALUES ('product_fixture', 'content_fixture', 'merchant_fixture', 'shopify',
      'fixture_lipstick', 'Fixture Lipstick', 'Fixture Brand', 'beauty/makeup/lip/lipstick',
      'https://retailer.example/products/fixture', 'https://cdn.example/fixture.jpg',
      'sig_fixture', '{}'::jsonb, now())`);
    await db.query(`INSERT INTO index_pipeline_state(content_key, serving_eligible)
      VALUES ('content_fixture', true)`);
    await db.query(`INSERT INTO catalog_skus(sku_key, product_key, source_variant_id)
      VALUES ('sku_fixture', 'product_fixture', 'variant_fixture')`);
  });

  afterAll(async () => {
    if (db) {
      if (schema) await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
    if (previousFlags) {
      for (const [flag, value] of Object.entries(previousFlags)) {
        if (value === undefined) delete process.env[flag];
        else process.env[flag] = value;
      }
    }
  });

  const setOffers = async (offers) => {
    await db.query('TRUNCATE catalog_offers');
    for (const offer of offers) {
      await db.query(`INSERT INTO catalog_offers(offer_id, sku_key, product_key, merchant_effective_price,
        currency, availability, market, suppressed_at, inventory_quantity)
        VALUES ($1, 'sku_fixture', 'product_fixture', $2, $3, $4, $5, $6, $7)`,
      [offer.id, offer.price, offer.currency === undefined ? 'USD' : offer.currency,
        offer.availability, offer.market === undefined ? 'US' : offer.market,
        offer.suppressed ? new Date() : null, offer.quantity === undefined ? null : offer.quantity]);
    }
  };

  const search = (includeSkuOffers, offerScope = null) => fetchCanonicalChainRows({
    query: 'Fixture Lipstick', merchantId: 'merchant_fixture', marketId: 'US',
    includeSkuOffers, offerScope, deps: { query: (sql, params) => db.query(sql, params) },
  });

  const feed = async () => {
    let rows;
    await getProductEntityIndexFeed({ market: 'US', priced_only: true, limit: 10 }, {
      query: async (sql, params) => {
        rows = (await db.query(sql, params)).rows;
        return { rows };
      },
    });
    return rows;
  };

  test.each([
    ['cheap unavailable loses to available', [
      { id: 'a', price: 1, availability: ' Out_Of_Stock ' },
      { id: 'b', price: 10, availability: 'in_stock' },
    ], 'in_stock', 10],
    ['JavaScript trim whitespace around unavailable loses to available', [
      { id: 'a', price: 1, availability: '\t\nOut_Of_Stock\u00a0' },
      { id: 'b', price: 10, availability: 'in_stock' },
    ], 'in_stock', 10],
    ['all five unavailable spellings lose', [
      ...['out_of_stock', 'outofstock', 'sold_out', 'soldout', 'unavailable']
        .map((availability, i) => ({ id: `a${i}`, price: i + 1, availability })),
      { id: 'b', price: 10, availability: 'in_stock' },
    ], 'in_stock', 10],
    ['unknown stock shares sellable tier and wins by price', [
      { id: 'a', price: 2, availability: null },
      { id: 'b', price: 5, availability: 'in_stock' },
    ], null, 2],
    ['all unavailable still returns the cheapest', [
      { id: 'a', price: 4, availability: 'sold_out' },
      { id: 'b', price: 3, availability: 'unavailable' },
    ], 'unavailable', 3],
    ['market preference stays ahead of stock tier', [
      { id: 'a', price: 1, availability: 'sold_out', market: 'US' },
      { id: 'b', price: 2, availability: 'in_stock', market: 'CA' },
    ], 'sold_out', 1],
    ['existing price, currency and suppression filters remain', [
      { id: 'a', price: 1, availability: 'in_stock', suppressed: true },
      { id: 'b', price: 2, availability: 'in_stock', currency: null },
      { id: 'c', price: 0, availability: 'in_stock' },
      { id: 'd', price: 4, availability: 'in_stock' },
    ], 'in_stock', 4],
  ])('%s', async (_name, offers, availability, price) => {
    await setOffers(offers);
    for (const includeSkuOffers of [true, false]) {
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(1);
      expect(rows[0].availability).toBe(availability);
      expect(Number(rows[0].merchant_effective_price)).toBe(price);
    }
    const rows = await feed();
    expect(rows).toHaveLength(1);
    expect(rows[0].availability).toBe(availability);
    expect(Number(rows[0].price_amount)).toBe(price);
    expect(rows[0].price_currency).toBe('USD');
  });

  test('inStockOnly keeps its broader exclusion vocabulary', async () => {
    await setOffers([
      { id: 'a', price: 1, availability: 'oos' },
      { id: 'b', price: 10, availability: 'in_stock' },
    ]);
    for (const includeSkuOffers of [true, false]) {
      const unscoped = await search(includeSkuOffers);
      expect(unscoped[0].availability).toBe('oos');
      const scoped = await search(includeSkuOffers, { inStockOnly: true });
      expect(scoped[0].availability).toBe('in_stock');
    }
  });
});
