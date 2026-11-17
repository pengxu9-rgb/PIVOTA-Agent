// The charge_pending reconcile for rows the webhook cannot settle (payment_id null after an unknown charge outcome).
// safety-kernel/src/reconcileUncorrelated.js + kernel.settleUncorrelatedCharge + the stores' compareAndSetFields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel, RECONCILE_SETTLER } from '../src/kernel.js';
import { InMemoryKvStore, fieldsMatch } from '../src/stores.js';
import { PostgresKvStore } from '../src/stores/postgresKvStore.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';
import {
  reconcileUncorrelatedChargePending, decideSettlement, projectBackendOrder, normalizeConfig,
  makeInMemoryListCandidates, makePostgresListCandidates, makeStoreLease, RECONCILE_DEFAULTS,
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
async function stuckKernel({ orderId = 'o_stuck', clock = makeClock(), submit = 'throw' } = {}) {
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
  const pay = kernel.submitPayment({ idempotency_key: `idem-${orderId}-pay`, confirmation_token: token, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  let paySettled;
  if (submit === 'throw') await assert.rejects(pay);
  else { paySettled = pay.then((v) => ({ ok: v }), (e) => ({ err: e })); await charging; }
  const row = await kernel._orderStore.get(o.order_id);
  assert.equal(row.status, 'charge_pending');
  assert.equal(row.payment_id, null);
  return { kernel, clock, order_id: o.order_id, calls, resolveSubmit, paySettled, store: kernel._orderStore };
}

function backendOrder(orderId, { state = 'awaiting_checkout', payment_status = 'awaiting_payment', surface = null } = {}) {
  return {
    status: 200,
    body: {
      status: 'success',
      order: {
        order_id: orderId, state, payment_status,
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
  assert.match(t, /^UPDATE commerce_kv SET v = \$3, expires_at = \$4 WHERE ns = \$1 AND k = \$2/);
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
const pendingRow = (ageMs) => ({ status: 'charge_pending', charge_pending_at: NOW - ageMs });
const B = (payment_status, state = 'awaiting_checkout', has_payment_surface = false) => ({ state, payment_status, has_payment_surface });
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
  const expiredRow = { status: 'expired', settled_at: NOW - HOUR };
  assert.deepEqual(decide(B('paid', 'confirmed'), expiredRow), { decision: 'paid', reason: 'backend_paid' });
  for (const b of [B('awaiting_payment'), B('', 'cancelled'), B('failed'), B('awaiting_payment', 'awaiting_checkout', true), B('paid_after_cancel', 'cancelled')]) {
    assert.equal(decide(b, expiredRow).decision, 'hold');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The backend read projection.
// ---------------------------------------------------------------------------------------------------------------

test('project: a 200 for this order gives state, payment_status and whether a surface exists, nothing more', () => {
  const p = projectBackendOrder('o1', 200, backendOrder('o1', { state: 'Awaiting_Checkout', payment_status: ' Awaiting_Payment ', surface: 'cs_test_1' }).body);
  assert.deepEqual(p, { ok: true, state: 'awaiting_checkout', payment_status: 'awaiting_payment', has_payment_surface: true });
  assert.equal(JSON.stringify(p).includes('secret'), false);
  assert.equal(projectBackendOrder('o1', 200, backendOrder('o1', { surface: '  ' }).body).has_payment_surface, false);
  assert.equal(projectBackendOrder('o1', 200, { order: { state: 'draft' } }).payment_status, '');
});

test('project: anything but a 200 about this order is "could not read"', () => {
  assert.deepEqual(projectBackendOrder('o1', 404, { detail: 'Order not found' }), { ok: false, reason: 'http_404' });
  assert.deepEqual(projectBackendOrder('o1', 403, {}), { ok: false, reason: 'http_403' });
  assert.deepEqual(projectBackendOrder('o1', 503, {}), { ok: false, reason: 'http_503' });
  assert.deepEqual(projectBackendOrder('o1', undefined, {}), { ok: false, reason: 'http_none' });
  assert.deepEqual(projectBackendOrder('o1', 200, null), { ok: false, reason: 'malformed_body' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: [] }), { ok: false, reason: 'malformed_body' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: { state: '' } }), { ok: false, reason: 'malformed_body' });
  assert.deepEqual(projectBackendOrder('o1', 200, { order: { state: 'draft', payment_status: 5 } }), { ok: false, reason: 'malformed_body' });
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
  const c = normalizeConfig({ mode: 'observe', batchSize: 10_000, readsPerSecond: 0, deadlineMs: 1, minAgeMs: 'x', sessionMaxAgeMs: 1 });
  assert.equal(c.mode, 'observe');
  assert.equal(c.batchSize, 200);
  assert.equal(c.readsPerSecond, 0.1);
  assert.equal(c.deadlineMs, 5000);
  assert.equal(c.minAgeMs, RECONCILE_DEFAULTS.minAgeMs);
  assert.equal(c.sessionMaxAgeMs, 6 * HOUR, 'never below the backend’s own 6 h session clamp');
  const w = normalizeConfig({ minAgeMs: 2 * HOUR, maxAgeMs: HOUR });
  assert.ok(w.maxAgeMs > w.minAgeMs);
});

test('postgres lister: asks for charge_pending with no payment id inside the window, then a few expired rows', async () => {
  const seen = [];
  const db = {
    query: async (text, params) => {
      seen.push({ text, params });
      if (text === PENDING_SQL) return { rows: [{ order_id: 'o1', attempt: 'k1', charge_pending_at: '1700000000000' }, { order_id: 'o2', attempt: null, charge_pending_at: null }] };
      if (text === EXPIRED_SQL) return { rows: [{ order_id: 'o3', settled_at: '1700000000500' }] };
      throw new Error('unexpected');
    },
  };
  const list = makePostgresListCandidates({ db });
  const rows = await list({ pendingOlderThan: 10, pendingNewerThan: 1, expiredNewerThan: 5, pendingLimit: 25, expiredLimit: 5 });
  assert.deepEqual(seen.map((s) => s.params), [['orders', 10, 1, 25], ['orders', RECONCILE_SETTLER_NAME, 5, 5]]);
  assert.deepEqual(rows, [
    { order_id: 'o1', status: 'charge_pending', attempt: 'k1', payment_id: null, charge_pending_at: 1700000000000 },
    { order_id: 'o2', status: 'charge_pending', attempt: undefined, payment_id: null, charge_pending_at: undefined },
    { order_id: 'o3', status: 'expired', payment_id: null, settled_at: 1700000000500 },
  ]);
  seen.length = 0;
  await list({ pendingOlderThan: 10, pendingNewerThan: 1, expiredNewerThan: 5, pendingLimit: 25, expiredLimit: 0 });
  assert.equal(seen.length, 1, 'no expired query with no recheck budget');
  // Neither query can write.
  for (const sql of [PENDING_SQL, EXPIRED_SQL]) assert.doesNotMatch(sql, /\b(UPDATE|INSERT|DELETE)\b/i);
});
