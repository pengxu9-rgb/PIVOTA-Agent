'use strict';

/*
 * AgenPas link tokens: a signed, expiring, purchase-scoped grant that lets the BUYER (who holds no agent key) see one
 * purchase's status page. docs/agenpas.md has the security model.
 *
 * FORMAT. `v1.<payload>.<signature>`, both parts base64url without padding.
 *   payload    JSON {v:1, aud:<public origin>, p:<purchase id>, a:<agent id>, u:<agent user ref>, iat, exp, n:<nonce>}
 *   signature  HMAC-SHA256(AGENPAS_LINK_SECRET, "agenpas-link:v1." + <payload>)
 * The payload is SIGNED, not encrypted: anyone holding the link can decode it. It therefore carries only identifiers
 * that are already pseudonymous (the user ref is the gateway's `usr_<digest>` form) and never the buyer's details.
 *
 * VERIFY ORDER. Shape -> signature (constant-time, on equal-length buffers, and only its CANONICAL base64url
 * spelling: a re-spelled signature that decodes to the same bytes is refused, so a token cannot be altered and still
 * verify) -> payload parse -> version -> audience (the public origin it was minted for) -> the purchase id the route
 * names -> issued-at not in the future (60 s skew) -> lifetime at most 30 min -> not expired. A token
 * failing any step is refused; the reason is for logs and the friendly page, never echoed with token bytes.
 */

const crypto = require('node:crypto');

const VERSION = 'v1';
const SIGNING_PREFIX = 'agenpas-link:v1.';
const MAX_LIFETIME_SECONDS = 30 * 60;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_CHARS = 2048;
const PURCHASE_ID_RE = /^(?:pp|ap|rp)_[0-9a-f]{24}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const REF_RE = /^[A-Za-z0-9_.:|@-]{1,200}$/;
const AUD_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

const REASON = Object.freeze({
  noSecret: 'no_secret',
  malformed: 'malformed',
  badSignature: 'bad_signature',
  wrongPurchase: 'wrong_purchase',
  wrongAudience: 'wrong_audience',
  notYetValid: 'not_yet_valid',
  lifetimeTooLong: 'lifetime_too_long',
  expired: 'expired',
});

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret, payloadPart) {
  return crypto.createHmac('sha256', secret).update(SIGNING_PREFIX + payloadPart, 'utf8').digest();
}

function nowSeconds(now) {
  const ms = typeof now === 'number' ? now : Date.now();
  return Math.floor(ms / 1000);
}

/**
 * Mint a token. Throws on bad input (a programming error, never a buyer's): callers check their inputs first.
 * @param {{ purchaseId: string, agentId: string, userRef: string, aud: string, secret: string, ttlSeconds?: number, now?: number }} input
 *        aud is the public origin the link is for (AGENPAS_PUBLIC_BASE_URL)
 */
function mintLinkToken({ purchaseId, agentId, userRef, aud, secret, ttlSeconds = MAX_LIFETIME_SECONDS, now } = {}) {
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('agenpas link: no secret');
  if (typeof aud !== 'string' || !AUD_RE.test(aud)) throw new Error('agenpas link: bad audience');
  if (typeof purchaseId !== 'string' || !PURCHASE_ID_RE.test(purchaseId)) throw new Error('agenpas link: bad purchase id');
  if (typeof agentId !== 'string' || !REF_RE.test(agentId)) throw new Error('agenpas link: bad agent id');
  if (typeof userRef !== 'string' || !REF_RE.test(userRef)) throw new Error('agenpas link: bad user ref');
  const ttl = Math.min(MAX_LIFETIME_SECONDS, Math.max(1, Math.floor(Number(ttlSeconds) || MAX_LIFETIME_SECONDS)));
  const iat = nowSeconds(now);
  const payload = { v: 1, aud, p: purchaseId, a: agentId, u: userRef, iat, exp: iat + ttl, n: b64url(crypto.randomBytes(9)) };
  const payloadPart = b64url(JSON.stringify(payload));
  return `${VERSION}.${payloadPart}.${b64url(sign(secret, payloadPart))}`;
}

/**
 * Verify a token for the purchase the route names.
 * @returns {{ ok: true, claims: { purchaseId, agentId, userRef, iat, exp } } | { ok: false, reason: string }}
 */
function verifyLinkToken(token, { purchaseId, aud, secret, now } = {}) {
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: REASON.noSecret };
  if (typeof aud !== 'string' || !AUD_RE.test(aud)) return { ok: false, reason: REASON.wrongAudience };
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: REASON.malformed };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION || !B64URL_RE.test(parts[1]) || !B64URL_RE.test(parts[2])) {
    return { ok: false, reason: REASON.malformed };
  }
  const expected = sign(secret, parts[1]);
  const given = Buffer.from(parts[2], 'base64url');
  // timingSafeEqual needs equal lengths; the length of an HMAC-SHA256 is public, so checking it first leaks nothing.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: REASON.badSignature };
  }
  // The same bytes can be spelled more than one way in base64url (the last character's spare bits): only the
  // canonical spelling, the one mint() writes, is accepted.
  if (given.toString('base64url') !== parts[2]) return { ok: false, reason: REASON.badSignature };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: REASON.malformed };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 1
    || typeof payload.p !== 'string' || !PURCHASE_ID_RE.test(payload.p)
    || typeof payload.a !== 'string' || !REF_RE.test(payload.a)
    || typeof payload.u !== 'string' || !REF_RE.test(payload.u)
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) {
    return { ok: false, reason: REASON.malformed };
  }
  if (payload.aud !== aud) return { ok: false, reason: REASON.wrongAudience };
  if (payload.p !== purchaseId) return { ok: false, reason: REASON.wrongPurchase };
  const t = nowSeconds(now);
  if (payload.iat > t + CLOCK_SKEW_SECONDS) return { ok: false, reason: REASON.notYetValid };
  if (payload.exp - payload.iat > MAX_LIFETIME_SECONDS || payload.exp <= payload.iat) return { ok: false, reason: REASON.lifetimeTooLong };
  if (t >= payload.exp) return { ok: false, reason: REASON.expired };
  return {
    ok: true,
    claims: { purchaseId: payload.p, agentId: payload.a, userRef: payload.u, iat: payload.iat, exp: payload.exp },
  };
}

module.exports = {
  MAX_LIFETIME_SECONDS,
  PURCHASE_ID_RE,
  REASON,
  mintLinkToken,
  verifyLinkToken,
};
