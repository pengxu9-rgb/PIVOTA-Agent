// Loopback-only: nothing in this file (or a mutant of the code it tests) can reach a real host.
const netGuard = require('../search_routing_net_guard.cjs');

/**
 * find_products_multi on the real invoke route: ONE reading of the caller's market, for every lane, the
 * serving-currency guard, the recorded market and the echo check (servingCurrencyGuard.requestedMarketOf):
 * the search block's `market` -- the payload itself when there is no search block -- else the metadata's.
 * A `market` beside a search block is read by none of them.
 *
 * Before: the early beauty lane and the guard read a flat payload's market, but the lanes after the
 * context build read the search block it wrote, which never carried it. A flat `{query, market: 'SG'}`
 * then asked upstream (and the canonical lanes) for the default market while the guard kept only SGD
 * rows: the page came back empty, or priced in the wrong market. And the context build recorded
 * `search.market || payload.market || metadata.market`, so a market beside a search block was recorded
 * (and compared by the echo check) while no lane served it. Now the context build copies a flat
 * payload's market into the search block it writes, records the market every lane serves, and the echo
 * check compares with that market; the invoke completion line says which carrier supplied it
 * (`market_carrier`) and whether a market beside a search block was left unread (`ignored_payload_market`).
 *
 * What proves the market a lane SERVED: the markets and currency its SQL was handed, the market the
 * upstream search request carried, the currency of the rows on the page (the fixture database and the
 * fixture upstream each answer in the currency of the market they were asked for), and the binding the
 * lane recorded on the invoke log line.
 */

const nock = require('nock');
const request = require('supertest');

const CANONICAL_MARKER = 'WITH candidate_products';
const UPSTREAM = 'http://upstream.invalid';

jest.setTimeout(120000);

const CURRENCY = { US: 'USD', SG: 'SGD' };
const priceIn = (currency) => (currency === 'SGD' ? '32.00' : '24.00');

function seedRow(key, title, categoryPath, currency, productType, actives = []) {
  const price = priceIn(currency);
  return {
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::ext_${key}`,
    platform: 'external_seed',
    source_product_id: `ext_${key}`,
    pivota_signature_id: `sig_${key}`,
    pivota_canonical_url: `https://catalog.invalid/products/sig_${key}`,
    product_title: title,
    product_description: `${title}. A test product.`,
    brand: 'Test Brand',
    product_type: productType,
    category: productType,
    category_path: categoryPath,
    canonical_url: `https://brand.invalid/products/${key}`,
    product_image_url: `https://cdn.invalid/${key}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    merchant_effective_price: price,
    currency,
    product_payload: {
      seed_data: { price_amount: price, price_currency: currency, availability: 'in stock', active_ingredients: actives },
    },
    rank_score: 90,
  };
}

const catalogIn = (currency) => [
  seedRow('sunscreen', 'Daily Sunscreen SPF 50', 'beauty/skincare/sun/sunscreen', currency, 'Sunscreen', ['zinc oxide']),
  seedRow('sunscreen_b', 'Mineral Sunscreen SPF 30', 'beauty/skincare/sun/sunscreen', currency, 'Sunscreen', ['titanium dioxide']),
  seedRow('cream', 'Daily Moisturizing Cream', 'beauty/skincare/moisturize/cream', currency, 'Moisturizer', ['glycerin']),
  seedRow('cream_b', 'Barrier Repair Cream', 'beauty/skincare/moisturize/cream', currency, 'Moisturizer', ['ceramide']),
  seedRow('retinol_serum', 'Retinol 0.3% Night Serum', 'beauty/skincare/treat/serum', currency, 'Serum', ['retinol']),
  seedRow('retinol_serum_b', 'Gentle Retinol Serum', 'beauty/skincare/treat/serum', currency, 'Serum', ['retinol']),
];

// The fixture upstream answers in the currency of the market it is asked for (silence = US).
const upstreamRow = (id, currency) => ({
  product_id: id,
  id,
  merchant_id: 'merch_market_test',
  merchant_name: 'Market Test Store',
  title: `Market Test Laptop ${id}`,
  description: 'A laptop',
  price: currency === 'SGD' ? 32 : 24,
  currency,
  image_url: `https://cdn.invalid/${id}.jpg`,
  inventory_quantity: 5,
  in_stock: true,
  platform: 'shopify',
});
const upstreamCurrencyFor = (market) => (String(market || '').trim().toUpperCase() === 'SG' ? 'SGD' : 'USD');

const OWNER = 'invoke.find_products_multi_market_one_convention';
const owned = (fn) => netGuard.attribution.run({ owner: OWNER }, fn);
const openServers = [];
const listen = (app) =>
  owned(() => {
    const server = app.listen(0, '127.0.0.1');
    openServers.push(server);
    return server;
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flatten = (params) => (Array.isArray(params) ? params : [params]).flatMap((p) => (Array.isArray(p) ? p : [p]));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const LANE = {
  EARLY: 'early_indexed',
  CREATOR_DIRECT: 'creator_direct',
  UPSTREAM: 'agent_products_search',
  SAFE_EMPTY: 'search_quality_contract_v1_safe_empty',
};
// [query, the lane that answers it]
const LANES = [
  ['sunscreen', LANE.EARLY],
  ['cream', LANE.CREATOR_DIRECT],
  ['laptop', LANE.UPSTREAM],
];

const flat = (query, market) => ({ query, page: 1, page_size: 20, ...(market !== undefined ? { market } : {}) });
const block = (query, { search = {}, market } = {}) => ({
  search: { query, page: 1, page_size: 20, ...search },
  ...(market !== undefined ? { market } : {}),
});

// Every placement, with the market the one reading picks and the carrier the log line names.
// [label, payload(query), metadata, served market (null = none named), market_carrier, ignored_payload_market]
const COMBINATIONS = [
  ['metadata only', (q) => block(q), { market: 'SG' }, 'SG', 'metadata', false],
  ['search block only', (q) => block(q, { search: { market: 'SG' } }), undefined, 'SG', 'search_block', false],
  ['flat only', (q) => flat(q, 'SG'), undefined, 'SG', 'flat_payload', false],
  ['flat + metadata (flat wins)', (q) => flat(q, 'SG'), { market: 'US' }, 'SG', 'flat_payload', false],
  ['block with market + metadata', (q) => block(q, { search: { market: 'SG' } }), { market: 'US' }, 'SG', 'search_block', false],
  ['block without market + payload.market + metadata (metadata wins)', (q) => block(q, { market: 'US' }), { market: 'SG' }, 'SG', 'metadata', true],
  ['block with market + payload.market', (q) => block(q, { search: { market: 'SG' }, market: 'US' }), undefined, 'SG', 'search_block', true],
  ['block without market + payload.market only (ignored)', (q) => block(q, { market: 'SG' }), undefined, null, 'none', true],
  ['none', (q) => block(q), undefined, null, 'none', false],
];

describe('find_products_multi: one reading of the caller\'s market, served and recorded alike', () => {
  let prevEnv;
  let statements;
  let upstreamMarkets;
  let logged;

  afterAll(() => {
    expect(netGuard.state.blocked.filter((entry) => entry.owner === OWNER)).toEqual([]);
  });

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => String(host || '').includes('127.0.0.1'));
    prevEnv = { ...process.env };
    process.env.PIVOTA_API_BASE = UPSTREAM;
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    process.env.GATEWAY_RATE_LIMIT_ENABLED = 'false';
    for (const key of [
      'INDEX_ELIGIBLE_RECALL',
      'CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET',
      'FIND_PRODUCTS_BUYER_MARKET',
      'SEARCH_BUDGET_REQUIRE_MARKER',
      'PIVOTA_GATEWAY_GOVERNANCE_SHADOW_MODE',
      'FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING',
      'FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING',
      'SEARCH_QUALITY_CONTRACT_V1_ENABLED',
      'SEARCH_QUALITY_CONTRACT_V1_MODE',
      'SERVE_LIVE_MERCHANT_PRICE',
    ]) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await Promise.all(openServers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
    process.env = prevEnv;
    jest.dontMock('../../src/db');
    jest.restoreAllMocks();
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  function boot() {
    process.env.DATABASE_URL = 'postgres://market-one-convention.invalid/db';
    statements = [];
    upstreamMarkets = [];
    const asked = upstreamMarkets;
    nock(UPSTREAM)
      .persist()
      .post(/.*/)
      .reply(function reply(_uri, body) {
        const market = body && typeof body === 'object' ? (body.market ?? null) : null;
        asked.push(market);
        const currency = upstreamCurrencyFor(market);
        const products = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id) => upstreamRow(id, currency));
        return [200, { status: 'success', success: true, products, total: products.length }];
      })
      .get(/.*/)
      .reply(200, { status: 'success', products: [], total: 0 });
    const recorder = statements;
    jest.doMock('../../src/db', () => ({
      query: async (sql, params) => {
        recorder.push({ sql: String(sql || ''), params: flatten(params) });
        if (!String(sql || '').includes(CANONICAL_MARKER)) return { rows: [] };
        const bound = flatten(params);
        return { rows: catalogIn(bound.includes('SGD') || bound.includes('SG') ? 'SGD' : 'USD') };
      },
    }));
    const app = listen(owned(() => require('../../src/server')));
    const logger = require('../../src/logger');
    const realInfo = logger.info.bind(logger);
    logged = [];
    const lines = logged;
    jest.spyOn(logger, 'info').mockImplementation((obj, msg, ...rest) => {
      if (msg === 'invoke request complete') {
        lines.push(obj);
        return undefined;
      }
      return realInfo(obj, msg, ...rest);
    });
    const send = async (payload, metadata = undefined) => {
      statements.length = 0;
      upstreamMarkets.length = 0;
      logged.length = 0;
      const body = { operation: 'find_products_multi', payload, ...(metadata !== undefined ? { metadata } : {}) };
      const resp = await owned(async () =>
        request(app).post('/agent/shop/v1/invoke').set('content-type', 'application/json').send(JSON.stringify(body)));
      await delay(5);
      return resp;
    };
    return { send };
  }

  function observe(resp) {
    const canonical = statements.filter((s) => s.sql.includes(CANONICAL_MARKER));
    const params = canonical.flatMap((s) => s.params).filter((p) => typeof p === 'string');
    const products = Array.isArray(resp.body?.products) ? resp.body.products : [];
    const line = logged[0] || {};
    const meta = resp.body?.metadata || {};
    return {
      status: resp.status,
      lane: line.lane || meta.query_source || null,
      bound: line.market_bound || null,
      sqlMarkets: ['US', 'SG'].filter((m) => params.includes(m)),
      upstream: [...new Set(upstreamMarkets.map((m) => (m == null ? null : String(m).trim().toUpperCase())))],
      rowCurrencies: [...new Set(products.map((p) => p.currency || null))],
      returned: products.length,
      understanding: hasOwn(meta.query_understanding, 'market') ? meta.query_understanding.market : null,
      hasUnderstanding: Boolean(meta.query_understanding),
      constraint: meta.search_quality_contract?.hard_constraints?.market ?? null,
      carrier: line.market_carrier,
      ignored: hasOwn(line, 'ignored_payload_market') ? line.ignored_payload_market : '<absent>',
    };
  }

  // The answer of `query` on `lane` served `served` (the deployment default, US, when the request named no
  // market) and recorded what it served.
  function expectServedAndRecorded(label, got, lane, served) {
    const market = served || 'US';
    expect([label, got.status, got.lane, got.returned > 0, got.rowCurrencies]).toEqual([label, 200, lane, true, [CURRENCY[market]]]);
    if (lane === LANE.UPSTREAM) {
      expect([label, got.upstream]).toEqual([label, [served]]);
    } else {
      expect([label, got.bound, got.sqlMarkets]).toEqual([label, [market], [market]]);
    }
    // The early lane records the market it bound; the context build records the market the request named.
    const recorded = lane === LANE.EARLY ? market : served;
    expect([label, got.constraint]).toEqual([label, recorded]);
    if (got.hasUnderstanding || lane !== LANE.EARLY) expect([label, got.understanding]).toEqual([label, recorded]);
  }

  test('a flat payload market reaches every lane: upstream is asked for it, and the guard keeps the page it priced', async () => {
    const { send } = boot();
    // laptop and retinol serum first: the lanes that never bind a market, where the guard emptied the page
    for (const [query, lane] of [['laptop', LANE.UPSTREAM], ['retinol serum', null], ['cream', LANE.CREATOR_DIRECT], ['sunscreen', LANE.EARLY]]) { // null: the ingredient lane
      for (const metadata of [undefined, { market: 'US' }]) {
        const label = [query, 'flat SG', JSON.stringify(metadata || null)];
        const got = observe(await send(flat(query, 'SG'), metadata));
        if (lane) {
          expectServedAndRecorded(label, got, lane, 'SG');
        } else {
          // the ingredient lane: its canonical statement binds SG and the page is the SGD one (it records no
          // understanding or contract of its own)
          expect([label, got.status, got.lane, got.returned > 0, got.rowCurrencies, got.sqlMarkets, got.constraint, got.hasUnderstanding]).toEqual([
            label, 200, 'agent_products_ingredient_recall_direct', true, ['SGD'], ['SG'], null, false,
          ]);
        }
      }
    }
  }, 300000);

  test('every placement: the lane serves the one reading, records it, and the log line names its carrier', async () => {
    const { send } = boot();
    for (const [query, lane] of LANES) {
      for (const [label, payload, metadata, served, carrier, ignored] of COMBINATIONS) {
        const got = observe(await send(payload(query), metadata));
        expectServedAndRecorded([query, label], got, lane, served);
        expect([query, label, got.carrier, got.ignored]).toEqual([query, label, carrier, ignored ? true : '<absent>']);
      }
    }
  }, 600000);

  test('safe-empty answers record the one reading too, and carry the carrier', async () => {
    const { send } = boot();
    for (const [label, payload, metadata, served, carrier, ignored] of COMBINATIONS) {
      const got = observe(await send(payload('Lidschatten'), metadata));
      expect([label, got.status, got.lane, got.constraint, got.understanding, got.carrier, got.ignored]).toEqual([
        label, 200, LANE.SAFE_EMPTY, served, served, carrier, ignored ? true : '<absent>',
      ]);
    }
  }, 300000);

  test('echo check: a rejected market that was used is cleared on every lane; one that was not used clears nothing', async () => {
    const { send } = boot();
    for (const [query, lane] of [...LANES, ['Lidschatten', LANE.SAFE_EMPTY]]) {
      // used: flat (#2512's early-lane case among them), the search block, the metadata -- cleared
      for (const [label, payload, metadata] of [
        ['flat us', flat(query, 'us'), undefined],
        ['flat us + metadata US', flat(query, 'us'), { market: 'US' }],
        ['search us + payload US + metadata US', block(query, { search: { market: 'us' }, market: 'US' }), { market: 'US' }],
        ['metadata us + payload US beside a block', block(query, { market: 'US' }), { market: 'us' }],
      ]) {
        const got = observe(await send(payload, metadata));
        expect([query, label, got.status, got.lane, got.constraint, got.understanding]).toEqual([query, label, 200, lane, null, null]);
      }
      // not used: a rejected market beside a search block, the metadata's clean US served -- kept
      const got = observe(await send(block(query, { market: 'us' }), { market: 'US' }));
      expect([query, 'payload us beside a block + metadata US', got.lane, got.constraint]).toEqual([
        query, 'payload us beside a block + metadata US', lane, 'US',
      ]);
      if (lane !== LANE.EARLY) expect([query, got.understanding]).toEqual([query, 'US']);
      // a clean flat market used beside a rejected metadata one: kept
      const clean = observe(await send(flat(query, 'SG'), { market: 'us' }));
      expect([query, 'flat SG + metadata us', clean.lane, clean.constraint]).toEqual([query, 'flat SG + metadata us', lane, 'SG']);
    }
  }, 600000);
});

describe('the one reading, as functions', () => {
  const { callerChosenMarket } = require('../../src/findProductsMulti/callerEcho');
  const { requestedMarketOf } = require('../../src/services/servingCurrencyGuard');
  const { describeMarketCarrier } = require('../../src/services/marketTelemetry');

  const CASES = [
    // [payload, metadata, market, carrier, ignored]
    [{ search: { market: 'a' }, market: 'b' }, { market: 'c' }, 'a', 'search_block', true],
    [{ search: {}, market: 'b' }, { market: 'c' }, 'c', 'metadata', true],
    [{ search: {}, market: 'b' }, {}, undefined, 'none', true],
    [{ market: 'b' }, { market: 'c' }, 'b', 'flat_payload', false],
    [{ market: '' }, { market: 'c' }, 'c', 'metadata', false],
    [{ search: 'oops', market: 'b' }, {}, 'b', 'flat_payload', false],
    [{ search: ['x'], market: 'b' }, {}, 'b', 'flat_payload', false],
    [{ search: { market: ' x ' } }, null, ' x ', 'search_block', false],
    [{}, { market: ['us'] }, ['us'], 'metadata', false],
    [null, null, undefined, 'none', false],
  ];

  test('callerChosenMarket is requestedMarketOf; market_carrier names the carrier it read', () => {
    for (const [payload, metadata, market, carrier, ignored] of CASES) {
      const label = JSON.stringify([payload, metadata]);
      expect([label, callerChosenMarket(metadata, payload)]).toEqual([label, market]);
      expect([label, requestedMarketOf(payload, metadata) || undefined]).toEqual([label, market]);
      expect([label, describeMarketCarrier(payload, metadata)]).toEqual([
        label, { market_carrier: carrier, ...(ignored ? { ignored_payload_market: true } : {}) },
      ]);
    }
  });

  test('the context build copies a flat payload\'s market into the search block it writes, and only then', async () => {
    const { buildFindProductsMultiContext } = require('../../src/findProductsMulti/policy');
    const searchOf = async (payload, metadata = {}) => (await buildFindProductsMultiContext({ payload, metadata })).adjustedPayload.search;
    expect((await searchOf({ query: 'laptop', market: 'SG' })).market).toBe('SG');
    // as sent: not trimmed, not upper-cased
    expect((await searchOf({ query: 'laptop', market: ' sg ' })).market).toBe(' sg ');
    // a search block: never copied, with or without a market of its own
    expect(hasOwn(await searchOf({ search: { query: 'laptop' }, market: 'SG' }), 'market')).toBe(false);
    expect((await searchOf({ search: { query: 'laptop', market: 'US' }, market: 'SG' })).market).toBe('US');
    // no flat market: nothing
    expect(hasOwn(await searchOf({ query: 'laptop' }, { market: 'SG' }), 'market')).toBe(false);
  });
});
