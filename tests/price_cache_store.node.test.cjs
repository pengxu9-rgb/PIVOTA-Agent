'use strict';

// THE FIRESTORE PRICE-CACHE STORE (src/services/priceCacheStore.js) against a faithful fake of the Firestore client
// (tests/_support/fakeFirestore.cjs; the emulator needs a Java runtime this suite does not assume). What the cache
// depends on: one getAll of <= 20 refs per read, a 150 ms ceiling, writes off the response path through a
// BulkWriter about once a second, the newest read_at winning, and a bounded queue.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFirestorePriceCacheStore, MAX_GET_ALL } = require('../src/services/priceCacheStore');
const { createFakeFirestore } = require('./_support/fakeFirestore.cjs');

const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const id = (n) => String(n).padStart(64, 'a');
const doc = (readAtMs, extra = {}) => ({ amount: '23.00', read_at: new Date(readAtMs), expire_at: new Date(readAtMs + 3600e3), ...extra });

test('getPrices: ONE getAll of at most 20 refs in verified_prices; absent docs are null; Timestamps come back', async () => {
  const fake = createFakeFirestore();
  fake.docs.set(`verified_prices/${id(1)}`, { amount: '23.00', read_at: new fake.FakeTimestamp(T0) });
  const store = createFirestorePriceCacheStore({ client: fake.db });
  const ids = Array.from({ length: 25 }, (_, i) => id(i + 1));
  const got = await store.getPrices([...ids, id(1)]);
  assert.equal(fake.calls.getAll.length, 1, 'one round trip');
  assert.equal(fake.calls.getAll[0].length, MAX_GET_ALL, 'capped at 20 refs, duplicates removed');
  assert.ok(fake.calls.getAll[0].every((p) => p.startsWith('verified_prices/')));
  assert.equal(got.get(id(1)).amount, '23.00');
  assert.equal(got.get(id(1)).read_at.toMillis(), T0);
  assert.equal(got.get(id(2)), null);
  assert.equal(got.has(id(21)), false, 'beyond 20: never asked');
  assert.equal((await store.getPrices([])).size, 0);
  assert.equal(fake.calls.getAll.length, 1, 'no ids, no call (getAll() with no refs throws)');
});

test('getPrices: a read slower than the timeout rejects (code timeout) at the timeout; an error rejects', async () => {
  const fake = createFakeFirestore();
  fake.faults.getAllDelayMs = 400;
  const store = createFirestorePriceCacheStore({ client: fake.db, readTimeoutMs: 60 });
  const t = Date.now();
  await assert.rejects(store.getPrices([id(1)]), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t < 300, 'gave up at its timeout, not the store\'s pace');
  fake.faults.getAllDelayMs = 0;
  fake.faults.getAllError = Object.assign(new Error('unavailable'), { code: 14 });
  await assert.rejects(store.getPrices([id(1)]), /unavailable/);
});

test('the default read timeout is 150 ms', async () => {
  const fake = createFakeFirestore();
  fake.faults.getAllDelayMs = 1000;
  const store = createFirestorePriceCacheStore({ client: fake.db });
  const t = Date.now();
  await assert.rejects(store.getPrices([id(1)]), (e) => e.code === 'timeout');
  const took = Date.now() - t;
  assert.ok(took >= 140 && took < 600, `took ${took} ms`);
});

test('putPrice never writes on the call; the queue is flushed about a second later, through ONE BulkWriter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = createFakeFirestore();
  const store = createFirestorePriceCacheStore({ client: fake.db });
  // setImmediate is not mocked: each pause lets any async flush that was started run to its writes.
  const drain = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
  store.putPrice(id(1), doc(T0));
  store.putPrice(id(2), doc(T0));
  await drain();
  assert.equal(fake.calls.batches.length, 0, 'nothing sent on the call');
  assert.equal(fake.calls.writerOptions.length, 0, 'no BulkWriter until the first flush');
  t.mock.timers.tick(999);
  await drain();
  assert.equal(fake.calls.writerOptions.length, 0, 'not before a second');
  t.mock.timers.tick(1);
  await drain();
  assert.equal(fake.calls.batches.length, 1, 'sent at one second, without anyone calling flush');
  t.mock.timers.reset();
  await store.flush();
  assert.equal(fake.calls.batches.length, 1);
  assert.deepEqual(fake.calls.batches[0].sort(), [`verified_prices/${id(1)}`, `verified_prices/${id(2)}`]);
  assert.deepEqual(fake.calls.writerOptions, [{ throttling: false }]);
  store.putPrice(id(3), doc(T0));
  await store.flush();
  assert.equal(fake.calls.writerOptions.length, 1, 'the BulkWriter is reused');
  assert.equal(fake.docs.get(`verified_prices/${id(3)}`).amount, '23.00');
  assert.deepEqual(store.stats(), { queued: 3, written: 3, failed: 0, dropped: 0, flushes: 2, flush_timeouts: 0, resets: 0, abandoned: 0, reenabled: 0, probes: 0, clients_built: 0, pending: 0, inflight: 0, disabled: false });
});

test('one doc queued twice in a window is written once, with the NEWER read_at, whichever came last', async () => {
  const fake = createFakeFirestore();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000 });
  store.putPrice(id(1), doc(T0 + 5000, { amount: '25.00' }));
  store.putPrice(id(1), doc(T0, { amount: '20.00' }));
  store.putPrice(id(2), doc(T0, { amount: '20.00' }));
  store.putPrice(id(2), doc(T0 + 1, { amount: '21.00' }));
  await store.flush();
  assert.equal(fake.calls.batches.flat().length, 2);
  assert.equal(fake.docs.get(`verified_prices/${id(1)}`).amount, '25.00', 'an older answer arriving later never replaces a newer one');
  assert.equal(fake.docs.get(`verified_prices/${id(2)}`).amount, '21.00');
  await store.close();
});

test('host_backoff docs go to their own collection, keyed by host; getHostBackoff reads one', async () => {
  const fake = createFakeFirestore();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000 });
  store.putHostBackoff('shop.example.com', { host: 'shop.example.com', backoff_until: new Date(T0 + 60e3), read_at: new Date(T0) });
  await store.flush();
  assert.deepEqual(fake.calls.batches, [['host_backoff/shop.example.com']]);
  const back = await store.getHostBackoff('shop.example.com');
  assert.equal(back.backoff_until.toMillis(), T0 + 60e3);
  assert.equal(await store.getHostBackoff('other.example.com'), null);
});

test('past maxPending queued docs, new ones are dropped and counted (a down store cannot grow the process)', async () => {
  const fake = createFakeFirestore();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, maxPending: 3 });
  for (let i = 1; i <= 5; i += 1) store.putPrice(id(i), doc(T0));
  store.putPrice(id(1), doc(T0 + 1));
  assert.equal(store.stats().pending, 3);
  assert.equal(store.stats().dropped, 2, 'a newer answer for a queued doc still takes its slot');
  await store.flush();
  assert.equal(fake.docs.size, 3);
  assert.equal(fake.docs.get(`verified_prices/${id(1)}`).read_at.toMillis(), T0 + 1);
});

test('a failing write is retried at most 3 attempts, then counted and logged once a minute; it never rejects', async () => {
  const fake = createFakeFirestore();
  const lines = [];
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, log: (e, f) => lines.push({ e, ...f }) });
  fake.faults.writeFailures = 3;
  store.putPrice(id(1), doc(T0));
  await store.flush();
  assert.equal(fake.calls.batches.length, 3, 'three attempts');
  assert.equal(fake.docs.size, 0);
  assert.equal(store.stats().failed, 1);
  const failures = () => lines.filter((l) => l.e === 'price_cache_write_failed');
  assert.deepEqual(failures(), [{ e: 'price_cache_write_failed', failures: 1, code: '14' }]);
  fake.faults.writeFailures = 2;
  store.putPrice(id(2), doc(T0));
  await store.flush();
  assert.equal(fake.docs.has(`verified_prices/${id(2)}`), true, 'two failures then a success: written');
  fake.faults.writeFailures = 3;
  store.putPrice(id(3), doc(T0));
  await store.flush();
  assert.equal(store.stats().failed, 2);
  assert.equal(failures().length, 1, 'the second failure inside the minute is counted, not logged');
});

test('an invalid doc costs that doc only: undefined throws at set(), a function rejects; the others are written', async () => {
  const fake = createFakeFirestore();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000 });
  store.putPrice(id(1), doc(T0, { handle: undefined }));
  store.putPrice(id(2), doc(T0, { handle: () => 1 }));
  store.putPrice(id(3), doc(T0));
  await store.flush();
  assert.deepEqual([...fake.docs.keys()], [`verified_prices/${id(3)}`]);
  assert.equal(store.stats().failed, 2);
});

test('close flushes what is queued and terminates the client; later puts are ignored', async () => {
  const fake = createFakeFirestore();
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000 });
  store.putPrice(id(1), doc(T0));
  await store.close();
  assert.equal(fake.docs.size, 1);
  assert.equal(fake.db.terminated, true);
  store.putPrice(id(2), doc(T0));
  assert.equal(store.stats().pending, 0);
});

test('building the store and queueing a write load no Firestore library (it loads at the first flush or read)', async () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const before = () => Object.keys(require.cache).some((k) => k.includes('@google-cloud/firestore'));
    const { createFirestorePriceCacheStore } = require('./src/services/priceCacheStore');
    // flushMs: never reached (the process exits first), so no write is ever attempted.
    const s = createFirestorePriceCacheStore({ database: 'price-cache', projectId: 'cache-project-test', flushMs: 600000 });
    const loadedAtBuild = before();
    s.putPrice('${id(1)}', { read_at: new Date() });
    const loadedAtQueue = before();
    console.log(JSON.stringify({ loadedAtBuild, loadedAtQueue }));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { loadedAtBuild: false, loadedAtQueue: false });
});

// ---- S1 (boot warm-up) and S2 (a store that never answers is never silent) -----------------------------------

test('warm: loads the client, builds the BulkWriter and makes ONE read of the warm doc; a hanging read gives up at its timeout', async () => {
  const { WARM_DOC_ID } = require('../src/services/priceCacheStore');
  const fake = createFakeFirestore();
  const lines = [];
  const store = createFirestorePriceCacheStore({ client: fake.db, log: (e, f) => lines.push({ e, ...f }) });
  const ok = await store.warm();
  assert.equal(ok.ok, true);
  assert.deepEqual(fake.calls.getAll, [[`verified_prices/${WARM_DOC_ID}`]]);
  assert.equal(fake.calls.writerOptions.length, 1, 'the BulkWriter is built at warm-up too');
  fake.faults.getAllDelayMs = 1000;
  const t = Date.now();
  const slow = await store.warm({ timeoutMs: 50 });
  assert.equal(slow.ok, false);
  assert.ok(Date.now() - t < 500);
  assert.equal(lines[0].e, 'price_cache_warm_failed');
  assert.equal(lines[0].code, 'timeout');
});

test('S2: a flush Firestore never answers gives up after its deadline, is logged as flush_timeout, and is counted', { timeout: 5000 }, async () => {
  // Holds the loop while the (unref'd) flush deadline runs, and lets go by itself: a flush that never gives up
  // fails this test in seconds instead of hanging the file.
  const keep = setTimeout(() => {}, 3000);
  try {
    const fake = createFakeFirestore();
    const lines = [];
    const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, flushTimeoutMs: 40, maxPending: 3, log: (e, f) => lines.push({ e, ...f }) });
    fake.faults.writeHang = true;
    store.putPrice(id(1), doc(T0));
    store.putPrice(id(2), doc(T0));
    const t = Date.now();
    await store.flush();
    assert.ok(Date.now() - t < 1000, 'the flush gave up waiting');
    assert.deepEqual(lines.filter((l) => l.e === 'price_cache_write_failed'), [{ e: 'price_cache_write_failed', failures: 1, code: 'flush_timeout' }]);
    const stat = lines.find((l) => l.e === 'price_cache_store_stats');
    assert.deepEqual(stat, { e: 'price_cache_store_stats', written: 0, failed: 0, dropped: 0, flush_timeouts: 1, resets: 0, abandoned: 0, reenabled: 0, probes: 0, clients_built: 0, pending: 0, inflight: 2 });
    assert.equal(store.stats().inflight, 2);
    // Two writes are still inside the client: room for one more, then drops (counted) until Firestore answers.
    store.putPrice(id(3), doc(T0));
    store.putPrice(id(4), doc(T0));
    store.putPrice(id(5), doc(T0));
    assert.equal(store.stats().dropped, 2);
    fake.release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.stats().inflight, 0);
    assert.equal(store.stats().written, 2, 'the timed-out writes landed later and were counted then');
    store.putPrice(id(6), doc(T0));
    await store.flush();
    assert.equal(store.stats().written, 4);
  } finally {
    clearTimeout(keep);
  }
});

test('the stats line: at most once a minute, only when something moved, with what is queued and in flight', async () => {
  let t = T0;
  const fake = createFakeFirestore();
  const lines = [];
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, now: () => t, log: (e, f) => lines.push({ e, ...f }) });
  store.putPrice(id(1), doc(T0));
  await store.flush();
  store.putPrice(id(2), doc(T0));
  await store.flush();
  const stats = () => lines.filter((l) => l.e === 'price_cache_store_stats');
  assert.deepEqual(stats(), [{ e: 'price_cache_store_stats', written: 1, failed: 0, dropped: 0, flush_timeouts: 0, resets: 0, abandoned: 0, reenabled: 0, probes: 0, clients_built: 0, pending: 0, inflight: 0 }]);
  t += 61 * 1000;
  await store.flush();
  assert.equal(stats().length, 2);
  assert.equal(stats()[1].written, 1, 'the delta since the last line');
  t += 61 * 1000;
  await store.flush();
  assert.equal(stats().length, 2, 'a quiet minute writes no line');
});

test('a hung connection: after 3 flush timeouts in a row the BulkWriter and client are rebuilt, the stuck writes are abandoned', { timeout: 5000 }, async () => {
  const keep = setTimeout(() => {}, 3000);
  try {
    const { RESET_AFTER_FLUSH_TIMEOUTS } = require('../src/services/priceCacheStore');
    assert.equal(RESET_AFTER_FLUSH_TIMEOUTS, 3);
    const hung = createFakeFirestore();
    const fresh = createFakeFirestore();
    const clients = [hung.db, fresh.db];
    let built = 0;
    const lines = [];
    const store = createFirestorePriceCacheStore({
      clientFactory: () => clients[built++], flushMs: 60000, flushTimeoutMs: 15, maxPending: 4,
      log: (e, f) => lines.push({ e, ...f }),
    });
    hung.faults.writeHang = true;
    for (let i = 1; i <= 2; i += 1) {
      store.putPrice(id(i), doc(T0));
      await store.flush();
    }
    assert.equal(store.stats().inflight, 2);
    assert.equal(store.stats().resets, 0, 'two timeouts: not yet');
    store.putPrice(id(3), doc(T0));
    await store.flush();
    assert.deepEqual([store.stats().resets, store.stats().abandoned, store.stats().inflight], [1, 3, 0]);
    assert.deepEqual(lines.find((l) => l.e === 'price_cache_store_reset'), { e: 'price_cache_store_reset', abandoned: 3, resets: 1 });
    assert.equal(hung.db.terminated, undefined, 'the old client is only let go, never terminated');
    // Firestore is back: new writes go through a NEW client and writer, and nothing is pinned.
    store.putPrice(id(4), doc(T0));
    await store.flush();
    assert.equal(built, 2);
    assert.equal(fresh.docs.has(`verified_prices/${id(4)}`), true);
    assert.equal(store.stats().inflight, 0);
    // The old connection finally answers: those writes were counted as abandoned, so they are not counted again as
    // written, and never push inflight below zero.
    const written = store.stats().written;
    hung.release();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.stats().inflight, 0);
    assert.equal(store.stats().failed, 0, 'abandoned writes are not counted twice');
    assert.equal(store.stats().written, written, 'an abandoned write that lands is not counted as written too');
    assert.equal(hung.db.terminated, undefined, 'a rebuilt-away client is never terminated (B1)');
  } finally {
    clearTimeout(keep);
  }
});

test('a timeout streak is broken by any flush that settles; an injected client is kept, only the writer is rebuilt', { timeout: 5000 }, async () => {
  const keep = setTimeout(() => {}, 3000);
  try {
    const fake = createFakeFirestore();
    const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, flushTimeoutMs: 15 });
    fake.faults.writeHang = true;
    store.putPrice(id(1), doc(T0)); await store.flush();
    store.putPrice(id(2), doc(T0)); await store.flush();
    fake.release();
    await new Promise((r) => setTimeout(r, 10));
    store.putPrice(id(3), doc(T0)); await store.flush();
    fake.faults.writeHang = true;
    store.putPrice(id(4), doc(T0)); await store.flush();
    store.putPrice(id(5), doc(T0)); await store.flush();
    assert.equal(store.stats().resets, 0, '2 + (a good flush) + 2 is not 3 in a row');
    store.putPrice(id(6), doc(T0)); await store.flush();
    assert.equal(store.stats().resets, 1);
    fake.release();
    store.putPrice(id(7), doc(T0)); await store.flush();
    assert.equal(fake.calls.writerOptions.length, 2, 'a new BulkWriter on the same injected client');
    assert.equal(fake.docs.has(`verified_prices/${id(7)}`), true);
    assert.equal(fake.db.terminated, undefined, 'an injected client is never terminated by a reset');
  } finally {
    clearTimeout(keep);
  }
});

test('the stats line runs on its own clock: drops after traffic stops are still logged', { timeout: 5000 }, async () => {
  const fake = createFakeFirestore();
  const lines = [];
  const store = createFirestorePriceCacheStore({ client: fake.db, flushMs: 60000, maxPending: 1, statsLogEveryMs: 40, log: (e, f) => lines.push({ e, ...f }) });
  try {
    store.putPrice(id(1), doc(T0));
    store.putPrice(id(2), doc(T0)); // the queue is full: dropped
    const keep = setTimeout(() => {}, 1000);
    await new Promise((r) => setTimeout(r, 120));
    clearTimeout(keep);
    const stat = lines.find((l) => l.e === 'price_cache_store_stats');
    assert.ok(stat, 'logged without any flush');
    assert.equal(stat.dropped, 1);
    assert.equal(stat.pending, 1);
  } finally {
    await store.close();
  }
});

test('an abandoned write that later FAILS is not counted again (it was counted as abandoned)', { timeout: 5000 }, async () => {
  const keep = setTimeout(() => {}, 3000);
  try {
    const hung = createFakeFirestore();
    const fresh = createFakeFirestore();
    const clients = [hung.db, fresh.db];
    let built = 0;
    const store = createFirestorePriceCacheStore({ clientFactory: () => clients[built++], flushMs: 60000, flushTimeoutMs: 15 });
    hung.faults.writeHang = true;
    for (let i = 1; i <= 3; i += 1) {
      store.putPrice(id(i), doc(T0));
      await store.flush();
    }
    assert.deepEqual([store.stats().resets, store.stats().abandoned, store.stats().failed], [1, 3, 0]);
    hung.release({ fail: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([store.stats().failed, store.stats().inflight, store.stats().written], [0, 0, 0]);
  } finally {
    clearTimeout(keep);
  }
});

test('no project: the store refuses to build (it never lets the library pick GOOGLE_CLOUD_PROJECT)', () => {
  const saved = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = 'vertex-billing-project';
  try {
    for (const projectId of [undefined, '', '  ']) {
      assert.throws(() => createFirestorePriceCacheStore({ database: 'price-cache', projectId }), (e) => e.code === 'project_unset', String(projectId));
    }
    const s = createFirestorePriceCacheStore({ database: 'price-cache', projectId: 'cache-project-test', flushMs: 600000 });
    const db = s._client();
    assert.equal(db.projectId, 'cache-project-test');
    return db.terminate();
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = saved;
  }
});

// ---- S-R4: a dead Firestore cannot make the store hold dropped clients forever ---------------------------------

test('reset cap: after 5 resets with no write landing, the store disables itself (once) and builds no more clients', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { RESET_CAP_WITHOUT_SUCCESS } = require('../src/services/priceCacheStore');
    assert.equal(RESET_CAP_WITHOUT_SUCCESS, 5);
    const clients = [];
    const lines = [];
    const store = createFirestorePriceCacheStore({
      clientFactory: () => { const f = createFakeFirestore(); f.faults.writeHang = true; clients.push(f); return f.db; },
      flushMs: 60000, flushTimeoutMs: 10, log: (e, f) => lines.push({ e, ...f }),
    });
    for (let i = 1; i <= 30; i += 1) {
      store.putPrice(id(i), doc(T0));
      await store.flush();
    }
    const st = store.stats();
    assert.equal(st.resets, 5, 'it stopped at the cap');
    assert.equal(st.disabled, true);
    assert.equal(clients.length, 5, 'no client after the one that hit the cap');
    assert.equal(lines.filter((l) => l.e === 'price_cache_store_disabled').length, 1, 'logged once');
    assert.deepEqual(lines.find((l) => l.e === 'price_cache_store_disabled'), { e: 'price_cache_store_disabled', resets: 5, abandoned: 15, reason: 'no_write_succeeded' });
    assert.equal(st.queued + st.dropped, 30, 'every put is either queued or dropped');
    assert.equal(st.abandoned, st.queued, 'every queued write was abandoned (none landed, none left in flight)');
    assert.equal(st.dropped, 15, 'after disabling, every write is dropped and counted');
    // Disabled: reads are misses without touching any client, the warm-up does nothing.
    assert.equal((await store.getPrices([id(1)])).size, 0);
    assert.equal(await store.getHostBackoff('shop.example.com'), null);
    assert.deepEqual(await store.warm(), { ok: false, ms: 0 });
    assert.ok(clients.every((c) => c.calls.getAll.length === 0 && c.calls.get.length === 0));
    for (const c of clients) c.release();
  } finally {
    clearTimeout(keep);
  }
});

test('reset cap: any write that lands (even a late one from a dropped client) restarts the count: a slow Firestore is never disabled', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const clients = [];
    const store = createFirestorePriceCacheStore({
      clientFactory: () => { const f = createFakeFirestore(); f.faults.writeHang = true; clients.push(f); return f.db; },
      flushMs: 60000, flushTimeoutMs: 10,
    });
    let n = 0;
    const timeoutOnce = async () => { n += 1; store.putPrice(id(n), doc(T0)); await store.flush(); };
    for (let i = 0; i < 12; i += 1) await timeoutOnce(); // 4 resets
    assert.equal(store.stats().resets, 4);
    clients[0].release(); // the first, long-dropped connection finally answers: Firestore is alive
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 12; i += 1) await timeoutOnce(); // 4 more resets
    assert.equal(store.stats().resets, 8);
    assert.equal(store.stats().disabled, false, '4 + (a write landed) + 4 never reaches 5 in a row');
    assert.equal(store.stats().written, 0, 'the late writes were abandoned, so they are not counted as written');
    for (const c of clients) c.release();
  } finally {
    clearTimeout(keep);
  }
});

// ---- controller r5: a disabled store comes back -----------------------------------------------------------------

/** A store whose every client hangs until released; `healthyFrom` (1-based) makes that client and later ones answer. */
function hungStore({ healthyFrom = Infinity, ...opts } = {}) {
  const clients = [];
  const lines = [];
  const store = createFirestorePriceCacheStore({
    clientFactory: () => {
      const f = createFakeFirestore();
      if (clients.length + 1 < healthyFrom) f.faults.writeHang = true;
      clients.push(f);
      return f.db;
    },
    flushMs: 60000, flushTimeoutMs: 10, probeInitialMs: 1e9, log: (e, f) => lines.push({ e, ...f }), ...opts,
  });
  let n = 0;
  const put = async () => { n += 1; store.putPrice(id(n), doc(T0)); await store.flush(); };
  return { store, clients, lines, put };
}

test('proof of life: a write from a dropped client lands while disabled -> re-enabled, and ONE fresh client takes the next writes', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { store, clients, lines, put } = hungStore({ healthyFrom: 6 });
    for (let i = 0; i < 15; i += 1) await put();
    assert.equal(store.stats().disabled, true);
    assert.equal(clients.length, 5);
    await put(); // dropped while disabled
    assert.equal(store.stats().dropped, 1);
    clients[0].release(); // Firestore answers again: the first dropped client's writes land
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.stats().disabled, false);
    assert.equal(store.stats().reenabled, 1);
    assert.deepEqual(lines.find((l) => l.e === 'price_cache_store_enabled'), { e: 'price_cache_store_enabled', reason: 'write_landed', resets: 5 });
    assert.equal(clients.length, 5, 'nothing is built until a write needs it');
    await put();
    assert.equal(clients.length, 6, 'exactly one fresh client');
    assert.equal(clients[5].docs.size, 1, 'the next write went through it');
    assert.equal(store.stats().written, 1);
    for (const c of clients) c.release();
  } finally {
    clearTimeout(keep);
  }
});

test('a refused outage never re-enables: dropped writes that FAIL are no proof of life', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { store, clients, put } = hungStore();
    for (let i = 0; i < 15; i += 1) await put();
    assert.equal(store.stats().disabled, true);
    for (const c of clients) c.release({ fail: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.stats().disabled, true);
    assert.equal(store.stats().reenabled, 0);
    await put();
    assert.equal(clients.length, 5, 'still no new client');
  } finally {
    clearTimeout(keep);
  }
});

test('slow probe: one fresh client after the delay, one more reset and disabled again; the delay doubles to its cap; at most maxProbes', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { store, clients, lines, put } = hungStore({ probeInitialMs: 40, probeMaxMs: 200, maxProbes: 2 });
    for (let i = 0; i < 15; i += 1) await put();
    assert.equal(store.stats().disabled, true);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(store.stats().probes, 0, 'not before the delay');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.stats().probes, 1);
    assert.equal(store.stats().disabled, false);
    for (let i = 0; i < 3; i += 1) await put(); // the probe's client hangs too: one reset
    assert.deepEqual([store.stats().resets, store.stats().disabled, clients.length], [6, true, 6], 'one more reset, one more client, disabled again');
    await new Promise((r) => setTimeout(r, 55));
    assert.equal(store.stats().probes, 1, 'the second delay doubled to 80 ms: not yet at 55');
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(store.stats().probes, 2);
    for (let i = 0; i < 3; i += 1) await put();
    assert.equal(store.stats().disabled, true);
    await new Promise((r) => setTimeout(r, 300)); // a third probe would come at min(160, 200) = 160 ms
    assert.equal(store.stats().probes, 2, 'at most maxProbes');
    assert.equal(clients.length, 7);
    assert.deepEqual(lines.filter((l) => l.e === 'price_cache_store_enabled').map((l) => l.reason), ['probe', 'probe']);
    for (const c of clients) c.release();
  } finally {
    clearTimeout(keep);
  }
});

test('a probe whose client answers brings the store fully back (the next outage needs 5 resets again)', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { store, clients, put } = hungStore({ healthyFrom: 6, probeInitialMs: 20 });
    for (let i = 0; i < 15; i += 1) await put();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(store.stats().probes, 1);
    await put();
    assert.equal(store.stats().written, 1, 'the probe client wrote');
    assert.equal(store.stats().disabled, false);
    assert.equal(clients.length, 6);
    for (const c of clients) c.release();
  } finally {
    clearTimeout(keep);
  }
});

test('the probe defaults: 30 min, doubling to 4 h, at most 6 per process', () => {
  const { PROBE_INITIAL_MS, PROBE_MAX_MS, MAX_PROBES } = require('../src/services/priceCacheStore');
  assert.deepEqual([PROBE_INITIAL_MS, PROBE_MAX_MS, MAX_PROBES], [30 * 60 * 1000, 4 * 60 * 60 * 1000, 6]);
});

test('the probe delay doubles up to its cap', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { store, clients, put } = hungStore({ probeInitialMs: 20, probeMaxMs: 50, maxProbes: 4 });
    for (let i = 0; i < 15; i += 1) await put();
    const gaps = [];
    for (let k = 0; k < 3; k += 1) {
      const t = Date.now();
      while (store.stats().probes === k) await new Promise((r) => setTimeout(r, 2));
      gaps.push(Date.now() - t);
      for (let i = 0; i < 3; i += 1) await put(); // the probe fails: disabled again, the next delay starts now
    }
    // 20, 40, then capped at 50 (not 80); each measured from the re-disable, so allow a little slack.
    assert.ok(gaps[0] >= 18 && gaps[0] < 38, String(gaps));
    assert.ok(gaps[1] >= 38 && gaps[1] < 60, String(gaps));
    assert.ok(gaps[2] >= 48 && gaps[2] < 75, String(gaps));
    for (const c of clients) c.release();
  } finally {
    clearTimeout(keep);
  }
});

// ---- controller r6: a flapping Firestore cannot make the store build clients without bound ------------------------

test('flapping: down for 5 resets, up for one late write, again and again -> at most MAX_CLIENTS clients, then disabled until restart', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { MAX_CLIENTS } = require('../src/services/priceCacheStore');
    const { store, clients, lines, put } = hungStore({ probeInitialMs: 30 });
    for (let cycle = 0; cycle < 10; cycle += 1) {
      for (let i = 0; i < 15 && !store.stats().disabled; i += 1) await put(); // down: 5 resets, 5 stranded clients
      clients[clients.length - 1].release(); // a short healthy window: the newest dropped client's writes land
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(clients.length, MAX_CLIENTS, `built ${clients.length}`);
    assert.equal(store.stats().clients_built, MAX_CLIENTS);
    assert.equal(store.stats().disabled, true);
    assert.equal(store.stats().reenabled, MAX_CLIENTS / 5 - 1, 'it came back after each full cycle but the last');
    const budget = lines.filter((l) => l.e === 'price_cache_store_disabled' && l.reason === 'client_budget');
    assert.equal(budget.length, 1, 'logged once');
    assert.equal(budget[0].clients_built, MAX_CLIENTS);
    // Retired: every client answering again, a probe's delay passing, more writes: nothing brings it back.
    for (const c of clients) c.release();
    await new Promise((r) => setTimeout(r, 80));
    await put();
    assert.equal(store.stats().disabled, true);
    assert.equal(store.stats().probes, 0);
    assert.equal(clients.length, MAX_CLIENTS);
  } finally {
    clearTimeout(keep);
  }
});

test('the client budget is spent mid-cycle too: a slow-but-alive Firestore that keeps resetting stops at maxClients', { timeout: 10000 }, async () => {
  const keep = setTimeout(() => {}, 8000);
  try {
    const { store, clients, lines, put } = hungStore({ maxClients: 7 });
    for (let i = 0; i < 12; i += 1) {
      for (let k = 0; k < 3; k += 1) await put(); // one reset
      clients[clients.length - 1].release(); // the client just dropped lands its writes late: the reset cap never trips
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(lines.filter((l) => l.reason === 'no_write_succeeded').length, 0, 'never disabled by the reset cap');
    assert.equal(clients.length, 7);
    assert.equal(store.stats().resets, 7);
    assert.equal(store.stats().disabled, true);
    assert.deepEqual(lines.filter((l) => l.e === 'price_cache_store_disabled').map((l) => l.reason), ['client_budget']);
  } finally {
    clearTimeout(keep);
  }
});

test('the client budget: 20 by default, above what a refused-forever outage needs (5 resets + every probe)', () => {
  const { MAX_CLIENTS, RESET_CAP_WITHOUT_SUCCESS, MAX_PROBES } = require('../src/services/priceCacheStore');
  assert.equal(MAX_CLIENTS, 20);
  assert.ok(MAX_CLIENTS > RESET_CAP_WITHOUT_SUCCESS + MAX_PROBES);
});
