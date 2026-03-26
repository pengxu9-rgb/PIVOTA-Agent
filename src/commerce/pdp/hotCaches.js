function parseTimeoutMs(envValue, fallbackMs) {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
}

function safeCloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

const resolveProductCandidatesCacheEnabled =
  process.env.RESOLVE_PRODUCT_CANDIDATES_CACHE_ENABLED !== 'false';
const resolveProductCandidatesCache = new Map();
const resolveProductCandidatesCacheMetrics = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
};
const resolveProductCandidatesTtlMs = parseTimeoutMs(
  process.env.RESOLVE_PRODUCT_CANDIDATES_TTL_MS,
  60 * 1000,
);

const resolveProductGroupCacheEnabled =
  process.env.RESOLVE_PRODUCT_GROUP_CACHE_ENABLED !== 'false';
const resolveProductGroupCache = new Map();
const resolveProductGroupCacheMetrics = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
};
const resolveProductGroupCacheTtlMs = parseTimeoutMs(
  process.env.RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS,
  10 * 60 * 1000,
);

function getResolveProductCandidatesCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = resolveProductCandidatesCache.get(key);
  if (!hit) {
    resolveProductCandidatesCacheMetrics.misses += 1;
    return null;
  }
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    resolveProductCandidatesCache.delete(key);
    resolveProductCandidatesCacheMetrics.misses += 1;
    return null;
  }
  resolveProductCandidatesCacheMetrics.hits += 1;
  return hit;
}

function setResolveProductCandidatesCache(
  cacheKey,
  value,
  ttlMs = resolveProductCandidatesTtlMs,
) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Number(ttlMs) || resolveProductCandidatesTtlMs;
  resolveProductCandidatesCacheMetrics.sets += 1;
  resolveProductCandidatesCache.set(key, {
    value,
    storedAtMs: Date.now(),
    expiresAtMs: Date.now() + Math.max(5_000, ttl),
  });
}

function snapshotResolveProductCandidatesCacheStats() {
  return {
    enabled: resolveProductCandidatesCacheEnabled,
    ttl_ms: resolveProductCandidatesTtlMs,
    size: resolveProductCandidatesCache.size,
    ...resolveProductCandidatesCacheMetrics,
  };
}

function getResolveProductGroupCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = resolveProductGroupCache.get(key);
  if (!hit) {
    resolveProductGroupCacheMetrics.misses += 1;
    return null;
  }
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    resolveProductGroupCache.delete(key);
    resolveProductGroupCacheMetrics.misses += 1;
    return null;
  }
  resolveProductGroupCacheMetrics.hits += 1;
  return hit;
}

function setResolveProductGroupCache(
  cacheKey,
  value,
  ttlMs = resolveProductGroupCacheTtlMs,
) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Number(ttlMs) || resolveProductGroupCacheTtlMs;
  resolveProductGroupCacheMetrics.sets += 1;
  resolveProductGroupCache.set(key, {
    value: safeCloneJson(value),
    storedAtMs: Date.now(),
    expiresAtMs: Date.now() + Math.max(5_000, ttl),
  });
}

function snapshotResolveProductGroupCacheStats() {
  return {
    enabled: resolveProductGroupCacheEnabled,
    ttl_ms: resolveProductGroupCacheTtlMs,
    size: resolveProductGroupCache.size,
    ...resolveProductGroupCacheMetrics,
  };
}

function resetPdpHotCachesForTest() {
  resolveProductCandidatesCache.clear();
  resolveProductGroupCache.clear();
  for (const key of Object.keys(resolveProductCandidatesCacheMetrics)) {
    resolveProductCandidatesCacheMetrics[key] = 0;
  }
  for (const key of Object.keys(resolveProductGroupCacheMetrics)) {
    resolveProductGroupCacheMetrics[key] = 0;
  }
}

module.exports = {
  resolveProductCandidatesCacheEnabled,
  resolveProductCandidatesCacheMetrics,
  resolveProductCandidatesTtlMs,
  getResolveProductCandidatesCacheEntry,
  setResolveProductCandidatesCache,
  snapshotResolveProductCandidatesCacheStats,
  resolveProductGroupCacheEnabled,
  resolveProductGroupCacheMetrics,
  resolveProductGroupCacheTtlMs,
  getResolveProductGroupCacheEntry,
  setResolveProductGroupCache,
  snapshotResolveProductGroupCacheStats,
  resetPdpHotCachesForTest,
};
