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
import { PivotaCommerceError } from '../src/errors.js';
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
