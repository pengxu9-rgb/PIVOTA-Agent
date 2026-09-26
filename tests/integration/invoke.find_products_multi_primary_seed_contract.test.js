const nock=require('nock');
const request=require('supertest');
describe('primary seed query errors and pagination do not switch recall routes',()=>{
  let previous,calls,failSeed,fallbackCalls,app;
  beforeEach(()=>{
    previous={...process.env};jest.resetModules();calls=[];failSeed=false;fallbackCalls=[];
    Object.assign(process.env,{DATABASE_URL:'postgres://fixture',PIVOTA_API_BASE:'http://primary.test',API_MODE:'REAL',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED:'true',INDEX_ELIGIBLE_RECALL:'true',
      PIVOT_BEAUTY_LEGACY_TOOL_SCOPE_RECALL_ENABLED:'false',PIVOT_BEAUTY_PARALLEL_SCOPE_RECALL_ENABLED:'true',
      STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED:'false',FIND_PRODUCTS_MULTI_EXPANSION_MODE:'off',
      FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE:'off'});
    jest.doMock('../../src/db',()=>({query:jest.fn(async(sql,params)=>{
      const text=String(sql);calls.push({sql:text,params});
      if(failSeed && text.includes('FROM external_product_seeds') && !text.includes('FROM candidate_products c')) {
        throw Object.assign(new Error('primary seed timeout'),{code:'57014'});
      }
      return {rows:[]};
    })}));
    nock.disableNetConnect();nock.enableNetConnect(host=>host.includes('127.0.0.1'));
    for(const method of ['get','post']) nock('http://primary.test').persist()[method](/\/(?:products\/search|invoke)$/).query(true).reply(uri=>{
      fallbackCalls.push(uri);return [200,{status:'success',products:[{product_id:'forbidden_rescue',title:'MAC Matte Lipstick',price:20,currency:'USD'}],total:1}];
    });
    app=require('../../src/server');
  });
  afterEach(()=>{
    const unexpected=[...fallbackCalls];process.env=previous;jest.dontMock('../../src/db');jest.resetModules();
    nock.cleanAll();nock.enableNetConnect();expect(unexpected).toEqual([]);
  });
  const invoke=(search={},source='shopping_agent')=>request(app).post('/agent/shop/v1/invoke').send({operation:'find_products_multi',
    payload:{search:{query:'MAC lipstick',domain:'beauty',market:'US',limit:10,...search}},metadata:{source}});
  const seedCalls=()=>calls.filter(call=>call.sql.includes('FROM external_product_seeds')&&!call.sql.includes('FROM candidate_products c'));
  test.each(['public_api','shopping_agent'])('seed primary failure remains HTTP503 after an empty canonical query for %s',async source=>{
    failSeed=true;const resp=await invoke({},source);
    expect(resp.status).toBe(503);expect(resp.body).toMatchObject({status:'failed',success:false,products:[],
      error:{code:'BEAUTY_PRIMARY_RECALL_FAILED'}});
    expect(seedCalls().length).toBeGreaterThan(0);
  });
  test('creator underfill cannot widen to shopping-agent tool scope',async()=>{
    const resp=await invoke({},'creator_agent');expect(resp.status).toBe(200);expect(resp.body.products).toEqual([]);
    const tools=seedCalls().map(call=>call.params[1]);
    expect(tools.sort()).toEqual(['*','creator_agents']);
  });
  test.each([{page:21,limit:10},{offset:200,limit:1},{page:1,limit:10,offset:195},
    {query:'MAC Cosmetics',domain:null,page:21,limit:10}])('unsupported recall window fails explicitly: %j',async search=>{
    const resp=await invoke(search);
    expect(resp.status).toBe(400);expect(resp.body).toMatchObject({status:'failed',success:false,products:[],
      error:{code:'PRIMARY_SEARCH_WINDOW_EXCEEDED'},metadata:{failure_class:'primary_search_window_exceeded'}});
    expect(calls).toEqual([]);
  });
  test('last supported window scales seed SQL depth to 200',async()=>{
    const resp=await invoke({page:20,limit:10});expect(resp.status).toBe(200);
    expect(seedCalls().length).toBeGreaterThan(0);
    expect(seedCalls().every(call=>{
      // Scope predicates append binds after the limit; assert the value used
      // by the SQL LIMIT itself, not an incidental parameter position.
      const limits=[...call.sql.matchAll(/LIMIT \$(\d+)/g)];
      return limits.length>0 && limits.every(match=>call.params[Number(match[1])-1]>=200);
    })).toBe(true);
  });
});
