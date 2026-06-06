// Unified payment-authorization verifier tests — the binding invariant that gates every charge. Uses STUB
// crypto verifiers (the per-method signature checks are tested separately) to exercise the binding logic:
// merchant/currency/amount/session/buyer/expiry must all tie the VERIFIED claims to THIS order, or fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentAuthorizationVerifier, assertPaymentBinding } from '../src/protocol/paymentAuthorizationVerifier.js';

const NOW = 1_900_000_000_000;
const BOUND = { order_id: 'o1', user_ref: 'usr_1', amount: 113, currency: 'USD', ctx: { acp_session_id: 'sess_1' } };
// a fully-valid allowance grant for BOUND
const GOOD = { max_amount: 200, currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1', user_ref: 'usr_1', expires_at: NOW + 60_000, id: 'g1' };

function verifierWith(claims, { method = 'acp_delegated_token' } = {}) {
  return createPaymentAuthorizationVerifier({
    merchantId: 'merch_A', now: () => NOW,
    methods: { [method]: async () => claims },
  });
}

test('construction requires merchantId + methods', () => {
  assert.throws(() => createPaymentAuthorizationVerifier({ methods: {} }), /merchantId/);
  assert.throws(() => createPaymentAuthorizationVerifier({ merchantId: 'm' }), /methods/);
});

test('happy: a signed allowance covering the order yields the bound attestation', async () => {
  const v = verifierWith(GOOD);
  const att = await v({ method: 'acp_delegated_token', token: 't' }, BOUND);
  assert.deepEqual(att, { ok: true, method: 'acp_delegated_token', amount: 113, currency: 'USD', user_ref: 'usr_1', authorization_id: 'g1' });
});

test('unknown / unconfigured method fails closed (no charge by absence-of-verifier)', async () => {
  const v = createPaymentAuthorizationVerifier({ merchantId: 'merch_A', now: () => NOW, methods: { acp_delegated_token: async () => GOOD } });
  await assert.rejects(v({ method: 'nope', token: 't' }, BOUND), (e) => e.code === 'CONFIRMATION_INVALID' && e.detail?.reason === 'unknown_authorization_method');
  await assert.rejects(v({ method: 'ap2_mandate', mandate: 'm' }, BOUND), (e) => e.detail?.reason === 'no_verifier_for_method');
  await assert.rejects(v(null, BOUND), (e) => e.detail?.reason === 'authorization_missing');
});

test('a throwing or empty crypto verifier fails closed', async () => {
  const throws = createPaymentAuthorizationVerifier({ merchantId: 'merch_A', now: () => NOW, methods: { acp_delegated_token: async () => { throw new Error('bad sig'); } } });
  await assert.rejects(throws({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'authorization_verification_failed');
  const empty = verifierWith(null);
  await assert.rejects(empty({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'verifier_returned_no_claims');
});

test('binding: merchant / currency mismatches fail closed', async () => {
  await assert.rejects(verifierWith({ ...GOOD, merchant_id: 'merch_OTHER' })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'merchant_mismatch');
  await assert.rejects(verifierWith({ ...GOOD, currency: 'EUR' })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'currency_mismatch');
  // case-insensitive currency match is OK
  const att = await verifierWith({ ...GOOD, currency: 'usd' })({ method: 'acp_delegated_token', token: 't' }, BOUND);
  assert.equal(att.ok, true);
});

test('binding: amount — allowance must cover; exact mandate must equal; never both/neither', async () => {
  // allowance too small
  await assert.rejects(verifierWith({ ...GOOD, max_amount: 100 })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'amount_exceeds_allowance');
  // exact mandate matches
  const exact = verifierWith({ currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1', amount: 113, expires_at: NOW + 60_000, id: 'm1' }, { method: 'ap2_mandate' });
  assert.equal((await exact({ method: 'ap2_mandate', mandate: 'm' }, BOUND)).ok, true);
  // exact mandate wrong amount
  const wrong = verifierWith({ currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1', amount: 99, expires_at: NOW + 60_000 }, { method: 'ap2_mandate' });
  await assert.rejects(wrong({ method: 'ap2_mandate', mandate: 'm' }, BOUND), (e) => e.detail?.reason === 'amount_mismatch');
  // both present → ambiguous
  await assert.rejects(verifierWith({ ...GOOD, amount: 113 })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'amount_authorization_ambiguous');
  // neither present → ambiguous
  const neither = { currency: 'USD', merchant_id: 'merch_A', checkout_session_id: 'sess_1', expires_at: NOW + 60_000 };
  await assert.rejects(verifierWith(neither)({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'amount_authorization_ambiguous');
});

test('binding: session — must be present AND match this checkout session (anti-replay across sessions)', async () => {
  await assert.rejects(verifierWith({ ...GOOD, checkout_session_id: undefined })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'authorization_not_session_bound');
  await assert.rejects(verifierWith({ ...GOOD, checkout_session_id: 'sess_OTHER' })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'session_mismatch');
});

test('binding: buyer mismatch (when the claim carries a buyer) fails closed', async () => {
  await assert.rejects(verifierWith({ ...GOOD, user_ref: 'usr_OTHER' })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'buyer_mismatch');
  // a grant without a buyer claim is allowed (ACP has no stable buyer id) — order ownership is enforced by the kernel
  const att = await verifierWith({ ...GOOD, user_ref: undefined })({ method: 'acp_delegated_token', token: 't' }, BOUND);
  assert.equal(att.user_ref, 'usr_1'); // attestation still asserts the authoritative buyer
});

test('binding: expiry is REQUIRED and enforced', async () => {
  await assert.rejects(verifierWith({ ...GOOD, expires_at: undefined })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'authorization_no_expiry');
  await assert.rejects(verifierWith({ ...GOOD, expires_at: NOW - 120_000 })({ method: 'acp_delegated_token', token: 't' }, BOUND), (e) => e.detail?.reason === 'authorization_expired');
});

test('assertPaymentBinding is directly testable and rejects a bad order amount', () => {
  assert.throws(() => assertPaymentBinding('acp_delegated_token', GOOD, { ...BOUND, amount: 0 }, { merchantId: 'merch_A', now: () => NOW }), (e) => e.detail?.reason === 'order_amount_invalid');
  assert.equal(assertPaymentBinding('acp_delegated_token', GOOD, BOUND, { merchantId: 'merch_A', now: () => NOW }), true);
});
