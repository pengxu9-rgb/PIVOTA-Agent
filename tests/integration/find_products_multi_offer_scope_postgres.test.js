const { Client } = require('pg');
const request = require('supertest');
const nock = require('nock');
const { fetchCanonicalChainRows } = require('../../src/services/canonicalCatalogSearch');
const { resolveBudgetConstraintsForRecall, resolveBudgetConstraintForCurrency } = require('../../src/findProductsMulti/policy');

// Opt-in disposable PostgreSQL only; unique schema, no production data/apply.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('primary offer constraints execute before the candidate cut', () => {
  let db, schema;
  const scope = updates => ({ markets: ['US'], inStockOnly: true, currency: 'USD', ...updates });
  const recall = (merchantId, offerScope, extra = {}) => fetchCanonicalChainRows({
    query: 'lipstick', merchantId, includeSkuOffers: true, limit: 1,
    marketId: 'US', offerScope, ...extra, deps: { query: (sql, params) => db.query(sql, params) },
  });
  async function product(id, merchant, title = 'Lipstick') {
    await db.query("INSERT INTO catalog_products(product_key,merchant_id,platform,source_product_id,title,brand,content_key,category_path,canonical_url,image_url,pivota_signature_id,updated_at) VALUES ($1,$2,'shopify',$1,$3,'MAC',$1,'beauty/makeup/lip/lipstick',$4,$5,$6,now())",
      [id,merchant,title,`https://retailer.example/products/${id}`,`https://cdn.example/${id}.jpg`,`sig_${Buffer.from(id).toString('hex').padEnd(32,'0').slice(0,32)}`]);
    await db.query('INSERT INTO index_pipeline_state(content_key,serving_eligible) VALUES ($1,true)', [id]);
    await db.query('INSERT INTO catalog_skus(sku_key,product_key,source_variant_id) VALUES ($1,$1,$1)', [id]);
  }
  async function offer(id, productKey, price, {currency='USD', availability='in_stock', market='US', quantity=null, suppressed=false} = {}) {
    await db.query('INSERT INTO catalog_offers(offer_id,sku_key,product_key,merchant_effective_price,currency,availability,market,inventory_quantity,suppressed_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8)',
      [id, productKey, price, currency, availability, market, quantity, suppressed ? new Date() : null]);
  }
  beforeAll(async () => {
    db = new Client({connectionString:url}); await db.connect();
    schema = `offer_scope_${process.pid}_${Date.now()}`;
    await db.query(`CREATE SCHEMA ${schema}`); await db.query(`SET search_path TO ${schema}`);
    let sql;
    await fetchCanonicalChainRows({query:'lipstick',marketId:'US',includeSkuOffers:true,offerScope:scope({priceRanges:[{currency:'USD',min:5,max:20}]}),
      deps:{query:async text => {sql=text;return {rows:[]};}}});
    const tables = {};
    for (const [,table,alias] of sql.matchAll(/(?:FROM|JOIN)\s+(catalog_\w+|index_pipeline_state|external_product_seeds|merchant_stores)\s+(\w+)/g)) {
      tables[table] ||= new Set();
      for(const ref of sql.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`,'g'))) tables[table].add(ref[1]);
    }
    tables.catalog_offers.add('product_key');
    for(const [table,cols] of Object.entries(tables)) {
      const defs=[...cols].map(col => `${col} ${/^(serving_eligible|index_eligible)$/.test(col) ? 'boolean' :
        /(_payload|_json|^seed_data$|^visible_attributes$|^visible_option_labels$|^ingredient_ids$)/.test(col) ? 'jsonb' :
        /^(list_price|merchant_effective_price|estimated_best_price|inventory_quantity|.*confidence)$/.test(col) ? 'numeric' : /(_at)$/.test(col) ? 'timestamptz' : 'text'}`);
      await db.query(`CREATE TABLE ${table} (${defs.join(',')})`);
    }
    for(const merchant of ['budget','sibling','fx','unknown','stockcap','currencycap','marketcap']) await db.query("INSERT INTO catalog_merchants(merchant_id,merchant_name,status) VALUES ($1,$1,'active')",[merchant]);
    // More rejected products than the real candidate cap (25 at limit=1),
    // all higher ranked than the valid product. No JS model of SQL filtering.
    for(let i=0;i<35;i++) {await product(`expensive_${i}`,'budget');await offer(`expensive_offer_${i}`,`expensive_${i}`,100);}
    await product('affordable','budget','Affordable Lipstick'); await offer('affordable_offer','affordable',15);
    await product('siblings','sibling');
    await offer('cheap_soldout','siblings',1,{availability:'sold out'});
    await offer('cheap_zero_stock','siblings',2,{quantity:0});
    await offer('cheap_wrong_currency','siblings',3,{currency:'JPY'});
    await offer('cheap_wrong_market','siblings',4,{market:'CA'});
    await offer('cheap_suppressed','siblings',5,{suppressed:true});
    await offer('valid_sibling','siblings',15);
    await product('fx_valid','fx');await offer('fx_valid_offer','fx_valid',10.9);
    await product('fx_expensive','fx');await offer('fx_expensive_offer','fx_expensive',10.91);
    await product('fx_unsupported','fx');await offer('fx_unsupported_offer','fx_unsupported',1,{currency:'SGD'});
    await product('unknown','unknown');await offer('unknown_offer','unknown',12,{availability:null,quantity:null,market:null});
    for(const [merchant,options] of [['stockcap',{availability:'out_of_stock'}],['currencycap',{currency:'JPY'}],['marketcap',{market:'CA'}]]) {
      for(let i=0;i<35;i++) {await product(`${merchant}_${i}`,merchant);await offer(`${merchant}_offer_${i}`,`${merchant}_${i}`,11,options);}
      await product(`${merchant}_valid`,merchant,'Eligible Lipstick');await offer(`${merchant}_valid_offer`,`${merchant}_valid`,19);
    }
  });
  afterAll(async()=>{if(db){await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();}});

  test('budget predicate recovers a valid product beyond the unfiltered candidate limit',async()=>{
    const before=await recall('budget',null);
    expect(before).toHaveLength(25);expect(before.some(r=>r.product_key==='affordable')).toBe(false);
    const after=await recall('budget',scope({priceRanges:resolveBudgetConstraintsForRecall({currency:'USD',min:10,max:20})}));
    expect(after.map(r=>r.product_key)).toEqual(['affordable']);
    expect(Number(after[0].merchant_effective_price)).toBe(15);
  });
  test.each([true,false])('chooses the eligible sibling offer on both SQL projections, SKU projection=%s',async includeSkuOffers=>{
    const rows=await recall('sibling',scope({priceRanges:[{currency:'USD',min:0,max:20}]}),{includeSkuOffers});
    expect(rows).toHaveLength(1);expect(Number(rows[0].merchant_effective_price)).toBe(15);
    expect(rows[0].availability).toBe('in_stock');expect(rows[0].currency).toBe('USD');
    if(includeSkuOffers) expect(rows[0].offer_id).toBe('valid_sibling');
  });
  test('explicit currency filters before choosing a representative even without budget bounds',async()=>{
    const rows=await recall('sibling',scope({}));expect(rows[0].offer_id).toBe('valid_sibling');
  });
  test('inStockOnly=false retains the deliberate unfiltered availability behavior',async()=>{
    const rows=await recall('sibling',scope({inStockOnly:false}));expect(rows[0].offer_id).toBe('cheap_soldout');
  });
  test('unknown stock and legacy unmarked market are not invented or rejected',async()=>{
    const rows=await recall('unknown',scope({}));expect(rows).toHaveLength(1);
    expect(rows[0].availability).toBeNull();expect(rows[0].inventory_quantity).toBeNull();
  });
  test('FX bounds exactly reuse final policy and unsupported conversion cannot win cheaply',async()=>{
    const ranges=resolveBudgetConstraintsForRecall({currency:'EUR',max:10});
    expect(ranges.find(r=>r.currency==='USD')).toEqual(resolveBudgetConstraintForCurrency({currency:'EUR',max:10},'USD').constraint);
    const rows=await recall('fx',scope({currency:null,priceRanges:ranges}));
    expect(rows.map(r=>r.product_key)).toEqual(['fx_valid']);
  });
  test('no resolvable budget currencies returns no candidates',async()=>{
    expect(await recall('sibling',scope({priceRanges:[]}))).toEqual([]);
  });
  test.each(['stockcap','currencycap','marketcap'])('%s cannot exhaust the candidate cap before the matching product',async merchant=>{
    expect((await recall(merchant,null)).some(row=>row.product_key===`${merchant}_valid`)).toBe(false);
    expect((await recall(merchant,scope({}))).map(row=>row.product_key)).toEqual([`${merchant}_valid`]);
  });
  test('HTTP primary route passes budget and stock constraints into real SQL',async()=>{
    const priorEnv={...process.env};jest.resetModules();const calls=[];
    Object.assign(process.env,{DATABASE_URL:url,PIVOTA_API_BASE:'http://disabled-upstream.test',API_MODE:'REAL',
      SEARCH_QUALITY_CONTRACT_V1_ENABLED:'true',SEARCH_QUALITY_CONTRACT_V1_MODE:'enforce',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED:'true',INDEX_ELIGIBLE_RECALL:'false'});
    jest.doMock('../../src/db',()=>({query:async(sql,params)=>{
      if(sql.includes('FROM candidate_products c')) {calls.push({sql,params});return db.query(sql,params);}
      return {rows:[]};
    }}));
    nock.disableNetConnect();nock.enableNetConnect(host=>host.includes('127.0.0.1'));
    try {
      const app=require('../../src/server');
      const resp=await request(app).post('/agent/shop/v1/invoke').send({operation:'find_products_multi',
        payload:{search:{query:'MAC lipstick',domain:'beauty',market:'US',limit:10,price_min:14,price_max:16,currency:'USD',in_stock_only:true}},
        metadata:{source:'public_api'}});
      expect(resp.status).toBe(200);expect(resp.body.status).toBe('success');
      expect(resp.body.products).toHaveLength(2);
      expect(resp.body.products.every(p=>p.price===15 && p.currency==='USD')).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].sql.indexOf('SELECT 1 FROM catalog_offers o')).toBeLessThan(calls[0].sql.indexOf('LIMIT $3'));
      expect(calls[0].params).toEqual(expect.arrayContaining([14,16]));
    } finally {
      process.env=priorEnv;jest.dontMock('../../src/db');jest.resetModules();nock.cleanAll();nock.enableNetConnect();
    }
  });
});
