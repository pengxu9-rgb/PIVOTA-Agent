'use strict';

// One price-cache store over the REAL Firestore client, against loopback servers (tests/_support/firestoreLoopback.cjs).
// Run as a child process by tests/price_cache_real_client.node.test.cjs, so an unhandled rejection shows up as the
// process dying, exactly as it would take down the gateway. Prints ONE JSON line with what happened.
//
//   refused  Firestore refuses every connection from boot: a 200 ms warm-up times out while the library keeps retrying
//            it, writes time out, the store rebuilds its client until the reset cap disables it; the process must
//            stay up.
//   hung     healthy, then every connection hangs (a frozen proxy that never resets), then new connections are healthy
//            again while the hung ones stay hung: after rebuilding, the store must write through a NEW connection.
//   library_terminate  NOT the store: one raw client whose getAll is being retried against a refused port, then
//            terminate()d. The library's own retry rejects with nothing to catch it and the process dies: the hazard
//            that makes a store reset only DROP a client (controller r4's deterministic repro, Node 20 and 24).

const path = require('node:path');
const { createFirestorePriceCacheStore } = require(path.join(__dirname, '..', '..', 'src', 'services', 'priceCacheStore'));
const { startFirestoreServer, startFreezableProxy, refusedPort } = require('./firestoreLoopback.cjs');

const scenario = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = () => ({ amount: '23.00', read_at: new Date(), expire_at: new Date(Date.now() + 3600e3) });
let seq = 0;
const nextId = () => String(seq += 1).padStart(64, 'b');

function store(port, lines) {
  return createFirestorePriceCacheStore({
    projectId: 'cache-project-test', database: 'price-cache',
    firestoreSettings: { host: '127.0.0.1', port, ssl: false },
    flushMs: 50, flushTimeoutMs: 300,
    log: (e, f) => lines.push({ e, ...f }),
  });
}

async function refused() {
  const lines = [];
  const s = store(await refusedPort(), lines);
  const warm = await s.warm({ timeoutMs: 200 });
  const until = Date.now() + 20000;
  while (Date.now() < until && !s.stats().disabled) {
    s.putPrice(nextId(), doc());
    await s.flush();
    await sleep(50);
  }
  // Disabled: more writes are dropped and counted, nothing else happens.
  for (let i = 0; i < 5; i += 1) {
    s.putPrice(nextId(), doc());
    await s.flush();
  }
  return { warmOk: warm.ok, stats: s.stats(), events: [...new Set(lines.map((l) => l.e))].sort() };
}

async function libraryTerminate() {
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ projectId: 'cache-project-test', databaseId: 'price-cache', host: '127.0.0.1', port: await refusedPort(), ssl: false });
  let callerCaught = false;
  db.getAll(db.collection('verified_prices').doc('0'.repeat(64))).catch(() => { callerCaught = true; });
  // The crash comes at the library's NEXT retry after terminate(), which backoff can put many seconds out: watch long
  // enough to see it (the controller's repro: 6/6 with a 15 s watch).
  await sleep(3000);
  db.terminate().catch(() => {});
  await sleep(20000);
  return { survived: true, callerCaught };
}

async function hung() {
  const lines = [];
  const server = await startFirestoreServer();
  const proxy = await startFreezableProxy(server.port);
  const s = store(proxy.port, lines);
  const warm = await s.warm({ timeoutMs: 3000 });
  s.putPrice(nextId(), doc());
  await s.flush();
  const writtenBefore = s.stats().written;
  proxy.freeze();
  const frozenUntil = Date.now() + 5000;
  while (s.stats().resets < 1 && Date.now() < frozenUntil) {
    s.putPrice(nextId(), doc());
    await s.flush();
  }
  const resets = s.stats().resets;
  proxy.healNew();
  const t0 = Date.now();
  const deadline = t0 + 5000;
  let msToRecover = null;
  while (Date.now() < deadline) {
    s.putPrice(nextId(), doc());
    await s.flush();
    if (s.stats().written > writtenBefore) {
      msToRecover = Date.now() - t0;
      break;
    }
    await sleep(50);
  }
  const out = {
    warmOk: warm.ok, writtenBefore, resets, msToRecover, writtenAfter: s.stats().written,
    databases: [...server.seen.databases],
  };
  await proxy.stop();
  await server.stop();
  return out;
}

(async () => {
  const run = { refused, hung, library_terminate: libraryTerminate }[scenario];
  if (!run) throw new Error(`unknown scenario ${scenario}`);
  const out = await run();
  process.stdout.write(`${JSON.stringify({ scenario, ...out })}\n`);
  // The library may still be retrying on a dropped client: give any late rejection the chance to surface (and kill
  // the process) before declaring the run clean.
  await sleep(1500);
  process.stdout.write('CLEAN_EXIT\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write(`${JSON.stringify({ scenario, error: String(e && e.stack || e) })}\n`);
  process.exit(2);
});
