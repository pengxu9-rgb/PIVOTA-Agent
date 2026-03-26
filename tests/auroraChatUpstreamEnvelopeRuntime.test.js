const { createChatUpstreamEnvelopeRuntime } = require('../src/auroraBff/chatUpstreamEnvelopeRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    getUpstreamStructuredOrJson: jest.fn((upstream) => upstream && upstream.structured),
    structuredContainsCommerceLikeFields: jest.fn(() => false),
    mergeExternalVerificationIntoStructured: jest.fn((structured) => structured),
    isRenderableCardForChatboxUi: jest.fn((card) => {
      const type = String(card && card.type ? card.type : '').trim().toLowerCase();
      return type === 'aurora_structured' || type === 'recommendations' || type === 'analysis_summary';
    }),
    sanitizeUpstreamAnswer: jest.fn((answer) => String(answer || '').trim()),
    inferRouteFromCards: jest.fn(() => null),
    inferRouteFromMessageIntent: jest.fn(() => null),
    resolveRouteHint: jest.fn((fromCards, fromMessage) => fromCards || fromMessage || null),
    looksLikeGenericStructuredNotice: jest.fn(() => false),
    isRouteStructuredAnswer: jest.fn(() => false),
    buildRouteAwareAssistantText: jest.fn(() => 'route structured answer'),
    addEmotionalPreambleToAssistantText: jest.fn((text) => `${text} ::preamble`),
    stripInternalRefsDeep: jest.fn((value) => value),
    finalizeProductAnalysisRecoContract: jest.fn((payload) => ({
      ...(payload && typeof payload === 'object' ? payload : {}),
      finalized: true,
    })),
    stateChangeAllowed: jest.fn(() => true),
    recordSessionPatchProfileEmitted: jest.fn(),
    emitPendingClarificationPatch: jest.fn((sessionPatch, pending) => {
      sessionPatch.pending_clarification = pending;
    }),
    isSkincareCatalogCard: jest.fn((card) => Boolean(card && (card.keep || (card.payload && card.payload.keep)))),
    recordCatalogPoisonBlock: jest.fn(),
    looksLikeRoutineRequest: jest.fn(() => false),
    hasRoutineSosSignal: jest.fn(() => false),
    findRoutineExpertNodeFromEnvelope: jest.fn(() => null),
    hasRoutineExpertRequiredModules: jest.fn(() => true),
    buildRoutineRulesOnlyFallbackCardsForChat: jest.fn(() => []),
    suppressAnalysisCardsForTravelEnvTurn: jest.fn((cards) => cards),
    selectTemplate: jest.fn(() => ({ id: 'tmpl_1', module: 'chat', variant: 'default' })),
    renderAssistantMessage: jest.fn(() => ({
      applied: true,
      content: 'templated answer',
      format: 'markdown',
    })),
    recordTemplateApplied: jest.fn(),
    recordTemplateFallback: jest.fn(),
    adaptChips: jest.fn(({ existingChips }) => ({ chips: Array.isArray(existingChips) ? existingChips : [] })),
    looksLikeStallPhrase: jest.fn(() => false),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx && ctx.request_id,
      ...payload,
    })),
    makeEvent: jest.fn((ctx, event_name, event_data) => ({
      event_name,
      event_data,
      request_id: ctx && ctx.request_id,
    })),
    AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED: false,
    ...overrides,
  };

  return {
    deps,
    runtime: createChatUpstreamEnvelopeRuntime(deps),
  };
}

describe('aurora chat upstream envelope runtime', () => {
  test('builds final envelope with structured card, finalized product analysis, and session patch', () => {
    const { runtime, deps } = buildRuntime();

    const envelope = runtime.buildUpstreamEnvelope({
      ctx: { request_id: 'req_upstream_1', lang: 'EN', trigger_source: 'chat' },
      upstream: {
        structured: {
          external_verification: {
            citations: [{ url: 'https://example.com/citation' }],
          },
        },
      },
      allowRecs: true,
      debugUpstream: false,
      answer: 'raw upstream answer',
      derivedCards: [],
      cards: [{ card_id: 'product_1', type: 'product_analysis', payload: { sku: 'sku_1' } }],
      fieldMissing: [],
      contextRaw: { source: 'upstream' },
      contextCard: [{ card_id: 'ctx_1', type: 'aurora_context_raw', payload: { foo: 'bar' } }],
      clarification: { id: 'clarify_1' },
      responseIntentMessage: 'recommend products',
      message: 'recommend products',
      normalizedActionPayload: {},
      profile: { skin_type: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      profileSummary: { skin_type: 'dry' },
      appliedProfilePatch: { skin_type: 'dry' },
      profilePatchFromSession: null,
      nextStateOverride: 'RECO_RESULTS',
      pendingClarificationPatchOverride: { current: { norm_id: 'skin_type' } },
      pendingClarificationFromUpstream: null,
      hasLlmRouteMeta: true,
      llmRouteMeta: { llm_provider_effective: 'gemini' },
      canonicalIntent: { intent: 'reco_products' },
      heatmapImpressionEvent: { event_name: 'heatmap_impression' },
      suggestedChips: [{ chip_id: 'chip.start.reco_products' }],
      makeChatAssistantMessage: (content, format = 'text') => ({ role: 'assistant', content, format }),
    });

    expect(envelope.assistant_message).toEqual({
      role: 'assistant',
      content: 'templated answer',
      format: 'markdown',
    });
    expect(envelope.session_patch).toEqual({
      next_state: 'RECO_RESULTS',
      profile: { skin_type: 'dry' },
      pending_clarification: { current: { norm_id: 'skin_type' } },
      llm: { llm_provider_effective: 'gemini' },
    });
    expect(envelope.cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'aurora_structured' }),
        expect.objectContaining({
          card_id: 'product_1',
          type: 'product_analysis',
          payload: expect.objectContaining({ sku: 'sku_1', finalized: true }),
        }),
        expect.objectContaining({
          card_id: 'ctx_1',
          type: 'aurora_context_raw',
          payload: expect.objectContaining({
            foo: 'bar',
            clarification: { id: 'clarify_1' },
          }),
        }),
      ]),
    );
    expect(envelope.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_name: 'value_moment' }),
        expect.objectContaining({ event_name: 'llm_route' }),
        expect.objectContaining({ event_name: 'recos_requested' }),
        expect.objectContaining({ event_name: 'heatmap_impression' }),
      ]),
    );
    expect(deps.recordSessionPatchProfileEmitted).toHaveBeenCalledWith({ changed: true });
    expect(deps.recordTemplateApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'tmpl_1',
        source: 'chat',
      }),
    );
  });

  test('filters catalog poison cards in routine-like context and emits telemetry', () => {
    const { runtime, deps } = buildRuntime({
      AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED: true,
      looksLikeRoutineRequest: jest.fn(() => true),
      renderAssistantMessage: jest.fn(() => null),
    });

    const envelope = runtime.buildUpstreamEnvelope({
      ctx: { request_id: 'req_upstream_2', lang: 'EN', trigger_source: 'chat' },
      upstream: {},
      allowRecs: false,
      debugUpstream: false,
      answer: 'safe answer',
      derivedCards: [],
      cards: [
        { card_id: 'keep', type: 'recommendations', keep: true, payload: { keep: true, product_ids: ['p1'] } },
        { card_id: 'drop', type: 'comparison', keep: false, payload: { keep: false, note: 'non skincare' } },
      ],
      fieldMissing: [],
      contextRaw: null,
      contextCard: [],
      clarification: null,
      responseIntentMessage: 'help me with routine',
      message: 'help me with routine',
      normalizedActionPayload: {},
      profile: {},
      recentLogs: [],
      profileSummary: null,
      profilePatchFromSession: null,
      pendingClarificationPatchOverride: undefined,
      pendingClarificationFromUpstream: null,
      hasLlmRouteMeta: false,
      llmRouteMeta: null,
      canonicalIntent: { intent: 'routine' },
      suggestedChips: [],
      makeChatAssistantMessage: (content, format = 'text') => ({ role: 'assistant', content, format }),
    });

    expect(envelope.cards).toEqual([
      expect.objectContaining({ card_id: 'keep', type: 'recommendations' }),
    ]);
    expect(envelope.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_name: 'catalog_poison_block',
          event_data: expect.objectContaining({ blocked_count: 1 }),
        }),
      ]),
    );
    expect(deps.recordCatalogPoisonBlock).toHaveBeenCalledWith(1);
  });

  test('adds routine fallback cards when the response stalls', () => {
    const { runtime } = buildRuntime({
      looksLikeRoutineRequest: jest.fn(() => true),
      isRenderableCardForChatboxUi: jest.fn(() => false),
      looksLikeStallPhrase: jest.fn(() => true),
      hasRoutineExpertRequiredModules: jest.fn(() => false),
      buildRoutineRulesOnlyFallbackCardsForChat: jest.fn(() => [
        { card_id: 'fallback_1', type: 'analysis_summary', payload: { source: 'rules_only' } },
      ]),
      renderAssistantMessage: jest.fn(() => null),
    });

    const envelope = runtime.buildUpstreamEnvelope({
      ctx: { request_id: 'req_upstream_3', lang: 'EN', trigger_source: 'chat' },
      upstream: {},
      allowRecs: false,
      debugUpstream: false,
      answer: 'generic stall response',
      derivedCards: [],
      cards: [],
      fieldMissing: [],
      contextRaw: null,
      contextCard: [],
      clarification: null,
      responseIntentMessage: 'build my routine',
      message: 'build my routine',
      normalizedActionPayload: {},
      profile: { skin_type: 'combination' },
      recentLogs: [{ id: 'log_1' }],
      profileSummary: null,
      profilePatchFromSession: null,
      pendingClarificationPatchOverride: undefined,
      pendingClarificationFromUpstream: null,
      hasLlmRouteMeta: false,
      llmRouteMeta: null,
      canonicalIntent: { intent: 'routine' },
      suggestedChips: [],
      makeChatAssistantMessage: (content, format = 'text') => ({ role: 'assistant', content, format }),
    });

    expect(envelope.assistant_message.content).toContain('rules-based fallback');
    expect(envelope.cards[0]).toEqual(
      expect.objectContaining({
        card_id: 'fallback_1',
        type: 'analysis_summary',
      }),
    );
  });
});
