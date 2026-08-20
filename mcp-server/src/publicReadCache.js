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
  // Optional PER-VALUE cache policy. Returns `null` to refuse the value entirely, or `{ttlMs, staleMs}` to
  // store it on its own clock. Default: keep everything on the shared clock, which is the behaviour the
  // public read tier has always had.
  //
  // TWO DISTINCT NEEDS, and they are not the same knob:
  //   REFUSE  — a caller whose upstream can answer HTTP-200 with a DEGRADED envelope uses `null` so a
  //             transient failure is not pinned for the whole TTL. `compute` throwing is not the only way
  //             an answer can be worth not keeping.
  //   SHORTEN — an answer that is probably true but expensive to be wrong about (an EMPTY search page,
  //             which renders as a confident negative) wants a much shorter clock, not exclusion. Refusing
  //             it outright removes caching from whatever share of traffic legitimately returns nothing —
  //             measured at 27-33% on this tier in 2026-08 — and hands an anonymous caller a free
  //             recompute of an 8-15s lane on every request.
  // Retained and still honored: the commerce surface (the AUTHENTICATED door) constructs this same cache
  // with `shouldCache: isCacheableSearchResult`. Renaming this option out from under it would not fail
  // loudly — the option would simply be ignored and degraded commerce responses would start being cached.
  // `cachePolicy` defaults to expressing `shouldCache`, so every existing caller keeps its exact behaviour
  // and only a caller that wants per-value clocks needs to know the new option exists.
  shouldCache = () => true,
  cachePolicy = (value) => (shouldCache(value) ? { ttlMs, staleMs } : null),
} = {}) {
  const entries = new Map(); // key → { value, at, ttlMs, staleMs } — clocks are PER ENTRY, see cachePolicy
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
  // Store `value` under its own clock, or drop the key when the policy refuses it. Dropping matters on the
  // revalidate path: an entry that has become un-storable (the lane started answering degraded) must not
  // keep being served from the previous good copy indefinitely.
  function store(key, value) {
    const policy = cachePolicy(value);
    if (!policy) return false;
    touch(key, {
      value,
      at: now(),
      ttlMs: Number.isFinite(policy.ttlMs) ? policy.ttlMs : ttlMs,
      staleMs: Number.isFinite(policy.staleMs) ? policy.staleMs : staleMs,
    });
    return true;
  }

  async function getOrCompute(key, compute) {
    const t = now();
    const hit = entries.get(key);
    if (hit) {
      const age = t - hit.at;
      const hitTtl = Number.isFinite(hit.ttlMs) ? hit.ttlMs : ttlMs;
      const hitStale = Number.isFinite(hit.staleMs) ? hit.staleMs : staleMs;
      if (age < hitTtl) {
        touch(key, hit); // LRU bump
        return hit.value;
      }
      if (age < hitStale) {
        // Serve stale now; revalidate once in the background.
        if (!inflight.has(key)) {
          inflight.add(key);
          Promise.resolve()
            .then(compute)
            .then((value) => { store(key, value); })
            .catch((err) => onRevalidateError(err, key)) // keep the stale entry on failure
            .finally(() => inflight.delete(key));
        }
        return hit.value;
      }
      entries.delete(key); // fully expired
    }
    const value = await compute(); // errors propagate, nothing cached
    store(key, value);
    return value;
  }

  return {
    getOrCompute,
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

export { createPublicReadCache, stableStringify };
