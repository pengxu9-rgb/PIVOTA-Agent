// ASSEMBLED end-to-end integration — proves the WHOLE pay path composes against REAL-shaped backend
// responses: mount (normalizeRealUpstream adapter) → kernel state machine → signed webhook handler →
// reconcile sweeper, all sharing one kernel/order store. This is the capstone that catches "the pieces
// don't compose" bugs (the class that has bitten this build repeatedly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createCommerceMount } from '../src/mount.js';
import { createPaymentWebhookHandler } from '../src/webhookHandler.js';
import { reconcilePendingOrders, makeInMemoryListPending } from '../src/reconcile.js';

const SECRET = 'assembled-secret-0123456789abcd';
const WEBHOOK_SECRET = 'assembled-webhook-secret-0123456789';
const CTX = { user_ref: 'usr_assembled', acp_session_id: 'acp_asm' };

// REAL backend shapes (pricing strings, nested order_id, payment_action checkout-session).
// `counts` (optional) records per-operation upstream call counts so a test can prove a SIDE EFFECT
// (e.g. that a rejected double-pay NEVER reached the upstream charge), not merely the response shape.
function realBackend({ counts } = {}) {
  return async (op) => {
    if (counts) counts[op] = (counts[op] || 0) + 1;
    if (op === 'find_products') return { results: [{ product_id: 'p1', title: 'Thing' }] };
    if (op === 'preview_quote') {
      return {
        quote_id: 'q_asm', expires_at: '2026-06-02T00:00:00Z', currency: 'USD',
        pricing: { subtotal: '100.00', shipping_fee: '5.00', tax: '8.00', total: '113.00' },
        payment_handlers: [{ id: 'shop_pay', type: 'dev.shopify.shop_pay' }],
        line_items: [{ variant_id: 'v1', quantity: 1 }],
      };
    }
    if (op === 'create_order') {
      return { status: 'success', order: { order_id: 'ORD_ASM', quote_id: 'q_asm', amounts: { total: '113.00', currency: 'USD' } }, payment: { psp: 'stripe' } };
    }
    if (op === 'submit_payment') {
      // Real async: returns requires_action under payment_action, with a payment_intent_id.
      return { status: 'requires_action', payment_status: 'requires_action', confirmation_owner: 'client', requires_client_confirmation: true, payment_intent_id: 'pi_asm_1', payment_action: { type: 'redirect_url', url: 'https://psp/3ds/asm', client_secret: 'cs_asm' } };
    }
    return {};
  };
}

function sign(body) { return createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body, 'utf8')).digest('base64'); }

test('FULL LIFECYCLE: quote → order → pay(requires_action) → signed webhook → paid (real shapes)', async () => {
  const counts = {};
  const mount = createCommerceMount({ upstream: realBackend({ counts }), db: null, secret: SECRET, strict: true, normalizeRealUpstream: true, log: { info() {}, warn() {}, error() {} } });
  const onWebhook = createPaymentWebhookHandler({ kernel: mount.kernel, secret: WEBHOOK_SECRET, log: { info() {}, warn() {}, error() {} } });

  // 1) read-only discovery passes through
  const search = await mount.handle('find_products', { search: { query: 'thing' } }, CTX);
  assert.equal(search.ok, true);

  // 2) preview_quote — the adapter maps pricing-strings → locked_totals numbers + merchant_of_record.
  const q = await mount.handle('preview_quote', { quote: { merchant_id: 'm_asm', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.equal(q.ok, true, q.error?.code);
  assert.equal(q.data.merchant_of_record, 'm_asm');
  assert.equal(q.data.locked_totals.total, 11300);

  // 3) create_order — adapter lifts nested order_id; charge amount from the quote snapshot (INV-5).
  const o = await mount.handle('create_order', { idempotency_key: 'idem-asm-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  assert.equal(o.ok, true, o.error?.code);
  assert.equal(o.data.order_id, 'ORD_ASM');
  assert.equal(o.data.amount_total, 11300);

  // 4) confirm + pay — real async: charge_pending, redirect_url surfaced from payment_action, NOT paid.
  const token = await mount.mintConfirmation({ order_id: o.data.order_id }, CTX);
  const pay = await mount.handle('submit_payment', { idempotency_key: 'idem-asm-pay', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 11300, currency: 'USD' } }, CTX);
  assert.equal(pay.ok, true, pay.error?.code);
  assert.equal(pay.data.order_status, 'charge_pending');
  assert.equal(pay.data.redirect_url, 'https://psp/3ds/asm');
  assert.equal(pay.data.payment_id, 'pi_asm_1', 'payment_intent_id → payment_id via the adapter');

  // 5) a SECOND pay during charge_pending is rejected (no double charge). Codex P2: prove the SIDE EFFECT —
  // the upstream submit_payment must have been called EXACTLY ONCE, so the rejection happened BEFORE the
  // charge, not after a second upstream charge that merely returned a conflict to the caller.
  assert.equal(counts.submit_payment, 1, 'first pay reached the upstream charge exactly once');
  const dbl = await mount.handle('submit_payment', { idempotency_key: 'idem-asm-pay2', confirmation_token: await mount.mintConfirmation({ order_id: o.data.order_id }, CTX), payment: { order_id: o.data.order_id, expected_amount: 11300, currency: 'USD' } }, CTX);
  assert.equal(dbl.ok, false);
  assert.equal(dbl.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(counts.submit_payment, 1, 'the rejected double-pay NEVER reached the upstream charge');

  // 6) the PSP sends a signed completion webhook (correlated by payment_intent_id) → order paid.
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_asm_1', status: 'succeeded', metadata: { order_id: o.data.order_id } } } });
  const res = await onWebhook({ headers: { 'x-pivota-webhook-signature': sign(body) }, rawBody: body });
  assert.equal(res.status, 200);
  assert.equal(res.body.transitioned, 'paid');
});

test('Codex P2: a forged webhook against a FRESH charge_pending order is rejected AND the kernel is never invoked', async () => {
  const mount = createCommerceMount({ upstream: realBackend(), db: null, secret: SECRET, strict: true, normalizeRealUpstream: true, log: { info() {}, warn() {}, error() {} } });
  // Spy on the kernel so we can prove the signature gate rejects BEFORE any state machine call.
  let kernelCalls = 0;
  const spyKernel = { onPaymentWebhook: async (e) => { kernelCalls += 1; return mount.kernel.onPaymentWebhook(e); } };
  const onWebhook = createPaymentWebhookHandler({ kernel: spyKernel, secret: WEBHOOK_SECRET, log: { info() {}, warn() {}, error() {} } });

  const q = await mount.handle('preview_quote', { quote: { merchant_id: 'm_asm', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await mount.handle('create_order', { idempotency_key: 'idem-asm-forge-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const token = await mount.mintConfirmation({ order_id: o.data.order_id }, CTX);
  await mount.handle('submit_payment', { idempotency_key: 'idem-asm-forge-pay', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 11300, currency: 'USD' } }, CTX);
  assert.equal((await mount.kernel._orderStore.get('ORD_ASM')).status, 'charge_pending');

  // Forged signature over a "succeeded" body — must be rejected 401, kernel never called, order unchanged.
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_asm_1', status: 'succeeded', metadata: { order_id: 'ORD_ASM' } } } });
  const forged = await onWebhook({ headers: { 'x-pivota-webhook-signature': 'forged' }, rawBody: body });
  assert.equal(forged.status, 401);
  assert.equal(kernelCalls, 0, 'forged webhook must NOT reach kernel.onPaymentWebhook');
  assert.equal((await mount.kernel._orderStore.get('ORD_ASM')).status, 'charge_pending', 'order state unchanged by forged webhook');
});

test('FULL LIFECYCLE via reconcile: a stuck charge_pending order is resolved by the sweeper', async () => {
  let t = 1_000_000;
  const mount = createCommerceMount({ upstream: realBackend(), db: null, secret: SECRET, strict: true, normalizeRealUpstream: true, now: () => t, log: { info() {}, warn() {}, error() {} } });
  const q = await mount.handle('preview_quote', { quote: { merchant_id: 'm_asm', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await mount.handle('create_order', { idempotency_key: 'idem-asm-rec-order', order: { quote_id: q.data.quote_id, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } } }, CTX);
  const token = await mount.mintConfirmation({ order_id: o.data.order_id }, CTX);
  await mount.handle('submit_payment', { idempotency_key: 'idem-asm-rec-pay', confirmation_token: token, payment: { order_id: o.data.order_id, expected_amount: 11300, currency: 'USD' } }, CTX);

  // No webhook ever arrives. Advance time; the sweeper queries the PSP (authoritative) and resolves it.
  t += 15 * 60 * 1000;
  const summary = await reconcilePendingOrders({
    kernel: mount.kernel,
    listPending: makeInMemoryListPending(mount.kernel._orderStore),
    queryStatus: async (ord) => (ord.payment_id === 'pi_asm_1' ? 'succeeded' : null),
    now: () => t, maxAgeMs: 10 * 60 * 1000, log: { info() {} },
  });
  assert.deepEqual(summary.reconciled, [{ order_id: 'ORD_ASM', to: 'paid' }]);
  const order = await mount.kernel._orderStore.get('ORD_ASM');
  assert.equal(order.status, 'paid');
});

test('strict OFF: the assembled mount leaves every op on the legacy path (handles() === false)', async () => {
  const mount = createCommerceMount({ upstream: realBackend(), secret: SECRET, strict: false, normalizeRealUpstream: true, log: { info() {}, warn() {}, error() {} } });
  for (const op of ['preview_quote', 'create_order', 'submit_payment', 'request_after_sales', 'find_products']) {
    assert.equal(mount.handles(op), false);
  }
});
