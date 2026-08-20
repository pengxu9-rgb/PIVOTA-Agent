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
 * TWO CRITERIA GATE THE FLIP, not one.
 *
 *   (a) `would_refuse: false` for all real traffic over a full traffic day, and
 *   (b) NO log line with `caller_class` of `browser` or `browser_app`.
 *
 * (b) is the one that is easy to miss. The CORS layer REFLECTS `Access-Control-Request-Headers`
 * into `Access-Control-Allow-Headers` (src/server.js ~34626), so `X-Internal-Key` is reachable from
 * a browser — the surface is shaped to accept it cross-origin. If any consumer calls /v1 directly
 * from the browser rather than through its server-side proxy, then "make the consumer send the key"
 * means shipping a shared secret into a JS bundle, where it is not a secret at all. That consumer
 * needs a different fix (proxy it server-side, or a per-user token), not this key.
 *
 * Every consumer measured so far proxies server-side, so (b) should already hold — but it must be
 * CHECKED rather than assumed, and this middleware logs `caller_class` precisely so it can be.
 * classifyCaller returns `browser_app` when a Mozilla-style UA arrives with an Origin header and
 * `browser` when it arrives without one (services/callerIdentity.js).
 *
 * WHY THE MEASUREMENT STEP IS NOT OPTIONAL, and cannot be a spot check: photo-analysis is
 * low-volume. On 2026-08-20 the gateway saw ZERO organic /v1/analysis/skin requests in the six hours
 * after its consumer went live — a short window reports "no consumer" for a consumer that is
 * demonstrably live. Absence of traffic is not evidence of absence of a caller.
 *
 * ENFORCE MODE IS IMPLEMENTED AND TESTED HERE, not left for the flip PR. A mode that is written later
 * is a mode that is exercised for the first time in production; this way the flip and its rollback are
 * both an env change with behaviour already pinned by tests. (Railway redeploys the service on a
 * variable change, so a rollback is a redeploy — fast and low-risk, but not instantaneous.)
 *
 * DELIBERATELY NOT COPIED: src/recommendations/routes.js `requireInternalKey` already guards
 * /v1/recommendations/* with this same header, and it has two defects this must not inherit —
 *   1. it FAILS OPEN when NODE_ENV is not literally 'production'/'prod' and no key is set. Prod
 *      leaves NODE_ENV UNSET, so that "dev default" branch IS the production branch;
 *   2. it compares with `===` rather than a constant-time comparison.
 * (A third defect in the same function — its refusal returned a truthy Response, so the caller's
 * `if (!requireInternalKey(...)) return;` never fired and an anonymous request crashed the process —
 * is fixed separately in PR #2040.)
 *
 * TWO PATH GROUPS ARE EXCLUDED FROM THIS GUARD, and neither exclusion is cosmetic:
 *
 *   /v1/recommendations/*  — already authenticated, with the SAME header name against a DIFFERENT
 *     secret (RECOMMENDATIONS_INTERNAL_KEY, set in prod). Left in, a caller that is correctly
 *     credentialed for that route logs here as `bad_key`, so `would_refuse` could never reach 0 and
 *     the step-3 gate would be unreachable — the operator would chase a phantom consumer forever.
 *     At the flip it would be worse: that caller would be 401'd before its own route. These paths
 *     are not part of the anonymous surface this guard exists to close, so they are not its business.
 *
 *   /metrics — a Prometheus dump, not an LLM door, and reached by its consumer over the railway.app
 *     name. PR #2034's HOST guard keeps it off the branded hosts, which is the actual exposure. This
 *     guard applies on EVERY host, so including it would mean the flip 401s the scrape everywhere,
 *     including the hourly chat-followup-canary CI job. Host-shape and caller-auth are different
 *     questions and /metrics only needs the first.
 *
 * Both exclusions live HERE and not in isAuroraSurfacePath, which is shared with the host guard —
 * narrowing the shared predicate would silently re-expose /metrics and /v1/recommendations on the
 * identity anchor and regress #2034.
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

/**
 * Paths inside the Aurora surface that this guard must NOT authenticate — see the header note.
 * Matched with the same normalisation Express routes with: lowercased, trailing slash tolerated.
 */
function isSelfAuthenticatedPath(path) {
  const p = String(path || '').toLowerCase().replace(/\/+$/, '');
  return p === '/metrics' || p === '/v1/recommendations' || p.startsWith('/v1/recommendations/');
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
function decideAuroraSurfaceAuth({ path = '', headers = {}, env = process.env } = {}) {
  const mode = auroraAuthMode(env);
  if (isSelfAuthenticatedPath(path)) {
    return {
      mode,
      hasKey: false,
      keyValid: false,
      keyConfigured: false,
      wouldRefuse: false,
      allow: true,
      reason: 'self_authenticated_path',
      skipped: true,
    };
  }
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
  isSelfAuthenticatedPath,
  auroraAuthMode,
  MODE_ENV,
  KEY_ENV,
  KEY_HEADER,
  MODE_OBSERVE,
  MODE_ENFORCE,
};
