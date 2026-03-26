const { createChatRecoResponseRuntime } = require('../src/auroraBff/chatRecoResponseRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    pickFirstTrimmed: (...values) => {
      for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
      return '';
    },
    stateChangeAllowed: jest.fn(() => true),
    applyRecoWarningVisibilityContract: jest.fn((payload) => ({ payload: { ...payload, warning_contract_applied: true } })),
    RECO_MAIN_PROMPT_TEMPLATE_ID: 'reco.main.v1',
    buildRecoLlmTraceRef: jest.fn((trace) => (trace ? `trace:${trace.trace_id || 'unknown'}` : null)),
    buildRouteAwareAssistantText: jest.fn(({ payload }) => {
      const count = Array.isArray(payload && payload.recommendations) ? payload.recommendations.length : 0;
      return count ? `Structured reco (${count})` : '';
    }),
    addEmotionalPreambleToAssistantText: jest.fn((text) => text),
    stripInternalRefsDeep: jest.fn((payload) => ({ ...payload, stripped: true })),
    buildIngredientPlanCard: jest.fn((plan, requestId) => ({
      card_id: `plan_${requestId}`,
      type: 'ingredient_plan',
      payload: plan,
    })),
    appendLatestArtifactToSessionPatch: jest.fn((patch, artifactId) => {
      if (artifactId) patch.latest_artifact_id = artifactId;
    }),
    appendLatestRecoContextToSessionPatch: jest.fn((patch, context) => {
      patch.latest_reco_context = context;
    }),
    deriveRecoEmptyReason: jest.fn(() => null),
    recordAuroraRecoKbWrite: jest.fn(),
    saveRecoRun: jest.fn(() => Promise.resolve()),
    recordAuroraSkinFlowMetric: jest.fn(),
    normalizeRecoSourceDetail: jest.fn((value) => String(value || '').trim().toLowerCase() || null),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRecoResponseRuntime(deps),
  };
}

function buildBaseArgs(overrides = {}) {
  return {
    ctx: { request_id: 'req_reco_1', trace_id: 'trace_reco_1', trigger_source: 'text', lang: 'EN' },
    norm: {
      payload: {
        source: '',
        recommendation_meta: {},
        metadata: {},
      },
      field_missing: [],
    },
    debugUpstream: false,
    upstreamDebug: null,
    alternativesDebug: null,
    recoLlmTrace: { trace_id: 'llm_trace_1' },
    llmFailureClass: '',
    llmPrimaryUsed: false,
    matcherFallbackUsed: false,
    generatedPrimaryUsed: false,
    generatedSourceMode: '',
    generatedPayloadSource: '',
    recoSource: 'rules_only',
    recoTaskMode: 'goal_based_products',
    profile: { skinType: 'dry' },
    recentLogs: [],
    latestArtifact: { artifact_id: 'artifact_1' },
    mappedIngredientPlan: null,
    matcherBundle: null,
    identity: { auroraUid: 'aurora_1', userId: 'user_1' },
    artifactConfidenceLevel: 'high',
    artifactConfidenceScore: 0.91,
    artifactGateOk: true,
    recoEntrySourceDetail: 'goal_driven',
    actionId: 'chip.reco',
    recoRequestMessage: 'recommend something',
    includeAlternatives: true,
    recoContextIngredientQuery: '',
    recoContextGoal: 'hydration',
    recoIngredientCandidates: [],
    recoProductCandidates: [],
    recoIngredientContext: null,
    lowConfidenceArtifact: false,
    refinementChips: [{ chip_id: 'refine_1' }],
    profileScore: 4,
    shouldAutoRerunRecommendationsFromProfilePatch: false,
    safetyWarnText: '',
    buildEnvelope: jest.fn((_ctx, payload) => payload),
    makeChatAssistantMessage: jest.fn((content) => ({ content })),
    makeEvent: jest.fn((_ctx, event_name, event_data) => ({ event_name, event_data })),
    ...overrides,
  };
}

describe('aurora chat reco response runtime', () => {
  test('finalizeRecoSuccess promotes plan-only fallback into recommendations envelope', () => {
    const { runtime, deps } = buildRuntime({
      deriveRecoEmptyReason: jest.fn(() => null),
    });

    const out = runtime.finalizeRecoSuccess(buildBaseArgs({
      norm: {
        payload: {
          source: '',
          recommendation_meta: {},
          metadata: {},
          plan_only_recommendations: [{ sku_id: 'sku_plan_1' }],
          products_empty_reason: 'strict_filter_fallback_only',
        },
        field_missing: [{ field: 'payload.recommendations', reason: 'strict_filter_fallback_only' }],
      },
    }));

    expect(out.hasRecs).toBe(true);
    expect(out.envelope.cards[0]).toEqual({
      card_id: 'reco_req_reco_1',
      type: 'recommendations',
      payload: expect.objectContaining({
        recommendations: [{ sku_id: 'sku_plan_1' }],
        grounding_status: 'plan_only',
        mainline_status: 'plan_only_fallback',
        stripped: true,
      }),
      field_missing: [{ field: 'payload.recommendations', reason: 'strict_filter_fallback_only' }],
    });
    expect(out.envelope.session_patch).toEqual({
      next_state: 'S7_PRODUCT_RECO',
      latest_artifact_id: 'artifact_1',
      latest_reco_context: expect.objectContaining({
        source_detail: 'goal_driven',
        include_alternatives: true,
      }),
    });
    expect(deps.recordAuroraSkinFlowMetric).toHaveBeenCalledWith({
      stage: 'reco_plan_only_fallback',
      hit: true,
    });
    expect(deps.recordAuroraSkinFlowMetric).toHaveBeenCalledWith({
      stage: 'reco_generated',
      hit: true,
    });
  });

  test('finalizeRecoSuccess quarantines unusable llm-primary output before persistence', () => {
    const { runtime, deps } = buildRuntime();

    const out = runtime.finalizeRecoSuccess(buildBaseArgs({
      llmPrimaryUsed: true,
      recoSource: 'llm_primary_v1',
      norm: {
        payload: {
          recommendation_meta: {},
          metadata: {},
          recommendations: [
            {
              sku: {},
              brand: '',
              name: '',
            },
          ],
        },
        field_missing: [],
      },
    }));

    expect(deps.saveRecoRun).toHaveBeenCalledWith(expect.objectContaining({
      requestContext: expect.objectContaining({
        source: 'llm_primary_v1',
        kb_backfill_attempted: true,
        kb_quarantined: true,
        kb_quarantine_reasons: ['llm_reco_quality_gate_failed'],
      }),
      reco: expect.objectContaining({
        source: 'llm_primary_v1',
      }),
    }));
    expect(out.payload.metadata).toEqual(expect.objectContaining({
      kb_write_status: 'attempted',
      kb_quarantine_reasons: ['llm_reco_quality_gate_failed'],
      llm_trace_ref: 'trace:llm_trace_1',
    }));
    expect(deps.recordAuroraRecoKbWrite).toHaveBeenCalledWith({
      source: 'llm_primary',
      outcome: 'attempted',
    });
  });

  test('finalizeRecoSuccess persists matcher fallback bundle and keeps debug cards', () => {
    const { runtime, deps } = buildRuntime();
    const matcherBundle = {
      source: 'artifact_matcher_v1',
      confidence: { score: 0.88 },
      recommendations: [{ sku_id: 'sku_matcher_1' }],
    };

    const out = runtime.finalizeRecoSuccess(buildBaseArgs({
      debugUpstream: true,
      upstreamDebug: { prompt_contract_ok: true },
      alternativesDebug: [{ sku_id: 'sku_alt_1' }],
      matcherFallbackUsed: true,
      matcherBundle,
      recoSource: 'artifact_matcher_v1',
      norm: {
        payload: {
          recommendation_meta: {},
          metadata: {},
          recommendations: [{ sku_id: 'sku_matcher_1' }],
        },
        field_missing: [],
      },
    }));

    expect(deps.saveRecoRun).toHaveBeenCalledWith(expect.objectContaining({
      requestContext: expect.objectContaining({
        source: 'artifact_matcher_v1',
      }),
      reco: matcherBundle,
      overallConfidence: 0.88,
    }));
    expect(out.envelope.cards.map((card) => card.type)).toEqual([
      'recommendations',
      'aurora_debug',
      'aurora_alt_debug',
    ]);
    expect(deps.recordAuroraRecoKbWrite).toHaveBeenCalledWith({
      source: 'artifact_matcher',
      outcome: 'attempted',
    });
  });
});
