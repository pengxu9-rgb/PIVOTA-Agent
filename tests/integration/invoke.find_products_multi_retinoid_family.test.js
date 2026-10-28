// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const nock = require('nock');
const request = require('supertest');

const { createRetinoidFixtureQuery } = require('../fixtures/retinoid_explicit_query_catalog.cjs');

// The shared retinoid family (src/services/retinoidFamily.js) through the real /agent/shop/v1/invoke
// route: the fixture catalog plus rows named ONLY by a family name (vitamin A and its esters,
// prescription names, rétinoïde, the Chinese / Japanese / Korean / Russian names), and a "retinol-free"
// row that names a retinoid elsewhere. db.query is mocked, the upstream is a nock on a .invalid host, and
// only loopback may connect.

const UPSTREAM = 'http://pivota-upstream.invalid';
const SOURCES = ['beauty_cross_agent_batch', null];

const FAMILY_ROWS = [
  ['fam_vitamin_a_cream', 'Vitamin A Night Cream', 'moisturizer', 'Face night cream with vitamin A.', ['vitamin a']],
  ['fam_palmitate_cream', 'Overnight Renewal Cream', 'moisturizer', 'Face night cream. Ingredients: aqua, retinyl palmitate, glycerin.', ['glycerin']],
  ['fam_differin_cream', 'Differin Oil Absorbing Moisturizer', 'moisturizer', 'Daily face moisturizer.', ['glycerin']],
  ['fam_retinoide_cream', 'Rétinoïde Crème de Nuit', 'moisturizer', 'Crème de nuit visage.', ['glycerin']],
  ['fam_cn_retinal_cream', '视黄醛晚霜', 'moisturizer', '含视黄醛的面霜。', ['glycerin']],
  ['fam_jp_retinal_cream', 'レチナール ナイトクリーム', 'moisturizer', 'レチナール配合のクリーム。', ['glycerin']],
  ['fam_ko_adapalene_cream', '아다팔렌 나이트 크림', 'moisturizer', '아다팔렌 크림.', ['glycerin']],
  ['fam_ru_retinal_cream', 'Ночной крем с ретинальдегидом', 'moisturizer', 'Крем для лица.', ['glycerin']],
  ['fam_free_claim_cream', 'Retinol-Free Night Cream', 'moisturizer', 'Retinol-free face night cream with hydroxypinacolone retinoate.', ['glycerin']],
];
const FAMILY_IDS = FAMILY_ROWS.map(([key]) => `ext_${key}`);

const ENV_KEYS = [
  'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
  'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED', 'BEAUTY_RETINOID_SOFT_SAFETY_TIER',
];

jest.setTimeout(240000);

describe('/agent/shop/v1/invoke find_products_multi: the shared retinoid family', () => {
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
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false', GATEWAY_RATE_LIMIT_ENABLED: 'false',
    });
    delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;
    jest.doMock('../../src/db', () => ({ query: createRetinoidFixtureQuery({ extraRows: FAMILY_ROWS }) }));
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
          payload: { search: { query, page: 1, limit: 50, in_stock_only: true } },
          metadata: source ? { source, market: 'US' } : { market: 'US' },
        });
        expect({ query, source, status: resp.status }).toEqual({ query, source, status: 200 });
        return { body: resp.body, ids: (resp.body.products || []).map((p) => p.product_id) };
      } catch (err) {
        const reset = err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || /socket hang up|ETIMEDOUT/.test(String(err.message)));
        if (!reset || attempt >= 2) throw err;
      }
    }
  }

  test('control: with no signal, the family-named night creams are served', async () => {
    for (const source of SOURCES) {
      const { ids } = await search('night cream', source);
      expect({ source, served: FAMILY_IDS.filter((id) => ids.includes(id)).length > 0 }).toEqual({ source, served: true });
    }
  });

  test.each([
    'pregnancy safe night cream',
    'moisturizer while on isotretinoin',
    'night cream for breastfeeding',
    'retinyl palmitate free night cream',
    'vitamin a palmitate free moisturizer',
    'retinoic acid free night cream',
  ])('HARD signal (%s): no family-named row is served, and no text names one', async (query) => {
    for (const source of SOURCES) {
      const { body, ids } = await search(query, source);
      expect({ query, source, served: FAMILY_IDS.filter((id) => ids.includes(id)) }).toEqual({ query, source, served: [] });
      const text = JSON.stringify(body);
      for (const [, title] of FAMILY_ROWS) expect({ query, source, title, named: text.includes(title) }).toEqual({ query, source, title, named: false });
    }
  });
});
