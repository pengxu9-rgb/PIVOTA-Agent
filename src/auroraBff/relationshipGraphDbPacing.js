'use strict';

// Duty-cycle pacing for relationship-graph database streams. pivota-pg has 2 vCPU, and a stream
// of back-to-back queries on one connection keeps one core busy: about 0.5 CPU utilization
// before any other load, however cheap each query is (2026-10-15: build-once cut a drain batch's
// relgraph query time ~4.5x, 320 s -> 71 s, and its per-minute CPU peaks stayed at 0.57-0.64).
// After each paced query, the caller sleeps duty x that query's duration, so the stream holds
// the database at most 1 / (1 + duty) of the time: duty 1 keeps relgraph at ~0.25 utilization.
//
// RELGRAPH_DB_DUTY_CYCLE: the ratio (0 or unset = off, the default: no timing, no sleep).
// RELGRAPH_DB_DUTY_CYCLE_MAX_SLEEP_MS: the cap on one sleep (default 10000).
// Only the relgraph-sync job is meant to set them; nothing reads them at request time.
const MAX_DUTY_CYCLE = 10;
const DEFAULT_MAX_SLEEP_MS = 10000;
const MAX_MAX_SLEEP_MS = 60000;

function dbDutyCycle() {
  const n = Number(process.env.RELGRAPH_DB_DUTY_CYCLE);
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_DUTY_CYCLE, n) : 0;
}

function dbDutyCycleMaxSleepMs() {
  const raw = process.env.RELGRAPH_DB_DUTY_CYCLE_MAX_SLEEP_MS;
  const n = Number(raw);
  return raw == null || raw === '' || !Number.isFinite(n) || n < 0
    ? DEFAULT_MAX_SLEEP_MS : Math.min(MAX_MAX_SLEEP_MS, Math.trunc(n));
}

// The sleep for a query that took elapsedMs, bounded by the per-sleep cap; 0 when pacing is off.
function pacingSleepMs(elapsedMs) {
  const duty = dbDutyCycle();
  if (!duty) return 0;
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  return Math.min(dbDutyCycleMaxSleepMs(), Math.round(elapsed * duty));
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sleep = realSleep;

// Runs fn and, when pacing is on and fn succeeded, sleeps in proportion to its duration.
// Off: returns fn() unchanged. A failure is thrown at once, without a sleep.
async function pacedDbCall(fn) {
  if (!dbDutyCycle()) return fn();
  const startedAt = Date.now();
  const result = await fn();
  const ms = pacingSleepMs(Date.now() - startedAt);
  if (ms > 0) await sleep(ms);
  return result;
}

module.exports = { dbDutyCycle, dbDutyCycleMaxSleepMs, pacingSleepMs, pacedDbCall,
  // Tests observe (and may shorten) the sleeps; null restores the real timer.
  __setSleepForTests(fn) { sleep = typeof fn === 'function' ? fn : realSleep; } };
