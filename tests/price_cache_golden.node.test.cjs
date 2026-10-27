'use strict';

// THE SHARED VERIFIED-PRICE CACHE CHANGES NO ANSWER UNTIL IT READS: through the REAL doors (/mcp, /ucp/mcp,
// /public/mcp, REST search, invoke), every answer is byte-identical with the cache flags unset and with
// PRICE_CACHE_STORE=firestore + PRICE_CACHE_MODE=write, with PRICE_VERIFICATION_LOG off and on. Unset, no store
// is built and no Firestore client is loaded at all. In write mode the get_offers live read (UCP_LIVE_OFFER_READ=
// enforce here) does record the merchant's answer, so the writer is proven wired, not merely silent.
//
// HARNESS: tests/_support/priceLogDoors.cjs (the same doors the price_verification_served golden test drives;
// no store, backend or merchant is contacted). The store is the faithful Firestore fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPriceLogDoors, maskIds } = require('./_support/priceLogDoors.cjs');
const pc = require('../src/services/priceCache');
const { createFirestorePriceCacheStore } = require('../src/services/priceCacheStore');
const { createFakeFirestore } = require('./_support/fakeFirestore.cjs');

const FLAGS = ['PRICE_CACHE_STORE', 'PRICE_CACHE_MODE', 'PRICE_CACHE_FIRESTORE_DATABASE', 'PRICE_HOST_BUDGET', 'PRICE_HOST_BUDGET_INSTANCES'];
for (const k of FLAGS) delete process.env[k];

const doors = createPriceLogDoors({ port: 3994 });
const { CASES } = doors;

const fake = createFakeFirestore();
const built = [];
pc._setStoreFactoryForTest((settings) => {
  built.push(settings.database);
  return createFirestorePriceCacheStore({ client: fake.db, database: settings.database, flushMs: 60000 });
});

test.before(() => doors.start(test.mock.timers));
test.after(async () => {
  pc._setStoreFactoryForTest(null);
  await doors.stop(test.mock.timers);
});

const firestoreLoaded = () => Object.keys(require.cache).some((k) => /@google-cloud[\\/]firestore|google-gax|@grpc[\\/]grpc-js/.test(k));

async function sendWith(env, request, flag) {
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await doors.send(request, { flag });
  } finally {
    for (const k of FLAGS) delete process.env[k];
  }
}

const WRITE = { PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'write', PRICE_CACHE_FIRESTORE_DATABASE: 'price-cache' };
const offs = new Map();

test('FLAGS UNSET: every door answers, and no store is built and no Firestore client is loaded', async () => {
  assert.equal(firestoreLoaded(), false, 'not loaded by the server at start');
  for (const [name, request] of Object.entries(CASES)) {
    for (const flag of [false, true]) {
      const r = await sendWith({}, request, flag);
      assert.equal(r.status, 200, `${name}: ${r.text.slice(0, 200)}`);
      offs.set(`${name}|${flag}`, r);
    }
  }
  // Half-on is off: a store without a mode, or a mode without a store.
  for (const env of [{ PRICE_CACHE_STORE: 'firestore' }, { PRICE_CACHE_MODE: 'write' }, { PRICE_CACHE_MODE: 'read' }]) {
    const r = await sendWith(env, CASES.mcp_get_offers, false);
    assert.equal(maskIds(r.text), maskIds(offs.get('mcp_get_offers|false').text));
  }
  assert.deepEqual(built, [], 'no store was built');
  assert.equal(firestoreLoaded(), false, 'no Firestore client, gax or gRPC module was ever required');
  assert.equal(fake.calls.getAll.length + fake.calls.get.length + fake.calls.batches.length, 0);
});

test('WRITE MODE: every door\'s answer is byte-identical to flags unset, log flag off and on, and nothing is read', async () => {
  assert.ok(offs.size > 0, 'the unset pass ran first');
  for (const [name, request] of Object.entries(CASES)) {
    for (const flag of [false, true]) {
      const off = offs.get(`${name}|${flag}`);
      const on = await sendWith(WRITE, request, flag);
      assert.equal(on.status, off.status, name);
      assert.equal(maskIds(on.text), maskIds(off.text), `${name} (log ${flag ? 'on' : 'off'}): write mode must not change a byte`);
      // (Fewer is the readers' own 30 s lookup memo under the frozen clock; never a call the unset pass did not make.)
      for (const call of on.merchant) assert.ok(off.merchant.includes(call), `${name}: no new merchant call: ${call}`);
    }
  }
  assert.deepEqual(built, ['price-cache'], 'one store, the named database');
  assert.equal(fake.calls.getAll.length, 0, 'write mode never reads the cache');
});

test('WRITE MODE wrote what the get_offers live read verified: the doors\' merchant answer, under the declared market', async () => {
  await sendWith(WRITE, CASES.mcp_get_offers, false);
  await pc.activePriceCache({ PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'write' }).store.flush();
  const docs = [...fake.docs.entries()].filter(([p]) => p.startsWith('verified_prices/')).map(([, d]) => d);
  assert.ok(docs.length >= 1);
  const d = docs.find((x) => x.variant_id === '43734829564039');
  assert.deepEqual(
    { host: d.host, market: d.market, currency: d.currency, amount: d.amount, status: d.status, source: d.source, writer: d.writer, handle: d.handle },
    { host: 'store.price-log.test', market: 'US', currency: 'USD', amount: '23.00', status: 'verified', source: 'merchant_ucp', writer: 'offers', handle: 'tint' },
  );
  assert.equal(d.expire_at.toMillis() - d.read_at.toMillis(), 60 * 60 * 1000);
});
