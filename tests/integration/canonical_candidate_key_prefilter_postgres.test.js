'use strict';

// CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER must return EXACTLY what the unwrapped statement
// returns: same rows, same columns, same order. This runs both through real PostgreSQL over rows
// built to sit on every edge of the predicate -- category-bucket rows, text-only / token-only /
// recall_doc-only / ingredient-only matches outside the bucket, a merchant-name-only match, and rows
// each serving conjunct must still drop (not serving-eligible, no offer, source-unavailable seed,
// suppressed offer, wrong market) -- under prod's lane flags and the variations around them.
//
// Dedicated disposable DB only, same opt-in as the other *_postgres suites.

const { Client } = require('pg');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const FLAGS = [
  'CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER',
  'CANONICAL_CATALOG_RANK_V2', 'CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK',
  'CANONICAL_CATALOG_SET_DIVERSITY', 'CANONICAL_CATALOG_FORM_AGREEMENT',
  'CANONICAL_CATALOG_RECALL_DOC_MATCH',
  'CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION',
  'SEARCH_NAME_EVIDENCE_ADMISSION',
];

const QUERIES = [
  ['hair mask', 'beauty/haircare/'],
  ['niacinamide toner', 'beauty/skincare/tone/'],
  ['toner', 'beauty/skincare/tone/'],
  ['niacinamide', 'beauty/skincare/treat/'],
  ['Silver Serum Gloss', 'beauty/skincare/treat/'],
];

// Every SQL-affecting flag is stated in every config, so one config cannot inherit another's leftovers.
const OFF = { CANONICAL_CATALOG_RANK_V2: 'off', CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: 'off',
  CANONICAL_CATALOG_SET_DIVERSITY: 'off', CANONICAL_CATALOG_FORM_AGREEMENT: 'off' };
const CONFIGS = [
  // prod's COMPLETE lane config, read from the live gateway env on 2026-09-26 (gateway-00396-xuj)
  { name: 'prod', env: { CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
    CANONICAL_CATALOG_RANK_V2: 'enabled', CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: 'enabled',
    CANONICAL_CATALOG_SET_DIVERSITY: 'enabled', CANONICAL_CATALOG_FORM_AGREEMENT: 'enabled' } },
  { name: 'union + recall_doc only', env: { ...OFF, CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on' } },
  { name: 'union off', env: { ...OFF, CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off' } },
  // the plain clause reads m.merchant_name: the guard must leave it alone, so on == off trivially
  { name: 'recall_doc off', env: { ...OFF, CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on' } },
];

function args(query, prefix, { contract = false, limit = 200 } = {}) {
  return {
    query,
    categoryPathPrefix: prefix,
    categoryMode: 'category_browse',
    verticalSearch: /niacinamide/i.test(query),
    tokenMatch: true,
    sargableTextWhere: true,
    limit,
    marketId: 'US',
    markets: ['US'],
    includeSkuOffers: true,
    offerScope: { inStockOnly: false, markets: ['US'], currency: null, priceRanges: null },
    searchQualityContract: contract ? buildSearchQualityContract({ rawQuery: query }) : null,
  };
}

suite('candidate-key prefilter returns exactly the unwrapped rows (PostgreSQL)', () => {
  let db; let schema; let savedEnv;

  const run = async (a) => fetchCanonicalChainRows({ ...a, deps: { query: (sql, params) => db.query(sql, params) } });

  beforeAll(async () => {
    savedEnv = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `ckp_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);

    // Materialize every column any statement in this suite references (flag on and off, every
    // config), typed as the sibling suites type them. No production data.
    const statements = [];
    const capture = { query: async (sql) => { statements.push(sql); return { rows: [] }; } };
    for (const cfg of CONFIGS) {
      Object.assign(process.env, cfg.env);
      for (const nameEvidence of ['off', 'on']) {
        process.env.SEARCH_NAME_EVIDENCE_ADMISSION = nameEvidence;
        for (const flag of ['off', 'on']) {
          process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = flag;
          for (const [q, prefix] of QUERIES) {
            for (const contract of [false, true]) {
              await fetchCanonicalChainRows({ ...args(q, prefix, { contract }), deps: capture });
            }
          }
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

    await db.query(`INSERT INTO catalog_merchants(merchant_id, merchant_name, status) VALUES
      ('m_shop', 'Retailer', 'active'), ('m_mask', 'Mask Emporium', 'active'), ('m_off', 'Closed Shop', 'inactive')`);
    // [key, title, brand, category_path, merchant, platform, recall_doc, extra]
    const rows = [
      ['hair_1', 'Repair Treatment', 'BrandA', 'beauty/haircare/treatment', 'm_shop', 'shopify', null, {}],
      ['hair_2', 'Curl Cream', 'BrandB', 'beauty/haircare/styling', 'm_shop', 'shopify', null, {}],
      ['hair_mask_text', 'Overnight Hair Mask', 'BrandC', 'beauty/skincare/treat/mask', 'm_shop', 'shopify', null, {}],
      ['hair_token_only', 'Mask for Dry Hair Ends', 'BrandC', 'beauty/makeup/face', 'm_shop', 'shopify', null, {}],
      ['merchant_only', 'Rose Water', 'BrandD', 'beauty/fragrance/mist', 'm_mask', 'shopify', null, {}],
      ['tone_1', 'Hydrating Toner', 'BrandE', 'beauty/skincare/tone/toner', 'm_shop', 'shopify', null, {}],
      ['tone_2', 'Clarifying Essence', 'BrandF', 'beauty/skincare/tone/essence', 'm_shop', 'shopify', null, {}],
      ['recall_only', 'Daily Liquid', 'BrandG', 'beauty/makeup/face', 'external_seed', 'external_seed', 'niacinamide toner for pores', {}],
      ['ingredient_only', 'Balancing Fluid', 'BrandH', 'beauty/skincare/moisturize', 'm_shop', 'shopify', null, { ingredients: ['niacinamide'] }],
      ['treat_1', 'Niacinamide 10% Serum', 'BrandI', 'beauty/skincare/treat/serum', 'm_shop', 'shopify', null, {}],
      ['gloss', 'Silver Serum Gloss', 'BrandJ', 'beauty/skincare/treat/serum', 'm_shop', 'shopify', null, {}],
      // rows the serving conjuncts must drop whether or not the prefilter runs
      ['not_serving', 'Hair Mask Deluxe', 'BrandK', 'beauty/haircare/treatment', 'm_shop', 'shopify', null, { serving: false }],
      ['no_offer', 'Hair Mask Travel', 'BrandK', 'beauty/haircare/treatment', 'm_shop', 'shopify', null, { offer: false }],
      ['seed_unavailable', 'Toner Mist', 'BrandL', 'beauty/skincare/tone/toner', 'external_seed', 'external_seed', 'toner',
        { payload: { source_unavailable_v1: { status: 'source_unavailable' } } }],
      ['suppressed_offer', 'Toner Pads', 'BrandM', 'beauty/skincare/tone/toner', 'm_shop', 'shopify', null, { suppressed: true }],
      ['wrong_market', 'Toner Gel', 'BrandN', 'beauty/skincare/tone/toner', 'm_shop', 'shopify', null, { market: 'JP' }],
      ['inactive_merchant', 'Hair Mask Gold', 'BrandO', 'beauty/haircare/treatment', 'm_off', 'shopify', null, {}],
    ];
    let minute = 0;
    for (const [key, title, brand, path, merchant, platform, recallDoc, extra] of rows) {
      minute += 1;
      await db.query(`INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, brand,
          product_type, category_path, content_key, product_payload, recall_doc, recall_market, updated_at, pdp_scope)
        VALUES ($1, $2, $3, $1, $4, $5, 'Beauty', $6, $1, $7, $8, NULL, now() - ($9 || ' minutes')::interval,
          CASE WHEN $3 = 'external_seed' THEN 'multi_merchant_canonical' END)`,
      [key, merchant, platform, title, brand, path, extra.payload || {}, recallDoc, String(minute)]);
      await db.query('INSERT INTO index_pipeline_state(content_key, serving_eligible) VALUES ($1, $2)', [key, extra.serving !== false]);
      await db.query('INSERT INTO catalog_skus(sku_key, product_key, sku, source_variant_id, title, ingredient_ids, visible_option_labels) VALUES ($1, $1, $2, $3, $4, $5, $6)',
        [key, `SKU-${key}`, `v_${key}`, 'Default', JSON.stringify(extra.ingredients || ['aqua']), JSON.stringify(['50ml'])]);
      if (extra.offer !== false) {
        await db.query(`INSERT INTO catalog_offers(offer_id, sku_key, merchant_effective_price, list_price, currency, availability, market, suppressed_at)
          VALUES ($1, $1, 20, 25, 'USD', 'in_stock', $2, $3)`, [key, extra.market || 'US', extra.suppressed ? new Date() : null]);
      }
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

  for (const cfg of CONFIGS) {
    for (const nameEvidence of ['off', 'on']) {
      for (const [q, prefix] of QUERIES) {
        for (const contract of [false, true]) {
          for (const limit of [3, 200]) {
            test(`${cfg.name} | name evidence ${nameEvidence} | ${q}${contract ? ' | contract' : ''} | limit ${limit}`, async () => {
              Object.assign(process.env, cfg.env, { SEARCH_NAME_EVIDENCE_ADMISSION: nameEvidence });
              process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'off';
              const off = await run(args(q, prefix, { contract, limit }));
              process.env.CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER = 'on';
              const on = await run(args(q, prefix, { contract, limit }));
              expect(on).toEqual(off);
            });
          }
        }
      }
    }
  }

  test('the fixture exercises the edges it claims to (prod config, no contract)', async () => {
    Object.assign(process.env, CONFIGS[0].env, { SEARCH_NAME_EVIDENCE_ADMISSION: 'off', CANONICAL_CATALOG_CANDIDATE_KEY_PREFILTER: 'on' });
    const keys = async (q, prefix) => (await run(args(q, prefix))).map((r) => r.product_key);
    const hair = await keys('hair mask', 'beauty/haircare/');
    expect(hair).toEqual(expect.arrayContaining(['hair_1', 'hair_2', 'hair_mask_text', 'hair_token_only']));
    for (const dropped of ['not_serving', 'no_offer', 'inactive_merchant', 'merchant_only']) expect(hair).not.toContain(dropped);
    const nt = await keys('niacinamide toner', 'beauty/skincare/tone/');
    expect(nt).toEqual(expect.arrayContaining(['tone_1', 'tone_2', 'recall_only']));
    const tone = await keys('toner', 'beauty/skincare/tone/');
    for (const dropped of ['seed_unavailable', 'suppressed_offer', 'wrong_market']) expect(tone).not.toContain(dropped);
    expect(await keys('niacinamide', 'beauty/skincare/treat/')).toEqual(expect.arrayContaining(['treat_1', 'ingredient_only']));
  });
});
