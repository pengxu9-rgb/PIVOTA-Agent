'use strict';

// RECOMMENDATION PRICE TIERS (FIX_PLAN Phase 1 item 1.17; D-03 / D-16). One rule per section:
//   1. the shared price cache keeps a price at most 15 min (a constant no env var reaches); tombstones 10 min;
//      read mode writes an answer its own L1 cannot vouch the store holds; a synthetic call writes nothing;
//   2. read mode serves search rows from the fleet cache, marked as cache;
//   3. top-K live read: only the first K shown cards, inside a budget, per-host budget respected, falling back
//      to the cache or the stored price, never holding or emptying the page; synthetic calls read nothing;
//   4. price_as_of + price_source on every search, recommend_products and get_alternatives row;
//   5. the 7-day staleness rule: demote, label, never the answer to a cheapest / price-capped ask; shadow logs.
// The defaults differential against origin/main is tests/recommendation_price_tiers_doors.node.test.cjs.
// Nothing leaves the process: fetches are fakes, the store is the Firestore fake.

const test = require('node:test');
const assert = require('node:assert/strict');

const FLAGS = [
  'LIST_ROW_PRICE_AS_OF', 'PRICE_STALENESS_DEMOTE', 'UCP_LIVE_SEARCH_READ', 'UCP_LIVE_SEARCH_READ_TOP_K',
  'UCP_LIVE_SEARCH_READ_BUDGET_MS', 'PRICE_CACHE_STORE', 'PRICE_CACHE_MODE', 'PRICE_CACHE_FIRESTORE_PROJECT',
  'PRICE_CACHE_FIRESTORE_DATABASE', 'SERVE_LIVE_MERCHANT_PRICE', 'PRICE_HOST_BUDGET',
];
for (const k of FLAGS) delete process.env[k];

function withEnv(env, fn) {
  const before = {};
  for (const k of FLAGS) { before[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  const restore = () => {
    for (const k of FLAGS) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const pc = require('../src/services/priceCache');
const tiers = require('../src/services/listPriceTiers');
const overlay = require('../src/services/liveMerchantSearchPrice');
const { createFirestorePriceCacheStore } = require('../src/services/priceCacheStore');
const { createFakeFirestore } = require('./_support/fakeFirestore.cjs');
const { INVOKE_AUTH_CONTEXT } = require('../src/guardrails/syntheticContext');

// ---- 1. the cache window --------------------------------------------------------------------------------

test('1a TTL CAP: 15 min everywhere the cache keeps or serves a price; tombstones stay 10 min', () => {
  assert.equal(pc.MAX_PRICE_WINDOW_MS, 15 * MIN);
  assert.equal(pc.HARD_EXPIRY_MS, 15 * MIN);
  assert.equal(pc.TOMBSTONE_TTL_MS, 10 * MIN);
  for (const [k, v] of Object.entries(pc.TTL_MS)) assert.ok(v <= 15 * MIN, `${k} window ${v} is within the cap`);
  assert.equal(overlay.SHARED_TTL_MS, 15 * MIN, 'search serves a cache answer for at most 15 min');
  const KEY = { host: 'shop.example.com', market: 'US', variant_id: '1', currency: 'USD' };
  const doc = pc.verifiedPriceDoc({ ...KEY, amount: 20, source: 'merchant_ucp', writer: 'search' }, NOW).doc;
  assert.equal(doc.expire_at - doc.read_at, 15 * MIN, 'expire_at = read_at + 15 min');
  assert.equal(pc.verifiedPriceDoc({ ...KEY, amount: 20, source: 'merchant_ucp', writer: 'search', read_at: NOW - 15 * MIN - 1 }, NOW), null,
    'an answer already older than 15 min is not written');
  const gone = pc.variantGoneDoc({ ...KEY, source: 'merchant_ucp', writer: 'search' }, NOW).doc;
  assert.equal(gone.expire_at - gone.read_at, 10 * MIN, 'variant_gone tombstones: 10 min');
  // Freshness is judged from read_at, and a consumer's window can never exceed the cap.
  const stored = { ...doc };
  assert.equal(pc.servableAnswer(stored, KEY, { nowMs: NOW + 14 * MIN, ttlMs: 24 * 60 * MIN }).amount, 20);
  assert.equal(pc.servableAnswer(stored, KEY, { nowMs: NOW + 15 * MIN + 1, ttlMs: 24 * 60 * MIN }), null, 'a 1-day window is capped at 15 min');
  // A doc stored under the old 60-min expiry is never served past 15 min either (read_at decides, not expire_at).
  assert.equal(pc.servableAnswer({ ...doc, expire_at: new Date(NOW + 60 * MIN) }, KEY, { nowMs: NOW + 20 * MIN, ttlMs: 15 * MIN }), null);
});

test('1b TTL CAP: no env var reaches the window (a fresh module load under hostile env keeps 15 min)', () => {
  const hostile = {
    PRICE_CACHE_TTL_MS: String(DAY), PRICE_CACHE_HARD_EXPIRY_MS: String(DAY), PRICE_CACHE_WINDOW_MS: String(DAY),
    PRICE_CACHE_EXPIRY_MIN: '600', SEARCH_PRICE_CACHE_TTL_MS: String(DAY),
  };
  Object.assign(process.env, hostile);
  const ids = [require.resolve('../src/services/priceCache'), require.resolve('../src/services/liveMerchantSearchPrice')];
  const saved = ids.map((id) => require.cache[id]);
  try {
    for (const id of ids) delete require.cache[id];
    const fresh = require('../src/services/priceCache');
    const freshOverlay = require('../src/services/liveMerchantSearchPrice');
    assert.equal(fresh.HARD_EXPIRY_MS, 15 * MIN);
    assert.equal(fresh.MAX_PRICE_WINDOW_MS, 15 * MIN);
    assert.equal(freshOverlay.SHARED_TTL_MS, 15 * MIN);
    const KEY = { host: 'shop.example.com', market: 'US', variant_id: '1', currency: 'USD' };
    const doc = fresh.verifiedPriceDoc({ ...KEY, amount: 20, source: 'merchant_ucp', writer: 'search' }, NOW).doc;
    assert.equal(doc.expire_at - doc.read_at, 15 * MIN);
  } finally {
    for (const k of Object.keys(hostile)) delete process.env[k];
    ids.forEach((id, i) => { require.cache[id] = saved[i]; });
  }
  // The module source names no env var for any window.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/priceCache'), 'utf8');
  const envNames = [...src.matchAll(/env(?:\s*&&\s*env)?\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envNames)].sort(), ['PRICE_CACHE_FIRESTORE_DATABASE', 'PRICE_CACHE_FIRESTORE_PROJECT', 'PRICE_CACHE_MODE', 'PRICE_CACHE_STORE']);
});

function cacheHarness({ read = true } = {}) {
  const fake = createFakeFirestore();
  let t = NOW;
  const clock = { now: () => t, add: (ms) => { t += ms; } };
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, now: clock.now });
  const cache = pc.createPriceCache({ store, now: clock.now, read: () => read });
  return { fake, clock, store, cache };
}
const VKEY = { host: 'shop.example.com', market: 'US', variant_id: '43734829564039', currency: 'USD' };
const VERIFIED = { ...VKEY, amount: 23, available: true, handle: 'tint', source: 'merchant_ucp', writer: 'offers' };

test('1c READ MODE settles the write skip: an own write vouches for nothing; a fresh store read does', async () => {
  // Write mode: exactly as before (an unchanged answer inside 5 min is skipped).
  const w = cacheHarness({ read: false });
  assert.equal(w.cache.recordVerifiedPrice(VERIFIED), true);
  w.clock.add(4 * MIN);
  assert.equal(w.cache.recordVerifiedPrice(VERIFIED), false, 'write mode: skipped');
  // Read mode: instance A wrote $23; another instance may have written since, so A's repeat is written.
  const r = cacheHarness({ read: true });
  assert.equal(r.cache.recordVerifiedPrice(VERIFIED), true);
  r.clock.add(4 * MIN);
  assert.equal(r.cache.recordVerifiedPrice(VERIFIED), true, 'read mode: an own write proves nothing about the store');
  await r.store.flush();
  // ...but an answer the STORE just gave this instance (inside the 30 s L1 window) is not repeated.
  r.clock.add(31 * 1000);
  const got = await r.cache.lookup([VKEY], { ttlMs: pc.TTL_MS.search });
  assert.equal(got[0].amount, 23);
  r.clock.add(10 * 1000);
  const later = { ...VERIFIED, read_at: r.clock.now() };
  assert.equal(r.cache.recordVerifiedPrice(later), false, 'the store holds this answer (read 10 s ago): skipped');
  r.clock.add(31 * 1000);
  assert.equal(r.cache.recordVerifiedPrice({ ...VERIFIED, read_at: r.clock.now() }), true, 'the store read is past its 30 s window: written');
});

test('1d SYNTHETIC: a synthetic call writes nothing to the shared cache (no record, no tombstone, no backoff)', () => {
  const fake = createFakeFirestore();
  const built = [];
  pc._setStoreFactoryForTest((settings) => {
    built.push(settings.database);
    return createFirestorePriceCacheStore({ client: fake.db, database: settings.database, flushMs: 60000 });
  });
  try {
    withEnv({ PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'read', PRICE_CACHE_FIRESTORE_PROJECT: 'p-test' }, () => {
      INVOKE_AUTH_CONTEXT.run({ synthetic: true }, () => {
        assert.equal(pc.recordVerifiedPrice({ ...VERIFIED, writer: 'search' }), false);
        assert.equal(pc.recordVariantGone({ ...VKEY, source: 'merchant_ucp', writer: 'search' }), false);
        assert.equal(pc.noteHostRefusal('shop.example.com', 429), false);
      });
      assert.deepEqual(built, [], 'no store was even built for the synthetic call');
      assert.equal(pc.recordVerifiedPrice({ ...VERIFIED, writer: 'search' }), true, 'a real call still records');
    });
  } finally {
    pc._setStoreFactoryForTest(null);
  }
});

// ---- 2 + 3. read mode on search, and the top-K live read --------------------------------------------------

const json = (variantId, price, currency = 'USD') => ({ product: { variants: [{ id: Number(variantId), price: String(price), price_currency: currency, available: true }] } });
let hostSeq = 0;
function page(n, { host = `tiers-${++hostSeq}.example.com`, price = 20 } = {}) {
  const products = Array.from({ length: n }, (_, i) => ({
    product_id: `sig_${i}`, price, currency: 'USD', source_variant_id: String(1000 + i),
    destination_url: `https://${host}/products/item-${i}`,
  }));
  return { host, response: { products, metadata: { query_source: 'beauty_external_seed_mainline' } } };
}
function fakeFleet(answers, { read = true } = {}) {
  const lookups = [];
  return {
    lookups,
    priceCacheReadEnabled: () => read,
    lookupRecentPrices: async (keys, opts) => {
      lookups.push({ keys, opts });
      return keys.map((k) => answers.get(`${k.host}|${k.variant_id}`) || null);
    },
    recordVerifiedPrice: () => true,
  };
}
const fleetAnswer = (amount, readAtMs, handle) => ({ amount, currency: 'USD', available: true, handle, source: 'merchant_ucp', writer: 'product', read_at_ms: readAtMs, age_ms: Date.now() - readAtMs });

test('2 READ MODE serves search rows from the fleet cache, marked merchant_cache (the `cache` token), dated by read_at', async () => {
  const { host, response } = page(2);
  const readAt = Date.now() - 3 * MIN;
  const fleet = fakeFleet(new Map([[`${host}|1000`, fleetAnswer(18, readAt, 'item-0')]]));
  const fetched = [];
  const out = await overlay.overlayLiveMerchantSearchPrices(response, {
    market: 'US', priceCache: fleet,
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, json: async () => json(1001, 21) }; },
  });
  assert.equal(fleet.lookups[0].opts.ttlMs, 15 * MIN, 'the search window');
  assert.equal(out.products[0].price, 18);
  assert.equal(out.products[0].price_source, 'merchant_cache');
  assert.equal(out.products[0].price_as_of, iso(readAt));
  assert.equal(out.products[1].price_source, 'merchant_live', 'a miss is read live as before');
  assert.deepEqual(fetched, [`https://${host}/products/item-1.json`], 'the cache hit was not read');
  // The list contract relabels it `cache`.
  const stamped = withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => tiers.applyListPriceTiers(out.products).rows);
  assert.deepEqual(stamped.map((r) => r.price_source), ['cache', 'live']);
});

test('3a TOP-K settings: K only under UCP_LIVE_SEARCH_READ=enforce; default 0; K and the budget are capped', () => {
  const s = overlay.searchTopKSettings;
  assert.deepEqual(s({}, 'enforce'), { topK: 0, liveBudgetMs: null }, 'unset: today');
  assert.deepEqual(s({ UCP_LIVE_SEARCH_READ_TOP_K: '3' }, 'shadow'), { topK: 0, liveBudgetMs: null }, 'shadow ignores K');
  assert.deepEqual(s({ UCP_LIVE_SEARCH_READ_TOP_K: '3' }, null), { topK: 0, liveBudgetMs: null }, 'no reader: off');
  assert.deepEqual(s({ UCP_LIVE_SEARCH_READ_TOP_K: '3' }, 'enforce'), { topK: 3, liveBudgetMs: 600 });
  assert.deepEqual(s({ UCP_LIVE_SEARCH_READ_TOP_K: '99', UCP_LIVE_SEARCH_READ_BUDGET_MS: '60000' }, 'enforce'), { topK: 10, liveBudgetMs: 1500 });
  assert.deepEqual(s({ UCP_LIVE_SEARCH_READ_TOP_K: '2', UCP_LIVE_SEARCH_READ_BUDGET_MS: '5' }, 'enforce'), { topK: 2, liveBudgetMs: 100 });
  for (const bad of ['-1', '0', 'three', '3.5', ' ']) assert.equal(s({ UCP_LIVE_SEARCH_READ_TOP_K: bad }, 'enforce').topK, 0, bad);
});

function fakeReader(answer = () => null) {
  const planned = [];
  return {
    planned,
    mode: 'enforce',
    plan: (cards) => new Map(cards.map((c, i) => [i, { id: c.source_variant_id }])),
    readCards: async (cards, ctx, p) => {
      planned.push([...p.keys()]);
      const reads = new Map();
      for (const i of p.keys()) {
        const a = answer(i);
        reads.set(i, a ? { status: 'verified', amount: a, currency: 'USD', available: true, market: 'US', market_basis: 'declared' } : { status: 'error', reason: 'merchant_error' });
      }
      return reads;
    },
  };
}

test('3b TOP-K: only the first K shown cards are read live (UCP and .json); the rest take the cache or keep the stored price', async () => {
  const { host, response } = page(6);
  const fleet = fakeFleet(new Map([
    [`${host}|1004`, fleetAnswer(17, Date.now() - MIN, 'item-4')], // past K: served from the cache
    [`${host}|1001`, fleetAnswer(16, Date.now() - MIN, 'item-1')], // inside K: only a fallback
  ]));
  const fetched = [];
  const reader = fakeReader((i) => (i === 0 ? 25 : null)); // UCP verifies card 0; card 1 falls to its .json read
  const out = await overlay.overlayLiveMerchantSearchPrices(response, {
    market: 'US', priceCache: fleet, ucpSearchReader: reader, topK: 3, liveBudgetMs: 600,
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, json: async () => json(Number(url.match(/item-(\d)/)[1]) + 1000, 22) }; },
  });
  assert.deepEqual(reader.planned, [[0, 1, 2]], 'the UCP read is planned for the top 3 only');
  assert.deepEqual(fetched.sort(), [1, 2].map((i) => `https://${host}/products/item-${i}.json`), 'only top-K cards the UCP read did not settle take a .json read');
  assert.deepEqual(out.products.map((p) => p.price_source), ['merchant_live', 'merchant_live', 'merchant_live', undefined, 'merchant_cache', undefined]);
  assert.deepEqual(out.products.map((p) => p.price), [25, 22, 22, 20, 17, 20], 'past K: cache or stored, never read');
  assert.equal(out.products.length, 6, 'never emptied');
  assert.deepEqual(out.metadata.live_merchant_price.top_k, { k: 3, budget_ms: 600, live_verified_count: 3, cache_fallback_count: 0 });
});

test('3c TOP-K BUDGET: a slow merchant costs the page at most the budget; the top-K card falls back to the cache, else stored', async () => {
  const { host, response } = page(3);
  const fleet = fakeFleet(new Map([[`${host}|1000`, fleetAnswer(19, Date.now() - 2 * MIN, 'item-0')]]));
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const started = Date.now();
  const out = await overlay.overlayLiveMerchantSearchPrices(response, {
    market: 'US', priceCache: fleet, topK: 2, liveBudgetMs: 150, fetchImpl: hang,
  });
  const ms = Date.now() - started;
  assert.ok(ms < 1000, `held the page ${ms} ms (budget 150, page deadline 2500)`);
  assert.equal(out.metadata.live_merchant_price.deadline_exceeded, true);
  assert.equal(out.products[0].price, 19);
  assert.equal(out.products[0].price_source, 'merchant_cache', 'timed out: the fleet answer');
  assert.equal(out.products[1].price, 20);
  assert.equal(out.products[1].price_source, 'catalog_offer', 'timed out, no fleet answer: the stored price');
  assert.equal(out.products[2].price_source, undefined, 'past K: untouched');
  assert.equal(out.products.length, 3);
  assert.equal(out.metadata.live_merchant_price.top_k.cache_fallback_count, 1);
});

test('3d TOP-K respects the per-host budget and backoff: a refused read is not sent, the card falls back', async () => {
  const { host, response } = page(3);
  const fleet = fakeFleet(new Map([[`${host}|1001`, fleetAnswer(15, Date.now() - MIN, 'item-1')]]));
  const admitted = [];
  const hostGate = {
    admit: (h, klass) => { admitted.push([h, klass]); return admitted.length === 1 ? null : 'host_budget'; },
    noteRefusal: () => {},
  };
  const fetched = [];
  const out = await overlay.overlayLiveMerchantSearchPrices(response, {
    market: 'US', priceCache: fleet, hostGate, topK: 2, liveBudgetMs: 600,
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, json: async () => json(1000, 24) }; },
  });
  assert.deepEqual(admitted.map(([, k]) => k), ['search', 'search'], 'every top-K read asks the gate, as the search class');
  assert.equal(fetched.length, 1, 'the refused read was never sent');
  assert.equal(out.products[0].price_source, 'merchant_live');
  assert.equal(out.products[1].price_source, 'merchant_cache', 'refused by the host budget: the fleet answer');
  assert.equal(out.metadata.live_merchant_price.failure_reasons.host_budget, 1);
});

test('3e TOP-K = 0 is the overlay exactly as before (every card read, no top_k metadata)', async () => {
  const run = async (opts) => {
    const { host, response } = page(4, { host: 'same-shape.example.com' });
    const fetched = [];
    const out = await overlay.overlayLiveMerchantSearchPrices(response, {
      market: 'US', ...opts,
      fetchImpl: async (url) => { fetched.push(url); return { ok: true, json: async () => json(Number(url.match(/item-(\d)/)[1]) + 1000, 21) }; },
    });
    return { host, out, fetched };
  };
  const a = await run({});
  overlay._hostBackoff.clear();
  const b = await run({ topK: 0, liveBudgetMs: 150 });
  assert.equal(a.fetched.length, 4);
  assert.equal(JSON.stringify(b.out.products), JSON.stringify(a.out.products));
  assert.equal('top_k' in b.out.metadata.live_merchant_price, false);
});

// ---- 4 + 5. the list contract and staleness ---------------------------------------------------------------

const searchRows = (now) => [
  { product_id: 'live', price: 10, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(now - 5000) },
  { product_id: 'cache', price: 11, currency: 'USD', price_source: 'merchant_cache', price_as_of: iso(now - 4 * MIN) },
  { product_id: 'canon', price: 12, currency: 'USD', price_source: 'catalog_offer', price_as_of: iso(now - 2 * DAY) },
  { product_id: 'seed', price: 13, currency: 'USD', seed_data: { snapshot: { extracted_at: iso(now - 9 * DAY) } } },
  { product_id: 'undated', price: 14, currency: 'USD' },
  { product_id: 'offer', price: 15, currency: 'USD', price_checked_at: iso(now - DAY) },
  { product_id: 'unpriced', price: 0, currency: 'USD' },
];

test('4a FLAGS OFF: the module returns the very same array (nothing is copied, stamped or logged)', () => {
  const rows = searchRows(NOW);
  const lines = [];
  const out = withEnv({}, () => tiers.applyListPriceTiers(rows, { nowMs: NOW, log: (e) => lines.push(e) }));
  assert.equal(out.rows, rows);
  assert.equal(out.summary, null);
  assert.deepEqual(lines, []);
  assert.equal(withEnv({}, () => tiers.listPriceTiersActive()), false);
});

test('4b LIST_ROW_PRICE_AS_OF=on: every row carries price_as_of (ISO UTC or null) and a live | cache | stored token', () => {
  const rows = searchRows(NOW);
  const before = JSON.stringify(rows);
  const { rows: out } = withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => tiers.applyListPriceTiers(rows, { nowMs: NOW }));
  assert.equal(JSON.stringify(rows), before, 'the input rows are never mutated');
  assert.deepEqual(out.map((r) => [r.product_id, r.price_source, r.price_as_of]), [
    ['live', 'live', iso(NOW - 5000)],
    ['cache', 'cache', iso(NOW - 4 * MIN)],
    ['canon', 'stored', iso(NOW - 2 * DAY)],
    ['seed', 'stored', iso(NOW - 9 * DAY)],
    ['undated', 'stored', null],
    ['offer', 'stored', iso(NOW - DAY)],
    ['unpriced', 'stored', null],
  ]);
  for (const r of out) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'price_as_of'));
    assert.ok(r.price_as_of === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.price_as_of));
    assert.equal('price_may_have_changed' in r, false, 'no staleness label without its own flag');
  }
  assert.deepEqual(out.map((r) => r.product_id), rows.map((r) => r.product_id), 'no reorder without the staleness flag');
  // Idempotent: a stamped list stamps to itself.
  const again = withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => tiers.applyListPriceTiers(out, { nowMs: NOW }).rows);
  assert.deepEqual(again, out);
  // A stamp from the future (another clock) dates nothing.
  assert.equal(tiers.priceTierOf({ price: 1, price_as_of: iso(NOW + MIN) }, { nowMs: NOW }).price_as_of, null);
});

test('5a PRICE_STALENESS_DEMOTE=on: a stale row is labelled and falls behind at most two fresh rows (penalty 2.5)', () => {
  const rows = [
    { product_id: 's0', price: 9, price_as_of: iso(NOW - 8 * DAY) },
    { product_id: 'f1', price: 9, price_as_of: iso(NOW - DAY) },
    { product_id: 'f2', price: 9, price_as_of: iso(NOW - DAY) },
    { product_id: 'f3', price: 9, price_as_of: iso(NOW - DAY) },
    { product_id: 'u4', price: 9 },
    { product_id: 'f5', price: 9, price_as_of: iso(NOW - 7 * DAY + MIN) },
  ];
  const { rows: out, summary } = withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => tiers.applyListPriceTiers(rows, { nowMs: NOW }));
  assert.deepEqual(out.map((r) => r.product_id), ['f1', 'f2', 's0', 'f3', 'f5', 'u4']);
  assert.deepEqual(out.filter((r) => r.price_may_have_changed === true).map((r) => r.product_id), ['s0', 'u4'],
    'older than 7 days, or undated: labelled');
  assert.equal(summary.stale, 2);
  assert.equal(summary.undated, 1);
  assert.equal(tiers.STALE_RANK_PENALTY, 2.5);
  assert.equal(tiers.STALE_AFTER_MS, 7 * DAY);
});

test('5b CHEAPEST / PRICE-CAPPED: a stale row is never the answer while a fresh one exists; all stale keeps the order', () => {
  const rows = [
    { product_id: 'stale_cheap', price: 5, price_as_of: iso(NOW - 30 * DAY) },
    { product_id: 'undated', price: 6 },
    { product_id: 'f1', price: 9, price_as_of: iso(NOW - MIN) },
    { product_id: 'f2', price: 8, price_as_of: iso(NOW - DAY) },
  ];
  const { rows: out } = withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => tiers.applyListPriceTiers(rows, { nowMs: NOW, answerGuard: true }));
  assert.deepEqual(out.map((r) => r.product_id), ['f1', 'f2', 'stale_cheap', 'undated'], 'every fresh row ahead of every stale one');
  const allStale = rows.slice(0, 2);
  const kept = withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => tiers.applyListPriceTiers(allStale, { nowMs: NOW, answerGuard: true }));
  assert.deepEqual(kept.rows.map((r) => r.product_id), ['stale_cheap', 'undated'], 'never emptied, order kept');
  assert.equal(kept.summary.no_fresh_row, true);
  for (const q of ['cheapest vitamin c serum', 'the lowest price retinol', 'least expensive SPF', '最便宜的防晒']) assert.equal(tiers.isCheapestQuery(q), true, q);
  for (const q of ['cheap dupe for la mer', 'vitamin c serum', 'lowest ph cleanser']) assert.equal(tiers.isCheapestQuery(q), false, q);
});

test('5c SHADOW: nothing served changes; one counts-only line says what would move (no price, host or id)', () => {
  const rows = searchRows(NOW).map((r) => ({ ...r, destination_url: 'https://secret-host.example.com/products/x' }));
  const lines = [];
  const out = withEnv({ PRICE_STALENESS_DEMOTE: 'shadow' }, () => tiers.applyListPriceTiers(rows, {
    nowMs: NOW, surface: 'search', log: (event, fields) => lines.push({ event, ...fields }),
  }));
  assert.equal(out.rows, rows, 'shadow returns the same array');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'list_price_staleness_shadow');
  assert.equal(lines[0].stale, 2);
  assert.ok(lines[0].moved > 0);
  const text = JSON.stringify(lines);
  for (const leak of ['secret-host', 'products/', 'canon', 'seed', 'price_as_of', '"price"', 'USD']) assert.equal(text.includes(leak), false, leak);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['answer_guard', 'as_of', 'by_source', 'event', 'mode', 'moved', 'no_fresh_row', 'priced', 'rows', 'stale', 'surface', 'top_was_stale', 'undated'],
    'counts and flags only');
});

// ---- 4 + 5 on recommend_products and get_alternatives ------------------------------------------------------

const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
const { makeGetAlternatives } = require('../src/agentSignals/intelligenceReads');

function recoItem(id, amount) {
  return {
    slot: 'treatment', step: 'treatment', brand: 'B', name: `Item ${id}`, display_name: `Item ${id}`,
    reasons: ['fits'], sku: { brand: 'B', name: `Item ${id}`, product_id: id, category: 'Serum' },
    merchant_id: 'm', price: { amount, currency: 'USD', unknown: false }, grounding_status: 'grounded',
  };
}
function recoHandler({ verify }) {
  return makeRecommendProducts({
    generate: async () => ({
      norm: {
        payload: {
          recommendations: [recoItem('sig_a', 30), recoItem('sig_b', 20), recoItem('sig_c', 25)],
          confidence: 0.7, missing_info: [], warnings: [], grounding_status: 'grounded',
          recommendation_meta: { source_mode: 'catalog_grounded' },
        },
      },
    }),
    isEnabled: () => true,
    verifyPrice: verify,
  });
}
const OLD = new Date(Date.now() - 20 * DAY).toISOString();
const VERIFY = async ({ product_id: id }) => {
  if (id === 'sig_a') return { price: 30, currency: 'USD', price_as_of: OLD };
  if (id === 'sig_b') return { price: 20, currency: 'USD', price_as_of: new Date().toISOString(), merchant_live: true };
  return null; // sig_c: unavailable -> the lane's snapshot, undated
};

test('4c recommend_products: flags off, the shortlist is the one served today (no new keys)', async () => {
  const strip = (r) => JSON.stringify(r, (k, v) => (k === 'recommendation_id' || k === 'recommendation_set_id' || k === 'latency_ms' ? undefined : v));
  const off = await withEnv({}, () => recoHandler({ verify: VERIFY })({ payload: { need: 'vitamin c serum', limit: 3 } }, { agent_id: 'a' }));
  const off2 = await withEnv({}, () => recoHandler({ verify: VERIFY })({ payload: { need: 'vitamin c serum', limit: 3 } }, { agent_id: 'a' }));
  assert.equal(strip(off), strip(off2));
  for (const s of off.signals) {
    for (const k of ['price_as_of', 'price_source', 'price_may_have_changed']) assert.equal(k in s.value.product, false, k);
  }
  assert.deepEqual(off.signals.map((s) => s.value.product.product_id), ['sig_a', 'sig_b', 'sig_c']);
});

test('4d + 5d recommend_products: as-of and source per item; stale items demoted; a ceiling guards the answer', async () => {
  const stamped = await withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => recoHandler({ verify: VERIFY })({ payload: { need: 'vitamin c serum', limit: 3 } }, { agent_id: 'a' }));
  assert.deepEqual(stamped.signals.map((s) => [s.value.product.product_id, s.value.product.price_source, s.value.product.price_as_of]), [
    ['sig_a', 'stored', OLD],
    ['sig_b', 'live', stamped.signals[1].value.product.price_as_of],
    ['sig_c', 'stored', null],
  ]);
  assert.ok(Date.parse(stamped.signals[1].value.product.price_as_of) > Date.now() - MIN);
  const on = await withEnv({ LIST_ROW_PRICE_AS_OF: 'on', PRICE_STALENESS_DEMOTE: 'on' }, () => recoHandler({ verify: VERIFY })({ payload: { need: 'vitamin c serum', limit: 3 } }, { agent_id: 'a' }));
  assert.deepEqual(on.signals.map((s) => s.value.product.product_id), ['sig_b', 'sig_a', 'sig_c'], 'penalty: the stale #1 falls behind the fresh #2');
  assert.deepEqual(on.signals.map((s) => s.value.rank), [1, 2, 3], 'ranks are the served order');
  assert.deepEqual(on.signals.map((s) => s.value.product.price_may_have_changed === true), [false, true, true]);
  const capped = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => recoHandler({ verify: VERIFY })({ payload: { need: 'vitamin c serum', constraints: { price_max: 40 }, limit: 3 } }, { agent_id: 'a' }));
  assert.equal(capped.signals[0].value.product.product_id, 'sig_b', 'price-capped: the answer is the fresh item');
  assert.equal(capped.signals[0].value.product.price_may_have_changed, undefined);
  const cheapest = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => recoHandler({ verify: VERIFY })({ payload: { need: 'the cheapest vitamin c serum', limit: 3 } }, { agent_id: 'a' }));
  assert.equal(cheapest.signals[0].value.product.product_id, 'sig_b');
});

const ALT_EDGE = (ref, price, observedAt, score) => ({
  anchor_ref: 'product:sig_anchor', anchor_snapshot: { price: 30, currency: 'USD' },
  candidate_product_ref: ref, candidate_snapshot: { title: ref, brand: 'B', price, currency: 'USD' },
  relation_type: 'competitive_alternative', score_total: score,
  price_evidence: { observed_at: observedAt, price_ratio: price / 30, anchor_price_amount: 30, candidate_price_amount: price },
  source_refs: [], evidence_grade: 'B',
});
const ALT_T0 = Date.now();
function altHandler(log) {
  const edges = [
    ALT_EDGE('product:sig_old', 10, new Date(ALT_T0 - 40 * DAY).toISOString(), 0.95),
    ALT_EDGE('product:sig_new', 12, new Date(ALT_T0 - DAY).toISOString(), 0.9),
    ALT_EDGE('product:sig_mid', 14, new Date(ALT_T0 - 3 * DAY).toISOString(), 0.8),
  ];
  return makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async () => edges.map((e) => structuredClone(e)),
    buildAnchorRefsFromProduct: () => ['product:sig_anchor'],
    isEnabled: () => true,
    log,
  });
}

test('4e + 5e get_alternatives: stored as-of from the edge; flags off byte-identical; max_price_ratio guards the answer', async () => {
  const args = { payload: { product_id: 'sig_anchor', market: 'US' } };
  const off = await withEnv({}, () => altHandler()(args));
  const offAgain = await withEnv({}, () => altHandler()(args));
  assert.equal(JSON.stringify(off), JSON.stringify(offAgain));
  for (const s of off.signals) assert.equal('price_as_of' in s.value.related, false);
  const on = await withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => altHandler()(args));
  assert.deepEqual(on.signals.map((s) => [s.value.related.ref, s.value.related.price_source]), [
    ['product:sig_old', 'stored'], ['product:sig_new', 'stored'], ['product:sig_mid', 'stored'],
  ]);
  for (const s of on.signals) assert.match(s.value.related.price_as_of, /Z$/);
  const lines = [];
  const shadow = await withEnv({ PRICE_STALENESS_DEMOTE: 'shadow' }, () => altHandler((e, f) => lines.push({ e, ...f }))(args));
  assert.equal(JSON.stringify(shadow), JSON.stringify(off), 'shadow serves exactly what off serves');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].surface, 'get_alternatives');
  const ratio = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => altHandler()({ payload: { product_id: 'sig_anchor', market: 'US', max_price_ratio: 1 } }));
  assert.deepEqual(ratio.signals.map((s) => s.value.related.ref), ['product:sig_new', 'product:sig_mid', 'product:sig_old'],
    'equal-or-cheaper ask: the 40-day-old cheapest is never the answer');
  assert.equal(ratio.signals[2].value.related.price_may_have_changed, true);
});

// ---- through the server: search exits, projection, synthetic --------------------------------------------

let app = null;
function server() {
  if (app) return app;
  process.env.NODE_ENV = 'test';
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k];
  app = require('../src/server');
  return app;
}

test('4f SEARCH through the server: every exit of the overlay is stamped (skipped or not); flags off it is untouched', async () => {
  const dbg = server()._debug;
  const t0 = Date.now();
  const response = () => ({
    status: 'success',
    products: [
      { product_id: 'sig_seed', price: 13, currency: 'USD', price_source: 'catalog_offer', seed_data: { snapshot: { extracted_at: iso(t0 - 10 * DAY) } } },
      { product_id: 'sig_fresh', price: 14, currency: 'USD', price_as_of: iso(t0 - DAY) },
    ],
    metadata: { query_source: 'beauty_external_seed_mainline' },
  });
  const off = await withEnv({}, () => dbg.maybeOverlayLiveSearchPrice(response(), { query: 'serum', market: 'US' }, { buyerMarket: 'US' }));
  assert.equal(JSON.stringify(off), JSON.stringify(response()), 'flags off: the overlay is off, the answer untouched');
  const on = await withEnv({ LIST_ROW_PRICE_AS_OF: 'on', PRICE_STALENESS_DEMOTE: 'on' }, () => dbg.maybeOverlayLiveSearchPrice(response(), { query: 'serum', market: 'US' }, { buyerMarket: 'US' }));
  assert.deepEqual(on.products.map((p) => [p.product_id, p.price_source, p.price_may_have_changed === true]), [
    ['sig_fresh', 'stored', false], ['sig_seed', 'stored', true],
  ]);
  assert.equal(on.metadata.price_staleness.stale_count, 1);
  // Applied once: an answer that already carries price_staleness is not reordered again.
  const twice = await withEnv({ LIST_ROW_PRICE_AS_OF: 'on', PRICE_STALENESS_DEMOTE: 'on' }, () => dbg.maybeOverlayLiveSearchPrice(on, { query: 'serum', market: 'US' }, {}));
  assert.equal(twice, on);
  // A price-capped search guards its answer.
  const capped = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => dbg.maybeOverlayLiveSearchPrice({
    ...response(), products: [response().products[0], { ...response().products[1] }, { product_id: 'sig_f2', price: 9, currency: 'USD', price_as_of: iso(t0) }],
  }, { query: 'serum under $20', market: 'US', price_max: 20 }, {}));
  assert.equal(capped.products[0].product_id, 'sig_fresh');
  assert.equal(capped.metadata.price_staleness.answer_guard, true);
});

test('4g SEARCH TRANSPORT PROJECTION: the token and label are projected; an internal price_source never is', () => {
  const dbg = server()._debug;
  const liveAt = iso(Date.now() - 1000);
  const body = () => ({
    status: 'success',
    products: [
      { product_id: 'p1', title: 'One', price: 9, currency: 'USD', price_source: 'merchant_live', price_as_of: liveAt },
      { product_id: 'p2', title: 'Two', price: 8, currency: 'USD', price_source: 'catalog_offer' },
    ],
    metadata: {},
  });
  const off = withEnv({}, () => dbg.projectFindProductsMultiTransportResponse(body(), { operation: 'find_products_multi' }));
  assert.deepEqual(off.products.map((p) => [p.price_source, p.price_as_of]), [[undefined, body().products[0].price_as_of], [undefined, undefined]]);
  const on = withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => dbg.projectFindProductsMultiTransportResponse(body(), { operation: 'find_products_multi', search: { query: 'cable' } }));
  assert.deepEqual(on.products.map((p) => [p.price_source, p.price_as_of === null ? null : typeof p.price_as_of]), [['live', 'string'], ['stored', null]]);
});

test('3f SYNTHETIC through the server: with top-K and read mode set, a synthetic search makes no live read and no cache read', async () => {
  const a = server();
  const fetched = [];
  a._debug.useSearchOverlayFetchForTest(async (url) => { fetched.push(url); return { ok: true, json: async () => json(Number(url.match(/item-(\d)/)[1]) + 1000, 22) }; });
  try {
    const { response } = page(2);
    const env = { SERVE_LIVE_MERCHANT_PRICE: 'on', UCP_LIVE_SEARCH_READ_TOP_K: '3', LIST_ROW_PRICE_AS_OF: 'on' };
    const synthetic = await withEnv(env, () => INVOKE_AUTH_CONTEXT.run({ synthetic: true }, () => a._debug.maybeOverlayLiveSearchPrice(
      JSON.parse(JSON.stringify(response)), { query: 'serum', market: 'US' }, { buyerMarket: 'US' },
    )));
    assert.deepEqual(fetched, [], 'no merchant read for a synthetic call');
    assert.deepEqual(synthetic.products.map((p) => p.price_source), ['stored', 'stored']);
    const real = await withEnv(env, () => a._debug.maybeOverlayLiveSearchPrice(JSON.parse(JSON.stringify(response)), { query: 'serum', market: 'US' }, { buyerMarket: 'US' }));
    assert.equal(fetched.length, 2, 'a real call reads (no UCP reader enforcing here, so K does not apply)');
    assert.deepEqual(real.products.map((p) => p.price_source), ['live', 'live']);
  } finally {
    a._debug.useSearchOverlayFetchForTest(null);
  }
});

test('4h PRICE LINE: a fleet-cache answer and the list tokens live / cache count as merchant answers; stored does not', () => {
  const { priceFactOf } = require('../src/observability/priceVerificationFacts');
  const at = iso(NOW - MIN);
  for (const source of ['merchant_live', 'merchant_cache', 'live', 'cache']) {
    assert.equal(priceFactOf({ price: 9, price_source: source, price_as_of: at }).merchant, true, source);
  }
  for (const source of ['stored', 'catalog_offer', undefined]) {
    assert.equal(priceFactOf({ price: 9, price_source: source, price_as_of: at }).merchant, false, String(source));
  }
});
