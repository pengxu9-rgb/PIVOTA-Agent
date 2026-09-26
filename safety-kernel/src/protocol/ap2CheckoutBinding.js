// AP2 checkout binding — the trusted-compute-base half of Checkout Mandate verification.
//
// createAp2MandateVerifier (protocolPaymentVerifiers.js) states the contract this file exists
// to satisfy, verbatim: verifyCheckoutHash(checkout_hash, checkout_jwt) MUST (a) verify
// checkout_jwt is the MERCHANT's own signed Checkout JWT, (b) confirm its hash equals
// checkout_hash, and (c) return that JWT's authoritative { checkout_session_id }. A
// misimplementation that returns the live session without proving the hash reintroduces the
// session-binding bypass — which is why the AP2 flag has thrown since the day it existed.
//
// THE FLOW this binds together:
//   1. create/update_checkout_session mints a Checkout JWT over {checkout_session_id, exp, jti}
//      and returns it to the agent alongside the session (`ap2_checkout_jwt`).
//   2. The buyer's wallet commits to it: checkout_hash = sha256 over the EXACT JWT string
//      (base64url or hex encoding of the digest), disclosed inside the signed mandate.
//   3. At complete_checkout the agent presents { mandate, checkout_jwt }; the verifier proves
//      OUR signature (a), hash equality (b), and yields the session id (c). The executor's
//      assertPaymentBinding then compares that session — and the mandate's own exact
//      amount/currency/merchant claims — against the quote actually being charged.
//
// WHAT THE JWT DELIBERATELY DOES NOT BIND: amount, currency, merchant. Those bind through the
// MANDATE's claims against the authoritative locked quote, one layer up. Duplicating them here
// would break honestly (an update_checkout re-quote would strand a wallet's already-hashed JWT)
// while adding nothing the binding assert does not already enforce.
//
// WHY HMAC AND NOT AN ASYMMETRIC ALG, in a codebase whose issuer registries are
// asymmetric-only: those registries verify THIRD-PARTY tokens, where a symmetric key would make
// every verifier a forger. Here minter and verifier are the SAME party (Pivota) — the wallet
// never verifies this signature, it only hashes the opaque string — so HMAC is the correct
// primitive, and it is the same one ConfirmationTokenService already uses for the same reason.

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PivotaCommerceError } from '../errors.js';

const CHECKOUT_JWT_TYP = 'pivota-ap2-checkout+jwt';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 60_000;

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
const b64uJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const fail = (reason, extra = {}) => {
  throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason, ...extra });
};

function safeEqual(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Decode a claimed digest that may be base64url OR hex — both are encodings of the same
 * 32-byte sha-256, so accepting either removes an integration failure mode without weakening
 * anything. Returns null when it is neither. */
function decodeClaimedDigest(claimed) {
  if (!nonEmpty(claimed)) return null;
  const s = claimed.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  try {
    const buf = Buffer.from(s, 'base64url');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

export class Ap2CheckoutBindingService {
  /** @param {{secret:string, ttlMs?:number, now?:()=>number}} opts */
  constructor({ secret, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    // 32, not ConfirmationTokenService's 16: this secret gates a PAYMENT session binding, and
    // it is new config with no deployed value to grandfather.
    if (!nonEmpty(secret) || secret.length < 32) {
      throw new Error('Ap2CheckoutBindingService requires AP2_CHECKOUT_JWT_SECRET (>= 32 chars)');
    }
    this._secret = secret;
    this._ttlMs = ttlMs;
    this._now = now;
  }

  _sign(signingInput) {
    return createHmac('sha256', this._secret).update(signingInput).digest('base64url');
  }

  /**
   * Mint the Checkout JWT for one session. `expires_at` (the quote's own expiry, ISO or epoch
   * ms) CAPS the JWT lifetime: a binding must never outlive the quote it binds.
   * @param {{checkout_session_id:string, expires_at?:string|number}} input
   */
  mintCheckoutJwt({ checkout_session_id, expires_at } = {}) {
    if (!nonEmpty(checkout_session_id)) {
      throw new Error('mintCheckoutJwt requires checkout_session_id');
    }
    const nowMs = this._now();
    let expMs = nowMs + this._ttlMs;
    const quoteExp = typeof expires_at === 'number' ? expires_at : Date.parse(expires_at ?? '');
    if (Number.isFinite(quoteExp) && quoteExp > nowMs && quoteExp < expMs) expMs = quoteExp;
    const signingInput = `${b64uJson({ alg: 'HS256', typ: CHECKOUT_JWT_TYP })}.${b64uJson({
      checkout_session_id,
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(expMs / 1000),
      jti: randomUUID(),
    })}`;
    return `${signingInput}.${this._sign(signingInput)}`;
  }

  /** The TCB function createAp2MandateVerifier requires. Every failure throws
   * PivotaCommerceError('CONFIRMATION_INVALID', {reason}) — deny by throwing, never by a
   * truthy-but-wrong return. */
  createCheckoutHashVerifier() {
    const self = this;
    return async function verifyCheckoutHash(checkout_hash, checkout_jwt) {
      if (!nonEmpty(checkout_hash)) fail('checkout_hash_missing');
      if (!nonEmpty(checkout_jwt)) fail('checkout_jwt_missing');
      const parts = checkout_jwt.split('.');
      if (parts.length !== 3 || !parts.every(nonEmpty)) fail('checkout_jwt_malformed');

      // (a) OUR signature over the exact signing input — before reading a single claim.
      const expectedSig = self._sign(`${parts[0]}.${parts[1]}`);
      if (!safeEqual(Buffer.from(parts[2]), Buffer.from(expectedSig))) {
        fail('checkout_jwt_bad_signature');
      }

      let header;
      let payload;
      try {
        header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        payload = Object.assign(
          Object.create(null),
          JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
        );
      } catch {
        fail('checkout_jwt_malformed');
      }
      // typ is pinned so no OTHER HMAC token this platform mints (confirmation tokens, future
      // instruments) can ever be replayed into this slot, even if a secret were shared.
      if (header?.alg !== 'HS256' || header?.typ !== CHECKOUT_JWT_TYP) fail('checkout_jwt_wrong_typ');
      if (typeof payload.exp !== 'number' || self._now() > payload.exp * 1000 + CLOCK_TOLERANCE_MS) {
        fail('checkout_jwt_expired');
      }

      // (b) the mandate's commitment: sha-256 over the EXACT JWT string the agent was handed.
      const actual = createHash('sha256').update(checkout_jwt, 'utf8').digest();
      const claimed = decodeClaimedDigest(checkout_hash);
      if (!claimed || !safeEqual(actual, claimed)) fail('checkout_hash_mismatch');

      // (c) the session id comes from OUR verified JWT — never from the mandate's own claims.
      if (!nonEmpty(payload.checkout_session_id)) fail('checkout_jwt_no_session');
      return { checkout_session_id: payload.checkout_session_id };
    };
  }
}

export { CHECKOUT_JWT_TYP };
