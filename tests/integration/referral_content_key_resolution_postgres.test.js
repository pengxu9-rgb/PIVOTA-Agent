const { Client } = require('pg');
const {
  resolveReferralContentKey,
  REFERRAL_CONTENT_KEY_SQL,
} = require('../../src/services/referralContentKeyResolution');

// Execute the production SQL on PostgreSQL: a mocked row alone would not catch
// the original bug, where the stored content_key was never part of the lookup.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const CONTENT_KEY = 'ck_4dc24acc8d9242a292e8692bd11f5c09';
const OTHER_KEY = 'ck_00000000000000000000000000000001';

suite('unminted referral content-key resolution on PostgreSQL', () => {
  let db;
  let schema;
  let sequence;

  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    schema = `referral_content_key_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products (
        product_key text PRIMARY KEY, merchant_id text, source_product_id text,
        content_key text, platform text, source_system text,
        pivota_signature_id text, pdp_lifecycle_stage text,
        updated_at timestamptz, source_domain text
      );
      CREATE INDEX referral_catalog_content_key_idx ON catalog_products(content_key);
      CREATE TABLE catalog_merchants (merchant_id text PRIMARY KEY, status text);
      CREATE TABLE merchant_stores (
        id serial PRIMARY KEY, merchant_id text, platform text, status text, domain text
      );
      CREATE INDEX referral_store_merchant_idx ON merchant_stores(merchant_id);
    `);
  });

  beforeEach(async () => {
    sequence = 0;
    await db.query('TRUNCATE catalog_products, catalog_merchants, merchant_stores');
  });

  afterAll(async () => {
    if (db) {
      if (schema) await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  });

  async function addProduct(overrides = {}) {
    const n = ++sequence;
    const row = {
      product_key: `prod::observed::external_seed::product_${n}`,
      merchant_id: 'merch_obs_referral_test',
      source_product_id: `ext_referral_${n}`,
      content_key: CONTENT_KEY,
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
      pivota_signature_id: null,
      pdp_lifecycle_stage: 'candidate',
      updated_at: '2026-10-27T14:00:00Z',
      source_domain: 'real-referral.example',
      ...overrides,
    };
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO catalog_products (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
    await db.query(
      'INSERT INTO catalog_merchants(merchant_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [row.merchant_id, 'observed'],
    );
    return row;
  }

  const resolve = (id = CONTENT_KEY) => resolveReferralContentKey(id, {
    queryFn: (sql, params) => db.query(sql, params),
  });

  test('the indexed content key resolves an observed seller without requiring or inventing a signature', async () => {
    const row = await addProduct({
      merchant_id: 'merch_obs_f90122172d141c2d',
      source_product_id: 'ext_11c49350f95d48555a9f2a6b',
      product_key: 'prod::external_seed::external_seed::ext_11c49350f95d48555a9f2a6b',
    });
    expect(await resolve()).toEqual({
      merchant_id: row.merchant_id,
      product_id: row.source_product_id,
      product_key: row.product_key,
      content_key: CONTENT_KEY,
      platform: 'external_seed',
      source_system: 'external_product_seeds_mirror_v1',
    });
    expect(await resolve(OTHER_KEY)).toBeNull();
    const stored = await db.query('SELECT pivota_signature_id FROM catalog_products WHERE product_key = $1', [row.product_key]);
    expect(stored.rows[0].pivota_signature_id).toBeNull();
  });

  test.each([
    ['signed mirror', { pivota_signature_id: 'sig_existing_identity' }],
    ['native platform', { platform: 'shopify' }],
    ['minted source', { source_system: 'catalog_enrichment_agent_v1' }],
    ['empty merchant', { merchant_id: ' ' }],
    ['empty source product', { source_product_id: ' ' }],
    ['known demo merchant', { merchant_id: 'merch_test_ownist_001' }],
    ['reconnected demo domain', { source_domain: 'pivota-review-demo-new.myshopify.com' }],
  ])('%s is outside this narrow alias lane', async (_name, overrides) => {
    await addProduct(overrides);
    expect(await resolve()).toBeNull();
  });

  test('a suspended observed seller cannot be used as a referral alias', async () => {
    const row = await addProduct();
    await db.query('UPDATE catalog_merchants SET status = $1 WHERE merchant_id = $2', ['suspended', row.merchant_id]);
    expect(await resolve()).toBeNull();
  });

  test('the shared active-store policy is retained for a seller with registered stores', async () => {
    const row = await addProduct();
    await db.query(
      'INSERT INTO merchant_stores(merchant_id, platform, status, domain) VALUES ($1, $2, $3, $4)',
      [row.merchant_id, 'external_seed', 'inactive', 'real-referral.example'],
    );
    expect(await resolve()).toBeNull();
    await db.query('UPDATE merchant_stores SET status = $1, platform = $2', ['active', 'shopify']);
    expect(await resolve()).toBeNull();
    await db.query('UPDATE merchant_stores SET platform = $1', ['external_seed']);
    expect((await resolve()).merchant_id).toBe(row.merchant_id);
  });

  test('an active source sibling survives beside an excluded or signed row with the same content key', async () => {
    await addProduct({ merchant_id: 'merch_test_ownist_001', pdp_lifecycle_stage: 'published' });
    await addProduct({ pivota_signature_id: 'sig_sibling', pdp_lifecycle_stage: 'published' });
    const live = await addProduct({ source_product_id: 'ext_real_sibling' });
    expect((await resolve()).product_id).toBe(live.source_product_id);
  });

  test('candidate ranking is stable: lifecycle, update time, then product key', async () => {
    await addProduct({ product_key: 'candidate', updated_at: '2026-10-27T15:00:00Z' });
    await addProduct({ product_key: 'published_old', pdp_lifecycle_stage: 'published', updated_at: '2026-10-26T14:00:00Z' });
    await addProduct({ product_key: 'published_z', pdp_lifecycle_stage: 'published' });
    const chosen = await addProduct({ product_key: 'published_a', pdp_lifecycle_stage: 'published' });
    expect((await resolve()).product_key).toBe(chosen.product_key);
  });

  test('the real statement can seek the content-key index rather than scanning catalog rows', async () => {
    await addProduct();
    await db.query(`
      INSERT INTO catalog_products(product_key, merchant_id, source_product_id, content_key,
        platform, source_system, pivota_signature_id, pdp_lifecycle_stage, updated_at, source_domain)
      SELECT 'filler_' || n, 'merch_obs_referral_test', 'ext_filler_' || n,
        'ck_' || md5('filler_' || n), 'external_seed', 'external_product_seeds_mirror_v1',
        NULL, 'candidate', NOW(), 'real-referral.example'
      FROM generate_series(1, 5000) AS n;
      ANALYZE catalog_products;
      ANALYZE catalog_merchants;
      ANALYZE merchant_stores;
    `);
    const plan = await db.query(`EXPLAIN (FORMAT JSON) ${REFERRAL_CONTENT_KEY_SQL}`, [CONTENT_KEY]);
    const serialized = JSON.stringify(plan.rows[0]['QUERY PLAN']);
    expect(serialized).toContain('referral_catalog_content_key_idx');
    expect(serialized).toContain('Index Cond');
    expect((await resolve()).content_key).toBe(CONTENT_KEY);
  });

  test('a database failure propagates and cannot be read as an absent content key', async () => {
    await db.query('ALTER TABLE catalog_products RENAME TO catalog_products_unavailable');
    try {
      await expect(resolve()).rejects.toThrow(/catalog_products/);
    } finally {
      await db.query('ALTER TABLE catalog_products_unavailable RENAME TO catalog_products');
    }
  });
});
