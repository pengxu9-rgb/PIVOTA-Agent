// Delegated-payment vaulting is PERMANENTLY refused — ACP `POST /agentic_commerce/delegate_payment`,
// canonical op `exchange_payment_token`, UCP `payment.token_exchange`.
//
// Four properties are asserted here, because each one has already been a real defect somewhere:
//   1. The refusal is SPEC-AWARE and ACTIONABLE — a named reason plus the pointer at the merchant's PSP /
//      Stripe SharedPaymentToken — not the old blind `token_exchange_verified_at_complete`, which described a
//      "we verify it at complete" step that does not exist.
//   2. The refusal NEVER TOUCHES THE REQUEST BODY. A delegate_payment body carries a raw PAN and CVC; the
//      conformance fixture below carries both, and neither may appear in the response.
//   3. Nothing ADVERTISES the operation. Advertising an operation that permanently refuses is the
//      "advertised but not executable" defect already fixed once for the checkout capabilities.
//   4. The refusal reaches no kernel, no store, no secret.
//
// Request fixture: the ACP 2026-04-17 / OpenAI Delegated Payment Spec shape (see fixtures/ for provenance).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PivotaCommerceError } from '../src/errors.js';
import {
  DELEGATED_PAYMENT_REFUSAL_REASON,
  DELEGATED_PAYMENT_REFUSAL_DETAIL,
  DELEGATED_PAYMENT_REFUSAL_MESSAGE,
  DELEGATED_PAYMENT_REFUSAL_HTTP_STATUS,
  delegatedPaymentRefusalAcpResponse,
} from '../src/protocol/delegatedPaymentRefusal.js';
import {
  canonicalOp, operationsForCapability, REFUSAL_ONLY_OPERATIONS, CANONICAL_CAPABILITIES,
} from '../src/protocol/canonicalContract.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { delegatePayment, createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { createAcpRouteHandlers } from '../src/protocol/acpRestRoutes.js';
import { buildUcpProfile } from '../src/protocol/ucpProfile.js';

const SPEC_REQUEST = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/acp_delegate_payment_request_2026-04-17.json', import.meta.url)),
  'utf8',
));
const PAN = SPEC_REQUEST.payment_method.number;
const CVC = SPEC_REQUEST.payment_method.cvc;

// Guard the guard: if the fixture ever loses its cardholder fields, the leak assertions below would pass
// vacuously and this suite would silently stop testing the thing it exists to test.
test('conformance fixture is the ACP 2026-04-17 delegate_payment shape and carries cardholder data', () => {
  assert.equal(SPEC_REQUEST.payment_method.type, 'card');
  assert.equal(SPEC_REQUEST.payment_method.card_number_type, 'fpan');
  assert.ok(/^\d{12,19}$/.test(PAN), 'fixture must carry a PAN');
  assert.ok(/^\d{3,4}$/.test(CVC), 'fixture must carry a CVC');
  for (const k of ['reason', 'max_amount', 'currency', 'checkout_session_id', 'merchant_id', 'expires_at']) {
    assert.ok(k in SPEC_REQUEST.allowance, `allowance.${k} present`);
  }
  assert.ok(Array.isArray(SPEC_REQUEST.risk_signals) && SPEC_REQUEST.risk_signals.length > 0);
  assert.ok(SPEC_REQUEST.billing_address && typeof SPEC_REQUEST.billing_address === 'object');
});

// ---- 1. the refusal is specific and actionable -------------------------------------------------------------

test('the refusal names the real reason and points at the merchant PSP / Stripe SPT', () => {
  assert.equal(DELEGATED_PAYMENT_REFUSAL_REASON, 'delegated_payment_vaulting_not_supported');
  // The OLD reason claimed a verification step that does not exist. It must be gone everywhere.
  assert.ok(!DELEGATED_PAYMENT_REFUSAL_MESSAGE.includes('token_exchange_verified_at_complete'));
  assert.notEqual(DELEGATED_PAYMENT_REFUSAL_DETAIL.reason, 'token_exchange_verified_at_complete');

  // Permanent architectural fact, not a rollout stage / kill-switch.
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.permanent, true);
  // Pivota's actual role: commerce index / protocol edge — never vault, never merchant of record.
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.role, 'commerce_index_passthrough');
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.merchant_of_record, false);
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.payment_vault, false);
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.pci_dss_level_1, false);
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.cardholder_data_scope, false);
  // Whose endpoint it is, and the supported rail (merchant's own Stripe account receives the SPT).
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.endpoint_owner, 'merchant_psp');
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.delegated_payment_rail, 'stripe_shared_payment_token');
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.delegated_payment_rail_recipient, 'merchant_stripe_account');
  // Where an authorization IS presented instead.
  assert.match(DELEGATED_PAYMENT_REFUSAL_DETAIL.present_authorization_at, /\/complete$/);
  assert.equal(DELEGATED_PAYMENT_REFUSAL_DETAIL.present_authorization_field, 'payment_data');

  // The prose must carry the same three facts a human integrator needs.
  assert.match(DELEGATED_PAYMENT_REFUSAL_MESSAGE, /never will/i);
  assert.match(DELEGATED_PAYMENT_REFUSAL_MESSAGE, /PSP/);
  assert.match(DELEGATED_PAYMENT_REFUSAL_MESSAGE, /SharedPaymentToken/);
});

// ---- 2. the kernel-side error (canonical executor) ---------------------------------------------------------

// A kernel stand-in that FAILS LOUDLY: reaching any of it means the refusal leaked into the money path.
function explodingKernel() {
  const trap = (name) => () => { throw new Error(`kernel.${name} must never be reached by the refusal`); };
  return {
    previewQuote: trap('previewQuote'), createOrder: trap('createOrder'), mintConfirmation: trap('mintConfirmation'),
    submitPayment: trap('submitPayment'), requestAfterSales: trap('requestAfterSales'),
    quotes: { resolveForOrder: trap('quotes.resolveForOrder') }, idempotency: { run: trap('idempotency.run') },
    _requireOrder: trap('_requireOrder'),
  };
}

test('executor: exchange_payment_token throws the spec-aware OPERATION_NOT_ALLOWED refusal', async () => {
  const { execute } = createCanonicalExecutor({
    kernel: explodingKernel(),
    upstream: () => { throw new Error('upstream must never be reached'); },
    verifyPaymentAuthorization: () => { throw new Error('verifier must never be reached'); },
  });

  await assert.rejects(
    execute('exchange_payment_token', {}, { user_ref: 'user_1', acp_session_id: 'acp_1' }),
    (err) => {
      assert.ok(err instanceof PivotaCommerceError);
      // Error CLASS is contract-stable; the specificity lives in the detail.
      assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
      assert.equal(err.retriable, false);
      assert.equal(err.detail.reason, DELEGATED_PAYMENT_REFUSAL_REASON);
      assert.equal(err.detail.op, 'exchange_payment_token');
      assert.equal(err.detail.endpoint_owner, 'merchant_psp');
      assert.equal(err.detail.delegated_payment_rail, 'stripe_shared_payment_token');
      // `.message` carries the curated text (PivotaCommerceError uses detail.message when present), which is
      // what the /invoke error body surfaces as `message`.
      assert.equal(err.message, DELEGATED_PAYMENT_REFUSAL_MESSAGE);
      return true;
    },
  );
});

test('executor: the refusal is answered BEFORE the auth/session gates (no sign-in-then-be-refused loop)', async () => {
  const { execute } = createCanonicalExecutor({ kernel: explodingKernel() });
  // No user_ref, no acp_session_id: those gates would otherwise fire first for this user-scoped op.
  await assert.rejects(execute('exchange_payment_token', {}, {}), (err) => {
    assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
    assert.notEqual(err.code, 'USER_AUTH_REQUIRED');
    assert.equal(err.detail.reason, DELEGATED_PAYMENT_REFUSAL_REASON);
    return true;
  });
});

test('executor: a spec-shaped delegate_payment body is refused and NEVER echoed back', async () => {
  const { execute } = createCanonicalExecutor({ kernel: explodingKernel() });
  // Pass the real spec request as params — the refusal must ignore it entirely.
  const err = await execute('exchange_payment_token', { ...SPEC_REQUEST }, { user_ref: 'u', acp_session_id: 's' })
    .then(() => null, (e) => e);
  assert.ok(err, 'must reject');
  const serialized = JSON.stringify({ message: err.message, detail: err.detail, code: err.code });
  assert.ok(!serialized.includes(PAN), 'PAN must not appear in the kernel error');
  assert.ok(!serialized.includes(CVC), 'CVC must not appear in the kernel error');
  assert.ok(!serialized.includes(SPEC_REQUEST.allowance.checkout_session_id), 'no request field is echoed');
});

// ---- 3. the ACP REST door ----------------------------------------------------------------------------------

test('ACP door: delegatePayment returns the refusal envelope with the documented type/code vocabulary', () => {
  const out = delegatePayment();
  // 501 Not Implemented: the request is not malformed (so not 4xx) and nothing is temporarily down (so not
  // 503 — nothing here should ever be retried).
  assert.equal(out.status, 501);
  assert.equal(out.status, DELEGATED_PAYMENT_REFUSAL_HTTP_STATUS);
  // Same envelope shape every other error from this adapter uses (see acpRestAdapter's guard()).
  assert.deepEqual(Object.keys(out.body).sort(), ['code', 'detail', 'message', 'type']);
  assert.equal(out.body.type, 'error');
  assert.equal(out.body.code, 'OPERATION_NOT_ALLOWED');
  assert.equal(out.body.message, DELEGATED_PAYMENT_REFUSAL_MESSAGE);
  assert.equal(out.body.detail.reason, DELEGATED_PAYMENT_REFUSAL_REASON);
});

test('ACP door: the refusal is a fresh object each call (a mutating caller cannot corrupt the constant)', () => {
  const a = delegatedPaymentRefusalAcpResponse();
  a.body.message = 'tampered';
  a.body.detail.reason = 'tampered';
  const b = delegatedPaymentRefusalAcpResponse();
  assert.equal(b.body.message, DELEGATED_PAYMENT_REFUSAL_MESSAGE);
  assert.equal(b.body.detail.reason, DELEGATED_PAYMENT_REFUSAL_REASON);
});

test('ACP door: a request carrying a PAN + CVC is refused and neither value appears in the response', () => {
  // Handed the full spec request in every position a handler could read it from.
  const out = delegatePayment({
    headers: { signature: 'sig', timestamp: `${Date.now()}` },
    rawBody: JSON.stringify(SPEC_REQUEST),
    body: SPEC_REQUEST,
    params: {},
  });
  assert.equal(out.status, 501);
  const serialized = JSON.stringify(out.body);
  assert.ok(!serialized.includes(PAN), 'PAN must not appear in the response');
  assert.ok(!serialized.includes(CVC), 'CVC must not appear in the response');
  assert.ok(!serialized.includes(SPEC_REQUEST.payment_method.display_last4));
  assert.ok(!serialized.includes(SPEC_REQUEST.allowance.merchant_id));
  assert.ok(!serialized.includes(SPEC_REQUEST.billing_address.postal_code));
  // Byte-identical to the no-argument call: proof the argument was not read at all.
  assert.deepEqual(out, delegatePayment());
});

test('ACP door: the refusal needs no executor/store/secret and reaches none of them', () => {
  // delegatePayment is exported OUTSIDE createAcpRestAdapter's closure, so it cannot even see them.
  assert.equal(delegatePayment.length, 0);
  const boom = () => { throw new Error('must never be reached'); };
  const adapter = createAcpRestAdapter({
    executor: { execute: boom },
    sessionStore: { get: boom, set: boom, putIfAbsent: boom },
    signingSecret: 'signing-secret-0123456789abc',
    resolveUserRef: boom,
  });
  assert.equal(adapter.delegatePayment, delegatePayment);
  assert.equal(adapter.delegatePayment().status, 501);
});

test('ACP routes: delegate_payment is mounted and the handler is invoked with NO request at all', async () => {
  const boom = () => { throw new Error('must never be reached'); };
  const seen = [];
  const adapter = createAcpRestAdapter({
    executor: { execute: boom },
    sessionStore: { get: boom, set: boom, putIfAbsent: boom },
    signingSecret: 'signing-secret-0123456789abc',
    resolveUserRef: boom,
  });
  // Wrap the constant so the route table's "call with nothing" contract is observable.
  adapter.delegatePayment = (...args) => { seen.push(args); return delegatePayment(); };

  const routes = createAcpRouteHandlers(adapter, { basePath: '/acp' });
  const route = routes.find((r) => r.method === 'POST' && r.path === '/acp/agentic_commerce/delegate_payment');
  assert.ok(route, 'delegate_payment route is mounted');

  const out = await route.handler({ headers: {}, rawBody: JSON.stringify(SPEC_REQUEST), body: SPEC_REQUEST, params: {} });
  assert.equal(out.status, 501);
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(out.body.code, 'OPERATION_NOT_ALLOWED');
  assert.deepEqual(seen, [[]], 'the handler receives no arguments — the body cannot reach it');
});

// ---- 4. nothing advertises it ------------------------------------------------------------------------------

test('contract: exchange_payment_token is flagged refusalOnly and the flag is discoverable', () => {
  assert.equal(canonicalOp('exchange_payment_token').refusalOnly, true);
  assert.ok(REFUSAL_ONLY_OPERATIONS.includes('exchange_payment_token'));
  // The contract VIEW still lists it (the door exists and answers a named refusal)...
  assert.ok(operationsForCapability('payment').includes('exchange_payment_token'));
  // ...but the ADVERTISABLE view does not.
  assert.ok(!operationsForCapability('payment', { includeRefusalOnly: false }).includes('exchange_payment_token'));
  // No other operation is refusal-only — a new one must be a deliberate decision, not an accident.
  assert.deepEqual([...REFUSAL_ONLY_OPERATIONS], ['exchange_payment_token']);
});

test('UCP profile: the refused operation and its now-empty capability are never advertised', () => {
  // no omissions: full advertisement. A transport is required for capabilities to appear at all
  // (the no-transport rule in ucpProfile.js), so this declares one and keeps the subject the refusal.
  const profile = buildUcpProfile({
    baseUrl: 'https://ucp.test.local',
    mcpEndpoint: 'https://ucp.test.local/ucp/mcp',
  });
  const serialized = JSON.stringify(profile);
  assert.ok(!serialized.includes('exchange_payment_token'), 'canonical op not advertised');
  assert.ok(!serialized.includes('payment.token_exchange'), 'UCP surface name not advertised');
  // Its capability held nothing else, so the capability itself is gone rather than shipping an empty entry.
  // `capabilities` is a MAP keyed by id — the spec's shape.
  const capIds = Object.keys(profile.ucp.capabilities);
  assert.ok(!capIds.includes('dev.ucp.shopping.ap2_mandate'));
  // Everything executable is still advertised, and no capability is left empty.
  assert.ok(capIds.includes('dev.ucp.shopping.checkout'));
  // This fixture now DECLARES a transport, because a transport-less profile advertises nothing at all
  // (no-transport rule, founder decision 2026-08-13) and this test's subject is the refusal, not the
  // empty case. With a door advertised the tool-reachability filter applies, so insights / order are
  // withheld here — that filter is unchanged by this rule and is asserted in protocol.test.js
  // 'a capability is advertised ONLY where the advertised door can actually serve it'.
  assert.ok(capIds.includes('dev.ucp.shopping.catalog.search'), 'search_catalog has a ucpTool since 2026-08-18');
  assert.ok(capIds.includes('dev.ucp.shopping.catalog.lookup'));
  assert.ok(capIds.includes('dev.ucp.common.identity_linking'));
  assert.ok(!capIds.includes('dev.ucp.shopping.order'), 'no ucpTool behind it on this door');
  // …and NOT the vendor capability, whose spec/schema documents are not hosted. Withholding it is what keeps
  // the document valid; a partial entry would make a validator reject all of the above with it.
  assert.ok(!capIds.includes('cc.pivota.insights'), 'no hosted spec/schema documents');
  // No capability is a title with nothing behind it. `operations` is not a spec member and is no longer
  // published, so the rule is asserted on what the document DOES carry plus the contract behind each id: a
  // MODIFIER (UCP `extends` + `config`, e.g. dev.ucp.shopping.fulfillment) is the one entry with no
  // operations of its OWN — what stands behind it is its config plus the capability it extends, which must
  // itself be advertised. So the rule is not relaxed, it is stated exactly: operations, or a present parent.
  const capIdSet = new Set(capIds);
  for (const [id, entries] of Object.entries(profile.ucp.capabilities)) {
    const entry = entries[0];
    const parents = entry.extends === undefined
      ? null
      : (Array.isArray(entry.extends) ? entry.extends : [entry.extends]);
    if (parents) {
      assert.ok(parents.some((parent) => capIdSet.has(parent)), `${id} extends a capability that is not advertised`);
    } else {
      const key = Object.keys(CANONICAL_CAPABILITIES).find((k) => CANONICAL_CAPABILITIES[k].ucp === id);
      assert.ok(operationsForCapability(key, { includeRefusalOnly: false }).length > 0,
        `${id} advertises no empty capability`);
    }
    // Every entry carries the members the spec marks REQUIRED — one incomplete entry invalidates the lot.
    assert.equal(typeof entry.spec, 'string', `${id} must publish a spec URL`);
    assert.equal(typeof entry.schema, 'string', `${id} must publish a schema URL`);
  }
  // Payment authorization is NOT lost — it is presented inline on the complete operation, which the checkout
  // capability still advertises (asserted through the contract, since operations are not in the document).
  assert.ok(capIdSet.has('dev.ucp.shopping.checkout'));
  assert.ok(operationsForCapability('checkout', { includeRefusalOnly: false }).includes('complete_checkout_session'));
});
