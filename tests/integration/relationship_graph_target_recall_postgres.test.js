const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { loadProductRelationshipGraphTargetRecall } = require('../../src/auroraBff/productRelationshipGraphTargetRecall');

const DATABASE_URL = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const BIN = process.env.RELGRAPH_TEST_POSTGRES_BIN || '/opt/homebrew/opt/postgresql@15/bin';
const postgresDescribe = (DATABASE_URL || process.env.RELGRAPH_TEST_POSTGRES === '1') ? describe : describe.skip;
postgresDescribe('full-catalog target recall on isolated Postgres', () => {
  let dir; let client; let started = false;
  const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
  const run = (name, args) => execFileSync(path.join(BIN, name), args, { env, stdio: 'pipe' });
  const anchor = { product_ref: 'product:sig_anchor', product_key: 'anchor', name: 'Gentle Hyaluronic Face Serum',
    category: 'Face Serum', brand: 'House', description: 'Gentle hydration hyaluronic acid serum' };
  const queryFn = jest.fn((sql, params) => client.query(sql, params));
  beforeAll(async () => {
    if (DATABASE_URL) {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(DATABASE_URL).hostname)) throw new Error('target recall Postgres tests require local database');
      client = new Client({ connectionString: DATABASE_URL });
    } else {
      const net = require('node:net');
      const port = await new Promise((resolve, reject) => {
        const server = net.createServer(); server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
      });
      dir = fs.mkdtempSync('/tmp/relgraph-target-recall-');
      run('initdb', ['-D', dir, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
      run('pg_ctl', ['-D', dir, '-l', path.join(dir, 'server.log'), '-o', `-k /tmp -c listen_addresses=127.0.0.1 -p ${port}`, '-w', 'start']);
      started = true;
      client = new Client({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres' });
    }
    await client.connect();
    await client.query('CREATE SCHEMA relgraph_target_recall_test; SET search_path TO relgraph_target_recall_test');
    await client.query(`CREATE TABLE catalog_merchants (merchant_id text PRIMARY KEY,status text);
      CREATE TABLE merchant_stores (merchant_id text,status text,domain text,platform text);
      CREATE TABLE catalog_row_trust (subject_type text,subject_key text,serving_decision text);
      CREATE TABLE external_product_seeds (id text PRIMARY KEY,external_product_id text,attached_product_key text,status text,market text);
      CREATE TABLE catalog_products (product_key text PRIMARY KEY,source_product_id text,pivota_signature_id text,
        content_key text,merchant_id text DEFAULT 'real',platform text DEFAULT 'shopify',source_domain text,sync_status text DEFAULT 'live',
        title text,description text,brand text,category text,category_label text,category_path text,product_type text,
        canonical_url text,pivota_canonical_url text,product_payload jsonb DEFAULT '{}',recall_doc text,
        recall_market text DEFAULT 'US',recall_availability text,suppressed_at timestamptz,suppression_reason text,
        pdp_will_render boolean DEFAULT true,pdp_will_render_computed_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now());
      INSERT INTO catalog_merchants VALUES ('real','active'),('inactive','inactive'),('merch_test_ownist_001','active');`);
  }, 30000);
  afterAll(async () => {
    try { if (client) { await client.query('DROP SCHEMA IF EXISTS relgraph_target_recall_test CASCADE'); await client.end(); } }
    finally { if (started) run('pg_ctl', ['-D', dir, '-m', 'immediate', '-w', 'stop']); if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
  });
  beforeEach(async () => {
    queryFn.mockClear();
    await client.query('TRUNCATE catalog_products,catalog_row_trust,merchant_stores,external_product_seeds');
  });
  async function product(key, overrides = {}) {
    await client.query(`INSERT INTO catalog_products(product_key,source_product_id,pivota_signature_id,content_key,
      title,description,category,brand,updated_at) VALUES ($1,$1,'sig_'||$1,$1,$2,$3,$4,$5,$6)`,
    [key, overrides.title || anchor.name, overrides.description || anchor.description,
      overrides.category || anchor.category, overrides.brand || 'Other', overrides.updated_at || '2021-01-01']);
    await client.query("INSERT INTO catalog_row_trust VALUES ('product',$1,$2)", [key, overrides.trust || 'public']);
  }
  const load = (options = {}) => loadProductRelationshipGraphTargetRecall({ queryFn, anchors: [anchor],
    existingProducts: [anchor, { brand: 'House' }], market: 'US', ...options });

  test('older unseen brands can compete with a large recent source pool and each other', async () => {
    await product('old_brand_a', { brand: 'Aster' }); await product('old_brand_b', { brand: 'Birch' });
    await product('known_brand', { brand: 'House', updated_at: new Date() });
    await client.query(`INSERT INTO catalog_products(product_key,source_product_id,pivota_signature_id,content_key,title,description,brand,category)
      SELECT 'recent_'||i,'recent_'||i,'sig_recent_'||i,'recent_'||i,$1,$2,'House',$3 FROM generate_series(1,2000) i`,
    [anchor.name, anchor.description, anchor.category]);
    await client.query("INSERT INTO catalog_row_trust SELECT 'product',product_key,'public' FROM catalog_products WHERE product_key LIKE 'recent_%'");
    const loaded = await load({ perAnchor: 2, maxCandidates: 2 });
    expect(new Set(loaded.products.map((item) => item.brand))).toEqual(new Set(['Aster', 'Birch']));
    expect(loaded.diagnostics).toMatchObject({ query_count: 1, rows_read: 2, candidate_count: 2 });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['suppressed', "suppressed_at=now()"], ['reason', "suppression_reason='manual'"],
    ['inactive', "merchant_id='inactive'"], ['demo', "source_domain='pivota-review-demo-3.myshopify.com'"],
    ['test', "merchant_id='merch_test_ownist_001'"], ['unrenderable', 'pdp_will_render=false'],
    ['stale_probe', "pdp_will_render_computed_at=now()-interval '8 days'"], ['unknown_probe', 'pdp_will_render_computed_at=NULL'],
    ['future_probe', "pdp_will_render_computed_at=now()+interval '1 day'"],
    ['unsigned', 'pivota_signature_id=NULL'], ['other_market', "recall_market='JP'"],
    ['compound_ref', "pivota_signature_id='merchant:listing'"],
    ['sold_out', "recall_availability='out_of_stock'"], ['payload_other_market', "recall_market=NULL,product_payload='{\"market\":\"JP\"}'"],
    ['blank_projection_stock', "recall_availability=' ',product_payload='{\"availability\":\"out_of_stock\"}'"],
    ['snapshot_stock', "product_payload='{\"snapshot\":{\"availability\":\"sold out\"}}'"],
    ['snapshot_stock_status', "recall_availability='',product_payload='{\"snapshot\":{\"availability_status\":\"unavailable\"}}'"],
    ['hyphenated_stock', "recall_availability=' out-of-stock '"],
    ['contradictory_stock', "recall_availability='in_stock',product_payload='{\"availability\":\"out_of_stock\"}'"],
    ['camel_case_stock', "product_payload='{\"availabilityStatus\":\"sold out\"}'"],
    ['snapshot_camel_case_stock', "product_payload='{\"snapshot\":{\"availabilityStatus\":\"unavailable\"}}'"],
    ['contradictory_market', "product_payload='{\"market\":\"JP\"}'"],
    ['contradictory_snapshot_market', "product_payload='{\"snapshot\":{\"market\":\"JP\"}}'"],
    ['contradictory_payload_markets', "recall_market=NULL,product_payload='{\"market\":\"US\",\"snapshot\":{\"market\":\"JP\"}}'"],
    ['unknown_market', 'recall_market=NULL'], ['retired', "sync_status='retired'"],
    ['missing', "sync_status='missing'"], ['unknown_status', 'sync_status=NULL'],
  ])('%s catalog rows cannot enter target retrieval', async (_kind, update) => {
    await product('unsafe'); await product('safe');
    await client.query(`UPDATE catalog_products SET ${update} WHERE product_key='unsafe'`);
    expect((await load()).products.map((item) => item.product_key)).toEqual(['safe']);
  });
  test.each(['blocked', 'review_required', 'missing'])('trust %s fails closed', async (trust) => {
    await product('unsafe', { trust }); await product('safe');
    if (trust === 'missing') await client.query("DELETE FROM catalog_row_trust WHERE subject_key='unsafe'");
    expect((await load()).products.map((item) => item.product_key)).toEqual(['safe']);
  });
  test('an active attached seed can establish explicit market; inactive or conflicting evidence cannot', async () => {
    await product('seed_market');
    await client.query("UPDATE catalog_products SET recall_market=NULL WHERE product_key='seed_market'");
    await client.query("INSERT INTO external_product_seeds VALUES ('seed','external','seed_market','active','US')");
    expect((await load()).products.map((item) => item.product_key)).toEqual(['seed_market']);
    await client.query("UPDATE external_product_seeds SET status='inactive'");
    expect((await load()).products).toHaveLength(0);
    await client.query("UPDATE external_product_seeds SET status='active'; UPDATE catalog_products SET recall_market='JP'");
    expect((await load()).products).toHaveLength(0);
  });
  test.each([
    ['conflicting_attachment', 'real', 'shopify', 'ext_shared', 'other_listing', 'active', false],
    ['external_lane_conflicting_attachment', 'observed_source', 'external_seed', '123', 'other_listing', 'active', false],
    ['unattached_native_shared_id', 'observed_source', 'shopify', '123', null, 'active', false],
    ['unknown_seed_status', 'observed_source', 'external_seed', 'legacy_external', null, null, false],
    ['external_lane_after_seller_rekey', 'observed_source', 'external_seed', '123', null, 'active', true],
    ['legacy_seller_does_not_make_native_lane_external', 'external_seed', 'shopify', '123', null, 'active', false],
    ['global_external_id', 'real', 'shopify', 'ext_shared', null, 'active', true],
    ['exact_native_attachment', 'real', 'shopify', '123', 'seed_bound', 'active', true],
  ])('seed market evidence respects exact listing ownership (%s)', async (_name, merchant, platform, sourceId, attachment, status, allowed) => {
    await product('seed_bound');
    await client.query("INSERT INTO catalog_merchants VALUES ('observed_source','observed') ON CONFLICT (merchant_id) DO UPDATE SET status='observed'");
    await client.query("UPDATE catalog_products SET recall_market=NULL,merchant_id=$1,platform=$2,source_product_id=$3 WHERE product_key='seed_bound'",
      [merchant, platform, sourceId]);
    await client.query("INSERT INTO external_product_seeds VALUES ('seed',$1,$2,$3,'US')", [sourceId, attachment, status]);
    const loaded = await load();
    expect(loaded.products.map((item) => item.product_key)).toEqual(allowed ? ['seed_bound'] : []);
  });
  test('inactive storefront and anchor aliases cannot reenter as candidates', async () => {
    await product('anchor', { brand: 'House' }); await product('other');
    await client.query("INSERT INTO merchant_stores VALUES ('real','inactive','real.example','shopify')");
    expect((await load()).products).toHaveLength(0);
    await client.query('TRUNCATE merchant_stores');
    expect((await load()).products.map((item) => item.product_key)).toEqual(['other']);
  });
  test('broad shelf matches still honor face/hair and topical/tool structural constraints', async () => {
    await product('hair', { title: 'Gentle Hyaluronic Hair Serum', category: 'Hair Serum' });
    await product('tool', { title: 'Face Serum Applicator Brush' });
    await product('safe');
    const loaded = await load();
    expect(loaded.products.map((item) => item.product_key)).toEqual(['safe']);
    expect(loaded.diagnostics.structural_rejected_count).toBe(2);
  });
  test('multiple anchors share one catalog query and bounded output', async () => {
    for (let i = 0; i < 8; i += 1) await product(`target_${i}`, { brand: `Brand ${i}` });
    const loaded = await load({ anchors: [anchor, { ...anchor, product_ref: 'product:sig_second' }], perAnchor: 7, maxCandidates: 6 });
    expect(loaded.diagnostics).toMatchObject({ query_count: 1, rows_read: 6, candidate_count: 6, per_anchor_budget: 3 });
    expect(Object.values(loaded.candidatesByAnchor).map((list) => list.length)).toEqual([3, 3]);
  });

  test('token-set recall preserves distinct evidence overlap without rewarding repeated words', async () => {
    await product('distinct_overlap', { title: 'Face Serum', description: 'Hyaluronic acid hydrating barrier serum', brand: 'Same Brand' });
    await product('repeated_word', { title: 'Face Serum', description: Array(200).fill('gentle').join(' '), brand: 'Same Brand' });
    const selected = { ...anchor, name: 'Face Serum', description: 'Gentle hyaluronic acid hydrating barrier serum' };
    const loaded = await load({ anchors: [selected], perAnchor: 1, maxCandidates: 1 });
    expect(loaded.products.map((item) => item.product_key)).toEqual(['distinct_overlap']);
  });

  test('a full 24k catalog with substantial repeated text stays inside the 30-second query deadline', async () => {
    const vocabulary = Array.from({ length: 300 }, (_, index) => `formulationword${index}`).join(' ');
    await client.query(`INSERT INTO catalog_products(product_key,source_product_id,pivota_signature_id,content_key,
        title,description,recall_doc,brand,category,recall_availability)
      SELECT 'fixture_'||i,'source_'||i,'sig_fixture_'||i,'ck_fixture_'||i,$1,$2,$2,
        'Brand '||(i%100),$3,'in_stock' FROM generate_series(1,24000) i`,
    [anchor.name, vocabulary, anchor.category]);
    await client.query("INSERT INTO catalog_row_trust SELECT 'product',product_key,'public' FROM catalog_products");
    await client.query('ANALYZE catalog_products; ANALYZE catalog_row_trust');
    const anchors = Array.from({ length: 20 }, (_, index) => ({ ...anchor,
      product_ref: `product:sig_stress_anchor_${index}`, product_key: `stress_anchor_${index}`,
      description: Array.from({ length: 24 }, (_, token) => `missingword${token}`).join(' ') }));
    // A database statement deadline is independent of Jest's timer and catches
    // unbounded anchor x text work even when the returned candidates are capped.
    await client.query('SET statement_timeout=30000');
    try {
      const startedAt = Date.now();
      const loaded = await load({ anchors, perAnchor: 25, maxPages: 1 });
      expect(Date.now() - startedAt).toBeLessThan(30000);
      expect(loaded.diagnostics).toMatchObject({ query_count: 1, candidate_count: 500, rows_read: 500 });
      expect(Object.values(loaded.candidatesByAnchor).map((list) => list.length)).toEqual(Array(20).fill(25));
    } finally {
      await client.query('SET statement_timeout=0');
    }
  }, 45000);
});
