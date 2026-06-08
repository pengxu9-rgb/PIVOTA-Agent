// Unified payment-authorization verifier — the single `verifyPaymentAuthorization(authorization, bound)` seam
// every protocol adapter (MCP / ACP / UCP) injects into the canonical executor. It normalizes the three
// authorization families into ONE binding invariant, so the rule "the authorization must cover THIS order's
// amount/currency/merchant/session/buyer and not be expired" is enforced once, never per ecosystem:
//
//   acp_delegated_token : ACP `delegate_payment` — a signed ALLOWANCE (max_amount, currency, merchant,
//                         checkout_session, expiry). Charge must be <= the allowance.
//   ucp_handler         : UCP payment handler token — same signed-grant shape.
//   ap2_mandate         : AP2 Checkout Mandate (SD-JWT VC) — an EXACT amount bound via checkout_hash.
//
// SAFETY (this is the last gate before mintConfirmation→charge in the executor):
//  - The signature/structure of each family is verified by a REQUIRED injected crypto verifier (jose-based
//    reference impls live in createSignedGrantVerifier / ap2MandateVerifier). A method with NO configured
//    verifier is REFUSED — never trusted by absence-of-throw.
//  - The binding is checked against the CRYPTOGRAPHICALLY-VERIFIED claims, never the raw (forgeable) envelope.
//  - FAIL CLOSED: anything missing/mismatched/expired throws CONFIRMATION_INVALID; the executor additionally
//    re-checks the returned attestation against the authoritative order (defence in depth).

import { PivotaCommerceError } from '../errors.js';

const CANONICAL_METHODS = new Set(['acp_delegated_token', 'ucp_handler', 'ap2_mandate']);
const DEFAULT_CLOCK_TOLERANCE_MS = 60 * 1000;
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
const sameCurrency = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();

/**
 * @param {{
 *   merchantId?: string,                      // optional fixed merchant-of-record; otherwise bound.merchant_id is used
 *   methods: Record<string, (authorization:any, bound:any) => Promise<object>>,  // method -> crypto verifier
 *   now?: () => number,
 *   clockToleranceMs?: number,
 * }} config
 * @returns {(authorization:any, bound:{order_id,user_ref,amount,currency,merchant_id,checkout_session_id,ctx}) => Promise<object>}
 */
export function createPaymentAuthorizationVerifier(config = {}) {
  const { merchantId, methods, now = () => Date.now(), clockToleranceMs = DEFAULT_CLOCK_TOLERANCE_MS } = config;
  if (!methods || typeof methods !== 'object') throw new Error('createPaymentAuthorizationVerifier requires a methods map');
  // Copy into a NULL-PROTO map so a polluted Object.prototype can't inject a verifier for a method the config
  // never configured (Codex P2): an absent method must always fail closed, never resolve via inheritance.
  const methodMap = Object.create(null);
  for (const k of Object.keys(methods)) methodMap[k] = methods[k];

  return async function verifyPaymentAuthorization(authorization, bound) {
    if (!isPlainObject(authorization)) {
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'authorization_missing' });
    }
    const method = nonEmpty(authorization.method) ? authorization.method
      : nonEmpty(authorization.protocol) ? authorization.protocol : undefined;
    if (!nonEmpty(method) || !CANONICAL_METHODS.has(method)) {
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'unknown_authorization_method', method: method ?? null });
    }
    const verifier = methodMap[method];
    if (typeof verifier !== 'function') {
      // No crypto verifier wired for this method → cannot trust it. Fail closed (never charge on a method we
      // can't cryptographically verify).
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'no_verifier_for_method', method });
    }

    // 1. CRYPTO: verify signature/structure → authoritative claims. Throws on any crypto/structure failure.
    let verified;
    try {
      verified = await verifier(authorization, bound);
    } catch (e) {
      if (e instanceof PivotaCommerceError) throw e;
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'authorization_verification_failed', method });
    }
    if (!isPlainObject(verified)) {
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'verifier_returned_no_claims', method });
    }

    // 2. BINDING: against the VERIFIED claims (not the raw envelope).
    const expectedMerchantId = nonEmpty(merchantId) ? merchantId : bound?.merchant_id;
    if (!nonEmpty(expectedMerchantId)) {
      throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason: 'merchant_binding_missing', method });
    }
    assertPaymentBinding(method, verified, bound, { merchantId: expectedMerchantId, now, clockToleranceMs });

    // 3. ATTESTATION the executor requires (it re-checks these against the authoritative order).
    return {
      ok: true,
      method,
      amount: bound.amount,
      currency: bound.currency,
      user_ref: bound.user_ref,
      authorization_id: verified.id ?? verified.authorization_id ?? null,
    };
  };
}

/**
 * The unified binding invariant — exported for direct testing. Verified claims MUST tie the authorization to
 * THIS order: same merchant, same currency, covering the amount, bound to this checkout session and (when the
 * claim carries it) this buyer, and not expired. Throws CONFIRMATION_INVALID on any failure.
 */
export function assertPaymentBinding(method, verified, bound, { merchantId, now = () => Date.now(), clockToleranceMs = DEFAULT_CLOCK_TOLERANCE_MS } = {}) {
  const fail = (reason, detail = {}) => { throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason, method, ...detail }); };

  // amount/currency must be authoritative on the order side.
  if (!Number.isSafeInteger(bound?.amount) || bound.amount <= 0) fail('order_amount_invalid');
  if (!nonEmpty(bound?.currency)) fail('order_currency_invalid');

  // merchant: the grant/mandate must be FOR this merchant of record.
  if (!nonEmpty(verified.merchant_id) || verified.merchant_id !== merchantId) fail('merchant_mismatch');

  // currency: canonical match.
  if (!sameCurrency(verified.currency, bound.currency)) fail('currency_mismatch');

  // amount: an EXACT-amount mandate must equal the order; an ALLOWANCE must cover it (charge <= max). Exactly
  // one of {amount, max_amount} must be present and authorize the charge.
  const hasExact = verified.amount != null;
  const hasAllowance = verified.max_amount != null;
  if (hasExact === hasAllowance) fail('amount_authorization_ambiguous'); // need exactly one
  if (hasExact) {
    if (!Number.isSafeInteger(verified.amount) || verified.amount !== bound.amount) fail('amount_mismatch', { expected: bound.amount });
  } else {
    if (!Number.isSafeInteger(verified.max_amount) || bound.amount > verified.max_amount) fail('amount_exceeds_allowance', { max: verified.max_amount });
  }

  // session: the authorization must be bound to THIS checkout session/quote, not merely the broader ACP/MCP
  // connection. This prevents a valid grant for checkout A being replayed to complete checkout B under the same
  // user/session. Older direct unit calls may omit checkout_session_id; fall back to ctx.acp_session_id only for
  // that non-executor path.
  const boundSession = nonEmpty(bound?.checkout_session_id) ? bound.checkout_session_id : bound?.ctx?.acp_session_id;
  if (nonEmpty(boundSession)) {
    if (!nonEmpty(verified.checkout_session_id)) fail('authorization_not_session_bound');
    if (verified.checkout_session_id !== boundSession) fail('session_mismatch');
  }

  // buyer: if the verified claim carries a buyer, it MUST be this buyer.
  if (verified.user_ref != null && verified.user_ref !== bound.user_ref) fail('buyer_mismatch');

  // expiry: an authorization MUST expire, and must not be expired now.
  if (!Number.isFinite(verified.expires_at)) fail('authorization_no_expiry');
  if (now() - clockToleranceMs >= verified.expires_at) fail('authorization_expired');

  return true;
}

function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
