const { createHash } = require('crypto');

const RATE_LIMIT_ENABLED = process.env.GATEWAY_RATE_LIMIT_ENABLED !== 'false';
const RATE_LIMIT_TTL_MS = Math.max(
  Number(process.env.GATEWAY_RATE_LIMIT_TTL_MS || 0) || 10 * 60 * 1000,
  10 * 1000,
);
const RATE_LIMIT_CLEANUP_INTERVAL_MS = Math.max(
  Number(process.env.GATEWAY_RATE_LIMIT_CLEANUP_INTERVAL_MS || 0) || 60 * 1000,
  5 * 1000,
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

function pickHeader(headers, ...names) {
  for (const raw of names) {
    const key = String(raw || '').toLowerCase();
    const value = headers && typeof headers === 'object' ? headers[key] : null;
    if (!value) continue;
    const v = Array.isArray(value) ? value[0] : value;
    const trimmed = String(v || '').trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function classifyClient({ headers, metadata, ip }) {
  const source = metadata && typeof metadata === 'object' ? String(metadata.source || '').trim() : '';

  const agentApiKey = pickHeader(headers, 'x-agent-api-key');
  const checkoutToken = pickHeader(headers, 'x-checkout-token');
  const authorization = pickHeader(headers, 'authorization');

  const identity = agentApiKey || checkoutToken || authorization || ip || 'anonymous';
  const hashed = sha256Hex(`${source || 'unknown'}:${identity}`).slice(0, 16);

  const tier = (() => {
    if (checkoutToken) return 'session';
    if (agentApiKey) return 'api_key';
    return 'anonymous';
  })();

  return {
    source: source || null,
    tier,
    key: `${tier}:${hashed}`,
  };
}

function shouldBypassRateLimit({ client }) {
  const bypassSources = String(process.env.GATEWAY_RATE_LIMIT_BYPASS_SOURCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!bypassSources.length) return false;
  return client?.source ? bypassSources.includes(client.source) : false;
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
    search.limit = clampInt(search.limit, 1, 50, 20);
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

function applyGatewayGuardrails({ req, operation, payload, effectivePayload, metadata }) {
  const headers = req && typeof req === 'object' ? req.headers : null;
  const ip = req && typeof req === 'object' ? req.ip : null;

  const client = classifyClient({ headers, metadata, ip });
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
    consumeToken,
    operationRateLimit,
    sha256Hex,
  },
};

