jest.mock('../../src/db', () => ({ query: jest.fn() }));
const { Client } = require('pg');
const db = require('../../src/db');
const axios = require('axios');
const { getDiscoveryFeed, buildDiscoveryProfile, _internals: i } = require('../../src/services/discoveryFeed');
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
      CREATE TABLE catalog_products(product_key text PRIMARY KEY,content_key text,pivota_signature_id text,merchant_id text,platform text,source_product_id text,brand text,canonical_url text,sync_status text,suppression_reason text,updated_at timestamptz,category_path text);
      CREATE UNIQUE INDEX own_cp_signature_unique ON catalog_products(pivota_signature_id) WHERE pivota_signature_id IS NOT NULL;
      CREATE TABLE catalog_row_trust(subject_type text,subject_key text,serving_decision text);
      CREATE TABLE catalog_offers(offer_id text,product_key text,merchant_id text,market text,currency text,availability text,merchant_effective_price numeric,list_price numeric,suppressed_at timestamptz,suppression_reason text);
      CREATE TABLE external_product_seeds(id text,attached_product_key text,destination_url text,status text,updated_at timestamptz);
      ALTER TABLE catalog_products ADD COLUMN source_system text, ADD COLUMN source_domain text;
      ALTER TABLE catalog_offers ADD COLUMN sku_key text, ADD COLUMN source_system text, ADD COLUMN source_domain text, ADD COLUMN source_ref text, ADD COLUMN offer_type text, ADD COLUMN is_first_party boolean, ADD COLUMN offer_mode text, ADD COLUMN catalog_track text, ADD COLUMN truth_tier text, ADD COLUMN readiness_tier text, ADD COLUMN offer_payload jsonb;
      CREATE TABLE catalog_merchants(merchant_id text PRIMARY KEY,merchant_name text,source_system text,status text,indexable boolean,source_ref text,metadata_json jsonb);
      CREATE TABLE catalog_skus(sku_key text PRIMARY KEY,product_key text,merchant_id text,suppressed_at timestamptz,suppression_reason text,currency text);`);
    db.query.mockImplementation((sql, params) => client.query(sql, params));
    jest.spyOn(axios, 'get').mockImplementation(() => { throw Error('Any HTTP provider call is forbidden'); });
  });
  afterAll(async () => { try { await client?.query('ROLLBACK'); } finally { await client?.end(); process.env = originalEnv; jest.restoreAllMocks(); } });
  beforeEach(async () => {
    await client.query('TRUNCATE agent_pdp_view,catalog_products,catalog_row_trust,external_product_seeds,catalog_offers,catalog_merchants,catalog_skus'); db.query.mockClear();
    db.query.mockImplementation((sql,params) => client.query(sql,params));
    for (let n = 0; n < 9; n++) {
      const id = n ? 'sig_' + String(n).padStart(32, '0') : sig, key = `local_${n}`;
      await client.query(`INSERT INTO agent_pdp_view VALUES($1,$2,'Jurlique',$3,'Skincare ritual','https://synthetic.invalid/image.png','[]','USD',45,45,1,$4,'beauty/sets/gift-set','2026-10-03T00:00:00Z')`, [key,id,n ? `Jurlique Ritual ${n}` : 'Iconic Starter Ritual',JSON.stringify([{market:'US',currency:'USD',price:45,availability:'in_stock'}])]);
      await client.query(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at) VALUES($1,$1,$2,'merch_obs_local','external_seed',$3,'Jurlique','https://jurlique.com/products/local-synthetic','live',NULL,NOW())`,[key,id,'ext_local_'+n]);
      await client.query("INSERT INTO catalog_row_trust VALUES('product',$1,'public')",[key]);
      await client.query("INSERT INTO catalog_offers(offer_id,product_key,merchant_id,market,currency,availability,merchant_effective_price,list_price,suppressed_at,suppression_reason) VALUES($1,$2,'merch_obs_local','US','USD','in_stock',45,NULL,NULL,NULL)",['offer_'+n,key]);
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
  test('equal-refresh canonical rows have deterministic signature order at both SQL selection and projection',async()=>{
    const result=await load();expect(result.products.map(p=>p.product_id)).toEqual(result.products.map(p=>p.product_id).sort());
    const sql=db.query.mock.calls[1][0];expect(sql).toContain('ORDER BY apv.refreshed_at DESC NULLS LAST, apv.pivota_signature_id ASC');expect(sql).toContain('ORDER BY picked.refreshed_at DESC NULLS LAST, apv.pivota_signature_id ASC');
  });
  test('same exact stored subject on browse resolves own public offers directly',async()=>{
    const req=i.normalizeDiscoveryRequest({...payload,surface:'browse_products'});expect((await load(req)).products).toHaveLength(9);expect(axios.get).not.toHaveBeenCalled();
  });
  test.each([['suppressed',"UPDATE catalog_products SET suppression_reason='hidden' WHERE product_key='local_0'"],['not live',"UPDATE catalog_products SET sync_status='expired' WHERE product_key='local_0'"],['private',"UPDATE catalog_row_trust SET serving_decision='private' WHERE subject_key='local_0'"]])('%s anchor is refused by the exact primary SQL, no alternate provider',async (_,sql) => {
    await client.query(sql);const result=await load();expect(result.products).toEqual([]);expect(result.recallSummary[0].failure_reason).toBe('canonical_history_subject_not_public');expect(db.query).toHaveBeenCalledTimes(1);expect(axios.get).not.toHaveBeenCalled();
  });
  test('untrusted/nonlive candidates are removed before the primary result',async () => {
    await client.query("UPDATE catalog_row_trust SET serving_decision='private' WHERE subject_key='local_1'; UPDATE catalog_products SET suppression_reason='hidden' WHERE product_key='local_2'; UPDATE catalog_products SET sync_status='expired' WHERE product_key='local_3'");
    expect((await load()).products).toHaveLength(6);expect(axios.get).not.toHaveBeenCalled();
  });
  test('private newer first-party row cannot borrow public content-group admission',async()=>{
    await client.query("INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at) VALUES('private-row','local_0',$1,'private-merchant','shopify','private-source','Jurlique',NULL,'live',NULL,NOW()+INTERVAL '1 day')",['sig_ffffffffffffffffffffffffffffffff']);
    await client.query("INSERT INTO catalog_row_trust VALUES('product','private-row','private')");
    const result=await load();expect(result.products).toHaveLength(9);expect(result.products.every(p=>p.merchant_id==='external_seed')).toBe(true);expect(result.products.every(p=>p.product_key!=='private-row')).toBe(true);
  });
  test.each(["UPDATE catalog_offers SET suppressed_at=NOW() WHERE product_key='local_0'","UPDATE catalog_offers SET merchant_id='foreign' WHERE product_key='local_0'","UPDATE catalog_offers SET currency='GBP' WHERE product_key='local_0'","UPDATE catalog_offers SET market='GB' WHERE product_key='local_0'"])('own rejected source offer refuses anchor before any alternate: %s',async sql=>{
    await client.query(sql);const result=await load();expect(result.products).toEqual([]);expect(result.recallSummary[0].status).toBe(200);expect(result.recallSummary[0].eligibility_reason).toBe('canonical_history_item_unavailable');expect(result.recallSummary[0]).not.toHaveProperty('failure_reason');expect(axios.get).not.toHaveBeenCalled();
  });
  test('requested merchant cannot impersonate a canonical observed subject',async () => {
    const req=i.normalizeDiscoveryRequest(payload);req.context.recent_views[0].merchant_id='foreign';const result=await load(req);expect(result.recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');expect(axios.get).not.toHaveBeenCalled();
  });
  // Captured 2026-10-04: the storefront records the public PDP's listing
  // merchant (merch_obs_…), while the canonical card carries the external-seed
  // convention and the official offer keeps an agent_seed:: seller.
  test('storefront view carrying the public listing merchant resolves through the real anchor SQL',async () => {
    await officialListing();
    const req=i.normalizeDiscoveryRequest(payload);req.context.recent_views[0].merchant_id='merch_obs_local';
    const result=await load(req);
    expect(result.recallSummary[0].status).toBe(200);expect(result.recallSummary[0]).not.toHaveProperty('failure_reason');
    expect(result.products).toHaveLength(9);
    const [anchor]=await i.fetchCanonicalSigBrowseCandidates({limit:1,signatureIds:[sig]});
    expect(anchor.merchant_id).toBe('external_seed');
    expect(anchor.history_subject_merchant_ids).toEqual(expect.arrayContaining(['external_seed','merch_obs_local','agent_seed::jurlique']));
    expect(axios.get).not.toHaveBeenCalled();
  });
  test.each([['private',"'private'",'live',null],['expired',"'public'",'expired',null],['suppressed',"'public'",'live','hidden']])('a %s listing merchant of the same product cannot vouch for a stored view',async (_,decision,status,suppression)=>{
    await client.query(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at) VALUES('other-listing','local_0',NULL,'merch_obs_other','external_seed','other','Jurlique','https://jurlique.com/products/other',$1,$2,NOW())`,[status,suppression]);
    await client.query(`INSERT INTO catalog_row_trust VALUES('product','other-listing',${decision})`);
    const req=i.normalizeDiscoveryRequest(payload);req.context.recent_views[0].merchant_id='merch_obs_other';
    expect((await load(req)).recallSummary[0].failure_reason).toBe('canonical_history_subject_conflict');
    await client.query("UPDATE catalog_row_trust SET serving_decision='public' WHERE subject_key='other-listing'; UPDATE catalog_products SET sync_status='live',suppression_reason=NULL WHERE product_key='other-listing'");
    expect((await load(req)).recallSummary[0]).not.toHaveProperty('failure_reason');
    expect(axios.get).not.toHaveBeenCalled();
  });
  // Captured 2026-10-04: agent_pdp_view.category_path is NULL for every Krave
  // row while the listing (catalog_products.category_path, what the PDP serves)
  // is beauty/skincare/treat/serum; Jurlique's view leaves are 'gift-set',
  // 'Face Mist', 'Haircare' while every listing path is beauty/....
  test('history domain reads the listing taxonomy through the real anchor and pool SQL',async () => {
    await client.query("UPDATE agent_pdp_view SET category_path=NULL; UPDATE catalog_products SET category_path='beauty/skincare/treat/serum'");
    const req=i.normalizeDiscoveryRequest(payload);const profile=buildDiscoveryProfile(req.context);profile.dominantDomain='beauty';
    const result=await i.loadCanonicalHistoryPrimary({request:req,profile,limit:48});
    expect(result.recallSummary[0]).not.toHaveProperty('failure_reason');
    expect(result.products).toHaveLength(9);
    expect(result.products.every(p=>!('stored_listing_category_path' in p))).toBe(true);
    await client.query("UPDATE catalog_products SET category_path=NULL WHERE product_key='local_0'");
    expect((await i.loadCanonicalHistoryPrimary({request:req,profile,limit:48})).recallSummary[0].failure_reason).toBe('canonical_history_domain_conflict');
    await client.query("UPDATE catalog_products SET category_path='beauty/sets/gift-set' WHERE product_key='local_0'; UPDATE catalog_products SET category_path='fashion/dresses' WHERE product_key IN ('local_1','local_2')");
    expect((await i.loadCanonicalHistoryPrimary({request:req,profile,limit:48})).products).toHaveLength(7);
    expect(axios.get).not.toHaveBeenCalled();
  });
  test('only own US/USD in-stock offer determines served price',async () => {
    await client.query(`UPDATE agent_pdp_view SET price_min=1,offers=$1 WHERE content_key='local_1'`,[JSON.stringify([{market:'GB',currency:'GBP',price:1,availability:'in_stock'},{market:'US',currency:'USD',price:45,availability:'in_stock'}])]);
    await client.query("INSERT INTO catalog_offers(offer_id,product_key,merchant_id,market,currency,availability,merchant_effective_price,list_price,suppressed_at,suppression_reason) VALUES('foreign-cheap','local_1','foreign','US','USD','in_stock',1,NULL,NULL,NULL)");
    expect((await load()).products.find(p=>p.product_id==='sig_'+String(1).padStart(32,'0')).price).toBe(45);expect(axios.get).not.toHaveBeenCalled();
  });
  test.each(['price_asc','price_desc','popular'])('real primary SQL %s fixed pool preserves page windows and scoped total beyond old30/36 boundary',async sort=>{
    for(let n=9;n<43;n++){
      const id='sig_'+String(n).padStart(32,'0'),key='local_'+n;
      await client.query(`INSERT INTO agent_pdp_view SELECT $1,$2,brand,title,description,image_url,image_urls,currency,price_min,price_max,offer_count,offers,category_path,refreshed_at FROM agent_pdp_view WHERE content_key='local_0'`,[key,id]);
      await client.query(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at) SELECT $1,$1,$2,merchant_id,platform,$3,brand,canonical_url,sync_status,suppression_reason,updated_at FROM catalog_products WHERE product_key='local_0'`,[key,id,'ext_local_'+n]);
      await client.query("INSERT INTO catalog_row_trust VALUES('product',$1,'public')",[key]);
      await client.query("INSERT INTO catalog_offers(offer_id,product_key,merchant_id,market,currency,availability,merchant_effective_price,list_price,suppressed_at,suppression_reason) VALUES($1,$2,'merch_obs_local','US','USD','in_stock',$3,NULL,NULL,NULL)",['offer_'+n,key,n===31?1:n===32?100:45]);
      await client.query(`INSERT INTO external_product_seeds VALUES($1,$2,'https://jurlique.com/products/local-synthetic','active',NOW())`,['synthetic_seed_'+n,key]);
    }
    await client.query("UPDATE catalog_products SET canonical_url='https://jurlique.com/products/'||product_key; UPDATE external_product_seeds SET destination_url='https://jurlique.com/products/'||attached_product_key; UPDATE agent_pdp_view SET title='Jurlique Daily Ritual '||content_key WHERE content_key<>'local_0'");
    // Primary anchor/pool SQL is actual PG. Ancillary hydration/identity/shadow
    // reads are explicitly empty synthetic projections, not production claims.
    const limits=[];
    db.query.mockImplementation((sql,params)=>{
      if(sql.includes('COUNT(DISTINCT'))throw Error('global count must not run on this primary');
      if(sql.includes('WITH brand_match')){limits.push(params[2]);return client.query(sql,params);}
      if(sql.includes('AND apv.pivota_signature_id = ANY($2::text[])'))return client.query(sql,params);
      return Promise.resolve({rows:[]});
    });
    const opts={identityGraphRowsResolverFn:async()=>[],relationshipGraphRecallFn:()=>{throw Error('alternate provider')}};
    const pages=[];
    for(let page=1;page<=3;page++)pages.push(await getDiscoveryFeed({...payload,surface:'browse_products',page,limit:6,sort,debug:true},opts));
    expect(limits).toEqual([400,400,400]);
    expect(new Set(pages.flatMap(p=>p.products.map(x=>x.product_id))).size).toBe(18);
    for(const result of pages){
      expect(result.total).toBe(42);expect(result.metadata.runtime_corpus_count).toBe(42);
      expect(result.metadata.count_source).toBe('runtime_canonical_history_pool');
      expect(result.products.some(p=>p.product_id===sig)).toBe(false);
    }
    expect(axios.get).not.toHaveBeenCalled();
  });

  // Synthetic reconstruction of the captured public official listing: apply
  // adopts the CP/SKU seller while the validated offer keeps agent_seed seller.
  async function officialListing() {
    await client.query(`UPDATE catalog_products SET source_system='catalog_enrichment_agent_v1',source_domain='jurlique.com';
      INSERT INTO catalog_merchants VALUES('agent_seed::jurlique','Jurlique','catalog_enrichment_agent_v1','active',true,'jurlique.com','{"domain":"jurlique.com","agent_version":"catalog_enrichment_agent_v1"}');
      INSERT INTO catalog_skus SELECT product_key||'::canonical',product_key,merchant_id,NULL,NULL,'USD' FROM catalog_products;
      UPDATE catalog_offers SET merchant_id='agent_seed::jurlique',sku_key=product_key||'::canonical',source_system='catalog_enrichment_agent_v1',source_domain='jurlique.com',source_ref='https://jurlique.com/products/local-synthetic',offer_type='brand_direct',is_first_party=true,offer_mode='external_referral',catalog_track='external_referral',truth_tier='primary',readiness_tier='referral_only',offer_payload='{"agent_version":"catalog_enrichment_agent_v1","merchant_inferred":"Jurlique","destination_url":"https://jurlique.com/products/local-synthetic","canonical_url":"https://jurlique.com/products/local-synthetic"}';`);
  }
  test('official producer seller topology keeps cold original identity, current own money, and direct history/brand parity', async () => {
    await officialListing();
    await client.query('UPDATE catalog_offers SET merchant_effective_price=49');
    const cold = await i.fetchCanonicalSigBrowseCandidates({limit:48});
    expect(cold).toHaveLength(9);
    const original = cold.find(p => p.product_id === sig);
    expect(original.price).toBe(49);
    expect(original.currency).toBe('USD');
    expect(original.external_product_key).toBe('local_0');
    expect(original.merchant_id).toBe('external_seed');
    expect(original.offers.every(o => o.merchant_id === 'agent_seed::jurlique' && o.price === 49)).toBe(true);
    const history = await load();
    const brand = await i.fetchBrandScopedCanonicalCandidates({brandAliases:['Jurlique'],limit:48,strictPublicSource:true});
    expect(history.products).toHaveLength(9);
    expect(brand).toHaveLength(9);
    expect([...history.products,...brand].every(p => p.price === 49)).toBe(true);
    expect(axios.get).not.toHaveBeenCalled();
  });
  test.each([
    ['foreign same-key seller', "UPDATE catalog_offers SET merchant_id='agent_seed::foreign'"],
    ['CP brand namespace disagreement', "UPDATE catalog_products SET brand='Foreign'"],
    ['registry source', "UPDATE catalog_merchants SET source_system='unknown_writer'"],
    ['registry domain', "UPDATE catalog_merchants SET metadata_json=jsonb_set(metadata_json,'{domain}','\"foreign.invalid\"')"],
    ['registry inactive', "UPDATE catalog_merchants SET status='inactive'"],
    ['registry unindexable', "UPDATE catalog_merchants SET indexable=false"],
    ['offer source', "UPDATE catalog_offers SET source_system='unknown_writer'"],
    ['retailer role', "UPDATE catalog_offers SET offer_type='retailer'"],
    ['not first party', "UPDATE catalog_offers SET is_first_party=false"],
    ['offer source URL', "UPDATE catalog_offers SET source_ref='https://jurlique.com/products/foreign'"],
    ['offer destination', "UPDATE catalog_offers SET offer_payload=jsonb_set(offer_payload,'{destination_url}','\"https://foreign.invalid/product\"')"],
    ['SKU currency mismatch', "UPDATE catalog_skus SET currency='GBP'"],
    ['canonical query', "UPDATE catalog_products SET canonical_url=canonical_url||'?view=foreign'"],
    ['canonical fragment', "UPDATE catalog_products SET canonical_url=canonical_url||'#foreign'"],
    ['SKU foreign owner', "UPDATE catalog_skus SET merchant_id='foreign'"],
    ['SKU foreign product', "UPDATE catalog_skus SET product_key='foreign'"],
    ['SKU suppressed', "UPDATE catalog_skus SET suppressed_at=NOW()"],
    ['wrong market', "UPDATE catalog_offers SET market='GB'"],
    ['wrong currency', "UPDATE catalog_offers SET currency='GBP'"],
    ['out of stock', "UPDATE catalog_offers SET availability='out_of_stock'"],
    ['suppressed offer', "UPDATE catalog_offers SET suppression_reason='hidden'"],
    ['zero own price', "UPDATE catalog_offers SET merchant_effective_price=0"]
  ])('official listing %s cannot borrow cached APV offers or an alternate provider', async (_,sql) => {
    await officialListing();
    await client.query(sql);
    expect(await i.fetchCanonicalSigBrowseCandidates({limit:48})).toEqual([]);
    expect(await i.fetchBrandScopedCanonicalCandidates({brandAliases:['Jurlique'],limit:48,strictPublicSource:true})).toEqual([]);
    const history = await load();
    expect(history.products).toEqual([]);
    expect(history.recallSummary[0].status).toBe(200);
    expect(history.recallSummary[0].eligibility_reason).toBe('canonical_history_item_unavailable');
    expect(history.recallSummary[0]).not.toHaveProperty('failure_reason');
    expect(axios.get).not.toHaveBeenCalled();
  });
  test('newer private or suppressed content alias cannot replace the original public official source', async () => {
    await officialListing();
    await client.query(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at,source_system,source_domain)
      VALUES('shadow','local_0','sig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','foreign','external_seed','foreign-id','Jurlique','https://foreign.invalid/product','live',NULL,NOW()+INTERVAL '1 day','catalog_enrichment_agent_v1','foreign.invalid');
      INSERT INTO catalog_row_trust VALUES('product','shadow','private');`);
    const cold = await i.fetchCanonicalSigBrowseCandidates({limit:48});
    expect(cold.find(p=>p.product_id===sig).external_product_key).toBe('local_0');
    expect((await load()).products.find(p=>p.product_id===sig).price).toBe(45);
    await client.query("UPDATE catalog_row_trust SET serving_decision='public' WHERE subject_key='shadow'; UPDATE catalog_products SET suppression_reason='hidden' WHERE product_key='shadow'");
    expect((await i.fetchCanonicalSigBrowseCandidates({limit:48})).find(p=>p.product_id===sig).external_product_key).toBe('local_0');
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('published cold→original Iconic history→browse keeps the same official listing and current49, without SDK', async () => {
    for (let n=9;n<60;n++) {
      const id='sig_'+String(n).padStart(32,'0'), key='local_'+n;
      await client.query(`INSERT INTO agent_pdp_view SELECT $1,$2,brand,title,description,image_url,image_urls,currency,price_min,price_max,offer_count,offers,category_path,refreshed_at FROM agent_pdp_view WHERE content_key='local_0'`,[key,id]);
      await client.query(`INSERT INTO catalog_products(product_key,content_key,pivota_signature_id,merchant_id,platform,source_product_id,brand,canonical_url,sync_status,suppression_reason,updated_at) SELECT $1,$1,$2,merchant_id,platform,$3,brand,canonical_url,sync_status,suppression_reason,updated_at FROM catalog_products WHERE product_key='local_0'`,[key,id,'ext_local_'+n]);
      await client.query("INSERT INTO catalog_row_trust VALUES('product',$1,'public')",[key]);
      await client.query("INSERT INTO catalog_offers(offer_id,product_key,merchant_id,market,currency,availability,merchant_effective_price) VALUES($1,$2,'merch_obs_local','US','USD','in_stock',49)",['offer_'+n,key]);
    }
    await officialListing();
    await client.query(`UPDATE catalog_products SET canonical_url='https://jurlique.com/products/'||product_key;
      UPDATE catalog_offers co SET merchant_effective_price=49,source_ref=cp.canonical_url,offer_payload=jsonb_build_object('destination_url',cp.canonical_url,'canonical_url',cp.canonical_url) FROM catalog_products cp WHERE co.product_key=cp.product_key;
      UPDATE agent_pdp_view SET title='Jurlique Ritual '||content_key WHERE content_key<>'local_0';`);
    // The primary source and admission SQL are actual PostgreSQL. Ancillary
    // hydration/identity/count projections are empty, as in the earlier fixture.
    db.query.mockImplementation((sql,params) => sql.includes('FROM agent_pdp_view apv') || sql.includes('WITH brand_match')
      ? client.query(sql,params) : Promise.resolve({rows:[]}));
    const app=require('../../src/server');
    const request=require('supertest');
    async function published(input) {
      return (await request(app).post('/agent/shop/v1/invoke').send({operation:'get_discovery_feed',payload:input,
        metadata:{entry:'plp',scope:{catalog:'global',region:'US',language:'en-US'},ui_source:'shopping-agent-ui',source:'shopping_agent',market:'US'}}).expect(200)).body;
    }
    const cold=await published({surface:'home_hot_deals',limit:6,debug:true,context:{auth_state:'anonymous',locale:'en-US',recent_views:[],recent_queries:[]}});
    expect(cold.products.length).toBeGreaterThan(0);
    expect(cold.products.every(p=>p.price===49 && p.currency==='USD')).toBe(true);
    expect(cold.metadata.primary_path_used).toBe('canonical_sig');
    expect(cold.metadata.fallback_triggered).toBe(false);
    const original=(await i.fetchCanonicalSigBrowseCandidates({limit:60})).find(p=>p.product_id===sig);
    expect(original.external_product_key).toBe('local_0');
    const {buildRecentView,deriveRecentQuery}=require('../../scripts/run_discovery_feed_smoke.cjs');
    const context={auth_state:'authenticated',locale:'en-US',recent_views:[buildRecentView(original)],recent_queries:[deriveRecentQuery(original)]};
    for (const surface of ['home_hot_deals','browse_products']) {
      const result=await published({surface,limit:6,debug:true,context});
      expect(result.products.length).toBeGreaterThan(0);
      expect(result.products.every(p=>p.price===49 && p.currency==='USD')).toBe(true);
      expect(result.metadata.primary_path_used).toBe('canonical_sig_personalized');
      expect(result.metadata.fallback_triggered).toBe(false);
    }
    expect(axios.get).not.toHaveBeenCalled();
  });

});
