// ONE LINE PER PRODUCT AND VARIANT (intakeBounds.cjs, buyerIntake.js `assertNoDuplicateLines`).
//
// The per-line quantity ceiling bounds one line. What prices a cart adds the quantities of lines that name the same
// product and variant together, so two lines of 600 would be priced as one line of 1,200. A cart that names the same
// product and variant on more than one line is therefore refused, by name, and the caller merges the lines.
//
// What is pinned here, at the rule itself and at the kernel-side callers (the cart intake, the canonical executor,
// the ACP REST adapter, the invoke contract and the kernel's invoke handler):
//   - WHAT "THE SAME" IS: the same product id and the same variant id, exactly, after the normalisation the reader
//     of the line already applies. Two lines with no variant are the same; a line with a variant and one without
//     are not known to be, and are not refused from the request alone.
//   - THE REFUSAL NAMES POSITIONS, never an id or a quantity, and is terminal.
//   - IT IS RAISED BEFORE ANYTHING IS CALLED: every collaborator is a recorder that fails the test when a refused
//     cart reaches it.
//   - THE EXECUTOR ASKS AGAIN on the lines it is about to price, so a variant a door resolved for a line is compared.
//   - NOTHING IS SUMMED: 999 + 999 of two different variants is accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { PivotaCommerceError } from '../src/errors.js';
import {
  assertInvokeIntakeBounds,
  assertInvokeNoDuplicateLines,
  invokeErrorOf,
  validateCanonical,
} from '../src/contractValidation.js';
import intakeBounds from '../src/protocol/intakeBounds.cjs';
import { createInvokeHandler } from '../src/invokeHandler.js';
import { SafetyKernel } from '../src/kernel.js';
import {
  assertNoDuplicateLines,
  DUPLICATE_LINE_REASON,
  DUPLICATE_LINES_SENTENCE,
  MAX_CART_ITEMS,
  normalizeCartItems,
  surfaceableIntakeRefusal,
} from '../src/protocol/buyerIntake.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { InMemoryKvStore } from '../src/stores.js';

const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };
const rejected = (promise) => promise.then(() => null, (err) => err);

const MESSAGE = 'This cart names the same product and variant on more than one line. Merge those lines into one line that carries their combined quantity (at most 999 units per line) and send the request again. `detail.duplicate_lines` lists the lines to merge by position (the first line is 1), one group per product and variant. Retrying as sent will not change the answer.';

function assertDuplicateLines(err, groups, label) {
  assert.ok(err instanceof PivotaCommerceError, `${label}: a kernel error, got ${JSON.stringify(err)}`);
  assert.equal(err.code, 'QUOTE_REQUIRED', `${label}: the code every other cart-line refusal gets`);
  assert.equal(err.retriable, false, `${label}: terminal`);
  assert.equal(err.detail.reason, 'duplicate_line_for_product_variant', `${label}: named`);
  const surfaced = surfaceableIntakeRefusal(err);
  assert.deepEqual(surfaced.detail, { reason: 'duplicate_line_for_product_variant', duplicate_lines: groups }, `${label}: the detail a door surfaces`);
  assert.equal(surfaced.message, MESSAGE, `${label}: the message`);
}

const line = (product_id, variant_id, quantity = 1) => (variant_id === undefined ? { product_id, quantity } : { product_id, variant_id, quantity });

// ---- the rule ---------------------------------------------------------------------------------------------------

test('the reason name, and the one sentence a tool schema adds', () => {
  assert.equal(DUPLICATE_LINE_REASON, 'duplicate_line_for_product_variant');
  assert.equal(intakeBounds.DUPLICATE_LINE_REASON, DUPLICATE_LINE_REASON);
  assert.match(DUPLICATE_LINES_SENTENCE, /same product and variant on more than one line is refused; merge those lines into one\.$/);
});

test('the same product and variant on two lines is a duplicate; 600 + 600 is refused, whatever the quantities', () => {
  assert.deepEqual(intakeBounds.duplicateLineGroups([line('p1', 'v1', 600), line('p1', 'v1', 600)]), [[1, 2]]);
  assertDuplicateLines(caught(() => assertNoDuplicateLines([line('p1', 'v1', 600), line('p1', 'v1', 600)])), [[1, 2]], '600 + 600');
  assertDuplicateLines(caught(() => assertNoDuplicateLines([line('p1', 'v1', 1), line('p1', 'v1', 1)])), [[1, 2]], '1 + 1');
  assertDuplicateLines(caught(() => assertNoDuplicateLines([line('p1', 'v1', 999), line('p2', 'v9', 1), line('p1', 'v1', 1)])), [[1, 3]], 'not adjacent');
  // Three lines of one, two of another: one group each, in the order the cart first names them.
  const cart = [line('p2', 'v2'), line('p1', 'v1'), line('p1', 'v1'), line('p3', 'v3'), line('p2', 'v2'), line('p1', 'v1')];
  assertDuplicateLines(caught(() => assertNoDuplicateLines(cart)), [[1, 5], [2, 3, 6]], 'two groups');
});

test('nothing is summed: different variants of one product, and different products, are different lines at any quantity', () => {
  for (const cart of [
    [line('p1', 'v1', 999), line('p1', 'v2', 999)],
    [line('p1', 'v1', 600), line('p2', 'v1', 600)],
    [line('p1', 'v1', 999)],
    [line('p1', 'v1', 999), line('p1', 'v2', 999), line('p2', 'v1', 999), line('p2', 'v2', 999)],
    [],
  ]) {
    assert.deepEqual(intakeBounds.duplicateLineGroups(cart), [], JSON.stringify(cart));
    assert.equal(caught(() => assertNoDuplicateLines(cart)), null, JSON.stringify(cart));
  }
});

test('a line with no variant: two of one product are the same line twice; one with a variant and one without are not known to be', () => {
  assertDuplicateLines(caught(() => assertNoDuplicateLines([line('p1', undefined, 600), line('p1', undefined, 600)])), [[1, 2]], 'no variant twice');
  // A variant that is not a string, or is blank, is no variant: that is how the intake reads it.
  for (const blank of ['', '   ', null, 7, {}, ['v1'], true]) {
    assertDuplicateLines(caught(() => assertNoDuplicateLines([line('p1', blank), line('p1', undefined)])), [[1, 2]], `variant ${JSON.stringify(blank)}`);
  }
  // Named beside unnamed: which variant the second line means is only known once the product is read.
  assert.equal(caught(() => assertNoDuplicateLines([line('p1', 'v1', 600), line('p1', undefined, 600)])), null);
  assert.equal(caught(() => assertNoDuplicateLines([line('p1', undefined, 600), line('p1', 'v1', 600), line('p1', 'v2', 600)])), null);
  // And never by the variant restating the product id: that is another spelling, not the same text.
  assert.equal(caught(() => assertNoDuplicateLines([line('p1', 'p1'), line('p1', undefined)])), null);
});

test('ids are compared exactly, after the one normalisation the intake applies: whitespace around an id', () => {
  assertDuplicateLines(caught(() => assertNoDuplicateLines([line(' p1 ', 'v1'), line('p1', ' v1')])), [[1, 2]], 'padding');
  assertDuplicateLines(caught(() => assertNoDuplicateLines([line('p1\t', 'v1\n'), line('p1', 'v1')])), [[1, 2]], 'other whitespace trim removes');
  // Not folded: letter case, inner whitespace, another spelling of an id, a number that prints the same.
  for (const [a, b] of [
    [line('P1', 'v1'), line('p1', 'v1')],
    [line('p1', 'V1'), line('p1', 'v1')],
    [line('p 1', 'v1'), line('p1', 'v1')],
    [line('sig_' + 'a'.repeat(32), 'v1'), line('sig_' + 'a'.repeat(24), 'v1')],
    [line('p1', 'v1'), line('p1', 'v1 x')],
    [line('p1', '1'), line('p1', '01')],
  ]) {
    assert.equal(caught(() => assertNoDuplicateLines([a, b])), null, JSON.stringify([a, b]));
  }
  // `sku_id` is not part of a line's identity: no pricing path reads it.
  assertDuplicateLines(caught(() => assertNoDuplicateLines([{ ...line('p1', 'v1'), sku_id: 's1' }, { ...line('p1', 'v1'), sku_id: 's2' }])), [[1, 2]], 'sku_id differs');
  assert.equal(caught(() => assertNoDuplicateLines([{ ...line('p1', 'v1'), sku_id: 's1' }, { ...line('p1', 'v2'), sku_id: 's1' }])), null, 'sku_id equal');
});

test('a line the intake cannot identify is not this rule\'s; a cart that is not a cart is left to the rule about that', () => {
  for (const unusable of [null, undefined, 'p1', 7, [], ['p1'], {}, { variant_id: 'v1' }, { product_id: '' }, { product_id: '   ' }, { product_id: 7, variant_id: 'v1' }, { product_id: null }]) {
    assert.equal(caught(() => assertNoDuplicateLines([unusable, unusable])), null, JSON.stringify(unusable));
    assert.deepEqual(intakeBounds.duplicateLineGroups([unusable, line('p1', 'v1'), unusable]), [], JSON.stringify(unusable));
  }
  // An object that is not a plain one, and a member that is not its own, are not read (as the intake copies a line).
  const inherited = Object.create({ product_id: 'p1', variant_id: 'v1' });
  assert.equal(caught(() => assertNoDuplicateLines([inherited, inherited])), null);
  assert.equal(caught(() => assertNoDuplicateLines([new (class Line { constructor() { this.product_id = 'p1'; } })(), line('p1')])), null);
  for (const notACart of [undefined, null, 'x', 7, {}, { 0: line('p1'), 1: line('p1'), length: 2 }]) {
    assert.equal(caught(() => assertNoDuplicateLines(notACart)), null, JSON.stringify(notACart));
    assert.deepEqual(intakeBounds.duplicateLineGroups(notACart), []);
  }
  // More lines than a cart may have: that rule answers, without this one walking the cart.
  assert.equal(caught(() => assertNoDuplicateLines(Array.from({ length: MAX_CART_ITEMS + 1 }, () => line('p1', 'v1')))), null);
  assertDuplicateLines(caught(() => assertNoDuplicateLines(Array.from({ length: MAX_CART_ITEMS }, (_, i) => line(i < 2 ? 'p1' : `p${i}`, 'v1')))), [[1, 2]], 'a full cart');
});

test('the refusal lists positions and nothing from the request, and is bounded whatever the cart', () => {
  const secret = 'prod-id-as-sent-0001';
  const err = caught(() => assertNoDuplicateLines([line(secret, 'variant-as-sent-0001', 777), line(secret, 'variant-as-sent-0001', 888)]));
  const text = JSON.stringify([err.detail, err.message, surfaceableIntakeRefusal(err), err.toResult()]);
  for (const sent of [secret, 'variant-as-sent-0001', '777', '888']) assert.ok(!text.includes(sent), sent);
  // The whole description, as the module gives it.
  assert.deepEqual(intakeBounds.duplicateLinesRefusal([line('p1', 'v1'), line('p1', 'v1')]), {
    code: 'QUOTE_REQUIRED', reason: 'duplicate_line_for_product_variant', message: MESSAGE, detail: { duplicate_lines: [[1, 2]] }, retriable: false,
  });
  assert.equal(intakeBounds.duplicateLinesRefusal([line('p1', 'v1'), line('p1', 'v2')]), null);
  // At most MAX_DUPLICATE_POSITIONS_LISTED positions are listed: whole groups first, never a group of one.
  assert.equal(intakeBounds.MAX_DUPLICATE_POSITIONS_LISTED, 24);
  const everyLineTwice = Array.from({ length: 50 }, (_, i) => line(`p${i % 25}`, 'v1'));
  const listed = intakeBounds.duplicateLinesRefusal(everyLineTwice).detail.duplicate_lines;
  assert.equal(listed.length, 12);
  assert.deepEqual(listed[0], [1, 26]);
  assert.equal(listed.flat().length, 24);
  const oneProductFiftyTimes = intakeBounds.duplicateLinesRefusal(Array.from({ length: 50 }, () => line('p1', 'v1'))).detail.duplicate_lines;
  assert.deepEqual(oneProductFiftyTimes, [Array.from({ length: 24 }, (_, i) => i + 1)]);
  const threeThenMany = intakeBounds.duplicateLinesRefusal([...Array.from({ length: 23 }, () => line('p1', 'v1')), line('p2', 'v1'), line('p2', 'v1')]).detail.duplicate_lines;
  assert.deepEqual(threeThenMany.map((g) => g.length), [23], 'a second group that would be listed as one position is left out');
  // On the invoke door there is no cart-size rule: a cart of any size still gets a small answer.
  const huge = intakeBounds.invokeDuplicateLineRefusal('preview_quote', { quote: { items: Array.from({ length: 5000 }, (_, i) => line(`p${i % 2500}`, 'v1')) } });
  assert.equal(huge.detail.duplicate_lines.flat().length, 24);
});

// ---- the cart intake ----------------------------------------------------------------------------------------------

test('normalizeCartItems: a duplicate line is refused by name; the ceiling and the cart-size rule answer first, every older refusal after', () => {
  assertDuplicateLines(caught(() => normalizeCartItems([line('p1', 'v1', 600), line('p1', 'v1', 600)])), [[1, 2]], '600 + 600');
  assertDuplicateLines(caught(() => normalizeCartItems([line('p1', undefined, 1), line(' p1 ', '', 1)])), [[1, 2]], 'no variant twice');
  assert.deepEqual(normalizeCartItems([line('p1', 'v1', 999), line('p1', 'v2', 999)]), [line('p1', 'v1', 999), line('p1', 'v2', 999)]);
  assert.deepEqual(normalizeCartItems([line('p1', 'v1', 600), line('p1', undefined, 600)]), [line('p1', 'v1', 600), line('p1', undefined, 600)], 'named beside unnamed: left to resolution');
  // Order: too many lines, then a line above the ceiling, then duplicates, then each line's own older refusal.
  assert.equal(caught(() => normalizeCartItems(Array.from({ length: MAX_CART_ITEMS + 1 }, () => line('p1', 'v1')))).detail.reason, 'acp_cart_too_many_items');
  assert.equal(caught(() => normalizeCartItems([line('p1', 'v1', 1000), line('p1', 'v1', 1)])).detail.reason, 'quantity_above_line_maximum');
  assertDuplicateLines(caught(() => normalizeCartItems([line('p1', 'v1', 0), line('p1', 'v1', 1)])), [[1, 2]], 'beside a bad quantity');
  assertDuplicateLines(caught(() => normalizeCartItems([{ sku_id: 's1', quantity: 1 }, line('p2', 'v1'), line('p2', 'v1')])), [[2, 3]], 'beside a line with no product_id');
});

// ---- the canonical executor ---------------------------------------------------------------------------------------

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
  const executor = createCanonicalExecutor({ kernel, upstream: record('upstream'), verifyPaymentAuthorization: record('verifyPaymentAuthorization'), hostedLinkEnabled: true });
  return { executor, calls };
}
const CTX = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };

for (const opId of ['create_checkout_session', 'update_checkout_session']) {
  test(`executor ${opId}: a duplicate line is refused by name before anything is priced; distinct lines are priced`, async () => {
    const params = (items) => ({ idempotency_key: 'abcdefgh', ...(opId === 'update_checkout_session' ? { session_id: 'q_1' } : {}), quote: { merchant_id: 'merch_a', items } });
    const dup = recordingExecutor();
    assertDuplicateLines(await rejected(dup.executor.execute(opId, params([line('p1', 'v1', 600), line('p1', 'v1', 600)]), CTX)), [[1, 2]], `${opId} 600 + 600`);
    // The lines as a door hands them on after resolving a missing variant: both carry it, so they are compared.
    assertDuplicateLines(await rejected(dup.executor.execute(opId, params([line('p1', 'v1', 600), line('p2', 'v1', 1), line('p1', 'v1', 600)]), CTX)), [[1, 3]], `${opId} resolved to the same variant`);
    assert.deepEqual(dup.calls, [], 'nothing was called');

    const distinct = recordingExecutor();
    const err = await rejected(distinct.executor.execute(opId, params([line('p1', 'v1', 999), line('p1', 'v2', 999)]), CTX));
    assert.match(String(err && err.message), /^the kernel was reached: previewQuote$/);
    assert.deepEqual(distinct.calls[0].args[0].quote.items, [line('p1', 'v1', 999), line('p1', 'v2', 999)], 'both lines, untouched, are what the kernel is asked to price');
  });
}

test('executor: the key and the ceiling answer before the duplicate rule, and an operation that carries no cart is not judged', async () => {
  const { executor, calls } = recordingExecutor();
  const dup = [line('p1', 'v1'), line('p1', 'v1')];
  assert.equal((await rejected(executor.execute('create_checkout_session', { idempotency_key: 'abcdefg', quote: { items: dup } }, CTX))).detail.reason, 'idempotency_key_too_short');
  assert.equal((await rejected(executor.execute('create_checkout_session', { idempotency_key: 'abcdefgh', quote: { items: [line('p1', 'v1', 1000), line('p1', 'v1')] } }, CTX))).detail.reason, 'quantity_above_line_maximum');
  assert.deepEqual(calls, []);
  const cancel = await rejected(executor.execute('cancel_checkout_session', { idempotency_key: 'abcdefgh', session_id: 'q_1', quote: { items: dup } }, CTX));
  assert.equal(cancel, null);
});

// ---- the ACP REST adapter -----------------------------------------------------------------------------------------

const ACP_SECRET = 'acp-signing-secret-0123456789abcdef';
function acpSetup({ variantsByProduct = {} } = {}) {
  const calls = [];
  const store = new InMemoryKvStore();
  const sessionStore = {
    get: async (k) => { calls.push({ name: 'sessionStore.get' }); return store.get(k); },
    set: async (k, v, o) => { calls.push({ name: 'sessionStore.set' }); return store.set(k, v, o); },
    putIfAbsent: async (k, v, o) => { calls.push({ name: 'sessionStore.putIfAbsent' }); return store.putIfAbsent(k, v, o); },
  };
  const executor = {
    execute: async (op, params) => {
      calls.push({ name: `executor.${op}`, params });
      if (op === 'get_product') {
        const id = params.payload.product.product_id;
        return { product: { product_id: id, merchant_id: 'merch_a', variants: (variantsByProduct[id] || []).map((variant_id) => ({ variant_id })) } };
      }
      return { session_id: 'q_1', status: 'ready_for_payment', totals: {}, line_items: [] };
    },
  };
  const adapter = createAcpRestAdapter({
    executor, sessionStore, signingSecret: ACP_SECRET,
    resolveUserRef: async () => { calls.push({ name: 'resolveUserRef' }); return { user_ref: 'buyer_1', customer_email: 'buyer@example.test' }; },
  });
  const req = ({ body, key, id }) => {
    const rawBody = JSON.stringify(body ?? {});
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', ACP_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
    return { headers: { signature, timestamp, ...(key !== undefined ? { 'idempotency-key': key } : {}) }, rawBody, params: id ? { checkout_session_id: id } : {} };
  };
  return { adapter, calls, req };
}
const acpCart = (items) => ({ merchant_id: 'merch_a', items });
function assertAcpDuplicateLines(res, groups, label) {
  assert.equal(res.status, 400, `${label}: the status every other cart-line refusal gets: ${JSON.stringify(res.body)}`);
  assert.deepEqual(res.body, { type: 'error', code: 'QUOTE_REQUIRED', message: MESSAGE, detail: { reason: 'duplicate_line_for_product_variant', duplicate_lines: groups } }, label);
}

test('ACP REST: a duplicate line is refused on create and on update before the executor or the session store is called; distinct variants are sent', async () => {
  const { adapter, calls, req } = acpSetup();
  const created = await adapter.createCheckoutSession(req({ body: acpCart([line('p1', 'v1', 999), line('p1', 'v2', 999)]), key: 'acp-create-0001' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(calls.find((c) => c.name === 'executor.create_checkout_session').params.quote.items, [line('p1', 'v1', 999), line('p1', 'v2', 999)]);

  calls.length = 0;
  assertAcpDuplicateLines(await adapter.createCheckoutSession(req({ body: acpCart([line('p1', 'v1', 600), line('p1', 'v1', 600)]), key: 'acp-create-0002' })), [[1, 2]], 'create 600 + 600');
  assert.deepEqual(calls.map((c) => c.name), ['resolveUserRef'], 'create: the buyer was resolved; nothing else was called');
  calls.length = 0;
  assertAcpDuplicateLines(await adapter.updateCheckoutSession(req({ body: acpCart([line('p1', undefined, 1), line('p1', undefined, 1)]), key: 'acp-update-0002', id: 'cs_unknown' })), [[1, 2]], 'update, no variant twice');
  assert.deepEqual(calls.map((c) => c.name), ['resolveUserRef'], 'update: the buyer was resolved; the session store was not read');
  // The same key is free afterwards: a refused cart claimed nothing.
  calls.length = 0;
  const after = await adapter.createCheckoutSession(req({ body: acpCart([line('p1', 'v1', 1)]), key: 'acp-create-0002' }));
  assert.equal(after.status, 201, JSON.stringify(after.body));
});

test('ACP REST, a kernel row: a line that names a variant beside one that names none is refused only when the read resolves them to the same variant, and never priced as one', async () => {
  // p1 has one variant: the line that names none resolves to it, and the two lines are then the same.
  const one = acpSetup({ variantsByProduct: { p1: ['v1'] } });
  const real = createCanonicalExecutor({
    kernel: { previewQuote: async (...args) => { one.calls.push({ name: 'kernel.previewQuote', args }); return { quote_id: 'q_1' }; } },
    upstream: async () => { throw new Error('no upstream here'); },
    verifyPaymentAuthorization: async () => { throw new Error('not reached'); },
  });
  // The door's own executor, wrapped so its checkout operations run the real canonical executor's rule.
  const adapter = createAcpRestAdapter({
    executor: { execute: async (op, params, ctx) => (op === 'get_product'
      ? { product: { product_id: params.payload.product.product_id, merchant_id: 'merch_a', variants: [{ variant_id: 'v1' }] } }
      : real.execute(op, params, ctx)) },
    sessionStore: new InMemoryKvStore(), signingSecret: ACP_SECRET,
    resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }),
  });
  const res = await adapter.createCheckoutSession(one.req({ body: acpCart([line('p1', 'v1', 600), line('p1', undefined, 600)]), key: 'acp-create-0003' }));
  assertAcpDuplicateLines(res, [[1, 2]], 'resolved to the same variant');
  assert.deepEqual(one.calls.filter((c) => c.name === 'kernel.previewQuote'), [], 'nothing was priced');
});

test('ACP REST create: a pair that resolves to the same variant is refused BEFORE the create claim is written, so the same key then creates the merged cart', async () => {
  const calls = [];
  const store = new InMemoryKvStore();
  const sessionStore = {
    get: async (k) => { calls.push('get'); return store.get(k); },
    set: async (k, v, o) => { calls.push('set'); return store.set(k, v, o); },
    putIfAbsent: async (k, v, o) => { calls.push('putIfAbsent'); return store.putIfAbsent(k, v, o); },
  };
  const executor = { execute: async (op, params) => {
    calls.push(op);
    if (op === 'get_product') return { product: { product_id: params.payload.product.product_id, merchant_id: 'merch_a', variants: [{ variant_id: 'v1' }] } };
    return { session_id: 'q_1', status: 'ready_for_payment', totals: {}, line_items: [] };
  } };
  const adapter = createAcpRestAdapter({ executor, sessionStore, signingSecret: ACP_SECRET, resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }) });
  const { req } = acpSetup();
  for (const items of [[line('p1', 'v1', 600), line('p1', undefined, 600)], [line('p1', undefined, 1), line('p1', 'v1', 1)]]) {
    calls.length = 0;
    assertAcpDuplicateLines(await adapter.createCheckoutSession(req({ body: acpCart(items), key: 'acp-claim-0001' })), [[1, 2]], JSON.stringify(items));
    assert.deepEqual(calls, ['get_product'], 'the read that resolves the variant, and nothing else: no claim, no create');
  }
  // The same key, the lines merged: a first create.
  calls.length = 0;
  const merged = await adapter.createCheckoutSession(req({ body: acpCart([line('p1', 'v1', 999)]), key: 'acp-claim-0001' }));
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  assert.deepEqual(calls, ['putIfAbsent', 'create_checkout_session', 'set']);
  // Update: refused after the session is loaded and the variant read, and before the executor is asked to re-price.
  calls.length = 0;
  assertAcpDuplicateLines(await adapter.updateCheckoutSession(req({ body: acpCart([line('p1', 'v1', 600), line('p1', undefined, 600)]), key: 'acp-claim-0002', id: merged.body.id })), [[1, 2]], 'update');
  assert.deepEqual(calls, ['get', 'get_product'], 'update: the session read and the variant read; the executor was not asked to price');
  // A pair that resolves to DIFFERENT variants is two lines, and is created.
  const other = createAcpRestAdapter({
    executor: { execute: async (op, params) => (op === 'get_product'
      ? { product: { product_id: params.payload.product.product_id, merchant_id: 'merch_a', variants: [{ variant_id: 'v_default' }] } }
      : { session_id: 'q_2', status: 'ready_for_payment', totals: {}, line_items: [] }) },
    sessionStore: new InMemoryKvStore(), signingSecret: ACP_SECRET, resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }),
  });
  assert.equal((await other.createCheckoutSession(req({ body: acpCart([line('p1', 'v1', 600), line('p1', undefined, 600)]), key: 'acp-claim-0003' }))).status, 201);
});

// ---- the invoke door ----------------------------------------------------------------------------------------------

const invokeQuote = (items, extra = {}) => ({ quote: { merchant_id: 'merch_a', items }, ...extra });

test('invoke, as that door builds its quote body: the product is product_id or productId; a line with no variant is a line whose variant is its product id', () => {
  const id = intakeBounds.lineIdentityAsInvokeReadsIt;
  assert.equal(id({ product_id: 'p1', variant_id: 'v1' }), id({ productId: ' p1 ', variantId: 'v1 ' }));
  assert.equal(id({ product_id: 'p1' }), id({ product_id: 'p1', variant_id: 'p1' }), 'no variant = the product id, on this door');
  assert.equal(id({ product_id: 'p1', sku: 's1' }), id({ product_id: 'p1', variant_id: 's1' }), '`sku` is a variant spelling here');
  assert.equal(id({ product_id: 9001, variant_id: 7 }), id({ product_id: '9001', variant_id: '7' }), 'read as text, as that builder reads it');
  // THE RESIDUAL ON THIS DOOR: a named variant beside an unnamed line is two keys, (p1, v1) and (p1, p1), and stays
  // so: nothing on this door reads the product, so it is never learned which variant the unnamed line means.
  assert.notEqual(id({ product_id: 'p1', variant_id: 'v1' }), id({ product_id: 'p1' }));
  assert.equal(intakeBounds.invokeDuplicateLineRefusal('preview_quote', { quote: { items: [{ product_id: 'p1', variant_id: 'v1', quantity: 600 }, { product_id: 'p1', quantity: 600 }] } }), null);
  assert.notEqual(id({ product_id: 'p1', variant_id: 'v1' }), id({ product_id: 'P1', variant_id: 'v1' }));
  // An offer id is not part of it: what prices the cart adds lines by product and variant, whatever offer each names.
  assert.equal(id({ product_id: 'p1', variant_id: 'v1', offer_id: 'of_a' }), id({ product_id: 'p1', variant_id: 'v1', offer_id: 'of_b' }));
  for (const none of [null, undefined, 'p1', 7, [], {}, { variant_id: 'v1' }, { product_id: '  ' }, { product_id: null, productId: undefined }]) assert.equal(id(none), null, JSON.stringify(none));
  // A value with no text form cannot be read by that builder either: not this rule's, and never a throw.
  assert.equal(id({ product_id: { toString: 1, valueOf: 1 } }), null);
});

test('the invoke route that does not run the strict contract: a duplicate line is refused on a quote and on an order\'s lines; the key and the ceiling answer first', () => {
  const dup = [line('p1', 'v1', 600), line('p1', 'v1', 600)];
  assertDuplicateLines(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote(dup))), [[1, 2]], 'quote');
  assertDuplicateLines(caught(() => assertInvokeIntakeBounds('create_order', { order: { quote_id: 'q_1', items: dup } })), [[1, 2]], 'order');
  assertDuplicateLines(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote([{ productId: 'p1', quantity: 1 }, { product_id: 'p1', variant_id: 'p1', quantity: 1 }]))), [[1, 2]], 'as that route reads a line');
  assertDuplicateLines(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote([{ product_id: 'p1', variant_id: 'v1', offer_id: 'of_a', quantity: 1 }, { product_id: 'p1', variant_id: 'v1', offer_id: 'of_b', quantity: 1 }]))), [[1, 2]], 'two offers of one variant');
  for (const items of [[line('p1', 'v1', 999), line('p1', 'v2', 999)], [line('p1', 'v1'), line('p1')], [line('p1', 'v1')], [null, 'x', 7], [{}, {}]]) {
    assert.equal(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote(items))), null, JSON.stringify(items));
  }
  assert.equal(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote(dup, { idempotency_key: 'k' }))).detail.reason, 'idempotency_key_too_short');
  assert.equal(caught(() => assertInvokeIntakeBounds('preview_quote', invokeQuote([line('p1', 'v1', '1000'), line('p1', 'v1')]))).detail.reason, 'quantity_above_line_maximum');
  // An operation that carries no cart is never judged.
  assert.equal(caught(() => assertInvokeIntakeBounds('find_products', invokeQuote(dup))), null);
  assert.equal(caught(() => assertInvokeIntakeBounds('submit_payment', { idempotency_key: 'abcdefgh', quote: { items: dup }, order: { items: dup } })), null);
  assert.equal(caught(() => assertInvokeNoDuplicateLines('toString', invokeQuote(dup))), null);
});

test('strict contract, preview_quote: a duplicate line is refused by name after the ceiling and before any line is otherwise judged; an order\'s lines are not read', () => {
  assertDuplicateLines(caught(() => validateCanonical('preview_quote', invokeQuote([line('p1', 'v1', 600), line('p1', 'v1', 600)]))), [[1, 2]], '600 + 600');
  assertDuplicateLines(caught(() => validateCanonical('preview_quote', invokeQuote([line('p1', 'v1', 'x'), line('p1', 'v1', 1)]))), [[1, 2]], 'beside a bad quantity');
  assert.equal(caught(() => validateCanonical('preview_quote', invokeQuote([line('p1', 'v1', 1000), line('p1', 'v1', 1)]))).detail.reason, 'quantity_above_line_maximum');
  assert.equal(caught(() => validateCanonical('preview_quote', invokeQuote([line('p1', 'v1', 999), line('p1', 'v2', 999)]))), null);
  const order = { idempotency_key: 'abcdefgh', order: { quote_id: 'q_1', items: [line('p1', 'v1'), line('p1', 'v1')], shipping_address: { country: 'US', city: 'c', address_line1: 'a', recipient_name: 'r', postal_code: '1' } } };
  assert.equal(caught(() => validateCanonical('create_order', order)), null, 'an order is priced from its locked quote');
  // The invoke door's error object names it, like the other shared bounds.
  assert.deepEqual(invokeErrorOf(caught(() => validateCanonical('preview_quote', invokeQuote([line('p1', 'v1'), line('p1', 'v1')])))), {
    code: 'QUOTE_REQUIRED', retriable: false, message: MESSAGE, detail: { reason: 'duplicate_line_for_product_variant', duplicate_lines: [[1, 2]] },
  });
});

test('the kernel\'s invoke handler: a quote with a duplicate line is refused before the kernel or an upstream is called', async () => {
  const calls = [];
  const kernel = new SafetyKernel({
    upstream: async (op, payload) => { calls.push({ op, payload }); return { quote_id: 'bq_1', currency: 'USD', merchant_of_record: 'merch_a', locked_totals: { subtotal: 100, total: 100 }, line_items: payload.quote.items }; },
    secret: 'invoke-bounds-secret-0123456789abcdef',
    log: { info() {}, warn() {}, error() {} },
  });
  const handler = createInvokeHandler({ kernel, upstream: async (op, payload) => { calls.push({ op, payload }); return {}; }, log: { info() {}, warn() {}, error() {} } });
  const out = await handler.handle('preview_quote', invokeQuote([line('p1', 'v1', 600), line('p1', 'v1', 600)]), CTX);
  assert.deepEqual(out, { ok: false, error: { code: 'QUOTE_REQUIRED', retriable: false, message: MESSAGE, detail: { reason: 'duplicate_line_for_product_variant', duplicate_lines: [[1, 2]] } } });
  assert.deepEqual(calls, [], 'nothing was called');
  const priced = await handler.handle('preview_quote', invokeQuote([line('p1', 'v1', 999), line('p1', 'v2', 999)]), CTX);
  assert.equal(priced.ok, true, JSON.stringify(priced));
  assert.deepEqual(calls.map((c) => c.payload.quote.items.map((it) => [it.variant_id, it.quantity])), [[['v1', 999], ['v2', 999]]]);
});
