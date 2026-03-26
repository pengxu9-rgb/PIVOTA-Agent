const {
  queryResolveSearchFallback,
} = require('../../src/commerce/catalog/queryResolveSearchFallback');

function createBaseArgs(overrides = {}) {
  return {
    queryParams: { query: 'ipsa', lang: 'en' },
    checkoutToken: 'checkout-token',
    reason: 'resolver_after_primary',
    requestSource: 'shopping_agent',
    fetchDetail: true,
    timeoutMs: 800,
    extractSearchQueryText: (query) => String(query?.query || '').trim(),
    firstQueryParamValue: (value) => {
      if (Array.isArray(value)) return value[0];
      return value;
    },
    parseQueryStringArray: (value) => {
      if (Array.isArray(value)) return value.map(String);
      if (value == null || value === '') return [];
      return [String(value)];
    },
    uniqueStrings: (values) => Array.from(new Set(values.filter(Boolean))),
    parseQueryBoolean: (value) => {
      if (value == null || value === '') return undefined;
      return String(value).trim().toLowerCase() === 'true';
    },
    proxySearchResolverTimeoutMs: 500,
    buildProxySearchResolverCacheKey: jest.fn(() => 'resolver-cache-key'),
    getProxySearchResolverCacheEntry: jest.fn(() => null),
    buildResolverQueryCandidates: jest.fn(() => ['ipsa']),
    resolveStableAliasByQuery: null,
    normalizeResolverText: (text) => String(text || '').trim().toLowerCase(),
    tokenizeResolverQuery: (text) => String(text || '').split(/\s+/).filter(Boolean),
    resolveProductRef: jest.fn(async () => ({
      resolved: false,
      reason: 'no_candidates',
      reason_code: 'no_candidates',
      metadata: { latency_ms: 10, sources: [{ source: 'resolver', ok: false, reason: 'no_results' }] },
    })),
    getProxySearchApiBase: () => 'http://resolver.test',
    pivotaApiKey: 'resolver-key',
    setProxySearchResolverCacheEntry: jest.fn(),
    proxySearchResolverMissCacheTtlMs: 3000,
    proxySearchResolverCacheTtlMs: 15000,
    proxySearchResolverDetailEnabled: true,
    proxySearchResolverDetailTimeoutMs: 900,
    isLookupStyleSearchQuery: jest.fn(() => false),
    extractSearchAnchorTokens: jest.fn(() => []),
    normalizeAgentProductsListResponse: jest.fn((value) => value),
    countUsableSearchProducts: jest.fn((products) => (Array.isArray(products) ? products.length : 0)),
    withProxySearchFallbackMetadata: jest.fn((body, patch) => ({
      ...(body || {}),
      metadata: {
        ...((body && body.metadata) || {}),
        proxy_search_fallback: patch,
      },
    })),
    finalizeResolveSearchFallbackResult: jest.fn(),
    logger: {
      warn: jest.fn(),
    },
    ...overrides,
  };
}

describe('queryResolveSearchFallback', () => {
  test('returns cached result before invoking resolver', async () => {
    const cached = { status: 200, usableCount: 1, data: { products: [{ product_id: 'cached' }] } };
    const args = createBaseArgs({
      getProxySearchResolverCacheEntry: jest.fn(() => cached),
    });

    const result = await queryResolveSearchFallback(args);

    expect(result).toBe(cached);
    expect(args.resolveProductRef).not.toHaveBeenCalled();
    expect(args.finalizeResolveSearchFallbackResult).not.toHaveBeenCalled();
  });

  test('returns and caches miss result when resolver cannot produce a product ref', async () => {
    const args = createBaseArgs();

    const result = await queryResolveSearchFallback(args);

    expect(args.resolveProductRef).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'ipsa',
        pivotaApiBase: 'http://resolver.test',
        pivotaApiKey: 'resolver-key',
      }),
    );
    expect(args.setProxySearchResolverCacheEntry).toHaveBeenCalledWith(
      'resolver-cache-key',
      expect.objectContaining({
        status: 200,
        usableCount: 0,
        resolved: false,
        resolve_reason_code: 'no_candidates',
      }),
      3000,
    );
    expect(result).toMatchObject({
      status: 200,
      usableCount: 0,
      resolved: false,
      resolve_reason_code: 'no_candidates',
    });
    expect(args.finalizeResolveSearchFallbackResult).not.toHaveBeenCalled();
  });
});
