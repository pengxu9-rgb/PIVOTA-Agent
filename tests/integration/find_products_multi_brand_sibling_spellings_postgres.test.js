const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

// One brand under two catalog spellings (GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS, default OFF).
// A retailer writes the bare name, the brand's own store writes the name plus a market word; a
// brand constraint is an equality on ONE dictionary key, so "<brand> sunscreen" was scoped to the
// retailer's rows and answered an empty page while the store's sunscreen sat under the sibling
// spelling. Real route, real statement, real PostgreSQL, and the dictionary is loaded by the real
// loader from this fixture. Every brand name is a placeholder.
//
// THE INVARIANT this file adds (it would have caught the defect): for every product a generic
// query returns, "<its brand as a buyer types it> <the same query>" returns that product too.
// Flag off, the number of products that break it is pinned, so the flag's effect is visible.
// The same invariant through the real /mcp door: ..._door_postgres.node.test.cjs.

// Dedicated disposable DB only. CI/operators opt in with this explicit test URL.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const FLAG = 'GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS';
const {
  BRANDS, FAMILY, ITEMS, KINDS, UNDER_A_SIBLING_SPELLING, brandOf, createFixture, familyOf, fixtureDbQuery, invariantBreaks,
} = require('../_support/brandSiblingSpellingsFixture.cjs');

suite('brand sibling spellings: route, both lanes and plan on real PostgreSQL', () => {
  let db, schema, priorEnv, app, sqlCalls, coldDictionary;
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = await createFixture(db, { fetchCanonicalChainRows, buildSearchQualityContract });
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });

  // A fresh app (and a freshly loaded dictionary) per boot.
  async function boot(flag) {
    Object.assign(process.env, { DATABASE_URL: url, PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      INDEX_ELIGIBLE_RECALL: 'false', PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false',
      CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      GATEWAY_DYNAMIC_BRAND_DETECT: '1', GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT: '1' });
    if (flag) process.env[FLAG] = flag; else delete process.env[FLAG];
    const state = { get sqlCalls() { return sqlCalls; }, get coldDictionary() { return coldDictionary; } };
    jest.doMock('../../src/db', () => ({ query: fixtureDbQuery(db, state) }));
    app = require('../../src/server');
    const cache = require('../../src/findProductsMulti/brandDictionaryCache');
    await cache.refresh(); // warm: a cold dictionary detects no brand at all (pinned below)
    return cache;
  }
  beforeEach(() => {
    priorEnv = { ...process.env }; jest.resetModules(); sqlCalls = []; coldDictionary = false;
    nock.disableNetConnect(); nock.enableNetConnect((host) => host.includes('127.0.0.1'));
  });
  afterEach(async () => {
    process.env = priorEnv; jest.dontMock('../../src/db'); jest.resetModules(); nock.cleanAll(); nock.enableNetConnect();
  });

  const invoke = (query, limit = 50) => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi',
    payload: { search: { query, domain: 'beauty', market: 'US', page: 1, limit } }, metadata: { source: 'public_api', market: 'US' } });
  const idsOf = (body) => (body.products || []).map((p) => p.product_key || p.product_ref?.product_id || p.id).sort();
  const routeIds = async (query) => { const res = await invoke(query); expect(res.status).toBe(200); return idsOf(res.body); };
  // The brand keys each statement bound: the text array that is followed by its md5 twin.
  const brandBinds = () => sqlCalls.map((call) => call.params.find((param, at) => Array.isArray(param)
    && Array.isArray(call.params[at + 1]) && call.params[at + 1].length === param.length
    && call.params[at + 1].every((value) => /^[0-9a-f]{32}$/.test(String(value)))) || null);

  // What each (query) answers on the route, as sorted fixture ids.
  async function routeAnswers(queries) {
    const out = {};
    for (const query of queries) out[query] = await routeIds(query);
    return out;
  }

  test('flag off, the symptom: bare brand + category is an empty page; the store row needs its suffix typed', async () => {
    await boot(null);
    expect(await routeIds('sunscreen')).toContain('zentora_usa__sunscreen');
    sqlCalls = [];
    const res = await invoke('Zentora sunscreen');
    expect(res.body.products).toEqual([]);
    expect(res.body.metadata.search_quality_contract.hard_constraints.brand).toEqual({ brand_key: 'catalog:zentora', canonical: 'zentora', alias: 'zentora' });
    expect(res.body.metadata.search_quality_contract).not.toHaveProperty('brand_spellings_bound');
    expect(brandBinds()).toEqual([['zentora']]);
    expect(await routeIds('Zentora USA sunscreen')).toEqual(['zentora_usa__sunscreen']);
    expect(await routeIds('Zentora')).toEqual(['zentora__lipstick', 'zentora__serum', 'zentora__toner']);
    expect(await routeIds('Zentora Green Tea Mild Daily Sunscreen SPF 50')).toEqual([]);
  });

  test('flag on, the fix: bare brand + category returns the store row; brand alone returns both spellings', async () => {
    await boot('on');
    const res = await invoke('Zentora sunscreen');
    expect(idsOf(res.body)).toEqual(['zentora_usa__sunscreen']);
    expect(res.body.products.every((p) => p.source === 'canonical_chain')).toBe(true);
    expect(brandBinds()).toEqual([['zentora', 'zentorausa']]);
    // the answer says how many spellings were bound, and names no spelling it did not name before
    const contract = res.body.metadata.search_quality_contract;
    expect(contract.brand_spellings_bound).toBe(2);
    expect(contract.hard_constraints.brand).toEqual({ brand_key: 'catalog:zentora', canonical: 'zentora', alias: 'zentora' });
    expect(JSON.stringify(res.body.metadata)).not.toMatch(/zentora usa/i);

    expect(await routeIds('Zentora')).toEqual(ITEMS.filter((item) => FAMILY.Zentora.includes(item.brand)).map((item) => item.id).sort());
    // the suffixed spelling typed: the bare retailer rows come too
    expect(await routeIds('Zentora USA serum')).toEqual(['zentora__serum', 'zentora_usa__serum']);
    expect(await routeIds('Zentora USA sunscreen')).toEqual(['zentora_usa__sunscreen']);
    // full brand + title: the exact-product anchor reads the row's own name, and admits it
    const exact = await invoke('Zentora Green Tea Mild Daily Sunscreen SPF 50');
    expect(exact.body.metadata.search_quality_contract.query_class).toBe('exact_product');
    expect(idsOf(exact.body)).toEqual(['zentora_usa__sunscreen']);
    // three spellings, any of them typed
    for (const typed of FAMILY.Lumavelle) {
      expect(await routeIds(`${typed} toner`)).toEqual(['lumavelle__toner', 'lumavelle_official_store__toner', 'lumavelle_uk__toner']);
    }
    const three = await invoke('Lumavelle UK toner');
    expect(three.body.metadata.search_quality_contract.brand_spellings_bound).toBe(3);
  });

  test('the invariant at the route: flag off breaks it for exactly the sibling-spelling products; flag on holds', async () => {
    await boot(null);
    const off = await invariantBreaks(routeIds);
    // KNOWN GAP, pinned: 10 of the fixture's 39 products cannot be found by their brand + category.
    expect(off).toEqual(UNDER_A_SIBLING_SPELLING);
    expect(off).toHaveLength(10);
    jest.resetModules();
    await boot('on');
    expect(await invariantBreaks(routeIds)).toEqual([]);
  });

  test('precision, flag on: a brand query returns its own family only; only family queries differ from flag off', async () => {
    const queries = BRANDS.flatMap(([brand]) => [brand, ...KINDS.map((kind) => `${brand} ${kind}`)]);
    await boot(null);
    const off = await routeAnswers(queries);
    jest.resetModules();
    await boot('on');
    const on = await routeAnswers(queries);
    const changed = [];
    for (const [brand] of BRANDS) {
      // "Brisa Beauty" also binds "brisa" on main (the predicate drops the word "beauty"): unchanged here.
      const allowed = brand === 'Brisa Beauty' ? ['Brisa Beauty', 'Brisa'] : familyOf(brand);
      for (const query of [brand, ...KINDS.map((kind) => `${brand} ${kind}`)]) {
        expect({ query, brands: [...new Set(on[query].map((id) => brandOf[id]))].filter((b) => !allowed.includes(b)) }).toEqual({ query, brands: [] });
        // nothing is lost: everything flag off returned is still returned
        expect(on[query]).toEqual(expect.arrayContaining(off[query]));
        if (JSON.stringify(on[query]) !== JSON.stringify(off[query])) changed.push(brand);
      }
    }
    // the prefix-sharing brands, named: neither ever shows the other's rows
    for (const kind of ['sunscreen', 'serum', 'toner']) {
      expect(on[`Zentora ${kind}`].map((id) => brandOf[id])).not.toContain('Zentora Labs');
      expect(on[`Zentora USA ${kind}`].map((id) => brandOf[id])).not.toContain('Zentora Labs');
      expect(on[`Zentora Labs ${kind}`]).toEqual([`zentora_labs__${kind}`]);
    }
    expect(on['Noble serum']).toEqual(['noble__serum']);
    expect(on['Noble Pegasus serum']).toEqual(['noble_pegasus__serum']);
    expect(on['Brisa serum']).toEqual(['brisa__serum']);
    expect(on['Brisa sunscreen']).toEqual([]); // "Brisa Beauty" is another brand: not a sibling
    // THE ONLY QUERIES THAT CHANGE are the ones whose brand has a sibling spelling.
    expect([...new Set(changed)].sort()).toEqual([...FAMILY.Zentora, ...FAMILY.Lumavelle].sort());
  });

  test('a cold dictionary: no brand constraint at all, flag on or off', async () => {
    const answers = {};
    for (const flag of [null, 'on']) {
      jest.resetModules(); coldDictionary = true; sqlCalls = [];
      await boot(flag);
      const res = await invoke('Zentora sunscreen');
      expect(res.status).toBe(200);
      expect(res.body.metadata.search_quality_contract?.hard_constraints?.brand || null).toBeNull();
      expect(res.body.metadata.search_quality_contract || {}).not.toHaveProperty('brand_spellings_bound');
      answers[String(flag)] = { ids: idsOf(res.body), sql: sqlCalls.map((call) => [call.sql, call.params]) };
    }
    expect(answers.on).toEqual(answers.null);
  });

  test('both lanes on PostgreSQL: the canonical and the seed predicate match the same rows, the family and no other', async () => {
    const matched = async (flag, key) => {
      jest.resetModules();
      await boot(flag);
      const { buildBrandIdentityPredicate, CANONICAL_OWN_BRAND_SQL } = require('../../src/services/canonicalSearchQualitySql');
      const { buildSeedSearchOfferScope } = require('../../src/services/seedSearchOfferScope');
      const brand = { contract: 'brand_browse', brand_key: `catalog:${key}`, brand: key, canonical: key, alias: key };
      const stored = BRANDS.map(([name]) => name);
      const canonicalParams = [];
      const canonical = buildBrandIdentityPredicate(brand, CANONICAL_OWN_BRAND_SQL, canonicalParams);
      canonicalParams.push(stored);
      const own = await db.query(`SELECT p.brand FROM (SELECT b AS brand, '{}'::jsonb AS product_payload FROM unnest($${canonicalParams.length}::text[]) b) p WHERE ${canonical} ORDER BY 1`, canonicalParams);
      const seedParams = [];
      const seed = buildSeedSearchOfferScope({ brand }, seedParams);
      seedParams.push(stored);
      const seeds = await db.query(`SELECT seed.seed_data->>'brand' AS brand FROM (SELECT jsonb_build_object('brand', b) AS seed_data, 20::numeric AS price_amount FROM unnest($${seedParams.length}::text[]) b) seed WHERE TRUE ${seed} ORDER BY 1`, seedParams);
      expect(seeds.rows).toEqual(own.rows);
      return own.rows.map((row) => row.brand);
    };
    expect(await matched(null, 'zentora')).toEqual(['Zentora']);
    expect(await matched('on', 'zentora')).toEqual(['Zentora', 'Zentora USA']);
    expect(await matched(null, 'zentora usa')).toEqual(['Zentora USA']);
    expect(await matched('on', 'zentora usa')).toEqual(['Zentora', 'Zentora USA']);
    expect(await matched('on', 'lumavelle uk')).toEqual(['Lumavelle', 'Lumavelle Official Store', 'Lumavelle UK']);
    expect(await matched('on', 'zentora labs')).toEqual(['Zentora Labs']);
    expect(await matched('on', 'noble')).toEqual(['Noble']);
    expect(await matched('on', 'noble pegasus')).toEqual(['Noble Pegasus']);
    expect(await matched('on', 'brisa')).toEqual(['Brisa']);
  });

  test('the plan: the brand index serves one key and a family alike', async () => {
    const { primaryBrandIndexDefinitions } = require('../../scripts/catalog/primary_brand_indexes');
    const index = primaryBrandIndexDefinitions().find((definition) => definition.table === 'catalog_products');
    // Enough other-brand rows that a scan is not the cheaper plan, in a category no query here reads.
    await db.query(`INSERT INTO catalog_products(product_key,merchant_id,platform,source_product_id,title,brand,product_type,category_path,content_key,product_payload,updated_at)
      SELECT 'filler_'||i,'retailer','shopify','filler_'||i,'Filler Item '||i,'Filler '||(i % 400),'Comb','beauty/haircare/tools','filler_'||i,'{}',now() FROM generate_series(1,6000) i`);
    try {
      await db.query(index.sql); await db.query('ANALYZE catalog_products');
      const plans = {};
      for (const flag of [null, 'on']) {
        jest.resetModules(); sqlCalls = [];
        await boot(flag);
        await invoke('Zentora sunscreen');
        expect(sqlCalls).toHaveLength(1);
        const explain = await db.query('EXPLAIN (FORMAT JSON) ' + sqlCalls[0].sql, sqlCalls[0].params);
        const nodes = []; const walk = (node) => { nodes.push(node); for (const child of node.Plans || []) walk(child); };
        walk(explain.rows[0]['QUERY PLAN'][0].Plan);
        plans[String(flag)] = { sql: sqlCalls[0].sql, binds: brandBinds()[0], indexed: nodes.some((node) => node['Index Name'] === index.name) };
      }
      expect(plans.null.binds).toEqual(['zentora']);
      expect(plans.on.binds).toEqual(['zentora', 'zentorausa']);
      expect(plans.on.sql).toBe(plans.null.sql); // one statement text: only the bound array grew
      expect(plans.null.indexed).toBe(true);
      expect(plans.on.indexed).toBe(true);
    } finally {
      await db.query(`DROP INDEX IF EXISTS ${index.name}`);
      await db.query("DELETE FROM catalog_products WHERE product_key LIKE 'filler_%'");
      await db.query('ANALYZE catalog_products');
    }
  });
});
