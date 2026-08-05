// PR-F — routing an external ACP agent's `payment_data.token = spt_…` completion to the BACKEND's money
// endpoints instead of the kernel's normal charge path.
//
// WHY THE LANE EXISTS. `verifyPaymentAuthorization` attests SIGNED grants (ACP delegated token / UCP handler /
// AP2 mandate) against pinned JWKS. A Stripe SharedPaymentToken is an OPAQUE handle whose allowance
// (`usage_limits{currency, max_amount, expires_at}`, single use, merchant scope) lives at Stripe and is
// readable only with the merchant's key — which this gateway does not and must not hold. The kernel therefore
// cannot attest it, and INV-3 forbids pretending otherwise. The completion is routed out to the backend, where
// the merchant's key confirms the charge and Stripe performs the attestation.
//
// WHAT THESE TESTS HOLD, in both directions:
//   flag OFF -> an `spt_` is refused EXACTLY as it is today (the branch is unreachable; proven by diffing
//               against a control executor built with no SPT wiring at all).
//   flag ON  -> the completion routes: order via kernel.createOrder (so INV-1's single-use claim and the
//               backend's OWN quote id are inherited, not reimplemented), metadata.protocol_name = 'acp',
//               charge dispatched to the delegated endpoint with the token, charge-once on replay, one locked
//               quote -> one order -> one charge, a non-SPT token still takes the verifier path, a backend
//               failure surfaces honestly and cannot be re-keyed into a second charge, and the token never
//               reaches a log line or any persisted record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { PivotaCommerceError } from '../src/errors.js';
import { createCanonicalExecutor, delegatedPspToken } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { createPaymentAuthorizationVerifier } from '../src/protocol/paymentAuthorizationVerifier.js';

const SECRET = 'spt-handoff-secret-0123456789abcd';
// `protocol: 'acp'` is what SCOPES the delegated lane to the ACP door (review F2) — the branch lives in the
// shared completeCheckout, so the door must declare itself or an /mcp completion would route here too and
// stamp a false `protocol_name` on the backend order.
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1', protocol: 'acp' };
// The same buyer/session arriving at any OTHER door.
const CTX_NON_ACP = { user_ref: 'user_1', acp_session_id: 'acp_1', protocol: 'mcp' };
const SPT = 'spt_1PjKtestTOKENvalue0001';

// `quote_id` here is the BACKEND's own quote id — the gateway persists it as snapshot.upstream_quote_id and
// createOrder forwards it, which is the entire reason this lane was chosen: the order is priced from the SAME
// quote the agent was quoted from, so the charged amount is the amount the buyer's token was sized against.
const BACKEND_QUOTE_ID = 'bk_quote_9001';
const QUOTE = {
  quote_id: BACKEND_QUOTE_ID,
  merchant_of_record: 'merch_A',
  currency: 'USD',
  locked_totals: { subtotal: 100, tax: 8, shipping: 5, total: 113 },
  line_items: [{ product_id: 'p1', quantity: 1 }],
  acp_state: { acp_session_id: 'acp_1' },
};

const attest = (bound) => ({ ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref });

/**
 * Build a kernel + executor with the SPT lane wired. Records every upstream money call, every dispatched
 * delegated charge, every log line, and every kv record written (so a test can prove the token is nowhere).
 */
function setup({ enabled = true, verify, dispatchImpl, wireDispatcher = true } = {}) {
  const calls = { create_order: 0, submit_payment: 0, delegated: 0, verify: 0 };
  const createOrderBodies = [];
  const delegatedBodies = [];
  const logLines = [];
  const stores = [];
  const log = {
    info: (...a) => logLines.push(a),
    warn: (...a) => logLines.push(a),
    error: (...a) => logLines.push(a),
  };

  const kernelUpstream = async (op, payload) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') {
      calls.create_order++;
      createOrderBodies.push(payload);
      return { order_id: 'o_1', acp_state: {} };
    }
    if (op === 'submit_payment') {
      // The HOSTED checkout lane. Reaching it with an SPT is the bug this PR exists to prevent, so the tests
      // must be able to see it happen rather than have it silently succeed.
      calls.submit_payment++;
      return { payment_id: 'pay_hosted', payment_status: 'succeeded' };
    }
    return {};
  };

  const storeFactory = (ns) => {
    const s = new InMemoryKvStore();
    stores.push([ns, s]);
    return s;
  };

  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log, storeFactory });

  const submitDelegatedPayment = async (bound) => {
    calls.delegated++;
    delegatedBodies.push(bound);
    if (typeof dispatchImpl === 'function') return dispatchImpl(bound);
    return { payment_id: 'pay_delegated_1', payment_status: 'succeeded' };
  };

  const verifyPaymentAuthorization = async (authz, bound) => {
    calls.verify++;
    if (typeof verify === 'function') return verify(authz, bound);
    return attest(bound);
  };

  const { execute } = createCanonicalExecutor({
    kernel,
    upstream: async () => ({}),
    verifyPaymentAuthorization,
    ...(wireDispatcher ? { submitDelegatedPayment } : {}),
    delegatedTokenHandoffEnabled: () => enabled,
  });

  // Everything the process persisted, as one blob — the substrate for the "token is nowhere" assertion.
  const dumpState = () => JSON.stringify(stores.map(([ns, s]) => [ns, [...s._m.entries()]]));

  return { kernel, exec: execute, calls, createOrderBodies, delegatedBodies, logLines, dumpState };
}

async function newSession(exec, ctx = CTX) {
  const s = await exec(
    'create_checkout_session',
    { idempotency_key: 'idem-create-spt', quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } },
    ctx,
  );
  return s.session_id;
}

const sptAuth = (token = SPT) => ({ provider: 'stripe', method: 'delegated', token });

// --- token recognition -------------------------------------------------------------------------------------

test('delegatedPspToken recognizes ONLY a non-empty spt_ string token', () => {
  assert.equal(delegatedPspToken({ token: SPT }), SPT);
  assert.equal(delegatedPspToken({ token: `  ${SPT}  ` }), SPT, 'surrounding whitespace is trimmed');
  // Everything else must fall through to the verifier — INV-3 is not weakened for any other shape.
  for (const bad of [
    null, undefined, 'spt_string_not_object', ['spt_x'],
    { token: 'pm_card_visa' }, { token: 'vt_abc' }, { token: 'spt_' }, { token: '' },
    { token: 42 }, { token: { toString: () => SPT } }, {}, { spt: SPT },
  ]) {
    assert.equal(delegatedPspToken(bad), null, `must not be treated as delegated: ${JSON.stringify(bad)}`);
  }
});

// --- flag OFF: byte-identical to today -------------------------------------------------------------------

test('flag OFF: an spt_ is refused exactly as today — identical to an executor with no SPT wiring at all', async () => {
  // The control is the pre-PR shape: createCanonicalExecutor called with no submitDelegatedPayment and no
  // delegatedTokenHandoffEnabled. If the flag-off path diverged from it by even an error detail, this fails.
  const realVerifier = () => createPaymentAuthorizationVerifier({
    methods: { acp_delegated_token: async () => ({ merchant_id: 'merch_A' }) },
  });

  const observed = [];
  for (const label of ['control', 'flag_off']) {
    const calls = { create_order: 0, submit_payment: 0 };
    const kernelUpstream = async (op) => {
      if (op === 'preview_quote') return QUOTE;
      if (op === 'create_order') { calls.create_order++; return { order_id: 'o_x', acp_state: {} }; }
      if (op === 'submit_payment') { calls.submit_payment++; return { payment_id: 'p', payment_status: 'succeeded' }; }
      return {};
    };
    const quiet = { info() {}, warn() {}, error() {} };
    const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
    const deps = {
      kernel,
      upstream: async () => ({}),
      verifyPaymentAuthorization: realVerifier(),
    };
    const { execute } = createCanonicalExecutor(
      label === 'control'
        ? deps
        : { ...deps, submitDelegatedPayment: async () => { throw new Error('must never be called'); }, delegatedTokenHandoffEnabled: () => false },
    );
    const session_id = await newSession(execute);
    let err;
    try {
      await execute('complete_checkout_session', { idempotency_key: `idem-off-${label}`, session_id, payment_authorization: sptAuth() }, CTX);
    } catch (e) {
      err = e;
    }
    observed.push({
      label,
      code: err?.code,
      detail: JSON.stringify(err?.detail),
      create_order: calls.create_order,
      submit_payment: calls.submit_payment,
    });
  }

  const [control, off] = observed;
  assert.equal(control.code, 'CONFIRMATION_INVALID');
  assert.equal(JSON.parse(control.detail).reason, 'unknown_authorization_method');
  assert.equal(off.code, control.code);
  assert.equal(off.detail, control.detail, 'flag-off must produce the IDENTICAL error detail, not merely the same code');
  assert.equal(off.create_order, control.create_order);
  assert.equal(off.submit_payment, control.submit_payment);
  assert.equal(off.create_order, 0, 'no order for a refused completion (the quote stays spendable)');
  assert.equal(off.submit_payment, 0, 'no charge');
});

test('flag OFF: the SPT branch is unreachable even with the dispatcher wired', async () => {
  const { exec, calls } = setup({ enabled: false });
  const session_id = await newSession(exec);
  // The stub verifier here ATTESTS anything, so the completion succeeds down the ordinary path — the point is
  // that `calls.delegated` stays 0 and the hosted charge lane ran, i.e. no routing happened.
  await exec('complete_checkout_session', { idempotency_key: 'idem-off-wired', session_id, payment_authorization: sptAuth() }, CTX);
  assert.equal(calls.delegated, 0, 'flag off ⇒ nothing is ever dispatched to the delegated endpoint');
  assert.equal(calls.verify, 1, 'flag off ⇒ the token is still handed to the verifier');
  assert.equal(calls.submit_payment, 1, 'flag off ⇒ the ordinary charge lane ran');
});

// --- flag ON: the handoff --------------------------------------------------------------------------------

test('flag ON: an spt_ completion routes to the backend — no attestation is claimed, and the charge leaves the kernel', async () => {
  const { exec, calls, createOrderBodies, delegatedBodies } = setup();
  const session_id = await newSession(exec);

  const out = await exec(
    'complete_checkout_session',
    { idempotency_key: 'idem-spt-1', session_id, payment_authorization: sptAuth(), shipping_address: { name: 'A', address_line1: '1 St', city: 'C', postal_code: '1', country: 'US' } },
    CTX,
  );

  // The verifier is NEVER consulted. That is the load-bearing claim of §3: the gateway refuses to pretend it
  // attested something it cannot attest, rather than waving the token through a verifier that would pass it.
  assert.equal(calls.verify, 0, 'an SPT must not be presented to the JWS verifier at all');

  // Order via kernel.createOrder (NOT a direct POST): that is what claims the quote single-use and forwards
  // the backend's own quote id.
  assert.equal(calls.create_order, 1);
  const orderBody = createOrderBodies[0].order;
  assert.equal(orderBody.quote_id, BACKEND_QUOTE_ID, 'priced from the SAME backend quote the gateway was quoted from');
  assert.equal(orderBody._kernel_quote_id, session_id);
  assert.deepEqual(orderBody._locked_totals, QUOTE.locked_totals);
  assert.equal(orderBody.metadata?.protocol_name, 'acp', 'without protocol_name the backend off-session gate never engages');

  // The charge went to the delegated dispatcher, NOT the hosted checkout-session lane.
  assert.equal(calls.submit_payment, 0, 'the hosted checkout lane must not be used for an SPT');
  assert.equal(calls.delegated, 1);
  assert.equal(delegatedBodies[0].token, SPT, 'the token is forwarded to the backend money endpoint');
  assert.equal(delegatedBodies[0].order_id, 'o_1');
  assert.equal(delegatedBodies[0].amount, 113, 'amount pinned by the kernel from its own order record');
  assert.equal(delegatedBodies[0].currency, 'USD');
  assert.ok(typeof delegatedBodies[0].idempotency_key === 'string' && delegatedBodies[0].idempotency_key.length > 0);

  assert.equal(out.order.order_id, 'o_1');
  assert.equal(out.order.amount_total, 113);
  assert.equal(out.payment.payment_id, 'pay_delegated_1');
  assert.equal(out.payment.order_status, 'paid');
});

test('flag ON: a NON-spt authorization still takes the verifier path, unchanged (INV-3 intact)', async () => {
  const { exec, calls, delegatedBodies } = setup();
  const session_id = await newSession(exec);
  await exec(
    'complete_checkout_session',
    { idempotency_key: 'idem-nonspt-1', session_id, payment_authorization: { method: 'acp_delegated_token', token: 'vt_abcdef0123' } },
    CTX,
  );
  assert.equal(calls.verify, 1, 'a signed-grant token is still verified');
  assert.equal(calls.delegated, 0, 'and is never routed to the delegated endpoint');
  assert.equal(delegatedBodies.length, 0);
  assert.equal(calls.submit_payment, 1);
});

test('flag ON: a non-attesting verifier still fails CLOSED for a non-spt token', async () => {
  // The routing branch must not become a hole in INV-3 for anything that is not an SPT.
  for (const bad of [async () => undefined, async () => ({ ok: false }), async () => ({ ok: true })]) {
    const { exec, calls } = setup({ verify: bad });
    const session_id = await newSession(exec);
    await assert.rejects(
      exec('complete_checkout_session', { idempotency_key: 'idem-inv3-spt', session_id, payment_authorization: { token: 'pm_card_visa' } }, CTX),
      (e) => e.code === 'CONFIRMATION_INVALID',
    );
    assert.equal(calls.create_order, 0);
    assert.equal(calls.delegated, 0);
    assert.equal(calls.submit_payment, 0);
  }
});

test('flag ON: the quote is claimed single-use — one locked quote can only ever become one delegated charge', async () => {
  const { exec, calls } = setup();
  const session_id = await newSession(exec);
  await exec('complete_checkout_session', { idempotency_key: 'idem-once-1', session_id, payment_authorization: sptAuth() }, CTX);

  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-once-2', session_id, payment_authorization: sptAuth() }, CTX),
    (e) => e.code === 'QUOTE_ALREADY_USED',
    'a second completion under a NEW key must be refused by the single-use claim',
  );
  assert.equal(calls.create_order, 1);
  assert.equal(calls.delegated, 1, 'charged exactly once');
});

test('flag ON: a same-key replay of a SUCCESSFUL completion returns the original result and does NOT re-charge', async () => {
  const { exec, calls } = setup();
  const session_id = await newSession(exec);
  const params = { idempotency_key: 'idem-replay-1', session_id, payment_authorization: sptAuth() };
  const first = await exec('complete_checkout_session', { ...params }, CTX);
  const replay = await exec('complete_checkout_session', { ...params }, CTX);
  assert.deepEqual(replay, first, 'the replay returns the ORIGINAL {order, payment}');
  assert.equal(calls.create_order, 1);
  assert.equal(calls.delegated, 1, 'charge-once across the replay');
});

test('flag ON: a mid-flight replay by a DIFFERENT buyer cannot read back the first buyer\'s result', async () => {
  // The ledger short-circuits a replay BEFORE ownership is checked, so the base key is user+session scoped.
  // The SPT lane inherits that scoping because it runs inside the SAME idempotency run.
  const { exec, calls } = setup();
  const session_id = await newSession(exec);
  await exec('complete_checkout_session', { idempotency_key: 'shared-key-1', session_id, payment_authorization: sptAuth() }, CTX);
  await assert.rejects(
    exec(
      'complete_checkout_session',
      { idempotency_key: 'shared-key-1', session_id, payment_authorization: sptAuth() },
      { user_ref: 'user_evil', acp_session_id: 'acp_evil' },
    ),
    (e) => e.code === 'QUOTE_NOT_FOUND' || e.code === 'STATE_LINKAGE_MISMATCH',
  );
  assert.equal(calls.delegated, 1);
});

// --- failure semantics (money path) ------------------------------------------------------------------------

test('flag ON: a backend charge failure surfaces honestly, and NO retry route can mint a second charge', async () => {
  // The dispatcher throws AFTER the backend has been asked to charge. That is the AMBIGUOUS class: money may
  // have moved. The buyer must get the real error — never "already completed" — and both retry routes must be
  // closed to a second charge.
  const { exec, calls } = setup({
    dispatchImpl: async () => { throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'upstream_timeout' }); },
  });
  const session_id = await newSession(exec);
  const params = { idempotency_key: 'idem-fail-1', session_id, payment_authorization: sptAuth() };

  await assert.rejects(
    exec('complete_checkout_session', { ...params }, CTX),
    (e) => e.code === 'MERCHANT_UNAVAILABLE' && e.detail?.reason === 'upstream_timeout',
    'the buyer sees the truthful upstream error, not a fabricated completion',
  );
  assert.equal(calls.delegated, 1);

  // Route 1: the SAME key. The ledger recorded the attempt ambiguous (the side effect had begun), so a retry
  // is refused rather than re-executed.
  await assert.rejects(
    exec('complete_checkout_session', { ...params }, CTX),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT' && e.detail?.reason === 'ambiguous_prior_attempt',
  );

  // Route 2: a NEW key — the re-keying route the doctrine calls out. The quote is already claimed, so it is
  // refused before anything can be dispatched.
  await assert.rejects(
    exec('complete_checkout_session', { ...params, idempotency_key: 'idem-fail-2' }, CTX),
    (e) => e.code === 'QUOTE_ALREADY_USED',
  );

  assert.equal(calls.delegated, 1, 'exactly one dispatch survived all retry routes');
  assert.equal(calls.create_order, 1);
});

test('flag ON: an unknown/absent backend payment status is treated as IN FLIGHT (order stays locked)', async () => {
  // Stripe has not documented the SPT usage-limit error codes, so the conservative default matters: anything
  // we cannot classify as a definitive success or failure must leave the order charge_pending, not reopen it.
  const { kernel, exec, calls } = setup({ dispatchImpl: async () => ({ payment_id: 'pay_?', payment_status: 'weird_unknown_code' }) });
  const session_id = await newSession(exec);
  const out = await exec('complete_checkout_session', { idempotency_key: 'idem-unk-1', session_id, payment_authorization: sptAuth() }, CTX);
  assert.equal(out.payment.order_status, 'charge_pending', 'unknown ⇒ in flight, never "paid"');
  const stored = await kernel._orderStore.get('o_1');
  assert.equal(stored.status, 'charge_pending', 'the durable order record is what blocks a second charge');
  assert.equal(calls.delegated, 1);
});

test('flag ON: a definitive backend decline marks the order failed and does not pretend to have completed', async () => {
  const { kernel, exec } = setup({ dispatchImpl: async () => ({ payment_id: 'pay_no', payment_status: 'declined' }) });
  const session_id = await newSession(exec);
  const out = await exec('complete_checkout_session', { idempotency_key: 'idem-dec-1', session_id, payment_authorization: sptAuth() }, CTX);
  assert.equal(out.payment.order_status, 'failed');
  const stored = await kernel._orderStore.get('o_1');
  assert.equal(stored.status, 'failed');
});

test('the SPT lane does not require a JWS verifier to be configured — but every other lane still does', async () => {
  // Deliberate decoupling: the SPT lane never calls verifyPaymentAuthorization, so gating it on an unrelated
  // JWKS verifier being wired would make it fail for a reason that has nothing to do with it. Its own
  // fail-closed gates are the flag, the route-level submit_payment kill-switch, and the dispatcher check.
  const build = ({ enabled }) => {
    const calls = { create_order: 0, delegated: 0 };
    const quiet = { info() {}, warn() {}, error() {} };
    const kernel = new SafetyKernel({
      upstream: async (op) => {
        if (op === 'preview_quote') return QUOTE;
        if (op === 'create_order') { calls.create_order++; return { order_id: 'o_nv', acp_state: {} }; }
        return {};
      },
      secret: SECRET,
      log: quiet,
    });
    const { execute } = createCanonicalExecutor({
      kernel,
      upstream: async () => ({}),
      // NO verifyPaymentAuthorization at all.
      submitDelegatedPayment: async () => { calls.delegated++; return { payment_id: 'pay_d', payment_status: 'succeeded' }; },
      delegatedTokenHandoffEnabled: () => enabled,
    });
    return { exec: execute, calls };
  };

  const on = build({ enabled: true });
  const sid = await newSession(on.exec);
  const out = await on.exec('complete_checkout_session', { idempotency_key: 'idem-noverifier-1', session_id: sid, payment_authorization: sptAuth() }, CTX);
  assert.equal(out.payment.order_status, 'paid');
  assert.equal(on.calls.delegated, 1);

  // A NON-SPT authorization in the same process still fails closed on the missing verifier.
  const CTX2 = { user_ref: 'user_2', acp_session_id: 'acp_2' };
  const sid2 = await newSession(on.exec, CTX2);
  await assert.rejects(
    on.exec('complete_checkout_session', { idempotency_key: 'idem-noverifier-2', session_id: sid2, payment_authorization: { token: 'pm_card_visa' } }, CTX2),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'no_payment_authorization_verifier',
  );

  // And with the flag OFF the SPT gets the same missing-verifier refusal as everything else.
  const off = build({ enabled: false });
  const sid3 = await newSession(off.exec);
  await assert.rejects(
    off.exec('complete_checkout_session', { idempotency_key: 'idem-noverifier-3', session_id: sid3, payment_authorization: sptAuth() }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'no_payment_authorization_verifier',
  );
  assert.equal(off.calls.delegated, 0);
});

test('flag ON but the dispatcher is NOT wired: fail closed, and do NOT burn the quote', async () => {
  const { exec, calls } = setup({ wireDispatcher: false });
  const session_id = await newSession(exec);
  await assert.rejects(
    exec('complete_checkout_session', { idempotency_key: 'idem-nodisp-1', session_id, payment_authorization: sptAuth() }, CTX),
    (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'no_delegated_payment_dispatcher',
  );
  assert.equal(calls.create_order, 0, 'nothing irreversible happened, so the checkout session must survive');
  assert.equal(calls.delegated, 0);
});

test('flag ON: a drifted order amount fails CLOSED before the charge', async () => {
  // The order is derived from the same snapshot the token allowance was sized against, so a divergence means
  // a regression. Charging it would charge money nobody authorized.
  for (const drift of [{ amount_total: 99999 }, { currency: 'JPY' }, { merchant_of_record: 'merch_EVIL' }]) {
    const { kernel, exec, calls } = setup();
    const session_id = await newSession(exec);
    const real = kernel.createOrder.bind(kernel);
    kernel.createOrder = async (p, c) => ({ ...(await real(p, c)), ...drift });
    await assert.rejects(
      exec('complete_checkout_session', { idempotency_key: 'idem-drift-spt', session_id, payment_authorization: sptAuth() }, CTX),
      (e) => e.code === 'CONFIRMATION_INVALID',
      `drifted ${Object.keys(drift)[0]} must fail closed`,
    );
    assert.equal(calls.delegated, 0, 'no charge on drifted money');
  }
});

// --- the token must not leak ------------------------------------------------------------------------------

test('the SPT never reaches a log line, an idempotency fingerprint body, or any persisted record', async () => {
  const { exec, logLines, dumpState, calls } = setup();
  const session_id = await newSession(exec);
  await exec('complete_checkout_session', { idempotency_key: 'idem-leak-1', session_id, payment_authorization: sptAuth() }, CTX);
  assert.equal(calls.delegated, 1);

  const logged = JSON.stringify(logLines);
  assert.ok(!logged.includes(SPT), `the token appeared in a log line: ${logged}`);
  assert.ok(!logged.includes('spt_'), `an spt_ prefix appeared in a log line: ${logged}`);

  // Persisted state: quotes, idempotency ledger, confirmations, orders, quote claims. The ledger stores a
  // sha256 fingerprint of the request body rather than the body, and the token rides the dispatch CLOSURE
  // rather than the payment payload, so neither the outer nor the inner ledger record can contain it.
  const state = dumpState();
  assert.ok(!state.includes(SPT), 'the token was persisted somewhere it must not be');
  assert.ok(!state.includes('spt_'), 'an spt_-prefixed value was persisted');
});

test('a failing delegated charge does not leak the token into the error path either', async () => {
  const { exec, logLines, dumpState } = setup({
    dispatchImpl: async () => { throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'upstream_5xx' }); },
  });
  const session_id = await newSession(exec);
  let caught;
  try {
    await exec('complete_checkout_session', { idempotency_key: 'idem-leak-2', session_id, payment_authorization: sptAuth() }, CTX);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.ok(!JSON.stringify(caught.detail ?? {}).includes('spt_'), 'the error detail must not carry the token');
  assert.ok(!String(caught.message).includes('spt_'));
  assert.ok(!JSON.stringify(logLines).includes('spt_'));
  assert.ok(!dumpState().includes('spt_'));
});

// --- end to end over the ACP REST surface -----------------------------------------------------------------

const ACP_SIGNING_SECRET = 'acp-spt-secret-0123456789abcdef01';
const FIXED_NOW = 1_900_000_000_000;

function acpSetup({ enabled = true } = {}) {
  const calls = { create_order: 0, submit_payment: 0, delegated: 0, verify: 0 };
  const createOrderBodies = [];
  const delegatedBodies = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const kernelUpstream = async (op, payload) => {
    if (op === 'preview_quote') return QUOTE;
    if (op === 'create_order') { calls.create_order++; createOrderBodies.push(payload); return { order_id: 'o_acp', acp_state: {} }; }
    if (op === 'submit_payment') { calls.submit_payment++; return { payment_id: 'pay_hosted', payment_status: 'succeeded' }; }
    return {};
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet, now: () => FIXED_NOW });
  const adapter = createAcpRestAdapter({
    executor: createCanonicalExecutor({
      kernel,
      upstream: async () => ({}),
      // The REAL verifier — so the flag-off assertion below is the production refusal, not a stub's.
      verifyPaymentAuthorization: createPaymentAuthorizationVerifier({
        methods: { acp_delegated_token: async () => { calls.verify++; return { merchant_id: 'merch_A' }; } },
      }),
      submitDelegatedPayment: async (bound) => {
        calls.delegated++;
        delegatedBodies.push(bound);
        return { payment_id: 'pay_delegated_acp', payment_status: 'succeeded' };
      },
      delegatedTokenHandoffEnabled: () => enabled,
    }),
    sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }),
    signingSecret: ACP_SIGNING_SECRET,
    resolveUserRef: async (r) => r.headers['x-test-buyer'],
    getProducts: async () => [],
    now: () => FIXED_NOW,
  });
  return { adapter, calls, createOrderBodies, delegatedBodies };
}

function acpReq({ body = {}, id, idem }) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(FIXED_NOW);
  return {
    headers: {
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

const createBody = {
  merchant_id: 'merch_A',
  buyer: { email: 'spt@example.com' },
  items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }],
};

test('ACP REST, flag OFF: POST /complete with an spt_ answers 402 CONFIRMATION_INVALID and leaves the session spendable', async () => {
  const { adapter, calls } = acpSetup({ enabled: false });
  const created = await adapter.createCheckoutSession(acpReq({ body: createBody, idem: 'idem-acp-off-c' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const res = await adapter.completeCheckoutSession(acpReq({ id: created.body.id, body: { payment_data: { token: SPT } }, idem: 'idem-acp-off-1' }));
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'CONFIRMATION_INVALID');
  assert.equal(calls.delegated, 0);
  assert.equal(calls.create_order, 0, 'the refusal must not burn the checkout session');
  assert.ok(!JSON.stringify(res.body).includes('spt_'), 'the refusal body must not echo the token');
});

test('ACP REST, flag ON: POST /complete with an spt_ completes through the delegated lane', async () => {
  const { adapter, calls, createOrderBodies, delegatedBodies } = acpSetup({ enabled: true });
  const created = await adapter.createCheckoutSession(acpReq({ body: createBody, idem: 'idem-acp-on-c' }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;

  const res = await adapter.completeCheckoutSession(acpReq({ id, body: { payment_data: { provider: 'stripe', token: SPT } }, idem: 'idem-acp-on-1' }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.order.id, 'o_acp');
  assert.equal(res.body.order.amount_total, 113);
  assert.ok(!JSON.stringify(res.body).includes('spt_'), 'the response must not echo the token back');

  assert.equal(calls.verify, 0, 'the SPT was never presented to the JWS verifier');
  assert.equal(calls.submit_payment, 0, 'the hosted checkout lane was not used');
  assert.equal(calls.delegated, 1);
  assert.equal(delegatedBodies[0].token, SPT);
  assert.equal(createOrderBodies[0].order.metadata?.protocol_name, 'acp');
  assert.equal(createOrderBodies[0].order.quote_id, BACKEND_QUOTE_ID);

  // The session is now genuinely spent — a further complete is refused, and refused without a second charge.
  const again = await adapter.completeCheckoutSession(acpReq({ id, body: { payment_data: { provider: 'stripe', token: SPT } }, idem: 'idem-acp-on-2' }));
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'QUOTE_ALREADY_USED');
  assert.equal(calls.delegated, 1, 'still exactly one charge');
});


test('the delegated lane is scoped to the ACP door: another door takes the verifier path unchanged', async () => {
  // Review F2. completeCheckout is SHARED, and the MCP tool surface accepts a free-form
  // `payment_authorization` — so without the ctx gate an /mcp completion carrying an `spt_` would route to
  // the delegated lane under a flag named ACP_SPT_GATEWAY_HANDOFF_ENABLED, and would write
  // `protocol_name: 'acp'` onto the backend order, which is the field the backend's off-session gate keys
  // on. A false value there is a falsified provenance record on the money path.
  const dispatched = [];
  const verified = [];
  const { exec, calls } = setup({
    enabled: true,
    dispatchImpl: async (bound) => { dispatched.push(bound); return { payment_status: 'succeeded', payment_id: 'pay_1' }; },
    verify: async (auth) => { verified.push(auth); throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'unknown_authorization_method' }); },
  });
  const session_id = await newSession(exec, CTX_NON_ACP);

  await assert.rejects(
    exec('complete_checkout_session',
      { idempotency_key: 'idem-nonacp', session_id, payment_authorization: { token: 'spt_live_1' } },
      CTX_NON_ACP),
    (e) => e.code === 'CONFIRMATION_INVALID',
    'a non-ACP door must fall through to the verifier, which cannot attest an spt_',
  );
  assert.equal(dispatched.length, 0, 'no delegated dispatch from another door');
  assert.equal(verified.length, 1, 'the verifier ran instead — INV-3 unchanged off the ACP door');
  assert.equal(calls.create_order, 0, 'and no order was created');
});
