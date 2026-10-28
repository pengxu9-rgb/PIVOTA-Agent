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
// A store that keeps resetting with no write landing in between is talking to a Firestore that is not there (refused,
// unreachable). The library keeps retrying on every dropped client, so it never frees them (controller r4: 0 of 615
// collected after 9 min, ~8 MB RSS per reset): after this many resets without one successful write the store DISABLES
// itself until the process restarts (price_cache_store_disabled, once), so an hours-long outage cannot exhaust memory.
// Any write that lands, even a late one from a dropped client, means Firestore is alive and restarts the count, so a
// slow-but-alive Firestore is never disabled (it keeps resetting every ~30 s instead; its late writes are reported as
// abandoned).
const RESET_CAP_WITHOUT_SUCCESS = 5;
// A disabled store comes back two ways (controller r5):
//   - PROOF OF LIFE: a write from a dropped client finally lands (the library kept retrying it), so Firestore answers
//     again. The store re-enables at once and the next flush builds one fresh client. It cannot fire while Firestore
//     refuses, and fires within a retry or two of recovery.
//   - A SLOW PROBE, for a hung connection whose dropped writes never land: one fresh client after 30 min, doubling to
//     4 h, at most 6 per process. A probe gets exactly one more reset before the store disables again, so each probe
//     can cost at most one more held client.
const PROBE_INITIAL_MS = 30 * 60 * 1000;
const PROBE_MAX_MS = 4 * 60 * 60 * 1000;
const MAX_PROBES = 6;
// A hard budget on LIVE clients (controller r6): the one in use plus every dropped one with a write or read still
// unsettled on it, which the library keeps alive while it retries. A dropped client whose operations have all settled
// (landed or failed) is free and stops counting, so a slow-but-alive Firestore, whose late writes land, never spends it.
// A FLAPPING Firestore (down long enough for 5 resets, up just long enough for one late write to land) re-enables the
// store again and again, each time stranding more clients (r6 sim: 107 clients and heap 32 -> 96 MB in 5 min): at this
// many live clients the store is disabled until the process restarts, whatever lands or probes later. A refused-forever
// outage needs at most 5 + MAX_PROBES = 11.
const MAX_CLIENTS = 20;
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
  const probeInitialMs = Number(opts.probeInitialMs) > 0 ? Number(opts.probeInitialMs) : PROBE_INITIAL_MS;
  const probeMaxMs = Number(opts.probeMaxMs) > 0 ? Number(opts.probeMaxMs) : PROBE_MAX_MS;
  const maxProbes = Number.isInteger(opts.maxProbes) && opts.maxProbes >= 0 ? opts.maxProbes : MAX_PROBES;
  const maxClients = Number.isInteger(opts.maxClients) && opts.maxClients > 0 ? opts.maxClients : MAX_CLIENTS;
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
  let current = null; // { ops, dropped, freed } for the client in use, when this store built it
  let liveClients = 0; // built and not known to be free: `current` plus every dropped client with an op unsettled
  const client = () => {
    if (!db) {
      db = clientFactory();
      stats.clients_built += 1;
      liveClients += 1;
      current = { ops: 0, dropped: false, freed: false };
    }
    return db;
  };
  // No factory (an injected client, tests): nothing is ever built, so there is no budget to spend.
  const budgetSpent = () => Boolean(clientFactory) && liveClients >= maxClients;

  /** Count an operation against the client it runs on until it settles, landed, failed or rejected. */
  function track(rec, promise) {
    if (!rec) return;
    rec.ops += 1;
    const done = () => {
      rec.ops -= 1;
      if (rec.dropped && rec.ops === 0) free(rec);
    };
    promise.then(done, done);
  }

  function free(rec) {
    if (rec.freed) return;
    rec.freed = true;
    liveClients -= 1;
  }

  /** Let the client and its BulkWriter go (never terminated); it stays live until its operations settle. */
  function dropClient() {
    writer = null;
    if (!clientFactory) return; // an injected client is kept
    db = null;
    if (current) {
      current.dropped = true;
      if (current.ops === 0) free(current);
      current = null;
    }
  }

  const pending = new Map(); // `${collection}/${id}` -> { collection, id, doc }
  const stats = { queued: 0, written: 0, failed: 0, dropped: 0, flushes: 0, flush_timeouts: 0, resets: 0, abandoned: 0, reenabled: 0, probes: 0, clients_built: 0 };
  let resetsSinceSuccess = 0;
  let disabled = false;
  let retired = false; // disabled for good: the client budget is spent
  let probeTimer = null;
  let nextProbeMs = probeInitialMs;
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
    for (const k of ['written', 'failed', 'dropped', 'flush_timeouts', 'resets', 'abandoned', 'reenabled', 'probes', 'clients_built']) {
      delta[k] = stats[k] - statsAtLastLog[k];
      if (delta[k]) moved = true;
    }
    if (!moved) return;
    lastStatsLogAt = t;
    statsAtLastLog = { ...stats };
    log('price_cache_store_stats', { ...delta, pending: pending.size, inflight, live_clients: liveClients, ...(disabled ? { disabled: true } : {}) });
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
    resetsSinceSuccess += 1;
    stats.abandoned += inflight;
    inflight = 0;
    generation += 1;
    consecutiveTimeouts = 0;
    dropClient();
    log('price_cache_store_reset', { abandoned: stats.abandoned, resets: stats.resets });
    if (budgetSpent()) retire();
    else if (resetsSinceSuccess >= RESET_CAP_WITHOUT_SUCCESS) disable();
  }

  /** No more clients, writes or reads until proof of life, a probe or a restart (the cache is optional; answers fall back). */
  function disable() {
    if (disabled) return;
    stopWork();
    log('price_cache_store_disabled', { resets: stats.resets, abandoned: stats.abandoned, reason: 'no_write_succeeded' });
    scheduleProbe();
  }

  function stopWork() {
    disabled = true;
    stats.dropped += pending.size;
    pending.clear();
    dropClient();
  }

  /** The client budget is spent: disabled until the process restarts; no write that lands and no probe brings it back. */
  function retire() {
    if (retired) return;
    retired = true;
    if (!disabled) stopWork();
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    log('price_cache_store_disabled', { resets: stats.resets, abandoned: stats.abandoned, clients_built: stats.clients_built, live_clients: liveClients, reason: 'client_budget' });
  }

  function scheduleProbe() {
    if (probeTimer || closed || retired || stats.probes >= maxProbes) return;
    const delay = nextProbeMs;
    nextProbeMs = Math.min(nextProbeMs * 2, probeMaxMs);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      if (!disabled || closed) return;
      stats.probes += 1;
      enable('probe');
      // One more reset (three more flush timeouts) and the store is disabled again.
      resetsSinceSuccess = RESET_CAP_WITHOUT_SUCCESS - 1;
    }, delay);
    if (typeof probeTimer.unref === 'function') probeTimer.unref();
  }

  /** Back to work: the next flush builds a fresh client. */
  function enable(reason) {
    // Retired (the client budget is spent): nothing brings it back but a restart.
    if (!disabled || retired) return;
    disabled = false;
    resetsSinceSuccess = 0;
    if (reason === 'write_landed') {
      stats.reenabled += 1;
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = null;
    }
    log('price_cache_store_enabled', { reason, resets: stats.resets });
  }

  function enqueue(collection, id, doc) {
    if (closed) return;
    startStatsTimer();
    if (disabled) {
      stats.dropped += 1;
      return;
    }
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
      if (!pending.size || disabled) {
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
      const rec = current;
      const results = batch.map(({ collection, id, doc }) => {
        try {
          const op = w.set(client().collection(collection).doc(id), doc);
          track(rec, op);
          inflight += 1;
          return op.then(
            // An abandoned write was counted when it was abandoned, landing or not; but any write that lands means
            // Firestore is alive, so the reset cap's count starts again.
            () => {
              resetsSinceSuccess = 0;
              nextProbeMs = probeInitialMs; // a future outage probes from the start again
              if (disabled) enable('write_landed');
              if (gen === generation) stats.written += 1;
            },
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
    if (!list.length || disabled) return out;
    const c = client();
    const refs = list.map((id) => c.collection(PRICES).doc(id));
    const read = Promise.resolve().then(() => c.getAll(...refs));
    track(current, read);
    const snaps = await withTimeout(read, readTimeoutMs);
    for (const snap of snaps) {
      if (snap && snap.id) out.set(snap.id, snap.exists ? snap.data() : null);
    }
    return out;
  }

  async function getHostBackoff(host) {
    if (disabled) return null;
    const c = client();
    const read = Promise.resolve().then(() => c.collection(BACKOFF).doc(host).get());
    track(current, read);
    const snap = await withTimeout(read, readTimeoutMs);
    return snap && snap.exists ? snap.data() : null;
  }

  /** Load the client and make one read now (boot, before traffic), so no request pays for it. Never rejects. */
  async function warm({ timeoutMs = WARM_TIMEOUT_MS } = {}) {
    const t = now();
    if (disabled) return { ok: false, ms: 0 };
    try {
      const c = client();
      bulkWriter();
      const read = Promise.resolve().then(() => c.getAll(c.collection(PRICES).doc(WARM_DOC_ID)));
      read.catch(() => {}); // the library keeps retrying after our timeout: its later rejection is handled here
      track(current, read);
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
      if (probeTimer) clearTimeout(probeTimer);
      probeTimer = null;
      await flush();
      if (writer) await writer.close().catch(() => {});
      if (db && typeof db.terminate === 'function') await db.terminate().catch(() => {});
    },
    stats: () => ({ ...stats, pending: pending.size, inflight, live_clients: liveClients, disabled }),
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
  RESET_CAP_WITHOUT_SUCCESS,
  PROBE_INITIAL_MS,
  PROBE_MAX_MS,
  MAX_PROBES,
  MAX_CLIENTS,
  GRPC_CHANNEL_OPTIONS,
  WARM_DOC_ID,
};
