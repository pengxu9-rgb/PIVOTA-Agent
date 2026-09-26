'use strict';

// CANONICAL_CATALOG_SINGLE_PAYLOAD_READ must return EXACTLY what the per-reference statement returns.
// The fixture puts a row on every payload-driven branch of the candidate CTE: each source-unavailable
// marker (status in mixed case, contract_version, the transaction-readiness twin), each product-family
// path the rank arm reads, a brand that exists ONLY inside the payload (brand filter), NULL / JSON-null
// / array payloads, and payloads large enough to be stored out of line -- the case the flag exists for.
// Both flags (prefilter, single read) are crossed, with the search-quality contract and name evidence.
//
// Dedicated disposable DB only, same opt-in as the other *_postgres suites.

const { Client } = require('pg');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const FLAGS = [
  'CANONICAL_CATALOG_SINGLE_PAYLOAD_READ',
  'CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER',
  'CANONICAL_CATALOG_RECALL_DOC_MATCH',
  'CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION',
  'SEARCH_NAME_EVIDENCE_ADMISSION',
];

const QUERIES = [
  { q: 'toner', prefix: 'beauty/skincare/tone/' },
  { q: 'hair mask', prefix: 'beauty/haircare/' },
  { q: 'cosrx toner', prefix: 'beauty/skincare/tone/', brandFilter: 'cosrx' },
  { q: 'Silver Serum Gloss', prefix: 'beauty/skincare/treat/', contract: true },
];

function args({ q, prefix, brandFilter = null, contract = false }, limit) {
  return {
    query: q,
    categoryPathPrefix: prefix,
    categoryMode: 'category_browse',
    verticalSearch: false,
    tokenMatch: true,
    sargableTextWhere: true,
    limit,
    marketId: 'US',
    markets: ['US'],
    includeSkuOffers: true,
    offerScope: { inStockOnly: false, markets: ['US'], currency: null, priceRanges: null },
    brandFilter,
    searchQualityContract: contract ? buildSearchQualityContract({ rawQuery: q }) : null,
  };
}

// ~64KB of poorly compressible text: stored out of line, like prod's large payloads.
const BIG = Array.from({ length: 4000 }, (_, i) => `${i.toString(36)}${(i * 7919).toString(16)}${(i * 104729).toString(36)}`).join(' ');

suite('single payload read returns exactly the per-reference rows (PostgreSQL)', () => {
  let db; let schema; let savedEnv;
  const run = (a) => fetchCanonicalChainRows({ ...a, deps: { query: (sql, params) => db.query(sql, params) } });

  beforeAll(async () => {
    savedEnv = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `csp_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);

    // Materialize every column any statement in this suite references (both flags, every query).
    const statements = [];
    const capture = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
    Object.assign(process.env, { CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on' });
    for (const single of ['off', 'on']) {
      for (const pre of ['off', 'on']) {
        for (const ne of ['off', 'on']) {
          Object.assign(process.env, { CANONICAL_CATALOG_SINGLE_PAYLOAD_READ: single, CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: pre, SEARCH_NAME_EVIDENCE_ADMISSION: ne });
          for (const c of QUERIES) await fetchCanonicalChainRows({ ...args(c, 200), deps: capture });
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
    ['product_key', 'merchant_id', 'platform', 'source_product_id', 'title', 'brand', 'product_type', 'category_path',
      'content_key', 'product_payload', 'recall_doc', 'recall_market', 'updated_at', 'pdp_scope'].forEach((c) => tables.catalog_products.add(c));
    ['sku_key', 'product_key', 'sku', 'source_variant_id', 'title', 'ingredient_ids', 'visible_option_labels', 'suppressed_at'].forEach((c) => tables.catalog_skus.add(c));
    ['offer_id', 'sku_key', 'merchant_effective_price', 'list_price', 'currency', 'availability', 'market', 'suppressed_at'].forEach((c) => tables.catalog_offers.add(c));
    ['merchant_id', 'merchant_name', 'status'].forEach((c) => tables.catalog_merchants.add(c));
    ['content_key', 'serving_eligible'].forEach((c) => tables.index_pipeline_state.add(c));
    for (const [table, cols] of Object.entries(tables)) {
      const defs = [...cols].map((col) => {
        const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
          : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
            : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric'
              : /(_at)$/.test(col) ? 'timestamptz' : 'text';
        return `${col} ${type}`;
      });
      await db.query(`CREATE TABLE ${table} (${defs.join(', ')})`);
    }
    await db.query("INSERT INTO catalog_merchants(merchant_id, merchant_name, status) VALUES ('m_shop', 'Retailer', 'active')");

    // [key, title, brand column, category_path, platform, payload (JSON text, or null for SQL NULL)]
    const rows = [
      ['tone_plain', 'Hydrating Toner', 'BrandA', 'beauty/skincare/tone/toner', 'shopify', '{}'],
      ['tone_seed_ok', 'Balancing Toner', 'BrandB', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ product_family: 'toner' })],
      ['tone_family_seed', 'Glow Toner', 'BrandC', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ external_seed_product_family: 'set_or_collection' })],
      ['tone_family_kind', 'Duo Toner', 'BrandC', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ external_seed_product_kind: { family: 'set_or_collection' } })],
      ['tone_unavail_status', 'Old Toner', 'BrandD', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ source_unavailable_v1: { status: 'Source_Unavailable' } })],
      ['tone_unavail_contract', 'Gone Toner', 'BrandD', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ source_unavailable_v1: { contract_version: 'external_seed.source_unavailable.v1' } })],
      ['tone_blocker', 'Blocked Toner', 'BrandD', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ transaction_readiness_blocker_v1: { status: 'SOURCE_UNAVAILABLE' } })],
      ['tone_status_not_string', 'Odd Toner', 'BrandD', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ source_unavailable_v1: { status: 1 } })],
      ['tone_null_payload', 'Bare Toner', 'BrandE', 'beauty/skincare/tone/toner', 'external_seed', null],
      ['tone_json_null', 'Null Toner', 'BrandE', 'beauty/skincare/tone/toner', 'external_seed', 'null'],
      ['tone_array_payload', 'Array Toner', 'BrandE', 'beauty/skincare/tone/toner', 'external_seed', '[1, 2]'],
      ['tone_big', 'Big Toner', 'BrandF', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ product_family: 'toner', blob: BIG })],
      ['tone_big_unavail', 'Big Gone Toner', 'BrandF', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ blob: BIG, source_unavailable_v1: { status: 'source_unavailable' } })],
      // brand filter: the brand only inside the payload, at several of the paths the filter reads
      ['cosrx_vendor', 'Pure Fit Toner', '', 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ vendor: 'COSRX', blob: BIG })],
      ['cosrx_seed', 'AHA BHA Toner', null, 'beauty/skincare/tone/toner', 'external_seed', JSON.stringify({ seed_data: { snapshot: { brand: 'cosrx' } } })],
      ['cosrx_column', 'Centella Toner', 'COSRX', 'beauty/skincare/tone/toner', 'shopify', '{}'],
      ['hair_1', 'Repair Hair Mask', 'BrandG', 'beauty/haircare/treatment', 'external_seed', JSON.stringify({ product_family: 'hair_mask', blob: BIG })],
      ['hair_2', 'Hair Oil', 'BrandG', 'beauty/haircare/oil', 'shopify', '{}'],
      ['gloss', 'Silver Serum Gloss', 'BrandH', 'beauty/skincare/treat/serum', 'external_seed', JSON.stringify({ canonical_title: 'Silver Serum Gloss', blob: BIG })],
      ['gloss_named_in_payload', 'Night Drops', 'BrandH', 'beauty/skincare/treat/serum', 'external_seed', JSON.stringify({ canonical_name: 'Silver Serum Gloss' })],
    ];
    let minute = 0;
    for (const [key, title, brand, path, platform, payload] of rows) {
      minute += 1;
      await db.query(`INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, brand,
          product_type, category_path, content_key, product_payload, updated_at, pdp_scope)
        VALUES ($1, 'm_shop', $2, $1, $3, $4, 'Beauty', $5, $1, $6::jsonb, now() - ($7 || ' minutes')::interval,
          CASE WHEN $2 = 'external_seed' THEN 'multi_merchant_canonical' END)`,
      [key, platform, title, brand, path, payload, String(minute)]);
      await db.query('INSERT INTO index_pipeline_state(content_key, serving_eligible) VALUES ($1, true)', [key]);
      await db.query('INSERT INTO catalog_skus(sku_key, product_key, sku, source_variant_id, title, ingredient_ids, visible_option_labels) VALUES ($1, $1, $2, $3, $4, $5, $6)',
        [key, `SKU-${key}`, `v_${key}`, 'Default', JSON.stringify(['aqua']), JSON.stringify(['50ml'])]);
      await db.query(`INSERT INTO catalog_offers(offer_id, sku_key, merchant_effective_price, list_price, currency, availability, market)
        VALUES ($1, $1, 20, 25, 'USD', 'in_stock', 'US')`, [key]);
    }
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv || {})) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  });

  test('the fixture really stores the large payloads out of line', async () => {
    const r = await db.query("SELECT octet_length(product_payload::text) AS raw FROM catalog_products WHERE product_key = 'tone_big'");
    expect(Number(r.rows[0].raw)).toBeGreaterThan(8192); // far past the ~2KB TOAST threshold
    // Direct proof: the table's TOAST relation holds chunks.
    const t = await db.query("SELECT reltoastrelid::regclass::text AS rel FROM pg_class WHERE oid = 'catalog_products'::regclass");
    const chunks = await db.query(`SELECT count(*)::int AS n FROM ${t.rows[0].rel}`);
    expect(chunks.rows[0].n).toBeGreaterThan(0);
  });

  for (const pre of ['off', 'on']) {
    for (const ne of ['off', 'on']) {
      for (const c of QUERIES) {
        for (const limit of [3, 200]) {
          test(`prefilter ${pre} | name evidence ${ne} | ${c.q}${c.brandFilter ? ' | brand' : ''}${c.contract ? ' | contract' : ''} | limit ${limit}`, async () => {
            Object.assign(process.env, {
              CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
              CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: pre, SEARCH_NAME_EVIDENCE_ADMISSION: ne,
            });
            process.env.CANONICAL_CATALOG_SINGLE_PAYLOAD_READ = 'off';
            const off = await run(args(c, limit));
            process.env.CANONICAL_CATALOG_SINGLE_PAYLOAD_READ = 'on';
            const on = await run(args(c, limit));
            expect(on).toEqual(off);
          });
        }
      }
    }
  }

  test('the fixture exercises the payload branches it claims to (flag on)', async () => {
    Object.assign(process.env, {
      CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
      CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: 'on', SEARCH_NAME_EVIDENCE_ADMISSION: 'off', CANONICAL_CATALOG_SINGLE_PAYLOAD_READ: 'on',
    });
    const toner = await run(args(QUERIES[0], 200));
    const keys = toner.map((r) => r.product_key);
    // served: plain, family variants, odd / null / array payloads, the big one
    for (const k of ['tone_plain', 'tone_seed_ok', 'tone_family_seed', 'tone_family_kind', 'tone_status_not_string',
      'tone_null_payload', 'tone_json_null', 'tone_array_payload', 'tone_big']) expect(keys).toContain(k);
    // refused by a payload marker, including the one inside the big out-of-line payload
    for (const k of ['tone_unavail_status', 'tone_unavail_contract', 'tone_blocker', 'tone_big_unavail']) expect(keys).not.toContain(k);
    // the family rank arm is live: a set/collection sorts below a same-bucket single product
    const rank = Object.fromEntries(toner.map((r) => [r.product_key, Number(r.rank_score)]));
    expect(rank.tone_seed_ok).toBeGreaterThan(rank.tone_family_seed);
    expect(rank.tone_family_seed).toBe(rank.tone_family_kind);
    // the brand filter reads the payload: vendor and seed_data.snapshot.brand both admit
    const cosrx = (await run(args(QUERIES[2], 200))).map((r) => r.product_key);
    for (const k of ['cosrx_vendor', 'cosrx_seed', 'cosrx_column']) expect(cosrx).toContain(k);
    expect(cosrx).not.toContain('tone_plain');
  });
});
