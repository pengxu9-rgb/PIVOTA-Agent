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
  // Read mode: instance A wrote $23; another instance may have written since, so A's repeat asks the STORE (in the
  // background) and writes only when the store holds something else.
  const r = cacheHarness({ read: true });
  assert.equal(r.cache.recordVerifiedPrice(VERIFIED), true);
  await r.store.flush();
  const batchesAfterFirst = r.fake.calls.batches.length;
  r.clock.add(4 * MIN);
  const readsBefore = r.fake.calls.getAll.length;
  assert.equal(r.cache.recordVerifiedPrice(VERIFIED), false, 'read mode: not written at once');
  for (let i = 0; i < 5; i += 1) await new Promise((res) => setImmediate(res));
  await r.store.flush();
  assert.equal(r.fake.calls.getAll.length, readsBefore + 1, 'one store read checked it');
  assert.equal(r.fake.calls.batches.length, batchesAfterFirst, 'the store holds this answer: nothing written');
  // Another instance writes $25 into the store; A's repeat of $23 inside 5 min is then written.
  const other = pc.createPriceCache({ store: r.store, now: r.clock.now, read: () => false });
  r.clock.add(MIN);
  other.recordVerifiedPrice({ ...VERIFIED, amount: 25, read_at: r.clock.now() - 1 });
  await r.store.flush();
  r.clock.add(31 * 1000);
  const batches2 = r.fake.calls.batches.length;
  r.cache.recordVerifiedPrice({ ...VERIFIED, read_at: r.clock.now() });
  for (let i = 0; i < 5; i += 1) await new Promise((res) => setImmediate(res));
  await r.store.flush();
  assert.ok(r.fake.calls.batches.length > batches2, 'the store held another answer: A writes its own');
  // An answer the STORE just gave this instance (inside the 30 s L1 window) is not repeated, nor even checked.
  r.clock.add(31 * 1000);
  const got = await r.cache.lookup([VKEY], { ttlMs: pc.TTL_MS.search });
  assert.equal(got[0].amount, 23);
  r.clock.add(10 * 1000);
  const later = { ...VERIFIED, read_at: r.clock.now() };
  const readsNow = r.fake.calls.getAll.length;
  assert.equal(r.cache.recordVerifiedPrice(later), false, 'the store holds this answer (read 10 s ago): skipped');
  for (let i = 0; i < 5; i += 1) await new Promise((res) => setImmediate(res));
  assert.equal(r.fake.calls.getAll.length, readsNow, 'vouched for by a fresh store read: no check either');
});

test('1e READ MODE write volume: an unchanged hot key re-recorded every 40 s for 10 min writes as often as write mode', async () => {
  const count = async (read) => {
    const h = cacheHarness({ read });
    let writes = 0;
    for (let t = 0; t <= 10 * MIN; t += 40 * 1000) {
      const before = h.fake.calls.batches.flat().length;
      h.cache.recordVerifiedPrice({ ...VERIFIED, read_at: h.clock.now() });
      for (let i = 0; i < 5; i += 1) await new Promise((res) => setImmediate(res));
      await h.store.flush();
      writes += h.fake.calls.batches.flat().length - before;
      h.clock.add(40 * 1000);
    }
    return writes;
  };
  const w = await count(false);
  const r = await count(true);
  assert.ok(r <= w, `read mode wrote ${r}, write mode ${w}`);
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
  assert.deepEqual(Object.keys(lines[0]).sort(), ['answer_guard', 'as_of', 'by_source', 'event', 'mode', 'moved', 'no_fresh_row', 'priced', 'reordered', 'rows', 'stale', 'surface', 'top_was_stale', 'undated'],
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
// THE VERIFY ANSWERS ARE BUILT BY THE REAL PRODUCERS: a get_pdp_v2 page from pdpBuilder, the PDP live overlay
// (applyPdpLiveOverlay over its own cache, which the merchant answered PDP_READ_AGO before this call), the
// gateway's own normalizePdpV2ToProductDetail, then the wiring's mapper (verifyPriceAnswerOfPdpProduct).
const { applyPdpLiveOverlay, createPdpLiveCache } = require('../src/services/pdpLiveOverlay');
const { buildPdpPayload } = require('../src/pdpBuilder');
const { verifyPriceAnswerOfPdpProduct } = require('../src/agentSignals/recommendProducts');
const PDP_HOST = 'tiers-pdp.example.com';
const PDP_READ_AGO = 2 * MIN;
const OLD = new Date(Date.now() - 20 * DAY).toISOString();
const PDP_VARIANT = '48087970185268';
const pdpHandle = (id) => `item-${id.replace(/_/g, '-')}`;
function pdpPage(id, amount, { priceAsOf } = {}) {
  const variant = { variant_id: PDP_VARIANT, title: 'One', options: [{ name: 'Size', value: 'One' }], price: { amount, currency: 'USD' }, in_stock: true, inventory_quantity: 3 };
  const product = {
    product_id: id, merchant_id: 'merch_obs_tiers', source: 'external_seed', title: `Item ${id}`, image_url: 'https://cdn.example/x.jpg',
    price: { amount, currency: 'USD' }, currency: 'USD', destination_url: `https://${PDP_HOST}/products/${pdpHandle(id)}`,
    default_variant_id: PDP_VARIANT, variants: [variant],
  };
  const pdp = buildPdpPayload({ product, relatedProducts: [], entryPoint: 'agent' });
  // The canonical lane's stored as-of (CANONICAL_CATALOG_SERVED_PRICE_AS_OF) rides on the card as built.
  if (priceAsOf) pdp.product = { ...pdp.product, price_as_of: priceAsOf };
  return { status: 'success', pdp_version: '2.0', modules: [{ type: 'canonical', required: true, data: { pdp_payload: pdp } }], metadata: {} };
}
function overlaid(id, amount, merchantAmount) {
  let t = Date.now() - PDP_READ_AGO;
  const cache = createPdpLiveCache({ now: () => t });
  cache.record({
    status: 'verified', host: PDP_HOST, country: 'US', currency: 'USD',
    live: new Map([[PDP_VARIANT, { handle: pdpHandle(id), amount: merchantAmount, currency: 'USD', available: true }]]),
    notFound: new Set(), askedIds: [PDP_VARIANT],
  });
  t = Date.now();
  const out = applyPdpLiveOverlay(pdpPage(id, amount, { priceAsOf: OLD }), { market: 'US', cache });
  assert.ok(out, 'the overlay served the merchant answer');
  return out.payload;
}
let PDP_BODIES = null;
function pdpBodies() {
  if (!PDP_BODIES) {
    PDP_BODIES = {
      sig_a: pdpPage('sig_a', 30, { priceAsOf: OLD }), // stored, 20 days old (canonical as-of)
      sig_b: overlaid('sig_b', 21, 20), // the merchant's answer from the overlay's cache, read 2 min ago
    };
  }
  return PDP_BODIES;
}
const VERIFY = async ({ product_id: id }) => {
  const body = pdpBodies()[id];
  if (!body) return null; // sig_c: unavailable -> the lane's snapshot, undated
  const { product } = server()._debug.normalizePdpV2ToProductDetail(body);
  return verifyPriceAnswerOfPdpProduct(product);
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

test('4d0 the verify mapper: a merchant-priced PDP is dated by the overlay\'s read (live_read.checked_at), never the stored as-of beside it', () => {
  const merchant = server()._debug.normalizePdpV2ToProductDetail(pdpBodies().sig_b).product;
  assert.equal(merchant.price_source, 'merchant_live');
  assert.equal(merchant.price_as_of, OLD, 'the real card keeps the canonical stored as-of beside the merchant price');
  const a = verifyPriceAnswerOfPdpProduct(merchant);
  assert.equal(a.merchant_live, true);
  assert.equal(a.price, 20);
  assert.equal(a.price_as_of, merchant.live_read.checked_at);
  assert.ok(Math.abs(Date.parse(a.price_as_of) - (Date.now() - PDP_READ_AGO)) < 5000, 'when the merchant answered');
  const stored = verifyPriceAnswerOfPdpProduct(server()._debug.normalizePdpV2ToProductDetail(pdpBodies().sig_a).product);
  assert.equal(stored.price, 30);
  assert.equal(stored.price_as_of, OLD, 'a stored PDP price: the page\'s own stored as-of');
  assert.equal('merchant_live' in stored, false);
});

test('4d + 5d recommend_products: as-of and source per item; stale items demoted; a ceiling guards the answer', async () => {
  const stamped = await withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => recoHandler({ verify: VERIFY })({ payload: { need: 'vitamin c serum', limit: 3 } }, { agent_id: 'a' }));
  const bAsOf = server()._debug.normalizePdpV2ToProductDetail(pdpBodies().sig_b).product.live_read.checked_at;
  assert.deepEqual(stamped.signals.map((s) => [s.value.product.product_id, s.value.product.price_source, s.value.product.price_as_of]), [
    ['sig_a', 'stored', OLD],
    // The PDP overlay answered from its 10-min cache: a merchant answer, but not read during this call.
    ['sig_b', 'cache', bAsOf],
    ['sig_c', 'stored', null],
  ]);
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

test('5f recommend_products with a ceiling: a known violator never outranks a conforming item, however fresh', async () => {
  // A $30 and a $35 item, both priced 20 days ago; a $55 item the merchant just answered; ceiling $40.
  const items = [recoItem('sig_ca', 30), recoItem('sig_cb', 35), recoItem('sig_cc', 55)];
  const verify = async ({ product_id: id }) => (id === 'sig_cc'
    ? { price: 55, currency: 'USD', price_as_of: new Date().toISOString(), merchant_live: true }
    : { price: id === 'sig_ca' ? 30 : 35, currency: 'USD', price_as_of: OLD });
  const h = makeRecommendProducts({
    generate: async () => ({ norm: { payload: { recommendations: items, confidence: 0.7, missing_info: [], warnings: [], grounding_status: 'grounded', recommendation_meta: { source_mode: 'catalog_grounded' } } } }),
    isEnabled: () => true,
    verifyPrice: verify,
  });
  const args = { payload: { need: 'vitamin c serum', constraints: { price_max: 40 }, limit: 3 } };
  const off = await withEnv({}, () => h(args, { agent_id: 'a' }));
  const on = await withEnv({ PRICE_STALENESS_DEMOTE: 'on', LIST_ROW_PRICE_AS_OF: 'on' }, () => h(args, { agent_id: 'a' }));
  assert.deepEqual(off.signals.map((s) => s.value.product.product_id), ['sig_ca', 'sig_cb', 'sig_cc']);
  assert.deepEqual(on.signals.map((s) => s.value.product.product_id), ['sig_ca', 'sig_cb', 'sig_cc'], 'the violator stays last');
  assert.ok(on.signals[2].value.constraint_violations, 'and stays marked');
  assert.equal(on.signals[2].value.product.price_source, 'live');
  // Inside the conforming rung, freshness still orders: a fresh conforming item outranks a stale one.
  const verify2 = async ({ product_id: id }) => (id === 'sig_cb'
    ? { price: 35, currency: 'USD', price_as_of: new Date().toISOString(), merchant_live: true }
    : { price: id === 'sig_ca' ? 30 : 55, currency: 'USD', price_as_of: OLD });
  const h2 = makeRecommendProducts({
    generate: async () => ({ norm: { payload: { recommendations: items.map((x) => ({ ...x })), confidence: 0.7, missing_info: [], warnings: [], grounding_status: 'grounded', recommendation_meta: { source_mode: 'catalog_grounded' } } } }),
    isEnabled: () => true,
    verifyPrice: verify2,
  });
  const on2 = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => h2(args, { agent_id: 'a' }));
  assert.deepEqual(on2.signals.map((s) => s.value.product.product_id), ['sig_cb', 'sig_ca', 'sig_cc']);
});

// price_evidence.observed_at is a ROW-WRITE time (the build's updated_at / build time), and dates nothing; the
// price read is candidate_snapshot.price_checked_at, which the graph build copies (see 4i).
const ALT_EDGE = (ref, price, observedAt, score, priceCheckedAt) => ({
  anchor_ref: 'product:sig_anchor', anchor_snapshot: { price: 30, currency: 'USD' },
  candidate_product_ref: ref,
  candidate_snapshot: { title: ref, brand: 'B', price, currency: 'USD', ...(priceCheckedAt ? { price_checked_at: priceCheckedAt } : {}) },
  relation_type: 'competitive_alternative', score_total: score,
  price_evidence: { observed_at: observedAt, price_ratio: price / 30, anchor_price_amount: 30, candidate_price_amount: price },
  source_refs: [], evidence_grade: 'B',
});
const ALT_T0 = Date.now();
function altHandler(log, { reorderAllowed } = {}) {
  const fresh = new Date(ALT_T0 - DAY).toISOString();
  const edges = [
    // Price read 40 days ago, on a row the build wrote yesterday.
    ALT_EDGE('product:sig_old', 10, fresh, 0.95, new Date(ALT_T0 - 40 * DAY).toISOString()),
    ALT_EDGE('product:sig_new', 12, fresh, 0.9, fresh),
    ALT_EDGE('product:sig_mid', 14, fresh, 0.8, new Date(ALT_T0 - 3 * DAY).toISOString()),
    // No price read on record: undated, whatever observed_at says.
    ALT_EDGE('product:sig_undated', 9, fresh, 0.7),
  ];
  return makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async () => edges.map((e) => structuredClone(e)),
    buildAnchorRefsFromProduct: () => ['product:sig_anchor'],
    isEnabled: () => true,
    log,
    ...(reorderAllowed ? { reorderAllowed } : {}),
  });
}

test('4e + 5e get_alternatives: stored as-of from the edge; flags off byte-identical; max_price_ratio guards the answer', async () => {
  const args = { payload: { product_id: 'sig_anchor', market: 'US' } };
  const off = await withEnv({}, () => altHandler()(args));
  const offAgain = await withEnv({}, () => altHandler()(args));
  assert.equal(JSON.stringify(off), JSON.stringify(offAgain));
  for (const s of off.signals) assert.equal('price_as_of' in s.value.related, false);
  const on = await withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => altHandler()(args));
  assert.deepEqual(on.signals.map((s) => [s.value.related.ref, s.value.related.price_source, s.value.related.price_as_of]), [
    ['product:sig_old', 'stored', new Date(ALT_T0 - 40 * DAY).toISOString()],
    ['product:sig_new', 'stored', new Date(ALT_T0 - DAY).toISOString()],
    ['product:sig_mid', 'stored', new Date(ALT_T0 - 3 * DAY).toISOString()],
    ['product:sig_undated', 'stored', null],
  ], 'dated by the price read only; observed_at (a write time, 1 day) never dates a price');
  const lines = [];
  const shadow = await withEnv({ PRICE_STALENESS_DEMOTE: 'shadow' }, () => altHandler((e, f) => lines.push({ e, ...f }))(args));
  assert.equal(JSON.stringify(shadow), JSON.stringify(off), 'shadow serves exactly what off serves');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].surface, 'get_alternatives');
  const ratio = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => altHandler()({ payload: { product_id: 'sig_anchor', market: 'US', max_price_ratio: 1 } }));
  assert.deepEqual(ratio.signals.map((s) => s.value.related.ref), ['product:sig_new', 'product:sig_mid', 'product:sig_old', 'product:sig_undated'],
    'equal-or-cheaper ask: the 40-day-old cheapest is never the answer, nor the undated one');
  assert.equal(ratio.signals[2].value.related.price_may_have_changed, true);
  assert.equal(ratio.signals[3].value.related.price_may_have_changed, true);
  // The public tier's projection drops the label: labelled, never reordered there.
  const pub = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => altHandler(undefined, { reorderAllowed: () => false })({ payload: { product_id: 'sig_anchor', market: 'US', max_price_ratio: 1 } }));
  assert.deepEqual(pub.signals.map((s) => s.value.related.ref), off.signals.map((s) => s.value.related.ref));
});

test('4i GRAPH BUILD: the candidate snapshot carries the seed\'s price READ time (flag on), never a write time', () => {
  const sources = require('../src/auroraBff/productRelationshipGraphSources');
  const { buildEdgeForCandidate } = require('../src/auroraBff/productRelationshipGraphBuilder');
  const readAt = '2026-10-01T08:00:00.000Z';
  const anchor = { product_ref: 'product:sig_anchor', product_key: 'anchor', name: 'Gentle Hyaluronic Face Serum',
    brand: 'House', category: 'Face Serum', description: 'Gentle hydrating hyaluronic acid serum', price: 40, price_currency: 'USD' };
  const seedRow = {
    id: 'eps_t1', external_product_id: 'ext_t1', product_ref: 'product:sig_t1', title: 'Gentle Hyaluronic Face Serum',
    brand: 'Brand T', category: 'Face Serum', description: 'Gentle hydrating hyaluronic acid serum',
    price_amount: '25.00', price_currency: 'USD', market: 'US',
    updated_at: '2026-11-07T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
    seed_data: { brand: 'Brand T', category: 'Face Serum', snapshot: { price_amount: '25.00', price_currency: 'USD', extracted_at: readAt } },
  };
  const off = withEnv({}, () => sources.normalizeProductCandidateSnapshot(seedRow, { sourceType: 'external_product_seeds' }));
  assert.equal('price_checked_at' in off, false, 'off: the snapshot is exactly as before');
  process.env.RELGRAPH_CANDIDATE_PRICE_CHECKED_AT = 'on';
  try {
    const on = sources.normalizeProductCandidateSnapshot(seedRow, { sourceType: 'external_product_seeds' });
    assert.equal(on.price_checked_at, readAt);
    assert.notEqual(on.price_observed_at, readAt, 'price_observed_at stays the write-time fallback it always was');
    const { price_checked_at: _drop, ...rest } = on;
    assert.deepEqual(rest, off, 'the one key it adds');
    const noRead = sources.normalizeProductCandidateSnapshot({ ...seedRow, seed_data: { ...seedRow.seed_data, snapshot: { price_amount: '25.00' } } }, { sourceType: 'external_product_seeds' });
    assert.equal('price_checked_at' in noRead, false, 'no read on record: no field (undated)');
    const [candidate] = sources.buildCandidatesByAnchorFromSources({ anchors: [anchor], products: [on], includeTransitiveRecall: false })[anchor.product_ref];
    const { edge } = buildEdgeForCandidate({ anchor, candidate, nowIso: '2026-11-08T00:00:00.000Z' });
    assert.ok(edge && edge.candidate_snapshot, 'the builder made the edge');
    assert.equal(edge.candidate_snapshot.price_checked_at, readAt, 'the edge snapshot keeps it');
    assert.notEqual(edge.price_evidence && edge.price_evidence.observed_at, readAt);
  } finally {
    delete process.env.RELGRAPH_CANDIDATE_PRICE_CHECKED_AT;
  }
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

// ---- review round 1 (P2-1, P3-1, P3-2, P3-6, P3-7) ---------------------------------------------------------

test('3g TOP-K FALLBACK only when the read got no answer: a merchant that answered (gone, variant missing) is never overridden by the cache', async () => {
  const storefrontProductPage = require('../src/services/storefrontProductPage');
  storefrontProductPage.resetForTests();
  const { host, response } = page(3);
  const fleet = fakeFleet(new Map([
    [`${host}|1000`, fleetAnswer(11, Date.now() - MIN, 'item-0')], // gone in this request
    [`${host}|1001`, fleetAnswer(12, Date.now() - MIN, 'item-1')], // variant missing in this request
    [`${host}|1002`, fleetAnswer(13, Date.now() - MIN, 'item-2')], // a 503 in this request: falls back
  ]));
  const fetchImpl = async (url) => {
    if (url.includes('item-0')) return new Response('{"errors":"Not Found"}', { status: 404, headers: { 'powered-by': 'Shopify' } });
    if (url.includes('item-1')) return { ok: true, json: async () => json(9999, 22) };
    return { ok: false, status: 503, headers: { get: () => null } };
  };
  const out = await overlay.overlayLiveMerchantSearchPrices(response, { market: 'US', priceCache: fleet, topK: 3, liveBudgetMs: 600, fetchImpl });
  assert.deepEqual(out.products.map((p) => [p.price_source, p.price]), [
    ['catalog_offer', 20], // gone: keeps the verdict, never the fleet's answer
    ['catalog_offer', 20], // the merchant answered without this variant
    ['merchant_cache', 13], // no answer (503): the fleet's
  ]);
  assert.equal(out.metadata.live_merchant_price.gone_count, 1);
  assert.equal(out.metadata.live_merchant_price.top_k.cache_fallback_count, 1);
  storefrontProductPage.resetForTests();
});

test('2b P2-1 LIVE MEANS THIS REQUEST: a merchant answer read before the request started is `cache`, price_as_of kept', async () => {
  const t = NOW;
  const rows = [
    { product_id: 'now', price: 9, price_source: 'merchant_live', price_as_of: iso(t - 200) },
    { product_id: 'page_cache', price: 9, price_source: 'merchant_live', price_as_of: iso(t - 90 * 1000) },
    { product_id: 'token_live_old', price: 9, price_source: 'live', price_as_of: iso(t - 5 * MIN) },
    { product_id: 'undated_merchant', price: 9, price_source: 'merchant_live' },
  ];
  const out = withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => tiers.applyListPriceTiers(rows, { nowMs: t, liveFromMs: t - 1000 }).rows);
  assert.deepEqual(out.map((r) => [r.price_source, r.price_as_of]), [
    ['live', iso(t - 200)], ['cache', iso(t - 90 * 1000)], ['cache', iso(t - 5 * MIN)], ['cache', null],
  ]);
  // No request start known: within the last 30 s.
  const fb = withEnv({ LIST_ROW_PRICE_AS_OF: 'on' }, () => tiers.applyListPriceTiers(rows, { nowMs: t }).rows);
  assert.deepEqual(fb.map((r) => r.price_source), ['live', 'cache', 'cache', 'cache']);
  // A door replay: `live` rows read before the call are relabelled; the same array when nothing changes.
  const stamped = [{ price_source: 'live', price_as_of: iso(t - 10) }, { price_source: 'live', price_as_of: iso(t - MIN) }, { price_source: 'stored', price_as_of: null }];
  assert.deepEqual(tiers.relabelReplayedRows(stamped, { liveFromMs: t - 1000 }).map((r) => r.price_source), ['live', 'cache', 'stored']);
  const none = [{ price_source: 'merchant_live', price_as_of: iso(t - MIN) }];
  assert.equal(tiers.relabelReplayedRows(none, { liveFromMs: t }), none, 'internal names (flags off) are never touched');
});

test('2c P2-1 through the server: a search served from this instance\'s `.json` page cache is `cache` on the next request', async () => {
  const a = server();
  a._debug.useSearchOverlayFetchForTest(async (url) => ({ ok: true, json: async () => json(Number(url.match(/item-(\d)/)[1]) + 1000, 22) }));
  try {
    const { response } = page(1, { host: 'page-cache-tiers.example.com' });
    const env = { SERVE_LIVE_MERCHANT_PRICE: 'on', LIST_ROW_PRICE_AS_OF: 'on' };
    const first = await withEnv(env, () => a._debug.maybeOverlayLiveSearchPrice(JSON.parse(JSON.stringify(response)), { query: 'serum', market: 'US' }, { buyerMarket: 'US' }));
    assert.equal(first.products[0].price_source, 'live');
    await new Promise((res) => setTimeout(res, 1100));
    const second = await withEnv(env, () => a._debug.maybeOverlayLiveSearchPrice(JSON.parse(JSON.stringify(response)), { query: 'serum', market: 'US' }, { buyerMarket: 'US' }));
    assert.equal(second.metadata.live_merchant_price.cache_hit_count, 1, 'answered from the page cache');
    assert.equal(second.products[0].price_source, 'cache');
    assert.equal(second.products[0].price_as_of, first.products[0].price_as_of, 'dated by the original read');
  } finally {
    a._debug.useSearchOverlayFetchForTest(null);
  }
});

test('5g P3-7 SHADOW WITH AS-OF ON: rows are stamped, never reordered or labelled', () => {
  const rows = [
    { product_id: 's0', price: 9, price_as_of: iso(NOW - 8 * DAY) },
    { product_id: 'f1', price: 9, price_as_of: iso(NOW - DAY) },
    { product_id: 'f2', price: 9, price_as_of: iso(NOW - DAY) },
  ];
  const lines = [];
  const out = withEnv({ LIST_ROW_PRICE_AS_OF: 'on', PRICE_STALENESS_DEMOTE: 'shadow' }, () => tiers.applyListPriceTiers(rows, { nowMs: NOW, log: (e, f) => lines.push(f) }));
  assert.deepEqual(out.rows.map((r) => r.product_id), ['s0', 'f1', 'f2']);
  assert.deepEqual(out.rows.map((r) => r.price_source), ['stored', 'stored', 'stored']);
  assert.equal(out.rows.some((r) => 'price_may_have_changed' in r), false);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].moved > 0);
  assert.equal(lines[0].reordered, false);
});

test('5h GROUPS and REORDER: rows move only inside their group; reorder:false labels without moving', () => {
  const t = (stale) => ({ stale });
  // groups: [ok, ok, violation]; the violation is fresh, both ok rows stale.
  assert.deepEqual(tiers.stalenessOrder([t(true), t(true), t(false)], { answerGuard: true, groups: ['ok', 'ok', 'violation'] }), [0, 1, 2]);
  assert.deepEqual(tiers.stalenessOrder([t(true), t(false), t(false)], { answerGuard: true, groups: ['ok', 'ok', 'violation'] }), [1, 0, 2]);
  assert.deepEqual(tiers.stalenessOrder([t(true), t(false), t(false), t(false)], { groups: ['a', 'a', 'a', 'b'] }), [1, 2, 0, 3], 'the penalty counts inside the group');
  const rows = [{ product_id: 's', price: 9 }, { product_id: 'f', price: 9, price_as_of: iso(NOW) }];
  const kept = withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => tiers.applyListPriceTiers(rows, { nowMs: NOW, reorder: false }));
  assert.deepEqual(kept.rows.map((r) => [r.product_id, r.price_may_have_changed === true]), [['s', true], ['f', false]]);
  assert.equal(kept.summary.reordered, false);
  // The door orders by the label it serves.
  assert.deepEqual(tiers.orderByStalenessLabel(kept.rows).map((r) => r.product_id), ['f', 's']);
  const fresh = [{ product_id: 'a' }, { product_id: 'b' }];
  assert.equal(tiers.orderByStalenessLabel(fresh), fresh);
});

test('4j P3-1/P3-2 SEARCH through the server: one shadow line per search; a loopback search (an MCP door\'s) is labelled, not reordered', async () => {
  const a = server();
  const logger = require('../src/logger');
  const original = logger.info;
  const lines = [];
  logger.info = (obj, msg) => { if (obj && obj.event === 'list_price_staleness_shadow') lines.push(obj); return undefined; };
  const t0 = Date.now();
  const body = () => ({
    status: 'success',
    products: [
      { product_id: 'p_stale', title: 'S', price: 9, currency: 'USD', price_source: 'catalog_offer', seed_data: { snapshot: { extracted_at: iso(t0 - 20 * DAY) } } },
      { product_id: 'p_fresh', title: 'F', price: 8, currency: 'USD', price_as_of: iso(t0 - DAY) },
    ],
    metadata: {},
  });
  try {
    const shadowed = await withEnv({ PRICE_STALENESS_DEMOTE: 'shadow' }, async () => {
      const r = await a._debug.maybeOverlayLiveSearchPrice(body(), { query: 'serum' }, {});
      return a._debug.projectFindProductsMultiTransportResponse({ ...r, metadata: { ...(r.metadata || {}) } }, { operation: 'find_products_multi' });
    });
    assert.equal(lines.length, 1, 'the overlay exit and the projection share one line');
    assert.deepEqual(shadowed.products.map((p) => p.product_id), ['p_stale', 'p_fresh']);
    const loop = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => a._debug.__agentCheckoutStrict.runInInvokeAuthContextForTest({ loopback_self_call: true },
      () => a._debug.maybeOverlayLiveSearchPrice(body(), { query: 'serum' }, {})));
    assert.deepEqual(loop.products.map((p) => [p.product_id, p.price_may_have_changed === true]), [['p_stale', true], ['p_fresh', false]]);
    assert.equal(loop.metadata.price_staleness.reordered, false);
    const direct = await withEnv({ PRICE_STALENESS_DEMOTE: 'on' }, () => a._debug.__agentCheckoutStrict.runInInvokeAuthContextForTest({ loopback_self_call: false },
      () => a._debug.maybeOverlayLiveSearchPrice(body(), { query: 'serum' }, {})));
    assert.deepEqual(direct.products.map((p) => p.product_id), ['p_fresh', 'p_stale']);
    assert.equal(direct.metadata.price_staleness.reordered, true);
  } finally {
    logger.info = original;
  }
});

test('4k P3-8 the projection allowlist is gated: flags off, a token arriving from upstream is not projected', () => {
  const dbg = server()._debug;
  const body = { status: 'success', products: [{ product_id: 'p', title: 'T', price: 9, currency: 'USD', price_source: 'live', price_may_have_changed: true }], metadata: {} };
  const off = withEnv({}, () => dbg.projectFindProductsMultiTransportResponse(JSON.parse(JSON.stringify(body)), { operation: 'find_products_multi' }));
  assert.equal('price_source' in off.products[0], false);
  assert.equal('price_may_have_changed' in off.products[0], false);
});
