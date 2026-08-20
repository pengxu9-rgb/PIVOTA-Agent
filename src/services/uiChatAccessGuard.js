'use strict';

/*
 * uiChatAccessGuard.js — who may reach the /ui/chat agent loop.
 *
 * /ui/chat runs an LLM agent loop WITH TOOLS on every call. Until 2026-08-20 it was mounted on the
 * bare app with no auth of any kind, so it was anonymously callable on every hostname this service
 * answers — commerce.mcp.pivota.cc, gateway.pivota.cc, and, worst, mcp.pivota.cc, the PUBLIC read
 * tier whose whole design premise is "no public tier = no unauthenticated LLM spend" (the same
 * premise that keeps recommend_products off the anonymous surface). Measured live that day: an
 * anonymous POST of {"messages":[{"role":"user","content":"..."}]} with no credential returned 200
 * and a model answer in ~1.1s, and the internal-UI page that calls it had already been served 22
 * times to outside IPs in the ~2.4 days of retained edge logs — GPTBot, Censys, Palo Alto and
 * RecordedFuture among them, two of which went on to probe /.env and /.git/config on the same host.
 *
 * Two decisions, in this order:
 *
 *   1. PUBLIC-READ HOSTS -> the route does not exist. 404, never 401: a 401 still advertises that
 *      something lives here, and on the UCP identity anchor (UCP_AGENT_PROFILE_URL is mcp.pivota.cc,
 *      chosen precisely because it is the public, unauthenticated, STATIC read tier) the honest
 *      answer is that the host serves no interactive agent surface at all.
 *
 *      This branch is keyed on the HOST ALONE, deliberately NOT on PUBLIC_READ_MCP_ENABLED. Every
 *      other host check in server.js reads `isPublicReadMcpEnabled() && isPublicReadMcpHostRequest()`
 *      because those decide how to DISPATCH the read tier. This one decides whether an LLM is
 *      reachable without a credential, and mcp.pivota.cc resolves to this service whether or not the
 *      read tier is switched on — anding the flag in would silently re-open /ui/chat the moment
 *      anyone darkened the read tier. The test suite pins that: the public host must 404 with
 *      PUBLIC_READ_MCP_ENABLED unset.
 *
 *   2. EVERY OTHER HOST -> an internal key is required. Fail-closed: with no key configured the
 *      route 404s rather than falling open, the same contract as ucpWarmHandoffInternalRoute ("an
 *      unconfigured key can never mean open"). Fixing only the public host would have left the
 *      identical uncapped-spend hole one hostname over — gateway.pivota.cc is the name partners are
 *      about to be handed, and it served /ui/chat anonymously too.
 *
 * Ordering matters and is not cosmetic: the public-host branch runs FIRST, so configuring
 * PIVOTA_UI_CHAT_INTERNAL_KEY can never make the identity anchor interactive again.
 *
 * On the Host header being caller-controlled: it is, and the edge forwards whatever was sent, so a
 * caller reaching mcp.pivota.cc can label the request commerce.mcp.pivota.cc and skip branch 1.
 * That buys them 401 instead of 404 and nothing else — branch 2 still wants the key. The host
 * branch is a SHAPE decision (what the identity anchor advertises), not the thing keeping the LLM
 * closed; branch 2 is. A host-only fix would have been spoofable down to no fix at all.
 */

const crypto = require('crypto');

const INTERNAL_KEY_ENV = 'PIVOTA_UI_CHAT_INTERNAL_KEY';
const INTERNAL_KEY_HEADER = 'x-internal-key';

function firstNonEmptyString(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

/** Header lookup that does not care how the caller cased the name. */
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

/** Constant-time key comparison (a length leak is fine; a content leak is not). */
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
 * @param {object}  input
 * @param {boolean} input.isPublicReadHost  did this request arrive on a PUBLIC_READ_MCP_HOSTS name?
 *                                          Injected rather than re-derived so there stays exactly
 *                                          ONE definition of that host set (server.js's
 *                                          isPublicReadMcpHostRequest) — a second copy of a host
 *                                          predicate is a predicate that drifts.
 * @param {object} [input.headers]
 * @param {object} [input.env]
 * @returns {{allow: boolean, reason: string, status?: number, body?: object}}
 */
function decideUiChatAccess({ isPublicReadHost = false, headers = {}, env = process.env } = {}) {
  if (isPublicReadHost === true) {
    return {
      allow: false,
      reason: 'public_read_host',
      status: 404,
      body: { error: 'NOT_FOUND', message: 'Not found' },
    };
  }

  const configuredKey = firstNonEmptyString(env[INTERNAL_KEY_ENV]);
  if (!configuredKey) {
    return {
      allow: false,
      reason: 'key_not_configured',
      status: 404,
      body: { error: 'NOT_FOUND', message: 'Not found' },
    };
  }

  if (!timingSafeKeyMatch(headerValue(headers, INTERNAL_KEY_HEADER), configuredKey)) {
    return {
      allow: false,
      reason: 'bad_key',
      status: 401,
      body: { error: 'UNAUTHORIZED', message: 'X-Internal-Key required' },
    };
  }

  return { allow: true, reason: 'ok' };
}

module.exports = {
  decideUiChatAccess,
  INTERNAL_KEY_ENV,
  INTERNAL_KEY_HEADER,
};
