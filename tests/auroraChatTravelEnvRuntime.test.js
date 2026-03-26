const { createChatTravelEnvRuntime } = require('../src/auroraBff/chatTravelEnvRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    INTENT_ENUM: {
      TRAVEL_PLANNING: 'travel_planning',
      WEATHER_ENV: 'weather_env',
    },
    GATE_MODE: {
      ADVISORY: 'advisory',
    },
    BLOCK_LEVEL: {
      INFO: 'info',
      WARN: 'warn',
    },
    AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED: true,
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    extractWeatherScenario: jest.fn(() => 'travel'),
    buildEnvStressUiModelFromLocal: jest.fn(() => ({ schema_version: 'aurora.ui.env_stress.v1', ess: 22 })),
    buildWeatherAdviceMessage: jest.fn(() => 'Local weather advice'),
    resolvePreferredLegacyTravelPlan: jest.fn(() => null),
    runTravelPipeline: jest.fn(async () => null),
    getOpenAIClient: jest.fn(() => ({ provider: 'stub' })),
    recordAuroraTravelEnvCardEmitted: jest.fn(),
    getTravelWeather: jest.fn(async () => ({
      source: 'weather_api',
      location: { name: 'Tokyo' },
      date_range: { start: '2026-03-01', end: '2026-03-05' },
    })),
    buildEpiPayload: jest.fn(() => ({
      epi: 55,
      env_source: 'weather_api',
      components: {},
      reco_weights: {},
      strategy: { am: ['SPF'], pm: ['Barrier repair'], notes: ['Pack travel minis'] },
    })),
    normalizeEnvStressTier: jest.fn(() => 'medium'),
    buildEpiRadarRows: jest.fn(() => []),
    buildTravelReadinessFromEpi: jest.fn(() => ({
      destination_context: { destination: 'Tokyo', start_date: '2026-03-01', end_date: '2026-03-05' },
      reco_bundle: [{ sku_id: 'sku_1' }],
      shopping_preview: { title: 'Preview' },
    })),
    buildEnvStressTierDescription: jest.fn(() => 'Medium'),
    stateChangeAllowed: jest.fn(() => true),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatTravelEnvRuntime(deps),
  };
}

function buildCallArgs(overrides = {}) {
  return {
    ctx: {
      request_id: 'req_travel_1',
      trace_id: 'trace_travel_1',
      lang: 'EN',
      trigger_source: 'text',
    },
    message: 'How is weather there? Will it be humid?',
    canonicalIntent: {
      intent: 'travel_planning',
      entities: {
        destination: 'Tokyo',
        date_range: { start: '2026-03-01', end: '2026-03-05' },
      },
    },
    plannerDecision: null,
    profile: { skinType: 'dry' },
    recentLogs: [],
    chatContext: {},
    effectiveChatFlags: { travel_weather_live_v1: false },
    templateAcceptLanguage: 'en-US',
    safetyDecision: null,
    nextStateOverride: 'S7_PRODUCT_RECO',
    buildSafetyNoticeText: jest.fn(() => 'Safety prefix'),
    pushGateDecision: jest.fn(() => ({ mode: 'advisory' })),
    enqueueGateAdvisory: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      ...payload,
    })),
    makeChatAssistantMessage: jest.fn((content, format = 'text') => ({
      role: 'assistant',
      content,
      format,
    })),
    makeEvent: jest.fn((_ctx, event_name, data) => ({
      event_name,
      data: data || {},
    })),
    ...overrides,
  };
}

describe('aurora chat travel env runtime', () => {
  test('emits travel missing-fields advisory patch without handling when trigger is unsupported', async () => {
    const { runtime, deps } = buildHarness();
    const pushGateDecision = jest.fn(() => ({ mode: 'advisory' }));
    const enqueueGateAdvisory = jest.fn();

    const result = await runtime.maybeBuildTravelEnvEnvelope(buildCallArgs({
      ctx: {
        request_id: 'req_gate_1',
        trace_id: 'trace_gate_1',
        lang: 'EN',
        trigger_source: 'system',
      },
      plannerDecision: {
        next_step: 'ask',
        required_fields: ['travel_plan.destination', 'travel_plan.start_date'],
        can_answer_now: false,
      },
      pushGateDecision,
      enqueueGateAdvisory,
    }));

    expect(pushGateDecision).toHaveBeenCalledWith('travel_missing_fields_gate', {
      reason_codes: ['travel_plan_missing_fields'],
    });
    expect(enqueueGateAdvisory).toHaveBeenCalledWith(
      expect.objectContaining({
        gate_id: 'travel_missing_fields_gate',
        actions: ['refine_travel_context'],
      }),
    );
    expect(result.handled).toBe(false);
    expect(result.envelope).toBeNull();
    expect(result.policyMetaPatch).toEqual({ gate_type: 'soft' });
    expect(deps.logger.info).toHaveBeenCalled();
  });

  test('returns pipeline-backed env envelope with travel meta fields', async () => {
    const { runtime, deps } = buildHarness({
      runTravelPipeline: jest.fn(async () => ({
        ok: true,
        assistant_text: 'Pipeline travel advice',
        env_source: 'travel_skills',
        degraded: false,
        env_stress_patch: { epi: 41, tier: 'medium' },
        travel_readiness: {
          destination_context: { destination: 'Tokyo', start_date: '2026-03-01', end_date: '2026-03-05' },
          reco_bundle: [{ sku_id: 'sku_1' }],
          shopping_preview: { title: 'Tokyo picks' },
        },
        travel_skills_version: 'travel_skills_dag_v1',
        travel_skills_trace: ['llm', 'reco'],
        travel_kb_hit: true,
        travel_kb_write_queued: false,
        travel_skill_invocation_matrix: { llm_called: true, reco_called: true },
        travel_followup_state: { destination: 'Tokyo' },
        store_channel: true,
      })),
    });

    const result = await runtime.maybeBuildTravelEnvEnvelope(buildCallArgs({
      safetyDecision: { block_level: 'warn' },
    }));

    expect(deps.runTravelPipeline).toHaveBeenCalled();
    expect(deps.recordAuroraTravelEnvCardEmitted).toHaveBeenCalledWith({ turn: 'first_turn' });
    expect(result.handled).toBe(true);
    expect(result.policyMetaPatch).toEqual({
      env_source: 'travel_skills',
      degraded: false,
    });
    expect(result.envelope.assistant_message.content).toContain('Safety prefix');
    expect(result.envelope.assistant_message.content).toContain('Pipeline travel advice');
    expect(result.envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'env_stress',
      }),
    );
    expect(result.envelope.session_patch.meta).toEqual(
      expect.objectContaining({
        travel_skills_version: 'travel_skills_dag_v1',
        travel_kb_hit: true,
        travel_kb_write_queued: false,
        travel_followup: { destination: 'Tokyo' },
      }),
    );
    expect(result.envelope.meta).toEqual(
      expect.objectContaining({
        travel_skills_version: 'travel_skills_dag_v1',
        travel_kb_hit: true,
      }),
    );
    expect(result.envelope.suggested_chips.some((chip) => chip.chip_id === 'chip.travel.store_channel')).toBe(true);
  });

  test('falls back to local weather advice when pipeline returns ok=false', async () => {
    const { runtime, deps } = buildHarness({
      looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => true),
      runTravelPipeline: jest.fn(async () => ({
        ok: false,
        quality_reason: 'missing_context',
      })),
    });

    const result = await runtime.maybeBuildTravelEnvEnvelope(buildCallArgs({
      canonicalIntent: {
        intent: 'travel_planning',
        entities: {
          destination: 'Tokyo',
        },
      },
    }));

    expect(result.handled).toBe(true);
    expect(result.policyMetaPatch).toEqual({
      env_source: 'local_template',
      degraded: true,
    });
    expect(result.envelope.assistant_message.content).toBe('Local weather advice');
    expect(result.envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'env_stress',
      }),
    );
    expect(result.envelope.events).toEqual([
      expect.objectContaining({
        event_name: 'value_moment',
      }),
    ]);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_travel_1',
        trace_id: 'trace_travel_1',
        quality_reason: 'missing_context',
      }),
      'aurora bff: travel skills pipeline returned ok=false, fallback to local weather path',
    );
  });
});
