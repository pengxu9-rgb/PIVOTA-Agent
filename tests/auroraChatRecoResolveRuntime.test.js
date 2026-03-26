const { createChatRecoResolveRuntime } = require('../src/auroraBff/chatRecoResolveRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    AURORA_PRODUCT_MATCHER_ENABLED: true,
    DIAG_PRODUCT_CATALOG_PATH: 'catalog/path.json',
    AURORA_BFF_CHAT_RECO_BUDGET_MS: 3200,
    withTimeout: jest.fn(async (promise) => promise),
    generateProductRecommendations: jest.fn(async () => ({
      norm: {
        payload: {
          recommendation_meta: {},
          metadata: {},
          recommendations: [],
        },
        field_missing: [],
      },
      upstreamDebug: { prompt_contract_ok: true },
      alternativesDebug: null,
      upstreamFailureCode: '',
      llmFailureClass: '',
      llmTrace: null,
    })),
    normalizeRecoFailureClass: jest.fn((value) => value || ''),
    classifyRecoUpstreamFailureCode: jest.fn(() => 'UPSTREAM_TIMEOUT'),
    isTransientRecoUpstreamFailureCode: jest.fn(() => false),
    recordAuroraRecoLlmCall: jest.fn(),
    applyIngredientRecoConstraint: jest.fn((payload) => ({
      constrained: false,
      payload,
      totalCount: 0,
      keptCount: 0,
      droppedCount: 0,
    })),
    mergeFieldMissing: jest.fn((existing, next) => [
      ...(Array.isArray(existing) ? existing : []),
      ...(Array.isArray(next) ? next : []),
    ]),
    ingredient_query_normalize: jest.fn((value) => String(value || '').trim().toLowerCase()),
    setImmediate: jest.fn((fn) => {
      fn();
      return { unref: jest.fn() };
    }),
    summarizeProfileForContext: jest.fn((profile) => ({
      summary_skin_type: profile && profile.skinType ? profile.skinType : null,
    })),
    buildIngredientPlan: jest.fn(({ artifact }) => ({
      plan_id: 'plan_1',
      derived_from: artifact && artifact.artifact_id ? artifact.artifact_id : 'artifact',
    })),
    buildProductRecommendationsBundle: jest.fn(() => ({
      source: 'artifact_matcher_v1',
      confidence: { score: 0.91 },
      recommendations: [{ sku_id: 'sku_matcher_1' }],
    })),
    toLegacyRecommendationsPayload: jest.fn(() => ({
      recommendation_meta: {},
      metadata: {},
      recommendations: [{ sku_id: 'sku_matcher_1' }],
    })),
    recordAuroraSkinFlowMetric: jest.fn(),
    chatRecoHandoffRuntime: {
      buildRecoTimeoutDegradedEnvelope: jest.fn(() => ({ kind: 'timeout_envelope' })),
    },
    chatRecoResponseRuntime: {
      finalizeRecoSuccess: jest.fn(() => ({ envelope: { kind: 'success_envelope' } })),
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRecoResolveRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    ctx: {
      request_id: 'req_reco_resolve_1',
      trace_id: 'trace_reco_resolve_1',
      lang: 'EN',
      trigger_source: 'text',
    },
    profile: { skinType: 'dry' },
    recentLogs: [{ id: 'log_1' }],
    message: 'recommend something',
    recoIngredientContext: null,
    includeAlternatives: true,
    debugUpstream: false,
    latestArtifact: {
      artifact_id: 'artifact_1',
      created_at: '2026-03-24T00:00:00.000Z',
      artifact_json: {
        overall_confidence: { score: 0.88 },
      },
    },
    mappedIngredientPlan: null,
    recoEntrySourceDetail: 'goal_driven',
    actionId: 'chip.start.reco_products',
    recoRequestMessage: 'recommend something',
    recoContextIngredientQuery: '',
    recoContextGoal: 'hydration',
    recoIngredientCandidates: [],
    recoProductCandidates: [],
    recoTaskMode: 'goal_based_products',
    identity: { auroraUid: 'aurora_1', userId: 'user_1' },
    artifactConfidenceLevel: 'high',
    artifactConfidenceScore: 0.88,
    artifactGateOk: true,
    lowConfidenceArtifact: false,
    refinementChips: [{ chip_id: 'refine_1' }],
    profileScore: 4,
    shouldAutoRerunRecommendationsFromProfilePatch: false,
    ingredientRecoOptInRequested: false,
    safetyWarnText: '',
    buildEnvelope: jest.fn((_ctx, payload) => payload),
    makeChatAssistantMessage: jest.fn((content) => ({ content })),
    makeEvent: jest.fn((_ctx, event_name, event_data) => ({ event_name, event_data })),
    ...overrides,
  };
}

describe('aurora chat reco resolve runtime', () => {
  test('uses matcher fallback when generated reco remains empty', async () => {
    const { runtime, deps } = buildRuntime();

    const out = await runtime.resolveRecoEnvelope(buildArgs());

    expect(out).toEqual({ kind: 'success_envelope' });
    expect(deps.chatRecoResponseRuntime.finalizeRecoSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        matcherFallbackUsed: true,
        recoSource: 'artifact_matcher_v1',
        norm: expect.objectContaining({
          payload: expect.objectContaining({
            intent: 'reco_products',
            source: 'artifact_matcher_v1',
            profile: { summary_skin_type: 'dry' },
          }),
        }),
      }),
    );
  });

  test('returns timeout degraded envelope on transient reco timeout', async () => {
    const timeoutError = new Error('timed out');
    timeoutError.code = 'AURORA_CHAT_RECO_BUDGET_TIMEOUT';
    const { runtime, deps } = buildRuntime({
      withTimeout: jest.fn(async () => {
        throw timeoutError;
      }),
      isTransientRecoUpstreamFailureCode: jest.fn(() => true),
    });

    const out = await runtime.resolveRecoEnvelope(buildArgs({
      latestArtifact: null,
    }));

    expect(out).toEqual({ kind: 'timeout_envelope' });
    expect(deps.recordAuroraRecoLlmCall).toHaveBeenCalledWith({
      stage: 'main',
      outcome: 'timeout',
    });
    expect(deps.chatRecoHandoffRuntime.buildRecoTimeoutDegradedEnvelope).toHaveBeenCalled();
    expect(deps.chatRecoResponseRuntime.finalizeRecoSuccess).not.toHaveBeenCalled();
  });

  test('normalizes ingredient no-candidate reco payload before finalize success', async () => {
    const { runtime, deps } = buildRuntime({
      generateProductRecommendations: jest.fn(async () => ({
        norm: {
          payload: {
            recommendation_meta: {},
            metadata: {},
            recommendations: [{ sku_id: 'sku_should_be_removed' }],
            evidence: {
              science: {
                key_ingredients: ['Niacinamide', 'Zinc PCA'],
              },
            },
          },
          field_missing: [],
        },
        upstreamDebug: null,
        alternativesDebug: null,
        upstreamFailureCode: '',
        llmFailureClass: '',
        llmTrace: null,
      })),
    });

    const out = await runtime.resolveRecoEnvelope(buildArgs({
      latestArtifact: null,
      ingredientRecoOptInRequested: true,
      recoTaskMode: 'ingredient_lookup_no_candidates',
      recoContextIngredientQuery: 'niacinamide',
      recoIngredientCandidates: ['niacinamide'],
      recoProductCandidates: [{ sku_id: 'sku_1' }, { sku_id: 'sku_2' }],
    }));

    expect(out).toEqual({ kind: 'success_envelope' });
    expect(deps.chatRecoResponseRuntime.finalizeRecoSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        norm: expect.objectContaining({
          payload: expect.objectContaining({
            recommendations: [],
            products_empty_reason: 'ingredient_constraint_no_match',
            task_mode: 'ingredient_lookup_no_candidates',
            ingredient_evidence: expect.objectContaining({
              query: 'niacinamide',
              product_candidates_count: 2,
            }),
            evidence: {
              science: {
                key_ingredients: ['Niacinamide'],
              },
            },
          }),
          field_missing: expect.arrayContaining([
            expect.objectContaining({
              field: 'payload.recommendations',
              reason: 'ingredient_constraint_no_match',
            }),
            expect.objectContaining({
              field: 'payload.recommendations',
              reason: 'ingredient_no_verified_candidates',
            }),
          ]),
        }),
      }),
    );
  });
});
