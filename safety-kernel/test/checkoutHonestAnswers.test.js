// CHECKOUT ANSWERS THAT SAY WHAT HAPPENED, at the executor and the kernel.
//
//   A. Once the kernel order exists, a money call with no readable answer (no response, the deadline, a 5xx, a 2xx
//      that says nothing) is CHECKOUT_OUTCOME_UNKNOWN with the order's id, not retriable; the same key is given that
//      same answer again; a new key is told QUOTE_ALREADY_USED with the caller's own order id. A create_order 2xx
//      that cannot be read as an order is an unknown outcome too (no order id is known), never PRICE_CHANGED.
//      Refusals the upstream answered (a status below 500) are exactly what they were.
//   B. A tool door's completion or payment link with no address to ship to is refused by name before any order.
//   C. With the upstream cancel off, a cancel by session id says "canceled" only when it is true.
//   D. A session that became an order reads as one (get), and an update of it says so.
// Every name is a placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { PivotaCommerceError, kernelOutcomeUnknown, kernelOutcomeUnknownOf, KERNEL_OUTCOME_UNKNOWN_REASONS, KERNEL_ANSWERED_REFUSALS } from '../src/errors.js';
import { REFUSED_BEFORE_ANY_ORDER } from '../src/upstreamRefusal.js';
import { IdempotencyLedger } from '../src/idempotencyLedger.js';
import { InMemoryKvStore } from '../src/stores.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';

const SECRET = 'honest-answers-secret-0123456789';
const CTX = Object.freeze({ user_ref: 'buyer_1', acp_session_id: 'sess_1' });
const quiet = { info() {}, warn() {}, error() {} };
const SHIP_TO = Object.freeze({ name: 'Buyer One', address_line1: '1 Example Road', city: 'Exampleton', postal_code: '00001', country: 'US' });
const CURRENCY_BY_MARKET = Object.freeze({ US: 'USD', SG: 'SGD', GB: 'GBP', DE: 'EUR' });

// What the gateway's transport throws for an upstream failure (src/server.js throwCommerceKernelUpstreamError).
const transportError = (code, detail) => new PivotaCommerceError(code, { operation: 'x', upstream_code: null, ...detail });
const UNKNOWN_FAILURES = Object.freeze({
  deadline: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: null, upstream_timeout: true }),
  no_response: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: null }),
  status_500: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: 500 }),
  status_502: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: 502 }),
  status_503: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: 503, upstream_code: 'TEMPORARY_UNAVAILABLE' }),
  status_504: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: 504 }),
  not_a_kernel_error: () => new Error('socket hang up'),
});
const KNOWN_REFUSALS = Object.freeze({
  status_409_canceled: () => transportError('ORDER_CANCELED', { upstream_status: 409, upstream_code: 'ORDER_CANCELED' }),
  status_400: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: 400, upstream_code: 'INVALID_REQUEST' }),
  status_404: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: 404 }),
});

/**
 * A kernel and an executor over a scripted upstream. `script.<op>` is a queue of functions `(payload) => answer`
 * (throw to fail); an empty queue answers normally. `market` prices the quote in that market's currency.
 */
function world({ market = 'US', hostedLink = true, cancelUpstream = false, delegated = false, onVerify } = {}) {
  const calls = [];
  const script = { create_order: [], submit_payment: [], create_payment_link: [], dispatch: [] };
  const currency = CURRENCY_BY_MARKET[market] || 'USD';
  let orders = 0;
  const upstream = async (op, payload) => {
    calls.push({ op, payload });
    const next = script[op] && script[op].shift();
    if (next) return next(payload);
    if (op === 'preview_quote') return { quote_id: 'bq_1', currency, merchant_of_record: 'merch_A', locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] };
    if (op === 'create_order') { orders += 1; return { order_id: `o_${orders}`, acp_state: {} }; }
    if (op === 'submit_payment') return { payment_id: `pay_${payload.payment.order_id}`, payment_status: 'requires_action', redirect_url: `https://pay.example.test/${payload.payment.order_id}` };
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: quiet });
  const reads = async (op, payload) => {
    calls.push({ op, payload });
    const next = script[op] && script[op].shift();
    if (next) return next(payload);
    if (op === 'create_payment_link') return { checkout_url: `https://pay.example.test/c/${payload.order_id}`, checkout_session_id: `cs_${payload.order_id}` };
    return {};
  };
  let verifies = 0;
  const cancels = [];
  const executor = createCanonicalExecutor({
    kernel,
    upstream: reads,
    verifyPaymentAuthorization: async (_a, b) => { verifies += 1; if (onVerify) await onVerify(b); return { ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }; },
    hostedLinkEnabled: hostedLink,
    cancelUpstreamEnabled: cancelUpstream,
    cancelUpstreamOrder: async (orderId) => { cancels.push(orderId); return { kind: 'canceled' }; },
    delegatedTokenHandoffEnabled: delegated,
    submitDelegatedPayment: async (bound) => {
      calls.push({ op: 'dispatch', payload: bound });
      const next = script.dispatch.shift();
      if (next) return next(bound);
      return { payment_id: `spt_pay_${bound.order_id}`, payment_status: 'succeeded' };
    },
  });
  const ops = (op) => calls.filter((c) => c.op === op);
  const exec = (op, params, ctx = CTX) => executor.execute(op, params, ctx);
  return { kernel, executor, exec, calls, ops, script, verifies: () => verifies, cancels, currency };
}

const refusal = (p) => p.then(() => null, (e) => e);
// An answer that must succeed: a refusal fails the test by assertion, naming the refusal.
const answered = (p, label = '') => p.catch((e) => assert.fail(`${label}: refused ${e && e.code} ${JSON.stringify(e && e.detail)}`));
async function open(w, { address = true, ctx = CTX, key = 'idem-open-0001' } = {}) {
  const s = await w.exec('create_checkout_session', { idempotency_key: key, quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test', ...(address ? { shipping_address: { ...SHIP_TO } } : {}) } }, ctx);
  return s.session_id;
}
const complete = (w, sid, key, extra = {}, ctx = CTX) => w.exec('complete_checkout_session', { idempotency_key: key, session_id: sid, payment_authorization: { token: 'grant_placeholder' }, ...extra }, ctx);
const link = (w, sid, key, extra = {}, ctx = CTX) => w.exec('create_payment_link', { idempotency_key: key, session_id: sid, customer_email: 'buyer@example.test', ...extra }, ctx);
const LANES = Object.freeze({ complete: { run: complete, failingOp: 'submit_payment', reason: KERNEL_OUTCOME_UNKNOWN_REASONS.payment }, payment_link: { run: link, failingOp: 'create_payment_link', reason: KERNEL_OUTCOME_UNKNOWN_REASONS.paymentLink } });

function assertUnknown(err, reason, orderId, label, { answered } = {}) {
  assert.ok(err instanceof PivotaCommerceError, `${label}: ${err && err.stack}`);
  assert.equal(err.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${label}: ${err.code} ${JSON.stringify(err.detail)}`);
  assert.equal(err.retriable, false, `${label}: not retriable`);
  // Says nothing but what it is about: no amount, no currency, no upstream detail.
  assert.deepEqual(err.detail, { reason, order_id: orderId }, label);
  assert.equal(kernelOutcomeUnknownOf(err).answered, answered, `${label}: the store's answer, as the words read it`);
  if (answered) {
    // A refusal the store DID answer (a 403, a 429): its own words, never the words of a call with no readable answer.
    assert.deepEqual([err.message, err.userMessage, err.recovery], [KERNEL_ANSWERED_REFUSALS[answered].message, KERNEL_ANSWERED_REFUSALS[answered].message, KERNEL_ANSWERED_REFUSALS[answered].recovery], label);
    for (const text of [err.message, err.recovery]) {
      assert.equal(/no readable answer|may have been accepted|store may hold an order/i.test(text), false, `${label}: ${text}`);
      assert.match(text, /do not place a new order for this purchase without the buyer/, label);
      assert.equal(/nothing was ordered/i.test(text), false, `${label}: never claims nothing was ordered`);
    }
    assert.match(err.message, answered === 'rate_limited' ? /rate limiting.*earlier attempt of this checkout may already have placed an order/ : /answered this order request with a refusal.*cannot be retried/, label);
    return;
  }
  if (orderId) assert.match(err.recovery, /get_order/, label);
  else {
    // No id to read: never sent to get_order; told the store may hold an order, and not to place one without the buyer.
    assert.equal(/get_order/.test(err.recovery), false, label);
    assert.match(err.recovery, /store may hold an order/, label);
    assert.match(err.recovery, /do not place a new order for this purchase without the buyer/, label);
  }
}

// ---- A.1 / A.2 / A.3: after the order exists ------------------------------------------------------------------------

for (const [laneName, lane] of Object.entries(LANES)) {
  for (const [shape, fail] of Object.entries(UNKNOWN_FAILURES)) {
    test(`A ${laneName}: ${shape} after the order exists is an unknown outcome with the order id; the same key is told the same, another key is told QUOTE_ALREADY_USED with that order, and nothing is asked again`, async () => {
      for (const market of ['US', 'SG', 'GB', 'DE', null]) {
        const label = `${laneName} ${shape} ${market}`;
        const w = world({ market: market ?? 'US' });
        const sid = await open(w);
        w.script[lane.failingOp].push(() => { throw fail(); });
        assertUnknown(await refusal(lane.run(w, sid, 'idem-first-0001')), lane.reason, 'o_1', label);
        assert.deepEqual([w.ops('create_order').length, w.ops(lane.failingOp).length], [1, 1], label);
        // A.2: the same key, the same request: the same answer, and nothing more is sent.
        assertUnknown(await refusal(lane.run(w, sid, 'idem-first-0001')), lane.reason, 'o_1', `${label} same key`);
        // A.3: another key: the session is spent, and the refusal names the caller's own order.
        const other = await refusal(lane.run(w, sid, 'idem-other-0001'));
        assert.equal(other.code, 'QUOTE_ALREADY_USED', label);
        assert.equal(other.detail.order_id, 'o_1', label);
        assert.deepEqual([w.ops('create_order').length, w.ops(lane.failingOp).length, w.ops('submit_payment').length], [1, 1, laneName === 'complete' ? 1 : 0], `${label}: never a second order or payment call`);
      }
    });
  }
  for (const [shape, fail] of Object.entries(KNOWN_REFUSALS)) {
    test(`A ${laneName}: a refusal the upstream answered (${shape}) after the order exists is answered exactly as it was raised`, async () => {
      const w = world();
      const sid = await open(w);
      const raised = fail();
      w.script[lane.failingOp].push(() => { throw raised; });
      assert.equal(await refusal(lane.run(w, sid, 'idem-known-0001')), raised);
      // The same key is not told "outcome unknown" either: the earlier answer was a known one.
      const again = await refusal(lane.run(w, sid, 'idem-known-0001'));
      assert.equal(again.code, 'IDEMPOTENCY_CONFLICT');
      assert.equal(again.detail.reason, 'ambiguous_prior_attempt');
    });
  }
}

test('A complete: a refusal the kernel raises before the payment call (a charge already in progress) stays what it was', async () => {
  const w = world();
  const sid = await open(w);
  const order = await w.kernel.createOrder({ idempotency_key: 'idem-direct-order', order: { quote_id: sid, shipping_address: { ...SHIP_TO } } }, CTX);
  await w.kernel._orderStore.putIfAbsent(`charge-lock:${order.order_id}`, { owner: 'someone-else' });
  // Drive the executor's post-order path by hand: the payment call refuses with the kernel's own named conflict.
  const err = await refusal(w.kernel.submitPayment({ idempotency_key: 'idem-direct-pay-1', confirmation_token: 'x', payment: { order_id: order.order_id, expected_amount: 1800, currency: 'USD' } }, CTX));
  assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(err.detail.reason, 'charge_in_progress');
  assert.equal(kernelOutcomeUnknownOf(err), null);
});

test('A complete: the delegated-token lane answers an unknown outcome of its dispatch the same way, with the order id', async () => {
  const w = world({ delegated: true });
  const ctx = { ...CTX, protocol: 'acp' };
  const sid = await open(w, { ctx });
  w.script.dispatch.push(() => { throw UNKNOWN_FAILURES.deadline(); });
  const first = await refusal(w.exec('complete_checkout_session', { idempotency_key: 'idem-spt-0001', session_id: sid, payment_authorization: { token: 'spt_placeholder' }, shipping_address: { ...SHIP_TO } }, ctx));
  assertUnknown(first, KERNEL_OUTCOME_UNKNOWN_REASONS.payment, 'o_1', 'spt');
  assert.equal(w.ops('dispatch').length, 1);
  const again = await refusal(w.exec('complete_checkout_session', { idempotency_key: 'idem-spt-0001', session_id: sid, payment_authorization: { token: 'spt_placeholder' }, shipping_address: { ...SHIP_TO } }, ctx));
  assertUnknown(again, KERNEL_OUTCOME_UNKNOWN_REASONS.payment, 'o_1', 'spt same key');
  assert.equal(w.ops('dispatch').length, 1);
});

// ---- A.4: a payment 2xx that says nothing -----------------------------------------------------------------------------

for (const [shape, body] of Object.entries({ empty_object: {}, null_body: null, a_string: '<html>ok</html>', payment_id_only: { payment_id: 'pay_x' }, blank_status: { payment_status: '  ', redirect_url: '' } })) {
  test(`A.4 a payment answer naming neither a status nor a page (${shape}) is an unknown outcome; the order stays charge_pending and cannot be charged again`, async () => {
    const w = world();
    const sid = await open(w);
    w.script.submit_payment.push(() => body);
    assertUnknown(await refusal(complete(w, sid, 'idem-pay-0001')), KERNEL_OUTCOME_UNKNOWN_REASONS.payment, 'o_1', shape);
    const record = await w.kernel._orderStore.get('o_1');
    assert.equal(record.status, 'charge_pending');
    assert.equal(record.payment_id, null);
    assertUnknown(await refusal(complete(w, sid, 'idem-pay-0001')), KERNEL_OUTCOME_UNKNOWN_REASONS.payment, 'o_1', `${shape} same key`);
    assert.equal(w.ops('submit_payment').length, 1);
  });
}

for (const [shape, body] of Object.entries({ status_only: { payment_id: 'pay_1', payment_status: 'requires_action' }, page_only: { payment_id: 'pay_1', redirect_url: 'https://pay.example.test/x' }, paid: { payment_id: 'pay_1', payment_status: 'succeeded' } })) {
  test(`A.4 a payment answer naming a status or a page (${shape}) is answered as before`, async () => {
    const w = world();
    const sid = await open(w);
    w.script.submit_payment.push(() => body);
    const out = await answered(complete(w, sid, 'idem-pay-0002'), shape);
    assert.equal(out.order.order_id, 'o_1');
    assert.equal(out.payment.payment_id, 'pay_1');
  });
}

// ---- A.5: a create_order 2xx that cannot be read as an order ------------------------------------------------------------

for (const [shape, body] of Object.entries({ empty_object: {}, a_string: '<html>ok</html>', null_body: null, blank_order_id: { order_id: '  ' }, numeric_order_id: { order_id: 17 } })) {
  test(`A.5 a create_order answer with no order in it (${shape}) is an unknown outcome with no order id, never PRICE_CHANGED; the claim is kept`, async () => {
    for (const [laneName, lane] of Object.entries(LANES)) {
      const w = world();
      const sid = await open(w);
      w.script.create_order.push(() => body);
      const label = `${laneName} ${shape}`;
      assertUnknown(await refusal(lane.run(w, sid, 'idem-co-0001')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, label);
      assert.equal(await w.kernel.isQuoteClaimed(sid), true, `${label}: the claim is kept`);
      assertUnknown(await refusal(lane.run(w, sid, 'idem-co-0001')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `${label} same key`);
      const other = await refusal(lane.run(w, sid, 'idem-co-0002'));
      assert.equal(other.code, 'QUOTE_ALREADY_USED', label);
      assert.equal(other.detail.order_id, undefined, `${label}: no order is known, none is named`);
      assert.deepEqual([w.ops('create_order').length, w.ops('submit_payment').length, w.ops('create_payment_link').length], [1, 0, 0], label);
    }
  });
}

test('A.5 an order the upstream made in another currency, or at another total, is still PRICE_CHANGED (unchanged)', async () => {
  for (const overrides of [{ backend_amount_present: true, backend_amount_minor: 1800, backend_currency: 'JPY' }, { backend_amount_present: true, backend_amount_minor: 1900, backend_currency: 'USD' }]) {
    const w = world();
    const sid = await open(w);
    w.script.create_order.push(() => ({ order_id: 'o_9', ...overrides }));
    const err = await refusal(complete(w, sid, 'idem-pc-0001'));
    assert.equal(err.code, 'PRICE_CHANGED', JSON.stringify(overrides));
  }
});

// ---- Q1: the order call itself gets no readable answer ------------------------------------------------------------

const CREATE_UNKNOWN = Object.freeze({
  ...UNKNOWN_FAILURES,
  connection_refused: () => transportError('MERCHANT_UNAVAILABLE', { upstream_status: null }),
});
for (const [laneName, lane] of Object.entries(LANES)) {
  for (const [shape, fail] of Object.entries(CREATE_UNKNOWN)) {
    test(`Q1 ${laneName}: an order call with ${shape} is an unknown outcome with no order id; the claim is kept, the same key is told the same, another key that the session is used, and get / cancel / update say order_outcome_unknown`, async () => {
      for (const market of ['US', 'SG', 'GB', 'DE']) {
        const label = `${laneName} ${shape} ${market}`;
        const w = world({ market });
        const sid = await open(w);
        w.script.create_order.push(() => { throw fail(); });
        assertUnknown(await refusal(lane.run(w, sid, 'idem-cu-0001')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, label);
        assert.equal(await w.kernel.isQuoteClaimed(sid), true, `${label}: kept`);
        assertUnknown(await refusal(lane.run(w, sid, 'idem-cu-0001')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `${label} same key`);
        const other = await refusal(lane.run(w, sid, 'idem-cu-0002'));
        assert.equal(other?.code, 'QUOTE_ALREADY_USED', label);
        assert.equal(other.detail.order_id, undefined, label);
        assert.deepEqual([w.ops('create_order').length, w.ops('submit_payment').length, w.ops('create_payment_link').length], [1, 0, 0], `${label}: one order call, ever`);
        assert.equal((await w.exec('get_checkout_session', { session_id: sid })).status, 'order_outcome_unknown', label);
        assert.equal((await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cu-cxl1', session_id: sid })))?.detail?.reason, 'session_order_outcome_unknown', label);
        const updated = await w.exec('update_checkout_session', { idempotency_key: 'idem-cu-upd1', session_id: sid, quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test', shipping_address: { ...SHIP_TO } } });
        assert.deepEqual(updated.previous_session, { session_id: sid, status: 'order_outcome_unknown', order_id: null }, label);
      }
    });
  }
  test(`Q1 ${laneName}: an order call the upstream refused by a terminal name is answered as raised, a kept refusal that would say retriable is an unknown outcome, and a listed prologue refusal still gives the session back`, async () => {
    for (const raised of [
      () => transportError('OUT_OF_STOCK', { upstream_status: 409, upstream_code: 'OUT_OF_STOCK' }),
      () => transportError('PRICE_CHANGED', { upstream_status: 409, upstream_code: 'QUOTE_MISMATCH' }),
      () => transportError('QUOTE_EXPIRED', { upstream_status: 409, upstream_code: 'QUOTE_EXPIRED' }),
    ]) {
      const w = world();
      const sid = await open(w);
      const err = raised();
      w.script.create_order.push(() => { throw err; });
      assert.equal(await refusal(lane.run(w, sid, 'idem-cr-0001')), err);
      assert.equal(await w.kernel.isQuoteClaimed(sid), true);
    }
    // Answered below 500, the claim kept, and as raised it would say retriable:true while every retry is refused. A 403
    // or a 429 says what the store answered (KERNEL_ANSWERED_REFUSALS); the others keep the words they had.
    const ANSWERED = { 400: 'refused', 401: 'refused', 403: 'refused', 409: 'refused', 429: 'rate_limited' };
    for (const [status, code] of [[409, 'QUOTE_CONSUMED'], [429, 'RATE_LIMIT_EXCEEDED'], [429, 'RATE_LIMITED'], [429, null], [408, 'REQUEST_TIMEOUT'], [400, 'INVALID_REQUEST'], [403, 'MERCHANT_NOT_ACCEPTING_ORDERS'], [403, 'FORBIDDEN'], [403, null], [401, 'UNAUTHORIZED']]) {
      const w = world();
      const sid = await open(w);
      w.script.create_order.push(() => { throw transportError('MERCHANT_UNAVAILABLE', { upstream_status: status, upstream_code: code }); });
      assertUnknown(await refusal(lane.run(w, sid, 'idem-cr-0003')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `${status} ${code}`, { answered: ANSWERED[status] });
      assertUnknown(await refusal(lane.run(w, sid, 'idem-cr-0003')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `${status} ${code} same key`, { answered: ANSWERED[status] });
      assert.equal(await w.kernel.isQuoteClaimed(sid), true);
      assert.equal(w.ops('create_order').length, 1);
    }
    // A listed refusal whose release could not be written keeps the claim, and is still answered as raised (nothing
    // was ordered: it is not an unknown outcome).
    {
      const w = world();
      const sid = await open(w);
      w.kernel._quoteClaims.compareAndDelete = async () => { throw new Error('store unavailable'); };
      const listedKept = transportError('MERCHANT_UNAVAILABLE', { upstream_status: 409, upstream_code: 'PREFLIGHT_FAILED', upstream_detail: { error: 'PREFLIGHT_FAILED' } });
      w.script.create_order.push(() => { throw listedKept; });
      assert.equal(await refusal(lane.run(w, sid, 'idem-cr-0004')), listedKept);
      assert.equal(await w.kernel.isQuoteClaimed(sid), true);
    }
    const w = world();
    const sid = await open(w);
    const listed = transportError('QUOTE_REQUIRED', { upstream_status: 400, upstream_code: 'INVALID_BUYER_CONTEXT', upstream_detail: { error: 'INVALID_BUYER_CONTEXT' } });
    w.script.create_order.push(() => { throw listed; });
    assert.equal(await refusal(lane.run(w, sid, 'idem-cr-0002')), listed);
    assert.equal(await w.kernel.isQuoteClaimed(sid), false, 'released, as the claim rule says');
    await answered(lane.run(w, sid, 'idem-cr-0002'), 'the same key then orders');
    assert.equal(w.ops('create_order').length, 2);
  });
}

// ---- Q3: the store's named refusals of the order call ----------------------------------------------------------------

// "This seller is not taking orders", as the transport raises it (src/server.js throwCommerceKernelUpstreamError, with
// src/services/commerceKernelErrorMapping.js): named, terminal, its reason as the detail. `over` changes the facts.
const notAccepting = (over = {}) => transportError('MERCHANT_NOT_ACCEPTING_ORDERS', {
  operation: 'create_order', reason: 'merchant_not_accepting_orders',
  acp_detail: { reason: 'merchant_not_accepting_orders' },
  upstream_status: 403, upstream_code: 'MERCHANT_NOT_ACCEPTING_ORDERS', upstream_detail: { error: 'MERCHANT_NOT_ACCEPTING_ORDERS', message: 'placeholder', merchant_id: 'merch_A' },
  ...over,
});
for (const [laneName, lane] of Object.entries(LANES)) {
  test(`Q3 ${laneName}: a seller not taking orders (403 by name, listed) is answered as raised, terminal, in every market; the claim is given back and the same key then orders once`, async () => {
    assert.ok((REFUSED_BEFORE_ANY_ORDER[403] || []).includes('MERCHANT_NOT_ACCEPTING_ORDERS'), 'the pair is listed');
    for (const market of ['US', 'SG', 'GB', 'DE']) {
      const label = `${laneName} ${market}`;
      const w = world({ market });
      const sid = await open(w);
      const err = notAccepting();
      w.script.create_order.push(() => { throw err; });
      const first = await refusal(lane.run(w, sid, 'idem-nta-0001'));
      assert.equal(first, err, `${label}: answered as raised`);
      assert.deepEqual([first.code, first.retriable, first.detail.acp_detail.reason], ['MERCHANT_NOT_ACCEPTING_ORDERS', false, 'merchant_not_accepting_orders'], label);
      assert.match(first.message, /^This seller is not taking orders, so nothing was ordered/, label);
      assert.equal(await w.kernel.isQuoteClaimed(sid), false, `${label}: released`);
      // The same key once more is a first attempt again: the store is asked again, and this time orders.
      const again = await refusal(lane.run(w, sid, 'idem-nta-0001'));
      assert.equal(again, null, `${label}: ${again && again.code}`);
      assert.equal(w.ops('create_order').length, 2, label);
      assert.equal(w.ops('submit_payment').length + w.ops('create_payment_link').length, 1, `${label}: a payment step only for the order that was made`);
    }
  });
  test(`P2-1 ${laneName}: "nothing was ordered" only on the release rule's proof: the same name with no route detail, another route code, or a deadline mark is the unknown outcome in the store-refused words, and the claim is kept`, async () => {
    for (const [label, over] of [
      ['no route detail', { upstream_detail: undefined }],
      ['the code only in a message', { upstream_detail: { message: 'MERCHANT_NOT_ACCEPTING_ORDERS' } }],
      ['the route naming another code', { upstream_detail: { error: 'FORBIDDEN' } }],
    ]) {
      for (const market of ['US', 'SG', 'GB', 'DE']) {
        const w = world({ market });
        const sid = await open(w);
        w.script.create_order.push(() => { throw notAccepting(over); });
        const err = await refusal(lane.run(w, sid, 'idem-nta-0002'));
        assertUnknown(err, KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `${label} ${market}`, { answered: 'refused' });
        assert.equal(/nothing was ordered|not taking orders/i.test(err.message + err.recovery), false, `${label} ${market}`);
        assert.equal(await w.kernel.isQuoteClaimed(sid), true, `${label} ${market}: kept`);
        assertUnknown(await refusal(lane.run(w, sid, 'idem-nta-0002')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `${label} ${market} same key`, { answered: 'refused' });
        assert.equal(w.ops('create_order').length, 1, `${label} ${market}: one order call, ever`);
      }
    }
  });
}

test('M04 a bare createOrder (the invoke route\'s call) after a 429 or an unnamed 403: the same key sends no second order call, and says what the store answered', async () => {
  for (const [status, code, answered] of [[429, null, 'rate_limited'], [429, 'RATE_LIMITED', 'rate_limited'], [429, 'RATE_LIMIT_EXCEEDED', 'rate_limited'], [403, 'FORBIDDEN', 'refused'], [403, null, 'refused']]) {
    for (const market of ['US', 'SG', 'GB', 'DE']) {
      const label = `${status} ${code} ${market}`;
      const w = world({ market });
      const sid = await open(w);
      w.script.create_order.push(() => { throw transportError('MERCHANT_UNAVAILABLE', { operation: 'create_order', upstream_status: status, upstream_code: code }); });
      const order = { quote_id: sid, customer_email: 'buyer@example.test', shipping_address: { ...SHIP_TO, country: market } };
      assertUnknown(await refusal(w.kernel.createOrder({ idempotency_key: 'idem-bare-0001', order }, CTX)), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, label, { answered });
      assert.equal(w.ops('create_order').length, 1, label);
      // The same key, the same body: the same answer, and 0 more order calls.
      assertUnknown(await refusal(w.kernel.createOrder({ idempotency_key: 'idem-bare-0001', order }, CTX)), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `${label} same key`, { answered });
      // Another key: the session is used.
      assert.equal((await refusal(w.kernel.createOrder({ idempotency_key: 'idem-bare-0002', order }, CTX)))?.code, 'QUOTE_ALREADY_USED', label);
      assert.equal(w.ops('create_order').length, 1, `${label}: 0 more order calls`);
      assert.equal(await w.kernel.isQuoteClaimed(sid), true, label);
    }
  }
  // A deadline mark is never a refusal the store answered, whatever status rides beside it: the no-answer words.
  {
    const w = world();
    const sid = await open(w);
    w.script.create_order.push(() => { throw transportError('MERCHANT_UNAVAILABLE', { operation: 'create_order', upstream_status: 403, upstream_code: null, upstream_timeout: true }); });
    assertUnknown(await refusal(w.kernel.createOrder({ idempotency_key: 'idem-bare-0009', order: { quote_id: sid, customer_email: 'buyer@example.test', shipping_address: { ...SHIP_TO } } }, CTX)), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, 'a deadline beside a 403');
  }
  // The named 403, listed, bare: answered as raised; released, so the same key is a first attempt again.
  const w = world();
  const sid = await open(w);
  w.script.create_order.push(() => { throw notAccepting(); });
  const order = { quote_id: sid, customer_email: 'buyer@example.test', shipping_address: { ...SHIP_TO } };
  assert.equal((await refusal(w.kernel.createOrder({ idempotency_key: 'idem-bare-0003', order }, CTX)))?.code, 'MERCHANT_NOT_ACCEPTING_ORDERS');
  const again = await refusal(w.kernel.createOrder({ idempotency_key: 'idem-bare-0003', order }, CTX));
  assert.equal(again?.code, undefined);
  assert.equal(w.ops('create_order').length, 2);
});

test('P3-6 the words of an order call\'s unknown outcome, by what came back: every status below 500 the store answered (and did not release) is a refusal; no response, a deadline, a 408, a 5xx and an unreadable 2xx have no readable answer', async () => {
  const answeredOf = (detail) => ({ upstream_status: null, upstream_code: null, ...detail });
  const TABLE = [
    [{ upstream_status: 400, upstream_code: 'INVALID_REQUEST' }, 'refused'],
    [{ upstream_status: 400, upstream_code: 'INVALID_REQUEST', upstream_detail: { message: 'Insufficient inventory', items: [] } }, 'refused'],
    [{ upstream_status: 401, upstream_code: 'UNAUTHORIZED' }, 'refused'],
    [{ upstream_status: 403, upstream_code: 'FORBIDDEN' }, 'refused'],
    [{ upstream_status: 403, upstream_code: null, upstream_detail: 'Not authorized for this merchant' }, 'refused'],
    [{ upstream_status: 404, upstream_code: 'MERCHANT_NOT_FOUND' }, 'refused'],
    [{ upstream_status: 409, upstream_code: 'QUOTE_CONSUMED', upstream_detail: { error: 'QUOTE_CONSUMED' } }, 'refused'],
    [{ upstream_status: 409, upstream_code: 'CONFLICT' }, 'refused'],
    [{ upstream_status: 422, upstream_code: 'VALIDATION_ERROR' }, 'refused'],
    [{ upstream_status: 429, upstream_code: 'RATE_LIMIT_EXCEEDED' }, 'rate_limited'],
    [{ upstream_status: 429, upstream_code: null }, 'rate_limited'],
    [{ upstream_status: 408, upstream_code: 'REQUEST_TIMEOUT' }, undefined],
    [{ upstream_status: null, upstream_timeout: true }, undefined],
    [{ upstream_status: 403, upstream_timeout: true }, undefined],
    [{ upstream_status: null }, undefined],
    [{ upstream_status: null, message: 'backend_iam_rejected' }, undefined],
    [{ upstream_status: 500, upstream_code: 'INTERNAL_SERVER_ERROR' }, undefined],
    [{ upstream_status: 502 }, undefined],
    [{ upstream_status: 503, upstream_code: 'TEMPORARY_UNAVAILABLE' }, undefined],
    [{ upstream_status: 504 }, undefined],
  ];
  for (const [detail, answered] of TABLE) {
    for (const market of ['US', 'SG', 'GB', 'DE']) {
      const label = `${JSON.stringify(detail)} ${market}`;
      const w = world({ market });
      const sid = await open(w);
      w.script.create_order.push(() => { throw transportError('MERCHANT_UNAVAILABLE', { operation: 'create_order', ...answeredOf(detail) }); });
      const err = await refusal(complete(w, sid, 'idem-table-0001'));
      assertUnknown(err, KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, label, { answered });
      if (!answered) assert.match(err.recovery, /store may hold an order/, label);
      assert.equal(await w.kernel.isQuoteClaimed(sid), true, label);
    }
  }
  // An unreadable 2xx: the no-answer words.
  for (const body of [null, '', '<html>ok</html>', {}]) {
    const w = world();
    const sid = await open(w);
    w.script.create_order.push(() => body);
    assertUnknown(await refusal(complete(w, sid, 'idem-table-0002')), KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, `2xx ${JSON.stringify(body)}`);
  }
});

test('Q3 a consumed quote (409 QUOTE_CONSUMED) logs the order the store names on the claim-kept line, owner-free, and the answer never carries it', async () => {
  const lines = [];
  const w = world();
  w.kernel._log = { info() {}, warn: (event, fields) => lines.push({ event, fields }), error() {} };
  const sid = await open(w);
  w.script.create_order.push(() => { throw transportError('MERCHANT_UNAVAILABLE', { operation: 'create_order', upstream_status: 409, upstream_code: 'QUOTE_CONSUMED', upstream_detail: { error: 'QUOTE_CONSUMED', message: 'Quote already consumed', details: { order_id: 'ord_backend_77' } } }); });
  const err = await refusal(complete(w, sid, 'idem-consumed-0001'));
  assertUnknown(err, KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, 'consumed', { answered: 'refused' });
  assert.equal(JSON.stringify({ m: err.message, d: err.detail, r: err.recovery }).includes('ord_backend_77'), false, 'never in the answer');
  assert.deepEqual(lines.filter((l) => l.event === 'quote_claim_kept'), [{ event: 'quote_claim_kept', fields: { quote_id: sid, upstream_order_id: 'ord_backend_77', code: 'MERCHANT_UNAVAILABLE', reason: 'create_order_outcome_unknown' } }]);
  // Only that code, at that status, from the route's own detail, id-shaped: nothing else adds a member.
  for (const detail of [
    { upstream_status: 409, upstream_code: 'CONFLICT', upstream_detail: { error: 'QUOTE_CONSUMED', details: { order_id: 'ord_x' } } },
    { upstream_status: 400, upstream_code: 'QUOTE_CONSUMED', upstream_detail: { error: 'QUOTE_CONSUMED', details: { order_id: 'ord_x' } } },
    { upstream_status: 409, upstream_code: 'QUOTE_CONSUMED', upstream_detail: { error: 'QUOTE_CONSUMED', details: { order_id: 'not an id; x' } } },
    { upstream_status: 409, upstream_code: 'QUOTE_CONSUMED', upstream_detail: { error: 'QUOTE_CONSUMED' } },
  ]) {
    lines.length = 0;
    const w2 = world();
    w2.kernel._log = { info() {}, warn: (event, fields) => lines.push({ event, fields }), error() {} };
    const sid2 = await open(w2);
    w2.script.create_order.push(() => { throw transportError('MERCHANT_UNAVAILABLE', { operation: 'create_order', ...detail }); });
    await refusal(complete(w2, sid2, 'idem-consumed-0002'));
    assert.deepEqual(lines.filter((l) => l.event === 'quote_claim_kept').map((l) => Object.keys(l.fields).sort()), [['code', 'quote_id', 'reason']], JSON.stringify(detail));
  }
});

// ---- A.3: the order id is only ever the caller's own ----------------------------------------------------------------

test('A.3 QUOTE_ALREADY_USED and the claim state name the order only to the buyer, session and agent that made it', async () => {
  const w = world();
  const ctx = { ...CTX, agent_id: 'agent_1' };
  const sid = await open(w, { ctx });
  await complete(w, sid, 'idem-own-0001', {}, ctx);
  assert.equal((await w.kernel.quoteAlreadyUsed(sid, ctx)).detail.order_id, 'o_1');
  assert.equal((await w.kernel.quoteClaimState(sid, ctx)).order_id, 'o_1');
  assert.equal((await w.kernel.quoteClaimState(sid, { user_ref: 'buyer_1', acp_session_id: 'sess_1' })).order_id, 'o_1', 'a ctx that names no agent is the same caller');
  for (const other of [{ ...ctx, user_ref: 'buyer_2' }, { ...ctx, acp_session_id: 'sess_2' }, { ...ctx, agent_id: 'agent_2' }, null]) {
    assert.equal((await w.kernel.quoteAlreadyUsed(sid, other)).detail.order_id, undefined, JSON.stringify(other));
    if (other) assert.equal((await w.kernel.quoteClaimState(sid, other)).order_id, null, JSON.stringify(other));
  }
  // Another buyer cannot even reach the claim through the executor: the session is not theirs.
  const foreign = await refusal(complete(w, sid, 'idem-own-0002', {}, { user_ref: 'buyer_2', acp_session_id: 'sess_1' }));
  assert.equal(foreign.code, 'STATE_LINKAGE_MISMATCH');
});

test('A.3 the claim records its order on THIS attempt\'s claim only (compare-and-set on claim_id)', async () => {
  const w = world();
  const sid = await open(w);
  // While the order is being asked for, the claim is replaced by one that is not this attempt's: the order note must
  // leave it as it is.
  w.script.create_order.push(async () => {
    await w.kernel._quoteClaims.set(sid, { idempotency_key: 'older', claim_id: 'not-this-attempt' });
    return { order_id: 'o_cas', acp_state: {} };
  });
  await answered(complete(w, sid, 'idem-cas-0001'), 'cas');
  assert.deepEqual(await w.kernel._quoteClaims.get(sid), { idempotency_key: 'older', claim_id: 'not-this-attempt' });
  // And with the claim untouched, the note lands on it.
  const w2 = world();
  const sid2 = await open(w2);
  await answered(complete(w2, sid2, 'idem-cas-0002'), 'cas 2');
  assert.equal((await w2.kernel._quoteClaims.get(sid2)).order_id, 'o_1');
});

// ---- the ledger keeps the answer it gave -----------------------------------------------------------------------------

test('ledger: an ambiguous record replays only the kernel\'s own unknown answer; anything else stays the generic conflict', async () => {
  const store = new InMemoryKvStore();
  const ledger = new IdempotencyLedger({ store });
  const key = 'idem-ledger-0001';
  const runFail = (err) => ledger.run(key, { a: 1 }, async (ctx) => { ctx.sideEffectDone = true; throw err; });
  await refusal(runFail(kernelOutcomeUnknown(KERNEL_OUTCOME_UNKNOWN_REASONS.payment, 'o_7')));
  assert.deepEqual((await store.get(key)).outcome_unknown, { reason: 'payment_outcome_unknown_after_order', order_id: 'o_7' });
  assertUnknown(await refusal(ledger.run(key, { a: 1 }, async () => 'never')), 'payment_outcome_unknown_after_order', 'o_7', 'replayed');
  // A different body under the key is still a conflict.
  assert.equal((await refusal(ledger.run(key, { a: 2 }, async () => 'never'))).detail.reason, undefined);
  // A record that names a reason the kernel never gives is not replayed as one.
  await store.set(key, { ...(await store.get(key)), outcome_unknown: { reason: 'something_else', order_id: 'o_7' } });
  assert.equal((await refusal(ledger.run(key, { a: 1 }, async () => 'never'))).detail.reason, 'ambiguous_prior_attempt');
  // Another error after the side effect keeps no answer.
  const key2 = 'idem-ledger-0002';
  await refusal(ledger.run(key2, { a: 1 }, async (ctx) => { ctx.sideEffectDone = true; throw new PivotaCommerceError('MERCHANT_UNAVAILABLE'); }));
  assert.equal((await store.get(key2)).outcome_unknown, undefined);
  assert.throws(() => kernelOutcomeUnknown('made_up_reason', 'o_1'));
  // The store's refusal is kept beside the reason, and replayed with its own words; it is never in the detail.
  const key3 = 'idem-ledger-0003';
  await refusal(ledger.run(key3, { a: 1 }, async (ctx) => { ctx.sideEffectDone = true; throw kernelOutcomeUnknown(KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, { answered: 'rate_limited' }); }));
  assert.deepEqual((await store.get(key3)).outcome_unknown, { reason: 'order_create_outcome_unknown', order_id: null, answered: 'rate_limited' });
  assertUnknown(await refusal(ledger.run(key3, { a: 1 }, async () => 'never')), 'order_create_outcome_unknown', null, 'replayed refusal', { answered: 'rate_limited' });
  await store.set(key3, { ...(await store.get(key3)), outcome_unknown: { reason: 'order_create_outcome_unknown', order_id: null, answered: 'made_up' } });
  assert.equal((await refusal(ledger.run(key3, { a: 1 }, async () => 'never'))).detail.reason, 'ambiguous_prior_attempt', 'a marker the kernel never writes is not replayed');
  // Only on the order call's own unknown, with no order id.
  assert.throws(() => kernelOutcomeUnknown(KERNEL_OUTCOME_UNKNOWN_REASONS.payment, 'o_1', { answered: 'refused' }));
  assert.throws(() => kernelOutcomeUnknown(KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, 'o_1', { answered: 'refused' }));
  assert.throws(() => kernelOutcomeUnknown(KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, { answered: 'toString' }));
  assert.equal(Object.keys(kernelOutcomeUnknown(KERNEL_OUTCOME_UNKNOWN_REASONS.orderCreate, null, { answered: 'refused' })).includes('answeredRefusal'), false, 'not an enumerable member');
});

// ---- B: no address to ship to, on a tool door -------------------------------------------------------------------------

const TOOL_STEPS = Object.freeze({ update_checkout_session: /`update_checkout_session` tool/, update_checkout: /`update_checkout` tool/ });
for (const [laneName, lane] of Object.entries(LANES)) {
  for (const [tool, words] of Object.entries(TOOL_STEPS)) {
    if (laneName === 'payment_link' && tool === 'update_checkout') continue; // the UCP dialect has no payment link
    test(`B ${laneName} (${tool}): no address anywhere is refused by name before any order: no authorization presented, no claim, and the same key with an address then orders once`, async () => {
      const w = world();
      const sid = await open(w, { address: false });
      const err = await refusal(lane.run(w, sid, 'idem-noaddr-0001', { fulfillment_address_update_tool: tool }));
      assert.equal(err && err.code, 'QUOTE_REQUIRED', err && err.stack);
      assert.equal(err.retriable, false);
      assert.equal(err.detail.acp_detail.reason, 'acp_fulfillment_address_required');
      assert.deepEqual(err.detail.acp_detail.missing_fields, ['name', 'address_line1', 'city', 'postal_code', 'country']);
      assert.match(err.detail.acp_message, words);
      assert.match(err.detail.acp_message, /no order was created/);
      assert.equal(/send it with this completion request/.test(err.detail.acp_message), false, 'the tool doors have their own next step');
      if (tool === 'update_checkout') assert.equal(/with this call/.test(err.detail.acp_message), false, 'the UCP completion carries no address');
      assert.deepEqual([w.verifies(), w.ops('create_order').length], [0, 0]);
      assert.equal(await w.kernel.isQuoteClaimed(sid), false);
      const out = await lane.run(w, sid, 'idem-noaddr-0001', { fulfillment_address_update_tool: tool, shipping_address: { ...SHIP_TO } });
      assert.equal(laneName === 'complete' ? out.order.order_id : out.order_id, 'o_1');
      assert.equal(w.ops('create_order').length, 1);
    });
  }
  test(`B ${laneName}: the address locked on the session passes; a spent session is told it is spent, not that it lacks an address`, async () => {
    const w = world();
    const sid = await open(w);
    await lane.run(w, sid, 'idem-locked-0001', { fulfillment_address_update_tool: 'update_checkout_session' });
    assert.equal(w.ops('create_order').length, 1);
    const w2 = world();
    const sid2 = await open(w2, { address: false });
    await lane.run(w2, sid2, 'idem-spent-0001', { shipping_address: { ...SHIP_TO } }); // spends it (no door member)
    const err = await refusal(lane.run(w2, sid2, 'idem-spent-0002', { fulfillment_address_update_tool: 'update_checkout_session' }));
    assert.equal(err.code, 'QUOTE_ALREADY_USED');
    assert.equal(err.detail.order_id, 'o_1');
  });
  test(`B ${laneName}: without the door's member, with an unknown tool name, or on the ACP door's ctx, nothing changes`, async () => {
    for (const [extra, ctx] of [[{}, CTX], [{ fulfillment_address_update_tool: 'some_other_tool' }, CTX], [{ fulfillment_address_update_tool: '__proto__' }, CTX], [{ fulfillment_address_update_tool: 'update_checkout_session' }, { ...CTX, protocol: 'acp' }]]) {
      const w = world();
      const sid = await open(w, { address: false, ctx });
      await refusal(lane.run(w, sid, 'idem-nomember-0001', extra, ctx));
      assert.equal(w.ops('create_order').length, 1, `${JSON.stringify(extra)} ${ctx.protocol}: the order was asked for, as before`);
    }
  });
}

// ---- C: cancel with the upstream cancel off ---------------------------------------------------------------------------

test('C cancel by session id says canceled only when it is true: an unordered session is canceled by taking its claim, and is never completed or linked afterwards', async () => {
  const w = world();
  const open1 = await open(w, { key: 'idem-open-c-01' });
  const canceled = await answered(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-0001', session_id: open1 }), 'unordered');
  assert.deepEqual(canceled, { session_id: open1, order_id: null, status: 'canceled' });
  assert.deepEqual(await w.kernel._quoteClaims.get(open1), { canceled: true }, 'the claim is the cancellation\'s');
  // Canceled again: the same answer.
  assert.equal((await answered(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-0001b', session_id: open1 }), 'again')).status, 'canceled');
  // Neither a completion nor a payment link can order it now, and nothing is asked of the upstream.
  for (const [name, run] of [['complete', complete], ['payment_link', link]]) {
    for (const extra of [{}, { fulfillment_address_update_tool: 'update_checkout_session' }]) {
      const err = await refusal(run(w, open1, `idem-cxl-after-${name}-${Object.keys(extra).length}`, extra));
      assert.equal(err?.code, 'QUOTE_ALREADY_USED', `${name} ${JSON.stringify(extra)}`);
      assert.equal(err.detail.claim, 'canceled', name);
      assert.equal(err.detail.reason, 'session_canceled', name);
    }
  }
  assert.deepEqual([w.ops('create_order').length, w.verifies()], [0, 0], 'no order call, no authorization presented');
  assert.equal((await w.exec('get_checkout_session', { session_id: open1 })).status, 'canceled');
  // An ordered session: refused by that name, with the order's id, and the order is not touched.
  const open4 = await open(w, { key: 'idem-open-c-04' });
  assert.equal((await answered(complete(w, open4, 'idem-cxl-pay-1'))).order.order_id, 'o_1');
  const ordered = await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-0002', session_id: open4 }));
  assert.deepEqual(ordered?.detail, { op: 'cancel_checkout_session', reason: 'session_already_ordered', order_id: 'o_1', upstream_cancel: false });
  assert.equal((await w.kernel._orderStore.get('o_1')).status, 'charge_pending', 'the order was not touched');
  // An order call with an unknown outcome: refused as such, and the claim stays the order call's.
  const open2 = await open(w, { key: 'idem-open-c-02' });
  w.script.create_order.push(() => { throw UNKNOWN_FAILURES.deadline(); });
  await refusal(complete(w, open2, 'idem-cxl-pay-2'));
  const unknown = await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-0003', session_id: open2 }));
  assert.deepEqual(unknown?.detail, { op: 'cancel_checkout_session', reason: 'session_order_outcome_unknown', upstream_cancel: false });
  assert.equal((await w.kernel._quoteClaims.get(open2)).canceled, undefined);
  // No session and no order named: nothing to cancel, said so.
  assert.equal((await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-0005' })))?.detail?.reason, 'missing_session_id');
  // Another buyer's session is not theirs to ask about, and nothing is claimed for them.
  const open5 = await open(w, { key: 'idem-open-c-05' });
  assert.equal((await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-0006', session_id: open5 }, { user_ref: 'buyer_2', acp_session_id: 'sess_1' })))?.code, 'STATE_LINKAGE_MISMATCH');
  assert.equal(await w.kernel.isQuoteClaimed(open5), false);
  // By order id: a charge_pending order keeps its refusal.
  assert.equal((await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-0007', order_id: 'o_1' })))?.detail?.reason, 'cannot_cancel_paid_or_pending');
});

test('C cancel by order id, with the upstream cancel off, is never answered canceled: the caller\'s own unpaid order is refused by name and left as it is; an id never held, and another caller\'s order, are not found alike', async () => {
  for (const [laneName, lane] of Object.entries(LANES)) {
    for (const market of ['US', 'SG', 'GB', 'DE']) {
      const label = `${laneName} ${market}`;
      const w = world({ market });
      const ctx = { ...CTX, agent_id: 'agent_1' };
      const sid = await open(w, { ctx });
      // An order whose payment page is open (payment link), or whose payment step failed (complete).
      if (laneName === 'complete') w.script.submit_payment.push(() => ({ payment_id: 'pay_x', payment_status: 'failed' }));
      await answered(lane.run(w, sid, 'idem-cxo-0001', {}, ctx), label);
      const before = await w.kernel._orderStore.get('o_1');
      const own = await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxo-0002', order_id: 'o_1' }, ctx));
      assert.deepEqual([own?.code, own?.retriable, own?.detail], ['OPERATION_NOT_ALLOWED', false, { op: 'cancel_checkout_session', reason: 'order_cancel_not_available', order_id: 'o_1', upstream_cancel: false, order_status: before.status }], label);
      // With the session id beside it: the same.
      assert.equal((await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxo-0003', session_id: sid, order_id: 'o_1' }, ctx)))?.detail?.reason, 'order_cancel_not_available', label);
      assert.deepEqual(await w.kernel._orderStore.get('o_1'), before, `${label}: nothing was written`);
      assert.equal((await w.exec('get_checkout_session', { session_id: sid }, ctx)).order_status, before.status, label);
      // Never held, and another caller's (another buyer, another session, another agent): one not-found answer.
      const notFound = [];
      for (const [id, other] of [['o_never_held', ctx], ['o_1', { ...ctx, user_ref: 'buyer_2' }], ['o_1', { ...ctx, acp_session_id: 'sess_2' }], ['o_1', { ...ctx, agent_id: 'agent_2' }]]) {
        const err = await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxo-0004', order_id: id }, other));
        assert.deepEqual([err?.code, err?.detail?.reason], ['QUOTE_NOT_FOUND', 'order_not_found'], `${label} ${id} ${JSON.stringify(other)}`);
        notFound.push({ code: err.code, message: err.message, retriable: err.retriable, keys: Object.keys(err.detail) });
      }
      assert.ok(notFound.every((n) => JSON.stringify(n) === JSON.stringify(notFound[0])), `${label}: indistinguishable`);
      assert.deepEqual(await w.kernel._orderStore.get('o_1'), before, label);
      assert.deepEqual([w.ops('create_order').length, w.ops('create_payment_link').length + w.ops('submit_payment').length], [1, 1], `${label}: nothing more asked`);
    }
  }
  // With the upstream cancel on, the backend's answer is still the answer (unchanged).
  const w = world({ cancelUpstream: true });
  const sid = await open(w);
  await answered(link(w, sid, 'idem-cxo-on-1'));
  assert.equal((await w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxo-on-2', order_id: 'o_1' })).status, 'canceled');
  assert.deepEqual(w.cancels, ['o_1']);
});

test('C a cancellation and a completion of one session: exactly one wins, whichever order they arrive in', async () => {
  // The cancellation arrives after the completion's spent-session check and before its order call (inside the
  // authorization check): the completion's own claim is refused, and no order is asked for.
  {
    const ref = {};
    const w = world({ onVerify: async () => { ref.cancel = await w.exec('cancel_checkout_session', { idempotency_key: 'idem-race-cxl1', session_id: ref.sid }); } });
    ref.sid = await open(w);
    const err = await refusal(complete(w, ref.sid, 'idem-race-pay1'));
    assert.equal(ref.cancel?.status, 'canceled', 'the cancellation won');
    assert.equal(err?.code, 'QUOTE_ALREADY_USED');
    assert.equal(w.ops('create_order').length, 0);
  }
  // The completion's order call is in flight when the cancellation arrives: the cancellation is refused, the order is
  // made once, and the cancellation is then refused with the order's id.
  {
    const w = world();
    const sid = await open(w);
    let release;
    const held = new Promise((r) => { release = r; });
    let reached;
    const atUpstream = new Promise((r) => { reached = r; });
    w.script.create_order.push(async () => { reached(); await held; return { order_id: 'o_held', acp_state: {} }; });
    const running = complete(w, sid, 'idem-race-pay2');
    await atUpstream;
    const during = await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-race-cxl2', session_id: sid }));
    assert.equal(during?.detail?.reason, 'session_order_outcome_unknown', 'the completion holds the claim');
    release();
    assert.equal((await answered(running, 'the completion won')).order.order_id, 'o_held');
    const after = await refusal(w.exec('cancel_checkout_session', { idempotency_key: 'idem-race-cxl3', session_id: sid }));
    assert.deepEqual(after?.detail, { op: 'cancel_checkout_session', reason: 'session_already_ordered', order_id: 'o_held', upstream_cancel: false });
    assert.equal(w.ops('create_order').length, 1);
  }
  // Two at once, started together: one winner every time.
  for (let i = 0; i < 5; i += 1) {
    const w = world();
    const sid = await open(w);
    const [c, p] = await Promise.all([
      w.exec('cancel_checkout_session', { idempotency_key: `idem-race-cx-${i}`, session_id: sid }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      complete(w, sid, `idem-race-pp-${i}`).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    ]);
    assert.equal([c.ok, p.ok].filter(Boolean).length, 1, `#${i}: exactly one winner (${JSON.stringify([c.ok, p.ok])})`);
    assert.equal(w.ops('create_order').length, p.ok ? 1 : 0, `#${i}`);
  }
});

test('C with the upstream cancel on, nothing here changes: an unordered session is claimed and canceled', async () => {
  const w = world({ cancelUpstream: true });
  const sid = await open(w);
  assert.equal((await w.exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-on-01', session_id: sid })).status, 'canceled');
  assert.equal(await w.kernel.isQuoteClaimed(sid), true);
});

// ---- D: a completed session reads as one ----------------------------------------------------------------------------

test('D get_checkout_session: ready while open, completed with its order id once ordered, canceled when a cancellation holds it, and order_outcome_unknown when an order call is unanswered', async () => {
  const w = world();
  const sid = await open(w, { key: 'idem-open-d-01' });
  const before = await w.exec('get_checkout_session', { session_id: sid });
  assert.equal(before.status, 'ready_for_payment');
  assert.equal('order_id' in before, false, 'an open session reads exactly as before');
  await complete(w, sid, 'idem-d-pay-1');
  const after = await w.exec('get_checkout_session', { session_id: sid });
  assert.deepEqual([after.status, after.order_id, after.order_status, after.session_id, after.totals.total, after.currency], ['completed', 'o_1', 'charge_pending', sid, 1800, 'USD']);
  const sid2 = await open(w, { key: 'idem-open-d-02' });
  await w.kernel._quoteClaims.putIfAbsent(sid2, { canceled: true });
  assert.deepEqual([(await w.exec('get_checkout_session', { session_id: sid2 })).status], ['canceled']);
  const sid3 = await open(w, { key: 'idem-open-d-03' });
  w.script.create_order.push(() => { throw UNKNOWN_FAILURES.no_response(); });
  await refusal(complete(w, sid3, 'idem-d-pay-3'));
  const unknown = await w.exec('get_checkout_session', { session_id: sid3 });
  assert.deepEqual([unknown.status, unknown.order_id], ['order_outcome_unknown', null]);
});

test('D update_checkout_session of a completed id still builds a separate session, and says the id it was sent is already ordered', async () => {
  const w = world();
  const sid = await open(w);
  await complete(w, sid, 'idem-d-pay-4');
  const quote = { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test', shipping_address: { ...SHIP_TO } };
  const updated = await w.exec('update_checkout_session', { idempotency_key: 'idem-upd-0001', session_id: sid, quote });
  assert.notEqual(updated.session_id, sid, 'a new session, as before');
  assert.equal(updated.status, 'ready_for_payment');
  assert.deepEqual(updated.previous_session, { session_id: sid, status: 'completed', order_id: 'o_1', order_status: 'charge_pending' });
  // An open id, an unknown id, another buyer's id: no note.
  const open2 = await open(w, { key: 'idem-open-d-05' });
  assert.equal((await w.exec('update_checkout_session', { idempotency_key: 'idem-upd-0002', session_id: open2, quote })).previous_session, undefined);
  assert.equal((await w.exec('update_checkout_session', { idempotency_key: 'idem-upd-0003', session_id: 'q_unknown', quote })).previous_session, undefined);
  assert.equal((await w.exec('update_checkout_session', { idempotency_key: 'idem-upd-0004', session_id: sid, quote }, { user_ref: 'buyer_2', acp_session_id: 'sess_9' })).previous_session, undefined);
});

test('D an order the kernel holds in a status the read does not know (an expired one, one with no status) is never read as plain completed: order_status_unknown, with its id and status; every known status still reads completed', async () => {
  const { KERNEL_ORDER_STATUSES } = await import('../src/protocol/canonicalExecutor.js');
  assert.deepEqual(KERNEL_ORDER_STATUSES, ['created', 'charge_pending', 'paid', 'failed', 'canceled']);
  const quote = { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test', shipping_address: { ...SHIP_TO } };
  for (const [written, status, orderStatus] of [
    ['expired', 'order_status_unknown', 'expired'],
    [undefined, 'order_status_unknown', null],
    ['Not A Word!', 'order_status_unknown', null],
    ...KERNEL_ORDER_STATUSES.map((known) => [known, 'completed', known]),
  ]) {
    const label = String(written);
    const w = world();
    const sid = await open(w);
    await answered(complete(w, sid, 'idem-d-st-0001'), label);
    const record = await w.kernel._orderStore.get('o_1');
    const { status: _was, ...rest } = record;
    await w.kernel._orderStore.set('o_1', written === undefined ? rest : { ...rest, status: written });
    const got = await w.exec('get_checkout_session', { session_id: sid });
    assert.deepEqual([got.status, got.order_id, got.order_status], [status, 'o_1', orderStatus], label);
    const updated = await w.exec('update_checkout_session', { idempotency_key: 'idem-d-st-upd1', session_id: sid, quote });
    assert.deepEqual(updated.previous_session, { session_id: sid, status, order_id: 'o_1', order_status: orderStatus }, label);
    // Never payable again either way: another key is told the session is used.
    assert.equal((await refusal(complete(w, sid, 'idem-d-st-0002')))?.code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.ops('create_order').length, 1, label);
  }
});

// ---- the markets: no new answer states money, in any market ------------------------------------------------------------

test('every new answer, in every market, states no amount and no currency; a market with no currency is still refused by name before any quote', async () => {
  for (const market of ['US', 'SG', 'GB', 'DE']) {
    const w = world({ market });
    const sid = await w.exec('create_checkout_session', { idempotency_key: 'idem-mkt-0001', market, market_currency: CURRENCY_BY_MARKET[market], quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test' } }).then((s) => s.session_id);
    const noAddress = await refusal(complete(w, sid, 'idem-mkt-pay-1', { fulfillment_address_update_tool: 'update_checkout_session' }));
    w.script.submit_payment.push(() => { throw UNKNOWN_FAILURES.deadline(); });
    const unknown = await refusal(complete(w, sid, 'idem-mkt-pay-2', { shipping_address: { ...SHIP_TO, country: market } }));
    const other = await refusal(complete(w, sid, 'idem-mkt-pay-3', { shipping_address: { ...SHIP_TO, country: market } }));
    for (const err of [noAddress, unknown, other]) {
      const text = JSON.stringify({ message: err.message, detail: err.detail });
      assert.equal(/USD|SGD|GBP|EUR|1800|18\.00/.test(text), false, `${market} ${err.code}: ${text}`);
    }
    assert.deepEqual([noAddress.code, unknown.code, other.code], ['QUOTE_REQUIRED', 'CHECKOUT_OUTCOME_UNKNOWN', 'QUOTE_ALREADY_USED'], market);
  }
  for (const market of ['ZZ']) {
    const w = world();
    const err = await refusal(w.exec('create_checkout_session', { idempotency_key: 'idem-mkt-0002', market, quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test' } }));
    assert.equal(err.detail.reason, 'market_not_priced');
    assert.equal(w.ops('preview_quote').length, 0);
  }
});
