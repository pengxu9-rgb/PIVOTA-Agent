const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');

// Regression for the 80371af8 rollback (2026-09-15): every beauty search through the MCP
// search_catalog door (source shopping-agent-ui) answered 503 BEAUTY_PRIMARY_RECALL_FAILED with
// PostgreSQL 42P18 "could not determine data type of parameter $N". fetchCanonicalChainRows pushed
// the recall_doc binds, then the search-quality contract REPLACED the WHERE that referenced them.
// The four sibling PostgreSQL suites turn the recall_doc arm and the category-browse text union
// OFF; production turns both ON. Here the canonical AND seed statements execute on PostgreSQL under
// the production flag values (read from the live gateway service 2026-09-15), and every bind in
// every primary statement must be referenced.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const PROD_FLAGS = {
  CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
  CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: 'enabled',
  CANONICAL_CATALOG_FORM_AGREEMENT: 'enabled',
  CANONICAL_CATALOG_RANK_V2: 'enabled',
  CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled',
  CANONICAL_CATALOG_SET_DIVERSITY: 'enabled',
  INDEX_ELIGIBLE_RECALL: '1',
  PIVOT_BEAUTY_ACTIVE_AWARE_RANK_ENABLED: 'true',
  PIVOT_BEAUTY_MAINLINE_SARGABLE_TEXT_WHERE_ENABLED: 'true',
};
// PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED is secret-backed in production; it shifts the bind
// numbering, so both values are exercised.
const TOKEN_MATCH_VALUES = ['true', 'false'];
// SEARCH_NAME_EVIDENCE_ADMISSION adds a CTE and binds; both values are exercised. `Metal Serum Gloss`
// is the query that arms it (a category guess plus rare name tokens).
const NAME_EVIDENCE_VALUES = ['off', 'on'];
const QUERIES = [
  "A'pieu",
  'lightweight moisturizer face moisturizer',
  'MAC lipstick makeup foundation concealer mascara lipstick',
  'Metal Serum Gloss',
];

const unreferencedBinds = (sql, params) =>
  params.map((_, i) => i + 1).filter((n) => !new RegExp(`\\$${n}(?!\\d)`).test(sql));

suite('find_products_multi under production canonical flags binds only referenced parameters', () => {
  let db;
  let schema;
  let priorEnv;
  let app;
  let sqlCalls;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `prod_flag_binds_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
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
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  const load = (tokenMatch, nameEvidence = 'off') => {
    priorEnv = { ...process.env };
    jest.resetModules();
    sqlCalls = [];
    Object.assign(process.env, {
      DATABASE_URL: url,
      PIVOTA_API_BASE: 'http://upstream-disabled.test',
      PIVOTA_API_KEY: 'test',
      API_MODE: 'REAL',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      ...PROD_FLAGS,
      PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED: tokenMatch,
      SEARCH_NAME_EVIDENCE_ADMISSION: nameEvidence,
    });
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({
      query: async (sql, params = []) => {
        const primary = sql.includes('ips.serving_eligible') &&
          // Not `WITH candidate_products AS`: with name-evidence admission on, the statement opens
          // `WITH name_evidence_carriers AS MATERIALIZED (...), candidate_products AS (`. Measured: in
          // this suite the armed statement was still caught, but only because it also contains
          // `FROM external_product_seeds` -- match the CTE names directly instead of relying on that.
          (sql.includes('candidate_products AS') || sql.includes('matched_products AS') || sql.includes('FROM external_product_seeds'));
        if (!primary) return { rows: [] };
        const call = { sql, params, unreferenced: unreferencedBinds(sql, params) };
        sqlCalls.push(call);
        try {
          return await db.query(sql, params);
        } catch (err) {
          call.error = `${err.code}: ${err.message}`;
          throw err;
        }
      },
    }));
    app = require('../../src/server');
  };

  afterEach(() => {
    if (priorEnv) process.env = priorEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  const cases = NAME_EVIDENCE_VALUES.flatMap((nameEvidence) => TOKEN_MATCH_VALUES.flatMap((tokenMatch) =>
    QUERIES.map((query) => [query, tokenMatch, nameEvidence])));
  test.each(cases)('%s (token match %s, name evidence %s): the shopping-agent-ui door executes on PostgreSQL', async (query, tokenMatch, nameEvidence) => {
    load(tokenMatch, nameEvidence);
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi',
      payload: { search: { query, market: 'US', limit: 10 } },
      metadata: { source: 'shopping-agent-ui', market: 'US' },
    });
    expect(sqlCalls.length).toBeGreaterThan(0);
    // Both lanes must actually have reached PostgreSQL, or this proves nothing about the canonical SQL.
    expect(sqlCalls.some((call) => call.sql.includes('catalog_products p'))).toBe(true);
    if (nameEvidence === 'on' && query === 'Metal Serum Gloss') {
      // The armed statement itself must have executed -- not merely some statement. (With flag
      // 'off' no statement may carry the arm; that side is pinned by the flag-off byte identity.)
      expect(sqlCalls.some((call) => call.sql.includes('name_evidence_carriers'))).toBe(true);
    }
    expect(sqlCalls.map((call) => ({ error: call.error || null, unreferenced: call.unreferenced })))
      .toEqual(sqlCalls.map(() => ({ error: null, unreferenced: [] })));
    expect(res.status).toBe(200);
  });
});
