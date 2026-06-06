// Multi-instance durability test — the whole point of the registry→store conversion.
// Two SEPARATE SafetyKernel instances share ONE backing store (as two processes behind a load
// balancer would share Postgres). Idempotency + single-use confirmation must hold ACROSS instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { PostgresKvStore } from '../src/stores/postgresKvStore.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';

const SECRET = 'multi-instance-secret-0123456789';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE_UPSTREAM = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};

const makeSharedDb = makeFakePgDb;

function makeInstance(db, now) {
  const upstream = async (op) => (
    op === 'preview_quote' ? QUOTE_UPSTREAM
    : op === 'create_order' ? { order_id: 'o_shared', acp_state: {} }
    : op === 'submit_payment' ? { order_id: 'o_shared', payment_id: 'pay1', payment_status: 'succeeded' }
    : {}
  );
  const storeFactory = (ns) => new PostgresKvStore({ db, namespace: ns, now });
  return new SafetyKernel({ upstream, secret: SECRET, storeFactory, now, log: { info() {}, warn() {}, error() {} } });
}

test('a quote issued on instance A is resolvable on instance B', async () => {
  let t = 1_000_000;
  const db = makeSharedDb(() => t);
  const a = makeInstance(db, () => t);
  const b = makeInstance(db, () => t);
  const q = await a.previewQuote({ quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  // B creates the order against A's quote — only possible if the quote is in the shared store.
  const o = await b.createOrder({ idempotency_key: 'idem-cross-1', order: { quote_id: q.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  assert.equal(o.amount_total, 113);
});

test('idempotency holds ACROSS instances: same key on A then B does not double-create', async () => {
  let t = 2_000_000; let creates = 0;
  const db = makeSharedDb(() => t);
  const mkUpstream = () => async (op) => {
    if (op === 'preview_quote') return QUOTE_UPSTREAM;
    if (op === 'create_order') { creates += 1; return { order_id: 'o_shared', acp_state: {} }; }
    return {};
  };
  const sf = (ns) => new PostgresKvStore({ db, namespace: ns, now: () => t });
  const a = new SafetyKernel({ upstream: mkUpstream(), secret: SECRET, storeFactory: sf, now: () => t, log: { info() {}, warn() {}, error() {} } });
  const b = new SafetyKernel({ upstream: mkUpstream(), secret: SECRET, storeFactory: sf, now: () => t, log: { info() {}, warn() {}, error() {} } });
  const q = await a.previewQuote({ quote: {} }, CTX);
  const args = { idempotency_key: 'idem-cross-dup', order: { quote_id: q.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } };
  const r1 = await a.createOrder(args, CTX);
  const r2 = await b.createOrder(args, CTX); // replay on a DIFFERENT instance
  assert.equal(r1.order_id, r2.order_id);
  assert.equal(creates, 1, 'upstream create called exactly once across both instances');
});

test('confirmation token is single-use ACROSS instances', async () => {
  let t = 3_000_000;
  const db = makeSharedDb(() => t);
  const a = makeInstance(db, () => t);
  const b = makeInstance(db, () => t);
  const q = await a.previewQuote({ quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await a.createOrder({ idempotency_key: 'idem-tok-cross', order: { quote_id: q.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const token = await a.mintConfirmation({ order_id: o.order_id }, CTX);
  // Pay on instance A with a fresh idem key.
  const pay1 = await a.submitPayment({ idempotency_key: 'idem-pay-A', confirmation_token: token, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(pay1.payment_status, 'succeeded');
  // Reuse the SAME token on instance B with a different idem key → must be REFUSED. The order is
  // already paid (charge-once lock, Codex P0-2), so B rejects with IDEMPOTENCY_CONFLICT before the
  // token re-check; the token single-use (CONFIRMATION_INVALID) is the other valid refusal. Either
  // way: the second instance does NOT charge again.
  await assert.rejects(
    b.submitPayment({ idempotency_key: 'idem-pay-B', confirmation_token: token, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT' || e.code === 'CONFIRMATION_INVALID',
  );
});
