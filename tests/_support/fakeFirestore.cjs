'use strict';

// A FAITHFUL FAKE of the slice of @google-cloud/firestore the price cache uses (services/priceCacheStore.js), for
// tests that must not need the Firestore emulator (a Java runtime and a download) or any network. It keeps the
// real client's contracts that the cache depends on:
//   - collection(name).doc(id): an empty id or one with a '/' throws (the real client's own check); '.', '..',
//     __name__-shaped and > 1500-byte ids, which the real client lets through for the SERVER to refuse, throw
//     here too (stricter, so a bad id cannot pass a test);
//   - getAll(...refs): at least one ref (the real client throws otherwise), ONE round trip, snapshots in ref order,
//     each { id, ref, exists, data() } (data() undefined when the doc does not exist);
//   - values: undefined is refused SYNCHRONOUSLY by set() (the real client without ignoreUndefinedProperties);
//     a function or symbol is accepted by set() and its write REJECTS (failedAttempts 1), as the real BulkWriter
//     does (checked against @google-cloud/firestore 8.7.1 offline); a Date comes back as a Timestamp
//     ({ toMillis, toDate, seconds, nanoseconds }), never as a Date;
//   - bulkWriter(): set(ref, data) validates at once and returns a promise per write; writes are sent in batches
//     of at most 20 (a full batch goes at once, the rest on flush/close); flush() never rejects; onWriteError(cb)
//     decides retries, with err.failedAttempts counting attempts so far; after close(), set() throws.
// Faults are injected per test: getAll latency or error, write failures (code and count).

class FakeTimestamp {
  constructor(ms) {
    this.seconds = Math.floor(ms / 1000);
    this.nanoseconds = (ms - this.seconds * 1000) * 1e6;
  }

  toMillis() {
    return this.seconds * 1000 + Math.round(this.nanoseconds / 1e6);
  }

  toDate() {
    return new Date(this.toMillis());
  }
}

function checkDocId(id) {
  if (typeof id !== 'string' || !id) throw new Error('Value for argument "documentPath" is not a valid resource path. Path must be a non-empty string.');
  if (id.includes('/')) throw new Error('Value for argument "documentPath" must point to a document, but was a nested path.');
  if (id === '.' || id === '..' || /^__.*__$/.test(id)) throw new Error(`Document id "${id}" is reserved.`);
  if (Buffer.byteLength(id, 'utf8') > 1500) throw new Error('Document id longer than 1500 bytes.');
}

function encode(value, path = 'data') {
  if (value === undefined) {
    throw Object.assign(new Error(`Value for argument "${path}" is not a valid Firestore document. Cannot use "undefined" as a Firestore value.`), { sync: true });
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`Cannot encode value: ${String(value).slice(0, 40)}`);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`Value for argument "${path}" is an invalid Date.`);
    return new FakeTimestamp(value.getTime());
  }
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.toMillis());
  if (Array.isArray(value)) return value.map((v, i) => encode(v, `${path}[${i}]`));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v, `${path}.${k}`);
    return out;
  }
  throw new Error(`Value for argument "${path}" is not a valid Firestore value.`);
}

function decode(value) {
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value.toMillis());
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  return value;
}

function createFakeFirestore({ databaseId = 'price-cache' } = {}) {
  const docs = new Map(); // path -> encoded data
  const calls = { getAll: [], get: [], batches: [], writerOptions: [] };
  // writeHang: a commit that never answers (a blackholed Firestore) until release() is called.
  const faults = { getAllDelayMs: 0, getAllError: null, getDelayMs: 0, getError: null, writeFailures: 0, writeCode: 14, writeHang: false };
  let releaseHang = () => {};
  const hung = () => new Promise((resolve) => { releaseHang = resolve; });
  const pause = (ms) => new Promise((r) => (ms ? setTimeout(r, ms) : setImmediate(r)));

  function docRef(collection, id) {
    checkDocId(id);
    const path = `${collection}/${id}`;
    return {
      id,
      path,
      parent: { id: collection },
      async get() {
        calls.get.push(path);
        await pause(faults.getDelayMs);
        if (faults.getError) throw faults.getError;
        return snapshot(this);
      },
    };
  }

  function snapshot(ref) {
    const stored = docs.get(ref.path);
    return { id: ref.id, ref, exists: stored !== undefined, data: () => (stored === undefined ? undefined : decode(stored)) };
  }

  const db = {
    databaseId,
    collection(name) {
      if (typeof name !== 'string' || !name || name.includes('/')) throw new Error('Value for argument "collectionPath" must point to a collection.');
      return { id: name, doc: (id) => docRef(name, id) };
    },
    async getAll(...refs) {
      if (!refs.length) throw new Error('Function "getAll()" requires at least 1 argument.');
      for (const r of refs) if (!r || typeof r.path !== 'string') throw new Error('Argument at index 0 is not a valid DocumentReference.');
      calls.getAll.push(refs.map((r) => r.path));
      await pause(faults.getAllDelayMs);
      if (faults.getAllError) throw faults.getAllError;
      return refs.map(snapshot);
    },
    bulkWriter(options) {
      calls.writerOptions.push(options);
      let queue = []; // { ref, data, resolve, reject, attempts }
      let closed = false;
      let shouldRetry = (err) => [10, 14].includes(err.code) && err.failedAttempts < 10;
      const inflight = new Set();
      async function send(batch) {
        calls.batches.push(batch.map((op) => op.ref.path));
        await pause(0);
        if (faults.writeHang) await hung();
        for (const op of batch) {
          if (faults.writeFailures > 0) {
            faults.writeFailures -= 1;
            op.attempts += 1;
            const err = Object.assign(new Error('fake write failure'), { code: faults.writeCode, failedAttempts: op.attempts, documentRef: op.ref });
            if (shouldRetry(err)) {
              queue.push(op);
              continue;
            }
            op.reject(err);
            continue;
          }
          docs.set(op.ref.path, op.data);
          op.resolve({ writeTime: new FakeTimestamp(Date.now()) });
        }
      }
      function sendFull() {
        while (queue.length >= 20) {
          const batch = queue.slice(0, 20);
          queue = queue.slice(20);
          const p = send(batch).finally(() => inflight.delete(p));
          inflight.add(p);
        }
      }
      async function drain() {
        // Retries re-enter the queue: send until it stays empty.
        while (queue.length || inflight.size) {
          while (queue.length) {
            const batch = queue.slice(0, 20);
            queue = queue.slice(20);
            const p = send(batch).finally(() => inflight.delete(p));
            inflight.add(p);
          }
          await Promise.all([...inflight]);
        }
      }
      return {
        set(ref, data) {
          if (closed) throw new Error('BulkWriter has already been closed.');
          let encoded;
          try {
            encoded = encode(data);
          } catch (err) {
            if (err.sync) throw err;
            return Promise.reject(Object.assign(err, { code: undefined, failedAttempts: 1, documentRef: ref }));
          }
          return new Promise((resolve, reject) => {
            queue.push({ ref, data: encoded, resolve, reject, attempts: 0 });
            sendFull();
          });
        },
        onWriteError(cb) {
          shouldRetry = cb;
        },
        async flush() {
          await drain();
        },
        async close() {
          closed = true;
          await drain();
        },
      };
    },
    async terminate() {
      db.terminated = true;
    },
  };
  return { db, docs, calls, faults, FakeTimestamp, release: () => { faults.writeHang = false; releaseHang(); } };
}

module.exports = { createFakeFirestore, FakeTimestamp };
