const { Client } = require('pg');
const { freshnessAuditSql, refreshPlanSql, queryParams, auditQueryParams } = require('../../src/services/relationshipGraphFreshness');
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('recommendation freshness planner on PostgreSQL', () => {
  let db; let schema;
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `rg_freshness_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    await db.query(`
      CREATE TABLE catalog_products(product_key text PRIMARY KEY, merchant_id text DEFAULT 'external_seed',
        platform text DEFAULT 'external_seed', source_product_id text, source_domain text, content_key text,
        pivota_signature_id text, title text DEFAULT 'Beauty serum', category text, category_path text,
        product_type text, category_label text, suppressed_at timestamptz, suppression_reason text,
        sync_status text DEFAULT 'live', pdp_will_render boolean DEFAULT true,
        pdp_will_render_computed_at timestamptz DEFAULT now() - interval '30 days',
        pdp_lifecycle_stage text, pivota_signature_minted_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE catalog_merchants(merchant_id text, status text);
      CREATE TABLE merchant_stores(merchant_id text, status text, domain text, platform text);
      CREATE TABLE product_group_members(merchant_id text, platform text, platform_product_id text,
        product_group_id text, is_primary boolean);
      CREATE TABLE external_product_seeds(id text PRIMARY KEY, external_product_id text, attached_product_key text,
        market text DEFAULT 'US', status text DEFAULT 'active', price_currency text DEFAULT 'USD',
        canonical_url text, destination_url text,
        last_crawled_at timestamptz DEFAULT now() - interval '30 days');
      CREATE TABLE catalog_offers(offer_id text, product_key text, market text DEFAULT 'US', currency text DEFAULT 'USD',
        suppressed_at timestamptz, merchant_effective_price numeric DEFAULT 20, list_price numeric,
        estimated_best_price numeric, price_checked_at timestamptz DEFAULT now() - interval '30 days',
        availability text DEFAULT 'in_stock', offer_payload jsonb, source_system text, source_ref text);
      CREATE TABLE relationship_candidate_labels(id text, anchor_type text DEFAULT 'product', anchor_ref text,
        candidate_product_ref text, label_state text, relation_type text DEFAULT 'similar', market text DEFAULT 'US',
        vertical text DEFAULT 'beauty', provenance jsonb, created_at timestamptz, updated_at timestamptz,
        reviewed_at timestamptz, last_verified_at timestamptz, expires_at timestamptz);
      CREATE TABLE relationship_graph_anchor_attempts(anchor_ref text, market text, vertical text, last_attempt_at timestamptz);
    `);
  });
  afterAll(async () => { if (db) { await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); } });
  beforeEach(async () => { await db.query(`TRUNCATE catalog_products, external_product_seeds, catalog_offers,
    catalog_merchants, merchant_stores, product_group_members, relationship_candidate_labels, relationship_graph_anchor_attempts`); });

  async function product(key, { market = 'US', currency = 'USD', sync = 'live', source = `src_${key}`,
    signature = `sig_${key}`, contentKey = `ck_${key}`, seedExternal = source, fresh = false } = {}) {
    await db.query(`INSERT INTO catalog_products(product_key, source_product_id, pivota_signature_id, content_key, sync_status,
      pdp_will_render_computed_at) VALUES($1,$2,$3,$4,$5,now() - ($6::int * interval '1 day'))`,
    [key, source, signature, contentKey, sync, fresh ? 0 : 30]);
    await db.query(`INSERT INTO external_product_seeds(id, external_product_id, attached_product_key, market, price_currency,
      last_crawled_at) VALUES($1,$2,$3,$4,$5,now() - ($6::int * interval '1 day'))`,
    [`seed_${key}`, seedExternal, key, market, currency, fresh ? 0 : 30]);
    await db.query(`INSERT INTO catalog_offers(offer_id,product_key,market,currency,offer_payload,price_checked_at)
      VALUES($1,$2,$3,$4,jsonb_build_object('external_seed_id',$5::text),now() - ($6::int * interval '1 day'))`,
    [`offer_${key}`, key, market, currency, `seed_${key}`, fresh ? 0 : 30]);
  }
  const plan = async (opts = {}, suppressed = []) => (await db.query(refreshPlanSql(), queryParams(opts, suppressed))).rows.map(r => r.product_key);

  test('stale live anchors can be checked; retired/missing rows and other markets cannot enter a worklist', async () => {
    await product('live'); await product('retired', { sync: 'retired' }); await product('missing', { sync: 'missing' });
    await product('jp', { market: 'JP', currency: 'JPY' }); await product('fresh', { fresh: true });
    expect(await plan()).toEqual(['live']);
    const audit = (await db.query(freshnessAuditSql(), auditQueryParams({}))).rows[0];
    expect(Number(audit.active_products)).toBe(2); expect(Number(audit.page_unknown)).toBe(1);
    expect(Number(audit.fresh_renderable)).toBe(1); expect(Number(audit.offer_fresh_available)).toBe(1);
    expect(await plan({ market: 'JP' })).toEqual(['jp']);
  });

  test('canonical sibling signature and attached seed aliases enforce the independent attempt cooldown', async () => {
    await product('anchor', { contentKey: 'ck_shared' }); await product('sibling', { contentKey: 'ck_shared' });
    await product('minted', { source: 'ext:canonical', seedExternal: 'actual_seed_id' });
    await db.query(`INSERT INTO relationship_graph_anchor_attempts VALUES
      ('product:sig_sibling','US','beauty',now()), ('product:actual_seed_id','US','beauty',now())`);
    expect(await plan()).toEqual([]);
    await db.query(`UPDATE relationship_graph_anchor_attempts SET last_attempt_at = now() - interval '8 days'`);
    expect((await plan()).sort()).toEqual(['anchor', 'minted', 'sibling']);
  });

  test('fresh approved endpoints and explicit selections have bounded lanes; hidden labels confer no priority', async () => {
    await product('ordinary'); await product('approved'); await product('selected'); await product('hidden');
    // All rows cooling down would ordinarily be excluded, but an approved endpoint still needs current offers.
    await db.query(`INSERT INTO relationship_graph_anchor_attempts
      SELECT lower('product:' || pivota_signature_id), 'US','beauty',now() FROM catalog_products`);
    await db.query(`INSERT INTO relationship_candidate_labels(id,anchor_ref,candidate_product_ref,label_state,
      last_verified_at,expires_at) VALUES
      ('safe','product:external_anchor','product:sig_approved','human_approved',now(),now()+interval '1 day'),
      ('hidden','product:external_anchor','product:sig_hidden','human_approved',now(),now()+interval '1 day')`);
    expect(await plan({ limit: 1, selectedProductKeys: ['selected'] }, ['hidden'])).toEqual(['selected']);
    expect(await plan({ limit: 2, selectedProductKeys: ['selected'] }, ['hidden'])).toEqual(['selected', 'approved']);
  });

  test('stale currency checks stay unknown; currency and market are never relabelled by the planner', async () => {
    await product('usd', { fresh: true }); await product('sgd', { currency: 'SGD', fresh: true });
    await db.query(`UPDATE catalog_offers SET price_checked_at = now() - interval '3 days' WHERE product_key = 'usd'`);
    const audit = (await db.query(freshnessAuditSql(), auditQueryParams({}))).rows[0];
    expect(Number(audit.offer_unknown_stale)).toBe(1); expect(Number(audit.offer_currency_mismatch)).toBe(1);
    expect((await db.query(`SELECT DISTINCT currency FROM catalog_offers ORDER BY currency`)).rows).toEqual([{currency:'SGD'}, {currency:'USD'}]);
  });

  test('fresh invalid price and unknown stock are refresh work; current unavailable stock is a conclusive result', async () => {
    await product('zero', { fresh: true }); await product('unknown', { fresh: true }); await product('unavailable', { fresh: true });
    await db.query(`UPDATE catalog_offers SET merchant_effective_price = 0 WHERE product_key IN ('zero','unavailable')`);
    await db.query(`UPDATE catalog_offers SET availability = 'unknown' WHERE product_key = 'unknown'`);
    await db.query(`UPDATE catalog_offers SET availability = 'out_of_stock' WHERE product_key = 'unavailable'`);
    expect((await plan()).sort()).toEqual(['unknown', 'zero']);
  });

  test('unknown native or mismatched-currency offers do not crowd repairable origin work after page validation', async () => {
    await product('native', { fresh: true }); await product('sgd', { currency: 'SGD', fresh: true });
    await product('repairable', { fresh: true });
    await db.query(`DELETE FROM external_product_seeds WHERE attached_product_key = 'native'`);
    await db.query(`UPDATE catalog_offers SET merchant_effective_price = 0 WHERE product_key = 'repairable'`);
    expect(await plan({ limit: 1 })).toEqual(['repairable']);
  });

  test.each([
    ['native conflicting attachment', 'store_a', '123', 'other_key', false],
    ['external conflicting attachment', 'external_seed', 'ext_shared', 'other_key', false],
    ['unattached recycled native ID', 'store_a', '123', null, false],
    ['exact attached native ID', 'store_a', '123', 'chosen', true],
    ['legacy external namespace', 'external_seed', '123', null, true],
    ['unattached globally external ID', 'store_a', 'ext_shared', null, true],
  ])('%s uses exact seed ownership for cohort, freshness and repairability', async (_case, merchant, source, attachment, bound) => {
    await product('chosen', { fresh: true, source });
    await product('other_key', { fresh: true, source });
    await db.query(`UPDATE catalog_products SET merchant_id=$1,platform='shopify' WHERE product_key='chosen'`, [merchant]);
    await db.query(`UPDATE catalog_products SET merchant_id='store_b',platform='shopify' WHERE product_key='other_key'`);
    await db.query(`INSERT INTO catalog_merchants VALUES ('store_a','active'),('store_b','active')`);
    await db.query(`INSERT INTO merchant_stores VALUES ('store_a','active','a.example','shopify'),('store_b','active','b.example','shopify')`);
    await db.query(`DELETE FROM external_product_seeds WHERE id='seed_other_key'`);
    await db.query(`UPDATE external_product_seeds SET attached_product_key=$1 WHERE id='seed_chosen'`, [attachment]);
    await db.query(`DELETE FROM catalog_offers WHERE product_key='other_key'`);
    const audit = (await db.query(freshnessAuditSql(), auditQueryParams({}))).rows[0];
    expect(Number(audit.offer_fresh_available)).toBe(Number(bound));
    expect(Number(audit.offer_unknown_stale)).toBe(Number(!bound));
    await db.query(`UPDATE catalog_offers SET price_checked_at=now()-interval '3 days'`);
    const work = await plan({ selectedProductKeys:['chosen'] });
    expect(work.includes('chosen')).toBe(bound);
    if (bound) expect(work[0]).toBe('chosen');
    // Seed-only market selection must use the same identity, even when the offer is absent.
    await db.query(`DELETE FROM catalog_offers`);
    // Remove the other listing to inspect admission of the requested product only.
    await db.query(`DELETE FROM catalog_products WHERE product_key='other_key'`);
    const chosenOnly = (await db.query(freshnessAuditSql(), auditQueryParams({}))).rows[0];
    expect(Number(chosenOnly.active_products)).toBe(Number(bound));
  });
});
