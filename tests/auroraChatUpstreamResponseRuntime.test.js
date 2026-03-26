const { createChatUpstreamResponseRuntime } = require('../src/auroraBff/chatUpstreamResponseRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    stripRecommendationCards: jest.fn((cards) => cards.filter((card) => String(card.type || '').trim().toLowerCase() !== 'recommendations')),
    enrichRecommendationsWithAlternatives: jest.fn(async ({ recommendations }) => ({
      recommendations: Array.isArray(recommendations)
        ? recommendations.map((item) => ({ ...item, alt_added: true }))
        : [],
      field_missing: [{ field: 'alternatives', reason: 'partial' }],
    })),
    mergeFieldMissing: jest.fn((existing, incoming) => [
      ...(Array.isArray(existing) ? existing : []),
      ...(Array.isArray(incoming) ? incoming : []),
    ]),
    chatClarificationRuntime: {
      deriveUpstreamClarification: jest.fn(() => ({
        clarification: { id: 'clarify_1' },
        pendingClarificationFromUpstream: { current: { id: 'skin_type' } },
        suggestedChips: [{ chip_id: 'chip.skin_type' }],
      })),
    },
    chatDerivedCardsRuntime: {
      prepareUpstreamDerivedCards: jest.fn(async ({ cards, fieldMissing }) => ({
        cards,
        fieldMissing,
        contextRaw: { source: 'upstream' },
        contextCard: [{ card_id: 'ctx_1', type: 'aurora_context_raw', payload: { foo: 'bar' } }],
        derivedCards: [{ card_id: 'derived_1', type: 'analysis_summary', payload: { ok: true } }],
        heatmapImpressionEvent: { event_name: 'heatmap_impression' },
      })),
    },
    chatUpstreamEnvelopeRuntime: {
      buildUpstreamEnvelope: jest.fn((args) => ({
        card_types: Array.isArray(args.cards) ? args.cards.map((card) => card.type) : [],
        field_missing: args.fieldMissing,
        clarification: args.clarification,
        pending: args.pendingClarificationFromUpstream,
        suggested_chips: args.suggestedChips,
        derived_cards: args.derivedCards,
        heatmap: args.heatmapImpressionEvent,
      })),
    },
    AURORA_CHAT_CLARIFICATION_FILTER_KNOWN_ENABLED: true,
    ...overrides,
  };

  return {
    deps,
    runtime: createChatUpstreamResponseRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    upstream: {
      cards: [
        { card_id: 'reco_1', type: 'recommendations', payload: { recommendations: [{ id: 'p1' }] } },
        { card_id: 'analysis_1', type: 'analysis_summary', payload: { ok: true } },
      ],
    },
    allowRecs: true,
    includeAlternatives: false,
    debugUpstream: false,
    ctx: { request_id: 'req_chat_upstream_1', lang: 'EN' },
    profileSummary: { skin_type: 'dry' },
    recentLogs: [{ id: 'log_1' }],
    answer: 'hello',
    message: 'recommend something',
    upstreamMessage: 'recommend something',
    actionId: 'chip.start.reco_products',
    canonicalIntent: { intent: 'reco_products' },
    profile: { skin_type: 'dry' },
    req: {},
    anchorProductUrl: '',
    anchorProductId: '',
    llmProvider: 'gemini',
    llmModel: 'gemini-3-flash-preview',
    normalizedActionPayload: {},
    appliedProfilePatch: null,
    profilePatchFromSession: null,
    nextStateOverride: 'S7_PRODUCT_RECO',
    pendingClarificationPatchOverride: undefined,
    hasLlmRouteMeta: false,
    llmRouteMeta: null,
    heatmapImpressionEvent: null,
    makeChatAssistantMessage: jest.fn((content, format = 'text') => ({ role: 'assistant', content, format })),
    ...overrides,
  };
}

describe('aurora chat upstream response runtime', () => {
  test('strips recommendation cards when recommendations are not allowed', async () => {
    const { runtime, deps } = buildRuntime();

    const envelope = await runtime.buildUpstreamResponseEnvelope(
      buildArgs({
        allowRecs: false,
      }),
    );

    expect(deps.stripRecommendationCards).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ type: 'recommendations' })]),
    );
    expect(deps.chatDerivedCardsRuntime.prepareUpstreamDerivedCards).toHaveBeenCalledWith(
      expect.objectContaining({
        cards: [expect.objectContaining({ type: 'analysis_summary' })],
        fieldMissing: [{ field: 'cards', reason: 'recommendations_not_requested' }],
      }),
    );
    expect(envelope.card_types).toEqual(['analysis_summary']);
  });

  test('enriches recommendation cards with alternatives before derived-card processing', async () => {
    const { runtime, deps } = buildRuntime();

    await runtime.buildUpstreamResponseEnvelope(
      buildArgs({
        includeAlternatives: true,
      }),
    );

    expect(deps.enrichRecommendationsWithAlternatives).toHaveBeenCalledWith(
      expect.objectContaining({
        recommendations: [{ id: 'p1' }],
      }),
    );
    expect(deps.mergeFieldMissing).toHaveBeenCalledWith(undefined, [{ field: 'alternatives', reason: 'partial' }]);
    expect(deps.chatDerivedCardsRuntime.prepareUpstreamDerivedCards).toHaveBeenCalledWith(
      expect.objectContaining({
        cards: [
          expect.objectContaining({
            type: 'recommendations',
            payload: { recommendations: [{ id: 'p1', alt_added: true }] },
            field_missing: [{ field: 'alternatives', reason: 'partial' }],
          }),
          expect.objectContaining({ type: 'analysis_summary' }),
        ],
      }),
    );
  });

  test('delegates clarification, derived cards, and envelope assembly with expected wiring', async () => {
    const { runtime, deps } = buildRuntime();

    const envelope = await runtime.buildUpstreamResponseEnvelope(buildArgs());

    expect(deps.chatClarificationRuntime.deriveUpstreamClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        upstream: expect.any(Object),
        profileSummary: { skin_type: 'dry' },
        filterKnown: true,
        upstreamMessage: 'recommend something',
        message: 'recommend something',
      }),
    );
    expect(deps.chatUpstreamEnvelopeRuntime.buildUpstreamEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        clarification: { id: 'clarify_1' },
        pendingClarificationFromUpstream: { current: { id: 'skin_type' } },
        suggestedChips: [{ chip_id: 'chip.skin_type' }],
        contextRaw: { source: 'upstream' },
        derivedCards: [{ card_id: 'derived_1', type: 'analysis_summary', payload: { ok: true } }],
      }),
    );
    expect(envelope).toEqual(
      expect.objectContaining({
        clarification: { id: 'clarify_1' },
        pending: { current: { id: 'skin_type' } },
        suggested_chips: [{ chip_id: 'chip.skin_type' }],
      }),
    );
  });
});
