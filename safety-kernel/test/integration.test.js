// Wave 1.5 tests — contract validation (C3) + kernel-behind-invoke integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createInvokeHandler } from '../src/invokeHandler.js';
import { validateCanonical } from '../src/contractValidation.js';

const SECRET = 'integration-secret-0123456789abcd';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE_UPSTREAM = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};

function makeHandler() {
  const upstreamCalls = [];
  const upstream = async (op, payload, headers) => {
    upstreamCalls.push({ op, headers });
    if (op === 'preview_quote') return QUOTE_UPSTREAM;
    if (op === 'create_order') return { order_id: 'o1', acp_state: {} };
    if (op === 'submit_payment') return { order_id: 'o1', payment_id: 'pay1', payment_status: 'succeeded', ap2_state: { mandate_id: 'm1' } };
    if (op === 'find_products') return { results: [] };
    if (op === 'request_after_sales') return { request_id: 'r1', status: 'received' };
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const handler = createInvokeHandler({ kernel, upstream, log: { info() {}, warn() {}, error() {} } });
  return { handler, kernel, upstreamCalls };
}

// ---- C3 contract validation ----

test('C3: get_product_detail requires merchant_id + product_id (drift #1)', () => {
  assert.throws(() => validateCanonical('get_product_detail', { product: { product_id: 'p1' } }), (e) => e.code === 'OPERATION_NOT_ALLOWED');
  assert.equal(validateCanonical('get_product_detail', { product: { merchant_id: 'm', product_id: 'p1' } }) !== null, true);
});

test('C3: create_order requires quote_id and idempotency_key (drift #2 + INV-4)', () => {
  assert.throws(() => validateCanonical('create_order', { idempotency_key: 'k-12345678', order: { shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }), (e) => e.code === 'QUOTE_REQUIRED');
  assert.throws(() => validateCanonical('create_order', { order: { quote_id: 'q1', shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
});

test('C3: submit_payment requires confirmation_token + numeric expected_amount echo (drift #3)', () => {
  assert.throws(() => validateCanonical('submit_payment', { idempotency_key: 'k-12345678', payment: { order_id: 'o1', expected_amount: 113, currency: 'USD' } }), (e) => e.code === 'CONFIRMATION_REQUIRED');
  assert.throws(() => validateCanonical('submit_payment', { idempotency_key: 'k-12345678', confirmation_token: 't', payment: { order_id: 'o1', currency: 'USD' } }), (e) => e.code === 'PRICE_CHANGED');
});

test('C3: request_after_sales rejects unsupported actions (refund only today)', () => {
  assert.throws(() => validateCanonical('request_after_sales', { idempotency_key: 'k-12345678', status: { order_id: 'o1', requested_action: 'exchange' } }), (e) => e.code === 'OPERATION_NOT_ALLOWED');
  assert.equal(validateCanonical('request_after_sales', { idempotency_key: 'k-12345678', status: { order_id: 'o1', requested_action: 'refund' } }) !== null, true);
});

test('C3: discovery reads have no strict rules (pass-through)', () => {
  assert.equal(validateCanonical('find_products', { search: {} }), null);
});

// ---- Kernel-behind-invoke integration ----

test('integration: full happy path quote->order->confirm->pay routes through the kernel', async () => {
  const { handler, kernel } = makeHandler();
  const q = await handler.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.equal(q.ok, true);
  const o = await handler.handle('create_order', { idempotency_key: 'idem-int-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  assert.equal(o.ok, true);
  assert.equal(o.data.amount_total, 113);
  const token = await kernel.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const pay = await handler.handle('submit_payment', { idempotency_key: 'idem-int-pay', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(pay.ok, true);
  assert.equal(pay.data.payment_status, 'succeeded');
});

test('integration: validation failure returns a structured error, not a throw', async () => {
  const { handler } = makeHandler();
  const res = await handler.handle('create_order', { idempotency_key: 'idem-valid-key-1', order: { shipping_address: {} } }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'QUOTE_REQUIRED');
});

test('integration: discovery is forwarded straight to upstream (not through kernel)', async () => {
  const { handler, upstreamCalls } = makeHandler();
  const res = await handler.handle('find_products', { search: { query: 'x' } }, CTX);
  assert.equal(res.ok, true);
  assert.ok(upstreamCalls.some((c) => c.op === 'find_products'));
});

test('integration: a model amount cannot lower the charge end-to-end', async () => {
  const { handler, kernel } = makeHandler();
  const q = await handler.handle('preview_quote', { quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await handler.handle('create_order', { idempotency_key: 'idem-lie-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const token = await kernel.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const pay = await handler.handle('submit_payment', { idempotency_key: 'idem-lie-pay', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 1, currency: 'USD' } }, CTX);
  assert.equal(pay.ok, false);
  assert.equal(pay.error.code, 'PRICE_CHANGED');
});
