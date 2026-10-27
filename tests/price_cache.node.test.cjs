'use strict';

// THE SHARED VERIFIED-PRICE CACHE (src/services/priceCache.js): the key, the currency rule, what a doc holds, the
// L1, the consumer windows, failing open, the fleet's host backoff, and the flags (off builds nothing at all).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pc = require('../src/services/priceCache');
const { createFirestorePriceCacheStore } = require('../src/services/priceCacheStore');
const { createFakeFirestore } = require('./_support/fakeFirestore.cjs');

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const MIN = 60 * 1000;
const KEY = { host: 'shop.example.com', market: 'US', variant_id: '43734829564039', currency: 'USD' };
const VERIFIED = { ...KEY, amount: 23, available: true, handle: 'tint', source: 'merchant_ucp', writer: 'offers' };

function clock(start = T0) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, add: (ms) => { t += ms; } };
}
/** A cache over a fake Firestore; `read` true unless said otherwise. */
function harness({ read = true, start = T0 } = {}) {
  const fake = createFakeFirestore();
  const c = clock(start);
  const lines = [];
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, now: c.now });
  const cache = pc.createPriceCache({ store, now: c.now, read: () => read, log: (e, f) => lines.push({ e, ...f }) });
  return { fake, c, store, cache, lines };
}

test('the key: host normalized (case, www., trailing dot, a URL), declared ISO-2 market, numeric variant, the market currency', () => {
  assert.deepEqual(pc.priceCacheKey({ host: 'https://WWW.Shop.Example.com./products/x', market: ' us ', variant_id: 'gid://shopify/ProductVariant/123', currency: 'usd' }),
    { host: 'shop.example.com', market: 'US', variant_id: '123', currency: 'USD' });
  assert.equal(pc.priceCacheDocId(pc.priceCacheKey(KEY)), crypto.createHash('sha256').update('shop.example.com|US|43734829564039|USD').digest('hex'));
  assert.match(pc.priceCacheDocId(pc.priceCacheKey(KEY)), /^[0-9a-f]{64}$/);
});

test('THE CURRENCY RULE: no declared market, an unpriced market, or a currency that is not the market\'s: no key at all', () => {
  for (const bad of [
    { ...KEY, market: undefined }, { ...KEY, market: '' }, { ...KEY, market: 'USA' }, { ...KEY, market: 'ZZ' },
    { ...KEY, currency: 'EUR' }, { ...KEY, market: 'GB' }, { ...KEY, currency: '' }, { ...KEY, currency: undefined },
  ]) assert.equal(pc.priceCacheKey(bad), null, JSON.stringify(bad));
  assert.deepEqual(pc.priceCacheKey({ ...KEY, market: 'GB', currency: 'GBP' }).currency, 'GBP');
  for (const host of ['', 'localhost', 'a/b', 'shop..com', '-x.com', '127.0.0.1x', '10.0.0.1', '[::1]', 'x'.repeat(300) + '.com']) {
    assert.equal(pc.priceCacheKey({ ...KEY, host }), null, host);
  }
  for (const variant of ['', 'a/b', 'x'.repeat(65), 'gid://shopify/Product/1']) assert.equal(pc.priceCacheKey({ ...KEY, variant_id: variant }), null, variant);
});

test('a verified doc: fields per the design, amount a decimal string in the currency\'s minor units, expire_at = read_at + 60 min', () => {
  const built = pc.verifiedPriceDoc({ ...VERIFIED, compare_at: 30, handle: 'Tint' }, T0);
  assert.deepEqual(built.doc, {
    host: 'shop.example.com', market: 'US', variant_id: '43734829564039', currency: 'USD', status: 'verified',
    amount: '23.00', compare_at: '30.00', available: true, handle: 'tint', source: 'merchant_ucp', writer: 'offers',
    read_at: new Date(T0), expire_at: new Date(T0 + 60 * MIN),
  });
  assert.equal(pc.verifiedPriceDoc({ ...VERIFIED, market: 'JP', currency: 'JPY', amount: 2300.4 }, T0).doc.amount, '2300');
  assert.equal(pc.verifiedPriceDoc({ ...VERIFIED, compare_at: 20 }, T0).doc.compare_at, null, 'a compare-at below the price is not one');
  assert.equal(pc.verifiedPriceDoc({ ...VERIFIED, available: 'yes', handle: 'a b' }, T0).doc.available, null);
  assert.equal(pc.verifiedPriceDoc({ ...VERIFIED, available: 'yes', handle: 'a b' }, T0).doc.handle, null);
  assert.equal(Object.values(pc.verifiedPriceDoc(VERIFIED, T0).doc).includes(undefined), false, 'no undefined field (Firestore refuses one)');
});

test('not a verified answer: no doc (zero, negative or junk amounts, unknown source or writer, a stale or future read)', () => {
  for (const bad of [
    { ...VERIFIED, amount: 0 }, { ...VERIFIED, amount: -1 }, { ...VERIFIED, amount: 'x' }, { ...VERIFIED, amount: null },
    { ...VERIFIED, source: 'catalog_refresh' }, { ...VERIFIED, writer: 'refresh' }, { ...VERIFIED, source: undefined },
    { ...VERIFIED, read_at: T0 + 10 * 1000 }, { ...VERIFIED, read_at: T0 - 61 * MIN }, { ...VERIFIED, currency: 'EUR' },
  ]) assert.equal(pc.verifiedPriceDoc(bad, T0), null, JSON.stringify(bad));
  assert.equal(pc.verifiedPriceDoc({ ...VERIFIED, read_at: new Date(T0 - 5 * MIN).toISOString() }, T0).doc.read_at.getTime(), T0 - 5 * MIN);
});

test('a variant_gone tombstone: no price, unavailable, the market\'s currency, 10-minute expiry', () => {
  const built = pc.variantGoneDoc({ host: 'shop.example.com', market: 'US', variant_id: '1', source: 'merchant_ucp', writer: 'product' }, T0);
  assert.deepEqual(built.doc, {
    host: 'shop.example.com', market: 'US', variant_id: '1', currency: 'USD', status: 'variant_gone', amount: null,
    compare_at: null, available: false, handle: null, source: 'merchant_ucp', writer: 'product',
    read_at: new Date(T0), expire_at: new Date(T0 + 10 * MIN),
  });
  assert.equal(pc.variantGoneDoc({ host: 'shop.example.com', variant_id: '1', source: 'merchant_ucp', writer: 'product' }, T0), null, 'no market, no tombstone');
});

test('record -> one queued Firestore doc keyed by the hashed id; nothing is sent until the flush', async () => {
  const { fake, store, cache } = harness();
  assert.equal(cache.recordVerifiedPrice(VERIFIED), true);
  assert.equal(cache.recordVerifiedPrice({ ...VERIFIED, currency: 'EUR' }), false);
  assert.equal(fake.calls.batches.length, 0);
  await store.flush();
  const docId = pc.priceCacheDocId(pc.priceCacheKey(KEY));
  assert.deepEqual([...fake.docs.keys()], [`verified_prices/${docId}`]);
  assert.equal(fake.docs.get(`verified_prices/${docId}`).expire_at.toMillis(), T0 + 60 * MIN);
});

test('lookup: an answer inside the consumer window is servable; outside it, past 60 min, from the future or a tombstone is not', async () => {
  const { c, store, cache } = harness();
  cache.recordVerifiedPrice({ ...VERIFIED, read_at: T0 - 14 * MIN });
  cache.recordVerifiedPrice({ ...VERIFIED, variant_id: '2', read_at: T0 - 16 * MIN });
  cache.recordVariantGone({ ...KEY, variant_id: '3', source: 'merchant_ucp', writer: 'product' });
  await store.flush();
  const keys = [KEY, { ...KEY, variant_id: '2' }, { ...KEY, variant_id: '3' }, { ...KEY, variant_id: '4' }];
  const got = await cache.lookup(keys, { ttlMs: pc.TTL_MS.search });
  assert.deepEqual(got.map((a) => a && a.amount), [23, null, null, null]);
  assert.equal(got[0].age_ms, 14 * MIN);
  assert.equal(got[0].read_at_ms, T0 - 14 * MIN);
  assert.equal(got[0].handle, 'tint');
  const pdp = await cache.lookup([KEY], { ttlMs: pc.TTL_MS.pdp });
  assert.equal(pdp[0], null, 'the PDP window is 10 min');
  assert.equal((await cache.lookup([KEY], { ttlMs: 0 }))[0], null, 'get_offers / cart: never from the cache');
  assert.equal((await cache.lookup([KEY], { ttlMs: 24 * 60 * MIN }))[0].amount, 23, 'a long window is capped at the hard expiry...');
  c.add(47 * MIN);
  assert.equal((await cache.lookup([KEY], { ttlMs: 24 * 60 * MIN }))[0], null, '...of 60 min');
});

test('lookup reads the STORE, not only this process: another instance\'s answer is served; the L1 then answers for 30 s', async () => {
  const { fake, c, store, cache } = harness();
  const other = pc.createPriceCache({ store, now: c.now, read: () => true });
  other.recordVerifiedPrice({ ...VERIFIED, read_at: T0 - MIN });
  await store.flush();
  const first = await cache.lookup([KEY, { ...KEY, variant_id: '9' }], { ttlMs: pc.TTL_MS.search });
  assert.equal(first[0].amount, 23);
  assert.equal(fake.calls.getAll.length, 1);
  c.add(29 * 1000);
  await cache.lookup([KEY, { ...KEY, variant_id: '9' }], { ttlMs: pc.TTL_MS.search });
  assert.equal(fake.calls.getAll.length, 1, 'hits AND misses are held by the L1');
  c.add(2 * 1000);
  await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search });
  assert.equal(fake.calls.getAll.length, 2, 'past 30 s the store is read again');
});

test('lookup: one getAll of at most 20 docs, duplicates once; keys that break the rule are never read', async () => {
  const { fake, cache } = harness();
  const keys = Array.from({ length: 25 }, (_, i) => ({ ...KEY, variant_id: String(1000 + i) }));
  const got = await cache.lookup([...keys, keys[0], { ...KEY, currency: 'EUR' }, { ...KEY, market: undefined }], { ttlMs: pc.TTL_MS.search });
  assert.equal(got.length, 28);
  assert.equal(fake.calls.getAll.length, 1);
  assert.equal(fake.calls.getAll[0].length, 20);
});

test('write mode: lookup answers nothing and reads nothing', async () => {
  const { fake, store, cache } = harness({ read: false });
  cache.recordVerifiedPrice(VERIFIED);
  await store.flush();
  assert.deepEqual(await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search }), [null]);
  assert.equal(fake.calls.getAll.length, 0);
  assert.equal(fake.docs.size, 1, 'it still writes');
});

test('FAIL OPEN: a slow or failing store read is a miss, logs price_cache_read_failed, and pauses store reads for 5 s', async () => {
  const fake = createFakeFirestore();
  const c = clock();
  const lines = [];
  const store = createFirestorePriceCacheStore({ client: fake.db, readTimeoutMs: 40, now: c.now });
  const cache = pc.createPriceCache({ store, now: c.now, read: () => true, log: (e, f) => lines.push({ e, ...f }) });
  fake.faults.getAllDelayMs = 300;
  const t = Date.now();
  assert.deepEqual(await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search }), [null]);
  assert.ok(Date.now() - t < 250, 'the request waited for the timeout, not the store');
  assert.deepEqual(lines, [{ e: 'price_cache_read_failed', reason: 'timeout', docs: 1, failures: 1 }]);
  fake.faults.getAllDelayMs = 0;
  await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search });
  assert.equal(fake.calls.getAll.length, 1, 'paused: no second store read');
  c.add(5001);
  fake.faults.getAllError = new Error('boom');
  await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search });
  assert.equal(fake.calls.getAll.length, 2);
  assert.equal(lines.length, 1, 'the second failure inside the minute is counted, not logged');
  c.add(61 * 1000);
  await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search });
  assert.equal(lines[1].reason, 'error');
  assert.equal(lines[1].failures, 2);
});

test('this instance\'s own newer write is not replaced by an older doc a concurrent read brings back', async () => {
  const { fake, c, store, cache } = harness();
  fake.docs.set(`verified_prices/${pc.priceCacheDocId(pc.priceCacheKey(KEY))}`, {
    ...pc.verifiedPriceDoc({ ...VERIFIED, amount: 20, read_at: T0 - 5 * MIN }, T0).doc,
    read_at: new fake.FakeTimestamp(T0 - 5 * MIN),
  });
  fake.faults.getAllDelayMs = 20;
  const pending = cache.lookup([KEY], { ttlMs: pc.TTL_MS.search });
  cache.recordVerifiedPrice({ ...VERIFIED, amount: 25 });
  const got = await pending;
  assert.equal(got[0].amount, 25);
  c.add(1000);
  assert.equal((await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search }))[0].amount, 25);
  await store.flush();
});

test('a doc that names another key, a malformed amount or no read_at is never served', () => {
  const key = pc.priceCacheKey(KEY);
  const good = pc.verifiedPriceDoc(VERIFIED, T0).doc;
  assert.equal(pc.servableAnswer(good, key, { nowMs: T0, ttlMs: MIN }).amount, 23);
  for (const bad of [{ ...good, host: 'evil.example.com' }, { ...good, currency: 'EUR' }, { ...good, amount: 23 }, { ...good, amount: '0' },
    { ...good, read_at: null }, { ...good, status: 'variant_gone' }, null]) {
    assert.equal(pc.servableAnswer(bad, key, { nowMs: T0, ttlMs: MIN }), null, JSON.stringify(bad));
  }
});

test('HOST BACKOFF: a 429 writes host_backoff/{host} for 60 s; a repeat within 10 min of its end doubles, capped at 10 min', async () => {
  const { fake, c, store, cache } = harness();
  assert.equal(cache.noteHostRefusal('https://www.Shop.Example.com/x', 429), true);
  assert.equal(cache.hostBackedOff('shop.example.com'), true);
  assert.equal(cache.noteHostRefusal('shop.example.com', 503), false, 'a refusal while backed off does not extend it');
  await store.flush();
  const docAt = fake.docs.get('host_backoff/shop.example.com');
  assert.equal(docAt.backoff_until.toMillis(), T0 + 60e3);
  assert.equal(docAt.backoff_ms, 60e3);
  assert.equal(docAt.last_status, 429);
  assert.equal(docAt.reason, 'http_429');
  const widths = [];
  for (let i = 0; i < 6; i += 1) {
    c.set(cache._backoffL1.get('shop.example.com').until + 1000);
    cache.noteHostRefusal('shop.example.com', 503);
    widths.push(cache._backoffL1.get('shop.example.com').ms / 1000);
  }
  assert.deepEqual(widths, [120, 240, 480, 600, 600, 600]);
  c.set(cache._backoffL1.get('shop.example.com').until + 10 * MIN + 1);
  cache.noteHostRefusal('shop.example.com', 500);
  assert.equal(cache._backoffL1.get('shop.example.com').ms, 60e3, 'a quiet 10 min resets it');
  for (const s of [200, 404, 400, 'x']) assert.equal(cache.noteHostRefusal('other.example.com', s), false, String(s));
  assert.equal(cache.noteHostRefusal('other.example.com', 430), true, 'Shopify\'s bot refusal backs off');
});

test('HOST BACKOFF across instances: B learns of A\'s backoff from the store within its 10 s L1, without waiting', async () => {
  const fake = createFakeFirestore();
  const c = clock();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, now: c.now });
  const a = pc.createPriceCache({ store, now: c.now });
  const b = pc.createPriceCache({ store, now: c.now });
  assert.equal(b.hostBackedOff('shop.example.com'), false, 'B knows nothing yet; the check starts a background read');
  await Promise.all([...b._refreshing.values()]);
  a.noteHostRefusal('shop.example.com', 429);
  await store.flush();
  assert.equal(b.hostBackedOff('shop.example.com'), false, 'B\'s L1 is under 10 s old: no read, no wait');
  assert.equal(fake.calls.get.length, 1);
  c.add(10001);
  assert.equal(b.hostBackedOff('shop.example.com'), false, 'stale: this check decides on what B knows and refreshes behind');
  await Promise.all([...b._refreshing.values()]);
  assert.equal(b.hostBackedOff('shop.example.com'), true, 'the next check sees the fleet backoff');
  assert.equal(fake.calls.get.length, 2);
  c.add(50 * 1000);
  assert.equal(b.hostBackedOff('shop.example.com'), false, 'it ends when A\'s backoff ends');
  await Promise.all([...b._refreshing.values()]);
  // A's backoff ended; B now draws a 429 itself: the fleet's backoff doubles.
  c.add(5000);
  b.noteHostRefusal('shop.example.com', 429);
  assert.equal(b._backoffL1.get('shop.example.com').ms, 120e3);
});

test('HOST BACKOFF: a failing store read keeps what this instance knows and is not retried for 10 s; a far-future doc has expired', async () => {
  const fake = createFakeFirestore();
  const c = clock();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, now: c.now });
  const b = pc.createPriceCache({ store, now: c.now });
  fake.faults.getError = new Error('down');
  b.hostBackedOff('shop.example.com');
  await Promise.all([...b._refreshing.values()]);
  b.hostBackedOff('shop.example.com');
  assert.equal(fake.calls.get.length, 1);
  fake.faults.getError = null;
  fake.docs.set('host_backoff/clock.example.com', { backoff_until: new fake.FakeTimestamp(T0 + 11 * MIN), backoff_ms: 600e3 });
  b.hostBackedOff('clock.example.com');
  await Promise.all([...b._refreshing.values()]);
  assert.equal(b.hostBackedOff('clock.example.com'), false, 'a backoff ending more than 10 min out is a clock that stepped: expired');
  assert.equal(b.hostBackedOff('not a host'), false);
});

// ---- the process cache: the flags ----------------------------------------------------------------------------

const FLAGS = ['PRICE_CACHE_STORE', 'PRICE_CACHE_MODE', 'PRICE_CACHE_FIRESTORE_DATABASE'];
function withEnv(env, fn) {
  const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, env);
  return Promise.resolve().then(fn).finally(() => {
    for (const k of FLAGS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test('settings: both flags must be on; anything unrecognised is off; the database defaults to price-cache', () => {
  assert.deepEqual(pc.priceCacheSettings({}), { store: 'off', mode: 'off', database: 'price-cache', active: false, read: false });
  assert.equal(pc.priceCacheSettings({ PRICE_CACHE_STORE: 'firestore' }).active, false);
  assert.equal(pc.priceCacheSettings({ PRICE_CACHE_MODE: 'read' }).active, false);
  assert.equal(pc.priceCacheSettings({ PRICE_CACHE_STORE: 'redis', PRICE_CACHE_MODE: 'write' }).active, false);
  assert.equal(pc.priceCacheSettings({ PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'on' }).active, false);
  assert.deepEqual(pc.priceCacheSettings({ PRICE_CACHE_STORE: ' Firestore ', PRICE_CACHE_MODE: 'WRITE', PRICE_CACHE_FIRESTORE_DATABASE: 'x' }),
    { store: 'firestore', mode: 'write', database: 'x', active: true, read: false });
  assert.equal(pc.priceCacheSettings({ PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'read' }).read, true);
});

test('FLAGS OFF: every API call is a no-op that builds no store; read mode only reads', async () => {
  let built = 0;
  const fake = createFakeFirestore();
  pc._setStoreFactoryForTest((settings) => { built += 1; return createFirestorePriceCacheStore({ client: fake.db, database: settings.database, flushMs: 60000 }); });
  try {
    for (const env of [{}, { PRICE_CACHE_STORE: 'firestore' }, { PRICE_CACHE_MODE: 'write' }, { PRICE_CACHE_STORE: 'off', PRICE_CACHE_MODE: 'read' }]) {
      await withEnv(env, async () => {
        assert.equal(pc.recordVerifiedPrice(VERIFIED), false);
        assert.equal(pc.recordVariantGone({ ...KEY, source: 'merchant_ucp', writer: 'product' }), false);
        assert.equal(pc.noteHostRefusal('shop.example.com', 429), false);
        assert.equal(pc.sharedHostBackedOff('shop.example.com'), false);
        assert.deepEqual(await pc.lookupRecentPrices([KEY], { ttlMs: pc.TTL_MS.search }), [null]);
        assert.equal(pc.activePriceCache(), null);
      });
    }
    assert.equal(built, 0, 'no store was ever built');
    await withEnv({ PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'write', PRICE_CACHE_FIRESTORE_DATABASE: 'price-cache-test' }, async () => {
      assert.equal(pc.recordVerifiedPrice(VERIFIED), true);
      assert.deepEqual(await pc.lookupRecentPrices([KEY], { ttlMs: pc.TTL_MS.search }), [null], 'write mode never answers');
      await pc.activePriceCache().store.flush();
    });
    assert.equal(built, 1);
    assert.equal(fake.calls.getAll.length, 0);
    await withEnv({ PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'read' }, async () => {
      assert.equal((await pc.lookupRecentPrices([KEY], { ttlMs: pc.TTL_MS.search }))[0].amount, 23);
      assert.equal(pc.priceCacheReadEnabled(), true);
    });
    assert.equal(built, 1, 'one store per process');
  } finally {
    pc._setStoreFactoryForTest(null);
  }
});

test('FLAGS OFF in a fresh process: requiring the cache, the reader module and recording loads no Firestore client', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const pc = require('./src/services/priceCache');
    require('./src/services/ucpLiveOfferRead');
    require('./src/services/liveMerchantSearchPrice');
    pc.recordVerifiedPrice({ host: 'shop.example.com', market: 'US', variant_id: '1', currency: 'USD', amount: 1, source: 'merchant_ucp', writer: 'offers' });
    pc.noteHostRefusal('shop.example.com', 429);
    const loaded = Object.keys(require.cache).filter((k) => /@google-cloud[\\/]firestore|google-gax|@grpc[\\/]grpc-js/.test(k));
    console.log(JSON.stringify({ loaded: loaded.length }));`;
  const env = { ...process.env };
  for (const k of FLAGS) delete env[k];
  const r = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { loaded: 0 });
});

test('S1 warmPriceCache: off builds and warms nothing; active builds the store and warms it (one read) and logs it', async () => {
  const warmed = [];
  const lines = [];
  pc._setStoreFactoryForTest(() => ({ warm: async () => { warmed.push(1); return { ok: true, ms: 3 }; }, putPrice() {}, putHostBackoff() {}, async getPrices() { return new Map(); } }));
  pc.setPriceCacheLog((e, f) => lines.push({ e, ...f }));
  try {
    await withEnv({ PRICE_CACHE_STORE: 'firestore' }, async () => assert.deepEqual(await pc.warmPriceCache(), { skipped: true }));
    assert.deepEqual(warmed, []);
    await withEnv({ PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'write' }, async () => assert.deepEqual(await pc.warmPriceCache(), { ok: true, ms: 3 }));
    assert.deepEqual(warmed, [1]);
    assert.deepEqual(lines, [{ e: 'price_cache_warm', ok: true, ms: 3 }]);
  } finally {
    pc._setStoreFactoryForTest(null);
    pc.setPriceCacheLog(null);
  }
});

test('S1 STRUCTURAL: the boot awaits the cache warm-up BEFORE the server listens', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const boot = src.slice(src.indexOf('if (require.main === module) {'));
  const warm = boot.indexOf('await priceCacheHooks.warmPriceCache();');
  const listen = boot.indexOf('app.listen(PORT');
  assert.ok(warm > 0 && listen > 0 && warm < listen);
});

test('R11 READ MODE: no declared market is never served, even with a US/USD answer in the store', async () => {
  const { store, cache } = harness();
  cache.recordVerifiedPrice({ ...VERIFIED, read_at: T0 - MIN });
  await store.flush();
  cache._l1.clear();
  assert.equal((await cache.lookup([KEY], { ttlMs: pc.TTL_MS.search }))[0].amount, 23, 'the doc is there for US');
  for (const market of [undefined, null, '', ' ', 'us-', 'USA']) {
    assert.deepEqual(await cache.lookup([{ ...KEY, market }], { ttlMs: pc.TTL_MS.search }), [null], String(market));
  }
  assert.deepEqual(await cache.lookup([{ host: KEY.host, variant_id: KEY.variant_id }], { ttlMs: pc.TTL_MS.search }), [null], 'no market, no currency');
});

test('write cost: an unchanged answer is not re-written within 5 min; a changed one, or one 5 min on, is', async () => {
  const { fake, c, store, cache } = harness();
  assert.equal(cache.recordVerifiedPrice(VERIFIED), true);
  c.add(4 * MIN);
  assert.equal(cache.recordVerifiedPrice(VERIFIED), false, 'same answer 4 min later: skipped');
  assert.equal(cache.recordVerifiedPrice({ ...VERIFIED, available: false }), true, 'stock changed: written at once');
  assert.equal(cache.recordVerifiedPrice({ ...VERIFIED, available: false, source: 'merchant_cart', writer: 'cart' }), true, 'a stronger source: written');
  c.add(5 * MIN);
  assert.equal(cache.recordVerifiedPrice({ ...VERIFIED, available: false, source: 'merchant_cart', writer: 'cart' }), true, '5 min on: refreshed');
  await store.flush();
  assert.equal(fake.calls.batches.flat().length, 1, 'coalesced in the queue: one doc');
  assert.equal(fake.docs.size, 1);
});
