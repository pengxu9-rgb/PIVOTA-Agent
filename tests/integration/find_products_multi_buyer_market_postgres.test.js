const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');

// Stage 0a (FIND_PRODUCTS_BUYER_MARKET), both recall lanes against real PostgreSQL, through the
// real invoke route, with CANONICAL_CATALOG_RANK_V2 on as in prod.
//
// The prod shape it reproduces (2026-09-18): every SGD seed is filed under the 'US' partition
// and its canonical row carries recall_market 'US'; the 'SG' partition is empty; JP is a real
// partition. So a buyer naming SG got nothing, and a buyer naming nothing got SGD and USD mixed.
//
// Pins: flag off is unchanged (a named SG still binds the empty partition, and a silent request
// sends byte-identical SQL with the flag on); flag on, SG serves only SGD and finds the Meitu
// product on both lanes; US serves only USD; a JP buyer keeps the JP partition; a caller's own
// currency beats the buyer's.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const FLAG = 'FIND_PRODUCTS_BUYER_MARKET';

// [id, partition, title, brand, currency, price]
const SEEDS = [
  ['jsm_gloss', 'US', 'JUNGSAEMMOOL LIP-PRESSION Metal Serum Gloss', 'JUNGSAEMMOOL', 'SGD', 28.2],
  ['sg_gloss_2', 'US', 'Fwee Lip Gloss Glassy', 'fwee', 'SGD', 24],
  ['us_gloss', 'US', 'Glossier Lip Gloss Clear', 'Glossier', 'USD', 16],
  ['us_gloss_2', 'US', 'NYX Butter Lip Gloss', 'NYX', 'USD', 6],
  ['jp_gloss', 'JP', 'Canmake Lip Gloss Juicy', 'Canmake', 'JPY', 880],
];
// Canonical-only rows (no seed): [id, platform, recall_market, title, brand, currency, price]
const CANONICAL = [
  ['ck_sg_gloss', 'external_seed', 'US', 'rom&nd Glasting Lip Gloss', 'rom&nd', 'SGD', 19],
  ['ck_us_gloss', 'shopify', null, 'Laneige Lip Gloss Glowy', 'Laneige', 'USD', 20],
  // Graduated into the JP partition with no seed of its own: reachable ONLY through canonical.
  ['ck_jp_gloss', 'external_seed', 'JP', 'Excel Lip Gloss Sheer', 'Excel', 'JPY', 1320],
];

suite('buyer market (Stage 0a) over both lanes, real PostgreSQL', () => {
  let db, schema, priorEnv, app, calls;
  jest.setTimeout(120000);

  const sig = (id) => `sig_${require('crypto').createHash('md5').update(id).digest('hex')}`;

  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `buyer_market_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    // The seed table is the seed lane's own shape (find_products_multi_seed_offer_scope_postgres).
    await db.query(`CREATE TABLE external_product_seeds(id text,external_product_id text,market text,tool text,destination_url text,canonical_url text,domain text,title text,image_url text,price_amount numeric,price_currency text,availability text,seed_data jsonb,updated_at timestamptz,created_at timestamptz,status text,attached_product_key text)`);
    // Every other table is materialised from the columns the statements actually reference, flag
    // off and on, SG / US / silent -- so neither lane can fail on a missing column and compare
    // empty-vs-empty.
    const tables = {};
    for (const flag of [null, 'on']) {
      for (const market of ['SG', 'US', undefined]) {
        const captured = [];
        boot(flag, async (sql) => { captured.push(sql); return { rows: [] }; });
        try { await invoke('lip gloss', { market }); } finally { unboot(); }
        for (const sql of captured) {
          for (const [, table, alias] of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|merchant_stores)\s+(?:AS\s+)?(\w+)/g)) {
            tables[table] ||= new Set();
            for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) tables[table].add(ref[1]);
          }
        }
      }
    }
    for (const col of ['product_key', 'content_key', 'pivota_signature_id', 'pivota_canonical_url', 'category_path', 'merchant_id', 'source_system',
      'platform', 'source_product_id', 'title', 'brand', 'canonical_url', 'image_url', 'pdp_scope', 'recall_market', 'updated_at']) {
      (tables.catalog_products ||= new Set()).add(col);
    }
    for (const col of ['offer_id', 'sku_key', 'product_key', 'merchant_effective_price', 'currency', 'availability', 'market', 'suppressed_at']) {
      (tables.catalog_offers ||= new Set()).add(col);
    }
    for (const col of ['sku_key', 'product_key', 'source_variant_id']) (tables.catalog_skus ||= new Set()).add(col);
    for (const col of ['content_key', 'serving_eligible']) (tables.index_pipeline_state ||= new Set()).add(col);
    for (const col of ['merchant_id', 'merchant_name', 'status']) (tables.catalog_merchants ||= new Set()).add(col);
    for (const [table, cols] of Object.entries(tables)) {
      const defs = [...cols].map((col) => `${col} ${/^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
        : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
          : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric'
            : /(_at)$/.test(col) ? 'timestamptz' : 'text'}`);
      await db.query(`CREATE TABLE ${table} (${defs.join(',')})`);
    }
    await db.query("INSERT INTO catalog_merchants(merchant_id,merchant_name,status) VALUES ('retailer','retailer','active')");
    const product = async (id, platform, recallMarket, title, brand, currency, price) => {
      await db.query(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,pivota_canonical_url,category_path,merchant_id,source_system,
        platform,source_product_id,title,brand,canonical_url,image_url,pdp_scope,recall_market,updated_at)
        VALUES ($1,$1,$2,$3,'beauty/makeup/lip/gloss','retailer',$4,$4,$1,$5,$6,$7,$8,$9,$10,now())`,
      [id, sig(id), `https://agent.pivota.cc/products/${sig(id)}`, platform, title, brand, `https://retailer.example/${id}`,
        `https://cdn.example/${id}.jpg`, platform === 'external_seed' ? 'multi_merchant_canonical' : null, recallMarket]);
      await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible) VALUES ($1,true)', [id]);
      await db.query('INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$1,$1)', [id]);
      await db.query("INSERT INTO catalog_offers(offer_id,sku_key,product_key,merchant_effective_price,currency,availability,market) VALUES ($1,$1,$1,$2,$3,'in_stock','US')",
        [id, price, currency]);
    };
    for (const [id, partition, title, brand, currency, price] of SEEDS) {
      await db.query(`INSERT INTO external_product_seeds VALUES ($1,$1,$2,'shopping_agents',$3,$3,'retailer.example',$4,$5,$6,$7,'in_stock',$8,now(),now(),'active',$1)`,
        [id, partition, `https://retailer.example/${id}`, title, `https://cdn.example/${id}.jpg`, price, currency, { brand, category: 'Lip Gloss' }]);
      // Its projection, as prod has it: a graduated canonical row with recall_market = partition.
      await product(id, 'external_seed', partition, title, brand, currency, price);
    }
    for (const row of CANONICAL) await product(...row);
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });

  function boot(flag, query) {
    priorEnv = { ...process.env }; jest.resetModules();
    Object.assign(process.env, { DATABASE_URL: url || 'postgres://unused.test/db', PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test',
      API_MODE: 'REAL', INDEX_ELIGIBLE_RECALL: 'false', PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false',
      CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off', CANONICAL_CATALOG_RANK_V2: 'enabled',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', GATEWAY_RATE_LIMIT_ENABLED: 'false' });
    delete process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET;
    if (flag) process.env[FLAG] = flag; else delete process.env[FLAG];
    nock.disableNetConnect(); nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query }));
    app = require('../../src/server');
  }
  function unboot() { process.env = priorEnv; jest.dontMock('../../src/db'); jest.resetModules(); nock.cleanAll(); nock.enableNetConnect(); }

  function invoke(queryText, { market, currency, priceMax } = {}) {
    const search = { query: queryText, domain: 'beauty', limit: 20 };
    if (market !== undefined) search.market = market;
    if (currency) search.currency = currency;
    if (priceMax != null) search.price_max = priceMax;
    return request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi', payload: { search }, metadata: { source: 'public_api' } });
  }

  // Both recall lanes run against PostgreSQL; everything else (caches, rescue lanes) is empty.
  const realLanes = async (sql, params) => {
    const lane = sql.includes('FROM candidate_products c') || (sql.includes('candidate_products AS') && sql.includes('ips.serving_eligible'))
      ? 'canonical'
      : (sql.includes('FROM external_product_seeds') ? 'seed' : null);
    if (sql.includes('ips.index_eligible')) throw new Error('citation rescue must not execute');
    if (!lane) return { rows: [] };
    const result = await db.query(sql, params);
    calls.push({ lane, sql, params, returned: result.rows.map((r) => String(r.external_product_id || r.source_product_id || r.product_key || r.id)) });
    return result;
  };

  async function serve(flag, queryText, opts) {
    calls = [];
    boot(flag, realLanes);
    try {
      const res = await invoke(queryText, opts);
      expect(res.status).toBe(200);
      expect(res.body.metadata?.canonical_error || null).toBeNull();
      const products = res.body.products || [];
      return {
        keys: products.map((p) => String(p.source_product_id || p.platform_product_id || p.product_id)),
        currencies: [...new Set(products.map((p) => p.currency))].sort(),
        sources: products.map((p) => p.source),
        calls: [...calls],
        body: res.body,
      };
    } finally { unboot(); }
  }

  // Prove each lane actually executed a statement -- a lane that never ran would pass every
  // "only SGD" assertion vacuously.
  const bothLanesRan = (out) => {
    expect(out.calls.some((c) => c.lane === 'canonical')).toBe(true);
    expect(out.calls.some((c) => c.lane === 'seed')).toBe(true);
  };

  test('control, flag off: silent request mixes SGD and USD; a named SG binds the empty partition', async () => {
    const silent = await serve(null, 'lip gloss');
    bothLanesRan(silent);
    expect(silent.currencies).toEqual(expect.arrayContaining(['SGD', 'USD']));
    const sg = await serve(null, 'lip gloss', { market: 'SG' });
    bothLanesRan(sg);
    // Today's defect, pinned as today's behaviour when the flag is off.
    expect(sg.keys.filter((k) => ['jsm_gloss', 'sg_gloss_2', 'ck_sg_gloss'].includes(k))).toEqual([]);
  });

  test('flag on, silent request: byte-identical SQL and the same page as flag off', async () => {
    const off = await serve(null, 'lip gloss');
    const on = await serve('on', 'lip gloss');
    expect(on.keys).toEqual(off.keys);
    expect(on.calls.map(({ lane, sql, params }) => ({ lane, sql, params })))
      .toEqual(off.calls.map(({ lane, sql, params }) => ({ lane, sql, params })));
  });

  test.each([
    ['lip gloss'],
    ['JUNGSAEMMOOL LIP-PRESSION Metal Serum Gloss'],
  ])('flag on, market SG, %s: only SGD, and the Meitu product is served', async (queryText) => {
    const out = await serve('on', queryText, { market: 'SG' });
    bothLanesRan(out);
    expect(out.currencies).toEqual(['SGD']);
    expect(out.keys).toContain('jsm_gloss');
    // The seed lane bound the served partition (plus SG) with the SGD conjunct, not SG alone.
    const seedParams = out.calls.filter((c) => c.lane === 'seed').flatMap((c) => c.params);
    expect(seedParams).toEqual(expect.arrayContaining(['SGD']));
    expect(seedParams.some((p) => Array.isArray(p) && p.includes('US') && p.includes('SG'))).toBe(true);
  });

  test('flag on, market SG, lip gloss: every SGD row on both lanes, canonical-only one included', async () => {
    const out = await serve('on', 'lip gloss', { market: 'SG' });
    expect([...out.keys].sort()).toEqual(['ck_sg_gloss', 'jsm_gloss', 'sg_gloss_2']);
  });

  test('flag on, market US: only USD -- the SGD rows filed under US leave a US buyer\'s page', async () => {
    const out = await serve('on', 'lip gloss', { market: 'US' });
    bothLanesRan(out);
    expect(out.currencies).toEqual(['USD']);
    expect([...out.keys].sort()).toEqual(['ck_us_gloss', 'us_gloss', 'us_gloss_2']);
  });

  test('flag on, market JP: the JP partition is kept on BOTH lanes, not swapped out', async () => {
    const seedReturned = (out) => out.calls.filter((c) => c.lane === 'seed').flatMap((c) => c.returned);
    const off = await serve(null, 'lip gloss', { market: 'JP' });
    const on = await serve('on', 'lip gloss', { market: 'JP' });
    // Seed lane: the JP partition row comes back from the seed SQL itself, not via its projection.
    expect(seedReturned(off)).toContain('jp_gloss');
    expect(seedReturned(on)).toContain('jp_gloss');
    // Canonical lane: a JP canonical with no seed. Flag off it is LOST today: its offer carries
    // catalog_offers.market's constant default 'US', and a named JP admits only JP offers. Flag on
    // admits the served markets too, and the partition comparison is bypassed for the currency.
    expect(off.keys).not.toContain('ck_jp_gloss');
    expect(on.keys).toContain('ck_jp_gloss');
    expect(on.currencies).toEqual(['JPY']);
    expect([...on.keys].sort()).toEqual(['ck_jp_gloss', 'jp_gloss']);
  });

  test('flag on, market SG with an undenominated budget: read as S$, SGD scoped before the cut', async () => {
    const out = await serve('on', 'lip gloss', { market: 'SG', priceMax: 25 });
    bothLanesRan(out);
    expect(out.currencies).toEqual(['SGD']);
    expect([...out.keys].sort()).toEqual(['ck_sg_gloss', 'sg_gloss_2']);
    // Recall itself was scoped to SGD on both lanes, not only the page.
    for (const lane of ['seed', 'canonical']) {
      expect({ lane, sgd: out.calls.filter((c) => c.lane === lane).some((c) => c.params.includes('SGD')) }).toEqual({ lane, sgd: true });
    }
  });

  test('flag on, market JP with a budget: JPY has FX rates, so only the recall scope keeps USD out', async () => {
    // With an FX rate the budget expands into USD/EUR/... ranges; unscoped, USD rows reach the
    // budget filter, which prefers USD whenever present -- and the page would come back empty.
    const out = await serve('on', 'lip gloss', { market: 'JP', priceMax: 1000 });
    bothLanesRan(out);
    expect(out.currencies).toEqual(['JPY']);
    expect(out.keys).toEqual(['jp_gloss']);
  });

  test('flag on: the caller\'s own currency beats the buyer\'s market', async () => {
    const out = await serve('on', 'lip gloss', { market: 'SG', currency: 'USD' });
    expect(out.currencies).toEqual(['USD']);
  });

  test('flag on, a market it cannot price: unchanged from flag off', async () => {
    const off = await serve(null, 'lip gloss', { market: 'ZZ' });
    const on = await serve('on', 'lip gloss', { market: 'ZZ' });
    expect(on.keys).toEqual(off.keys);
    expect(on.calls.map(({ sql, params }) => ({ sql, params }))).toEqual(off.calls.map(({ sql, params }) => ({ sql, params })));
  });
});
