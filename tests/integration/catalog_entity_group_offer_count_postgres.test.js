const { Client } = require('pg');

// get_pdp_v2's signature resolve (resolveCanonicalCatalogEntityGroup) used a CTE that grouped EVERY
// catalog_skus x catalog_offers row on each call to count offers for a handful of group members:
// ~57,600 calls at 1.25-1.33s mean in pg_stat_statements, pinning the 2-vCPU pivota-pg under ~10x
// PDP traffic on 2026-09-15. The count is now a per-row LATERAL. This executes the REAL resolver
// statement on PostgreSQL and checks, per returned product, that offer_count equals exactly what the
// old global aggregate produced, over the edge shapes: several SKUs, a SKU with no offers, a product
// with no SKUs, and offers belonging to products OUTSIDE the group (which must not leak in).
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const SIG = 'sig_0123456789abcdef0123456789abcdef';

suite('canonical catalog entity group offer_count on PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `entity_group_offer_count_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text, platform text, source_product_id text,
        title text, description text, brand text, category text, product_type text, category_path text, canonical_url text,
        image_url text, product_payload jsonb, pdp_lifecycle_stage text, sync_status text, pivota_signature_id text, pivota_canonical_url text,
        pivota_signature_minted_at timestamptz, content_key text, updated_at timestamptz, source_domain text);
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY, merchant_name text, status text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text, product_group_id text, is_primary boolean);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY, product_key text);
      CREATE TABLE catalog_offers(offer_id text PRIMARY KEY, sku_key text);
      CREATE INDEX ON catalog_skus(product_key);
      CREATE INDEX ON catalog_offers(sku_key);
    `);
    const product = (key, merchant, stage, minted) => db.query(
      `INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, brand, category_path,
         canonical_url, product_payload, pdp_lifecycle_stage, pivota_signature_id, pivota_signature_minted_at, content_key, updated_at)
       VALUES ($1, $2, 'external_seed', $1, $1, 'Brand', 'beauty/makeup/lip/lipstick', 'https://x.example/' || $1, '{}'::jsonb,
         $3, $4, $5::timestamptz, $6, now())`,
      [key, merchant, stage, key === 'outsider' ? 'sig_ffffffffffffffffffffffffffffffff' : SIG, minted, key === 'outsider' ? 'ck_other' : 'ck_group'],
    );
    await db.query(`INSERT INTO catalog_merchants VALUES ('merch_obs_one', 'Seller One', 'observed')`);
    await product('p_many', 'external_seed', 'published', '2026-01-01');
    await product('p_sku_no_offer', 'merch_obs_one', 'validated', '2026-01-02');
    await product('p_no_sku', 'external_seed', 'candidate', '2026-01-03');
    await product('outsider', 'external_seed', 'published', '2026-01-04');
    await db.query(`
      INSERT INTO catalog_skus VALUES ('s1', 'p_many'), ('s2', 'p_many'), ('s3', 'p_sku_no_offer'), ('s_out', 'outsider');
      INSERT INTO catalog_offers VALUES ('o1', 's1'), ('o2', 's1'), ('o3', 's2'), ('o_out1', 's_out'), ('o_out2', 's_out');
    `);
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
    jest.resetModules();
  });
  afterEach(() => {
    process.env = priorEnv;
  });

  test('every member carries the same offer_count the old global aggregate produced', async () => {
    const { resolveCanonicalCatalogEntityGroup } = require('../../src/services/catalogEntityResolution');
    const { CANONICAL_ENTITY_GROUP_SQL_TAG } = require('../../src/services/catalogEntityResolutionSqlTag');
    const statements = [];
    const queryFn = async (sql, params) => {
      statements.push(sql);
      return db.query(sql, params);
    };
    const group = await resolveCanonicalCatalogEntityGroup({ productId: SIG, queryFn });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(CANONICAL_ENTITY_GROUP_SQL_TAG);
    // The removed shape: a CTE grouping the whole SKU x offer join. Its return is the regression.
    expect(statements[0]).not.toMatch(/GROUP BY\s+s\.product_key/);

    // Re-run the statement to read the per-row offer_count it projects.
    const params = [SIG];
    const rows = (await db.query(statements[0], params)).rows;
    const perRow = Object.fromEntries(rows.map((row) => [row.product_key, row.offer_count]));

    // Ground truth: the OLD CTE's semantics, computed independently over the same tables.
    const oldAggregate = Object.fromEntries((await db.query(`
      SELECT s.product_key, COUNT(DISTINCT o.offer_id)::int AS offer_count
      FROM catalog_skus s LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
      GROUP BY s.product_key`)).rows.map((row) => [row.product_key, row.offer_count]));
    const expected = Object.fromEntries(Object.keys(perRow).map((key) => [key, oldAggregate[key] ?? 0]));

    expect(Object.keys(perRow).sort()).toEqual(['p_many', 'p_no_sku', 'p_sku_no_offer']);
    expect(perRow).toEqual(expected);
    expect(perRow).toEqual({ p_many: 3, p_sku_no_offer: 0, p_no_sku: 0 });
    // The group-level total is the sum over members; the outsider's two offers must not leak in.
    expect(group).toBeTruthy();
    expect(group.offer_count).toBe(3);
  });
});
