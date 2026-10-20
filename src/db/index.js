const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../logger');

let pool = null;
let poolCtor = null;
let poolCtorResolved = false;
let poolResetState = { pool: null, promise: null };

const TRANSIENT_DB_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  '57P01',
  '57P02',
  '57P03',
]);

function parseIntegerEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function getDbQueryRetries() {
  return parseIntegerEnv(process.env.DB_QUERY_RETRIES, 1, { min: 0, max: 3 });
}

function getDbConnectRetries() {
  return parseIntegerEnv(process.env.DB_CONNECT_RETRIES, 1, { min: 0, max: 3 });
}

function getDbRetryBackoffMs() {
  return parseIntegerEnv(process.env.DB_QUERY_RETRY_BACKOFF_MS, 75, { min: 0, max: 2000 });
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(err) {
  const code = String(err?.code || '').trim().toUpperCase();
  const message = String(err?.message || err || '').toLowerCase();
  if (!code && !message) return false;
  if (TRANSIENT_DB_ERROR_CODES.has(code)) return true;
  if (code.startsWith('08')) return true;
  return (
    message.includes('econnreset') ||
    message.includes('connection reset') ||
    message.includes('connection terminated unexpectedly') ||
    message.includes('server closed the connection unexpectedly') ||
    message.includes('socket hang up') ||
    message.includes('terminating connection due to administrator command') ||
    message.includes('client has encountered a connection error') ||
    message.includes('connection terminated')
  );
}

// pg-pool's and pg's own timeouts carry no SQLSTATE, only these messages.
const DB_UNAVAILABLE_MESSAGES = [
  /^timeout exceeded when trying to connect$/i,
  /^Connection terminated due to connection timeout$/i,
  /^Query read timeout$/i,
];

// "The database could not answer in time / at all", as opposed to "the database
// answered and the answer is no". A caller that turns a failed lookup into a
// negative answer (null -> not found, row dropped) must not do it for these:
// a pool that is momentarily full says nothing about whether a row exists.
function isDbUnavailableError(err) {
  if (!err) return false;
  const code = String(err?.code || '').trim().toUpperCase();
  if (code === DB_BUDGET_ACQUIRE_TIMEOUT || code === DB_BUDGET_QUERY_TIMEOUT) return true;
  // query_canceled (statement_timeout), too_many_connections, cannot_connect_now.
  if (code === '57014' || code === '53300' || code === '57P03') return true;
  if (isTransientDbError(err)) return true;
  const message = String(err?.message || '').trim();
  return DB_UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(message));
}

function buildNoDatabaseError() {
  const err = new Error('DATABASE_URL not configured or pg driver unavailable');
  err.code = 'NO_DATABASE';
  return err;
}

async function resetPool(sourcePool, reason, err) {
  const existingPool = sourcePool || pool;
  if (!existingPool) return;
  if (pool === existingPool) pool = null;
  if (poolResetState.pool === existingPool && poolResetState.promise) {
    await poolResetState.promise;
    return;
  }
  const resetPromise = (async () => {
    try {
      if (typeof existingPool.end === 'function') {
        await existingPool.end();
      }
    } catch (endErr) {
      logger.warn(
        {
          reason,
          err: endErr?.message || String(endErr),
          original_err: err?.message || null,
        },
        'Failed to close Postgres pool after transient error',
      );
    } finally {
      if (poolResetState.pool === existingPool) {
        poolResetState = { pool: null, promise: null };
      }
    }
  })();
  poolResetState = { pool: existingPool, promise: resetPromise };
  await resetPromise;
}

function getPoolConstructor() {
  if (poolCtorResolved) return poolCtor;
  poolCtorResolved = true;
  try {
    // Load lazily so local/unit environments without `pg` can still run non-DB paths.
    const mod = require('pg');
    poolCtor = mod && typeof mod.Pool === 'function' ? mod.Pool : null;
  } catch (_err) {
    poolCtor = null;
  }
  return poolCtor;
}

function shouldUseSsl(databaseUrl) {
  if (process.env.DB_SSL === 'true') return true;
  const url = String(databaseUrl || '');
  return (
    /[?&]sslmode=(require|verify-full|verify-ca)\b/i.test(url) ||
    /[?&]ssl=true\b/i.test(url)
  );
}

// Server-side reaping of statements whose client has gone away.
//
// When a budgeted caller gives up, queryWithBudget DESTROYS the connection so
// the pool slot comes back at once. That frees the client, not the server: a
// backend busy executing does not read its socket, so the statement keeps
// burning primary CPU until it finishes or `statement_timeout` (30s) fires --
// orphaned work behind a caller whose budget was a few seconds.
// `client_connection_check_interval` (PostgreSQL 14+, user-settable) makes the
// backend poll its socket while it executes and cancel the statement once the
// client has hung up. Sent in the startup packet like statement_timeout, so it
// costs zero round-trips. Unset/0 keeps today's behaviour. A DATABASE_URL that
// carries its own `options=` wins over this (pg merges the URL last).
function getClientConnectionCheckIntervalMs() {
  return parseIntegerEnv(process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS, 0, { min: 0, max: 60_000 });
}

function buildConnectionStartupOptions() {
  const intervalMs = getClientConnectionCheckIntervalMs();
  if (!(intervalMs > 0)) return {};
  return { options: `-c client_connection_check_interval=${intervalMs}` };
}

function getPool() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const Pool = getPoolConstructor();
  if (!Pool) return null;
  if (!pool) {
    const useSsl = shouldUseSsl(databaseUrl);
    const nextPool = new Pool({
      connectionString: databaseUrl,
      // A single chat turn fans out several recall queries in parallel (the
      // beauty lane runs primary + support roles per round), so a pool smaller
      // than that fan-out starves by construction: one query answers and the
      // rest sit in the checkout queue until their budget expires. That is what
      // emptied the acne recall on 2026-09-08, against a pool of 2.
      //
      // Sizing is bounded by Cloud SQL `max_connections` (300 on pivota-pg)
      // across every service, so raising this is a budget decision, not a free
      // one: worst case is `max` x the service's max instance count.
      max: Number(process.env.DB_POOL_MAX || 12),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 10000),
      // Backstop so NO query in this process can hang forever.
      //
      // 2026-07-25: three sitemap PDPs returned zero bytes and no status,
      // indefinitely, because `query()` is `Pool.query` — which had neither a
      // server-side nor a client-side deadline. A single pathological plan
      // pinned one of only `max` (default 5) connections until the TCP session
      // died, and the awaiting request never produced a response at all.
      //
      // Both are set here rather than per-query on purpose: node-postgres sends
      // them with the connection, so they cost ZERO extra round-trips. The
      // per-query alternative (`queryWithStatementTimeout`) wraps each call in
      // BEGIN / SET LOCAL / COMMIT — three extra round-trips on a hot read path
      // whose app and database sit in different regions.
      //
      // Deliberately generous: these exist to kill true pathologies, not to
      // enforce latency budgets. Per-request budgets belong at the call site
      // (see `withStageBudget`). `query_timeout` is set ABOVE
      // `statement_timeout` so the server-side cancel normally wins and the
      // connection stays reusable; the client-side one only fires if the socket
      // itself is wedged.
      statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30000),
      query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS || 35000),
      // Off unless DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS is set; see
      // buildConnectionStartupOptions.
      ...buildConnectionStartupOptions(),
      ssl:
        useSsl
          ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : undefined,
    });
    if (typeof nextPool.on === 'function') {
      // Connection age is a diagnostic we cannot reconstruct later: pg exposes no
      // birth time, and "was this socket fresh or hours old?" is exactly what
      // separates a stale-connection stall from a slow statement.
      nextPool.on('connect', (client) => {
        try {
          client.__pivotaConnectedAtMs = Date.now();
        } catch {
          // a frozen/mock client is not worth failing a connection over
        }
      });
      nextPool.on('error', (err) => {
        logger.warn(
          { err: err?.message || String(err), code: err?.code || null },
          'Postgres pool emitted client error; resetting pool',
        );
        resetPool(nextPool, 'pool_error', err).catch((resetErr) => {
          logger.warn(
            { err: resetErr?.message || String(resetErr) },
            'Failed to reset Postgres pool after client error',
          );
        });
      });
    }
    pool = nextPool;
  }
  return pool;
}

async function queryPooled(text, params) {
  const maxRetries = getDbQueryRetries();
  const backoffMs = getDbRetryBackoffMs();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const p = getPool();
    if (!p) throw buildNoDatabaseError();
    try {
      return await p.query(text, params);
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= maxRetries) {
        throw err;
      }
      logger.warn(
        {
          err: err?.message || String(err),
          code: err?.code || null,
          attempt: attempt + 1,
          max_retries: maxRetries,
        },
        'Transient DB query failed; resetting pool and retrying',
      );
      await resetPool(p, 'query_retry', err);
      await sleep(backoffMs);
    }
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Lane deadlines: bound every plain `query()` issued inside a caller's budget.
//
// The interactive lanes (signature resolve, PDP prechecks, recall) wrap their
// work in a wall-clock stage budget, but the statements underneath go through
// plain `query()` = `pool.query`, which has no idea a budget exists. When the
// budget fires the caller moves on and the statement does not: it keeps its
// pooled connection until it ends or the 30s pool-level statement_timeout
// fires. With a handful of connections per instance, a few of those pin the
// whole pool, and every later checkout on the instance -- including lanes that
// were fast -- queues until pg-pool's connect timeout. That is the shape of the
// "timeout exceeded when trying to connect" bursts that follow
// first-paint-budget misses on an otherwise idle database.
//
// runWithDbDeadline(options, fn) runs fn inside an AsyncLocalStorage context
// that carries an absolute deadline. While it is active, `query()` routes
// through queryWithBudget with whatever budget remains, so a checkout never
// waits past the caller, a late checkout is handed straight back, and a
// statement still running at the deadline has its connection destroyed (and,
// with DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS, cancelled server-side). Nested
// deadlines take the earlier of the two. Zero extra round-trips: the routed
// path is the same checkout + query + release that pool.query does.
//
// The deadline sits a small grace (DB_LANE_DEADLINE_GRACE_MS) AFTER the stage
// budget, so the caller's own STAGE_TIMEOUT still wins the race and the error a
// caller sees is unchanged; the deadline only stops the work it left behind.
//
// Off unless DB_LANE_DEADLINES_ENABLED is set: with it off, runWithDbDeadline
// is a plain call and query() behaves exactly as before.
// ---------------------------------------------------------------------------
const DB_DEADLINE_CONTEXT = new AsyncLocalStorage();

function isDbLaneDeadlinesRequested() {
  return /^(1|true|yes|on)$/i.test(String(process.env.DB_LANE_DEADLINES_ENABLED || '').trim());
}

// Why the requested deadlines cannot be honoured, or null when they can.
//
// A lane deadline DESTROYS the connection of a statement still running at the deadline. Without
// client_connection_check_interval the server never notices: the backend keeps executing until
// statement_timeout while the pool opens a replacement, so per-instance SERVER connections climb past
// DB_POOL_MAX -- the pinned pool becomes orphan backends plus fresh connections, which is worse for the
// primary than what the deadline was meant to fix. So the deadlines are refused unless the interval is
// actually in the startup packet. pg merges DATABASE_URL's own `options=` over the config, so a URL that
// carries options without the interval silently drops it; that refuses too.
function laneDeadlinesBlockedReason() {
  if (!(getClientConnectionCheckIntervalMs() > 0)) return 'client_connection_check_interval_unset';
  let urlOptions = null;
  try {
    urlOptions = new URL(String(process.env.DATABASE_URL || '')).searchParams.get('options');
  } catch {
    urlOptions = null;
  }
  if (urlOptions !== null && !/client_connection_check_interval/.test(urlOptions)) {
    return 'database_url_options_override_check_interval';
  }
  return null;
}

let laneDeadlinesRefusalWarned = false;
function isDbLaneDeadlinesEnabled() {
  if (!isDbLaneDeadlinesRequested()) return false;
  const blocked = laneDeadlinesBlockedReason();
  if (!blocked) return true;
  if (!laneDeadlinesRefusalWarned) {
    laneDeadlinesRefusalWarned = true;
    logger.warn(
      { reason: blocked, db_lane_deadlines_enabled: process.env.DB_LANE_DEADLINES_ENABLED },
      'DB_LANE_DEADLINES_ENABLED is set but lane deadlines are REFUSED: they need DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS > 0 '
        + 'in the startup packet, or abandoned statements become orphan backends plus new connections',
    );
  }
  return false;
}

function getDbLaneDeadlineGraceMs() {
  return parseIntegerEnv(process.env.DB_LANE_DEADLINE_GRACE_MS, 100, { min: 0, max: 5_000 });
}

function runWithDbDeadline(options, fn) {
  const budgetMs = Number(options?.budgetMs);
  if (!isDbLaneDeadlinesEnabled() || !Number.isFinite(budgetMs) || budgetMs <= 0) return fn();
  let deadlineAtMs = Date.now() + Math.trunc(budgetMs) + getDbLaneDeadlineGraceMs();
  const outer = DB_DEADLINE_CONTEXT.getStore();
  if (outer && Number.isFinite(outer.deadlineAtMs)) {
    deadlineAtMs = Math.min(deadlineAtMs, outer.deadlineAtMs);
  }
  const label = String(options?.label || outer?.label || '').trim() || null;
  return DB_DEADLINE_CONTEXT.run({ deadlineAtMs, label }, fn);
}

// Remaining ms of the active lane deadline, or null when no deadline applies.
function remainingDbDeadlineMs() {
  const store = DB_DEADLINE_CONTEXT.getStore();
  if (!store || !Number.isFinite(store.deadlineAtMs)) return null;
  return store.deadlineAtMs - Date.now();
}

function buildDeadlineExpiredError() {
  const store = DB_DEADLINE_CONTEXT.getStore();
  // Same code as a budgeted checkout that ran out of time: the caller's budget
  // was spent before this statement could even be queued. Nothing touched the
  // pool, which is the point -- an abandoned caller must not take a slot.
  const err = buildBudgetTimeoutError(DB_BUDGET_ACQUIRE_TIMEOUT, { budgetMs: 0, waitedMs: 0 });
  err.lane = store?.label || null;
  return err;
}

async function query(text, params) {
  if (remainingDbDeadlineMs() === null) return queryPooled(text, params);
  // queryWithBudget takes its budget from the active lane deadline.
  return queryWithBudget(text, params, {});
}

function normalizeLocalTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.min(60_000, Math.trunc(parsed)));
}

const DB_BUDGET_ACQUIRE_TIMEOUT = 'DB_BUDGET_ACQUIRE_TIMEOUT';
const DB_BUDGET_QUERY_TIMEOUT = 'DB_BUDGET_QUERY_TIMEOUT';

function buildBudgetTimeoutError(code, { budgetMs, waitedMs }) {
  const err = new Error(
    code === DB_BUDGET_ACQUIRE_TIMEOUT
      ? `Timed out after ${waitedMs}ms waiting for a pooled connection (budget ${budgetMs}ms)`
      : `Query exceeded its ${budgetMs}ms budget after ${waitedMs}ms`,
  );
  err.code = code;
  err.budget_ms = budgetMs;
  err.waited_ms = waitedMs;
  return err;
}

// Event-loop lag, sampled across the WHOLE call rather than once at the deadline.
//
// The point sample `timer_lag_ms` only exists when a deadline fires, and it can
// read near zero for a 300ms block that ended before the deadline came due — so
// on its own it neither covers the fast path nor rules a stall out. This watches
// the interval instead: a timer that should fire every `intervalMs` and comes
// back late by N was a loop that could not run for N, which is also a loop that
// could not drain a socket for N.
function startEventLoopLagProbe(intervalMs = 100) {
  let maxLagMs = 0;
  let lastFiredAtMs = Date.now();
  let timer = null;
  try {
    timer = setInterval(() => {
      const now = Date.now();
      const lagMs = Math.max(0, now - lastFiredAtMs - intervalMs);
      if (lagMs > maxLagMs) maxLagMs = lagMs;
      lastFiredAtMs = now;
    }, intervalMs);
    // Never hold the process open for a diagnostic.
    if (typeof timer.unref === 'function') timer.unref();
  } catch {
    timer = null;
  }
  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Count the tail too: a block still running when the call ends would
      // otherwise never be sampled.
      const tailLagMs = Math.max(0, Date.now() - lastFiredAtMs - intervalMs);
      return Math.max(maxLagMs, tailLagMs);
    },
  };
}

function raceAgainstBudget(promise, timeoutMs, code, { budgetMs, startedAt, diagnostics = null }) {
  let timer = null;
  const scheduledFireAtMs = Date.now() + timeoutMs;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // How late this timer fired is a direct read on event-loop health: a timer
      // cannot run while the loop is blocked, so a large lag means the process
      // was busy and could not drain its sockets either. A lag near zero says the
      // loop was free and the wait was genuinely out in the network or the server.
      const lagMs = Math.max(0, Date.now() - scheduledFireAtMs);
      if (diagnostics) diagnostics.timer_lag_ms = lagMs;
      const err = buildBudgetTimeoutError(code, {
        budgetMs,
        waitedMs: Math.max(0, Date.now() - startedAt),
      });
      err.timer_lag_ms = lagMs;
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// A pool-safe `query` for callers that hold a wall-clock budget (a request
// deadline, a recall stage) and would otherwise abandon the promise when it
// expires.
//
// Abandoning `pool.query` is what starves the pool, in two ways that both
// outlive the caller:
//
//   1. A checkout that has not been granted yet CANNOT be cancelled — pg hands
//      you the client whenever one frees up, and then runs the query. Dropping
//      the promise does not withdraw you from the queue; it just means nobody
//      releases what you are eventually given.
//   2. A statement already in flight keeps its connection until it finishes or
//      `statement_timeout` (30s) fires — an eternity behind a caller whose own
//      budget was 5s.
//
// Both were live on the aurora beauty recall lane (2026-09-08): three parallel
// seed queries per round against a pool of 2, where one returned in ~60ms and
// the rest were cut at the identical millisecond, never having run at all.
//
// So: bound the checkout, hand back the slot the instant a late checkout lands,
// and destroy — not release — a connection whose statement is still running.
// The distinct error codes matter as much as the fix; `pool starvation` and
// `slow query` need different remedies and used to look identical from outside.
async function queryWithBudget(text, params, options = {}) {
  let budgetMs = normalizeLocalTimeoutMs(options.timeoutMs);
  // An explicit budget inside a lane deadline gets the earlier of the two.
  const laneRemainingMs = remainingDbDeadlineMs();
  if (laneRemainingMs !== null) {
    if (laneRemainingMs < 1) throw buildDeadlineExpiredError();
    budgetMs = Math.min(budgetMs || Infinity, normalizeLocalTimeoutMs(laneRemainingMs));
  }
  if (!budgetMs) return queryPooled(text, params);

  const p = getPool();
  if (!p) throw buildNoDatabaseError();

  // Callers may hand in an object to be filled with what this call actually did.
  // Split timings and pool census are the difference between "the pool is full",
  // "the loop was blocked" and "the server or the wire was slow" — from outside
  // they produce the same symptom, a caller that waited and gave up.
  const diagnostics = options.diagnostics && typeof options.diagnostics === 'object'
    ? options.diagnostics
    : null;
  // Three MOMENTS, each under its own name, never overwritten. `_at_request` is
  // the pressure we queued into, `_at_acquire` is what it looked like once we
  // were served, `_at_failure` is what it looked like when we gave up.
  //
  // Re-capturing a failure-time census under the `_at_acquire` name is worse than
  // not capturing it: a stage served instantly into an idle pool that dies 1.6s
  // later would report `pool_waiting_at_acquire: 9`, and an on-call reads that as
  // pool starvation and raises DB_POOL_MAX -- chasing the one cause #2148 already
  // removed.
  const capturePoolCensus = (suffix) => {
    if (!diagnostics) return;
    if (Number.isFinite(Number(p.totalCount))) diagnostics[`pool_total_at_${suffix}`] = Number(p.totalCount);
    if (Number.isFinite(Number(p.idleCount))) diagnostics[`pool_idle_at_${suffix}`] = Number(p.idleCount);
    if (Number.isFinite(Number(p.waitingCount))) diagnostics[`pool_waiting_at_${suffix}`] = Number(p.waitingCount);
  };
  const lagProbe = diagnostics ? startEventLoopLagProbe() : null;
  const finishLagProbe = () => {
    if (!lagProbe || !diagnostics) return;
    diagnostics.event_loop_lag_ms = lagProbe.stop();
  };
  if (diagnostics) diagnostics.budget_ms = budgetMs;
  capturePoolCensus('request');

  const startedAt = Date.now();
  let acquire = null;
  let client = null;
  try {
    // Inside the try: the probe is already running, and a synchronous throw from
    // `connect` would otherwise leak its interval.
    acquire = p.connect();
    client = await raceAgainstBudget(acquire, budgetMs, DB_BUDGET_ACQUIRE_TIMEOUT, {
      budgetMs,
      startedAt,
      diagnostics,
    });
  } catch (err) {
    if (diagnostics) diagnostics.acquire_ms = Math.max(0, Date.now() - startedAt);
    capturePoolCensus('failure');
    finishLagProbe();
    if (diagnostics) err.diagnostics = { ...diagnostics };
    if (err?.code === DB_BUDGET_ACQUIRE_TIMEOUT) {
      // We are still in pg's checkout queue and cannot leave it. Give the slot
      // straight back to the next waiter rather than spending it on a query
      // whose result nobody is awaiting.
      acquire?.then?.(
        (lateClient) => {
          try {
            lateClient.release();
          } catch {
            // pool already torn down; nothing to hand back
          }
        },
        () => {},
      );
    }
    throw err;
  }

  const acquiredAt = Date.now();
  if (diagnostics) {
    diagnostics.acquire_ms = Math.max(0, acquiredAt - startedAt);
    const connectedAtMs = Number(client?.__pivotaConnectedAtMs);
    if (Number.isFinite(connectedAtMs)) {
      diagnostics.conn_age_ms = Math.max(0, acquiredAt - connectedAtMs);
    }
    // pg-pool only sets `_poolUseCount` in `_release`, so a connection's FIRST
    // use has none. Dropping the field there loses exactly the case that
    // distinguishes a brand-new socket from a reused one.
    diagnostics.conn_use_count = Number.isFinite(Number(client?._poolUseCount))
      ? Number(client._poolUseCount)
      : 0;
    capturePoolCensus('acquire');
  }

  const remainingMs = budgetMs - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    try {
      client.release();
    } catch {
      // ignore release failures
    }
    finishLagProbe();
    throw buildBudgetTimeoutError(DB_BUDGET_QUERY_TIMEOUT, {
      budgetMs,
      waitedMs: Math.max(0, Date.now() - startedAt),
    });
  }

  let queryPromise = null;
  let destroyed = false;
  try {
    // Inside the try: `client.query` can throw synchronously (a malformed
    // query), and that path must still hand the connection back.
    queryPromise = client.query(text, params);
    const result = await raceAgainstBudget(
      queryPromise,
      remainingMs,
      DB_BUDGET_QUERY_TIMEOUT,
      { budgetMs, startedAt, diagnostics },
    );
    if (diagnostics) {
      diagnostics.query_ms = Math.max(0, Date.now() - acquiredAt);
      finishLagProbe();
    }
    return result;
  } catch (err) {
    if (diagnostics) {
      diagnostics.query_ms = Math.max(0, Date.now() - acquiredAt);
      capturePoolCensus('failure');
      finishLagProbe();
      err.diagnostics = { ...diagnostics };
    }
    const budgetExpired = err?.code === DB_BUDGET_QUERY_TIMEOUT;
    if (queryPromise && (budgetExpired || isTransientDbError(err))) {
      // The statement is still running server-side. Returning this connection
      // to the pool would hand the next caller a client that cannot answer
      // until `statement_timeout`; destroying it frees the slot now.
      // `release(true)` attaches pg-pool's own error listener before tearing
      // the client down, so the doomed statement cannot raise an unhandled
      // 'error' event on the way out. Deliberately NOT `resetPool`: one slow
      // statement says nothing about the other connections, and tearing the
      // whole pool down from a budgeted read path would turn a blip into an
      // outage.
      queryPromise.catch(() => {});
      destroyed = true;
      try {
        client.release(true);
      } catch {
        // ignore release failures on broken clients
      }
    }
    throw err;
  } finally {
    if (!destroyed) {
      try {
        client.release();
      } catch {
        // ignore release failures
      }
    }
  }
}

async function queryWithStatementTimeout(text, params, options = {}) {
  const statementTimeoutMs = normalizeLocalTimeoutMs(options.statementTimeoutMs);
  const lockTimeoutMs = normalizeLocalTimeoutMs(options.lockTimeoutMs);
  if (!statementTimeoutMs && !lockTimeoutMs) {
    return query(text, params);
  }

  return withClient(async (client) => {
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      if (statementTimeoutMs) {
        await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      }
      if (lockTimeoutMs) {
        await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
      }
      const result = await client.query(text, params);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (err) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          logger.warn(
            {
              err: rollbackErr?.message || String(rollbackErr),
              original_err: err?.message || String(err),
            },
            'Failed to rollback statement-timeout query transaction',
          );
        }
      }
      throw err;
    }
  });
}

async function connectWithRetry() {
  const maxRetries = getDbConnectRetries();
  const backoffMs = getDbRetryBackoffMs();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const p = getPool();
    if (!p) throw buildNoDatabaseError();
    try {
      return { client: await p.connect(), pool: p };
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= maxRetries) {
        throw err;
      }
      logger.warn(
        {
          err: err?.message || String(err),
          code: err?.code || null,
          attempt: attempt + 1,
          max_retries: maxRetries,
        },
        'Transient DB connect failed; resetting pool and retrying',
      );
      await resetPool(p, 'connect_retry', err);
      await sleep(backoffMs);
    }
  }
  throw new Error('unreachable');
}

function captureCheckedOutClientErrors(client) {
  if (!client || typeof client.on !== 'function') {
    return {
      getError: () => null,
      detach: () => {},
    };
  }

  let capturedError = null;
  const onError = (err) => {
    capturedError = err || new Error('Postgres checked-out client emitted an unknown error');
    logger.warn(
      {
        err: capturedError?.message || String(capturedError),
        code: capturedError?.code || null,
      },
      'Postgres checked-out client emitted error; marking client broken',
    );
  };

  client.on('error', onError);
  return {
    getError: () => capturedError,
    detach: () => {
      if (typeof client.off === 'function') {
        client.off('error', onError);
      } else if (typeof client.removeListener === 'function') {
        client.removeListener('error', onError);
      }
    },
  };
}

// A helper that changed session state on a checked-out client and could not restore it (for example a
// failed `RESET statement_timeout`) marks the client so withClient DESTROYS it on release instead of
// handing the next caller a connection in an unknown state.
const DESTROY_ON_RELEASE = Symbol('pivota.db.destroyOnRelease');
function markClientForDestroy(client) {
  try {
    if (client && typeof client === 'object') client[DESTROY_ON_RELEASE] = true;
  } catch {
    // a frozen/mock client cannot be marked; nothing else to do
  }
}

async function withClient(fn) {
  const { client, pool: sourcePool } = await connectWithRetry();
  let released = false;
  let poolResetAfterError = false;
  const clientErrorCapture = captureCheckedOutClientErrors(client);
  try {
    return await fn(client);
  } catch (err) {
    if (isTransientDbError(err)) {
      try {
        client.release(true);
        released = true;
      } catch {
        // ignore release failures on broken clients
      }
      await resetPool(sourcePool, 'with_client_error', err);
      poolResetAfterError = true;
    }
    throw err;
  } finally {
    const checkedOutClientError = clientErrorCapture.getError();
    try {
      if (!released) {
        client.release(Boolean(checkedOutClientError) || client?.[DESTROY_ON_RELEASE] === true);
        released = true;
      }
    } finally {
      clientErrorCapture.detach();
    }
    if (checkedOutClientError && !poolResetAfterError) {
      await resetPool(sourcePool, 'with_client_error_event', checkedOutClientError);
    }
  }
}

async function closePool() {
  const existingPool = pool;
  if (!existingPool) return;
  await resetPool(existingPool, 'manual_close', null);
}

// Every exported read/write entry point records its failures on the current
// get_pdp_v2 request's swallowed-failure ledger (a no-op outside one), then
// rethrows unchanged. The PDP route swallows many lookup failures; this is how it
// knows one happened anywhere, in any module, before it calls a miss settled
// (see src/services/pdpSwallowedFailureLedger.js). Required lazily so the ledger
// module never participates in db's own load order.
function recordingFailures(label, fn) {
  return async function recordedDbCall(...args) {
    try {
      return await fn(...args);
    } catch (err) {
      try {
        require('../services/pdpSwallowedFailureLedger').noteSwallowedPdpFailure(label);
      } catch {
        // bookkeeping must never mask the real error
      }
      throw err;
    }
  };
}

// Boot-time check, so a refused configuration is in the logs at startup, not at the first request.
isDbLaneDeadlinesEnabled();

module.exports = {
  DB_BUDGET_ACQUIRE_TIMEOUT,
  DB_BUDGET_QUERY_TIMEOUT,
  closePool,
  getPool,
  isDbLaneDeadlinesEnabled,
  isDbUnavailableError,
  isTransientDbError,
  markClientForDestroy,
  remainingDbDeadlineMs,
  runWithDbDeadline,
  query: recordingFailures('db_query', query),
  queryWithBudget: recordingFailures('db_query_with_budget', queryWithBudget),
  queryWithStatementTimeout: recordingFailures('db_query_with_statement_timeout', queryWithStatementTimeout),
  withClient: recordingFailures('db_with_client', withClient),
};
