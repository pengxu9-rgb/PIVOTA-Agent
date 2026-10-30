const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { SETTING_SPRAY_CATEGORY_ROUTE_FLAG: FLAG } = require('../../src/findProductsMulti/queryUnderstanding');

// THE SETTING-SPRAY ROUTE, end to end through HTTP and a real PostgreSQL, under the PRODUCTION search
// flags (the lash route's harness: tests/integration/search_lash_category_route_postgres.test.js).
// The leaf is beauty/makeup/face/setting-spray (pivota-backend#2547). Only real SQL under the real flags
// can show, with SEARCH_SETTING_SPRAY_CATEGORY_ROUTE on:
//   - a setting-spray query browses the leaf, and the category-browse TEXT UNION's path-less rows are
//     admitted only when their own text names a FACE setting spray -- a path-less seed "Eyebrow Setting
//     Spray" stays out (server.js beautyProductMatchesCategoryPathQuery). A path-less CATALOG row the
//     canonical SQL admitted on its own name skips that check under prod's name-evidence admission, so a
//     catalog "Brow Setting Spray" is served: pinned below, so the flag-on decision sees it;
//   - the external-seed lane's text recall carries the label term "setting spray"
//     (buildBeautyExternalSeedCategoryTerms), so a "makeup fixer" query also recalls a seed titled
//     "... Setting Spray";
//   - a brand + setting-spray browse carries the setting-spray text terms ("fixing spray" ...) into the
//     seed brand recall (buildBeautyExternalSeedBrandCategoryTextTerms);
// and with it off, a setting-spray query is not a category browse at all, exactly as before the leaf.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const LEAF = 'beauty/makeup/face/setting-spray';
// The lash test's list, read from the live gateway service 2026-09-27.
const PROD_FLAGS = {
  BEAUTY_RANKER_CATALOG_LEAF_SIGNAL_ENABLED: '1',
  CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: 'on',
  CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
  CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: 'enabled',
  CANONICAL_CATALOG_FORM_AGREEMENT: 'enabled',
  CANONICAL_CATALOG_RANK_V2: 'enabled',
  CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled',
  CANONICAL_CATALOG_SET_DIVERSITY: 'enabled',
  INDEX_ELIGIBLE_RECALL: '1',
  PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED: 'true',
  PIVOT_BEAUTY_DISCOVERY_ZERO_FALLTHROUGH: 'on',
  PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED: 'true',
  PIVOT_BEAUTY_NEAR_DUP_COLLAPSE_ENABLED: 'true',
  PIVOT_BEAUTY_SET_DEMOTION_ENABLED: 'true',
  SEARCH_NAME_EVIDENCE_ADMISSION: 'on',
};

suite('setting-spray category route with real PostgreSQL under production flags', () => {
  let db, schema, priorEnv, app, sqlCalls;
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `setting_spray_route_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // Same prod-shaped tables as the lash route test.
    await db.query(`
      CREATE TABLE catalog_products(product_key text, content_key text, merchant_id text, platform text, source_product_id text,
        title text, description text, brand text, product_type text, category text, category_path text, canonical_url text,
        image_url text, catalog_track text, truth_tier text, readiness_tier text, pdp_scope text, source_system text,
        product_payload jsonb, freshness_json jsonb, pivota_signature_id text, pivota_canonical_url text, material text,
        material_source text, material_confidence numeric, care text, care_source text, care_confidence numeric, size_guide text,
        size_guide_source text, size_guide_confidence numeric, updated_at timestamptz, recall_doc text, recall_market text, source_domain text,
        status text, suppressed_at timestamptz, sync_status text);
      CREATE TABLE index_pipeline_state(content_key text, serving_eligible boolean, index_eligible boolean);
      CREATE TABLE catalog_merchants(merchant_id text, merchant_name text, primary_platform text, status text);
      CREATE TABLE catalog_skus(sku_key text, product_key text, source_variant_id text, sku text, barcode text, title text,
        visible_attributes jsonb, visible_option_labels jsonb, ingredient_ids jsonb, image_url text, suppressed_at timestamptz);
      CREATE TABLE catalog_offers(offer_id text, sku_key text, product_key text, catalog_track text, truth_tier text,
        readiness_tier text, offer_mode text, availability text, inventory_quantity numeric, currency text, list_price numeric,
        merchant_effective_price numeric, estimated_best_price numeric, price_confidence numeric, source_system text,
        offer_payload jsonb, market text, suppressed_at timestamptz, updated_at timestamptz);
      CREATE TABLE external_product_seeds(id text, external_product_id text, market text, tool text, destination_url text,
        canonical_url text, domain text, title text, image_url text, price_amount numeric, price_currency text, availability text,
        seed_data jsonb, updated_at timestamptz, created_at timestamptz, status text, attached_product_key text);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);`);
    await db.query("INSERT INTO catalog_merchants(merchant_id,merchant_name,status,primary_platform) VALUES ('retailer','Retailer','active','shopify')");
    const items = [
      // On the leaf.
      ['ss_nighter', 'All Nighter Long-Lasting Makeup Setting Spray', 'Urban Decay', LEAF, 'Setting Spray'],
      ['ss_fixer', 'Makeup Fixer Mist 100ml', 'Brand', LEAF, 'Setting Spray'],
      // Path-less rows the text union recalls by name: only the FACE setting spray may be admitted.
      ['pl_spray', 'Dewy Finish Setting Spray', 'Brand', 'beauty', ''],
      ['pl_brow', 'Brow Setting Spray', 'Brand', 'beauty', ''],
      ['seed_cp_brow', 'Item 1042', 'Brand', null, ''],
      ['seed_cp_face', 'Item 1043', 'Brand', null, ''],
      // Neighbours a setting-spray browse must not serve.
      ['powder', 'Loose Setting Powder', 'Brand', 'beauty/makeup/face/powder', 'Powder'],
      ['toner', 'Hydrating Face Mist', 'Brand', 'beauty/skincare/tone/toner', 'Toner'],
      // The serving mirror rows the two seeds attach to.
      ['seed_cp_ss', 'Matte Setting Spray', 'Brand', null, ''],
      ['seed_cp_brand', 'Urban Decay All Nighter Fixing Spray', 'Urban Decay', null, ''],
    ];
    for (const [id, title, brand, category, type] of items) {
      const sig = `sig_${Buffer.from(id).toString('hex').padEnd(32, '0').slice(0, 32)}`;
      await db.query(`INSERT INTO catalog_products(product_key,content_key,merchant_id,platform,source_product_id,title,brand,product_type,
        category_path,pivota_signature_id,pivota_canonical_url,canonical_url,image_url,product_payload,recall_doc,updated_at)
        VALUES ($1,$1,'retailer','shopify',$1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,lower($2),now())`,
      [id, title, brand, type, category, sig, `https://agent.pivota.cc/products/${sig}`, `https://retailer.example/products/${id}`,
        `https://cdn.example/${id}.jpg`]);
      await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible,index_eligible) VALUES ($1,true,true)', [id]);
      await db.query('INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$1,$2)', [id, `variant_${id}`]);
      await db.query("INSERT INTO catalog_offers(offer_id,sku_key,product_key,merchant_effective_price,currency,availability,market) VALUES ($1,$1,$1,9,'USD','in_stock','US')", [id]);
    }
    const seeds = [
      ['seed_ss', 'Matte Setting Spray', 'seed_cp_ss', { category: 'Setting Spray', brand: 'Brand' }],
      ['seed_brand', 'Urban Decay All Nighter Fixing Spray', 'seed_cp_brand', { category: 'Makeup', brand: 'Urban Decay' }],
      ['seed_brow', 'Eyebrow Setting Spray', 'seed_cp_brow', { brand: 'Brand' }],
      ['seed_face', 'Long Wear Makeup Setting Spray', 'seed_cp_face', { brand: 'Brand' }],
    ];
    for (const [id, title, attached, seedData] of seeds) {
      await db.query(`INSERT INTO external_product_seeds(id,external_product_id,market,tool,destination_url,canonical_url,domain,title,
        image_url,price_amount,price_currency,availability,seed_data,updated_at,created_at,status,attached_product_key)
        VALUES ($1,$1,'US','*',$2,$2,'retailer.example',$3,$4,9,'USD','in_stock',$5::jsonb,now(),now(),'active',$6)`,
      [id, `https://retailer.example/products/${id}`, title, `https://cdn.example/${id}.jpg`, JSON.stringify(seedData), attached]);
    }
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });

  const boot = (flag, extraEnv = {}) => {
    priorEnv = { ...process.env }; jest.resetModules(); sqlCalls = [];
    Object.assign(process.env, { DATABASE_URL: url, PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false', ...PROD_FLAGS, ...extraEnv });
    if (flag) process.env[FLAG] = flag; else delete process.env[FLAG];
    nock.disableNetConnect(); nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query: async (sql, params = []) => {
      const primary = sql.includes('ips.serving_eligible')
        && (sql.includes('candidate_products AS') || sql.includes('FROM external_product_seeds'));
      if (!primary) return { rows: [] };
      sqlCalls.push({ sql, params });
      return db.query(sql, params);
    } }));
    app = require('../../src/server');
  };
  afterEach(() => { process.env = priorEnv; jest.dontMock('../../src/db'); jest.resetModules(); nock.cleanAll(); nock.enableNetConnect(); });

  const search = (query, limit = 12) => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi',
    payload: { search: { query, domain: 'beauty', market: 'US', limit } }, metadata: { source: 'public_api', market: 'US' } });
  const keys = (res) => (res.body.products || []).map((p) => p.product_key || p.product_ref?.product_id || p.id).sort();
  const canonicalCalls = () => sqlCalls.filter((c) => c.sql.includes('candidate_products AS'));
  const seedCalls = () => sqlCalls.filter((c) => c.sql.includes('FROM external_product_seeds') && !c.sql.includes('candidate_products AS'));
  const rerun = async (calls) => (await Promise.all(calls.map((c) => db.query(c.sql, c.params))))
    .flatMap((r) => r.rows.map((row) => row.id || row.product_key));

  test('flag OFF: a setting-spray query is not a category browse, as before the leaf', async () => {
    boot(null);
    const res = await search('setting spray');
    expect(res.status).toBe(200);
    expect(canonicalCalls()).toHaveLength(0);
    expect(keys(res)).toEqual([]);
  });

  test('flag ON: "setting spray" serves the leaf and the path-less FACE setting spray', async () => {
    boot('on');
    const res = await search('setting spray');
    expect(res.status).toBe(200);
    expect(canonicalCalls().length).toBeGreaterThan(0);
    const served = keys(res);
    expect(served).toEqual(expect.arrayContaining(['ss_nighter', 'ss_fixer', 'pl_spray']));
    expect(served).not.toContain('powder');
    expect(served).not.toContain('toner');
  });

  test('flag ON: a path-less seed is admitted only when its own text names a FACE setting spray', async () => {
    // Seed rows carry no name-evidence mark, so the path-less row check (server.js
    // beautyProductMatchesCategoryPathQuery) is what decides: the text recall finds both by name.
    boot('on');
    const res = await search('setting spray');
    expect(res.status).toBe(200);
    const served = keys(res);
    expect(served).toContain('seed_cp_face');
    expect(served).not.toContain('seed_cp_brow');
  });

  test('flag ON, prod flags: the canonical SQL\'s name evidence admits the path-less brow fixer anyway', async () => {
    // SEARCH_NAME_EVIDENCE_ADMISSION waives a category rejection for a row the SQL admitted on its own
    // name ("Brow Setting Spray" contains "setting spray"). If this starts failing, the waiver learned
    // about areas and this pin can go.
    boot('on');
    const res = await search('setting spray');
    expect(keys(res)).toContain('pl_brow');
  });

  test('flag ON: the seed text recall carries the "setting spray" label term, and PostgreSQL returns that seed', async () => {
    boot('on');
    const res = await search('makeup fixer');
    expect(res.status).toBe(200);
    const labelled = seedCalls().filter((c) => c.params.includes('%setting spray%'));
    expect(labelled.length).toBeGreaterThan(0);
    expect(await rerun(labelled)).toContain('seed_ss');
  });

  test('flag ON: a brand + setting-spray browse carries the setting-spray terms into the seed brand recall', async () => {
    boot('on');
    const res = await search('urban decay setting spray');
    expect(res.status).toBe(200);
    const branded = seedCalls().filter((c) => c.params.includes('%fixing spray%'));
    expect(branded.length).toBeGreaterThan(0);
    expect(await rerun(branded)).toContain('seed_brand');
  });

  test('flag ON: "setting spray spf" is a sunscreen ask, not a setting-spray browse', async () => {
    boot('on');
    const res = await search('setting spray spf');
    expect(res.status).toBe(200);
    expect(keys(res)).not.toContain('ss_nighter');
  });
});
