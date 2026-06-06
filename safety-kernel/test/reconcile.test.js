// Reconciliation sweeper tests — resolves stuck 'charge_pending' orders via the PSP truth source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { reconcilePendingOrders, makeInMemoryListPending } from '../src/reconcile.js';

const SECRET = 'reconcile-secret-0123456789abc';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [], acp_state: { acp_session_id: 'acp_1' },
};

// Build a kernel with a controllable clock and put one order into charge_pending(payment_id=pi_1).
async function pendingKernel(orderId = 'o_rec') {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const upstream = async (op) => (
    op === 'preview_quote' ? QUOTE
    : op === 'create_order' ? { order_id: orderId, acp_state: {} }
    : op === 'submit_payment' ? { payment_id: 'pi_1', payment_status: 'requires_action' }
    : {}
  );
  const kernel = new SafetyKernel({ upstream, secret: SECRET, now: () => t, log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-rec-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const token = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  await kernel.submitPayment({ idempotency_key: 'idem-rec-pay', confirmation_token: token, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  return { kernel, clock, order_id: o.order_id, listPending: makeInMemoryListPending(kernel._orderStore) };
}

test('listPending finds the charge_pending order (by store key) with its payment_id', async () => {
  const { listPending, order_id } = await pendingKernel();
  const pending = await listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].order_id, order_id);
  assert.equal(pending[0].payment_id, 'pi_1');
  assert.equal(typeof pending[0].charge_pending_at, 'number');
});

test('a stuck order whose PSP says succeeded is reconciled → paid', async () => {
  const { kernel, clock, listPending, order_id } = await pendingKernel();
  clock.advance(15 * 60 * 1000); // past maxAge
  const summary = await reconcilePendingOrders({
    kernel, listPending, queryStatus: async () => 'succeeded', now: clock.now, maxAgeMs: 10 * 60 * 1000,
    log: { info() {} },
  });
  assert.deepEqual(summary.reconciled, [{ order_id, to: 'paid' }]);
  // order is now paid
  const order = await kernel._orderStore.get(order_id);
  assert.equal(order.status, 'paid');
});

test('a stuck order whose PSP says failed is reconciled → failed', async () => {
  const { kernel, clock, listPending } = await pendingKernel('o_fail');
  clock.advance(15 * 60 * 1000);
  const summary = await reconcilePendingOrders({ kernel, listPending, queryStatus: async () => 'payment_failed', now: clock.now, maxAgeMs: 10 * 60 * 1000, log: { info() {} } });
  assert.equal(summary.reconciled[0].to, 'failed');
});

test('a RECENT charge_pending order is NOT swept (too_recent)', async () => {
  const { kernel, clock, listPending } = await pendingKernel('o_recent');
  clock.advance(2 * 60 * 1000); // under maxAge (10m)
  const summary = await reconcilePendingOrders({ kernel, listPending, queryStatus: async () => 'succeeded', now: clock.now, maxAgeMs: 10 * 60 * 1000, log: { info() {} } });
  assert.equal(summary.reconciled.length, 0);
  assert.equal(summary.stillPending[0].reason, 'too_recent');
});

test('a stuck order the PSP still reports pending/unknown is left pending', async () => {
  const { kernel, clock, listPending } = await pendingKernel('o_unknown');
  clock.advance(15 * 60 * 1000);
  const summary = await reconcilePendingOrders({ kernel, listPending, queryStatus: async () => null, now: clock.now, maxAgeMs: 10 * 60 * 1000, log: { info() {} } });
  assert.equal(summary.reconciled.length, 0);
  assert.equal(summary.stillPending[0].reason, 'psp_unknown');
});

test('reconcile uses the attempt-correlated webhook path (payment_id carried through)', async () => {
  const { kernel, clock, listPending, order_id } = await pendingKernel('o_corr');
  clock.advance(15 * 60 * 1000);
  let seen;
  const spyKernel = { onPaymentWebhook: async (e) => { seen = e; return kernel.onPaymentWebhook(e); } };
  await reconcilePendingOrders({ kernel: spyKernel, listPending, queryStatus: async () => 'succeeded', now: clock.now, maxAgeMs: 10 * 60 * 1000, log: { info() {} } });
  assert.equal(seen.order_id, order_id);
  assert.equal(seen.payment_id, 'pi_1');
  assert.equal(seen.status, 'succeeded');
});

test('Codex P2-1: an order missing charge_pending_at is HELD BACK (no_timestamp), not swept', async () => {
  const { kernel, clock } = await pendingKernel('o_nots');
  const listPending = async () => [{ order_id: 'o_nots', payment_id: 'pi_1' /* no charge_pending_at */ }];
  clock.advance(60 * 60 * 1000);
  let queried = false;
  const summary = await reconcilePendingOrders({ kernel, listPending, queryStatus: async () => { queried = true; return 'succeeded'; }, now: clock.now, maxAgeMs: 10 * 60 * 1000, log: { info() {} } });
  assert.equal(queried, false, 'must NOT query/resolve a row with no charge_pending_at');
  assert.equal(summary.stillPending[0].reason, 'no_timestamp');
});

test('Codex P1: an OLD charge_pending order missing payment_id is HELD BACK (no_payment_id), never queried', async () => {
  const { kernel, clock } = await pendingKernel('o_nopid');
  // Simulate the lock-first crash window: charge_pending written, payment_id never stamped.
  const pendingAt = clock.now(); // capture BEFORE advancing so the row reads as OLD, not too_recent
  const listPending = async () => [{ order_id: 'o_nopid', payment_id: null, charge_pending_at: pendingAt }];
  clock.advance(60 * 60 * 1000); // well past maxAge
  let queried = false;
  const summary = await reconcilePendingOrders({
    kernel, listPending,
    queryStatus: async () => { queried = true; return 'succeeded'; },
    now: clock.now, maxAgeMs: 10 * 60 * 1000, log: { info() {} },
  });
  assert.equal(queried, false, 'must NOT call queryStatus with a null payment_id');
  assert.equal(summary.reconciled.length, 0);
  assert.equal(summary.stillPending[0].reason, 'no_payment_id');
});

test('a RECENT charge_pending order missing payment_id is too_recent (not no_payment_id) — may still get its id', async () => {
  const { kernel, clock } = await pendingKernel('o_nopid_recent');
  const pendingAt = clock.now();
  const listPending = async () => [{ order_id: 'o_nopid_recent', payment_id: null, charge_pending_at: pendingAt }];
  clock.advance(2 * 60 * 1000); // 2min — under maxAge (10m): the too_recent gate wins before no_payment_id
  const summary = await reconcilePendingOrders({ kernel, listPending, queryStatus: async () => 'succeeded', now: clock.now, maxAgeMs: 10 * 60 * 1000, log: { info() {} } });
  assert.equal(summary.stillPending[0].reason, 'too_recent');
});

test('validates required deps', async () => {
  await assert.rejects(reconcilePendingOrders({ listPending: async () => [], queryStatus: async () => null }));
  await assert.rejects(reconcilePendingOrders({ kernel: { onPaymentWebhook() {} }, queryStatus: async () => null }));
});
