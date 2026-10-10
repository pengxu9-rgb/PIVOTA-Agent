const REVIEW_CAPTURE_DIR = process.env.SHOPPING_REVIEW_RECEIPT_DIR || require('path').join(require('os').tmpdir(), 'shopping-revision-route-receipts');
require('fs').mkdirSync(REVIEW_CAPTURE_DIR, { recursive: true });
const { once } = require('events');
const nock = require('nock');

// These cases exercise dynamic recall beside the graph: the PDP_SIMILAR_GRAPH_ONLY_ENABLED=false kill-switch
// path. The default graph-only contract is tests/integration/invoke.pdp_similar_graph_only.test.js.
const PRIOR_PDP_SIMILAR_GRAPH_ONLY = process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED;
beforeAll(() => { process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED = 'false'; });
afterAll(() => {
  if (PRIOR_PDP_SIMILAR_GRAPH_ONLY === undefined) delete process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED;
  else process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED = PRIOR_PDP_SIMILAR_GRAPH_ONLY;
});

function hasRuntimeDeps() {
  for (const dep of ['dotenv', 'express', 'axios']) {
    try {
      require.resolve(dep);
    } catch {
      return false;
    }
  }
  return true;
}

const describeIfRuntimeDeps = hasRuntimeDeps() ? describe : describe.skip;

const API_BASE = 'http://localhost:8080';
const MERCHANT_ID = 'merch_208139f7600dbf42';
const PRODUCT_ID = 'BOTTLE_001';

const ENV_KEYS = [
  'API_MODE',
  'PIVOTA_API_BASE',
  'PIVOTA_API_KEY',
  'DATABASE_URL',
  'PGHOST',
  'AGENT_AUTH_INTROSPECT_URL',
  'AGENT_AUTH_INTROSPECT_INTERNAL_KEY', 'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED', 'PDP_SIMILAR_FIRST_PAINT_INLINE_ENABLED', 'PDP_SIMILAR_FIRST_PAINT_PREWARM_ENABLED',
];
let previousEnv = null;
let recommendCalls = [];
let graphErrorCode = null;
let graphReadCalls = 0;
let productExtras = {};


function buildBottleProduct() {
  return {
    merchant_id: MERCHANT_ID,
    product_id: PRODUCT_ID,
    id: PRODUCT_ID,
    title: 'Insulated Water Bottle',
    brand: 'Pivota Test',
    currency: 'USD',
    price: { amount: 19, currency: 'USD' },
    platform: 'shopify',
    platform_product_id: PRODUCT_ID,
    in_stock: true,
    ...productExtras,
  };
}

// The server hard-ignores API_MODE=MOCK now ("Ignoring disabled API_MODE=MOCK
// runtime mode") and always runs REAL, so this suite runs REAL mode with the
// upstream nocked. Product detail is fetched via POST /agent/shop/v1/invoke
// with operation get_product_detail (fetchProductDetailFromUpstream); all
// other upstream lookups (group resolve, reviews, legacy detail) get 404s.
// DATABASE_URL/PGHOST are cleared so the get_pdp_v2 serving-eligibility gate
// does not fail closed for this non-external-seed merchant.
async function startServerWithRecommendationResult(recommendationResult) {
  jest.resetModules();
  nock.cleanAll();
  recommendCalls = [];
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.API_MODE = 'REAL';
  process.env.PIVOTA_API_BASE = API_BASE;
  process.env.PIVOTA_API_KEY =
    'ak_live_0000000000000000000000000000000000000000000000000000000000000000';
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED = 'true';
  process.env.PDP_SIMILAR_FIRST_PAINT_INLINE_ENABLED = process.env.REVIEW_FIRST_PAINT_INLINE || 'true';
  process.env.PDP_SIMILAR_FIRST_PAINT_PREWARM_ENABLED = 'false';
  graphReadCalls = 0;
  jest.doMock('../../src/db', () => ({ ...jest.requireActual('../../src/db'), query: jest.fn(async (sql) => {
    if (/FROM product_relationship_edges/.test(sql)) { graphReadCalls++; if (graphErrorCode) throw Object.assign(new Error('private SQL details'), { code: graphErrorCode }); }
    return { rows: [] };
  }) }));
  delete process.env.AGENT_AUTH_INTROSPECT_URL;
  delete process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY;

  nock(API_BASE)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => {
      const ref = body?.payload?.product || {};
      return (
        body?.operation === 'get_product_detail' &&
        ref.merchant_id === MERCHANT_ID &&
        ref.product_id === PRODUCT_ID
      );
    })
    .reply(200, { status: 'success', product: buildBottleProduct() });
  nock(API_BASE).persist().get(/.*/).reply(404, { error: 'NOT_FOUND' });
  nock(API_BASE).persist().post(/.*/).reply(404, { error: 'NOT_FOUND' });

  const actualRecommendationEngine = jest.requireActual('../../src/services/RecommendationEngine');
  jest.doMock('../../src/services/RecommendationEngine', () => ({
    recommend: jest.fn(async (args) => {
      recommendCalls.push(args);
      return recommendationResult;
    }),
    getCacheStats: jest.fn(() => ({
      enabled: true,
      ttl_ms: 600000,
      max_entries: 2000,
      size: 0,
      hits: 0,
      misses: 0,
      sets: 0,
      bypasses: 0,
      evictions: 0,
    })),
    hydrateRecommendationItemsWithReviewedProductIntel:
      actualRecommendationEngine.hydrateRecommendationItemsWithReviewedProductIntel,
    _internals: actualRecommendationEngine._internals,
  }));
  const app = require('../../src/server');
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  nock.cleanAll();
  if (previousEnv) {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv = null;
  }
  jest.resetModules();
  jest.dontMock('../../src/services/RecommendationEngine');
  jest.dontMock('../../src/db');
}


const fs = require('fs');
const captures = [];
const empty = { strategy: 'related_products', status: 'success', items: [], metadata: { similar_status: 'empty', empty_reason: 'no_same_brand_candidates' } };
async function invoke(baseUrl, operation) {
 const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, { method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({operation, payload: operation === 'get_pdp_v2' ? {product: {merchant_id: MERCHANT_ID, product_id: PRODUCT_ID}, include: ['similar'], similar_request_mode: 'background'} : {similar: {merchant_id: MERCHANT_ID, product_id: PRODUCT_ID, limit: 6}}}) });
 return {status: response.status, body: await response.json()};
}
describe('independent actual route graph read states', () => {
 test.each([[null,'empty','no_eligible_edges'], ['NO_DATABASE','unavailable','no_database'], ['42P01','unavailable','schema_unavailable'], ['ETIMEDOUT','unavailable','read_failed']])('propagates actual graph %s through both endpoints', async (code,status,reason) => {
  graphErrorCode = code; productExtras = {};
  const {server,baseUrl} = await startServerWithRecommendationResult(empty);
  try {
   for (const operation of ['get_pdp_v2','find_similar_products']) {
    const r = await invoke(baseUrl,operation);
    const data = operation === 'get_pdp_v2' ? r.body.modules?.find(m=>m.type==='similar')?.data : r.body;
    captures.push({code,operation,http:r.status,graphReadCalls,metadata:data?.metadata,similarStatus:data?.status,missing:r.body.missing});
    expect(r.status).toBe(200); expect(graphReadCalls).toBeGreaterThan(0);
    expect(data?.metadata).toMatchObject({ relationship_graph_read_status: status, relationship_graph_read_reason:reason, relationship_graph_edge_count:0, relationship_graph_edge_count_semantics:'returned_eligible_edges' });
    expect(JSON.stringify(r.body)).not.toContain('private SQL details');
   }
  } finally { await stopServer(server); }
 });
 afterAll(()=>fs.writeFileSync(REVIEW_CAPTURE_DIR + '/runtime-captures.json', JSON.stringify(captures,null,2)));
});
describe('independent accessory-path graph diagnostics', () => {
 test.each([[null,'empty'],['NO_DATABASE','unavailable'],['42P01','unavailable']])('retains actual graph %s diagnostic when accessory recall is skipped', async (code,status) => {
  graphErrorCode = code; productExtras = {title:'Travel Cosmetic Case', product_family:'accessory', platform_product_id:'ext_fixture_accessory'};
  const {server,baseUrl} = await startServerWithRecommendationResult(empty);
  try {
   const r = await invoke(baseUrl,'get_pdp_v2');
   const similar = r.body.modules?.find(m=>m.type==='similar');
   const metadata = similar?.data?.metadata || r.body.metadata;
   fs.writeFileSync(`${REVIEW_CAPTURE_DIR}/accessory-${code||'empty'}.json`, JSON.stringify({http:r.status,graphReadCalls,body:r.body},null,2));
   expect(r.status).toBe(200); expect(graphReadCalls).toBeGreaterThan(0);
   expect(metadata.relationship_graph_read_status).toBe(status);
  } finally {await stopServer(server);}
 });
});

describe('independent deferred settlement',()=>{
 test('first paint defers without invented graph empty, background settles unavailable',async()=>{
  process.env.REVIEW_FIRST_PAINT_INLINE='false'; graphErrorCode='42P01'; productExtras={};
  const {server,baseUrl}=await startServerWithRecommendationResult(empty);
  try {
   const response=await fetch(`${baseUrl}/agent/shop/v1/invoke`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'get_pdp_v2',payload:{product:{merchant_id:MERCHANT_ID,product_id:PRODUCT_ID},include:['similar'],options:{similar_mode:'first_paint'}}})});
   const body=await response.json(); const d=body.modules.find(m=>m.type==='similar').data;
   expect(response.status).toBe(200); expect(d.status).toBe('deferred'); expect(graphReadCalls).toBe(0); expect(d.metadata?.relationship_graph_read_status).not.toBe('empty');
   const bg=await invoke(baseUrl,'get_pdp_v2'); const settled=bg.body.modules.find(m=>m.type==='similar').data;
   expect(bg.status).toBe(200); expect(settled.status).not.toBe('deferred'); expect(settled.metadata.relationship_graph_read_status).toBe('unavailable');
   fs.writeFileSync(REVIEW_CAPTURE_DIR + '/deferred-settlement.json',JSON.stringify({first:body,background:bg.body},null,2));
  }finally{await stopServer(server); delete process.env.REVIEW_FIRST_PAINT_INLINE;}
 });
});
