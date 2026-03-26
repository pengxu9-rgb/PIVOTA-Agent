const {
  buildAuroraPrimaryIrrelevantSemanticRetryQueries,
  createProxySearchFallbackHelpers,
} = require('../../src/commerce/catalog/proxySearchFallbacks');

describe('proxySearchFallbacks', () => {
  test('buildAuroraPrimaryIrrelevantSemanticRetryQueries dedupes and limits retries', () => {
    const queries = buildAuroraPrimaryIrrelevantSemanticRetryQueries(
      'Brand Copper Tripeptide Serum',
      {
        normalizeSearchTextForMatch: (value) =>
          String(value || '').trim().toLowerCase(),
        maxQueries: 2,
      },
    );

    expect(queries).toEqual([
      'Brand Copper peptide Serum',
      'Brand Copper peptide Serum multi peptide',
    ]);
  });

  test('fetchExternalSeedSupplementFromBackend returns empty_query when query is missing', async () => {
    const axiosClient = jest.fn();
    const { fetchExternalSeedSupplementFromBackend } = createProxySearchFallbackHelpers({
      axiosClient,
      config: {
        PROXY_SEARCH_FALLBACK_TIMEOUT_MS: 1500,
        PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS: 900,
        PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY: 'supplement_internal_first',
        PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE: true,
        PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED: true,
        PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES: 1,
        SEARCH_FRAGRANCE_SEMANTIC_RETRY: true,
      },
      helpers: {
        extractSearchQueryText: () => '',
      },
    });

    const result = await fetchExternalSeedSupplementFromBackend({
      queryParams: {},
      neededCount: 3,
      source: 'shopping_agent',
    });

    expect(result).toEqual({
      products: [],
      metadata: {
        attempted: false,
        applied: false,
        reason: 'empty_query',
        requested_count: 3,
      },
    });
    expect(axiosClient).not.toHaveBeenCalled();
  });

  test('queryFindProductsMultiFallback prefers semantic retry when recall is materially better', async () => {
    const axiosClient = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        data: { products: [{ id: 'base' }] },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { products: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] },
      });

    const { queryFindProductsMultiFallback } = createProxySearchFallbackHelpers({
      axiosClient,
      config: {
        PROXY_SEARCH_FALLBACK_TIMEOUT_MS: 1500,
        PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS: 900,
        PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY: 'supplement_internal_first',
        PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE: true,
        PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED: true,
        PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES: 1,
        SEARCH_FRAGRANCE_SEMANTIC_RETRY: false,
      },
      helpers: {
        buildFindProductsMultiPayloadFromQuery: jest.fn((query) => ({
          search: {
            query: query.query,
            limit: 5,
          },
          metadata: {
            source: 'aurora-bff',
          },
        })),
        getProxySearchApiBase: () => 'http://proxy.test',
        isAuroraSource: (value) => String(value || '').trim().toLowerCase() === 'aurora-bff',
        buildInvokeUpstreamAuthHeaders: () => ({ Authorization: 'Bearer x' }),
        normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
        hasFragranceQuerySignal: () => false,
        buildFragranceSemanticRetryQuery: () => '',
        normalizeAgentProductsListResponse: (data) => data,
        parseQueryNumber: (value) => Number(value),
        countUsableSearchProducts: (products) => (Array.isArray(products) ? products.length : 0),
        isProxySearchFallbackRelevant: (normalized, relevanceQuery) =>
          (Array.isArray(normalized?.products) && normalized.products.length > 1) ||
          String(relevanceQuery || '').toLowerCase().includes('multi peptide'),
        withProxySearchFallbackMetadata: (normalized, metadata) => ({
          ...normalized,
          metadata,
        }),
      },
    });

    const result = await queryFindProductsMultiFallback({
      queryParams: { query: 'Brand Copper Tripeptide Serum' },
      checkoutToken: 'tok',
      reason: 'primary_irrelevant',
      requestSource: 'aurora-bff',
      timeoutMs: 800,
    });

    expect(axiosClient).toHaveBeenCalledTimes(2);
    expect(axiosClient.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'http://proxy.test/agent/shop/v1/invoke',
    });
    expect(axiosClient.mock.calls[1][0]).toMatchObject({
      method: 'GET',
      url: 'http://proxy.test/agent/v1/products/search',
    });
    expect(result).toMatchObject({
      selectedAttemptNo: 2,
      semanticRetryApplied: true,
      actualRetryAttempted: true,
      semanticRetryHits: 3,
      usableCount: 3,
      relevanceMatched: true,
    });
    expect(String(result.selectedQuery || '').toLowerCase()).not.toBe(
      'brand copper tripeptide serum',
    );
  });
});
