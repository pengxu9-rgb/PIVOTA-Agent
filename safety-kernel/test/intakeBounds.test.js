// THE TWO BOUNDS EVERY CHECKOUT DOOR SHARES (buyerIntake.js): an idempotency key that is present is at least 8
// characters, and one cart line is at most 999 units.
//
// What is pinned here, at the intake itself and at the two kernel-side callers (the canonical executor and the ACP
// REST adapter):
//   - HOW THE KEY IS COUNTED: Unicode code points, after surrounding whitespace is removed. 7 is refused and 8 is
//     accepted; padding does not count; a character outside the basic plane counts once.
//   - AN ABSENT KEY IS NOT THIS RULE'S: the "a key is required" refusal keeps its reason and its (unnamed) shape.
//   - THE CEILING IS PER LINE: 999 is accepted and 1000 refused, on a create and on an update; a quantity that is
//     not a number keeps the refusal it always had.
//   - EACH REFUSAL IS NAMED AND TERMINAL, and is raised BEFORE anything is called: the executor's kernel and
//     upstream, and the ACP door's buyer resolver, session store and executor, are recorders that fail the test
//     when a refused request reaches them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PivotaCommerceError } from '../src/errors.js';
import {
  assertInvokeIntakeBounds,
  assertInvokeLineQuantities,
  INVOKE_BOUNDED_OPERATIONS,
  INVOKE_KEYED_OPERATIONS,
  invokeErrorOf,
  validateCanonical,
  WRITE_OPERATIONS,
} from '../src/contractValidation.js';
import intakeBoundsModule from '../src/protocol/intakeBounds.cjs';
import { createInvokeHandler } from '../src/invokeHandler.js';
import { SafetyKernel } from '../src/kernel.js';
import {
  assertIdempotencyKeyLongEnough,
  assertLineQuantitiesWithinMaximum,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_TOO_SHORT_REASON,
  isAcceptableLineQuantity,
  isLineQuantityAboveMaximum,
  MAX_CART_ITEMS,
  MAX_LINE_QUANTITY,
  normalizeCartItems,
  QUANTITY_ABOVE_LINE_MAXIMUM_REASON,
  surfaceableIntakeRefusal,
} from '../src/protocol/buyerIntake.js';
import { MUTATING_OPERATIONS } from '../src/protocol/canonicalContract.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { InMemoryKvStore } from '../src/stores.js';

const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };
const rejected = (promise) => promise.then(() => null, (err) => err);

function assertKeyTooShort(err, label) {
  assert.ok(err instanceof PivotaCommerceError, `${label}: a kernel error`);
  assert.equal(err.code, 'IDEMPOTENCY_CONFLICT', `${label}: the code a missing key gets`);
  assert.equal(err.retriable, false, `${label}: terminal`);
  assert.equal(err.detail.reason, 'idempotency_key_too_short', `${label}: named`);
  const surfaced = surfaceableIntakeRefusal(err);
  assert.deepEqual(surfaced.detail, { reason: 'idempotency_key_too_short', min_length: 8 }, `${label}: the detail a door surfaces`);
  assert.match(surfaced.message, /at least 8 characters/, `${label}: the message states the minimum`);
}

function assertQuantityAboveMaximum(err, label) {
  assert.ok(err instanceof PivotaCommerceError, `${label}: a kernel error`);
  assert.equal(err.code, 'QUOTE_REQUIRED', `${label}: the code every other bad quantity gets`);
  assert.equal(err.retriable, false, `${label}: terminal`);
  assert.equal(err.detail.reason, 'quantity_above_line_maximum', `${label}: named`);
  const surfaced = surfaceableIntakeRefusal(err);
  assert.deepEqual(surfaced.detail, { reason: 'quantity_above_line_maximum', max_quantity: 999 }, `${label}: the detail a door surfaces`);
  assert.match(surfaced.message, /at most 999 units per line/, `${label}: the message states the maximum`);
  assert.match(surfaced.message, /from 1 to 999/, `${label}: and the range to send`);
}

// ---- the numbers and the names ------------------------------------------------------------------------------

test('the two numbers and the two reason names', () => {
  assert.equal(IDEMPOTENCY_KEY_MIN_LENGTH, 8);
  assert.equal(MAX_LINE_QUANTITY, 999);
  assert.equal(IDEMPOTENCY_KEY_TOO_SHORT_REASON, 'idempotency_key_too_short');
  assert.equal(QUANTITY_ABOVE_LINE_MAXIMUM_REASON, 'quantity_above_line_maximum');
});

// ---- the key --------------------------------------------------------------------------------------------------

test('a key of 7 characters is refused and one of 8 is accepted', () => {
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough('abcdefg')), '7');
  assert.equal(caught(() => assertIdempotencyKeyLongEnough('abcdefgh')), null, '8');
  assert.equal(caught(() => assertIdempotencyKeyLongEnough('abcdefghi')), null, '9');
  for (const short of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
    assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough(short)), JSON.stringify(short));
  }
});

test('surrounding whitespace is not counted', () => {
  // 8 characters as sent, 3 once trimmed: padding cannot make a key long enough.
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough('abc     ')), 'padded on the right');
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough('     abc')), 'padded on the left');
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough('  abcdefg\t\n')), '7 inside padding');
  // 8 once trimmed is long enough, whatever surrounds it; whitespace INSIDE the key is part of the key.
  assert.equal(caught(() => assertIdempotencyKeyLongEnough('  abcdefgh  ')), null, '8 inside padding');
  assert.equal(caught(() => assertIdempotencyKeyLongEnough('abc  fgh')), null, 'inner whitespace counts');
});

test('the unit is the Unicode code point, as JSON Schema minLength counts', () => {
  // Two-byte characters: one each.
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough('é'.repeat(7))), '7 two-byte characters');
  assert.equal(caught(() => assertIdempotencyKeyLongEnough('é'.repeat(8))), null, '8 two-byte characters');
  // A character outside the basic plane is two UTF-16 units and ONE character: four of them are 4, not 8.
  const astral = '\u{1F511}';
  assert.equal(astral.repeat(4).length, 8, 'four such characters are eight UTF-16 units');
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough(astral.repeat(4))), 'four characters outside the basic plane');
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough(astral.repeat(7))), 'seven of them');
  assert.equal(caught(() => assertIdempotencyKeyLongEnough(astral.repeat(8))), null, 'eight of them');
  // Three-byte characters.
  assert.equal(caught(() => assertIdempotencyKeyLongEnough('一'.repeat(8))), null, '8 three-byte characters');
  assertKeyTooShort(caught(() => assertIdempotencyKeyLongEnough('一'.repeat(7))), '7 three-byte characters');
});

test('an absent key is not this rule\'s to refuse', () => {
  for (const absent of [undefined, null, '', '   ', '\t\n', 0, 12345678, {}, [], true]) {
    assert.equal(caught(() => assertIdempotencyKeyLongEnough(absent)), null, `absent: ${JSON.stringify(absent)}`);
  }
});

test('the key refusal says nothing about the key', () => {
  const key = 'zq7!x';
  const err = caught(() => assertIdempotencyKeyLongEnough(key));
  assertKeyTooShort(err, 'short');
  assert.equal(JSON.stringify({ message: err.message, detail: err.detail }).includes(key), false, 'the key is not echoed');
  assert.equal('length' in err.detail.acp_detail, false, 'nor its length');
});

// ---- the quantity -----------------------------------------------------------------------------------------------

test('what counts as above the ceiling, and what a door may act on', () => {
  for (const [q, above, acceptable] of [
    [1, false, true], [2, false, true], [998, false, true], [999, false, true],
    [1000, true, false], [1001, true, false], [900000000, true, false], [Number.MAX_SAFE_INTEGER, true, false],
    [1e30, true, false], [Infinity, true, false], [1000.5, true, false], [999.5, true, false],
    [0, false, false], [-1, false, false], [-1000, false, false], [1.5, false, false], [NaN, false, false],
    ['3', false, false], ['999', false, false], ['1000', false, false], [null, false, false], [undefined, false, false],
    [[1000], false, false], [{}, false, false], [true, false, false],
  ]) {
    assert.equal(isLineQuantityAboveMaximum(q), above, `above: ${String(q)} (${typeof q})`);
    assert.equal(isAcceptableLineQuantity(q), acceptable, `acceptable: ${String(q)} (${typeof q})`);
  }
});

test('999 on a line is accepted and 1000 refused, on any line of the cart', () => {
  assert.equal(caught(() => assertLineQuantitiesWithinMaximum([{ product_id: 'p1', quantity: 999 }])), null);
  assertQuantityAboveMaximum(caught(() => assertLineQuantitiesWithinMaximum([{ product_id: 'p1', quantity: 1000 }])), '1000');
  assertQuantityAboveMaximum(caught(() => assertLineQuantitiesWithinMaximum([{ product_id: 'p1', quantity: 900000000 }])), 'huge');
  assertQuantityAboveMaximum(caught(() => assertLineQuantitiesWithinMaximum([{ product_id: 'p1', quantity: 1e30 }])), 'beyond a safe integer');
  assertQuantityAboveMaximum(caught(() => assertLineQuantitiesWithinMaximum([
    { product_id: 'p1', quantity: 1 }, { product_id: 'p2', quantity: 999 }, { product_id: 'p3', quantity: 1000 },
  ])), 'the third line');
  // PER LINE: three lines of 999 are 2997 units of three products, and no line is above the ceiling.
  assert.equal(caught(() => assertLineQuantitiesWithinMaximum([
    { product_id: 'p1', quantity: 999 }, { product_id: 'p2', quantity: 999 }, { product_id: 'p3', quantity: 999 },
  ])), null, 'the ceiling is not a cart total');
});

test('what the ceiling leaves to the rules that were already there', () => {
  // Not a number: the bad-quantity refusal's, not this one's.
  for (const q of ['1000', '900000000', null, undefined, [1000], { valueOf: () => 1000 }]) {
    assert.equal(caught(() => assertLineQuantitiesWithinMaximum([{ product_id: 'p1', quantity: q }])), null, `not a number: ${JSON.stringify(q)}`);
  }
  // Not a cart, or a line that is not a plain object.
  for (const cart of [undefined, null, 'items', 7, {}, [], [null], ['x'], [[{ quantity: 1000 }]]]) {
    assert.equal(caught(() => assertLineQuantitiesWithinMaximum(cart)), null, `not a cart: ${JSON.stringify(cart)}`);
  }
  // Only a line's OWN quantity is read, as the cart rule itself reads it: an inherited one is not the line's.
  assert.equal(caught(() => assertLineQuantitiesWithinMaximum([Object.create({ quantity: 1000 })])), null, 'an inherited quantity');
  // A cart with more lines than a cart may have is refused for THAT, without being walked.
  const oversized = Array.from({ length: MAX_CART_ITEMS + 1 }, (_, i) => ({ product_id: `p${i}`, quantity: 1000 }));
  assert.equal(caught(() => assertLineQuantitiesWithinMaximum(oversized)), null, 'left to the cart-size rule');
  const atTheCap = Array.from({ length: MAX_CART_ITEMS }, (_, i) => ({ product_id: 'p1', quantity: i === MAX_CART_ITEMS - 1 ? 1000 : 1 }));
  assertQuantityAboveMaximum(caught(() => assertLineQuantitiesWithinMaximum(atTheCap)), 'the last line of a full cart');
});

test('the quantity refusal does not echo the quantity', () => {
  const err = caught(() => assertLineQuantitiesWithinMaximum([{ product_id: 'p1', quantity: 123456 }]));
  assertQuantityAboveMaximum(err, '123456');
  assert.equal(JSON.stringify({ detail: err.detail }).includes('123456'), false);
});

// ---- the shared cart rule (both MCP doors and the ACP REST routes call it) ---------------------------------------

test('normalizeCartItems: 999 passes, 1000 is refused by name, and every older refusal keeps its own', () => {
  assert.deepEqual(normalizeCartItems([{ product_id: 'p1', variant_id: 'v1', quantity: 999 }]), [{ product_id: 'p1', variant_id: 'v1', quantity: 999 }]);
  assertQuantityAboveMaximum(caught(() => normalizeCartItems([{ product_id: 'p1', variant_id: 'v1', quantity: 1000 }])), '1000');
  assertQuantityAboveMaximum(caught(() => normalizeCartItems([{ product_id: 'p1', quantity: 900000000 }])), '900000000');
  assertQuantityAboveMaximum(caught(() => normalizeCartItems([{ product_id: 'p1', quantity: 1e30 }])), '1e30');
  assertQuantityAboveMaximum(caught(() => normalizeCartItems([{ product_id: 'p1', quantity: 1000.5 }])), '1000.5');
  // The refusals that were there before, unchanged: same code, same reason, no curated detail.
  for (const q of [0, -1, 1.5, 998.5, '3', '1000', '900000000', null, undefined, NaN]) {
    const err = caught(() => normalizeCartItems([{ product_id: 'p1', quantity: q }]));
    assert.equal(err.code, 'QUOTE_REQUIRED', `bad quantity ${String(q)}`);
    assert.deepEqual(err.detail, { reason: 'item_bad_quantity' }, `bad quantity ${String(q)}`);
    assert.equal(surfaceableIntakeRefusal(err), null, `bad quantity ${String(q)}: still not a curated refusal`);
  }
  assert.deepEqual(caught(() => normalizeCartItems([])).detail, { reason: 'no_items' });
  // The cart-size rule is decided first, as it always was, and without walking the cart.
  const oversized = Array.from({ length: MAX_CART_ITEMS + 1 }, () => ({ product_id: 'p1', quantity: 1000 }));
  assert.equal(caught(() => normalizeCartItems(oversized)).detail.reason, 'acp_cart_too_many_items');
  // The ceiling is decided before any single line is otherwise judged: one answer for it on every door.
  assertQuantityAboveMaximum(caught(() => normalizeCartItems([{ sku_id: 's1', quantity: 1 }, { product_id: 'p2', quantity: 1000 }])), 'beside a line with no product_id');
});

// ---- the canonical executor: refused before the kernel or an upstream is reached --------------------------------

function recordingExecutor() {
  const calls = [];
  const record = (name) => async (...args) => { calls.push({ name, args }); throw new Error(`the kernel was reached: ${name}`); };
  const kernel = {
    previewQuote: record('previewQuote'),
    createOrder: record('createOrder'),
    requestAfterSales: record('requestAfterSales'),
    _requireOrder: record('_requireOrder'),
    isQuoteClaimed: record('isQuoteClaimed'),
    quotes: { resolveForOrder: record('quotes.resolveForOrder') },
    idempotency: { run: record('idempotency.run') },
  };
  const executor = createCanonicalExecutor({
    kernel,
    upstream: record('upstream'),
    verifyPaymentAuthorization: record('verifyPaymentAuthorization'),
    hostedLinkEnabled: true,
  });
  return { executor, calls };
}

const CTX = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
const CART = { merchant_id: 'merch_a', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] };
const PARAMS_BY_OP = {
  create_checkout_session: { quote: CART },
  update_checkout_session: { session_id: 'q_1', quote: CART },
  complete_checkout_session: { session_id: 'q_1', payment_authorization: { method: 'placeholder' } },
  create_payment_link: { session_id: 'q_1', customer_email: 'buyer@example.test' },
  cancel_checkout_session: { session_id: 'q_1' },
  request_after_sales: { status: { order_id: 'o_1', requested_action: 'refund' } },
};
// exchange_payment_token is refused whoever asks and whatever it carries, before any of this.
const KEYED_OPS = MUTATING_OPERATIONS.filter((id) => id !== 'exchange_payment_token');

test('every mutating operation the executor serves is covered by the cases below', () => {
  assert.deepEqual([...KEYED_OPS].sort(), Object.keys(PARAMS_BY_OP).sort());
});

for (const opId of Object.keys(PARAMS_BY_OP)) {
  test(`executor ${opId}: a 7-character key is refused by name before the kernel is reached; 8 characters reach it`, async () => {
    const short = recordingExecutor();
    assertKeyTooShort(await rejected(short.executor.execute(opId, { ...PARAMS_BY_OP[opId], idempotency_key: 'abcdefg' }, CTX)), opId);
    assertKeyTooShort(await rejected(short.executor.execute(opId, { ...PARAMS_BY_OP[opId], idempotency_key: '  abc   ' }, CTX)), `${opId} padded`);
    assert.deepEqual(short.calls, [], 'nothing was called');

    const long = recordingExecutor();
    const err = await rejected(long.executor.execute(opId, { ...PARAMS_BY_OP[opId], idempotency_key: 'abcdefgh' }, CTX));
    if (opId === 'cancel_checkout_session') {
      // A cancel of a session with no order touches no kernel state: past the gate, it simply answers.
      assert.equal(err, null, 'an 8-character key is past the gate');
    } else {
      assert.match(String(err && err.message), /^the kernel was reached: /, 'an 8-character key is past the gate');
      assert.equal(long.calls.length, 1);
    }
  });

  test(`executor ${opId}: an absent key is refused exactly as before`, async () => {
    const { executor, calls } = recordingExecutor();
    for (const absent of [undefined, '', '   ']) {
      const err = await rejected(executor.execute(opId, { ...PARAMS_BY_OP[opId], idempotency_key: absent }, CTX));
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
      assert.deepEqual(err.detail, { reason: 'missing_idempotency_key', op: opId });
      assert.equal(surfaceableIntakeRefusal(err), null, 'the missing-key refusal carries no curated detail, as before');
    }
    assert.deepEqual(calls, []);
  });
}

test('executor: a read needs no key and is not judged by this rule', async () => {
  const { executor, calls } = recordingExecutor();
  const err = await rejected(executor.execute('get_checkout_session', { session_id: 'q_1', idempotency_key: 'k' }, CTX));
  assert.match(String(err && err.message), /^the kernel was reached: quotes\.resolveForOrder$/);
  assert.equal(calls.length, 1);
});

for (const opId of ['create_checkout_session', 'update_checkout_session']) {
  test(`executor ${opId}: a line of 1000 is refused by name before anything is priced; 999 is priced`, async () => {
    const cart = (quantity) => ({ ...PARAMS_BY_OP[opId], idempotency_key: 'abcdefgh', quote: { merchant_id: 'merch_a', items: [{ product_id: 'p1', variant_id: 'v1', quantity }] } });
    const over = recordingExecutor();
    assertQuantityAboveMaximum(await rejected(over.executor.execute(opId, cart(1000), CTX)), `${opId} 1000`);
    assertQuantityAboveMaximum(await rejected(over.executor.execute(opId, cart(900000000), CTX)), `${opId} huge`);
    assert.deepEqual(over.calls, [], 'nothing was called');

    const at = recordingExecutor();
    const err = await rejected(at.executor.execute(opId, cart(999), CTX));
    assert.match(String(err && err.message), /^the kernel was reached: previewQuote$/);
    assert.equal(at.calls[0].args[0].quote.items[0].quantity, 999, 'the quantity the kernel is asked to price');
  });
}

// ---- the ACP REST adapter: refused before the buyer is resolved, a session is loaded or the executor is called ---

const ACP_SECRET = 'acp-signing-secret-0123456789abcdef';
function acpSetup() {
  const calls = [];
  const store = new InMemoryKvStore();
  const sessionStore = {
    get: async (k) => { calls.push({ name: 'sessionStore.get' }); return store.get(k); },
    set: async (k, v, o) => { calls.push({ name: 'sessionStore.set' }); return store.set(k, v, o); },
    putIfAbsent: async (k, v, o) => { calls.push({ name: 'sessionStore.putIfAbsent' }); return store.putIfAbsent(k, v, o); },
  };
  const executor = { execute: async (op, params) => { calls.push({ name: `executor.${op}`, params }); return { session_id: 'q_1', status: 'ready_for_payment', totals: {}, line_items: [] }; } };
  const adapter = createAcpRestAdapter({
    executor,
    sessionStore,
    signingSecret: ACP_SECRET,
    resolveUserRef: async () => { calls.push({ name: 'resolveUserRef' }); return { user_ref: 'buyer_1', customer_email: 'buyer@example.test' }; },
  });
  const req = ({ body, key, id }) => {
    const rawBody = JSON.stringify(body ?? {});
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', ACP_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    return {
      headers: { signature, timestamp, ...(key !== undefined ? { 'idempotency-key': key } : {}) },
      rawBody,
      params: id ? { checkout_session_id: id } : {},
    };
  };
  return { adapter, calls, req, store };
}
const ACP_CART = (quantity) => ({ merchant_id: 'merch_a', items: [{ product_id: 'p1', variant_id: 'v1', quantity }] });

function assertAcpKeyTooShort(res, label) {
  assert.equal(res.status, 409, `${label}: the status a missing key gets`);
  assert.equal(res.body.code, 'IDEMPOTENCY_CONFLICT', label);
  assert.deepEqual(res.body.detail, { reason: 'idempotency_key_too_short', min_length: 8 }, label);
  assert.match(res.body.message, /at least 8 characters/, label);
}

test('ACP REST: a short Idempotency-Key is refused on create, update, complete and cancel before anything is called', async () => {
  const { adapter, calls, req } = acpSetup();
  for (const [name, handler, request] of [
    ['create', adapter.createCheckoutSession, { body: ACP_CART(1) }],
    ['update', adapter.updateCheckoutSession, { body: ACP_CART(1), id: 'cs_1' }],
    ['complete', adapter.completeCheckoutSession, { body: { payment_data: { method: 'placeholder' } }, id: 'cs_1' }],
    ['cancel', adapter.cancelCheckoutSession, { body: {}, id: 'cs_1' }],
  ]) {
    assertAcpKeyTooShort(await handler(req({ ...request, key: 'abcdefg' })), `${name} 7`);
    assertAcpKeyTooShort(await handler(req({ ...request, key: 'a' })), `${name} 1`);
    // The header value arrives trimmed (HTTP strips it; the adapter trims again): padding cannot lengthen it.
    assertAcpKeyTooShort(await handler(req({ ...request, key: '  abcdefg  ' })), `${name} padded`);
  }
  assert.deepEqual(calls, [], 'no buyer was resolved, no session loaded, no executor called');
});

test('ACP REST: an 8-character key is past the gate; an absent key is refused exactly as before; a read needs none', async () => {
  const { adapter, calls, req } = acpSetup();
  const created = await adapter.createCheckoutSession(req({ body: ACP_CART(1), key: 'abcdefgh' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(calls.some((c) => c.name === 'executor.create_checkout_session'));

  for (const absent of [undefined, '', '   ']) {
    const res = await adapter.createCheckoutSession(req({ body: ACP_CART(1), key: absent }));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal('detail' in res.body, false, 'the missing-key refusal carries no detail, as before');
  }
  const read = await adapter.getCheckoutSession(req({ body: undefined, id: created.body.id }));
  assert.equal(read.status, 200, 'a read carries no key');
});

test('ACP REST: a line of 1000 is refused on create and on update before the executor is called; 999 is sent', async () => {
  const { adapter, calls, req } = acpSetup();
  const created = await adapter.createCheckoutSession(req({ body: ACP_CART(999), key: 'acp-create-0001' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(calls.find((c) => c.name === 'executor.create_checkout_session').params.quote.items[0].quantity, 999);
  const updated = await adapter.updateCheckoutSession(req({ body: ACP_CART(999), key: 'acp-update-0001', id: created.body.id }));
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const executorCallsBefore = calls.filter((c) => c.name.startsWith('executor.')).length;
  for (const quantity of [1000, 900000000]) {
    for (const [name, res] of [
      ['create', await adapter.createCheckoutSession(req({ body: ACP_CART(quantity), key: `acp-create-${quantity}` }))],
      ['update', await adapter.updateCheckoutSession(req({ body: ACP_CART(quantity), key: `acp-update-${quantity}`, id: created.body.id }))],
    ]) {
      assert.equal(res.status, 400, `${name} ${quantity}: the status every other bad quantity gets`);
      assert.equal(res.body.code, 'QUOTE_REQUIRED', `${name} ${quantity}`);
      assert.deepEqual(res.body.detail, { reason: 'quantity_above_line_maximum', max_quantity: 999 }, `${name} ${quantity}`);
      assert.match(res.body.message, /at most 999 units per line/, `${name} ${quantity}`);
    }
  }
  assert.equal(calls.filter((c) => c.name.startsWith('executor.')).length, executorCallsBefore, 'the executor was not called for a refused cart');
  // A numeric string is not coerced: the refusal it always got.
  const asString = await adapter.createCheckoutSession(req({ body: ACP_CART('1000'), key: 'acp-create-string' }));
  assert.equal(asString.status, 400);
  assert.equal(asString.body.code, 'QUOTE_REQUIRED');
  assert.equal('detail' in asString.body, false);
});

// ---- the invoke door: the strict contract validator, the kernel's invoke handler, and the other route's check -----

const invokeQuote = (quantity, extra = {}) => ({ quote: { merchant_id: 'merch_a', items: [{ product_id: 'p1', variant_id: 'v1', quantity }] }, ...extra });

test('the invoke operations either bound can refuse', () => {
  assert.deepEqual([...INVOKE_KEYED_OPERATIONS].sort(), ['confirm_payment', 'create_order', 'preview_quote', 'request_after_sales', 'submit_payment']);
  assert.deepEqual([...INVOKE_BOUNDED_OPERATIONS], ['confirm_payment', 'create_order', 'preview_quote', 'request_after_sales', 'submit_payment']);
  for (const write of WRITE_OPERATIONS) assert.ok(INVOKE_KEYED_OPERATIONS.has(write), write);
});

test('strict contract, preview_quote: 999 passes, a number above it is refused by name, and every older refusal keeps its own', () => {
  assert.equal(caught(() => validateCanonical('preview_quote', invokeQuote(999))), null);
  for (const quantity of [1000, 1001, 900000000, 1e30, 1000.5, 999.5]) {
    assertQuantityAboveMaximum(caught(() => validateCanonical('preview_quote', invokeQuote(quantity))), `strict ${quantity}`);
  }
  // On any line, and before any single line is otherwise judged.
  const second = invokeQuote(1);
  second.quote.items.push({ product_id: 'p2', quantity: 1000 });
  assertQuantityAboveMaximum(caught(() => validateCanonical('preview_quote', second)), 'second line');
  assertQuantityAboveMaximum(caught(() => validateCanonical('preview_quote', { quote: { merchant_id: 'merch_a', items: [{ quantity: 1 }, { product_id: 'p2', quantity: 1000 }] } })), 'beside a line with no product_id');
  // This door's cart has no line cap of its own, so there is none for a long cart to hide behind.
  const long = { quote: { merchant_id: 'merch_a', items: Array.from({ length: 80 }, (_, i) => ({ product_id: `p${i}`, quantity: i === 79 ? 1000 : 1 })) } };
  assertQuantityAboveMaximum(caught(() => validateCanonical('preview_quote', long)), 'the 80th line');
  // A numeric string is not a quantity under this contract: the refusal it always got, unchanged.
  for (const quantity of ['1000', '5', 0, -1, 1.5, null, undefined]) {
    const err = caught(() => validateCanonical('preview_quote', invokeQuote(quantity)));
    assert.equal(err.code, 'QUOTE_REQUIRED', String(quantity));
    assert.deepEqual(err.detail, { reason: 'item_quantity_invalid' }, String(quantity));
  }
  // What was refused before the cart was looked at still is, for the same reason.
  assert.deepEqual(caught(() => validateCanonical('preview_quote', {})).detail, { reason: 'quote_required' });
  assert.deepEqual(caught(() => validateCanonical('preview_quote', { quote: { items: [{ product_id: 'p1', quantity: 1000 }] } })).detail.reason, 'merchant_id_required');
  assert.deepEqual(caught(() => validateCanonical('preview_quote', { quote: { merchant_id: 'merch_a', items: [] } })).detail, { reason: 'items_required' });
});

test('strict contract, create_order: the order is priced from its locked quote, so lines beside it are not judged', () => {
  const order = {
    idempotency_key: 'abcdefgh',
    order: {
      quote_id: 'q_1',
      shipping_address: { country: 'US', city: 'Springfield', address_line1: '1 Example Street', recipient_name: 'Example Buyer', postal_code: '00000' },
      items: [{ product_id: 'p1', quantity: 1000 }],
    },
  };
  assert.equal(caught(() => validateCanonical('create_order', order)), null);
});

test('strict contract, the key on a write: where the minimum always was, and what the shared rule adds', () => {
  const writes = {
    create_order: { order: { quote_id: 'q_1', shipping_address: { country: 'US', city: 'Springfield', address_line1: '1 Example Street', recipient_name: 'Example Buyer', postal_code: '00000' } } },
    submit_payment: { confirmation_token: 'placeholder', payment: { order_id: 'o_1', currency: 'USD', expected_amount: 100 } },
    request_after_sales: { status: { order_id: 'o_1', requested_action: 'refund' } },
  };
  assert.deepEqual(Object.keys(writes).sort(), [...WRITE_OPERATIONS].sort());
  for (const [operation, payload] of Object.entries(writes)) {
    // ALREADY ENFORCED, unnamed: absent, blank, or fewer than 8 UTF-16 units once trimmed.
    for (const key of [undefined, null, '', '   ', 'abcdefg', 'k', '  abcdefg  ', 'abc     ', 12345678]) {
      const err = caught(() => validateCanonical(operation, { ...payload, idempotency_key: key }));
      assert.equal(err.code, 'IDEMPOTENCY_CONFLICT', `${operation} ${JSON.stringify(key)}`);
      assert.deepEqual(err.detail, { reason: 'missing_or_short_idempotency_key' }, `${operation} ${JSON.stringify(key)}`);
    }
    // ADDED: 8 or more UTF-16 units that are fewer than 8 characters.
    for (const key of ['\u{1F511}'.repeat(4), '\u{1F511}'.repeat(7), `  ${'\u{1F511}'.repeat(4)}  `]) {
      assertKeyTooShort(caught(() => validateCanonical(operation, { ...payload, idempotency_key: key })), `${operation} wide characters`);
    }
    for (const key of ['abcdefgh', '  abcdefgh  ', '\u{1F511}'.repeat(8), 'é'.repeat(8)]) {
      assert.equal(caught(() => validateCanonical(operation, { ...payload, idempotency_key: key })), null, `${operation} ${JSON.stringify(key)}`);
    }
  }
});

test('strict contract, the key on a quote: none is needed, and one that is sent has the shared minimum', () => {
  for (const absent of [undefined, null, '', '   ']) {
    assert.equal(caught(() => validateCanonical('preview_quote', invokeQuote(1, { idempotency_key: absent }))), null, JSON.stringify(absent));
  }
  for (const key of ['abcdefg', 'k', 'abc     ', '\u{1F511}'.repeat(4)]) {
    assertKeyTooShort(caught(() => validateCanonical('preview_quote', invokeQuote(1, { idempotency_key: key }))), JSON.stringify(key));
  }
  assert.equal(caught(() => validateCanonical('preview_quote', invokeQuote(1, { idempotency_key: 'abcdefgh' }))), null);
  // A read is not judged, whatever it carries.
  assert.equal(caught(() => validateCanonical('get_order_status', { idempotency_key: 'k', quote: invokeQuote(1000).quote })), null);
});

test('the other invoke route\'s check: both bounds and nothing else, with the quantity read as that route reads it', () => {
  // That route converts a quantity (`Number(quantity)`) and prices the result: "1000" is a thousand units there.
  for (const quantity of [1000, 900000000, 1e30, '1000', '900000000', '1e9', ' 1000 ', [1000]]) {
    assertQuantityAboveMaximum(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote(quantity))), `quote ${JSON.stringify(quantity)}`);
    assertQuantityAboveMaximum(caught(() => assertInvokeIntakeBounds('create_order', { order: { quote_id: 'q_1', items: [{ product_id: 'p1', quantity }] } })), `order ${JSON.stringify(quantity)}`);
  }
  // Everything that route always accepted or judged for itself is left to it.
  for (const quantity of [1, 999, '999', '5', 0, -1, 1.5, null, undefined, 'many', {}, true]) {
    assert.equal(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote(quantity))), null, `quote ${JSON.stringify(quantity)}`);
  }
  for (const payload of [undefined, null, {}, { quote: null }, { quote: {} }, { quote: { items: 'x' } }, { quote: { items: [null, 'x', 7] } }]) {
    assert.equal(caught(() => assertInvokeIntakeBounds('preview_quote', payload)), null, JSON.stringify(payload));
  }
  // The strict contract's own reading stays strict: there a string is never converted.
  assert.equal(caught(() => assertInvokeLineQuantities('preview_quote', invokeQuote('1000'))), null);
  assertQuantityAboveMaximum(caught(() => assertInvokeLineQuantities('preview_quote', invokeQuote('1000'), { asThatRouteReadsIt: true })), 'converted');
  // The key: present and short on an operation that takes one.
  for (const operation of INVOKE_KEYED_OPERATIONS) {
    assertKeyTooShort(caught(() => assertInvokeIntakeBounds(operation, { idempotency_key: 'abc     ' })), operation);
    assertKeyTooShort(caught(() => assertInvokeIntakeBounds(operation, { idempotency_key: '\u{1F511}'.repeat(4) })), operation);
    assert.equal(caught(() => assertInvokeIntakeBounds(operation, { idempotency_key: 'abcdefgh' })), null, operation);
    assert.equal(caught(() => assertInvokeIntakeBounds(operation, {})), null, `${operation}: no key`);
  }
  // An operation that is neither keyed nor carries lines is never judged.
  assert.equal(caught(() => assertInvokeIntakeBounds('find_products', { idempotency_key: 'k', quote: invokeQuote(1000).quote, order: { items: [{ quantity: 1000 }] } })), null);
  assert.equal(caught(() => assertInvokeIntakeBounds('toString', { idempotency_key: 'k', quote: invokeQuote(1000).quote })), null);
});

test('the invoke door\'s error object: a shared refusal is named, every other error is exactly toResult()', () => {
  const quantity = invokeErrorOf(caught(() => validateCanonical('preview_quote', invokeQuote(1000))));
  assert.deepEqual(quantity, {
    code: 'QUOTE_REQUIRED',
    retriable: false,
    message: "A line's quantity is above the maximum: at most 999 units per line are accepted. Send a whole number from 1 to 999 as each line's quantity. Retrying as sent will not change the answer.",
    detail: { reason: 'quantity_above_line_maximum', max_quantity: 999 },
  });
  const key = invokeErrorOf(caught(() => validateCanonical('preview_quote', invokeQuote(1, { idempotency_key: 'k' }))));
  assert.equal(key.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(key.retriable, false);
  assert.deepEqual(key.detail, { reason: 'idempotency_key_too_short', min_length: 8 });
  for (const other of [
    caught(() => validateCanonical('preview_quote', invokeQuote('1000'))),
    caught(() => validateCanonical('create_order', {})),
    new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'placeholder', secret: 'x' }),
  ]) {
    assert.deepEqual(invokeErrorOf(other), other.toResult().error);
    assert.equal('detail' in invokeErrorOf(other), false);
  }
});

test('the kernel\'s invoke handler: a quote above the ceiling, or with a short key, is refused before the kernel or an upstream is called', async () => {
  const calls = [];
  const kernel = new SafetyKernel({
    upstream: async (op, payload) => { calls.push({ op, payload }); return { quote_id: 'bq_1', currency: 'USD', merchant_of_record: 'merch_a', locked_totals: { subtotal: 100, total: 100 }, line_items: payload.quote.items }; },
    secret: 'invoke-bounds-secret-0123456789abcdef',
    log: { info() {}, warn() {}, error() {} },
  });
  const handler = createInvokeHandler({ kernel, upstream: async (op, payload) => { calls.push({ op, payload }); return {}; }, log: { info() {}, warn() {}, error() {} } });
  for (const quantity of [1000, 900000000]) {
    const out = await handler.handle('preview_quote', invokeQuote(quantity), CTX);
    assert.deepEqual(out, { ok: false, error: {
      code: 'QUOTE_REQUIRED',
      retriable: false,
      message: "A line's quantity is above the maximum: at most 999 units per line are accepted. Send a whole number from 1 to 999 as each line's quantity. Retrying as sent will not change the answer.",
      detail: { reason: 'quantity_above_line_maximum', max_quantity: 999 },
    } }, String(quantity));
  }
  const shortKey = await handler.handle('preview_quote', invokeQuote(1, { idempotency_key: 'abcdefg' }), CTX);
  assert.equal(shortKey.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(shortKey.error.detail, { reason: 'idempotency_key_too_short', min_length: 8 });
  // A refusal that was there before answers with exactly the body it had: no detail, the code's own hint.
  const asString = await handler.handle('preview_quote', invokeQuote('1000'), CTX);
  assert.deepEqual(asString, { ok: false, error: { code: 'QUOTE_REQUIRED', retriable: false, recovery: 'call pivota_quote first', message: 'I need a fresh price quote before placing this order.' } });
  assert.deepEqual(calls, [], 'nothing was called for any refusal');

  const priced = await handler.handle('preview_quote', invokeQuote(999), CTX);
  assert.equal(priced.ok, true, JSON.stringify(priced));
  assert.deepEqual(calls.map((c) => [c.op, c.payload.quote.items[0].quantity]), [['preview_quote', 999]]);
});

// ---- one number: no other literal ceiling on a line quantity anywhere on these paths ------------------------------

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const QUANTITY_PATHS = [
  'safety-kernel/src/protocol/intakeBounds.cjs',
  'safety-kernel/src/protocol/buyerIntake.js',
  'safety-kernel/src/protocol/canonicalExecutor.js',
  'safety-kernel/src/protocol/acpRestAdapter.js',
  'safety-kernel/src/contractValidation.js',
  'safety-kernel/src/invokeHandler.js',
  'safety-kernel/src/kernel.js',
  'safety-kernel/src/upstreamAdapter.js',
  'mcp-server/src/commerceToolSurface.js',
  'mcp-server/src/ucpArgumentAdapter.js',
  'mcp-server/src/ucpCheckoutEscalation.js',
  'mcp-server/src/operationMap.js',
  'mcp-server/src/secureInvoke.js',
  'src/schema.js',
  'src/server.js',
];
// The purchase lanes' own limit: lower than the ceiling, theirs to keep, and the largest number a quantity may sit
// beside anywhere else on these paths.
const LARGEST_LANE_LIMIT = 10;

/** Every number above the lane limit that sits within one expression of the word "quantity", in code (not comments). */
function numbersBesideQuantity(source) {
  const found = [];
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(code) || /^\s*\/\*/.test(code)) return;
    for (const match of code.matchAll(/quantity/gi)) {
      const before = code.slice(Math.max(0, match.index - 40), match.index).split(/[;{}]/).pop();
      const after = code.slice(match.index, match.index + 100).split(/[;}]/)[0];
      for (const number of `${before} ${after}`.matchAll(/(?<![\w.$])(\d[\d_]*)(?![\w.])/g)) {
        const value = Number(number[1].replace(/_/g, ''));
        if (value > LARGEST_LANE_LIMIT) found.push({ line: index + 1, value, code: code.trim().slice(0, 120) });
      }
    }
  });
  return found;
}

test('the scan itself finds a literal ceiling when there is one', () => {
  assert.equal(numbersBesideQuantity('if (it.quantity > 1000) refuse();').length, 1);
  assert.equal(numbersBesideQuantity('const ok = 999 >= item.quantity;').length, 1);
  assert.equal(numbersBesideQuantity('quantity: { type: "integer", minimum: 1, maximum: 500 },').length, 1);
  assert.equal(numbersBesideQuantity('const MAX_QUANTITY = 1_000;').length, 1);
  assert.equal(numbersBesideQuantity('// a comment about quantity 1000').length, 0);
  assert.equal(numbersBesideQuantity('quantity: { type: "integer", minimum: 1, maximum: 10 }, title: { maxLength: 1024 }').length, 0);
  assert.equal(numbersBesideQuantity('if (it.quantity > MAX_LINE_QUANTITY) refuse();').length, 0);
});

test('the per-line ceiling is written as a number in exactly one place on the checkout and invoke paths', () => {
  const hits = [];
  for (const file of QUANTITY_PATHS) {
    for (const hit of numbersBesideQuantity(readFileSync(join(REPO, file), 'utf8'))) hits.push({ file, ...hit });
  }
  assert.deepEqual(hits.map((h) => [h.file, h.value, h.code]), [
    ['safety-kernel/src/protocol/intakeBounds.cjs', 999, 'const MAX_LINE_QUANTITY = 999;'],
  ]);
});

test('the gateway\'s own invoke route holds no rule of its own: it loads the shared module and asks it', () => {
  const server = readFileSync(join(REPO, 'src/server.js'), 'utf8');
  assert.match(server, /require\('\.\.\/safety-kernel\/src\/protocol\/intakeBounds\.cjs'\)/);
  assert.match(server, /commerceIntakeBounds\.invokeIntakeBoundsRefusal\(operation, payload\)/);
  // No list of operations, no minimum and no ceiling of its own.
  for (const forbidden of [/MAX_LINE_QUANTITY\s*=/, /IDEMPOTENCY_KEY_MIN_LENGTH\s*=/, /quantity_above_line_maximum/, /idempotency_key_too_short/]) {
    assert.equal(forbidden.test(server), false, String(forbidden));
  }
});

test('the shared module: what a refusal says, and that it is as final as its code', () => {
  const key = intakeBoundsModule.idempotencyKeyRefusal('abcdefg');
  const quantity = intakeBoundsModule.lineQuantityRefusal();
  for (const refusal of [key, quantity]) {
    const err = new PivotaCommerceError(refusal.code, {});
    assert.equal(refusal.retriable, false);
    assert.equal(refusal.retriable, err.retriable, `${refusal.code}: the taxonomy says the same`);
  }
  assert.deepEqual([key.code, key.reason, key.detail], ['IDEMPOTENCY_CONFLICT', 'idempotency_key_too_short', { min_length: 8 }]);
  assert.deepEqual([quantity.code, quantity.reason, quantity.detail], ['QUOTE_REQUIRED', 'quantity_above_line_maximum', { max_quantity: 999 }]);
  assert.equal(intakeBoundsModule.idempotencyKeyRefusal('abcdefgh'), null);
  assert.equal(intakeBoundsModule.idempotencyKeyRefusal(undefined), null);
  // What the gateway's own invoke route gets back: the key before the lines, null when within both.
  assert.equal(intakeBoundsModule.invokeIntakeBoundsRefusal('preview_quote', { idempotency_key: 'k', quote: { items: [{ quantity: 1000 }] } }).reason, 'idempotency_key_too_short');
  assert.equal(intakeBoundsModule.invokeIntakeBoundsRefusal('preview_quote', { quote: { items: [{ quantity: '1000' }] } }).reason, 'quantity_above_line_maximum');
  assert.equal(intakeBoundsModule.invokeIntakeBoundsRefusal('preview_quote', { idempotency_key: 'abcdefgh', quote: { items: [{ quantity: '999' }] } }), null);
  assert.equal(intakeBoundsModule.invokeIntakeBoundsRefusal('constructor', { idempotency_key: 'k', quote: { items: [{ quantity: 1000 }] } }), null);
  // The numbers every ESM importer sees are this module's own.
  assert.equal(IDEMPOTENCY_KEY_MIN_LENGTH, intakeBoundsModule.IDEMPOTENCY_KEY_MIN_LENGTH);
  assert.equal(MAX_LINE_QUANTITY, intakeBoundsModule.MAX_LINE_QUANTITY);
});
