const { createChatBoundaryRuntime } = require('../src/auroraBff/chatBoundaryRuntime');

function buildHarness(overrides = {}) {
  const chatSafetyRuntime = {
    resolveSafetyGate: jest.fn(async () => ({
      profile: { persisted: true },
      pendingSafetyAdvisory: { reason: 'warn' },
      blockedEnvelope: { assistant_message: { content: 'blocked' } },
    })),
  };
  const runtime = createChatBoundaryRuntime({
    logger: { info: jest.fn() },
    collectConceptMatchesFromText: jest.fn(() => ({
      concept_ids: ['retinoid'],
      matched_concepts_debug: ['retinoid:debug'],
    })),
    matchIngredientOntology: jest.fn(() => [
      { contraindication_tags: ['pregnancy', 'pregnancy', 'retinoid'] },
    ]),
    evaluateSafety: jest.fn(() => ({ block_level: 'require_info', reasons: ['risk_a'] })),
    buildFitCheckAnchorPrompt: jest.fn(() => ({
      prompt: 'paste anchor',
      chips: [{ chip_id: 'chip.fitcheck.send_link' }],
    })),
    buildConfidenceNoticeCardPayload: jest.fn((payload) => payload),
    chatSafetyRuntime,
    INTENT_ENUM: {
      UNKNOWN: 'unknown',
      RECO_PRODUCTS: 'reco_products',
      ROUTINE: 'routine',
      TRAVEL_PLANNING: 'travel_planning',
      WEATHER_ENV: 'weather_env',
    },
    BLOCK_LEVEL: {
      INFO: 'info',
      WARN: 'warn',
      REQUIRE_INFO: 'require_info',
      BLOCK: 'block',
    },
    GATE_MODE: {
      BYPASS: 'bypass',
      ADVISORY: 'advisory',
      BLOCK: 'block',
    },
    ...overrides,
  });
  return { runtime, chatSafetyRuntime };
}

describe('aurora chat boundary runtime', () => {
  test('computeSafetyDecision derives anchor signal and safety decision', () => {
    const { runtime } = buildHarness();

    const result = runtime.computeSafetyDecision({
      effectiveChatFlags: { safety_engine_v1: true },
      message: 'Can I use retinoid tonight?',
      actionId: 'chip.fitcheck.send_link',
      ctx: { lang: 'EN', match_lang: 'EN' },
      canonicalIntent: { intent: 'routine' },
      profile: { pregnancy_status: 'unknown' },
      hasPlannerAnchor: true,
      debugUpstream: true,
    });

    expect(result.anchorCollectionSignal).toBe(true);
    expect(result.safetyDecision).toEqual({ block_level: 'require_info', reasons: ['risk_a'] });
  });

  test('analyzeBoundaryState reuses passed safety decision and derives boundary booleans', () => {
    const { runtime } = buildHarness({
      collectConceptMatchesFromText: jest.fn(() => {
        throw new Error('should not recompute concepts');
      }),
    });

    const result = runtime.analyzeBoundaryState({
      message: 'Retinoid recommendation please',
      actionId: '',
      canonicalIntent: { intent: 'reco_products' },
      evaluateIntent: false,
      ingredientScienceIntentEffective: false,
      conflictIntentRequested: false,
      safetyDecision: { block_level: 'require_info' },
      anchorCollectionSignal: false,
    });

    expect(result.shouldBypassAvailabilityShortCircuit).toBe(true);
    expect(result.shouldRunSafetyPreGate).toBe(true);
  });

  test('maybeBuildFitCheckAnchorEnvelope emits advisory prompt when fit-check lacks anchor', () => {
    const { runtime } = buildHarness();
    const enqueueGateAdvisory = jest.fn();

    const result = runtime.maybeBuildFitCheckAnchorEnvelope({
      evaluateIntent: true,
      hasFitCheckAnchor: false,
      anchorCollectionSignal: true,
      ctx: { request_id: 'req_1', trace_id: 'trace_1', lang: 'EN' },
      pushGateDecision: jest.fn(() => ({ mode: 'advisory' })),
      enqueueGateAdvisory,
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    });

    expect(result.gateType).toBe('soft');
    expect(result.envelope.assistant_message).toEqual({ content: 'paste anchor' });
    expect(enqueueGateAdvisory).toHaveBeenCalledWith({
      gate_id: 'fit_check_anchor_gate',
      message: 'paste anchor',
      reason_codes: ['anchor_soft_blocked_ambiguous'],
      actions: ['provide_anchor_url_or_name'],
      chips: [{ chip_id: 'chip.fitcheck.send_link' }],
    });
  });

  test('runSafetyPreGate delegates to chatSafetyRuntime when enabled', async () => {
    const { runtime, chatSafetyRuntime } = buildHarness();

    const result = await runtime.runSafetyPreGate({
      shouldRunSafetyPreGate: true,
      safetyDecision: { block_level: 'warn' },
      profile: { skinType: 'dry' },
      identity: { auroraUid: 'aurora_1' },
      conflictIntentRequested: true,
      pendingSafetyAdvisory: { existing: true },
      pushGateDecision: jest.fn(() => ({ mode: 'advisory' })),
      ctx: { lang: 'EN', request_id: 'req_2' },
      buildEnvelope: jest.fn((_ctx, payload) => payload),
      makeChatAssistantMessage: jest.fn((content) => ({ content })),
      makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
      intent: 'reco_products',
    });

    expect(chatSafetyRuntime.resolveSafetyGate).toHaveBeenCalledWith({
      safety: { block_level: 'warn' },
      profile: { skinType: 'dry' },
      identity: { auroraUid: 'aurora_1' },
      conflictIntent: true,
      pendingSafetyAdvisory: { existing: true },
      pushGateDecision: expect.any(Function),
      language: 'EN',
      variant: 'generic',
      ctx: { lang: 'EN', request_id: 'req_2' },
      buildEnvelope: expect.any(Function),
      makeChatAssistantMessage: expect.any(Function),
      makeEvent: expect.any(Function),
      intent: 'reco_products',
    });
    expect(result.blockedEnvelope).toEqual({ assistant_message: { content: 'blocked' } });
  });
});
