'use strict';

/*
 * auroraSurfaceAuth.js — caller authentication for the Aurora BFF surface.
 *
 * Phase 1, step 1 of the anonymous-LLM work. Phase 0 (PR #2034) removed the surface from the
 * mcp.pivota.cc identity anchor; it could not close the rest, because the Host header is
 * caller-controlled and because gateway.pivota.cc is DESIGNED to carry /v1 and /v2
 * (DNS_gateway_pivota_cc_2026-08-20.md). The only thing that closes this is authenticating the
 * caller, which is what this does.
 *
 * SHIPS IN OBSERVE MODE. `AURORA_SURFACE_AUTH_MODE` defaults to `observe`: every request is allowed
 * through exactly as before, and the decision that WOULD have been made is logged. Nothing changes
 * for any caller until someone sets `enforce`.
 *
 * That is not timidity, it is the rollout. Phase 0 was single-repo, so fail-closed was free. This is
 * cross-repo — pivota-agent-ui, pivota-backend, pivota-backend-gcp, Aurora-Beauty-Decision-System and
 * pivota-aurora-chatbox all reach this surface — and enforcement shipped ahead of the consumers is a
 * consumer outage, not a security fix. The sequence is: deploy this (observe), ship the header in
 * every consumer, MEASURE that 100% of /v1 requests carry a key over a full traffic day, then flip.
 *
 * WHY THE MEASUREMENT STEP IS NOT OPTIONAL, and cannot be a spot check: photo-analysis is
 * low-volume. On 2026-08-20 the gateway saw ZERO organic /v1/analysis/skin requests in the six hours
 * after its consumer went live — a short window reports "no consumer" for a consumer that is
 * demonstrably live. Absence of traffic is not evidence of absence of a caller.
 *
 * ENFORCE MODE IS IMPLEMENTED AND TESTED HERE, not left for the flip PR. A mode that is written later
 * is a mode that is exercised for the first time in production; this way the flip is an env change
 * that is instantly revertible without a deploy, and its behaviour is already pinned by tests.
 *
 * DELIBERATELY NOT COPIED: src/recommendations/routes.js:342 `requireInternalKey` already guards
 * /v1/recommendations/* with this same header, and it has two defects this must not inherit —
 *   1. it FAILS OPEN when NODE_ENV is not literally 'production'/'prod' and no key is set, so any
 *      environment that is not exactly prod is an open door;
 *   2. it compares with `===` rather than a constant-time comparison.
 * The header name and 401 body are kept identical so consumers need one credential, not two.
 */

const crypto = require('crypto');

const MODE_ENV = 'AURORA_SURFACE_AUTH_MODE';
const KEY_ENV = 'AURORA_SURFACE_INTERNAL_KEY';
const KEY_HEADER = 'x-internal-key';

const MODE_OBSERVE = 'observe';
const MODE_ENFORCE = 'enforce';

function firstNonEmptyString(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

/**
 * Anything that is not exactly `enforce` is `observe`. A typo, an empty string, or an unset variable
 * must never be read as "enforce" — the failure mode of guessing wrong here is a total outage of the
 * consumer app, so the ambiguous cases resolve to the harmless one.
 */
function auroraAuthMode(env = process.env) {
  return firstNonEmptyString(env[MODE_ENV]).toLowerCase() === MODE_ENFORCE ? MODE_ENFORCE : MODE_OBSERVE;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() === wanted) {
      const raw = headers[key];
      return firstNonEmptyString(Array.isArray(raw) ? raw[0] : raw);
    }
  }
  return '';
}

/** Constant-time comparison (a length leak is fine; a content leak is not). */
function timingSafeKeyMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * @returns {{
 *   mode: 'observe'|'enforce',
 *   hasKey: boolean,          // did the caller send ANY value in the header?
 *   keyValid: boolean,        // did it match?
 *   keyConfigured: boolean,
 *   wouldRefuse: boolean,     // what enforce mode WOULD do — the measurement signal
 *   allow: boolean,           // what actually happens now
 *   reason: string,
 *   status?: number,
 *   body?: object,
 * }}
 */
function decideAuroraSurfaceAuth({ headers = {}, env = process.env } = {}) {
  const mode = auroraAuthMode(env);
  const configuredKey = firstNonEmptyString(env[KEY_ENV]);
  const provided = headerValue(headers, KEY_HEADER);
  const hasKey = provided !== '';
  const keyValid = Boolean(configuredKey) && timingSafeKeyMatch(provided, configuredKey);

  // An unconfigured key can never mean "open" once enforcing. It means the deploy is misconfigured,
  // and a misconfigured security guard must fail closed rather than silently pass everything.
  const reason = !configuredKey ? 'key_not_configured' : keyValid ? 'ok' : hasKey ? 'bad_key' : 'missing_key';
  const wouldRefuse = reason !== 'ok';

  if (mode === MODE_OBSERVE || !wouldRefuse) {
    return { mode, hasKey, keyValid, keyConfigured: Boolean(configuredKey), wouldRefuse, allow: true, reason };
  }

  return {
    mode,
    hasKey,
    keyValid,
    keyConfigured: Boolean(configuredKey),
    wouldRefuse,
    allow: false,
    reason,
    status: 401,
    body: { error: 'UNAUTHORIZED', message: 'Missing or invalid X-Internal-Key' },
  };
}

module.exports = {
  decideAuroraSurfaceAuth,
  auroraAuthMode,
  MODE_ENV,
  KEY_ENV,
  KEY_HEADER,
  MODE_OBSERVE,
  MODE_ENFORCE,
};
