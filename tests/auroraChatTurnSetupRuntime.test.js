const { createChatTurnSetupRuntime } = require('../src/auroraBff/chatTurnSetupRuntime');

function buildRuntime(overrides = {}) {
  const profileRuntime = {
    applyProfilePatchFromAction: jest.fn(async ({ profile }) => ({
      profile: { ...(profile || {}), action_patch: true },
      appliedProfilePatch: { action_patch: true },
    })),
    applyPregnancyPolicy: jest.fn(async ({ profile, appliedProfilePatch }) => ({
      profile: { ...(profile || {}), pregnancy_patch: true },
      appliedProfilePatch: { ...(appliedProfilePatch || {}), pregnancy_patch: true },
      pendingPregnancyPolicyEvents: [{ event_name: 'pregnancy_policy' }],
    })),
    applyTextDerivedProfilePatch: jest.fn(async ({ profile, appliedProfilePatch }) => ({
      profile: { ...(profile || {}), text_patch: true },
      appliedProfilePatch: { ...(appliedProfilePatch || {}), text_patch: true },
      textDerivedProfilePatch: { text_patch: true },
    })),
    applyTextDerivedSkinLog: jest.fn(async () => ({
      recentLogs: [{ id: 'log_1' }],
      textDerivedSkinLog: { id: 'derived_log_1' },
    })),
  };

  return createChatTurnSetupRuntime({
    chatProfileRuntime: profileRuntime,
    extractLatestRecoContextFromSession: jest.fn(() => ({ source: 'session' })),
    extractReplyTextFromAction: jest.fn(() => 'reply from action'),
    extractIncludeAlternativesFromAction: jest.fn(() => true),
    coerceBoolean: jest.fn((value) => String(value).trim().toLowerCase() === 'true'),
    normalizeChatLlmProvider: jest.fn((value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')),
    normalizeChatLlmModel: jest.fn((value) => (typeof value === 'string' ? value.trim() : '')),
    inferCanonicalIntent: jest.fn(() => ({
      intent: 'evaluate_product',
      source: 'intent_model',
      confidence: 0.82,
      entities: {},
    })),
    hasRoutineSosSignal: jest.fn(() => true),
    resolvePreferredLegacyTravelPlan: jest.fn(() => null),
    hasMeaningfulFitCheckAnchor: jest.fn(() => true),
    AURORA_DIAG_FORCE_GEMINI: false,
    AURORA_DIAG_FORCE_GEMINI_MODEL: 'gemini-2.5-pro',
    AURORA_ROUTER_DST_PATCH_V1_ENABLED: true,
    INTENT_ENUM: {
      UNKNOWN: 'unknown',
      ROUTINE: 'routine',
      EVALUATE_PRODUCT: 'evaluate_product',
      DUPE_COMPARE: 'dupe_compare',
      INGREDIENT_SCIENCE: 'ingredient_science',
      TRAVEL_PLANNING: 'travel_planning',
      WEATHER_ENV: 'weather_env',
    },
    ...overrides,
  });
}

describe('aurora chat turn setup runtime', () => {
  test('prepares normalized turn setup and preserves requested llm metadata', async () => {
    const runtime = buildRuntime();

    const result = await runtime.prepareChatTurnSetup({
      parsedData: {
        action_id: 'chip.start.reco_products',
        action_data: {
          clarification_id: 'clar_1',
        },
        anchor_product_id: 'prod_123',
        anchor_product_url: 'https://example.com/p/123',
      },
      req: {
        get: jest.fn((name) => {
          if (name === 'X-Debug') return 'true';
          if (name === 'X-LLM-Provider') return 'openai';
          if (name === 'X-LLM-Model') return 'gpt-test';
          return undefined;
        }),
      },
      ctx: {
        lang: 'EN',
        match_lang: 'EN',
      },
      profile: { skin_type: 'oily' },
      recentLogs: [],
      identity: { auroraUid: 'uid_1' },
      effectiveChatFlags: { profile_v2: false },
    });

    expect(result.normalizedActionPayload).toEqual({
      action_id: 'chip.start.reco_products',
      kind: 'action',
      data: {
        clarification_id: 'clar_1',
      },
    });
    expect(result.latestRecoContextFromSession).toEqual({ source: 'session' });
    expect(result.message).toBe('reply from action');
    expect(result.requestMessage).toBe('reply from action');
    expect(result.actionId).toBe('chip.start.reco_products');
    expect(result.clarificationId).toBe('clar_1');
    expect(result.includeAlternatives).toBe(true);
    expect(result.debugUpstream).toBe(true);
    expect(result.llmProvider).toBe('openai');
    expect(result.llmModel).toBe('gpt-test');
    expect(result.llmRouteMetaForResponse).toEqual({
      llm_provider_requested: 'openai',
      llm_model_requested: 'gpt-test',
      llm_provider_effective: null,
      llm_model_effective: null,
    });
    expect(result.canonicalIntent).toEqual({
      intent: 'routine',
      source: 'sos_override',
      confidence: 0.99,
      entities: {},
    });
    expect(result.canonicalIntentForResponse).toEqual({
      intent: 'routine',
      confidence: 0.99,
      entities: {},
    });
    expect(result.pendingPregnancyPolicyEvents).toEqual([{ event_name: 'pregnancy_policy' }]);
    expect(result.profile).toEqual({
      skin_type: 'oily',
      action_patch: true,
      pregnancy_patch: true,
      text_patch: true,
    });
    expect(result.recentLogs).toEqual([{ id: 'log_1' }]);
    expect(result.textDerivedProfilePatch).toEqual({ text_patch: true });
    expect(result.textDerivedSkinLog).toEqual({ id: 'derived_log_1' });
    expect(result.hasPlannerAnchor).toBe(true);
  });

  test('merges travel patch into profile when profile v2 is enabled', async () => {
    const runtime = buildRuntime({
      inferCanonicalIntent: jest.fn(() => ({
        intent: 'travel_planning',
        source: 'intent_model',
        confidence: 0.91,
        entities: {
          destination: 'Tokyo',
          date_range: {
            start: '2026-04-01',
            end: '2026-04-03',
          },
          time_window: 'night',
        },
      })),
      hasRoutineSosSignal: jest.fn(() => false),
      resolvePreferredLegacyTravelPlan: jest.fn(() => ({ season: 'spring' })),
      extractReplyTextFromAction: jest.fn(() => ''),
      extractIncludeAlternativesFromAction: jest.fn(() => false),
    });

    const result = await runtime.prepareChatTurnSetup({
      parsedData: {
        message: 'plan my trip skincare routine',
      },
      req: {
        get: jest.fn(() => undefined),
      },
      ctx: {
        lang: 'EN',
        match_lang: 'EN',
      },
      profile: { skin_type: 'dry' },
      recentLogs: [],
      identity: { auroraUid: 'uid_2' },
      effectiveChatFlags: { profile_v2: true },
    });

    expect(result.profile.travel_plan).toEqual({
      season: 'spring',
      destination: 'Tokyo',
      start_date: '2026-04-01',
      end_date: '2026-04-03',
      time_window: 'night',
    });
    expect(result.appliedProfilePatch).toEqual({
      action_patch: true,
      pregnancy_patch: true,
      text_patch: true,
      travel_plan: {
        season: 'spring',
        destination: 'Tokyo',
        start_date: '2026-04-01',
        end_date: '2026-04-03',
        time_window: 'night',
      },
    });
    expect(result.canonicalIntentForResponse).toEqual({
      intent: 'travel_planning',
      confidence: 0.91,
      entities: {
        destination: 'Tokyo',
        date_range: {
          start: '2026-04-01',
          end: '2026-04-03',
        },
        time_window: 'night',
      },
    });
  });
});
