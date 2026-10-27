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
 *   client?: object,        // a Firestore instance (tests); built from @google-cloud/firestore otherwise
 *   readTimeoutMs?: number, flushMs?: number, maxPending?: number,
 *   now?: () => number,
 *   log?: (event: string, fields: object) => void,
 * }} opts
 * @returns {PriceCacheStore & { flush(): Promise<void>, stats(): object }}
 */
function createFirestorePriceCacheStore(opts = {}) {
  const database = String(opts.database || 'price-cache');
  const readTimeoutMs = Number(opts.readTimeoutMs) > 0 ? Number(opts.readTimeoutMs) : READ_TIMEOUT_MS;
  const flushMs = Number(opts.flushMs) > 0 ? Number(opts.flushMs) : FLUSH_MS;
  const maxPending = Number.isInteger(opts.maxPending) && opts.maxPending > 0 ? opts.maxPending : MAX_PENDING;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const logSink = typeof opts.log === 'function' ? opts.log : () => {};
  const log = (event, fields) => {
    try { logSink(event, fields); } catch { /* a log line never costs a write */ }
  };
  let db = opts.client || null;
  const client = () => {
    if (!db) {
      // Only here: an off or unconfigured cache never loads the client (and so never opens a channel).
      const { Firestore } = require('@google-cloud/firestore');
      db = new Firestore({ databaseId: database });
    }
    return db;
  };

  const pending = new Map(); // `${collection}/${id}` -> { collection, id, doc }
  const stats = { queued: 0, written: 0, failed: 0, dropped: 0, flushes: 0 };
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

  function noteFailure(err) {
    stats.failed += 1;
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

  function enqueue(collection, id, doc) {
    if (closed) return;
    const key = `${collection}/${id}`;
    const prev = pending.get(key);
    // Last writer wins by read time: an older answer that reaches the queue later never replaces a newer one.
    if (prev && msOf(prev.doc.read_at) > msOf(doc.read_at)) return;
    if (!prev && pending.size >= maxPending) {
      stats.dropped += 1;
      return;
    }
    pending.set(key, { collection, id, doc });
    stats.queued += 1;
    schedule();
  }

  /** Hand every queued doc to the BulkWriter and wait for it. Never rejects. */
  function flush() {
    flushing = flushing.then(async () => {
      if (!pending.size) return;
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
      const results = batch.map(({ collection, id, doc }) => {
        try {
          return w.set(client().collection(collection).doc(id), doc).then(
            () => { stats.written += 1; },
            (err) => noteFailure(err),
          );
        } catch (err) {
          // An invalid doc (the client refuses it synchronously) costs that doc only.
          noteFailure(err);
          return null;
        }
      });
      try {
        await w.flush();
      } catch (err) {
        noteFailure(err);
      }
      await Promise.all(results);
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

  return {
    getPrices,
    putPrice: (id, doc) => enqueue(PRICES, id, doc),
    getHostBackoff,
    putHostBackoff: (host, doc) => enqueue(BACKOFF, host, doc),
    flush,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
      if (writer) await writer.close().catch(() => {});
      if (db && typeof db.terminate === 'function') await db.terminate().catch(() => {});
    },
    stats: () => ({ ...stats, pending: pending.size }),
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
};
