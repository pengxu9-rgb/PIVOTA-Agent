// The loopback-only network guard goes first, so nothing below can reach a real host.
const NET_GUARD = require('../agent_readiness_eval/_net_guard.cjs').state;
const NET_GUARD_BLOCKED_AT_START = NET_GUARD.blocked.length;

const nock = require('nock');
const request = require('supertest');

const { createRetinoidFixtureQuery } = require('../fixtures/retinoid_explicit_query_catalog.cjs');

// The retinoid rule in isBeautyProductContraindicatedForQuery (src/server.js) keeps retinoids
// out of a generic moisturizer / cleanser / sunscreen answer. Before this suite it also
// emptied every query that asked for the retinoid ("retinol cream"). These run the real
// invoke route over a fixture catalog: db.query is mocked, the upstream is a nock on a
// .invalid host, and only loopback may connect.

const UPSTREAM = 'http://pivota-upstream.invalid';

const RETINOID_IDS = new Set([
  'ext_ret_night_cream',
  'ext_ret_pro_cream',
  'ext_ret_creme_riche',
  'ext_ret_moisturizer',
  'ext_retinal_cream',
  'ext_granactive_emulsion',
  'ext_retinal_eye_cream',
  'ext_ret_cleanser',
  'ext_retinyl_spf',
  'ext_cn_retinol_cream',
  'ext_ret_serum',
  'ext_retinal_serum',
  'ext_adapalene_gel',
  'ext_ret_body_lotion',
]);

const ENV_KEYS = [
  'PIVOTA_API_BASE',
  'PIVOTA_API_KEY',
  'API_MODE',
  'DATABASE_URL',
  'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
  'FIND_PRODUCTS_MULTI_ROUTE_DEBUG',
  'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED',
  'GATEWAY_RATE_LIMIT_ENABLED',
];

describe('/agent/shop/v1/invoke find_products_multi: a query that asks for a retinoid', () => {
  let prevEnv;
  let app;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => /^(127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(String(host || '')));

    prevEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.PIVOTA_API_BASE = UPSTREAM;
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://fixture-db.invalid/test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.FIND_PRODUCTS_MULTI_ROUTE_DEBUG = '1';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';

    jest.doMock('../../src/db', () => ({ query: createRetinoidFixtureQuery() }));
    nock(UPSTREAM)
      .persist()
      .get(/.*/)
      .reply(200, { status: 'success', success: true, products: [], total: 0 });
    app = require('../../src/server');
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  // A connection reset under heavy machine load is transport noise, not an answer: retried.
  async function postWithResetRetry(body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(app).post('/agent/shop/v1/invoke').send(body);
      } catch (err) {
        const reset = err && (err.code === 'ECONNRESET' || /socket hang up/.test(String(err.message)));
        if (!reset || attempt >= 2) throw err;
      }
    }
  }

  async function search(query, { source = 'beauty_cross_agent_batch' } = {}) {
    const resp = await postWithResetRetry({
        operation: 'find_products_multi',
        payload: { search: { query, page: 1, limit: 12, in_stock_only: true } },
        metadata: source ? { source, market: 'US' } : { market: 'US' },
      });
    expect(resp.status).toBe(200);
    return { body: resp.body, ids: (resp.body.products || []).map((product) => product.product_id) };
  }

  const retinoidsIn = (ids) => ids.filter((id) => RETINOID_IDS.has(id));

  test('"retinol cream" serves retinol creams instead of nothing', async () => {
    for (const source of ['beauty_cross_agent_batch', null]) {
      const { ids } = await search('retinol cream', { source });
      expect(ids.slice(0, 4)).toEqual([
        'ext_ret_night_cream',
        'ext_ret_pro_cream',
        'ext_ret_creme_riche',
        'ext_ret_moisturizer',
      ]);
      expect(retinoidsIn(ids)).toEqual(ids);
      expect(ids).not.toContain('ext_ret_serum');
    }
  });

  test('a retinoid named with night, eye, cleanser, sunscreen or "with" is served', async () => {
    expect((await search('retinol night cream')).ids[0]).toBe('ext_ret_night_cream');
    expect((await search('retinol moisturizer')).ids).toContain('ext_ret_moisturizer');
    expect((await search('retinol eye cream')).ids).toContain('ext_retinal_eye_cream');
    expect((await search('night cream with retinol')).ids[0]).toBe('ext_ret_night_cream');
    expect((await search('retinol cleanser')).ids).toEqual(['ext_ret_cleanser']);
    expect((await search('retinyl palmitate sunscreen')).ids[0]).toBe('ext_retinyl_spf');
    expect((await search('retinal cream')).ids[0]).toBe('ext_retinal_cream');
    expect((await search('granactive retinoid moisturizer')).ids[0]).toBe('ext_granactive_emulsion');
    expect(retinoidsIn((await search('视黄醇面霜')).ids)).not.toEqual([]);
  });

  test('"moisturizer" still excludes every retinoid, row for row as before', async () => {
    const { ids } = await search('moisturizer');
    expect(ids).toEqual([
      'ext_bakuchiol_cream',
      'ext_barrier_moisturizer',
      'ext_gel_cream',
      'ext_peptide_night_cream',
      'ext_preg_moisturizer',
      'ext_tinted_spf',
      'ext_cream_cleanser',
    ]);
    expect(retinoidsIn((await search('cleanser')).ids)).toEqual([]);
    expect(retinoidsIn((await search('sunscreen')).ids)).toEqual([]);
    expect(retinoidsIn((await search('night cream')).ids)).toEqual([]);
  });

  test('"retinol-free cream" still excludes retinoids', async () => {
    const { ids } = await search('retinol-free cream');
    expect(ids.length).toBeGreaterThan(0);
    expect(retinoidsIn(ids)).toEqual([]);
    expect(ids[0]).toBe('ext_bakuchiol_cream');
    for (const query of ['without retinol cream', 'no retinol cream', 'retinol alternative cream', 'bio retinol cream']) {
      expect(retinoidsIn((await search(query)).ids)).toEqual([]);
    }
  });

  test('"pregnancy safe retinol cream" still excludes retinoids: the safety constraint wins', async () => {
    const { body, ids } = await search('pregnancy safe retinol cream');
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toBe('ext_preg_moisturizer');
    expect(retinoidsIn(ids)).toEqual([]);
    expect(body.metadata?.beauty_mainline_filter?.safety_rules).toContain('avoid_retinoids');
    for (const source of ['beauty_cross_agent_batch', null]) {
      for (const query of [
        'breastfeeding safe retinol cream',
        'retinol cream while nursing',
        'retinol cream for sensitive skin',
        'retinol cream for kids',
        'while using tretinoin cream, which moisturizer',
      ]) {
        expect(retinoidsIn((await search(query, { source })).ids)).toEqual([]);
      }
    }
  });

  test('"retinol serum" is unchanged', async () => {
    for (const source of ['beauty_cross_agent_batch', null]) {
      expect((await search('retinol serum', { source })).ids).toEqual(['ext_ret_serum', 'ext_retinal_serum']);
    }
  });

  test('the allowlisted modifiers still serve retinol creams', async () => {
    for (const source of ['beauty_cross_agent_batch', null]) {
      for (const query of [
        'retinol cream for acne', 'retinol cream for mature skin', 'retinol cream for men', 'retinol cream for beginners',
        'retinol face cream', "men's retinol cream", 'pro-retinol cream',
      ]) {
        const { ids } = await search(query, { source });
        expect({ query, served: retinoidsIn(ids).length > 0 }).toEqual({ query, served: true });
      }
    }
  });

  test('pairings, questions, informational and padded queries are not asks: no retinoid', async () => {
    for (const source of ['beauty_cross_agent_batch', null]) {
      for (const query of [
        'retinol and moisturizer', 'retinol and sunscreen', 'retinol + spf', 'tretinoin and moisturizer',
        'adapalene and sunscreen', 'do i need sunscreen with retinol', 'spf with retinol', 'retinol cream vs serum',
        'how to use retinol cream', 'retinol cream review', 'retinol cream reddit', 'is retinol cream bad',
        'retinol cream side effects', 'retinol cream dangers', 'retinol cream risks', 'vegan retinol cream',
        'natural retinol cream', 'retinol cream.', 'retinol cream 임산부', 'retinol cream \u{1F930}', 'retinol cream for 13 year old',
      ]) {
        const { ids } = await search(query, { source });
        expect({ query, retinoids: retinoidsIn(ids) }).toEqual({ query, retinoids: [] });
      }
    }
  });

  test('any context beyond the query turns the ask off; empty containers do not count', async () => {
    const withContext = [
      { payload: { user_profile: { skin_type: 'oily', age: 30 } } },
      { payload: { messages: [{ role: 'user', content: 'I have oily skin' }, { role: 'user', content: 'retinol cream' }] } },
      { payload: { constraints: { avoid_ingredients: ['fragrance'] } } },
      { metadata: { safety_flags: ['custom'] } },
      { payload: { context: { raw_user_goal: 'something for my skin' } } },
    ];
    const empty = [
      { payload: { user_profile: {} } },
      { payload: { messages: [{ role: 'user', content: 'retinol cream' }] } },
      { metadata: { safety_flags: [] } },
      { payload: { constraints: {} } },
    ];
    for (const source of ['beauty_cross_agent_batch', null]) {
      for (const extra of withContext) {
        const resp = await postWithResetRetry({
          operation: 'find_products_multi',
          payload: { ...(extra.payload || {}), search: { query: 'retinol cream', page: 1, limit: 12, in_stock_only: true } },
          metadata: { ...(source ? { source, market: 'US' } : { market: 'US' }), ...(extra.metadata || {}) },
        });
        const ids = (resp.body.products || []).map((p) => p.product_id);
        expect({ extra, retinoids: retinoidsIn(ids) }).toEqual({ extra, retinoids: [] });
      }
      for (const extra of empty) {
        const resp = await postWithResetRetry({
          operation: 'find_products_multi',
          payload: { ...(extra.payload || {}), search: { query: 'retinol cream', page: 1, limit: 12, in_stock_only: true } },
          metadata: { ...(source ? { source, market: 'US' } : { market: 'US' }), ...(extra.metadata || {}) },
        });
        const ids = (resp.body.products || []).map((p) => p.product_id);
        expect({ extra, served: retinoidsIn(ids).length > 0 }).toEqual({ extra, served: true });
      }
    }
  });

  test('the controller repro serves 0 retinoids', async () => {
    for (const source of ['beauty_cross_agent_batch', null]) {
      const resp = await postWithResetRetry({
        operation: 'find_products_multi',
        payload: {
          messages: [
            { role: 'user', content: 'I am 20 weeks pregnant and breastfeeding my toddler' },
            { role: 'assistant', content: 'Congratulations. How can I help?' },
            { role: 'user', content: 'retinol cream' },
          ],
          user_profile: { pregnancy_status: 'pregnant' },
          constraints: { avoid_ingredients: ['retinol'] },
          search: { query: 'retinol cream', page: 1, limit: 12, in_stock_only: true },
        },
        metadata: { ...(source ? { source, market: 'US' } : { market: 'US' }), safety_flags: ['pregnancy'] },
      });
      expect(resp.status).toBe(200);
      expect(retinoidsIn((resp.body.products || []).map((p) => p.product_id))).toEqual([]);
    }
  });

  test('no connection was refused by the loopback guard', () => {
    expect(NET_GUARD.installed).toBe(true);
    expect(NET_GUARD.blocked.slice(NET_GUARD_BLOCKED_AT_START)).toEqual([]);
  });
});
