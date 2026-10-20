'use strict';

// Configuration for the per-caller MCP door limits (src/guardrails/mcpCallerLimits.js). Read from the
// environment on every decision so an operator's change takes effect on the next request and tests can
// flip a knob between cases; the only parse worth caching (the overrides JSON) is cached by its raw text.
//
// Every limit is "0 = no limit". The defaults are a starting point for OBSERVE mode, which measures what
// they would have done against real traffic before anything is enforced.

const net = require('net');

const MODES = Object.freeze(['off', 'observe', 'enforce']);

const DEFAULTS = Object.freeze({
  anonymous: Object.freeze({ rpm: 30, concurrency: 2 }),
  // A request whose client address could not be established at all. One shared bucket for every such
  // request, so it is the strictest class rather than a loophole.
  unknownIp: Object.freeze({ rpm: 10, concurrency: 1 }),
  partner: Object.freeze({ rpm: 300, concurrency: 8 }),
  anonymousTier: Object.freeze({ rpm: 0, concurrencyPerInstance: 4 }),
  // MCP OAuth clients without an explicit override. Dynamic client registration means anyone can mint a
  // client id, so together they share one aggregate budget; a client with an override is exempt.
  oauthUnregisteredTier: Object.freeze({ rpm: 600, concurrencyPerInstance: 8 }),
  shed: Object.freeze({ anonymousPoolWaiting: 2, partnerPoolWaiting: 6, retryAfterSec: 5 }),
  // How many instances a key's budget is split across before this instance has a fresh shared count for it.
  expectedInstances: 4,
  // An in-flight slot older than this is flagged and logged as a zombie (it stays counted until its work's
  // finally runs). Twice the gateway's Cloud Run request timeout (300 s), so no legitimate request is ever
  // flagged.
  inflightMaxAgeMs: 600_000,
  syncIntervalMs: 2000,
  syncTimeoutMs: 1500,
  // How long the sync may wait for a pool connection before giving up (and backing off).
  syncAcquireTimeoutMs: 500,
  // How often to retry fetching the shared daily salt while on a local one.
  saltRetryMs: 30_000,
  syncMaxBackoffMs: 60_000,
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

function limitEntry(v) {
  const entry = {};
  if (v.rpm !== undefined) entry.rpm = nonNegativeNumber(v.rpm, undefined);
  if (v.concurrency !== undefined) entry.concurrency = nonNegativeNumber(v.concurrency, undefined);
  return entry;
}

// cidr:<network>/<prefix> -> a matcher. Throws on anything that is not a valid network, so a typo fails the
// whole overrides value loudly instead of silently matching nothing.
function parseCidr(spec) {
  const [addr, prefixText, extra] = String(spec).split('/');
  const family = net.isIP(addr);
  const prefix = Number(prefixText);
  const max = family === 4 ? 32 : 128;
  if (!family || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new Error(`invalid cidr override: ${spec}`);
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const list = new net.BlockList();
  list.addSubnet(addr, prefix, type);
  return { type, prefix, list };
}

// MCP_CALLER_LIMITS_OVERRIDES_JSON keys (the caller ids resolveDoorCaller produces):
//   agent:<agent_id>                 a verified API-key agent
//   key:<key fingerprint>            an API key with no agent
//   oauth:<issuer>#<client_id>       an MCP OAuth client (issuer AND client id)
//   ip:<IPv4 address>                one anonymous IPv4 address
//   ip:<IPv6 /64 network>/64         one anonymous IPv6 /64, e.g. ip:2001:db8:1:2::/64
//   cidr:<network>/<prefix>          every anonymous caller in a range (each address keeps its OWN bucket,
//                                    at this limit); the longest matching prefix wins; an exact key wins
//                                    over any cidr.
// A malformed value is ignored as a whole, loudly, rather than half-applied.
let overridesCache = { raw: null, map: new Map(), cidrs: [], error: null };
function parseOverrides(raw) {
  const text = String(raw || '').trim();
  if (overridesCache.raw === text) return overridesCache;
  const map = new Map();
  const cidrs = [];
  let error = null;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [rawId, v] of Object.entries(parsed)) {
        if (!v || typeof v !== 'object') continue;
        const id = String(rawId).trim();
        if (id.startsWith('cidr:')) {
          cidrs.push({ id, ...parseCidr(id.slice(5)), entry: limitEntry(v) });
        } else {
          map.set(id, limitEntry(v));
        }
      }
      cidrs.sort((a, b) => b.prefix - a.prefix);
    } catch (err) {
      error = err?.message || String(err);
      map.clear();
      cidrs.length = 0;
    }
  }
  overridesCache = { raw: text, map, cidrs, error };
  return overridesCache;
}

function matchCidrOverride(cidrs, ip) {
  const family = net.isIP(String(ip || ''));
  if (!family) return null;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  for (const c of cidrs) {
    if (c.type === type && c.list.check(ip, type)) return c;
  }
  return null;
}

function readCallerLimitsConfig(env = process.env) {
  const overrides = parseOverrides(env.MCP_CALLER_LIMITS_OVERRIDES_JSON);
  return {
    mode: callerLimitsMode(env),
    anonymous: {
      rpm: nonNegativeNumber(env.MCP_CALLER_LIMITS_ANON_RPM, DEFAULTS.anonymous.rpm),
      concurrency: nonNegativeNumber(env.MCP_CALLER_LIMITS_ANON_CONCURRENCY, DEFAULTS.anonymous.concurrency),
    },
    unknownIp: {
      rpm: nonNegativeNumber(env.MCP_CALLER_LIMITS_UNKNOWN_IP_RPM, DEFAULTS.unknownIp.rpm),
      concurrency: nonNegativeNumber(env.MCP_CALLER_LIMITS_UNKNOWN_IP_CONCURRENCY, DEFAULTS.unknownIp.concurrency),
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
    oauthUnregisteredTier: {
      rpm: nonNegativeNumber(env.MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_RPM, DEFAULTS.oauthUnregisteredTier.rpm),
      concurrencyPerInstance: nonNegativeNumber(
        env.MCP_CALLER_LIMITS_OAUTH_UNREGISTERED_TIER_CONCURRENCY_PER_INSTANCE,
        DEFAULTS.oauthUnregisteredTier.concurrencyPerInstance,
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
    expectedInstances: positiveInt(env.MCP_CALLER_LIMITS_EXPECTED_INSTANCES, DEFAULTS.expectedInstances, 1000),
    inflightMaxAgeMs: positiveInt(env.MCP_CALLER_LIMITS_INFLIGHT_MAX_AGE_MS, DEFAULTS.inflightMaxAgeMs, 3_600_000),
    overrides: overrides.map,
    cidrOverrides: overrides.cidrs,
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
    syncMaxBackoffMs: positiveInt(env.MCP_CALLER_LIMITS_SYNC_MAX_BACKOFF_MS, DEFAULTS.syncMaxBackoffMs, 600_000),
    syncAcquireTimeoutMs: positiveInt(env.MCP_CALLER_LIMITS_SYNC_ACQUIRE_TIMEOUT_MS, DEFAULTS.syncAcquireTimeoutMs, 10_000),
    saltRetryMs: positiveInt(env.MCP_CALLER_LIMITS_SALT_RETRY_MS, DEFAULTS.saltRetryMs, 3_600_000),
    maxSyncKeys: positiveInt(env.MCP_CALLER_LIMITS_MAX_SYNC_KEYS, DEFAULTS.maxSyncKeys, 5000),
  };
}

module.exports = {
  DEFAULTS,
  MODES,
  callerLimitsMode,
  matchCidrOverride,
  readCallerLimitsConfig,
  readStoreConfig,
};
