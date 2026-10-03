const axios = require('axios');
const { getDiscoveryFeed, buildDiscoveryProfile, _internals } = require('../../src/services/discoveryFeed');
const { buildRecentView, deriveRecentQuery } = require('../../scripts/run_discovery_feed_smoke.cjs');

let originalEnv;
beforeEach(() => { originalEnv = { ...process.env };
  delete process.env.DATABASE_URL; delete process.env.DISCOVERY_RECALL_BUDGET_MS;
  delete process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS;
  process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'https://diagnostic-primary.invalid';
  process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'synthetic-local-only';
});
afterEach(() => { jest.restoreAllMocks(); _internals.resetProductsSearchBreaker(); process.env = originalEnv; });

test('brand-only home coalesces identical primary calls under unchanged1650ms budget', async () => {
  delete process.env.DATABASE_URL;
  delete process.env.DISCOVERY_RECALL_BUDGET_MS;
  delete process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS;
  process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'https://diagnostic-primary.invalid';
  process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'synthetic-local-only';
  const seed = { merchant_id: 'external_seed', product_id: 'synthetic-diagnostic', title: 'Iconic Starter Ritual', brand: 'Jurlique' };
  const context = { auth_state: 'authenticated', locale: 'en-US', recent_views: [buildRecentView(seed)], recent_queries: [deriveRecentQuery(seed)] };
  const profile = buildDiscoveryProfile(context);
  expect(profile.dominantDomain).toBeNull();
  expect(profile.hasInterestSignals).toBe(true);
  expect(_internals.computeDiscoveryStepTimeoutMs(1800, 6500)).toBe(1650);
  const spy = jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { products: [] } });
  await getDiscoveryFeed({ surface: 'home_hot_deals', page: 1, limit: 6, context }).catch(() => {});
  expect(spy).toHaveBeenCalledTimes(1);
  const calls = spy.mock.calls.map(([url, config]) => ({ url, params: config.params, timeout: config.timeout }));
  expect(calls[0]).toEqual({ url: 'https://diagnostic-primary.invalid/agent/v1/products/search', params: { query: 'Jurlique', in_stock_only: false, limit: 24, offset: 0 }, timeout: 1650 });
});

function directRequest(extra={}) {
  return _internals.normalizeDiscoveryRequest({surface:'home_hot_deals',limit:6,context:{auth_state:'authenticated',locale:'en-US',recent_views:[{merchant_id:'external_seed',product_id:'local-diagnostic',title:'Iconic Starter Ritual',brand:'Jurlique'}],recent_queries:['Jurlique']},...extra});
}
async function direct(request=directRequest(),limit=48) {
 return _internals.loadProductsSearchCandidates({request,profile:buildDiscoveryProfile(request.context),limit});
}
test('one failed physical transport preserves timeout truth and counts the breaker once',async()=>{
 const spy=jest.spyOn(axios,'get').mockRejectedValue(Object.assign(Error('synthetic timeout'),{code:'ECONNABORTED'}));
 const result=await direct();expect(spy).toHaveBeenCalledTimes(1);
 expect(result.recallSummary).toHaveLength(2);
 expect(result.recallSummary[0]).toMatchObject({failure_reason:'timeout',returned:0});
 expect(result.recallSummary[1]).toMatchObject({skipped:true,skip_reason:'identical_primary_request_coalesced',latency_ms:0,returned:0,status:null});
 expect(_internals.getProductsSearchBreakerState().consecutive_failures).toBe(1);
});
test('different requested offsets and limits are separate real calls',async()=>{
 const spy=jest.spyOn(axios,'get').mockResolvedValue({status:200,data:{products:[]}});
 await direct(directRequest({scope:{brand_names:['Jurlique']}}),120); expect(spy).toHaveBeenCalledTimes(2);
 expect(spy.mock.calls[0][1].params.offset).not.toBe(spy.mock.calls[1][1].params.offset);
});
test('coalescing is per request and never shares across credentials or context',async()=>{
 const spy=jest.spyOn(axios,'get').mockResolvedValue({status:200,data:{products:[]}});
 await direct();process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY='synthetic-second-owner';
 const req=directRequest();req.context.auth_state='anonymous';req.context.locale='en-SG'; await direct(req);
 expect(spy).toHaveBeenCalledTimes(2);
 expect(spy.mock.calls[0][1].headers.Authorization).not.toBe(spy.mock.calls[1][1].headers.Authorization);
});
