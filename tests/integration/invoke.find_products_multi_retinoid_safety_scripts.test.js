// The loopback-only network guard goes first, so nothing below can reach a real host.
require('../agent_readiness_eval/_net_guard.cjs');

const nock = require('nock');
const request = require('supertest');

const { buildRetinoidFixtureSeedRows } = require('../fixtures/retinoid_explicit_query_catalog.cjs');

// Retinoid PRODUCTS named only in Korean or Russian. The row keys (and so the URLs built from them)
// carry no Latin retinoid word, so nothing but the Korean or Russian text can give them away. On main the product-side retinoid check read
// a search-normalised text that drops Hangul and Cyrillic, so "pregnancy safe serum" served
// "레티놀 프리미엄 세럼" and "retinol during pregnancy" served "Крем с ретинолом". These run the real
// invoke route over the shared fixture catalog plus the rows below.

const UPSTREAM = 'http://pivota-upstream.invalid';
const SOURCES = ['beauty_cross_agent_batch', null];
const NOW = '2026-10-01T00:00:00.000Z';

function row(key, title, category, description, extra = {}) {
  return {
    id: `seed-${key}`,
    external_product_id: `ext_${key}`,
    market: 'US',
    tool: '*',
    destination_url: `https://fixture-store.invalid/products/${key}`,
    canonical_url: `https://fixture-store.invalid/products/${key}`,
    domain: 'fixture-store.invalid',
    title,
    image_url: `https://fixture-cdn.invalid/${key}.jpg`,
    price_amount: '24.00',
    price_currency: 'USD',
    availability: 'in stock',
    seed_data: { brand: 'Fixture Beauty', category, description, ...extra },
    updated_at: NOW,
    created_at: NOW,
  };
}

const SCRIPT_RETINOID_ROWS = [
  row('ko_rx1', '레티놀 프리미엄 세럼', 'serum', '피부 결 개선 세럼.'),
  row('ko_rx2', '레티날 나이트 크림', 'moisturizer', '야간용 크림.'),
  row('ko_rx3', '레티노이드 앰플 serum', 'serum', '앰플.'),
  row('ko_rx4', '데일리 크림', 'moisturizer', '보습 크림.', { ingredients: ['정제수', '레티닐 팔미테이트', '글리세린'] }),
  row('ko_rx5', '나이트 세럼', 'serum', '세럼.', { inci: '정제수, 레티닐팔미테이트' }),
  row('ru_rx1', 'Крем с ретинолом', 'moisturizer', 'Ночной крем для лица.'),
  row('ru_rx2', 'Сыворотка ночная', 'serum', 'Содержит ретинола 0,3%.'),
  row('ru_rx3', 'Крем ретиналь', 'moisturizer', 'Ночной крем.'),
  row('ru_rx4', 'Ретиноидная сыворотка', 'serum', 'Сыворотка.'),
];
const SCRIPT_PLAIN_ROWS = [
  row('ko_plain1', '히알루론산 수분 세럼', 'serum', '수분 세럼.'),
  row('ko_plain2', '시카 진정 크림', 'moisturizer', '진정 크림.'),
  row('ru_plain1', 'Увлажняющий крем с гиалуроновой кислотой', 'moisturizer', 'Крем для лица.'),
  row('ru_plain2', 'Сыворотка с гиалуроновой кислотой', 'serum', 'Сыворотка для лица.'),
];
const SCRIPT_RETINOID_IDS = new Set(SCRIPT_RETINOID_ROWS.map((r) => r.external_product_id));
const SCRIPT_PLAIN_IDS = new Set(SCRIPT_PLAIN_ROWS.map((r) => r.external_product_id));

const ENV_KEYS = [
  'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'FIND_PRODUCTS_MULTI_VECTOR_ENABLED',
  'FIND_PRODUCTS_MULTI_ROUTE_DEBUG', 'AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED', 'GATEWAY_RATE_LIMIT_ENABLED',
  'BEAUTY_RETINOID_SOFT_SAFETY_TIER', 'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING',
];

jest.setTimeout(240000);

describe.each(['off', 'on'])('/agent/shop/v1/invoke find_products_multi: Korean and Russian retinoid products (multilingual routing %s)', (routing) => {
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
    process.env.FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING = routing;
    const rows = [...buildRetinoidFixtureSeedRows(NOW), ...SCRIPT_RETINOID_ROWS, ...SCRIPT_PLAIN_ROWS];
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (text.includes('FROM external_product_seeds') && !text.includes('FROM external_product_seeds eps')) {
          return { rows: rows.map((r) => JSON.parse(JSON.stringify(r))) };
        }
        return { rows: [] };
      },
    }));
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

  async function search(query, source) {
    const resp = await postWithResetRetry({
      operation: 'find_products_multi',
      payload: { search: { query, page: 1, limit: 24, in_stock_only: true } },
      metadata: source ? { source, market: 'US' } : { market: 'US' },
    });
    expect(resp.status).toBe(200);
    return (resp.body.products || []).map((p) => p.product_id);
  }

  test('a safety query serves no Korean or Russian retinoid row, and still serves the plain ones', async () => {
    for (const source of SOURCES) {
      const plainServed = new Set();
      for (const query of ['pregnancy safe serum', 'retinol during pregnancy', '임산부 세럼', 'беременность крем', 'serum for kids', 'pregnancy safe moisturizer']) {
        const ids = await search(query, source);
        expect({ query, source, scriptRetinoids: ids.filter((id) => SCRIPT_RETINOID_IDS.has(id)) }).toEqual({ query, source, scriptRetinoids: [] });
        ids.filter((id) => SCRIPT_PLAIN_IDS.has(id)).forEach((id) => plainServed.add(id));
      }
      expect(plainServed.size).toBeGreaterThan(0);
    }
  });

  test('premise: without a signal the Korean and Russian retinoid rows are served', async () => {
    for (const source of SOURCES) {
      const ids = await search('face serum', source);
      expect(ids.filter((id) => SCRIPT_RETINOID_IDS.has(id)).length).toBeGreaterThan(0);
    }
  });

  if (routing === 'on') {
    // With multilingual routing on, "세럼" routes like "serum": the Korean safety word must still gate.
    test('routing on: a Korean safety query reaches the beauty lane and still serves no retinoid', async () => {
      for (const source of SOURCES) {
        const plain = await search('세럼', source);
        expect(plain.filter((id) => SCRIPT_RETINOID_IDS.has(id)).length).toBeGreaterThan(0);
        const ids = await search('임산부 세럼', source);
        expect(ids.filter((id) => SCRIPT_PLAIN_IDS.has(id)).length).toBeGreaterThan(0);
        expect(ids.filter((id) => SCRIPT_RETINOID_IDS.has(id))).toEqual([]);
        expect(ids.filter((id) => id.startsWith('ext_ret') || id.startsWith('ext_retinal'))).toEqual([]);
      }
    });
  }
});
