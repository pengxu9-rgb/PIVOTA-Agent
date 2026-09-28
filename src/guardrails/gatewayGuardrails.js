const { createHash } = require('crypto');
const { isIP } = require('net');

const RATE_LIMIT_ENABLED = process.env.GATEWAY_RATE_LIMIT_ENABLED !== 'false';
const RATE_LIMIT_TTL_MS = Math.max(
  Number(process.env.GATEWAY_RATE_LIMIT_TTL_MS || 0) || 10 * 60 * 1000,
  10 * 1000,
);
const RATE_LIMIT_CLEANUP_INTERVAL_MS = Math.max(
  Number(process.env.GATEWAY_RATE_LIMIT_CLEANUP_INTERVAL_MS || 0) || 60 * 1000,
  5 * 1000,
);
const SEARCH_LIMIT_MAX = Math.max(
  1,
  Math.min(Number(process.env.SEARCH_LIMIT_MAX || 200) || 200, 200),
);

const BUCKETS = new Map(); // key -> { tokens, lastRefillMs, lastSeenMs }
let lastCleanupAtMs = 0;

function sha256Hex(input) {
  return createHash('sha256').update(String(input || '')).digest('hex');
}

function coerceInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = coerceInt(value, fallback);
  return Math.min(Math.max(n, min), max);
}

function nonEmptyString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

// The rate-limit bucket is chosen ONLY from identity this gateway verified itself: `req.invokeAuth`,
// which requireExternalInvokeAuth writes after it has checked the credential (an API key through
// introspection, a checkout token through the backend's verdict). Nothing the request asserts about
// itself — X-Agent-API-Key, Authorization, X-Checkout-Token, metadata.source — selects a bucket: a
// value the gateway has not checked is just a string the caller picked. A request with no verified
// identity is keyed on its client IP.
//
// Verified means:
//  - an API key verdict: keyed on the agent it belongs to, so every key of one agent
//    shares that agent's budget; the key fingerprint only when the verdict named no agent;
//  - a checkout token the backend vouched for (auth_mode 'checkout_token' WITH an agent_id and the
//    token's fingerprint — the shape authenticateCheckoutTokenOnly writes): keyed per token, the
//    'session' tier. A checkout_token verdict without an agent_id was never checked, so it is not
//    identity.
// Anything else is not: no invokeAuth at all (the public search route runs no auth), the test bypass,
// or an auth mode that names no agent.
function verifiedClientIdentity(invokeAuth) {
  const auth = invokeAuth && typeof invokeAuth === 'object' ? invokeAuth : null;
  if (!auth) return null;
  const mode = nonEmptyString(auth.auth_mode);
  const agentId = nonEmptyString(auth.agent_id);
  if (mode === 'api_key') {
    if (agentId) return { tier: 'api_key', identity: `agent:${agentId}` };
    const keyFingerprint = nonEmptyString(auth.key_fingerprint);
    if (keyFingerprint) return { tier: 'api_key', identity: `key:${keyFingerprint}` };
    return null;
  }
  if (mode === 'checkout_token') {
    const tokenFingerprint = nonEmptyString(auth.checkout_token_fingerprint);
    if (agentId && tokenFingerprint) return { tier: 'session', identity: `checkout:${tokenFingerprint}` };
    return null;
  }
  return null;
}

// How many proxies in front of this service append to X-Forwarded-For. Every external request reaches
// the gateway through Google's external Application Load Balancer (Cloud Run ingress is
// internal-and-cloud-load-balancing), which appends TWO entries — the client address it saw and its own
// forwarding-rule address — after whatever the client sent. Everything left of those is the client's
// own text.
function trustedProxyHops() {
  const n = Number(process.env.GATEWAY_RATE_LIMIT_TRUSTED_PROXY_HOPS);
  return Number.isInteger(n) && n >= 1 ? n : 2;
}

function normalizeIp(value) {
  let s = nonEmptyString(value);
  if (!s) return null;
  if (s.toLowerCase().startsWith('::ffff:') && isIP(s.slice(7)) === 4) s = s.slice(7);
  return isIP(s) ? s.toLowerCase() : null;
}

// The client address our own edge observed: the Nth entry from the RIGHT of X-Forwarded-For, N = trusted
// proxy hops. A chain shorter than N (a caller inside the VPC, which reaches the service without the
// load balancer) clamps to its left-most entry. An entry that is not an IP address is not an identity
// either, and falls back to the socket peer rather than becoming a bucket of its own.
function clientIpFromRequest(req) {
  const parts = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length) {
    const fromEdge = normalizeIp(parts[Math.max(0, parts.length - trustedProxyHops())]);
    if (fromEdge) return fromEdge;
  }
  return normalizeIp(req?.socket?.remoteAddress) || normalizeIp(req?.ip) || null;
}

function classifyClient({ req } = {}) {
  const verified = verifiedClientIdentity(req?.invokeAuth);
  if (verified) {
    return {
      tier: verified.tier,
      key: `${verified.tier}:${sha256Hex(verified.identity).slice(0, 16)}`,
      agent_id: nonEmptyString(req.invokeAuth.agent_id),
    };
  }
  const ip = clientIpFromRequest(req);
  return {
    tier: 'anonymous',
    key: `anonymous:${sha256Hex(`ip:${ip || 'unknown'}`).slice(0, 16)}`,
    agent_id: null,
  };
}

// Operators can exempt named agents (a first-party proxy whose one key carries many end users). Only a
// VERIFIED agent_id can match — an exemption keyed on anything the caller sends is an exemption for
// every caller who sends it.
function shouldBypassRateLimit({ client }) {
  const bypassAgentIds = String(process.env.GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!bypassAgentIds.length || !client?.agent_id) return false;
  return bypassAgentIds.includes(client.agent_id);
}

function operationRateLimit(operation, client) {
  const op = String(operation || '').trim();
  const base = {
    capacity: clampInt(process.env.GATEWAY_RATE_LIMIT_CAPACITY, 10, 10_000, 120),
    refill_per_sec: Math.max(Number(process.env.GATEWAY_RATE_LIMIT_REFILL_PER_SEC || 0) || 2, 0.1),
  };

  const tuned = (() => {
    if (op === 'find_products_multi') return { capacity: 60, refill_per_sec: 1 };
    if (op === 'find_products') return { capacity: 120, refill_per_sec: 2 };
    if (op === 'get_pdp_v2' || op === 'resolve_product_candidates') return { capacity: 180, refill_per_sec: 3 };
    return base;
  })();

  if (client?.tier === 'session') return { ...tuned, capacity: tuned.capacity * 2, refill_per_sec: tuned.refill_per_sec * 2 };
  return tuned;
}

function maybeCleanup(nowMs) {
  if (nowMs - lastCleanupAtMs < RATE_LIMIT_CLEANUP_INTERVAL_MS) return;
  lastCleanupAtMs = nowMs;
  for (const [key, bucket] of BUCKETS.entries()) {
    if (!bucket || typeof bucket !== 'object') {
      BUCKETS.delete(key);
      continue;
    }
    const lastSeenMs = typeof bucket.lastSeenMs === 'number' ? bucket.lastSeenMs : 0;
    if (nowMs - lastSeenMs > RATE_LIMIT_TTL_MS) BUCKETS.delete(key);
  }
}

function consumeToken({ key, capacity, refillPerSec, nowMs }) {
  if (!key) return { ok: true, retryAfterSec: null };

  maybeCleanup(nowMs);

  const cap = Math.max(Number(capacity) || 0, 1);
  const refill = Math.max(Number(refillPerSec) || 0, 0);
  const existing = BUCKETS.get(key);
  const bucket = existing && typeof existing === 'object' ? existing : null;

  const lastRefillMs = bucket && typeof bucket.lastRefillMs === 'number' ? bucket.lastRefillMs : nowMs;
  const tokens = bucket && typeof bucket.tokens === 'number' ? bucket.tokens : cap;
  const elapsedSec = Math.max(0, (nowMs - lastRefillMs) / 1000);
  const nextTokens = Math.min(cap, tokens + elapsedSec * refill);

  if (nextTokens < 1) {
    const missing = 1 - nextTokens;
    const retryAfterSec = refill > 0 ? Math.ceil(missing / refill) : 60;
    BUCKETS.set(key, {
      tokens: nextTokens,
      lastRefillMs: nowMs,
      lastSeenMs: nowMs,
    });
    return { ok: false, retryAfterSec };
  }

  BUCKETS.set(key, {
    tokens: nextTokens - 1,
    lastRefillMs: nowMs,
    lastSeenMs: nowMs,
  });
  return { ok: true, retryAfterSec: null };
}

function clampSearchPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  const search = payload.search && typeof payload.search === 'object' ? payload.search : null;
  if (!search) return;

  // Keep query fanout bounded. The underlying search endpoint supports large limits; we
  // cap here as a guardrail (partners should paginate if needed).
  if (Object.prototype.hasOwnProperty.call(search, 'limit')) {
    search.limit = clampInt(search.limit, 1, SEARCH_LIMIT_MAX, 20);
  }
  if (Object.prototype.hasOwnProperty.call(search, 'offset')) {
    search.offset = clampInt(search.offset, 0, 500, 0);
  }
}

function clampResolveCandidatesPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  const options = payload.options && typeof payload.options === 'object' ? payload.options : null;
  if (!options) return;
  if (Object.prototype.hasOwnProperty.call(options, 'limit')) {
    options.limit = clampInt(options.limit, 1, 30, 10);
  }
}

function clampGetPdpV2Payload(payload) {
  if (!payload || typeof payload !== 'object') return;
  const offers = payload.offers && typeof payload.offers === 'object' ? payload.offers : null;
  if (offers && Object.prototype.hasOwnProperty.call(offers, 'limit')) {
    offers.limit = clampInt(offers.limit, 1, 30, 10);
  }

  const similar = payload.similar && typeof payload.similar === 'object' ? payload.similar : null;
  if (similar && Object.prototype.hasOwnProperty.call(similar, 'limit')) {
    similar.limit = clampInt(similar.limit, 0, 24, 6);
  }
}

function applyGatewayGuardrails({ req, operation, payload, effectivePayload }) {
  const client = classifyClient({ req });
  const nowMs = Date.now();

  if (RATE_LIMIT_ENABLED && !shouldBypassRateLimit({ client })) {
    const limits = operationRateLimit(operation, client);
    const rateKey = `${client.key}:${String(operation || '').trim() || 'unknown'}`;
    const rate = consumeToken({
      key: rateKey,
      capacity: limits.capacity,
      refillPerSec: limits.refill_per_sec,
      nowMs,
    });
    if (!rate.ok) {
      return {
        blocked: {
          status: 429,
          retryAfterSec: rate.retryAfterSec,
          body: {
            error: 'RATE_LIMITED',
            message: 'Too many requests. Please retry later.',
            operation,
          },
        },
        client,
      };
    }
  }

  // Payload-level clamps (cheap safety guardrails).
  if (operation === 'find_products_multi' || operation === 'find_products') {
    clampSearchPayload(effectivePayload || payload);
  } else if (operation === 'resolve_product_candidates') {
    clampResolveCandidatesPayload(payload);
  } else if (operation === 'get_pdp_v2') {
    clampGetPdpV2Payload(payload);
  }

  return { blocked: null, client };
}

module.exports = {
  applyGatewayGuardrails,
  classifyClient,
  clampInt,
  __test__: {
    clientIpFromRequest,
    consumeToken,
    operationRateLimit,
    sha256Hex,
  },
};
