const { createChatIngredientReplayRuntime } = require('../src/auroraBff/chatIngredientReplayRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: { info: jest.fn() },
    pickFirstTrimmed: (...values) => {
      for (const raw of values) {
        const value = String(raw || '').trim();
        if (value) return value;
      }
      return '';
    },
    recordAuroraIngredientsFlowMetric: jest.fn(),
    INGREDIENT_ROUTE_RULE_VERSION: 'ingredient_route_v1',
    ...overrides,
  };

  return {
    deps,
    runtime: createChatIngredientReplayRuntime(deps),
  };
}

describe('aurora chat ingredient replay runtime', () => {
  test('records answer-served flow and sanitizes provider attempts', () => {
    const { runtime, deps } = buildRuntime();

    const result = runtime.processIngredientReplay({
      envelope: {
        cards: [
          {
            type: 'aurora_ingredient_report',
            payload: {
              research_provider: 'gemini',
              research_attempts: [
                {
                  provider: 'gemini-very-long-provider-name-that-should-be-truncated',
                  outcome: 'success-with-extra-text-that-should-be-truncated-because-it-is-too-long',
                  reason_code: 'provider_timeout_with_many_details_that_should_also_be_truncated',
                },
              ],
            },
          },
        ],
        session_patch: {
          meta: {
            ingredient_query_first_applied: true,
            ingredient_route_source: 'text',
          },
        },
      },
      chatCardsResponse: {
        cards: [{ type: 'aurora_ingredient_report' }],
      },
      ingredientReplayContext: {
        intent_requested: true,
        starter_action: false,
        diagnosis_optin: false,
        reco_optin: false,
        entry: 'ingredient_lookup',
      },
      legacyCardTypes: ['aurora_ingredient_report'],
      gateType: 'none',
      nextState: 'IDLE_CHAT',
      actionIdForReplay: 'ingredient.lookup',
      clientStateForReplay: 'IDLE_CHAT',
      agentStateForReplay: 'IDLE_CHAT',
      ctx: { request_id: 'req_ing_1', trace_id: 'trace_ing_1', trigger_source: 'text' },
      policyMeta: { intent_canonical: 'ingredient_science' },
      canonicalIntentForResponse: { intent: 'ingredient_science' },
    });

    expect(result.ingredientRouteSource).toBe('text');
    expect(result.ingredientReplayRelevant).toBe(true);
    expect(result.ingredientProviderFinal).toBe('gemini');
    expect(result.ingredientProviderAttempts).toHaveLength(1);
    expect(result.ingredientProviderAttempts[0].provider).toHaveLength(32);
    expect(result.ingredientProviderAttempts[0].outcome.length).toBeLessThanOrEqual(48);
    expect(result.ingredientProviderAttempts[0].reason_code.length).toBeLessThanOrEqual(64);
    expect(deps.recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'answer_served', hit: true });
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_ing_1',
        route_source: 'text',
        ingredient_query_first_applied: true,
        provider_final: 'gemini',
      }),
      'aurora bff: ingredient replay route',
    );
  });

  test('flags text-route drift when query-first ingredient route produces no ingredient answer card', () => {
    const { runtime, deps } = buildRuntime();

    const result = runtime.processIngredientReplay({
      envelope: {
        cards: [{ type: 'analysis_summary', payload: {} }],
        events: [],
        session_patch: {
          meta: {
            ingredient_query_first_applied: true,
            ingredient_route_source: 'text',
          },
        },
      },
      chatCardsResponse: {
        cards: [{ type: 'analysis_summary' }],
      },
      ingredientReplayContext: {
        intent_requested: true,
        starter_action: false,
        diagnosis_optin: false,
        reco_optin: false,
        entry: 'ingredient_lookup',
      },
      legacyCardTypes: ['analysis_summary'],
      gateType: 'none',
      nextState: 'IDLE_CHAT',
      actionIdForReplay: null,
      clientStateForReplay: 'IDLE_CHAT',
      agentStateForReplay: 'IDLE_CHAT',
      ctx: { request_id: 'req_ing_2', trace_id: 'trace_ing_2', trigger_source: 'text' },
      policyMeta: { intent_canonical: 'ingredient_science' },
      canonicalIntentForResponse: { intent: 'ingredient_science' },
    });

    expect(result.ingredientTextRouteDrift).toBe(true);
    expect(deps.recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'text_route_drift', hit: true });
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        text_route_drift: true,
        ingredient_card_render_drop: false,
      }),
      'aurora bff: ingredient replay route',
    );
  });

  test('tracks unwanted diagnosis and render-drop when ingredient answer is lost in cards response', () => {
    const { runtime, deps } = buildRuntime();

    const result = runtime.processIngredientReplay({
      envelope: {
        cards: [{ type: 'aurora_ingredient_report', payload: {} }],
        session_patch: { meta: {} },
      },
      chatCardsResponse: {
        cards: [{ type: 'analysis_summary' }],
      },
      ingredientReplayContext: {
        intent_requested: false,
        starter_action: true,
        diagnosis_optin: false,
        reco_optin: false,
        entry: 'ingredient_starter',
      },
      legacyCardTypes: ['aurora_ingredient_report'],
      gateType: 'diagnosis_gate',
      nextState: 'S2_DIAGNOSIS',
      actionIdForReplay: 'chip.ingredient.start',
      clientStateForReplay: 'RECO_GATE',
      agentStateForReplay: 'RECO_GATE',
      ctx: { request_id: 'req_ing_3', trace_id: 'trace_ing_3', trigger_source: 'chip' },
      policyMeta: { intent_canonical: 'ingredient_science' },
      canonicalIntentForResponse: { intent: 'ingredient_science' },
    });

    expect(result.unwantedDiagnosis).toBe(true);
    expect(result.ingredientCardRenderDrop).toBe(true);
    expect(deps.recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'answer_served', hit: true });
    expect(deps.recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'unwanted_diagnosis', hit: true });
    expect(deps.recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'card_render_drop', hit: true });
  });
});
