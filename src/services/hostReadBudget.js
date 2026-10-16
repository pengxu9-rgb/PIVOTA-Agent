'use strict';

/*
 * A per-merchant-host READ BUDGET for the PDP live reads, in this process: at most N merchant reads per host
 * per minute (UCP_LIVE_PDP_HOST_READS_PER_MIN, default 30, clamped 1..1000), shared by the server-side PDP
 * shadow read (shadowPdpLiveRead) and the browser's first-view refresh (pdp_live_read).
 *
 * The PDP cache's claim already reads one product x market at most once per ten minutes, and the lookup core
 * caps a store at 3 lookups in flight. This bounds what neither does: many DIFFERENT products of one store
 * read in a minute (a replayed set of valid tokens, a crawler sweeping a catalogue). A read over budget is
 * not made: the caller releases its claim and answers host_busy, as when the store's in-flight cap is full.
 */

const DEFAULT_READS_PER_MIN = 30;
const WINDOW_MS = 60 * 1000;
const MAX_HOSTS = 5000;

function hostReadsPerMinute(env = process.env) {
  const raw = String(env.UCP_LIVE_PDP_HOST_READS_PER_MIN ?? '').trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return DEFAULT_READS_PER_MIN;
  return Math.min(1000, Math.max(1, Math.floor(n)));
}

/**
 * @param {{ limit?: () => number, now?: () => number, windowMs?: number, maxHosts?: number }} opts
 * @returns {{ take(host: string): boolean, stats(): object }}
 */
function createHostReadBudget({ limit = () => hostReadsPerMinute(process.env), now = () => Date.now(), windowMs = WINDOW_MS, maxHosts = MAX_HOSTS } = {}) {
  const reads = new Map(); // host -> timestamps inside the window, oldest first
  return {
    /** True (and counted) when `host` has room for one more read in the window. */
    take(host) {
      const key = String(host || '').trim().toLowerCase();
      if (!key) return true;
      const t = now();
      const recent = (reads.get(key) || []).filter((at) => t - at < windowMs);
      reads.delete(key);
      if (recent.length >= limit()) {
        reads.set(key, recent);
        return false;
      }
      recent.push(t);
      reads.set(key, recent);
      while (reads.size > maxHosts) reads.delete(reads.keys().next().value);
      return true;
    },
    stats() {
      return { hosts: reads.size };
    },
  };
}

module.exports = { createHostReadBudget, hostReadsPerMinute, DEFAULT_READS_PER_MIN };
