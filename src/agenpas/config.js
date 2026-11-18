'use strict';

/*
 * AgenPas configuration (docs/agenpas.md). Every value is read from the environment AT CALL TIME, so a flag is live
 * (no restart, and a test can flip it between requests). Nothing here logs or returns a secret's value.
 *
 *   AGENPAS_ENABLED               default OFF. Off: every /agenpas path falls through to the app's normal not-found
 *                                 handling (byte-identical to before AgenPas existed), and start_purchase answers
 *                                 exactly as before (no `agenpas_url`).
 *   AGENPAS_LINK_SECRET           the HMAC-SHA256 key for link tokens. Missing or shorter than 32 characters: the
 *                                 feature refuses (no link is minted, every link is refused).
 *   AGENPAS_LINK_TTL_SECONDS      link lifetime; default and maximum 1800 (30 min), minimum 60.
 *   AGENPAS_PUBLIC_BASE_URL       the https origin minted links point at (e.g. https://agenpas-host.example), and
 *                                 the ONLY host the routes answer on. No value: no link is minted and no route is
 *                                 served. A dedicated origin is recommended (docs/agenpas.md). http://localhost is
 *                                 accepted only while the dev fixtures are actually enabled.
 *   AGENPAS_INTERNAL_READ_KEY     the dedicated key the gateway presents (X-Internal-Key) on the backend's internal
 *                                 buyer read. No value: every read is `unavailable`.
 *   AGENPAS_HOSTED_HOSTS          comma-separated exact host names the payment partner serves its hosted pages from.
 *                                 Default empty = every hosted page URL is refused (the page shows no button).
 *   AGENPAS_EMBED_HOSTED_PAGES    default OFF: hosted pages open in a popup / new tab (they cannot be framed today).
 *                                 On: the page frames them instead (CSP frame-src widened to the allowlisted hosts).
 *   AGENPAS_COLLECT_SHIPPING      default OFF (inside AGENPAS_ENABLED). On: when the purchase lacks a shipping address
 *                                 or email, the page asks for it and submits it (POST /agenpas/api/p/:id/shipping-
 *                                 address). Off: the page says "Go back to the chat to add your address".
 *   AGENPAS_DEV_FIXTURES          local development only: canned purchases instead of the backend. Refused (treated as
 *                                 off) on any managed platform or production environment (src/config/platform.js).
 */

const platform = require('../config/platform');

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const MIN_SECRET_CHARS = 32;
const MAX_TTL_SECONDS = 30 * 60;
const MIN_TTL_SECONDS = 60;
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function on(env, name) {
  return TRUTHY.has(String(env[name] || '').trim().toLowerCase());
}

function isEnabled(env = process.env) {
  return on(env, 'AGENPAS_ENABLED');
}

/** The link secret, or null when absent or too short (the feature then refuses). Never logged. */
function linkSecret(env = process.env) {
  const raw = String(env.AGENPAS_LINK_SECRET || '');
  return raw.length >= MIN_SECRET_CHARS ? raw : null;
}

function linkTtlSeconds(env = process.env) {
  const n = Number.parseInt(String(env.AGENPAS_LINK_TTL_SECONDS || ''), 10);
  if (!Number.isFinite(n) || n <= 0) return MAX_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, n));
}

/** The public origin links are minted for: `https://host[:port]` with no path, or null. */
function publicBaseUrl(env = process.env) {
  const raw = String(env.AGENPAS_PUBLIC_BASE_URL || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const localDev = devFixturesEnabled(env) && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !localDev) return null;
  if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
  return u.origin;
}

/** The exact host names a hosted page may be on (lower-case, no trailing dot). Empty = refuse all. */
function hostedHosts(env = process.env) {
  return String(env.AGENPAS_HOSTED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter((h) => HOST_RE.test(h));
}

/** Whole minutes of link lifetime, for the buyer- and agent-facing copy (at least 1). */
function linkTtlMinutes(env = process.env) {
  return Math.max(1, Math.floor(linkTtlSeconds(env) / 60));
}

/** The dedicated backend key for the internal buyer read, or '' (never logged). */
function internalReadKey(env = process.env) {
  return String(env.AGENPAS_INTERNAL_READ_KEY || '').trim();
}

function collectShipping(env = process.env) {
  return isEnabled(env) && on(env, 'AGENPAS_COLLECT_SHIPPING');
}

function embedHostedPages(env = process.env) {
  return on(env, 'AGENPAS_EMBED_HOSTED_PAGES');
}

/** True only off every managed platform AND outside production: the fixture mode can never arm in a deploy. */
function devFixturesAllowed(env = process.env) {
  try {
    if (platform.isManagedPlatform(env) || platform.isProduction(env)) return false;
  } catch {
    return false;
  }
  return true;
}

function devFixturesEnabled(env = process.env) {
  return on(env, 'AGENPAS_DEV_FIXTURES') && devFixturesAllowed(env);
}

module.exports = {
  MAX_TTL_SECONDS,
  collectShipping,
  MIN_SECRET_CHARS,
  devFixturesAllowed,
  devFixturesEnabled,
  embedHostedPages,
  hostedHosts,
  internalReadKey,
  isEnabled,
  linkSecret,
  linkTtlMinutes,
  linkTtlSeconds,
  publicBaseUrl,
};
