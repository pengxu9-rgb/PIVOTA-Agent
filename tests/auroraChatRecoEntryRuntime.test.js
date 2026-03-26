const { createChatRecoEntryRuntime } = require('../src/auroraBff/chatRecoEntryRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    looksLikeRoutineRequest: jest.fn(() => false),
    looksLikeSuitabilityRequest: jest.fn(() => false),
    looksLikeRecommendationRequest: jest.fn(() => false),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    isBudgetClarificationAction: jest.fn(() => false),
    isBareBudgetSelectionMessage: jest.fn(() => false),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRecoEntryRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    forceUpstreamAfterPendingAbandon: false,
    actionId: '',
    clarificationId: '',
    appliedProfilePatch: null,
    textDerivedProfilePatch: null,
    textDerivedSkinLog: null,
    latestRecoContextFromSession: null,
    allowRecoCards: true,
    message: 'Recommend something',
    normalizedActionPayload: null,
    ingredientRecoOptInRequested: false,
    ingredientLookupRequested: false,
    ingredientByGoalRequested: false,
    ctx: {
      request_id: 'req_reco_entry_1',
      lang: 'EN',
      state: 'IDLE_CHAT',
    },
    profile: { skinType: 'dry' },
    buildEnvelope: jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload })),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    summarizeChatProfileForContext: jest.fn((profile) => profile),
    ...overrides,
  };
}

describe('aurora chat reco entry runtime', () => {
  test('returns stale budget guard envelope when leftover budget chip arrives out of reco flow', () => {
    const { runtime } = buildHarness({
      isBudgetClarificationAction: jest.fn(() => true),
      isBareBudgetSelectionMessage: jest.fn(() => true),
    });

    const out = runtime.prepareRecoEntry(buildArgs({
      actionId: 'chip.clarify.budget.low',
      clarificationId: 'budget',
      message: '$50-$100',
      ctx: {
        request_id: 'req_budget_guard_1',
        lang: 'EN',
        state: 'IDLE_CHAT',
      },
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope.assistant_message.content).toContain('Budget noted');
    expect(out.envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'profile',
        payload: { profile: { skinType: 'dry' } },
      }),
    );
    expect(out.envelope.events[0]).toEqual(
      expect.objectContaining({
        event_name: 'state_entered',
        event_data: expect.objectContaining({ reason: 'stale_budget_chip_ignored' }),
      }),
    );
  });

  test('computes profile rerun reco entry context from text-derived patch plus reco session', () => {
    const { runtime } = buildHarness();

    const out = runtime.prepareRecoEntry(buildArgs({
      textDerivedProfilePatch: { skinType: 'combo' },
      latestRecoContextFromSession: { intent: 'reco_products' },
      message: 'My skin is actually more combo now',
    }));

    expect(out.handled).toBe(false);
    expect(out.shouldAutoRerunRecommendationsFromProfilePatch).toBe(true);
    expect(out.recoEntrySourceDetail).toBe('profile_refine_rerun');
    expect(out.recoRequestMessage).toBe('My skin is actually more combo now');
  });

  test('marks ingredient-driven entry and budget continuation when still in S6_BUDGET', () => {
    const { runtime } = buildHarness({
      isBudgetClarificationAction: jest.fn(() => true),
    });

    const out = runtime.prepareRecoEntry(buildArgs({
      actionId: 'chip.clarify.budget.medium',
      clarificationId: 'budget',
      ingredientRecoOptInRequested: true,
      ctx: {
        request_id: 'req_budget_continue_1',
        lang: 'CN',
        state: 'S6_BUDGET',
      },
      message: '200-300',
    }));

    expect(out.handled).toBe(false);
    expect(out.budgetChipCanContinueReco).toBe(true);
    expect(out.ingredientDrivenRecommendationRequested).toBe(true);
    expect(out.recoEntrySourceDetail).toBe('ingredient_driven');
  });
});
