const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');

// Dedicated disposable DB only. CI/operators opt in with this explicit test URL.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('primary seed offer scope with real PostgreSQL and no rescue lanes', () => {
  let db, schema, priorEnv, app, sqlCalls, forceWrongCurrency;
  beforeAll(async () => {
    db=new Client({connectionString:url});await db.connect();schema=`seed_constraints_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE catalog_products(product_key text,content_key text,pivota_signature_id text,pivota_canonical_url text,category_path text,merchant_id text,source_system text);
      CREATE TABLE index_pipeline_state(content_key text,serving_eligible boolean);
      CREATE TABLE external_product_seeds(id text,external_product_id text,market text,tool text,destination_url text,canonical_url text,domain text,title text,image_url text,price_amount numeric,price_currency text,availability text,seed_data jsonb,updated_at timestamptz,created_at timestamptz,status text,attached_product_key text);`);
    for(const brand of ['MAC','Stila']) {
      for(let i=0;i<221;i++) {
        const id=`${brand}_${i}`,valid=i===220;
        const sig='sig_'+require('crypto').createHash('md5').update(id).digest('hex');
        await db.query("INSERT INTO catalog_products VALUES ($1,$1,$2,$3,'beauty/makeup/lip/lipstick','retailer','external_seed')",[id,sig,`https://agent.pivota.cc/products/${sig}`]);
        await db.query('INSERT INTO index_pipeline_state VALUES ($1,true)',[id]);
        await db.query("INSERT INTO external_product_seeds VALUES ($1,$1,'US','shopping_agents',$2,$2,'retailer.example',$3,$4,$5,$6,'in_stock',$7,$8,now(),'active',$1)",
          [id,`https://retailer.example/${id}`,`${brand} Matte Lipstick ${i}`,`https://cdn.example/${id}.jpg`,brand==='Stila'&&!valid?100:20,brand==='MAC'&&!valid?'EUR':'USD',
           {brand,category:'Lipstick'},new Date(Date.now()-(valid?100000:0))]);
      }
    }
  });
  afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();}});
  beforeEach(()=>{
    priorEnv={...process.env};jest.resetModules();sqlCalls=[];forceWrongCurrency=false;
    Object.assign(process.env,{DATABASE_URL:url,PIVOTA_API_BASE:'http://upstream-disabled.test',PIVOTA_API_KEY:'test',API_MODE:'REAL',
      INDEX_ELIGIBLE_RECALL:'false',PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED:'true',SEARCH_QUALITY_CONTRACT_V1_ENABLED:'true',
      SEARCH_QUALITY_CONTRACT_V1_MODE:'enforce',PIVOT_BEAUTY_MAINLINE_TOKEN_MATCH_ENABLED:'false',
      CANONICAL_CATALOG_RECALL_DOC_MATCH:'off',CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION:'off',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:'false'});
    nock.disableNetConnect();nock.enableNetConnect(host=>host.includes('127.0.0.1'));
    jest.doMock('../../src/db',()=>({query:async(sql,params)=>{
      if(sql.includes('FROM external_product_seeds') && !sql.includes('FROM candidate_products c')) {
        sqlCalls.push({sql,params});
        const result=await db.query(sql,params);
        if(forceWrongCurrency) result.rows=result.rows.map(row=>({...row,price_currency:'EUR'}));
        return result;
      }
      if(sql.includes('ips.index_eligible')) throw new Error('citation rescue must not execute');
      return {rows:[]}; // canonical/cache/rescue lanes contain no products
    }}));
    app=require('../../src/server');
  });
  afterEach(()=>{process.env=priorEnv;jest.dontMock('../../src/db');jest.resetModules();nock.cleanAll();nock.enableNetConnect();});
  const invoke=(query,search={})=>request(app).post('/agent/shop/v1/invoke').send({operation:'find_products_multi',
    payload:{search:{query,domain:'beauty',market:'US',limit:10,...search}},metadata:{source:'public_api',market:'US'}});
  test.each([
    ['MAC lipstick',{currency:'USD'},'MAC_220'],
    ['MAC',{currency:'USD'},'MAC_220'],
    ['Stila lipstick',{currency:'USD',price_max:25},'Stila_220'],
  ])('%s enforces seed offer scope before the candidate limit',async(q,search,id)=>{
    const res=await invoke(q,search);
    expect(res.status).toBe(200);expect(res.body.status).toBe('success');
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0]).toMatchObject({source:'external_seed',currency:'USD',price:20,source_product_id:id});
    expect(sqlCalls.length).toBeGreaterThan(0);
    expect(res.body.metadata.route_health.fallback_triggered).toBe(false);
  });
  test('final guard rejects a seed adapter returning a different explicit currency',async()=>{
    forceWrongCurrency=true;
    const res=await invoke('MAC lipstick',{currency:'USD'});
    expect(res.status).toBe(200);expect(res.body.products).toEqual([]);
    expect(res.body.status).toBe('failed');
    expect(sqlCalls.length).toBeGreaterThan(0);
  });
  test.each([['cleanser',1],['cleanser and moisturizer',2]])('category SQL shape scopes currency before each cut: %s',async(query,expected)=>{
    await db.query('BEGIN');
    try {
      await db.query("UPDATE external_product_seeds SET title=CASE WHEN id LIKE 'MAC_%' THEN 'MAC Gentle Cleanser' ELSE 'Stila Barrier Moisturizer' END,seed_data=jsonb_set(seed_data,'{category}',to_jsonb(CASE WHEN id LIKE 'MAC_%' THEN 'cleanser'::text ELSE 'moisturizer'::text END)),price_currency=CASE WHEN id IN ('MAC_220','Stila_220') THEN 'USD' ELSE 'EUR' END");
      await db.query("UPDATE catalog_products SET category_path=CASE WHEN product_key LIKE 'MAC_%' THEN 'beauty/skincare/cleanse' ELSE 'beauty/skincare/moisturize' END");
      const res=await invoke(query,{currency:'USD'});
      expect(res.status).toBe(200);expect(res.body.status).toBe('success');
      expect(res.body.products).toHaveLength(expected);
      expect(res.body.products.every(p=>p.currency==='USD' && ['MAC_220','Stila_220'].includes(p.source_product_id))).toBe(true);
      expect(sqlCalls.some(call=>call.sql.includes('UNION ALL'))).toBe(expected===2);
    } finally {await db.query('ROLLBACK');}
  });

  test('reviewed brand aliases use own seed identity, not title or cross-sell descriptions',async()=>{
    const aliases=require('../../data/beauty/meitu_brand_aliases.json');
    const {buildSeedSearchOfferScope}=require('../../src/services/seedSearchOfferScope');
    for(const [brand_key,names] of Object.entries(aliases)) {
      for(const name of names) {
        const params=[];
        const predicate=buildSeedSearchOfferScope({brand:{brand_key,brand:names[0]}},params);
        params.push({brand:name});
        const rows=await db.query(`SELECT 1 FROM (SELECT $${params.length}::jsonb AS seed_data, 20::numeric AS price_amount) seed WHERE TRUE ${predicate}`,params);
        expect({brand_key,name,count:rows.rows.length}).toEqual({brand_key,name,count:1});
      }
    }
    const params=[];
    const predicate=buildSeedSearchOfferScope({brand:{brand_key:'mac_cosmetics',brand:'MAC'}},params);
    params.push({brand:'Stila',title:'MAC Cosmetics Lipstick',description:'Pair with MAC Cosmetics'});
    const wrong=await db.query(`SELECT 1 FROM (SELECT $${params.length}::jsonb AS seed_data, 20::numeric AS price_amount) seed WHERE TRUE ${predicate}`,params);
    expect(wrong.rows).toEqual([]);
  });

  test.each(['in_stock',null])('explicit unavailable seed variants cannot consume the cut; eligible stock=%s',async(availability)=>{
    await db.query('BEGIN');
    try {
      await db.query("UPDATE external_product_seeds SET price_currency='USD',availability=(ARRAY['soldout','sold_out','sold out','unavailable','false','out_of_stock','oos'])[1+(substring(id FROM '[0-9]+$')::int % 7)] WHERE id LIKE 'MAC_%'");
      await db.query("UPDATE external_product_seeds SET availability=$1 WHERE id='MAC_220'",[availability]);
      const res=await invoke('MAC lipstick',{in_stock_only:true});
      expect(res.status).toBe(200);expect(res.body.status).toBe('success');
      expect(res.body.products).toHaveLength(1);
      expect(res.body.products[0].source_product_id).toBe('MAC_220');
      expect(res.body.products[0].currency).toBe('USD');
    } finally {await db.query('ROLLBACK');}
  });

  test('unusable prices cannot consume the primary seed limit even without a budget',async()=>{
    await db.query('BEGIN');
    try {
      await db.query("UPDATE external_product_seeds SET price_currency='USD',price_amount=(ARRAY[NULL,0,-10])[1+(substring(id FROM '[0-9]+$')::int % 3)] WHERE id LIKE 'MAC_%' AND id<>'MAC_220'");
      // Whitespace falls through to the same own snapshot currency as the mapper.
      await db.query("UPDATE external_product_seeds SET price_currency='  ',seed_data=jsonb_set(seed_data,'{price_currency}','\"USD\"') WHERE id='MAC_220'");
      const res=await invoke('MAC lipstick',{currency:'USD'});
      expect(res.status).toBe(200);expect(res.body.status).toBe('success');
      expect(res.body.products).toHaveLength(1);
      expect(res.body.products[0]).toMatchObject({source_product_id:'MAC_220',price:20,currency:'USD'});
    } finally {await db.query('ROLLBACK');}
  });

  test.each(["A'PIEU lip oil",'lip oil'])('explicit lip-oil form reaches seed-only primary SQL: %s',async(query)=>{
    await db.query('BEGIN');
    try {
      await db.query("UPDATE external_product_seeds SET title=$1,seed_data=$2 WHERE id='MAC_220'",["A'PIEU Honey Milk Lip Oil",{brand:"A'PIEU",category:'Lip Oil'}]);
      await db.query("UPDATE catalog_products SET category_path='beauty/makeup/lip/oil' WHERE product_key='MAC_220'");
      const res=await invoke(query,{currency:'USD'});
      expect(res.status).toBe(200);expect(res.body.status).toBe('success');
      expect(res.body.products).toHaveLength(1);
      expect(res.body.products[0]).toMatchObject({source:'external_seed',source_product_id:'MAC_220',currency:'USD',price:20});
      expect(sqlCalls.every(call=>call.params.includes('%lip oil%'))).toBe(true);
      expect(sqlCalls.every(call=>!call.params.includes('%lipstick%'))).toBe(true);
    } finally {await db.query('ROLLBACK');}
  });
  test('seed hash index is valid and full equality rejects an accelerator collision',async()=>{
    const {primaryBrandIndexDefinitions}=require('../../scripts/catalog/primary_brand_indexes');
    const index=primaryBrandIndexDefinitions().find(index=>index.table==='external_product_seeds');
    await db.query(index.sql);
    const ready=await db.query("SELECT indisvalid,indisready FROM pg_index WHERE indexrelid=$1::regclass",[schema+'.'+index.name]);
    expect(ready.rows[0]).toEqual({indisvalid:true,indisready:true});
    const {buildSeedSearchOfferScope}=require('../../src/services/seedSearchOfferScope');
    const params=[];
    const predicate=buildSeedSearchOfferScope({brand:{brand_key:'mac_cosmetics',brand:'MAC'}},params);
    // An accelerator hit alone must not qualify the wrong identity.
    params[1]=[require('crypto').createHash('md5').update('stila').digest('hex')];
    params.push({brand:'Stila'});
    const collision=await db.query(`SELECT 1 FROM (SELECT $${params.length}::jsonb seed_data,20::numeric price_amount) p WHERE TRUE ${predicate}`,params);
    expect(collision.rows).toEqual([]);
  });

});
