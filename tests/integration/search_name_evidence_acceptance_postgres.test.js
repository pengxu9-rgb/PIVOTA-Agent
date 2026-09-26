const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

// The acceptance set's 600 production rows (+ the Meitu row), loaded into real PostgreSQL, every
// tracked query served through the real route with SEARCH_NAME_EVIDENCE_ADMISSION off and on, at
// the default page size (12).
//
// Admission is decided by SQL (a carrier count over the catalog), so an offline gate harness
// cannot say what the flag does; this can. It pins:
//   * NO REMOVAL OR REORDERING AMONG ROWS THE CATEGORY SERVES: for every query, the flag-on page
//     with its admitted rows removed is a prefix of the flag-off page, in order. Admitted rows are
//     served ahead of them, so on a full page the last flag-off row(s) move to the next page --
//     they are pushed down, never dropped from recall (recall is pinned in
//     search_name_evidence_admission_postgres.test.js);
//   * every row the flag newly serves, so a widening shows up in review.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const FLAG = 'SEARCH_NAME_EVIDENCE_ADMISSION';
const ROWS = require('../acceptance/fixtures/serving_rows_2026_09_16.json').rows;
const CASES = require('../acceptance/cases.json');

// Reviewed 2026-09-17 against the fixture: rows the flag newly serves, per query.
const EXPECTED_ADDITIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_name_evidence_acceptance_expected.json'), 'utf8'));

suite('name-evidence admission over the acceptance fixture, real PostgreSQL', () => {
  let db, schema, priorEnv, app;
  jest.setTimeout(600000);
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `name_evidence_acc_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // Materialise the UNION of the columns every tracked query's statement references, flag off
    // and on, with and without the sku-offer join. One statement's columns were not enough: review of
    // #2230 found "vitamin c serum" (which takes the product-level offer join) failing with
    // `column o.product_key does not exist` in both passes -- a vacuous comparison.
    const tables = {};
    for (const [flag, includeSkuOffers] of [[null, true], [null, false], ['on', true], ['on', false]]) {
      if (flag) process.env[FLAG] = flag; else delete process.env[FLAG];
      for (const query of [...new Set([...CASES.cases.map((c) => c.query), ...(CASES.ratchet_queries || []).map((x) => x.query)])]) {
        const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
        let sql = '';
        await fetchCanonicalChainRows({ query, categoryPathPrefix: contract.hard_constraints.category_path_prefix, categoryMode: 'category_browse',
          brandFilter: contract.hard_constraints.brand, includeSkuOffers, marketId: 'SG', searchQualityContract: contract,
          deps: { query: async (text) => { sql = text; return { rows: [] }; } } });
        for (const match of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
          const [, table, alias] = match; tables[table] ||= new Set();
          for (const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) tables[table].add(ref[1]);
        }
      }
    }
    delete process.env[FLAG];
    tables.index_pipeline_state.add('serving_eligible');
    for (const [table, cols] of Object.entries(tables)) {
      const definitions = [...cols].map((col) => {
        const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean'
          : /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb'
            : /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric'
              : /(_at)$/.test(col) ? 'timestamptz' : 'text';
        return `${col} ${type}`;
      });
      await db.query(`CREATE TABLE ${table} (${definitions.join(',')})`);
    }
    const merchants = [...new Set(ROWS.map((r) => r.merchant_id))];
    for (const m of merchants) {
      await db.query("INSERT INTO catalog_merchants(merchant_id,merchant_name,status,primary_platform) VALUES ($1,$1,'active','shopify')", [m]);
    }
    for (const [i, r] of ROWS.entries()) {
      const key = `acc_${i}`;
      await db.query(`INSERT INTO catalog_products(product_key,merchant_id,platform,source_product_id,title,brand,product_type,
       category_path,content_key,pivota_signature_id,pivota_canonical_url,canonical_url,image_url,product_payload,updated_at)
       VALUES ($1,$2,'shopify',$3,$4,$5,$6,$7,$1,$8,$9,$10,$11,'{}'::jsonb, now() - ($12 || ' seconds')::interval)`,
      [key, r.merchant_id, String(r.product_id), r.title, r.brand, r.product_type, r.catalog_category_path,
        String(r.product_id), `https://agent.pivota.cc/products/${r.product_id}`, r.destination_url || `https://x.example/${key}`,
        r.image_url || `https://cdn.example/${key}.jpg`, String(i)]);
      await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible) VALUES ($1,true)', [key]);
      await db.query('INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$1,$2)', [key, `v_${key}`]);
      await db.query("INSERT INTO catalog_offers(offer_id,sku_key,product_key,merchant_effective_price,currency,availability) VALUES ($1,$1,$1,$2,$3,'in_stock')",
        [key, Number(r.price) > 0 ? Number(r.price) : 20, r.currency || 'USD']);
    }
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });

  const boot = (flag) => {
    priorEnv = { ...process.env }; jest.resetModules();
    Object.assign(process.env, { DATABASE_URL: url, PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      INDEX_ELIGIBLE_RECALL: 'false', PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce', PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: 'false',
      CANONICAL_CATALOG_RECALL_DOC_MATCH: 'off', CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'off',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      // 78 requests per pass exceed find_products_multi's 60-token bucket: review of #2230 found
      // ~20% of the recorded run was HTTP 429, compared empty-vs-empty and pinned as a result.
      GATEWAY_RATE_LIMIT_ENABLED: 'false' });
    if (flag) process.env[FLAG] = flag; else delete process.env[FLAG];
    nock.disableNetConnect(); nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query: async (sql, params) => {
      if (sql.includes('candidate_products AS') && sql.includes('ips.serving_eligible')) return db.query(sql, params);
      if (sql.includes('ips.index_eligible')) throw new Error('citation rescue must not execute');
      return { rows: [] };
    } }));
    app = require('../../src/server');
  };
  const unboot = () => { process.env = priorEnv; jest.dontMock('../../src/db'); jest.resetModules(); nock.cleanAll(); nock.enableNetConnect(); };

  const queries = [...new Set([...CASES.cases.map((c) => c.query), ...(CASES.ratchet_queries || []).map((x) => x.query)])];

  async function serveAll(flag) {
    boot(flag);
    const out = {};
    try {
      for (const query of queries) {
        const res = await request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_products_multi',
          payload: { search: { query, domain: 'beauty', market: 'SG', limit: 12 } }, metadata: { source: 'public_api', market: 'SG' } });
        // Every query must actually run: a 429 or a failed canonical statement is an empty page
        // on BOTH sides and would compare as "unchanged".
        expect({ query, status: res.status }).toEqual({ query, status: 200 });
        expect({ query, canonical_error: res.body.metadata?.canonical_error || null }).toEqual({ query, canonical_error: null });
        out[query] = {
          keys: (res.body.products || []).map((p) => String(p.source_product_id || p.platform_product_id || p.product_id)),
          waived: Number(res.body.metadata?.search_quality_tier_counts?.category_waived_by_name_evidence_count || 0),
        };
      }
    } finally { unboot(); }
    return out;
  }

  test('flag on: rows the category serves keep their order (admitted rows lead the page), and every addition is the reviewed list', async () => {
    const off = await serveAll(null);
    const on = await serveAll('on');
    const additions = {};
    for (const query of queries) {
      const added = on[query].keys.filter((k) => !off[query].keys.includes(k));
      if (added.length) additions[query] = added.sort();
      const kept = on[query].keys.filter((k) => !added.includes(k));
      expect({ query, kept }).toEqual({ query, kept: off[query].keys.slice(0, kept.length) });
    }
    if (process.env.WRITE_NAME_EVIDENCE_EXPECTED) {
      fs.writeFileSync(path.join(__dirname, 'search_name_evidence_acceptance_expected.json'), `${JSON.stringify(additions, null, 1)}\n`);
    }
    expect(additions).toEqual(EXPECTED_ADDITIONS);
  });
});
