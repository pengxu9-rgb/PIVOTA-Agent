// Wave 3 — kernel-side after-sales + durable-store seam tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createInvokeHandler } from '../src/invokeHandler.js';
import { InMemoryKvStore } from '../src/stores.js';

const SECRET = 'wave3-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE_UPSTREAM = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};

function makeKernel(afterSalesSupported) {
  let refunds = 0;
  const upstream = async (op) => (
    op === 'preview_quote' ? QUOTE_UPSTREAM
    : op === 'create_order' ? { order_id: 'o1', acp_state: {} }
    : op === 'request_after_sales' ? (refunds++, { request_id: 'r1', status: 'received', message: 'ok' })
    : {}
  );
  const kernel = new SafetyKernel({ upstream, secret: SECRET, afterSalesSupported, log: { info() {}, warn() {}, error() {} } });
  return { kernel, refundCount: () => refunds };
}

async function order(kernel) {
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  return kernel.createOrder({ idempotency_key: 'idem-as-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
}

test('after-sales: refund (supported) succeeds and is ownership-checked', async () => {
  const { kernel } = makeKernel();
  const o = await order(kernel);
  const r = await kernel.requestAfterSales({ idempotency_key: 'idem-as-1', status: { order_id: o.order_id, requested_action: 'refund', reason: 'x' } }, CTX);
  assert.equal(r.status, 'received');
  assert.equal(r.merchant_of_record, 'merch_A');
});

test('after-sales: unsupported action (exchange) is refused, never forwarded', async () => {
  const { kernel, refundCount } = makeKernel(); // default supports refund only
  const o = await order(kernel);
  await assert.rejects(
    kernel.requestAfterSales({ idempotency_key: 'idem-as-2', status: { order_id: o.order_id, requested_action: 'exchange' } }, CTX),
    (e) => e.code === 'OPERATION_NOT_ALLOWED',
  );
  assert.equal(refundCount(), 0, 'upstream not called for unsupported action');
});

test('after-sales: another user cannot request on an order they do not own', async () => {
  const { kernel } = makeKernel();
  const o = await order(kernel);
  await assert.rejects(
    kernel.requestAfterSales({ idempotency_key: 'idem-as-3', status: { order_id: o.order_id, requested_action: 'refund' } }, { user_ref: 'user_2', acp_session_id: 'acp_1' }),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH',
  );
});

test('after-sales: idempotent replay does not double-refund', async () => {
  const { kernel, refundCount } = makeKernel();
  const o = await order(kernel);
  const args = { idempotency_key: 'idem-as-4', status: { order_id: o.order_id, requested_action: 'refund' } };
  await kernel.requestAfterSales(args, CTX);
  await kernel.requestAfterSales(args, CTX);
  assert.equal(refundCount(), 1, 'refund issued exactly once on replay');
});

test('after-sales: a merchant that supports return allows it', async () => {
  const { kernel } = makeKernel(new Set(['refund', 'return']));
  const o = await order(kernel);
  const r = await kernel.requestAfterSales({ idempotency_key: 'idem-as-5', status: { order_id: o.order_id, requested_action: 'return' } }, CTX);
  assert.equal(r.requested_action, 'return');
});

test('after-sales via invokeHandler routes through the kernel (gated)', async () => {
  const { kernel } = makeKernel();
  const upstream = async () => ({});
  const handler = createInvokeHandler({ kernel, upstream, log: { info() {}, warn() {}, error() {} } });
  const o = await order(kernel);
  const res = await handler.handle('request_after_sales', { idempotency_key: 'idem-as-6', status: { order_id: o.order_id, requested_action: 'exchange' } }, CTX);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'OPERATION_NOT_ALLOWED');
});

// --- durable-store seam ---

test('InMemoryKvStore: putIfAbsent is atomic check-and-set', async () => {
  const s = new InMemoryKvStore();
  assert.equal(await s.putIfAbsent('k', 1), true);
  assert.equal(await s.putIfAbsent('k', 2), false, 'second put refused');
  assert.equal(await s.get('k'), 1);
});

test('InMemoryKvStore: TTL expires entries', async () => {
  let t = 1000;
  const s = new InMemoryKvStore({ now: () => t });
  await s.set('k', 'v', { ttlMs: 100 });
  assert.equal(await s.get('k'), 'v');
  t += 200;
  assert.equal(await s.get('k'), undefined, 'expired');
  assert.equal(await s.putIfAbsent('k', 'v2'), true, 'expired key can be re-claimed');
});
