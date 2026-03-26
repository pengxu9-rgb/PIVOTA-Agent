const {
  createProductIntelGuardrailRuntime,
} = require('../src/auroraBff/productIntelGuardrailRuntime');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function buildRuntime(overrides = {}) {
  const deps = {
    isPlainObject,
    pickFirstString,
    resolveQaMode: jest.fn((value) => String(value || 'single').trim().toLowerCase() || 'single'),
    resolveQaSingleProvider: jest.fn((value) => String(value || 'gemini').trim().toLowerCase() || 'gemini'),
    applyPhotoClaimConsistency: jest.fn((cards) => cards),
    sanitizeRecoCandidatesForUi: jest.fn(async (cards) => ({
      cards,
      dropped: 1,
      externalized: 0,
      rejected: [{ product_id: 'p_guardrail_1' }],
      lookup_meta: {
        llm_fallback_used: true,
        llm_fallback_attempted: 2,
        llm_fallback_recovered: 1,
        llm_fallback_last_reason: 'timeout',
        llm_fallback_stage_counts: {
          timeout: 1,
          invalid_json: 0,
          error: 0,
          empty: 0,
        },
      },
    })),
    applyAnalysisStoryAndRoutineSoftGate: jest.fn(async (cards) => cards),
    initLlmFallbackStageCounts: jest.fn(() => ({
      timeout: 0,
      invalid_json: 0,
      error: 0,
      empty: 0,
    })),
    buildPurchasableFallbackCandidates: jest.fn(),
    makeEvent: jest.fn((ctx, event_name, event_data) => ({
      event_name,
      event_data,
      request_id: ctx && ctx.request_id ? ctx.request_id : null,
    })),
    AURORA_LLM_QA_MIN_REMAINING_BUDGET_MS: 180,
    AURORA_LLM_QA_MODE: 'single',
    AURORA_LLM_SINGLE_PROVIDER: 'gemini',
    AURORA_LLM_OPENAI_FALLBACK_ENABLED: false,
    AURORA_PRODUCT_RELEVANCE_QA_MODE: 'single',
    AURORA_PRODUCT_STRICT_SKINCARE_FILTER: true,
    AURORA_PURCHASABLE_FALLBACK_ENABLED: true,
    AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED: true,
    AURORA_PRODUCT_LOOKUP_LLM_FALLBACK_ENABLED: true,
    SKIN_VISION_MODEL_GEMINI: 'gemini-vision-test',
    SKIN_VISION_MODEL_OPENAI: 'openai-vision-test',
    ANALYSIS_STORY_MODEL_OPENAI: 'analysis-story-openai',
    ANALYSIS_STORY_MODEL_GEMINI: 'analysis-story-gemini',
    ...overrides,
  };

  return {
    deps,
    runtime: createProductIntelGuardrailRuntime(deps),
  };
}

describe('createProductIntelGuardrailRuntime', () => {
  test('applies guardrail enrichment and annotates analysis meta', async () => {
    const { runtime, deps } = buildRuntime();

    const out = await runtime.applyProductIntelGuardrailsToEnvelope({
      envelope: {
        cards: [
          {
            type: 'analysis_summary',
            payload: {
              analysis_source: 'gemini_mainline',
            },
          },
          {
            type: 'recommendations',
            payload: {
              recommendations: [{ product_id: 'p1' }],
            },
          },
        ],
        analysis_meta: {},
      },
      ctx: { request_id: 'req_guardrail_meta', trace_id: 'trace_guardrail_meta' },
      profile: { skinType: 'dry' },
      language: 'EN',
      qaRuntime: {
        budget_ms: 1200,
        started_at_ms: 100,
      },
    });

    expect(deps.applyPhotoClaimConsistency).toHaveBeenCalled();
    expect(deps.sanitizeRecoCandidatesForUi).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        allowExternalSeedSupplement: true,
        fallbackCandidateBuilder: deps.buildPurchasableFallbackCandidates,
        externalSeedStrategy: 'supplement_internal_first',
      }),
    );
    expect(deps.applyAnalysisStoryAndRoutineSoftGate).toHaveBeenCalled();
    expect(out.dropped).toBe(1);
    expect(out.rejected).toEqual([{ product_id: 'p_guardrail_1' }]);
    expect(out.envelope.analysis_meta).toEqual(
      expect.objectContaining({
        qa_mode: 'single',
        qa_provider: 'gemini',
        diag_provider: 'gemini',
        diag_model: 'gemini-vision-test',
        story_model: 'analysis-story-gemini',
        product_lookup_mode: 'catalog_then_llm_fallback',
        product_lookup_fallback_used: true,
        product_lookup_fallback_attempted: 2,
        product_lookup_fallback_recovered: 1,
        product_lookup_fallback_timeout: 1,
        product_lookup_fallback_last_reason: 'timeout',
        invalid_url_drop_rate: 0,
      }),
    );
  });

  test('fails open with telemetry event when guardrail throws', async () => {
    const logger = { warn: jest.fn() };
    const { runtime, deps } = buildRuntime({
      makeEvent: jest.fn((ctx, event_name, event_data) => ({
        event_name,
        event_data,
        trace_id: ctx && ctx.trace_id ? ctx.trace_id : null,
      })),
    });

    const out = await runtime.safelyApplyProductIntelGuardrailsToEnvelope({
      envelope: {
        assistant_message: { content: 'hello' },
        cards: [],
        events: [],
      },
      ctx: {
        request_id: 'req_guardrail_fail',
        trace_id: 'trace_guardrail_fail',
      },
      language: 'EN',
      logger,
      applyFn: async () => {
        const err = new Error('boom');
        err.code = 'GUARDRAIL_TEST_THROW';
        throw err;
      },
    });

    expect(out.failed).toBe(true);
    expect(out.error_code).toBe('GUARDRAIL_TEST_THROW');
    expect(out.envelope.events).toEqual([
      expect.objectContaining({
        event_name: 'product_intel_guardrail_failed',
        event_data: { code: 'GUARDRAIL_TEST_THROW' },
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_guardrail_fail',
        trace_id: 'trace_guardrail_fail',
        error_code: 'GUARDRAIL_TEST_THROW',
      }),
      'aurora bff: product-intel guardrail runtime failure',
    );
    expect(deps.makeEvent).toHaveBeenCalled();
  });
});
