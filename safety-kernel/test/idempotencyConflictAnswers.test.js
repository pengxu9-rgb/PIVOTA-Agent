// A KEY THAT CANNOT RUN THIS REQUEST NOW IS NEVER TOLD TO START AGAIN.
//
// IDEMPOTENCY_CONFLICT is answered for a missing or reused key, and for a key whose attempt is still running, was taken
// over, or may have taken effect, and for an order whose payment was already asked for. Each says what is true there
// (errors.js IDEMPOTENCY_CONFLICT_ANSWERS, and the catalog's own words for the rest); none says "Starting fresh", which an
// agent obeys by opening a second checkout while the first may have placed an order.
//
// And the bare submit_payment (the invoke route's call): after `charge_pending` is written, a 5xx, a page from in front of
// the backend, a timeout or a raw transport error is the unknown outcome with the order id, not a retriable
// "temporarily unreachable"; the same key is told the same with nothing sent; another key is told the payment was already
// asked for, with the order id. Every name is a placeholder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CATALOG, IDEMPOTENCY_CONFLICT_ANSWERS, KERNEL_ANSWERED_AFTER_ORDER, PivotaCommerceError, idempotencyConflict } from '../src/errors.js';
import { IdempotencyLedger } from '../src/idempotencyLedger.js';
import { InMemoryKvStore } from '../src/stores.js';
import { SafetyKernel } from '../src/kernel.js';
import { NO_EFFECT } from '../test-support/noEffectWords.js';

const START_AGAIN = /start(?:ing)? (?:fresh|over|again)|different request reusing an old reference/i;
const CTX = Object.freeze({ user_ref: 'buyer_1', acp_session_id: 'sess_1' });
const QUOTE = Object.freeze({ merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test', shipping_address: { name: 'Buyer One', address_line1: '1 Example Road', city: 'Exampleton', postal_code: '00001', country: 'US' } });

function assertConflict(err, reason, label, { orderId } = {}) {
  const words = IDEMPOTENCY_CONFLICT_ANSWERS[reason];
  assert.ok(err instanceof PivotaCommerceError, `${label}: ${err}`);
  assert.deepEqual([err.code, err.retriable, err.detail.reason, err.detail.acp_message], ['IDEMPOTENCY_CONFLICT', false, reason, words.message], label);
  assert.deepEqual(err.detail.acp_detail, orderId ? { reason, order_id: orderId } : { reason }, label);
  assert.doesNotMatch(`${words.message} ${words.recovery}`, START_AGAIN, label);
  assert.doesNotMatch(`${words.message} ${words.recovery}`, NO_EFFECT, label);
}

test('the words: the catalog and every named conflict answer say nothing of starting again, and say nothing had no effect', () => {
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    assert.doesNotMatch(`${entry.userMessage} ${entry.recovery}`, START_AGAIN, code);
  }
  const generic = ERROR_CATALOG.IDEMPOTENCY_CONFLICT;
  assert.match(generic.userMessage, /missing or too short, or an earlier request with other details already used it/);
  assert.match(generic.userMessage, /do not start another checkout for this purchase without the buyer/);
  assert.doesNotMatch(`${generic.userMessage} ${generic.recovery}`, NO_EFFECT);
  for (const [reason, words] of Object.entries(IDEMPOTENCY_CONFLICT_ANSWERS)) {
    assert.match(words.message, /get_order|checkout session or its order/, reason);
    assert.doesNotMatch(`${words.message} ${words.recovery}`, START_AGAIN, reason);
    assert.doesNotMatch(`${words.message} ${words.recovery}`, NO_EFFECT, reason);
  }
  assert.match(IDEMPOTENCY_CONFLICT_ANSWERS.in_flight.message, /still running, and its outcome is not known yet/);
  assert.match(IDEMPOTENCY_CONFLICT_ANSWERS.charge_pending.message, /\(detail\.order_id\) was already asked for, and its outcome is not known yet/);
  // An answer that names the order is given only the caller's own order id; one that does not never carries it.
  assert.throws(() => idempotencyConflict('charge_pending', { order_id: 'o_1' }), /names the caller's own order/);
  assert.deepEqual(idempotencyConflict('charge_in_progress', { order_id: 'o_1' }, { ownedOrderId: 'o_1' }).detail.acp_detail, { reason: 'charge_in_progress' });
  assert.throws(() => idempotencyConflict('no_such_reason'), /Unknown idempotency conflict reason/);
});

test('the ledger: a same-key resend while the first attempt is still running, a key held a moment ago, and a key taken over after the op each get their own words; the op runs once', async () => {
  const ledger = new IdempotencyLedger();
  let release;
  let runs = 0;
  const held = new Promise((r) => { release = r; });
  const first = ledger.run('idem-flight-0001', { a: 1 }, async () => { runs += 1; await held; return { order_id: 'o_1' }; });
  const second = await ledger.run('idem-flight-0001', { a: 1 }, async () => { runs += 1; return {}; }).then(() => null, (e) => e);
  assertConflict(second, 'in_flight', 'in flight');
  release();
  assert.deepEqual((await first).result, { order_id: 'o_1' });
  assert.equal(runs, 1);
  const replay = await ledger.run('idem-flight-0001', { a: 1 }, async () => { runs += 1; return {}; });
  assert.deepEqual([replay.replayed, replay.result, runs], [true, { order_id: 'o_1' }, 1], 'the first attempt\'s answer, once it finished');

  // The claim lost, then nothing there: the attempt that held it ended a moment ago.
  const gone = new IdempotencyLedger({ store: { putIfAbsent: async () => false, get: async () => null } });
  assertConflict(await gone.run('idem-race-00001', {}, async () => ({})).then(() => null, (e) => e), 'race', 'race');

  // The op ran, and another attempt took the key over before it finished.
  const store = new InMemoryKvStore();
  store.compareAndSet = async () => false;
  let ran = 0;
  const lost = await new IdempotencyLedger({ store }).run('idem-lease-0001', {}, async () => { ran += 1; return {}; }).then(() => null, (e) => e);
  assertConflict(lost, 'lease_lost_after_op', 'lease lost');
  assert.equal(ran, 1);

  // A key reused for a request with other details keeps the catalog's words, which are true there.
  const reused = await ledger.run('idem-flight-0001', { a: 2 }, async () => ({})).then(() => null, (e) => e);
  assert.deepEqual([reused.code, reused.detail.reason, reused.userMessage], ['IDEMPOTENCY_CONFLICT', undefined, ERROR_CATALOG.IDEMPOTENCY_CONFLICT.userMessage]);
});

/** A kernel whose upstream answers submit_payment with `make()` once (null: a payment page); every other call succeeds. */
function world(make) {
  const calls = [];
  let failed = false;
  const upstream = async (op) => {
    calls.push(op);
    if (op === 'preview_quote') return { quote_id: 'bq_1', currency: 'USD', merchant_of_record: 'merch_A', locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [{ product_id: 'p1', quantity: 1 }] };
    if (op === 'create_order') return { order_id: 'o_1', acp_state: {} };
    if (op === 'submit_payment') {
      if (make && !failed) { failed = true; throw make(); }
      return { payment_id: 'pay_1', payment_status: 'succeeded' };
    }
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: 'conflict-secret-0123456789abcdef', log: { info() {}, warn() {}, error() {} } });
  return { kernel, calls };
}
async function ordered(w) {
  const q = await w.kernel.previewQuote({ quote: QUOTE }, CTX);
  const o = await w.kernel.createOrder({ idempotency_key: 'idem-cf-order-01', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  // One confirmation per key: a resend with the same key is the same request (another token is another body). A key
  // sent after the order can no longer be confirmed reuses the last token, as a caller holding only that one would.
  const tokens = new Map();
  let last = null;
  const pay = async (key) => {
    if (!tokens.has(key)) {
      last = await w.kernel.mintConfirmation({ order_id: o.order_id }, CTX).catch(() => last);
      tokens.set(key, last);
    }
    return w.kernel.submitPayment({ idempotency_key: key, confirmation_token: tokens.get(key), payment: { order_id: o.order_id, expected_amount: 1800, currency: 'USD' } }, CTX).then((r) => r, (e) => e);
  };
  return { orderId: o.order_id, pay };
}

test('the bare submit_payment: a 500, a 502 page, a timeout and a raw transport error after charge_pending are the unknown outcome with the order id, not retriable; the same key is told the same with nothing sent; another key is told the payment was already asked for', async () => {
  const transport = (status, extra = {}) => () => new PivotaCommerceError('MERCHANT_UNAVAILABLE', { operation: 'submit_payment', upstream_status: status, ...extra });
  const cases = {
    500: transport(500),
    '502 page': transport(502, { upstream_code: null }),
    timeout: transport(null, { upstream_timeout: true }),
    'no answer': transport(undefined),
    'raw error': () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  };
  for (const [label, make] of Object.entries(cases)) {
    const w = world(make);
    const { orderId, pay } = await ordered(w);
    const first = await pay('idem-cf-pay-0001');
    assert.ok(first instanceof PivotaCommerceError, `${label}: ${first?.message}`);
    assert.deepEqual([first.code, first.retriable, first.detail], ['CHECKOUT_OUTCOME_UNKNOWN', false, { reason: 'payment_outcome_unknown_after_order', order_id: orderId }], `${label}: ${first.message}`);
    assert.notEqual(first.message, KERNEL_ANSWERED_AFTER_ORDER.payment_outcome_unknown_after_order.message, `${label}: no answer came back, so not the refused words`);
    assert.match(first.recovery, /read the order in detail\.order_id with get_order before anything else/, label);
    assert.equal((await w.kernel._orderStore.get(orderId)).status, 'charge_pending', label);
    // The same key: the same answer, and the payment step is not asked again.
    const same = await pay('idem-cf-pay-0001');
    assert.deepEqual([same.code, same.message, same.detail], [first.code, first.message, first.detail], `${label} same key`);
    // Another key: refused before anything is sent, in words that name the order and say its payment was asked for.
    const other = await pay('idem-cf-pay-0002');
    assertConflict(other, 'charge_pending', `${label} another key`, { orderId });
    assert.equal(w.calls.filter((c) => c === 'submit_payment').length, 1, `${label}: one payment call`);
  }
});

test('the bare submit_payment: a paid order is told it is paid, with its id; an order whose payment lock another request holds is told so, without one', async () => {
  const w = world(null);
  const { orderId, pay } = await ordered(w);
  const paid = await pay('idem-cf-paid-0001');
  assert.equal(paid.payment_status, 'succeeded');
  assertConflict(await pay('idem-cf-paid-0002'), 'order_already_paid', 'paid', { orderId });

  const w2 = world(null);
  const second = await ordered(w2);
  await w2.kernel._orderStore.putIfAbsent(`charge-lock:${second.orderId}`, { owner: 'another' }, { ttlMs: 60_000 });
  assertConflict(await second.pay('idem-cf-lock-0001'), 'charge_in_progress', 'locked');
  assert.equal(w2.calls.filter((c) => c === 'submit_payment').length, 0);
});

// ---- the ownership check comes before the order's payment state -------------------------------------------------
//
// `charge_pending` and `order_already_paid` name the order and its payment state, so they are given only to the order's
// own caller: `_requireOrder` (user, then session, then agent) runs before the status is read. Another user, the same
// buyer in another session, or another agent, sending that order id with a new key, is refused as a linkage mismatch:
// no order id, no payment state, nothing sent.

import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { invokeErrorOf } from '../src/contractValidation.js';

const OWNER = Object.freeze({ user_ref: 'buyer_1', acp_session_id: 'sess_1', agent_id: 'agent_A' });
const STRANGERS = Object.freeze({
  'another user': { user_ref: 'buyer_2', acp_session_id: 'sess_1', agent_id: 'agent_A' },
  'the same buyer in another session': { user_ref: 'buyer_1', acp_session_id: 'sess_2', agent_id: 'agent_A' },
  'the same buyer through another agent': { user_ref: 'buyer_1', acp_session_id: 'sess_1', agent_id: 'agent_B' },
});
const PAYMENT_STATE = /charge_pending|order_already_paid|already paid|was already asked for|payment step|payment_status/i;

/** Every surfaced form of an answer: the error, its invoke body. Neither may carry the order id or its payment state. */
function assertRevealsNothing(err, orderId, label) {
  assert.ok(err instanceof PivotaCommerceError, `${label}: ${err && err.message}`);
  assert.equal(err.code, 'STATE_LINKAGE_MISMATCH', `${label}: ${err.code} ${err.message}`);
  assert.equal(err.message, ERROR_CATALOG.STATE_LINKAGE_MISMATCH.userMessage, label);
  assert.equal(err.detail.acp_detail, undefined, `${label}: nothing curated to surface`);
  assert.equal(err.detail.acp_message, undefined, label);
  const body = JSON.stringify(invokeErrorOf(err));
  assert.equal(body.includes(orderId), false, `${label}: ${body}`);
  assert.doesNotMatch(body, PAYMENT_STATE, `${label}: ${body}`);
  assert.equal(JSON.stringify(err.toResult()).includes(orderId), false, label);
}

test('the bare submit_payment: after the order is charge_pending, and after it is paid, another user, the same buyer in another session and another agent get a linkage mismatch with no order id and no payment state; nothing is sent', async () => {
  const transport500 = () => new PivotaCommerceError('MERCHANT_UNAVAILABLE', { operation: 'submit_payment', upstream_status: 500 });
  for (const [state, make] of [['charge_pending', transport500], ['paid', null]]) {
    const w = world(make);
    const q = await w.kernel.previewQuote({ quote: QUOTE }, OWNER);
    const o = await w.kernel.createOrder({ idempotency_key: 'idem-own-order-01', order: { quote_id: q.quote_id, shipping_address: {} } }, OWNER);
    const token = await w.kernel.mintConfirmation({ order_id: o.order_id }, OWNER);
    const pay = (key, ctx, t = token) => w.kernel.submitPayment({ idempotency_key: key, confirmation_token: t, payment: { order_id: o.order_id, expected_amount: 1800, currency: 'USD' } }, ctx).then((r) => r, (e) => e);
    await pay('idem-own-pay-0001', OWNER);
    assert.equal((await w.kernel._orderStore.get(o.order_id)).status, state, state);
    const sentBefore = w.calls.length;
    let n = 0;
    for (const [who, ctx] of Object.entries(STRANGERS)) {
      for (const [tk, t] of [['the owner\'s token', token], ['a garbage token', 'cft_placeholder']]) {
        n += 1;
        assertRevealsNothing(await pay(`idem-stranger-${String(n).padStart(4, '0')}`, ctx, t), o.order_id, `${state}: ${who}, ${tk}`);
      }
    }
    assert.equal(w.calls.length, sentBefore, `${state}: nothing sent for any stranger`);
    // The owner, with a new key, is still told what is true of its own order, with its id.
    const own = await pay('idem-own-pay-0002', OWNER, await w.kernel.mintConfirmation({ order_id: o.order_id }, OWNER).catch(() => token));
    assertConflict(own, state === 'paid' ? 'order_already_paid' : 'charge_pending', `${state}: the owner`, { orderId: o.order_id });
  }
});

test('the tool-door lanes (complete, payment link, session read): after the order is charge_pending, and after it is paid, another user, the same buyer in another session and another agent learn nothing of the order', async () => {
  for (const state of ['charge_pending', 'paid']) {
    const calls = [];
    let failPage = state === 'charge_pending';
    const upstream = async (op) => {
      calls.push(op);
      if (op === 'preview_quote') return { quote_id: 'bq_1', currency: 'USD', merchant_of_record: 'merch_A', locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [{ product_id: 'p1', quantity: 1 }] };
      if (op === 'create_order') return { order_id: 'o_1', acp_state: {} };
      if (op === 'submit_payment') {
        if (failPage) { failPage = false; throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { operation: 'submit_payment', upstream_status: 500 }); }
        return { payment_id: 'pay_1', payment_status: 'succeeded' };
      }
      return {};
    };
    const kernel = new SafetyKernel({ upstream, secret: 'linkage-secret-0123456789abcdef', log: { info() {}, warn() {}, error() {} } });
    const executor = createCanonicalExecutor({
      kernel, upstream, hostedLinkEnabled: true,
      verifyPaymentAuthorization: async (_a, b) => ({ ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }),
    });
    const sid = (await executor.execute('create_checkout_session', { idempotency_key: 'idem-own-open-01', quote: QUOTE }, OWNER)).session_id;
    await executor.execute('complete_checkout_session', { idempotency_key: 'idem-own-done-01', session_id: sid, payment_authorization: { token: 'grant_placeholder' } }, OWNER).catch((e) => e);
    assert.equal((await kernel._orderStore.get('o_1')).status, state, state);
    const sentBefore = calls.length;
    let n = 0;
    for (const [who, ctx] of Object.entries(STRANGERS)) {
      for (const [tool, args] of [
        ['complete_checkout_session', (k) => ({ idempotency_key: k, session_id: sid, payment_authorization: { token: 'grant_placeholder' } })],
        ['create_payment_link', (k) => ({ idempotency_key: k, session_id: sid, customer_email: 'buyer@example.test' })],
        ['get_checkout_session', () => ({ session_id: sid })],
      ]) {
        n += 1;
        const label = `${state}: ${who}, ${tool}`;
        const err = await executor.execute(tool, args(`idem-stranger-tool-${String(n).padStart(3, '0')}`), ctx).then((r) => ({ notRefused: r }), (e) => e);
        // Another agent in the buyer's own session may read that session (sessions are bound to the buyer and the
        // session, not the agent), but not the order: no id, and the claim's state hidden behind `order_outcome_unknown`
        // whatever the order's real payment state.
        if (who === 'the same buyer through another agent' && tool === 'get_checkout_session') {
          const read = err.notRefused;
          assert.ok(read, `${label}: ${JSON.stringify(err).slice(0, 300)}`);
          assert.deepEqual([read.order_id, read.status], [null, 'order_outcome_unknown'], `${label}: ${JSON.stringify(read).slice(0, 300)}`);
          assert.equal(JSON.stringify(read).includes('o_1'), false, label);
          assert.doesNotMatch(JSON.stringify(read), PAYMENT_STATE, label);
          continue;
        }
        assert.ok(err instanceof PivotaCommerceError, `${label}: ${JSON.stringify(err).slice(0, 300)}`);
        // Another user or session: the linkage mismatch. Another agent in the buyer's own session: that session is spent
        // (QUOTE_ALREADY_USED), and the order it made is not named to that agent.
        assert.equal(['STATE_LINKAGE_MISMATCH', 'QUOTE_ALREADY_USED'].includes(err.code), true, `${label}: ${err.code} ${err.message}`);
        if (who !== 'the same buyer through another agent') assert.equal(err.code, 'STATE_LINKAGE_MISMATCH', label);
        assert.equal(err.detail.order_id, undefined, `${label}: ${JSON.stringify(err.detail)}`);
        assert.equal(err.detail.acp_detail?.order_id, undefined, label);
        const body = JSON.stringify(invokeErrorOf(err));
        assert.equal(body.includes('o_1'), false, `${label}: ${body}`);
        assert.doesNotMatch(body, PAYMENT_STATE, `${label}: ${body}`);
      }
    }
    assert.equal(calls.length, sentBefore, `${state}: nothing sent for any stranger`);
  }
});
