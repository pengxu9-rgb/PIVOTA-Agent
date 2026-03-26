const { createChatRecommendationFlowRuntime } = require('../src/auroraBff/chatRecommendationFlowRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    looksLikeSuitabilityRequest: jest.fn(() => false),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    looksLikeRecommendationRequest: jest.fn(() => false),
    chatRoutineGateRuntime: {
      resolveRoutineGate: jest.fn(async () => ({
        handled: false,
        envelope: null,
        profile: { skinType: 'dry', from: 'routine_gate' },
        nextStateOverride: 'S7_PRODUCT_RECO',
        nextCtxState: 'S7_PRODUCT_RECO',
        policyMetaPatch: { gate_type: 'soft' },
      })),
    },
    chatRecoEntryRuntime: {
      prepareRecoEntry: jest.fn(() => ({
        handled: false,
        envelope: null,
        budgetChipCanContinueReco: true,
        profileClarificationAction: false,
        ingredientDrivenRecommendationRequested: true,
        shouldAutoRerunRecommendationsFromProfilePatch: false,
        recoEntrySourceDetail: 'ingredient_driven',
        recoRequestMessage: 'recommend for me',
      })),
    },
    chatRecommendationRuntime: {
      maybeBuildRecommendationEnvelope: jest.fn(async () => ({
        handled: false,
        envelope: null,
        ingredientRecoContext: { source: 'recommendation' },
        profile: { skinType: 'dry', from: 'recommendation' },
        pendingSafetyAdvisory: { kind: 'warn' },
        pendingClarificationPatchOverride: { next_step: 'clarify' },
      })),
    },
    chatProfileContinuationRuntime: {
      maybeBuildProfileContinuationEnvelope: jest.fn(() => null),
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRecommendationFlowRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    forceUpstreamAfterPendingAbandon: false,
    actionId: 'chip.start.reco_products',
    clarificationId: '',
    allowRecoCards: true,
    ctx: {
      request_id: 'req_reco_flow_1',
      lang: 'EN',
      state: 'IDLE_CHAT',
      trigger_source: 'text',
    },
    profile: { skinType: 'dry' },
    appliedProfilePatch: null,
    message: 'recommend something',
    normalizedActionPayload: null,
    ingredientScienceIntentEffective: false,
    recoInteractionAllowed: true,
    includeAlternatives: false,
    identity: { auroraUid: 'aur_1' },
    recentLogs: [{ id: 'log_1' }],
    debugUpstream: false,
    nextStateOverride: null,
    summarizeChatProfileForContext: jest.fn((profile) => profile),
    pushGateDecision: jest.fn(() => ({ mode: 'ADVISORY' })),
    enqueueGateAdvisory: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload })),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    textDerivedProfilePatch: null,
    textDerivedSkinLog: null,
    latestRecoContextFromSession: null,
    ingredientRecoOptInRequested: false,
    ingredientLookupRequested: false,
    ingredientByGoalRequested: false,
    ingredientRecoContext: { source: 'seed' },
    ingredientActionData: null,
    safetyDecision: null,
    pendingSafetyAdvisory: null,
    pendingClarificationPatchOverride: null,
    buildDiagnosisChips: jest.fn(() => [{ chip_id: 'diag_1' }]),
    chatSafetyRuntime: { resolveSafetyGate: jest.fn() },
    chatDiagnosisGateRuntime: { buildDiagnosisGateEnvelope: jest.fn() },
    canonicalIntent: 'recommendation',
    session: { id: 'session_1' },
    buildSafetyNoticeText: jest.fn(() => 'Safety notice'),
    agentState: 'IDLE_CHAT',
    ingredientEntryRequested: false,
    ingredientTextTrigger: false,
    buildDiagnosisPrompt: jest.fn(() => 'diagnosis prompt'),
    ...overrides,
  };
}

describe('aurora chat recommendation flow runtime', () => {
  test('returns routine gate envelope when budget/routine gate handles the turn', async () => {
    const routineEnvelope = { type: 'routine_gate' };
    const { runtime, deps } = buildHarness({
      chatRoutineGateRuntime: {
        resolveRoutineGate: jest.fn(async () => ({
          handled: true,
          envelope: routineEnvelope,
          profile: { skinType: 'dry', from: 'routine_gate' },
          nextStateOverride: 'S6_BUDGET',
          nextCtxState: 'S6_BUDGET',
          policyMetaPatch: { gate_type: 'soft' },
        })),
      },
    });

    const out = await runtime.resolveRecommendationFlow(buildArgs());

    expect(out.handled).toBe(true);
    expect(out.envelope).toBe(routineEnvelope);
    expect(out.nextStateOverride).toBe('S6_BUDGET');
    expect(out.nextCtxState).toBe('S6_BUDGET');
    expect(out.policyMetaPatch).toEqual({ gate_type: 'soft' });
    expect(deps.chatRecoEntryRuntime.prepareRecoEntry).not.toHaveBeenCalled();
  });

  test('returns recommendation envelope and forwards reco entry outputs', async () => {
    const recommendationEnvelope = { type: 'recommendations' };
    const { runtime, deps } = buildHarness({
      chatRecommendationRuntime: {
        maybeBuildRecommendationEnvelope: jest.fn(async () => ({
          handled: true,
          envelope: recommendationEnvelope,
          ingredientRecoContext: { source: 'recommendation' },
          profile: { skinType: 'dry', from: 'recommendation' },
          pendingSafetyAdvisory: { kind: 'warn' },
          pendingClarificationPatchOverride: { next_step: 'clarify' },
        })),
      },
    });

    const out = await runtime.resolveRecommendationFlow(buildArgs({
      ingredientRecoOptInRequested: true,
      ingredientLookupRequested: true,
      ingredientByGoalRequested: true,
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope).toBe(recommendationEnvelope);
    expect(deps.chatRecommendationRuntime.maybeBuildRecommendationEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetChipCanContinueReco: true,
        ingredientDrivenRecommendationRequested: true,
        recoEntrySourceDetail: 'ingredient_driven',
        recoRequestMessage: 'recommend for me',
      }),
    );
    expect(out.ingredientRecoContext).toEqual({ source: 'recommendation' });
    expect(out.pendingClarificationPatchOverride).toEqual({ next_step: 'clarify' });
  });

  test('returns profile continuation envelope after reco flow falls through', async () => {
    const continuationEnvelope = { type: 'profile_continuation' };
    const { runtime, deps } = buildHarness({
      chatProfileContinuationRuntime: {
        maybeBuildProfileContinuationEnvelope: jest.fn(() => continuationEnvelope),
      },
    });

    const out = await runtime.resolveRecommendationFlow(buildArgs({
      appliedProfilePatch: { skinType: 'oily' },
      message: '',
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope).toBe(continuationEnvelope);
    expect(deps.chatProfileContinuationRuntime.maybeBuildProfileContinuationEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        hasExplicitUserIntentMessage: false,
        profile: expect.objectContaining({ from: 'recommendation' }),
      }),
    );
  });

  test('returns pass-through state when no downstream branch handles the turn', async () => {
    const { runtime } = buildHarness();

    const out = await runtime.resolveRecommendationFlow(buildArgs());

    expect(out.handled).toBe(false);
    expect(out.envelope).toBeNull();
    expect(out.profile).toEqual({ skinType: 'dry', from: 'recommendation' });
    expect(out.nextStateOverride).toBe('S7_PRODUCT_RECO');
    expect(out.nextCtxState).toBe('S7_PRODUCT_RECO');
    expect(out.policyMetaPatch).toEqual({ gate_type: 'soft' });
    expect(out.pendingSafetyAdvisory).toEqual({ kind: 'warn' });
  });

  test('preserves undefined pending clarification override when reco flow does not handle the turn', async () => {
    const { runtime } = buildHarness({
      chatRecommendationRuntime: {
        maybeBuildRecommendationEnvelope: jest.fn(async () => ({
          handled: false,
          envelope: null,
          ingredientRecoContext: { source: 'recommendation' },
          profile: { skinType: 'dry', from: 'recommendation' },
          pendingSafetyAdvisory: { kind: 'warn' },
          pendingClarificationPatchOverride: undefined,
        })),
      },
    });

    const out = await runtime.resolveRecommendationFlow(buildArgs({
      pendingClarificationPatchOverride: undefined,
    }));

    expect(out.handled).toBe(false);
    expect(out.pendingClarificationPatchOverride).toBeUndefined();
  });
});
