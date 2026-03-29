const {
  assessPrimaryPath,
  evaluatePrimaryPathContract,
} = require('../scripts/lib/commerce_primary_path');

describe('commerce primary path contract helper', () => {
  test('marks resolver fallback as degraded primary path', () => {
    const assessment = assessPrimaryPath({
      metadata: {
        query_source: 'agent_products_resolver_fallback',
        route_health: {
          fallback_triggered: true,
          primary_path_used: 'resolver_fallback',
        },
        search_trace: {
          final_decision: 'resolver_returned',
        },
      },
    });

    expect(assessment.degraded).toBe(true);
    expect(assessment.reasons).toEqual(
      expect.arrayContaining([
        'query_source=agent_products_resolver_fallback',
        'route_health.fallback_triggered=true',
      ]),
    );
  });

  test('fails strict_empty unless the fixture explicitly allows it', () => {
    const evaluated = evaluatePrimaryPathContract(
      {
        metadata: {
          query_source: 'cache_cross_merchant_search',
          strict_empty: true,
          search_trace: {
            final_decision: 'strict_empty',
          },
        },
      },
      {
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['cache_cross_merchant_search'],
      },
    );

    expect(evaluated.passed).toBe(false);
    expect(evaluated.reasons).toContain('strict_empty_not_allowed:strict_empty');
  });

  test('passes healthy cache-stage hit when it stays on the allowed primary source', () => {
    const evaluated = evaluatePrimaryPathContract(
      {
        metadata: {
          query_source: 'cache_cross_merchant_search',
          route_health: {
            fallback_triggered: false,
            primary_path_used: 'cache_stage',
          },
          search_trace: {
            final_decision: 'cache_returned',
          },
        },
      },
      {
        require_primary_path: true,
        allow_strict_empty: false,
        allowed_query_sources: ['cache_cross_merchant_search'],
      },
    );

    expect(evaluated.passed).toBe(true);
    expect(evaluated.reasons).toEqual([]);
  });

  test('ignores observer-only fallback traces once a non-fallback authority is locked', () => {
    const assessment = assessPrimaryPath({
      metadata: {
        query_source: 'cache_cross_merchant_search',
        proxy_search_fallback: {
          applied: true,
          reason: 'resolver_after_primary',
        },
        route_health: {
          fallback_triggered: true,
          fallback_reason: 'resolver_after_primary',
          primary_path_used: 'cache_stage',
          observer_nodes: ['governance_shadow_block_observed'],
        },
        search_decision: {
          final_decision: 'cache_returned',
          decision_authority: 'cache_cross_merchant_search',
          decision_locked: true,
          decision_lock_reason: 'cache_main_path',
        },
      },
    });

    expect(assessment.degraded).toBe(false);
    expect(assessment.querySource).toBe('cache_cross_merchant_search');
    expect(assessment.decisionLocked).toBe(true);
    expect(assessment.observerNodes).toContain('governance_shadow_block_observed');
  });
});
