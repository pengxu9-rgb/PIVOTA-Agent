'use strict';

// The gateway wiring of the kernel's charge_pending reconcile (src/services/kernelChargePendingReconcile.js). The
// rules themselves are tested in safety-kernel/test/reconcileUncorrelated.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/kernelChargePendingReconcile');

const quiet = { info() {}, warn() {} };

test('mode: off unless exactly observe or apply', () => {
  assert.equal(svc.readMode({}), 'off');
  for (const v of ['', '0', '1', 'true', 'on', 'yes', 'dry_run', 'applyy']) assert.equal(svc.readMode({ [svc.MODE_ENV]: v }), 'off', v);
  assert.equal(svc.readMode({ [svc.MODE_ENV]: ' Observe ' }), 'observe');
  assert.equal(svc.readMode({ [svc.MODE_ENV]: 'APPLY' }), 'apply');
});

test('config: numbers are passed through for the kernel to clamp; unset stays unset', () => {
  const cfg = svc.readReconcileConfig({
    [svc.MODE_ENV]: 'observe',
    KERNEL_CHARGE_PENDING_RECONCILE_BATCH_SIZE: '10',
    KERNEL_CHARGE_PENDING_RECONCILE_READS_PER_SECOND: '0.5',
    KERNEL_CHARGE_PENDING_RECONCILE_DEADLINE_MS: 'abc',
  });
  assert.equal(cfg.mode, 'observe');
  assert.equal(cfg.batchSize, 10);
  assert.equal(cfg.readsPerSecond, 0.5);
  assert.ok(Number.isNaN(cfg.deadlineMs));
  assert.equal(cfg.minAgeMs, undefined);
});

test('interval: default 5 min, clamped to 1 min .. 1 h', () => {
  assert.equal(svc.readIntervalMs({}), 5 * 60 * 1000);
  assert.equal(svc.readIntervalMs({ KERNEL_CHARGE_PENDING_RECONCILE_INTERVAL_MS: '1000' }), 60 * 1000);
  assert.equal(svc.readIntervalMs({ KERNEL_CHARGE_PENDING_RECONCILE_INTERVAL_MS: String(10 * 60 * 60 * 1000) }), 60 * 60 * 1000);
  assert.equal(svc.readIntervalMs({ KERNEL_CHARGE_PENDING_RECONCILE_INTERVAL_MS: 'x' }), 5 * 60 * 1000);
});

test('backend reader: one GET of the v2 order route, every status answered raw, no retry', async () => {
  const calls = [];
  const read = svc.createBackendOrderReader({
    httpGet: async (url, config) => { calls.push({ url, config }); return { status: 404, data: { detail: 'Order not found' } }; },
    baseUrl: 'https://backend.example.test/',
    authHeaders: () => ({ 'X-API-Key': 'k' }),
  });
  const r = await read('ord/1 x', { timeoutMs: 1234 });
  assert.deepEqual(r, { status: 404, body: { detail: 'Order not found' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://backend.example.test/agent/v2/orders/ord%2F1%20x');
  assert.equal(calls[0].config.timeout, 1234);
  assert.equal(calls[0].config.headers['X-API-Key'], 'k');
  assert.equal(calls[0].config.validateStatus(500), true);
  assert.equal(calls[0].config.method, undefined, 'a GET (httpGet), never a write');
  const failing = svc.createBackendOrderReader({ httpGet: async () => { throw new Error('ECONNRESET'); }, baseUrl: 'x', authHeaders: () => ({}) });
  await assert.rejects(failing('o1', { timeoutMs: 1 }), /ECONNRESET/);
});

function fakeTimers() {
  const t = { timeouts: [], intervals: [] };
  t.setTimeoutFn = (fn, ms) => { t.timeouts.push({ fn, ms }); return { unref() {} }; };
  t.setIntervalFn = (fn, ms) => { t.intervals.push({ fn, ms }); return { unref() {} }; };
  return t;
}

test('start: flag off at boot schedules nothing and builds nothing', () => {
  const timers = fakeTimers();
  let mountBuilt = false;
  const r = svc.startKernelChargePendingReconcile({
    env: {}, db: { query() {} }, getMount: async () => { mountBuilt = true; }, readBackendOrder: async () => ({}), logger: quiet, ...timers,
  });
  assert.deepEqual(r, { scheduled: false, reason: 'off' });
  assert.equal(timers.timeouts.length + timers.intervals.length, 0);
  assert.equal(mountBuilt, false);
});

test('start: no durable store, nothing scheduled', () => {
  const timers = fakeTimers();
  const r = svc.startKernelChargePendingReconcile({ env: { [svc.MODE_ENV]: 'observe' }, db: null, getMount: async () => ({}), readBackendOrder: async () => ({}), logger: quiet, ...timers });
  assert.deepEqual(r, { scheduled: false, reason: 'no_durable_store' });
  assert.equal(timers.timeouts.length, 0);
});

function fakeKernelModule(record) {
  return async () => ({
    normalizeConfig: (c) => ({ ...c, deadlineMs: 60_000 }),
    makePostgresListCandidates: ({ db, namespace }) => { record.lister = { db, namespace }; return async () => []; },
    makeStoreLease: (store, opts) => { record.lease = { store, opts }; return { acquire: async () => true, release: async () => {} }; },
    makeStoreCursor: (store) => { record.cursorStore = store; return { get: async () => null, set: async () => {} }; },
    reconcileUncorrelatedChargePending: async (deps) => { record.runs.push(deps); if (record.block) await record.block; return { mode: deps.mode, scanned: 0 }; },
  });
}

test('start: schedules a jittered first tick, then the interval; a tick runs the kernel reconcile on the durable store', async () => {
  const timers = fakeTimers();
  const record = { runs: [] };
  const db = { query() {} };
  const kernel = { settleUncorrelatedCharge() {} };
  const stateStores = [];
  const mount = { durable: true, kernel, stateStore: (ns) => { stateStores.push(ns); return { ns }; } };
  const env = { [svc.MODE_ENV]: 'observe' };
  const r = svc.startKernelChargePendingReconcile({
    env, db, getMount: async () => mount, readBackendOrder: async () => ({}), logger: quiet,
    loadKernelModule: fakeKernelModule(record), instanceId: 'inst', ...timers,
  });
  assert.equal(r.scheduled, true);
  assert.equal(timers.timeouts.length, 1);
  assert.ok(timers.timeouts[0].ms >= r.intervalMs / 2 && timers.timeouts[0].ms <= r.intervalMs, 'first tick jittered into the second half of an interval');
  timers.timeouts[0].fn();
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].ms, r.intervalMs);
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setImmediate(res));
  assert.equal(record.runs.length, 1);
  const deps = record.runs[0];
  assert.equal(deps.mode, 'observe');
  assert.equal(deps.kernel, kernel);
  assert.deepEqual(record.lister, { db, namespace: 'orders' });
  assert.deepEqual(stateStores, [svc.LEASE_NAMESPACE]);
  assert.equal(record.cursorStore, record.lease.store, 'the cursor lives beside the lease');
  assert.equal(typeof deps.cursor?.get, 'function');
  assert.equal(record.lease.opts.owner, 'inst:1');
  assert.equal(record.lease.opts.ttlMs, 90_000, 'lease outlives the run deadline');
  // The mode is read again per tick: off now, so the next tick does nothing.
  env[svc.MODE_ENV] = 'off';
  assert.deepEqual(await r.tick(), { skipped: 'off' });
  assert.equal(record.runs.length, 1);
});

test('tick: one run at a time per instance; a non-durable kernel and a failing run are logged and skipped', async () => {
  const record = { runs: [] };
  let release;
  record.block = new Promise((res) => { release = res; });
  const mount = { durable: true, kernel: {}, stateStore: () => ({}) };
  const warns = [];
  const logger = { info() {}, warn: (f) => warns.push(f) };
  const r = svc.startKernelChargePendingReconcile({
    env: { [svc.MODE_ENV]: 'apply' }, db: { query() {} }, getMount: async () => mount, readBackendOrder: async () => ({}), logger,
    loadKernelModule: fakeKernelModule(record), ...fakeTimers(),
  });
  const first = r.tick();
  assert.deepEqual(await r.tick(), { skipped: 'in_flight' });
  release();
  await first;
  assert.equal(record.runs.length, 1);
  mount.durable = false;
  assert.deepEqual(await r.tick(), { skipped: 'kernel_not_durable' });
  mount.durable = true;
  const failing = svc.startKernelChargePendingReconcile({
    env: { [svc.MODE_ENV]: 'apply' }, db: { query() {} }, getMount: async () => { throw new Error('mount failed'); }, readBackendOrder: async () => ({}), logger,
    loadKernelModule: fakeKernelModule(record), ...fakeTimers(),
  });
  assert.deepEqual(await failing.tick(), { skipped: 'run_failed' });
  assert.ok(warns.some((w) => w.reason === 'run_failed'));
  assert.deepEqual(await failing.tick(), { skipped: 'run_failed' }, 'a failed run does not wedge the in-flight guard');
});

test('the real kernel module loads and exposes what the wiring calls', async () => {
  const mod = await import('../safety-kernel/src/reconcileUncorrelated.js');
  for (const fn of ['normalizeConfig', 'makePostgresListCandidates', 'makeStoreLease', 'makeStoreCursor', 'reconcileUncorrelatedChargePending']) {
    assert.equal(typeof mod[fn], 'function', fn);
  }
});

test('server.js starts it with the kernel mount, the DB, and the backend read on the gateway service key', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const i = src.indexOf('kernelChargePendingReconcile.startKernelChargePendingReconcile({');
  assert.ok(i > 0, 'wired');
  const block = src.slice(i, src.indexOf('\n      });\n', i));
  assert.match(block, /getMount: getCommerceMount/);
  assert.match(block, /db: process\.env\.DATABASE_URL \? \{ query \} : null/);
  assert.match(block, /httpGet: \(url, config\) => axios\.get\(url, config\)/);
  assert.match(block, /forceInternalFallback: true/);
  assert.match(block, /forwardAgentUserJwt: false/);
  assert.match(block, /forwardBuyerRef: false/);
});
