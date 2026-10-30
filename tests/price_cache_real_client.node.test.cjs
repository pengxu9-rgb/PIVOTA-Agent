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
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// The client is the real one, so it looks for credentials like the gateway does. With none on the machine (CI), it
// falls back to the GCP metadata server: a probe of 169.254.169.254 and metadata.google.internal, and an unhandled
// MetadataLookupWarning rejection when that fails. A placeholder service account ends the search before that, and
// METADATA_SERVER_DETECTION=none rules the metadata server out for anything that looks anyway. (A machine with gcloud
// application-default credentials never gets that far, which is why only CI saw it.) Nothing signs with the
// placeholder: the loopback servers are plaintext gRPC (ssl: false), where the client sends no auth.
const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-cache-real-client-'));
const fakeCredentials = path.join(credsDir, 'service-account.json');
fs.writeFileSync(fakeCredentials, JSON.stringify({
  type: 'service_account',
  project_id: 'cache-project-test',
  private_key_id: 'placeholder',
  private_key: '-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n',
  client_email: 'price-cache-test@cache-project-test.iam.gserviceaccount.com',
  client_id: '0',
}));
test.after(() => fs.rmSync(credsDir, { recursive: true, force: true }));

function sim(scenario) {
  const r = spawnSync(process.execPath, [...process.execArgv.filter((a) => !a.startsWith('--test')), path.join(__dirname, '_support', 'priceCacheRealClientSim.cjs'), scenario], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: fakeCredentials, METADATA_SERVER_DETECTION: 'none', FIRESTORE_EMULATOR_HOST: '' },
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
  assert.equal(r.out.stats.resets, 5, `rebuilt until the cap, then no more: ${JSON.stringify(r.out.stats)}`);
  assert.equal(r.out.stats.disabled, true);
  assert.equal(r.out.stats.flush_timeouts, 15, '3 timeouts per reset, 5 resets, none after');
  assert.equal(r.out.stats.dropped, 5, 'the 5 writes after disabling are dropped and counted, never queued');
  assert.ok(r.out.events.includes('price_cache_store_disabled'));
  assert.equal(r.out.stats.written, 0);
  // Every queued write is accounted for exactly once (writes dropped after disabling were never queued), and only the
  // current (unfinished) timeout streak can still be in flight: never the backlog of every rebuild.
  const st = r.out.stats;
  assert.equal(st.abandoned + st.inflight + st.written + st.failed + st.pending, st.queued, JSON.stringify(st));
  assert.ok(st.inflight <= 2, `nothing pinning the cap: ${JSON.stringify(st)}`);
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

test('the hazard behind B1, in the REAL library: terminate() on a client whose read is still being retried kills the process', { timeout: 90000 }, () => {
  // If a dependency upgrade makes this survive, terminate() became safe; the store still only drops clients.
  const r = sim('library_terminate');
  assert.notEqual(r.status, 0, `expected the process to die: ${JSON.stringify(r.out)}`);
  assert.equal(r.clean, false);
  assert.match(r.stderr, /already been terminated/);
});
