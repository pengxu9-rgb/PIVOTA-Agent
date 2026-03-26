const { createChatUpstreamRequestRuntime } = require('../src/auroraBff/chatUpstreamRequestRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: {
      warn: jest.fn(),
    },
    ingredientEntityMatchFromText: jest.fn(() => ({ entity_key: 'niacinamide' })),
    buildIngredientReportPayload: jest.fn(() => ({
      ingredient: {
        display_name: 'Niacinamide',
        inci: 'Niacinamide',
        category: 'vitamin',
      },
      verdict: {
        one_liner: 'Supports barrier function.',
        evidence_grade: 'A',
        irritation_risk: 'low',
      },
      benefits: [
        { concern: 'barrier', strength: 4, what_it_means: 'Supports barrier repair' },
      ],
      watchouts: [
        { issue: 'flushing', likelihood: 'low', what_to_do: 'Introduce slowly' },
      ],
      how_to_use: {
        frequency: 'daily',
        routine_step: 'serum',
      },
    })),
    buildSkinAnalysisContextForPrefix: jest.fn(() => 'SKIN_ANALYSIS_CONTEXT'),
    buildContextPrefix: jest.fn(() => 'PREFIX\n'),
    recordClarificationHistorySent: jest.fn(),
    AURORA_CHAT_RESUME_PREFIX_V2_ENABLED: false,
    AURORA_CHAT_RESUME_PREFIX_V1_ENABLED: false,
    recordResumePrefixInjected: jest.fn(),
    recordResumePrefixHistoryItems: jest.fn(),
    auroraChat: jest.fn(async () => ({
      answer: 'upstream answer',
      llm_provider: 'gemini',
      llm_model: 'gemini-3',
    })),
    AURORA_DECISION_BASE_URL: 'http://aurora.local',
    AURORA_CHAT_UPSTREAM_TIMEOUT_MS: 1234,
    recordUpstreamCall: jest.fn(),
    observeUpstreamLatency: jest.fn(),
    AURORA_CHAT_RESUME_PROBE_METRICS_ENABLED: false,
    classifyResumeResponseMode: jest.fn(() => 'direct_answer'),
    recordResumeResponseMode: jest.fn(),
    buildResumeKnownProfileFields: jest.fn(() => ['budget']),
    detectResumePlaintextReaskFields: jest.fn(() => []),
    recordResumePlaintextReaskDetected: jest.fn(),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatUpstreamRequestRuntime(deps),
  };
}

describe('aurora chat upstream request runtime', () => {
  test('builds context-rich upstream query with clarification history and ingredient hint', async () => {
    const { runtime, deps } = buildRuntime();

    const result = await runtime.requestUpstream({
      ctx: {
        lang: 'EN',
        state: 'S2_DIAGNOSIS',
        trigger_source: 'text',
      },
      profile: { skin_type: 'dry' },
      profileSummary: { skin_type: 'dry' },
      recentLogs: [{ concern: 'dryness' }],
      upstreamMessage: 'Tell me about niacinamide',
      agentState: 'IDLE',
      normalizedActionPayload: { action_id: 'chip.action.ask_ingredient' },
      clarificationId: 'clarify_1',
      clarificationHistoryForUpstream: [{ id: 'q1' }],
      allowRecoCards: true,
      llmProvider: 'gemini',
      llmModel: 'gemini-3',
    });

    expect(deps.recordClarificationHistorySent).toHaveBeenCalledWith({ count: 1 });
    expect(deps.buildContextPrefix).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { skin_type: 'dry' },
        lang: 'EN',
        state: 'S2_DIAGNOSIS',
        agent_state: 'IDLE',
        trigger_source: 'text',
        action_id: 'chip.action.ask_ingredient',
        clarification_id: 'clarify_1',
        clarification_history: [{ id: 'q1' }],
        ingredient_kb_context: expect.stringContaining('Niacinamide'),
        skin_analysis_context: 'SKIN_ANALYSIS_CONTEXT',
      }),
    );
    expect(deps.auroraChat).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://aurora.local',
        query: 'PREFIX\nTell me about niacinamide',
        timeoutMs: 1234,
        allow_recommendations: true,
        llm_provider: 'gemini',
        llm_model: 'gemini-3',
      }),
    );
    expect(result.answer).toBe('upstream answer');
    expect(result.llmRouteMetaForResponse).toEqual({
      llm_provider_requested: 'gemini',
      llm_model_requested: 'gemini-3',
      llm_provider_effective: 'gemini',
      llm_model_effective: 'gemini-3',
    });
  });

  test('injects resume context and records resume probe metrics', async () => {
    const { runtime, deps } = buildRuntime({
      AURORA_CHAT_RESUME_PREFIX_V2_ENABLED: true,
      AURORA_CHAT_RESUME_PROBE_METRICS_ENABLED: true,
      classifyResumeResponseMode: jest.fn(() => 'plaintext_reask'),
      detectResumePlaintextReaskFields: jest.fn(() => ['budget']),
    });

    await runtime.requestUpstream({
      ctx: { lang: 'EN', state: 'idle', trigger_source: 'text' },
      profileSummary: { budget: 'medium' },
      upstreamMessage: 'resume my previous plan',
      resumeContextForUpstream: {
        clarification_history: new Array(8).fill(null).map((_, index) => ({ id: `q${index}` })),
      },
    });

    expect(deps.recordResumePrefixInjected).toHaveBeenCalledWith({ enabled: true });
    expect(deps.recordResumePrefixHistoryItems).toHaveBeenCalledWith({ count: 6 });
    expect(deps.auroraChat).toHaveBeenCalledWith(
      expect.objectContaining({
        resume_context: expect.objectContaining({
          enabled: true,
          template_version: 'v2',
        }),
      }),
    );
    expect(deps.recordResumeResponseMode).toHaveBeenCalledWith({ mode: 'plaintext_reask' });
    expect(deps.recordResumePlaintextReaskDetected).toHaveBeenCalledWith({ field: 'budget' });
  });

  test('returns fallback answer and records upstream error when aurora call fails', async () => {
    const { runtime, deps } = buildRuntime({
      auroraChat: jest.fn(async () => {
        const err = new Error('timeout');
        err.code = 'ETIMEDOUT';
        throw err;
      }),
    });

    const result = await runtime.requestUpstream({
      ctx: { lang: 'CN', state: 'idle', trigger_source: 'text' },
      upstreamMessage: '给我建议',
      llmProvider: 'gemini',
      llmModel: 'gemini-3',
    });

    expect(deps.recordUpstreamCall).toHaveBeenCalledWith({ path: 'aurora_chat', status: 'error' });
    expect(deps.observeUpstreamLatency).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'aurora_chat', latencyMs: expect.any(Number) }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { err: 'timeout' },
      'aurora bff: aurora upstream failed',
    );
    expect(result.answer).toContain('Aurora 上游暂不可用');
    expect(result.llmRouteMetaForResponse).toEqual({
      llm_provider_requested: 'gemini',
      llm_model_requested: 'gemini-3',
      llm_provider_effective: null,
      llm_model_effective: null,
    });
  });
});
