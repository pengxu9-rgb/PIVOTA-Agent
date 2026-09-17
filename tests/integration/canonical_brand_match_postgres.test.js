const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// The brand page's commerce-index lane (discoveryFeed's fetchBrandScopedCanonicalCandidates) found a
// brand's content keys with `lower(brand) = ANY($1) OR regexp_replace(lower(brand), ...) = ANY($2)`,
// which no index served: every brand-page cache miss scanned catalog_products and ran regexp_replace on
// every row (~44ms in prod on 2026-09-17, for every brand). The match is now a UNION of one indexed branch
// per spelling (canonicalBrandMatchSql.js). This runs the REAL fetcher against real PostgreSQL and pins:
//   1. EQUIVALENCE. The old statement is frozen verbatim in tests/fixtures/canonical_brand_scoped_or_filter_sql.txt
//      (captured from origin/main before the change). Old and new run side by side, with the parameters the
//      fetcher itself builds, over brands that match only lowercased, only compacted, both, by case alone,
//      through punctuation and non-ASCII letters, plus rows excluded by a NULL brand or a NULL content key,
//      several products sharing one content key, and a brand that matches nothing. Every returned row and
//      column must be identical.
//   2. PLAN CHOICE + INDEXABILITY: on a 20k-row, 400-brand fixture with the planner left alone, the brand
//      match never scans catalog_products and probes both indexes with an Index Cond on their expressions;
//      the same statement before the indexes exist does scan.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const OLD_SQL = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'canonical_brand_scoped_or_filter_sql.txt'), 'utf8');

const BRANDS = ['Fenty Beauty', 'FENTY', 'Dr. Jart+', 'Aëtas', 'Round Lab', 'SKIN1004', 'Unknown Brand Nobody Sells', 'fenty beauty'];

suite('canonical brand match on PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;
  let definitions;

  const createTables = async () => {
    await db.query(`
      CREATE TABLE catalog_products(product_key varchar PRIMARY KEY, content_key varchar, brand varchar(255), merchant_id varchar,
        platform varchar, source_product_id varchar, sync_status varchar, suppression_reason varchar, updated_at timestamptz,
        canonical_url text, pivota_signature_id text);
      CREATE INDEX idx_catalog_products_content_key ON catalog_products(content_key);
      CREATE TABLE agent_pdp_view(content_key varchar PRIMARY KEY, pivota_signature_id varchar, brand text, title text,
        description text, image_url text, image_urls jsonb, currency text, price_min numeric, price_max numeric,
        offer_count int, offers jsonb, category_path text, refreshed_at timestamptz);
      CREATE TABLE catalog_row_trust(subject_type text, subject_key text, serving_decision text, PRIMARY KEY (subject_type, subject_key));
      CREATE TABLE external_product_seeds(id text PRIMARY KEY, attached_product_key text, status text, destination_url text,
        updated_at timestamptz);
      CREATE INDEX idx_external_product_seeds_attached ON external_product_seeds(attached_product_key);
    `);
  };

  const createBrandIndexes = async () => {
    for (const index of definitions) await db.query(index.sql.replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
  };

  // Every product gets a servable identity: a view row, a public trust row, a live external_seed row with
  // an active seed. What varies is only the brand, so membership is decided by the brand match alone.
  const product = async ({ key, content, brand, refreshed = '2026-09-01' }) => {
    await db.query(
      `INSERT INTO catalog_products VALUES ($1::text, $2::text, $3::text, 'merch_obs_x', 'external_seed', 'ext_' || $1::text, 'live',
         NULL, now(), 'https://shop.example/' || $1::text, 'sig_' || $2::text)`,
      [key, content, brand],
    );
    if (content) {
      await db.query(
        `INSERT INTO agent_pdp_view VALUES ($1::text, 'sig_' || $1::text, $2::text, 'Title ' || $1::text, 'Desc', NULL, NULL, 'USD', 10, 12, 1, NULL,
           'beauty/skincare', $3::timestamptz) ON CONFLICT (content_key) DO NOTHING`,
        [content, brand, refreshed],
      );
    }
    await db.query(`INSERT INTO catalog_row_trust VALUES ('product', $1::text, 'public')`, [key]);
    await db.query(`INSERT INTO external_product_seeds VALUES ('eps_' || $1::text, $1::text, 'active', 'https://shop.example/buy/' || $1::text, now())`, [key]);
  };

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `canonical_brand_match_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await createTables();
    await product({ key: 'p1', content: 'ck_fenty_1', brand: 'Fenty Beauty', refreshed: '2026-09-03' });
    await product({ key: 'p2', content: 'ck_fenty_2', brand: 'FENTY BEAUTY', refreshed: '2026-09-02' }); // case only
    await product({ key: 'p3', content: 'ck_fenty_3', brand: 'Fenty-Beauty' }); // compacted only
    await product({ key: 'p4', content: 'ck_fenty_4', brand: 'fenty' }); // the short alias
    await product({ key: 'p5', content: 'ck_fenty_1', brand: 'Fenty Beauty' }); // shares a content key with p1
    await product({ key: 'p6', content: null, brand: 'Fenty Beauty' }); // no content key
    await product({ key: 'p7', content: 'ck_nobrand', brand: null }); // no brand
    await product({ key: 'p8', content: 'ck_jart', brand: 'Dr. Jart+' });
    await product({ key: 'p9', content: 'ck_jart_2', brand: 'DR JART' }); // compacts to drjart
    await product({ key: 'p10', content: 'ck_aetas', brand: 'Aëtas' });
    await product({ key: 'p11', content: 'ck_atas', brand: 'ATAS' }); // "aëtas" compacts to "atas"
    await product({ key: 'p12', content: 'ck_round', brand: 'Round Lab' });
    await product({ key: 'p13', content: 'ck_other', brand: 'Laneige' });
    await product({ key: 'p14', content: 'ck_skin1004', brand: 'Skin 1004' }); // digits survive compaction
    await product({ key: 'p15', content: 'ck_skin', brand: 'SKIN' }); // must not match SKIN1004
    await db.query('ANALYZE');
    jest.resetModules();
    definitions = require('../../scripts/catalog/primary_brand_indexes')
      .primaryBrandIndexDefinitions()
      .filter((index) => index.accelerates === 'canonical_brand_equality');
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  beforeEach(() => {
    priorEnv = { ...process.env };
    process.env.DATABASE_URL = url;
    process.env.BRAND_PAGE_USES_COMMERCE_INDEX = 'true';
  });
  afterEach(() => {
    process.env = priorEnv;
  });

  // Runs the real fetcher with its own parameters, returning the statement it issued.
  const capture = async (brand) => {
    // Set here, not only in beforeEach: a beforeAll that captures runs before any beforeEach.
    process.env.DATABASE_URL = url;
    process.env.BRAND_PAGE_USES_COMMERCE_INDEX = 'true';
    jest.resetModules();
    const dbModule = require('../../src/db');
    const calls = [];
    dbModule.query = async (sql, params) => {
      if (/brand_match AS/.test(sql)) calls.push({ sql, params });
      if (/brand_match AS/.test(sql)) return db.query(sql, params);
      return { rows: [] };
    };
    const feed = require('../../src/services/discoveryFeed');
    const request = feed._internals.normalizeDiscoveryRequest({
      surface: 'browse_products',
      page: 1,
      limit: 12,
      scope: { brand_names: [brand] },
      context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] },
    });
    const aliases = feed._internals.buildBrandScopeAliases(request.scope.brand_names);
    const result = await feed._internals.computeBrandScopedDirectCandidates({ request, brandAliases: aliases, limit: 120 });
    expect(calls).toHaveLength(1);
    return { ...calls[0], result };
  };

  test.each(BRANDS)('%s: the new statement returns exactly the rows the OR-filtered one did', async (brand) => {
    const { sql, params } = await capture(brand);
    expect(sql).not.toMatch(/OR regexp_replace\(lower\(cp\.brand\)/);
    const newRows = (await db.query(sql, params)).rows;
    expect(newRows).toEqual((await db.query(OLD_SQL, params)).rows);
  });

  test('the fixture exercises each way a brand can match, and each way a row is excluded', async () => {
    const keys = async (brand, override) => {
      const { sql, params } = await capture(brand);
      return (await db.query(sql, override ? override(params) : params)).rows.map((row) => row.content_key).sort();
    };
    // The fetcher's own aliases for "Fenty Beauty" reach case-only, compacted-only and short-alias rows,
    // collapse the shared content key, and leave out the rows without a brand or content key.
    expect(await keys('Fenty Beauty')).toEqual(['ck_fenty_1', 'ck_fenty_2', 'ck_fenty_3', 'ck_fenty_4']);
    expect(await keys('Dr. Jart+')).toEqual(['ck_jart', 'ck_jart_2']);
    expect(await keys('Unknown Brand Nobody Sells')).toEqual([]);
    expect(await keys('SKIN1004')).toEqual(['ck_skin1004']);
    // Each branch alone, with hand-built parameters, so neither can silently carry the other.
    const lowerOnly = (params) => [params[0], ['no_such_compact'], params[2]];
    const compactOnly = (params) => [['no such lower'], params[1], params[2]];
    expect(await keys('Fenty Beauty', lowerOnly)).toEqual(['ck_fenty_1', 'ck_fenty_2', 'ck_fenty_4']);
    expect(await keys('Fenty Beauty', compactOnly)).toEqual(['ck_fenty_1', 'ck_fenty_2', 'ck_fenty_3', 'ck_fenty_4']);
    const aetas = (params) => [['aëtas'], ['atas'], params[2]];
    expect(await keys('Aëtas', aetas)).toEqual(['ck_aetas', 'ck_atas']);
    const { sql, params } = await capture('Aëtas');
    expect((await db.query(sql, aetas(params))).rows).toEqual((await db.query(OLD_SQL, aetas(params))).rows);
  });

  test('the page is picked before the laterals: same rows and order as the single statement at every LIMIT', async () => {
    // 'Glowtest' has more matches than the small limits below. The two newest fail the trust gate and one
    // has no signature, so the gate and the signature filter must run BEFORE the LIMIT, as they did.
    const at = (day) => `2026-08-${String(day).padStart(2, '0')}T00:00:00Z`;
    for (let n = 1; n <= 9; n += 1) {
      await product({ key: `glow_${n}`, content: `ck_glow_${n}`, brand: 'Glowtest', refreshed: at(n) });
    }
    // A second product on content key 1 gives the identity laterals a real choice to make.
    await product({ key: 'glow_1b', content: 'ck_glow_1', brand: 'Glowtest', refreshed: at(1) });
    await db.query(`UPDATE catalog_row_trust SET serving_decision = 'private' WHERE subject_key IN ('glow_9', 'glow_8')`);
    await db.query(`UPDATE agent_pdp_view SET pivota_signature_id = NULL WHERE content_key = 'ck_glow_7'`);
    try {
      const { sql, params } = await capture('Glowtest');
      expect(sql).toContain('picked AS MATERIALIZED');
      for (const limit of [1, 2, 3, 5, 120]) {
        const bound = [params[0], params[1], limit];
        const newRows = (await db.query(sql, bound)).rows;
        expect(newRows).toEqual((await db.query(OLD_SQL, bound)).rows);
        const keys = newRows.map((row) => row.content_key);
        expect(keys).not.toContain('ck_glow_9');
        expect(keys).not.toContain('ck_glow_8');
        expect(keys).not.toContain('ck_glow_7');
        expect(keys.length).toBe(Math.min(limit, 6));
      }
    } finally {
      await db.query(`DELETE FROM catalog_row_trust WHERE subject_key LIKE 'glow_%'`);
      await db.query(`DELETE FROM external_product_seeds WHERE attached_product_key LIKE 'glow_%'`);
      await db.query(`DELETE FROM agent_pdp_view WHERE content_key LIKE 'ck_glow_%'`);
      await db.query(`DELETE FROM catalog_products WHERE product_key LIKE 'glow_%'`);
    }
  });

  test('the fetcher still maps the rows to products', async () => {
    const { result } = await capture('Fenty Beauty');
    expect(result.products.length).toBe(4);
  });

  describe('plan choice on a 20k-row, 400-brand catalog', () => {
    let bigSchema;
    let planBeforeIndexes;

    beforeAll(async () => {
      bigSchema = `${schema}_big`;
      await db.query(`CREATE SCHEMA ${bigSchema}`);
      await db.query(`SET search_path TO ${bigSchema}`);
      await createTables();
      await db.query(`
        INSERT INTO catalog_products
        SELECT 'pk_' || g, 'ck_' || (g / 2), 'Brand ' || (g % 400) || CASE WHEN g % 7 = 0 THEN ' Co.' ELSE '' END,
          'merch_obs_x', 'external_seed', 'ext_' || g, 'live', NULL, now(), 'https://shop.example/' || g, 'sig_' || (g / 2)
        FROM generate_series(1, 20000) g;
        INSERT INTO agent_pdp_view
        SELECT DISTINCT ON (content_key) content_key, pivota_signature_id, brand, 'T', repeat('description ', 40), NULL, NULL,
          'USD', 10, 12, 1, NULL, 'beauty', now()
        FROM catalog_products;
        INSERT INTO catalog_row_trust SELECT 'product', product_key, 'public' FROM catalog_products;
        INSERT INTO external_product_seeds SELECT 'eps_' || product_key, product_key, 'active', 'https://shop.example/b', now() FROM catalog_products;
      `);
      await db.query('ANALYZE');
      // Before the indexes exist, the statement has no choice but to scan: this is what prod ran.
      const { sql, params } = await capture('Brand 42');
      planBeforeIndexes = (await db.query(`EXPLAIN ${sql}`, params)).rows.map((row) => row['QUERY PLAN']).join('\n');
      await createBrandIndexes();
      await db.query('ANALYZE');
    });

    afterAll(async () => {
      await db.query(`DROP SCHEMA ${bigSchema} CASCADE`);
      await db.query(`SET search_path TO ${schema}`);
    });

    test('the brand match probes both indexes and never scans catalog_products', async () => {
      const { sql, params } = await capture('Brand 42');
      const lines = (await db.query(`EXPLAIN ${sql}`, params)).rows.map((row) => row['QUERY PLAN']);
      const plan = lines.join('\n');
      expect(plan).not.toMatch(/Seq Scan on catalog_products/);
      for (const index of definitions) {
        const at = lines.findIndex((line) => line.includes(` using ${index.name} `) || line.includes(` on ${index.name} `));
        expect({ index: index.name, found: at > -1 }).toEqual({ index: index.name, found: true });
        expect(lines[at + 1]).toMatch(/Index Cond:/);
        expect(lines[at + 1]).toMatch(index.name.endsWith('_compact_v1') ? /regexp_replace\(lower\(/ : /lower\(\(?brand/);
      }
      // The fixture reproduces the problem: without the indexes the brand match scans catalog_products.
      expect(planBeforeIndexes).toMatch(/Seq Scan on catalog_products/);
      const rows = (await db.query(sql, params)).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toEqual((await db.query(OLD_SQL, params)).rows);
    });
  });
});
