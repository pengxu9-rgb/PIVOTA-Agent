const { createChatRecoHandoffRuntime } = require('../src/auroraBff/chatRecoHandoffRuntime');

function buildRuntime(overrides = {}) {
  return createChatRecoHandoffRuntime({
    buildConfidenceNoticeCardPayload: jest.fn(({ language, reason, confidence, actions, details }) => ({
      language,
      reason,
      confidence,
      actions,
      details,
    })),
    buildIngredientPlanCard: jest.fn((plan, requestId) => ({
      card_id: `plan_${requestId}`,
      type: 'ingredient_plan',
      payload: plan,
    })),
    buildRulesOnlyRoutineExpertFromContext: jest.fn(({ language }) => ({
      source_language: language,
      summary: 'rules-only',
    })),
    appendLatestArtifactToSessionPatch: jest.fn((patch, artifactId) => {
      if (artifactId) patch.latest_artifact_id = artifactId;
    }),
    appendLatestRecoContextToSessionPatch: jest.fn((patch, context) => {
      patch.latest_reco_context = context;
    }),
    buildRecoLlmTraceRef: jest.fn((trace) => (trace ? `trace:${trace.trace_id || 'unknown'}` : null)),
    normalizeRecoSourceDetail: jest.fn((value) => String(value || '').trim().toLowerCase() || null),
    ...overrides,
  });
}

describe('aurora chat reco handoff runtime', () => {
  test('buildRoutineTimeoutDegradedEnvelope builds degraded routine fallback cards and event', () => {
    const runtime = buildRuntime();
    const envelope = runtime.buildRoutineTimeoutDegradedEnvelope({
      ctx: { request_id: 'req_routine_1', lang: 'EN' },
      message: 'build me a routine',
      profile: { skinType: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      detail: 'Routine generation timed out in budget flow.',
      upstreamFailureCode: 'UPSTREAM_TIMEOUT',
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    });

    expect(envelope.cards).toHaveLength(2);
    expect(envelope.cards[0]).toEqual({
      card_id: 'analysis_req_routine_1',
      type: 'analysis_summary',
      payload: {
        analysis_source: 'rules_only_timeout_degraded',
        low_confidence: true,
        analysis: {
          routine_expert: {
            source_language: 'EN',
            summary: 'rules-only',
          },
        },
      },
    });
    expect(envelope.cards[1].type).toBe('confidence_notice');
    expect(envelope.events).toEqual([
      {
        event_name: 'recos_requested',
        event_data: {
          explicit: true,
          gated: true,
          reason: 'timeout_degraded',
          source: 'upstream_timeout',
          route: 'routine',
          upstream_failure_code: 'UPSTREAM_TIMEOUT',
        },
      },
    ]);
  });

  test('buildRoutineRecoEnvelope builds budget-flow routine recommendation envelope', () => {
    const runtime = buildRuntime();
    const envelope = runtime.buildRoutineRecoEnvelope({
      ctx: { request_id: 'req_routine_2', lang: 'CN' },
      variant: 'budget_flow',
      hasBudget: true,
      suggestedChips: [{ chip_id: 'budget_ok' }],
      payload: { recommendations: [{ sku_id: 'sku_1' }] },
      fieldMissing: ['skinType'],
      nextState: 'S7_PRODUCT_RECO',
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    });

    expect(envelope.assistant_message).toEqual({
      content: '已收到预算信息。我生成了一个简洁 AM/PM routine（见下方卡片）。',
    });
    expect(envelope.cards[0]).toEqual({
      card_id: 'reco_req_routine_2',
      type: 'recommendations',
      payload: { recommendations: [{ sku_id: 'sku_1' }] },
      field_missing: ['skinType'],
    });
    expect(envelope.session_patch).toEqual({ next_state: 'S7_PRODUCT_RECO' });
  });

  test('buildRoutineRecoEnvelope builds direct routine envelope with budget optimization message', () => {
    const runtime = buildRuntime();
    const envelope = runtime.buildRoutineRecoEnvelope({
      ctx: { request_id: 'req_routine_3', lang: 'EN' },
      variant: 'routine_request',
      hasBudget: false,
      suggestedChips: [{ chip_id: 'optimize_budget' }],
      payload: { recommendations: [{ sku_id: 'sku_1' }] },
      fieldMissing: [],
      nextState: undefined,
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    });

    expect(envelope.assistant_message).toEqual({
      content: 'I generated a simple AM/PM routine first (efficacy + tolerance prioritized). If you want, I can optimize it by budget next.',
    });
    expect(envelope.suggested_chips).toEqual([{ chip_id: 'optimize_budget' }]);
    expect(envelope.session_patch).toEqual({});
  });

  test('buildRecoTimeoutDegradedEnvelope preserves session context and llm trace refs', () => {
    const runtime = buildRuntime();
    const envelope = runtime.buildRecoTimeoutDegradedEnvelope({
      ctx: { request_id: 'req_reco_1', lang: 'EN' },
      latestArtifactId: 'artifact_1',
      recoEntrySourceDetail: 'profile_refine_rerun',
      triggerSource: 'text',
      actionId: 'chip.reco',
      message: 'recommend something',
      includeAlternatives: true,
      ingredientQuery: 'niacinamide',
      goal: 'hydration',
      mappedIngredientPlan: { plan_id: 'plan_1' },
      refinementChips: [{ chip_id: 'retry' }],
      recoLlmTrace: { trace_id: 'llm_1' },
      upstreamFailureCode: 'RECO_TIMEOUT',
      shouldAutoRerunRecommendationsFromProfilePatch: true,
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    });

    expect(envelope.cards.map((card) => card.type)).toEqual(['confidence_notice', 'ingredient_plan']);
    expect(envelope.session_patch).toEqual({
      latest_artifact_id: 'artifact_1',
      latest_reco_context: {
        intent: 'reco_products',
        source_detail: 'profile_refine_rerun',
        trigger_source: 'text',
        action_id: 'chip.reco',
        message: 'recommend something',
        include_alternatives: true,
        ingredient_query: 'niacinamide',
        goal: 'hydration',
      },
    });
    expect(envelope.events).toEqual([
      {
        event_name: 'reco_timeout_degraded',
        event_data: {
          source: 'upstream_timeout',
          upstream_failure_code: 'RECO_TIMEOUT',
          failure_class: 'timeout',
          llm_trace_ref: 'trace:llm_1',
        },
      },
      {
        event_name: 'recos_requested',
        event_data: {
          explicit: true,
          gated: true,
          reason: 'artifact_missing',
          telemetry_reason: 'timeout_degraded',
          source: 'upstream_timeout',
          source_mode: 'rules_only',
          grounding_status: 'ungrounded',
          grounded_count: 0,
          ungrounded_count: 0,
          mainline_status: 'upstream_timeout',
          source_detail: 'profile_refine_rerun',
          recompute_from_profile_update: true,
          upstream_failure_code: 'RECO_TIMEOUT',
          failure_class: 'timeout',
          llm_trace_ref: 'trace:llm_1',
        },
      },
    ]);
  });
});
