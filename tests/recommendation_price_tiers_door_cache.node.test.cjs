'use strict';

// RECOMMENDATION PRICE TIERS AT THE DOORS (FIX_PLAN 1.17, review round 1), through the real /mcp, /ucp/mcp and
// /public/mcp doors with their read caches ON (tests/_support/priceLogDoors.cjs; nothing leaves the process):
//   P2-1  a replayed answer is never `live`: the /mcp read cache serves a `live` row read before the call as
//         `cache`, with the original price_as_of;
//   P3-2  the demote runs where the label is served: /mcp reorders its own answer by the label the gateway set
//         (`price_staleness.reordered: false`); /ucp/mcp, whose shaper drops the label, keeps the order;
//   P2-5  DOOR_CACHE_PRICE_FRESHNESS_CAP=on: a door cache entry holding a merchant answer ends when that answer is
//         15 min old (the /mcp + /ucp read cache and the public tier's); off, every TTL exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');

const PORT = 3997;
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const PAGES = {
  'tiers replay probe': () => [
    { product_id: 'sig_r1', title: 'Replay One', price: 10, currency: 'USD', price_source: 'live', price_as_of: iso(NOW) },
  ],
  'tiers reorder probe': () => [
    { product_id: 'sig_s0', title: 'Stale Zero', price: 10, currency: 'USD', price_source: 'stored', price_as_of: null, price_may_have_changed: true },
    { product_id: 'sig_f1', title: 'Fresh One', price: 11, currency: 'USD', price_source: 'stored', price_as_of: iso(NOW - MIN) },
    { product_id: 'sig_f2', title: 'Fresh Two', price: 12, currency: 'USD', price_source: 'stored', price_as_of: iso(NOW - MIN) },
  ],
  // A merchant answer read 20 min ago (the fleet cache served it at 14 min, the door kept it 6 more).
  'tiers cap old probe': () => [
    { product_id: 'sig_o1', title: 'Old Answer', price: 13, currency: 'USD', price_source: 'merchant_cache', price_as_of: iso(NOW - 20 * MIN) },
  ],
  // A merchant answer read 12 min ago: storable, for 3 more minutes.
  'tiers cap recent probe': () => [
    { product_id: 'sig_c1', title: 'Recent Answer', price: 14, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW - 12 * MIN) },
  ],
  // Stored prices only: the cap leaves the clock alone.
  'tiers cap stored probe': () => [
    { product_id: 'sig_st1', title: 'Stored Only', price: 15, currency: 'USD', price_source: 'catalog_offer' },
  ],
};
const calls = {};
// Registered BEFORE the doors' own loopback interceptor, so these queries are answered here.
nock(LOOPBACK, { allowUnmocked: true }).persist()
  .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi'
    && Object.prototype.hasOwnProperty.call(PAGES, String(body.payload?.search?.query || '')))
  .reply((uri, body) => {
    const q = body.payload.search.query;
    calls[q] = (calls[q] || 0) + 1;
    const metadata = q === 'tiers reorder probe'
      ? { price_staleness: { mode: 'on', stale_after_days: 7, stale_count: 1, undated_count: 1, moved_count: 2, answer_guard: false, reordered: false, no_fresh_row: false } }
      : {};
    return [200, { status: 'success', success: true, products: PAGES[q](), total: PAGES[q]().length, metadata }];
  });

const { createPriceLogDoors, rpc, AGENT_META } = require('./_support/priceLogDoors.cjs');

const doors = createPriceLogDoors({ port: PORT, env: { COMMERCE_READ_CACHE_ENABLED: '1', PUBLIC_READ_CACHE_ENABLED: '1' } });
const supertest = require('supertest');

test.before(() => doors.start(test.mock.timers));
test.after(() => doors.stop(test.mock.timers));

const FLAGS = ['DOOR_CACHE_PRICE_FRESHNESS_CAP', 'LIST_ROW_PRICE_AS_OF', 'PRICE_STALENESS_DEMOTE'];
async function withFlags(env, fn) {
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of FLAGS) delete process.env[k];
  }
}

const mcpSearch = (query) => supertest(doors.app).post('/mcp').send(rpc('search_catalog', { query, market: 'US' }));
const ucpSearch = (query) => supertest(doors.app).post('/ucp/mcp').send(rpc('search_catalog', { meta: AGENT_META, catalog: { query } }));
const publicSearch = (query) => supertest(doors.app).post('/public/mcp').send(rpc('search_catalog', { query }));
function nativeOf(resp) {
  const r = JSON.parse(resp.text).result;
  return r.structuredContent || JSON.parse(r.content[0].text);
}

test('P2-1 a /mcp read-cache replay serves `live` rows as `cache`, dated by the original read', async () => {
  const q = 'tiers replay probe';
  const first = nativeOf(await mcpSearch(q));
  assert.equal(first.products[0].price_source, 'live', 'fresh: read during this call');
  test.mock.timers.tick(60 * 1000);
  const replay = nativeOf(await mcpSearch(q));
  assert.equal(calls[q], 1, 'the second answer is the cache\'s');
  assert.equal(replay.products[0].price_source, 'cache');
  assert.equal(replay.products[0].price_as_of, iso(NOW));
});

test('P3-2 /mcp reorders by the label it serves; /ucp/mcp (label dropped) keeps the order', async () => {
  const q = 'tiers reorder probe';
  const mcp = nativeOf(await mcpSearch(q));
  assert.deepEqual(mcp.products.map((p) => p.product_id), ['sig_f1', 'sig_f2', 'sig_s0']);
  assert.equal(mcp.metadata.price_staleness.reordered, true);
  const ucp = JSON.parse((await ucpSearch(q)).text).result;
  const ucpBody = ucp.structuredContent || JSON.parse(ucp.content[0].text);
  const ids = JSON.stringify(ucpBody).match(/sig_(?:s0|f1|f2)/g);
  assert.deepEqual([...new Set(ids)], ['sig_s0', 'sig_f1', 'sig_f2'], 'the UCP answer keeps the served order');
  // The replay is reordered on its own copy: the cached entry keeps the gateway's order.
  const again = nativeOf(await mcpSearch(q));
  assert.deepEqual(again.products.map((p) => p.product_id), ['sig_f1', 'sig_f2', 'sig_s0']);
  const ucpAgain = JSON.parse((await ucpSearch(q)).text).result;
  assert.deepEqual([...new Set(JSON.stringify(ucpAgain.structuredContent || JSON.parse(ucpAgain.content[0].text)).match(/sig_(?:s0|f1|f2)/g))], ['sig_s0', 'sig_f1', 'sig_f2']);
});

test('P2-5 OFF: the door caches keep their own TTLs, whatever the price age', async () => {
  const q = 'tiers cap old probe';
  await withFlags({}, async () => {
    await mcpSearch(q);
    await mcpSearch(q);
    assert.equal(calls[q], 1, '/mcp: stored and replayed');
    const before = calls[q];
    await publicSearch(q);
    await publicSearch(q);
    assert.equal(calls[q], before + 1, 'public: stored and replayed');
  });
});

test('P2-5 ON: an entry holding a merchant answer older than 15 min is not stored; a younger one ends at 15 min', async () => {
  test.mock.timers.tick(61 * MIN); // past every entry the OFF test stored
  await withFlags({ DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on' }, async () => {
    const old = 'tiers cap old probe';
    const base = calls[old] || 0;
    await mcpSearch(old);
    await mcpSearch(old);
    assert.equal(calls[old], base + 2, '/mcp: a 20-min-old merchant answer is never kept');
    await publicSearch(old);
    await publicSearch(old);
    assert.equal(calls[old], base + 4, 'public: the same');
    // NOW has moved on by the ticks above; the page answers relative to the frozen NOW.
  });
});

test('P2-5 ON: the cap shortens the clock to the answer\'s 15-min mark; stored-only answers keep theirs', async () => {
  // Reset Date to NOW so the 12-min-old answer has 3 min left.
  test.mock.timers.setTime(NOW);
  await withFlags({ DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on' }, async () => {
    const recent = 'tiers cap recent probe';
    await mcpSearch(recent);
    test.mock.timers.tick(2 * MIN);
    await mcpSearch(recent);
    assert.equal(calls[recent], 1, 'inside its 3 min: served from the cache');
    test.mock.timers.tick(2 * MIN);
    await mcpSearch(recent);
    assert.equal(calls[recent], 2, 'past the answer\'s 15-min mark (the cache\'s own TTL is 5 min): recomputed');
    const stored = 'tiers cap stored probe';
    await mcpSearch(stored);
    test.mock.timers.tick(4 * MIN);
    await mcpSearch(stored);
    assert.equal(calls[stored], 1, 'no merchant answer: its own 5-min TTL');
  });
});
