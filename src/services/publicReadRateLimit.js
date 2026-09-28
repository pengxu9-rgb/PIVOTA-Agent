'use strict';

// Minimal in-memory per-key token bucket for the PUBLIC (auth:none) read MCP tier. Deliberately
// dependency-free and process-local: the public tier serves stateless reads, so a per-instance limit is an
// abuse valve, not an accounting system. Unknown/empty keys share one bucket (still bounded, never open).

function createTokenBucketLimiter({
  capacity = 20,
  refillPerSecond = 1,
  maxKeys = 10000,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();
  // A bucket idle long enough to have fully refilled carries no state worth keeping.
  const idleMs = Math.max(60_000, Math.ceil((capacity / refillPerSecond) * 2000));

  function allow(key) {
    const k = typeof key === 'string' && key ? key : 'unknown';
    const t = now();
    let bucket = buckets.get(k);
    if (!bucket) {
      // Opportunistic pruning (no timer) keeps the map bounded; a pathological flood of distinct keys
      // resets the map rather than growing it — new callers start with a full bucket either way.
      if (buckets.size >= maxKeys) prune(t);
      if (buckets.size >= maxKeys) buckets.clear();
      bucket = { tokens: capacity, at: t };
      buckets.set(k, bucket);
    } else {
      const elapsedSec = Math.max(0, (t - bucket.at) / 1000);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond);
      bucket.at = t;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  function prune(t) {
    for (const [k, bucket] of buckets) {
      if (t - bucket.at > idleMs) buckets.delete(k);
    }
  }

  function size() {
    return buckets.size;
  }

  return { allow, size };
}

// How many entries X-Forwarded-For carried, logged once per (door, count) per process — the COUNT only,
// never an address. The rate-limit key trusts the Nth entry from the right (gatewayGuardrails
// clientIpFromRequest), so N is only right if our edge appends exactly N entries; this is the evidence.
// Counts at or above XFF_ENTRIES_CAP report as the cap, so a caller padding the header cannot mint new
// log lines: the set of distinct lines is bounded by doors x (cap + 1).
const XFF_ENTRIES_CAP = 10;

function createForwardedForShapeRecorder({ log } = {}) {
  const seen = new Set();

  function record(req, door) {
    const entries = String(req?.headers?.['x-forwarded-for'] || '')
      .split(',')
      .filter((part) => part.trim()).length;
    const xffEntries = Math.min(entries, XFF_ENTRIES_CAP);
    const seenKey = `${door}:${xffEntries}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    log?.info?.({ event: 'public_read_xff_shape', door, xff_entries: xffEntries }, 'public read forwarded-for shape');
  }

  return record;
}

module.exports = { createTokenBucketLimiter, createForwardedForShapeRecorder, XFF_ENTRIES_CAP };
