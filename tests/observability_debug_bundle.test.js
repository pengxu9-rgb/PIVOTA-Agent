const {
  RESULT_TYPE_VALUES,
  REASON_CODE_VALUES,
  inferResultType,
  inferReasonCode,
  buildSearchDebugBundle,
  shouldExposeDebugBundle,
} = require('../src/observability/debugBundle');

describe('observability debug bundle', () => {
  test('builds debug bundle with required fields', () => {
    const req = {
      headers: { 'x-debug': '1' },
      query: {},
      body: {
        operation: 'find_products_multi',
        payload: { search: { query: 'ipsa' } },
      },
      ip: '127.0.0.1',
    };
    const responseBody = {
      products: [
        {
          product_id: 'p1',
          title: 'IPSA Time Reset Aqua',
          merchant_id: 'merch_1',
          final_score: 0.88,
          attributes: { pivota: { domain: 'beauty' } },
        },
      ],
      metadata: {
        query_source: 'cache_cross_merchant_search',
        route_health: {
          primary_path_used: 'cache_stage',
          primary_latency_ms: 121,
          ambiguity_score_pre: 0.2,
          ambiguity_score_post: 0.21,
          degrade_flags: { nlu_degraded: false, vector_skipped: false, behavior_skipped: false },
        },
        search_trace: {
          trace_id: 't1',
          raw_query: 'ipsa',
          expanded_query: 'ipsa toner',
          expansion_mode: 'conservative',
          final_decision: 'cache_returned',
        },
        search_decision: {
          ambiguity_score_pre: 0.2,
          ambiguity_score_post: 0.21,
          final_decision: 'cache_returned',
        },
      },
      intent: {
        language: 'zh',
        query_class: 'lookup',
        primary_domain: 'beauty',
        scenario: { name: 'general' },
      },
    };
    const debugBundle = buildSearchDebugBundle({
      requestId: 'req-1',
      req,
      responseBody,
      context: {
        invokeStartedAtMs: Date.now() - 50,
        nluLatencyMs: 10,
        rawUserQuery: 'ipsa',
        intent: {
          language: 'zh',
          query_class: 'lookup',
          primary_domain: 'beauty',
          scenario: { name: 'general' },
          confidence: { overall: 0.8 },
          hard_constraints: { must_exclude_domains: [] },
        },
      },
    });

    expect(debugBundle).toBeTruthy();
    expect(debugBundle.schema_version).toBe('v1');
    expect(Object.prototype.hasOwnProperty.call(debugBundle, 'build_sha')).toBe(true);
    expect(debugBundle.req_id).toBe('req-1');
    expect(debugBundle.query).toBe('ipsa');
    expect(RESULT_TYPE_VALUES).toContain(debugBundle.result_type);
    expect(typeof debugBundle.latency_ms.total).toBe('number');
    expect(debugBundle.flags_snapshot).toEqual(
      expect.objectContaining({
        search_domain_hard_filter_mode: expect.any(String),
      }),
    );
    expect(debugBundle.degrade).toEqual({
      nlu_degraded: false,
      vector_skipped: false,
      behavior_skipped: false,
    });
    expect(Array.isArray(debugBundle.top_items)).toBe(true);
    expect(debugBundle.top_items[0]).toEqual(
      expect.objectContaining({
        pid: 'p1',
        domain: 'beauty',
      }),
    );
  });

  test('result_type and reason_code are always enum-compatible', () => {
    const cases = [
      {
        body: { products: [{ id: 'p1' }], metadata: { query_source: 'cache_cross_merchant_search' } },
        expectedType: 'product_list',
      },
      {
        body: { products: [], clarification: { question: 'which one?' }, metadata: {} },
        expectedType: 'clarify',
      },
      {
        body: { products: [], metadata: { strict_empty: true, strict_empty_reason: 'no_candidates' } },
        expectedType: 'strict_empty',
      },
    ];

    for (const item of cases) {
      const resultType = inferResultType(item.body);
      const reasonCode = inferReasonCode({
        responseBody: item.body,
        resultType,
        routeHealth: item.body.metadata?.route_health || {},
        searchTrace: item.body.metadata?.search_trace || {},
      });
      expect(resultType).toBe(item.expectedType);
      expect(RESULT_TYPE_VALUES).toContain(resultType);
      expect(typeof reasonCode).toBe('string');
      expect(REASON_CODE_VALUES.includes(reasonCode) || /^[A-Z0-9_]+$/.test(reasonCode)).toBe(true);
    }
  });

  test('debug response exposure requires allowlist unless private mode explicitly enabled', () => {
    const req = {
      headers: { 'x-debug': '1', 'x-forwarded-for': '157.10.251.29' },
      query: {},
      body: {},
      ip: '10.0.0.5',
    };
    const oldAllowlist = process.env.SEARCH_DEBUG_BUNDLE_ALLOWLIST;
    const oldPrivate = process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP;
    try {
      delete process.env.SEARCH_DEBUG_BUNDLE_ALLOWLIST;
      delete process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP;
      expect(shouldExposeDebugBundle(req)).toBe(false);

      process.env.SEARCH_DEBUG_BUNDLE_ALLOWLIST = '157.10.251.*';
      expect(shouldExposeDebugBundle(req)).toBe(true);
    } finally {
      if (oldAllowlist == null) delete process.env.SEARCH_DEBUG_BUNDLE_ALLOWLIST;
      else process.env.SEARCH_DEBUG_BUNDLE_ALLOWLIST = oldAllowlist;
      if (oldPrivate == null) delete process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP;
      else process.env.SEARCH_DEBUG_BUNDLE_ALLOW_PRIVATE_IP = oldPrivate;
    }
  });
});
