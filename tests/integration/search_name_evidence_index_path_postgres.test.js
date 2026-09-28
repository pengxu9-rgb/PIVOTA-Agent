'use strict';

// NAME-EVIDENCE ADMISSION MUST NOT COST THE CATEGORY BROWSE ITS INDEX.
//
// The admitted arm is OR'd with the category WHERE, and PostgreSQL can serve an OR from indexes (a
// BitmapOr) only when every arm has an indexable clause. The first version's arm was a CASE over a
// carrier count and per-row regexes, so the whole OR had none: every armed category browse ("nail
// polish", "curl cream", "lip gloss", ...) became a Seq Scan of catalog_products evaluating the
// own-name regexes on each row -- 3.2-4.1s in prod against ~0.2s with the arm off (2026-09-27, prod
// flags, candidate-key prefilter on). The arm now admits by `p.product_key = ANY(<carrier keys>)`, a
// primary-key index condition.
//
// This pins the PLAN, which the behaviour suites (search_name_evidence_admission_postgres,
// search_name_evidence_acceptance_postgres) cannot see: over a catalog_products carrying prod's two
// relevant indexes -- the primary key and 243's category_path varchar_pattern_ops -- the candidate-key
// prefilter's scan must be a bitmap scan that ORs the category index with the primary key.
// `enable_seqscan = off` makes the planner take an index path whenever one exists, so a tiny fixture
// answers the question the prod catalog does; with no indexable path it still has to fall back.
//
// Dedicated disposable DB only, same opt-in as the other *_postgres suites.

const { Client } = require('pg');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// prod's lane flags (live gateway env, gateway-00438-geg, 2026-09-27) plus the two this is about.
const ENV = {
  CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: 'on',
  SEARCH_NAME_EVIDENCE_ADMISSION: 'on',
  CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled',
  CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
  CANONICAL_CATALOG_RANK_V2: 'enabled',
  CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: 'enabled',
  CANONICAL_CATALOG_SET_DIVERSITY: 'enabled',
  CANONICAL_CATALOG_FORM_AGREEMENT: 'enabled',
};

// A browse with no product-form rule (the category predicate alone), a browse with one (category OR
// ancestor-with-form, AND NOT conflicting type), and a name.
const QUERIES = [
  ['nail polish', 'beauty/makeup/nails/nail-polish/'],
  ['lip gloss', 'beauty/makeup/lips/lip-gloss/'],
  ['Silver Serum Gloss', 'beauty/skincare/treat/'],
];

const CATEGORY_INDEX = 'ne_idx_category_path_pattern';
const PRIMARY_KEY = 'ne_catalog_products_pkey';

function args(query, prefix) {
  return {
    query,
    categoryPathPrefix: prefix,
    categoryMode: 'category_browse',
    limit: 200,
    marketId: 'US',
    markets: ['US'],
    includeSkuOffers: true,
    offerScope: { inStockOnly: false, markets: ['US'], currency: null, priceRanges: null },
    searchQualityContract: buildSearchQualityContract({ rawQuery: query }),
  };
}

async function captureStatement(query, prefix) {
  let captured = null;
  await fetchCanonicalChainRows({ ...args(query, prefix), deps: { query: async (sql, params) => {
    if (sql.includes('candidate_products AS') && !captured) captured = { sql, params };
    return { rows: [] };
  } } });
  return captured;
}

function nodes(plan, out = [], ancestors = []) {
  out.push({ node: plan, ancestors });
  for (const child of plan.Plans || []) nodes(child, out, [...ancestors, plan]);
  return out;
}

suite('name-evidence admission keeps the category browse on its index (PostgreSQL)', () => {
  let db; let schema; let savedEnv;

  beforeAll(async () => {
    savedEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, ENV);
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `ne_idx_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);

    const statements = [];
    for (const [q, prefix] of QUERIES) statements.push((await captureStatement(q, prefix)).sql);
    const tables = {};
    for (const sql of statements) {
      for (const m of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
        const [, table, alias] = m;
        tables[table] ||= new Set();
        for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) tables[table].add(ref[1]);
      }
    }
    ['product_key', 'category_path', 'title', 'product_type'].forEach((c) => tables.catalog_products.add(c));
    for (const [table, cols] of Object.entries(tables)) {
      const defs = [...cols].map((col) => {
        // prod's types for the two indexed columns: both varchar.
        if (table === 'catalog_products' && col === 'product_key') return `${col} varchar(255) CONSTRAINT ${PRIMARY_KEY} PRIMARY KEY`;
        if (table === 'catalog_products' && col === 'category_path') return `${col} varchar(255)`;
        const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
          : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
            : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric'
              : /(_at)$/.test(col) ? 'timestamptz' : 'text';
        return `${col} ${type}`;
      });
      await db.query(`CREATE TABLE ${table} (${defs.join(', ')})`);
    }
    // 243's index, as prod has it.
    await db.query(`CREATE INDEX ${CATEGORY_INDEX} ON catalog_products (category_path varchar_pattern_ops)`);
    const paths = ['beauty/makeup/nails/nail-polish', 'beauty/makeup/lips/lip-gloss', 'beauty/skincare/treat/serum',
      'beauty/skincare/moisturize/cream', 'beauty/haircare/styling', 'beauty/makeup/eyes/mascara'];
    await db.query(`INSERT INTO catalog_products (product_key, category_path, title, product_type)
      SELECT 'k' || g, (ARRAY['${paths.join("','")}'])[1 + g % ${paths.length}], 'Product ' || g, 'type'
      FROM generate_series(1, 3000) g`);
    await db.query('ANALYZE catalog_products');
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv || {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
      await db.end();
    }
  });

  test.each(QUERIES)('%s: the prefilter is a bitmap scan ORing the category index with the primary key', async (query, prefix) => {
    const { sql, params } = await captureStatement(query, prefix);
    expect(sql).toContain('name_evidence_carriers');  // premise: the arm is armed
    expect(sql).toContain('p.product_key = ANY(ARRAY(');  // premise: the prefilter wraps the WHERE
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL enable_seqscan = off');
      const { rows } = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      const all = nodes(rows[0]['QUERY PLAN'][0].Plan);
      // The prefilter is the scan of catalog_products `p` that is, or sits under, a non-CTE InitPlan (the
      // ARRAY(SELECT ...)). The outer candidate scan of `p` is not, and the carrier CTE scans `np`.
      // EXPLAIN uniquifies repeated aliases (p, p_1, p_2).
      const isInitPlan = (n) => n['Parent Relationship'] === 'InitPlan' && !String(n['Subplan Name'] || '').startsWith('CTE');
      const prefilter = all.filter(({ node, ancestors }) => node['Relation Name'] === 'catalog_products' && /^p(_\d+)?$/.test(node.Alias)
        && [node, ...ancestors].some(isInitPlan));
      expect(prefilter.map(({ node }) => node['Node Type'])).toEqual(['Bitmap Heap Scan']);
      const indexes = nodes(prefilter[0].node).map(({ node }) => node['Index Name']).filter(Boolean);
      expect(indexes).toContain(CATEGORY_INDEX);
      expect(indexes).toContain(PRIMARY_KEY);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
