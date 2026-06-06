// Regression tests for the defects Codex found in the C-track review (REVIEW_by_codex_of_Ctrack.md).
// Each test pins a fix so the hole cannot silently reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createInvokeHandler } from '../src/invokeHandler.js';
import { validateCanonical } from '../src/contractValidation.js';
import { toAp2Payment, getAp2State, assertAcpLinkage } from '../src/acpAp2.js';
import { AuditLog, CommerceMetrics, readinessScorecard } from '../src/audit.js';

const SECRET = 'ctrack-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE_UPSTREAM = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};
const ADDR = { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' };

function makeHandler() {
  const calls = [];
  const upstream = async (op, payload) => {
    calls.push({ op, payload });
    if (op === 'preview_quote') return QUOTE_UPSTREAM;
    if (op === 'create_order') return { order_id: 'o1', acp_state: {} };
    if (op === 'submit_payment') return { order_id: 'o1', payment_id: 'pay1', payment_status: 'succeeded' };
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const handler = createInvokeHandler({ kernel, upstream, log: { info() {}, warn() {}, error() {} } });
  return { handler, kernel, calls };
}

async function quoteAndOrder(handler) {
  const q = await handler.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await handler.handle('create_order', { idempotency_key: 'idem-co-1', order: { quote_id: q.data.quote_id, shipping_address: ADDR } }, CTX);
  return o.data.order_id;
}

// P0-1: currency cannot be swapped under a valid amount + token.
test('P0-1: paying a USD order with currency:EUR (same number) is rejected', async () => {
  const { handler, kernel } = makeHandler();
  const order_id = await quoteAndOrder(handler);
  const token = await kernel.mintConfirmation({ order_id }, CTX);
  const res = await handler.handle('submit_payment', { idempotency_key: 'idem-eur', confirmation_token: token, payment: { order_id, expected_amount: 113, currency: 'EUR' } }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PRICE_CHANGED');
});

// P0-1 cont: upstream receives the server-pinned amount/currency, not a model-supplied one.
test('P0-1: upstream payment is pinned to the order amount/currency', async () => {
  const { handler, kernel, calls } = makeHandler();
  const order_id = await quoteAndOrder(handler);
  const token = await kernel.mintConfirmation({ order_id }, CTX);
  await handler.handle('submit_payment', { idempotency_key: 'idem-pin', confirmation_token: token, payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  const payCall = calls.find((c) => c.op === 'submit_payment');
  assert.equal(payCall.payload.payment.expected_amount, 113);
  assert.equal(payCall.payload.payment.currency, 'USD');
});

// P0-2: an unknown/legacy mutating op must NOT pass through to upstream.
test('P0-2: confirm_payment (legacy money op) is refused, not forwarded', async () => {
  const { handler, calls } = makeHandler();
  const res = await handler.handle('confirm_payment', { payment: { order_id: 'o1' } }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OPERATION_NOT_ALLOWED');
  assert.ok(!calls.some((c) => c.op === 'confirm_payment'), 'must not reach upstream');
});

test('P0-2: a known discovery op still passes through', async () => {
  const { handler, calls } = makeHandler();
  const res = await handler.handle('get_order_status', { status: { order_id: 'o1' } }, CTX);
  assert.equal(res.ok, true);
});

// P1-1: closed payment payload — an extra money-source field is rejected.
test('P1-1: submit_payment with an extra quote_id field is rejected', () => {
  assert.throws(
    () => validateCanonical('submit_payment', { idempotency_key: 'k-12345678', confirmation_token: 't', payment: { order_id: 'o1', expected_amount: 1, currency: 'USD', quote_id: 'q_evil' } }),
    (e) => e.code === 'PRICE_CHANGED',
  );
});

// P1-2: after-sales requires an explicit supported action (missing != refund).
test('P1-2: request_after_sales with NO action is refused (not defaulted to refund)', async () => {
  const { handler } = makeHandler();
  const order_id = await quoteAndOrder(handler);
  const res = await handler.handle('request_after_sales', { idempotency_key: 'idem-noact', status: { order_id } }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OPERATION_NOT_ALLOWED');
});

// P1-3: full-body after-sales fingerprint — same key + different refund body conflicts.
test('P1-3: after-sales same key + different body => IDEMPOTENCY_CONFLICT', async () => {
  const { kernel } = makeHandler();
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-aso-1', order: { quote_id: q.quote_id, shipping_address: ADDR } }, CTX);
  await kernel.requestAfterSales({ idempotency_key: 'k-as-key-1', status: { order_id: o.order_id, requested_action: 'refund', amount: 50 } }, CTX);
  await assert.rejects(
    kernel.requestAfterSales({ idempotency_key: 'k-as-key-1', status: { order_id: o.order_id, requested_action: 'refund', amount: 113 } }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
});

// Fix-Wave A P0-2: after-sales is a closed payload — a caller amount field can't ride along.
test("FWA-P0-2: request_after_sales with status.amount is rejected (closed payload)", () => {
  assert.throws(
    () => validateCanonical("request_after_sales", { idempotency_key: "k-12345678", status: { order_id: "o1", requested_action: "refund", amount: 9999 } }),
    (e) => e.code === "OPERATION_NOT_ALLOWED",
  );
});
test("FWA-P0-2: request_after_sales with a root refund field is rejected", () => {
  assert.throws(
    () => validateCanonical("request_after_sales", { idempotency_key: "k-12345678", refund: { amount: 9999 }, status: { order_id: "o1", requested_action: "refund" } }),
    (e) => e.code === "OPERATION_NOT_ALLOWED",
  );
});

// P2-6: a token accidentally placed in idempotency_key is redacted in the audit entry.
test('P2-6: audit redacts a PAN-shaped value placed in a top-level field', () => {
  const audit = new AuditLog();
  audit.record('order_created', { user_ref: 'u1', order_id: 'o1', idempotency_key: '4242424242424242' });
  const blob = JSON.stringify(audit.entries());
  assert.ok(!blob.includes('4242424242424242'), 'PAN-shaped idempotency_key must be masked');
});

// P2-7: zero traffic is 'unknown', not 'green'.
test('P2-7: readiness scorecard reads unknown (not green) with zero traffic', () => {
  const sc = readinessScorecard(new CommerceMetrics());
  assert.equal(sc.exercised, false);
  assert.equal(sc.dimensions.NoDoubleCharge, 'unknown');
  assert.equal(sc.dimensions.PriceLockIntegrity, 'unknown');
});

// P2-8: ap2_state does not leak through a generic stringify of the AP2 view.
test('P2-8: toAp2Payment view does not leak ap2_state on JSON.stringify', () => {
  const view = toAp2Payment({ payment_id: 'pay1', payment_status: 'succeeded', ap2_state: { mandate_id: 'm', token: 'SECRET' } });
  assert.ok(!JSON.stringify(view).includes('SECRET'), 'ap2_state must be non-enumerable');
  assert.deepEqual(getAp2State(view), { mandate_id: 'm', token: 'SECRET' }, 'still reachable explicitly');
});

// P3-3: linkage fails closed when a session is expected but missing.
test('P3-3: assertAcpLinkage fails closed on a missing inbound session', () => {
  assert.throws(() => assertAcpLinkage({}, 'acp_1'), (e) => e.code === 'STATE_LINKAGE_MISMATCH');
  assert.equal(assertAcpLinkage({}, 'acp_1', { allowMissing: true }), true);
});
