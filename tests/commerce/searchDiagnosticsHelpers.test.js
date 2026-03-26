const {
  createSearchDiagnosticsHelpers,
} = require('../../src/commerce/catalog/searchDiagnosticsHelpers');

function createHelpers(overrides = {}) {
  return createSearchDiagnosticsHelpers({
    buildFallbackCandidateText: (product) =>
      String(
        product?.title ||
          product?.name ||
          product?.text ||
          '',
      ),
    hasFragranceQuerySignal: (query) => /perfume|fragrance/i.test(String(query || '')),
    normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
    parseQueryNumber: (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    },
    normalizeAgentProductsListResponse: (body, options = {}) => ({
      ...body,
      page_size: body.page_size ?? options.limit ?? 0,
    }),
    isExternalSeedProduct: (product) => Boolean(product?.external_seed),
    hasLingerieSearchSignal: (query) => /bra|lingerie/i.test(String(query || '')),
    hasLingerieCatalogProductSignal: (text) => /bra|lingerie/i.test(String(text || '')),
    buildClarification: ({ language, queryClass }) => ({
      question: language === 'zh' ? '请具体一点' : `Need clarification for ${queryClass}`,
      options: ['A', 'B'],
      reason_code: 'AMBIGUITY_CLARIFY',
      slot: 'query',
      dedup_key: 'clarify-query',
    }),
    searchUpstreamQuotaClarifyEnabled: true,
    searchUpstreamQuotaClarifyQueryClasses: new Set(['exploratory', 'scenario']),
    ...overrides,
  });
}

describe('createSearchDiagnosticsHelpers', () => {
  test('buildSearchRelevanceDebug derives beauty category mix', () => {
    const helpers = createHelpers();

    expect(
      helpers.buildSearchRelevanceDebug({
        intent: {
          primary_domain: 'beauty',
          scenario: { name: 'buy' },
        },
        products: [
          { title: 'Makeup brush set' },
          { title: 'Lip balm' },
          { title: 'Hydrating serum' },
        ],
        diversityPenaltyApplied: true,
      }),
    ).toEqual({
      intent_domain: 'beauty',
      intent_scenario: 'buy',
      diversity_penalty_applied: true,
      category_mix_topN: {
        tools: 1,
        lip_makeup: 1,
        skincare: 1,
      },
    });
  });

  test('withSearchDiagnostics normalizes strict-empty decision and route health', () => {
    const helpers = createHelpers();

    const result = helpers.withSearchDiagnostics(
      {
        products: [],
        metadata: {
          search_decision: {
            final_decision: 'products_returned',
          },
          search_trace: {
            raw_query: 'perfume',
          },
          source_breakdown: {
            internal_count: 2,
            external_seed_count: 1,
          },
        },
      },
      {
        route_health: {
          fallback_reason: 'low_quality_primary',
          primary_path_used: 'cache_returned',
        },
        search_trace: {
          raw_query: 'perfume',
        },
        strict_empty: true,
        strict_empty_reason: 'primary_irrelevant',
      },
    );

    expect(result.metadata.strict_empty).toBe(true);
    expect(result.metadata.strict_empty_reason).toBe('primary_irrelevant');
    expect(result.metadata.search_decision.final_decision).toBe('strict_empty');
    expect(result.metadata.route_health).toEqual(
      expect.objectContaining({
        decision_node: 'cache_returned',
        query_semantic_class: 'fragrance',
        primary_quality_gate_passed: false,
        low_quality_nonempty_detected: true,
        internal_raw_count: 2,
        external_raw_count: 1,
      }),
    );
  });

  test('buildProxySearchSoftFallbackResponse emits clarify payload for quota exhaustion', () => {
    const helpers = createHelpers();

    const result = helpers.buildProxySearchSoftFallbackResponse({
      queryParams: { limit: '12' },
      reason: 'upstream_quota',
      upstreamStatus: 429,
      upstreamCode: 'RATE_LIMIT_EXCEEDED',
      upstreamMessage: 'quota exceeded',
      queryClass: 'exploratory',
      queryText: '精华',
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'success',
        success: true,
        total: 0,
        page_size: 12,
        clarification: expect.objectContaining({
          reason_code: 'AMBIGUITY_CLARIFY',
        }),
        reason_codes: ['UPSTREAM_QUOTA_EXHAUSTED', 'AMBIGUITY_CLARIFY'],
      }),
    );
    expect(result.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        upstream_status: 429,
        upstream_error_code: 'RATE_LIMIT_EXCEEDED',
        upstream_quota_guarded: true,
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'upstream_quota',
        }),
      }),
    );
  });
});
