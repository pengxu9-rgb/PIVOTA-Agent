'use strict';

// CANONICAL_CATALOG_NARROW_RANK must return EXACTLY the rows the wide statement returns: same rows,
// same order, every column equal. The flag moves the rank sort, the set-quota window and the cut onto
// narrow rows and re-reads the display columns for the survivors by primary key (see
// isNarrowRankEnabled), so the risk is a different survivor set or order at the cut -- above all among
// TIED rank scores, where only the tie-break decides. The fixture is built to be full of ties:
//   * the acceptance set's 600 production rows (category browse gives most of a category one flat
//     score), served for every tracked query plus prod's 6/7-token shapes;
//   * 40 multi-product sets and 40 single products in one leaf, recalled by category alone (titles that
//     match neither the query nor its form, so no family-sensitive rank arm fires): ONE rank score.
//     The set keys sort first, so the set quota's demotion visibly reorders the tie group (demoted
//     sets fall behind every single), and the candidate cut lands inside it;
//   * large out-of-line payloads (the case the narrow sort exists for), and NULL / JSON-null payloads.
// Crossed: set diversity on/off (a set-seeking query turns it off per query), name evidence on/off,
// and page sizes on both sides of the candidate cut. Prod's other lane flags are fixed as in prod.
// Prod runs CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK=enabled (a total order); the legacy updated_at
// tie-break is nondeterministic among equal timestamps with or without this flag, so it is not crossed.
//
// Dedicated disposable DB only, same opt-in as the other *_postgres suites.

const { Client } = require('pg');
const { fetchCanonicalChainRows, isNarrowRankEnabled } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const ROWS = require('../acceptance/fixtures/serving_rows_2026_09_16.json').rows;
const CASES = require('../acceptance/cases.json');

// Prod's lane flags (gateway-00735-koh, 2026-10-19), minus the two crossed below and the stored fold
// (which needs the backend's fold function; its own suites cover it).
const PROD_FLAGS = {
  CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: 'on',
  CANONICAL_CATALOG_SINGLE_PAYLOAD_READ: 'on',
  CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled',
  CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
  CANONICAL_CATALOG_RANK_V2: 'enabled',
  CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: 'enabled',
  CANONICAL_CATALOG_FORM_AGREEMENT: 'enabled',
};
const CROSSED = ['CANONICAL_CATALOG_SET_DIVERSITY', 'SEARCH_NAME_EVIDENCE_ADMISSION', 'CANONICAL_CATALOG_NARROW_RANK'];

const QUERIES = [...new Set([
  ...CASES.cases.map((c) => c.query),
  ...(CASES.ratchet_queries || []).map((x) => x.query),
  'lightweight hydrating gel moisturizer for sensitive dry skin',
  'long lasting matte red lipstick for dry lips',
  'lip gloss',             // the tied set/single leaf below
  'lip gloss gift set',    // set-seeking: set diversity is off for this query
  'sunscreen',
])];

function args(rawQuery, limit) {
  const contract = buildSearchQualityContract({ rawQuery });
  return {
    query: rawQuery,
    searchQualityContract: contract,
    brandFilter: contract.hard_constraints.brand,
    categoryPathPrefix: contract.hard_constraints.category_path_prefix,
    categoryMode: 'category_browse',
    limit,
    marketId: 'US',
    markets: ['US'],
    includeSkuOffers: true,
    offerScope: { inStockOnly: false, markets: ['US'], currency: null, priceRanges: null },
  };
}

// ~64KB of poorly compressible text: stored out of line, like prod's large payloads.
const BIG = Array.from({ length: 4000 }, (_, i) => `${i.toString(36)}${(i * 7919).toString(16)}${(i * 104729).toString(36)}`).join(' ');

suite('narrow rank returns exactly the wide statement\'s rows, in order (PostgreSQL)', () => {
  let db; let schema; let savedEnv;
  const run = (a) => fetchCanonicalChainRows({ ...a, deps: { query: (sql, params) => db.query(sql, params) } });
  const setFlags = (flags) => { for (const [k, v] of Object.entries(flags)) process.env[k] = v; };
  jest.setTimeout(600000);

  beforeAll(async () => {
    savedEnv = Object.fromEntries([...Object.keys(PROD_FLAGS), ...CROSSED].map((k) => [k, process.env[k]]));
    setFlags(PROD_FLAGS);
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `cnr_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);

    // Materialise every column any statement in this suite references, every flag combination.
    const statements = [];
    const capture = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
    for (const sd of ['off', 'enabled']) {
      for (const ne of ['off', 'on']) {
        for (const nr of ['off', 'on']) {
          setFlags({ CANONICAL_CATALOG_SET_DIVERSITY: sd, SEARCH_NAME_EVIDENCE_ADMISSION: ne, CANONICAL_CATALOG_NARROW_RANK: nr });
          for (const q of QUERIES) await fetchCanonicalChainRows({ ...args(q, 12), deps: capture });
        }
      }
    }
    const tables = {};
    for (const sql of statements) {
      for (const m of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
        const [, table, alias] = m;
        tables[table] ||= new Set();
        for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) tables[table].add(ref[1]);
      }
    }
    for (const t of ['catalog_products', 'catalog_skus', 'catalog_offers', 'catalog_merchants', 'index_pipeline_state']) tables[t] ||= new Set();
    ['product_key', 'merchant_id', 'platform', 'source_product_id', 'title', 'description', 'brand', 'product_type', 'category_path',
      'content_key', 'pivota_signature_id', 'pivota_canonical_url', 'canonical_url', 'image_url', 'product_payload', 'freshness_json',
      'updated_at', 'pdp_scope', 'material', 'care'].forEach((c) => tables.catalog_products.add(c));
    ['sku_key', 'product_key', 'source_variant_id', 'suppressed_at'].forEach((c) => tables.catalog_skus.add(c));
    ['offer_id', 'sku_key', 'product_key', 'merchant_effective_price', 'list_price', 'currency', 'availability', 'market', 'suppressed_at'].forEach((c) => tables.catalog_offers.add(c));
    ['merchant_id', 'merchant_name', 'status', 'primary_platform'].forEach((c) => tables.catalog_merchants.add(c));
    ['content_key', 'serving_eligible'].forEach((c) => tables.index_pipeline_state.add(c));
    for (const [table, cols] of Object.entries(tables)) {
      const defs = [...cols].map((col) => {
        // Both keys the re-read joins on are primary keys in prod (pivota-backend db/catalog.py).
        if (table === 'catalog_products' && col === 'product_key') return `${col} text PRIMARY KEY`;
        if (table === 'catalog_merchants' && col === 'merchant_id') return `${col} text PRIMARY KEY`;
        const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
          : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
            : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric'
              : /(_at)$/.test(col) ? 'timestamptz' : 'text';
        return `${col} ${type}`;
      });
      await db.query(`CREATE TABLE ${table} (${defs.join(', ')})`);
    }

    const insert = async ({ key, merchant, title, brand, type, path, payload, platform = 'shopify', seconds, price = 20, description = null }) => {
      await db.query(`INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, description, brand,
          product_type, category_path, content_key, pivota_signature_id, pivota_canonical_url, canonical_url, image_url,
          product_payload, freshness_json, updated_at, pdp_scope, material, care)
        VALUES ($1, $2, $3, $1, $4, $5, $6, $7, $8, $1, $1, 'https://agent.pivota.cc/products/' || $1, 'https://x.example/' || $1,
          'https://cdn.example/' || $1 || '.jpg', $9::jsonb, '{"checked":"2026-10-19"}'::jsonb, now() - ($10 || ' seconds')::interval,
          CASE WHEN $3 = 'external_seed' THEN 'multi_merchant_canonical' END, 'cotton', 'hand wash')`,
      [key, merchant, platform, title, description, brand, type, path, payload, String(seconds)]);
      await db.query('INSERT INTO index_pipeline_state(content_key, serving_eligible) VALUES ($1, true)', [key]);
      await db.query('INSERT INTO catalog_skus(sku_key, product_key, source_variant_id) VALUES ($1, $1, $2)', [key, `v_${key}`]);
      await db.query(`INSERT INTO catalog_offers(offer_id, sku_key, product_key, merchant_effective_price, list_price, currency, availability, market)
        VALUES ($1, $1, $1, $2, $2, 'USD', 'in_stock', 'US')`, [key, price]);
    };

    const merchants = [...new Set(ROWS.map((r) => r.merchant_id)), 'm_ties'];
    for (const m of merchants) {
      await db.query("INSERT INTO catalog_merchants(merchant_id, merchant_name, status, primary_platform) VALUES ($1, $1, 'active', 'shopify')", [m]);
    }
    for (const [i, r] of ROWS.entries()) {
      await insert({ key: `acc_${i}`, merchant: r.merchant_id, title: r.title, brand: r.brand, type: r.product_type, path: r.catalog_category_path,
        payload: i % 50 === 0 ? JSON.stringify({ blob: BIG }) : (i % 37 === 0 ? 'null' : '{}'), seconds: i,
        price: Number(r.price) > 0 ? Number(r.price) : 20, description: i % 7 === 0 ? BIG.slice(0, 3000) : `About ${r.title}` });
    }
    // The tie leaf: 40 sets and 40 singles named alike, so most of them share one rank score.
    for (let n = 0; n < 40; n += 1) {
      await insert({ key: `tie_a_set_${String(n).padStart(2, '0')}`, merchant: 'm_ties', title: `Shine Tint ${n}`, brand: 'TieBrand',
        type: 'Lip Gloss', path: 'beauty/makeup/lip/gloss',
        payload: JSON.stringify({ external_seed_product_family: 'set_or_collection', ...(n % 5 === 0 ? { blob: BIG } : {}) }), seconds: 1000 + (n % 3) });
      await insert({ key: `tie_b_one_${String(n).padStart(2, '0')}`, merchant: 'm_ties', title: `Shine Tint ${n}`, brand: 'TieBrand',
        type: 'Lip Gloss', path: 'beauty/makeup/lip/gloss',
        payload: JSON.stringify({ product_family: 'lip_gloss', ...(n % 5 === 0 ? { blob: BIG } : {}) }), seconds: 1000 + (n % 3) });
    }
    await db.query('ANALYZE');
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv || {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await db.end();
    }
  });

  test('the flag reads on/1/true/yes/enabled only, default off', () => {
    for (const v of ['on', '1', 'true', 'yes', 'enabled', ' ON ']) expect(isNarrowRankEnabled({ CANONICAL_CATALOG_NARROW_RANK: v })).toBe(true);
    for (const v of ['off', '0', '', undefined, 'narrow']) expect(isNarrowRankEnabled({ CANONICAL_CATALOG_NARROW_RANK: v })).toBe(false);
  });

  for (const sd of ['enabled', 'off']) {
    for (const ne of ['on', 'off']) {
      test(`set diversity ${sd} | name evidence ${ne}: every query, page 200 / 12 / 3, identical rows in identical order`, async () => {
        setFlags({ CANONICAL_CATALOG_SET_DIVERSITY: sd, SEARCH_NAME_EVIDENCE_ADMISSION: ne });
        const diffs = [];
        let cutPages = 0; let served = 0;
        for (const q of QUERIES) {
          let all = null;
          for (const limit of [200, 12, 3]) {
            process.env.CANONICAL_CATALOG_NARROW_RANK = 'off';
            const wide = await run(args(q, limit));
            process.env.CANONICAL_CATALOG_NARROW_RANK = 'on';
            const narrow = await run(args(q, limit));
            if (JSON.stringify(narrow) !== JSON.stringify(wide)) {
              const at = wide.findIndex((r, i) => JSON.stringify(r) !== JSON.stringify(narrow[i]));
              diffs.push({ q, limit, wide: wide.length, narrow: narrow.length, firstDiffAt: at,
                wideKey: wide[at]?.product_key, narrowKey: narrow[at]?.product_key });
            }
            // A page is candidate-sized (CANDIDATE_LIMIT_MIN 25, x4 the page), so the cut is live
            // whenever a smaller page returns fewer rows than the 200 page.
            if (limit === 200) all = wide.length; else if (wide.length < all) cutPages += 1;
            served += wide.length;
          }
        }
        expect(diffs).toEqual([]);
        // Not vacuous: real pages, many of them cut by the candidate LIMIT.
        expect(served).toBeGreaterThan(500);
        expect(cutPages).toBeGreaterThan(40);
      });
    }
  }

  test('the tie leaf really exercises the set quota and the cut inside one tie group', async () => {
    setFlags({ CANONICAL_CATALOG_SET_DIVERSITY: 'enabled', SEARCH_NAME_EVIDENCE_ADMISSION: 'on', CANONICAL_CATALOG_NARROW_RANK: 'on' });
    const all = await run(args('lip gloss', 200));
    const ties = all.filter((r) => r.product_key.startsWith('tie_'));
    expect(ties.length).toBe(80);
    expect(new Set(ties.map((r) => Number(r.rank_score))).size).toBe(1);   // one tie group
    // Demotion is visible: by key alone every set precedes every single; with the quota, the sets past
    // the quota fall behind the last single.
    const keys = ties.map((r) => r.product_key);
    const lastSingle = keys.lastIndexOf(keys.filter((k) => k.startsWith('tie_b_one_')).pop());
    expect(keys.slice(lastSingle + 1).every((k) => k.startsWith('tie_a_set_'))).toBe(true);
    expect(keys.slice(lastSingle + 1).length).toBeGreaterThan(20);
    // A page whose candidate cut (4x the page) lands inside the group: some of it survives, not all,
    // and that page is identical with the flag off.
    const before = all.findIndex((r) => r.product_key.startsWith('tie_'));
    const limit = Math.ceil((before + 40) / 4);
    const page = await run(args('lip gloss', limit));
    const tiesOnPage = page.filter((r) => r.product_key.startsWith('tie_')).length;
    expect(tiesOnPage).toBeGreaterThan(0);
    expect(tiesOnPage).toBeLessThan(80);
    process.env.CANONICAL_CATALOG_NARROW_RANK = 'off';
    expect(await run(args('lip gloss', limit))).toEqual(page);
    process.env.CANONICAL_CATALOG_NARROW_RANK = 'on';
    // The display columns came back through the re-read, out-of-line payloads included.
    const row = all.find((r) => r.product_key === 'tie_a_set_00');
    expect(row.product_title).toBe('Shine Tint 0');
    expect(row.material).toBe('cotton');
    expect(JSON.stringify(row.product_payload).length).toBeGreaterThan(8192);
  });

  test('flag on, the statement ranks narrow and re-reads wide; flag off, no trace of it', async () => {
    const statements = {};
    for (const nr of ['off', 'on']) {
      setFlags({ CANONICAL_CATALOG_SET_DIVERSITY: 'enabled', SEARCH_NAME_EVIDENCE_ADMISSION: 'on', CANONICAL_CATALOG_NARROW_RANK: nr });
      await fetchCanonicalChainRows({ ...args('lip gloss', 12), deps: { query: async (sql) => { statements[nr] = sql; return { rows: [] }; } } });
    }
    expect(statements.off).not.toContain('candidate_keys');
    const scoring = statements.on.slice(statements.on.indexOf('matched_products AS ('), statements.on.indexOf('candidate_keys AS ('));
    // The display columns are not projected by the scoring CTE (its rank and WHERE may still READ them).
    expect(scoring).not.toMatch(/AS product_description|\n\s+p\.product_payload,|\n\s+p\.freshness_json,|AS product_image_url/);
    const reread = statements.on.slice(statements.on.indexOf('candidate_products AS ('), statements.on.indexOf('candidate_slots AS ('));
    expect(reread).toContain('FROM candidate_keys k');
    expect(reread).toContain('JOIN catalog_products p ON p.product_key = k.product_key');
    expect(reread).toContain('p.product_payload,');
  });
});
