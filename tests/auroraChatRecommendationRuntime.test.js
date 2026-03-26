const { createChatRecommendationRuntime } = require('../src/auroraBff/chatRecommendationRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    looksLikeIngredientScienceIntent: jest.fn(() => false),
    looksLikeRoutineRequest: jest.fn(() => false),
    looksLikeSuitabilityRequest: jest.fn(() => false),
    looksLikeRecommendationRequest: jest.fn(() => false),
    chatRecoPreludeRuntime: {
      prepareRecoRequestPrelude: jest.fn(async () => ({
        recoIngredientContext: { goal: 'hydration' },
        profile: { skinType: 'dry' },
        pendingSafetyAdvisory: { level: 'warn' },
        pendingClarificationPatchOverride: { pending: true },
        recoContextIngredientQuery: 'niacinamide',
        recoContextGoal: 'hydration',
        recoIngredientCandidates: ['niacinamide'],
        recoProductCandidates: [{ sku_id: 'sku_1' }],
        recoTaskMode: 'goal_based_products',
        profileScore: 4,
        refinementChips: [{ chip_id: 'refine_1' }],
        blockedEnvelope: null,
      })),
    },
    chatRecoArtifactRuntime: {
      prepareRecoArtifactContext: jest.fn(async () => ({
        latestArtifact: { artifact_id: 'artifact_1' },
        mappedIngredientPlan: { plan_id: 'plan_1' },
        artifactConfidenceLevel: 'high',
        artifactConfidenceScore: 0.91,
        artifactGateOk: true,
        lowConfidenceArtifact: false,
      })),
    },
    chatRecoResolveRuntime: {
      resolveRecoEnvelope: jest.fn(async () => ({ assistant_message: { content: 'resolved' } })),
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRecommendationRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    forceUpstreamAfterPendingAbandon: false,
    allowRecoCards: true,
    message: 'recommend a routine',
    normalizedActionPayload: null,
    ingredientRecoOptInRequested: false,
    actionId: 'chip.start.reco_products',
    budgetChipCanContinueReco: false,
    profileClarificationAction: false,
    ingredientDrivenRecommendationRequested: false,
    shouldAutoRerunRecommendationsFromProfilePatch: false,
    recoInteractionAllowed: true,
    ingredientRecoContext: null,
    ingredientActionData: null,
    ctx: { request_id: 'req_1', lang: 'EN' },
    recoEntrySourceDetail: 'chip_entry',
    safetyDecision: { block_level: 'warn' },
    profile: { skinType: 'dry' },
    identity: { auroraUid: 'aur_1' },
    pendingSafetyAdvisory: null,
    pushGateDecision: jest.fn(),
    enqueueGateAdvisory: jest.fn(),
    pendingClarificationPatchOverride: undefined,
    buildDiagnosisChips: jest.fn(() => [{ chip_id: 'chip_a' }]),
    chatDiagnosisGateRuntime: { applyDiagnosisFirstProfileGate: jest.fn() },
    buildEnvelope: jest.fn((_ctx, payload) => payload),
    makeChatAssistantMessage: jest.fn((content) => ({ content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    canonicalIntent: { intent: 'reco_products' },
    session: { meta: {} },
    recentLogs: [{ id: 'log_1' }],
    includeAlternatives: true,
    debugUpstream: false,
    recoRequestMessage: 'recommend a routine',
    buildSafetyNoticeText: jest.fn(() => 'warn text'),
    ...overrides,
  };
}

describe('aurora chat recommendation runtime', () => {
  test('returns not handled when recommendation entry is not requested', async () => {
    const { runtime, deps } = buildRuntime({
      looksLikeRecommendationRequest: jest.fn(() => false),
    });

    const out = await runtime.maybeBuildRecommendationEnvelope(buildArgs({
      actionId: '',
      recoInteractionAllowed: false,
    }));

    expect(out.handled).toBe(false);
    expect(out.envelope).toBeNull();
    expect(out.pendingClarificationPatchOverride).toBeUndefined();
    expect(deps.chatRecoPreludeRuntime.prepareRecoRequestPrelude).not.toHaveBeenCalled();
  });

  test('returns blocked envelope from reco prelude without continuing', async () => {
    const blockedEnvelope = { assistant_message: { content: 'blocked' } };
    const { runtime, deps } = buildRuntime({
      chatRecoPreludeRuntime: {
        prepareRecoRequestPrelude: jest.fn(async () => ({
          recoIngredientContext: { goal: 'hydration' },
          profile: { skinType: 'combo' },
          pendingSafetyAdvisory: { level: 'warn' },
          pendingClarificationPatchOverride: { pending: true },
          recoContextIngredientQuery: '',
          recoContextGoal: '',
          recoIngredientCandidates: [],
          recoProductCandidates: [],
          recoTaskMode: 'goal_based_products',
          profileScore: 2,
          refinementChips: [],
          blockedEnvelope,
        })),
      },
    });

    const out = await runtime.maybeBuildRecommendationEnvelope(buildArgs());

    expect(out).toEqual({
      handled: true,
      envelope: blockedEnvelope,
      ingredientRecoContext: { goal: 'hydration' },
      profile: { skinType: 'combo' },
      pendingSafetyAdvisory: { level: 'warn' },
      pendingClarificationPatchOverride: { pending: true },
    });
    expect(deps.chatRecoArtifactRuntime.prepareRecoArtifactContext).not.toHaveBeenCalled();
    expect(deps.chatRecoResolveRuntime.resolveRecoEnvelope).not.toHaveBeenCalled();
  });

  test('resolves recommendation envelope and propagates reco state updates', async () => {
    const { runtime, deps } = buildRuntime();
    const args = buildArgs({
      ingredientDrivenRecommendationRequested: true,
    });

    const out = await runtime.maybeBuildRecommendationEnvelope(args);

    expect(out.handled).toBe(true);
    expect(out.envelope).toEqual({ assistant_message: { content: 'resolved' } });
    expect(out.ingredientRecoContext).toEqual({ goal: 'hydration' });
    expect(out.profile).toEqual({ skinType: 'dry' });
    expect(out.pendingSafetyAdvisory).toEqual({ level: 'warn' });
    expect(out.pendingClarificationPatchOverride).toEqual({ pending: true });
    expect(deps.chatRecoArtifactRuntime.prepareRecoArtifactContext).toHaveBeenCalledWith(
      expect.objectContaining({
        session: { meta: {} },
        refinementChips: [{ chip_id: 'refine_1' }],
      }),
    );
    expect(deps.chatRecoResolveRuntime.resolveRecoEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        recoIngredientContext: { goal: 'hydration' },
        recoContextIngredientQuery: 'niacinamide',
        recoContextGoal: 'hydration',
        recoIngredientCandidates: ['niacinamide'],
        recoProductCandidates: [{ sku_id: 'sku_1' }],
        recoTaskMode: 'goal_based_products',
        artifactConfidenceLevel: 'high',
        artifactConfidenceScore: 0.91,
        safetyWarnText: 'warn text',
      }),
    );
    expect(args.buildSafetyNoticeText).toHaveBeenCalledWith({ block_level: 'warn' });
  });
});
