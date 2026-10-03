jest.mock('../../src/db', () => ({ query: jest.fn() }));
const { Client } = require('pg');
const db = require('../../src/db');
const axios = require('axios');
const { buildDiscoveryProfile, _internals: i } = require('../../src/services/discoveryFeed');
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('canonical personalized history on explicitly selected owned loopback PostgreSQL', () => {
  let client, originalEnv;
  const schema = `discovery_history_${process.pid}`;
  const sig = 'sig_3d1b5a5627cbb101f388e5a90c80b4e5';
  const payload = { surface: 'home_hot_deals', limit: 6, context: { auth_state: 'authenticated', locale: 'en-US', recent_queries: ['Jurlique'], recent_views: [{ merchant_id: 'external_seed', product_id: sig, title: 'Iconic Starter Ritual', brand: 'Jurlique', description: 'A complete ritual that transforms your skincare experience.' }] } };
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw Error('Owned loopback DB required');
    if (!((parsed.pathname === '/gateway_test' && (parsed.port || '5432') === '5432') ||
          (parsed.pathname === '/gateway_money_main_57625_test' && parsed.port === '55447'))) throw Error('Explicit CI or owned database required');
    originalEnv = { ...process.env }; process.env.DATABASE_URL = url;
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true'; process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';
    client = new Client({ connectionString: url }); await client.connect();
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public;
      CREATE TABLE agent_pdp_view(content_key text PRIMARY KEY,pivota_signature_id text,brand text,title text,description text,image_url text,image_urls jsonb,currency text,price_min numeric,price_max numeric,offer_count int,offers jsonb,category_path text,refreshed_at timestamptz);
      CREATE TABLE catalog_products(product_key text PRIMARY KEY,content_key text,pivota_signature_id text,merchant_id text,platform text,source_product_id text,brand text,canonical_url text,sync_status text,suppression_reason text,updated_at timestamptz);
      CREATE TABLE catalog_row_trust(subject_type text,subject_key text,serving_decision text);
      CREATE TABLE catalog_offers(offer_id text,product_key text,merchant_id text,market text,currency text,availability text,merchant_effective_price numeric,list_price numeric,suppressed_at timestamptz,suppression_reason text);
      CREATE TABLE external_product_seeds(id text,attached_product_key text,destination_url text,status text,updated_at timestamptz);`);
    db.query.mockImplementation((sql, params) => client.query(sql, params));
    jest.spyOn(axios, 'get').mockImplementation(() => { throw Error('Any HTTP provider call is forbidden'); });
  });
  afterAll(async () => { try { await client?.query('ROLLBACK'); } finally { await client?.end(); process.env = originalEnv; jest.restoreAllMocks(); } });
  beforeEach(async () => {
    await client.query('TRUNCATE agent_pdp_view,catalog_products,catalog_row_trust,external_product_seeds,catalog_offers'); db.query.mockClear();
    for (let n = 0; n < 9; n++) {
      const id = n ? 'sig_' + String(n).padStart(32, '0') : sig, key = `local_${n}`;
      await client.query(`INSERT INTO agent_pdp_view VALUES($1,$2,'Jurlique',$3,'Skincare ritual','https://synthetic.invalid/image.png','[]','USD',45,45,1,$4,'beauty/sets/gift-set',NOW())`, [key,id,n ? `Jurlique Ritual ${n}` : 'Iconic Starter Ritual',JSON.stringify([{market:'US',currency:'USD',price:45,availability:'in_stock'}])]);
      await client.query(`INSERT INTO catalog_products VALUES($1,$1,$2,'merch_obs_local','external_seed',$3,'Jurlique','https://jurlique.com/products/local-synthetic','live',NULL,NOW())`,[key,id,'ext_local_'+n]);
      await client.query("INSERT INTO catalog_row_trust VALUES('product',$1,'public')",[key]);
      await client.query("INSERT INTO catalog_offers VALUES($1,$2,'merch_obs_local','US','USD','in_stock',45,NULL,NULL,NULL)",['offer_'+n,key]);
      await client.query(`INSERT INTO external_product_seeds VALUES($1,$2,'https://jurlique.com/products/local-synthetic','active',NOW())`,['synthetic_seed_'+n,key]);
    }
  });
  async function load(request = i.normalizeDiscoveryRequest(payload)) { return i.loadCanonicalHistoryPrimary({ request, profile: buildDiscoveryProfile(request.context), limit: 48 }); }
  test('actual stored TEXT taxonomy and exact subject lookup yield direct canonical primary, no REST bounce', async () => {
    const result = await load(); expect(result.products).toHaveLength(9);
    expect(result.products.every(p => p.currency === 'USD' && p.price === 45)).toBe(true);
    expect(result.products[0].category_path).toEqual(['beauty','sets','gift-set']);
    expect(result.recallSummary[0].status).toBe(200); expect(db.query).toHaveBeenCalledTimes(2); expect(axios.get).not.toHaveBeenCalled();
  });
  test.each([['suppressed',"UPDATE catalog_products SET suppression_reason='hidden' WHERE product_key='local_0'"],['not live',"UPDATE catalog_products SET sync_status='expired' WHERE product_key='local_0'"],['private',"UPDATE catalog_row_trust SET serving_decision='private' WHERE subject_key='local_0'"]])('%s anchor is refused by the exact primary SQL, no alternate provider',async (_,sql) => {
    await client.query(sql);const result=await load();expect(result.products).toEqual([]);expect(result.recallSummary[0].failure_reason).toBe('canonical_history_subject_not_public');expect(db.query).toHaveBeenCalledTimes(1);expect(axios.get).not.toHaveBeenCalled();
  });
  test('untrusted/nonlive candidates are removed before the primary result',async () => {
    await client.query("UPDATE catalog_row_trust SET serving_decision='private' WHERE subject_key='local_1'; UPDATE catalog_products SET suppression_reason='hidden' WHERE product_key='local_2'; UPDATE catalog_products SET sync_status='expired' WHERE product_key='local_3'");
    expect((await load()).products).toHaveLength(6);expect(axios.get).not.toHaveBeenCalled();
  });
  test('private newer first-party row cannot borrow public content-group admission',async()=>{
    await client.query("INSERT INTO catalog_products VALUES('private-row','local_0',$1,'private-merchant','shopify','private-source','Jurlique',NULL,'live',NULL,NOW()+INTERVAL '1 day')",[sig]);
    await client.query("INSERT INTO catalog_row_trust VALUES('product','private-row','private')");
    const result=await load();expect(result.products).toHaveLength(9);expect(result.products.every(p=>p.merchant_id==='external_seed')).toBe(true);expect(result.products.every(p=>p.product_key!=='private-row')).toBe(true);
  });
  test.each(["UPDATE catalog_offers SET suppressed_at=NOW() WHERE product_key='local_0'","UPDATE catalog_offers SET merchant_id='foreign' WHERE product_key='local_0'","UPDATE catalog_offers SET currency='GBP' WHERE product_key='local_0'","UPDATE catalog_offers SET market='GB' WHERE product_key='local_0'"])('own rejected source offer refuses anchor before any alternate: %s',async sql=>{
    await client.query(sql);const result=await load();expect(result.products).toEqual([]);expect(result.recallSummary[0].failure_reason).toBe('canonical_history_subject_not_public');expect(axios.get).not.toHaveBeenCalled();
  });
  test('requested merchant cannot impersonate a canonical observed subject',async () => {
    const req=i.normalizeDiscoveryRequest(payload);req.context.recent_views[0].merchant_id='foreign';const result=await load(req);expect(result.recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');expect(axios.get).not.toHaveBeenCalled();
  });
  test('only own US/USD in-stock offer determines served price',async () => {
    await client.query(`UPDATE agent_pdp_view SET price_min=1,offers=$1 WHERE content_key='local_1'`,[JSON.stringify([{market:'GB',currency:'GBP',price:1,availability:'in_stock'},{market:'US',currency:'USD',price:45,availability:'in_stock'}])]);
    await client.query("INSERT INTO catalog_offers VALUES('foreign-cheap','local_1','foreign','US','USD','in_stock',1,NULL,NULL,NULL)");
    expect((await load()).products.find(p=>p.product_id==='sig_'+String(1).padStart(32,'0')).price).toBe(45);expect(axios.get).not.toHaveBeenCalled();
  });
});
