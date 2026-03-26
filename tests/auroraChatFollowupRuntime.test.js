const { createChatFollowupRuntime } = require('../src/auroraBff/chatFollowupRuntime');

function buildHarness(overrides = {}) {
  const buildEnvelope = jest.fn((_ctx, payload) => payload);
  const makeChatAssistantMessage = jest.fn((content) => ({ content }));
  const makeEvent = jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data }));
  const summarizeChatProfileForContext = jest.fn((profile) => (
    profile ? { skinType: profile.skinType || null, region: profile.region || null } : null
  ));

  const runtime = createChatFollowupRuntime({
    logger: { info: jest.fn(), warn: jest.fn() },
    ANALYSIS_FOLLOWUP_ACTION_IDS: new Set(['chip.aurora.next_action.deep_dive_skin']),
    buildAnalysisFollowupContent: jest.fn(() => ({
      assistant_text: 'Deep dive result',
      suggested_chips: [{ chip_id: 'next' }],
      cards: [{ card_id: 'card_1', type: 'analysis_story_v2', payload: { ok: true } }],
      used_last_analysis: true,
      missing_context: false,
    })),
    recordAuroraSkinFlowMetric: jest.fn(),
    pickFirstTrimmed: (...values) => values.map((v) => String(v || '').trim()).find(Boolean) || '',
    buildConfidenceNoticeCardPayload: jest.fn(({ language, reason, confidence, actions, details }) => ({
      language,
      reason,
      confidence,
      actions,
      details,
    })),
    PRODUCT_URL_INGREDIENT_ANALYSIS_ENABLED: false,
    buildProductAnalysisFromUrlIngredients: jest.fn(),
    applyProductAnalysisGapContract: jest.fn((payload) => payload),
    initCandidateFilterStats: jest.fn(() => ({ kept: 0 })),
    buildRealtimeCompetitorCandidates: jest.fn(async () => ({
      reason: 'fallback_pool',
      candidates: [
        {
          brand: 'Brand A',
          name: 'Acne Serum',
          similarity_score: 0.91,
          why_candidate: ['acne', 'oil control'],
        },
        {
          brand: 'Brand B',
          name: 'Barrier Serum',
          similarity_score: 0.82,
          why_candidate: ['hydration', 'barrier'],
        },
      ],
    })),
    PRODUCT_URL_REALTIME_COMPETITOR_TIMEOUT_MS: 3200,
    PRODUCT_URL_REALTIME_COMPETITOR_MAX_QUERIES: 4,
    PRODUCT_URL_REALTIME_COMPETITOR_MAX_CANDIDATES: 6,
    sanitizeCompetitorCandidates: jest.fn((candidates) => candidates || []),
    routeCompetitorCandidatePools: jest.fn(({ candidates }) => ({
      compPool: candidates || [],
      relPool: [],
      dupePool: [],
    })),
    uniqCaseInsensitiveStrings: (values, max = 16) => {
      const out = [];
      const seen = new Set();
      for (const raw of Array.isArray(values) ? values : []) {
        const value = String(raw || '').trim();
        const key = value.toLowerCase();
        if (!value || seen.has(key)) continue;
        seen.add(key);
        out.push(value);
        if (out.length >= max) break;
      }
      return out;
    },
    asStringArray: (value) => (Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : []),
    joinBrandAndName: (brand, name) => [brand, name].filter(Boolean).join(' ').trim(),
    normalizeProductAnalysis: jest.fn((payload) => ({ payload, field_missing: [] })),
    reconcileProductAnalysisConsistency: jest.fn((payload) => payload),
    finalizeProductAnalysisRecoContract: jest.fn((payload) => payload),
    enrichProductAnalysisPayload: jest.fn((payload) => payload),
    stripInternalRefsDeep: jest.fn((payload) => ({ ...payload, stripped: true })),
    isPlainObject: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    ...overrides,
  });

  return {
    runtime,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    summarizeChatProfileForContext,
  };
}

describe('aurora chat followup runtime', () => {
  test('routes analysis followup action into an envelope with metrics', () => {
    const { runtime, buildEnvelope, makeChatAssistantMessage, makeEvent } = buildHarness();

    const envelope = runtime.maybeBuildAnalysisFollowupEnvelope({
      ctx: { request_id: 'req_followup_1', lang: 'EN' },
      actionId: 'chip.aurora.next_action.deep_dive_skin',
      profile: { lastAnalysis: { id: 'analysis_1' } },
      actionReplyText: 'Tell me more',
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });

    expect(buildEnvelope).toHaveBeenCalled();
    expect(makeChatAssistantMessage).toHaveBeenCalledWith('Deep dive result');
    expect(envelope.cards).toEqual([{ card_id: 'card_1', type: 'analysis_story_v2', payload: { ok: true } }]);
    expect(envelope.events).toEqual([
      {
        event_name: 'analysis_followup_action_routed',
        data: {
          action_id: 'chip.aurora.next_action.deep_dive_skin',
          used_last_analysis: true,
          missing_context: false,
          fell_back_to_generic: false,
        },
      },
    ]);
  });

  test('returns missing-anchor confidence notice for follow-up alternatives', async () => {
    const { runtime, buildEnvelope, makeChatAssistantMessage, makeEvent, summarizeChatProfileForContext } = buildHarness();

    const envelope = await runtime.maybeBuildFollowupAlternativesEnvelope({
      ctx: { request_id: 'req_followup_2', lang: 'EN' },
      actionId: 'chat.followup.alternatives',
      normalizedActionPayload: {
        data: {
          goal: 'acne_focus',
        },
      },
      message: 'show me alternatives',
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
    });

    expect(envelope.cards.map((card) => card.type)).toEqual(['confidence_notice']);
    expect(envelope.session_patch).toEqual({
      meta: {
        followup_goal: 'acne_focus',
      },
    });
    expect(envelope.events).toEqual([
      {
        event_name: 'value_moment',
        data: {
          kind: 'product_analyze_followup',
          followup_goal: 'acne_focus',
          anchored: false,
        },
      },
    ]);
  });

  test('builds anchored follow-up alternatives product analysis envelope', async () => {
    const { runtime, buildEnvelope, makeChatAssistantMessage, makeEvent, summarizeChatProfileForContext } = buildHarness();

    const envelope = await runtime.maybeBuildFollowupAlternativesEnvelope({
      ctx: { request_id: 'req_followup_3', lang: 'EN' },
      actionId: 'chat.followup.alternatives',
      normalizedActionPayload: {
        data: {
          goal: 'acne_focus',
          anchor: {
            brand: 'Anchor Brand',
            name: 'Anchor Serum',
            url: 'https://brand.example/anchor-serum',
          },
        },
      },
      message: 'show me acne-focused alternatives',
      anchorProductUrl: 'https://brand.example/anchor-serum',
      profile: { skinType: 'oily', region: 'us' },
      debugUpstream: false,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      summarizeChatProfileForContext,
    });

    expect(buildEnvelope).toHaveBeenCalled();
    expect(envelope.cards).toHaveLength(1);
    expect(envelope.cards[0].type).toBe('product_analysis');
    expect(envelope.cards[0].payload.provenance).toEqual(
      expect.objectContaining({
        followup_goal: 'acne_focus',
        anchor_used: expect.objectContaining({
          anchor_product_url: 'https://brand.example/anchor-serum',
          anchor_brand: 'Anchor Brand',
          anchor_name: 'Anchor Serum',
        }),
      }),
    );
    expect(envelope.events).toEqual([
      {
        event_name: 'value_moment',
        data: {
          kind: 'product_analyze_followup',
          followup_goal: 'acne_focus',
          anchored: true,
        },
      },
    ]);
  });
});
