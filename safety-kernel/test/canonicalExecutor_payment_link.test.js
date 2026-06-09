// Tests for the GUEST hosted-checkout op (create_payment_link): grant-free, and — critically — it
// MUST NEVER charge (never calls kernel.submitPayment). It only mints a hosted page the buyer pays on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';

const SECRET = 'exec-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = {
  merchant_of_record: 'merch_A', currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: { acp_session_id: 'acp_1' },
};
const quiet = { info() {}, warn() {}, error() {} };

function setup({ hosted } = {}) {
  let charges = 0;
  const kernelUpstream = async (op) => (
    op === 'preview_quote' ? QUOTE
    : op === 'create_order' ? { order_id: 'o_exec', acp_state: {} }
    : op === 'submit_payment' ? (charges++, { order_id: 'o_exec', payment_id: 'pay1', payment_status: 'succeeded' })
    : {}
  );
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const calls = [];
  const readUpstream = async (op, payload) => {
    calls.push({ op, payload });
    if (op === 'create_payment_link') {
      return hosted !== undefined ? hosted : {
        checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_abc123',
        checkout_session_id: 'cs_test_abc123',
        expires_at: 1780000000,
      };
    }
    return { ok: true, op };
  };
  const exec = createCanonicalExecutor({ kernel, upstream: readUpstream, verifyPaymentAuthorization: async () => ({ ok: true }) });
  return { exec: exec.execute, calls, charges: () => charges };
}

async function newSession(exec) {
  const s = await exec('create_checkout_session', { idempotency_key: 'idem-create-1', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, CTX);
  return s.session_id;
}

test('create_payment_link mints a hosted URL and NEVER charges (no submitPayment)', async () => {
  const { exec, calls, charges } = setup();
  const sid = await newSession(exec);
  const out = await exec('create_payment_link', {
    idempotency_key: 'idem-link-1', session_id: sid,
    customer_email: 'guest@example.com',
    shipping_address: { country: 'US', city: 'NY', postal_code: '10001', address_line1: '1', recipient_name: 'Guest' },
  }, CTX);
  assert.equal(out.status, 'awaiting_payment');
  assert.match(out.checkout_url, /checkout\.stripe\.com/);
  assert.equal(out.checkout_session_id, 'cs_test_abc123');
  assert.equal(out.amount_total, 113);          // server-side locked amount, not caller-set
  assert.equal(out.currency, 'USD');
  assert.ok(out.order_id);
  // THE invariant:
  assert.equal(charges(), 0, 'create_payment_link must never call submitPayment');
  assert.equal(calls.filter((c) => c.op === 'create_payment_link').length, 1);
  // the hosted call carried the order_id + email, not a caller amount
  const link = calls.find((c) => c.op === 'create_payment_link');
  assert.equal(link.payload.order_id, out.order_id);
  assert.equal(link.payload.customer_email, 'guest@example.com');
  assert.ok(!('amount' in link.payload) && !('total' in link.payload));
});

test('requires NO payment authorization (grant-free)', async () => {
  const { exec } = setup();
  const sid = await newSession(exec);
  // no payment_authorization passed at all -> still succeeds
  const out = await exec('create_payment_link', { idempotency_key: 'idem-link-2', session_id: sid, customer_email: 'g@x.com' }, CTX);
  assert.ok(out.checkout_url);
});

test('idempotent replay returns the same order + link, mints only one hosted session, still 0 charges', async () => {
  const { exec, calls, charges } = setup();
  const sid = await newSession(exec);
  const args = { idempotency_key: 'idem-link-3', session_id: sid, customer_email: 'g@x.com' };
  const a = await exec('create_payment_link', args, CTX);
  const b = await exec('create_payment_link', args, CTX);
  assert.equal(a.order_id, b.order_id);
  assert.equal(a.checkout_url, b.checkout_url);
  assert.equal(calls.filter((c) => c.op === 'create_payment_link').length, 1, 'replay must not mint a second session');
  assert.equal(charges(), 0);
});

test('fail-closed when the hosted op returns no URL', async () => {
  const { exec } = setup({ hosted: { checkout_session_id: 'cs_x' } }); // no url
  const sid = await newSession(exec);
  await assert.rejects(
    exec('create_payment_link', { idempotency_key: 'idem-link-4', session_id: sid }, CTX),
    (e) => e.code === 'MERCHANT_UNAVAILABLE',
  );
});

test('contract safety: needs verified buyer + session + idempotency key', async () => {
  const { exec } = setup();
  const sid = await newSession(exec);
  await assert.rejects(exec('create_payment_link', { idempotency_key: 'k', session_id: sid }, { acp_session_id: 'acp_1' }), (e) => e.code === 'USER_AUTH_REQUIRED');
  await assert.rejects(exec('create_payment_link', { session_id: sid }, CTX), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(exec('create_payment_link', { idempotency_key: 'k2' }, CTX), (e) => e.code === 'QUOTE_NOT_FOUND');
});
