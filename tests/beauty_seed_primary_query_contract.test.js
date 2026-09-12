// One primary seed query shape per tool scope; underfill cannot change route or market.
const source = require.resolve('../src/server');
describe.each(['true','false'])('beauty seed primary SQL contract, parallel=%s',parallel=>{
  let previous, calls, debug, fail;
  beforeEach(()=>{
    previous={...process.env};jest.resetModules();calls=[];fail=false;
    Object.assign(process.env,{DATABASE_URL:'postgres://fixture',PIVOT_BEAUTY_PARALLEL_SCOPE_RECALL_ENABLED:parallel,
      PIVOT_BEAUTY_LEGACY_TOOL_SCOPE_RECALL_ENABLED:'false'});
    jest.doMock('../src/db',()=>({query:jest.fn(async(sql,params)=>{
      calls.push({sql:String(sql),params});if(fail) throw Object.assign(new Error('primary seed SQL unavailable'),{code:'57014'});
      return {rows:[]};
    })}));
    jest.doMock('../src/auroraBff/routes',()=>({mountAuroraBffRoutes:()=>{},__internal:{}}));
    debug=require(source)._debug;
  });
  afterEach(()=>{process.env=previous;jest.dontMock('../src/db');jest.resetModules();});
  async function run(queryText,options={}) {
    return debug.queryBeautyExternalSeedRowsFast({market:'US',markets:['US'],queryText,
      intent:debug.inferBeautyMainlineIntent(queryText),inStockOnly:true,limit:10,toolScope:'all_tools',...options});
  }
  const expectOneQueryPerTool=()=>{
    expect(calls).toHaveLength(3);
    expect(calls.map(call=>call.params[1]).sort()).toEqual(['*','creator_agents','shopping_agents']);
  };
  test('empty category primary does not retry with text recall',async()=>{
    const result=await run('gentle cleanser');
    expectOneQueryPerTool();expect(result.rawProducts).toEqual([]);
    expect(calls.every(call=>call.params.includes('cleanser'))).toBe(true);
    expect(calls.every(call=>!call.sql.includes("lower(coalesce(title, '')) LIKE"))).toBe(true);
  });
  test('brand-category intent selects text SQL upfront, not after an empty category query',async()=>{
    await run('MAC lipstick');expectOneQueryPerTool();
    expect(calls.every(call=>call.sql.includes("lower(coalesce(title, '')) LIKE"))).toBe(true);
    for (const call of calls) {
      // Maker identity uses exact normalized aliases. A title substring no
      // longer establishes the requested brand or consumes a brand bind.
      const brandIndex = call.params.findIndex(value => Array.isArray(value) && value.includes('mac'));
      expect(brandIndex).toBeGreaterThanOrEqual(0);
      expect(call.params[brandIndex]).toEqual(expect.arrayContaining(['mac', 'maccosmetics']));
      const brandPredicate = `= ANY($${brandIndex + 1}::text[])`;
      const predicatePosition = call.sql.indexOf(brandPredicate);
      const limit = [...call.sql.matchAll(/\bLIMIT \$(\d+)/g)].pop();
      expect(predicatePosition).toBeGreaterThanOrEqual(0);
      expect(limit).toBeDefined();
      expect(predicatePosition).toBeLessThan(limit.index);
      expect(call.params[Number(limit[1]) - 1]).toBeGreaterThanOrEqual(10);
      expect(call.params).toContain('%lipstick%');
    }
  });
  test('brand-only query selects text upfront rather than unrelated default category cohorts',async()=>{
    await run('MAC Cosmetics');expectOneQueryPerTool();
    expect(calls.every(call=>call.sql.includes("lower(coalesce(title, '')) LIKE"))).toBe(true);
  });
  test('KR underfill never expands into the US market',async()=>{
    await run('korean skincare in Seoul',{market:'KR',markets:['KR']});
    expectOneQueryPerTool();
    expect(calls.every(call=>JSON.stringify(call.params[0]).includes('KR'))).toBe(true);
    expect(calls.some(call=>JSON.stringify(call.params[0]).includes('US'))).toBe(false);
  });
  test('primary SQL timeout rejects rather than silently returning empty candidates',async()=>{
    fail=true;await expect(run('MAC lipstick')).rejects.toMatchObject({code:'57014'});
    expect(calls.length).toBeGreaterThan(0);
  });
  test('deep page recall depth reaches each SQL scope before LIMIT',async()=>{
    await run('gentle cleanser',{limit:80});expectOneQueryPerTool();
    for (const call of calls) {
      const limit = [...call.sql.matchAll(/\bLIMIT \$(\d+)/g)].pop();
      expect(limit).toBeDefined();
      expect(call.params[Number(limit[1]) - 1]).toBeGreaterThanOrEqual(80);
    }
  });
});
