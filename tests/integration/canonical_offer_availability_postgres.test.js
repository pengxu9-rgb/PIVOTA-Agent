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

  test.each([
    ['the synthetic ::canonical sku (variant = product key)', 'product_fixture::canonical', 'product_fixture'],
    ['a NULL-variant sku', 'sku_null_variant', null],
    ['a derived placeholder variant', 'sku_default_variant', 'x-default'],
  ])('at equal price a real variant beats %s, whatever the offer_id order', async (_name, skuKey, variantId) => {
    // bluemercury.com 2026-09-25: the hashed offer_id picked the synthetic sku, and the card carried the
    // product key as its variant, so live price verification reported variant_missing.
    await db.query('INSERT INTO catalog_skus(sku_key, product_key, source_variant_id) VALUES ($1, $2, $3)',
      [skuKey, 'product_fixture', variantId]);
    try {
      await db.query('TRUNCATE catalog_offers');
      for (const [id, sku] of [['a_synthetic', skuKey], ['b_real', 'sku_fixture']]) {
        await db.query(`INSERT INTO catalog_offers(offer_id, sku_key, product_key, merchant_effective_price,
          currency, availability, market) VALUES ($1, $2, 'product_fixture', 46, 'USD', 'in_stock', 'US')`, [id, sku]);
      }
      const rows = await search(true);
      expect(rows).toHaveLength(1);
      expect(rows[0].source_variant_id).toBe('variant_fixture');
      // a tie-break only: a cheaper synthetic offer still wins on price
      await db.query("UPDATE catalog_offers SET merchant_effective_price = 40 WHERE offer_id = 'a_synthetic'");
      const cheaper = await search(true);
      expect(Number(cheaper[0].merchant_effective_price)).toBe(40);
    } finally {
      await db.query('DELETE FROM catalog_skus WHERE sku_key = $1', [skuKey]);
    }
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

// THE CARD SHOWS THE PRODUCT'S BEST OFFER ACROSS ITS LISTINGS (content_key), not the
// best offer inside whichever listing recall happened to rank. Live defect 2026-09-22:
// "Purito Oat-in Calming Gel Cream" served ohlolly.com $21 out_of_stock at #1 while
// sokoglam.com's $19.50 in_stock listing of the same content_key sat at #144.
// These run the production statement on real PostgreSQL; no JS sort stands in for it.
suite('the served listing is the product\'s best offer across its listings', () => {
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
      CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: process.env.CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK,
    };
    for (const flag of Object.keys(previousFlags)) process.env[flag] = 'off';
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `served_listing_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
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
        suppressed_at timestamptz, updated_at timestamptz);
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
    if (previousFlags) {
      for (const [flag, value] of Object.entries(previousFlags)) {
        if (value === undefined) delete process.env[flag];
        else process.env[flag] = value;
      }
    }
  });

  // A listing = one catalog_products row + its merchant + one sku + its offers.
  // `age` orders updated_at (smaller = newer) so the feed's representative is fixed.
  const seed = async (listings) => {
    for (const table of ['catalog_products', 'index_pipeline_state', 'catalog_merchants', 'catalog_skus',
      'catalog_offers', 'external_product_seeds', 'merchant_stores']) {
      await db.query(`TRUNCATE ${table}`);
    }
    const merchants = new Map();
    const contentKeys = new Set();
    for (const [index, l] of listings.entries()) {
      const merchantId = l.merchant || `merch_${l.key}`;
      if (!merchants.has(merchantId)) {
        merchants.set(merchantId, true);
        await db.query(`INSERT INTO catalog_merchants(merchant_id, merchant_name, status) VALUES ($1, $2, $3)`,
          [merchantId, l.merchantName || `${l.key}.example`, l.merchantStatus || 'observed']);
      }
      const contentKey = l.contentKey === undefined ? 'ck_oat' : l.contentKey;
      if (contentKey) contentKeys.add(contentKey);
      await db.query(`INSERT INTO catalog_products(product_key, content_key, merchant_id, platform,
        source_product_id, title, brand, category_path, canonical_url, image_url, pivota_signature_id,
        pivota_canonical_url, product_payload, updated_at, suppressed_at, sync_status, pdp_scope)
        VALUES ($1, $2, $3, $4, $5, $6, 'Purito', 'beauty/skincare/moisturize/cream', $7, $8, $9, $10, $11,
          now() - make_interval(mins => $12::int), $13, $14, 'multi_merchant_canonical')`,
      [l.key, contentKey, merchantId, l.platform || 'external_seed', `src_${l.key}`, l.title,
        l.url === undefined ? `https://${l.key}.example/products/oat` : l.url, `https://cdn.example/${l.key}.jpg`,
        `sig_${l.key}`, `https://agent.example/products/sig_${l.key}`,
        JSON.stringify(l.payload || { seed_data: { destination_url: `https://${l.key}.example/seed`, availability: `seed_${l.key}` } }),
        l.age === undefined ? index : l.age, l.suppressed ? new Date() : null, l.syncStatus || 'live']);
      await db.query(`INSERT INTO catalog_skus(sku_key, product_key, source_variant_id) VALUES ($1, $2, $3)`,
        [`sku_${l.key}`, l.key, `variant_${l.key}`]);
      for (const [i, o] of (l.offers || []).entries()) {
        await db.query(`INSERT INTO catalog_offers(offer_id, sku_key, product_key, merchant_effective_price,
          currency, availability, market) VALUES ($1, $2, $3, $4, 'USD', $5, $6)`,
        [`offer_${l.key}_${i}`, `sku_${l.key}`, l.key, o.price, o.availability === undefined ? null : o.availability,
          o.market || 'US']);
      }
    }
    for (const contentKey of contentKeys) {
      await db.query(`INSERT INTO index_pipeline_state(content_key, serving_eligible, index_eligible)
        VALUES ($1, true, true)`, [contentKey]);
    }
  };

  const search = (includeSkuOffers, extra = {}) => fetchCanonicalChainRows({
    query: 'Oat Gel Cream', marketId: 'US', includeSkuOffers,
    deps: { query: (sql, params) => db.query(sql, params) }, ...extra,
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

  // Every seller-identifying column of the row, and they must all name ONE listing.
  const expectServedListing = (row, key) => {
    expect(row.product_key).toBe(key);
    expect(row.merchant_id).toBe(`merch_${key}`);
    expect(row.merchant_name).toBe(`${key}.example`);
    expect(row.source_product_id).toBe(`src_${key}`);
    expect(row.pivota_signature_id).toBe(`sig_${key}`);
    expect(row.pivota_canonical_url).toBe(`https://agent.example/products/sig_${key}`);
    expect(row.canonical_url).toBe(`https://${key}.example/products/oat`);
    // The payload rides with the listing: the card builder falls back to it for URL/availability.
    expect(row.product_payload.seed_data.destination_url).toBe(`https://${key}.example/seed`);
  };
  const expectServedOffer = (row, key, includeSkuOffers) => {
    if (includeSkuOffers) {
      expect(row.offer_id).toMatch(new RegExp(`^offer_${key}_`));
      expect(row.sku_key).toBe(`sku_${key}`);
      expect(row.source_variant_id).toBe(`variant_${key}`);
    }
  };

  const OHLOLLY = { key: 'ohlolly', title: 'Oat Gel Cream', offers: [
    { price: 21, availability: 'out_of_stock' }, { price: 21, availability: 'out_of_stock' }] };
  // Not recalled: its title does not carry the query. Same content_key.
  const SOKOGLAM = { key: 'sokoglam', title: 'Calming Cream', offers: [
    { price: 19.5, availability: 'in_stock' }, { price: 19.5, availability: 'in_stock' }] };

  test.each([true, false])('ACCEPT flagship: ohlolly $21 out_of_stock + sokoglam $19.50 in_stock -> one sokoglam card (sku offers: %s)', async (includeSkuOffers) => {
    await seed([OHLOLLY, SOKOGLAM]);
    const rows = await search(includeSkuOffers);
    expect(rows).toHaveLength(1);
    expectServedListing(rows[0], 'sokoglam');
    expectServedOffer(rows[0], 'sokoglam', includeSkuOffers);
    expect(Number(rows[0].merchant_effective_price)).toBe(19.5);
    expect(rows[0].availability).toBe('in_stock');
    // What the row EARNED stays: the recalled listing's content and rank.
    expect(rows[0].product_title).toBe('Oat Gel Cream');
    expect(rows[0].content_key).toBe('ck_oat');
    expect(rows[0].recalled_product_key).toBe('ohlolly');
  });

  test('ACCEPT flagship on the index feed: the entry sells from sokoglam', async () => {
    await seed([{ ...OHLOLLY, age: 0 }, { ...SOKOGLAM, age: 5 }]);
    const rows = await feed();
    expect(rows).toHaveLength(1);
    const [entry] = rows;
    // Identity stays with the representative (newest, ohlolly): the entity id and its Pivota PDP.
    expect(entry.product_entity_id).toBe('sig_ohlolly');
    expect(entry.canonical_url).toBe('https://agent.example/products/sig_ohlolly');
    // Every seller field names sokoglam.
    expect(entry.merchant_id).toBe('merch_sokoglam');
    expect(entry.merchant_name).toBe('sokoglam.example');
    expect(entry.source_product_id).toBe('src_sokoglam');
    expect(entry.external_product_id).toBe('src_sokoglam');
    expect(entry.destination_url).toBe('https://sokoglam.example/products/oat');
    expect(entry.domain).toBe('sokoglam.example');
    expect(entry.seed_data.seed_data.destination_url).toBe('https://sokoglam.example/seed');
    expect(Number(entry.price_amount)).toBe(19.5);
    expect(entry.availability).toBe('in_stock');
    expect(entry.seller_count).toBe(2);
  });

  test.each([
    ['cheapest listing out_of_stock loses to a pricier in-stock listing',
      [{ price: 13, availability: 'out_of_stock' }], [{ price: 30, availability: 'in_stock' }], 'sokoglam', 30],
    ['unknown availability is sellable and wins on price',
      [{ price: 10, availability: 'unknown' }], [{ price: 12, availability: 'in_stock' }], 'ohlolly', 10],
    ['NULL availability is sellable and wins on price',
      [{ price: 10, availability: null }], [{ price: 12, availability: 'in_stock' }], 'ohlolly', 10],
    ['every listing out_of_stock: still one card, the cheapest, marked out_of_stock',
      [{ price: 21, availability: 'out_of_stock' }], [{ price: 19.5, availability: 'sold_out' }], 'sokoglam', 19.5],
    ['market preference stays ahead of stock across listings',
      [{ price: 21, availability: 'out_of_stock', market: 'US' }], [{ price: 5, availability: 'in_stock', market: 'CA' }], 'ohlolly', 21],
    ['a listing with no priced offer never wins over a priced one',
      [{ price: 21, availability: 'out_of_stock' }], [{ price: 0, availability: 'in_stock' }], 'ohlolly', 21],
  ])('ACCEPT %s', async (_name, recalledOffers, siblingOffers, winner, price) => {
    await seed([{ ...OHLOLLY, offers: recalledOffers, age: 0 }, { ...SOKOGLAM, offers: siblingOffers, age: 5 }]);
    for (const includeSkuOffers of [true, false]) {
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(1);
      expectServedListing(rows[0], winner);
      expectServedOffer(rows[0], winner, includeSkuOffers);
      expect(Number(rows[0].merchant_effective_price)).toBe(price);
    }
    const entries = await feed();
    expect(entries).toHaveLength(1);
    expect(entries[0].merchant_id).toBe(`merch_${winner}`);
    expect(entries[0].destination_url).toBe(`https://${winner}.example/products/oat`);
    expect(Number(entries[0].price_amount)).toBe(price);
  });

  test('ACCEPT a single-listing product is served from its own listing, exactly as before', async () => {
    await seed([{ ...OHLOLLY, offers: [{ price: 21, availability: 'out_of_stock' }, { price: 18, availability: 'out_of_stock' }] }]);
    for (const includeSkuOffers of [true, false]) {
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(1);
      expectServedListing(rows[0], 'ohlolly');
      expect(rows[0].recalled_product_key).toBe('ohlolly');
      expect(Number(rows[0].merchant_effective_price)).toBe(18);
      expect(rows[0].availability).toBe('out_of_stock');
    }
  });

  test('ACCEPT a NULL content_key is a product of one', async () => {
    await seed([{ ...OHLOLLY, contentKey: null }, { ...SOKOGLAM, contentKey: null }]);
    await db.query(`INSERT INTO index_pipeline_state(content_key, serving_eligible) VALUES (NULL, true)`);
    // NULL never joins index_pipeline_state, so nothing is recalled — and nothing is invented.
    expect(await search(true)).toHaveLength(0);
  });

  test('REFUSE two cards for one product, lost products, or reordering: recalled siblings take distinct listings', async () => {
    // Both listings recalled (both titles carry the query), plus two unrelated products around them.
    await seed([
      { key: 'alpha', title: 'Oat Gel Cream Alpha Edition', contentKey: 'ck_alpha', offers: [{ price: 5, availability: 'in_stock' }] },
      { ...OHLOLLY, title: 'Oat Gel Cream' },
      { ...SOKOGLAM, title: 'Purito Oat Gel Cream Jar' },
      { key: 'omega', title: 'Big Oat Gel Cream Tub', contentKey: 'ck_omega', offers: [{ price: 9, availability: 'out_of_stock' }] },
    ]);
    for (const includeSkuOffers of [true, false]) {
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(4);
      // Order is the recalled rows' earned order: the exact title (+100) first.
      expect(rows.map((row) => row.recalled_product_key)).toEqual(
        [...rows].sort((a, b) => Number(b.rank_score) - Number(a.rank_score)).map((row) => row.recalled_product_key));
      expect(rows[0].recalled_product_key).toBe('ohlolly');
      expect(rows[0].product_title).toBe('Oat Gel Cream');
      // The product's first position sells from its best listing; its second shows the other one.
      expectServedListing(rows[0], 'sokoglam');
      expect(rows[0].availability).toBe('in_stock');
      const oatRows = rows.filter((row) => row.content_key === 'ck_oat');
      expect(oatRows).toHaveLength(2);
      expect(oatRows.map((row) => row.product_key).sort()).toEqual(['ohlolly', 'sokoglam']);
      expectServedListing(oatRows[1], 'ohlolly');
      // Unrelated products: untouched, one row each.
      for (const key of ['alpha', 'omega']) {
        const own = rows.filter((row) => row.content_key === `ck_${key}`);
        expect(own).toHaveLength(1);
        expectServedListing(own[0], key);
      }
    }
  });

  test('REFUSE losing a product: a RECALLED listing that fails a sibling-only filter still keeps its row', async () => {
    // Recall itself does not read sync_status, so a stale listing can be recalled today. It must
    // stay in its own product's pool, or the second slot would find no listing and the row would vanish.
    await seed([
      { ...OHLOLLY, title: 'Oat Gel Cream' },
      { ...SOKOGLAM, title: 'Purito Oat Gel Cream Jar', syncStatus: 'stale' },
    ]);
    for (const includeSkuOffers of [true, false]) {
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.product_key).sort()).toEqual(['ohlolly', 'sokoglam']);
      expect(rows.map((row) => row.recalled_product_key).sort()).toEqual(['ohlolly', 'sokoglam']);
    }
  });

  test.each([
    ['a suppressed listing', { suppressed: true }],
    ['a non-live (stale) listing', { syncStatus: 'stale' }],
    ['an archived listing', { syncStatus: 'archived' }],
    ['a test/demo merchant', { merchant: 'merch_test_ownist_001' }],
    ['an inactive merchant', { merchantStatus: 'suspended' }],
    ['a source-unavailable external seed', { payload: { source_unavailable_v1: { status: 'source_unavailable' },
      seed_data: { destination_url: 'https://sokoglam.example/seed' } } }],
  ])('REFUSE an offer from %s — the recalled listing keeps the card', async (_name, overrides) => {
    await seed([OHLOLLY, { ...SOKOGLAM, ...overrides }]);
    for (const includeSkuOffers of [true, false]) {
      const rows = await search(includeSkuOffers);
      expect(rows).toHaveLength(1);
      expectServedListing(rows[0], 'ohlolly');
      expect(rows[0].availability).toBe('out_of_stock');
    }
  });

  test('REFUSE a sibling outside the request\'s merchant scope', async () => {
    await seed([{ ...OHLOLLY, merchant: 'merch_ohlolly' }, SOKOGLAM]);
    const rows = await search(true, { merchantId: 'merch_ohlolly' });
    expect(rows).toHaveLength(1);
    expectServedListing(rows[0], 'ohlolly');
  });

  test('REFUSE a sibling whose only offer is outside the request\'s offer scope (currency / market)', async () => {
    await seed([
      { ...OHLOLLY, offers: [{ price: 21, availability: 'out_of_stock', market: 'US' }] },
      { ...SOKOGLAM, offers: [{ price: 19.5, availability: 'in_stock', market: 'GB' }] },
    ]);
    // No market PREFERENCE here, so only the scope can keep the in-stock sibling out.
    const rows = await search(true, { marketId: null, offerScope: { markets: ['US'] } });
    expect(rows).toHaveLength(1);
    expectServedListing(rows[0], 'ohlolly');
    // Control: the same sibling IS eligible when the scope admits its market.
    const widened = await search(true, { marketId: null, offerScope: { markets: ['US', 'GB'] } });
    expectServedListing(widened[0], 'sokoglam');
  });

  test('REFUSE a sibling outside the request\'s market (external seed with no matching seed market)', async () => {
    await seed([OHLOLLY, SOKOGLAM]);
    // marketWhere exempts multi_merchant_canonical rows; make the sibling a plain external seed row
    // whose seed market is KR, so it fails the SAME market clause the recalled row passes.
    await db.query(`UPDATE catalog_products SET pdp_scope = NULL WHERE product_key = 'sokoglam'`);
    await db.query(`UPDATE catalog_products SET pdp_scope = NULL WHERE product_key = 'ohlolly'`);
    await db.query(`INSERT INTO external_product_seeds(external_product_id, market) VALUES ('src_ohlolly', 'US'), ('src_sokoglam', 'KR')`);
    const rows = await search(true);
    expect(rows).toHaveLength(1);
    expectServedListing(rows[0], 'ohlolly');
    await db.query(`UPDATE external_product_seeds SET market = 'US' WHERE external_product_id = 'src_sokoglam'`);
    expectServedListing((await search(true))[0], 'sokoglam');
  });
});
