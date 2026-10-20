'use strict';

// PER-CALLER LIMITS AT THE MCP DOORS (/public/mcp, /mcp, /ucp/mcp).
//
// Why this exists. The doors had gaps that let one caller degrade every other caller and the shared
// Postgres primary:
//   1. the public tier's limiter is in-memory PER INSTANCE, so its per-IP budget multiplies by however many
//      instances the service has scaled to;
//   2. the authenticated door had no per-caller limit at all, and every MCP tool's loopback invoke call
//      drew from the invoke limiter's bucket for the gateway's own service key (fixed separately by
//      src/guardrails/loopbackCallerAssertion.js);
//   3. neither door bounded how many slow requests one caller may hold IN FLIGHT, which is what actually
//      loads the database: a caller well inside a request-rate budget can still pin the primary with slow
//      searches running in parallel.
//
// What it does, per tools/call (the one MCP method that does real work; initialize / tools/list answer
// from memory and are not counted):
//   - resolves WHO is calling (resolveDoorCaller): a verified API key's agent (or key fingerprint), an MCP
//     OAuth client (issuer + client id), else the client address by the gateway-wide client-IP rule (an
//     IPv6 address by its /64). First-party callers are never limited.
//   - checks, in this order, and stops at the first that fails:
//       shed             the DB pool is saturated: refuse anonymous first, partners at a higher threshold
//       tier_concurrency anonymous (or unregistered-OAuth) requests in flight on THIS instance
//       concurrency      this caller's requests in flight, across instances
//       rate             this caller's requests per minute, across instances (sliding window)
//       tier_rate        all anonymous / all unregistered-OAuth requests per minute, across instances
//   - in OBSERVE mode logs the decision it would have made (WARN) and admits; in ENFORCE mode refuses with
//     a JSON-RPC error and Retry-After (never a 200 with empty results).
//
// IN FLIGHT means "the door's tool dispatch is running", not "the response is open": the door releases the
// slot in a finally around the dispatch, so a client that disconnects mid-call keeps its slot until the
// work it started has finished (the work does not stop when the socket does). A client already gone when
// its turn for admission comes is never admitted. A slot whose release somehow never runs is reaped after
// MCP_CALLER_LIMITS_INFLIGHT_MAX_AGE_MS, with a WARN.
//
// GLOBAL across instances without a per-request write. The only shared store this service has is the
// Postgres primary it is protecting, so the hot path never touches it: every decision reads local
// counters plus the last snapshot of the other instances' counters. A background sync (one statement per
// instance every MCP_CALLER_LIMITS_SYNC_MS, default 2 s, only while this instance has active callers and a
// free pool connection) writes this instance's absolute counts for its busiest keys into an UNLOGGED table
// and reads back the other instances' totals for the same keys. Postgres cancels the statement itself at
// MCP_CALLER_LIMITS_SYNC_TIMEOUT_MS (statement_timeout, so the connection survives), and a failing sync
// backs off exponentially. Each instance writes only its own rows, so instances never contend on a row
// lock. The price is approximation: until a key appears in a fresh snapshot, this instance allows it only
// limit / MCP_CALLER_LIMITS_EXPECTED_INSTANCES, so a burst landing on many instances at once cannot
// multiply the budget; after that, a caller can overshoot by roughly what the instances admit between two
// syncs. When the store is unreachable or missing, limits stay at that per-instance share.
//
// NEVER LOGGED: a client address. A refusal line carries the hashed caller key and, for anonymous callers,
// the truncated network (IPv4 /24, IPv6 /48) — enough to choose a cidr: override, not enough to name a
// client.

const crypto = require('crypto');
const net = require('net');
const { clientIpFromRequest } = require('./gatewayGuardrails');
const {
  matchCidrOverride,
  readCallerLimitsConfig,
  readStoreConfig,
  callerLimitsMode,
} = require('./mcpCallerLimitsConfig');
const { loopbackAssertionStatus } = require('./loopbackCallerAssertion');

const WINDOW_MS = 60_000;
const ANON_TIER_KEY = 'tier:anonymous';
const OAUTH_UNREG_TIER_KEY = 'tier:oauth_unregistered';
const TIER_KEYS = new Set([ANON_TIER_KEY, OAUTH_UNREG_TIER_KEY]);
const MAX_LOCAL_KEYS = 50_000;
const STORE_DISABLE_MS = 10 * 60 * 1000;
const STORE_WARN_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const REAP_INTERVAL_MS = 1000;
const CONCURRENCY_RETRY_AFTER_SEC = 2;

// JSON-RPC server-error codes (the -32000..-32099 range is implementation-defined).
const RPC_CODE_CALLER_LIMITED = -32029;
const RPC_CODE_SERVER_BUSY = -32053;

// Auth sources that name this platform's own service credential (see resolveConfiguredInvokeAuthFastPath in
// src/server.js). A caller holding it is first-party by construction.
const FIRST_PARTY_AUTH_SOURCES = new Set(['configured_service_key', 'internal_trusted_key']);

function text(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s && s.length <= 512 ? s : null;
}

function sha16(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 16);
}

// ---------------- addresses ----------------

// The eight 16-bit groups of an IPv6 address, or null.
function ipv6Groups(addr) {
  let a = String(addr || '').toLowerCase().split('%')[0];
  if (net.isIP(a) !== 6) return null;
  const dotted = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    a = `${a.slice(0, -dotted[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function ipv6Prefix(groups, nGroups) {
  return `${groups.slice(0, nGroups).map((g) => g.toString(16)).join(':')}::/${nGroups * 16}`;
}

// The bucket an anonymous address keys on: an IPv4 address as itself; an IPv6 address by its /64, the
// smallest block a single subscriber is normally given (rotating within it buys no new bucket).
function anonymousIdForIp(ip) {
  const family = net.isIP(String(ip || ''));
  if (family === 4) return `ip:${ip}`;
  if (family === 6) {
    const groups = ipv6Groups(ip);
    if (groups) return `ip:${ipv6Prefix(groups, 4)}`;
  }
  return 'ip:unknown';
}

// What a log line may say about an address: IPv4 /24, IPv6 /48. Never the address.
function logNetworkForIp(ip) {
  const family = net.isIP(String(ip || ''));
  if (family === 4) return `${String(ip).split('.').slice(0, 3).join('.')}.0/24`;
  if (family === 6) {
    const groups = ipv6Groups(ip);
    if (groups) return ipv6Prefix(groups, 3);
  }
  return 'unknown';
}

// ---------------- identity ----------------

function makeCaller(tier, id, extra = {}) {
  return {
    tier,
    // The id the operator names in MCP_CALLER_LIMITS_OVERRIDES_JSON. Never logged (for an anonymous caller it
    // carries the client address); `key` is the hashed form used everywhere else.
    id,
    key: `${tier}:${sha16(id)}`,
    agent_id: extra.agentId || null,
    oauth_client_id: extra.oauthClientId || null,
    oauth_issuer: extra.oauthIssuer || null,
    // Anonymous only, for cidr: override matching. Never logged, never leaves this module's decisions.
    ip: extra.ip || null,
    net_prefix: extra.netPrefix || null,
    unknown_ip: extra.unknownIp === true,
  };
}

/**
 * Who is calling this MCP door. Reads only identity the gateway verified itself (req.invokeAuth, written by
 * the api-key channel or the MCP OAuth front door) and the edge-attested client address; nothing the
 * request asserts about itself picks the bucket.
 */
function resolveDoorCaller(req, { config } = {}) {
  const cfg = config || readCallerLimitsConfig();
  const auth = req && typeof req.invokeAuth === 'object' && req.invokeAuth ? req.invokeAuth : null;
  const authMode = auth ? text(auth.auth_mode) : null;
  const agentId = auth ? text(auth.agent_id) : null;

  if (authMode === 'api_key') {
    const keyFingerprint = text(auth.key_fingerprint);
    // A degraded verdict (introspection outage, emergency key list) names a shared fallback agent, not the
    // caller: key it on the credential so an outage does not merge every partner into one bucket.
    if (auth.auth_degraded === true) {
      if (keyFingerprint) return makeCaller('partner', `key:${keyFingerprint}`);
    } else {
      const source = (text(auth.introspect_auth_source) || '').toLowerCase();
      if ((agentId && cfg.firstPartyAgentIds.has(agentId)) || FIRST_PARTY_AUTH_SOURCES.has(source)) {
        return makeCaller('first_party', `agent:${agentId || 'service'}`, { agentId });
      }
      if (agentId) return makeCaller('partner', `agent:${agentId}`, { agentId });
      if (keyFingerprint) return makeCaller('partner', `key:${keyFingerprint}`);
    }
  }
  if (authMode === 'mcp_oauth') {
    const clientId = text(auth.oauth_client_id);
    const issuer = text(auth.oauth_issuer);
    // Issuer AND client id: two authorization servers may issue the same client id string.
    if (clientId) {
      return makeCaller('partner', `oauth:${issuer || 'unknown'}#${clientId}`, {
        oauthClientId: clientId,
        oauthIssuer: issuer,
      });
    }
  }
  const ip = clientIpFromRequest(req);
  const id = anonymousIdForIp(ip);
  return makeCaller('anonymous', id, {
    ip: id === 'ip:unknown' ? null : ip,
    netPrefix: logNetworkForIp(ip),
    unknownIp: id === 'ip:unknown',
  });
}

function policyFor(caller, cfg) {
  const exact = cfg.overrides.get(caller.id) || null;
  const cidr = !exact && caller.tier === 'anonymous' && caller.ip
    ? matchCidrOverride(cfg.cidrOverrides, caller.ip)
    : null;
  const override = exact || (cidr ? cidr.entry : null) || {};
  let base = cfg.anonymous;
  if (caller.unknown_ip) base = cfg.unknownIp;
  else if (caller.tier === 'partner') base = cfg.partner;
  const oauthUnregistered = Boolean(caller.oauth_client_id) && !exact;
  let tierKey = null;
  let tier = null;
  if (caller.tier === 'anonymous') {
    tierKey = ANON_TIER_KEY;
    tier = cfg.anonymousTier;
  } else if (oauthUnregistered) {
    tierKey = OAUTH_UNREG_TIER_KEY;
    tier = cfg.oauthUnregisteredTier;
  }
  return {
    rpm: Number.isFinite(override.rpm) ? override.rpm : base.rpm,
    concurrency: Number.isFinite(override.concurrency) ? override.concurrency : base.concurrency,
    overridden: Boolean(exact || cidr),
    oauthUnregistered,
    tierKey,
    tier,
  };
}

function clampSec(n, min, max) {
  const v = Math.ceil(Number(n) || 0);
  return Math.min(Math.max(v, min), max);
}

/**
 * @param {object} opts
 * @param {object} [opts.store] shared counter store ({ sync, prune }); null = per-instance only.
 * @param {() => ({waiting:number, idle?:number, total?:number, max?:number}|null)} [opts.poolStats]
 */
function createCallerLimiter({
  env = process.env,
  now = () => Date.now(),
  store = null,
  instanceId = crypto.randomUUID(),
  poolStats = () => null,
  log = null,
  autoSync = true,
} = {}) {
  // key -> { win, cur, prev, inflight }: THIS instance's admitted requests in the current and previous
  // window, and its requests in flight.
  const local = new Map();
  // others: key -> { byWin: Map(windowStartMs -> requests), inflight } for the OTHER instances; synced:
  // the keys this instance sent in that sync (only those have a shared count, even when it is zero).
  let snapshot = { at: 0, others: new Map(), synced: new Set() };
  // Every slot currently held, for the max-age reaper.
  const held = new Map();
  let nextHandleId = 1;
  let lastReapAt = 0;
  let syncing = null;
  let timer = null;
  let lastPruneAt = 0;
  const syncState = { failures: 0, nextAt: 0, lastWarnAt: 0, lastOkAt: 0 };

  function storeConfig() {
    return readStoreConfig(env);
  }

  function windowOf(t) {
    return Math.floor(t / WINDOW_MS) * WINDOW_MS;
  }

  function roll(entry, win) {
    if (entry.win === win) return entry;
    entry.prev = entry.win === win - WINDOW_MS ? entry.cur : 0;
    entry.cur = 0;
    entry.win = win;
    return entry;
  }

  function localEntry(key, win) {
    let entry = local.get(key);
    if (!entry) {
      if (local.size >= MAX_LOCAL_KEYS) pruneLocal(win);
      entry = { win, cur: 0, prev: 0, inflight: 0 };
      local.set(key, entry);
    }
    return roll(entry, win);
  }

  // Bounded memory under a flood of distinct callers (rotating addresses): idle entries go first; past that,
  // entries with nothing in flight. The tier-wide limits are what still bound such a flood.
  function pruneLocal(win) {
    for (const [key, entry] of local) {
      roll(entry, win);
      if (!entry.cur && !entry.prev && !entry.inflight) local.delete(key);
    }
    if (local.size < MAX_LOCAL_KEYS) return;
    for (const [key, entry] of local) {
      if (!entry.inflight && !TIER_KEYS.has(key)) local.delete(key);
    }
  }

  function snapshotFresh(t) {
    return snapshot.at > 0 && t - snapshot.at <= 3 * storeConfig().syncIntervalMs;
  }

  function others(key, win, t) {
    const o = snapshot.others.get(key);
    if (!o) return { cur: 0, prev: 0, inflight: 0 };
    return {
      cur: o.byWin.get(win) || 0,
      prev: o.byWin.get(win - WINDOW_MS) || 0,
      // A gauge goes stale fast; window counts stay true for their window whatever their age.
      inflight: snapshotFresh(t) ? o.inflight : 0,
    };
  }

  // A key this instance has no fresh shared count for gets only its share of a global limit: a burst that
  // lands on many instances at once cannot multiply the budget before the first sync. Per-instance mode
  // (no shared store) is an explicit choice of per-instance limits, so it keeps the full limit.
  function effectiveLimit(key, limit, t, cfg) {
    if (!store || !(limit > 0)) return { limit, split: false };
    if (snapshotFresh(t) && snapshot.synced.has(key)) return { limit, split: false };
    return { limit: Math.max(1, Math.ceil(limit / cfg.expectedInstances)), split: true };
  }

  function inflightOf(key, t) {
    const entry = local.get(key);
    return (entry ? entry.inflight : 0) + others(key, windowOf(t), t).inflight;
  }

  // Sliding-window estimate: the previous window weighted by how much of it still overlaps the last minute.
  function rateOf(key, t) {
    const win = windowOf(t);
    const frac = (t - win) / WINDOW_MS;
    const entry = local.get(key);
    if (entry) roll(entry, win);
    const o = others(key, win, t);
    const prev = (entry ? entry.prev : 0) + o.prev;
    const cur = (entry ? entry.cur : 0) + o.cur;
    return { value: prev * (1 - frac) + cur, prev, cur, frac };
  }

  function rateRetryAfterSec(est, limit) {
    const { prev, cur, frac } = est;
    if (cur + 1 <= limit) {
      // Over only because of the previous window's tail: wait for it to decay.
      const needFrac = prev > 0 ? 1 - (limit - cur - 1) / prev : frac;
      return clampSec(((needFrac - frac) * WINDOW_MS) / 1000, 1, 60);
    }
    // The current window alone is over: after it rolls, its count decays as the new previous window.
    const afterRollFrac = cur > 0 ? Math.max(0, 1 - (limit - 1) / cur) : 0;
    return clampSec((((1 - frac) + afterRollFrac) * WINDOW_MS) / 1000, 1, 120);
  }

  function rateViolation(reason, status, key, rawLimit, t, cfg) {
    const { limit, split } = effectiveLimit(key, rawLimit, t, cfg);
    const est = rateOf(key, t);
    if (est.value + 1 <= limit) return null;
    return {
      reason,
      status,
      limit,
      limit_split: split,
      observed: Math.round(est.value * 100) / 100,
      retryAfterSec: rateRetryAfterSec(est, limit),
    };
  }

  function firstViolation(caller, policy, cfg, t) {
    const shedAt = caller.tier === 'anonymous' ? cfg.shed.anonymousPoolWaiting : cfg.shed.partnerPoolWaiting;
    if (shedAt > 0) {
      let stats = null;
      try {
        stats = poolStats();
      } catch (_) {
        stats = null;
      }
      const waiting = Number(stats?.waiting);
      if (Number.isFinite(waiting) && waiting >= shedAt) {
        return { reason: 'shed', status: 503, limit: shedAt, observed: waiting, retryAfterSec: cfg.shed.retryAfterSec };
      }
    }
    if (policy.tierKey && policy.tier.concurrencyPerInstance > 0) {
      const entry = local.get(policy.tierKey);
      const inflight = entry ? entry.inflight : 0;
      if (inflight >= policy.tier.concurrencyPerInstance) {
        return {
          reason: 'tier_concurrency',
          status: 503,
          limit: policy.tier.concurrencyPerInstance,
          observed: inflight,
          retryAfterSec: cfg.shed.retryAfterSec,
        };
      }
    }
    if (policy.concurrency > 0) {
      const { limit, split } = effectiveLimit(caller.key, policy.concurrency, t, cfg);
      const inflight = inflightOf(caller.key, t);
      if (inflight >= limit) {
        return {
          reason: 'concurrency',
          status: 429,
          limit,
          limit_split: split,
          observed: inflight,
          retryAfterSec: CONCURRENCY_RETRY_AFTER_SEC,
        };
      }
    }
    if (policy.rpm > 0) {
      const v = rateViolation('rate', 429, caller.key, policy.rpm, t, cfg);
      if (v) return v;
    }
    if (policy.tierKey && policy.tier.rpm > 0) {
      const v = rateViolation('tier_rate', 503, policy.tierKey, policy.tier.rpm, t, cfg);
      if (v) return v;
    }
    return null;
  }

  function callerLogFields(caller) {
    return {
      tier: caller.tier,
      caller_key: caller.key,
      ...(caller.net_prefix ? { caller_net: caller.net_prefix } : {}),
      ...(caller.unknown_ip ? { caller_ip_unknown: true } : {}),
      ...(caller.agent_id ? { caller_agent_id: caller.agent_id } : {}),
      ...(caller.oauth_client_id ? { caller_oauth_client_id: caller.oauth_client_id } : {}),
      ...(caller.oauth_issuer ? { caller_oauth_issuer: caller.oauth_issuer } : {}),
    };
  }

  function logDecision({ mode, violation, caller, policy, door }) {
    try {
      log?.warn?.(
        {
          event: 'mcp_caller_limit',
          action: mode === 'enforce' ? 'reject' : 'would_reject',
          mode,
          reason: violation.reason,
          door: door || null,
          ...callerLogFields(caller),
          // Whether an override set this caller's limits — never WHICH key (an ip: key is an address).
          overridden: policy.overridden,
          ...(policy.oauthUnregistered ? { oauth_unregistered: true } : {}),
          limit: violation.limit,
          ...(violation.limit_split ? { limit_split: true } : {}),
          observed: violation.observed,
          retry_after_s: violation.retryAfterSec,
          status: violation.status,
          store: store ? store.kind || 'shared' : 'local',
          store_fresh: store ? snapshotFresh(now()) : false,
        },
        'mcp caller limit',
      );
    } catch (_) {
      // Logging must never change the decision.
    }
  }

  // The max-age backstop: a slot older than any tool can legitimately run is released and reported.
  function reapExpired(t, cfg) {
    if (t - lastReapAt < REAP_INTERVAL_MS) return;
    lastReapAt = t;
    for (const handle of [...held.values()]) {
      if (t - handle.startedAt > cfg.inflightMaxAgeMs) {
        handle.free();
        try {
          log?.warn?.(
            {
              event: 'mcp_caller_limit_reaped',
              door: handle.door,
              ...callerLogFields(handle.caller),
              age_ms: t - handle.startedAt,
              max_age_ms: cfg.inflightMaxAgeMs,
            },
            'mcp caller limit in-flight slot reaped',
          );
        } catch (_) {
          // ignore
        }
      }
    }
  }

  const NOOP = Object.freeze({ allowed: true, violation: null, release() {} });

  /**
   * Decide one tools/call. Returns { allowed, violation, release }. `release` must be called when the tool
   * dispatch finishes (it is idempotent, and the reaper is the backstop). In observe mode `allowed` is
   * always true and `violation` says what enforce would have done.
   */
  function admit(caller, { door } = {}) {
    const cfg = readCallerLimitsConfig(env);
    if (cfg.mode === 'off' || !caller || caller.tier === 'first_party') return NOOP;
    const t = now();
    ensureSyncTimer();
    reapExpired(t, cfg);
    const policy = policyFor(caller, cfg);
    const violation = firstViolation(caller, policy, cfg, t);
    if (violation) {
      logDecision({ mode: cfg.mode, violation, caller, policy, door });
      if (cfg.mode === 'enforce') return { allowed: false, violation, release() {} };
    }
    const win = windowOf(t);
    const entry = localEntry(caller.key, win);
    entry.cur += 1;
    entry.inflight += 1;
    const tierEntry = policy.tierKey ? localEntry(policy.tierKey, win) : null;
    if (tierEntry) {
      tierEntry.cur += 1;
      tierEntry.inflight += 1;
    }
    const id = nextHandleId;
    nextHandleId += 1;
    let freed = false;
    const handle = {
      caller,
      door: door || null,
      startedAt: t,
      free() {
        if (freed) return;
        freed = true;
        held.delete(id);
        entry.inflight = Math.max(0, entry.inflight - 1);
        if (tierEntry) tierEntry.inflight = Math.max(0, tierEntry.inflight - 1);
      },
    };
    held.set(id, handle);
    return { allowed: true, violation, release: handle.free };
  }

  function warnStore(err, extra = {}) {
    const t = now();
    if (t - syncState.lastWarnAt < STORE_WARN_INTERVAL_MS) return;
    syncState.lastWarnAt = t;
    try {
      log?.warn?.(
        {
          event: 'mcp_caller_limit_store',
          err: err?.message || String(err),
          code: err?.code || null,
          failures: syncState.failures,
          next_sync_in_ms: Math.max(0, syncState.nextAt - t),
          ...extra,
        },
        'mcp caller limit store sync failed; limits are per-instance shares until it recovers',
      );
    } catch (_) {
      // ignore
    }
  }

  // 1st failure: wait one interval; then 2x, 4x, ... up to the cap. A success resets it.
  function backoffMs(failures, cfg) {
    return Math.min(cfg.syncMaxBackoffMs, cfg.syncIntervalMs * 2 ** Math.max(0, failures - 1));
  }

  /** One sync round. Resolves true when a fresh snapshot was taken. Never rejects. */
  function syncNow() {
    if (!store) return Promise.resolve(false);
    if (syncing) return syncing;
    syncing = (async () => {
      const t = now();
      if (t < syncState.nextAt) return false;
      reapExpired(t, readCallerLimitsConfig(env));
      // Never queue behind real work: no sync while the pool has waiters or no free connection.
      let stats = null;
      try {
        stats = poolStats();
      } catch (_) {
        stats = null;
      }
      if (Number(stats?.waiting) > 0) return false;
      if (stats && Number(stats.idle) === 0 && Number(stats.max) > 0 && Number(stats.total) >= Number(stats.max)) {
        return false;
      }
      const cfg = storeConfig();
      const win = windowOf(t);
      const active = [];
      for (const [key, entry] of local) {
        roll(entry, win);
        if (entry.cur || entry.prev || entry.inflight) active.push([key, entry]);
      }
      if (!active.length) return false;
      active.sort((a, b) => (b[1].cur + b[1].inflight * 10) - (a[1].cur + a[1].inflight * 10));
      const chosen = active.slice(0, cfg.maxSyncKeys);
      const rows = [];
      for (const [key, entry] of chosen) {
        rows.push({ key, windowMs: win, requests: entry.cur, inflight: entry.inflight });
        if (entry.prev) rows.push({ key, windowMs: win - WINDOW_MS, requests: entry.prev, inflight: 0 });
      }
      const result = await store.sync({
        instanceId,
        rows,
        sinceMs: win - WINDOW_MS,
        freshSec: Math.max(1, Math.ceil((3 * cfg.syncIntervalMs) / 1000)),
        timeoutMs: cfg.syncTimeoutMs,
      });
      const next = new Map();
      for (const row of Array.isArray(result) ? result : []) {
        const key = String(row.key);
        const o = next.get(key) || { byWin: new Map(), inflight: 0 };
        const rowWin = Number(row.windowMs);
        o.byWin.set(rowWin, (o.byWin.get(rowWin) || 0) + (Number(row.requests) || 0));
        if (rowWin === win) o.inflight += Number(row.inflight) || 0;
        next.set(key, o);
      }
      snapshot = { at: now(), others: next, synced: new Set(chosen.map(([key]) => key)) };
      syncState.failures = 0;
      syncState.nextAt = 0;
      syncState.lastOkAt = snapshot.at;
      if (typeof store.prune === 'function' && snapshot.at - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = snapshot.at;
        store.prune({ beforeMs: win - 2 * WINDOW_MS, timeoutMs: cfg.syncTimeoutMs }).catch((err) => warnStore(err, { op: 'prune' }));
      }
      return true;
    })()
      .catch((err) => {
        const t = now();
        syncState.failures += 1;
        // The table is not there (migration not applied yet): stop asking for a while.
        syncState.nextAt = err?.code === '42P01'
          ? t + STORE_DISABLE_MS
          : t + backoffMs(syncState.failures, storeConfig());
        warnStore(err);
        return false;
      })
      .finally(() => {
        syncing = null;
      });
    return syncing;
  }

  function ensureSyncTimer() {
    if (!store || !autoSync || timer) return;
    const intervalMs = storeConfig().syncIntervalMs;
    timer = setInterval(() => {
      syncNow();
    }, intervalMs);
    // Never keeps the process (or a test file) alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function inspect(key) {
    const t = now();
    const entry = local.get(key);
    return {
      local: entry ? { ...roll(entry, windowOf(t)) } : null,
      others: others(key, windowOf(t), t),
      snapshotAt: snapshot.at,
      held: held.size,
      sync: { failures: syncState.failures, nextAt: syncState.nextAt },
    };
  }

  return { admit, syncNow, stop, inspect, instanceId };
}

// ---------------- shared stores ----------------

// One round trip for the work (inside a transaction that sets statement_timeout, so Postgres cancels a slow
// sync itself and the connection stays healthy): upsert this instance's absolute counts (GREATEST, so a
// late or repeated sync can never lower or double-count a window), then read the OTHER instances' totals
// for the same keys. The read runs on the statement's snapshot, which never includes rows written by the
// same statement — and own rows are excluded anyway, because this instance already counts its own
// requests locally.
//
// GREATEST and the prune: the prune deletes only windows at least two minutes old, which no instance
// writes any more (each writes its current and previous minute), so a pruned row is never re-created
// lower. A table emptied by a crash or failover is re-filled with each instance's absolute counts.
const SYNC_SQL = `
WITH incoming AS (
  SELECT * FROM unnest($1::text[], $2::bigint[], $3::int[], $4::int[]) AS t(caller_key, window_ms, requests, in_flight)
), upserted AS (
  INSERT INTO gateway_caller_limit_counters AS c (caller_key, window_start, instance_id, requests, in_flight, updated_at)
  SELECT caller_key, to_timestamp(window_ms / 1000.0), $5, requests, in_flight, now() FROM incoming
  ON CONFLICT (caller_key, window_start, instance_id) DO UPDATE
    SET requests = GREATEST(c.requests, EXCLUDED.requests), in_flight = EXCLUDED.in_flight, updated_at = now()
  RETURNING 1
)
SELECT caller_key,
       (extract(epoch FROM window_start) * 1000)::bigint AS window_ms,
       sum(requests)::bigint AS requests,
       coalesce(sum(in_flight) FILTER (WHERE updated_at > now() - make_interval(secs => $7)), 0)::bigint AS in_flight
  FROM gateway_caller_limit_counters
 WHERE caller_key = ANY($1::text[])
   AND window_start >= to_timestamp($6 / 1000.0)
   AND instance_id <> $5
 GROUP BY caller_key, window_start`;

// Bounded per call and lock-free against concurrent pruners on other instances.
const PRUNE_SQL = `
DELETE FROM gateway_caller_limit_counters
 WHERE ctid IN (
   SELECT ctid FROM gateway_caller_limit_counters
    WHERE window_start < to_timestamp($1 / 1000.0)
    LIMIT 5000
    FOR UPDATE SKIP LOCKED
 )`;

function createPostgresCallerLimitStore({ db = require('../db') } = {}) {
  return {
    kind: 'postgres',
    async sync({ instanceId, rows, sinceMs, freshSec, timeoutMs }) {
      // statement_timeout, NOT a client-side budget: a client-side abort would destroy the connection and
      // leave the statement running, which on a saturated primary means connection churn plus orphans.
      const res = await db.queryWithStatementTimeout(
        SYNC_SQL,
        [
          rows.map((r) => r.key),
          rows.map((r) => r.windowMs),
          rows.map((r) => Math.max(0, Math.trunc(r.requests))),
          rows.map((r) => Math.max(0, Math.trunc(r.inflight))),
          instanceId,
          sinceMs,
          freshSec,
        ],
        { statementTimeoutMs: timeoutMs },
      );
      return (res?.rows || []).map((r) => ({
        key: r.caller_key,
        windowMs: Number(r.window_ms),
        requests: Number(r.requests),
        inflight: Number(r.in_flight),
      }));
    },
    async prune({ beforeMs, timeoutMs }) {
      await db.queryWithStatementTimeout(PRUNE_SQL, [beforeMs], { statementTimeoutMs: timeoutMs });
    },
  };
}

// The same contract in memory: what several limiter instances in one test share in place of the table.
function createMemoryCallerLimitStore({ now = () => Date.now() } = {}) {
  const rows = new Map();
  return {
    kind: 'memory',
    rows,
    async sync({ instanceId, rows: incoming, sinceMs, freshSec }) {
      const t = now();
      for (const r of incoming) {
        const id = `${r.key}|${r.windowMs}|${instanceId}`;
        const prev = rows.get(id);
        rows.set(id, {
          key: r.key,
          windowMs: r.windowMs,
          instanceId,
          requests: Math.max(prev ? prev.requests : 0, r.requests),
          inflight: r.inflight,
          updatedAt: t,
        });
      }
      const keys = new Set(incoming.map((r) => r.key));
      const out = new Map();
      for (const row of rows.values()) {
        if (!keys.has(row.key) || row.windowMs < sinceMs || row.instanceId === instanceId) continue;
        const id = `${row.key}|${row.windowMs}`;
        const agg = out.get(id) || { key: row.key, windowMs: row.windowMs, requests: 0, inflight: 0 };
        agg.requests += row.requests;
        if (t - row.updatedAt <= freshSec * 1000) agg.inflight += row.inflight;
        out.set(id, agg);
      }
      return [...out.values()];
    },
    async prune({ beforeMs }) {
      for (const [id, row] of rows) if (row.windowMs < beforeMs) rows.delete(id);
    },
  };
}

// ---------------- the JSON-RPC refusal ----------------

function limitRejectionResponse(violation, { rpcId = null, tier } = {}) {
  const retryAfterSec = Math.max(1, Math.ceil(Number(violation.retryAfterSec) || 1));
  const perCaller = violation.reason === 'rate' || violation.reason === 'concurrency';
  let message;
  if (violation.reason === 'rate') {
    message = `Rate limit exceeded for this caller. Retry after ${retryAfterSec} seconds.`;
  } else if (violation.reason === 'concurrency') {
    message = `Too many concurrent requests from this caller. Retry after ${retryAfterSec} seconds.`;
  } else {
    message = `The service is busy and is shedding load. Retry after ${retryAfterSec} seconds.`;
  }
  return {
    status: violation.status || (perCaller ? 429 : 503),
    headers: { 'Retry-After': String(retryAfterSec) },
    body: {
      jsonrpc: '2.0',
      id: rpcId,
      error: {
        code: perCaller ? RPC_CODE_CALLER_LIMITED : RPC_CODE_SERVER_BUSY,
        message,
        data: { reason: violation.reason, retry_after_s: retryAfterSec, ...(tier ? { tier } : {}) },
      },
    },
  };
}

// ---------------- the process-wide limiter and the door hooks ----------------

let processLimiter = null;

// The pool's census WITHOUT creating the pool: no pool yet means no load to shed.
function defaultPoolStats() {
  try {
    const pool = require('../db').peekPool();
    if (!pool) return null;
    return {
      waiting: Number(pool.waitingCount) || 0,
      total: Number(pool.totalCount) || 0,
      idle: Number(pool.idleCount) || 0,
      max: Number(pool.options?.max) || 0,
    };
  } catch (_) {
    return null;
  }
}

function getProcessCallerLimiter() {
  if (!processLimiter) {
    const storeCfg = readStoreConfig();
    processLimiter = createCallerLimiter({
      store: storeCfg.kind === 'postgres' ? createPostgresCallerLimitStore() : null,
      poolStats: defaultPoolStats,
      log: require('../logger'),
    });
  }
  return processLimiter;
}

function resetProcessCallerLimiterForTest(opts = null) {
  if (processLimiter) processLimiter.stop();
  processLimiter = opts ? createCallerLimiter({ log: require('../logger'), ...opts }) : null;
  return processLimiter;
}

function isToolsCall(req) {
  const body = req && typeof req.body === 'object' && req.body !== null ? req.body : null;
  return Boolean(body) && body.method === 'tools/call';
}

// The client is gone: its socket closed or the response already ended. NOT req.destroyed — Node destroys a
// healthy request as soon as its body has been read.
function isClientGone(req, res) {
  return Boolean(res?.writableEnded || res?.destroyed || req?.socket?.destroyed);
}

/**
 * Resolve and remember the caller on req (req.mcpLimitCaller), with a fresh per-call id, so the door's
 * invoke context can carry it to the loopback calls. Cheap; no admission. A no-op when limits are off.
 */
function attachMcpLimitCaller(req) {
  try {
    if (callerLimitsMode() === 'off') return null;
    if (!req.mcpLimitCaller) req.mcpLimitCaller = { ...resolveDoorCaller(req), call_id: crypto.randomUUID() };
    return req.mcpLimitCaller;
  } catch (_) {
    return null;
  }
}

/** What the invoke context may carry: the hashed key and tier, never the address or the override id. */
function invokeContextLimitCaller(req) {
  const c = req?.mcpLimitCaller;
  if (!c) return null;
  return { tier: c.tier, key: c.key, agent_id: c.agent_id || null, call_id: c.call_id || null };
}

const PASS = Object.freeze({ release() {} });

/**
 * The door hook, called right before the tool dispatch. Returns one of:
 *   { refusal: { status, headers, body } }  answer with this instead (enforce);
 *   { gone: true }                          the client left while the request waited (enforce): do no work;
 *   { release }                             proceed, and call release() in a FINALLY around the dispatch.
 */
function admitMcpCallerLimit(req, res, { door } = {}) {
  try {
    const mode = callerLimitsMode();
    if (mode === 'off' || !isToolsCall(req)) return PASS;
    const caller = attachMcpLimitCaller(req);
    if (!caller) return PASS;
    if (isClientGone(req, res)) {
      // Observe changes nothing: the request runs as before, it just is not counted.
      return mode === 'enforce' ? { gone: true, release() {} } : PASS;
    }
    const decision = getProcessCallerLimiter().admit(caller, { door });
    if (!decision.allowed) {
      const rpcId = Object.prototype.hasOwnProperty.call(req.body, 'id') ? req.body.id : null;
      return { refusal: limitRejectionResponse(decision.violation, { rpcId, tier: caller.tier }), release() {} };
    }
    return { release: decision.release };
  } catch (_) {
    // A limiter fault must never take a door down: fail open, as the doors behaved before.
    return PASS;
  }
}

/** One line at boot: the mode, the store, and whether loopback tool calls can carry the caller at all. */
function logMcpCallerLimitsBootStatus({ selfInvokeBase, log = require('../logger'), env = process.env } = {}) {
  try {
    const mode = callerLimitsMode(env);
    const loopback = loopbackAssertionStatus(selfInvokeBase);
    const fields = {
      event: 'mcp_caller_limits_boot',
      mode,
      store: readStoreConfig(env).kind,
      loopback_assertion_active: mode !== 'off' && loopback.active,
      self_invoke_host_is_loopback: loopback.self_invoke_host_is_loopback,
    };
    if (mode !== 'off' && !loopback.active) {
      log.warn(fields, 'mcp caller limits: SELF_INVOKE_BASE is not loopback; tool calls keep the shared invoke key');
    } else {
      log.info(fields, 'mcp caller limits');
    }
    return fields;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ANON_TIER_KEY,
  OAUTH_UNREG_TIER_KEY,
  RPC_CODE_CALLER_LIMITED,
  RPC_CODE_SERVER_BUSY,
  SYNC_SQL,
  WINDOW_MS,
  admitMcpCallerLimit,
  anonymousIdForIp,
  attachMcpLimitCaller,
  createCallerLimiter,
  createMemoryCallerLimitStore,
  createPostgresCallerLimitStore,
  getProcessCallerLimiter,
  invokeContextLimitCaller,
  isClientGone,
  limitRejectionResponse,
  logMcpCallerLimitsBootStatus,
  logNetworkForIp,
  resetProcessCallerLimiterForTest,
  resolveDoorCaller,
};
