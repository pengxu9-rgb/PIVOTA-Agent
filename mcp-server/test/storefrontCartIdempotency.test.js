// A RETRIED STOREFRONT CREATE RETURNS THE SAME CHECKOUT (AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED): the ledger
// itself and the lane. The doors end to end: tests/store_cart_idempotency_door.node.test.cjs.
//
// Pinned here: the switch; what "the same request" is (the market included); what is stored and that only the same
// buyer and key can open it; one build under concurrency, the loser reading the winner's checkout; the terminal
// refusal for another request under the key; the retriable answer while the first is still building; fail open,
// counted, when there is no store or the store fails; a build that hands out nothing leaves no record.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  STORE_CART_IDEMPOTENCY_FLAG, CLAIM_LEASE_MS, KEY_REUSED_REASON, IN_FLIGHT_REASON, STORE_CART_IDEMPOTENCY_NAMESPACE,
  storeCartIdempotencyEnabled, storeCartIdempotencyCounts, resetStoreCartIdempotencyCountsForTest,
  canonicalRequest, requestFingerprint, recordKey, sealCheckoutId, openCheckoutId, runIdempotentCart,
} from '../src/storefrontCartIdempotency.js';
import { MERCHANT_PRICING_FLAG } from '../src/ucpMerchantDoorPricing.js';
import { UCP_ESCALATION_FLAG, ESCALATION_TTL_MS, tryEscalateUcpCheckout } from '../src/ucpCheckoutEscalation.js';
import { InMemoryKvStore } from '../../safety-kernel/src/stores.js';
import { createCommerceMount } from '../../safety-kernel/src/mount.js';
import { PivotaCommerceError } from '../../safety-kernel/src/errors.js';

const SCOPE = Object.freeze({ door: 'ucp', userRef: 'buyer-0001', rawKey: 'idem-key-0001' });
const FP = requestFingerprint(canonicalRequest({ items: [{ product_id: 'p1', quantity: 1 }], market: 'US' }));
const ID = 'esc_eyJ2IjoyfQ';
const TTL = 6 * 60 * 60 * 1000;

beforeEach(() => resetStoreCartIdempotencyCountsForTest());

function harness({ store = new InMemoryKvStore(), buildMs = 0, id = ID } = {}) {
  const calls = { build: 0, replay: [] };
  const run = (over = {}) => runIdempotentCart({
    store, scope: SCOPE, fingerprint: FP, ttlMs: TTL, now: () => 1000,
    build: async () => {
      calls.build += 1;
      if (buildMs) await new Promise((r) => setTimeout(r, buildMs));
      return { answer: { id, built: calls.build }, id };
    },
    replay: async (storedId, createdAt) => { calls.replay.push([storedId, createdAt]); return { id: storedId, replayed: true }; },
    pollMs: 5,
    ...over,
  });
  return { store, calls, run };
}

describe('the switch and the constants', () => {
  test('values', () => {
    assert.equal(STORE_CART_IDEMPOTENCY_FLAG, 'AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED');
    for (const v of ['1', 'true', 'on', 'YES']) assert.equal(storeCartIdempotencyEnabled({ [STORE_CART_IDEMPOTENCY_FLAG]: v }), true);
    for (const v of ['', '0', 'off', 'enabled', undefined]) assert.equal(storeCartIdempotencyEnabled({ [STORE_CART_IDEMPOTENCY_FLAG]: v }), false);
  });
  test('a record lives as long as the checkout id says it does; a claim outlives the slowest create', () => {
    assert.equal(ESCALATION_TTL_MS, TTL);
    assert.ok(CLAIM_LEASE_MS >= 3000 + 1000 + 5000 + 2000 + 5000);
  });
  test('the store is the kernel\'s own backing, in a namespace of its own', async () => {
    const mount = createCommerceMount({ upstream: async () => ({}), secret: 'x'.repeat(32), strict: false });
    const store = mount.stateStore(STORE_CART_IDEMPOTENCY_NAMESPACE);
    assert.equal(typeof store.putIfAbsent, 'function');
    assert.equal(store.durable, false, 'in-process only where the kernel itself is');
    const queries = [];
    const durable = createCommerceMount({ upstream: async () => ({}), secret: 'x'.repeat(32), strict: false, db: { query: async (text, params) => { queries.push(params); return { rows: [] }; } } });
    const shared = durable.stateStore(STORE_CART_IDEMPOTENCY_NAMESPACE);
    assert.equal(shared.durable, true);
    await shared.get('k');
    assert.ok(queries[0].includes(STORE_CART_IDEMPOTENCY_NAMESPACE));
  });
});

describe('the same request', () => {
  const base = { items: [{ product_id: 'p1', quantity: 2, variant_id: 'v1' }, { product_id: 'p2', quantity: 1 }], market: 'US', marketAssumed: false, discountCodes: [['SAVE10'], null], sellerNamed: 'seller-a', expectedSeller: undefined };
  const fp = (over) => requestFingerprint(canonicalRequest({ ...base, ...over }));
  test('line order does not matter; everything else does', () => {
    assert.equal(fp({ items: [...base.items].reverse() }), fp({}));
    const different = {
      'a quantity': { items: [{ product_id: 'p1', quantity: 3, variant_id: 'v1' }, base.items[1]] },
      'a variant': { items: [{ product_id: 'p1', quantity: 2, variant_id: 'v2' }, base.items[1]] },
      'no variant': { items: [{ product_id: 'p1', quantity: 2 }, base.items[1]] },
      'a product': { items: [base.items[0], { product_id: 'p3', quantity: 1 }] },
      'one line fewer': { items: [base.items[0]] },
      'the market': { market: 'GB' },
      'an assumed market': { marketAssumed: true },
      'no market': { market: null },
      'a discount code': { discountCodes: [['SAVE20'], null] },
      'no discount code': { discountCodes: [null, null] },
      'the seller named': { sellerNamed: 'seller-b' },
      'an expected seller': { expectedSeller: 'shop-a.example.com' },
    };
    for (const [name, over] of Object.entries(different)) assert.notEqual(fp(over), fp({}), name);
  });
  test('a GB cart and a US cart are never the same request', () => {
    assert.notEqual(fp({ market: 'GB' }), fp({ market: 'US' }));
    assert.equal(canonicalRequest({ ...base, market: 'GB' }).market, 'GB');
  });
  test('nothing of the buyer is in it', () => {
    assert.deepEqual(Object.keys(canonicalRequest(base)), ['v', 'lines', 'market', 'market_assumed', 'discount_codes', 'seller_named', 'expected_seller']);
  });
});

describe('what is stored', () => {
  test('the key names neither the buyer nor the key; the id is sealed to the same door, buyer and key', async () => {
    const h = harness();
    await h.run();
    const key = recordKey(SCOPE);
    assert.match(key, /^sci1_[0-9a-f]{64}$/);
    const record = await h.store.get(key);
    assert.deepEqual(Object.keys(record).sort(), ['created_at', 'fp', 'sealed', 'status']);
    assert.equal(record.status, 'done');
    assert.equal(record.fp, FP);
    const stored = JSON.stringify([key, record]);
    for (const secret of [SCOPE.userRef, SCOPE.rawKey, ID]) assert.equal(stored.includes(secret), false, secret);
    assert.equal(openCheckoutId(record.sealed, SCOPE), ID);
    for (const other of [{ ...SCOPE, userRef: 'buyer-0002' }, { ...SCOPE, rawKey: 'idem-key-0002' }, { ...SCOPE, door: 'mcp' }]) {
      assert.equal(openCheckoutId(record.sealed, other), null);
      assert.notEqual(recordKey(other), key);
    }
    assert.equal(openCheckoutId('not.a.record', SCOPE), null);
    assert.notEqual(sealCheckoutId(ID, SCOPE), sealCheckoutId(ID, SCOPE), 'a fresh nonce per record');
  });
  test('a finished record expires with the checkout id; a claim with its lease', async () => {
    const ttls = [];
    const store = new InMemoryKvStore();
    const spy = { ...store, get: (k) => store.get(k), compareAndDelete: (...a) => store.compareAndDelete(...a),
      putIfAbsent: (k, v, o) => { ttls.push(['claim', o.ttlMs]); return store.putIfAbsent(k, v, o); },
      compareAndSet: (k, f, m, v, o) => { ttls.push(['done', o.ttlMs]); return store.compareAndSet(k, f, m, v, o); } };
    await harness({ store: spy }).run();
    assert.deepEqual(ttls, [['claim', CLAIM_LEASE_MS], ['done', TTL]]);
  });
});

describe('retries', () => {
  test('the same request again: built once, then read back with the id and the time of the first', async () => {
    const h = harness();
    const first = await h.run();
    const second = await h.run();
    const third = await h.run();
    assert.deepEqual(first, { id: ID, built: 1 });
    assert.deepEqual([second, third], [{ id: ID, replayed: true }, { id: ID, replayed: true }]);
    assert.equal(h.calls.build, 1);
    assert.deepEqual(h.calls.replay, [[ID, 1000], [ID, 1000]]);
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, replayed: 2 });
  });

  test('another request under the key: refused, terminally, with the kernel ledger\'s code; nothing is built', async () => {
    const h = harness();
    await h.run();
    await assert.rejects(h.run({ fingerprint: 'f'.repeat(64) }), (err) => {
      assert.ok(err instanceof PivotaCommerceError);
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(err.retriable, false);
      assert.equal(err.detail.reason, KEY_REUSED_REASON);
      return true;
    });
    assert.equal(h.calls.build, 1);
    assert.deepEqual(h.calls.replay, []);
    assert.equal(storeCartIdempotencyCounts().conflict, 1);
  });

  test('another buyer, another key or another door under the same words is a build of its own', async () => {
    const h = harness();
    await h.run();
    for (const scope of [{ ...SCOPE, userRef: 'buyer-0002' }, { ...SCOPE, rawKey: 'idem-key-0002' }, { ...SCOPE, door: 'mcp' }]) await h.run({ scope });
    assert.equal(h.calls.build, 4);
    assert.deepEqual(h.calls.replay, []);
  });

  test('a build that hands out no checkout (a decline) leaves no record: the retry builds again', async () => {
    const h = harness({ id: null });
    await h.run();
    await h.run();
    assert.equal(h.calls.build, 2);
    assert.equal(await h.store.get(recordKey(SCOPE)), undefined);
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 2, released: 2 });
  });

  test('a build that throws releases its claim and rethrows: the retry builds again', async () => {
    const h = harness();
    const boom = new PivotaCommerceError('OUT_OF_STOCK', { reason: 'ucp_seller_out_of_stock' });
    await assert.rejects(h.run({ build: async () => { throw boom; } }), (err) => err === boom);
    assert.equal(await h.store.get(recordKey(SCOPE)), undefined);
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
  });
});

describe('two creates at the same moment', () => {
  test('ONE builds; the other waits and reads the same checkout back', async () => {
    const h = harness({ buildMs: 60 });
    const answers = await Promise.all([h.run(), h.run(), h.run()]);
    assert.equal(h.calls.build, 1, 'the store is called by one create only');
    assert.deepEqual(answers.map((a) => a.id), [ID, ID, ID]);
    assert.equal(answers.filter((a) => a.replayed).length, 2);
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, replayed_after_wait: 2 });
  });

  test('a different request arriving while the first builds is refused at once, not after the wait', async () => {
    const h = harness({ buildMs: 80 });
    const first = h.run();
    const started = Date.now();
    await assert.rejects(h.run({ fingerprint: 'e'.repeat(64) }), (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.detail.reason === KEY_REUSED_REASON);
    assert.ok(Date.now() - started < 60);
    await first;
    assert.equal(h.calls.build, 1);
  });

  test('the first still building when the wait ends: retriable, "retry the same request", never "start another"', async () => {
    const h = harness({ buildMs: 150 });
    const first = h.run();
    await assert.rejects(h.run({ waitMs: 30 }), (err) => {
      assert.equal(err.code, 'CHECKOUT_OUTCOME_UNKNOWN');
      assert.equal(err.retriable, true);
      assert.equal(err.detail.reason, IN_FLIGHT_REASON);
      return true;
    });
    assert.deepEqual(await first, { id: ID, built: 1 });
    assert.equal(h.calls.build, 1);
    // And the retry it asked for reads the checkout back.
    assert.deepEqual(await h.run(), { id: ID, replayed: true });
  });

  test('the winner fails: a waiting create takes the claim and builds', async () => {
    const h = harness();
    let n = 0;
    const build = async () => {
      n += 1;
      if (n === 1) { await new Promise((r) => setTimeout(r, 40)); throw new Error('first attempt failed'); }
      return { answer: { id: ID, built: n }, id: ID };
    };
    const [a, b] = await Promise.allSettled([h.run({ build }), h.run({ build })]);
    assert.equal(a.status, 'rejected');
    assert.deepEqual(b.value, { id: ID, built: 2 });
  });
});

describe('fail open, counted', () => {
  const broken = (failing) => {
    const store = new InMemoryKvStore();
    const wrap = (name) => (...a) => (failing.includes(name) ? Promise.reject(new Error('store down')) : store[name](...a));
    return { get: wrap('get'), putIfAbsent: wrap('putIfAbsent'), compareAndSet: wrap('compareAndSet'), compareAndDelete: wrap('compareAndDelete') };
  };
  test('no store wired: every create builds, as before the switch existed', async () => {
    const h = harness();
    assert.deepEqual(await h.run({ store: undefined }), { id: ID, built: 1 });
    assert.deepEqual(await h.run({ store: undefined }), { id: ID, built: 2 });
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:no_store': 2 });
  });
  test('the claim cannot be written: the create builds', async () => {
    const h = harness({ store: broken(['putIfAbsent']) });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(await h.run(), { id: ID, built: 2 });
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:claim': 2 });
  });
  test('the result cannot be written: the buyer still gets the checkout', async () => {
    const h = harness({ store: broken(['compareAndSet']) });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(storeCartIdempotencyCounts(), { claimed: 1, finalize_failed: 1 });
  });
  test('the record cannot be read: the create builds', async () => {
    const store = new InMemoryKvStore();
    await harness({ store }).run();
    resetStoreCartIdempotencyCountsForTest();
    const h = harness({ store: { ...broken(['get']), putIfAbsent: (...a) => store.putIfAbsent(...a) } });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:read': 1 });
  });
  test('a record this buyer and key cannot open is not read back', async () => {
    const store = new InMemoryKvStore();
    await store.putIfAbsent(recordKey(SCOPE), { fp: FP, status: 'done', sealed: sealCheckoutId(ID, { ...SCOPE, userRef: 'someone-else' }), created_at: 1 }, { ttlMs: TTL });
    const h = harness({ store });
    assert.deepEqual(await h.run(), { id: ID, built: 1 });
    assert.deepEqual(h.calls.replay, []);
    assert.deepEqual(storeCartIdempotencyCounts(), { 'fail_open:unreadable_record': 1 });
  });
});

// ---- the lane ---------------------------------------------------------------------------------------------------

describe('the lane', () => {
  const ON = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1', [STORE_CART_IDEMPOTENCY_FLAG]: '1' };
  const GID = (n) => `gid://shopify/ProductVariant/${n}`;
  const SEED = Object.freeze({
    product_id: 'sig_idem_a', merchant_id: 'merch_obs_shop_a', title: 'Serum X', price: 25, currency: 'USD',
    external_redirect_url: 'https://shop-a.example.com/products/serum-x?variant=1',
    variants: [{ variant_id: 'sig_idem_a', source_variant_id: '44012345678901' }],
  });
  const executor = { async execute(op, params) { return op === 'get_product' ? { product: structuredClone(SEED) } : {}; } };
  function fakeDoor() {
    const calls = [];
    let seq = 0;
    const carts = new Map();
    const cart = (id, quantity) => ({ ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify({
      id, currency: 'USD', continue_url: `https://shop-a.example.com/cart/c/${id}?key=secret-${id}`,
      line_items: [{ id: 'l0', item: { id: GID('44012345678901'), title: 'T', price: 2400 }, quantity, totals: [{ type: 'subtotal', amount: 2400 * quantity }, { type: 'total', amount: 2400 * quantity }] }],
      totals: [{ type: 'subtotal', amount: 2400 * quantity }, { type: 'total', amount: 2400 * quantity }],
    }) }] } } });
    return {
      calls,
      async endpointFor() { return 'https://shop-a.example.com/api/ucp/mcp'; },
      async createCart(_ep, args) { seq += 1; const id = `cart_${seq}`; carts.set(id, args.lineItems[0].quantity); calls.push(['create_cart', id, args.context]); await new Promise((r) => setTimeout(r, 20)); return cart(id, args.lineItems[0].quantity); },
      async getCart(_ep, id) { calls.push(['get_cart', id]); return cart(id, carts.get(id)); },
    };
  }
  const create = ({ env = ON, store, door, key = 'idem-lane-0001', quantity = 2, market = 'US', user = 'buyer-0001', email, now = 5000, idempotencyDoor }) => tryEscalateUcpCheckout({
    op: { id: 'create_checkout_session' }, ctx: { user_ref: user },
    params: { idempotency_key: key, quote: { items: [{ product_id: SEED.product_id, quantity }], ...(email ? { customer_email: email } : {}) } },
    executor, ucpArgs: market ? { checkout: { context: { address_country: market } } } : {}, env, now, merchantDoor: door, idempotencyStore: store, idempotencyDoor,
  });

  test('a retry is the same answer, member for member, from one cart; a later retry states the first expiry', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const first = await create({ store, door, email: 'buyer@example.com' });
    const retry = await create({ store, door, email: 'buyer@example.com', now: 5000 + 60000 });
    assert.deepEqual(retry, first);
    assert.equal(retry.expires_at, new Date(5000 + ESCALATION_TTL_MS).toISOString());
    assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart', 'get_cart']);
    assert.equal(retry.buyer.email, 'buyer@example.com');
  });

  test('the lane\'s record lives exactly as long as the id it hands out: six hours', async () => {
    const real = new InMemoryKvStore();
    const ttls = [];
    const store = { get: (k) => real.get(k), putIfAbsent: (k, v, o) => real.putIfAbsent(k, v, o), compareAndDelete: (...a) => real.compareAndDelete(...a),
      compareAndSet: (k, f, m, v, o) => { ttls.push(o.ttlMs); return real.compareAndSet(k, f, m, v, o); } };
    const out = await create({ store, door: fakeDoor(), now: 5000 });
    assert.deepEqual(ttls, [ESCALATION_TTL_MS]);
    assert.equal(Date.parse(out.expires_at) - 5000, ESCALATION_TTL_MS);
  });

  test('flag off: every create is a cart of its own, store or no store', async () => {
    const door = fakeDoor();
    const env = { ...ON, [STORE_CART_IDEMPOTENCY_FLAG]: '' };
    const a = await create({ env, store: new InMemoryKvStore(), door });
    const b = await create({ env, store: new InMemoryKvStore(), door });
    assert.notEqual(a.id, b.id);
    assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart', 'create_cart']);
    assert.deepEqual(storeCartIdempotencyCounts(), {});
  });

  test('another quantity, or another market, under the key is refused and builds nothing', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    await create({ store, door });
    for (const over of [{ quantity: 3 }, { market: 'GB' }, { market: null }]) {
      await assert.rejects(create({ store, door, ...over }), (err) => err.code === 'IDEMPOTENCY_CONFLICT' && err.detail.reason === KEY_REUSED_REASON, JSON.stringify(over));
    }
    assert.deepEqual(door.calls.map((c) => c[0]), ['create_cart']);
  });

  test('a GB cart and a US cart under different keys are two carts, each read back as itself', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const us = await create({ store, door, key: 'idem-lane-us', market: 'US' });
    const gb = await create({ store, door, key: 'idem-lane-gb', market: 'GB' });
    assert.notEqual(us.id, gb.id);
    assert.deepEqual(door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[2].address_country), ['US', 'GB']);
    assert.equal((await create({ store, door, key: 'idem-lane-gb', market: 'GB' })).id, gb.id);
    assert.equal((await create({ store, door, key: 'idem-lane-us', market: 'US' })).id, us.id);
  });

  test('two at once: one create_cart, the same id twice', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const [a, b] = await Promise.all([create({ store, door }), create({ store, door })]);
    assert.equal(a.id, b.id);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
  });

  test('the two doors, and two buyers, do not share a key', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const ucp = await create({ store, door });
    const mcp = await create({ store, door, idempotencyDoor: 'mcp' });
    const other = await create({ store, door, user: 'buyer-0002' });
    assert.equal(new Set([ucp.id, mcp.id, other.id]).size, 3);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 3);
  });

  test('no verified buyer or no key on the call: not deduplicated (and never thrown for)', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    await create({ store, door, user: '' });
    await create({ store, door, user: '' });
    await create({ store, door, key: '' });
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 3);
  });

  test('the stored row holds no cart link, no cart id in clear, no email', async () => {
    const store = new InMemoryKvStore();
    const door = fakeDoor();
    const first = await create({ store, door, email: 'buyer@example.com' });
    const row = JSON.stringify([...store._m.entries()]);
    for (const secret of ['secret-cart_1', 'cart_1', 'buyer@example.com', 'buyer-0001', 'idem-lane-0001', first.id, 'shop-a.example.com']) assert.equal(row.includes(secret), false, secret);
  });
});
