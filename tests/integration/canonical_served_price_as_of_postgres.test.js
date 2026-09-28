const { Client } = require('pg');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');

// The served price's as-of and confidence come off the SAME offer row the amount does -- the one
// the best-offer LATERAL picked, across the product's listings (#2258). Run on real PostgreSQL; no JS
// stands in for the LATERAL's choice. Opt-in like the other canonical SQL suites.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const FLAGS = [
  'CANONICAL_CATALOG_SERVED_PRICE_AS_OF',
  'CANONICAL_CATALOG_RANK_V2',
  'CANONICAL_CATALOG_RECALL_DOC_MATCH',
  'CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION',
  'CANONICAL_CATALOG_SET_DIVERSITY',
  'SEARCH_NAME_EVIDENCE_ADMISSION',
  'CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK',
];

const CHECKED_OHLOLLY = '2026-09-27T05:15:00.000Z';
const CHECKED_SOKOGLAM = '2026-09-01T05:15:00.000Z';

suite('the served price states when it was read, off the served offer row', () => {
  let db;
  let schema;
  let previousFlags;

  beforeAll(async () => {
    previousFlags = Object.fromEntries(FLAGS.map((flag) => [flag, process.env[flag]]));
    for (const flag of FLAGS) process.env[flag] = 'off';
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `served_price_as_of_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // catalog_offers starts WITHOUT price_checked_at: prod's shape until the backend migration lands.
    await db.query(`
      CREATE TABLE catalog_products(product_key text, content_key text, merchant_id text, platform text,
        source_product_id text, title text, description text, brand text, product_type text, category text,
        category_path text, canonical_url text, image_url text, catalog_track text, truth_tier text,
        readiness_tier text, pdp_scope text, source_system text, product_payload jsonb, freshness_json jsonb,
        pivota_signature_id text, pivota_canonical_url text, pivota_signature_minted_at timestamptz,
        pdp_lifecycle_stage text, material text, material_source text, material_confidence numeric,
        care text, care_source text, care_confidence numeric, size_guide text, size_guide_source text,
        size_guide_confidence numeric, updated_at timestamptz, recall_doc text, recall_market text,
        source_domain text, status text, suppressed_at timestamptz, sync_status text);
      CREATE TABLE index_pipeline_state(content_key text, serving_eligible boolean, index_eligible boolean);
      CREATE TABLE catalog_merchants(merchant_id text, merchant_name text, primary_platform text, status text);
      CREATE TABLE catalog_skus(sku_key text, product_key text, source_variant_id text, sku text, barcode text,
        title text, visible_attributes jsonb, visible_option_labels jsonb, ingredient_ids jsonb,
        image_url text, suppressed_at timestamptz);
      CREATE TABLE catalog_offers(offer_id text, sku_key text, product_key text, catalog_track text,
        truth_tier text, readiness_tier text, offer_mode text, availability text, inventory_quantity numeric,
        currency text, list_price numeric, merchant_effective_price numeric, estimated_best_price numeric,
        price_confidence numeric, source_system text, offer_payload jsonb, market text,
        suppressed_at timestamptz, updated_at timestamp);
      CREATE TABLE external_product_seeds(id text, external_product_id text, market text, tool text,
        destination_url text, canonical_url text, domain text, title text, image_url text,
        price_amount numeric, price_currency text, availability text, seed_data jsonb,
        updated_at timestamptz, created_at timestamptz, status text, attached_product_key text);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text,
        product_group_id text, is_primary boolean);
    `);
  });

  afterAll(async () => {
    if (db) {
      if (schema) await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
    for (const [flag, value] of Object.entries(previousFlags || {})) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
  });

  afterEach(() => {
    process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF = 'off';
    require('../../src/services/canonicalCatalogSearch').__internal.servedPriceAsOfState.unavailableUntil = 0;
  });

  // A listing = one catalog_products row + its merchant + one sku + its offers. Every offer's
  // updated_at is NEWER than any price_checked_at: a row-write stamp must never be what surfaces.
  const seed = async (listings, { withCheckedAt }) => {
    for (const table of ['catalog_products', 'index_pipeline_state', 'catalog_merchants', 'catalog_skus',
      'catalog_offers']) {
      await db.query(`TRUNCATE ${table}`);
    }
    for (const [index, l] of listings.entries()) {
      await db.query(`INSERT INTO catalog_merchants(merchant_id, merchant_name, status) VALUES ($1, $2, 'observed')`,
        [`merch_${l.key}`, `${l.key}.example`]);
      await db.query(`INSERT INTO catalog_products(product_key, content_key, merchant_id, platform,
        source_product_id, title, brand, category_path, canonical_url, image_url, pivota_signature_id,
        product_payload, updated_at, sync_status, pdp_scope)
        VALUES ($1, 'ck_oat', $2, 'external_seed', $3, $4, 'Purito', 'beauty/skincare/moisturize/cream',
          $5, $6, $7, '{}'::jsonb, now() - make_interval(mins => $8::int), 'live', 'multi_merchant_canonical')`,
      [l.key, `merch_${l.key}`, `src_${l.key}`, l.title, `https://${l.key}.example/products/oat`,
        `https://cdn.example/${l.key}.jpg`, `sig_${l.key}`, index]);
      await db.query(`INSERT INTO catalog_skus(sku_key, product_key, source_variant_id) VALUES ($1, $2, $3)`,
        [`sku_${l.key}`, l.key, `variant_${l.key}`]);
      for (const [i, o] of l.offers.entries()) {
        const columns = ['offer_id', 'sku_key', 'product_key', 'merchant_effective_price', 'currency',
          'availability', 'market', 'price_confidence', 'updated_at'];
        const values = [`offer_${l.key}_${i}`, `sku_${l.key}`, l.key, o.price, 'USD', o.availability, 'US',
          o.confidence, '2026-09-28 06:00:00'];
        if (withCheckedAt) {
          columns.push('price_checked_at');
          values.push(o.checkedAt);
        }
        await db.query(`INSERT INTO catalog_offers(${columns.join(', ')})
          VALUES (${columns.map((_, n) => `$${n + 1}`).join(', ')})`, values);
      }
    }
    await db.query(`INSERT INTO index_pipeline_state(content_key, serving_eligible, index_eligible)
      VALUES ('ck_oat', true, true)`);
  };

  const search = (includeSkuOffers) => fetchCanonicalChainRows({
    query: 'Oat Gel Cream', marketId: 'US', includeSkuOffers,
    deps: { query: (sql, params) => db.query(sql, params) },
  });

  // Recalled on its title, newest check, but out of stock at $21.
  const OHLOLLY = { key: 'ohlolly', title: 'Oat Gel Cream', offers: [
    { price: 21, availability: 'out_of_stock', confidence: 0.95, checkedAt: CHECKED_OHLOLLY }] };
  // Same content_key, not recalled, in stock at $19.50: the listing the card sells from. Its pricier
  // second offer carries a newer check that must NOT date the $19.50.
  const SOKOGLAM = { key: 'sokoglam', title: 'Calming Cream', offers: [
    { price: 19.5, availability: 'in_stock', confidence: 0.6, checkedAt: CHECKED_SOKOGLAM },
    { price: 24, availability: 'in_stock', confidence: 0.9, checkedAt: CHECKED_OHLOLLY }] };

  test.each([true, false])('flag OFF: the SQL never names price_checked_at, so prod\'s schema serves (sku offers: %s)', async (includeSkuOffers) => {
    await seed([OHLOLLY, SOKOGLAM], { withCheckedAt: false });
    const rows = await search(includeSkuOffers);
    expect(rows).toHaveLength(1);
    expect(rows[0].product_key).toBe('sokoglam');
    expect(Number(rows[0].merchant_effective_price)).toBe(19.5);
    expect(rows[0]).not.toHaveProperty('price_checked_at');
    // BOTH branches carry the served offer's own confidence. The no-sku branch used to hardcode
    // NULL::text, so a product served through it could never carry one.
    expect(Number(rows[0].price_confidence)).toBe(0.6);
  });

  test('flag ON before the backend migration degrades: the price serves, the as-of waits', async () => {
    const { __internal: { servedPriceAsOfState } } = require('../../src/services/canonicalCatalogSearch');
    await seed([OHLOLLY, SOKOGLAM], { withCheckedAt: false });
    process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF = 'on';
    servedPriceAsOfState.unavailableUntil = 0;
    const statements = [];
    const rows = await fetchCanonicalChainRows({
      query: 'Oat Gel Cream', marketId: 'US', includeSkuOffers: true,
      deps: { query: (sql, params) => { statements.push(sql); return db.query(sql, params); } },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].merchant_effective_price)).toBe(19.5);
    expect(rows[0]).not.toHaveProperty('price_checked_at');
    // the armed statement, rejected; then the same query without the column
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('price_checked_at');
    expect(statements[1]).not.toContain('price_checked_at');
    // latched: the next request does not pay for the rejected statement again
    statements.length = 0;
    await fetchCanonicalChainRows({
      query: 'Oat Gel Cream', marketId: 'US', includeSkuOffers: true,
      deps: { query: (sql, params) => { statements.push(sql); return db.query(sql, params); } },
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('price_checked_at');
    servedPriceAsOfState.unavailableUntil = 0;
  });

  describe('with the backend column', () => {
    beforeAll(async () => {
      await db.query('ALTER TABLE catalog_offers ADD COLUMN price_checked_at timestamptz');
    });

    test.each([true, false])('the as-of and confidence are the SERVED offer\'s: sibling listing, cheaper offer (sku offers: %s)', async (includeSkuOffers) => {
      await seed([OHLOLLY, SOKOGLAM], { withCheckedAt: true });
      process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF = 'on';
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(1);
      expect(rows[0].product_key).toBe('sokoglam');
      expect(rows[0].recalled_product_key).toBe('ohlolly');
      expect(Number(rows[0].merchant_effective_price)).toBe(19.5);
      // pg returns timestamptz as a Date; the card mapper accepts one.
      expect(rows[0].price_checked_at).toBeInstanceOf(Date);
      expect(rows[0].price_checked_at.toISOString()).toBe(CHECKED_SOKOGLAM);
      expect(Number(rows[0].price_confidence)).toBe(0.6);
    });

    test.each([true, false])('an offer never checked carries NULL, not its updated_at (sku offers: %s)', async (includeSkuOffers) => {
      await seed([{ ...SOKOGLAM, title: 'Oat Gel Cream', offers: [
        { price: 19.5, availability: 'in_stock', confidence: null, checkedAt: null }] }],
        { withCheckedAt: true });
      process.env.CANONICAL_CATALOG_SERVED_PRICE_AS_OF = 'on';
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].merchant_effective_price)).toBe(19.5);
      expect(rows[0].price_checked_at).toBeNull();
      expect(rows[0].price_confidence).toBeNull();
    });
  });
});
