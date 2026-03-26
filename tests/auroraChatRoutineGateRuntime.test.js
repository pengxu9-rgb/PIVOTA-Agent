const { createChatRoutineGateRuntime } = require('../src/auroraBff/chatRoutineGateRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    logger: {
      warn: jest.fn(),
    },
    isBudgetOptimizationEntryAction: jest.fn(() => false),
    looksLikeSuitabilityRequest: jest.fn(() => false),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    looksLikeRecommendationRequest: jest.fn(() => false),
    looksLikeRoutineRequest: jest.fn(() => false),
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    buildBudgetGatePrompt: jest.fn((lang) => `budget-prompt:${lang}`),
    buildBudgetGateChips: jest.fn((lang) => [{ chip_id: `budget_${lang}` }]),
    normalizeBudgetHint: jest.fn((value) => {
      if (value === '$50') return 'mid';
      if (typeof value === 'string') return value.trim();
      return '';
    }),
    upsertProfileForIdentity: jest.fn(async (_identity, patch) => ({ persisted: true, ...patch })),
    stateChangeAllowed: jest.fn(() => true),
    chatRoutineRecoRuntime: {
      resolveRoutineRecoEnvelope: jest.fn(async (args) => ({ mode: 'routine', args })),
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRoutineGateRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    actionId: '',
    allowRecoCards: true,
    ctx: {
      request_id: 'req_routine_gate_1',
      lang: 'EN',
      state: 'IDLE_CHAT',
      trigger_source: 'text',
    },
    profile: { skinType: 'dry' },
    appliedProfilePatch: null,
    message: 'build me a routine',
    normalizedActionPayload: null,
    ingredientScienceIntentEffective: false,
    recoInteractionAllowed: true,
    includeAlternatives: false,
    identity: { auroraUid: 'aur_1', userId: 'user_1' },
    recentLogs: [{ id: 'log_1' }],
    debugUpstream: false,
    nextStateOverride: null,
    summarizeChatProfileForContext: jest.fn((profile) => profile),
    pushGateDecision: jest.fn(() => ({ mode: 'ADVISORY' })),
    enqueueGateAdvisory: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload })),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    ...overrides,
  };
}

describe('aurora chat routine gate runtime', () => {
  test('builds budget entry envelope when budget optimization action is clicked', async () => {
    const { runtime } = buildHarness({
      isBudgetOptimizationEntryAction: jest.fn(() => true),
    });

    const out = await runtime.resolveRoutineGate(buildArgs({
      actionId: 'chip.action.budget_optimization_entry',
      message: '',
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'budget_gate',
        payload: expect.objectContaining({ reason: 'budget_optimization_optional' }),
      }),
    );
    expect(out.envelope.session_patch).toEqual({ next_state: 'S6_BUDGET' });
  });

  test('bypasses S6_BUDGET when user switches to fit-check intent', async () => {
    const { runtime, deps } = buildHarness({
      looksLikeSuitabilityRequest: jest.fn(() => true),
    });

    const out = await runtime.resolveRoutineGate(buildArgs({
      ctx: {
        request_id: 'req_routine_gate_2',
        lang: 'EN',
        state: 'S6_BUDGET',
        trigger_source: 'text',
      },
      message: 'Is this suitable for me?',
    }));

    expect(out.handled).toBe(false);
    expect(out.nextStateOverride).toBe('S7_PRODUCT_RECO');
    expect(out.nextCtxState).toBe('S7_PRODUCT_RECO');
    expect(deps.chatRoutineRecoRuntime.resolveRoutineRecoEnvelope).not.toHaveBeenCalled();
  });

  test('keeps budget-flow route and emits soft advisory when budget is still missing', async () => {
    const { runtime, deps } = buildHarness({
      normalizeBudgetHint: jest.fn(() => ''),
    });
    const args = buildArgs({
      ctx: {
        request_id: 'req_routine_gate_3',
        lang: 'CN',
        state: 'S6_BUDGET',
        trigger_source: 'text',
      },
      message: '继续',
    });

    const out = await runtime.resolveRoutineGate(args);

    expect(out.handled).toBe(true);
    expect(out.policyMetaPatch).toEqual({ gate_type: 'soft' });
    expect(args.enqueueGateAdvisory).toHaveBeenCalledWith(
      expect.objectContaining({
        gate_id: 'budget_gate',
        reason_codes: ['budget_optimization_optional'],
      }),
    );
    expect(deps.chatRoutineRecoRuntime.resolveRoutineRecoEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'budget_flow',
        hasBudget: true,
      }),
    );
  });

  test('persists selected budget before budget-flow routine generation', async () => {
    const { runtime, deps } = buildHarness();

    const out = await runtime.resolveRoutineGate(buildArgs({
      ctx: {
        request_id: 'req_routine_gate_4',
        lang: 'EN',
        state: 'S6_BUDGET',
        trigger_source: 'text',
      },
      message: '$50',
      profile: { skinType: 'dry' },
    }));

    expect(out.handled).toBe(true);
    expect(deps.upsertProfileForIdentity).toHaveBeenCalledWith(
      { auroraUid: 'aur_1', userId: 'user_1' },
      { budgetTier: 'mid' },
    );
    expect(out.profile).toEqual({ persisted: true, budgetTier: 'mid' });
  });

  test('routes direct routine request to routine_request flow with optional budget chip', async () => {
    const { runtime, deps } = buildHarness({
      looksLikeRoutineRequest: jest.fn(() => true),
      normalizeBudgetHint: jest.fn(() => ''),
    });

    const out = await runtime.resolveRoutineGate(buildArgs({
      ctx: {
        request_id: 'req_routine_gate_5',
        lang: 'EN',
        state: 'IDLE_CHAT',
        trigger_source: 'text',
      },
      message: 'Build an AM/PM routine',
    }));

    expect(out.handled).toBe(true);
    expect(deps.chatRoutineRecoRuntime.resolveRoutineRecoEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'routine_request',
        hasBudget: false,
        appendBudgetOptimizationChip: true,
      }),
    );
  });
});
