'use strict';

// THE PRICE CACHE OVER THE REAL @google-cloud/firestore CLIENT (8.7.1), offline: loopback gRPC servers
// (tests/_support/firestoreLoopback.cjs), each scenario in a child process (tests/_support/priceCacheRealClientSim.cjs)
// so an unhandled rejection kills it exactly as it would kill the gateway. The child inherits this process's
// --require flags (the loopback-only network guard when the suite runs under it).
//
// Controller r3 on gw#2500:
//   B1  a refused / unreachable Firestore at boot: the warm-up read times out while the library keeps retrying it, and
//       terminate() on a store reset made that retry reject with nothing to catch it -> the gateway exited. The store
//       must survive repeated resets.
//   (2) a hung connection: grpc-js shares subchannels process-wide, so a rebuilt client reused the hung connection and
//       never wrote again. With a local subchannel pool the rebuilt client writes through a new connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function sim(scenario) {
  const r = spawnSync(process.execPath, [...process.execArgv.filter((a) => !a.startsWith('--test')), path.join(__dirname, '_support', 'priceCacheRealClientSim.cjs'), scenario], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '', FIRESTORE_EMULATOR_HOST: '' },
  });
  const lines = String(r.stdout || '').split('\n').filter(Boolean);
  const json = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x && x.scenario === scenario);
  return { status: r.status, clean: lines.includes('CLEAN_EXIT'), out: json, stderr: String(r.stderr || '').slice(-2000) };
}

test('B1: Firestore refused from boot: warm-up and writes time out, the client is rebuilt again and again, the process stays up', { timeout: 90000 }, () => {
  const r = sim('refused');
  assert.equal(r.status, 0, `the process died (an unhandled rejection exits the gateway): ${r.stderr}`);
  assert.equal(r.clean, true);
  assert.equal(r.out.warmOk, false);
  assert.ok(r.out.stats.resets >= 2, `several rebuilds: ${JSON.stringify(r.out.stats)}`);
  assert.ok(r.out.stats.flush_timeouts >= 6);
  assert.equal(r.out.stats.written, 0);
  assert.equal(r.out.stats.inflight, 0, 'nothing left pinning the cap');
  assert.ok(r.out.events.includes('price_cache_store_reset'));
});

test('(2) a hung connection: after the rebuild the store writes through a NEW connection as soon as Firestore answers', { timeout: 90000 }, () => {
  const r = sim('hung');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.clean, true);
  assert.equal(r.out.warmOk, true);
  assert.equal(r.out.writtenBefore, 1);
  assert.ok(r.out.resets >= 1);
  assert.notEqual(r.out.msToRecover, null, `never wrote again after the connection hung: ${JSON.stringify(r.out)}`);
  assert.ok(r.out.msToRecover < 3000);
  assert.deepEqual(r.out.databases, ['projects/cache-project-test/databases/price-cache']);
});
