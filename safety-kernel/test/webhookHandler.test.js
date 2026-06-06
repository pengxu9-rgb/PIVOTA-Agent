// Payment webhook handler tests — signature verification (security) + kernel dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createPaymentWebhookHandler, verifyWebhookSignature } from '../src/webhookHandler.js';
import { SafetyKernel } from '../src/kernel.js';

const SECRET = 'webhook-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [], acp_state: { acp_session_id: 'acp_1' },
};

// A kernel with an order already in charge_pending(payment_id=pi_1).
async function pendingOrderKernel() {
  const upstream = async (op) => (
    op === 'preview_quote' ? QUOTE
    : op === 'create_order' ? { order_id: 'o_wh', acp_state: {} }
    : op === 'submit_payment' ? { payment_id: 'pi_1', payment_status: 'requires_action' }
    : {}
  );
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-wh-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const token = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  await kernel.submitPayment({ idempotency_key: 'idem-wh-pay', confirmation_token: token, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  return { kernel, order_id: o.order_id };
}

function sign(body) {
  return createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('base64');
}

test('verifyWebhookSignature: accepts a correct HMAC, rejects tampering / empty', () => {
  const body = '{"a":1}';
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
  assert.equal(verifyWebhookSignature(body + ' ', sign(body), SECRET), false);
  assert.equal(verifyWebhookSignature(body, '', SECRET), false);
  assert.equal(verifyWebhookSignature(body, sign(body), 'wrong-secret-0123456789'), false);
});

test('constructor requires a kernel + strong secret', () => {
  assert.throws(() => createPaymentWebhookHandler({ secret: SECRET }));
  assert.throws(() => createPaymentWebhookHandler({ kernel: { onPaymentWebhook() {} }, secret: 'short' }));
});

test('valid signed success webhook → 200, order marked paid', async () => {
  const { kernel, order_id } = await pendingOrderKernel();
  const handler = createPaymentWebhookHandler({ kernel, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const body = JSON.stringify({ order_id, status: 'succeeded', payment_id: 'pi_1' });
  const res = await handler({ headers: { 'x-pivota-webhook-signature': sign(body) }, rawBody: body });
  assert.equal(res.status, 200);
  assert.equal(res.body.transitioned, 'paid');
  // duplicate (idempotent) → 200, idempotent
  const res2 = await handler({ headers: { 'x-pivota-webhook-signature': sign(body) }, rawBody: body });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.idempotent, true);
});

test('SECURITY: a mis-signed webhook is rejected 401 and the kernel is NEVER called', async () => {
  let called = false;
  const kernel = { onPaymentWebhook: async () => { called = true; return {}; } };
  const handler = createPaymentWebhookHandler({ kernel, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const body = JSON.stringify({ order_id: 'o_wh', status: 'succeeded' });
  const res = await handler({ headers: { 'x-pivota-webhook-signature': 'forged' }, rawBody: body });
  assert.equal(res.status, 401);
  assert.equal(called, false, 'kernel.onPaymentWebhook must not run for a bad signature');
});

test('SECURITY: a missing signature header is rejected 401', async () => {
  const handler = createPaymentWebhookHandler({ kernel: { onPaymentWebhook: async () => ({}) }, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const body = JSON.stringify({ order_id: 'o', status: 'succeeded' });
  const res = await handler({ headers: {}, rawBody: body });
  assert.equal(res.status, 401);
});

test('a signed-but-invalid-JSON body → 400', async () => {
  const handler = createPaymentWebhookHandler({ kernel: { onPaymentWebhook: async () => ({}) }, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const body = 'not json';
  const res = await handler({ headers: { 'x-pivota-webhook-signature': sign(body) }, rawBody: body });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_json');
});

test('a signed event with no order_id → 400 (unparseable)', async () => {
  const handler = createPaymentWebhookHandler({ kernel: { onPaymentWebhook: async () => ({}) }, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const body = JSON.stringify({ status: 'succeeded' });
  const res = await handler({ headers: { 'x-pivota-webhook-signature': sign(body) }, rawBody: body });
  assert.equal(res.status, 400);
});

test('Codex P2-2: a signed webhook for an unknown order returns a RETRYABLE 404 (not a silent 200)', async () => {
  let warned = false;
  const kernel = { onPaymentWebhook: async () => ({ ignored: true, reason: 'unknown_order' }) };
  const handler = createPaymentWebhookHandler({ kernel, secret: SECRET, log: { info() {}, warn() { warned = true; }, error() {} } });
  const body = JSON.stringify({ order_id: 'o_missing', status: 'succeeded', payment_id: 'pi_1' });
  const res = await handler({ headers: { 'x-pivota-webhook-signature': sign(body) }, rawBody: body });
  assert.equal(res.status, 404, 'unknown order → retryable 404 so the PSP retries (handles replication lag / misconfig)');
  assert.equal(warned, true, 'and it alerts at warn level');
});

test('default parser extracts order_id/status/payment_id from a nested data.object (Stripe-like)', async () => {
  const { kernel, order_id } = await pendingOrderKernel();
  const handler = createPaymentWebhookHandler({ kernel, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', status: 'succeeded', metadata: { order_id } } } });
  const res = await handler({ headers: { 'x-pivota-webhook-signature': sign(body) }, rawBody: body });
  assert.equal(res.status, 200);
  assert.equal(res.body.transitioned, 'paid');
});
