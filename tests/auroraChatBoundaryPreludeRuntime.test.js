const { createChatBoundaryPreludeRuntime } = require('../src/auroraBff/chatBoundaryPreludeRuntime');

function buildHarness(overrides = {}) {
  const chatBoundaryRuntime = {
    computeSafetyDecision: jest.fn(() => ({
      anchorCollectionSignal: false,
      safetyDecision: { block_level: 'warn' },
    })),
    analyzeBoundaryState: jest.fn(() => ({
      anchorCollectionSignal: false,
      safetyDecision: { block_level: 'warn' },
      shouldBypassAvailabilityShortCircuit: true,
      shouldRunSafetyPreGate: false,
    })),
    maybeBuildFitCheckAnchorEnvelope: jest.fn(() => null),
    runSafetyPreGate: jest.fn(async ({ profile, pendingSafetyAdvisory }) => ({
      profile,
      pendingSafetyAdvisory,
      blockedEnvelope: null,
    })),
  };

  const deps = {
    resolveQaPlan: jest.fn(() => ({
      gate_type: 'soft',
      loop_count: '2',
      break_applied: 'conservative_defaults',
      session_state_patch: { next_state: 'planner_next' },
    })),
    stateChangeAllowed: jest.fn(() => true),
    looksLikeSuitabilityRequest: jest.fn(() => false),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    looksLikeRoutineRequest: jest.fn(() => false),
    looksLikeRecommendationRequest: jest.fn(() => false),
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    chatBoundaryRuntime,
    ...overrides,
  };

  return {
    deps,
    chatBoundaryRuntime,
    runtime: createChatBoundaryPreludeRuntime(deps),
  };
}

describe('aurora chat boundary prelude runtime', () => {
  test('returns planner patch and escapes sticky budget gate for reco follow-up', async () => {
    const { runtime, deps, chatBoundaryRuntime } = buildHarness({
      looksLikeRecommendationRequest: jest.fn(() => true),
    });

    const result = await runtime.prepareBoundaryPrelude({
      effectiveChatFlags: { qa_planner_v1: true },
      message: 'Give me product recommendations',
      actionId: 'chip.start.reco_products',
      ctx: { state: 'S6_BUDGET', trigger_source: 'text', lang: 'EN', match_lang: 'EN' },
      canonicalIntent: { intent: 'reco_products' },
      profile: { skinType: 'dry' },
      allowRecoCards: true,
      recommendationEntryRequested: true,
      diagnosisEntryRequested: false,
      evaluateIntent: false,
      ingredientScienceIntentEffective: false,
      conflictIntentRequested: false,
      appliedProfilePatch: { skinType: 'dry' },
      anchorProductId: 'prod_1',
      session: { id: 'sess_1' },
    });

    expect(deps.resolveQaPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'reco_products',
        message: 'Give me product recommendations',
        hasAnchor: false,
        session: { id: 'sess_1' },
      }),
    );
    expect(chatBoundaryRuntime.computeSafetyDecision).toHaveBeenCalled();
    expect(chatBoundaryRuntime.analyzeBoundaryState).toHaveBeenCalledWith(
      expect.objectContaining({
        conflictIntentRequested: false,
        ingredientScienceIntentEffective: false,
      }),
    );
    expect(result.plannerDecision).toEqual(
      expect.objectContaining({
        gate_type: 'soft',
        break_applied: 'conservative_defaults',
      }),
    );
    expect(result.plannerPolicyMetaPatch).toEqual({
      gate_type: 'soft',
      loop_count: 2,
      break_applied: 'conservative_defaults',
    });
    expect(result.plannerSessionStatePatch).toEqual({ next_state: 'planner_next' });
    expect(result.diagnosisFlowContinuationAllowed).toBe(false);
    expect(result.nextStateOverride).toBe('S7_PRODUCT_RECO');
    expect(result.nextCtxState).toBe('S7_PRODUCT_RECO');
    expect(result.shouldBypassAvailabilityShortCircuit).toBe(true);
  });

  test('returns fit-check anchor envelope before safety pre-gate', async () => {
    const { runtime, chatBoundaryRuntime } = buildHarness();
    chatBoundaryRuntime.maybeBuildFitCheckAnchorEnvelope.mockReturnValue({
      envelope: { assistant_message: { content: 'paste product link' } },
      gateType: 'soft',
    });

    const result = await runtime.prepareBoundaryPrelude({
      message: 'Is this good for me?',
      actionId: 'chip.action.analyze_product',
      ctx: { state: 'idle', trigger_source: 'text', lang: 'EN' },
      canonicalIntent: { intent: 'evaluate_product' },
      profile: { skinType: 'dry' },
      evaluateIntent: true,
      buildEnvelope: jest.fn(),
      makeChatAssistantMessage: jest.fn(),
      makeEvent: jest.fn(),
    });

    expect(result.blockedEnvelope).toEqual({
      assistant_message: { content: 'paste product link' },
    });
    expect(result.fitCheckAnchorGateType).toBe('soft');
    expect(chatBoundaryRuntime.runSafetyPreGate).not.toHaveBeenCalled();
  });

  test('returns safety gate patch when pre-gate blocks the turn', async () => {
    const { runtime, chatBoundaryRuntime } = buildHarness();
    chatBoundaryRuntime.analyzeBoundaryState.mockReturnValue({
      anchorCollectionSignal: false,
      safetyDecision: { block_level: 'require_info' },
      shouldBypassAvailabilityShortCircuit: true,
      shouldRunSafetyPreGate: true,
    });
    chatBoundaryRuntime.runSafetyPreGate.mockResolvedValue({
      profile: { persisted: true },
      pendingSafetyAdvisory: { reason: 'warn' },
      blockedEnvelope: { assistant_message: { content: 'blocked' } },
    });

    const result = await runtime.prepareBoundaryPrelude({
      message: 'Can I combine retinoid and acids?',
      actionId: '',
      ctx: { state: 'idle', trigger_source: 'text', lang: 'EN' },
      canonicalIntent: { intent: 'reco_products' },
      profile: { skinType: 'dry' },
      conflictIntentRequested: true,
      buildEnvelope: jest.fn(),
      makeChatAssistantMessage: jest.fn(),
      makeEvent: jest.fn(),
      identity: { auroraUid: 'aurora_1' },
    });

    expect(chatBoundaryRuntime.runSafetyPreGate).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldRunSafetyPreGate: true,
        conflictIntentRequested: true,
        identity: { auroraUid: 'aurora_1' },
      }),
    );
    expect(result.profile).toEqual({ persisted: true });
    expect(result.pendingSafetyAdvisory).toEqual({ reason: 'warn' });
    expect(result.blockedEnvelope).toEqual({
      assistant_message: { content: 'blocked' },
    });
    expect(result.safetyPolicyMetaPatch).toEqual({
      safety_gate_mode: 'advisory_only_v1',
      safety_advisory_emitted: false,
    });
  });
});
