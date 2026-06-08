// Canonical executor tests — the one execution bridge. Proves it enforces the contract's safety flags
// (deny without user_ref; require idempotency on mutations; require verified payment authz on complete) and
// routes canonical ops to the kernel with charge-once intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createPaymentAuthorizationVerifier } from '../src/protocol/paymentAuthorizationVerifier.js';

const SECRET = 'exec-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};
const quiet = { info() {}, warn() {}, error() {} };
// A correct verifier echoes the binding it was asked to check — the attestation MUST match the order.
const okVerify = async (_authz, bound) => ({ ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref });

function setup({ verify } = {}) {
  let charges = 0;
  const kernelUpstream = async (op) => (
    op === 'preview_quote' ? QUOTE
    : op === 'create_order' ? { order_id: 'o_exec', acp_state: {} }
    : op === 'submit_payment' ? (charges++, { order_id: 'o_exec', payment_id: 'pay1', payment_status: 'succeeded' })
    : {}
  );
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const reads = [];
  const readUpstream = async (op, payload) => { reads.push({ op, payload }); return { ok: true, op }; };
  const exec = createCanonicalExecutor({ kernel, upstream: readUpstream, verifyPaymentAuthorization: verify });
  return { kernel, exec: exec.execute, reads, charges: () => charges };
}

async function newSession(exec) {
  const s = await exec('create_checkout_session', { idempotency_key: 'idem-create-1', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  return s.session_id;
}

test('unknown operation throws (adapters can never route an unknown op)', async () => {
  const { exec } = setup();
  await assert.rejects(exec('totally_unknown', {}, CTX), /unknown canonical operation/);
});

test('deny without a verified buyer (requiresUserRef) — closes L2/L3 at the executor', async () => {
  const { exec } = setup();
  const noUser = { acp_session_id: 'acp_1' };
  await assert.rejects(exec('create_checkout_session', { idempotency_key: 'idem-x-123' }, noUser), (e) => e.code === 'USER_AUTH_REQUIRED');
  await assert.rejects(exec('get_order', { order_id: 'o1' }, noUser), (e) => e.code === 'USER_AUTH_REQUIRED');
  await assert.rejects(exec('complete_checkout_session', { idempotency_key: 'idem-x-123', session_id: 'q' }, noUser), (e) => e.code === 'USER_AUTH_REQUIRED');
});

test('a user-scoped op needs a verified session id too (not just user_ref) — defense in depth', async () => {
  const { exec } = setup({ verify: async () => ({ ok: true }) });
  const noSession = { user_ref: 'user_1' }; // buyer but NO acp_session_id
  await assert.rejects(
    exec('create_checkout_session', { idempotency_key: 'idem-nosess-1', quote: {} }, noSession),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH' && e.detail?.reason === 'missing_acp_session',
  );
  await assert.rejects(exec('get_order', { order_id: 'o1' }, noSession), (e) => e.code === 'STATE_LINKAGE_MISMATCH' && e.detail?.reason === 'missing_acp_session');
});

test('mutations require an idempotency key', async () => {
  const { exec } = setup({ verify: okVerify });
  await assert.rejects(exec('create_checkout_session', { quote: {} }, CTX), (e) => e.code === 'IDEMPOTENCY_CONFLICT' && e.detail?.reason === 'missing_idempotency_key');
  await assert.rejects(exec('complete_checkout_session', { session_id: 'q' }, CTX), (e) => e.code === 'IDEMPOTENCY_CONFLICT' && e.detail?.reason === 'missing_idempotency_key');
});

test('reads route to the upstream (search_catalog / get_product)', async () => {
  const { exec, reads } = setup();
  await exec('search_catalog', { payload: { search: { query: 'x' } } }, CTX);
  await exec('get_product', { payload: { product: { merchant_id: 'm', product_id: 'p' } } }, CTX);
  assert.deepEqual(reads.map((r) => r.op), ['find_products', 'get_product_detail']);
});

test('create_checkout_session returns a session bound to the quote', async () => {
  const { exec } = setup();
  const s = await exec('create_checkout_session', { idempotency_key: 'idem-create-1', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  assert.ok(s.session_id, 'session_id == quote_id');
  assert.equal(s.status, 'ready_for_payment');
  assert.equal(s.currency, 'USD');
  assert.equal(s.totals.total, 113);
});

test('complete: verify payment authz → order + charge once; verifier sees the bound amount', async () => {
  const seen = [];
  const { exec, charges } = setup({ verify: async (authz, bound) => { seen.push({ authz, bound }); return { ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref }; } });
  const session_id = await newSession(exec);
  const out = await exec('complete_checkout_session', { idempotency_key: 'idem-complete-1', session_id, payment_authorization: { token: 'tok_abc' }, shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'A' } }, CTX);
  assert.equal(out.order.order_id, 'o_exec');
  assert.equal(out.payment.order_status, 'paid');
  assert.equal(charges(), 1, 'charged exactly once');
  // the verifier was called with the AUTHORITATIVE order amount/currency + buyer
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authz.token, 'tok_abc');
  assert.equal(seen[0].bound.amount, 113);
  assert.equal(seen[0].bound.currency, 'USD');
  assert.equal(seen[0].bound.user_ref, 'user_1');
  assert.equal(seen[0].bound.merchant_id, 'merch_A');
  assert.equal(seen[0].bound.checkout_session_id, session_id);
});

test('complete carries locked quote buyer context into create_order without payment-time identity fields', async () => {
  let createOrderPayload;
  let charges = 0;
  const kernelUpstream = async (op, payload) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') {
      createOrderPayload = payload;
      return { order_id: 'o_buyer_ctx', acp_state: {} };
    }
    if (op === 'submit_payment') {
      charges++;
      return { order_id: 'o_buyer_ctx', payment_id: 'pay_buyer_ctx', payment_status: 'succeeded' };
    }
    return {};
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const executor = createCanonicalExecutor({ kernel, verifyPaymentAuthorization: okVerify });
  const lockedShipping = {
    country: 'US',
    city: 'San Francisco',
    state: 'CA',
    postal_code: '94105',
    address_line1: '1 Kernel Way',
    recipient_name: 'Strict Buyer',
  };
  const session = await executor.execute('create_checkout_session', {
    idempotency_key: 'idem-buyer-context-create',
    quote: {
      merchant_id: 'merch_A',
      customer_email: 'strict-buyer@example.com',
      shipping_address: lockedShipping,
      items: [{ product_id: 'p1', quantity: 1 }],
    },
  }, CTX);

  await executor.execute('complete_checkout_session', {
    idempotency_key: 'idem-buyer-context-complete',
    session_id: session.session_id,
    payment_authorization: { token: 'tok_buyer_context' },
  }, CTX);

  assert.equal(charges, 1);
  assert.equal(createOrderPayload.order.customer_email, 'strict-buyer@example.com');
  assert.equal(createOrderPayload.order.shipping_address.address_line1, '1 Kernel Way');
  assert.equal(createOrderPayload.order.shipping_address.name, 'Strict Buyer');
});

test('complete: a payment grant must bind to the checkout session, not only the ACP connection', async () => {
  const verify = createPaymentAuthorizationVerifier({
    methods: {
      acp_delegated_token: async () => ({
        max_amount: 200,
        currency: 'USD',
        merchant_id: 'merch_A',
        checkout_session_id: CTX.acp_session_id,
        user_ref: CTX.user_ref,
        expires_at: Date.now() + 60_000,
      }),
    },
  });
  const { exec, charges } = setup({ verify });
  const session_id = await newSession(exec);
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-connection-grant-1', session_id, payment_authorization: { method: 'acp_delegated_token', token: 'grant-for-connection-not-checkout' } }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'session_mismatch',
  );
  assert.equal(charges(), 0);
});

test('complete FAILS CLOSED when payment authorization does not verify — NO charge', async () => {
  const { exec, charges } = setup({ verify: async () => { throw new Error('authorization rejected'); } });
  const session_id = await newSession(exec);
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-complete-2', session_id, payment_authorization: { token: 'bad' } }, CTX),
  );
  assert.equal(charges(), 0, 'a failed authorization must never reach the charge');
});

test('complete FAILS CLOSED with no verifier configured', async () => {
  const { exec, charges } = setup(); // no verifyPaymentAuthorization
  const session_id = await newSession(exec);
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-complete-3', session_id, payment_authorization: { token: 'x' } }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'no_payment_authorization_verifier',
  );
  assert.equal(charges(), 0);
});

test('P0: a verifier that returns without a positive attestation FAILS CLOSED — no charge', async () => {
  // a no-op verifier (returns undefined) must NOT be treated as success
  const noop = setup({ verify: async () => undefined });
  let sid = await newSession(noop.exec);
  await assert.rejects(
    noop.exec('complete_checkout_session', { idempotency_key: 'idem-noattest-1', session_id: sid, payment_authorization: { token: 'x' } }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'payment_authorization_not_attested',
  );
  assert.equal(noop.charges(), 0);
  // an attestation for the WRONG amount is rejected too
  const wrong = setup({ verify: async () => ({ ok: true, amount: 1 }) });
  sid = await newSession(wrong.exec);
  await assert.rejects(
    wrong.exec('complete_checkout_session', { idempotency_key: 'idem-noattest-2', session_id: sid, payment_authorization: { token: 'x' } }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'authorization_amount_mismatch',
  );
  assert.equal(wrong.charges(), 0);
  // the exact Codex re-review exploit: a verifier that returns BARE {ok:true} (echoes NOTHING) for an auth
  // token bound to some other order/buyer must FAIL CLOSED — the echo fields are mandatory, not optional.
  const bare = setup({ verify: async () => ({ ok: true }) });
  sid = await newSession(bare.exec);
  await assert.rejects(
    bare.exec('complete_checkout_session', { idempotency_key: 'idem-noattest-3', session_id: sid, payment_authorization: { token: 'x' } }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'authorization_amount_mismatch',
  );
  assert.equal(bare.charges(), 0);
});

test('P0 cross-user replay: User B replaying A\'s key+body cannot read back A\'s order/payment', async () => {
  const { exec, charges } = setup({ verify: okVerify });
  const A = { user_ref: 'user_A', acp_session_id: 'acp_A' };
  const B = { user_ref: 'user_B', acp_session_id: 'acp_B' };
  const sA = (await exec('create_checkout_session', { idempotency_key: 'shared-key-xyz', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, A)).session_id;
  const a = await exec('complete_checkout_session', { idempotency_key: 'shared-key-xyz', session_id: sA, payment_authorization: { token: 't' } }, A);
  assert.equal(charges(), 1);
  // B replays the IDENTICAL idempotency_key + session_id + auth. Pre-fix the outer ledger returned A's cached
  // {order, payment} (a data leak) before ownership was checked. Now the key is user-scoped, so B's flow runs
  // its own path and is denied at the quote/order linkage — B never receives A's result.
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'shared-key-xyz', session_id: sA, payment_authorization: { token: 't' } }, B),
    (e) => e.code === 'STATE_LINKAGE_MISMATCH' || e.code === 'QUOTE_NOT_FOUND' || e.code === 'QUOTE_ALREADY_USED',
  );
  assert.equal(charges(), 1, 'no second charge, and B got an error — not A\'s cached order');
});

test('P0: complete with no payment_authorization is refused before any order is created', async () => {
  const { exec, charges } = setup({ verify: okVerify });
  const session_id = await newSession(exec);
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-noauth-1', session_id }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'missing_payment_authorization',
  );
  assert.equal(charges(), 0);
});

test('P1 idempotent replay: a retry of a completed checkout (same key) replays the result, no 2nd charge', async () => {
  let verifyCalls = 0;
  const { exec, charges } = setup({ verify: async (_a, bound) => { verifyCalls++; return { ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref }; } });
  const session_id = await newSession(exec);
  const args = { idempotency_key: 'idem-replay-1', session_id, payment_authorization: { token: 't' } };
  const first = await exec('complete_checkout_session', args, CTX);
  const second = await exec('complete_checkout_session', args, CTX); // network-timeout retry, same key+body
  assert.equal(second.order.order_id, first.order.order_id);
  assert.equal(second.payment.payment_id, first.payment.payment_id);
  assert.equal(charges(), 1, 'replay must NOT re-charge');
  assert.equal(verifyCalls, 1, 'replay short-circuits before re-running verify/mint/charge');
});

test('recovery: a complete that fails verify can be retried with the SAME key + valid auth (charges once)', async () => {
  let good = false;
  const { exec, charges } = setup({ verify: async (_a, bound) => (good ? { ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref } : (() => { throw new Error('bad auth'); })()) });
  const session_id = await newSession(exec);
  const args = { idempotency_key: 'idem-recover-1', session_id, payment_authorization: { token: 't' } };
  await assert.rejects(exec('complete_checkout_session', args, CTX)); // verify throws → no charge, key released
  assert.equal(charges(), 0);
  good = true;
  const out = await exec('complete_checkout_session', args, CTX); // same key, corrected auth → completes
  assert.equal(out.payment.order_status, 'paid');
  assert.equal(charges(), 1);
});

test('get_order: a kernel-tracked order owned by another user is denied (ownership-gated)', async () => {
  const { kernel, exec } = setup({ verify: okVerify });
  // create an order owned by user_1
  const session_id = await newSession(exec);
  await exec('complete_checkout_session', { idempotency_key: 'idem-own-1', session_id, payment_authorization: { token: 't' } }, CTX);
  // a different user asking for the same order id → STATE_LINKAGE_MISMATCH
  const other = { user_ref: 'user_2', acp_session_id: 'acp_2' };
  await assert.rejects(exec('get_order', { order_id: 'o_exec' }, other), (e) => e.code === 'STATE_LINKAGE_MISMATCH');
});

test('P0 single-use: a session cannot be completed twice (different keys) — no double charge', async () => {
  const { exec, charges } = setup({ verify: okVerify });
  const session_id = await newSession(exec);
  await exec('complete_checkout_session', { idempotency_key: 'idem-KEY-A', session_id, payment_authorization: { token: 't' } }, CTX);
  // a second complete on the SAME session with a DIFFERENT key must not mint a second order/charge
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-KEY-B', session_id, payment_authorization: { token: 't' } }, CTX),
    (e) => e.code === 'QUOTE_ALREADY_USED',
  );
  assert.equal(charges(), 1, 'one locked quote → exactly one charge');
});

test('P0 get_order fails CLOSED for an order the kernel does not track (no unscoped upstream read)', async () => {
  const { exec, reads } = setup({ verify: okVerify });
  await assert.rejects(
    exec('get_order', { order_id: 'o_not_tracked' }, CTX),
    (e) => e.code === 'QUOTE_NOT_FOUND',
  );
  assert.equal(reads.length, 0, 'no upstream read for an unproven order');
});

test('cancel: cancels a created order; refuses to cancel a paid one', async () => {
  const { kernel, exec } = setup({ verify: okVerify });
  // a created (unpaid) order cancels
  const s1 = await newSession(exec);
  const o1 = await kernel.createOrder({ idempotency_key: 'idem-cxl-order', order: { quote_id: s1, shipping_address: {} } }, CTX);
  const c = await exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-1', session_id: s1, order_id: o1.order_id }, CTX);
  assert.equal(c.status, 'canceled');
  assert.equal((await kernel._orderStore.get(o1.order_id)).status, 'canceled');
  // a paid order cannot be canceled
  const s2 = await newSession(exec);
  await exec('complete_checkout_session', { idempotency_key: 'idem-paid-1', session_id: s2, payment_authorization: { token: 't' } }, CTX);
  await assert.rejects(exec('cancel_checkout_session', { idempotency_key: 'idem-cxl-2', order_id: 'o_exec' }, CTX), (e) => e.code === 'OPERATION_NOT_ALLOWED');
});
