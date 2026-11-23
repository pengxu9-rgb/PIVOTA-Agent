'use strict';

// THE SHARED PRICE CACHE'S WINDOW IS 10 MINUTES (src/services/priceCache.js MAX_PRICE_WINDOW_MS), the limit Shopify
// publishes for keeping a price or availability answer (usage guidelines, shopify.dev/docs/agents/catalog, read
// 2026-11-23; ADR-031 requires it before the cache is ever turned on). The door caches' price-freshness cap
// (src/observability/priceVerificationFacts.js DOOR_CAP_WINDOW_MS) keeps to the same limit. Four pins:
//   1. the window is exactly 600,000 ms everywhere the cache stores or serves a price;
//   2. no env var raises it (a fresh module load with every env var the cache's modules name set to a day);
//   3. under PRICE_CACHE_STORE=firestore + PRICE_CACHE_MODE=read (the real flags, the process cache), an answer the
//      store still holds from 11 minutes ago is NOT served, to a lookup or to search; one from 9 minutes ago is;
//   4. the door caches' cap is the same 600,000 ms: an entry ends when its merchant answer is 10 minutes old, and
//      one already that old is not stored (through the real doors: recommendation_price_tiers_door_cache).
// Nothing leaves the process: the store is the Firestore fake and the storefront is a fake fetch. Every host,
// handle and product here is a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const CACHE_FLAGS = ['PRICE_CACHE_STORE', 'PRICE_CACHE_MODE', 'PRICE_CACHE_FIRESTORE_PROJECT', 'PRICE_CACHE_FIRESTORE_DATABASE'];
for (const k of CACHE_FLAGS) delete process.env[k];

const MIN = 60 * 1000;
const TEN_MINUTES_MS = 600000;
const DAY_MS = 24 * 60 * MIN;

const pc = require('../src/services/priceCache');
const overlay = require('../src/services/liveMerchantSearchPrice');
const facts = require('../src/observability/priceVerificationFacts');
const { createFirestorePriceCacheStore } = require('../src/services/priceCacheStore');
const { createFakeFirestore } = require('./_support/fakeFirestore.cjs');

const HOST = 'window-pin.example.com';
const key = (variantId) => ({ host: HOST, market: 'US', variant_id: String(variantId), currency: 'USD' });
const verified = (variantId, extra = {}) => ({ ...key(variantId), amount: 20, available: true, source: 'merchant_ucp', writer: 'search', ...extra });

test('PIN: the window is exactly 10 minutes wherever the cache stores or serves a price', () => {
  assert.equal(pc.MAX_PRICE_WINDOW_MS, TEN_MINUTES_MS);
  assert.equal(pc.HARD_EXPIRY_MS, TEN_MINUTES_MS);
  assert.equal(overlay.SHARED_TTL_MS, TEN_MINUTES_MS, 'search, the one consumer');
  assert.deepEqual({ ...pc.TTL_MS }, { search: TEN_MINUTES_MS, recommend: TEN_MINUTES_MS, get_product: TEN_MINUTES_MS, pdp: TEN_MINUTES_MS, get_offers: 0, cart: 0 });
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  // What a writer stores: expire_at = read_at + 10 min, and an answer already older than that is not written.
  const doc = pc.verifiedPriceDoc(verified(1), NOW).doc;
  assert.equal(doc.expire_at - doc.read_at, TEN_MINUTES_MS);
  assert.ok(pc.verifiedPriceDoc(verified(1, { read_at: NOW - TEN_MINUTES_MS }), NOW), 'exactly 10 min old is still written');
  assert.equal(pc.verifiedPriceDoc(verified(1, { read_at: NOW - TEN_MINUTES_MS - 1 }), NOW), null, '1 ms past 10 min is not');
  // What a reader serves: judged from read_at, and no consumer window reaches past the cap.
  for (const ttlMs of [TEN_MINUTES_MS, 15 * MIN, 60 * MIN, DAY_MS, Infinity]) {
    assert.equal(pc.servableAnswer(doc, key(1), { nowMs: NOW + TEN_MINUTES_MS, ttlMs }).amount, 20, `${ttlMs}: exactly 10 min old is served`);
    assert.equal(pc.servableAnswer(doc, key(1), { nowMs: NOW + TEN_MINUTES_MS + 1, ttlMs }), null, `${ttlMs}: 1 ms past 10 min is not`);
    assert.equal(pc.servableAnswer(doc, key(1), { nowMs: NOW + 11 * MIN, ttlMs }), null, `${ttlMs}: 11 min old is not`);
    // A doc written before 11-23 carries a 15-min expire_at (60 min before 11-08): its read_at still decides.
    for (const oldExpiry of [15 * MIN, 60 * MIN]) {
      assert.equal(pc.servableAnswer({ ...doc, expire_at: new Date(NOW + oldExpiry) }, key(1), { nowMs: NOW + 11 * MIN, ttlMs }), null);
    }
  }
});

test('NO ENV VAR RAISES IT: a fresh load with every env var the cache\'s modules name (and the likely names) set to a day keeps 10 minutes', () => {
  const sources = [
    '../src/services/priceCache', '../src/services/priceCacheStore', '../src/services/liveMerchantSearchPrice',
    '../src/observability/priceVerificationFacts',
  ];
  const named = new Set();
  for (const s of sources) {
    for (const m of fs.readFileSync(require.resolve(s), 'utf8').matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) named.add(m[0]);
  }
  for (const flag of CACHE_FLAGS) assert.ok(named.has(flag), `${flag} is among the names read from the source`);
  const likely = [
    'MAX_PRICE_WINDOW_MS', 'HARD_EXPIRY_MS', 'SHARED_TTL_MS', 'TTL_MS', 'PRICE_CACHE_TTL_MS', 'PRICE_CACHE_HARD_EXPIRY_MS',
    'PRICE_CACHE_WINDOW_MS', 'PRICE_CACHE_MAX_PRICE_WINDOW_MS', 'PRICE_CACHE_MAX_WINDOW_MS', 'PRICE_CACHE_EXPIRY_MIN',
    'PRICE_CACHE_WINDOW_MIN', 'PRICE_CACHE_SEARCH_TTL_MS', 'SEARCH_PRICE_CACHE_TTL_MS', 'PRICE_CACHE_SHARED_TTL_MS',
    'DOOR_CAP_WINDOW_MS', 'DOOR_CACHE_PRICE_FRESHNESS_CAP_MS', 'DOOR_CACHE_PRICE_FRESHNESS_CAP_WINDOW_MS', 'DOOR_CACHE_PRICE_WINDOW_MS',
  ];
  const hostile = [...new Set([...named, ...likely])];
  const before = new Map(hostile.map((k) => [k, process.env[k]]));
  const ids = sources.map((s) => require.resolve(s));
  const saved = ids.map((id) => require.cache[id]);
  try {
    for (const k of hostile) process.env[k] = String(DAY_MS);
    for (const id of ids) delete require.cache[id];
    const fresh = require('../src/services/priceCache');
    const freshOverlay = require('../src/services/liveMerchantSearchPrice');
    const freshFacts = require('../src/observability/priceVerificationFacts');
    assert.notEqual(fresh, pc, 'a fresh load, not the cached module');
    assert.notEqual(freshFacts, facts);
    assert.equal(freshFacts.DOOR_CAP_WINDOW_MS, TEN_MINUTES_MS);
    assert.equal(fresh.MAX_PRICE_WINDOW_MS, TEN_MINUTES_MS);
    assert.equal(fresh.HARD_EXPIRY_MS, TEN_MINUTES_MS);
    assert.equal(freshOverlay.SHARED_TTL_MS, TEN_MINUTES_MS);
    for (const [k, v] of Object.entries(fresh.TTL_MS)) assert.ok(v <= TEN_MINUTES_MS, `${k} window ${v}`);
    const NOW = Date.parse('2026-11-23T12:00:00.000Z');
    const doc = fresh.verifiedPriceDoc(verified(1), NOW).doc;
    assert.equal(doc.expire_at - doc.read_at, TEN_MINUTES_MS);
    assert.equal(fresh.verifiedPriceDoc(verified(1, { read_at: NOW - 11 * MIN }), NOW), null);
    assert.equal(fresh.servableAnswer(doc, key(1), { nowMs: NOW + 11 * MIN, ttlMs: DAY_MS }), null);
    assert.equal(freshFacts.capCachePolicyAtPriceAge({ ttlMs: DAY_MS, staleMs: DAY_MS }, NOW - 11 * MIN, NOW), null);
    assert.deepEqual(freshFacts.capCachePolicyAtPriceAge({ ttlMs: DAY_MS, staleMs: DAY_MS }, NOW - 9 * MIN, NOW), { ttlMs: MIN, staleMs: MIN });
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    ids.forEach((id, i) => {
      if (saved[i]) require.cache[id] = saved[i];
      else delete require.cache[id];
    });
  }
});

test('PRICE_CACHE_MODE=read: an answer the store holds from 11 minutes ago is not served (lookup and search); one from 9 minutes ago is', async () => {
  const fake = createFakeFirestore();
  const built = [];
  pc._setStoreFactoryForTest((settings) => {
    built.push(settings.database);
    return createFirestorePriceCacheStore({ client: fake.db, database: settings.database, flushMs: 60000 });
  });
  const before = new Map(CACHE_FLAGS.map((k) => [k, process.env[k]]));
  try {
    // Another instance wrote both answers, 11 and 9 minutes ago. Firestore's TTL sweep is lazy, so the older doc
    // is still in the store after its expire_at.
    const t0 = Date.now();
    const elevenAgo = t0 - 11 * MIN;
    const nineAgo = t0 - 9 * MIN;
    const otherStore = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000 });
    let otherClock = elevenAgo;
    const other = pc.createPriceCache({ store: otherStore, now: () => otherClock, read: () => false });
    assert.equal(other.recordVerifiedPrice(verified(1000, { amount: 18, handle: 'item-0' })), true);
    otherClock = nineAgo;
    assert.equal(other.recordVerifiedPrice(verified(1001, { amount: 19, handle: 'item-1' })), true);
    await otherStore.flush();
    const stored = [...fake.docs.values()].filter((d) => d.status === 'verified');
    assert.deepEqual(stored.map((d) => [d.variant_id, d.amount, d.read_at.toMillis()]).sort(), [['1000', '18.00', elevenAgo], ['1001', '19.00', nineAgo]]);
    assert.ok(stored.find((d) => d.variant_id === '1000').expire_at.toMillis() < t0, 'the 11-min-old doc is past its expire_at and still present');

    Object.assign(process.env, { PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'read', PRICE_CACHE_FIRESTORE_PROJECT: 'p-test' });
    assert.equal(pc.priceCacheReadEnabled(), true);

    // The process cache's own lookup, at search's window and at windows a caller might ask for.
    for (const ttlMs of [overlay.SHARED_TTL_MS, 15 * MIN, DAY_MS]) {
      const got = await pc.lookupRecentPrices([key(1000), key(1001)], { ttlMs });
      assert.equal(got[0], null, `${ttlMs}: 11 min old is not served`);
      assert.equal(got[1].amount, 19, `${ttlMs}: 9 min old is served`);
      assert.equal(got[1].read_at_ms, nineAgo);
    }
    assert.deepEqual(built, ['price-cache'], 'the flags built the process cache over the fake store');

    // Search, the one consumer: the 9-min answer is served as the fleet's; the 11-min card is read from the store.
    const response = {
      products: [1000, 1001].map((variantId, i) => ({
        product_id: `sig_${i}`, price: 25, currency: 'USD', source_variant_id: String(variantId),
        destination_url: `https://${HOST}/products/item-${i}`,
      })),
      metadata: { query_source: 'beauty_external_seed_mainline' },
    };
    const fetched = [];
    const out = await overlay.overlayLiveMerchantSearchPrices(response, {
      market: 'US', priceCache: pc, env: {},
      fetchImpl: async (url) => {
        fetched.push(url);
        return { ok: true, json: async () => ({ product: { variants: [{ id: 1000, price: '21.00', price_currency: 'USD', available: true }] } }) };
      },
    });
    assert.deepEqual(fetched, [`https://${HOST}/products/item-0.json`], 'only the card whose cached answer is 11 min old was read');
    assert.deepEqual(
      out.products.map((p) => [p.price, p.price_source]),
      [[21, 'merchant_live'], [19, 'merchant_cache']],
      'the 11-min-old $18 is never served; the 9-min-old $19 is, marked as the cache\'s',
    );
    assert.equal(out.products[1].price_as_of, new Date(nineAgo).toISOString());
    assert.equal(out.metadata.live_merchant_price.shared_cache_hit_count, 1);

    // Write mode, and off: nothing is read from the cache at all.
    for (const mode of ['write', 'off']) {
      process.env.PRICE_CACHE_MODE = mode;
      assert.deepEqual(await pc.lookupRecentPrices([key(1000), key(1001)], { ttlMs: overlay.SHARED_TTL_MS }), [null, null], mode);
    }
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    pc._setStoreFactoryForTest(null);
  }
});

test('THE DOOR CACHES\' CAP is the same 10 minutes: an entry ends when its merchant answer is 10 min old; one already that old is not stored', () => {
  assert.equal(facts.DOOR_CAP_WINDOW_MS, TEN_MINUTES_MS);
  assert.equal(facts.DOOR_CAP_WINDOW_MS, pc.MAX_PRICE_WINDOW_MS, 'one published limit, one figure');
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  // The /mcp read cache's own clocks (5 min fresh, 15 min stale) and the public tier's (10 and 60).
  for (const policy of [{ ttlMs: 5 * MIN, staleMs: 15 * MIN }, { ttlMs: 10 * MIN, staleMs: 60 * MIN }, { ttlMs: DAY_MS, staleMs: DAY_MS }]) {
    // Read just now: the whole 10 minutes are left, and no clock runs past them.
    assert.deepEqual(facts.capCachePolicyAtPriceAge(policy, NOW, NOW),
      { ttlMs: Math.min(policy.ttlMs, TEN_MINUTES_MS), staleMs: TEN_MINUTES_MS });
    // 9 minutes old: one minute left, for the fresh window and the stale window alike.
    assert.deepEqual(facts.capCachePolicyAtPriceAge(policy, NOW - 9 * MIN, NOW), { ttlMs: MIN, staleMs: MIN });
    assert.deepEqual(facts.capCachePolicyAtPriceAge(policy, NOW - TEN_MINUTES_MS + 1, NOW), { ttlMs: 1, staleMs: 1 });
    // 10 minutes old, or older: not stored at all.
    for (const age of [TEN_MINUTES_MS, 11 * MIN, 15 * MIN]) {
      assert.equal(facts.capCachePolicyAtPriceAge(policy, NOW - age, NOW), null, `${age} ms old`);
    }
    // No merchant answer in the entry: its own clocks, untouched.
    assert.equal(facts.capCachePolicyAtPriceAge(policy, null, NOW), policy);
  }
  // The cap itself stays behind its flag, default off.
  assert.equal(facts.doorCachePriceFreshnessCapEnabled({}), false);
  assert.equal(facts.DOOR_CAP_FLAG, 'DOOR_CACHE_PRICE_FRESHNESS_CAP');
});
