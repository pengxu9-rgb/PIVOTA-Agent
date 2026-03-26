function parseTimeoutMs(raw, fallbackMs) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

function safeCloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

const proxySearchResolverCacheTtlMs = Math.max(
  5_000,
  parseTimeoutMs(process.env.PROXY_SEARCH_RESOLVER_CACHE_TTL_MS, 5 * 60 * 1000),
);
const proxySearchResolverMissCacheTtlMs = Math.max(
  2_000,
  parseTimeoutMs(process.env.PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS, 45 * 1000),
);
const proxySearchResolverCacheMaxEntries = Math.max(
  50,
  Number(process.env.PROXY_SEARCH_RESOLVER_CACHE_MAX_ENTRIES || 2000) || 2000,
);

const PROXY_SEARCH_RESOLVER_CACHE = new Map();

function buildProxySearchResolverCacheKey({
  queryText,
  lang,
  preferMerchants,
  searchAllMerchants,
  fetchDetail,
  resolverTimeoutMs,
}) {
  const timeoutBucket = Number.isFinite(Number(resolverTimeoutMs))
    ? Math.max(100, Math.round(Number(resolverTimeoutMs) / 50) * 50)
    : null;
  return JSON.stringify({
    q: String(queryText || '').trim().toLowerCase(),
    lang: String(lang || '').trim().toLowerCase() || 'en',
    prefer_merchants: Array.isArray(preferMerchants)
      ? preferMerchants.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    search_all_merchants: searchAllMerchants === true ? true : false,
    fetch_detail: fetchDetail === true,
    resolver_timeout_ms_bucket: timeoutBucket,
  });
}

function getProxySearchResolverCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = PROXY_SEARCH_RESOLVER_CACHE.get(key);
  if (!hit) return null;
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    PROXY_SEARCH_RESOLVER_CACHE.delete(key);
    return null;
  }
  return safeCloneJson(hit.value);
}

function setProxySearchResolverCacheEntry(
  cacheKey,
  value,
  ttlMs = proxySearchResolverCacheTtlMs,
) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Math.max(500, Number(ttlMs) || proxySearchResolverCacheTtlMs);
  while (PROXY_SEARCH_RESOLVER_CACHE.size >= proxySearchResolverCacheMaxEntries) {
    const firstKey = PROXY_SEARCH_RESOLVER_CACHE.keys().next().value;
    if (!firstKey) break;
    PROXY_SEARCH_RESOLVER_CACHE.delete(firstKey);
  }
  PROXY_SEARCH_RESOLVER_CACHE.set(key, {
    value: safeCloneJson(value),
    expiresAtMs: Date.now() + ttl,
  });
}

function resetProxySearchResolverCache() {
  PROXY_SEARCH_RESOLVER_CACHE.clear();
}

module.exports = {
  proxySearchResolverCacheTtlMs,
  proxySearchResolverMissCacheTtlMs,
  buildProxySearchResolverCacheKey,
  getProxySearchResolverCacheEntry,
  setProxySearchResolverCacheEntry,
  __internal: {
    resetProxySearchResolverCache,
  },
};
