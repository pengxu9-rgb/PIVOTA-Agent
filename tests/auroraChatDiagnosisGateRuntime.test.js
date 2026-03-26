const { createChatDiagnosisGateRuntime } = require('../src/auroraBff/chatDiagnosisGateRuntime');

function buildHarness(overrides = {}) {
  const runtime = createChatDiagnosisGateRuntime({
    GATE_MODE: {
      ADVISORY: 'advisory',
    },
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED: true,
    buildPendingClarificationForGate: jest.fn(({ missing }) => ({
      question_id: 'diag_gate',
      missing,
    })),
    emitPendingClarificationPatch: jest.fn((sessionPatch, pending) => {
      sessionPatch.pending_clarification = pending;
    }),
    logger: {
      info: jest.fn(),
    },
    ...overrides,
  });
  return runtime;
}

describe('aurora chat diagnosis gate runtime', () => {
  test('buildDiagnosisGateEnvelope creates diagnosis start envelope', () => {
    const runtime = buildHarness();
    const envelope = runtime.buildDiagnosisGateEnvelope({
      reason: 'diagnosis_start',
      ctx: { request_id: 'req_1', lang: 'EN' },
      profile: { skinType: 'dry' },
      recentLogs: [{ logged_at: '2026-03-24' }],
      missingFields: ['skinType', 'goals'],
      nextState: 'S2_DIAGNOSIS',
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      summarizeChatProfileForContext: jest.fn((profile) => ({ summary: profile.skinType })),
      buildDiagnosisPrompt: jest.fn((_lang, missing) => `prompt:${missing.join(',')}`),
      buildDiagnosisChips: jest.fn((_lang, missing) => missing.map((field) => ({ chip_id: field }))),
    });

    expect(envelope.assistant_message).toEqual({ content: 'prompt:skinType,goals' });
    expect(envelope.suggested_chips).toEqual([{ chip_id: 'skinType' }, { chip_id: 'goals' }]);
    expect(envelope.cards[0]).toEqual({
      card_id: 'diag_req_1',
      type: 'diagnosis_gate',
      payload: {
        reason: 'diagnosis_start',
        missing_fields: ['skinType', 'goals'],
        wants: 'diagnosis',
        profile: { summary: 'dry' },
        recent_logs: [{ logged_at: '2026-03-24' }],
      },
    });
    expect(envelope.session_patch).toEqual({ next_state: 'S2_DIAGNOSIS' });
    expect(envelope.events).toEqual([
      {
        event_name: 'state_entered',
        event_data: { next_state: 'S2_DIAGNOSIS', reason: 'diagnosis_start' },
      },
    ]);
  });

  test('buildDiagnosisGateEnvelope creates diagnosis progress envelope with profile patch event', () => {
    const runtime = buildHarness();
    const envelope = runtime.buildDiagnosisGateEnvelope({
      reason: 'diagnosis_progress',
      ctx: { request_id: 'req_2', lang: 'EN' },
      profile: { sensitivity: 'high' },
      recentLogs: [],
      missingFields: ['barrierStatus'],
      nextState: undefined,
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      summarizeChatProfileForContext: jest.fn((profile) => ({ summary: profile.sensitivity })),
      buildDiagnosisPrompt: jest.fn((_lang, missing) => `prompt:${missing.join(',')}`),
      buildDiagnosisChips: jest.fn((_lang, missing) => missing.map((field) => ({ chip_id: field }))),
      includeProfileInSessionPatch: true,
      profileSummaryForPatch: { summary: 'high' },
      appliedProfilePatch: { sensitivity: 'high' },
    });

    expect(envelope.session_patch).toEqual({ profile: { summary: 'high' } });
    expect(envelope.events).toEqual([
      {
        event_name: 'profile_saved',
        event_data: { fields: ['sensitivity'] },
      },
      {
        event_name: 'state_entered',
        event_data: { next_state: null, reason: 'diagnosis_progress' },
      },
    ]);
  });

  test('applyDiagnosisFirstProfileGate enqueues advisory and builds pending clarification patch', () => {
    const buildPendingClarificationForGate = jest.fn(({ language, missing, message, wants }) => ({
      language,
      missing,
      message,
      wants,
    }));
    const emitPendingClarificationPatch = jest.fn((sessionPatch, pending) => {
      sessionPatch.pending_clarification = { ...pending, persisted: true };
    });
    const logger = { info: jest.fn() };
    const runtime = buildHarness({
      buildPendingClarificationForGate,
      emitPendingClarificationPatch,
      logger,
    });
    const enqueueGateAdvisory = jest.fn();

    const result = runtime.applyDiagnosisFirstProfileGate({
      ctx: { request_id: 'req_3', trace_id: 'trace_3', lang: 'CN' },
      requiredMissing: ['skinType', 'goals'],
      message: '推荐一下',
      pushGateDecision: jest.fn(() => ({ mode: 'advisory' })),
      enqueueGateAdvisory,
      pendingClarificationPatchOverride: null,
      buildDiagnosisChips: jest.fn((_lang, missing) => missing.map((field) => ({ chip_id: field }))),
    });

    expect(enqueueGateAdvisory).toHaveBeenCalledWith({
      gate_id: 'diagnosis_first_profile_gate',
      message: '我先给你可执行推荐，同时补充画像后可进一步提高精准度。',
      reason_codes: ['diagnosis_first', 'missing_skinType', 'missing_goals'],
      actions: ['refine_profile'],
      chips: [{ chip_id: 'skinType' }, { chip_id: 'goals' }],
    });
    expect(buildPendingClarificationForGate).toHaveBeenCalledWith({
      language: 'CN',
      missing: ['skinType', 'goals'],
      message: '推荐一下',
      wants: 'recommendation',
    });
    expect(result.pendingClarificationPatchOverride).toEqual({
      language: 'CN',
      missing: ['skinType', 'goals'],
      message: '推荐一下',
      wants: 'recommendation',
      persisted: true,
    });
    expect(logger.info).toHaveBeenCalled();
  });

  test('applyDiagnosisFirstProfileGate is a no-op when nothing is missing', () => {
    const runtime = buildHarness();
    const enqueueGateAdvisory = jest.fn();
    const pushGateDecision = jest.fn();

    const result = runtime.applyDiagnosisFirstProfileGate({
      ctx: { request_id: 'req_4', lang: 'EN' },
      requiredMissing: [],
      message: 'help',
      pushGateDecision,
      enqueueGateAdvisory,
      pendingClarificationPatchOverride: { keep: true },
      buildDiagnosisChips: jest.fn(),
    });

    expect(pushGateDecision).not.toHaveBeenCalled();
    expect(enqueueGateAdvisory).not.toHaveBeenCalled();
    expect(result).toEqual({
      decision: null,
      pendingClarificationPatchOverride: { keep: true },
    });
  });

  test('resolveDiagnosisEntryEnvelope builds diagnosis_start gate when required profile fields are missing', () => {
    const runtime = buildHarness();
    const result = runtime.resolveDiagnosisEntryEnvelope({
      ctx: { request_id: 'req_5', trigger_source: 'text', lang: 'EN' },
      agentState: 'RECO_GATE',
      diagnosisFlowContinuationAllowed: false,
      diagnosisEntryRequested: true,
      ingredientScienceIntentEffective: false,
      ingredientDiagnosisOptInRequested: false,
      actionId: null,
      ingredientEntryRequested: false,
      ingredientLookupRequested: false,
      ingredientByGoalRequested: false,
      ingredientResearchPollRequested: false,
      ingredientTextTrigger: false,
      profile: { skinType: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      summarizeChatProfileForContext: jest.fn((profile) => ({ summary: profile.skinType })),
      buildDiagnosisPrompt: jest.fn((_lang, missing) => `prompt:${missing.join(',')}`),
      buildDiagnosisChips: jest.fn((_lang, missing) => missing.map((field) => ({ chip_id: field }))),
      profileCompleteness: jest.fn(() => ({ score: 0.25, missing: ['skinType', 'goals'] })),
      stateChangeAllowed: jest.fn(() => true),
      normalizeIngredientActionId: jest.fn(() => null),
    });

    expect(result.handled).toBe(true);
    expect(result.envelope.cards[0].payload.reason).toBe('diagnosis_start');
    expect(result.envelope.session_patch).toEqual({ next_state: 'S2_DIAGNOSIS' });
  });

  test('resolveDiagnosisEntryEnvelope builds photo followup when profile is complete', () => {
    const runtime = buildHarness();
    const result = runtime.resolveDiagnosisEntryEnvelope({
      ctx: { request_id: 'req_6', trigger_source: 'text', lang: 'CN' },
      agentState: 'DIAG_PROFILE',
      diagnosisFlowContinuationAllowed: true,
      diagnosisEntryRequested: false,
      ingredientScienceIntentEffective: false,
      ingredientDiagnosisOptInRequested: false,
      actionId: null,
      ingredientEntryRequested: false,
      ingredientLookupRequested: false,
      ingredientByGoalRequested: false,
      ingredientResearchPollRequested: false,
      ingredientTextTrigger: false,
      profile: { skinType: 'dry', sensitivity: 'medium', barrierStatus: 'ok', goals: ['hydrate'] },
      recentLogs: [],
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      summarizeChatProfileForContext: jest.fn(() => ({ summary: 'complete' })),
      buildDiagnosisPrompt: jest.fn(),
      buildDiagnosisChips: jest.fn(),
      profileCompleteness: jest.fn(() => ({ score: 1, missing: [] })),
      stateChangeAllowed: jest.fn(() => true),
      normalizeIngredientActionId: jest.fn(() => null),
    });

    expect(result.handled).toBe(true);
    expect(result.envelope.assistant_message).toEqual({
      content: '已收到你的肤况信息。要不要再上传一张照片让我更准？你也可以先跳过照片，我会给一份低置信度的安全基线。',
    });
    expect(result.envelope.suggested_chips.map((chip) => chip.chip_id)).toEqual([
      'chip.intake.upload_photos',
      'chip.intake.skip_analysis',
      'chip_keep_chatting',
    ]);
    expect(result.envelope.session_patch).toEqual({
      next_state: 'S2_DIAGNOSIS',
      profile: { summary: 'complete' },
    });
  });
});
