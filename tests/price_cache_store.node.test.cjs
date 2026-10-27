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
  assert.deepEqual(store.stats(), { queued: 3, written: 3, failed: 0, dropped: 0, flushes: 2, pending: 0 });
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
  assert.deepEqual(lines, [{ e: 'price_cache_write_failed', failures: 1, code: '14' }]);
  fake.faults.writeFailures = 2;
  store.putPrice(id(2), doc(T0));
  await store.flush();
  assert.equal(fake.docs.has(`verified_prices/${id(2)}`), true, 'two failures then a success: written');
  fake.faults.writeFailures = 3;
  store.putPrice(id(3), doc(T0));
  await store.flush();
  assert.equal(store.stats().failed, 2);
  assert.equal(lines.length, 1, 'the second failure inside the minute is counted, not logged');
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
    const s = createFirestorePriceCacheStore({ database: 'price-cache', flushMs: 600000 });
    const loadedAtBuild = before();
    s.putPrice('${id(1)}', { read_at: new Date() });
    const loadedAtQueue = before();
    console.log(JSON.stringify({ loadedAtBuild, loadedAtQueue }));
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { loadedAtBuild: false, loadedAtQueue: false });
});
