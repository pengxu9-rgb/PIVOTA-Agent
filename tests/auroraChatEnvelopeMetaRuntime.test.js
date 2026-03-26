const { createChatEnvelopeMetaRuntime } = require('../src/auroraBff/chatEnvelopeMetaRuntime');

function buildRuntime(overrides = {}) {
  return createChatEnvelopeMetaRuntime({
    summarizeProfileForContext: jest.fn((profileValue, { profileV2Enabled }) => ({
      profileValue,
      profileV2Enabled,
    })),
    resolvePreferredLegacyTravelPlan: jest.fn((profileValue) => (profileValue && profileValue.travel_plan ? profileValue.travel_plan : null)),
    BLOCK_LEVEL: { INFO: 'info' },
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    normalizeRecoSourceDetail: jest.fn((value) => String(value || '').trim().toLowerCase() || null),
    pickFirstTrimmed: (...values) => values.find((value) => String(value || '').trim()) || null,
    recordAuroraRecoContextUsed: jest.fn(),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    ...overrides,
  });
}

describe('aurora chat envelope meta runtime', () => {
  test('summarizes chat profile with effective profile_v2 flag', () => {
    const summarizeProfileForContext = jest.fn((profileValue, { profileV2Enabled }) => ({
      id: profileValue.id,
      profileV2Enabled,
    }));
    const runtime = buildRuntime({ summarizeProfileForContext });

    const summary = runtime.summarizeChatProfileForContext({
      profileValue: { id: 'profile_1' },
      effectiveChatFlags: { profile_v2: true },
    });

    expect(summary).toEqual({ id: 'profile_1', profileV2Enabled: true });
    expect(summarizeProfileForContext).toHaveBeenCalledWith(
      { id: 'profile_1' },
      { profileV2Enabled: true },
    );
  });

  test('applies llm route meta once into session_patch and events', () => {
    const runtime = buildRuntime();

    const envelope = runtime.applyLlmMetaToEnvelope({
      envelope: { session_patch: {}, events: [] },
      llmRouteMetaForResponse: {
        llm_provider_requested: 'gemini',
        llm_model_effective: 'gemini-2.5-pro',
      },
      ctx: { request_id: 'req_chat_meta_1' },
    });

    expect(envelope.session_patch.llm).toEqual({
      llm_provider_requested: 'gemini',
      llm_model_effective: 'gemini-2.5-pro',
    });
    expect(envelope.events).toEqual([
      {
        event_name: 'llm_route',
        event_data: {
          llm_provider_requested: 'gemini',
          llm_model_effective: 'gemini-2.5-pro',
        },
      },
    ]);
  });

  test('applies pending pregnancy policy events and annotates session meta', () => {
    const runtime = buildRuntime();

    const envelope = runtime.applyPendingPregnancyPolicyEventsToEnvelope({
      envelope: { session_patch: { meta: { existing: true } }, events: [{ event_name: 'keep_me' }] },
      pendingPregnancyPolicyEvents: [
        { event_name: 'pregnancy_status_defaulted' },
        { event_name: 'pregnancy_status_auto_reset' },
        { event_name: 'keep_me' },
      ],
    });

    expect(envelope.events).toEqual([
      { event_name: 'keep_me' },
      { event_name: 'pregnancy_status_defaulted' },
      { event_name: 'pregnancy_status_auto_reset' },
    ]);
    expect(envelope.session_patch.meta).toEqual({
      existing: true,
      pregnancy_status_defaulted: true,
      pregnancy_status_auto_reset: true,
    });
  });

  test('applies recommendation meta and emits context metrics only once', () => {
    const recordAuroraRecoContextUsed = jest.fn();
    const runtime = buildRuntime({ recordAuroraRecoContextUsed });

    const result = runtime.applyRecommendationMetaToEnvelope({
      envelope: {
        cards: [
          {
            type: 'recommendations',
            payload: {
              source: 'catalog_grounded',
              recommendation_meta: {
                trigger_source: ' profile_update ',
                recompute_from_profile_update: true,
              },
            },
          },
        ],
        events: [],
      },
      recentLogs: [{ id: 'log_1' }],
      profile: { itinerary: 'Tokyo trip' },
      safetyDecision: { block_level: 'warn', reasons: ['safety_flag'] },
      recoContextMetricsEmitted: false,
    });

    expect(result.envelope.recommendation_meta).toEqual({
      source_mode: 'catalog_grounded',
      trigger_source: 'profile_update',
      recompute_from_profile_update: true,
      used_recent_logs: true,
      used_itinerary: true,
      used_safety_flags: true,
    });
    expect(result.envelope.cards[0].payload.recommendation_meta).toEqual(result.envelope.recommendation_meta);
    expect(result.recoContextMetricsEmitted).toBe(true);
    expect(recordAuroraRecoContextUsed).toHaveBeenCalledTimes(3);
    expect(recordAuroraRecoContextUsed).toHaveBeenNthCalledWith(1, { signal: 'recent_logs' });
    expect(recordAuroraRecoContextUsed).toHaveBeenNthCalledWith(2, { signal: 'itinerary' });
    expect(recordAuroraRecoContextUsed).toHaveBeenNthCalledWith(3, { signal: 'safety' });
  });
});
