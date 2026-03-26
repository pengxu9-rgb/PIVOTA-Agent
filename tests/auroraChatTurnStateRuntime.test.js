const { createChatTurnStateRuntime } = require('../src/auroraBff/chatTurnStateRuntime');

function buildRuntime(overrides = {}) {
  return createChatTurnStateRuntime({
    DEFAULT_AGENT_STATE: 'S0_INIT',
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED: true,
    PENDING_CLARIFICATION_TTL_MS: 60_000,
    normalizeAgentState: (value) => String(value || '').trim(),
    deriveRequestedTransitionFromAction: jest.fn(() => null),
    inferTextExplicitTransition: jest.fn(() => null),
    validateRequestedTransition: jest.fn(() => ({ ok: true, next_state: 'RECO_GATE' })),
    recommendationsAllowed: jest.fn(() => false),
    isClarifyChipAction: jest.fn(() => false),
    hasPendingClarificationStateHint: jest.fn(() => false),
    parseClarificationReplyFromActionId: jest.fn(() => ''),
    extractClarificationQuestionIdFromAction: jest.fn(() => ''),
    parseClarificationIdFromActionId: jest.fn(() => ''),
    advancePendingClarification: jest.fn(() => ({ nextPending: null, nextQuestion: null, history: [] })),
    emitPendingClarificationPatch: jest.fn((sessionPatch, pending) => {
      sessionPatch.pending_clarification = pending;
    }),
    compactClarificationHistory: jest.fn((history) => history),
    buildResumeKnownProfileFields: jest.fn(() => ({ skinType: 'oily' })),
    ...overrides,
  });
}

function buildArgs(overrides = {}) {
  return {
    parsedData: {
      client_state: 'RECO_GATE',
      session: {},
    },
    ctx: {
      request_id: 'req_chat_turn_1',
      trace_id: 'trace_chat_turn_1',
      lang: 'EN',
      match_lang: 'EN',
      trigger_source: 'chip',
      state: 'idle',
    },
    message: 'show me products',
    actionId: 'chip.reco.next',
    clarificationId: '',
    actionReplyText: '',
    normalizedActionPayload: { action_id: 'chip.reco.next', data: {} },
    profile: { skinType: 'oily' },
    appliedProfilePatch: null,
    summarizeChatProfileForContext: jest.fn(() => ({ skinType: 'oily' })),
    pushGateDecision: jest.fn(),
    policyMeta: {},
    logger: { warn: jest.fn() },
    recordPendingClarificationAbandoned: jest.fn(),
    recordSessionPatchProfileEmitted: jest.fn(),
    buildChipsForQuestion: jest.fn(() => [{ chip_id: 'chip.clarify.skinType.oily' }]),
    recordAuroraChatSkipped: jest.fn(),
    recordPendingClarificationStep: jest.fn(),
    recordPendingClarificationCompleted: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload })),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    getPendingClarification: jest.fn(() => null),
    AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED: true,
    ...overrides,
  };
}

describe('aurora chat turn state runtime', () => {
  test('rejects invalid requested transition and falls back to default state', () => {
    const runtime = buildRuntime({
      inferTextExplicitTransition: jest.fn(() => null),
    });
    const args = buildArgs({
      parsedData: {
        client_state: 'RECO_GATE',
        requested_transition: {
          trigger_source: 'text_explicit',
          trigger_id: 'free_text_reco',
          requested_next_state: 'DIAG_PROFILE',
        },
        session: {},
      },
      message: 'i want to switch modes',
    });

    const result = runtime.prepareChatTurnPrelude(args);

    expect(result.clientAgentState).toBe('RECO_GATE');
    expect(result.agentState).toBe('S0_INIT');
    expect(args.pushGateDecision).toHaveBeenCalledWith('frontend_state_transition_guard', {
      reason_codes: ['text_explicit_not_allowed'],
    });
    expect(args.policyMeta.invalid_transition_fallback).toBe(true);
    expect(args.policyMeta.invalid_transition_reason).toBe('TEXT_EXPLICIT_NOT_ALLOWED');
    expect(args.logger.warn).toHaveBeenCalled();
  });

  test('emits local pending clarification next-step envelope', () => {
    const pending = {
      flow_id: 'pc_123',
      created_at_ms: Date.now(),
      resume_user_text: 'show me products',
      current: { id: 'skin_type' },
      history: [],
    };
    const nextPending = {
      flow_id: 'pc_123',
      created_at_ms: Date.now(),
      resume_user_text: 'show me products',
      current: { id: 'budget' },
      history: [{ question_id: 'skin_type', option: 'oily', ts_ms: Date.now() }],
    };
    const nextQuestion = {
      id: 'budget',
      question: 'What is your budget?',
      options: ['Low', 'Mid', 'High'],
    };
    const runtime = buildRuntime({
      isClarifyChipAction: jest.fn(() => true),
      extractClarificationQuestionIdFromAction: jest.fn(() => 'skin_type'),
      advancePendingClarification: jest.fn(() => ({
        nextPending,
        nextQuestion,
        history: nextPending.history,
      })),
    });
    const args = buildArgs({
      actionId: 'chip.clarify.skin_type.oily',
      actionReplyText: 'oily',
      normalizedActionPayload: { action_id: 'chip.clarify.skin_type.oily', data: {} },
      getPendingClarification: jest.fn(() => ({ pending })),
    });

    const result = runtime.prepareChatTurnPrelude(args);

    expect(result.earlyEnvelope).toBeTruthy();
    expect(result.earlyEnvelope.session_patch.pending_clarification).toEqual(nextPending);
    expect(result.earlyEnvelope.suggested_chips).toEqual([{ chip_id: 'chip.clarify.skinType.oily' }]);
    expect(args.recordAuroraChatSkipped).toHaveBeenCalledWith({ reason: 'pending_clarification_step' });
    expect(args.recordPendingClarificationStep).toHaveBeenCalledWith({ stepIndex: 1 });
    expect(result.forceUpstreamAfterPendingAbandon).toBe(false);
  });

  test('completes pending clarification and resumes upstream with history context', () => {
    const pending = {
      flow_id: 'pc_123',
      created_at_ms: Date.now(),
      resume_user_text: 'show me products',
      current: { id: 'budget' },
      history: [{ question_id: 'skin_type', option: 'oily', ts_ms: 1 }],
    };
    const history = [
      { question_id: 'skin_type', option: 'oily', ts_ms: 1 },
      { question_id: 'budget', option: 'mid', ts_ms: 2 },
    ];
    const runtime = buildRuntime({
      isClarifyChipAction: jest.fn(() => true),
      extractClarificationQuestionIdFromAction: jest.fn(() => 'budget'),
      advancePendingClarification: jest.fn(() => ({
        nextPending: null,
        nextQuestion: null,
        history,
      })),
    });
    const args = buildArgs({
      actionId: 'chip.clarify.budget.mid',
      actionReplyText: 'mid',
      normalizedActionPayload: { action_id: 'chip.clarify.budget.mid', data: {} },
      getPendingClarification: jest.fn(() => ({ pending })),
    });

    const result = runtime.prepareChatTurnPrelude(args);

    expect(result.earlyEnvelope).toBeNull();
    expect(result.pendingClarificationPatchOverride).toBeNull();
    expect(result.forceUpstreamAfterPendingAbandon).toBe(true);
    expect(result.upstreamMessage).toBe('show me products');
    expect(result.resumeContextForUpstream).toEqual({
      flow_id: 'pc_123',
      resume_user_text: 'show me products',
      clarification_history: history,
      include_history: true,
      known_profile_fields: { skinType: 'oily' },
    });
    expect(args.recordPendingClarificationCompleted).toHaveBeenCalled();
  });

  test('upgraded pending clarification still yields reco interaction but is abandoned on free text', () => {
    const pending = {
      flow_id: 'pc_123',
      created_at_ms: Date.now(),
      resume_user_text: 'show me products',
      current: { id: 'budget' },
      history: [],
    };
    const runtime = buildRuntime({
      recommendationsAllowed: jest.fn(() => true),
    });
    const args = buildArgs({
      parsedData: {
        client_state: 'idle',
        session: {},
      },
      getPendingClarification: jest.fn(() => ({ pending, upgraded: true })),
    });

    const result = runtime.prepareChatTurnPrelude(args);

    expect(result.agentState).toBe('idle');
    expect(result.allowRecoCards).toBe(true);
    expect(result.pendingClarificationPatchOverride).toBeNull();
    expect(args.recordPendingClarificationAbandoned).toHaveBeenCalledWith({ reason: 'free_text' });
  });
});
