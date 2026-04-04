const {
  createGuidanceRetrievalPlanRuntime,
} = require('../src/modules/decisioning/shopping_agent/guidanceRetrievalPlan');

function createTestRuntime(nowMs = 2000) {
  return createGuidanceRetrievalPlanRuntime({
    normalizeSearchTextForMatch(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    },
    normalizeRecoTargetStep(value) {
      const token = String(value || '').trim().toLowerCase();
      if (!token) return '';
      if (['moisturizer', 'moisturiser', 'cream'].includes(token)) return 'moisturizer';
      if (['serum', 'essence', 'ampoule'].includes(token)) return 'serum';
      return token;
    },
    normalizeSearchUiSurface(value) {
      return String(value || '').trim().toLowerCase();
    },
    normalizeRecommendationDecisionMode(value, options = {}) {
      const token = String(value || '').trim().toLowerCase();
      if (token) return token;
      return options.guidanceOnlyDiscovery ? 'guidance_only' : 'default';
    },
    normalizeSharedTargetIntent({ queryText, targetStepFamily, mode, queryStepStrength }) {
      return {
        normalized_query: String(queryText || '').trim().toLowerCase(),
        target_step_family: targetStepFamily || null,
        mode: mode || null,
        query_step_strength: queryStepStrength || null,
      };
    },
    normalizeGuidanceIntentStrength(value) {
      const token = String(value || '').trim().toLowerCase();
      return token || null;
    },
    classifyBeautyGuidanceQueryStrength(queryText, { queryTargetStepFamily } = {}) {
      return queryTargetStepFamily === 'serum' && /\brepair\b/i.test(String(queryText || ''))
        ? 'strong_goal_family'
        : 'supportive_family';
    },
    hasFragranceFreeSkincareSignal(queryText) {
      return /\bfragrance[- ]free\b/i.test(String(queryText || ''));
    },
    getNowMs() {
      return nowMs;
    },
  });
}

describe('Shopping agent guidance retrieval plan module', () => {
  test('resolves guidance search step strength and normalized intent', () => {
    const runtime = createTestRuntime();

    expect(runtime.resolveGuidanceSearchStepStrength('', 'repair serum', 'serum')).toBe('strong_goal_family');
    expect(runtime.resolveGuidanceSearchStepStrength('supportive_family', 'repair serum', 'serum')).toBe(
      'supportive_family',
    );

    expect(
      runtime.buildGuidanceSearchNormalizedIntent({
        queryText: 'repair serum',
        targetStepFamily: 'serum',
        uiSurface: 'ingredient_plan_guidance_only',
        decisionMode: '',
        queryStepStrength: 'strong_goal_family',
      }),
    ).toEqual({
      normalized_query: 'repair serum',
      target_step_family: 'serum',
      mode: 'guidance_only',
      query_step_strength: 'strong_goal_family',
    });
  });

  test('builds recall supplement and ingredient recall query variants', () => {
    const runtime = createTestRuntime();

    expect(
      runtime.buildGuidanceRecallSupplementQueries('panthenol repair serum', {
        is_guidance_only: true,
        target_step_family: 'serum',
      }),
    ).toEqual([
      'panthenol serum',
      'barrier repair serum',
      'soothing serum',
      'hydrating serum',
      'serum',
    ]);

    expect(
      runtime.buildGuidanceRecallSupplementQueries('hydrating serum', {
        is_guidance_only: true,
        target_step_family: 'serum',
      }),
    ).toEqual([
      'repair serum',
      'soothing repair serum',
      'barrier repair serum',
      'soothing serum',
      'hydrating serum',
      'serum',
    ]);

    expect(
      runtime.buildIngredientRecallQueryVariants(
        'repair serum',
        {
          exact_phrases: ['panthenol'],
          alias_phrases: ['vitamin b5'],
        },
        'serum',
      ),
    ).toEqual(['panthenol', 'panthenol serum', 'vitamin b5', 'vitamin b5 serum']);

    expect(
      runtime.buildBeautyFamilySupplementQueries('best sunscreen for oily skin', {
        target_step_family: 'sunscreen',
      }),
    ).toEqual([
      'lightweight face sunscreen',
      'matte face sunscreen',
      'face sunscreen lotion',
      'sunscreen milk',
      'mineral face sunscreen',
    ]);

    expect(
      runtime.buildBeautyFamilySupplementQueries('spf serum for oily skin', {
        target_step_family: 'sunscreen',
      }),
    ).toEqual(['spf serum', 'uv filters serum']);
  });

  test('builds server-owned ladder attempts with strong and supportive query clusters', () => {
    const runtime = createTestRuntime();

    expect(
      runtime.buildGuidanceServerOwnedLadderAttempts('fragrance-free ceramide cream', {
        is_server_owned_ladder: true,
        target_step_family: 'moisturizer',
      }),
    ).toEqual([
      {
        intent_strength: 'strong_goal_family',
        cluster_queries: ['ceramide barrier moisturizer', 'barrier repair ceramide moisturizer'],
        selected_query: 'ceramide barrier moisturizer',
        stop_on_success: true,
      },
      {
        intent_strength: 'supportive_family',
        cluster_queries: [
          'barrier repair moisturizer',
          'fragrance-free barrier moisturizer',
          'ceramide moisturizer',
          'sensitive skin moisturizer',
        ],
        selected_query: 'barrier repair moisturizer',
        stop_on_success: true,
      },
    ]);

    expect(
      runtime.buildGuidanceServerOwnedLadderAttempts('hyaluronic niacinamide serum', {
        is_server_owned_ladder: true,
        target_step_family: 'serum',
      }),
    ).toEqual([
      {
        intent_strength: 'strong_goal_family',
        cluster_queries: ['hyaluronic acid serum', 'niacinamide serum'],
        selected_query: 'hyaluronic acid serum',
        stop_on_success: true,
      },
      {
        intent_strength: 'supportive_family',
        cluster_queries: ['hydrating serum', 'balancing serum', 'serum'],
        selected_query: 'hydrating serum',
        stop_on_success: true,
      },
    ]);
  });

  test('adds a generic serum recall variant for supportive-family serum guidance queries', () => {
    const runtime = createTestRuntime();

    expect(
      runtime.buildGuidanceServerOwnedLadderAttempts('hydrating serum', {
        is_server_owned_ladder: true,
        target_step_family: 'serum',
      }),
    ).toEqual([
      {
        intent_strength: 'strong_goal_family',
        cluster_queries: ['hydrating serum'],
        selected_query: 'hydrating serum',
        stop_on_success: true,
      },
      {
        intent_strength: 'supportive_family',
        cluster_queries: [
          'hydrating serum',
          'repair serum',
          'barrier repair serum',
          'soothing repair serum',
          'serum',
        ],
        selected_query: 'hydrating serum',
        stop_on_success: true,
      },
    ]);
  });

  test('computes remaining fastpath budget deterministically', () => {
    const runtime = createTestRuntime(2500);
    expect(runtime.getGuidanceFastpathRemainingBudgetMs(2000, 1000)).toBe(500);
    expect(runtime.getGuidanceFastpathRemainingBudgetMs(1000, 1000)).toBe(0);
  });
});
