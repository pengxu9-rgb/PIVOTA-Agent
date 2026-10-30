/**
 * A strength or a size in the query is never a price cap -- through the real invoke route.
 *
 * Found on a fixture catalog: "1.0% retinol serum", "2.0% salicylic acid", "10.0% niacinamide" and
 * "15.0% vitamin c" routed to the ingredient lane and returned 0 rows, because the budget parser read
 * the strength as a max price ("1.0" -> a $1 cap) and the lane's budget filter then dropped every row.
 * With SEARCH_BUDGET_REQUIRE_MARKER=1 the plain "N%" form was already safe, but a bound word in front
 * of a full-width "％" ("niacinamide serum max 10％") or a range of strengths still became a cap.
 *
 * Every row in the fixture costs $18, so a phantom cap below 18 empties the response.
 *
 * Network: the DB is mocked, the upstream base is a `.invalid` host, nock refuses everything but the
 * supertest loopback, and the suite is meant to run with the loopback net guard preloaded
 * (NODE_OPTIONS=--require tests/agent_readiness_eval/_net_guard.cjs).
 */

const nock = require('nock');
const request = require('supertest');

const FLAG = 'SEARCH_BUDGET_REQUIRE_MARKER';

function serumRow(id, title, ingredient) {
  return {
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::${id}`,
    platform: 'external_seed',
    source_product_id: id,
    pivota_signature_id: `sig_${id}`,
    pivota_canonical_url: `https://catalog.invalid/products/sig_${id}`,
    product_title: title,
    product_description: `Daily serum formulated with ${ingredient}.`,
    brand: 'Fixture Beauty',
    product_type: 'Serum',
    category: 'Serum',
    category_path: 'beauty/skincare/treat/serum',
    canonical_url: `https://brand.invalid/products/${id}`,
    product_image_url: `https://cdn.invalid/${id}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    // The canonical builder prices a row from its offer columns only.
    currency: 'USD',
    merchant_effective_price: '18.00',
    product_payload: {
      seed_data: {
        price_amount: '18.00',
        price_currency: 'USD',
        availability: 'in stock',
        active_ingredients: [ingredient],
      },
    },
    rank_score: 300,
  };
}

const FIXTURE_ROWS = [
  serumRow('ext_retinol_serum', 'Retinol 1% Renewal Serum', 'retinol'),
  serumRow('ext_bha_serum', 'Salicylic Acid 2% Clarifying Serum', 'salicylic acid'),
  serumRow('ext_niacinamide_serum', 'Niacinamide 10% Brightening Serum', 'niacinamide'),
  serumRow('ext_vitc_serum', 'Vitamin C 15% Glow Serum', 'vitamin c'),
];

async function invoke(query) {
  jest.doMock('../../src/db', () => ({
    query: async (sql) => {
      const text = String(sql || '');
      if (text.includes('FROM catalog_products p')) return { rows: FIXTURE_ROWS };
      return { rows: [] };
    },
  }));
  const app = require('../../src/server');
  const resp = await request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'find_products_multi',
      payload: { search: { query, page: 1, limit: 20, market: 'US' } },
      metadata: { source: 'shopping_agent', market: 'US' },
    });
  expect(resp.status).toBe(200);
  return resp.body;
}

// Strength / size queries: no price cap, so the $18 rows are served.
const STRENGTH_QUERIES = [
  '1.0% retinol serum',
  '2.0% salicylic acid',
  '10.0% niacinamide',
  '15.0% vitamin c serum',
  '1 % retinol serum',
  '10％ niacinamide serum',
  'niacinamide serum max 10％',
  'salicylic acid serum under 2％',
  'vitamin c serum 10-15%',
  'between 5 and 10% niacinamide serum',
  'between 5 and 10％ niacinamide serum',
  'niacinamide serum around 10％',
];

describe.each([
  ['SEARCH_BUDGET_REQUIRE_MARKER=1', '1'],
  ['SEARCH_BUDGET_REQUIRE_MARKER unset', undefined],
])('%s', (_label, flagValue) => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').startsWith('127.0.0.1'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = 'http://upstream.invalid';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://fixture.invalid/catalog';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    delete process.env.INDEX_ELIGIBLE_RECALL;
    if (flagValue === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flagValue;
  });

  afterEach(() => {
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  test.each(STRENGTH_QUERIES)('"%s" is not capped and serves the fixture rows', async (query) => {
    const body = await invoke(query);
    expect(body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(body.metadata?.ingredient_direct_budget_filtered_out_count).toBe(0);
    expect(body.metadata?.ingredient_direct_budget_filter_applied).toBe(false);
    expect(Array.isArray(body.products) && body.products.length).toBeGreaterThan(0);
  });

  test.each([
    ['1% retinol serum under $20', 20],
    ['under $30 1% retinol serum', 30],
  ])('a marked budget next to a strength still applies: "%s"', async (query) => {
    const body = await invoke(query);
    expect(body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(body.metadata?.ingredient_direct_budget_filtered_out_count).toBe(0);
    expect(body.products.length).toBeGreaterThan(0);
  });

  test('a marked budget below the fixture price still filters every row', async () => {
    const body = await invoke('1% retinol serum under $15');
    expect(body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(body.metadata?.ingredient_direct_budget_filtered_out_count).toBeGreaterThan(0);
    expect(body.products).toHaveLength(0);
  });
});
