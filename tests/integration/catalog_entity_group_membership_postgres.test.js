const { Client } = require('pg');

// get_pdp_v2's signature resolve gathers a canonical group's members. It used to do that with one
// outer `WHERE (content_key IN target OR product_group_id IN target OR product_key IN target)`, which
// PostgreSQL could only answer by scanning every catalog_products row. It now unions three indexed
// lookups. This executes the REAL resolver statement on PostgreSQL and pins exactly which rows are
// members for each argument shape, including the rows that must stay OUT.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const sig = (n) => `sig_${String(n).padStart(32, '0')}`;

suite('canonical catalog entity group membership on PostgreSQL', () => {
  let db;
  let schema;
  let priorEnv;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `entity_group_membership_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text, platform text, source_product_id text,
        title text, description text, brand text, category text, product_type text, category_path text, canonical_url text,
        image_url text, product_payload jsonb, pdp_lifecycle_stage text, pivota_signature_id text, pivota_canonical_url text,
        pivota_signature_minted_at timestamptz, content_key text, updated_at timestamptz, source_domain text);
      CREATE UNIQUE INDEX ON catalog_products(pivota_signature_id) WHERE pivota_signature_id IS NOT NULL;
      CREATE INDEX ON catalog_products(content_key) WHERE content_key IS NOT NULL;
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY, merchant_name text, status text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text, product_group_id text,
        is_primary boolean, PRIMARY KEY (merchant_id, platform, platform_product_id));
      CREATE INDEX ON product_group_members(product_group_id);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY, product_key text);
      CREATE TABLE catalog_offers(offer_id text PRIMARY KEY, sku_key text);
    `);
    await db.query(`INSERT INTO catalog_merchants VALUES ('merch_obs_b', 'Seller B', 'observed'), ('merch_obs_c', 'Seller C', 'observed')`);
    const product = (key, merchant, source, content, signature, stage, minted) => db.query(
      `INSERT INTO catalog_products(product_key, merchant_id, platform, source_product_id, title, brand, category_path,
         canonical_url, product_payload, pdp_lifecycle_stage, pivota_signature_id, pivota_signature_minted_at, content_key, updated_at)
       VALUES ($1, $2, 'external_seed', $3, $1, 'Brand', 'beauty/makeup/lip/lipstick', 'https://x.example/' || $1, '{}'::jsonb,
         $4, $5, $6::timestamptz, $7, now())`,
      [key, merchant, source, stage, signature, minted, content],
    );
    // A: the target. content ck_group, group G1 (primary).
    await product('A', 'external_seed', 'src_a', 'ck_group', sig(1), 'published', '2026-01-01');
    // B: same content_key as A, no group row -> member via content_key.
    await product('B', 'merch_obs_b', 'src_b', 'ck_group', sig(2), 'validated', '2026-01-02');
    // C: different content_key, but its group row carries G1 -> member via product group.
    await product('C', 'merch_obs_c', 'src_c', 'ck_other', sig(3), 'candidate', '2026-01-03');
    // D: unrelated content and group G2 -> NOT a member.
    await product('D', 'external_seed', 'src_d', 'ck_unrelated', sig(4), 'published', '2026-01-04');
    // E: same content_key as A but no signature -> excluded by `pivota_signature_id IS NOT NULL`.
    await product('E', 'external_seed', 'src_e', 'ck_group', null, 'published', '2026-01-05');
    // F: a G1 group row exists for its merchant+source, but under a DIFFERENT platform -> the group
    // row does not join to F, and F's own content is unrelated -> NOT a member.
    await product('F', 'external_seed', 'src_f', 'ck_f', sig(6), 'published', '2026-01-06');
    // G: no content_key and no group row -> only the "is the target" branch can find it.
    await product('G', 'external_seed', 'src_g', null, sig(7), 'published', '2026-01-07');
    await db.query(`
      INSERT INTO product_group_members VALUES
        ('external_seed', 'external_seed', 'src_a', 'G1', true),
        ('merch_obs_c', 'external_seed', 'src_c', 'G1', false),
        ('external_seed', 'external_seed', 'src_d', 'G2', true),
        ('external_seed', 'shopify', 'src_f', 'G1', false);
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

  const resolveMembers = async (args) => {
    const { resolveCanonicalCatalogEntityGroup } = require('../../src/services/catalogEntityResolution');
    const calls = [];
    const queryFn = async (sql, params) => {
      calls.push({ sql, params });
      return db.query(sql, params);
    };
    const group = await resolveCanonicalCatalogEntityGroup({ ...args, queryFn });
    expect(calls).toHaveLength(1);
    const rows = (await db.query(calls[0].sql, calls[0].params)).rows;
    return { group, sql: calls[0].sql, keys: rows.map((row) => row.product_key).sort() };
  };

  test.each([
    ['signature', { productId: sig(1) }],
    ['product group id', { productGroupId: 'G1' }],
    ['merchant + source product id', { merchantId: 'external_seed', productId: 'src_a' }],
    ['plain product key', { productId: 'A' }],
  ])('%s resolves exactly the content, group and target members', async (_label, args) => {
    const { group, sql, keys } = await resolveMembers(args);
    expect(keys).toEqual(['A', 'B', 'C']);
    expect(group).toBeTruthy();
    // The removed shape: one OR across three IN-subqueries on the outer query forced a full scan.
    expect(sql).not.toMatch(/OR\s+pgm\.product_group_id\s+IN/);
    expect(sql).toMatch(/WHERE cp\.product_key IN \(SELECT product_key FROM candidate_keys\)/);
  });

  test('a target with its own content and group resolves to just itself', async () => {
    const { keys } = await resolveMembers({ productId: sig(4) });
    expect(keys).toEqual(['D']);
  });

  test('a target without a content_key or group row still resolves to itself', async () => {
    const { keys } = await resolveMembers({ productId: sig(7) });
    expect(keys).toEqual(['G']);
  });

  test('a signature that matches nothing resolves to no rows', async () => {
    const { keys } = await resolveMembers({ productId: sig(99) });
    expect(keys).toEqual([]);
  });
});
