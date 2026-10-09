'use strict';

// THE BUYER-MARKET FALLBACK (discoveryFeed.applyBuyerMarketFallback, Peng 2026-10-09 "(c)").
//
// The curated feed is the deployment's market (USD). A request keyed to another market whose page
// has no row in that market's currency is rebuilt from that market's own products_search rows,
// filtered to the currency BEFORE ranking -- never USD rows across markets. Everything else is
// byte-identical. The rule is pinned here with its two collaborators injected (no database, no
// transport); the transport hop is pinned below over a mocked axios.

jest.mock('axios');
const axios = require('axios');

const { _internals } = require('../src/services/discoveryFeed');
const { applyBuyerMarketFallback, fetchBuyerMarketSearchRows, resolveDiscoveryBuyerMarket, BUYER_MARKET_FALLBACK_REASON } = _internals;

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
    expect(out.metadata.fallback_triggered).toBe(false);
  });

  test('a nested `discovery` payload names its market the same way', async () => {
    const h = harness({ rows: [sgd(1)] });
    const out = await applyBuyerMarketFallback({ response: page([usd(1)]), payload: { discovery: { ...BROWSE }, buyer_market: 'SG' }, ...h });
    expect(out.metadata.buyer_market_fallback.applied).toBe(true);
  });
});

describe('fetchBuyerMarketSearchRows: the hop', () => {
  const REQUEST = { surface: 'browse_products', query: { text: '' }, request_id: 'req_1' };
  const prev = {};
  beforeEach(() => {
    for (const k of ['DISCOVERY_PRODUCTS_SEARCH_BASE_URL', 'DISCOVERY_PRODUCTS_SEARCH_API_KEY', 'DISCOVERY_COLD_START_QUERY_BASKET']) prev[k] = process.env[k];
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = 'http://catalog.test';
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'test-token';
    process.env.DISCOVERY_COLD_START_QUERY_BASKET = 'serum|sunscreen|lip gloss|shampoo|toner|mask';
    axios.get.mockReset();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
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
      expect(config.params).toEqual(expect.objectContaining({ market: 'SG', in_stock_only: false, limit: 60, offset: 0 }));
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
