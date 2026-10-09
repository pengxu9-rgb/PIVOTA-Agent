process.env.PIVOTA_API_BASE = 'http://catalog.test';
process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'LIVE';

// THE BUYER-MARKET FALLBACK, END TO END THROUGH THE INVOKE DOOR (Peng 2026-10-09 "(c)").
//
// The door stamps the request's market (metadata.market, the same reader the serving-currency
// guard uses) onto the discovery payload; the feed's curated page comes back USD; the feed rebuilds
// from the backend's SG rows (products/search?market=SG); the door's guard then has nothing to drop.
// Modelled on invoke.get_discovery_feed_products_search.test.js: no database, so recall goes through
// products/search, which nock answers by whether the hop carried a market.

const nock = require('nock');
const request = require('supertest');
const app = require('../../src/server');
const { _internals: feedInternals } = require('../../src/services/discoveryFeed');

const usdRows = [
  { merchant_id: 'm1', product_id: 'alpha_serum', title: 'Alpha Repair Serum', brand: 'Alpha', category: 'Skincare', product_type: 'Serum', inventory_quantity: 12, status: 'active', price: 24, currency: 'USD' },
  { merchant_id: 'm2', product_id: 'beta_toner', title: 'Beta Repair Toner', brand: 'Beta', category: 'Skincare', product_type: 'Toner', inventory_quantity: 8, status: 'active', price: 18, currency: 'USD' },
];
const sgdRows = [
  { merchant_id: 'm3', product_id: 'gamma_cream_sg', title: 'Gamma Barrier Cream', brand: 'Gamma', category: 'Skincare', product_type: 'Cream', inventory_quantity: 7, status: 'active', price: 31, currency: 'SGD' },
  { merchant_id: 'm4', product_id: 'delta_serum_sg', title: 'Delta Repair Serum', brand: 'Delta', category: 'Skincare', product_type: 'Serum', inventory_quantity: 5, status: 'active', price: 42, currency: 'SGD' },
  // A USD row the backend answered for SG anyway: filtered out before ranking, never served.
  { merchant_id: 'm5', product_id: 'stray_usd', title: 'Stray USD Serum', brand: 'Stray', category: 'Skincare', product_type: 'Serum', inventory_quantity: 5, status: 'active', price: 9, currency: 'USD' },
];

const invokeBody = (market) => ({
  operation: 'get_discovery_feed',
  payload: {
    surface: 'home_hot_deals',
    page: 1,
    limit: 3,
    context: {
      auth_state: 'authenticated',
      locale: 'en-US',
      recent_views: [{ merchant_id: 'm1', product_id: 'seed_alpha', title: 'Alpha Repair Serum', brand: 'Alpha', category: 'Skincare', product_type: 'Serum', viewed_at: '2026-04-04T10:00:00Z' }],
      recent_queries: ['repair serum'],
    },
  },
  metadata: { source: 'shopping-agent-ui', ...(market ? { market } : {}) },
});

function mockCatalog() {
  const hops = [];
  nock('http://catalog.test')
    .matchHeader('x-api-key', 'test-token')
    .get('/agent/v1/products/search')
    .query((params) => { hops.push(params); return true; })
    .times(12)
    .reply(200, (uri) => ({ products: /[?&]serving_market=SG/.test(uri) ? sgdRows : usdRows }));
  return hops;
}

describe('/agent/shop/v1/invoke get_discovery_feed: the buyer-market fallback', () => {
  beforeEach(() => { feedInternals.resetBuyerMarketPoolCacheForTest(); feedInternals.resetProductsSearchBreaker(); });
  afterEach(() => nock.cleanAll());

  test('metadata.market=SG: the USD page is rebuilt from the backend\'s SG rows, and the door drops nothing', async () => {
    const hops = mockCatalog();
    const res = await request(app).post('/agent/shop/v1/invoke').send(invokeBody('SG')).expect(200);
    expect(res.body.products.length).toBeGreaterThan(0);
    expect(res.body.products.map((p) => p.currency)).toEqual(res.body.products.map(() => 'SGD'));
    expect(res.body.products.map((p) => p.product_id)).not.toContain('stray_usd');
    expect(res.body.metadata).toEqual(expect.objectContaining({
      candidate_source: 'buyer_market_products_search',
      fallback_triggered: true,
      fallback_reason: 'buyer_market_currency_empty',
      buyer_market_fallback: expect.objectContaining({ market: 'SG', serving_currency: 'SGD', applied: true, rows: 2, served: 2 }),
    }));
    expect(res.body.metadata.serving_currency_guard).toBeUndefined();
    expect(hops.some((p) => p.serving_market === 'SG')).toBe(true);
    expect(hops.filter((p) => p.serving_market === 'SG').every((p) => String(p.query || '').trim().length > 0)).toBe(true);
    // THE BACKEND PROXY'S PAGINATION CONTRACT, pinned on the wire: limit <= 100 and offset a multiple of it
    // (its SDK route answers 422 gateway_pagination_unsupported otherwise, before any search runs).
    for (const p of hops.filter((h) => h.serving_market === 'SG')) {
      expect(Number(p.limit)).toBeLessThanOrEqual(100);
      expect(Number(p.offset) % Number(p.limit)).toBe(0);
    }
    // No hop ever names the storage partition; the first build's hops carried no market at all.
    expect(hops.some((p) => 'market' in p)).toBe(false);
    expect(hops.some((p) => !('serving_market' in p))).toBe(true);
  });

  test('no market: the page is the deployment\'s own (USD), untouched, no fallback stamp', async () => {
    const hops = mockCatalog();
    const res = await request(app).post('/agent/shop/v1/invoke').send(invokeBody(null)).expect(200);
    expect(res.body.products.map((p) => p.currency)).toEqual(res.body.products.map(() => 'USD'));
    expect(res.body.metadata.buyer_market_fallback).toBeUndefined();
    expect(res.body.metadata.fallback_reason).not.toBe('buyer_market_currency_empty');
    expect(hops.some((p) => 'serving_market' in p)).toBe(false);
  });

  test('metadata.market=US: the deployment\'s own market, untouched', async () => {
    const hops = mockCatalog();
    const res = await request(app).post('/agent/shop/v1/invoke').send(invokeBody('US')).expect(200);
    expect(res.body.products.map((p) => p.currency)).toEqual(res.body.products.map(() => 'USD'));
    expect(res.body.metadata.buyer_market_fallback).toBeUndefined();
    expect(hops.some((p) => 'serving_market' in p)).toBe(false);
  });

  test('a buyer_market the CLIENT wrote into the payload is scrubbed: no market on any hop, no fallback stamp', async () => {
    const hops = mockCatalog();
    const body = invokeBody(null);
    body.payload.buyer_market = 'SG';
    const res = await request(app).post('/agent/shop/v1/invoke').send(body).expect(200);
    expect(res.body.products.map((p) => p.currency)).toEqual(res.body.products.map(() => 'USD'));
    expect(res.body.metadata.buyer_market_fallback).toBeUndefined();
    expect(hops.some((p) => 'serving_market' in p)).toBe(false);
  });

  test('metadata.market=SG but the backend has no SG rows either: an empty page that says why', async () => {
    const hops = [];
    nock('http://catalog.test')
      .matchHeader('x-api-key', 'test-token')
      .get('/agent/v1/products/search')
      .query((params) => { hops.push(params); return true; })
      .times(12)
      .reply(200, (uri) => ({ products: /[?&]serving_market=SG/.test(uri) ? [] : usdRows }));
    const res = await request(app).post('/agent/shop/v1/invoke').send(invokeBody('SG')).expect(200);
    expect(res.body.products).toEqual([]);
    expect(res.body.metadata.buyer_market_fallback).toEqual(expect.objectContaining({ market: 'SG', applied: false, rows: 0 }));
    expect(res.body.metadata.buyer_market_fallback.recall_summary.length).toBeGreaterThan(0);
    expect(res.body.metadata.buyer_market_fallback.recall_summary.every((h) => h.returned === 0 && h.status === 200)).toBe(true);
    // The door's guard did the emptying, and says so.
    expect(res.body.metadata.serving_currency_guard).toEqual(expect.objectContaining({ serving_currency: 'SGD', dropped_currencies: ['USD'] }));
  });
});
