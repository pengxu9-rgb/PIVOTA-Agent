const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { uncoveredLiveCatalogSql } = require('../../src/auroraBff/relationshipGraphCoverage');
const selector = require('../../scripts/select-relationship-graph-affected-products');

const BIN = '/opt/homebrew/opt/postgresql@15/bin';
const postgresDescribe = process.env.RELGRAPH_TEST_POSTGRES === '1' ? describe : describe.skip;
postgresDescribe('uncovered-anchor semantics on throwaway local Postgres', () => {
  let dir;
  let client;
  let started = false;
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = (name, args) => execFileSync(path.join(BIN, name), args, { env, stdio: 'pipe' });
  beforeAll(async () => {
    dir = fs.mkdtempSync('/tmp/relgraph-uncovered-');
    run('initdb', ['-D', dir, '-A', 'trust', '--no-locale']);
    run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', '-k /tmp -c listen_addresses=127.0.0.1 -p 55439', '-w', 'start']);
    started = true;
    client = new Client({ host: '127.0.0.1', port: 55439, user: process.env.USER, database: 'postgres' });
    await client.connect();
    await client.query(`
      CREATE TABLE catalog_merchants (merchant_id text PRIMARY KEY, status text);
      CREATE TABLE merchant_stores (merchant_id text, status text, domain text, platform text);
      CREATE TABLE catalog_products (
        product_key text PRIMARY KEY, source_product_id text, pivota_signature_id text, content_key text,
        merchant_id text, platform text, source_domain text, suppressed_at timestamptz, suppression_reason text,
        title text, description text, brand text, product_type text, category text, category_path text,
        category_label text, canonical_url text, pivota_canonical_url text, product_payload jsonb,
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
      CREATE INDEX ON catalog_products(content_key);
      CREATE TABLE product_group_members (merchant_id text, platform text, platform_product_id text,
        product_group_id text, PRIMARY KEY (merchant_id, platform, platform_product_id));
      CREATE INDEX ON product_group_members(product_group_id);
      CREATE TABLE external_product_seeds (id text PRIMARY KEY, external_product_id text, attached_product_key text,
        status text, market text, domain text, title text, canonical_url text, destination_url text,
        seed_data jsonb, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
      CREATE INDEX ON external_product_seeds(attached_product_key);
      INSERT INTO catalog_merchants VALUES ('real', 'active'), ('inactive', 'inactive'), ('merch_test_ownist_001', 'active');
    `);
    for (const number of ['046', '048', '050', '051']) {
      const file = fs.readdirSync(path.join(__dirname, '../../src/db/migrations')).find((name) => name.startsWith(`${number}_`));
      await client.query(fs.readFileSync(path.join(__dirname, '../../src/db/migrations', file), 'utf8'));
    }
  }, 30000);
  afterAll(async () => {
    try { if (client) await client.end(); } finally {
      if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    await client.query('TRUNCATE relationship_candidate_labels, catalog_products, external_product_seeds, product_group_members, merchant_stores');
    await product('anchor');
  });
  async function product(key, { merchant = 'real', content = key } = {}) {
    await client.query(`INSERT INTO catalog_products(product_key, source_product_id, pivota_signature_id,
      content_key, merchant_id, platform, title, category) VALUES ($1,$2,$3,$4,$5,'shopify','Beauty serum','skincare')`,
    [key, `source_${key}`, `sig_${key}`, content, merchant]);
  }
  async function label(ref, { market = 'US', state = 'ai_approved', recent = false, expires = true } = {}) {
    await client.query(`INSERT INTO relationship_candidate_labels(id,anchor_type,anchor_ref,candidate_product_ref,
      relation_type,market,label_state,last_verified_at,expires_at,created_at)
      VALUES ($1,'product',$2,'product:candidate','related_product',$3,$4,now(),
        now() + $5::interval,now() - $6::interval)`, [ref, ref, market, state, expires ? '45 days' : '-1 day', recent ? '1 day' : '30 days']);
  }
  async function priority(days = 7) {
    const result = await client.query(`SELECT CASE WHEN ${uncoveredLiveCatalogSql('cp', { marketSql: '$1', cooldownDays: days })}
      THEN true ELSE false END AS priority FROM catalog_products cp
      LEFT JOIN catalog_merchants cm ON cm.merchant_id=cp.merchant_id WHERE cp.product_key='anchor'`, ['US']);
    return result.rows[0].priority;
  }
  test('uncovered active row is promoted', async () => expect(await priority()).toBe(true));
  test.each(['product:sig_anchor', 'product:source_anchor'])('served ref %s counts as covered', async (ref) => {
    await label(ref); expect(await priority()).toBe(false);
  });
  test('unattached source-id seed is covered', async () => {
    await client.query("INSERT INTO external_product_seeds(id,external_product_id,status,market) VALUES ('seed','source_anchor','active','US')");
    await label('product:source_anchor'); expect(await priority()).toBe(false);
  });
  test('attached seed is covered', async () => {
    await client.query("INSERT INTO external_product_seeds(id,external_product_id,attached_product_key) VALUES ('seed','external','anchor')");
    await label('product:external'); expect(await priority()).toBe(false);
  });
  test.each(['suppressed', 'inactive', 'test', 'demo_domain', 'inactive_store'])('%s row is not live', async (kind) => {
    if (kind === 'suppressed') await client.query("UPDATE catalog_products SET suppressed_at=now()");
    if (kind === 'inactive') await client.query("UPDATE catalog_products SET merchant_id='inactive'");
    if (kind === 'test') await client.query("UPDATE catalog_products SET merchant_id='merch_test_ownist_001'");
    if (kind === 'demo_domain') await client.query("UPDATE catalog_products SET source_domain='pivota-review-demo-3.myshopify.com'");
    if (kind === 'inactive_store') await client.query("INSERT INTO merchant_stores VALUES ('real','inactive','real.example','shopify')");
    expect(await priority()).toBe(false);
  });
  test('recent pending label rotates out; configurable cooldown lets it return', async () => {
    await label('product:sig_anchor', { state: 'generated', recent: true });
    expect(await priority()).toBe(false);
    await client.query("UPDATE relationship_candidate_labels SET created_at=now()-interval '8 days'");
    expect(await priority(7)).toBe(true); expect(await priority(11)).toBe(false);
  });
  test('old rejected label returns to queue', async () => {
    await label('product:sig_anchor', { state: 'human_rejected' }); expect(await priority()).toBe(true);
  });
  test('market mismatch does not count as coverage or cooldown', async () => {
    await label('product:sig_anchor', { market: 'JP', recent: true }); expect(await priority()).toBe(true);
  });
  test('non-beauty label does not count as coverage or cooldown', async () => {
    await client.query("ALTER TABLE relationship_candidate_labels DROP CONSTRAINT relationship_candidate_labels_vertical_check");
    try {
      await label('product:sig_anchor', { recent: true });
      await client.query("UPDATE relationship_candidate_labels SET vertical='other'");
      expect(await priority()).toBe(true);
    } finally {
      await client.query("DELETE FROM relationship_candidate_labels; ALTER TABLE relationship_candidate_labels ADD CONSTRAINT relationship_candidate_labels_vertical_check CHECK(vertical='beauty')");
    }
  });
  test.each(['product:sig_sibling', 'product:source_sibling', 'product:pg_fixture'])('group ref %s counts as covered', async (ref) => {
    await product('sibling', { content: 'different' });
    await client.query("INSERT INTO product_group_members VALUES ('real','shopify','source_anchor','pg_fixture'),('real','shopify','source_sibling','pg_fixture')");
    await label(ref); expect(await priority()).toBe(false);
  });
  test('content-cluster sibling signature counts as covered', async () => {
    await product('sibling', { content: 'anchor' });
    await label('product:sig_sibling'); expect(await priority()).toBe(false);
  });
  test('selector executes priority once, promotes uncovered before covered and suppressed', async () => {
    await product('covered'); await product('suppressed');
    await label('product:sig_covered');
    await client.query("UPDATE catalog_products SET suppressed_at=now() WHERE product_key='suppressed'");
    const rows = await selector.fetchCatalogProductRows({ queryFn: (sql, params) => client.query(sql, params),
      updatedSince: '2026-01-01', market: 'US', prioritizeUncovered: true });
    expect(rows[0].product_key).toBe('anchor');
    expect(rows.map((row) => row.relgraph_uncovered_live)).toEqual([true, false, false]);
  });
});
