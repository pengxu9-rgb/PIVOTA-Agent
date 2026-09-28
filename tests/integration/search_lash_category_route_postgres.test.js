const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { LASH_CATEGORY_ROUTE_FLAG: FLAG } = require('../../src/findProductsMulti/queryUnderstanding');

// THE LASH ROUTE, end to end through HTTP and a real PostgreSQL, under the PRODUCTION search flags.
// Measured 2026-09-27: `lash glue` safe-emptied and `false lashes` ranked by bare text relevance while
// beauty/makeup/eye/false-lashes held 594 live rows, the largest leaf in the eye tree.
//
// Only real SQL under the real flags can show:
//   - with SEARCH_LASH_CATEGORY_ROUTE on, a lash query serves the false-lashes leaf and nothing else in
//     the eye tree, even though prod's category-browse TEXT UNION also recalls a "lash" mascara by name;
//     with it off, a lash query is not a category browse at all, exactly as today;
//   - "Brush On" no longer makes a lash glue a TOOL, in the candidate SQL's tool exclusion
//     (canonicalSearchQualitySql.js) or in the JS accessory gate. "Duo Brush On Striplash Adhesive" is a
//     real prod row that the exclusion deleted from any category browse. A real applicator stays out;
//   - rows typed only "false-lashes" (591 of the 594 in prod) are served. The ranker's text bucket has
//     no lash vocabulary, so they rely on BEAUTY_RANKER_CATALOG_LEAF_SIGNAL_ENABLED, which prod has ON;
//     the last test pins that dependency so turning the leaf signal off cannot pass silently.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const LASHES = 'beauty/makeup/eye/false-lashes';
// Read from the live gateway service (image bf6ae5adf) 2026-09-27: every search/recall/ranker flag it sets.
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

suite('lash category route with real PostgreSQL under production flags', () => {
  let db, schema, priorEnv, app, sqlCalls;
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `lash_route_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // Same prod-shaped tables as find_products_multi_prod_flags_bind_types_postgres.test.js.
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
      // Titles, brands and types as stored in prod 2026-09-27.
      ['kiss_strip', 'KISS Lash Couture Faux Mink Strip Lashes - Chiffon', 'KISS', LASHES, 'false-lashes'],
      ['kiss_glue', 'Kiss Strip Lash Adhesive - Clear', 'KISS', LASHES, 'false-lashes'],
      ['falscara', 'Falscara Wispy Single Pack | DIY False Lash Extensions, Natural, Cluster Lash, 10 Wisps, 14mm', 'KISS', LASHES, 'false-lashes'],
      ['duo_brush_on', 'Duo Brush On Striplash Adhesive', 'MAC Cosmetics', LASHES, 'makeup'],
      ['duo_adhesive', 'Duo Adhesive', 'MAC Cosmetics', LASHES, 'makeup'],
      // A real lash APPLICATOR is a tool, and a lash query does not ask for one: still excluded.
      ['applicator', 'Kiss Falscara Eyelash Applicator', 'KISS', LASHES, 'false-lashes'],
      // Neighbours in the eye tree a lash browse must not serve -- the mascara names "lash", so the
      // text union recalls it.
      ['mascara', 'Volumizing Lash Mascara', 'Brand', 'beauty/makeup/eye/mascara', 'Mascara'],
      ['eyeliner', 'Magnetic Liquid Eyeliner', 'Brand', 'beauty/makeup/eye/eyeliner', 'Eyeliner'],
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
      const primary = sql.includes('ips.serving_eligible') && sql.includes('candidate_products AS');
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
  const recalled = async () => (await db.query(sqlCalls.at(-1).sql, sqlCalls.at(-1).params)).rows.map((r) => r.product_key).sort();
  const LASH_ROWS = ['duo_adhesive', 'duo_brush_on', 'falscara', 'kiss_glue', 'kiss_strip'];

  test('flag OFF: a lash query is not a category browse and serves no lash row, as today', async () => {
    boot(null);
    const res = await search('lash glue');
    expect(res.status).toBe(200);
    // No category browse means the canonical category recall never runs (in prod the MCP door then
    // answers safe-empty; here, with the upstream disabled, the public door answers its fallback).
    expect(sqlCalls).toHaveLength(0);
    expect(keys(res)).toEqual([]);
  });

  test('flag ON: "lash glue" serves the lash leaf only -- brush-on glue in, applicator and mascara out', async () => {
    boot('on');
    const res = await search('lash glue');
    expect(res.status).toBe(200);
    expect(sqlCalls.length).toBeGreaterThan(0);
    const recall = await recalled();
    // The SQL tool exclusion keeps the brush-on glue and still drops the applicator.
    expect(recall).toEqual(expect.arrayContaining(['duo_brush_on']));
    expect(recall).not.toContain('applicator');
    // ...and the JS gates serve exactly the lash rows.
    expect(keys(res)).toEqual(LASH_ROWS);
  });

  test('flag ON: saying "brush on" is not asking for a tool -- the applicator stays excluded', async () => {
    boot('on');
    const res = await search('brush on lash glue');
    expect(res.status).toBe(200);
    expect(sqlCalls.length).toBeGreaterThan(0);
    const recall = await recalled();
    expect(recall).toEqual(expect.arrayContaining(['duo_brush_on']));
    expect(recall).not.toContain('applicator');
  });

  test('flag ON: "false lashes" never serves the mascara or eyeliner leaves', async () => {
    boot('on');
    const res = await search('false lashes');
    expect(res.status).toBe(200);
    const served = keys(res);
    expect(served).toEqual(expect.arrayContaining(['falscara', 'kiss_strip']));
    expect(served).not.toContain('mascara');
    expect(served).not.toContain('eyeliner');
    expect(served).not.toContain('applicator');
  });

  test('flag ON: "mascara" keeps its own browse (control)', async () => {
    boot('on');
    const res = await search('mascara');
    expect(res.status).toBe(200);
    expect(keys(res)).toContain('mascara');
  });

  test('the "false-lashes"-typed rows depend on the catalog-leaf ranker signal prod has on', async () => {
    boot('on', { BEAUTY_RANKER_CATALOG_LEAF_SIGNAL_ENABLED: '0' });
    const res = await search('lash glue');
    expect(res.status).toBe(200);
    // Without the leaf signal, a row whose only type is "false-lashes" reads as "not beauty" (score
    // -30): if this ever starts passing, the ranker learned lash vocabulary and this pin can go.
    expect(keys(res)).not.toContain('kiss_glue');
  });
});
