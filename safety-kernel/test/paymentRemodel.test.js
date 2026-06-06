// Payment-flow re-model regression tests — the async checkout-session / webhook model.
// These pin the SAFETY-CRITICAL behavior: an in-flight charge must NEVER allow a second charge, and
// completion arrives via webhook. See docs/agent-checkout/payment-flow-remodel.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel, classifyPaymentStatus } from '../src/kernel.js';

const SECRET = 'remodel-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};

// upstream whose submit_payment status is configurable; counts charge calls.
function makeKernel(submitStatus = 'succeeded', extra = {}) {
  let charges = 0;
  const upstream = async (op) => (
    op === 'preview_quote' ? QUOTE
    : op === 'create_order' ? { order_id: 'o_rm', acp_state: {} }
    : op === 'submit_payment' ? (charges++, { order_id: 'o_rm', payment_id: 'pay1', payment_status: submitStatus, ...extra })
    : {}
  );
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  return { kernel, charges: () => charges };
}

async function orderWithTokens(kernel, n = 2) {
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-rm-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const tokens = [];
  for (let i = 0; i < n; i++) tokens.push(await kernel.mintConfirmation({ order_id: o.order_id }, CTX));
  return { order_id: o.order_id, tokens };
}

test('classifyPaymentStatus: success / failure / in_flight buckets', () => {
  for (const s of ['succeeded', 'paid', 'captured', 'completed']) assert.equal(classifyPaymentStatus(s), 'success');
  for (const s of ['payment_failed', 'failed', 'declined', 'cancelled']) assert.equal(classifyPaymentStatus(s), 'failure');
  for (const s of ['processing', 'requires_action', 'pending', 'unknown', '', undefined]) assert.equal(classifyPaymentStatus(s), 'in_flight');
});

test('async pending: requires_action → order charge_pending, NOT paid; charged once', async () => {
  const { kernel, charges } = makeKernel('requires_action', { confirmation_owner: 'client', requires_client_confirmation: true, redirect_url: 'https://psp/3ds' });
  const { order_id, tokens } = await orderWithTokens(kernel);
  const pay = await kernel.submitPayment({ idempotency_key: 'idem-rm-pay', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(pay.payment_status, 'requires_action');
  assert.equal(pay.order_status, 'charge_pending');
  assert.equal(pay.redirect_url, 'https://psp/3ds');
  assert.equal(charges(), 1);
});

test('T7: order bound to its ACP session — a same-user request in a DIFFERENT session cannot touch it', async () => {
  const { kernel } = makeKernel('succeeded');
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-t7-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const otherSession = { user_ref: CTX.user_ref, acp_session_id: 'acp_OTHER' };
  await assert.rejects(
    kernel.mintConfirmation({ order_id: o.order_id }, otherSession),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH' && e.detail?.reason === 'acp_session_mismatch',
  );
});

test('T7: order bound to its agent — a same-user/session request from a DIFFERENT agent cannot touch it', async () => {
  const { kernel } = makeKernel('succeeded');
  const ctxA = { user_ref: 'user_1', acp_session_id: 'acp_1', agent_id: 'chatgpt' };
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm', items: [{ product_id: 'p1', quantity: 1 }] } }, ctxA);
  const o = await kernel.createOrder({ idempotency_key: 'idem-t7-agent', order: { quote_id: q.quote_id, shipping_address: {} } }, ctxA);
  const ctxB = { user_ref: 'user_1', acp_session_id: 'acp_1', agent_id: 'gemini' };
  await assert.rejects(
    kernel.mintConfirmation({ order_id: o.order_id }, ctxB),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH' && e.detail?.reason === 'agent_mismatch',
  );
});

test('Codex P2-2: a NaN expected_amount echo is REJECTED in-process (never reaches the charge)', async () => {
  const { kernel, charges } = makeKernel('succeeded');
  const { order_id, tokens } = await orderWithTokens(kernel);
  // typeof NaN === 'number' AND Math.abs(NaN - 113) > 0 is false — without Number.isSafeInteger this
  // would slip past the amount check. It must fail closed, and the upstream charge must NOT be called.
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'idem-nan', confirmation_token: tokens[0], payment: { order_id, expected_amount: NaN, currency: 'USD' } }, CTX),
    (e) => e.code === 'PRICE_CHANGED',
  );
  assert.equal(charges(), 0, 'no upstream charge for a rejected NaN echo');
});

test('P0: a second submit (different key/token) for a charge_pending order is REJECTED, not re-charged', async () => {
  const { kernel, charges } = makeKernel('requires_action');
  const { order_id, tokens } = await orderWithTokens(kernel, 2);
  await kernel.submitPayment({ idempotency_key: 'idem-rm-A', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'idem-rm-B', confirmation_token: tokens[1], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT' && e.detail?.reason === 'charge_pending',
  );
  assert.equal(charges(), 1, 'upstream charged exactly once — no double charge during pending');
});

test('webhook success: charge_pending → paid; idempotent on duplicate webhook', async () => {
  const { kernel } = makeKernel('requires_action');
  const { order_id, tokens } = await orderWithTokens(kernel);
  await kernel.submitPayment({ idempotency_key: 'idem-rm-wh', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  const r1 = await kernel.onPaymentWebhook({ order_id, status: 'succeeded', payment_id: 'pay1' });
  assert.equal(r1.transitioned, 'paid');
  const r2 = await kernel.onPaymentWebhook({ order_id, status: 'succeeded', payment_id: 'pay1' }); // duplicate
  assert.equal(r2.idempotent, true);
  // defense in depth (Codex P0): a confirmation can no longer be MINTED for a paid order
  await assert.rejects(
    kernel.mintConfirmation({ order_id }, CTX),
    (e) => e.code === 'OPERATION_NOT_ALLOWED' && e.detail?.reason === 'not_confirmable:paid',
  );
  // and even a pre-minted (still-valid) token cannot re-charge a paid order — submitPayment rejects it
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'idem-rm-after', confirmation_token: tokens[1], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX),
    (e) => e.detail?.reason === 'order_already_paid',
  );
});

test('webhook failure: charge_pending → failed; a retry submit is then ALLOWED', async () => {
  const { kernel, charges } = makeKernel('requires_action');
  const { order_id, tokens } = await orderWithTokens(kernel, 2);
  await kernel.submitPayment({ idempotency_key: 'idem-rm-f1', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  const wh = await kernel.onPaymentWebhook({ order_id, status: 'payment_failed', payment_id: 'pay1' });
  assert.equal(wh.transitioned, 'failed');
  // retry now permitted (status 'failed' admits a new submit)
  const retry = await kernel.submitPayment({ idempotency_key: 'idem-rm-f2', confirmation_token: tokens[1], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(retry.order_status, 'charge_pending');
  assert.equal(charges(), 2, 'retry after failure issues a fresh charge');
});

test('webhook: paid is STICKY — a stray later failure webhook does not un-pay', async () => {
  const { kernel } = makeKernel('succeeded');
  const { order_id, tokens } = await orderWithTokens(kernel);
  await kernel.submitPayment({ idempotency_key: 'idem-rm-sticky', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  // synchronous success already marked paid
  const wh = await kernel.onPaymentWebhook({ order_id, status: 'payment_failed', payment_id: 'pay1' });
  assert.equal(wh.idempotent, true, 'paid order ignores a later failure webhook');
});

test('Codex P1-1: a webhook with NO payment_id on a charge_pending order is IGNORED (correlation required)', async () => {
  const { kernel } = makeKernel('requires_action');
  const { order_id, tokens } = await orderWithTokens(kernel);
  await kernel.submitPayment({ idempotency_key: 'idem-corr-pay', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  const r = await kernel.onPaymentWebhook({ order_id, status: 'succeeded' }); // no payment_id
  assert.equal(r.ignored, true);
  assert.equal(r.reason, 'uncorrelated_attempt');
  const order = await kernel._orderStore.get(order_id);
  assert.equal(order.status, 'charge_pending', 'order NOT marked paid without correlation');
});

test('webhook: unknown order is ignored (no-op)', async () => {
  const { kernel } = makeKernel();
  const r = await kernel.onPaymentWebhook({ order_id: 'does_not_exist', status: 'succeeded' });
  assert.equal(r.ignored, true);
});

test('synchronous success still works (backward compatible): order marked paid immediately', async () => {
  const { kernel } = makeKernel('succeeded');
  const { order_id, tokens } = await orderWithTokens(kernel);
  const pay = await kernel.submitPayment({ idempotency_key: 'idem-rm-sync', confirmation_token: tokens[0], payment: { order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  assert.equal(pay.payment_status, 'succeeded');
  assert.equal(pay.order_status, 'paid');
});

const quiet = { info() {}, warn() {}, error() {} };

test('Codex P0-1: lock TTL expiring mid-charge does NOT allow a second charge (durable charge_pending guards)', async () => {
  let t = 1_000_000;
  let release; const gate = new Promise((r) => { release = r; });
  let started = 0, charges = 0;
  const upstream = async (op) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') return { order_id: 'o_ttl', acp_state: {} };
    if (op === 'submit_payment') { charges++; started++; if (started === 1) await gate; return { payment_id: `pi_${started}`, payment_status: 'requires_action' }; }
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, now: () => t, log: quiet });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-ttl-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const tA = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  const tB = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  const results = [];
  const collect = (p) => p.then((v) => results.push({ ok: true }), (e) => results.push({ ok: false, reason: e.detail?.reason }));
  const pA = collect(kernel.submitPayment({ idempotency_key: 'idem-ttl-A', confirmation_token: tA, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX));
  await new Promise((r) => setImmediate(r)); // A acquires lock, writes charge_pending, blocks in upstream
  t += 3 * 60 * 1000; // advance PAST the lock TTL — the lock is now free
  const pB = collect(kernel.submitPayment({ idempotency_key: 'idem-ttl-B', confirmation_token: tB, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX));
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([pA, pB]);
  assert.equal(charges, 1, 'B did NOT charge — durable charge_pending blocked it despite the free lock');
  assert.ok(results.some((r) => !r.ok && r.reason === 'charge_pending'), 'B rejected with charge_pending');
});

test('Codex P0-2: an upstream timeout AFTER charge_pending is written leaves the order locked (no reopen)', async () => {
  let charges = 0;
  const upstream = async (op) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') return { order_id: 'o_to', acp_state: {} };
    if (op === 'submit_payment') { charges++; throw new Error('socket timeout (PSP may have accepted)'); }
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: quiet });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-to-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const tA = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  const tB = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  await assert.rejects(kernel.submitPayment({ idempotency_key: 'idem-to-A', confirmation_token: tA, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX));
  const order = await kernel._orderStore.get('o_to');
  assert.equal(order.status, 'charge_pending', 'fail closed: ambiguous timeout leaves the order locked, not reopened');
  await assert.rejects(
    kernel.submitPayment({ idempotency_key: 'idem-to-B', confirmation_token: tB, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX),
    (e) => e.detail?.reason === 'charge_pending',
  );
  assert.equal(charges, 1, 'only ONE upstream charge attempt despite the ambiguous timeout');
});

test('Codex P0-3: a stale failure webhook for a PREVIOUS attempt cannot corrupt a live retry', async () => {
  let n = 0;
  const upstream = async (op) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') return { order_id: 'o_stale', acp_state: {} };
    if (op === 'submit_payment') { n++; return { payment_id: `pi_${n}`, payment_status: 'requires_action' }; }
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: quiet });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-stale-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  // Attempt A → charge_pending(pi_1); A fails via webhook.
  await kernel.submitPayment({ idempotency_key: 'idem-stale-A', confirmation_token: await kernel.mintConfirmation({ order_id: o.order_id }, CTX), payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  await kernel.onPaymentWebhook({ order_id: o.order_id, status: 'payment_failed', payment_id: 'pi_1' });
  // Retry B → charge_pending(pi_2).
  await kernel.submitPayment({ idempotency_key: 'idem-stale-B', confirmation_token: await kernel.mintConfirmation({ order_id: o.order_id }, CTX), payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX);
  // STALE webhook for A (pi_1) arrives — must be IGNORED, must not touch B's live attempt.
  const stale = await kernel.onPaymentWebhook({ order_id: o.order_id, status: 'payment_failed', payment_id: 'pi_1' });
  assert.equal(stale.ignored, true);
  assert.equal(stale.reason, 'stale_attempt');
  // B's own success webhook (pi_2) → paid.
  const good = await kernel.onPaymentWebhook({ order_id: o.order_id, status: 'succeeded', payment_id: 'pi_2' });
  assert.equal(good.transitioned, 'paid');
});

test('Codex P1: a webhook for a never-submitted (created) order is ignored (cannot mark paid)', async () => {
  const { kernel } = makeKernel();
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-created-o', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const r = await kernel.onPaymentWebhook({ order_id: o.order_id, status: 'succeeded', payment_id: 'pi_x' });
  assert.equal(r.ignored, true);
  assert.match(r.reason, /not_pending/);
});

test('CONCURRENT submits for the same order: exactly one charges (lock-first closes TOCTOU)', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let started = 0, charges = 0;
  const upstream = async (op) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') return { order_id: 'o_cc', acp_state: {} };
    if (op === 'submit_payment') { charges++; started++; if (started === 1) await gate; return { payment_id: 'p', payment_status: 'requires_action' }; }
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: SECRET, log: { info() {}, warn() {}, error() {} } });
  const q = await kernel.previewQuote({ quote: {} }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-cc-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const t1 = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  const t2 = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  // Chain the result/rejection handler at CREATION so a rejection is never momentarily unhandled
  // (node:test fails a test on any transient unhandled rejection).
  const results = [];
  const collect = (p) => p.then((v) => results.push({ ok: true, v }), (e) => results.push({ ok: false, code: e.code }));
  const pay1 = collect(kernel.submitPayment({ idempotency_key: 'k-cc-key-1', confirmation_token: t1, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX));
  await new Promise((r) => setImmediate(r)); // let pay1 acquire the charge lock + block on the gate
  const pay2 = collect(kernel.submitPayment({ idempotency_key: 'k-cc-key-2', confirmation_token: t2, payment: { order_id: o.order_id, expected_amount: 113, currency: 'USD' } }, CTX));
  release();
  await Promise.all([pay1, pay2]);
  assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one submit succeeds');
  assert.equal(results.filter((r) => !r.ok).length, 1, 'the concurrent one is rejected');
  assert.equal(charges, 1, 'upstream charged exactly once despite concurrency');
});
