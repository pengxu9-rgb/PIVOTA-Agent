'use strict';

/*
 * auroraSurfaceHostGuard.js — the Aurora BFF surface must not be served on the branded public hosts.
 *
 * Phase 0 of the anonymous-LLM work that started with /ui/chat (PR #2032). The Aurora BFF is mounted
 * on the bare app with no host gate and no auth middleware. Its only gate is requireAuroraUid(),
 * which demands a non-empty `X-Aurora-UID` — a client-invented device string, not a credential, and
 * one that sits in the CORS allow-list. resolveIdentity() then returns a GUEST identity with no
 * bearer token and the handler calls an LLM. Nine /v1 routes reach a model across 36 call sites,
 * plus /v1/photos/upload, an anonymous storage write on the same gate.
 *
 * Measured on prod 2026-08-20: `POST /v1/chat` with `{}` and no credential returns 400 carrying a
 * full Aurora application envelope (request_id / trace_id / assistant_text) on mcp.pivota.cc AND
 * gateway.pivota.cc. Same tell as /ui/chat — reaching application code with no credential proves
 * the gate is absent, not lenient.
 *
 * WHAT THE EDGE LOGS SAY, because this decision is measured rather than reasoned. Sweeping all 20
 * retained deployments (2026-08-18 → 08-20, 2,073 edge rows, 141 of them /v1):
 *
 *     pivota-agent-production.up.railway.app   128   the real lane
 *     commerce.mcp.pivota.cc                    11   all /v1/reco/generate — OUR OWN curl probes
 *     gateway.pivota.cc                          2   /v1/kv/ and /v1/health, both 404 — scanners
 *     mcp.pivota.cc                              0
 *
 * Zero legitimate /v1 traffic on any branded host. /v1/chat itself was 77 requests from 7 IPs at
 * exactly 11 each, UA `node` — a load-balanced server-side proxy fleet, confirmed by
 * pivota-aurora-chatbox/vercel.json rewriting /v1/:path* to the railway.app domain. The browser
 * never reaches this service directly.
 *
 * SCOPE, STATED HONESTLY. This removes the surface from the branded hosts. It is NOT the lock:
 * the Host header is caller-controlled and the edge forwards it verbatim, so anyone can reach
 * mcp.pivota.cc and label the request with the railway.app name. What it buys is that the identity
 * anchor and the partner-facing host stop ADVERTISING an LLM to honest clients, crawlers and
 * partners — the same shape argument as branch 1 of uiChatAccessGuard.js. The lock is Phase 1
 * (authenticate the Vercel->gateway hop, and/or a quota), which needs a cross-repo rollout and must
 * not ship fail-closed ahead of the consumer.
 *
 * DENYLIST, NOT ALLOWLIST — a deliberate choice against the usual rule, and its cost. An allowlist
 * of "hosts that may serve Aurora" would also deny commerce.mcp.pivota.cc, and 2.4 days of retained
 * logs is not enough evidence to take the primary service domain away from a consumer I cannot see.
 * The cost is real and must be paid attention to: a NEW branded host — and the GCP migration is
 * actively adding them — serves the Aurora surface again until it is added here. Anything that
 * terminates a public name for this service belongs in AURORA_SURFACE_DENIED_HOSTS.
 */

function firstNonEmptyString(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

const DENIED_HOSTS_ENV = 'AURORA_SURFACE_DENIED_HOSTS';
const DEFAULT_DENIED_HOSTS = 'gateway.pivota.cc';

/**
 * Hosts where the Aurora surface must not be served, beyond the public-read names (those come from
 * server.js's isPublicReadMcpHostRequest, injected — there must stay exactly ONE definition of that
 * set). Normalised the same way that predicate normalises: lowercase, trimmed, port stripped.
 */
function auroraDeniedHosts(env = process.env) {
  const raw = env[DENIED_HOSTS_ENV] === undefined ? DEFAULT_DENIED_HOSTS : env[DENIED_HOSTS_ENV];
  return String(raw)
    .split(',')
    .map((h) => h.trim().toLowerCase().split(':')[0])
    .filter(Boolean);
}

/**
 * Does this path belong to the Aurora BFF surface?
 *
 * Matched by PREFIX, not by an enumerated route list. The /v1 routes are spread across
 * auroraBff/routes.js, auroraBff/index.js, auroraBff/diagnosisV2Routes.js and
 * auroraBff/routes/travelPlansRoutes.js — enumerating them is a list that goes stale, and a route
 * added tomorrow would default to being served on the anchor. A prefix defaults the other way.
 *
 * Express routes case-insensitively and tolerates trailing slashes, so `/V1/Chat` and `/v1/chat/`
 * reach the same handlers. This runs as middleware rather than inside a route handler, so unlike
 * uiChatAccessGuard it cannot inherit that normalisation and has to do it explicitly.
 */
function isAuroraSurfacePath(path) {
  const p = String(path || '').toLowerCase();
  return p === '/v1' || p === '/v2' || p.startsWith('/v1/') || p.startsWith('/v2/');
}

/**
 * @returns {{allow: boolean, reason: string, status?: number, body?: object}}
 */
function decideAuroraSurfaceAccess({
  path = '',
  host = '',
  isPublicReadHost = false,
  env = process.env,
} = {}) {
  if (!isAuroraSurfacePath(path)) return { allow: true, reason: 'not_aurora_surface' };

  if (isPublicReadHost === true) {
    return {
      allow: false,
      reason: 'public_read_host',
      status: 404,
      body: { error: 'NOT_FOUND', message: 'Not found' },
    };
  }

  const normalized = firstNonEmptyString(host).toLowerCase().split(':')[0];
  if (normalized && auroraDeniedHosts(env).includes(normalized)) {
    return {
      allow: false,
      reason: 'denied_host',
      status: 404,
      body: { error: 'NOT_FOUND', message: 'Not found' },
    };
  }

  return { allow: true, reason: 'ok' };
}

module.exports = {
  decideAuroraSurfaceAccess,
  isAuroraSurfacePath,
  auroraDeniedHosts,
  DENIED_HOSTS_ENV,
  DEFAULT_DENIED_HOSTS,
};
