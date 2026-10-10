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
  'AGENT_AUTH_INTROSPECT_INTERNAL_KEY',
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
}

describeIfRuntimeDeps('/agent/shop/v1/invoke PDP similar contracts', () => {
  test('healthy empty similar remains ready instead of unavailable', async () => {
    const { server, baseUrl } = await startServerWithRecommendationResult({
      strategy: 'related_products',
      status: 'success',
      items: [],
      metadata: {
        similar_status: 'empty',
        similar_sources: {
          internal: { attempted: true, timed_out: false, returned: 0, skipped: false },
          external: { attempted: true, timed_out: false, returned: 0, skipped: false },
        },
        empty_reason: 'no_same_brand_candidates',
      },
    });

    try {
      const pdpResponse = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'get_pdp_v2',
          payload: {
            product: {
              merchant_id: MERCHANT_ID,
              product_id: PRODUCT_ID,
            },
            include: ['similar'],
          },
        }),
      });
      const pdpBody = await pdpResponse.json();
      const similarModule = Array.isArray(pdpBody.modules)
        ? pdpBody.modules.find((module) => module?.type === 'similar')
        : null;

      expect(pdpResponse.status).toBe(200);
      expect(similarModule).toBeTruthy();
      expect(similarModule.reason).toBeUndefined();
      expect(similarModule.data).toEqual(
        expect.objectContaining({
          status: 'empty',
          items: [],
        }),
      );
      expect(pdpBody.metadata.similar_status).toBe('empty');

      const similarResponse = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'find_similar_products',
          payload: {
            similar: {
              merchant_id: MERCHANT_ID,
              product_id: PRODUCT_ID,
              limit: 6,
            },
          },
        }),
      });
      const similarBody = await similarResponse.json();
      expect(similarResponse.status).toBe(200);
      expect(similarBody.products).toEqual([]);
      expect(similarBody.metadata).toEqual(
        expect.objectContaining({
          similar_status: 'empty',
          empty_reason: 'no_same_brand_candidates',
        }),
      );
    } finally {
      await stopServer(server);
    }
  });

  test('hard failure still surfaces as unavailable', async () => {
    const { server, baseUrl } = await startServerWithRecommendationResult({
      strategy: 'related_products',
      status: 'unavailable',
      items: [],
      metadata: {
        similar_status: 'unavailable',
        similar_sources: {
          internal: {
            attempted: true,
            timed_out: true,
            returned: 0,
            skipped: false,
            error_code: 'timeout',
          },
          external: {
            attempted: true,
            timed_out: true,
            returned: 0,
            skipped: false,
            error_code: 'timeout',
          },
        },
        empty_reason: 'all_sources_failed',
      },
    });

    try {
      const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'get_pdp_v2',
          payload: {
            product: {
              merchant_id: MERCHANT_ID,
              product_id: PRODUCT_ID,
            },
            include: ['similar'],
          },
        }),
      });
      const body = await response.json();
      const similarModule = Array.isArray(body.modules)
        ? body.modules.find((module) => module?.type === 'similar')
        : null;

      expect(response.status).toBe(200);
      expect(similarModule).toBeTruthy();
      expect(similarModule.data).toBeNull();
      expect(similarModule.reason).toBe('unavailable');
      expect(body.metadata.similar_status).toBe('unavailable');
    } finally {
      await stopServer(server);
    }
  });
  // Peng 2026-09-26: a similar product priced in another currency than the buyer's never reaches the
  // agent frontend. Measured on prod 2026-09-27: 39 serving-eligible similar candidates are priced
  // in JPY, and a US (market-less) PDP could show them.
  test('similar products are served only in the buyer currency, on both surfaces', async () => {
    const card = (id, extra) => ({
      product_id: id,
      merchant_id: 'merch_similar_test',
      title: `Similar ${id}`,
      image_url: `https://cdn.example.test/${id}.jpg`,
      description: 'A verified similar product highlight for PDP card presentation.',
      card_highlight_status: 'ready',
      card_highlight: 'Same routine fit with a stronger finish.',
      ...extra,
    });
    const { server, baseUrl } = await startServerWithRecommendationResult({
      strategy: 'related_products',
      status: 'success',
      items: [
        card('sim_usd', { price: 21, currency: 'USD' }),
        card('sim_jpy', { price: 2400, currency: 'JPY' }),
        card('sim_sgd', { price: { amount: 30, currency: 'SGD' }, currency: 'USD' }),
      ],
      metadata: { similar_status: 'ready' },
    });
    const invoke = async (body) => {
      const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const pdpSimilarIds = (body) => {
      const module = (body.modules || []).find((m) => m?.type === 'similar');
      return (module?.data?.items || []).map((item) => item.product_id);
    };
    const pdp = (market) => invoke({
      operation: 'get_pdp_v2',
      payload: {
        product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID },
        include: ['similar'],
        ...(market ? { market } : {}),
      },
    });

    try {
      const silent = await pdp(null);
      expect(silent.status).toBe(200);
      expect(pdpSimilarIds(silent.body)).toEqual(['sim_usd']);
      const jp = await pdp('JP');
      expect(pdpSimilarIds(jp.body)).toEqual(['sim_jpy']);
      expect(recommendCalls.map((args) => args.serving_currency)).toEqual(['USD', 'JPY']);

      const similar = await invoke({
        operation: 'find_similar_products',
        payload: { similar: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID, limit: 6 } },
      });
      expect(similar.status).toBe(200);
      expect(similar.body.products.map((p) => p.product_id)).toEqual(['sim_usd']);
      expect(recommendCalls[recommendCalls.length - 1].serving_currency).toBe('USD');
    } finally {
      await stopServer(server);
    }
  });
});
