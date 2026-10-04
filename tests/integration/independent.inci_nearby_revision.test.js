const REVIEW_CAPTURE_DIR = process.env.SHOPPING_REVIEW_RECEIPT_DIR || require('path').join(require('os').tmpdir(), 'shopping-final-revision-route-receipts');
require('fs').mkdirSync(REVIEW_CAPTURE_DIR,{recursive:true});
const { once } = require('events');
const nock = require('nock');

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
  process.env.PDP_SIMILAR_FIRST_PAINT_INLINE_ENABLED = 'true';
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


const nearby=[
 ['ambiguous_coumarin',{ingredients_inci:['Water','Glycerin','Propanediol','How to Use','Coumarin']}],
 ['verified_two_item',{ingredients_inci:['Squalane','Tocopherol'],pdp_ingredients_raw:'Squalane, Tocopherol',pdp_field_quality_summary:{ingredients_raw:{source_origin:'official_html',source_quality_status:'high',review_state:'approved'}}}]
];
describe('revision nearby ingredient preservation',()=>{
 test.each(nearby)('%s',async(name,inputs)=>{
  graphErrorCode=null;productExtras={title:'Face Oil',category:'beauty/skincare',product_type:'face oil',catalog_category_path:'beauty/skincare/face-oils',...inputs};
  const {server,baseUrl}=await startServerWithRecommendationResult(empty);
  try {
   const response=await fetch(`${baseUrl}/agent/shop/v1/invoke`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'get_pdp_v2',payload:{product:{merchant_id:MERCHANT_ID,product_id:PRODUCT_ID},include:['ingredients_inci','active_ingredients']}})});
   const body=await response.json();const inci=body.modules?.find(m=>m.type==='ingredients_inci')?.data;
   fs.writeFileSync(`${REVIEW_CAPTURE_DIR}/runtime-${name}.json`,JSON.stringify({http:response.status,body},null,2));
   expect(response.status).toBe(200);
   if(name==='ambiguous_coumarin')expect(inci).toBeNull();
   if(name==='verified_two_item')expect(inci?.items).toEqual(['Squalane','Tocopherol']);
  }finally{await stopServer(server);}
 });
});
