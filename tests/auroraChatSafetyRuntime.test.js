const { createChatSafetyRuntime } = require('../src/auroraBff/chatSafetyRuntime');

function buildHarness(overrides = {}) {
  const chatAdvisoryRuntime = {
    buildSafetyNoticeText: jest.fn(({ safety }) => `notice:${String(safety && safety.block_level || '')}`),
    resolveSafetyGateAction: jest.fn(() => ({ mode: 'bypass', advisory: null, ask_once_fields: [] })),
    mergePendingSafetyAdvisory: jest.fn(({ pendingSafetyAdvisory, incoming }) => ({
      ...(pendingSafetyAdvisory || {}),
      ...(incoming || {}),
      merged: true,
    })),
    persistSafetyPromptAskedOnce: jest.fn(async ({ profile }) => ({ ...(profile || {}), persisted: true })),
  };
  const runtime = createChatSafetyRuntime({
    chatAdvisoryRuntime,
    INTENT_ENUM: { UNKNOWN: 'unknown' },
    ...overrides,
  });
  return { runtime, chatAdvisoryRuntime };
}

describe('aurora chat safety runtime', () => {
  test('resolveSafetyGate merges inline advisory and persists ask-once state', async () => {
    const { runtime, chatAdvisoryRuntime } = buildHarness();
    chatAdvisoryRuntime.resolveSafetyGateAction.mockReturnValue({
      mode: 'inline',
      advisory: {
        reason: 'safety_optional_profile_missing',
        details: ['warn'],
      },
      ask_once_fields: ['pregnancy_status'],
    });

    const result = await runtime.resolveSafetyGate({
      safety: { block_level: 'warn' },
      profile: { skinType: 'oily' },
      identity: { auroraUid: 'aurora_1', userId: 'user_1' },
      pendingSafetyAdvisory: { existing: true },
      pushGateDecision: jest.fn(() => ({ mode: 'advisory' })),
      language: 'EN',
    });

    expect(chatAdvisoryRuntime.mergePendingSafetyAdvisory).toHaveBeenCalledWith({
      pendingSafetyAdvisory: { existing: true },
      incoming: {
        reason: 'safety_optional_profile_missing',
        details: ['warn'],
      },
    });
    expect(chatAdvisoryRuntime.persistSafetyPromptAskedOnce).toHaveBeenCalledWith({
      fields: ['pregnancy_status'],
      profile: { skinType: 'oily' },
      identity: { auroraUid: 'aurora_1', userId: 'user_1' },
    });
    expect(result.pendingSafetyAdvisory).toEqual({
      existing: true,
      reason: 'safety_optional_profile_missing',
      details: ['warn'],
      merged: true,
    });
    expect(result.profile).toEqual({ skinType: 'oily', persisted: true });
    expect(result.blockedEnvelope).toBeNull();
  });

  test('resolveSafetyGate builds generic block envelope', async () => {
    const { runtime, chatAdvisoryRuntime } = buildHarness();
    chatAdvisoryRuntime.resolveSafetyGateAction.mockReturnValue({
      mode: 'block',
      advisory: null,
      ask_once_fields: [],
    });

    const result = await runtime.resolveSafetyGate({
      safety: {
        block_level: 'block',
        reasons: ['risk_a'],
        safe_alternatives: ['alt_a'],
      },
      profile: {},
      identity: { auroraUid: 'aurora_1' },
      pushGateDecision: jest.fn(() => ({ mode: 'block' })),
      language: 'EN',
      ctx: { request_id: 'req_1', lang: 'EN' },
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      intent: 'routine',
    });

    expect(result.blockedEnvelope.assistant_message).toEqual({ content: 'notice:block' });
    expect(result.blockedEnvelope.cards[0].payload.actions).toEqual(['safe_alternatives']);
    expect(result.blockedEnvelope.events).toEqual([
      {
        event_name: 'safety_gate_block',
        event_data: { intent: 'routine', block_level: 'block' },
      },
    ]);
  });

  test('resolveSafetyGate builds ingredient block envelope with route meta', async () => {
    const { runtime, chatAdvisoryRuntime } = buildHarness();
    chatAdvisoryRuntime.resolveSafetyGateAction.mockReturnValue({
      mode: 'block',
      advisory: null,
      ask_once_fields: [],
    });
    const attachIngredientRouteMetaToSessionPatch = jest.fn((_patch, meta) => ({ meta }));

    const result = await runtime.resolveSafetyGate({
      safety: {
        block_level: 'block',
        reasons: ['risk_a'],
      },
      profile: {},
      identity: { auroraUid: 'aurora_1' },
      pushGateDecision: jest.fn(() => ({ mode: 'block' })),
      language: 'EN',
      variant: 'ingredient',
      ctx: { request_id: 'req_ing', lang: 'EN' },
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      attachIngredientRouteMetaToSessionPatch,
      ingredientRouteMeta: {
        routeSource: 'text',
        routeDecisionReasons: ['safety_block'],
      },
    });

    expect(attachIngredientRouteMetaToSessionPatch).toHaveBeenCalledWith(
      {},
      {
        routeSource: 'text',
        routeDecisionReasons: ['safety_block'],
      },
    );
    expect(result.blockedEnvelope.session_patch).toEqual({
      meta: {
        routeSource: 'text',
        routeDecisionReasons: ['safety_block'],
      },
    });
    expect(result.blockedEnvelope.events[0]).toEqual({
      event_name: 'safety_gate_block',
      event_data: { intent: 'ingredient_science', block_level: 'block' },
    });
  });

  test('resolveSafetyGate builds reco block envelope with conservative chips', async () => {
    const { runtime, chatAdvisoryRuntime } = buildHarness();
    chatAdvisoryRuntime.resolveSafetyGateAction.mockReturnValue({
      mode: 'block',
      advisory: null,
      ask_once_fields: [],
    });

    const result = await runtime.resolveSafetyGate({
      safety: {
        block_level: 'warn',
        reasons: ['risk_a'],
        safe_alternatives: ['alt_a'],
      },
      profile: {},
      identity: { auroraUid: 'aurora_1' },
      pushGateDecision: jest.fn(() => ({ mode: 'block' })),
      language: 'CN',
      variant: 'reco',
      ctx: { request_id: 'req_reco', lang: 'CN' },
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      intent: 'reco_products',
    });

    expect(result.blockedEnvelope.suggested_chips).toHaveLength(2);
    expect(result.blockedEnvelope.cards[0].payload.actions).toEqual(['safe_alternatives', 'profile_update']);
    expect(result.blockedEnvelope.events[0]).toEqual({
      event_name: 'safety_gate_block',
      event_data: { intent: 'reco_products', block_level: 'warn' },
    });
  });
});
