// The seam no other test crosses: UCP ADAPTER OUTPUT -> the REAL payment-authorization verifier.
//
// WHY THIS FILE EXISTS. #1966 published `checkout.payment = { instruments: [...] }` and forwarded it opaquely
// as `payment_authorization`. Every argument-level test passed — the suite was even mutation-checked — because
// all of them stopped at "what did the executor receive?". The kernel's verifier requires a `method`
// discriminator from CANONICAL_PAYMENT_METHODS and refuses anything else with
// CONFIRMATION_INVALID{unknown_authorization_method}, so the one operation the UCP stack exists to enable was
// advertised and could not charge. A defect in the JOIN between two correct-looking halves is invisible to any
// test that only ever exercises one half.
//
// So this file wires the REAL `createPaymentAuthorizationVerifier` over the REAL `createSignedGrantVerifier`,
// exactly as safety-kernel/src/protocol/productionWiring.js does, feeds it what `ucpToNativeToolArgs` actually
// produces, and asserts on whether MONEY WOULD MOVE. Nothing here is a mock or a restatement of the contract:
// if the two sides stop agreeing, the assertion that fails is "this charge would not have gone through".
//
// The grant fixtures are signed with a locally generated ES256 key against a locally pinned JWKS, so the whole
// crypto path (issuer selection, signature, alg allowlist, claim binding) runs for real.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import { ucpToNativeToolArgs, UCP_INPUT_SCHEMAS } from '../src/ucpArgumentAdapter.js';
import {
  createPaymentAuthorizationVerifier,
  CANONICAL_PAYMENT_METHODS,
} from '../../safety-kernel/src/protocol/paymentAuthorizationVerifier.js';
import { createSignedGrantVerifier } from '../../safety-kernel/src/protocol/protocolPaymentVerifiers.js';

// ---- the real gate, wired as production wires it -----------------------------------------------------------

const ISSUER = 'https://payments.example';
const AUDIENCE = 'pivota-agent-mcp';
const MERCHANT = 'merch_efbc46b4619cfbdf';
const SESSION_ID = 'q_locked_1';
const BUYER = 'buyer_1';

const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' };

/** productionWiring.js: `{ acp_delegated_token: grantVerifier, ucp_handler: grantVerifier }`. */
function realVerifier() {
  const grantVerifier = createSignedGrantVerifier({
    issuers: [{ iss: ISSUER, aud: AUDIENCE, jwks: { keys: [jwk] } }],
  });
  return createPaymentAuthorizationVerifier({
    methods: { acp_delegated_token: grantVerifier, ucp_handler: grantVerifier },
  });
}

/** What canonicalExecutor binds the authorization against: the LOCKED quote's money, session and buyer. */
const BOUND = Object.freeze({
  order_id: 'o_1', user_ref: BUYER, amount: 1900, currency: 'USD',
  merchant_id: MERCHANT, checkout_session_id: SESSION_ID, ctx: {},
});

/** A real signed allowance grant — the credential the runbook documents for `ucp_handler`. */
async function signGrant(allowance = {}, { jti = 'grant_1' } = {}) {
  return new SignJWT({
    allowance: {
      max_amount: 2000, currency: 'USD', merchant_id: MERCHANT, checkout_session_id: SESSION_ID, ...allowance,
    },
    user_ref: BUYER,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setJti(jti).setExpirationTime('10m')
    .sign(privateKey);
}

const COMPLETE_OP = { id: 'complete_checkout_session' };
const META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-key-0001' };

/** UCP wire body -> the canonical `payment_authorization` this door hands the kernel. */
function authorizationFor(payment) {
  return ucpToNativeToolArgs(COMPLETE_OP, { meta: META, id: SESSION_ID, checkout: { payment } }).payment_authorization;
}

/** Run the REAL gate over the REAL adapter output. Resolves to a verdict rather than throwing. */
async function wouldCharge(payment) {
  let authorization;
  try {
    authorization = authorizationFor(payment);
  } catch (e) {
    return { charged: false, refusedAt: 'door', code: String(e.code), reason: e.detail?.reason, error: e };
  }
  try {
    return { charged: true, refusedAt: null, attestation: await realVerifier()(authorization, BOUND) };
  } catch (e) {
    return { charged: false, refusedAt: 'kernel', code: String(e.code), reason: e.detail?.reason, error: e };
  }
}

// ---- 1. the published contract actually completes -----------------------------------------------------------

describe('the payment envelope this door PUBLISHES verifies at the real gate', () => {
  test('a body built to the published schema passes the verifier and authorizes THIS order', async () => {
    // The regression test for the whole defect class: a platform that sends exactly what `tools/list`
    // advertises must be able to pay. If this fails, the UCP door is advertising a charge it cannot take.
    const verdict = await wouldCharge({ method: 'ucp_handler', token: await signGrant() });

    assert.equal(verdict.charged, true, `the advertised envelope must charge, got ${verdict.reason}`);
    assert.equal(verdict.attestation.method, 'ucp_handler');
    // The attestation is over the LOCKED quote's money, never the grant's ceiling.
    assert.equal(verdict.attestation.amount, 1900);
    assert.equal(verdict.attestation.currency, 'USD');
    assert.equal(verdict.attestation.user_ref, BUYER);
    assert.equal(verdict.attestation.authorization_id, 'grant_1');
  });

  test('the schema names every field that verification requires — nothing is needed but undocumented', async () => {
    // Build the envelope from the PUBLISHED schema alone, as a platform integrating against `tools/list`
    // would: only `required` members, filled with real values. A field the gate needs but the schema omits
    // fails here rather than in production on someone's charge.
    const schema = UCP_INPUT_SCHEMAS.complete_checkout_session.properties.checkout.properties.payment;
    const built = {};
    for (const field of schema.required) {
      built[field] = field === 'token' ? await signGrant() : schema.properties[field].enum?.[0];
    }
    assert.deepEqual(Object.keys(built).sort(), ['method', 'token']);
    assert.equal((await wouldCharge(built)).charged, true, 'the schema`s required set must be sufficient to pay');
  });

  test('the published `method` enum is a discriminator the kernel actually accepts', () => {
    // The enum is derived from CANONICAL_PAYMENT_METHODS; this pins that derivation against the kernel's own
    // vocabulary, so renaming a method there cannot leave this door advertising a dead one.
    const schema = UCP_INPUT_SCHEMAS.complete_checkout_session.properties.checkout.properties.payment;
    assert.ok(schema.properties.method.enum.length > 0);
    for (const method of schema.properties.method.enum) {
      assert.ok(CANONICAL_PAYMENT_METHODS.includes(method), `${method} is not a canonical payment method`);
    }
  });
});

// ---- 2. the shape that was published before, and why mapping it would NOT have fixed it ----------------------

describe('a UCP payment-handler instrument cannot charge, and is refused where the caller can act on it', () => {
  // The LIVE cosrx instrument, verbatim from `tools/list` 2026-08-13 — `credential.token` is an opaque PSP
  // token (`stripe.token`), not a signed grant. This is exactly what #1966 advertised and forwarded.
  const LIVE_INSTRUMENT_PAYMENT = Object.freeze({
    instruments: [{
      id: 'inst_1', handler_id: 'shopify.card', type: 'card',
      credential: { token: 'tok_live_abc123', type: 'stripe.token' },
      display: { brand: 'visa', last_digits: '4242' },
    }],
  });

  test('the shape #1966 published is refused AT THE DOOR, not deep in the money path', async () => {
    const verdict = await wouldCharge(LIVE_INSTRUMENT_PAYMENT);

    assert.equal(verdict.charged, false, 'an instrument must never authorize a charge on this lane');
    // WHERE it is refused is the point. Before this fix the answer was 'kernel', with
    // `unknown_authorization_method` — a code naming no field, raised after the executor had already entered
    // the completion path. The door refusal names the field and the remedy.
    assert.equal(verdict.refusedAt, 'door');
    assert.equal(verdict.reason, 'ucp_payment_instruments_not_accepted');
    const message = String(verdict.error.detail?.acp_message ?? verdict.error.message);
    assert.match(message, /instruments/);
    assert.match(message, /method/, 'the refusal must name what to send instead');
    assert.match(message, /token/);
  });

  test('mapping handler_id -> method would NOT have made the lane executable (the rejected fix, measured)', async () => {
    // The tempting one-line fix: derive the discriminator from `handler_id`. Simulate its BEST case — the
    // discriminator present, the instrument intact — straight at the real gate, bypassing the door.
    const discriminatorOnly = { ...LIVE_INSTRUMENT_PAYMENT, method: 'ucp_handler' };
    await assert.rejects(
      () => realVerifier()(discriminatorOnly, BOUND),
      (e) => e.detail?.reason === 'grant_token_missing',
      'a discriminator alone leaves the grant missing — one refusal swapped for another',
    );

    // …and lifting the instrument's own credential into the grant slot fails too: a PSP token is not a JWT.
    const withLiftedToken = {
      ...discriminatorOnly, token: LIVE_INSTRUMENT_PAYMENT.instruments[0].credential.token,
    };
    await assert.rejects(
      () => realVerifier()(withLiftedToken, BOUND),
      (e) => e.detail?.reason === 'malformed_credential',
      'an opaque PSP token cannot be verified as a signed grant',
    );
    // Both of these are why the contract is PUBLISHED rather than adapted: no rearrangement of the instrument
    // shape reaches a charge, so a mapper that produced one would be a fallback that only looks valid.
  });

  test('an instrument alongside a valid grant is still refused, not quietly half-honoured', async () => {
    const verdict = await wouldCharge({
      method: 'ucp_handler', token: await signGrant(), instruments: LIVE_INSTRUMENT_PAYMENT.instruments,
    });
    // Ambiguity on the money path resolves to a refusal: the caller named two authorities and only one of them
    // is real, so it must be told rather than have one silently ignored.
    assert.equal(verdict.charged, false);
    assert.equal(verdict.reason, 'ucp_payment_instruments_not_accepted');
  });
});

// ---- 3. the door cannot be softer than the gate --------------------------------------------------------------

describe('every envelope the door ACCEPTS is one the gate can verify', () => {
  const REFUSED_AT_DOOR = [
    ['no method', { token: 'x.y.z' }],
    ['no token', { method: 'ucp_handler' }],
    ['an empty token', { method: 'ucp_handler', token: '   ' }],
    ['a method the kernel has no verifier for on this lane', { method: 'ap2_mandate', token: 'x.y.z' }],
    ['a method spelled as `protocol`', { protocol: 'ucp_handler', token: 'x.y.z' }],
    ['an undeclared extra field', { method: 'ucp_handler', token: 'x.y.z', capture: 'immediate' }],
    ['a non-object envelope', 'ucp_handler'],
  ];

  for (const [label, payment] of REFUSED_AT_DOOR) {
    test(`${label} is refused at the door`, async () => {
      const verdict = await wouldCharge(payment);
      assert.equal(verdict.charged, false);
      assert.equal(verdict.refusedAt, 'door', `${label} must be caught at the door, not by the kernel`);
      assert.equal(verdict.code, 'QUOTE_REQUIRED');
    });
  }

  test('a grant that does not bind to THIS order is refused by the kernel even though the door accepts it', async () => {
    // The division of labour, pinned in both directions: the door validates the WIRE SHAPE and the kernel
    // validates the BINDING. These bodies are well-formed — the door must pass them — and each must still fail
    // closed at the gate. A door that started rejecting these would be guessing about money it cannot see;
    // a kernel that started accepting them would charge a buyer for an order they never authorized.
    const cases = [
      ['another merchant', { merchant_id: 'merch_someone_else' }, 'merchant_mismatch'],
      ['another checkout session', { checkout_session_id: 'q_other' }, 'session_mismatch'],
      ['another currency', { currency: 'EUR' }, 'currency_mismatch'],
      ['an allowance below the locked total', { max_amount: 1899 }, 'amount_exceeds_allowance'],
    ];
    for (const [label, allowance, reason] of cases) {
      const verdict = await wouldCharge({ method: 'ucp_handler', token: await signGrant(allowance) });
      assert.equal(verdict.charged, false, `${label} must not charge`);
      assert.equal(verdict.refusedAt, 'kernel', `${label} is a binding failure, not a wire-shape one`);
      assert.equal(verdict.reason, reason, label);
    }
  });

  test('an unsigned / forged grant never charges', async () => {
    const { privateKey: attackerKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({
      allowance: { max_amount: 2000, currency: 'USD', merchant_id: MERCHANT, checkout_session_id: SESSION_ID },
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setJti('forged').setExpirationTime('10m')
      .sign(attackerKey);

    const verdict = await wouldCharge({ method: 'ucp_handler', token: forged });
    assert.equal(verdict.charged, false);
    assert.equal(verdict.reason, 'credential_signature_invalid');
  });
});
