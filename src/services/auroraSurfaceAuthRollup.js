'use strict';

/*
 * auroraSurfaceAuthRollup.js — a durable counter for the Phase 1 flip gate.
 *
 * WHY THIS EXISTS INSTEAD OF READING LOGS. PR #2038 ships the Aurora surface auth guard in observe
 * mode and logs a `would_refuse` decision per request. Step 3 of the rollout gates the flip on that
 * signal being clean over a FULL TRAFFIC DAY. That measurement cannot be made from `railway logs`:
 * it returns only the live deployment and roughly minutes of history — measured 2026-08-20, asking
 * for 5,000 lines returned 248 rows spanning 9.2 minutes, and `--since 3d` returned 0 rows. Deploys
 * happen several times a day, and each one starts the window over.
 *
 * A Railway log drain is the better general answer and is still worth configuring — it would also
 * have made the traffic sweeps earlier in this work possible instead of stitching 20 deployments
 * together for a 2.4-day view. But it needs dashboard access and a destination decision, and the
 * flip gate should not wait on that. This keeps a small, durable rollup of exactly the question being
 * asked, in a table the repo already has.
 *
 * SHAPE. One `commerce_kv` row per UTC day, namespaced, holding a bucket->count map:
 *
 *     ns = 'aurora_surface_auth_rollup'
 *     k  = '2026-08-20'
 *     v  = { total, buckets: { "<path>|<reason>|<caller_class>": n }, first_seen, last_seen }
 *
 * KEY CARDINALITY IS BOUNDED BY CONSTRUCTION, and that is a security property, not tidiness.
 * `req.path` is caller-controlled: anyone can request /v1/<random> forever. See normalizePath below
 * for why a cap on the in-memory map was NOT enough, and what the database growth actually measured.
 *
 * INSTRUMENTATION MUST NEVER BREAK A REQUEST. record() only mutates an in-memory map and returns
 * synchronously; nothing in the request path awaits a database. A timer flushes to postgres, and
 * every failure path is swallowed after a warn — a rollout counter that can 500 a live request is
 * worse than no counter.
 *
 * With no DATABASE_URL the module still counts in memory and the read endpoint says so, so local and
 * CI runs behave sensibly rather than erroring.
 *
 * KNOWN GAP, DELIBERATELY NOT CLOSED HERE: up to one flush interval of counts is lost on every
 * process exit. There is no SIGTERM handler anywhere in src/server.js, and adding one is not free —
 * registering a SIGTERM listener SUPPRESSES Node's default exit, so a handler that hangs (precisely
 * when the database is unreachable, which is when a flush would hang) turns every deploy into a
 * stalled shutdown. Trading a reliable deploy for ~15s of counts is the wrong trade.
 *
 * What that means for the gate: it is looking for ZERO, and a lost window is exactly where a lone
 * non-zero could hide. At ~6 deploys a day that is ~90s of 86,400 (~0.1%), so a reading of exactly 0
 * over a day with deploys in it is "0 that could be hiding a handful". Read the gate over a window
 * with no deploy in it, or corroborate a borderline reading against the per-request log line before
 * flipping.
 */

const DEFAULT_NS = 'aurora_surface_auth_rollup';
const DEFAULT_FLUSH_MS = 15_000;
const OVERFLOW_PATH = '__other__';
// reason (5) x caller_class (7) = 35 possible overflow buckets by construction; the headroom is that
// bound plus slack, so the backstop below is unreachable from the middleware and exists only for a
// direct caller passing arbitrary values.

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/*
 * The path component is normalised to a FIXED literal set. This is the difference between bounding
 * memory and bounding the database.
 *
 * The in-memory map is cleared on every flush, so capping it bounds only one 15-second window: a
 * caller inventing new paths gets a fresh 500 keys every window, and those keys accumulate in the
 * same jsonb row forever. Measured on real PG 15: 120 windows of 500 new paths persisted 60,000
 * keys, grew the row to 287KB, and pushed merge time from 4ms to 237ms — linear, so a day of it is
 * millions of keys, merges longer than the flush interval, and eventually the 1GB jsonb ceiling,
 * after which the merge fails permanently. Raw paths were also stored untruncated, so a 7KB request
 * path became a 7KB key.
 *
 * Normalising to a literal set makes the durable key space bounded BY CONSTRUCTION —
 * (paths + 1) x reason x caller_class — with no cap logic, no growth, and nothing to tune. It also
 * keeps exactly what step 2 needs: which known consumer path is still missing the header.
 */
const KNOWN_PATHS = [
  '/v1/chat', '/v1/chat/stream', '/v2/chat', '/v2/chat/stream',
  '/v1/analysis/skin', '/v1/photos/upload', '/v1/photos/presign', '/v1/photos/confirm',
  '/v1/product/parse', '/v1/product/analyze', '/v1/dupe/suggest', '/v1/dupe/compare',
  '/v1/reco/generate', '/v1/reco/alternatives', '/v1/routine/simulate',
  '/v1/auth/me', '/v1/session/bootstrap', '/v1/events', '/v1/diagnosis/start',
];
const KNOWN_PATH_SET = new Set(KNOWN_PATHS);

function normalizePath(path) {
  const p = String(path || '').toLowerCase().replace(/\/+$/, '') || '/';
  return KNOWN_PATH_SET.has(p) ? p : OVERFLOW_PATH;
}

function bucketKey({ path, reason, callerClass }) {
  const r = String(reason || 'unknown').slice(0, 40);
  const c = String(callerClass || 'unknown').slice(0, 40);
  return `${normalizePath(path)}|${r}|${c}`;
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.now]        clock override for tests
 * @param {Function} [deps.query]      async (sql, params) => { rows }, injected so the store is
 *                                     testable without a database
 * @param {object}   [deps.logger]
 * @param {number}   [deps.maxBuckets]
 */
function createAuroraAuthRollup(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const logger = deps.logger || { warn() {}, info() {} };
  const ns = deps.ns || DEFAULT_NS;

  // day -> { total, buckets: Map, firstSeen, lastSeen }
  const pending = new Map();
  let timer = null;
  // A sustained outage retries every 15s forever (deliberate — counts are preserved). Without
  // throttling that is ~5,760 identical warn lines a day, which buries every other signal.
  let consecutiveFailures = 0;

  function dayState(day) {
    let st = pending.get(day);
    if (!st) {
      st = { total: 0, buckets: new Map(), firstSeen: null, lastSeen: null };
      pending.set(day, st);
    }
    return st;
  }

  /** Synchronous, allocation-light, never throws. Safe to call on the request path. */
  function record(observation = {}) {
    try {
      const t = now();
      const day = utcDay(t);
      const st = dayState(day);

      // total counts EVERY observation, before any capping decision. The first version incremented
      // it only on the paths that produced a bucket, so a path flood silently stopped counting: 250
      // observations reported 200, with `total` still equal to the sum of buckets, so there was no
      // internal tell that anything had been lost.
      st.total += 1;

      // No cap needed: bucketKey normalises the path to a literal set, so the key space is bounded
      // by construction at (KNOWN_PATHS + 1) x reason x caller_class regardless of what is requested.
      const key = bucketKey(observation);
      st.buckets.set(key, (st.buckets.get(key) || 0) + 1);
      if (!st.firstSeen) st.firstSeen = new Date(t).toISOString();
      st.lastSeen = new Date(t).toISOString();
    } catch {
      /* a counter must never break a request */
    }
  }

  function snapshot() {
    const out = {};
    for (const [day, st] of pending) {
      out[day] = {
        total: st.total,
        buckets: Object.fromEntries(st.buckets),
        first_seen: st.firstSeen,
        last_seen: st.lastSeen,
      };
    }
    return out;
  }

  /**
   * Merge the in-memory deltas into postgres and clear them. Merging server-side (jsonb) rather than
   * read-modify-write keeps concurrent instances from clobbering each other — Railway can run more
   * than one, and two replicas doing read-then-write would silently lose counts.
   */
  async function flush() {
    if (!deps.query || pending.size === 0) return { flushed: 0, skipped: pending.size };
    const days = [...pending.keys()];
    let flushed = 0;
    for (const day of days) {
      const st = pending.get(day);
      if (!st || st.total === 0) { pending.delete(day); continue; }
      // Take the delta out FIRST, so counts recorded during the await are not lost or double-counted.
      pending.delete(day);
      const delta = {
        total: st.total,
        buckets: Object.fromEntries(st.buckets),
        first_seen: st.firstSeen,
        last_seen: st.lastSeen,
      };
      try {
        await deps.query(
          `INSERT INTO commerce_kv (ns, k, v)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (ns, k) DO UPDATE SET v = jsonb_build_object(
             'total',      COALESCE((commerce_kv.v->>'total')::bigint, 0) + COALESCE(($3::jsonb->>'total')::bigint, 0),
             'buckets',    COALESCE(commerce_kv.v->'buckets', '{}'::jsonb) || (
                             SELECT COALESCE(jsonb_object_agg(kk, COALESCE((commerce_kv.v->'buckets'->>kk)::bigint, 0) + vv::bigint), '{}'::jsonb)
                             FROM jsonb_each_text($3::jsonb->'buckets') AS t(kk, vv)
                           ),
             'first_seen', LEAST(COALESCE(commerce_kv.v->>'first_seen', $3::jsonb->>'first_seen'), $3::jsonb->>'first_seen'),
             'last_seen',  GREATEST(COALESCE(commerce_kv.v->>'last_seen', $3::jsonb->>'last_seen'), $3::jsonb->>'last_seen')
           )`,
          [ns, day, JSON.stringify(delta)],
        );
        flushed += 1;
        consecutiveFailures = 0;
      } catch (err) {
        // Put the delta back so the next flush retries it rather than dropping the counts.
        const back = dayState(day);
        back.total += delta.total;
        for (const [k, v] of Object.entries(delta.buckets)) back.buckets.set(k, (back.buckets.get(k) || 0) + v);
        back.firstSeen = back.firstSeen && back.firstSeen < delta.first_seen ? back.firstSeen : delta.first_seen;
        back.lastSeen = back.lastSeen && back.lastSeen > delta.last_seen ? back.lastSeen : delta.last_seen;
        consecutiveFailures += 1;
        // First three, then every 40th (~10 minutes at the default interval).
        if (consecutiveFailures <= 3 || consecutiveFailures % 40 === 0) {
          logger.warn(
            { err: err?.message || String(err), day, consecutive_failures: consecutiveFailures },
            'aurora surface auth rollup flush failed',
          );
        }
      }
    }
    return { flushed };
  }

  async function read({ days = 7 } = {}) {
    const live = snapshot();
    if (!deps.query) return { durable: false, pending: live, rows: [] };
    try {
      const { rows } = await deps.query(
        `SELECT k AS day, v FROM commerce_kv WHERE ns = $1 ORDER BY k DESC LIMIT $2`,
        [ns, Math.max(1, Math.min(90, Number(days) || 7))],
      );
      return { durable: true, pending: live, rows: rows || [] };
    } catch (err) {
      logger.warn({ err: err?.message || String(err) }, 'aurora surface auth rollup read failed');
      return { durable: false, pending: live, rows: [], error: 'read_failed' };
    }
  }

  function start(intervalMs = DEFAULT_FLUSH_MS) {
    if (timer || !deps.query) return;
    timer = setInterval(() => { flush().catch(() => {}); }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref(); // never hold the process open
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { record, flush, read, snapshot, start, stop };
}

module.exports = { createAuroraAuthRollup, utcDay, bucketKey, normalizePath, KNOWN_PATHS, DEFAULT_NS, OVERFLOW_PATH };
