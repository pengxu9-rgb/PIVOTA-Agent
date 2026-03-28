const {
  createShoppingAgentDecisioningRuntime,
  handleShoppingAgentDecisioning,
} = require('../src/modules/decisioning/shopping_agent');

function createTestRuntime(overrides = {}) {
  return createShoppingAgentDecisioningRuntime({
    normalizeSearchTextForMatch(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    },
    buildBeautyQueryProfile({ rawQuery } = {}) {
      const normalized = String(rawQuery || '').toLowerCase();
      if (/\b(foundation|lipstick|blush|gloss)\b/.test(normalized)) {
        return { isBeautyQuery: true, bucket: 'base_makeup' };
      }
      if (/\b(serum|moisturizer|cleanser|toner|niacinamide|retinol|ceramide|panthenol)\b/.test(normalized)) {
        return { isBeautyQuery: true, bucket: 'skincare' };
      }
      return { isBeautyQuery: false, bucket: 'general' };
    },
    hasDatabaseUrl: false,
    ...overrides,
  });
}

describe('Shopping agent facade', () => {
  test('discovery facade keeps strict ingredient reasoning in decision_state', async () => {
    const runtime = createTestRuntime();

    const out = await runtime.handleShoppingAgentDecisioning({
      task_type: 'discovery',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'niacinamide serum',
      },
    });

    expect(out.layer).toBe('decisioning');
    expect(out.status).toBe('no_match');
    expect(out.delegation_plan).toBe('stay_in_layer');
    expect(out.updated_context.normalized_need.query).toBe('niacinamide serum');
    expect(out.updated_context.decision_state.rationale).toContain('strict_constraint:ingredient');
    expect(out.updated_context.decision_state.confidence).toBeGreaterThanOrEqual(0.35);
  });

  test('facade routes exact_product decisioning requests toward execution', async () => {
    const out = await handleShoppingAgentDecisioning({
      task_type: 'exact_product',
      context: {
        source_profile: {
          source: 'shopping_agent',
          default_entry_layer: 'decisioning',
        },
        vertical: 'beauty',
        category: 'skincare',
        raw_user_goal: 'ipsa toner',
      },
    });

    expect(out.layer).toBe('decisioning');
    expect(out.status).toBe('needs_execution');
    expect(out.delegation_plan).toBe('call_execution');
  });

  test('policy wrapper skips apply when no intent or fashion constraint signal exists', () => {
    const runtime = createShoppingAgentDecisioningRuntime({
      hasFashionConstraintQuerySignal() {
        return false;
      },
      applyFindProductsMultiPolicy() {
        throw new Error('should not apply policy');
      },
      hasDatabaseUrl: false,
    });
    const response = { products: [], metadata: { query_source: 'cache_cross_merchant_search' } };

    expect(
      runtime.applyFindProductsMultiPolicyIfNeeded({
        response,
        intent: null,
        rawUserQuery: 'plain ipsa products',
      }),
    ).toBe(response);
  });

  test('policy wrapper applies when fashion visible constraints are present without intent', () => {
    const runtime = createShoppingAgentDecisioningRuntime({
      hasFashionConstraintQuerySignal(rawQuery) {
        return /\b(size xl)\b/i.test(String(rawQuery || ''));
      },
      applyFindProductsMultiPolicy({ response, rawUserQuery }) {
        return {
          ...response,
          metadata: {
            ...(response.metadata || {}),
            policy_applied_for: rawUserQuery,
          },
        };
      },
      hasDatabaseUrl: false,
    });

    expect(
      runtime.applyFindProductsMultiPolicyIfNeeded({
        response: { products: [], metadata: { query_source: 'agent_products_search' } },
        intent: null,
        rawUserQuery: 'black fleece vest size xl',
      }),
    ).toEqual({
      products: [],
      metadata: {
        query_source: 'agent_products_search',
        policy_applied_for: 'black fleece vest size xl',
      },
    });
  });

  test('cache-stage ambiguity helper forces search-first for brand-like queries', () => {
    const runtime = createTestRuntime({
      detectBrandEntities() {
        return { brand_like: true, brands: ['ipsa'] };
      },
    });

    expect(
      runtime.evaluateCacheStageAmbiguityDecision({
        effectiveIntent: {
          query_class: 'gift',
          ambiguity: { needs_clarification: true },
        },
        cacheQueryText: 'ipsa gift toner',
        effectiveProducts: [{ product_id: 'p1' }],
        internalProductsAfterAnchor: [{ product_id: 'p1' }],
        traceQueryClass: 'gift',
      }),
    ).toMatchObject({
      queryClassForEarlyDecision: 'gift',
      canUseEarlyAmbiguityDecision: false,
      gateTraceReason: 'brand_like_search_first',
      routeDebugUpdate: {
        applied: false,
        reason: 'brand_like_search_first',
        query_class: 'gift',
        brand_entities: ['ipsa'],
      },
    });
  });

  test('cache-stage ambiguity helper forces controlled recall for scenario queries when enabled', () => {
    const runtime = createTestRuntime({
      searchForceControlledRecallForScenario: true,
    });

    expect(
      runtime.evaluateCacheStageAmbiguityDecision({
        effectiveIntent: {
          query_class: 'scenario',
          ambiguity: { needs_clarification: true },
        },
        cacheQueryText: 'routine for dry skin while traveling',
        effectiveProducts: [],
        internalProductsAfterAnchor: [],
        traceQueryClass: 'scenario',
      }),
    ).toMatchObject({
      queryClassForEarlyDecision: 'scenario',
      forceControlledRecallForScenario: true,
      canUseEarlyAmbiguityDecision: false,
      routeDebugUpdate: {
        applied: false,
        reason: 'force_controlled_recall_for_scenario',
        query_class: 'scenario',
      },
    });
  });

  test('cache-stage ambiguity helper allows clarify-only early decision for cache-miss gift queries', () => {
    const runtime = createTestRuntime({
      searchForceControlledRecallForScenario: false,
    });

    expect(
      runtime.evaluateCacheStageAmbiguityDecision({
        effectiveIntent: {
          query_class: 'gift',
          ambiguity: { needs_clarification: true },
        },
        cacheQueryText: 'gift for skincare lover',
        effectiveProducts: [],
        internalProductsAfterAnchor: [],
        traceQueryClass: 'gift',
      }),
    ).toMatchObject({
      queryClassForEarlyDecision: 'gift',
      forceControlledRecallForScenario: false,
      canUseEarlyAmbiguityDecision: true,
      earlyDecisionCause: 'cache_miss_ambiguity_sensitive',
      gateTraceReason: 'cache_miss_ambiguity_sensitive',
      routeDebugUpdate: {
        applied: true,
        reason: 'cache_miss_ambiguity_sensitive',
        query_class: 'gift',
      },
    });
  });

  test('second-stage supplement helper blocks risky broadening for category queries', () => {
    const runtime = createTestRuntime({
      extractSearchAnchorTokens(queryText) {
        return String(queryText || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
      },
    });

    expect(
      runtime.getFindProductsMultiSecondStageSupplementDecision({
        queryText: 'blue striped sweater',
        expandedQuery: 'blue striped sweater women clothing dress top skirt outfit',
        traceQueryClass: 'category',
      }),
    ).toEqual(
      expect.objectContaining({
        allowSupplement: false,
        reason: 'disabled_for_risky_broadening',
        queryClass: 'category',
        addedTokens: ['women', 'clothing', 'dress', 'top', 'skirt', 'outfit'],
      }),
    );
  });

  test('second-stage supplement helper allows safe browse supplement with bounded expansion', () => {
    const runtime = createTestRuntime({
      extractSearchAnchorTokens(queryText) {
        return String(queryText || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
      },
    });

    expect(
      runtime.getFindProductsMultiSecondStageSupplementDecision({
        queryText: 'face sunscreen',
        expandedQuery: 'face sunscreen spf skincare',
        traceQueryClass: 'category',
      }),
    ).toEqual(
      expect.objectContaining({
        allowSupplement: true,
        reason: 'second_stage_allowed',
        queryClass: 'category',
        addedTokens: ['spf', 'skincare'],
      }),
    );
  });
});
