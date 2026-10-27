'use strict';

/*
 * THE SHARED VERIFIED-PRICE STORE (verified-price plan PR-3; design section 2.2). One interface, so the store can
 * change without touching a reader:
 *
 *   PriceCacheStore {
 *     getPrices(ids: string[]): Promise<Map<id, object|null>>   at most MAX_GET_ALL ids, ONE round trip; rejects
 *                                                              on error or after the read timeout (the caller
 *                                                              fails open)
 *     putPrice(id: string, doc: object): void                  queued, never awaited; flushed in the background
 *     getHostBackoff(host: string): Promise<object|null>       one host_backoff doc; rejects like getPrices
 *     putHostBackoff(host: string, doc: object): void          queued like putPrice
 *     warm(): Promise<{ ok, ms }>                                load the client and make one read, at boot
 *     close(): Promise<void>
 *   }
 *
 * The Firestore implementation: collection `verified_prices` (doc id = hex sha256 of host|market|variant|currency,
 * services/priceCache.js), collection `host_backoff` (doc id = the host). Reads are one `getAll`, raced against a
 * 150 ms timer. Writes go into a per-process map (the newest `read_at` per doc wins) and a BulkWriter takes them
 * about once a second, so a write is never on a response path. Nothing here runs, and `@google-cloud/firestore`
 * is not even loaded, until createFirestorePriceCacheStore is called (PRICE_CACHE_STORE=firestore and
 * PRICE_CACHE_MODE write|read; services/priceCache.js).
 */

const PRICES = 'verified_prices';
const BACKOFF = 'host_backoff';
const MAX_GET_ALL = 20;
const READ_TIMEOUT_MS = 150;
const FLUSH_MS = 1000;
// A store that cannot keep up (Firestore down, quota) must not grow this process: past this many queued docs,
// new writes are dropped and counted.
const MAX_PENDING = 2000;
// A failed write is retried at most twice more (the BulkWriter's own backoff), then dropped and counted.
const MAX_WRITE_ATTEMPTS = 3;
const FAILURE_LOG_EVERY_MS = 60 * 1000;
// A flush that has not settled in this long (Firestore refused or unreachable: the BulkWriter keeps retrying) is
// given up on: counted as `flush_timeout` and logged, so an outage is never silent. Its writes may still land.
const FLUSH_TIMEOUT_MS = 10 * 1000;
// Writes handed to the BulkWriter that have not settled count against maxPending too: while Firestore does not
// answer, new writes are dropped (and counted) instead of piling up inside the client.
// One stats line at most this often, whenever anything moved: written / failed / dropped / timeouts, and what is
// queued or in flight now.
const STATS_LOG_EVERY_MS = 60 * 1000;
// A connection that hangs (TCP blackholed, no RST) never settles the writes on it, even after Firestore recovers:
// after this many flush timeouts in a row the BulkWriter and the client (its channel) are dropped and built again on
// next use. Their unsettled writes are counted as `abandoned` and stop holding the in-flight cap.
const RESET_AFTER_FLUSH_TIMEOUTS = 3;
// gRPC channel options for every client this store builds. grpc-js shares subchannels PROCESS-WIDE by default, so a
// rebuilt client would reuse the hung connection it was rebuilt to escape (controller r3 sim: 6 rebuilds, 0 writes,
// 140 s after the backend recovered). A local pool gives each client its own connection.
const GRPC_CHANNEL_OPTIONS = Object.freeze({ 'grpc.use_local_subchannel_pool': 1 });
// The doc the boot warm-up reads (a valid id no price key hashes to in practice); absent, it costs one read.
const WARM_DOC_ID = '0'.repeat(64);
const WARM_TIMEOUT_MS = 5000;

function msOf(v) {
  if (v == null) return NaN;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('price_cache_timeout'), { code: 'timeout' })), ms);
    if (typeof t.unref === 'function') t.unref();
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * @param {{
 *   database?: string,      // Firestore database id (PRICE_CACHE_FIRESTORE_DATABASE, default price-cache)
 *   projectId?: string,     // the cache's GCP project (PRICE_CACHE_FIRESTORE_PROJECT); REQUIRED unless a client or
 *                           // clientFactory is given: never left to the library, which reads GOOGLE_CLOUD_PROJECT
 *   client?: object,        // a Firestore instance (tests); built from @google-cloud/firestore otherwise
 *   readTimeoutMs?: number, flushMs?: number, maxPending?: number,
 *   now?: () => number,
 *   log?: (event: string, fields: object) => void,
 * }} opts
 * @returns {PriceCacheStore & { flush(): Promise<void>, stats(): object }}
 */
function createFirestorePriceCacheStore(opts = {}) {
  const database = String(opts.database || 'price-cache');
  const projectId = String(opts.projectId || '').trim();
  // The project is NEVER left to the library: unset, google-gax takes GOOGLE_CLOUD_PROJECT, which on the gateway is the
  // Vertex/Gemini billing project, not the cache's (write mode 2026-10-27: every call PERMISSION_DENIED on the wrong
  // project). No project, no store.
  if (!projectId && !opts.client && typeof opts.clientFactory !== 'function') {
    throw Object.assign(new Error('price cache: no Firestore project (PRICE_CACHE_FIRESTORE_PROJECT)'), { code: 'project_unset' });
  }
  const readTimeoutMs = Number(opts.readTimeoutMs) > 0 ? Number(opts.readTimeoutMs) : READ_TIMEOUT_MS;
  const flushMs = Number(opts.flushMs) > 0 ? Number(opts.flushMs) : FLUSH_MS;
  const maxPending = Number.isInteger(opts.maxPending) && opts.maxPending > 0 ? opts.maxPending : MAX_PENDING;
  const flushTimeoutMs = Number(opts.flushTimeoutMs) > 0 ? Number(opts.flushTimeoutMs) : FLUSH_TIMEOUT_MS;
  const statsLogEveryMs = Number(opts.statsLogEveryMs) > 0 ? Number(opts.statsLogEveryMs) : STATS_LOG_EVERY_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const logSink = typeof opts.log === 'function' ? opts.log : () => {};
  const log = (event, fields) => {
    try { logSink(event, fields); } catch { /* a log line never costs a write */ }
  };
  // An injected client (tests) is kept across a reset unless a factory says how to build another.
  // `firestoreSettings` (tests only): extra client settings such as a loopback host, so the REAL client runs offline.
  const extraSettings = opts.firestoreSettings && typeof opts.firestoreSettings === 'object' ? opts.firestoreSettings : {};
  const clientFactory = typeof opts.clientFactory === 'function' ? opts.clientFactory : (opts.client ? null : () => {
    // Only here: an off or unconfigured cache never loads the client (and so never opens a channel).
    const { Firestore } = require('@google-cloud/firestore');
    return new Firestore({ ...extraSettings, ...GRPC_CHANNEL_OPTIONS, projectId, databaseId: database });
  });
  let db = opts.client || null;
  const client = () => {
    if (!db) db = clientFactory();
    return db;
  };

  const pending = new Map(); // `${collection}/${id}` -> { collection, id, doc }
  const stats = { queued: 0, written: 0, failed: 0, dropped: 0, flushes: 0, flush_timeouts: 0, resets: 0, abandoned: 0 };
  let inflight = 0; // handed to the current BulkWriter, not yet settled
  let generation = 0; // which BulkWriter an in-flight write belongs to
  let consecutiveTimeouts = 0;
  let statsTimer = null;
  let lastStatsLogAt = -Infinity;
  let statsAtLastLog = { ...stats };
  let writer = null;
  let timer = null;
  let flushing = Promise.resolve();
  let lastFailureLogAt = -Infinity;
  let failuresSinceLog = 0;
  let closed = false;

  function bulkWriter() {
    if (!writer) {
      writer = client().bulkWriter({ throttling: false });
      writer.onWriteError((err) => Number(err && err.failedAttempts) < MAX_WRITE_ATTEMPTS);
    }
    return writer;
  }

  function noteFailure(err, { count = true } = {}) {
    if (count) stats.failed += 1;
    failuresSinceLog += 1;
    const t = now();
    if (t - lastFailureLogAt < FAILURE_LOG_EVERY_MS) return;
    lastFailureLogAt = t;
    log('price_cache_write_failed', {
      failures: failuresSinceLog,
      code: err && err.code != null ? String(err.code).slice(0, 40) : null,
    });
    failuresSinceLog = 0;
  }

  function schedule() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, flushMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** One `price_cache_store_stats` line at most a minute, when anything moved since the last one. */
  function maybeLogStats() {
    const t = now();
    if (t - lastStatsLogAt < STATS_LOG_EVERY_MS) return;
    const delta = {};
    let moved = false;
    for (const k of ['written', 'failed', 'dropped', 'flush_timeouts', 'resets', 'abandoned']) {
      delta[k] = stats[k] - statsAtLastLog[k];
      if (delta[k]) moved = true;
    }
    if (!moved) return;
    lastStatsLogAt = t;
    statsAtLastLog = { ...stats };
    log('price_cache_store_stats', { ...delta, pending: pending.size, inflight });
  }

  /** The stats line on its own clock too: drops after traffic stops (no flush) still reach the log. */
  function startStatsTimer() {
    if (statsTimer || closed) return;
    statsTimer = setInterval(() => maybeLogStats(), statsLogEveryMs);
    if (typeof statsTimer.unref === 'function') statsTimer.unref();
  }

  /**
   * Drop the BulkWriter and the client (rebuilt on next use); their unsettled writes are abandoned. The old ones are
   * NEVER closed or terminated: terminate() rejects the library's own in-flight retries (a timed-out warm-up read, a
   * cache read) with nothing to catch them, and an unhandled rejection exits the gateway (controller r3, B1). They are
   * only let go; the hung channel goes with them.
   */
  function reset() {
    stats.resets += 1;
    stats.abandoned += inflight;
    inflight = 0;
    generation += 1;
    consecutiveTimeouts = 0;
    writer = null;
    if (clientFactory) db = null;
    log('price_cache_store_reset', { abandoned: stats.abandoned, resets: stats.resets });
  }

  function enqueue(collection, id, doc) {
    if (closed) return;
    startStatsTimer();
    const key = `${collection}/${id}`;
    const prev = pending.get(key);
    // Last writer wins by read time: an older answer that reaches the queue later never replaces a newer one.
    if (prev && msOf(prev.doc.read_at) > msOf(doc.read_at)) return;
    if (!prev && pending.size + inflight >= maxPending) {
      stats.dropped += 1;
      schedule(); // so the drop reaches the stats line even when nothing else is queued
      return;
    }
    pending.set(key, { collection, id, doc });
    stats.queued += 1;
    schedule();
  }

  /** Hand every queued doc to the BulkWriter and wait for it. Never rejects. */
  function flush() {
    flushing = flushing.then(async () => {
      if (!pending.size) {
        maybeLogStats();
        return;
      }
      const batch = [...pending.values()];
      pending.clear();
      stats.flushes += 1;
      let w;
      try {
        w = bulkWriter();
      } catch (err) {
        for (let i = 0; i < batch.length; i += 1) noteFailure(err);
        return;
      }
      const gen = generation;
      const results = batch.map(({ collection, id, doc }) => {
        try {
          const op = w.set(client().collection(collection).doc(id), doc);
          inflight += 1;
          return op.then(
            // An abandoned write was counted when it was abandoned, landing or not.
            () => { if (gen === generation) stats.written += 1; },
            // An abandoned write was counted when it was abandoned.
            (err) => { if (gen === generation) noteFailure(err); },
          ).finally(() => {
            if (gen === generation) inflight -= 1;
          });
        } catch (err) {
          // An invalid doc (the client refuses it synchronously) costs that doc only.
          noteFailure(err);
          return null;
        }
      });
      const settled = Promise.all([Promise.resolve().then(() => w.flush()).catch((err) => noteFailure(err)), ...results]);
      let timer;
      const timedOut = await Promise.race([
        settled.then(() => false),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(true), flushTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        // The writes stay with the client (they may land later and are counted then); this flush gives up waiting.
        stats.flush_timeouts += 1;
        consecutiveTimeouts += 1;
        noteFailure({ code: 'flush_timeout' }, { count: false });
        if (consecutiveTimeouts >= RESET_AFTER_FLUSH_TIMEOUTS) reset();
      } else {
        consecutiveTimeouts = 0;
      }
      maybeLogStats();
    }).catch(() => {});
    return flushing;
  }

  async function getPrices(ids) {
    const list = [...new Set(Array.isArray(ids) ? ids : [])].slice(0, MAX_GET_ALL);
    const out = new Map();
    if (!list.length) return out;
    const c = client();
    const refs = list.map((id) => c.collection(PRICES).doc(id));
    const snaps = await withTimeout(Promise.resolve().then(() => c.getAll(...refs)), readTimeoutMs);
    for (const snap of snaps) {
      if (snap && snap.id) out.set(snap.id, snap.exists ? snap.data() : null);
    }
    return out;
  }

  async function getHostBackoff(host) {
    const c = client();
    const snap = await withTimeout(Promise.resolve().then(() => c.collection(BACKOFF).doc(host).get()), readTimeoutMs);
    return snap && snap.exists ? snap.data() : null;
  }

  /** Load the client and make one read now (boot, before traffic), so no request pays for it. Never rejects. */
  async function warm({ timeoutMs = WARM_TIMEOUT_MS } = {}) {
    const t = now();
    try {
      const c = client();
      bulkWriter();
      const read = Promise.resolve().then(() => c.getAll(c.collection(PRICES).doc(WARM_DOC_ID)));
      read.catch(() => {}); // the library keeps retrying after our timeout: its later rejection is handled here
      await withTimeout(read, timeoutMs);
      return { ok: true, ms: now() - t };
    } catch (err) {
      log('price_cache_warm_failed', { code: err && err.code != null ? String(err.code).slice(0, 40) : null, ms: now() - t });
      return { ok: false, ms: now() - t };
    }
  }

  return {
    warm,
    getPrices,
    putPrice: (id, doc) => enqueue(PRICES, id, doc),
    getHostBackoff,
    putHostBackoff: (host, doc) => enqueue(BACKOFF, host, doc),
    flush,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (statsTimer) clearInterval(statsTimer);
      statsTimer = null;
      await flush();
      if (writer) await writer.close().catch(() => {});
      if (db && typeof db.terminate === 'function') await db.terminate().catch(() => {});
    },
    stats: () => ({ ...stats, pending: pending.size, inflight }),
    /** Tests: the client this store would use now (built on demand, no RPC). */
    _client: () => client(),
  };
}

module.exports = {
  createFirestorePriceCacheStore,
  msOf,
  PRICES,
  BACKOFF,
  MAX_GET_ALL,
  READ_TIMEOUT_MS,
  FLUSH_MS,
  MAX_PENDING,
  FLUSH_TIMEOUT_MS,
  RESET_AFTER_FLUSH_TIMEOUTS,
  GRPC_CHANNEL_OPTIONS,
  WARM_DOC_ID,
};
