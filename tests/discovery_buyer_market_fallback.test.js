'use strict';

// THE BUYER-MARKET FALLBACK (discoveryFeed.applyBuyerMarketFallback, Peng 2026-10-09 "(c)").
//
// The curated feed is the deployment's market (USD). A request keyed to another market whose page
// has no row in that market's currency is rebuilt from that market's own products_search rows,
// filtered to the currency BEFORE ranking -- never USD rows across markets. Everything else is
// byte-identical. The rule is pinned here with its two collaborators injected (no database, no
// transport); the transport hop is pinned below over a mocked axios.

jest.mock('axios');
// The card-mode build below runs the real pipeline with injected candidates; the browse count reads the
// database, which answers nothing here.
jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
const axios = require('axios');

const { _internals } = require('../src/services/discoveryFeed');
const {
  applyBuyerMarketFallback, fetchBuyerMarketSearchRows, resolveDiscoveryBuyerMarket, resolveDiscoveryCardCurrency,
  buildDiscoveryFeedOnce, resetBuyerMarketPoolCacheForTest, resetProductsSearchBreaker, isProductsSearchBreakerOpen,
  BUYER_MARKET_FALLBACK_REASON,
} = _internals;

const usd = (id, price = 24) => ({ merchant_id: 'external_seed', product_id: `sig_${id}`, title: `USD ${id}`, currency: 'USD', price });
const sgd = (id, price = 31) => ({ merchant_id: 'external_seed', product_id: `sig_${id}`, title: `SGD ${id}`, currency: 'SGD', price });
const unpriced = (id) => ({ merchant_id: 'external_seed', product_id: `sig_${id}`, title: `No price ${id}` });

const BROWSE = {
  surface: 'browse_products', page: 1, limit: 24,
  context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] },
};
const page = (products, metadata = {}) => ({
  status: 'success', success: true, products, total: 3222, page: 1, page_size: products.length,
  metadata: { candidate_source: 'canonical_sig', primary_path_used: 'canonical_sig', fallback_triggered: false, eligible_pool_count: 104, ...metadata },
});

function harness({ rows = [], rebuilt = null } = {}) {
  const calls = { fetch: [], build: [] };
  const fetchRows = jest.fn(async (args) => { calls.fetch.push(args); return { products: rows, recallSummary: [{ label: 'buyer_market_pool_1', market: args.market, returned: rows.length }], skipped: null }; });
  const buildOnce = jest.fn(async (payload, options) => { calls.build.push({ payload, options }); return rebuilt || page(options.candidateProducts.map((p) => ({ ...p })), { candidate_source: 'override', eligible_pool_count: options.candidateProducts.length }); });
  return { calls, fetchRows, buildOnce };
}

describe('resolveDiscoveryBuyerMarket', () => {
  test('one ISO-2 market, upper-cased, from buyer_market; a list, a locale, junk or nothing is null', () => {
    expect(resolveDiscoveryBuyerMarket({ buyer_market: 'sg' })).toBe('SG');
    expect(resolveDiscoveryBuyerMarket({ buyerMarket: 'JP' })).toBe('JP');
    for (const raw of ['US,SG', 'en-US', 'USA', '', null, undefined, 7, 'ZZ']) {
      // ZZ is a well-formed code: resolveDiscoveryBuyerMarket does not price it; applyBuyerMarketFallback does.
      if (raw === 'ZZ') expect(resolveDiscoveryBuyerMarket({ buyer_market: raw })).toBe('ZZ');
      else expect(resolveDiscoveryBuyerMarket({ buyer_market: raw })).toBeNull();
    }
    expect(resolveDiscoveryBuyerMarket(null)).toBeNull();
    expect(resolveDiscoveryBuyerMarket({ market: 'SG' })).toBeNull(); // only the door's stamp counts
  });
});

describe('applyBuyerMarketFallback: the rule', () => {
  test('a silent request is untouched by reference, and nothing is fetched or rebuilt', async () => {
    const h = harness({ rows: [sgd(1)] });
    const response = page([usd(1), usd(2)]);
    expect(await applyBuyerMarketFallback({ response, payload: BROWSE, ...h })).toBe(response);
    expect(h.fetchRows).not.toHaveBeenCalled();
    expect(h.buildOnce).not.toHaveBeenCalled();
  });

  test("the deployment's own market (US -> USD) is untouched: the curated feed IS that market's", async () => {
    const h = harness({ rows: [sgd(1)] });
    const response = page([usd(1)]);
    expect(await applyBuyerMarketFallback({ response, payload: { ...BROWSE, buyer_market: 'US' }, ...h })).toBe(response);
    expect(h.fetchRows).not.toHaveBeenCalled();
  });

  test("the deployment's own market with an EMPTY page is untouched too: an empty home feed is not a currency problem", async () => {
    const h = harness({ rows: [usd(1)] });
    const response = page([]);
    expect(await applyBuyerMarketFallback({ response, payload: { ...BROWSE, buyer_market: 'US' }, ...h })).toBe(response);
    expect(h.fetchRows).not.toHaveBeenCalled();
    expect(h.buildOnce).not.toHaveBeenCalled();
  });

  test('a market nothing is priced for (null currency) is untouched: the door serves nothing, by design', async () => {
    const h = harness({ rows: [sgd(1)] });
    const response = page([usd(1)]);
    expect(await applyBuyerMarketFallback({ response, payload: { ...BROWSE, buyer_market: 'ZZ' }, ...h })).toBe(response);
    expect(h.fetchRows).not.toHaveBeenCalled();
  });

  test('a keyed market whose page already holds a row in its currency is untouched', async () => {
    const h = harness({ rows: [sgd(9)] });
    const response = page([usd(1), sgd(2)]);
    expect(await applyBuyerMarketFallback({ response, payload: { ...BROWSE, buyer_market: 'SG' }, ...h })).toBe(response);
    expect(h.fetchRows).not.toHaveBeenCalled();
  });

  test("SG with a USD-only page: rebuilt from SG's own rows, annotated as products_search, with the stamp", async () => {
    const h = harness({ rows: [sgd(10), sgd(11), sgd(12)] });
    const out = await applyBuyerMarketFallback({ response: page([usd(1), usd(2)]), payload: { ...BROWSE, buyer_market: 'sg' }, ...h });
    expect(h.fetchRows).toHaveBeenCalledTimes(1);
    expect(h.calls.fetch[0]).toEqual(expect.objectContaining({ market: 'SG', servingCurrency: 'SGD' }));
    expect(h.calls.fetch[0].request.surface).toBe('browse_products');
    expect(h.buildOnce).toHaveBeenCalledTimes(1);
    const injected = h.calls.build[0].options.candidateProducts;
    expect(injected.map((p) => p.product_id)).toEqual(['sig_10', 'sig_11', 'sig_12']);
    expect(injected.every((p) => p.__discovery_provider === 'products_search')).toBe(true);
    expect(h.calls.build[0].payload).toEqual({ ...BROWSE, buyer_market: 'sg' });
    expect(out.products.map((p) => p.currency)).toEqual(['SGD', 'SGD', 'SGD']);
    expect(out.total).toBe(3); // the market's pool, not the USD corpus count
    expect(out.metadata.corpus_total_count).toBe(3);
    expect(out.metadata).toEqual(expect.objectContaining({
      candidate_source: 'buyer_market_products_search',
      fallback_triggered: true,
      fallback_reason: BUYER_MARKET_FALLBACK_REASON,
      buyer_market_fallback: expect.objectContaining({ market: 'SG', serving_currency: 'SGD', applied: true, rows: 3, curated_rows_dropped: 2, reason: BUYER_MARKET_FALLBACK_REASON }),
    }));
    expect(out.metadata.route_health).toEqual(expect.objectContaining({ fallback_triggered: true, fallback_reason: BUYER_MARKET_FALLBACK_REASON }));
    expect(out.metadata.search_decision).toEqual(expect.objectContaining({ fallback_triggered: true }));
  });

  test('an EMPTY keyed page (no curated rows at all) also falls back', async () => {
    const h = harness({ rows: [sgd(10)] });
    const out = await applyBuyerMarketFallback({ response: page([]), payload: { ...BROWSE, buyer_market: 'SG' }, ...h });
    expect(h.fetchRows).toHaveBeenCalledTimes(1);
    expect(out.products).toHaveLength(1);
    expect(out.metadata.buyer_market_fallback.curated_rows_dropped).toBe(0);
  });

  test("the market has no rows of its own either: the page stays as built (the door's guard empties it) and says so", async () => {
    const h = harness({ rows: [] });
    const response = page([usd(1)]);
    const out = await applyBuyerMarketFallback({ response, payload: { ...BROWSE, buyer_market: 'SG' }, ...h });
    expect(h.buildOnce).not.toHaveBeenCalled();
    expect(out.products).toEqual(response.products);
    expect(out.metadata.buyer_market_fallback).toEqual(expect.objectContaining({ market: 'SG', applied: false, rows: 0, curated_rows_dropped: 1 }));
    // The hops ride on the applied:false stamp too: a live diagnosis needs no API key.
    expect(out.metadata.buyer_market_fallback.recall_summary).toEqual([{ label: 'buyer_market_pool_1', market: 'SG', returned: 0 }]);
    expect(out.metadata.fallback_triggered).toBe(false);
  });

  test('a nested `discovery` payload names its market the same way', async () => {
    const h = harness({ rows: [sgd(1)] });
    const out = await applyBuyerMarketFallback({ response: page([usd(1)]), payload: { discovery: { ...BROWSE }, buyer_market: 'SG' }, ...h });
    expect(out.metadata.buyer_market_fallback.applied).toBe(true);
  });
});

describe('resolveDiscoveryCardCurrency and the card build', () => {
  test('the card currency is the row\'s RESOLVED currency, USD only when the row says nothing', () => {
    expect(resolveDiscoveryCardCurrency({ price: 31, price_currency: 'SGD' })).toBe('SGD');
    expect(resolveDiscoveryCardCurrency({ price: { amount: 31, currency: 'sgd' } })).toBe('SGD');
    expect(resolveDiscoveryCardCurrency({ price: 31, currency: 'JPY' })).toBe('JPY');
    expect(resolveDiscoveryCardCurrency({ price: 31, currency_code: 'gbp' })).toBe('GBP');
    // No amount to pair with: the written currency still names what the card is priced in.
    expect(resolveDiscoveryCardCurrency({ price_currency: 'SGD' })).toBe('SGD');
    expect(resolveDiscoveryCardCurrency({ currency: 'jpy' })).toBe('JPY');
    expect(resolveDiscoveryCardCurrency({ price: 31 })).toBe('USD');
    expect(resolveDiscoveryCardCurrency({ title: 'no price' })).toBe('USD');
  });

  test('browse_products card mode labels an SGD row SGD (price_currency only, and a price object), so the guard keeps it', async () => {
    const rows = [
      { merchant_id: 'external_seed', product_id: 'sig_a', title: 'A', price: 31, price_currency: 'SGD', image_url: 'https://x/a.jpg', status: 'active', inventory_quantity: 3 },
      { merchant_id: 'external_seed', product_id: 'sig_b', title: 'B', price: { amount: 42, currency: 'SGD' }, image_url: 'https://x/b.jpg', status: 'active', inventory_quantity: 3 },
    ];
    const out = await buildDiscoveryFeedOnce({ ...BROWSE, response_detail: 'card', buyer_market: 'SG' }, { candidateProducts: rows.map((r) => ({ ...r, __discovery_provider: 'products_search' })) });
    const byId = Object.fromEntries(out.products.map((p) => [p.product_id, p]));
    expect(Object.keys(byId).sort()).toEqual(['sig_a', 'sig_b']);
    expect(byId.sig_a.currency).toBe('SGD');
    expect(byId.sig_b.currency).toBe('SGD');
    // And the door's own rule keeps both for an SGD buyer.
    const { enforceServingCurrency } = require('../src/services/servingCurrencyGuard');
    const guarded = enforceServingCurrency({ operation: 'get_discovery_feed', payload: {}, metadata: { market: 'SG' }, body: out });
    expect(guarded.products).toHaveLength(2);
    expect(guarded.metadata.serving_currency_guard).toBeUndefined();
  });
});

describe('fetchBuyerMarketSearchRows: the hop', () => {
  const REQUEST = { surface: 'browse_products', query: { text: '' }, request_id: 'req_1' };
  const prev = {};
  beforeEach(() => {
    for (const k of ['DISCOVERY_PRODUCTS_SEARCH_BASE_URL', 'DISCOVERY_PRODUCTS_SEARCH_API_KEY', 'DISCOVERY_COLD_START_QUERY_BASKET', 'DISCOVERY_BUYER_MARKET_FALLBACK_BUDGET_MS']) prev[k] = process.env[k];
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'test-token';
    process.env.DISCOVERY_COLD_START_QUERY_BASKET = 'serum|sunscreen|lip gloss|shampoo|toner|mask';
    process.env.DISCOVERY_BUYER_MARKET_FALLBACK_BUDGET_MS = '1500';
    axios.get.mockReset();
    resetBuyerMarketPoolCacheForTest();
    resetProductsSearchBreaker();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetBuyerMarketPoolCacheForTest();
    resetProductsSearchBreaker();
  });

  test('the hops run IN PARALLEL, each clamped to the one fallback budget', async () => {
    const pending = [];
    axios.get.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    const run = fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toHaveLength(4); // all four in flight before any answered
    for (const [, config] of axios.get.mock.calls) expect(config.timeout).toBeLessThanOrEqual(1500);
    for (const resolve of pending) resolve({ status: 200, data: { products: [sgd('p')] } });
    const out = await run;
    expect(out.products).toHaveLength(1);
    expect(out.cached).toBe(false);
  });

  test('a market\'s pool is cached: the next page pays no hop; an answered-EMPTY pool is cached too', async () => {
    axios.get.mockResolvedValue({ status: 200, data: { products: [sgd(1)] } });
    const first = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    expect(axios.get).toHaveBeenCalledTimes(4);
    const second = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    expect(axios.get).toHaveBeenCalledTimes(4);
    expect(second.cached).toBe(true);
    expect(second.products).toEqual(first.products);
    expect(second.recallSummary[0]).toEqual(expect.objectContaining({ label: 'buyer_market_pool_cache', cache_hit: true, market: 'SG' }));
    // Another market, another pool.
    await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'JP', servingCurrency: 'JPY', limit: 24 });
    expect(axios.get).toHaveBeenCalledTimes(8);
    // Answered empty (the upstream said so): negative-cached for its own TTL (30 s), no hop on the
    // next page even 5 s later -- and gone after the TTL.
    axios.get.mockResolvedValue({ status: 200, data: { products: [] } });
    let clock = 1_000_000;
    const now = () => clock;
    const empty = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'GB', servingCurrency: 'GBP', limit: 24, now });
    expect(empty.products).toEqual([]);
    expect(axios.get).toHaveBeenCalledTimes(12);
    clock += 5000;
    const emptyAgain = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'GB', servingCurrency: 'GBP', limit: 24, now });
    expect(emptyAgain.cached).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(12);
    clock += 30001;
    const afterTtl = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'GB', servingCurrency: 'GBP', limit: 24, now });
    expect(afterTtl.cached).toBe(false);
    expect(axios.get).toHaveBeenCalledTimes(16);
  });

  test('an all-failed round is not an answer: not cached, and it FEEDS the breaker, which the next call RESPECTS', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const failed = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    expect(failed.products).toEqual([]);
    expect(failed.recallSummary.every((s) => s.failure_reason === 'request_error:ECONNRESET')).toBe(true);
    expect(axios.get).toHaveBeenCalledTimes(4);
    // Four failures passed the breaker's threshold (3): open.
    expect(isProductsSearchBreakerOpen()).toBe(true);
    const skipped = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    expect(skipped).toEqual(expect.objectContaining({ products: [], skipped: 'products_search_circuit_open' }));
    // Nothing new was paid beyond the lane's own probe (at most one request).
    expect(axios.get.mock.calls.length).toBeLessThanOrEqual(5);
  });

  test('one GET per cold-start query (capped at 4), keyed on the market; rows merged, and kept only in the serving currency', async () => {
    axios.get.mockImplementation(async (url, config) => ({
      status: 200,
      data: { products: [sgd(`${config.params.query}_a`), usd(`${config.params.query}_usd`), unpriced(`${config.params.query}_np`), { ...sgd('dup'), product_id: 'sig_dup' }] },
    }));
    const out = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 60 });
    expect(axios.get).toHaveBeenCalledTimes(4);
    for (const [url, config] of axios.get.mock.calls) {
      expect(url).toBe('http://catalog.test/agent/v1/products/search');
      // SERVING market, never the storage partition: `market=SG` binds the empty SG partition on the backend.
      expect(config.params).toEqual(expect.objectContaining({ serving_market: 'SG', in_stock_only: false, limit: 60, offset: 0 }));
      expect(config.params).not.toHaveProperty('market');
      expect(config.headers['X-Agent-API-Key']).toBe('test-token');
    }
    expect(axios.get.mock.calls.map(([, c]) => c.params.query)).toEqual(['serum', 'sunscreen', 'lip gloss', 'shampoo']);
    const ids = out.products.map((p) => p.product_id);
    // USD rows never cross markets; an unpriced row is a card without a price and is kept; the duplicate is merged once.
    expect(ids.filter((id) => id.endsWith('_usd'))).toEqual([]);
    expect(ids.filter((id) => id === 'sig_dup')).toHaveLength(1);
    expect(ids).toEqual(expect.arrayContaining(['sig_serum_a', 'sig_serum_np', 'sig_sunscreen_a']));
    expect(out.recallSummary).toHaveLength(4);
    expect(out.recallSummary[0]).toEqual(expect.objectContaining({ label: 'buyer_market_pool_1', market: 'SG', status: 200, returned: 4 }));
  });

  test('a hop asks for at most ONE page (60) at offset 0, whatever the candidate limit: the backend proxy 422s above 100', async () => {
    axios.get.mockResolvedValue({ status: 200, data: { products: [sgd(1)] } });
    await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 120 });
    for (const [, config] of axios.get.mock.calls) {
      expect(config.params.limit).toBe(60);
      expect(config.params.offset).toBe(0);
      expect(config.params.limit).toBeLessThanOrEqual(100);
    }
  });

  test("the page's own query text replaces the cold-start basket", async () => {
    axios.get.mockResolvedValue({ status: 200, data: { products: [sgd(1)] } });
    await fetchBuyerMarketSearchRows({ request: { ...REQUEST, query: { text: 'vitamin c serum' } }, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][1].params.query).toBe('vitamin c serum');
  });

  test('a failed hop yields no rows and a failure in the summary, never a throw', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const out = await fetchBuyerMarketSearchRows({ request: { ...REQUEST, query: { text: 'serum' } }, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    expect(out.products).toEqual([]);
    expect(out.recallSummary[0]).toEqual(expect.objectContaining({ returned: 0, failure_reason: 'request_error:ECONNRESET' }));
  });

  test('no base URL or key configured: skipped, no hop', async () => {
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY;
    const out = await fetchBuyerMarketSearchRows({ request: REQUEST, market: 'SG', servingCurrency: 'SGD', limit: 24 });
    expect(out).toEqual({ products: [], recallSummary: [], skipped: 'products_search_api_key_unset' });
    expect(axios.get).not.toHaveBeenCalled();
  });
});
