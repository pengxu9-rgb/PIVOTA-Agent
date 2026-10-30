// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');
// The guard is one per process (a jest worker runs many files), so this file judges only the refusals
// recorded after it started.
const NET_GUARD = require('../agent_readiness_eval/_net_guard.cjs').state;
const NET_GUARD_BLOCKED_AT_START = NET_GUARD.blocked.length;

const nock = require('nock');
const request = require('supertest');

const { createRetinoidFixtureQuery } = require('../fixtures/retinoid_explicit_query_catalog.cjs');
const { HARD, HARD_NEGATION_PHRASES, SOFT, NEUTRAL } = require('../retinoid_safety_lexicon_phrases.cjs');
// main's answers, captured once. Three entries were regenerated when a strength stopped being read as a
// price cap ("10% niacinamide + retinol", "0.3% retinol serum" were empty only because of that cap);
// the fixture's "notes" says which.
const MAIN_GOLDEN = require('../fixtures/retinoid_safety_main_golden.json').product_ids;
const signal = require('../../src/services/retinoidSafetySignal');

// The retinoid safety lexicon (src/services/retinoidSafetySignal.js) through the real
// /agent/shop/v1/invoke route, on a fixture catalog with retinoid serums, creams, cleansers,
// sunscreens and an acne gel. db.query is mocked, the upstream is a nock on a .invalid host, and
// only loopback may connect.

const UPSTREAM = 'http://pivota-upstream.invalid';
const SOURCES = ['beauty_cross_agent_batch', null];

const RETINOID_IDS = new Set([
  'ext_ret_night_cream', 'ext_ret_pro_cream', 'ext_ret_creme_riche', 'ext_ret_moisturizer', 'ext_retinal_cream',
  'ext_granactive_emulsion', 'ext_retinal_eye_cream', 'ext_ret_cleanser', 'ext_retinyl_spf', 'ext_cn_retinol_cream',
  'ext_ret_serum', 'ext_retinal_serum', 'ext_adapalene_gel', 'ext_ret_body_lotion',
]);

const ENV_KEYS = [
  'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
  'FIND_PRODUCTS_MULTI_ROUTE_DEBUG', 'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED',
  'BEAUTY_RETINOID_SOFT_SAFETY_TIER',
];

jest.setTimeout(240000);

describe('/agent/shop/v1/invoke find_products_multi: retinoid safety lexicon', () => {
  let prevEnv;
  let app;

  beforeAll(() => {
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
    delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
    jest.doMock('../../src/db', () => ({ query: createRetinoidFixtureQuery() }));
    nock(UPSTREAM)
      .persist()
      .get(/.*/)
      .reply(200, { status: 'success', success: true, products: [], total: 0 });
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

  afterEach(() => {
    delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
  });

  // supertest opens a fresh loopback server per request; under heavy machine load a connection
  // is occasionally reset before the response (seen on main as well). That is transport noise,
  // not an answer, so a reset is retried; every other error and every assertion is final.
  async function postWithResetRetry(body) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(app).post('/agent/shop/v1/invoke').send(body);
      } catch (err) {
        const reset = err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /socket hang up|ETIMEDOUT/.test(String(err.message)));
        if (!reset || attempt >= 2) throw err;
      }
    }
  }

  async function search(query, { source = 'beauty_cross_agent_batch', payload = {}, metadata = {}, top = {} } = {}) {
    const resp = await postWithResetRetry({
      ...top,
      operation: 'find_products_multi',
      payload: { ...payload, search: { query, page: 1, limit: 12, in_stock_only: true } },
      metadata: { ...(source ? { source, market: 'US' } : { market: 'US' }), ...metadata },
    });
    expect({ query, source, status: resp.status, error: resp.status === 200 ? null : resp.body }).toEqual({ query, source, status: 200, error: null });
    return { body: resp.body, ids: (resp.body.products || []).map((p) => p.product_id) };
  }
  const retinoidsIn = (ids) => ids.filter((id) => RETINOID_IDS.has(id));
  const sourceKey = (source) => (source ? 'batch' : 'none');

  // Runs a worker over items, `size` at a time. The bulk lists go one at a time (the server is
  // single-threaded, so concurrency only adds contention); the isolation test runs twelve at once.
  async function inPool(items, worker, size = 1) {
    let next = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  // Every lane this fixture reaches calls the beauty gate, so the gate itself must keep the
  // retinoids out. The response-level net reporting a removal means a lane let one through.
  async function expectNoRetinoids(query, options = {}) {
    const { ids, body } = await search(query, options);
    if (retinoidsIn(ids).length > 0) throw new Error(`retinoids served for ${JSON.stringify(query)}: ${ids.join(',')}`);
    if (body?.metadata?.retinoid_safety_net) {
      throw new Error(`the gate let a retinoid through for ${JSON.stringify(query)}: ${JSON.stringify(body.metadata.retinoid_safety_net)}`);
    }
    return { ids, body };
  }

  test('premise: without a signal the serum and generic forms serve retinoids', async () => {
    for (const source of SOURCES) {
      expect(retinoidsIn((await search('retinol serum', { source })).ids).length).toBeGreaterThan(0);
      expect(retinoidsIn((await search('acne treatment', { source })).ids).length).toBeGreaterThan(0);
    }
  });

  for (const [cls, phrases] of Object.entries(HARD)) {
    test(`HARD ${cls}: no retinoid for serum, cream or generic, batch source set and unset`, async () => {
      const cases = [];
      for (const phrase of phrases) {
        for (const source of SOURCES) {
          for (const query of [`retinol serum ${phrase}`, `retinol cream ${phrase}`, `acne treatment ${phrase}`]) {
            cases.push({ query, source });
          }
        }
      }
      await inPool(cases, ({ query, source }) => expectNoRetinoids(query, { source }));
    });
  }

  test('HARD negations bound to the retinoid: no retinoid for serum, cream or generic', async () => {
    const cases = [];
    for (const phrase of HARD_NEGATION_PHRASES) {
      for (const source of SOURCES) {
        for (const query of [`retinol serum, ${phrase}`, `retinol cream, ${phrase}`, `acne treatment, ${phrase}`]) {
          cases.push({ query, source });
        }
      }
    }
    await inPool(cases, ({ query, source }) => expectNoRetinoids(query, { source }));
  });

  test('SOFT tier OFF (default): every answer is exactly main\'s', async () => {
    const cases = [];
    for (const phrases of Object.values(SOFT)) {
      for (const phrase of phrases) {
        for (const source of SOURCES) {
          for (const query of [`retinol serum ${phrase}`, `retinol cream ${phrase}`, `acne treatment ${phrase}`]) {
            cases.push({ query, source });
          }
        }
      }
    }
    await inPool(cases, async ({ query, source }) => {
      {
        {
          {
            // A soft word next to a named retinoid can also be a HARD negation ("retinol 过敏" is
            // "allergic to retinol"); those must gate whatever the flag says.
            if (signal.retinoidSafetyClassesForText(query, { softTier: false }).length > 0) {
              await expectNoRetinoids(query, { source });
              return;
            }
            const { ids } = await search(query, { source });
            expect({ query, ids }).toEqual({ query, ids: MAIN_GOLDEN[`${sourceKey(source)}|${query}`] });
          }
        }
      }
    });
  });

  test('SOFT tier ON: no retinoid for serum, cream or generic', async () => {
    process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER = 'on';
    const cases = [];
    for (const phrases of Object.values(SOFT)) {
      for (const phrase of phrases) {
        for (const source of SOURCES) {
          for (const query of [`retinol serum ${phrase}`, `retinol cream ${phrase}`, `acne treatment ${phrase}`]) {
            cases.push({ query, source });
          }
        }
      }
    }
    await inPool(cases, ({ query, source }) => expectNoRetinoids(query, { source }));
  });

  test('the existing sensitive rule keeps gating whatever the flag says', async () => {
    for (const flag of [undefined, 'off', 'on']) {
      if (flag) process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER = flag;
      else delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
      for (const query of ['retinol serum sensitive skin', 'retinol serum gentle', 'retinol serum 敏感']) {
        await expectNoRetinoids(query);
      }
    }
  });

  test('no signal: neutral queries and main\'s existing safe answers are exactly main\'s', async () => {
    const queries = [
      ...NEUTRAL,
      'pregnancy safe retinol cream',
      'pregnancy safe brightening serum sunscreen peptide moisturizer',
      'retinol-free cream',
      'retinol free moisturizer',
      'face serum',
    ];
    for (const query of queries) {
      for (const source of SOURCES) {
        const { ids } = await search(query, { source });
        expect({ query, ids }).toEqual({ query, ids: MAIN_GOLDEN[`${sourceKey(source)}|${query}`] });
      }
    }
  });

  test('an adult age gates nothing: "for an eighteen year old" serves retinoids', async () => {
    // Spelled out: a bare number in a query becomes a price cap, which would empty the answer
    // for a reason that has nothing to do with this rule.
    for (const source of SOURCES) {
      expect(retinoidsIn((await search('retinol serum for an eighteen year old', { source })).ids).length).toBeGreaterThan(0);
      await expectNoRetinoids('retinol serum for an eleven year old', { source });
    }
  });

  const REPRO = {
    payload: {
      messages: [
        { role: 'user', content: 'I am 20 weeks pregnant and breastfeeding my toddler' },
        { role: 'assistant', content: 'Congratulations. How can I help?' },
        { role: 'user', content: 'retinol cream' },
      ],
      user_profile: { pregnancy_status: 'pregnant' },
      constraints: { avoid_ingredients: ['retinol'] },
    },
    metadata: { safety_flags: ['pregnancy'] },
  };

  test('context: the controller repro serves 0 retinoids, for a cream, a serum and a generic query', async () => {
    for (const source of SOURCES) {
      for (const query of ['retinol cream', 'retinol serum', 'acne treatment']) {
        await expectNoRetinoids(query, { source, ...REPRO });
      }
    }
  });

  test('context: one signal anywhere gates; a neutral profile, flag or earlier turn does not', async () => {
    const gating = [
      { payload: { user_profile: { pregnancy_status: 'pregnant' } } },
      { payload: { user_profile: { breastfeeding: true } } },
      { payload: { user_profile: { age: 8 } } },
      { payload: { constraints: { avoid_ingredients: ['retinol'] } } },
      { payload: { avoid_ingredients: ['tretinoin'] } },
      { metadata: { safety_flags: ['pregnancy'] } },
      { metadata: { safety_flags: { pregnant: true } } },
      { payload: { messages: [{ role: 'user', content: 'I am breastfeeding' }, { role: 'user', content: 'serum' }] } },
      { top: { messages: [{ role: 'user', content: 'it is for my 9 year old' }] } },
      { payload: { context: { user_profile: { pregnancy_status: 'pregnant' } } } },
      { payload: { context: { raw_user_goal: 'something for my 8 year old' } } },
    ];
    const neutral = [
      { payload: { user_profile: { skin_type: 'oily', age: 30 } } },
      { payload: { user_profile: { pregnancy_status: 'not_pregnant' } } },
      { metadata: { safety_flags: { pregnant: false } } },
      { metadata: { safety_flags: [] } },
      { payload: { constraints: { avoid_ingredients: ['fragrance'] } } },
      { payload: { messages: [{ role: 'user', content: 'I have oily skin' }, { role: 'assistant', content: 'Noted.' }] } },
    ];
    for (const source of SOURCES) {
      const baseline = (await search('retinol serum', { source })).ids;
      expect(retinoidsIn(baseline).length).toBeGreaterThan(0);
      for (const context of gating) {
        await expectNoRetinoids('retinol serum', { source, ...context });
        await expectNoRetinoids('acne treatment', { source, ...context });
      }
      for (const context of neutral) {
        expect((await search('retinol serum', { source, ...context })).ids).toEqual(baseline);
      }
    }
  });

  test('concurrent requests never share a safety context', async () => {
    const pregnant = { payload: { user_profile: { pregnancy_status: 'pregnant' } } };
    const cases = [];
    for (let i = 0; i < 24; i += 1) cases.push(i % 2 === 0 ? { context: pregnant } : { context: {} });
    const served = [];
    await inPool(cases, async ({ context }) => {
      const { ids } = await search('retinol serum', { source: null, ...context });
      served.push({ gated: Boolean(context.payload), retinoids: retinoidsIn(ids).length });
    }, 12);
    for (const row of served) {
      if (row.gated) expect(row.retinoids).toBe(0);
      else expect(row.retinoids).toBeGreaterThan(0);
    }
  });

  test('no connection was refused by the loopback guard', () => {
    expect(NET_GUARD.installed).toBe(true);
    expect(NET_GUARD.blocked.slice(NET_GUARD_BLOCKED_AT_START)).toEqual([]);
  });
});
