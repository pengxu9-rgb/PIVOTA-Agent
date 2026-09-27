const { Client } = require('pg');

// pdp_route_id_exists runs one statement across every store a PDP route id can live in. This runs the REAL
// statement on PostgreSQL with one row per lookup — each id stored in exactly ONE place — so a lookup that
// silently stops matching (a typo'd column, a wrong cast, a case rule) turns its id into `exists:false`,
// which in production would become a cached 404 on a live product. Every lookup must be proven here.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

// id → the ONE lookup that must match it.
const STORED = {
  sig_aaaa: 'catalog_signature',
  'ext:brand-name::abcd1234': 'catalog_product_key',
  'retailer:0011': 'catalog_source_product_id',
  ck_c0ffee: 'catalog_content_key',
  pg_catalog_b41f: 'product_group',
  'shopify-12345': 'product_group_member',
  seed_row_id_1: 'seed_id',
  ext_0123456789abcdef01234567: 'seed_external_product_id',
  'ext:attached::99': 'seed_attached_product_key',
  'rejuran:aa11': 'seed_data_external_product_id',
  'seed-data-pid-7': 'seed_data_product_id',
  'snap-pid-8': 'seed_snapshot_product_id',
  sig_0123456789abcdef01234567: 'identity_group',
  'listing-pid-9': 'identity_listing',
  sig_elected_sig: 'content_election_sig',
  ck_elected_key: 'content_election_key',
  'pc-platform-1': 'products_cache_platform_product_id',
  'pc-data-id-2': 'products_cache_data_id',
  'pc-data-pid-3': 'products_cache_data_product_id',
};

suite('pdp_route_id_exists on PostgreSQL', () => {
  let db;
  let schema;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `pdp_route_exists_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products(product_key varchar PRIMARY KEY, merchant_id text, platform text,
        source_product_id varchar, pivota_signature_id text, content_key text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text, product_group_id text,
        PRIMARY KEY (merchant_id, platform, platform_product_id));
      CREATE TABLE external_product_seeds(id text PRIMARY KEY, external_product_id text, attached_product_key text,
        status text, seed_data jsonb);
      CREATE TABLE pdp_identity_listing(source_listing_ref text PRIMARY KEY, merchant_id text, product_id text,
        sellable_item_group_id text);
      CREATE TABLE content_canonical_election(content_key text PRIMARY KEY, canonical_sig_id text);
      CREATE TABLE products_cache(id serial PRIMARY KEY, merchant_id text, platform text, platform_product_id text,
        product_data jsonb);
    `);
    // Each id lands in exactly one column; filler values never collide with any STORED id.
    await db.query(`
      INSERT INTO catalog_products VALUES
        ('pk_1', 'm', 'p', 'src_1', 'sig_aaaa', 'ck_x1'),
        ('ext:brand-name::abcd1234', 'm', 'p', 'src_2', NULL, NULL),
        ('pk_3', 'm', 'p', 'retailer:0011', NULL, NULL),
        ('pk_4', 'm', 'p', 'src_4', NULL, 'ck_c0ffee');
      INSERT INTO product_group_members VALUES
        ('m', 'p', 'member_1', 'pg_catalog_b41f'),
        ('m', 'p', 'shopify-12345', 'pg_other');
      INSERT INTO external_product_seeds VALUES
        ('seed_row_id_1', 'ext_x', NULL, 'active', '{}'),
        ('seed_2', 'ext_0123456789abcdef01234567', NULL, 'inactive', '{}'),
        ('seed_3', 'ext_y', 'ext:attached::99', 'active', '{}'),
        ('seed_4', 'ext_z', NULL, 'active', '{"external_product_id": "rejuran:aa11"}'),
        ('seed_5', 'ext_w', NULL, 'active', '{"product_id": "seed-data-pid-7"}'),
        ('seed_6', 'ext_v', NULL, 'active', '{"snapshot": {"product_id": "snap-pid-8"}}');
      INSERT INTO pdp_identity_listing VALUES
        ('l1', 'm', 'listing_other', 'sig_0123456789abcdef01234567'),
        ('l2', 'm', 'listing-pid-9', NULL);
      INSERT INTO content_canonical_election VALUES
        ('ck_other', 'sig_elected_sig'),
        ('ck_elected_key', NULL);
      INSERT INTO products_cache(merchant_id, platform, platform_product_id, product_data) VALUES
        ('m', 'shopify', 'pc-platform-1', '{}'),
        ('m', 'shopify', 'pc_other_1', '{"id": "pc-data-id-2"}'),
        ('m', 'shopify', 'pc_other_2', '{"product_id": "pc-data-pid-3"}');
    `);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  });

  const probe = (id) => {
    const { probePdpRouteIdExistence } = require('../../src/services/pdpRouteIdExistence');
    return probePdpRouteIdExistence(id, { queryFn: (sql, params) => db.query(sql, params) });
  };

  test('every lookup is exercised by the fixture', () => {
    const { __internal } = require('../../src/services/pdpRouteIdExistence');
    expect(Object.values(STORED).sort()).toEqual(__internal.ROUTE_ID_LOOKUPS.map(([name]) => name).sort());
  });

  test.each(Object.entries(STORED))('%s is found by exactly %s', async (id, lookup) => {
    const out = await probe(id);
    expect(out.exists).toBe(true);
    expect(out.matched).toEqual([lookup]);
  });

  test('ids no table holds are absent', async () => {
    for (const id of ['foo', 'sig_00000000000000000000000000000000', 'product:sig_aaaa', 'url:x', 'null']) {
      const out = await probe(id);
      expect(out).toMatchObject({ exists: false, matched: [] });
    }
  });

  test('case: ref-key columns match any case; exact columns match as stored', async () => {
    expect((await probe('SIG_AAAA')).matched).toEqual(['catalog_signature']);
    expect((await probe('PG_CATALOG_B41F')).matched).toEqual(['product_group']);
    // Stored lower-case, requested upper-case: the lower-cased spelling still reaches the exact lookup.
    expect((await probe('CK_C0FFEE')).matched).toEqual(['catalog_content_key']);
  });

  test('an inactive seed is still found by its own id columns (only the seed_data paths are active-only)', async () => {
    expect((await probe('ext_0123456789abcdef01234567')).exists).toBe(true);
  });

  test('a missing table is an error, never an absence', async () => {
    await db.query('ALTER TABLE products_cache RENAME TO products_cache_hidden');
    try {
      await expect(probe('foo')).rejects.toThrow(/products_cache/);
    } finally {
      await db.query('ALTER TABLE products_cache_hidden RENAME TO products_cache');
    }
  });
});
