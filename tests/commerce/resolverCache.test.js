const {
  proxySearchResolverCacheTtlMs,
  proxySearchResolverMissCacheTtlMs,
  buildProxySearchResolverCacheKey,
  getProxySearchResolverCacheEntry,
  setProxySearchResolverCacheEntry,
  __internal,
} = require('../../src/commerce/catalog/resolverCache');

describe('resolverCache', () => {
  beforeEach(() => {
    __internal.resetProxySearchResolverCache();
  });

  test('builds normalized cache key with timeout bucket', () => {
    const key = buildProxySearchResolverCacheKey({
      queryText: ' IPSA Aqua ',
      lang: 'EN',
      preferMerchants: ['m1', '', 'm2'],
      searchAllMerchants: true,
      fetchDetail: true,
      resolverTimeoutMs: 812,
    });

    expect(JSON.parse(key)).toEqual({
      q: 'ipsa aqua',
      lang: 'en',
      prefer_merchants: ['m1', 'm2'],
      search_all_merchants: true,
      fetch_detail: true,
      resolver_timeout_ms_bucket: 800,
    });
  });

  test('stores and returns cloned cache value', () => {
    setProxySearchResolverCacheEntry('cache-key', {
      data: { products: [{ product_id: 'p1' }] },
    });

    const first = getProxySearchResolverCacheEntry('cache-key');
    first.data.products[0].product_id = 'mutated';
    const second = getProxySearchResolverCacheEntry('cache-key');

    expect(second).toEqual({
      data: { products: [{ product_id: 'p1' }] },
    });
    expect(proxySearchResolverCacheTtlMs).toBeGreaterThanOrEqual(1000);
    expect(proxySearchResolverMissCacheTtlMs).toBeGreaterThanOrEqual(500);
  });
});
