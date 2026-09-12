const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const reviewedAliases = require('../../data/beauty/meitu_brand_aliases.json');
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
      ['apieu_hair','A’PIEU Oily Hair Dry Powder (5g)',"A'PIEU",'beauty/haircare/treatment','Hair Treatment'],
      ['other_hair','Oily Hair Dry Powder','Other Brand','beauty/haircare/treatment','Hair Treatment'],
      ['apieu_face','Oily Skin Face Powder',"A'PIEU",'beauty/makeup/face/powder','Face Powder'],
      ['stila','Mini Stay All Day Liquid Lipstick','Stila','beauty/makeup/lip/lipstick','Lipstick'],
      ['glokolor','Pearl Glow Lipstick','Code Glökolor','beauty/makeup/lip/lipstick','Lipstick'],
      ['murad_cream','Barrier Repair Cream','MISSHA','beauty/skincare','Moisturizer'],
      ['murad_serum','Hydrating Serum','MISSHA','beauty/skincare','Serum'],
      ['murad_spf','Daily Sun Cream SPF50','MISSHA','beauty/skincare','Sunscreen'],
      ['chanel_perfume','Chance Eau de Parfum','Chanel','beauty','Perfume'],
      ['stila_wrong','Plumping Lipstick','Stila Cosmetics','beauty/makeup/lip/lipstick','Lipstick'],
      ['mac','M·A·Cximal Silky Matte Lipstick','M·A·C','beauty/makeup/lip/lipstick','Lipstick'],
      ['romand','Juicy Lasting Lip Tint','rom&nd','beauty/makeup','Lip Tint'],
      ['romand_wrong','Glasting Lip Gloss','rom&nd','beauty/makeup/lip/gloss','Lip Gloss'],
      ['mac_brush','Foundation Brush','MAC','beauty/makeup','Brush'],
      ['mac_foundation','Studio Fix Fluid Foundation','MAC Cosmetics','beauty/makeup','Foundation'],
      ...Array.from({length:220},(_,i)=>[`brush_${i}`,`Foundation Brush Tool ${i}`,'MAC','beauty/makeup/face/foundation','Brush']),
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
    ["A'PIEU Oily Hair Dry Powder",'apieu_hair'],['Stila Cosmetics products','stila'],['Stila Stay All Day Liquid Lipstick','stila'],
    ['M·A·C MACximal Silky Matte Lipstick','mac'],['romand lip tint','romand'],['MAC foundation','mac_foundation'],
    ['Code Glokolor lipstick','glokolor'],['MISSHA moisturizer','murad_cream'],['MISSHA serum','murad_serum'],
    ['MISSHA sunscreen','murad_spf'],['Chanel perfume','chanel_perfume'],
  ])('%s succeeds on the canonical main route',async(q,id)=>{
    const res=await invoke(q); expect(res.status).toBe(200);expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products.some(p=>p.product_key===id || p.product_ref?.product_id===id || p.id===id)).toBe(true);
    expect(res.body.products.every(p=>p.source==='canonical_chain')).toBe(true);
    expect(res.body.metadata.route_health.fallback_triggered).toBe(false);
    expect(res.body.metadata.canonical_returned_count).toBe(res.body.products.length);
    expect(sqlCalls).toHaveLength(1);
    expect(res.body.status).toBe('success');
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.products.length);
    if(q.includes('MISSHA') || q.includes('Code Glokolor') || q.includes('Stay All') || q.includes('MACximal') || q.includes('tint') || q.includes('foundation')) expect(res.body.products).toHaveLength(1);
  });
  test('exact oily-hair title keeps stock and explicit currency gates before final ranking', async()=>{
    const search = ()=>request(app).post('/agent/shop/v1/invoke').send({operation:'find_products_multi',
      payload:{search:{query:"A'PIEU Oily Hair Dry Powder",domain:'beauty',market:'US',currency:'USD',limit:10}},
      metadata:{source:'public_api',market:'US'}});
    const valid=await search();
    expect(valid.body.status).toBe('success');expect(valid.body.products).toHaveLength(1);
    expect(valid.body.products[0].product_key).toBe('apieu_hair');
    expect(valid.body.metadata.canonical_raw_count).toBe(1);
    try {
      await db.query("UPDATE catalog_offers SET availability='out_of_stock' WHERE offer_id='apieu_hair'");
      expect((await search()).body.products).toEqual([]);
      await db.query("UPDATE catalog_offers SET availability='in_stock',currency='EUR' WHERE offer_id='apieu_hair'");
      expect((await search()).body.products).toEqual([]);
    } finally {
      await db.query("UPDATE catalog_offers SET availability='in_stock',currency='USD' WHERE offer_id='apieu_hair'");
    }
    expect(sqlCalls).toHaveLength(3);
  });
  test('every reviewed roster alias matches its stored identity in PostgreSQL',async()=>{
    const {buildCanonicalSearchQualitySql}=require('../../src/services/canonicalSearchQualitySql');
    for(const [brand_key,aliases] of Object.entries(reviewedAliases)) {
      for(const alias of aliases) {
        const params=['probe','%probe%'];
        const scoped=buildCanonicalSearchQualitySql({contract:{target_domain:'beauty',query_class:'brand_browse',
          hard_constraints:{brand:{brand_key,canonical:aliases[0],alias}}},params,defaultWhere:'FALSE',defaultBrandWhere:''});
        params.push(alias);
        const result=await db.query(`SELECT $1::text FROM (SELECT $${params.length}::text AS brand, 'Lipstick'::text AS title, 'Lipstick'::text AS product_type, 'beauty/makeup/lip/lipstick'::text AS category_path, '{}'::jsonb AS product_payload) p WHERE ${scoped.where} ${scoped.brandWhere}`,params);
        expect({brand_key,alias,count:result.rows.length}).toEqual({brand_key,alias,count:1});
      }
    }
  });
  test('accessory rows cannot exhaust the primary candidate limit',async()=>{
    const res=await invoke('MAC foundation',1,2);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].title).toBe('Studio Fix Fluid Foundation');
    expect(sqlCalls[0].params[2]).toBeLessThan(220);
    expect(res.body.metadata.canonical_raw_count).toBe(1);
  });
  test('successive pages contain different eligible canonical products',async()=>{
    const first=await invoke('MAC lipstick',1,10), second=await invoke('MAC lipstick',2,10);
    expect(first.body.products).toHaveLength(10);expect(second.body.products).toHaveLength(10);
    const ids=new Set(first.body.products.map(p=>p.id));
    expect(second.body.products.every(p=>!ids.has(p.id))).toBe(true);
  });
  test('deep bounded pages retain the full primary candidate window',async()=>{
    const res=await invoke('MAC lipstick',40,2);
    expect(res.body.products).toHaveLength(2);
    expect(sqlCalls[0].params[2]).toBeGreaterThanOrEqual(80);
  });
  test('pages four and five share one fixed candidate window and never repeat products',async()=>{
    const fourth=await invoke('MAC lipstick',4,10), fifth=await invoke('MAC lipstick',5,10);
    expect(fourth.status).toBe(200);expect(fifth.status).toBe(200);
    expect(fourth.body.products).toHaveLength(10);expect(fifth.body.products).toHaveLength(10);
    expect(sqlCalls).toHaveLength(2);
    // params[2] is the actual candidate LIMIT consumed by PostgreSQL. It must
    // not grow between pages and allow newly recalled candidates to reorder
    // products into an already served page. The whole SQL/bind set is stable.
    expect(sqlCalls.map(call=>call.params[2])).toEqual([200,200]);
    expect(sqlCalls[1]).toEqual(sqlCalls[0]);
    const previous=new Set(fourth.body.products.map(product=>product.id));
    expect(fifth.body.products.every(product=>!previous.has(product.id))).toBe(true);
    for(const body of [fourth.body,fifth.body]) {
      expect(body.metadata).toMatchObject({primary_result_window:200,total_is_lower_bound:true});
      expect(body.total).toBeLessThanOrEqual(200);
    }
  });
  test('a primary SQL failure propagates instead of succeeding on seed data',async()=>{
    failCanonical=true;
    const res=await invoke('MAC lipstick');
    expect(res.status).toBe(503);
    expect(res.body.products || []).toEqual([]);
    expect(sqlCalls).toHaveLength(1);
  });
  test('precise canonical category accepts a missing form word but rejects conflicting own type',async()=>{
    try {
      await db.query("UPDATE catalog_products SET title='Studio Fix Fluid SPF15',product_type=NULL,category_path='beauty/makeup/face/foundation' WHERE product_key='mac_foundation'");
      const valid=await invoke('MAC foundation');
      expect(valid.status).toBe(200);expect(valid.body.status).toBe('success');
      expect(valid.body.products).toHaveLength(1);
      expect(valid.body.products[0].product_key).toBe('mac_foundation');
      for (const [title, type] of [['Studio Fix Cream','Cream'], ['Studio Fix Serum Foundation','Serum']]) {
        await db.query("UPDATE catalog_products SET title=$1,product_type=$2 WHERE product_key='mac_foundation'",[title,type]);
        const hybrid=await invoke('MAC foundation');
        expect(hybrid.body.products).toHaveLength(1);
        expect(hybrid.body.products[0].product_key).toBe('mac_foundation');
      }
      await db.query("UPDATE catalog_products SET title='Barrier Repair Cream',product_type='Moisturizer' WHERE product_key='mac_foundation'");
      expect((await invoke('MAC foundation')).body.products).toEqual([]);
      await db.query("UPDATE catalog_products SET title='Studio Fix Fluid SPF15',product_type='Eyeliner' WHERE product_key='mac_foundation'");
      const conflict=await invoke('MAC foundation');
      expect(conflict.body.products).toEqual([]);
      // An ancestor alone still cannot qualify via description cross-sell.
      await db.query("UPDATE catalog_products SET product_type=NULL,category_path='beauty/makeup' WHERE product_key='mac_foundation'");
      const thin=await invoke('MAC foundation');expect(thin.body.products).toEqual([]);
    } finally {
      await db.query("UPDATE catalog_products SET title='Studio Fix Fluid Foundation',product_type='Foundation',category_path='beauty/makeup' WHERE product_key='mac_foundation'");
    }
  });

  test('canonical exact-brand index is valid and available before offer selection',async()=>{
    const {primaryBrandIndexDefinitions}=require('../../scripts/catalog/primary_brand_indexes');
    const index=primaryBrandIndexDefinitions().find(index=>index.table==='catalog_products');
    await db.query(index.sql);await db.query('ANALYZE catalog_products');
    const ready=await db.query("SELECT indisvalid,indisready FROM pg_index WHERE indexrelid=$1::regclass",[schema+'.'+index.name]);
    expect(ready.rows[0]).toEqual({indisvalid:true,indisready:true});
    const res=await invoke('Stila Cosmetics products');
    expect(res.body.products).toHaveLength(2);
    const explain=await db.query('EXPLAIN (FORMAT JSON) '+sqlCalls[0].sql,sqlCalls[0].params);
    const nodes=[];const walk=node=>{nodes.push(node);for(const child of node.Plans||[])walk(child);};
    walk(explain.rows[0]['QUERY PLAN'][0].Plan);
    expect(nodes.some(node=>node['Index Name']===index.name)).toBe(true);
  });

});
