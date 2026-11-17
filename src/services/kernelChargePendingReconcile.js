'use strict';

/*
 * kernelChargePendingReconcile.js — runs the kernel's charge_pending reconcile on a gateway interval
 * (safety-kernel/src/reconcileUncorrelated.js has the rules; this file has only the wiring).
 *
 * WHERE IT RUNS, AND WHY HERE. A gateway interval, beside the other periodic work this process already does on
 * setInterval (creator catalog auto-sync, PDP identity auto-resolve, PDP prewarm, all in src/server.js). The rows it
 * settles are the kernel's own (commerce_kv, namespace `orders`), written through the kernel's store classes, and
 * the backend read it needs goes out on this gateway's own service key: both live in this process. This repo has no
 * scheduled-job image or job deploy path, so a job would first need one. Every instance schedules the tick; a run
 * lease in the kernel's own store lets one of them run it at a time.
 *
 * FLAG. KERNEL_CHARGE_PENDING_RECONCILE_MODE = off (default) | observe | apply. Off: nothing is scheduled. Observe:
 * reads the backend and logs what it would do, writing nothing. Apply: also settles. Any other value is off. The
 * mode is read again on every tick.
 *
 * BOUNDS (all optional, clamped; safety-kernel/src/reconcileUncorrelated.js RECONCILE_DEFAULTS has the defaults):
 *   KERNEL_CHARGE_PENDING_RECONCILE_INTERVAL_MS       how often a tick starts (default 5 min, 1 min .. 1 h)
 *   KERNEL_CHARGE_PENDING_RECONCILE_BATCH_SIZE        charge_pending rows per run
 *   KERNEL_CHARGE_PENDING_RECONCILE_RECHECK_BATCH_SIZE  expired rows re-read per run for a late payment
 *   KERNEL_CHARGE_PENDING_RECONCILE_MIN_AGE_MS        a row younger than this may still be in flight: not read
 *   KERNEL_CHARGE_PENDING_RECONCILE_MAX_AGE_MS        a row older than this is left to ops
 *   KERNEL_CHARGE_PENDING_RECONCILE_SESSION_MAX_AGE_MS  longer than any hosted session lives
 *   KERNEL_CHARGE_PENDING_RECONCILE_RECHECK_WINDOW_MS how long an expired row is re-read
 *   KERNEL_CHARGE_PENDING_RECONCILE_READS_PER_SECOND  backend reads per second
 *   KERNEL_CHARGE_PENDING_RECONCILE_DEADLINE_MS       a run stops reading at this
 *   KERNEL_CHARGE_PENDING_RECONCILE_READ_TIMEOUT_MS   one backend read's timeout
 */

const ENV_PREFIX = 'KERNEL_CHARGE_PENDING_RECONCILE_';
const MODE_ENV = `${ENV_PREFIX}MODE`;
const LEASE_NAMESPACE = 'kernel_charge_pending_reconcile';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 60 * 60 * 1000;

const CONFIG_ENV = Object.freeze({
  batchSize: 'BATCH_SIZE',
  recheckBatchSize: 'RECHECK_BATCH_SIZE',
  minAgeMs: 'MIN_AGE_MS',
  maxAgeMs: 'MAX_AGE_MS',
  sessionMaxAgeMs: 'SESSION_MAX_AGE_MS',
  recheckWindowMs: 'RECHECK_WINDOW_MS',
  readsPerSecond: 'READS_PER_SECOND',
  deadlineMs: 'DEADLINE_MS',
  readTimeoutMs: 'READ_TIMEOUT_MS',
});

function readMode(env = process.env) {
  const raw = String(env[MODE_ENV] || '').trim().toLowerCase();
  return raw === 'observe' || raw === 'apply' ? raw : 'off';
}

/** The raw run config from the environment (the kernel module clamps it). */
function readReconcileConfig(env = process.env) {
  const out = { mode: readMode(env) };
  for (const [key, suffix] of Object.entries(CONFIG_ENV)) {
    const raw = String(env[`${ENV_PREFIX}${suffix}`] ?? '').trim();
    out[key] = raw === '' ? undefined : Number(raw);
  }
  return out;
}

function readIntervalMs(env = process.env) {
  const n = Number(String(env[`${ENV_PREFIX}INTERVAL_MS`] ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.floor(n)));
}

/**
 * The backend's own order read, GET {base}/agent/v2/orders/{order_id}, answered raw ({ status, body }) for the
 * kernel module's projection. Every HTTP status is an answer here (the projection treats all but 200 as "could not
 * read"); a transport failure throws and is treated the same way. Nothing is retried: the next tick reads again.
 *
 * @param {{ httpGet: (url:string, config:object) => Promise<{status:number, data:any}>, baseUrl: string,
 *           authHeaders: () => object }} deps
 */
function createBackendOrderReader({ httpGet, baseUrl, authHeaders }) {
  if (typeof httpGet !== 'function') throw new Error('createBackendOrderReader requires httpGet');
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return async (orderId, { timeoutMs } = {}) => {
    const resp = await httpGet(`${base}/agent/v2/orders/${encodeURIComponent(orderId)}`, {
      headers: { 'Content-Type': 'application/json', ...(typeof authHeaders === 'function' ? authHeaders() : {}) },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    return { status: resp?.status, body: resp?.data };
  };
}

/**
 * Schedule the reconcile tick. Returns { scheduled:false, reason } when the flag is off at boot (nothing is
 * scheduled at all), or when there is no durable kernel store to settle.
 *
 * @param {{
 *   env?: object, getMount: () => Promise<object>, db: { query: Function } | null,
 *   readBackendOrder: Function, logger: object, loadKernelModule?: () => Promise<object>,
 *   setTimeoutFn?: Function, setIntervalFn?: Function, instanceId?: string, initialDelayMs?: number,
 * }} deps
 */
function startKernelChargePendingReconcile(deps = {}) {
  const {
    env = process.env, getMount, db, readBackendOrder, logger,
    loadKernelModule = () => import('../../safety-kernel/src/reconcileUncorrelated.js'),
    setTimeoutFn = setTimeout, setIntervalFn = setInterval,
    instanceId = `gw-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  } = deps;
  if (readMode(env) === 'off') return { scheduled: false, reason: 'off' };
  if (!db || typeof db.query !== 'function') {
    logger?.warn?.({ event: 'kernel_charge_pending_reconcile', reason: 'no_durable_store' }, 'kernel charge_pending reconcile not scheduled: no DATABASE_URL');
    return { scheduled: false, reason: 'no_durable_store' };
  }
  const intervalMs = readIntervalMs(env);
  let inFlight = false;
  let tickNo = 0;

  const tick = async () => {
    if (inFlight) return { skipped: 'in_flight' };
    const cfg = readReconcileConfig(env);
    if (cfg.mode === 'off') return { skipped: 'off' };
    inFlight = true;
    tickNo += 1;
    try {
      const mod = await loadKernelModule();
      const mount = await getMount();
      if (!mount || !mount.durable || typeof mount.stateStore !== 'function') {
        logger?.warn?.({ event: 'kernel_charge_pending_reconcile', reason: 'kernel_not_durable' }, 'kernel charge_pending reconcile skipped');
        return { skipped: 'kernel_not_durable' };
      }
      const normalized = mod.normalizeConfig(cfg);
      const state = mount.stateStore(LEASE_NAMESPACE);
      return await mod.reconcileUncorrelatedChargePending({
        ...normalized,
        kernel: mount.kernel,
        listCandidates: mod.makePostgresListCandidates({ db, namespace: 'orders' }),
        readBackendOrder,
        lease: mod.makeStoreLease(state, {
          owner: `${instanceId}:${tickNo}`,
          ttlMs: normalized.deadlineMs + 30 * 1000,
        }),
        // Where the last run stopped, so rows it held never starve the rows behind them.
        cursor: mod.makeStoreCursor(state),
        log: logger,
      });
    } catch (err) {
      logger?.warn?.({ event: 'kernel_charge_pending_reconcile', reason: 'run_failed', err: err?.message || String(err) }, 'kernel charge_pending reconcile run failed');
      return { skipped: 'run_failed' };
    } finally {
      inFlight = false;
    }
  };

  // Jittered first run, so instances that boot together after a deploy do not all reach for the lease at once.
  const initialDelayMs = Number.isFinite(deps.initialDelayMs)
    ? deps.initialDelayMs
    : Math.floor(intervalMs / 2 + Math.random() * (intervalMs / 2));
  const startTimer = setTimeoutFn(() => {
    tick();
    const t = setIntervalFn(tick, intervalMs);
    if (t && typeof t.unref === 'function') t.unref();
  }, initialDelayMs);
  if (startTimer && typeof startTimer.unref === 'function') startTimer.unref();
  logger?.info?.({ event: 'kernel_charge_pending_reconcile', mode: readMode(env), interval_ms: intervalMs }, 'kernel charge_pending reconcile scheduled');
  return { scheduled: true, intervalMs, tick };
}

module.exports = {
  MODE_ENV,
  LEASE_NAMESPACE,
  readMode,
  readReconcileConfig,
  readIntervalMs,
  createBackendOrderReader,
  startKernelChargePendingReconcile,
};
