// cancel_checkout_session behind CHECKOUT_CANCEL_UPSTREAM_ENABLED (FIX_PLAN C-11): the backend's cancel is the
// answer. "canceled" only when the backend cancelled; every other outcome is refused in words that cannot be read as
// canceled; a foreign or unknown order is not found and reaches nothing; a session-only cancel claims the session.
// The /mcp door twin is tests/commerce_mcp_get_order_and_cancel_door.node.test.cjs at the repo root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';

const SECRET = 'exec-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1', agent_id: 'agent_a' };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};
const quiet = { info() {}, warn() {}, error() {} };

function setup({ enabled = true, answer = { kind: 'canceled' } } = {}) {
  const kernelUpstream = async (op) => (
    op === 'preview_quote' ? QUOTE : op === 'create_order' ? { order_id: 'o_cxl', acp_state: {} } : {}
  );
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const calls = [];
  const exec = createCanonicalExecutor({
    kernel,
    upstream: async () => ({}),
    cancelUpstreamEnabled: () => enabled,
    cancelUpstreamOrder: async (orderId, ctx) => {
      calls.push({ orderId, user_ref: ctx.user_ref });
      return typeof answer === 'function' ? answer() : answer;
    },
  });
  return { kernel, exec: exec.execute, calls };
}

let n = 0;
async function order(kernel, exec, ctx = CTX) {
  n += 1;
  const s = await exec('create_checkout_session', { idempotency_key: `idem-cxl-s-${n}`, quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, ctx);
  const o = await kernel.createOrder({ idempotency_key: `idem-cxl-o-${n}`, order: { quote_id: s.session_id, shipping_address: {} } }, ctx);
  return { session_id: s.session_id, order_id: o.order_id };
}

test('flag off: the gateway-row cancel, and the backend is never asked', async () => {
  const { kernel, exec, calls } = setup({ enabled: false });
  const { session_id, order_id } = await order(kernel, exec);
  const out = await exec('cancel_checkout_session', { idempotency_key: 'idem-off-1', session_id, order_id }, CTX);
  assert.deepEqual(out, { session_id, order_id, status: 'canceled' });
  assert.deepEqual(calls, []);
  // and the old behaviour for an untracked id is kept exactly (it is what the flag fixes)
  assert.deepEqual(
    await exec('cancel_checkout_session', { idempotency_key: 'idem-off-2', order_id: 'o_untracked' }, CTX),
    { session_id: null, order_id: 'o_untracked', status: 'canceled' },
  );
});

for (const kind of ['canceled', 'already_canceled']) {
  test(`flag on: backend "${kind}" -> canceled, and the kernel row follows`, async () => {
    const { kernel, exec, calls } = setup({ answer: { kind } });
    const { session_id, order_id } = await order(kernel, exec);
    const out = await exec('cancel_checkout_session', { idempotency_key: `idem-${kind}`, session_id, order_id }, CTX);
    assert.deepEqual(out, { session_id, order_id, status: 'canceled' });
    assert.deepEqual(calls, [{ orderId: order_id, user_ref: 'user_1' }]);
    assert.equal((await kernel._orderStore.get(order_id)).status, 'canceled');
  });
}

for (const [kind, code, reason] of [
  ['paid', 'OPERATION_NOT_ALLOWED', 'order_paid_not_canceled'],
  ['processing', 'OPERATION_NOT_ALLOWED', 'payment_processing_not_canceled'],
  ['unavailable', 'MERCHANT_UNAVAILABLE', 'cancel_not_confirmed'],
  ['something_new', 'MERCHANT_UNAVAILABLE', 'cancel_not_confirmed'],
  ['not_found', 'QUOTE_NOT_FOUND', 'order_not_found'],
]) {
  test(`flag on: backend "${kind}" is ${code}/${reason}, and the kernel row is untouched`, async () => {
    const { kernel, exec } = setup({ answer: { kind } });
    const { order_id } = await order(kernel, exec);
    await assert.rejects(
      exec('cancel_checkout_session', { idempotency_key: `idem-${kind}`, order_id }, CTX),
      (e) => e.code === code && e.detail?.reason === reason,
    );
    assert.equal((await kernel._orderStore.get(order_id)).status, 'created');
  });
}

test('flag on: an answer the upstream cannot give (null) is not confirmed', async () => {
  const { kernel, exec } = setup({ answer: () => null });
  const { order_id } = await order(kernel, exec);
  await assert.rejects(
    exec('cancel_checkout_session', { idempotency_key: 'idem-null', order_id }, CTX),
    (e) => e.code === 'MERCHANT_UNAVAILABLE' && e.detail?.reason === 'cancel_not_confirmed',
  );
});

test('flag on: another user, session or agent, and an untracked id, are not found and reach nothing', async () => {
  const { kernel, exec, calls } = setup();
  const { order_id } = await order(kernel, exec);
  for (const ctx of [
    { ...CTX, user_ref: 'user_2' },
    { ...CTX, acp_session_id: 'acp_2' },
    { ...CTX, agent_id: 'agent_b' },
  ]) {
    await assert.rejects(
      exec('cancel_checkout_session', { idempotency_key: 'idem-foreign', order_id }, ctx),
      (e) => e.code === 'QUOTE_NOT_FOUND' && e.detail?.reason === 'order_not_found',
    );
  }
  await assert.rejects(
    exec('cancel_checkout_session', { idempotency_key: 'idem-untracked', order_id: 'o_untracked' }, CTX),
    (e) => e.code === 'QUOTE_NOT_FOUND',
  );
  assert.deepEqual(calls, []);
  assert.equal((await kernel._orderStore.get(order_id)).status, 'created');
});

test('flag on: a session-only cancel claims the session, so it can never become an order', async () => {
  const { kernel, exec, calls } = setup();
  const s = await exec('create_checkout_session', { idempotency_key: 'idem-sess-only', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  const out = await exec('cancel_checkout_session', { idempotency_key: 'idem-sess-cxl', session_id: s.session_id }, CTX);
  assert.deepEqual(out, { session_id: s.session_id, order_id: null, status: 'canceled' });
  await assert.rejects(
    kernel.createOrder({ idempotency_key: 'idem-after-cxl', order: { quote_id: s.session_id, shipping_address: {} } }, CTX),
    (e) => e.code === 'QUOTE_ALREADY_USED',
  );
  assert.deepEqual(calls, [], 'no order exists upstream: nothing to ask');
});

test('flag on: a session-only cancel of a session that became an order is refused, naming why', async () => {
  const { kernel, exec } = setup();
  const { session_id } = await order(kernel, exec);
  await assert.rejects(
    exec('cancel_checkout_session', { idempotency_key: 'idem-sess-ordered', session_id }, CTX),
    (e) => e.code === 'OPERATION_NOT_ALLOWED' && e.detail?.reason === 'session_already_ordered',
  );
});

// The quote registry's own ownership answer, the one get_checkout_session gives for the same session.
test('flag on: another buyer cannot cancel a session they do not own', async () => {
  const { exec } = setup();
  const s = await exec('create_checkout_session', { idempotency_key: 'idem-sess-own', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  await assert.rejects(
    exec('cancel_checkout_session', { idempotency_key: 'idem-sess-foreign', session_id: s.session_id }, { ...CTX, user_ref: 'user_2' }),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH',
  );
});
