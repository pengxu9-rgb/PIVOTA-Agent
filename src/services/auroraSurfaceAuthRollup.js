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
 * PATH CARDINALITY IS BOUNDED, and that is a security property, not tidiness. `req.path` is
 * caller-controlled: anyone can request /v1/<random> forever, and an unbounded key map is a memory
 * exhaustion vector reachable without a credential. Distinct buckets are capped; everything past the
 * cap folds into a single `__other__` path bucket, so the counter degrades in accuracy rather than
 * falling over. The cap is deliberately generous relative to the real surface (~52 Aurora routes).
 *
 * INSTRUMENTATION MUST NEVER BREAK A REQUEST. record() only mutates an in-memory map and returns
 * synchronously; nothing in the request path awaits a database. A timer flushes to postgres, and
 * every failure path is swallowed after a warn — a rollout counter that can 500 a live request is
 * worse than no counter.
 *
 * With no DATABASE_URL the module still counts in memory and the read endpoint says so, so local and
 * CI runs behave sensibly rather than erroring.
 */

const DEFAULT_NS = 'aurora_surface_auth_rollup';
const DEFAULT_MAX_BUCKETS = 500;
const DEFAULT_FLUSH_MS = 15_000;

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function bucketKey({ path, reason, callerClass }) {
  const p = String(path || '').toLowerCase() || '/';
  const r = String(reason || 'unknown');
  const c = String(callerClass || 'unknown');
  return `${p}|${r}|${c}`;
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
  const maxBuckets = Number.isFinite(deps.maxBuckets) && deps.maxBuckets > 0 ? deps.maxBuckets : DEFAULT_MAX_BUCKETS;
  const ns = deps.ns || DEFAULT_NS;

  // day -> { total, buckets: Map, firstSeen, lastSeen }
  const pending = new Map();
  let timer = null;

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
      let key = bucketKey(observation);
      // Bounded cardinality — see the header note. Existing keys always increment; only a NEW key
      // past the cap is folded, so the common case never degrades.
      if (!st.buckets.has(key) && st.buckets.size >= maxBuckets) {
        key = bucketKey({ path: '__other__', reason: observation.reason, callerClass: observation.callerClass });
        if (!st.buckets.has(key) && st.buckets.size >= maxBuckets + 1) return;
      }
      st.buckets.set(key, (st.buckets.get(key) || 0) + 1);
      st.total += 1;
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
      } catch (err) {
        // Put the delta back so the next flush retries it rather than dropping the counts.
        const back = dayState(day);
        back.total += delta.total;
        for (const [k, v] of Object.entries(delta.buckets)) back.buckets.set(k, (back.buckets.get(k) || 0) + v);
        back.firstSeen = back.firstSeen && back.firstSeen < delta.first_seen ? back.firstSeen : delta.first_seen;
        back.lastSeen = back.lastSeen && back.lastSeen > delta.last_seen ? back.lastSeen : delta.last_seen;
        logger.warn({ err: err?.message || String(err), day }, 'aurora surface auth rollup flush failed');
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

module.exports = { createAuroraAuthRollup, utcDay, bucketKey, DEFAULT_NS, DEFAULT_MAX_BUCKETS };
