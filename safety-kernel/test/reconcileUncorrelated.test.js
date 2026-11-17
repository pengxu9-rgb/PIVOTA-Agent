// The charge_pending reconcile for rows the webhook cannot settle (payment_id null after an unknown charge outcome).
// safety-kernel/src/reconcileUncorrelated.js + kernel.settleUncorrelatedCharge + the stores' compareAndSetFields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel, RECONCILE_SETTLER } from '../src/kernel.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { InMemoryKvStore, fieldsMatch } from '../src/stores.js';
import { PostgresKvStore } from '../src/stores/postgresKvStore.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';
import {
  reconcileUncorrelatedChargePending, decideSettlement, projectBackendOrder, normalizeConfig,
  makeInMemoryListCandidates, makePostgresListCandidates, makeStoreLease, makeStoreCursor, RECONCILE_DEFAULTS,
  RECONCILE_SETTLER_NAME, PENDING_SQL, EXPIRED_SQL,
} from '../src/reconcileUncorrelated.js';

const SECRET = 'reconcile-uncorrelated-secret-0123456789';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [], acp_state: { acp_session_id: 'acp_1' },
};
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const quiet = { info() {}, warn() {}, error() {} };

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

// A kernel with ONE order left exactly as an unknown charge outcome leaves it: charge_pending, payment_id null.
// `submit` decides what the charge call does: 'throw' (the outcome is unknown), or a deferred the test resolves.
async function stuckKernel({ orderId = 'o_stuck', clock = makeClock(), submit = 'throw', lane = 'upstream' } = {}) {
  let resolveSubmit;
  let chargeCalled;
  const deferred = new Promise((r) => { resolveSubmit = r; });
  const charging = new Promise((r) => { chargeCalled = r; });
  const calls = [];
  const upstream = async (op) => {
    calls.push(op);
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') return { order_id: orderId, acp_state: {} };
    if (op === 'submit_payment') {
      chargeCalled();
      if (submit === 'throw') throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' });
      return deferred;
    }
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, now: clock.now, log: quiet });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: `idem-${orderId}-order`, order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const token = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  // The delegated-token lane charges through an injected dispatcher instead of the upstream submit_payment.
  const opts = lane === 'dispatch' ? { dispatch: async () => { calls.push('dispatch'); throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }); } } : {};
  const pay = kernel.submitPayment({ idempotency_key: `idem-${orderId}-pay`, confirmation_token: token, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX, opts);
  let paySettled;
  if (submit === 'throw' || lane === 'dispatch') await assert.rejects(pay);
  else { paySettled = pay.then((v) => ({ ok: v }), (e) => ({ err: e })); await charging; }
  const row = await kernel._orderStore.get(o.order_id);
  assert.equal(row.status, 'charge_pending');
  assert.equal(row.payment_id, null);
  return { kernel, clock, order_id: o.order_id, calls, resolveSubmit, paySettled, store: kernel._orderStore };
}

// The backend's GET /agent/v2/orders/{id} body (routes/agent_v2.py _order_response_from_row). The kernel order above is
// 113 minor USD at merch_A; the backend records the same money as a MAJOR-unit decimal string.
function backendOrder(orderId, { state = 'awaiting_checkout', payment_status = 'awaiting_payment', surface = null, total = '1.13', currency = 'USD', merchant_id = 'merch_A' } = {}) {
  return {
    status: 200,
    body: {
      status: 'success',
      order: {
        order_id: orderId, merchant_id, state, payment_status,
        amounts: { subtotal: '1.00', discount_total: '0.00', shipping_fee: '0.05', tax: '0.08', total, currency },
        payment_summary: { psp: 'stripe', payment_intent_id: surface, client_secret: surface ? 'secret_must_not_leak' : null },
        buyer_context: { customer_email: 'buyer@example.test' },
      },
    },
  };
}

function captureLog() {
  const lines = [];
  return { lines, info: (f) => lines.push({ level: 'info', ...f }), warn: (f) => lines.push({ level: 'warn', ...f }) };
}

async function run(env, overrides = {}) {
  const listCandidates = overrides.listCandidates || makeInMemoryListCandidates(env.store);
  return reconcileUncorrelatedChargePending({
    kernel: env.kernel,
    listCandidates,
    now: env.clock.now,
    sleep: env.clock.sleep,
    log: overrides.log || quiet,
    mode: 'apply',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// compareAndSetFields: both stores, one rule.
// ---------------------------------------------------------------------------------------------------------------

test('fieldsMatch: null matches null or absent; values compare as strings; an empty expectation matches nothing', () => {
  assert.equal(fieldsMatch({ a: null }, { a: null }), true);
  assert.equal(fieldsMatch({}, { a: null }), true);
  assert.equal(fieldsMatch({ a: '' }, { a: null }), false);
  assert.equal(fieldsMatch({ a: 0 }, { a: null }), false);
  assert.equal(fieldsMatch({ a: 5 }, { a: '5' }), true);
  assert.equal(fieldsMatch({ a: 5 }, { a: 6 }), false);
  assert.equal(fieldsMatch({}, { a: 'x' }), false);
  assert.equal(fieldsMatch({ a: 1 }, {}), false);
  assert.equal(fieldsMatch({ a: 1 }, null), false);
});

for (const [name, makeStore] of [
  ['InMemoryKvStore', (now) => new InMemoryKvStore({ now })],
  ['PostgresKvStore (fake db)', (now) => new PostgresKvStore({ db: makeFakePgDb(now), namespace: 'orders', now })],
]) {
  test(`${name}.compareAndSetFields sets only when every field matches`, async () => {
    const clock = makeClock();
    const store = makeStore(clock.now);
    await store.set('o1', { status: 'charge_pending', attempt: 'k1', charge_pending_at: 123, payment_id: null });
    const expected = { status: 'charge_pending', attempt: 'k1', charge_pending_at: 123, payment_id: null };
    assert.equal(await store.compareAndSetFields('o1', { ...expected, attempt: 'k2' }, { status: 'x' }), false);
    assert.equal(await store.compareAndSetFields('o1', { ...expected, charge_pending_at: 124 }, { status: 'x' }), false);
    assert.equal(await store.compareAndSetFields('o1', { ...expected, payment_id: 'pi_1' }, { status: 'x' }), false);
    assert.equal(await store.compareAndSetFields('o1', {}, { status: 'x' }), false);
    assert.equal(await store.compareAndSetFields('nope', expected, { status: 'x' }), false);
    assert.equal((await store.get('o1')).status, 'charge_pending');
    assert.equal(await store.compareAndSetFields('o1', expected, { status: 'paid' }), true);
    assert.equal((await store.get('o1')).status, 'paid');
    // The same CAS again sees the new row and loses.
    assert.equal(await store.compareAndSetFields('o1', expected, { status: 'expired' }), false);
    assert.equal((await store.get('o1')).status, 'paid');
  });

  test(`${name}.compareAndSetFields never sets an expired (TTL-lapsed) record`, async () => {
    const clock = makeClock();
    const store = makeStore(clock.now);
    await store.set('t1', { status: 'charge_pending', payment_id: null }, { ttlMs: 1000 });
    clock.advance(1001);
    assert.equal(await store.compareAndSetFields('t1', { status: 'charge_pending', payment_id: null }, { status: 'paid' }), false);
  });

  test(`${name}.compareAndSetFields: an absent field matches a null expectation, a stamped one does not`, async () => {
    const clock = makeClock();
    const store = makeStore(clock.now);
    await store.set('o2', { status: 'charge_pending' });
    assert.equal(await store.compareAndSetFields('o2', { status: 'charge_pending', payment_id: null }, { status: 'expired' }), true);
    await store.set('o3', { status: 'charge_pending', payment_id: 'pi_9' });
    assert.equal(await store.compareAndSetFields('o3', { status: 'charge_pending', payment_id: null }, { status: 'expired' }), false);
  });
}

test('PostgresKvStore.compareAndSetFields refuses an empty or malformed expectation without asking the database', async () => {
  let queries = 0;
  const db = { query: async () => { queries += 1; return { rows: [{ k: 'o1' }] }; } };
  const store = new PostgresKvStore({ db, namespace: 'orders', now: () => 1000 });
  assert.equal(await store.compareAndSetFields('o1', {}, { status: 'paid' }), false);
  assert.equal(await store.compareAndSetFields('o1', null, { status: 'paid' }), false);
  assert.equal(await store.compareAndSetFields('o1', { '': 'x' }, { status: 'paid' }), false);
  assert.equal(queries, 0);
});

test('PostgresKvStore.compareAndSetFields sends one conditional UPDATE with typed text params', async () => {
  const seen = [];
  const db = { query: async (text, params) => { seen.push({ text, params }); return { rows: [] }; } };
  const store = new PostgresKvStore({ db, namespace: 'orders', now: () => 1000 });
  await store.compareAndSetFields('o1', { status: 'charge_pending', payment_id: null, charge_pending_at: 7 }, { status: 'paid' });
  assert.equal(seen.length, 1);
  const t = seen[0].text.replace(/\s+/g, ' ');
  assert.match(t, /^UPDATE commerce_kv SET v = \$3, expires_at = \$4 WHERE ns = \$1 AND k = \$2 AND \(expires_at IS NULL OR expires_at > to_timestamp\(\$5\)\) AND /);
  assert.equal(seen[0].params[4], 1, 'the liveness clock is the store clock, in seconds');
  assert.match(t, /\(v ->> \$6::text\) IS NOT DISTINCT FROM \$7::text AND \(v ->> \$8::text\) IS NOT DISTINCT FROM \$9::text AND \(v ->> \$10::text\) IS NOT DISTINCT FROM \$11::text RETURNING k$/);
  assert.deepEqual(seen[0].params.slice(5), ['status', 'charge_pending', 'payment_id', null, 'charge_pending_at', '7']);
});

// ---------------------------------------------------------------------------------------------------------------
// kernel.settleUncorrelatedCharge: every transition, and every way it refuses.
// ---------------------------------------------------------------------------------------------------------------

async function observedOf(store, order_id) {
  const r = await store.get(order_id);
  return { status: r.status, attempt: r.attempt, charge_pending_at: r.charge_pending_at, settled_at: r.settled_at };
}

test('settle: charge_pending (no payment id) -> paid, stamped, and the charge lock is cleared', async () => {
  const env = await stuckKernel();
  await env.store.set(`charge-lock:${env.order_id}`, { owner: 'stale' });
  const observed = await observedOf(env.store, env.order_id);
  const r = await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'paid', reason: 'backend_paid' });
  assert.deepEqual(r, { transitioned: 'paid' });
  const row = await env.store.get(env.order_id);
  assert.equal(row.status, 'paid');
  assert.equal(row.settled_by, RECONCILE_SETTLER);
  assert.equal(row.settled_from, 'charge_pending');
  assert.equal(row.settled_reason, 'backend_paid');
  assert.equal(row.settled_at, env.clock.now());
  assert.equal(row.amount, 113, 'the rest of the order is kept');
  assert.equal(await env.store.get(`charge-lock:${env.order_id}`), undefined);
  // A late correlated webhook for a paid order is idempotent.
  assert.deepEqual(await env.kernel.onPaymentWebhook({ order_id: env.order_id, status: 'succeeded', payment_id: 'pi_x' }), { idempotent: true, reason: 'already_paid' });
});

test('settle: charge_pending -> expired, and an expired order can be neither confirmed nor charged', async () => {
  const env = await stuckKernel();
  const r = await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed: await observedOf(env.store, env.order_id), to: 'expired', reason: 'backend_order_cancelled' });
  assert.deepEqual(r, { transitioned: 'expired' });
  assert.equal((await env.store.get(env.order_id)).status, 'expired');
  await assert.rejects(env.kernel.mintConfirmation({ order_id: env.order_id }, CTX), (e) => e.detail?.reason === 'not_confirmable:expired');
  const charges = env.calls.filter((c) => c === 'submit_payment').length;
  // Even with a token minted before the expiry, submit refuses an expired order and sends nothing upstream.
  await assert.rejects(
    env.kernel.submitPayment({ idempotency_key: 'idem-after-expire', confirmation_token: 'x', payment: { order_id: env.order_id, expected_amount: 113, currency: 'USD' } }, CTX),
    (e) => e.detail?.reason === 'not_payable:expired',
  );
  assert.equal(env.calls.filter((c) => c === 'submit_payment').length, charges, 'no second charge call');
  // A webhook for it is ignored (it cannot correlate, and the row is no longer pending).
  assert.equal((await env.kernel.onPaymentWebhook({ order_id: env.order_id, status: 'succeeded', payment_id: 'pi_x' })).ignored, true);
});

test('settle: expired (by this reconcile) -> paid; expired -> expired is refused', async () => {
  const env = await stuckKernel();
  await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed: await observedOf(env.store, env.order_id), to: 'expired', reason: 'session_lapsed_no_payment_surface' });
  const observed = await observedOf(env.store, env.order_id);
  assert.equal(observed.status, 'expired');
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'expired', reason: 'r' }), { ignored: true, reason: 'not_settleable:expired' });
  env.clock.advance(MIN);
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'paid', reason: 'backend_paid' }), { transitioned: 'paid' });
  const row = await env.store.get(env.order_id);
  assert.equal(row.status, 'paid');
  assert.equal(row.settled_from, 'expired');
});

test('settle: an expired row this reconcile did not write is never moved', async () => {
  const env = await stuckKernel();
  const row = await env.store.get(env.order_id);
  await env.store.set(env.order_id, { ...row, status: 'expired', settled_at: 5 }); // no settled_by
  assert.deepEqual(
    await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed: { status: 'expired', settled_at: 5 }, to: 'paid', reason: 'r' }),
    { ignored: true, reason: 'row_changed' },
  );
  assert.equal((await env.store.get(env.order_id)).status, 'expired');
});

for (const [what, mutate] of [
  ['the late submit stamped a payment id', (r) => ({ ...r, payment_id: 'pi_late' })],
  ['another attempt owns the row', (r) => ({ ...r, attempt: 'other-attempt' })],
  ['the row was re-stamped charge_pending', (r) => ({ ...r, charge_pending_at: r.charge_pending_at + 1 })],
  ['a webhook or repair marked it paid', (r) => ({ ...r, status: 'paid' })],
  ['it was cancelled', (r) => ({ ...r, status: 'canceled' })],
  ['it failed', (r) => ({ ...r, status: 'failed' })],
]) {
  test(`settle loses (row_changed, no write) when ${what} after the reconcile observed it`, async () => {
    const env = await stuckKernel();
    const observed = await observedOf(env.store, env.order_id);
    const changed = mutate(await env.store.get(env.order_id));
    await env.store.set(env.order_id, changed);
    for (const to of ['paid', 'expired']) {
      assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to, reason: 'r' }), { ignored: true, reason: 'row_changed' });
    }
    assert.deepEqual(await env.store.get(env.order_id), changed);
  });
}

test('settle refuses what it was not built for, writing nothing', async () => {
  const env = await stuckKernel();
  const before = await env.store.get(env.order_id);
  const observed = await observedOf(env.store, env.order_id);
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ observed, to: 'paid' }), { ignored: true, reason: 'missing_order_id' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'failed' }), { ignored: true, reason: 'bad_target' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'canceled' }), { ignored: true, reason: 'bad_target' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: 'o_none', observed, to: 'paid' }), { ignored: true, reason: 'unknown_order' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed: { ...observed, attempt: undefined }, to: 'paid' }), { ignored: true, reason: 'unobservable_row' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed: { ...observed, charge_pending_at: undefined }, to: 'paid' }), { ignored: true, reason: 'unobservable_row' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed: { status: 'expired' }, to: 'paid' }), { ignored: true, reason: 'unobservable_row' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed: { ...observed, status: 'created' }, to: 'paid' }), { ignored: true, reason: 'not_settleable:created' });
  assert.deepEqual(await env.store.get(env.order_id), before);
});

test('settle twice: the second is a no-op (idempotent)', async () => {
  const env = await stuckKernel();
  const observed = await observedOf(env.store, env.order_id);
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'paid', reason: 'r' }), { transitioned: 'paid' });
  const after = await env.store.get(env.order_id);
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'paid', reason: 'r' }), { ignored: true, reason: 'row_changed' });
  assert.deepEqual(await env.kernel.settleUncorrelatedCharge({ order_id: env.order_id, observed, to: 'expired', reason: 'r' }), { ignored: true, reason: 'row_changed' });
  assert.deepEqual(await env.store.get(env.order_id), after);
});

test('RECONCILE_SETTLER is the name the listers look for', () => {
  assert.equal(RECONCILE_SETTLER, RECONCILE_SETTLER_NAME);
});

// ---------------------------------------------------------------------------------------------------------------
// The decision table (pure).
// ---------------------------------------------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const SESSION = 24 * HOUR;
const MONEY = { amount: 113, currency: 'USD', merchant_of_record: 'merch_A' };
const pendingRow = (ageMs, extra = {}) => ({ status: 'charge_pending', charge_pending_at: NOW - ageMs, charge_lane: 'upstream', ...MONEY, ...extra });
const B = (payment_status, state = 'awaiting_checkout', has_payment_surface = false, money = {}) => ({
  state, payment_status, has_payment_surface, total_minor: 113, currency: 'USD', merchant_id: 'merch_A', ...money,
});
const decide = (b, row = pendingRow(25 * HOUR)) => decideSettlement(b, row, { now: NOW, sessionMaxAgeMs: SESSION });

test('decide: every backend paid state -> paid, whatever else the order says', () => {
  for (const ps of ['paid', 'completed', 'succeeded', 'success', 'settled', 'partially_refunded', 'refunded']) {
    assert.deepEqual(decide(B(ps, 'confirmed', true)), { decision: 'paid', reason: 'backend_paid' }, ps);
    assert.deepEqual(decide(B(ps, 'cancelled')), { decision: 'paid', reason: 'backend_paid' }, ps);
    assert.deepEqual(decide(B(ps), pendingRow(MIN)), { decision: 'paid', reason: 'backend_paid' }, `${ps}, young row`);
  }
});

test('decide: money after cancel is held for ops, never settled', () => {
  assert.deepEqual(decide(B('paid_after_cancel', 'cancelled')), { decision: 'hold', reason: 'backend_paid_after_cancel' });
});

test('decide: a cancelled backend order -> expire, at any age', () => {
  assert.deepEqual(decide(B('awaiting_payment', 'cancelled', true)), { decision: 'expire', reason: 'backend_order_cancelled' });
  assert.deepEqual(decide(B('', 'cancelled'), pendingRow(MIN)), { decision: 'expire', reason: 'backend_order_cancelled' });
});

test('decide: a cancelled order whose payment is in flight (or failed) is held, not expired', () => {
  for (const ps of ['processing', 'requires_action', 'failed', 'payment_failed', 'authorized']) {
    assert.deepEqual(decide(B(ps, 'cancelled')), { decision: 'hold', reason: 'backend_cancelled_payment_in_flight' }, ps);
  }
  for (const ps of ['cancelled', 'canceled', '', 'unpaid', 'pending', 'awaiting_payment']) {
    assert.deepEqual(decide(B(ps, 'cancelled')), { decision: 'expire', reason: 'backend_order_cancelled' }, ps);
  }
});

test('decide: a delegated-token (dispatch) row is never expired, only paid', () => {
  const lane = (age) => pendingRow(age, { charge_lane: 'dispatch' });
  for (const b of [B('awaiting_payment'), B('', 'draft'), B('awaiting_payment', 'cancelled'), B('', 'cancelled'), B('processing'), B('awaiting_payment', 'awaiting_checkout', true)]) {
    assert.deepEqual(decide(b, lane(30 * 24 * HOUR)), { decision: 'hold', reason: 'delegated_lane_not_paid' }, JSON.stringify(b));
  }
  assert.deepEqual(decide(B('paid', 'confirmed'), lane(HOUR)), { decision: 'paid', reason: 'backend_paid' });
  assert.deepEqual(decide(B('paid_after_cancel', 'cancelled'), lane(HOUR)), { decision: 'hold', reason: 'backend_paid_after_cancel' });
  // A row from before charge_lane existed reads as the hosted lane.
  assert.equal(decide(B('awaiting_payment'), pendingRow(25 * HOUR, { charge_lane: undefined })).decision, 'expire');
});

test('decide: "paid" counts only when the backend money is the kernel order\'s own', () => {
  assert.deepEqual(decide(B('paid', 'confirmed', false, { total_minor: 114 })), { decision: 'hold', reason: 'backend_paid_mismatch:amount' });
  assert.deepEqual(decide(B('paid', 'confirmed', false, { total_minor: null })), { decision: 'hold', reason: 'backend_paid_mismatch:amount' });
  assert.deepEqual(decide(B('paid', 'confirmed', false, { currency: 'EUR' })), { decision: 'hold', reason: 'backend_paid_mismatch:currency' });
  assert.deepEqual(decide(B('paid', 'confirmed', false, { currency: null })), { decision: 'hold', reason: 'backend_paid_mismatch:currency' });
  assert.deepEqual(decide(B('paid', 'confirmed', false, { merchant_id: 'merch_B' })), { decision: 'hold', reason: 'backend_paid_mismatch:merchant' });
  assert.deepEqual(decide(B('paid', 'confirmed', false, { merchant_id: null })), { decision: 'hold', reason: 'backend_paid_mismatch:merchant' });
  assert.deepEqual(decide(B('paid', 'confirmed'), pendingRow(HOUR, { amount: undefined })), { decision: 'hold', reason: 'backend_paid_mismatch:amount' });
  assert.deepEqual(decide(B('paid', 'confirmed'), pendingRow(HOUR, { currency: 'usd' })), { decision: 'paid', reason: 'backend_paid' }, 'currency case-insensitive');
  assert.deepEqual(decide(B('paid', 'confirmed'), pendingRow(HOUR, { amount: '113' })), { decision: 'paid', reason: 'backend_paid' }, 'amount read back as text from SQL');
  // A mismatch only blocks "paid"; an unpaid order still expires.
  assert.equal(decide(B('awaiting_payment', 'awaiting_checkout', false, { total_minor: 999 }), pendingRow(25 * HOUR)).decision, 'expire');
});

test('decide: a failed payment is held (the hosted page may still take a retry)', () => {
  for (const ps of ['failed', 'payment_failed']) {
    assert.deepEqual(decide(B(ps, 'payment_failed')), { decision: 'hold', reason: 'backend_payment_failed' });
  }
});

test('decide: an open PSP surface on an unpaid order is held', () => {
  for (const ps of ['', 'awaiting_payment', 'pending', 'unpaid']) {
    assert.deepEqual(decide(B(ps, 'awaiting_checkout', true)), { decision: 'hold', reason: 'payment_surface_open' }, ps);
  }
});

test('decide: unpaid, no surface -> expire only once older than any session lives', () => {
  for (const ps of ['', 'awaiting_payment', 'pending', 'unpaid']) {
    assert.deepEqual(decide(B(ps, ps ? 'awaiting_checkout' : 'draft')), { decision: 'expire', reason: 'session_lapsed_no_payment_surface' }, ps);
    assert.deepEqual(decide(B(ps), pendingRow(SESSION - 1)), { decision: 'hold', reason: 'session_may_be_open' }, ps);
  }
  assert.deepEqual(decide(B('awaiting_payment'), pendingRow(SESSION)), { decision: 'expire', reason: 'session_lapsed_no_payment_surface' }, 'boundary');
  assert.deepEqual(decide(B('awaiting_payment'), { status: 'charge_pending' }), { decision: 'hold', reason: 'no_timestamp' });
});

test('decide: a status this does not know is held', () => {
  for (const ps of ['processing', 'requires_action', 'authorized', 'refund_pending']) {
    assert.deepEqual(decide(B(ps)), { decision: 'hold', reason: 'backend_status_unrecognized' }, ps);
  }
});

test('decide: an expired row only ever moves to paid', () => {
  const expiredRow = { status: 'expired', settled_at: NOW - HOUR, ...MONEY };
  assert.deepEqual(decide(B('paid', 'confirmed'), expiredRow), { decision: 'paid', reason: 'backend_paid' });
  for (const b of [B('awaiting_payment'), B('', 'cancelled'), B('failed'), B('awaiting_payment', 'awaiting_checkout', true), B('paid_after_cancel', 'cancelled')]) {
    assert.equal(decide(b, expiredRow).decision, 'hold');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The backend read projection.
// ---------------------------------------------------------------------------------------------------------------

test('project: a 200 for this order gives state, payment_status and whether a surface exists, nothing more', () => {
  const p = projectBackendOrder('o1', 200, backendOrder('o1', { state: 'Awaiting_Checkout', payment_status: ' Awaiting_Payment ', surface: 'pi_test_1', currency: 'usd', total: '28.40' }).body);
  assert.deepEqual(p, { ok: true, state: 'awaiting_checkout', payment_status: 'awaiting_payment', has_payment_surface: true, total_minor: 2840, currency: 'USD', merchant_id: 'merch_A' });
  assert.equal(JSON.stringify(p).includes('secret'), false);
  assert.equal(JSON.stringify(p).includes('buyer'), false);
  assert.equal(projectBackendOrder('o1', 200, backendOrder('o1', { surface: '  ' }).body).has_payment_surface, false);
  assert.equal(projectBackendOrder('o1', 200, { order: { order_id: 'o1', state: 'draft' } }).payment_status, '');
  // Money that cannot be read is null, never a guess.
  const noMoney = projectBackendOrder('o1', 200, { order: { order_id: 'o1', state: 'draft' } });
  assert.deepEqual([noMoney.total_minor, noMoney.currency, noMoney.merchant_id], [null, null, null]);
  assert.equal(projectBackendOrder('o1', 200, backendOrder('o1', { total: '1.005' }).body).total_minor, null, 'over-precise');
  assert.equal(projectBackendOrder('o1', 200, backendOrder('o1', { total: '1000', currency: 'JPY' }).body).total_minor, 1000);
});

test('project: anything but a 200 about this order is "could not read"', () => {
  assert.deepEqual(projectBackendOrder('o1', 404, { detail: 'Order not found' }), { ok: false, reason: 'http_404' });
  assert.deepEqual(projectBackendOrder('o1', 403, {}), { ok: false, reason: 'http_403' });
  assert.deepEqual(projectBackendOrder('o1', 503, {}), { ok: false, reason: 'http_503' });
  // Only a 200 is an answer: another 2xx carrying a body is not.
  assert.deepEqual(projectBackendOrder('o1', 201, backendOrder('o1', { payment_status: 'paid' }).body), { ok: false, reason: 'http_201' });
  assert.deepEqual(projectBackendOrder('o1', 204, backendOrder('o1', { payment_status: 'paid' }).body), { ok: false, reason: 'http_204' });
  assert.deepEqual(projectBackendOrder('o1', undefined, {}), { ok: false, reason: 'http_none' });
  assert.deepEqual(projectBackendOrder('o1', 200, null), { ok: false, reason: 'malformed_body' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: [] }), { ok: false, reason: 'malformed_body' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: { order_id: 'o1', state: '' } }), { ok: false, reason: 'malformed_body' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: { order_id: 'o1', state: 'draft', payment_status: 5 } }), { ok: false, reason: 'malformed_body' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: { state: 'draft', payment_status: 'paid' } }), { ok: false, reason: 'order_id_missing' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: { order_id: '', state: 'draft', payment_status: 'paid' } }), { ok: false, reason: 'order_id_missing' });
  assert.deepEqual(projectBackendOrder('o1', 200, backendOrder('o2').body), { ok: false, reason: 'order_id_mismatch' });
});

// ---------------------------------------------------------------------------------------------------------------
// The run: modes, every transition end to end, the read failing, the late-webhook race, and the bounds.
// ---------------------------------------------------------------------------------------------------------------

test('run: mode off reads nothing and writes nothing', async () => {
  const env = await stuckKernel();
  let reads = 0;
  const s = await run(env, { mode: 'off', readBackendOrder: async () => { reads += 1; return backendOrder(env.order_id, { payment_status: 'paid' }); } });
  assert.deepEqual(s, { mode: 'off', skipped: 'off' });
  assert.equal(reads, 0);
  assert.equal((await env.store.get(env.order_id)).status, 'charge_pending');
  // An unknown mode is off.
  assert.equal((await run(env, { mode: 'APPLY', readBackendOrder: async () => { reads += 1; return {}; } })).skipped, 'off');
  assert.equal(reads, 0);
});

test('run: observe reads, decides and logs what it would do, and writes nothing', async () => {
  const env = await stuckKernel();
  env.clock.advance(HOUR);
  const before = await env.store.get(env.order_id);
  const log = captureLog();
  const s = await run(env, { mode: 'observe', log, readBackendOrder: async () => backendOrder(env.order_id, { payment_status: 'paid', state: 'merchant_confirming' }) });
  assert.equal(s.scanned, 1);
  assert.equal(s.decisions.paid, 1);
  assert.equal(s.applied, 0);
  assert.deepEqual(await env.store.get(env.order_id), before);
  const line = log.lines.find((l) => l.order_id === env.order_id);
  assert.equal(line.decision, 'paid');
  assert.equal(line.applied, false);
  assert.equal(line.mode, 'observe');
});

for (const [name, answer, ageMs, want] of [
  ['backend paid -> paid', { payment_status: 'paid', state: 'confirmed', surface: 'pi_1' }, HOUR, 'paid'],
  ['backend cancelled -> expired', { payment_status: 'awaiting_payment', state: 'cancelled' }, HOUR, 'expired'],
  ['no surface, past session life -> expired', { payment_status: 'awaiting_payment' }, 25 * HOUR, 'expired'],
  ['no surface, session may be open -> unchanged', { payment_status: 'awaiting_payment' }, HOUR, 'charge_pending'],
  ['open surface -> unchanged', { payment_status: 'awaiting_payment', surface: 'cs_1' }, 25 * HOUR, 'charge_pending'],
  ['payment failed -> unchanged', { payment_status: 'payment_failed', state: 'payment_failed', surface: 'pi_1' }, 25 * HOUR, 'charge_pending'],
  ['money after cancel -> unchanged', { payment_status: 'paid_after_cancel', state: 'cancelled' }, 25 * HOUR, 'charge_pending'],
  ['unknown status -> unchanged', { payment_status: 'processing' }, 25 * HOUR, 'charge_pending'],
]) {
  test(`run apply: ${name}`, async () => {
    const env = await stuckKernel();
    env.clock.advance(ageMs);
    const before = await env.store.get(env.order_id);
    const charges = env.calls.length;
    const s = await run(env, { readBackendOrder: async (id) => backendOrder(id, answer) });
    assert.equal(s.scanned, 1);
    const row = await env.store.get(env.order_id);
    assert.equal(row.status, want);
    if (want === 'charge_pending') {
      assert.deepEqual(row, before, 'a hold writes nothing');
      assert.equal(s.applied, 0);
    } else {
      assert.equal(s.applied, 1);
      assert.equal(row.settled_by, RECONCILE_SETTLER);
    }
    assert.equal(env.calls.length, charges, 'nothing is sent upstream through the kernel: no charge, no order, no session');
  });
}

for (const [name, reader] of [
  ['answers 503', async () => ({ status: 503, body: { detail: 'unavailable' } })],
  ['answers 404', async () => ({ status: 404, body: { detail: 'Order not found' } })],
  ['times out', async () => { throw Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }); }],
  ['answers garbage', async () => ({ status: 200, body: '<html>' })],
  ['answers for another order', async () => backendOrder('o_other', { payment_status: 'paid' })],
]) {
  test(`run apply: the backend read ${name} -> no change, logged as a read failure`, async () => {
    const env = await stuckKernel();
    env.clock.advance(25 * HOUR);
    const before = await env.store.get(env.order_id);
    const log = captureLog();
    const s = await run(env, { log, readBackendOrder: reader });
    assert.equal(s.read_failed, 1);
    assert.equal(s.applied, 0);
    assert.deepEqual(s.decisions, { paid: 0, expire: 0, hold: 0 });
    assert.deepEqual(await env.store.get(env.order_id), before);
    const line = log.lines.find((l) => l.order_id === env.order_id);
    assert.equal(line.level, 'warn');
    assert.match(line.reason, /^read_failed:/);
  });
}

test('race: the in-flight charge answers and its webhook lands while the reconcile reads -> the reconcile loses, the webhook stands', async () => {
  const env = await stuckKernel({ submit: 'deferred' });
  env.clock.advance(31 * MIN); // just past the minimum age; a cancelled backend order expires at any age
  let readError = null;
  const s = await run(env, {
    readBackendOrder: async (id) => {
      try { return await raceRead(id); } catch (err) { readError = err; throw err; }
    },
  });
  async function raceRead(id) {
    {
      // While the backend read is out: the original charge call finally returns (stamping its payment id), and that
      // payment's webhook arrives and settles the order.
      env.resolveSubmit({ payment_id: 'pi_late', payment_status: 'requires_action' });
      // It finishes after its idempotency lease (2 min) lapsed, so its caller gets IDEMPOTENCY_CONFLICT, but the
      // order row is stamped first: the payment id is on the row either way.
      await env.paySettled;
      assert.equal((await env.store.get(id)).payment_id, 'pi_late');
      const wh = await env.kernel.onPaymentWebhook({ order_id: id, status: 'payment_failed', payment_id: 'pi_late' });
      assert.deepEqual(wh, { transitioned: 'failed' });
      // The backend read was taken before all that: it saw the order cancelled.
      return backendOrder(id, { payment_status: 'awaiting_payment', state: 'cancelled' });
    }
  }
  assert.equal(readError, null);
  assert.equal(s.decisions.expire, 1);
  assert.equal(s.applied, 0);
  assert.equal(s.raced, 1);
  const row = await env.store.get(env.order_id);
  assert.equal(row.status, 'failed', "the webhook's answer stands");
  assert.equal(row.payment_id, 'pi_late');
  assert.equal(row.settled_by, undefined);
});

test('race: a late webhook after the reconcile settled the order does not undo it', async () => {
  const env = await stuckKernel();
  env.clock.advance(HOUR);
  await run(env, { readBackendOrder: async (id) => backendOrder(id, { payment_status: 'paid', state: 'confirmed' }) });
  assert.equal((await env.store.get(env.order_id)).status, 'paid');
  for (const status of ['payment_failed', 'succeeded', 'processing']) {
    const r = await env.kernel.onPaymentWebhook({ order_id: env.order_id, status, payment_id: 'pi_any' });
    assert.equal(r.transitioned, undefined, status);
  }
  assert.equal((await env.store.get(env.order_id)).status, 'paid');
});

test('race: two reconciles settle the same order once (a second instance, or a stale list)', async () => {
  const env = await stuckKernel();
  env.clock.advance(HOUR);
  const staleList = await makeInMemoryListCandidates(env.store)({ pendingOlderThan: env.clock.now() - 30 * MIN, pendingNewerThan: 0, expiredNewerThan: 0, pendingLimit: 10, expiredLimit: 0 });
  const reader = async (id) => backendOrder(id, { payment_status: 'paid', state: 'confirmed' });
  const first = await run(env, { readBackendOrder: reader, listCandidates: async () => staleList });
  const second = await run(env, { readBackendOrder: reader, listCandidates: async () => staleList });
  assert.equal(first.applied, 1);
  assert.equal(second.applied, 0);
  assert.equal(second.raced, 1);
  // And with a fresh list there is nothing left to read.
  let reads = 0;
  const third = await run(env, { readBackendOrder: async (id) => { reads += 1; return reader(id); } });
  assert.equal(third.scanned, 0);
  assert.equal(reads, 0);
});

test('run: an expired row is re-read and moves to paid when the backend later says paid', async () => {
  const env = await stuckKernel();
  env.clock.advance(25 * HOUR);
  await run(env, { readBackendOrder: async (id) => backendOrder(id) });
  assert.equal((await env.store.get(env.order_id)).status, 'expired');
  env.clock.advance(HOUR);
  const still = await run(env, { readBackendOrder: async (id) => backendOrder(id) });
  assert.equal(still.decisions.hold, 1);
  assert.equal((await env.store.get(env.order_id)).status, 'expired');
  const late = await run(env, { readBackendOrder: async (id) => backendOrder(id, { payment_status: 'paid', state: 'confirmed', surface: 'pi_late' }) });
  assert.equal(late.applied, 1);
  assert.equal((await env.store.get(env.order_id)).status, 'paid');
  // Outside the recheck window it is no longer read.
  const env2 = await stuckKernel({ orderId: 'o_old_expired' });
  env2.clock.advance(25 * HOUR);
  await run(env2, { readBackendOrder: async (id) => backendOrder(id) });
  env2.clock.advance(RECONCILE_DEFAULTS.recheckWindowMs + MIN);
  let reads = 0;
  await run(env2, { readBackendOrder: async (id) => { reads += 1; return backendOrder(id, { payment_status: 'paid' }); } });
  assert.equal(reads, 0);
});

test('bounds: the age window leaves too-recent and too-old rows unread', async () => {
  const clock = makeClock();
  const young = await stuckKernel({ orderId: 'o_young', clock });
  let reads = [];
  const reader = async (id) => { reads.push(id); return backendOrder(id, { payment_status: 'paid' }); };
  clock.advance(29 * MIN);
  await run(young, { readBackendOrder: reader });
  assert.deepEqual(reads, [], 'younger than minAge');
  clock.advance(2 * MIN);
  await run(young, { readBackendOrder: reader });
  assert.deepEqual(reads, ['o_young']);
  const old = await stuckKernel({ orderId: 'o_old', clock });
  clock.advance(RECONCILE_DEFAULTS.maxAgeMs + MIN);
  reads = [];
  await run(old, { readBackendOrder: reader });
  assert.deepEqual(reads, [], 'older than maxAge is left to ops');
});

// Many stuck rows in one store: several kernels would each have their own, so seed rows directly.
async function manyStuck(n, clock = makeClock()) {
  const env = await stuckKernel({ clock, orderId: 'o_000' });
  const base = await env.store.get('o_000');
  for (let i = 1; i < n; i += 1) {
    await env.store.set(`o_${String(i).padStart(3, '0')}`, { ...base, order_id: undefined, attempt: `att-${i}`, charge_pending_at: base.charge_pending_at + i });
  }
  return env;
}

test('bounds: the batch size caps the reads per run, oldest first', async () => {
  const env = await manyStuck(8);
  env.clock.advance(HOUR);
  const reads = [];
  const s = await run(env, { batchSize: 3, readBackendOrder: async (id) => { reads.push(id); return backendOrder(id); } });
  assert.deepEqual(reads, ['o_000', 'o_001', 'o_002']);
  assert.equal(s.scanned, 3);
  // A lister that returns more than asked is still capped.
  const reads2 = [];
  const all = await makeInMemoryListCandidates(env.store)({ pendingOlderThan: Infinity, pendingNewerThan: 0, expiredNewerThan: 0, pendingLimit: 100, expiredLimit: 0 });
  await run(env, { batchSize: 2, recheckBatchSize: 0, listCandidates: async () => all, readBackendOrder: async (id) => { reads2.push(id); return backendOrder(id); } });
  assert.equal(reads2.length, 2);
});

test('bounds: reads are spaced by the rate limit', async () => {
  const env = await manyStuck(4);
  env.clock.advance(HOUR);
  const at = [];
  const sleeps = [];
  await run(env, {
    readsPerSecond: 2,
    sleep: async (ms) => { sleeps.push(ms); env.clock.advance(ms); },
    readBackendOrder: async (id) => { at.push(env.clock.now()); env.clock.advance(100); return backendOrder(id); },
  });
  assert.equal(at.length, 4);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 500, `gap ${at[i] - at[i - 1]}`);
  assert.deepEqual(sleeps, [400, 400, 400]);
});

test('bounds: the run stops reading at its deadline, and the read timeout never outlives it', async () => {
  const env = await manyStuck(10);
  env.clock.advance(HOUR);
  const timeouts = [];
  const s = await run(env, {
    deadlineMs: 10_000,
    readTimeoutMs: 5000,
    readsPerSecond: 20,
    readBackendOrder: async (id, { timeoutMs }) => { timeouts.push(timeoutMs); env.clock.advance(4000); return backendOrder(id); },
  });
  assert.equal(s.stopped, 'deadline');
  assert.equal(s.scanned, 3);
  assert.deepEqual(timeouts, [5000, 5000, 2000]);
});

test('lease: a held lease skips the run; the lease is released after a run, even one that throws', async () => {
  const env = await stuckKernel();
  env.clock.advance(HOUR);
  const leaseStore = new InMemoryKvStore({ now: env.clock.now });
  const a = makeStoreLease(leaseStore, { owner: 'A', ttlMs: 90_000 });
  const b = makeStoreLease(leaseStore, { owner: 'B', ttlMs: 90_000 });
  assert.equal(await a.acquire(), true);
  let reads = 0;
  const skipped = await run(env, { lease: b, readBackendOrder: async (id) => { reads += 1; return backendOrder(id); } });
  assert.deepEqual(skipped, { mode: 'apply', skipped: 'lease_held' });
  assert.equal(reads, 0);
  await a.release();
  await run(env, { lease: b, readBackendOrder: async (id) => { reads += 1; return backendOrder(id); } });
  assert.equal(reads, 1);
  assert.equal(await leaseStore.get('run-lease'), undefined, 'released');
  await assert.rejects(run(env, { lease: b, listCandidates: async () => { throw new Error('db down'); }, readBackendOrder: async () => ({}) }));
  assert.equal(await leaseStore.get('run-lease'), undefined, 'released after a throw');
  // B's release cannot free A's lease.
  await a.acquire();
  await b.release();
  assert.deepEqual(await leaseStore.get('run-lease'), { owner: 'A' });
  // An abandoned lease frees itself by its TTL.
  env.clock.advance(90_001);
  assert.equal(await b.acquire(), true);
});

test('config: defaults, clamps, and a window that stays a window', () => {
  const d = normalizeConfig({});
  assert.equal(d.mode, 'off');
  for (const k of Object.keys(RECONCILE_DEFAULTS)) assert.equal(d[k], RECONCILE_DEFAULTS[k], k);
  // The defaults themselves, as literals (the money-safety ones above all).
  assert.deepEqual({ ...RECONCILE_DEFAULTS }, {
    batchSize: 25, recheckBatchSize: 5, minAgeMs: 30 * MIN, maxAgeMs: 14 * 24 * HOUR, sessionMaxAgeMs: 24 * HOUR,
    recheckWindowMs: 72 * HOUR, readsPerSecond: 2, deadlineMs: 60_000, readTimeoutMs: 5000,
  });
  const c = normalizeConfig({ mode: 'observe', batchSize: 10_000, readsPerSecond: 0, deadlineMs: 1, minAgeMs: 'x', sessionMaxAgeMs: 1 });
  assert.equal(c.mode, 'observe');
  assert.equal(c.batchSize, 200);
  assert.equal(c.readsPerSecond, 0.1);
  assert.equal(c.deadlineMs, 5000);
  assert.equal(c.minAgeMs, RECONCILE_DEFAULTS.minAgeMs);
  assert.equal(c.sessionMaxAgeMs, 6 * HOUR + 5 * MIN, 'never below the backend session clamp (6 h) plus margin');
  const w = normalizeConfig({ minAgeMs: 2 * HOUR, maxAgeMs: HOUR });
  assert.ok(w.maxAgeMs > w.minAgeMs);
});

test('postgres lister: asks for charge_pending with no payment id inside the window, then a few expired rows', async () => {
  const seen = [];
  const db = {
    query: async (text, params) => {
      seen.push({ text, params });
      if (text === PENDING_SQL) return { rows: [
        { order_id: 'o1', attempt: 'k1', charge_pending_at: '1700000000000', charge_lane: 'upstream', amount: '113', currency: 'USD', merchant_of_record: 'merch_A' },
        { order_id: 'o2', attempt: null, charge_pending_at: null, charge_lane: null, amount: null, currency: null, merchant_of_record: null },
      ] };
      if (text === EXPIRED_SQL) return { rows: [{ order_id: 'o3', settled_at: '1700000000500', charge_lane: 'dispatch', amount: '113', currency: 'USD', merchant_of_record: 'merch_A' }] };
      throw new Error('unexpected');
    },
  };
  const list = makePostgresListCandidates({ db });
  const rows = await list({ pendingOlderThan: 10, pendingNewerThan: 1, expiredNewerThan: 5, pendingLimit: 25, expiredLimit: 5 });
  assert.deepEqual(seen.map((s) => s.params), [['orders', 10, 1, 25, null, null], ['orders', RECONCILE_SETTLER_NAME, 5, 5]]);
  const U = undefined;
  assert.deepEqual(rows, [
    { order_id: 'o1', status: 'charge_pending', attempt: 'k1', payment_id: null, charge_pending_at: 1700000000000, charge_lane: 'upstream', amount: 113, currency: 'USD', merchant_of_record: 'merch_A' },
    { order_id: 'o2', status: 'charge_pending', attempt: U, payment_id: null, charge_pending_at: U, charge_lane: U, amount: U, currency: U, merchant_of_record: U },
    { order_id: 'o3', status: 'expired', payment_id: null, settled_at: 1700000000500, charge_lane: 'dispatch', amount: 113, currency: 'USD', merchant_of_record: 'merch_A' },
  ]);
  seen.length = 0;
  await list({ pendingOlderThan: 10, pendingNewerThan: 1, expiredNewerThan: 5, pendingLimit: 25, expiredLimit: 0, pendingAfter: { at: 7, id: 'o9' } });
  assert.deepEqual(seen[0].params, ['orders', 10, 1, 25, 7, 'o9'], 'the cursor rides as $5/$6');
  seen.length = 0;
  await list({ pendingOlderThan: 10, pendingNewerThan: 1, expiredNewerThan: 5, pendingLimit: 25, expiredLimit: 0 });
  assert.equal(seen.length, 1, 'no expired query with no recheck budget');
  // Neither query can write.
  for (const sql of [PENDING_SQL, EXPIRED_SQL]) assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE)\b/i);
  // The clauses that keep the list to the reconcile's own rows (real-PG behaviour is checked outside CI; these pin
  // the text so a dropped clause cannot pass).
  const flat = (q) => q.replace(/\s+/g, ' ');
  for (const clause of [
    "WHERE ns = $1", "AND v ->> 'status' = 'charge_pending'", "AND (v ->> 'payment_id') IS NULL",
    'AND (expires_at IS NULL OR expires_at > now())', "jsonb_typeof(v -> 'charge_pending_at') = 'number'",
    'AND c.charge_pending_at <= $2', 'AND c.charge_pending_at >= $3',
    'AND ($5::numeric IS NULL OR (c.charge_pending_at, c.order_id) > ($5::numeric, $6::text))',
    'ORDER BY c.charge_pending_at ASC, c.order_id ASC', 'LIMIT $4',
  ]) assert.ok(flat(PENDING_SQL).includes(clause), clause);
  for (const clause of [
    "AND v ->> 'status' = 'expired'", "AND v ->> 'settled_by' = $2", "AND (v ->> 'payment_id') IS NULL",
    'AND c.settled_at >= $3', 'ORDER BY c.settled_at DESC', 'LIMIT $4',
  ]) assert.ok(flat(EXPIRED_SQL).includes(clause), clause);
});

// ---------------------------------------------------------------------------------------------------------------
// The kernel records how a charge was attempted (P3-3), and the flag-off cancel leaves 'expired' alone (P3-5).
// ---------------------------------------------------------------------------------------------------------------

test('kernel: the charge_pending row records its lane, and the dispatch lane is never expired end to end', async () => {
  const hosted = await stuckKernel({ orderId: 'o_hosted' });
  assert.equal((await hosted.store.get('o_hosted')).charge_lane, 'upstream');
  const delegated = await stuckKernel({ orderId: 'o_delegated', lane: 'dispatch' });
  const row = await delegated.store.get('o_delegated');
  assert.equal(row.charge_lane, 'dispatch');
  assert.equal(row.status, 'charge_pending');
  assert.equal(row.payment_id, null);
  assert.equal(delegated.calls.includes('submit_payment'), false, 'the dispatcher charged, not the hosted surface');
  delegated.clock.advance(10 * 24 * HOUR); // far past any session life, inside the 14 d window
  for (const answer of [{ state: 'cancelled', payment_status: '' }, { state: 'draft', payment_status: '' }, { state: 'awaiting_checkout', payment_status: 'awaiting_payment' }]) {
    const s = await run(delegated, { readBackendOrder: async (id) => backendOrder(id, answer) });
    assert.equal(s.by_reason.delegated_lane_not_paid, 1, JSON.stringify(answer));
    assert.equal((await delegated.store.get('o_delegated')).status, 'charge_pending');
  }
  await run(delegated, { readBackendOrder: async (id) => backendOrder(id, { state: 'confirmed', payment_status: 'paid' }) });
  assert.equal((await delegated.store.get('o_delegated')).status, 'paid');
});

test('flag-off cancel by order id: an expired order is refused and left expired', async () => {
  const env = await stuckKernel();
  env.clock.advance(25 * HOUR);
  await run(env, { readBackendOrder: async (id) => backendOrder(id) });
  const expired = await env.store.get(env.order_id);
  assert.equal(expired.status, 'expired');
  const exec = createCanonicalExecutor({ kernel: env.kernel }).execute;
  await assert.rejects(
    exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-expired', order_id: env.order_id }, CTX),
    (e) => e.code === 'OPERATION_NOT_ALLOWED' && e.detail?.reason === 'order_expired_not_payable',
  );
  assert.deepEqual(await env.store.get(env.order_id), expired);
  // ...so a late payment is still caught by the re-read.
  env.clock.advance(HOUR);
  await run(env, { readBackendOrder: async (id) => backendOrder(id, { state: 'confirmed', payment_status: 'paid' }) });
  assert.equal((await env.store.get(env.order_id)).status, 'paid');
});

test('flag-off cancel by order id: the write is conditional on the status it read', async () => {
  const clock = makeClock();
  const kernel = new SafetyKernel({ upstream: async (op) => (op === 'preview_quote' ? QUOTE : op === 'create_order' ? { order_id: 'o_cx', acp_state: {} } : {}), secret: SECRET, now: clock.now, log: quiet });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  await kernel.createOrder({ idempotency_key: 'idem-o_cx-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const exec = createCanonicalExecutor({ kernel }).execute;
  // A plain created order still cancels.
  const ok = await exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-ok', order_id: 'o_cx' }, CTX);
  assert.equal(ok.status, 'canceled');
  assert.equal((await kernel._orderStore.get('o_cx')).status, 'canceled');
  // A writer that lands between the cancel's read and its write wins; the cancel says so and writes nothing.
  const row = await kernel._orderStore.get('o_cx');
  await kernel._orderStore.set('o_cx', { ...row, status: 'created' });
  const realGet = kernel._orderStore.get.bind(kernel._orderStore);
  kernel._orderStore.get = async (k) => {
    const v = await realGet(k);
    if (k === 'o_cx') await kernel._orderStore.set('o_cx', { ...v, status: 'paid' });
    return v;
  };
  await assert.rejects(
    exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-race', order_id: 'o_cx' }, CTX),
    (e) => e.code === 'OPERATION_NOT_ALLOWED' && e.detail?.reason === 'order_changed_during_cancel',
  );
  kernel._orderStore.get = realGet;
  assert.equal((await kernel._orderStore.get('o_cx')).status, 'paid');
});

// ---------------------------------------------------------------------------------------------------------------
// P2-1: held rows never starve the rows behind them (keyset cursor).
// ---------------------------------------------------------------------------------------------------------------

test('starvation: 30 held rows ahead of a settleable one — the cursor reaches it on the next run, then wraps', async () => {
  const env = await manyStuck(30);
  // The target: younger than every held row, unpaid, no surface, past the session life.
  const base = await env.store.get('o_000');
  await env.store.set('o_target', { ...base, attempt: 'att-target', charge_pending_at: base.charge_pending_at + 1000 });
  env.clock.advance(25 * HOUR);
  const cursorStore = new InMemoryKvStore({ now: env.clock.now });
  const cursor = makeStoreCursor(cursorStore);
  // The common held state: an abandoned page that attached a PaymentIntent reads `processing`.
  const reader = async (id) => (id === 'o_target' ? backendOrder(id) : backendOrder(id, { payment_status: 'processing', surface: 'pi_abandoned' }));
  const reads = [];
  const read = async (id, o) => { reads.push(id); return reader(id, o); };

  const r1 = await run(env, { cursor, readBackendOrder: read });
  assert.equal(r1.scanned, 25);
  assert.equal(reads.includes('o_target'), false);
  assert.equal(r1.cursor, 'advanced');
  assert.deepEqual(await cursorStore.get('pending-cursor'), { at: base.charge_pending_at + 24, id: 'o_024' });

  reads.length = 0;
  const r2 = await run(env, { cursor, readBackendOrder: read });
  assert.deepEqual(reads, ['o_025', 'o_026', 'o_027', 'o_028', 'o_029', 'o_target']);
  assert.equal(r2.applied, 1);
  assert.equal((await env.store.get('o_target')).status, 'expired');
  assert.equal(r2.cursor, 'wrapped', 'reached the end: the next run starts from the oldest again');
  assert.equal(await cursorStore.get('pending-cursor'), undefined);

  reads.length = 0;
  await run(env, { cursor, readBackendOrder: read });
  assert.equal(reads[0], 'o_000');
  assert.deepEqual([reads.length, reads.at(-1)], [26, 'o_target'], '25 pending from the top, then the expired target re-read for a late payment');
  // Without a cursor the same 25 would be read forever: the regression this guards.
  reads.length = 0;
  await run(env, { readBackendOrder: read });
  await run(env, { readBackendOrder: read });
  assert.equal(new Set(reads.filter((id) => id !== 'o_target')).size, 25, 'two cursorless runs read the same 25 held rows');
});

test('cursor: a run stopped by its deadline carries on after the last row it read', async () => {
  const env = await manyStuck(10);
  env.clock.advance(HOUR);
  const cursorStore = new InMemoryKvStore({ now: env.clock.now });
  const cursor = makeStoreCursor(cursorStore);
  const reads = [];
  const s = await run(env, {
    cursor, deadlineMs: 10_000, readsPerSecond: 20,
    readBackendOrder: async (id) => { reads.push(id); env.clock.advance(4000); return backendOrder(id, { payment_status: 'processing' }); },
  });
  assert.equal(s.stopped, 'deadline');
  assert.deepEqual(reads, ['o_000', 'o_001', 'o_002']);
  assert.equal(s.cursor, 'advanced');
  reads.length = 0;
  await run(env, { cursor, readsPerSecond: 20, readBackendOrder: async (id) => { reads.push(id); return backendOrder(id, { payment_status: 'processing' }); } });
  assert.equal(reads[0], 'o_003');
});

test('cursor: an unreadable or failing cursor store starts from the oldest row and never stops the run', async () => {
  const env = await manyStuck(3);
  env.clock.advance(HOUR);
  const reads = [];
  const read = async (id) => { reads.push(id); return backendOrder(id, { payment_status: 'processing' }); };
  for (const bad of [{ at: 'x', id: 'o_001' }, { at: 1, id: '' }, 'junk', null]) {
    reads.length = 0;
    await run(env, { cursor: { get: async () => bad, set: async () => {} }, readBackendOrder: read });
    assert.equal(reads[0], 'o_000', JSON.stringify(bad));
  }
  reads.length = 0;
  const s = await run(env, { cursor: { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } }, readBackendOrder: read });
  assert.equal(reads.length, 3);
  assert.equal(s.cursor, 'not_saved');
});

test('cursor: the in-memory lister orders by (charge_pending_at, order_id), so equal stamps are not skipped', async () => {
  const env = await stuckKernel();
  const base = await env.store.get(env.order_id);
  for (const id of ['o_b', 'o_a', 'o_c']) await env.store.set(id, { ...base, attempt: `att-${id}`, charge_pending_at: base.charge_pending_at + 5 });
  const list = makeInMemoryListCandidates(env.store);
  const q = { pendingOlderThan: Infinity, pendingNewerThan: 0, expiredNewerThan: 0, pendingLimit: 10, expiredLimit: 0 };
  const after = await list({ ...q, pendingAfter: { at: base.charge_pending_at + 5, id: 'o_a' } });
  assert.deepEqual(after.map((r) => r.order_id), ['o_b', 'o_c']);
});
