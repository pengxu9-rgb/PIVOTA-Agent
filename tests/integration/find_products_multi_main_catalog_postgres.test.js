const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { buildSearchQualityContract } = require('../../src/findProductsMulti/queryUnderstanding');

// Dedicated disposable DB only. CI/operators opt in with this explicit test URL.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('canonical MAIN route with real PostgreSQL and no rescue lanes', () => {
  let db, schema, priorEnv, app, sqlCalls, failCanonical;
  beforeAll(async () => {
    db = new Client({ connectionString: url }); await db.connect();
    schema = `main_recall_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    // Materialize the columns referenced by the production statement. Every SQL
    // predicate/join/order/limit is then executed by PostgreSQL, not reimplemented
    // by a test mock. Fixture tables contain no production data.
    let sql;
    await fetchCanonicalChainRows({query:'MAC lipstick',categoryPathPrefix:'beauty/makeup/lip/',categoryMode:'category_browse',
      includeSkuOffers:true,marketId:'US', searchQualityContract:buildSearchQualityContract({rawQuery:'MAC lipstick'}),
      deps:{query:async(text)=>{sql=text;return {rows:[]};}}});
    const tables = {};
    for (const match of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
      const [,table,alias]=match; tables[table] ||= new Set();
      for(const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`,'g'))) tables[table].add(ref[1]);
    }
    tables.index_pipeline_state.add('serving_eligible');
    for(const [table,cols] of Object.entries(tables)) {
      const definitions=[...cols].map(col=> {
        const type = /^(serving_eligible|index_eligible)$/.test(col) ? 'boolean' :
          /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb' :
          /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric' :
          /(_at)$/.test(col) ? 'timestamptz' : 'text';
        return `${col} ${type}`;
      });
      await db.query(`CREATE TABLE ${table} (${definitions.join(',')})`);
    }
    await db.query("INSERT INTO catalog_merchants(merchant_id,merchant_name,status,primary_platform) VALUES ('retailer','Retailer','active','shopify')");
    const items=[
      ['stila','Mini Stay All Day Liquid Lipstick','Stila','beauty/makeup/lip/lipstick','Lipstick'],
      ['stila_wrong','Plumping Lipstick','Stila Cosmetics','beauty/makeup/lip/lipstick','Lipstick'],
      ['mac','M·A·Cximal Silky Matte Lipstick','M·A·C','beauty/makeup/lip/lipstick','Lipstick'],
      ['romand','Juicy Lasting Lip Tint','rom&nd','beauty/makeup','Lip Tint'],
      ['romand_wrong','Glasting Lip Gloss','rom&nd','beauty/makeup/lip/gloss','Lip Gloss'],
      ['mac_brush','Foundation Brush','MAC','beauty/makeup','Brush'],
      ['mac_foundation','Studio Fix Fluid Foundation','MAC Cosmetics','beauty/makeup','Foundation'],
      ...Array.from({length:100},(_,i)=>[`mac_${i}`,`MAC Lipstick Color ${String(i).padStart(2,'0')}`,'MAC Cosmetics','beauty/makeup/lip/lipstick','Lipstick']),
    ];
    for(const [id,title,brand,category,type] of items) {
      const sig=`sig_${Buffer.from(id).toString('hex').padEnd(32,'0').slice(0,32)}`;
      await db.query(`INSERT INTO catalog_products(product_key,merchant_id,platform,source_product_id,title,brand,product_type,
       category_path,content_key,pivota_signature_id,pivota_canonical_url,canonical_url,image_url,product_payload,updated_at)
       VALUES ($1,'retailer','shopify',$1,$2,$3,$4,$5,$1,$6,$7,$8,$9,$10,now())`,
       [id,title,brand,type,category,sig,`https://agent.pivota.cc/products/${sig}`,`https://retailer.example/products/${id}`,
        `https://cdn.example/${id}.jpg`,{description:'Pair with Stay All Day Liquid Lipstick and MACximal Silky Matte Lipstick'}]);
      await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible) VALUES ($1,true)',[id]);
      await db.query('INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$1,$2)',[id,`variant_${id}`]);
      await db.query("INSERT INTO catalog_offers(offer_id,sku_key,merchant_effective_price,currency,availability) VALUES ($1,$1,20,'USD','in_stock')",[id]);
    }
  });
  afterAll(async()=> {if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();}});
  beforeEach(()=>{
    priorEnv={...process.env};jest.resetModules();sqlCalls=[];failCanonical=false;
    Object.assign(process.env,{DATABASE_URL:url,PIVOTA_API_BASE:'http://upstream-disabled.test',PIVOTA_API_KEY:'test',API_MODE:'REAL',
      INDEX_ELIGIBLE_RECALL:'false',PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED:'true',SEARCH_QUALITY_CONTRACT_V1_ENABLED:'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE:'enforce',PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED:'false',
      CANONICAL_CATALOG_RECALL_DOC_MATCH:'off',CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION:'off',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:'false'});
    nock.disableNetConnect();nock.enableNetConnect(host=>host.includes('127.0.0.1'));
    jest.doMock('../../src/db',()=>({query:async(sql,params)=>{
      if(sql.includes('WITH candidate_products AS') && sql.includes('ips.serving_eligible')) {
        sqlCalls.push({sql,params}); if(failCanonical) throw Object.assign(new Error('primary unavailable'),{code:'PRIMARY_TEST_FAILURE'});
        return db.query(sql,params);
      }
      if(sql.includes('ips.index_eligible')) throw new Error('citation rescue must not execute');
      return {rows:[]}; // no seed/cache/rescue data exists in this fixture
    }}));
    app=require('../../src/server');
  });
  afterEach(()=>{process.env=priorEnv;jest.dontMock('../../src/db');jest.resetModules();nock.cleanAll();nock.enableNetConnect();});
  const invoke=(query,page=1,limit=10)=>request(app).post('/agent/shop/v1/invoke').send({operation:'find_products_multi',
    payload:{search:{query,domain:'beauty',market:'US',page,limit}},metadata:{source:'public_api',market:'US'}});
  test.each([
    ['Stila Cosmetics products','stila'],['Stila Stay All Day Liquid Lipstick','stila'],
    ['M·A·C MACximal Silky Matte Lipstick','mac'],['romand lip tint','romand'],['MAC foundation','mac_foundation'],
  ])('%s succeeds on the canonical main route',async(q,id)=>{
    const res=await invoke(q); expect(res.status).toBe(200);expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products.some(p=>p.product_key===id || p.product_ref?.product_id===id || p.id===id)).toBe(true);
    expect(res.body.products.every(p=>p.source==='canonical_chain')).toBe(true);
    expect(res.body.metadata.route_health.fallback_triggered).toBe(false);
    expect(res.body.metadata.canonical_returned_count).toBe(res.body.products.length);
    expect(sqlCalls).toHaveLength(1);
    expect(res.body.status).toBe('success');
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.products.length);
    if(q.includes('Stay All') || q.includes('MACximal') || q.includes('tint') || q.includes('foundation')) expect(res.body.products).toHaveLength(1);
  });
  test('successive pages contain different eligible canonical products',async()=>{
    const first=await invoke('MAC lipstick',1,10), second=await invoke('MAC lipstick',2,10);
    expect(first.body.products).toHaveLength(10);expect(second.body.products).toHaveLength(10);
    const ids=new Set(first.body.products.map(p=>p.id));
    expect(second.body.products.every(p=>!ids.has(p.id))).toBe(true);
  });
  test('deep bounded pages expand recall depth before final pagination',async()=>{
    const res=await invoke('MAC lipstick',40,2);
    expect(res.body.products).toHaveLength(2);
    expect(sqlCalls[0].params[2]).toBeGreaterThanOrEqual(80);
  });
  test('a primary SQL failure propagates instead of succeeding on seed data',async()=>{
    failCanonical=true;
    const res=await invoke('MAC lipstick');
    expect(res.status).toBe(503);
    expect(res.body.products || []).toEqual([]);
    expect(sqlCalls).toHaveLength(1);
  });
});
