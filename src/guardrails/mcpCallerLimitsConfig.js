'use strict';

// Configuration for the per-caller MCP door limits (src/guardrails/mcpCallerLimits.js). Read from the
// environment on every decision so an operator's change takes effect on the next request and tests can
// flip a knob between cases; the only parse worth caching (the overrides JSON) is cached by its raw text.
//
// Every limit is "0 = no limit". The defaults are a starting point for OBSERVE mode, which measures what
// they would have done against real traffic before anything is enforced.

const MODES = Object.freeze(['off', 'observe', 'enforce']);

const DEFAULTS = Object.freeze({
  anonymous: Object.freeze({ rpm: 30, concurrency: 2 }),
  partner: Object.freeze({ rpm: 300, concurrency: 8 }),
  anonymousTier: Object.freeze({ rpm: 0, concurrencyPerInstance: 4 }),
  shed: Object.freeze({ anonymousPoolWaiting: 2, partnerPoolWaiting: 0, retryAfterSec: 5 }),
  syncIntervalMs: 2000,
  syncTimeoutMs: 1500,
  maxSyncKeys: 500,
});

function callerLimitsMode(env = process.env) {
  const raw = String(env.MCP_CALLER_LIMITS_MODE || '').trim().toLowerCase();
  return MODES.includes(raw) ? raw : 'off';
}

function nonNegativeNumber(raw, fallback) {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function positiveInt(raw, fallback, max) {
  const n = Math.trunc(nonNegativeNumber(raw, fallback));
  return n > 0 ? Math.min(n, max) : fallback;
}

function csvSet(...raws) {
  const out = new Set();
  for (const raw of raws) {
    for (const part of String(raw || '').split(',')) {
      const v = part.trim();
      if (v) out.add(v);
    }
  }
  return out;
}

// MCP_CALLER_LIMITS_OVERRIDES_JSON: {"agent:<agent_id>": {"rpm": 600, "concurrency": 16},
//                                    "key:<key fingerprint>": {...}, "oauth:<client_id>": {...}}
// Keys are the caller ids resolveDoorCaller produces (OAuth by client id alone). A malformed value is
// ignored as a whole, loudly, rather than half-applied.
let overridesCache = { raw: null, map: new Map(), error: null };
function parseOverrides(raw) {
  const text = String(raw || '').trim();
  if (overridesCache.raw === text) return overridesCache;
  const map = new Map();
  let error = null;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [id, v] of Object.entries(parsed)) {
        if (!v || typeof v !== 'object') continue;
        const entry = {};
        if (v.rpm !== undefined) entry.rpm = nonNegativeNumber(v.rpm, undefined);
        if (v.concurrency !== undefined) entry.concurrency = nonNegativeNumber(v.concurrency, undefined);
        map.set(String(id).trim(), entry);
      }
    } catch (err) {
      error = err?.message || String(err);
      map.clear();
    }
  }
  overridesCache = { raw: text, map, error };
  return overridesCache;
}

function readCallerLimitsConfig(env = process.env) {
  const overrides = parseOverrides(env.MCP_CALLER_LIMITS_OVERRIDES_JSON);
  return {
    mode: callerLimitsMode(env),
    anonymous: {
      rpm: nonNegativeNumber(env.MCP_CALLER_LIMITS_ANON_RPM, DEFAULTS.anonymous.rpm),
      concurrency: nonNegativeNumber(env.MCP_CALLER_LIMITS_ANON_CONCURRENCY, DEFAULTS.anonymous.concurrency),
    },
    partner: {
      rpm: nonNegativeNumber(env.MCP_CALLER_LIMITS_PARTNER_RPM, DEFAULTS.partner.rpm),
      concurrency: nonNegativeNumber(env.MCP_CALLER_LIMITS_PARTNER_CONCURRENCY, DEFAULTS.partner.concurrency),
    },
    anonymousTier: {
      rpm: nonNegativeNumber(env.MCP_CALLER_LIMITS_ANON_TIER_RPM, DEFAULTS.anonymousTier.rpm),
      concurrencyPerInstance: nonNegativeNumber(
        env.MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE,
        DEFAULTS.anonymousTier.concurrencyPerInstance,
      ),
    },
    shed: {
      anonymousPoolWaiting: nonNegativeNumber(
        env.MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING,
        DEFAULTS.shed.anonymousPoolWaiting,
      ),
      partnerPoolWaiting: nonNegativeNumber(
        env.MCP_CALLER_LIMITS_SHED_PARTNER_POOL_WAITING,
        DEFAULTS.shed.partnerPoolWaiting,
      ),
      retryAfterSec: positiveInt(env.MCP_CALLER_LIMITS_SHED_RETRY_AFTER_S, DEFAULTS.shed.retryAfterSec, 300),
    },
    overrides: overrides.map,
    overridesError: overrides.error,
    // A first-party proxy (one verified agent carrying many end users) is never limited or shed at the MCP
    // doors. DELIBERATELY a separate list from the invoke limiter's GATEWAY_RATE_LIMIT_BYPASS_AGENT_IDS: an
    // operator may lift a partner's invoke ceiling for its loopback tool calls (the invoke limiter applies
    // that bypass by the agent the door verified) without also exempting it from its door limits.
    firstPartyAgentIds: csvSet(env.MCP_CALLER_LIMITS_FIRST_PARTY_AGENT_IDS),
  };
}

function readStoreConfig(env = process.env) {
  const raw = String(env.MCP_CALLER_LIMITS_STORE || '').trim().toLowerCase();
  const kind = raw === 'local' || raw === 'postgres' ? raw : (env.DATABASE_URL ? 'postgres' : 'local');
  return {
    kind,
    syncIntervalMs: positiveInt(env.MCP_CALLER_LIMITS_SYNC_MS, DEFAULTS.syncIntervalMs, 60_000),
    syncTimeoutMs: positiveInt(env.MCP_CALLER_LIMITS_SYNC_TIMEOUT_MS, DEFAULTS.syncTimeoutMs, 10_000),
    maxSyncKeys: positiveInt(env.MCP_CALLER_LIMITS_MAX_SYNC_KEYS, DEFAULTS.maxSyncKeys, 5000),
  };
}

module.exports = {
  DEFAULTS,
  MODES,
  callerLimitsMode,
  readCallerLimitsConfig,
  readStoreConfig,
};
