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
const { createPriceLogDoors, maskIds, rpc } = require('./_support/priceLogDoors.cjs');
const pc = require('../src/services/priceCache');
const { createFirestorePriceCacheStore } = require('../src/services/priceCacheStore');
const { createFakeFirestore } = require('./_support/fakeFirestore.cjs');

const FLAGS = ['PRICE_CACHE_STORE', 'PRICE_CACHE_MODE', 'PRICE_CACHE_FIRESTORE_DATABASE', 'PRICE_CACHE_FIRESTORE_PROJECT', 'PRICE_HOST_BUDGET', 'PRICE_HOST_BUDGET_INSTANCES'];
for (const k of FLAGS) delete process.env[k];

// R14: a flagged offer whose cart the backend mints once the gateway asserts the merchant's live answer (the
// GET_OFFERS_LIVE_CART contract), for product sig_cartwire only. Registered BEFORE the doors' own offers.resolve
// interceptor, so it answers first for that product and the doors' cases are untouched.
const STORE = 'store.price-log.test';
const VARIANT = '43734829564039';
const flaggedOffer = () => ({
  offer_id: `of:external_seed:eps_wire:${VARIANT}`, merchant_id: STORE, price: 20, currency: 'USD', availability: 'unknown',
  purchase_route: 'affiliate_outbound', affiliate_url: 'https://api.pivota.cc/r?token=first',
  execution_spec: { merchant_domain: STORE, variant_id: null, cart_url: null },
  requires_live_verification: { reasons: ['stale_snapshot'], price_stale: true, lookup_variant_id: VARIANT },
  source: { type: 'external_seed', seed_id: 'eps_wire', canonical_url: `https://${STORE}/products/tint` },
});
require('nock')('http://backend.price-log.test').persist()
  .post('/agent/shop/v1/invoke', (b) => b && b.operation === 'offers.resolve' && JSON.stringify(b).includes('sig_cartwire'))
  .reply(200, (uri, body) => {
    const tokens = body.payload && body.payload.liveVerifications;
    if (!tokens) return { offers: [flaggedOffer()], product_group_id: 'pg_wire' };
    // The backend's mint, per the contract: the asserted price, stock and variant, with a cart pinned to the market.
    const c = JSON.parse(Buffer.from(tokens[0].split('.')[1], 'base64url').toString('utf8'));
    const { requires_live_verification: _r, availability: _a, ...rest } = flaggedOffer();
    return {
      offers: [{
        ...rest, price: c.a, currency: c.c, in_stock: c.av, affiliate_url: 'https://api.pivota.cc/r?token=minted',
        execution_spec: { merchant_domain: STORE, variant_id: c.vid, cart_url: `https://${STORE}/cart/${c.vid}:1?country=${c.m}`, expected_item_total: c.a, expected_currency: c.c, expected_quantity: 1 },
        live_verification: { status: 'verified', source: 'gateway_live_read', checked_at: new Date(c.iat * 1000).toISOString(), amount: c.a, currency: c.c, variant_id: c.vid },
      }],
      product_group_id: 'pg_wire',
      live_verification_assertions: { received: tokens.length, accepted: 1, rejected: 0 },
    };
  });

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

const WRITE = { PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'write', PRICE_CACHE_FIRESTORE_DATABASE: 'price-cache', PRICE_CACHE_FIRESTORE_PROJECT: 'cache-project-test' };
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
  await pc.activePriceCache({ ...WRITE }).store.flush();
  const docs = [...fake.docs.entries()].filter(([p]) => p.startsWith('verified_prices/')).map(([, d]) => d);
  assert.ok(docs.length >= 1);
  const d = docs.find((x) => x.variant_id === '43734829564039');
  assert.deepEqual(
    { host: d.host, market: d.market, currency: d.currency, amount: d.amount, status: d.status, source: d.source, writer: d.writer, handle: d.handle },
    { host: 'store.price-log.test', market: 'US', currency: 'USD', amount: '23.00', status: 'verified', source: 'merchant_ucp', writer: 'offers', handle: 'tint' },
  );
  assert.equal(d.expire_at.toMillis() - d.read_at.toMillis(), 60 * 60 * 1000);
});

const supertest = require('supertest');
async function flushedDocs() {
  await pc.activePriceCache({ ...WRITE }).store.flush();
  return [...fake.docs.entries()].filter(([p]) => p.startsWith('verified_prices/')).map(([, d]) => d);
}

test('R13 WRITE MODE through the server\'s own overlay call: a search card the storefront verified is written (writer search)', async () => {
  const WIRE = 'wire.price-log.test';
  const WIRE_VARIANT = '43734829500001';
  const fetched = [];
  doors.app._debug.useSearchOverlayFetchForTest(async (url) => {
    fetched.push(url);
    return { ok: true, status: 200, json: async () => ({ product: { variants: [{ id: Number(WIRE_VARIANT), price: '27.00', price_currency: 'USD', available: true }] } }) };
  });
  Object.assign(process.env, WRITE);
  try {
    const page = { status: 'success', products: [{ product_id: 'sig_wire', price: 25, currency: 'USD', source_variant_id: WIRE_VARIANT, destination_url: `https://${WIRE}/products/wire-serum` }] };
    const out = await doors.app._debug.maybeOverlayLiveSearchPrice(page, { query: 'serum', market: 'US' }, { buyerMarket: 'US' });
    assert.equal(out.products[0].price, 27);
    assert.deepEqual(fetched, [`https://${WIRE}/products/wire-serum.json`]);
    const d = (await flushedDocs()).find((x) => x.variant_id === WIRE_VARIANT);
    assert.ok(d, 'the overlay\'s verified answer was written');
    assert.deepEqual([d.host, d.market, d.currency, d.amount, d.source, d.writer, d.handle], [WIRE, 'US', 'USD', '27.00', 'merchant_storefront', 'search', 'wire-serum']);
  } finally {
    doors.app._debug.useSearchOverlayFetchForTest(null);
    for (const k of FLAGS) delete process.env[k];
  }
});

test('R14 WRITE MODE through the MCP get_offers door: GET_OFFERS_LIVE_CART=on writes the minted cart (merchant_cart)', async () => {
  Object.assign(process.env, WRITE, { GET_OFFERS_LIVE_CART: 'on', OFFER_LIVE_VERIFICATION_SECRET: 'w'.repeat(40) });
  try {
    const r = await supertest(doors.app).post('/mcp').send(rpc('get_offers', { product_id: 'sig_cartwire', market: 'US' }));
    assert.equal(r.status, 200);
    assert.match(r.text, /cart\/43734829564039:1\?country=US/, 'the backend minted the cart (the answer redacts the affiliate token)');
    const d = (await flushedDocs()).find((x) => x.variant_id === VARIANT && x.host === STORE);
    assert.deepEqual([d.market, d.currency, d.amount, d.available, d.source, d.writer, d.handle], ['US', 'USD', '23.00', true, 'merchant_cart', 'cart', 'tint']);
  } finally {
    for (const k of [...FLAGS, 'GET_OFFERS_LIVE_CART', 'OFFER_LIVE_VERIFICATION_SECRET']) delete process.env[k];
  }
});
