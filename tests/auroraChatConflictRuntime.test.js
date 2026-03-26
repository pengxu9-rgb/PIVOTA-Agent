const { createChatConflictRuntime } = require('../src/auroraBff/chatConflictRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    buildLocalCompatibilitySimulationInput: jest.fn(() => null),
    simulateConflicts: jest.fn(() => ({ safe: true, conflicts: [], summary: 'safe' })),
    buildHeatmapStepsFromRoutine: jest.fn(() => [{ step_id: 'step_1' }]),
    buildConflictHeatmapV1: jest.fn(() => ({
      schema_version: 'aurora.ui.conflict_heatmap.v1',
      state: 'has_conflicts',
      axes: { rows: { items: [{ id: 'row_1' }] } },
      cells: { items: [{ severity: 2 }] },
      unmapped_conflicts: [],
    })),
    buildRouteAwareAssistantText: jest.fn(() => 'route-aware-conflict-text'),
    addEmotionalPreambleToAssistantText: jest.fn((text) => `preamble:${text}`),
    stateChangeAllowed: jest.fn(() => true),
    CONFLICT_HEATMAP_V1_ENABLED: true,
    ...overrides,
  };

  return {
    deps,
    runtime: createChatConflictRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    ctx: {
      request_id: 'req_conflict_1',
      lang: 'EN',
      trigger_source: 'text',
    },
    message: 'Can I use product A and product B in the same night?',
    profile: { skinType: 'dry' },
    nextStateOverride: 'S7_PRODUCT_RECO',
    buildEnvelope: jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload })),
    makeChatAssistantMessage: jest.fn((content, format = 'text') => ({ role: 'assistant', content, format })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    ...overrides,
  };
}

describe('aurora chat conflict runtime', () => {
  test('returns simulation envelope for parseable conflict question', async () => {
    const { runtime, deps } = buildHarness({
      looksLikeCompatibilityOrConflictQuestion: jest.fn(() => true),
      buildLocalCompatibilitySimulationInput: jest.fn(() => ({
        routine: { steps: [{ name: 'retinoid' }] },
        testProduct: { name: 'aha serum' },
      })),
      simulateConflicts: jest.fn(() => ({
        safe: false,
        conflicts: [{ severity: 'warn', message: 'stacking risk' }],
        summary: 'Potential conflict detected.',
      })),
    });

    const out = await runtime.maybeBuildConflictEnvelope(buildArgs());

    expect(out.handled).toBe(true);
    expect(deps.simulateConflicts).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'EN',
      }),
    );
    expect(out.envelope.cards).toEqual([
      expect.objectContaining({ type: 'routine_simulation' }),
      expect.objectContaining({ type: 'conflict_heatmap' }),
    ]);
    expect(out.envelope.session_patch).toEqual({ next_state: 'S7_PRODUCT_RECO' });
    expect(out.envelope.events.map((event) => event.event_name)).toEqual([
      'simulate_conflict',
      'aurora_conflict_heatmap_impression',
    ]);
  });

  test('returns parse-fail notice when conflict text cannot be parsed into comparable steps', async () => {
    const { runtime } = buildHarness({
      looksLikeCompatibilityOrConflictQuestion: jest.fn(() => true),
      buildLocalCompatibilitySimulationInput: jest.fn(() => null),
    });

    const out = await runtime.maybeBuildConflictEnvelope(buildArgs({
      ctx: {
        request_id: 'req_conflict_2',
        lang: 'CN',
        trigger_source: 'action',
      },
      message: '这个能一起用吗？',
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'confidence_notice',
        payload: expect.objectContaining({
          reason: 'conflict_input_parse_failed',
        }),
      }),
    );
    expect(out.envelope.events).toEqual([
      expect.objectContaining({ event_name: 'conflict_input_parse_failed' }),
    ]);
  });

  test('returns unhandled when request is not a supported conflict short-circuit', async () => {
    const { runtime } = buildHarness({
      looksLikeCompatibilityOrConflictQuestion: jest.fn(() => true),
    });

    const out = await runtime.maybeBuildConflictEnvelope(buildArgs({
      ctx: {
        request_id: 'req_conflict_3',
        lang: 'EN',
        trigger_source: 'system',
      },
    }));

    expect(out).toEqual({ handled: false, envelope: null });
  });
});
