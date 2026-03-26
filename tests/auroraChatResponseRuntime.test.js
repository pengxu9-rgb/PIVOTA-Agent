const { createChatResponseRuntime } = require('../src/auroraBff/chatResponseRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    makeEvent: jest.fn((ctx, event_name, event_data) => ({
      event_name,
      event_data,
      request_id: ctx && ctx.request_id ? ctx.request_id : null,
    })),
    applyReplyTemplates: jest.fn(({ envelope }) => ({
      ...envelope,
      meta: { ...(envelope.meta || {}), reply_templated: true },
    })),
    augmentEnvelopeProductAnalysisCardsForDogfood: jest.fn(({ envelope }) => ({
      ...envelope,
      meta: { ...(envelope.meta || {}), dogfood_augmented: true },
    })),
    shouldApplyRecoOutputGuard: jest.fn(() => false),
    applyLowOrMediumRecoGuardToEnvelope: jest.fn(({ envelope }) => ({
      envelope,
      applied: false,
      filteredCount: 0,
      totalCount: 0,
      fallbackApplied: false,
    })),
    recordAuroraSkinFlowMetric: jest.fn(),
    ensureNonEmptyChatCardsEnvelope: jest.fn(({ envelope }) => ({
      envelope,
      applied: false,
      reason: null,
    })),
    isRoutineContractIntent: jest.fn(() => false),
    hasRoutineSosSignal: jest.fn(() => false),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    looksLikeRoutineRequest: jest.fn(() => false),
    looksLikeIngredientScienceIntent: jest.fn(() => false),
    findRoutineExpertNodeFromEnvelope: jest.fn(() => null),
    hasRoutineExpertRequiredModules: jest.fn(() => false),
    buildRoutineRulesOnlyFallbackCardsForChat: jest.fn(() => []),
    AURORA_MULTITURN_CONTRACT_GATE_V1_ENABLED: false,
    evaluateQualityContractForEnvelope: jest.fn(() => null),
    recordChatStallPhrase: jest.fn(),
    recordContractFail: jest.fn(),
    recordRecommendationUrlInvariantFail: jest.fn(),
    recordKnownFieldReask: jest.fn(),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatResponseRuntime(deps),
  };
}

describe('aurora chat response runtime', () => {
  test('applyPolicyMetaToEnvelope injects meta and policy event', () => {
    const { runtime } = buildRuntime();

    const out = runtime.applyPolicyMetaToEnvelope({
      envelope: {
        session_patch: { meta: { existing: true } },
        meta: { top: true },
        events: [],
      },
      shouldAttachPolicyMeta: true,
      policyMeta: {
        intent_source: 'router',
        intent_canonical: 'reco_products',
        break_applied: 'chips_single_question',
        gate_type: 'diagnosis_gate',
      },
      plannerSessionStatePatch: { budget_tier: 'low' },
      latestClarificationId: 'clarify_1',
      ctx: { request_id: 'req_policy' },
    });

    expect(out.session_patch.meta).toEqual(
      expect.objectContaining({
        existing: true,
        intent_source: 'router',
        intent_canonical: 'reco_products',
      }),
    );
    expect(out.session_patch.state).toEqual({ budget_tier: 'low' });
    expect(out.meta).toEqual(
      expect.objectContaining({
        top: true,
        gate_type: 'diagnosis_gate',
      }),
    );
    expect(out.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_name: 'aurora_policy_meta',
          event_data: expect.objectContaining({
            intent_source: 'router',
            clarification_id: 'clarify_1',
            loop_breaker_triggered: true,
          }),
        }),
      ]),
    );
  });

  test('applyRolloutHeaders uses response header setter', () => {
    const { runtime } = buildRuntime();
    const res = { setHeader: jest.fn() };

    runtime.applyRolloutHeaders({
      res,
      rolloutContext: {
        bucket: 7,
        variant: 'beta',
        policy_version: 'chat_v2',
      },
      policyMeta: {},
    });

    expect(res.setHeader).toHaveBeenCalledWith('x-aurora-bucket', '7');
    expect(res.setHeader).toHaveBeenCalledWith('x-aurora-variant', 'beta');
    expect(res.setHeader).toHaveBeenCalledWith('x-aurora-policy-version', 'chat_v2');
  });

  test('prepareEnvelopeForDelivery adds routine fallback cards and quality contract', () => {
    const { runtime, deps } = buildRuntime({
      isRoutineContractIntent: jest.fn(() => true),
      buildRoutineRulesOnlyFallbackCardsForChat: jest.fn(() => [
        { type: 'analysis_summary', payload: { source: 'rules' } },
        { type: 'confidence_notice', payload: { source: 'rules' } },
      ]),
      AURORA_MULTITURN_CONTRACT_GATE_V1_ENABLED: true,
      evaluateQualityContractForEnvelope: jest.fn(() => ({
        stall_hit: true,
        critical_fail_reasons: ['missing_anchor'],
        strict_fail_flags: {
          missing_product_urls_in_recommendations: true,
          entity_miss_fail_seed_profile: true,
        },
      })),
    });

    const out = runtime.prepareEnvelopeForDelivery({
      envelope: {
        assistant_message: { content: 'routine answer' },
        cards: [],
        events: [],
      },
      statusCode: 200,
      req: {},
      ctx: { request_id: 'req_routine', trace_id: 'trace_routine', lang: 'EN' },
      templateCtx: {},
      chatSessionId: 'session_routine',
      requestMessage: 'build me a routine',
      profile: { skinType: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      policyMeta: { intent_canonical: 'routine' },
      canonicalIntent: 'routine',
      skipRoutineRulesFallback: false,
    });

    expect(out.cards.map((card) => card.type)).toEqual(['analysis_summary', 'confidence_notice']);
    expect(out.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_name: 'routine_rules_fallback',
          event_data: expect.objectContaining({
            reason: 'contract_module_missing',
            intent_canonical: 'routine',
          }),
        }),
      ]),
    );
    expect(out.meta).toEqual(
      expect.objectContaining({
        dogfood_augmented: true,
        reply_templated: true,
        quality_contract: expect.objectContaining({
          stall_hit: true,
        }),
      }),
    );
    expect(deps.recordChatStallPhrase).toHaveBeenCalledWith(1);
    expect(deps.recordContractFail).toHaveBeenCalledWith('missing_anchor', 1);
    expect(deps.recordRecommendationUrlInvariantFail).toHaveBeenCalledWith(1);
    expect(deps.recordKnownFieldReask).toHaveBeenCalledWith(1);
  });

  test('prepareEnvelopeForDelivery records low-medium and empty-card guards', () => {
    const { runtime, deps } = buildRuntime({
      shouldApplyRecoOutputGuard: jest.fn(() => true),
      applyLowOrMediumRecoGuardToEnvelope: jest.fn(({ envelope }) => ({
        envelope: { ...envelope, cards: [] },
        applied: true,
        filteredCount: 2,
        totalCount: 3,
        fallbackApplied: true,
      })),
      ensureNonEmptyChatCardsEnvelope: jest.fn(({ envelope }) => ({
        envelope: { ...envelope, cards: [{ type: 'confidence_notice' }] },
        applied: true,
        reason: 'empty_cards',
      })),
    });

    const out = runtime.prepareEnvelopeForDelivery({
      envelope: {
        assistant_message: { content: 'reco answer' },
        cards: [{ type: 'recommendations' }],
      },
      statusCode: 200,
      req: {},
      ctx: { request_id: 'req_guard', trace_id: 'trace_guard', lang: 'EN' },
      templateCtx: {},
      chatSessionId: 'session_guard',
      requestMessage: 'recommend products',
      profile: {},
      recentLogs: [],
      policyMeta: { intent_canonical: 'reco_products' },
      canonicalIntent: 'reco_products',
      skipRoutineRulesFallback: true,
    });

    expect(out.cards).toEqual([{ type: 'confidence_notice' }]);
    expect(deps.recordAuroraSkinFlowMetric).toHaveBeenCalledWith({
      stage: 'reco_low_medium_treatment_filtered',
      hit: true,
    });
    expect(deps.recordAuroraSkinFlowMetric).toHaveBeenCalledWith({
      stage: 'reco_low_medium_notice_fallback',
      hit: true,
    });
    expect(deps.recordAuroraSkinFlowMetric).toHaveBeenCalledWith({
      stage: 'reco_output_guard_fallback',
      hit: true,
    });
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_guard',
        filtered_count: 2,
      }),
      'aurora bff: low/medium confidence reco treatment filter applied',
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_guard',
        reason: 'empty_cards',
      }),
      'aurora bff: reco output guard applied due to empty/unrenderable cards',
    );
  });
});
