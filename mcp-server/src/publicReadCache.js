// Response cache for the PUBLIC (auth:none) read MCP tier — TTL + stale-while-revalidate LRU.
//
// Why: the mainline multi-merchant search costs ~8–15s per cold query (sequential recall legs + ranking —
// a search-perf workstream of its own). The public tier serves deterministic, slowly-changing catalog reads
// (the backend's own citation API already sends Cache-Control), so caching the PROJECTED (slim, leak-free)
// results is honest and makes repeat/popular queries answer in <100ms.
//
// Semantics:
//   - FRESH  (age < ttlMs): serve from cache.
//   - STALE  (ttlMs ≤ age < staleMs): serve from cache immediately AND kick one background revalidation
//     (single-flight — concurrent stale hits trigger only one refresh; a failed refresh keeps the stale entry).
//   - EXPIRED (age ≥ staleMs) or miss: compute inline; only SUCCESSES are cached (errors always propagate
//     and never poison the cache).
//
// Pure module: timers injected (`now`), no env reads — configuration happens at the wiring site.

function stableStringify(value) {
  // Deterministic key for plain-JSON tool args (sorted keys, arrays in order).
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function createPublicReadCache({
  ttlMs = 10 * 60 * 1000,
  staleMs = 60 * 60 * 1000,
  maxEntries = 300,
  now = () => Date.now(),
  onRevalidateError = () => {},
} = {}) {
  const entries = new Map(); // key → { value, at }
  const inflight = new Set(); // keys with a background revalidation running

  function touch(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  /**
   * Get-or-compute through the cache.
   * @param {string} key
   * @param {() => Promise<any>} compute produces the value on miss/expiry (and on background revalidation)
   * @returns {Promise<any>}
   */
  async function getOrCompute(key, compute) {
    const t = now();
    const hit = entries.get(key);
    if (hit) {
      const age = t - hit.at;
      if (age < ttlMs) {
        touch(key, hit); // LRU bump
        return hit.value;
      }
      if (age < staleMs) {
        // Serve stale now; revalidate once in the background.
        if (!inflight.has(key)) {
          inflight.add(key);
          Promise.resolve()
            .then(compute)
            .then((value) => touch(key, { value, at: now() }))
            .catch((err) => onRevalidateError(err, key)) // keep the stale entry on failure
            .finally(() => inflight.delete(key));
        }
        return hit.value;
      }
      entries.delete(key); // fully expired
    }
    const value = await compute(); // errors propagate, nothing cached
    touch(key, { value, at: now() });
    return value;
  }

  return {
    getOrCompute,
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

export { createPublicReadCache, stableStringify };
