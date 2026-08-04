// Per-user token verifier for the agent-checkout gateway/edge. Verifies a managed-IdP-issued per-user JWT
// and derives the kernel's ownership key (user_ref). IdP-agnostic: you configure an issuer registry.
//
// SECURITY (from the Codex identity review, REVIEW_by_codex_of_IdentityArchitecture.md):
//  - Signatures are verified with `jose` (vetted) against a PINNED JWKS per issuer (configured jwksUri or a
//    static jwks). Token-embedded `jku`/`x5u` are IGNORED by construction — jose only uses the key set we
//    provide, never key material named in the token header.
//  - Explicit per-issuer algorithm allowlist (asymmetric only; never `none`; never HS/RS confusion).
//  - `iss` must be in the registry; `aud` must match; `exp`/`iat` + a max token age are enforced (`nbf` is
//    checked when present); optional per-issuer `azp`/`client_id` + required `scope` binding.
//  - FAIL CLOSED: any problem throws UserTokenError; the function never returns an unverified/partial id.
//
// Usage (IdP-agnostic):
//   const verify = createUserTokenVerifier({ issuers: [{ iss, aud, jwksUri, algs }] });
//   const { user_ref, claims } = await verify(token);   // throws UserTokenError on any failure
//
// The result ALSO carries `attested_email` / `attested_name` when the verified claims contain them
// (see attestedBuyerFromClaims). Those are a READ of claims that were already returned in `claims` —
// nothing about what the verifier ACCEPTS, or how `user_ref` is DERIVED, depends on them.

import { jwtVerify, createRemoteJWKSet, createLocalJWKSet, decodeJwt } from 'jose';
import { createHash } from 'node:crypto';

export class UserTokenError extends Error {
  constructor(message, code = 'USER_TOKEN_INVALID') {
    super(message);
    this.name = 'UserTokenError';
    this.code = code;
  }
}

const DEFAULT_ALGS = ['RS256', 'ES256']; // asymmetric only — never 'none', never HS*
const DEFAULT_MAX_TOKEN_AGE = '1h';
const DEFAULT_CLOCK_TOLERANCE_S = 60;

/**
 * Derive the kernel ownership key from VERIFIED claims. MUST stay byte-identical to
 * mcp-server/auth/userRef.js `deriveUserRef`, so one human has ONE user_ref across the MCP and gateway
 * doors. (Pinned by a cross-check test.)
 */
export function deriveUserRefFromClaims(iss, sub) {
  if (typeof iss !== 'string' || !iss.trim() || typeof sub !== 'string' || !sub.trim()) {
    throw new UserTokenError('verified claims must include non-empty iss and sub', 'CLAIMS_MISSING_SUBJECT');
  }
  const digest = createHash('sha256').update(`${iss}|${sub}`, 'utf8').digest('base64url').slice(0, 32);
  return `usr_${digest}`;
}

// Conservative address shape. Deliberately NOT an RFC-5322 parser: this only has to reject the shapes a
// downstream order/receipt system cannot use, and anything it lets through the backend validates again.
const EMAIL_SHAPE = /^[^\s@,;<>"'\\]+@[^\s@,;<>"'\\]+\.[^\s@,;<>"'\\]{2,}$/;

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * ATTESTED buyer identity fields, read from claims a verified token already carried.
 *
 * `email` is taken ONLY when the IdP has not explicitly disclaimed it: an OIDC `email_verified: false`
 * means "the issuer is asserting an address it has NOT confirmed", which is not an attestation, so it is
 * treated as ABSENT (a caller-supplied address may then be used instead). A missing `email_verified` is
 * accepted — many issuers omit it — because the claim still comes from inside a signature-verified token,
 * which is strictly stronger than a value typed into a request body by the calling agent.
 *
 * Pure and side-effect free. It NEVER contributes to `user_ref` (ownership stays `iss|sub`), and it never
 * widens what the verifier accepts — a token without these claims verifies exactly as it does today.
 */
export function attestedBuyerFromClaims(claims) {
  if (claims == null || typeof claims !== 'object' || Array.isArray(claims)) return {};
  const out = {};
  const email = trimmed(claims.email);
  if (email && claims.email_verified !== false && EMAIL_SHAPE.test(email)) out.attested_email = email;
  const name = trimmed(claims.name)
    || [trimmed(claims.given_name), trimmed(claims.family_name)].filter(Boolean).join(' ');
  if (name) out.attested_name = name;
  return out;
}

/**
 * @param {{ issuers: Array<{ iss:string, aud:string|string[], algs?:string[], jwksUri?:string, jwks?:object }>,
 *           maxTokenAge?: string|number, clockToleranceSeconds?: number }} config
 * @returns {(token: string) => Promise<{ user_ref:string, claims:object }>}
 */
export function createUserTokenVerifier(config = {}) {
  const issuers = Array.isArray(config?.issuers) ? config.issuers : [];
  if (issuers.length === 0) {
    throw new UserTokenError('verifier requires at least one configured issuer', 'NO_ISSUERS');
  }

  // One key resolver per EXACT issuer string. jose caches remote keys + handles rotation.
  const registry = new Map();
  for (const entry of issuers) {
    if (!entry || typeof entry.iss !== 'string' || !entry.iss.trim()) {
      throw new UserTokenError('each issuer needs a non-empty iss', 'BAD_ISSUER_CONFIG');
    }
    // Codex P2: forbid the user_ref delimiter in iss so `${iss}|${sub}` can't be made ambiguous/collide.
    if (entry.iss.includes('|')) {
      throw new UserTokenError(`issuer ${entry.iss} must not contain '|'`, 'BAD_ISSUER_CONFIG');
    }
    // Codex P3: aud = a non-empty string OR a non-empty array of non-empty strings.
    const aud = entry.aud;
    const audOk = (typeof aud === 'string' && aud.trim() !== '')
      || (Array.isArray(aud) && aud.length > 0 && aud.every((a) => typeof a === 'string' && a.trim() !== ''));
    if (!audOk) throw new UserTokenError(`issuer ${entry.iss} needs a non-empty aud (string or non-empty array of non-empty strings)`, 'BAD_ISSUER_CONFIG');
    // Codex P3: algs must be an EXPLICIT non-empty ASYMMETRIC allowlist — no widening default, no HS*/none.
    const algs = entry.algs === undefined ? DEFAULT_ALGS : entry.algs;
    if (!Array.isArray(algs) || algs.length === 0
      || algs.some((a) => typeof a !== 'string' || !/^(?:RS|PS|ES)\d{3}$|^EdDSA$/.test(a))) {
      throw new UserTokenError(`issuer ${entry.iss} alg allowlist must be a non-empty asymmetric set (RS*/PS*/ES*/EdDSA)`, 'BAD_ALG_CONFIG');
    }
    // Codex P1: a remote JWKS URL MUST be https — over http a network attacker swaps the keys and mints
    // tokens that still pass signature/iss/aud/exp. (Use a static `jwks` object for tests/local dev.)
    let jwks;
    if (entry.jwks) {
      jwks = createLocalJWKSet(entry.jwks);
    } else if (entry.jwksUri) {
      const url = new URL(entry.jwksUri);
      if (url.protocol !== 'https:') throw new UserTokenError(`issuer ${entry.iss} jwksUri must be https`, 'BAD_ISSUER_CONFIG');
      jwks = createRemoteJWKSet(url);
    } else {
      throw new UserTokenError(`issuer ${entry.iss} needs jwksUri or jwks`, 'BAD_ISSUER_CONFIG');
    }
    if (registry.has(entry.iss)) throw new UserTokenError(`duplicate issuer ${entry.iss}`, 'BAD_ISSUER_CONFIG');
    // Codex P2: optional authorized-party + required-scope binding (the IDENTITY_ARCHITECTURE.md control) —
    // so a token for an unapproved OAuth client or without money-path consent can't become a trusted user_ref.
    const expectedAzp = entry.azp != null ? [].concat(entry.azp).map(String) : null;
    const requiredScopes = entry.requiredScopes != null ? [].concat(entry.requiredScopes).map(String) : null;
    registry.set(entry.iss, { jwks, aud, algs, expectedAzp, requiredScopes });
  }

  // Codex P2: jose SKIPS the age check for a falsy maxTokenAge (0/''/false) → stale tokens accepted. Require
  // a positive number or non-empty duration string, and cap clock tolerance to a small audited range.
  const maxTokenAge = config.maxTokenAge ?? DEFAULT_MAX_TOKEN_AGE;
  const maxAgeOk = (typeof maxTokenAge === 'number' && Number.isFinite(maxTokenAge) && maxTokenAge > 0)
    || (typeof maxTokenAge === 'string' && maxTokenAge.trim() !== '');
  if (!maxAgeOk) throw new UserTokenError('maxTokenAge must be a positive number or non-empty duration string', 'BAD_CONFIG');
  const ct = Number.isFinite(config.clockToleranceSeconds) ? config.clockToleranceSeconds : DEFAULT_CLOCK_TOLERANCE_S;
  if (ct < 0 || ct > 120) throw new UserTokenError('clockToleranceSeconds must be between 0 and 120', 'BAD_CONFIG');
  const clockTolerance = ct;

  return async function verifyUserToken(token) {
    if (typeof token !== 'string' || !token.trim()) {
      throw new UserTokenError('missing user token', 'TOKEN_MISSING');
    }
    // Peek `iss` (UNVERIFIED, base64 decode only) solely to select the registered key set. The signature is
    // then cryptographically verified against THAT issuer's pinned JWKS and jose re-checks iss === entry.iss,
    // so a forged/spoofed iss cannot validate (its signature won't match the registered issuer's keys).
    let unsafeIss;
    try {
      unsafeIss = decodeJwt(token)?.iss;
    } catch {
      throw new UserTokenError('malformed token', 'TOKEN_MALFORMED');
    }
    const entry = typeof unsafeIss === 'string' ? registry.get(unsafeIss) : undefined;
    if (!entry) throw new UserTokenError('untrusted or missing issuer', 'ISSUER_NOT_ALLOWED');

    let payload;
    try {
      ({ payload } = await jwtVerify(token, entry.jwks, {
        issuer: entry.iss,
        audience: entry.aud,
        algorithms: entry.algs,
        maxTokenAge,
        clockTolerance,
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'],
      }));
    } catch (err) {
      throw new UserTokenError(`token verification failed: ${err?.code || err?.message || 'invalid'}`, 'TOKEN_VERIFY_FAILED');
    }

    // Codex P2: enforce authorized-party + scope when the issuer config requires them (an IdP may issue the
    // same aud to multiple clients/scopes; an unapproved client/scope must not become a trusted user_ref).
    if (entry.expectedAzp) {
      const azp = typeof payload.azp === 'string' ? payload.azp
        : (typeof payload.client_id === 'string' ? payload.client_id : undefined);
      if (!azp || !entry.expectedAzp.includes(azp)) {
        throw new UserTokenError('token authorized-party (azp/client_id) not allowed', 'AZP_NOT_ALLOWED');
      }
    }
    if (entry.requiredScopes) {
      const raw = typeof payload.scope === 'string' ? payload.scope
        : (Array.isArray(payload.scp) ? payload.scp.join(' ') : '');
      const granted = new Set(String(raw).split(/\s+/).filter(Boolean));
      if (!entry.requiredScopes.every((s) => granted.has(s))) {
        throw new UserTokenError('token missing a required scope', 'SCOPE_MISSING');
      }
    }

    const user_ref = deriveUserRefFromClaims(payload.iss, payload.sub);
    // Additive: `claims` already carried these; surfacing them named saves every caller from re-deriving
    // the "is this attested?" rule (and getting `email_verified:false` wrong) on its own.
    return { user_ref, claims: payload, ...attestedBuyerFromClaims(payload) };
  };
}
