const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// The relationship graph resolves every edge ref to a catalog row
// (catalogEntityResolution's resolveRelationshipGraphRefsToCanonicalEntities). It used to join
// catalog_products ON lower(a) = k OR lower(b) = k OR ... across five key columns, which no index can
// answer: in prod on 2026-09-16 it took 7.4s for the 41 refs of three anchors and made brand pages with a
// relationship-graph recall ~1.4s at p50 and ~5.3s at p95. It now issues one indexed equality branch per
// column (relationshipGraphRefKeySql.js). This runs the REAL resolver against real PostgreSQL and pins:
//   1. EQUIVALENCE. The old statement is frozen verbatim in
//      tests/fixtures/relationship_graph_ref_resolution_or_join_sql.txt (captured from origin/main before
//      the change). Old and new run side by side over refs that exercise each column, mixed case, a ref
//      matching one product through two columns, a ref matching two products (tie-break), a URL longer
//      than the indexed 512-char prefix whose sibling shares that prefix, the active-source gate, the
//      product-group branch and its precedence, and a ref that matches nothing. Every returned column
//      must be identical, and so must the resolver's output map.
//   2. PLAN CHOICE + INDEXABILITY: on a 20k-row fixture with wide payloads and the planner left alone,
//      the statement never scans catalog_products and probes every ref-key index with an Index Cond on
//      its bounded expression (so query and index still match character for character), while the
//      frozen old statement does scan.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const OLD_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'relationship_graph_ref_resolution_or_join_sql.txt'),
  'utf8',
);

const LONG_PREFIX = `https://long.example/${'a'.repeat(600)}`;
const LONG_GROUP_PREFIX = `pg_${'g'.repeat(600)}`;

const REFS = [
  'product:ext_aaa', // source_product_id
  'pk_bbb', // product_key, no prefix
  'product:sig_ccc', // pivota_signature_id
  'url:https://shop.example/products/mixed-case', // canonical_url stored mixed case
  'url:https://pivota.cc/p/sig_ddd', // pivota_canonical_url stored mixed case
  'https://pivota.cc/p/sig_ddd', // a bare URL loses "https:" as a ref prefix, in both statements: no match
  'product:ext_dup', // two products share this source id: tie-break
  'product:ext_two', // one product matches through two columns
  `url:${LONG_PREFIX}x`, // longer than the indexed prefix; a sibling shares the prefix
  'product:ext_susp', // only a suspended merchant's product: no match
  'product:pg_group1', // product-group branch
  'product:pg_both', // matches a product_key (rank 0) and a group id (rank 10)
  'product:ext_nomatch',
  'PRODUCT:EXT_MIXED_REF', // input ref in upper case
  'product:pg_mixed_group', // product group id stored in mixed case
  `product:${LONG_GROUP_PREFIX}x`, // group id longer than the indexed prefix; a sibling group shares the prefix
];

suite('relationship graph ref resolution on PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;
  let definitions;

  const createTables = async () => {
    await db.query(`
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text, platform text, source_product_id varchar,
        title text, description text, brand text, category text, product_type text, category_path text, canonical_url text,
        image_url text, product_payload jsonb, pdp_lifecycle_stage text, pivota_signature_id text, pivota_canonical_url text,
        pivota_signature_minted_at timestamptz, content_key text, updated_at timestamptz, source_domain text);
      CREATE UNIQUE INDEX ON catalog_products(pivota_signature_id) WHERE pivota_signature_id IS NOT NULL;
      CREATE UNIQUE INDEX ON catalog_products(merchant_id, platform, source_product_id);
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY, merchant_name text, status text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text, product_group_id text,
        is_primary boolean, PRIMARY KEY (merchant_id, platform, platform_product_id));
      CREATE INDEX ON product_group_members(product_group_id);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
    `);
  };

  const createRefKeyIndexes = async () => {
    for (const index of definitions) {
      // CONCURRENTLY is for prod; the definition is otherwise used verbatim.
      await db.query(index.sql.replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
    }
  };

  const product = (row) => db.query(
    `INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, brand, canonical_url,
       product_payload, pdp_lifecycle_stage, pivota_signature_id, pivota_canonical_url, pivota_signature_minted_at, updated_at)
     VALUES ($1, $2, 'external_seed', $3, $1, 'Brand', $4, $5::jsonb, $6, $7, $8, $9::timestamptz, $10::timestamptz)`,
    [
      row.key,
      row.merchant || 'external_seed',
      row.source,
      row.url || null,
      JSON.stringify(row.payload || { variant_title: `v-${row.key}` }),
      row.stage || 'published',
      row.sig || null,
      row.pivotaUrl || null,
      row.minted || '2026-01-01',
      row.updated || '2026-02-01',
    ],
  );

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `rg_ref_resolution_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await createTables();
    await db.query(`
      INSERT INTO catalog_merchants VALUES
        ('merch_obs_b', 'Seller B', 'observed'),
        ('merch_suspended', 'Seller S', 'suspended')
    `);
    await product({ key: 'P1', source: 'ext_aaa' });
    await product({ key: 'pk_bbb', source: 'src_p2' });
    await product({ key: 'P3', source: 'src_p3', sig: 'sig_ccc' });
    await product({ key: 'P4', source: 'src_p4', url: 'https://Shop.Example/Products/Mixed-Case' });
    await product({ key: 'P5', source: 'src_p5', pivotaUrl: 'https://pivota.cc/p/Sig_Ddd' });
    // Two products with the same source id: the published, earlier-minted one wins.
    await product({ key: 'P6', source: 'ext_dup', stage: 'draft', minted: '2026-01-01' });
    await product({ key: 'P7', source: 'ext_dup', merchant: 'merch_obs_b', stage: 'published', minted: '2026-03-01' });
    // One product whose source id AND product key both equal the ref.
    await product({ key: 'ext_two', source: 'ext_two' });
    // Long URLs sharing the first 512+ characters: only the exact one may match.
    await product({ key: 'P9', source: 'src_p9', url: `${LONG_PREFIX}x` });
    await product({ key: 'P10', source: 'src_p10', url: `${LONG_PREFIX}y` });
    await product({ key: 'P11', source: 'ext_susp', merchant: 'merch_suspended' });
    await product({ key: 'P12', source: 'src_p12' });
    await product({ key: 'pg_both', source: 'src_both' });
    await product({ key: 'P14', source: 'src_p14' });
    await product({ key: 'P15', source: 'EXT_MIXED_REF' });
    await product({ key: 'P16', source: 'src_p16' });
    await product({ key: 'P17', source: 'src_p17' });
    await product({ key: 'P18', source: 'src_p18' });
    await db.query(`
      INSERT INTO product_group_members VALUES
        ('external_seed', 'external_seed', 'src_p12', 'pg_group1', true),
        ('external_seed', 'external_seed', 'src_p14', 'pg_both', true),
        ('external_seed', 'external_seed', 'src_p16', 'PG_Mixed_Group', true),
        ('external_seed', 'external_seed', 'src_p17', $1, true),
        ('external_seed', 'external_seed', 'src_p18', $2, true)
    `, [`${LONG_GROUP_PREFIX}y`, `${LONG_GROUP_PREFIX}x`]);
    await db.query('ANALYZE');
    jest.resetModules();
    process.env.DATABASE_URL = url;
    definitions = require('../../scripts/catalog/primary_brand_indexes')
      .primaryBrandIndexDefinitions()
      .filter((index) => index.accelerates === 'ref_key_equality');
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
  });
  afterEach(() => {
    process.env = priorEnv;
  });

  const resolve = async (refs, { sqlOverride = null } = {}) => {
    const { resolveRelationshipGraphRefsToCanonicalEntities } = require('../../src/services/catalogEntityResolution');
    const calls = [];
    const queryFn = async (sql, params) => {
      calls.push({ sql, params });
      return db.query(sqlOverride || sql, params);
    };
    const map = await resolveRelationshipGraphRefsToCanonicalEntities(refs, { queryFn, bypassCache: true });
    expect(calls).toHaveLength(1);
    return { map, sql: calls[0].sql, params: calls[0].params };
  };

  test('the new statement returns exactly the rows the OR-joined statement did', async () => {
    const { sql, params } = await resolve(REFS);
    const oldRows = (await db.query(OLD_SQL, params)).rows;
    const newRows = (await db.query(sql, params)).rows;
    expect(newRows).toEqual(oldRows);
    // The fixture is only meaningful if each case actually resolved the way it was built to.
    const byRef = Object.fromEntries(newRows.map((row) => [row.normalized_ref, row.product_key]));
    expect(byRef).toEqual({
      'product:ext_aaa': 'P1',
      pk_bbb: 'pk_bbb',
      'product:sig_ccc': 'P3',
      'url:https://shop.example/products/mixed-case': 'P4',
      'url:https://pivota.cc/p/sig_ddd': 'P5',
      'product:ext_dup': 'P7',
      'product:ext_two': 'ext_two',
      [`url:${LONG_PREFIX}x`]: 'P9',
      'product:pg_group1': 'P12',
      'product:pg_both': 'pg_both',
      'product:ext_mixed_ref': 'P15',
      'product:pg_mixed_group': 'P16',
      [`product:${LONG_GROUP_PREFIX}x`]: 'P18',
    });
    expect(byRef['product:ext_susp']).toBeUndefined();
    expect(byRef['https://pivota.cc/p/sig_ddd']).toBeUndefined();
    expect(byRef['product:ext_nomatch']).toBeUndefined();
  });

  test('the resolver output map is identical under the old and new statements', async () => {
    const fresh = await resolve(REFS);
    const frozen = await resolve(REFS, { sqlOverride: OLD_SQL });
    expect([...fresh.map.entries()]).toEqual([...frozen.map.entries()]);
    expect(fresh.map.size).toBe(REFS.length);
  });

  test('each key column is its own branch; the OR join is gone', async () => {
    const { sql } = await resolve(REFS);
    expect(sql).not.toMatch(/OR\s+lower\(cp\.\w+\)\s*=\s*i\.ref_key/);
    expect((sql.match(/JOIN catalog_products cp_key ON left\(lower\(cp_key\.\w+\), 512\) = left\(i\.ref_key, 512\)/g) || []))
      .toHaveLength(5);
  });

  describe('with the ref-key indexes', () => {
    beforeAll(createRefKeyIndexes);

    test('the results do not change once the indexes exist', async () => {
      const { sql, params } = await resolve(REFS);
      expect((await db.query(sql, params)).rows).toEqual((await db.query(OLD_SQL, params)).rows);
    });
  });

  describe('plan choice on a 20k-row catalog', () => {
    let bigSchema;

    beforeAll(async () => {
      bigSchema = `${schema}_big`;
      await db.query(`CREATE SCHEMA ${bigSchema}`);
      await db.query(`SET search_path TO ${bigSchema}`);
      await createTables();
      await db.query(`
        INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, brand, canonical_url,
          product_payload, pdp_lifecycle_stage, pivota_signature_id, pivota_canonical_url, pivota_signature_minted_at, updated_at)
        SELECT 'pk_' || g, CASE WHEN g % 3 = 0 THEN 'merch_obs_b' ELSE 'external_seed' END, 'external_seed', 'ext_' || md5(g::text),
          'Title ' || g, 'Brand ' || (g % 40), 'https://shop' || (g % 50) || '.example/Products/' || g,
          jsonb_build_object('description', repeat(md5(g::text), 60)), 'published', 'sig_' || md5(g::text),
          'https://pivota.cc/p/sig_' || md5(g::text), now(), now()
        FROM generate_series(1, 20000) g
      `);
      await db.query(`
        INSERT INTO product_group_members(merchant_id, platform, platform_product_id, product_group_id, is_primary)
        SELECT CASE WHEN g % 3 = 0 THEN 'merch_obs_b' ELSE 'external_seed' END, 'external_seed', 'ext_' || md5(g::text),
          'pg_' || (g / 4), g % 4 = 0
        FROM generate_series(1, 20000) g
      `);
      await db.query(`INSERT INTO catalog_merchants VALUES ('merch_obs_b', 'Seller B', 'observed')`);
      await createRefKeyIndexes();
      await db.query('ANALYZE');
    });

    afterAll(async () => {
      await db.query(`DROP SCHEMA ${bigSchema} CASCADE`);
      await db.query(`SET search_path TO ${schema}`);
    });

    test('the planner answers 41 refs from the indexes, not by scanning catalog_products or product_group_members', async () => {
      const refs = [];
      for (let g = 1; g <= 41; g += 1) {
        const key = require('crypto').createHash('md5').update(String(g * 97)).digest('hex');
        // Every fifth ref names a product group, which only the group branch can resolve.
        refs.push(g % 5 === 0 ? `product:pg_${g * 13}` : g % 2 ? `product:ext_${key}` : `product:sig_${key}`);
      }
      const { sql, params } = await resolve(refs);
      const explain = async (statement) =>
        (await db.query(`EXPLAIN ${statement}`, params)).rows.map((row) => row['QUERY PLAN']).join('\n');

      const newPlan = await explain(sql);
      expect(newPlan).not.toMatch(/Seq Scan on catalog_products/);
      expect(newPlan).not.toMatch(/Seq Scan on product_group_members/);
      // Every branch is a probe of its own index: the index is named, and the next plan line is an Index
      // Cond on the bounded expression for that column. This is also the drift alarm between the query
      // expressions and the index definitions, which must match character for character.
      const planLines = newPlan.split('\n');
      for (const index of definitions) {
        const at = planLines.findIndex((line) => line.includes(` using ${index.name} `) || line.includes(` on ${index.name} `));
        expect({ index: index.name, found: at > -1 }).toEqual({ index: index.name, found: true });
        const column = index.name.replace(/^idx_.*?_ref_key_/, '').replace(/_v1$/, '');
        expect(planLines[at + 1]).toMatch(/Index Cond:/);
        expect(planLines[at + 1]).toMatch(new RegExp(`"?left"?\\(lower\\(\\(?${column}\\b`));
      }

      // The fixture reproduces the prod problem: the frozen statement cannot avoid the scan.
      expect(await explain(OLD_SQL)).toMatch(/Seq Scan on catalog_products/);

      const rows = (await db.query(sql, params)).rows;
      expect(rows).toEqual((await db.query(OLD_SQL, params)).rows);
      expect(rows).toHaveLength(41);
      // The group refs really resolved through the group branch (their product_key is a member, not the ref).
      const groupRows = rows.filter((row) => row.normalized_ref.startsWith('product:pg_'));
      expect(groupRows).toHaveLength(8);
      for (const row of groupRows) expect(row.product_group_id).toBe(row.ref_key);
    });
  });
});
