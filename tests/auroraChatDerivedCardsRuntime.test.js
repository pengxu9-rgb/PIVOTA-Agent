const { createChatDerivedCardsRuntime } = require('../src/auroraBff/chatDerivedCardsRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    chatFitCheckRuntime: {
      buildFitCheckCards: jest.fn(async () => []),
    },
    buildEnvStressUiModelFromUpstream: jest.fn((payload) => payload),
    buildEnvStressUiModelFromLocal: jest.fn(() => ({ schema_version: 'aurora.ui.env_stress.v1' })),
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    extractHeatmapStepsFromConflictDetector: jest.fn(() => [{ id: 'step_1' }]),
    buildConflictHeatmapV1: jest.fn(() => ({
      schema_version: 'aurora.ui.conflict_heatmap.v1',
      axes: { rows: { items: [{ id: 'row_1' }] } },
      cells: { items: [{ severity: 2 }] },
      unmapped_conflicts: [],
      state: 'ready',
    })),
    CONFLICT_HEATMAP_V1_ENABLED: true,
    INCLUDE_RAW_AURORA_CONTEXT: false,
    makeEvent: jest.fn((_ctx, eventName, data) => ({
      event_name: eventName,
      event_data: data || {},
    })),
    INTENT_ENUM: {
      CONFLICT_CHECK: 'conflict_check',
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatDerivedCardsRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    upstream: { context: {} },
    cards: [],
    fieldMissing: [],
    ctx: {
      request_id: 'req_chat_derived_1',
      lang: 'EN',
      trigger_source: 'text',
    },
    message: 'hello',
    upstreamMessage: '',
    actionId: '',
    canonicalIntent: null,
    debugUpstream: false,
    profile: { skinType: 'dry' },
    profileSummary: { skinType: 'dry' },
    recentLogs: [{ id: 'log_1' }],
    req: {},
    anchorProductUrl: '',
    anchorProductId: '',
    llmProvider: 'gemini',
    llmModel: 'gemini-2.5-flash',
    ...overrides,
  };
}

describe('aurora chat derived cards runtime', () => {
  test('filters upstream env-stress cards when the user did not request them', async () => {
    const { runtime } = buildRuntime();

    const result = await runtime.prepareUpstreamDerivedCards(
      buildArgs({
        cards: [
          { type: 'env_stress', payload: { schema_version: 'aurora.ui.env_stress.v1' } },
          { type: 'analysis_summary', payload: {} },
        ],
      }),
    );

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe('analysis_summary');
    expect(result.fieldMissing).toContainEqual({
      field: 'cards.env_stress',
      reason: 'not_requested',
    });
  });

  test('builds conflict derived cards and heatmap impression event', async () => {
    const { runtime, deps } = buildRuntime({
      looksLikeCompatibilityOrConflictQuestion: jest.fn(() => true),
    });

    const result = await runtime.prepareUpstreamDerivedCards(
      buildArgs({
        upstream: {
          context: {
            conflict_detector: {
              safe: false,
              conflicts: [{ id: 'c_1' }],
            },
          },
        },
        message: 'Can you check routine conflicts?',
      }),
    );

    expect(result.derivedCards.map((card) => card.type)).toEqual([
      'routine_simulation',
      'conflict_heatmap',
    ]);
    expect(result.heatmapImpressionEvent).toEqual(
      expect.objectContaining({
        event_name: 'aurora_conflict_heatmap_impression',
      }),
    );
    expect(deps.buildConflictHeatmapV1).toHaveBeenCalled();
  });

  test('delegates fit-check work and can emit raw context card', async () => {
    const { runtime, deps } = buildRuntime({
      INCLUDE_RAW_AURORA_CONTEXT: true,
      chatFitCheckRuntime: {
        buildFitCheckCards: jest.fn(async () => [{ type: 'product_analysis', payload: { assessment: {} } }]),
      },
    });

    const result = await runtime.prepareUpstreamDerivedCards(
      buildArgs({
        upstream: {
          intent: 'product_suitability',
          context: {
            anchor: { product_id: 'sku_1' },
          },
        },
      }),
    );

    expect(deps.chatFitCheckRuntime.buildFitCheckCards).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorFromContext: { product_id: 'sku_1' },
      }),
    );
    expect(result.derivedCards).toContainEqual(
      expect.objectContaining({
        type: 'product_analysis',
      }),
    );
    expect(result.contextCard).toEqual([
      expect.objectContaining({
        type: 'aurora_context_raw',
      }),
    ]);
  });
});
