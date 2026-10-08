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
  'AGENT_AUTH_INTROSPECT_INTERNAL_KEY',
  'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED',
];
let previousEnv = null;
let recommendCalls = [];

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
  };
}

// The server hard-ignores API_MODE=MOCK now ("Ignoring disabled API_MODE=MOCK
// runtime mode") and always runs REAL, so this suite runs REAL mode with the
// upstream nocked. Product detail is fetched via POST /agent/shop/v1/invoke
// with operation get_product_detail (fetchProductDetailFromUpstream); all
// other upstream lookups (group resolve, reviews, legacy detail) get 404s.
// DATABASE_URL/PGHOST are cleared so the get_pdp_v2 serving-eligibility gate
// does not fail closed for this non-external-seed merchant.
// Dynamic recall failing while the relationship graph returns only cards the public filter removes
// is an outage, not "no similar products": find_similar_products answers 503, and get_pdp_v2 must
// report the similar module unavailable instead of rendering an empty one.
async function startServer() {
  jest.resetModules();
  nock.cleanAll();
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.API_MODE = 'REAL';
  process.env.PIVOTA_API_BASE = API_BASE;
  process.env.PIVOTA_API_KEY =
    'ak_live_0000000000000000000000000000000000000000000000000000000000000000';
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED = 'true';
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  delete process.env.AGENT_AUTH_INTROSPECT_URL;
  delete process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY;

  nock(API_BASE)
    .persist()
    .post('/agent/shop/v1/invoke', (body) => body?.operation === 'get_product_detail')
    .reply(200, { status: 'success', product: buildBottleProduct() });
  nock(API_BASE).persist().get(/.*/).reply(404, { error: 'NOT_FOUND' });
  nock(API_BASE).persist().post(/.*/).reply(404, { error: 'NOT_FOUND' });

  const actualRecommendationEngine = jest.requireActual('../../src/services/RecommendationEngine');
  jest.doMock('../../src/services/RecommendationEngine', () => ({
    ...actualRecommendationEngine,
    recommend: jest.fn(async () => {
      throw new Error('dynamic recall exploded');
    }),
  }));
  const actualRecall = jest.requireActual('../../src/services/relationshipGraphRecall');
  jest.doMock('../../src/services/relationshipGraphRecall', () => ({
    ...actualRecall,
    // One graph card whose external-seed id resolves to no public signature (no catalog DB here),
    // so the public filter removes it.
    fetchRelationshipGraphRecallForAnchor: jest.fn(async () => ({
      edges: [],
      items: [{
        product_id: 'ext_unresolvable_candidate',
        external_product_id: 'ext_unresolvable_candidate',
        title: 'Steel Bottle',
        image_url: 'https://cdn.example.test/b.jpg',
        source: 'relationship_graph',
        recommendation_source: 'relationship_graph',
        relationship_edge_id: 'prel_outage',
        relationship_type: 'competitive_alternative',
      }],
      metadata: { enabled: true, edge_count: 1, item_count: 1, read_status: 'ready', read_reason: null },
    })),
  }));
  const app = require('../../src/server');
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  nock.cleanAll();
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv = null;
  jest.resetModules();
  jest.dontMock('../../src/services/RecommendationEngine');
  jest.dontMock('../../src/services/relationshipGraphRecall');
}

describeIfRuntimeDeps('similar during a dynamic-recall outage', () => {
  test('get_pdp_v2 reports similar unavailable and find_similar_products answers 503', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const post = (payload) => fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const pdpResponse = await post({
        operation: 'get_pdp_v2',
        payload: { product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID }, include: ['similar'] },
      });
      const pdpBody = await pdpResponse.json();
      expect(pdpResponse.status).toBe(200);
      const similarModule = pdpBody.modules.find((module) => module?.type === 'similar');
      expect(similarModule).toBeTruthy();
      expect(similarModule.data).toBeNull();
      expect(similarModule.reason).toBe('unavailable');
      expect(pdpBody.missing).toEqual(expect.arrayContaining([{ type: 'similar', reason: 'unavailable' }]));

      const similarResponse = await post({
        operation: 'find_similar_products',
        payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 6, options: { cache_bypass: true } },
      });
      expect(similarResponse.status).toBe(503);
    } finally {
      await stopServer(server);
    }
  });
});
