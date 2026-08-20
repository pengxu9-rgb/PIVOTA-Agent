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
 * WHY gateway.pivota.cc IS NOT DENIED BY DEFAULT — and why the measurement above did not settle it.
 * The first version of this shipped `gateway.pivota.cc` as the default denied host on the strength of
 * that sweep. Review caught it: pivota-agent-ui PR #308 ("R1: use gateway.pivota.cc / api.pivota.cc
 * instead of Railway hostnames") merged at 2026-08-20T14:41:59Z, FORTY-TWO MINUTES after the log
 * window above closed at 14:00:08Z, and its live main now defaults two server-side callers —
 * /v1/analysis/skin and /v1/photos/upload — to that host. pivota-backend-gcp's env.prod.yaml already
 * sets RECOMMENDATIONS_SERVICE_BASE_URL to it for /v1/recommendations/*. The R1 migration is actively
 * pointing consumers AT this name while this guard would have pointed it away.
 *
 * The lesson is not "measure more"; the window was correct for the window. It is that a traffic sweep
 * answers "who called yesterday", never "who ships tomorrow", and on a host that is mid-migration
 * those are different questions. So the default denies NOTHING beyond the public-read names, and any
 * additional host is opted in explicitly via AURORA_SURFACE_DENIED_HOSTS once its consumers are
 * reconciled. Add gateway.pivota.cc there after the pivota-agent-ui env vars and the /v1/auth/me
 * migration branch are settled.
 *
 * The public-read names are NOT configurable here and are always refused: mcp.pivota.cc is the UCP
 * identity anchor, it is the hole that was actually reported, and it has zero measured /v1 traffic
 * from anyone.
 */

/**
 * Lowercase, trim, drop a trailing FQDN dot, drop the port — the same normalisation
 * isPublicReadMcpHostRequest applies, so the two host decisions cannot disagree about what a name is.
 * `gateway.pivota.cc.` is a valid spelling of the same host and every scanner tries it; the Railway
 * edge refuses to route it today, but the GCP migration replaces that edge.
 */
function normalizeHost(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\.+$/, '').split(':')[0];
}

function firstNonEmptyString(...values) {
  for (const v of values) {
    const s = String(v == null ? '' : v).trim();
    if (s) return s;
  }
  return '';
}

const DENIED_HOSTS_ENV = 'AURORA_SURFACE_DENIED_HOSTS';
const DEFAULT_DENIED_HOSTS = '';

/**
 * Hosts where the Aurora surface must not be served, beyond the public-read names (those come from
 * server.js's isPublicReadMcpHostRequest, injected — there must stay exactly ONE definition of that
 * set). Normalised the same way that predicate normalises: lowercase, trimmed, port stripped.
 */
function auroraDeniedHosts(env = process.env) {
  const raw = env[DENIED_HOSTS_ENV] === undefined ? DEFAULT_DENIED_HOSTS : env[DENIED_HOSTS_ENV];
  return String(raw)
    .split(',')
    .map((h) => normalizeHost(h))
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
 *
 * /metrics is here because mountAuroraBffRoutes registers it too and it sits outside the version
 * prefix. It is not a cost surface — it is the full Prometheus dump (vision, reco, chat-quality, QA,
 * discovery, PDP, relationship-graph, UCP counters), verified answering 200 unauthenticated on the
 * anchor and the partner host. Operational telemetry does not belong on the UCP identity anchor or
 * on a name being handed to a partner. Edge logs show one hit in the retained window, and the
 * consumer reaches it over the railway.app name (vercel.json rewrites /metrics), which is untouched.
 *
 * NOT included: mountAuroraBffRoutes also registers /internal/prelabel, /internal/prelabel/suggestions
 * and /internal/label-queue, which do reach Gemini. They are already triple-gated (dogfood_mode +
 * prelabel.enabled + a timingSafeEqual admin key) and verified 404 unauthenticated, and `/internal/`
 * is shared with separately-gated routes whose branded-host traffic has not been measured. Left alone
 * deliberately rather than swept in.
 */
function isAuroraSurfacePath(path) {
  const p = String(path || '').toLowerCase();
  if (p === '/metrics') return true; // see below
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

  const normalized = normalizeHost(host);
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
