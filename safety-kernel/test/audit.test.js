// C6 tests — audit trail completeness + redaction + readiness scorecard.
// This is the JS-side mirror of the standing test_audit_v3_end_to_end.py CI gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createInvokeHandler } from '../src/invokeHandler.js';
import { AuditLog, CommerceMetrics, readinessScorecard } from '../src/audit.js';

const SECRET = 'audit-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE_UPSTREAM = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};

function makeHandler() {
  const upstream = async (op) => (
    op === 'preview_quote' ? QUOTE_UPSTREAM
    : op === 'create_order' ? { order_id: 'o1', acp_state: {} }
    : op === 'submit_payment' ? { order_id: 'o1', payment_id: 'pay1', payment_status: 'succeeded', ap2_state: { mandate_id: 'm1', token: 'SECRET' } }
    : {}
  );
  const audit = new AuditLog();
  const metrics = new CommerceMetrics();
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const handler = createInvokeHandler({ kernel, upstream, audit, metrics, log: { info() {}, warn() {}, error() {} } });
  return { handler, kernel, audit, metrics };
}

async function fullFlow(handler, kernel) {
  const q = await handler.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await handler.handle('create_order', { idempotency_key: 'idem-audit-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const token = await kernel.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const pay = await handler.handle('submit_payment', { idempotency_key: 'idem-audit-pay', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  return { q, o, pay };
}

test('v3 e2e gate: a full quote->order->pay flow emits a complete audit trail', async () => {
  const { handler, kernel, audit } = makeHandler();
  const { o } = await fullFlow(handler, kernel);
  const events = audit.trailFor(o.data.order_id).map((e) => e.event);
  assert.ok(events.includes('order_created'));
  assert.ok(events.includes('payment_succeeded'));
  const all = audit.entries().map((e) => e.event);
  assert.ok(all.includes('quote_issued'));
});

test('C6: audit entries never leak sensitive data (ap2_state/tokens/amounts)', async () => {
  const { handler, kernel, audit } = makeHandler();
  await fullFlow(handler, kernel);
  const blob = JSON.stringify(audit.entries());
  assert.ok(!blob.includes('SECRET'), 'no token leaks into audit');
  assert.ok(!blob.includes('mandate_id'), 'no ap2_state leaks into audit');
  assert.ok(!/\b113\b/.test(blob), 'no raw amount in audit (currency code ok, amount not)');
});

test('C6: a price-mismatch attempt is recorded as price_changed_blocked + metric', async () => {
  const { handler, kernel, audit, metrics } = makeHandler();
  const q = await handler.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await handler.handle('create_order', { idempotency_key: 'idem-pc-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const token = await kernel.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const res = await handler.handle('submit_payment', { idempotency_key: 'idem-pc-pay', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 1, currency: 'USD' } }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PRICE_CHANGED');
  assert.equal(metrics.get('price_lock_violation'), 1);
  assert.ok(audit.entries().some((e) => e.event === 'price_changed_blocked'));
});

test('C6: missing confirmation is recorded as confirmation_blocked + metric', async () => {
  const { handler, kernel, metrics, audit } = makeHandler();
  const q = await handler.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await handler.handle('create_order', { idempotency_key: 'idem-cb-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const res = await handler.handle('submit_payment', { idempotency_key: 'idem-cb-pay', payment: { order_id: o.data.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(res.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(metrics.get('confirmation_bypass'), 1);
  assert.ok(audit.entries().some((e) => e.event === 'confirmation_blocked'));
});

test('C6: readiness scorecard is green on a clean run, red on a safety violation', async () => {
  const { handler, kernel, metrics } = makeHandler();
  await fullFlow(handler, kernel);
  let sc = readinessScorecard(metrics);
  assert.equal(sc.dimensions.NoDoubleCharge, 'green');
  assert.equal(sc.dimensions.PriceLockIntegrity, 'green');
  assert.equal(sc.dimensions.ConfirmationIntegrity, 'green');
  // simulate a violation
  metrics.inc('price_lock_violation');
  sc = readinessScorecard(metrics);
  assert.equal(sc.dimensions.PriceLockIntegrity, 'red');
});
