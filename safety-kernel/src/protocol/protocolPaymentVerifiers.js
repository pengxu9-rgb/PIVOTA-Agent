// Concrete crypto verifiers that plug into the unified paymentAuthorizationVerifier `methods` map. Each turns a
// platform/issuer-signed credential into the AUTHORITATIVE claims the binding check consumes. Signatures are
// verified with `jose` against a PINNED JWKS per issuer (token-embedded jku/x5u are ignored by construction),
// with an explicit asymmetric algorithm allowlist — same hardening as the identity verifier.
//
//   createSignedGrantVerifier  -> acp_delegated_token / ucp_handler : a signed allowance/grant JWT.
//   createAp2MandateVerifier   -> ap2_mandate                       : an AP2 Checkout Mandate (SD-JWT VC).
//
// These return claims ONLY; they never decide the charge. The unified verifier's assertPaymentBinding ties the
// claims to the order (merchant/amount/currency/session/buyer/expiry). FAIL CLOSED on any crypto/structure error.

import { jwtVerify, createLocalJWKSet, createRemoteJWKSet, decodeJwt, decodeProtectedHeader } from 'jose';
import { createHash } from 'node:crypto';
import { PivotaCommerceError } from '../errors.js';
import { deriveUserRefFromClaims } from '../identity/userTokenVerifier.js';

const DEFAULT_ALGS = ['RS256', 'PS256', 'ES256', 'EdDSA']; // asymmetric only — never HS*/none
const DEFAULT_CLOCK_TOLERANCE_S = 60;
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
const firstString = (...xs) => xs.find((x) => nonEmpty(x));
const b64uDecode = (s) => Buffer.from(s, 'base64url').toString('utf8');
const fail = (reason, extra = {}) => { throw new PivotaCommerceError('CONFIRMATION_INVALID', { reason, ...extra }); };

// Shared issuer registry (pinned JWKS, asymmetric alg allowlist, https-only remote JWKS) — mirrors the
// identity verifier's hardening so a payment credential can't be minted via key-confusion or http key swap.
function buildIssuerRegistry(issuers) {
  if (!Array.isArray(issuers) || issuers.length === 0) throw new Error('verifier requires at least one configured issuer');
  const registry = new Map();
  for (const entry of issuers) {
    if (!entry || !nonEmpty(entry.iss)) throw new Error('each issuer needs a non-empty iss');
    if (entry.iss.includes('|')) throw new Error(`issuer ${entry.iss} must not contain '|'`);
    const aud = entry.aud;
    const audOk = nonEmpty(aud) || (Array.isArray(aud) && aud.length > 0 && aud.every(nonEmpty));
    if (!audOk) throw new Error(`issuer ${entry.iss} needs a non-empty aud`);
    const algs = entry.algs === undefined ? DEFAULT_ALGS : entry.algs;
    if (!Array.isArray(algs) || algs.length === 0 || algs.some((a) => typeof a !== 'string' || !/^(?:RS|PS|ES)\d{3}$|^EdDSA$/.test(a))) {
      throw new Error(`issuer ${entry.iss} alg allowlist must be a non-empty asymmetric set`);
    }
    let jwks;
    if (entry.jwks) jwks = createLocalJWKSet(entry.jwks);
    else if (entry.jwksUri) {
      const url = new URL(entry.jwksUri);
      if (url.protocol !== 'https:') throw new Error(`issuer ${entry.iss} jwksUri must be https`);
      jwks = createRemoteJWKSet(url);
    } else throw new Error(`issuer ${entry.iss} needs jwksUri or jwks`);
    if (registry.has(entry.iss)) throw new Error(`duplicate issuer ${entry.iss}`);
    registry.set(entry.iss, { jwks, aud, algs });
  }
  return registry;
}

function clockTolerance(config) {
  const ct = Number.isFinite(config?.clockToleranceSeconds) ? config.clockToleranceSeconds : DEFAULT_CLOCK_TOLERANCE_S;
  if (ct < 0 || ct > 120) throw new Error('clockToleranceSeconds must be between 0 and 120');
  return ct;
}

// Select + verify a compact JWT against its registered issuer's pinned key set. Peeking iss (unverified) only
// SELECTS the key set; jose then verifies the signature against THAT issuer's keys and re-checks iss === entry.iss.
async function verifyCompactJwt(token, registry, ct, requiredClaims) {
  // Peek iss as an OWN property only (it selects the key set). A polluted Object.prototype.iss must NOT pick a
  // trusted key set for a token that has no own iss (Codex round-3).
  let decoded;
  try { decoded = decodeJwt(token); } catch { fail('malformed_credential'); }
  const unsafeIss = hasOwn(decoded, 'iss') ? decoded.iss : undefined;
  const entry = nonEmpty(unsafeIss) ? registry.get(unsafeIss) : undefined;
  if (!entry) fail('untrusted_issuer', { iss: unsafeIss ?? null });
  let payload;
  try {
    ({ payload } = await jwtVerify(token, entry.jwks, {
      issuer: unsafeIss, audience: entry.aud, algorithms: entry.algs, clockTolerance: ct, requiredClaims,
    }));
  } catch (err) {
    fail('credential_signature_invalid', { detail: err?.code || 'invalid' });
  }
  // Normalize to a NULL-PROTO, OWN-PROPERTIES-ONLY record. The jose payload is a normal object, so a later
  // `payload._sd` / `payload.allowance` / `payload.vct` read would traverse Object.prototype — if anything else
  // in the process pollutes it, forged disclosure digests / allowances would be synthesized at the money gate
  // (Codex round-2 P0). After ownClone, every downstream read sees ONLY issuer-signed own claims.
  const cloned = ownClone(payload);
  // Re-assert the required registered claims are OWN on the verified payload. jose's iss/aud/exp PRESENCE checks
  // can be satisfied via a polluted prototype; ownClone dropped any inherited claim, so a missing own claim here
  // means it was never signed — fail closed (Codex round-3 1a). exp absence is also caught downstream.
  for (const claim of requiredClaims) {
    if (!hasOwn(cloned, claim)) fail('credential_missing_claim', { claim });
  }
  if (cloned.iss !== unsafeIss) fail('issuer_mismatch');
  return cloned;
}

// --- ACP delegated token / UCP handler : a signed allowance grant -----------------------------------------

/**
 * @param {{ issuers: Array<{iss,aud,algs?,jwksUri?,jwks?}>, clockToleranceSeconds?: number }} config
 * @returns {(authorization:any) => Promise<object>} verified grant claims
 */
export function createSignedGrantVerifier(config = {}) {
  const registry = buildIssuerRegistry(config.issuers);
  const ct = clockTolerance(config);
  return async function verifyGrant(authorization) {
    const token = firstString(authorization?.token, authorization?.grant, authorization?.credential);
    if (!token) fail('grant_token_missing');
    const payload = await verifyCompactJwt(token, registry, ct, ['iss', 'aud', 'exp']); // null-proto, own-only
    // A delegated-token grant is NOT an SD-JWT VC mandate. Reject mandate markers so a mandate's issuer JWT
    // can't be replayed as a grant (Codex round-2 P1, the reverse method-confusion direction).
    if (hasOwn(payload, '_sd') || nonEmpty(payload.vct)) fail('not_a_grant');
    // allowance may be nested OR top-level — but if `allowance` is PRESENT it MUST be a plain object; a
    // malformed allowance container must not silently fall through to top-level (Codex P2). own-property check.
    let a;
    if (hasOwn(payload, 'allowance')) {
      if (!isPlainObject(payload.allowance)) fail('grant_allowance_malformed');
      a = payload.allowance;
    } else {
      a = payload;
    }
    return {
      // a delegated token is ALWAYS an allowance (max_amount); the exact-amount path belongs to AP2 mandates.
      max_amount: toIntOrUndef(a.max_amount),
      currency: firstString(a.currency),
      merchant_id: firstString(a.merchant_id, a.merchant),
      checkout_session_id: firstString(a.checkout_session_id, a.session_id, a.checkout_session),
      user_ref: resolveSignedUserRef({ payload, claims: a }),
      expires_at: typeof payload.exp === 'number' ? payload.exp * 1000 : undefined,
      id: firstString(payload.jti, a.id, a.authorization_id),
    };
  };
}

// --- AP2 Checkout Mandate : SD-JWT VC ----------------------------------------------------------------------

/**
 * Verify an AP2 Checkout Mandate (SD-JWT). The issuer JWS is verified (pinned JWKS); each presented disclosure
 * is validated against the issuer JWT's `_sd` digests (a forged/extra disclosure is rejected); the disclosed
 * claims are merged and returned. The mandate is an EXACT-amount authorization. Optional `verifyCheckoutHash`
 * cross-checks the mandate's `checkout_hash` against the merchant's own signed Checkout JWT and yields the
 * session id. (Key-binding/KB-JWT holder proof is a documented follow-up; issuer-sig + disclosure-integrity +
 * binding is enforced here.)
 * @param {{ issuers:Array, clockToleranceSeconds?:number, verifyCheckoutHash?:(hash:string, checkoutJwt?:string)=>Promise<{checkout_session_id?:string}>}} config
 */
export function createAp2MandateVerifier(config = {}) {
  const registry = buildIssuerRegistry(config.issuers);
  const ct = clockTolerance(config);
  // MANDATORY (Codex P0): the checkout binding must be PROVEN against the merchant's own signed Checkout JWT —
  // never the issuer's self-asserted checkout_session_id. Without it, a valid mandate could bind to any live
  // session. So verifyCheckoutHash is required, and the session id comes ONLY from its verified result.
  // TCB CONTRACT: verifyCheckoutHash(checkout_hash, checkout_jwt) MUST (a) verify checkout_jwt is the MERCHANT's
  // own signed Checkout JWT, (b) confirm its hash equals checkout_hash, and (c) return that JWT's authoritative
  // { checkout_session_id }. It is part of the trusted compute base — a misimplementation that returns the live
  // session without proving the hash reintroduces the session-binding bypass. Throw or return no session to deny.
  const verifyCheckoutHash = config.verifyCheckoutHash;
  if (typeof verifyCheckoutHash !== 'function') {
    throw new Error('createAp2MandateVerifier requires verifyCheckoutHash — AP2 checkout-hash binding is mandatory');
  }
  const expectedVct = nonEmpty(config.expectedVct) ? config.expectedVct : null;

  return async function verifyMandate(authorization) {
    const sdjwt = firstString(authorization?.mandate, authorization?.credential, authorization?.token);
    if (!sdjwt) fail('mandate_missing');
    // An AP2 mandate is an SD-JWT PRESENTATION (issuer-jwt ~ disclosures ~). A plain compact JWT has no '~' —
    // reject it so an ACP/UCP grant can't be replayed as method:'ap2_mandate' (Codex P1 method confusion).
    if (!sdjwt.includes('~')) fail('not_sd_jwt');
    const parts = sdjwt.split('~');
    const issuerJwt = parts[0];
    if (!nonEmpty(issuerJwt) || !issuerJwt.includes('.')) fail('mandate_malformed');

    // 1. issuer signature.
    const payload = await verifyCompactJwt(issuerJwt, registry, ct, ['iss', 'aud', 'exp']); // null-proto, own-only
    // A Checkout Mandate is an SD-JWT VC — it MUST carry a `vct` type. Requiring it (with the '~' presentation
    // check) stops a non-mandate JWT from being accepted as method:'ap2_mandate' (Codex round-2 P1).
    if (!nonEmpty(payload.vct)) fail('mandate_no_vct');
    if (expectedVct && payload.vct !== expectedVct) fail('unexpected_vct', { vct: payload.vct ?? null });

    // 2. disclosure integrity: a disclosure is base64url(JSON [salt,name,value]); its digest MUST be in `_sd`.
    //    Reject duplicate digests, duplicate claim names, a name that OVERRIDES a protected plain claim, and
    //    prototype keys. Reconstruct into a NULL-PROTO object (Codex P1).
    const sdAlg = (payload._sd_alg || 'sha-256').toLowerCase();
    if (sdAlg !== 'sha-256') fail('unsupported_sd_alg', { sd_alg: sdAlg });
    const sdSet = new Set(Array.isArray(payload._sd) ? payload._sd : []);
    const plain = stripSd(payload);
    const claims = Object.assign(Object.create(null), plain);
    const seenDigests = new Set();
    const seenNames = new Set();
    for (const part of parts.slice(1)) {
      if (!nonEmpty(part) || part.includes('.')) continue; // skip empty / a trailing KB-JWT (has dots)
      const digest = createHash('sha256').update(part).digest('base64url');
      if (!sdSet.has(digest)) fail('disclosure_not_in_sd'); // forged/extra disclosure
      if (seenDigests.has(digest)) fail('duplicate_disclosure');
      seenDigests.add(digest);
      let arr;
      try { arr = JSON.parse(b64uDecode(part)); } catch { fail('disclosure_malformed'); }
      if (!Array.isArray(arr) || arr.length !== 3 || typeof arr[1] !== 'string') fail('disclosure_shape');
      const name = arr[1];
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') fail('disclosure_bad_name');
      if (seenNames.has(name) || Object.prototype.hasOwnProperty.call(plain, name)) fail('disclosure_overrides_claim', { name });
      seenNames.add(name);
      claims[name] = arr[2];
    }

    // 3. checkout binding (mandatory): the session id is whatever the merchant's OWN Checkout JWT says, after
    //    verifying its hash equals the mandate's checkout_hash. The mandate's own checkout_session_id is NOT
    //    trusted as the binding source.
    if (!nonEmpty(claims.checkout_hash)) fail('mandate_no_checkout_hash');
    let boundCheckout;
    try { boundCheckout = await verifyCheckoutHash(claims.checkout_hash, authorization.checkout_jwt); }
    catch (e) { if (e instanceof PivotaCommerceError) throw e; fail('checkout_hash_unverified'); }
    const checkout_session_id = firstString(boundCheckout?.checkout_session_id);
    if (!nonEmpty(checkout_session_id)) fail('checkout_session_unresolved');

    return {
      amount: toIntOrUndef(claims.amount), // Checkout Mandate authorizes an EXACT amount
      currency: firstString(claims.currency),
      merchant_id: firstString(claims.merchant_id, claims.merchant),
      checkout_session_id, // from the VERIFIED merchant Checkout JWT, not the mandate's self-assertion
      user_ref: nonEmpty(payload.sub) ? safeDeriveUserRef(payload.iss, payload.sub) : undefined,
      expires_at: typeof payload.exp === 'number' ? payload.exp * 1000 : undefined,
      id: firstString(payload.jti, claims.id),
    };
  };
}

// --- helpers ----------------------------------------------------------------------------------------------

function stripSd(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === '_sd' || k === '_sd_alg' || k === 'cnf') continue;
    out[k] = v;
  }
  return out;
}
// Deep clone into NULL-PROTO, OWN-PROPERTIES-ONLY structures so no read can resolve via a polluted prototype.
function ownClone(v, depth = 0) {
  if (v === null || typeof v !== 'object') return v;
  if (depth > 64) return undefined;
  if (Array.isArray(v)) return v.map((x) => ownClone(x, depth + 1));
  const out = Object.create(null);
  for (const k of Object.keys(v)) { // own enumerable only — inherited props are dropped
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = ownClone(v[k], depth + 1);
  }
  return out;
}
// own-property presence check on a (possibly null-proto) object
const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
function toIntOrUndef(v) { return Number.isSafeInteger(v) ? v : undefined; }
function safeDeriveUserRef(iss, sub) {
  try { return deriveUserRefFromClaims(iss, sub); } catch { return undefined; }
}
function resolveSignedUserRef({ payload, claims }) {
  const explicit = firstString(claims?.user_ref, claims?.userRef, payload?.user_ref, payload?.userRef);
  const derived = nonEmpty(payload?.sub) ? safeDeriveUserRef(payload.iss, payload.sub) : undefined;
  if (explicit && derived && explicit !== derived) fail('grant_user_ref_mismatch');
  return explicit || derived;
}
function isPlainObject(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/**
 * Compose the per-method verifier map the payment authorization verifier is built over.
 *
 * EXTRACTED SO IT CAN BE TESTED. This logic used to be an inline callback in src/server.js,
 * where nothing could reach it: the registry's own tests inject a FAKE build callback, so the
 * real composition never ran in CI. That is exactly how an unconditional
 * createSignedGrantVerifier({ issuers: [] }) shipped — buildIssuerRegistry hard-throws on an
 * empty array, and once ap2-only rows became live trust a config with no signed_grant issuer
 * made the throw land before the AP2 flag was read, refusing EVERY payment on EVERY method.
 *
 * THE RULE: a method with no usable issuer is ABSENT from the map. Absence is the kernel's
 * clean "no verifier for this method" refusal, scoped to that one method. A build-time throw is
 * not — it takes the sibling methods down with it.
 *
 * @param {object}   o
 * @param {Array}    o.signedGrantIssuers  issuers trusted for signed_grant (acp_delegated_token + ucp_handler)
 * @param {Array}    o.ap2MandateIssuers   issuers EXPLICITLY trusted for ap2_mandate — never implied by signed_grant
 * @param {object|null} o.ap2Binding       the checkout-binding service; null/absent when the AP2 flag is off
 * @param {string}   o.expectedVct         optional credential-type pin for AP2
 * @returns {Record<string, Function>} method -> verifier; keys are omitted, never null
 */
export function buildPaymentMethodVerifiers({
  signedGrantIssuers = [],
  ap2MandateIssuers = [],
  ap2Binding = null,
  expectedVct = '',
} = {}) {
  const methods = {};
  if (Array.isArray(signedGrantIssuers) && signedGrantIssuers.length) {
    const signedGrantVerifier = createSignedGrantVerifier({ issuers: signedGrantIssuers });
    methods.acp_delegated_token = signedGrantVerifier;
    methods.ucp_handler = signedGrantVerifier;
  }
  // AP2 needs BOTH the flag (=> binding service) AND at least one issuer trusted for
  // ap2_mandate. Registry rows opt in via methods; static env entries may too, but AP2 trust is
  // never implicit — a signed_grant-only issuer cannot mint mandates.
  if (ap2Binding && Array.isArray(ap2MandateIssuers) && ap2MandateIssuers.length) {
    methods.ap2_mandate = createAp2MandateVerifier({
      issuers: ap2MandateIssuers,
      verifyCheckoutHash: ap2Binding.createCheckoutHashVerifier(),
      ...(expectedVct ? { expectedVct } : {}),
    });
  }
  return methods;
}
