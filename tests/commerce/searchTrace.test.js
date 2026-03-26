const {
  buildSearchTrace,
} = require('../../src/commerce/catalog/searchTrace');

describe('buildSearchTrace', () => {
  test('applies stable defaults', () => {
    expect(buildSearchTrace({})).toEqual({
      trace_id: '',
      raw_query: '',
      expanded_query: '',
      expansion_mode: 'conservative',
      query_class: null,
      rewrite_gate: null,
      association_plan: null,
      flags_snapshot: null,
      intent_domain: null,
      intent_target: null,
      intent_scenario: null,
      scenario: null,
      cache_stage: null,
      upstream_stage: null,
      resolver_stage: null,
      final_decision: 'unknown',
    });
  });

  test('normalizes trace fields and passes structured stages through', () => {
    const cacheStage = { hit: true, candidate_count: 4 };
    const upstreamStage = { called: true, timeout: false, status: 200 };
    const resolverStage = { called: true, hit: true, miss: false };
    const rewriteGate = { applied: true, reason: 'brand_anchor' };
    const associationPlan = { mode: 'controlled_recall', signals: ['pet'] };
    const flagsSnapshot = { fast_mode: true, allow_external_seed: false };

    expect(
      buildSearchTrace({
        traceId: 'req_1',
        rawQuery: '  dyson airwrap  ',
        expandedQuery: 'dyson airwrap complete long',
        expansionMode: 'semantic_retry',
        queryClass: 'lookup',
        rewriteGate,
        associationPlan,
        flagsSnapshot,
        intent: {
          primary_domain: 'beauty',
          target_object: { type: 'product' },
          scenario: { name: 'buy' },
        },
        cacheStage,
        upstreamStage,
        resolverStage,
        finalDecision: 'upstream_returned',
      }),
    ).toEqual({
      trace_id: 'req_1',
      raw_query: '  dyson airwrap  ',
      expanded_query: 'dyson airwrap complete long',
      expansion_mode: 'semantic_retry',
      query_class: 'lookup',
      rewrite_gate: rewriteGate,
      association_plan: associationPlan,
      flags_snapshot: flagsSnapshot,
      intent_domain: 'beauty',
      intent_target: 'product',
      intent_scenario: 'buy',
      scenario: 'buy',
      cache_stage: cacheStage,
      upstream_stage: upstreamStage,
      resolver_stage: resolverStage,
      final_decision: 'upstream_returned',
    });
  });

  test('drops non-object trace details and falls back expanded query to raw query', () => {
    expect(
      buildSearchTrace({
        traceId: 123,
        rawQuery: 'milk cleanser',
        expandedQuery: '',
        expansionMode: '',
        queryClass: 'scenario',
        rewriteGate: ['bad'],
        associationPlan: 'bad',
        flagsSnapshot: 0,
        finalDecision: null,
      }),
    ).toEqual(
      expect.objectContaining({
        trace_id: '123',
        raw_query: 'milk cleanser',
        expanded_query: 'milk cleanser',
        expansion_mode: 'conservative',
        query_class: 'scenario',
        rewrite_gate: null,
        association_plan: null,
        flags_snapshot: null,
        final_decision: 'unknown',
      }),
    );
  });
});
