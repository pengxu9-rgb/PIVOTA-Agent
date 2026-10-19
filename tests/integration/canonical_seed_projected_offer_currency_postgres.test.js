const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

// A SEED-PROJECTED OFFER IS A PRICE ONLY IN THE CURRENCY ITS SEED STATES (seedSearchOfferScope.
// seedProjectedOfferInSeedCurrencySql), on the REAL invoke route, with the production statement
// executed by real PostgreSQL. Peng 2026-10-19: a price's currency is the buyer market's, never
// defaulted, never relabelled.
//
// The skintific rows are prod's own shape (read-only probe skin-probe-1019, 2026-10-19): US
// search_catalog served sig_8b0c02f9bc41ac3f07a9b9cd64efc3a4 at "USD 23.56" off variant offers the
// variant-identity backfill wrote on 09-10 from seed_data.variants, while the seed itself has since
// been re-read in AUD (column AUD 56, snapshot AUD 57) and the canonical mirror offer is AUD 56. The
// nourwish row is the writers' old `or 'USD'` stamp: a USD mirror offer on a seed priced in SGD.
//
// The seed's currency is its snapshot's (the page as read), else its column; seed_data.price_currency
// is a writer-defaulted copy and is not evidence. Every refusal has a USD control on the same page,
// so an empty page can never pass for a refusal; and a Shopify-Markets USD sibling (its own read of
// the store's US price) on a non-USD seed is served, because only offers COPIED off a seed are judged
// by the seed.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const SKIN_PK = 'prod::external_seed::external_seed::ext_d7ce5dea9d90103468e9640d';
const SKIN_URL = 'https://skintific.com/products/glow-cushion-peptide-lip-serum-set-2pcs';

suite('seed-projected offers are prices only in their seed currency, real PostgreSQL', () => {
  let db, schema, priorEnv, app, sqlCalls;

  const product = async ({ key, title, merchant, domain, seedId, contentKey, sig, category = 'beauty/skincare/treat/serum', type = 'Serum' }) => {
    await db.query(`INSERT INTO catalog_products(product_key,merchant_id,platform,source_system,source_product_id,source_ref,
      source_domain,title,brand,product_type,category_path,content_key,pivota_signature_id,pivota_canonical_url,canonical_url,
      image_url,catalog_track,sync_status,updated_at)
      VALUES ($1,$2,'external_seed','external_product_seeds_mirror_v1',$3,$4,$5,$6,'SKINTIFIC',$7,$8,$9,$10,$11,$12,$13,
        'external_referral','live',now())`,
    [key, merchant, key.split('::').pop(), seedId, domain, title, type, category, contentKey, sig,
      `https://agent.pivota.cc/products/${sig}`, `https://${domain}/products/${contentKey}`, `https://cdn.example/${contentKey}.jpg`]);
    await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible) VALUES ($1,true)', [contentKey]);
  };
  const sku = (skuKey, productKey, variantId) => db.query(
    'INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$2,$3)', [skuKey, productKey, variantId]);
  const offer = ({ id, skuKey, productKey, merchant, currency, price, sourceSystem, sourceRef, domain }) => db.query(
    `INSERT INTO catalog_offers(offer_id,sku_key,product_key,merchant_id,market,currency,list_price,merchant_effective_price,
      availability,offer_type,offer_mode,catalog_track,source_system,source_ref,source_domain,updated_at)
     VALUES ($1,$2,$3,$4,'US',$5,$6,$6,'in_stock','brand_direct','redirect','external_referral',$7,$8,$9,now())`,
    [id, skuKey, productKey, merchant, currency, price, sourceSystem, sourceRef, domain]);
  const seed = ({ id, attached, priceAmount, priceCurrency, seedData }) => db.query(
    `INSERT INTO external_product_seeds(id,external_product_id,attached_product_key,status,market,price_amount,price_currency,seed_data)
     VALUES ($1,$2,$3,'active','US',$4,$5,$6)`,
    [id, attached.split('::').pop(), attached, priceAmount, priceCurrency, JSON.stringify(seedData)]);

  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `seed_projected_ccy_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // Materialize exactly the columns the production statement references (the main-catalog suite's
    // method), so every predicate below is PostgreSQL's, not a reimplementation.
    let sql;
    await fetchCanonicalChainRows({ query: 'skintific lip serum', includeSkuOffers: true, marketId: 'US',
      offerScope: { markets: ['US'], currency: 'USD' },
      searchQualityContract: buildSearchQualityContract({ rawQuery: 'skintific lip serum' }),
      deps: { query: async (text) => { sql = text; return { rows: [] }; } } });
    const tables = {};
    for (const match of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
      const [, table, alias] = match; tables[table] ||= new Set();
      for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) tables[table].add(ref[1]);
    }
    for (const col of ['serving_eligible', 'content_key']) tables.index_pipeline_state.add(col);
    for (const col of ['id', 'external_product_id', 'attached_product_key', 'status', 'market', 'price_amount', 'price_currency', 'seed_data']) {
      tables.external_product_seeds.add(col);
    }
    for (const col of ['product_key', 'merchant_id', 'market', 'source_system', 'source_ref', 'source_domain', 'offer_type', 'updated_at']) {
      tables.catalog_offers.add(col);
    }
    for (const col of ['source_system', 'source_ref', 'source_domain', 'catalog_track', 'sync_status']) tables.catalog_products.add(col);
    for (const [table, cols] of Object.entries(tables)) {
      const definitions = [...cols].map((col) => {
        const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
          : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
            : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|price_amount|.*confidence)$/.test(col) ? 'numeric'
              : /(_at)$/.test(col) ? 'timestamptz' : 'text';
        return `${col} ${type}`;
      });
      await db.query(`CREATE TABLE ${table} (${definitions.join(',')})`);
    }

    // 1. skintific.com, prod's rows: a re-read AUD seed whose payload and variants still say USD 23.56.
    await product({ key: SKIN_PK, title: 'Glow Cushion & Peptide Lip Serum Set 2pcs', merchant: 'merch_obs_9cbce09d1019844b',
      domain: 'skintific.com', seedId: 'eps_e49ba92834d24bac922e80cf', contentKey: 'ck_886037a7e0db98c316caebdd26f5cd20',
      sig: 'sig_8b0c02f9bc41ac3f07a9b9cd64efc3a4' });
    await sku(`${SKIN_PK}::canonical`, SKIN_PK, SKIN_PK);
    await offer({ id: 'offer:external_seed:8324e856d975c44b2e40fce16ae1ab89', skuKey: `${SKIN_PK}::canonical`, productKey: SKIN_PK,
      merchant: 'merch_obs_9cbce09d1019844b', currency: 'AUD', price: 56, sourceSystem: 'external_product_seeds_mirror_v1',
      sourceRef: 'eps_e49ba92834d24bac922e80cf', domain: 'skintific.com' });
    for (const variant of ['42706501599337', '42706501632105']) {
      await sku(`${SKIN_PK}::v::${variant}`, SKIN_PK, variant);
      await offer({ id: `offer:variant:${variant}`, skuKey: `${SKIN_PK}::v::${variant}`, productKey: SKIN_PK,
        merchant: 'merch_obs_9cbce09d1019844b', currency: 'USD', price: 23.56, sourceSystem: 'variant_identity_backfill_v1',
        sourceRef: SKIN_URL, domain: 'skintific.com' });
    }
    await seed({ id: 'eps_e49ba92834d24bac922e80cf', attached: SKIN_PK, priceAmount: 56, priceCurrency: 'AUD', seedData: {
      price_amount: '23.56', price_currency: 'USD',
      snapshot: { price_amount: '57.0', price_currency: 'AUD' },
      variants: [{ variant_id: '42706501599337', price: '23.56', currency: 'USD' }, { variant_id: '42706501632105', price: '23.56', currency: 'USD' }],
    } });

    // 2. CONTROL: a USD seed that kept no snapshot currency (its column stands in), mirrored at USD 18.
    const ctlPk = 'prod::merch_obs_ctl::external_seed::ext_ctl_usd';
    await product({ key: ctlPk, title: 'Hyaluronic Water Serum', merchant: 'merch_obs_ctl', domain: 'us.skintific.example',
      seedId: 'eps_ctl_usd', contentKey: 'ck_ctl_usd', sig: 'sig_ctl_usd' });
    await sku(`${ctlPk}::canonical`, ctlPk, ctlPk);
    await offer({ id: 'offer:ctl_usd', skuKey: `${ctlPk}::canonical`, productKey: ctlPk, merchant: 'merch_obs_ctl', currency: 'USD',
      price: 18, sourceSystem: 'external_product_seeds_mirror_v1', sourceRef: 'eps_ctl_usd', domain: 'us.skintific.example' });
    await seed({ id: 'eps_ctl_usd', attached: ctlPk, priceAmount: 18, priceCurrency: 'USD',
      seedData: { price_amount: '18', price_currency: 'USD', snapshot: { price_amount: '18' } } });

    // 3. A Shopify-Markets USD sibling on an SGD seed: the store's own US price, not a copy of the seed's.
    const mktPk = 'prod::merch_obs_mkt::external_seed::ext_mkt_sgd';
    await product({ key: mktPk, title: 'Ceramide Barrier Serum', merchant: 'merch_obs_mkt', domain: 'sg.skintific.example',
      seedId: 'eps_mkt_sgd', contentKey: 'ck_mkt_sgd', sig: 'sig_mkt_sgd' });
    await sku(`${mktPk}::canonical`, mktPk, mktPk);
    await offer({ id: 'offer:mkt_usd', skuKey: `${mktPk}::canonical`, productKey: mktPk, merchant: 'merch_obs_mkt', currency: 'USD',
      price: 30, sourceSystem: 'shopify_markets_us_localization', sourceRef: 'https://sg.skintific.example/products/mini', domain: 'sg.skintific.example' });
    // ...beside a CHEAPER USD row the mirror stamped off that SGD seed: the offer pick must pass it over.
    await sku(`${mktPk}::v::mirror`, mktPk, 'mirror');
    await offer({ id: 'offer:mkt_mirror_usd', skuKey: `${mktPk}::v::mirror`, productKey: mktPk, merchant: 'merch_obs_mkt', currency: 'USD',
      price: 25, sourceSystem: 'external_product_seeds_mirror_v1', sourceRef: 'eps_mkt_sgd', domain: 'sg.skintific.example' });
    await seed({ id: 'eps_mkt_sgd', attached: mktPk, priceAmount: 40, priceCurrency: 'SGD',
      seedData: { price_amount: '40', price_currency: 'SGD', snapshot: { price_amount: '40', price_currency: 'SGD' } } });

    // 4. nourwish.com's shape: a USD mirror offer (the writer's old `or 'USD'`) on a seed priced in SGD.
    const nwPk = 'prod::external_seed::external_seed::ext_nourwish_sgd';
    await product({ key: nwPk, title: 'Niacinamide Pore Serum', merchant: 'merch_obs_nourwish', domain: 'nourwish.com',
      seedId: 'eps_nourwish_sgd', contentKey: 'ck_nourwish_sgd', sig: 'sig_nourwish_sgd' });
    await sku(`${nwPk}::canonical`, nwPk, nwPk);
    await offer({ id: 'offer:nourwish_usd', skuKey: `${nwPk}::canonical`, productKey: nwPk, merchant: 'merch_obs_nourwish', currency: 'USD',
      price: 38, sourceSystem: 'external_product_seeds_mirror_v1', sourceRef: 'eps_nourwish_sgd', domain: 'nourwish.com' });
    await seed({ id: 'eps_nourwish_sgd', attached: nwPk, priceAmount: 38, priceCurrency: 'SGD',
      seedData: { price_amount: '38', price_currency: 'SGD', snapshot: { price_amount: '38', price_currency: 'SGD' } } });

    // 5. The census's commonest disagreement (2026-10-19: 367 active seeds): the column says USD (the
    // writers' old default) while the page was read in QAR; the mirror offer copied the column.
    const qarPk = 'prod::merch_obs_qar::external_seed::ext_qar_page';
    await product({ key: qarPk, title: 'Vitamin C Glow Serum', merchant: 'merch_obs_qar', domain: 'qa.skintific.example',
      seedId: 'eps_qar_page', contentKey: 'ck_qar_page', sig: 'sig_qar_page' });
    await sku(`${qarPk}::canonical`, qarPk, qarPk);
    await offer({ id: 'offer:qar_usd', skuKey: `${qarPk}::canonical`, productKey: qarPk, merchant: 'merch_obs_qar', currency: 'USD',
      price: 95, sourceSystem: 'external_product_seeds_mirror_v1', sourceRef: 'eps_qar_page', domain: 'qa.skintific.example' });
    await seed({ id: 'eps_qar_page', attached: qarPk, priceAmount: 95, priceCurrency: 'USD',
      seedData: { price_amount: '95', snapshot: { price_amount: '95', price_currency: 'QAR' } } });

    // 6. CONTROL, glowrecipe.com's shape: page read and column both USD, seed_data's copy says EUR.
    // seed_data.price_currency is a copy the writers default, not a read, so it does not refuse.
    const grPk = 'prod::merch_obs_gr::external_seed::ext_gr_usd';
    await product({ key: grPk, title: 'Watermelon Dew Serum', merchant: 'merch_obs_gr', domain: 'glowrecipe.example',
      seedId: 'eps_gr_usd', contentKey: 'ck_gr_usd', sig: 'sig_gr_usd' });
    await sku(`${grPk}::canonical`, grPk, grPk);
    await offer({ id: 'offer:gr_usd', skuKey: `${grPk}::canonical`, productKey: grPk, merchant: 'merch_obs_gr', currency: 'USD',
      price: 35, sourceSystem: 'external_product_seeds_mirror_v1', sourceRef: 'eps_gr_usd', domain: 'glowrecipe.example' });
    await seed({ id: 'eps_gr_usd', attached: grPk, priceAmount: 35, priceCurrency: 'USD',
      seedData: { price_amount: '35', price_currency: 'EUR', snapshot: { price_amount: '35', price_currency: 'USD' } } });

    // 7. An offer no seed-copying writer wrote (source_system NULL) is not judged, even on a listing
    // whose seed reads another currency.
    const nsPk = 'prod::merch_obs_ns::external_seed::ext_null_source';
    await product({ key: nsPk, title: 'Panthenol Repair Serum', merchant: 'merch_obs_ns', domain: 'ns.skintific.example',
      seedId: 'eps_ns', contentKey: 'ck_null_source', sig: 'sig_null_source' });
    await sku(`${nsPk}::canonical`, nsPk, nsPk);
    await offer({ id: 'offer:ns_usd', skuKey: `${nsPk}::canonical`, productKey: nsPk, merchant: 'merch_obs_ns', currency: 'USD',
      price: 44, sourceSystem: null, sourceRef: null, domain: 'ns.skintific.example' });
    await seed({ id: 'eps_ns', attached: nsPk, priceAmount: 60, priceCurrency: 'AUD',
      seedData: { snapshot: { price_amount: '60', price_currency: 'AUD' } } });
    // 8. The offer's currency is compared trimmed and upper-cased, as every reader spells it.
    const lcPk = 'prod::merch_obs_lc::external_seed::ext_lower_currency';
    await product({ key: lcPk, title: 'Mugwort Calming Serum', merchant: 'merch_obs_lc', domain: 'lc.skintific.example',
      seedId: 'eps_lc', contentKey: 'ck_lower_currency', sig: 'sig_lower_currency' });
    await sku(`${lcPk}::canonical`, lcPk, lcPk);
    await offer({ id: 'offer:lc_usd', skuKey: `${lcPk}::canonical`, productKey: lcPk, merchant: 'merch_obs_lc', currency: 'usd ',
      price: 41, sourceSystem: 'external_product_seeds_mirror_v1', sourceRef: 'eps_lc', domain: 'lc.skintific.example' });
    await seed({ id: 'eps_lc', attached: lcPk, priceAmount: 41, priceCurrency: 'USD',
      seedData: { snapshot: { price_amount: '41', price_currency: 'USD' } } });
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });
  beforeEach(() => {
    priorEnv = { ...process.env }; jest.resetModules(); sqlCalls = [];
    Object.assign(process.env, { DATABASE_URL: url, PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      INDEX_ELIGIBLE_RECALL: 'false', PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false',
      CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', SERVE_LIVE_MERCHANT_PRICE: 'false' });
    nock.disableNetConnect(); nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query: async (sql, params) => {
      if (sql.includes('candidate_products AS') && sql.includes('ips.serving_eligible')) {
        sqlCalls.push({ sql, params });
        return db.query(sql, params);
      }
      return { rows: [] }; // no seed-lane / cache / rescue rows: the canonical route alone prices the page
    } }));
    app = require('../../src/server');
  });
  afterEach(() => { process.env = priorEnv; jest.dontMock('../../src/db'); jest.resetModules(); nock.cleanAll(); nock.enableNetConnect(); });

  const invoke = (query) => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi',
    payload: { search: { query, domain: 'beauty', market: 'US', limit: 10 } }, metadata: { source: 'public_api', market: 'US' } });
  const keys = (body) => (body.products || []).map((p) => p.product_key);

  // The incident query on the skintific set alone: the page ranker demotes a 2-piece set beside
  // single products, which would hide the set whether or not its price were refused.
  const skintificAlone = async (fn) => {
    await db.query("UPDATE index_pipeline_state SET serving_eligible = (content_key = 'ck_886037a7e0db98c316caebdd26f5cd20')");
    try { return await fn(); } finally { await db.query('UPDATE index_pipeline_state SET serving_eligible = TRUE'); }
  };

  test('the incident query: no USD 23.56 card for the AUD-read skintific set', async () => {
    const res = await skintificAlone(() => invoke('skintific glow cushion peptide lip serum set'));
    expect(res.status).toBe(200);
    expect(sqlCalls).toHaveLength(1);
    expect(keys(res.body)).not.toContain(SKIN_PK);
    expect((res.body.products || []).some((p) => Number(p.price) === 23.56)).toBe(false);
  });

  test('a brand query keeps the controls and refuses both seed-currency violations', async () => {
    const res = await invoke('skintific serum');
    expect(res.status).toBe(200);
    const served = Object.fromEntries((res.body.products || []).map((p) => [p.product_key, [Number(p.price), p.currency]]));
    expect(served['prod::merch_obs_ctl::external_seed::ext_ctl_usd']).toEqual([18, 'USD']);
    expect(served['prod::merch_obs_mkt::external_seed::ext_mkt_sgd']).toEqual([30, 'USD']);
    expect(served['prod::merch_obs_gr::external_seed::ext_gr_usd']).toEqual([35, 'USD']);
    expect(served['prod::merch_obs_ns::external_seed::ext_null_source']).toEqual([44, 'USD']);
    expect(served['prod::merch_obs_lc::external_seed::ext_lower_currency']?.[0]).toBe(41);
    expect(served).not.toHaveProperty([SKIN_PK]);
    expect(served).not.toHaveProperty(['prod::external_seed::external_seed::ext_nourwish_sgd']);
    expect(served).not.toHaveProperty(['prod::merch_obs_qar::external_seed::ext_qar_page']);
    // Refused BEFORE the candidate LIMIT, not after it: a product whose only USD offers are refused
    // never takes a candidate slot from a priceable one (canonical_raw_count is the SQL's row count).
    expect(res.body.metadata.canonical_raw_count).toBe(5);
  });

  test('the same skintific set is served once its seed agrees with the offer it projected', async () => {
    try {
      await db.query(`UPDATE external_product_seeds SET price_amount=23.56, price_currency='USD',
        seed_data = jsonb_set(seed_data, '{snapshot,price_currency}', '"USD"') WHERE id='eps_e49ba92834d24bac922e80cf'`);
      const res = await skintificAlone(() => invoke('skintific glow cushion peptide lip serum set'));
      const card = (res.body.products || []).find((p) => p.product_key === SKIN_PK);
      expect(card).toBeDefined();
      expect([Number(card.price), card.currency]).toEqual([23.56, 'USD']);
    } finally {
      await db.query(`UPDATE external_product_seeds SET price_amount=56, price_currency='AUD',
        seed_data = jsonb_set(seed_data, '{snapshot,price_currency}', '"AUD"') WHERE id='eps_e49ba92834d24bac922e80cf'`);
    }
  });

  // PR controller review of #2467: with no active seed behind it, a projected offer is an orphan of a
  // read nobody holds any more, and is refused like a disagreeing one. Each case starts from the
  // skintific seed made to AGREE (USD everywhere), so a refusal is the case's doing, not the AUD read.
  const SKIN_SEED = 'eps_e49ba92834d24bac922e80cf';
  const AGREEING = { price_amount: '23.56', price_currency: 'USD', snapshot: { price_amount: '23.56', price_currency: 'USD' } };
  const resetSkintificSeed = async ({ agree }) => {
    await db.query("DELETE FROM external_product_seeds WHERE id LIKE 'eps_extra_%'");
    await db.query(`UPDATE external_product_seeds SET status='active', attached_product_key=$1, price_amount=$2, price_currency=$3,
      seed_data=$4::jsonb WHERE id=$5`, agree
      ? [SKIN_PK, 23.56, 'USD', JSON.stringify(AGREEING), SKIN_SEED]
      : [SKIN_PK, 56, 'AUD', JSON.stringify({ price_amount: '23.56', price_currency: 'USD',
        snapshot: { price_amount: '57.0', price_currency: 'AUD' },
        variants: [{ variant_id: '42706501599337', price: '23.56', currency: 'USD' }, { variant_id: '42706501632105', price: '23.56', currency: 'USD' }] }), SKIN_SEED]);
  };
  const extraSeed = (id, currency) => db.query(
    `INSERT INTO external_product_seeds(id,external_product_id,attached_product_key,status,market,price_amount,price_currency,seed_data)
     VALUES ($1,$1,$2,'active','US',23.56,$3,$4::jsonb)`,
    [id, SKIN_PK, currency, JSON.stringify({ snapshot: { price_currency: currency } })]);
  test.each([
    ['its seed retired (status inactive)', false, () => db.query("UPDATE external_product_seeds SET status='inactive' WHERE id=$1", [SKIN_SEED])],
    ['its seed detached to another listing', false, () => db.query("UPDATE external_product_seeds SET attached_product_key='prod::elsewhere' WHERE id=$1", [SKIN_SEED])],
    ["its seed's status spelled 'ACTIVE '", true, () => db.query("UPDATE external_product_seeds SET status='ACTIVE ' WHERE id=$1", [SKIN_SEED])],
    ['a second active seed that reads AUD', false, () => extraSeed('eps_extra_aud', 'AUD')],
    ['a second active seed that also reads USD', true, () => extraSeed('eps_extra_usd', 'USD')],
    ['its snapshot stored as a JSON string', false, () => db.query(
      "UPDATE external_product_seeds SET seed_data = jsonb_set(seed_data, '{snapshot}', to_jsonb($1::text)) WHERE id=$2",
      [JSON.stringify(AGREEING.snapshot), SKIN_SEED])],
    ['its seed_data stored as a JSON string', false, () => db.query(
      'UPDATE external_product_seeds SET seed_data = to_jsonb($1::text) WHERE id=$2', [JSON.stringify(AGREEING), SKIN_SEED])],
  ])('an agreeing skintific set with %s: served=%s', async (_label, served, mutate) => {
    try {
      await resetSkintificSeed({ agree: true });
      await mutate();
      const res = await skintificAlone(() => invoke('skintific glow cushion peptide lip serum set'));
      expect(res.status).toBe(200);
      const card = (res.body.products || []).find((p) => p.product_key === SKIN_PK);
      expect(card ? [Number(card.price), card.currency] : null).toEqual(served ? [23.56, 'USD'] : null);
    } finally {
      await resetSkintificSeed({ agree: false });
    }
  });

  test('the kill switch off restores the pre-guard statement (and with it the incident card)', async () => {
    process.env.CANONICAL_SEED_PROJECTED_OFFER_CURRENCY_GUARD = 'off';
    const res = await skintificAlone(() => invoke('skintific glow cushion peptide lip serum set'));
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].sql).not.toContain('eps_own');
    const card = (res.body.products || []).find((p) => p.product_key === SKIN_PK);
    expect(card && [Number(card.price), card.currency]).toEqual([23.56, 'USD']);
  });

  test('a seed that states no currency refuses the offer stamped from it', async () => {
    try {
      await db.query(`UPDATE external_product_seeds SET price_currency=NULL, seed_data='{}'::jsonb WHERE id='eps_ctl_usd'`);
      const res = await invoke('skintific serum');
      expect(keys(res.body)).not.toContain('prod::merch_obs_ctl::external_seed::ext_ctl_usd');
      expect(keys(res.body)).toContain('prod::merch_obs_mkt::external_seed::ext_mkt_sgd');
    } finally {
      await db.query(`UPDATE external_product_seeds SET price_currency='USD',
        seed_data='{"price_amount":"18","price_currency":"USD","snapshot":{"price_amount":"18"}}'::jsonb WHERE id='eps_ctl_usd'`);
    }
  });
});
