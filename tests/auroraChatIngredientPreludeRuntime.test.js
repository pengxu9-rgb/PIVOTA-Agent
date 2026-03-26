const { createChatIngredientPreludeRuntime } = require('../src/auroraBff/chatIngredientPreludeRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    isIngredientEntryAction: jest.fn(() => false),
    isIngredientLookupAction: jest.fn(() => false),
    isIngredientByGoalAction: jest.fn(() => false),
    isIngredientDiagnosisOptInAction: jest.fn(() => false),
    isIngredientResearchPollAction: jest.fn(() => false),
    isIngredientRecoOptInAction: jest.fn(() => false),
    extractIngredientLookupQuery: jest.fn(() => ''),
    extractIngredientLookupTargetFromText: jest.fn(async () => ''),
    ingredientEntityMatchFromText: jest.fn(() => ({
      normalized_query: '',
      entity_key: '',
      entity_match_type: 'none',
      entity_confidence: 0,
    })),
    looksLikeProductEvaluationIntentV2: jest.fn(() => false),
    looksLikeRecommendationRequest: jest.fn(() => false),
    looksLikeSuitabilityRequest: jest.fn(() => false),
    extractIngredientGoalRequest: jest.fn(() => ({ goal: '', sensitivity: 'unknown' })),
    extractActionDataObject: jest.fn(() => null),
    normalizeIngredientRecoContextValue: jest.fn((value) => value || null),
    mergeIngredientRecoContextValue: jest.fn((base, patch) => ({ ...(base || {}), ...(patch || {}) })),
    extractIngredientRecoContext: jest.fn(() => null),
    normalizeIngredientCandidateList: jest.fn((items) => items),
    pickFirstTrimmed: jest.fn((...values) => {
      for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    }),
    normalizeIngredientActionId: jest.fn((value) => String(value || '').trim()),
    recordAuroraIngredientsFlowMetric: jest.fn(),
    buildIngredientLookupUpstreamPrompt: jest.fn(({ query, language }) => `lookup:${language}:${query}`),
    buildIngredientRecoUpstreamPrompt: jest.fn(({ language, context }) => `reco:${language}:${context.query || ''}`),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    looksLikeRoutineRequest: jest.fn(() => false),
    normalizeAgentState: jest.fn((value) => value),
    looksLikeDiagnosisStart: jest.fn(() => false),
    now: jest.fn(() => 1700000000000),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatIngredientPreludeRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    actionId: '',
    normalizedActionPayload: null,
    parsedData: { session: { meta: {} } },
    message: '',
    ctx: { lang: 'EN', trigger_source: 'chip' },
    canonicalIntent: { intent: 'unknown' },
    INTENT_ENUM: { EVALUATE_PRODUCT: 'evaluate_product' },
    requestedTransition: null,
    ingredientScienceIntent: false,
    upstreamMessage: 'upstream:seed',
    ...overrides,
  };
}

describe('aurora chat ingredient prelude runtime', () => {
  test('lookup action without free text switches to lookup prompt and skips routine fallback', async () => {
    const { runtime, deps } = buildHarness({
      isIngredientLookupAction: jest.fn(() => true),
      extractIngredientLookupQuery: jest.fn(() => 'niacinamide'),
    });

    const out = await runtime.prepareIngredientPrelude(buildArgs({
      actionId: 'chip.lookup.ingredient',
      normalizedActionPayload: { action_id: 'chip.lookup.ingredient' },
    }));

    expect(out.ingredientLookupRequested).toBe(true);
    expect(out.skipRoutineRulesFallback).toBe(true);
    expect(out.upstreamMessage).toBe('lookup:EN:niacinamide');
    expect(out.ingredientRouteDecisionReasons).toContain('action_lookup');
    expect(deps.recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'mode_selected', hit: true });
  });

  test('text cue with entity match enables ingredient science and suppresses evaluate intent', async () => {
    const { runtime } = buildHarness({
      ingredientEntityMatchFromText: jest.fn(() => ({
        normalized_query: 'azelaic acid',
        entity_key: 'azelaic_acid',
        entity_match_type: 'alias',
        entity_confidence: 0.92,
      })),
      extractIngredientLookupTargetFromText: jest.fn(async () => 'azelaic acid'),
    });

    const out = await runtime.prepareIngredientPrelude(buildArgs({
      message: '查 azelaic acid 成分',
      ctx: { lang: 'CN', trigger_source: 'text' },
      canonicalIntent: { intent: 'evaluate_product' },
    }));

    expect(out.ingredientScienceIntentEffective).toBe(true);
    expect(out.evaluateIntent).toBe(false);
    expect(out.ingredientRouteDecisionReasons).toContain('entity_alias_match');
    expect(out.ingredientReplayContext).toEqual(
      expect.objectContaining({
        intent_requested: true,
        route_source: 'text',
        entry: 'ingredient_intent',
      }),
    );
  });

  test('reco opt-in merges session and action context and builds reco prompt', async () => {
    const { runtime, deps } = buildHarness({
      isIngredientRecoOptInAction: jest.fn(() => true),
      extractActionDataObject: jest.fn(() => ({
        ingredient_query: 'retinol',
        ingredient_goal: 'anti-aging',
        ingredient_candidates: [{ key: 'retinol' }],
        ingredient_sensitivity: 'medium',
        entry_source: 'ingredient_report',
      })),
      normalizeIngredientRecoContextValue: jest.fn((value) => value || null),
      extractIngredientRecoContext: jest.fn(() => ({ source: 'action_seed' })),
    });

    const out = await runtime.prepareIngredientPrelude(buildArgs({
      actionId: 'chip.start.reco_products',
      normalizedActionPayload: { action_id: 'chip.start.reco_products' },
      parsedData: {
        session: {
          meta: {
            ingredient_context: {
              query: 'bakuchiol',
              source: 'session_seed',
            },
          },
        },
      },
    }));

    expect(out.ingredientRecoOptInRequested).toBe(true);
    expect(out.upstreamMessage).toBe('reco:EN:retinol');
    expect(out.ingredientRecoContext).toEqual(
      expect.objectContaining({
        query: 'retinol',
        goal: 'anti-aging',
        source: 'ingredient_report',
        updated_at_ms: 1700000000000,
      }),
    );
    expect(out.ingredientReplayContext).toEqual(
      expect.objectContaining({
        reco_optin: true,
      }),
    );
    expect(deps.recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'reco_optin', hit: true });
  });

  test('requested DIAG_PROFILE transition opens diagnosis entry even without explicit chip', async () => {
    const { runtime } = buildHarness({
      normalizeAgentState: jest.fn((value) => value),
    });

    const out = await runtime.prepareIngredientPrelude(buildArgs({
      requestedTransition: { requested_next_state: 'DIAG_PROFILE' },
    }));

    expect(out.diagnosisEntryRequested).toBe(true);
    expect(out.conflictIntentRequested).toBe(false);
  });
});
