// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const nock = require('nock');
const request = require('supertest');

// The retinoid safety net on the other invoke operations that serve beauty products from a query or a
// request context: find_products (the single-merchant search, answered by the upstream) and
// get_discovery_feed. Neither reaches the beauty gate, so the net is their only retinoid rule. With a
// signal (query, profile, turn or flag) no retinoid product is served; without one, the answer is
// the upstream's / the feed's, untouched.

const UPSTREAM = 'http://pivota-upstream.invalid';
const RETINOID_ID = 'more_ops_retinoid_row';
const PLAIN_ID = 'more_ops_plain_row';
const ROWS = [
  { id: RETINOID_ID, product_id: RETINOID_ID, merchant_id: 'merch_more_ops_fixture', title: 'Retinol Night Serum', description: 'Night serum with retinol.', product_type: 'Serum', status: 'published', inventory_quantity: 5, price: 30, currency: 'USD', image_url: 'https://fixture-cdn.invalid/m1.jpg' },
  { id: PLAIN_ID, product_id: PLAIN_ID, merchant_id: 'merch_more_ops_fixture', title: 'Hyaluronic Hydrating Serum', description: 'Hydrating serum.', product_type: 'Serum', status: 'published', inventory_quantity: 5, price: 20, currency: 'USD', image_url: 'https://fixture-cdn.invalid/m2.jpg' },
];
const ENV_KEYS = ['PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED', 'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED', 'BEAUTY_RETINOID_SOFT_SAFETY_TIER'];

jest.setTimeout(180000);

const SIGNALS = [
  { name: 'child word in the query', query: 'serum 👶' },
  { name: 'pregnancy profile', query: 'serum', payload: { user_profile: { pregnancy_status: 'pregnant' } } },
  { name: 'earlier user turn', query: 'serum', payload: { messages: [{ role: 'user', content: 'I am breastfeeding' }] } },
  { name: 'safety flag', query: 'serum', metadata: { source: 'search', safety_flags: ['pregnancy'] } },
];

describe('retinoid safety net: find_products and get_discovery_feed', () => {
  let app;
  let prevEnv;

  beforeAll(() => {
    jest.resetModules();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => /^(127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(String(host || '')));
    prevEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      PIVOTA_API_BASE: UPSTREAM, PIVOTA_API_KEY: 'test_key', API_MODE: 'REAL', DATABASE_URL: 'postgres://fixture-db.invalid/test',
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', GATEWAY_RATE_LIMIT_ENABLED: 'false',
    });
    delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
    nock(UPSTREAM).persist().get(/.*/).reply(200, () => ({ status: 'success', success: true, products: ROWS.map((r) => ({ ...r })), total: 2 }));
    nock(UPSTREAM).persist().post(/.*/).reply(200, () => ({ status: 'success', success: true, products: ROWS.map((r) => ({ ...r })), total: 2 }));
    jest.doMock('../../src/db', () => ({ query: async (sql) => (String(sql).includes('COUNT(*)::int AS total') ? { rows: [{ total: 0 }] } : { rows: [] }) }));
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return { ...actual, getDiscoveryFeed: jest.fn(async () => ({ products: ROWS.map((r) => ({ ...r })), total: 2, metadata: {} })) };
    });
    app = require('../../src/server');
  });

  afterAll(() => {
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/services/discoveryFeed');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  const post = async (operation, query, { payload = {}, metadata = { source: 'search' } } = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(app).post('/agent/shop/v1/invoke').send({
          operation,
          payload: { ...payload, search: { query, page: 1, limit: 10 }, query },
          metadata,
        });
      } catch (err) {
        const reset = err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /socket hang up|ETIMEDOUT/.test(String(err.message)));
        if (!reset || attempt >= 2) throw err;
      }
    }
  };
  const ids = (resp) => (resp.body.products || []).map((p) => p.product_id);

  for (const operation of ['find_products', 'get_discovery_feed']) {
    test(`${operation}: without a signal, both rows are served and the body carries no net marker`, async () => {
      for (const query of ['serum', 'retinol serum', 'retinol cream for my 30s']) {
        const resp = await post(operation, query);
        expect(resp.status).toBe(200);
        expect([query, ids(resp)]).toEqual([query, [RETINOID_ID, PLAIN_ID]]);
        expect(resp.body.metadata?.retinoid_safety_net).toBeUndefined();
      }
    });

    test.each(SIGNALS)(`${operation}: with a signal ($name), no retinoid row; the plain row is still served`, async ({ query, payload, metadata }) => {
      const resp = await post(operation, query, { payload, metadata });
      expect(resp.status).toBe(200);
      expect(ids(resp)).toEqual([PLAIN_ID]);
      // the retinoid row is gone from every list and id list in the body
      expect(JSON.stringify(resp.body)).not.toContain(RETINOID_ID);
      expect(resp.body.metadata?.retinoid_safety_net?.removed_count).toBeGreaterThan(0);
      // no generated text still recommends it
      expect(JSON.stringify(resp.body)).not.toMatch(/Retinol Night Serum/);
    });
  }
});
