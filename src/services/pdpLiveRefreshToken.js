'use strict';

/*
 * THE PDP LIVE-REFRESH TOKEN (get_pdp_v2 issues it, pdp_live_read verifies it).
 *
 *   v1.<b64url(JSON claims)>.<b64url(HMAC-SHA256(secret, "pdp_live_refresh.v1." + part1))>
 *
 * The token is the ONLY thing the refresh endpoint trusts: it names the product, the merchant host and
 * handle, the market, the page currency and the variant ids a browser may ask the merchant about. The page
 * the browser sends back is checked against it and never picks the read target.
 *
 * It is baked into an ISR page (cached up to an hour, rebuilt from a cache that may hold it longer), so it
 * outlives a page: UCP_LIVE_PDP_REFRESH_TOKEN_TTL_S, default 6 h, clamped to 1 h .. 7 days. A token whose
 * lifetime (exp - iat) is longer than the CURRENT setting is refused, so lowering it shortens old tokens too.
 *
 * Secrets: UCP_LIVE_PDP_REFRESH_SECRET signs and verifies; UCP_LIVE_PDP_REFRESH_SECRET_PREVIOUS verifies only
 * (rotation). A secret shorter than 32 bytes after trim is no secret: no token is issued.
 */

const crypto = require('node:crypto');

const TOKEN_VERSION = 'v1';
const MAC_CONTEXT = 'pdp_live_refresh.v1.';
const TOKEN_OP = 'pdp_live_read';
const MIN_SECRET_BYTES = 32;
const DEFAULT_TTL_S = 6 * 3600;
const MIN_TTL_S = 3600;
const MAX_TTL_S = 604800;
const MAX_TOKEN_CHARS = 4096;
const MAX_IDS = 30;
// A 32-byte HMAC-SHA256 is 43 base64url characters without padding.
const TOKEN_SHAPE = /^v1\.([A-Za-z0-9_-]{1,4000})\.([A-Za-z0-9_-]{43})$/;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function secretOf(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return Buffer.byteLength(s, 'utf8') >= MIN_SECRET_BYTES ? s : '';
}

/** { current, previous }: each '' when unset or too short. */
function readRefreshSecrets(env = process.env) {
  return {
    current: secretOf(env.UCP_LIVE_PDP_REFRESH_SECRET),
    previous: secretOf(env.UCP_LIVE_PDP_REFRESH_SECRET_PREVIOUS),
  };
}

function tokenTtlSeconds(env = process.env) {
  const raw = String(env.UCP_LIVE_PDP_REFRESH_TOKEN_TTL_S ?? '').trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_TTL_S;
  return Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.floor(n)));
}

function macOf(secret, part1) {
  return crypto.createHmac('sha256', secret).update(MAC_CONTEXT + part1).digest();
}

/** The signed token, or null without a usable secret (no secret, no token). */
function signRefreshToken(claims, secret) {
  const key = secretOf(secret);
  if (!key || !claims || typeof claims !== 'object') return null;
  const part1 = b64url(JSON.stringify(claims));
  return `${TOKEN_VERSION}.${part1}.${b64url(macOf(key, part1))}`;
}

const nonEmpty = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;

function claimsAreWellFormed(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (c.v !== 1 || c.op !== TOKEN_OP) return false;
  for (const key of ['pid', 'mid', 'h', 'hd']) if (!nonEmpty(c[key])) return false;
  if (typeof c.lid !== 'string' || c.lid.length > 512) return false;
  if (typeof c.m !== 'string' || !/^[A-Z]{2}$/.test(c.m)) return false;
  if (typeof c.c !== 'string' || !/^[A-Z]{3}$/.test(c.c)) return false;
  if (!Array.isArray(c.ids) || c.ids.length < 1 || c.ids.length > MAX_IDS) return false;
  if (!c.ids.every((id) => typeof id === 'string' && /^\d{1,30}$/.test(id))) return false;
  if (new Set(c.ids).size !== c.ids.length) return false;
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp <= c.iat) return false;
  return true;
}

/**
 * @param {{ secrets?: string[], nowSec?: number, maxTtlS?: number|null }} opts  maxTtlS: the current TTL setting
 * @returns {{ ok: true, claims } | { ok: false, error: 'malformed' | 'bad_mac' | 'expired', claims? }}
 *   The MAC is checked (constant time, over the RECEIVED part1) before anything inside the token is read;
 *   `expired` is only said of a token this gateway signed.
 */
function verifyRefreshToken(token, { secrets = [], nowSec = Math.floor(Date.now() / 1000), maxTtlS = null } = {}) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return { ok: false, error: 'malformed' };
  const m = TOKEN_SHAPE.exec(token);
  if (!m) return { ok: false, error: 'malformed' };
  const [, part1, part2] = m;
  const given = Buffer.from(part2, 'base64url');
  // Only the canonical spelling of the MAC: a string that decodes to the same bytes is not the same token.
  if (given.length !== 32 || b64url(given) !== part2) return { ok: false, error: 'malformed' };
  const keys = (Array.isArray(secrets) ? secrets : []).map(secretOf).filter(Boolean);
  if (!keys.length) return { ok: false, error: 'bad_mac' };
  let matched = false;
  for (const key of keys) {
    // Every configured key is tried (no early exit), so the timing does not say which one matched.
    if (crypto.timingSafeEqual(macOf(key, part1), given)) matched = true;
  }
  if (!matched) return { ok: false, error: 'bad_mac' };
  let claims;
  try {
    const raw = Buffer.from(part1, 'base64url');
    if (b64url(raw) !== part1) return { ok: false, error: 'malformed' };
    claims = JSON.parse(raw.toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (!claimsAreWellFormed(claims)) return { ok: false, error: 'malformed' };
  if (nowSec >= claims.exp) return { ok: false, error: 'expired', claims };
  // Issued under a longer lifetime than the gateway now allows: expired, as if issued under today's.
  if (Number.isFinite(maxTtlS) && maxTtlS > 0 && claims.exp - claims.iat > maxTtlS) return { ok: false, error: 'expired', claims };
  return { ok: true, claims };
}

module.exports = {
  readRefreshSecrets,
  signRefreshToken,
  tokenTtlSeconds,
  verifyRefreshToken,
  MAC_CONTEXT,
  TOKEN_OP,
  MIN_SECRET_BYTES,
  DEFAULT_TTL_S,
  MIN_TTL_S,
  MAX_TTL_S,
  MAX_IDS,
};
