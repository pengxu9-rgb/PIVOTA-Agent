'use strict';

// PER-CALLER LIMITS AT THE MCP DOORS (/public/mcp, /mcp, /ucp/mcp).
//
// Why this exists. The doors had two gaps that let one caller degrade every other caller and the shared
// Postgres primary:
//   1. the public tier's limiter is in-memory PER INSTANCE, so its per-IP budget multiplies by however many
//      instances the service has scaled to;
//   2. the authenticated door had no per-caller limit at all, and every MCP tool's loopback invoke call
//      drew from the invoke limiter's bucket for the gateway's own service key (fixed separately by
//      src/guardrails/loopbackCallerAssertion.js).
// And neither door bounded how many slow requests one caller may hold IN FLIGHT, which is what actually
// loads the database: a caller well inside a request-rate budget can still pin the primary with slow
// searches running in parallel.
//
// What it does, per tools/call (the one MCP method that does real work; initialize / tools/list answer
// from memory and are not counted):
//   - resolves WHO is calling (resolveDoorCaller): a verified API key's agent (or key fingerprint), an MCP
//     OAuth client id, else the client IP by the gateway-wide client-IP rule. First-party callers are
//     never limited.
//   - checks, in this order, and stops at the first that fails:
//       shed            the DB pool is saturated: refuse the tiers configured to shed (anonymous first)
//       tier_concurrency anonymous requests in flight on THIS instance (protects this instance's pool)
//       concurrency      this caller's requests in flight, across instances
//       rate             this caller's requests per minute, across instances (sliding window)
//       tier_rate        all anonymous requests per minute, across instances (optional)
//   - in OBSERVE mode logs the decision it would have made (WARN) and admits; in ENFORCE mode refuses with
//     a JSON-RPC error and Retry-After (never a 200 with empty results).
//
// GLOBAL across instances without a per-request write. The only shared store this service has is the
// Postgres primary it is protecting, so the hot path never touches it: every decision reads local
// counters plus the last snapshot of the other instances' counters. A background sync (one statement per
// instance every MCP_CALLER_LIMITS_SYNC_MS, default 2 s, and only while this instance has active callers)
// writes this instance's absolute counts for its busiest keys into an UNLOGGED table and reads back the
// other instances' totals for the same keys. Each instance writes only its own rows, so instances never
// contend on a row lock. The price is approximation: a caller can overshoot a global budget by roughly
// what the instances admit between two syncs. When the store is unreachable, missing, or the pool is
// already saturated, the sync is skipped and limits fall back to per-instance accounting — the protection
// the doors had before, never less.

const crypto = require('crypto');
const { clientIpFromRequest } = require('./gatewayGuardrails');
const { readCallerLimitsConfig, readStoreConfig, callerLimitsMode } = require('./mcpCallerLimitsConfig');

const WINDOW_MS = 60_000;
const ANON_TIER_KEY = 'tier:anonymous';
const MAX_LOCAL_KEYS = 50_000;
const STORE_DISABLE_MS = 10 * 60 * 1000;
const STORE_WARN_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
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

function makeCaller(tier, id, { agentId = null, oauthClientId = null } = {}) {
  return {
    tier,
    // The id the operator names in MCP_CALLER_LIMITS_OVERRIDES_JSON. Never logged for anonymous callers
    // (it carries the client address); `key` is the hashed form used everywhere else.
    id,
    key: `${tier}:${sha16(id)}`,
    agent_id: agentId,
    oauth_client_id: oauthClientId,
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
    if (clientId) return makeCaller('partner', `oauth:${clientId}`, { oauthClientId: clientId });
  }
  const ip = clientIpFromRequest(req);
  return makeCaller('anonymous', `ip:${ip || 'unknown'}`);
}

function policyFor(caller, cfg) {
  const base = caller.tier === 'partner' ? cfg.partner : cfg.anonymous;
  const override = cfg.overrides.get(caller.id) || {};
  return {
    rpm: Number.isFinite(override.rpm) ? override.rpm : base.rpm,
    concurrency: Number.isFinite(override.concurrency) ? override.concurrency : base.concurrency,
  };
}

function clampSec(n, min, max) {
  const v = Math.ceil(Number(n) || 0);
  return Math.min(Math.max(v, min), max);
}

/**
 * @param {object} opts
 * @param {object} [opts.store] shared counter store ({ sync, prune }); null = per-instance only.
 * @param {() => ({waiting:number}|null)} [opts.poolStats] the DB pool's current census.
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
  // key -> { byWin: Map(windowStartMs -> requests), inflight }: the OTHER instances, as of the last sync.
  let snapshot = { at: 0, others: new Map() };
  let syncing = null;
  let timer = null;
  let lastPruneAt = 0;
  const storeHealth = { disabledUntil: 0, lastWarnAt: 0, lastOkAt: 0 };

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
      if (!entry.inflight && key !== ANON_TIER_KEY) local.delete(key);
    }
  }

  function snapshotFresh(t) {
    return t - snapshot.at <= 3 * storeConfig().syncIntervalMs;
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
    if (caller.tier === 'anonymous' && cfg.anonymousTier.concurrencyPerInstance > 0) {
      const entry = local.get(ANON_TIER_KEY);
      const inflight = entry ? entry.inflight : 0;
      if (inflight >= cfg.anonymousTier.concurrencyPerInstance) {
        return {
          reason: 'tier_concurrency',
          status: 503,
          limit: cfg.anonymousTier.concurrencyPerInstance,
          observed: inflight,
          retryAfterSec: cfg.shed.retryAfterSec,
        };
      }
    }
    if (policy.concurrency > 0) {
      const inflight = inflightOf(caller.key, t);
      if (inflight >= policy.concurrency) {
        return {
          reason: 'concurrency',
          status: 429,
          limit: policy.concurrency,
          observed: inflight,
          retryAfterSec: CONCURRENCY_RETRY_AFTER_SEC,
        };
      }
    }
    if (policy.rpm > 0) {
      const est = rateOf(caller.key, t);
      if (est.value + 1 > policy.rpm) {
        return {
          reason: 'rate',
          status: 429,
          limit: policy.rpm,
          observed: Math.round(est.value * 100) / 100,
          retryAfterSec: rateRetryAfterSec(est, policy.rpm),
        };
      }
    }
    if (caller.tier === 'anonymous' && cfg.anonymousTier.rpm > 0) {
      const est = rateOf(ANON_TIER_KEY, t);
      if (est.value + 1 > cfg.anonymousTier.rpm) {
        return {
          reason: 'tier_rate',
          status: 503,
          limit: cfg.anonymousTier.rpm,
          observed: Math.round(est.value * 100) / 100,
          retryAfterSec: rateRetryAfterSec(est, cfg.anonymousTier.rpm),
        };
      }
    }
    return null;
  }

  function logDecision({ mode, violation, caller, door }) {
    try {
      log?.warn?.(
        {
          event: 'mcp_caller_limit',
          action: mode === 'enforce' ? 'reject' : 'would_reject',
          mode,
          reason: violation.reason,
          door: door || null,
          tier: caller.tier,
          caller_key: caller.key,
          ...(caller.agent_id ? { caller_agent_id: caller.agent_id } : {}),
          ...(caller.oauth_client_id ? { caller_oauth_client_id: caller.oauth_client_id } : {}),
          limit: violation.limit,
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

  const NOOP = Object.freeze({ allowed: true, violation: null, release() {} });

  /**
   * Decide one tools/call. Returns { allowed, violation, release }. `release` MUST be called exactly once
   * when the request finishes (it is idempotent). In observe mode `allowed` is always true and `violation`
   * says what enforce would have done.
   */
  function admit(caller, { door } = {}) {
    const cfg = readCallerLimitsConfig(env);
    if (cfg.mode === 'off' || !caller || caller.tier === 'first_party') return NOOP;
    const t = now();
    ensureSyncTimer();
    const violation = firstViolation(caller, policyFor(caller, cfg), cfg, t);
    if (violation) {
      logDecision({ mode: cfg.mode, violation, caller, door });
      if (cfg.mode === 'enforce') return { allowed: false, violation, release() {} };
    }
    const win = windowOf(t);
    const entry = localEntry(caller.key, win);
    entry.cur += 1;
    entry.inflight += 1;
    const tierEntry = caller.tier === 'anonymous' ? localEntry(ANON_TIER_KEY, win) : null;
    if (tierEntry) {
      tierEntry.cur += 1;
      tierEntry.inflight += 1;
    }
    let released = false;
    return {
      allowed: true,
      violation,
      release() {
        if (released) return;
        released = true;
        entry.inflight = Math.max(0, entry.inflight - 1);
        if (tierEntry) tierEntry.inflight = Math.max(0, tierEntry.inflight - 1);
      },
    };
  }

  function warnStore(err, extra = {}) {
    const t = now();
    if (t - storeHealth.lastWarnAt < STORE_WARN_INTERVAL_MS) return;
    storeHealth.lastWarnAt = t;
    try {
      log?.warn?.(
        { event: 'mcp_caller_limit_store', err: err?.message || String(err), code: err?.code || null, ...extra },
        'mcp caller limit store sync failed; limits are per-instance until it recovers',
      );
    } catch (_) {
      // ignore
    }
  }

  /** One sync round. Resolves true when a fresh snapshot was taken. Never rejects. */
  function syncNow() {
    if (!store) return Promise.resolve(false);
    if (syncing) return syncing;
    syncing = (async () => {
      const t = now();
      if (t < storeHealth.disabledUntil) return false;
      // Never queue behind real work: when the pool already has waiters, the sync would only add to them.
      let stats = null;
      try {
        stats = poolStats();
      } catch (_) {
        stats = null;
      }
      if (Number(stats?.waiting) > 0) return false;
      const cfg = storeConfig();
      const win = windowOf(t);
      const active = [];
      for (const [key, entry] of local) {
        roll(entry, win);
        if (entry.cur || entry.prev || entry.inflight) active.push([key, entry]);
      }
      if (!active.length) return false;
      active.sort((a, b) => (b[1].cur + b[1].inflight * 10) - (a[1].cur + a[1].inflight * 10));
      const rows = [];
      for (const [key, entry] of active.slice(0, cfg.maxSyncKeys)) {
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
      snapshot = { at: now(), others: next };
      storeHealth.lastOkAt = snapshot.at;
      if (typeof store.prune === 'function' && snapshot.at - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = snapshot.at;
        store.prune({ beforeMs: win - 2 * WINDOW_MS, timeoutMs: cfg.syncTimeoutMs }).catch((err) => warnStore(err, { op: 'prune' }));
      }
      return true;
    })()
      .catch((err) => {
        // The table is not there (migration not applied yet): stop asking for a while instead of failing
        // every couple of seconds.
        if (err?.code === '42P01') storeHealth.disabledUntil = now() + STORE_DISABLE_MS;
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
    };
  }

  return { admit, syncNow, stop, inspect, instanceId, ANON_TIER_KEY };
}

// ---------------- shared stores ----------------

// One round trip: upsert this instance's absolute counts (GREATEST, so a late or repeated sync can never
// lower or double-count a window), then read the OTHER instances' totals for the same keys. The read runs
// on the statement's snapshot, which never includes rows written by the same statement — and own rows are
// excluded anyway, because this instance already counts its own requests locally.
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
      const res = await db.queryWithBudget(
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
        { timeoutMs },
      );
      return (res?.rows || []).map((r) => ({
        key: r.caller_key,
        windowMs: Number(r.window_ms),
        requests: Number(r.requests),
        inflight: Number(r.in_flight),
      }));
    },
    async prune({ beforeMs, timeoutMs }) {
      await db.queryWithBudget(PRUNE_SQL, [beforeMs], { timeoutMs });
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

// ---------------- the process-wide limiter and the door hook ----------------

let processLimiter = null;

function defaultPoolStats() {
  try {
    const pool = require('../db').getPool();
    if (!pool) return null;
    return { waiting: Number(pool.waitingCount) || 0, total: Number(pool.totalCount) || 0, idle: Number(pool.idleCount) || 0 };
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

/**
 * Resolve and remember the caller on req (req.mcpLimitCaller), so the door's invoke context can carry it
 * to the loopback calls. Cheap; no admission. A no-op when limits are off.
 */
function attachMcpLimitCaller(req) {
  try {
    if (callerLimitsMode() === 'off') return null;
    if (!req.mcpLimitCaller) req.mcpLimitCaller = resolveDoorCaller(req);
    return req.mcpLimitCaller;
  } catch (_) {
    return null;
  }
}

/**
 * The door hook. Returns null to proceed, or { status, headers, body } to answer with instead. Admission
 * is released when the response finishes or the connection closes, whichever comes first.
 */
function applyMcpCallerLimit(req, res, { door } = {}) {
  try {
    if (callerLimitsMode() === 'off' || !isToolsCall(req)) return null;
    const caller = attachMcpLimitCaller(req);
    if (!caller) return null;
    const decision = getProcessCallerLimiter().admit(caller, { door });
    if (!decision.allowed) {
      const rpcId = Object.prototype.hasOwnProperty.call(req.body, 'id') ? req.body.id : null;
      return limitRejectionResponse(decision.violation, { rpcId, tier: caller.tier });
    }
    if (res && typeof res.once === 'function') {
      res.once('finish', decision.release);
      res.once('close', decision.release);
    } else {
      decision.release();
    }
    return null;
  } catch (_) {
    // A limiter fault must never take a door down: fail open, as the doors behaved before.
    return null;
  }
}

module.exports = {
  ANON_TIER_KEY,
  RPC_CODE_CALLER_LIMITED,
  RPC_CODE_SERVER_BUSY,
  SYNC_SQL,
  WINDOW_MS,
  applyMcpCallerLimit,
  attachMcpLimitCaller,
  createCallerLimiter,
  createMemoryCallerLimitStore,
  createPostgresCallerLimitStore,
  getProcessCallerLimiter,
  limitRejectionResponse,
  resetProcessCallerLimiterForTest,
  resolveDoorCaller,
};
