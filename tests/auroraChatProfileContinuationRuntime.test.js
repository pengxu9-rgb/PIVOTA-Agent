const { createChatProfileContinuationRuntime } = require('../src/auroraBff/chatProfileContinuationRuntime');

function buildHarness(overrides = {}) {
  const chatDiagnosisGateRuntime = {
    buildDiagnosisGateEnvelope: jest.fn(() => ({ type: 'diagnosis_gate' })),
  };
  const buildEnvelope = jest.fn((_ctx, payload) => payload);
  const makeChatAssistantMessage = jest.fn((content) => ({ content }));
  const makeEvent = jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data }));
  const recordSessionPatchProfileEmitted = jest.fn();
  const summarizeChatProfileForContext = jest.fn((profile) => (profile ? { summary: 'ok', skinType: profile.skinType || null } : null));

  const runtime = createChatProfileContinuationRuntime({
    profileCompleteness: jest.fn(() => ({ missing: [] })),
    stateChangeAllowed: jest.fn(() => true),
    recordSessionPatchProfileEmitted,
    chatDiagnosisGateRuntime,
    ...overrides,
  });

  return {
    runtime,
    chatDiagnosisGateRuntime,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    recordSessionPatchProfileEmitted,
    summarizeChatProfileForContext,
  };
}

describe('aurora chat profile continuation runtime', () => {
  test('returns diagnosis progress gate when profile patch leaves required fields missing in diagnosis flow', () => {
    const { runtime, chatDiagnosisGateRuntime, buildEnvelope, makeChatAssistantMessage, makeEvent, summarizeChatProfileForContext } = buildHarness({
      profileCompleteness: jest.fn(() => ({ missing: ['sensitivity', 'goals'] })),
    });

    const envelope = runtime.maybeBuildProfileContinuationEnvelope({
      ctx: { state: 'S2_DIAGNOSIS', trigger_source: 'user', lang: 'EN', request_id: 'req_diag_patch' },
      agentState: 'DIAG_ACTIVE',
      message: '',
      profileClarificationAction: true,
      profile: { skinType: 'oily' },
      recentLogs: [{ id: 'log_1' }],
      appliedProfilePatch: { skinType: 'oily' },
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
      buildDiagnosisPrompt: jest.fn(),
      buildDiagnosisChips: jest.fn(),
    });

    expect(envelope).toEqual({ type: 'diagnosis_gate' });
    expect(chatDiagnosisGateRuntime.buildDiagnosisGateEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'diagnosis_progress',
        missingFields: ['sensitivity', 'goals'],
        includeProfileInSessionPatch: true,
        appliedProfilePatch: { skinType: 'oily' },
      }),
    );
  });

  test('returns next-step envelope after profile patch when diagnosis can continue without gating', () => {
    const {
      runtime,
      chatDiagnosisGateRuntime,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      recordSessionPatchProfileEmitted,
      summarizeChatProfileForContext,
    } = buildHarness();

    const envelope = runtime.maybeBuildProfileContinuationEnvelope({
      ctx: { state: 'IDLE', trigger_source: 'user', lang: 'EN', request_id: 'req_profile_patch' },
      agentState: 'IDLE',
      message: '',
      profileClarificationAction: false,
      profile: { skinType: 'dry' },
      appliedProfilePatch: { skinType: 'dry', budgetTier: 'mid' },
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
      buildDiagnosisPrompt: jest.fn(),
      buildDiagnosisChips: jest.fn(),
    });

    expect(chatDiagnosisGateRuntime.buildDiagnosisGateEnvelope).not.toHaveBeenCalled();
    expect(recordSessionPatchProfileEmitted).toHaveBeenCalledWith({ changed: true });
    expect(envelope.assistant_message).toEqual({ content: 'Got it. What would you like to do next?' });
    expect(envelope.session_patch).toEqual({ profile: { summary: 'ok', skinType: 'dry' } });
    expect(envelope.events).toEqual([
      {
        event_name: 'profile_saved',
        data: { fields: ['skinType', 'budgetTier'] },
      },
    ]);
    expect(envelope.cards).toEqual([
      {
        card_id: 'profile_req_profile_patch',
        type: 'profile',
        payload: { profile: { summary: 'ok', skinType: 'dry' } },
      },
    ]);
  });
});
