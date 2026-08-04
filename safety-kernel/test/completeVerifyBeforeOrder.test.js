// Regression: complete_checkout_session must VERIFY the buyer's payment authorization BEFORE it turns the
// session's locked quote into an order.
//
// The bug this pins: createOrder ran first and claims the quote single-use (INV-1). So a complete whose
// authorization failed verification burned the checkout session permanently — no money moved, nothing was
// completed, yet every recovery route was dead:
//     1st complete, bad authorization      -> CONFIRMATION_INVALID (402)
//     retry, SAME idempotency key          -> CONFIRMATION_INVALID (the cached order replays, verify re-fails)
//     retry, NEW  idempotency key          -> QUOTE_ALREADY_USED   (409) even with a CORRECTED authorization
// The executor's own comment promised the opposite ("the buyer can re-complete with a corrected
// authorization"), and QUOTE_ALREADY_USED told the buyer the checkout "was already completed" — untrue.
//
// These tests hold BOTH ends: the failed-verify path must leave the quote spendable, and the charge-once /
// positive-attestation invariants (INV-2/3) must not be loosened to get there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { PivotaCommerceError } from '../src/errors.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { createPaymentAuthorizationVerifier } from '../src/protocol/paymentAuthorizationVerifier.js';

const SECRET = 'verify-first-secret-0123456789ab';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = {
  merchant_of_record: 'merch_A',
  currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }],
  acp_state: { acp_session_id: 'acp_1' },
};
const quiet = { info() {}, warn() {}, error() {} };

// Counts every upstream money-path call, so a test can prove no ORDER was created (not merely no charge).
function setup({ verify } = {}) {
  const calls = { create_order: 0, submit_payment: 0 };
  let orderSeq = 0;
  const kernelUpstream = async (op) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') { calls.create_order++; return { order_id: `o_${++orderSeq}`, acp_state: {} }; }
    if (op === 'submit_payment') { calls.submit_payment++; return { order_id: `o_${orderSeq}`, payment_id: 'pay_1', payment_status: 'succeeded' }; }
    return {};
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const { execute } = createCanonicalExecutor({ kernel, upstream: async () => ({}), verifyPaymentAuthorization: verify });
  return { kernel, exec: execute, calls };
}

async function newSession(exec) {
  const s = await exec(
    'create_checkout_session',
    { idempotency_key: 'idem-create-vfo', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } },
    CTX,
  );
  return s.session_id;
}

const attest = (bound) => ({ ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref });

test('a failed payment-authorization verify does NOT consume the quote — the buyer recovers with a corrected authorization', async () => {
  // The realistic shape of the bug: the buyer's FIRST authorization is malformed/unverifiable and their
  // SECOND is valid. A corrected authorization is a different request body, so it also needs a new
  // idempotency key (the same key + a changed body is an IDEMPOTENCY_CONFLICT by design).
  const { exec, calls } = setup({
    verify: async (authz, bound) => {
      if (authz?.token !== 'tok_good') throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'bad_grant' });
      return attest(bound);
    },
  });
  const session_id = await newSession(exec);

  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-bad-1', session_id, payment_authorization: { token: 'tok_bad' } }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID',
  );
  assert.equal(calls.create_order, 0, 'a rejected authorization must not create an order (that is what burns the quote)');
  assert.equal(calls.submit_payment, 0, 'no charge — INV-2 holds');

  // The corrected authorization completes the SAME checkout session. Pre-fix this threw QUOTE_ALREADY_USED.
  const out = await exec(
    'complete_checkout_session',
    { idempotency_key: 'idem-good-1', session_id, payment_authorization: { token: 'tok_good' } },
    CTX,
  );
  assert.equal(out.payment.order_status, 'paid');
  assert.equal(calls.create_order, 1, 'exactly one order from the one locked quote');
  assert.equal(calls.submit_payment, 1, 'charged exactly once');
});

test('the same recovery holds through the REAL unified verifier (createPaymentAuthorizationVerifier)', async () => {
  // Same scenario, but the CONFIRMATION_INVALID comes from the production verifier's own fail-closed paths
  // (unknown method / no crypto verifier / binding mismatch) rather than a hand-rolled throw.
  const grants = new Map([
    ['tok_good', { max_amount: 113, currency: 'USD', merchant_id: 'merch_A', expires_at: Date.now() + 60_000 }],
    ['tok_low', { max_amount: 1, currency: 'USD', merchant_id: 'merch_A', expires_at: Date.now() + 60_000 }],
  ]);
  const verify = createPaymentAuthorizationVerifier({
    methods: {
      acp_delegated_token: async (authorization) => {
        const claims = grants.get(authorization?.token);
        if (!claims) throw new Error('unknown grant');
        return { ...claims, checkout_session_id: authorization.checkout_session_id };
      },
    },
  });
  const { exec, calls } = setup({ verify });
  const session_id = await newSession(exec);
  const authz = (token) => ({ method: 'acp_delegated_token', token, checkout_session_id: session_id });

  // (a) a grant for a method with no configured verifier
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-r-1', session_id, payment_authorization: { method: 'ap2_mandate', mandate: 'x~y' } }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'no_verifier_for_method',
  );
  // (b) a structurally valid grant that does not cover the order total
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-r-2', session_id, payment_authorization: authz('tok_low') }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'amount_exceeds_allowance',
  );
  // (c) an unverifiable token
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-r-3', session_id, payment_authorization: authz('tok_nope') }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID',
  );
  assert.equal(calls.create_order, 0, 'three rejected completes, still no order');
  assert.equal(calls.submit_payment, 0);

  // the session is still spendable
  const out = await exec('complete_checkout_session', { idempotency_key: 'idem-r-4', session_id, payment_authorization: authz('tok_good') }, CTX);
  assert.equal(out.payment.order_status, 'paid');
  assert.equal(calls.create_order, 1);
  assert.equal(calls.submit_payment, 1);
});

test('the verifier is bound to the LOCKED QUOTE snapshot (authoritative money), never the caller', async () => {
  const seen = [];
  const { exec } = setup({ verify: async (_a, bound) => { seen.push(bound); return attest(bound); } });
  const session_id = await newSession(exec);
  await exec(
    'complete_checkout_session',
    // caller-supplied amount/currency junk must be ignored entirely
    { idempotency_key: 'idem-bind-1', session_id, payment_authorization: { token: 't', amount: 1, currency: 'JPY' } },
    CTX,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].amount, 113, 'the quote snapshot total, not the caller');
  assert.equal(seen[0].currency, 'USD');
  assert.equal(seen[0].merchant_id, 'merch_A');
  assert.equal(seen[0].user_ref, 'user_1');
  assert.equal(seen[0].checkout_session_id, session_id);
});

test('INV-3 not weakened: a non-attesting verifier still fails CLOSED — and now without burning the quote', async () => {
  for (const [label, bad] of [
    ['returns nothing', async () => undefined],
    ['returns {ok:false}', async () => ({ ok: false })],
    ['returns bare {ok:true} (echoes nothing)', async () => ({ ok: true })],
    ['attests the WRONG amount', async (_a, bound) => ({ ok: true, amount: 1, currency: bound.currency, user_ref: bound.user_ref })],
    ['attests the WRONG currency', async (_a, bound) => ({ ok: true, amount: bound.amount, currency: 'JPY', user_ref: bound.user_ref })],
    ['attests the WRONG buyer', async (_a, bound) => ({ ok: true, amount: bound.amount, currency: bound.currency, user_ref: 'user_evil' })],
  ]) {
    const { exec, calls } = setup({ verify: bad });
    const session_id = await newSession(exec);
    await assert.rejects(
      exec('complete_checkout_session', { idempotency_key: `idem-inv3-${calls.create_order}-x`, session_id, payment_authorization: { token: 't' } }, CTX),
      (e) => e.code === 'CONFIRMATION_INVALID',
      `verifier that ${label} must fail closed`,
    );
    assert.equal(calls.create_order, 0, `verifier that ${label}: no order`);
    assert.equal(calls.submit_payment, 0, `verifier that ${label}: no charge`);
  }
});

test('defense in depth: if the minted order disagrees with the verified quote, fail CLOSED before any charge', async () => {
  // The order's amount/currency/merchant are derived from the same snapshot the authorization was verified
  // against, so they cannot legitimately diverge. Simulate a divergence (a kernel/adapter regression) and
  // prove the executor refuses to mint a confirmation or charge on money nobody authorized.
  for (const [label, drift] of [
    ['amount', { amount_total: 99999 }],
    ['currency', { currency: 'JPY' }],
    ['merchant_of_record', { merchant_of_record: 'merch_EVIL' }],
  ]) {
    const { kernel, exec, calls } = setup({ verify: async (_a, bound) => attest(bound) });
    const session_id = await newSession(exec);
    const realCreateOrder = kernel.createOrder.bind(kernel);
    kernel.createOrder = async (payload, ctx) => ({ ...(await realCreateOrder(payload, ctx)), ...drift });
    await assert.rejects(
      exec('complete_checkout_session', { idempotency_key: 'idem-drift-1', session_id, payment_authorization: { token: 't' } }, CTX),
      (e) => e.code === 'CONFIRMATION_INVALID',
      `drifted ${label} must fail closed`,
    );
    assert.equal(calls.submit_payment, 0, `drifted ${label}: no charge`);
  }
});

test('charge-once is unchanged: one locked quote can still only ever become one order', async () => {
  const { exec, calls } = setup({ verify: async (_a, bound) => attest(bound) });
  const session_id = await newSession(exec);
  await exec('complete_checkout_session', { idempotency_key: 'idem-once-A', session_id, payment_authorization: { token: 't' } }, CTX);
  // a SUCCESSFUL complete still consumes the quote — a second complete under a different key is refused
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-once-B', session_id, payment_authorization: { token: 't' } }, CTX),
    (e) => e.code === 'QUOTE_ALREADY_USED',
  );
  assert.equal(calls.create_order, 1);
  assert.equal(calls.submit_payment, 1, 'one locked quote → exactly one charge');
});

test('QUOTE_ALREADY_USED no longer claims the checkout "was already completed"', async () => {
  // It fires when the quote became an ORDER — which may be unpaid (a post-create failure). Telling the buyer
  // it "was already completed" is the same false-recovery claim this fix removes from the executor comment.
  const { ERROR_CATALOG } = await import('../src/errors.js');
  const msg = ERROR_CATALOG.QUOTE_ALREADY_USED.userMessage;
  assert.ok(!/already completed/i.test(msg), `misleading completion claim: ${msg}`);
  assert.ok(/order/i.test(msg));
});

// --- end-to-end over the ACP REST surface (the shape the bug was reported in) -------------------------------

const ACP_SIGNING_SECRET = 'acp-signing-secret-0123456789abcdef';
const FIXED_NOW = 1_900_000_000_000;

function acpSetup(verify) {
  const calls = { create_order: 0, submit_payment: 0 };
  const kernelUpstream = async (op) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') { calls.create_order++; return { order_id: 'o_acp', acp_state: {} }; }
    if (op === 'submit_payment') { calls.submit_payment++; return { order_id: 'o_acp', payment_id: 'pay1', payment_status: 'succeeded' }; }
    return {};
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet, now: () => FIXED_NOW });
  const adapter = createAcpRestAdapter({
    executor: createCanonicalExecutor({ kernel, upstream: async () => ({}), verifyPaymentAuthorization: verify }),
    sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }),
    signingSecret: ACP_SIGNING_SECRET,
    resolveUserRef: async (r) => r.headers['x-test-buyer'],
    getProducts: async () => [],
    now: () => FIXED_NOW,
  });
  return { adapter, calls };
}

function acpReq({ body = {}, id, idem }) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(FIXED_NOW);
  return {
    headers: {
      authorization: 'Bearer platform-key',
      timestamp,
      signature: createHmac('sha256', ACP_SIGNING_SECRET).update(`${timestamp}.${rawBody}`).digest('hex'),
      'x-test-buyer': 'buyer_1',
      ...(idem ? { 'idempotency-key': idem } : {}),
    },
    rawBody,
    body,
    params: id ? { checkout_session_id: id } : {},
  };
}

test('ACP REST end-to-end: a 402 on a bad delegated token leaves the checkout session completable', async () => {
  // The reported repro, over the real adapter: complete with a bad payment_data, then walk every retry route.
  const { adapter, calls } = acpSetup(async (authz, bound) => {
    if (authz?.token !== 'tok_good') throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'bad_grant' });
    return attest(bound);
  });
  const created = await adapter.createCheckoutSession(acpReq({ body: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] }, idem: 'idem-acp-open-1' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;

  const bad = { payment_data: { token: 'tok_bad' } };
  const first = await adapter.completeCheckoutSession(acpReq({ id, body: bad, idem: 'idem-acp-c1' }));
  assert.equal(first.status, 402);
  assert.equal(first.body.code, 'CONFIRMATION_INVALID');

  // same idempotency key, same body → the ledger released the key, so it re-runs and re-fails the same way
  const sameKey = await adapter.completeCheckoutSession(acpReq({ id, body: bad, idem: 'idem-acp-c1' }));
  assert.equal(sameKey.status, 402);
  assert.equal(sameKey.body.code, 'CONFIRMATION_INVALID');

  // new idempotency key, still-bad token → still 402. Pre-fix this was 409 QUOTE_ALREADY_USED.
  const newKey = await adapter.completeCheckoutSession(acpReq({ id, body: bad, idem: 'idem-acp-c2' }));
  assert.equal(newKey.status, 402);
  assert.equal(newKey.body.code, 'CONFIRMATION_INVALID');

  assert.equal(calls.create_order, 0, 'no order was ever minted for an unauthorized complete');
  assert.equal(calls.submit_payment, 0, 'no charge — INV-2/3 held throughout');

  // corrected token (new key, since the body changed) → the session completes. Pre-fix: 409, permanently.
  const ok = await adapter.completeCheckoutSession(acpReq({ id, body: { payment_data: { token: 'tok_good' } }, idem: 'idem-acp-c3' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(calls.create_order, 1);
  assert.equal(calls.submit_payment, 1, 'charged exactly once');

  // and the session is now genuinely spent — a further complete is refused
  const after = await adapter.completeCheckoutSession(acpReq({ id, body: { payment_data: { token: 'tok_good' } }, idem: 'idem-acp-c4' }));
  assert.equal(after.status, 409);
  assert.equal(after.body.code, 'QUOTE_ALREADY_USED');
  assert.equal(calls.submit_payment, 1, 'still one charge');
});
