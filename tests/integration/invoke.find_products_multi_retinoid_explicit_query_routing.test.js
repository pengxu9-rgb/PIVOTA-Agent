// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const nock = require('nock');
const request = require('supertest');

const { createRetinoidFixtureQuery } = require('../fixtures/retinoid_explicit_query_catalog.cjs');

// The explicit-ask exemption with FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING on and off. With routing
// on, "레티놀 크림" is mapped to "retinol cream" at request entry and is served like it. A Korean word
// the router does not map stays as typed, so the allowlist rejects it and the rule stays on.

const UPSTREAM = 'http://pivota-upstream.invalid';
const RETINOID_CREAMS = new Set([
  'ext_ret_night_cream', 'ext_ret_pro_cream', 'ext_ret_creme_riche', 'ext_ret_moisturizer', 'ext_retinal_cream',
  'ext_granactive_emulsion', 'ext_retinal_eye_cream', 'ext_ret_cleanser', 'ext_retinyl_spf', 'ext_cn_retinol_cream',
  'ext_ret_serum', 'ext_retinal_serum', 'ext_adapalene_gel', 'ext_ret_body_lotion',
]);
const ENV_KEYS = [
  'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
  'FIND_PRODUCTS_MULTI_ROUTE_DEBUG', 'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED',
  'BEAUTY_RETINOID_SOFT_SAFETY_TIER', 'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING',
];

jest.setTimeout(120000);

describe.each(['off', 'on'])('explicit retinoid ask with multilingual routing %s', (routing) => {
  let prevEnv;
  let app;

  beforeAll(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => /^(127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(String(host || '')));
    prevEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      PIVOTA_API_BASE: UPSTREAM, PIVOTA_API_KEY: 'test_key', API_MODE: 'REAL', DATABASE_URL: 'postgres://fixture-db.invalid/test',
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: 'false', FIND_PRODUCTS_MULTI_ROUTE_DEBUG: '1', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      GATEWAY_RATE_LIMIT_ENABLED: 'false', FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: routing,
    });
    delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
    jest.doMock('../../src/db', () => ({ query: createRetinoidFixtureQuery() }));
    nock(UPSTREAM).persist().get(/.*/).reply(200, { status: 'success', success: true, products: [], total: 0 });
    app = require('../../src/server');
  });

  afterAll(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  async function search(query, source) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const resp = await request(app).post('/agent/shop/v1/invoke').send({
          operation: 'find_products_multi',
          payload: { search: { query, page: 1, limit: 12, in_stock_only: true } },
          metadata: source ? { source, market: 'US' } : { market: 'US' },
        });
        expect(resp.status).toBe(200);
        return (resp.body.products || []).map((p) => p.product_id).filter((id) => RETINOID_CREAMS.has(id));
      } catch (err) {
        const reset = err && (err.code === 'ECONNRESET' || /socket hang up/.test(String(err.message)));
        if (!reset || attempt >= 2) throw err;
      }
    }
  }

  test('a Korean safety or extra word keeps retinoids out, routed or not', async () => {
    for (const source of ['beauty_cross_agent_batch', null]) {
      for (const query of ['레티놀 크림 임산부', '임산부 레티놀 크림', '레티놀 크림 아이', '레티놀 크림 추천', 'retinol cream 임산부']) {
        expect({ query, retinoids: await search(query, source) }).toEqual({ query, retinoids: [] });
      }
    }
  });

  test(routing === 'on' ? 'routing on: "레티놀 크림" is served like "retinol cream"' : 'routing off: "레티놀 크림" never reaches the rule and serves nothing', async () => {
    for (const source of ['beauty_cross_agent_batch', null]) {
      const ids = await search('레티놀 크림', source);
      if (routing === 'on') expect(ids.length).toBeGreaterThan(0);
      else expect(ids).toEqual([]);
    }
  });
});
