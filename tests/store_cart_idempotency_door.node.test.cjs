'use strict';

// A RETRIED STOREFRONT CREATE RETURNS THE SAME CHECKOUT (AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED).
//
// A create's idempotency key was ignored on the storefront path, so a retry built a second anonymous cart at the
// seller's store (and, with the referral on, a second click row). With the flag on, through the real doors
// (`/ucp/mcp` and `/mcp`; tests/_support/storeCartHardeningDoor.cjs says what is real and what is stubbed):
// the same buyer, key and request get the same checkout from ONE cart; another request under the key is refused
// as the kernel refuses a reused key; two creates at once build one cart.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const h = require('./_support/storeCartHardeningDoor.cjs');

const { IDS, AS } = h;
const ORIGINAL_ENV = { ...process.env };
const door = h.bootHardeningDoor({ port: 4464 });
let ledger = null;

test.before(async () => {
  await door.listen();
  ledger = await import(path.join(door.root, 'mcp-server/src/storefrontCartIdempotency.js'));
});
test.after(async () => {
  await door.close();
  process.env = { ...ORIGINAL_ENV };
});
test.beforeEach(() => { door.resetHardening(); ledger.resetStoreCartIdempotencyCountsForTest(); h.setFlags([]); });

// Every test uses keys of its own: the ledger's records outlive a test (they live six hours).
let keySeq = 2000;
const nextKey = () => (keySeq += 1);
const mask = (text) => String(text).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>');
const creates = (answer) => answer.store.filter((c) => c.kind === 'tool' && c.tool === 'create_cart').length;
const tools = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);
const errorOf = (answer) => (answer.value && answer.value.error) || null;
const decodeEsc = (id) => JSON.parse(Buffer.from(String(id).slice(4), 'base64url').toString('utf8'));
const ucp = (items, n, { as = AS.A, market = 'US' } = {}) => door.call('/ucp/mcp', 'create_checkout', h.ucpCreateKeyed(items, market, n), { buyer: as });
const native = (items, n, { as = AS.A, market = 'US', seller = IDS.SELLER_A } = {}) => door.call('/mcp', 'create_checkout_session', h.nativeCreate(seller, items, { market, n }), { buyer: as });

test('flag off: a retry is a second cart at the store, as it always was', async () => {
  const n = nextKey();
  const first = await ucp([[IDS.SIG_A, 1]], n);
  const retry = await ucp([[IDS.SIG_A, 1]], n);
  assert.notEqual(first.value.id, retry.value.id);
  assert.deepEqual([creates(first), creates(retry)], [1, 1]);
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), {});
});

test('UCP door: the same key and request again is the same checkout, byte for byte, from one cart', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG]);
  const n = nextKey();
  const first = await ucp([[IDS.SIG_A, 2]], n);
  assert.equal(first.isError, false, first.raw);
  const retry = await ucp([[IDS.SIG_A, 2]], n);
  const third = await ucp([[IDS.SIG_A, 2]], n);
  assert.equal(retry.raw, first.raw, 'the retry\'s answer is the first answer, expiry included');
  assert.equal(third.raw, first.raw);
  assert.deepEqual([tools(first), tools(retry), tools(third)], [['create_cart'], ['get_cart'], ['get_cart']]);
  assert.equal(retry.store.find((c) => c.kind === 'tool').arguments.id, decodeEsc(first.value.id).c, 'the cart read back is the first cart');
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), { claimed: 1, replayed: 2 });
});

test('native door: the same key and request again is the same session from one cart', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG]);
  const n = nextKey();
  const first = await native([[IDS.SIG_A, 1]], n);
  assert.equal(first.isError, false, first.raw);
  assert.equal(first.value.status, 'completes_on_seller_storefront');
  const retry = await native([[IDS.SIG_A, 1]], n);
  assert.equal(retry.raw, first.raw);
  assert.deepEqual([tools(first), tools(retry)], [['create_cart'], ['get_cart']]);
  // A chosen variant is part of the request.
  const k = nextKey();
  const chosen = await native([[IDS.SIG_A_MULTI, 1, IDS.VARIANT_A_MULTI[1]]], k);
  const chosenRetry = await native([[IDS.SIG_A_MULTI, 1, IDS.VARIANT_A_MULTI[1]]], k);
  assert.equal(chosenRetry.value.session_id, chosen.value.session_id);
  assert.equal(creates(chosenRetry), 0);
  const otherVariant = await native([[IDS.SIG_A_MULTI, 1, IDS.VARIANT_A_MULTI[0]]], k);
  assert.equal(errorOf(otherVariant).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(otherVariant.store.length, 0);
});

test('the same key with a DIFFERENT request is refused as the kernel refuses a reused key, and nothing reaches the store', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG]);
  // What the kernel's ledger says for a key reused with another body (safety-kernel/src/idempotencyLedger.js): this
  // code, with this message and recovery, not retriable.
  const { PivotaCommerceError } = await import(path.join(door.root, 'safety-kernel/src/errors.js'));
  const ledgerRefusal = new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { key: 'k' });
  const kernelConflict = { value: { error: { code: ledgerRefusal.code, message: ledgerRefusal.userMessage, retriable: ledgerRefusal.retriable } } };
  assert.equal(ledgerRefusal.retriable, false);
  assert.match(ledgerRefusal.recovery, /new idempotency_key/);

  const n = nextKey();
  const first = await native([[IDS.SIG_A_SECOND, 1]], n);
  assert.equal(first.isError, false, first.raw);
  for (const [name, args] of Object.entries({
    'another quantity': h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_SECOND, 2]], { market: 'US', n }),
    'another market': h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_SECOND, 1]], { market: 'GB', n }),
    'another product': h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A, 1]], { market: 'US', n }),
    'one more line': h.nativeCreate(IDS.SELLER_A, [[IDS.SIG_A_SECOND, 1], [IDS.SIG_A, 1]], { market: 'US', n }),
  })) {
    const refused = await door.call('/mcp', 'create_checkout_session', args, { buyer: AS.A });
    assert.equal(refused.isError, true, `${name}: ${refused.raw}`);
    // The same code, message, retriability and recovery as the kernel's own refusal.
    assert.deepEqual(
      { code: errorOf(refused).code, message: errorOf(refused).message, retriable: errorOf(refused).retriable },
      { code: errorOf(kernelConflict).code, message: errorOf(kernelConflict).message, retriable: errorOf(kernelConflict).retriable },
      name,
    );
    assert.equal(errorOf(refused).retriable, false);
    assert.equal(refused.store.length, 0, name);
    assert.equal(refused.gate.length, 0, name);
  }
  // The first checkout is untouched: the original request still reads it back.
  const again = await native([[IDS.SIG_A_SECOND, 1]], n);
  assert.equal(again.value.session_id, first.value.session_id);
  // The UCP door says the same.
  const u = nextKey();
  await ucp([[IDS.SIG_A_SECOND, 1]], u);
  const ucpRefused = await ucp([[IDS.SIG_A_SECOND, 3]], u);
  assert.equal(ucpRefused.isError, true, ucpRefused.raw);
  assert.match(ucpRefused.raw, /IDEMPOTENCY_CONFLICT|idempotency/i);
  assert.equal(ucpRefused.store.length, 0);
});

test('a GB cart and a US cart are never one another: the market is part of the request and of the id', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG]);
  const us = await ucp([[IDS.SIG_A, 1]], nextKey(), { market: 'US' });
  const gbKey = nextKey();
  const gb = await ucp([[IDS.SIG_A, 1]], gbKey, { market: 'GB' });
  assert.notEqual(us.value.id, gb.value.id);
  assert.deepEqual([decodeEsc(us.value.id).m, decodeEsc(gb.value.id).m], ['US', 'GB']);
  assert.deepEqual([us, gb].map((a) => a.store.find((c) => c.kind === 'tool').arguments.cart.context.address_country), ['US', 'GB']);
  // The GB key replays the GB cart, and refuses the US request.
  assert.equal((await ucp([[IDS.SIG_A, 1]], gbKey, { market: 'GB' })).value.id, gb.value.id);
  assert.equal((await ucp([[IDS.SIG_A, 1]], gbKey, { market: 'US' })).isError, true);
  // No market named is not "US named".
  const k = nextKey();
  const assumed = await ucp([[IDS.SIG_A, 1]], k, { market: null });
  assert.ok(assumed.value.market_assumed);
  assert.equal((await ucp([[IDS.SIG_A, 1]], k, { market: 'US' })).isError, true);
  const assumedAgain = await ucp([[IDS.SIG_A, 1]], k, { market: null });
  assert.equal(assumedAgain.raw, assumed.raw, 'the assumed-market label is on the replay too');
});

test('two creates at the same moment build ONE cart and answer the same checkout', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG]);
  const n = nextKey();
  const before = door.storeCalls.filter((c) => c.kind === 'tool' && c.tool === 'create_cart').length;
  const [a, b, c] = await Promise.all([ucp([[IDS.SIG_A, 1]], n), ucp([[IDS.SIG_A, 1]], n), ucp([[IDS.SIG_A, 1]], n)]);
  for (const answer of [a, b, c]) assert.equal(answer.isError, false, answer.raw);
  assert.equal(new Set([a.value.id, b.value.id, c.value.id]).size, 1);
  assert.equal(door.storeCalls.filter((x) => x.kind === 'tool' && x.tool === 'create_cart').length - before, 1);
  assert.equal(mask(a.raw), mask(b.raw));
  assert.equal(ledger.storeCartIdempotencyCounts().claimed, 1);
});

test('the key is the buyer\'s on that door: another buyer, another partner and the other door each get their own cart', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.NATIVE_DOOR_FLAG]);
  const n = nextKey();
  const mine = await ucp([[IDS.SIG_A, 1]], n);
  const otherBuyer = await ucp([[IDS.SIG_A, 1]], n, { as: AS.A_OTHER_BUYER });
  const otherPartner = await ucp([[IDS.SIG_A, 1]], n, { as: AS.B });
  const otherDoor = await native([[IDS.SIG_A, 1]], n);
  assert.deepEqual([mine, otherBuyer, otherPartner, otherDoor].map(creates), [1, 1, 1, 1]);
  assert.equal(new Set([mine.value.id, otherBuyer.value.id, otherPartner.value.id, otherDoor.value.session_id]).size, 4);
});

test('with the referral on: a retry mints no second click and writes no second hand-off record', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG, h.REFERRAL_FLAG, h.FORWARDING_FLAG, h.HANDOFF_RECORD_FLAG, h.ATTRIBUTION_FLAG]);
  const n = nextKey();
  const first = await ucp([[IDS.SIG_A, 1]], n);
  const retry = await ucp([[IDS.SIG_A, 1]], n);
  assert.equal(first.isError, false, first.raw);
  assert.deepEqual([first.referral.length, retry.referral.length], [1, 0]);
  assert.deepEqual([first.handoff.length, retry.handoff.length], [1, 0]);
  assert.equal(retry.value.id, first.value.id);
  assert.equal(retry.value.continue_url, first.value.continue_url, 'the same attributed link');
  assert.match(retry.value.continue_url, /pvt_click_id=clk_/);
  assert.deepEqual(tools(retry), ['get_cart']);
});

test('a checkout the store did not price is replayed too: the same catalogue answer, and the store is not asked again', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG]);
  const n = nextKey();
  const first = await ucp([[IDS.SIG_B, 1]], n);
  assert.deepEqual(first.value.messages.map((m) => m.code), ['checkout.completes_on_seller_storefront']);
  const retry = await ucp([[IDS.SIG_B, 1]], n);
  assert.equal(retry.raw, first.raw);
  assert.deepEqual(tools(retry), []);
});

test('a create that hands out nothing leaves nothing behind: a declined seller is asked about again on a retry', async () => {
  h.setFlags([h.IDEMPOTENCY_FLAG]);
  const n = nextKey();
  const first = await ucp([[IDS.SIG_C, 1]], n);
  const retry = await ucp([[IDS.SIG_C, 1]], n);
  assert.equal(first.isError, true);
  assert.equal(mask(retry.raw), mask(first.raw));
  assert.equal(ledger.storeCartIdempotencyCounts().released, 2);
  assert.equal(ledger.storeCartIdempotencyCounts().replayed, undefined);
});

test('a kernel checkout is not this switch\'s: with it on, a connected merchant\'s create is answered by the kernel as before', async () => {
  const kernelCreate = (n) => native([[IDS.SOURCE_CONNECTED, 1, IDS.VARIANT_CONNECTED]], n, { seller: IDS.SELLER_CONNECTED, market: undefined });
  const shape = (answer) => mask(answer.raw).replace(/q_[0-9a-f-]{36}/g, 'q_<random>');
  h.setFlags([h.NATIVE_DOOR_FLAG]);
  const offKey = nextKey();
  const off = [await kernelCreate(offKey), await kernelCreate(offKey)];
  h.setFlags([h.NATIVE_DOOR_FLAG, h.IDEMPOTENCY_FLAG]);
  const onKey = nextKey();
  const on = [await kernelCreate(onKey), await kernelCreate(onKey)];
  assert.equal(off[0].isError, false, off[0].raw);
  assert.match(on[0].value.session_id, /^q_/);
  assert.deepEqual(on.map(shape), off.map(shape));
  assert.deepEqual(on.map((a) => a.upstream.map((u) => u.op)), off.map((a) => a.upstream.map((u) => u.op)));
  assert.deepEqual(ledger.storeCartIdempotencyCounts(), {});
});
