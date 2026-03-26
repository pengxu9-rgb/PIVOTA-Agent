function defaultIsPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function createChatRecoResolveRuntime(options = {}) {
  const {
    logger = null,
    isPlainObject = defaultIsPlainObject,
    AURORA_PRODUCT_MATCHER_ENABLED = false,
    DIAG_PRODUCT_CATALOG_PATH = '',
    AURORA_BFF_CHAT_RECO_BUDGET_MS = 0,
    withTimeout,
    generateProductRecommendations,
    normalizeRecoFailureClass = () => '',
    classifyRecoUpstreamFailureCode = () => '',
    isTransientRecoUpstreamFailureCode = () => false,
    recordAuroraRecoLlmCall = () => {},
    applyIngredientRecoConstraint = (payload) => ({
      constrained: false,
      payload,
      totalCount: 0,
      keptCount: 0,
      droppedCount: 0,
    }),
    mergeFieldMissing = (existing, next) => [
      ...(Array.isArray(existing) ? existing : []),
      ...(Array.isArray(next) ? next : []),
    ],
    ingredient_query_normalize = (value) => String(value || '').trim().toLowerCase(),
    setImmediate: scheduleImmediate = setImmediate,
    summarizeProfileForContext = () => ({}),
    buildIngredientPlan,
    buildProductRecommendationsBundle,
    toLegacyRecommendationsPayload,
    recordAuroraSkinFlowMetric = () => {},
    chatRecoHandoffRuntime,
    chatRecoResponseRuntime,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat reco resolve runtime missing dependency: ${name}`);
  }

  async function resolveRecoEnvelope({
    ctx,
    profile = null,
    recentLogs = [],
    message = '',
    recoIngredientContext = null,
    includeAlternatives = false,
    debugUpstream = false,
    latestArtifact = null,
    mappedIngredientPlan = null,
    recoEntrySourceDetail = '',
    actionId = '',
    recoRequestMessage = '',
    recoContextIngredientQuery = '',
    recoContextGoal = '',
    recoIngredientCandidates = [],
    recoProductCandidates = [],
    recoTaskMode = '',
    identity = {},
    artifactConfidenceLevel = 'unknown',
    artifactConfidenceScore = null,
    artifactGateOk = true,
    lowConfidenceArtifact = false,
    refinementChips = [],
    profileScore = 0,
    shouldAutoRerunRecommendationsFromProfilePatch = false,
    ingredientRecoOptInRequested = false,
    safetyWarnText = '',
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  } = {}) {
    const withTimeoutFn = requireFunction('withTimeout', withTimeout);
    const generateProductRecommendationsFn = requireFunction(
      'generateProductRecommendations',
      generateProductRecommendations,
    );
    const buildIngredientPlanFn = requireFunction('buildIngredientPlan', buildIngredientPlan);
    const buildProductRecommendationsBundleFn = requireFunction(
      'buildProductRecommendationsBundle',
      buildProductRecommendationsBundle,
    );
    const toLegacyRecommendationsPayloadFn = requireFunction(
      'toLegacyRecommendationsPayload',
      toLegacyRecommendationsPayload,
    );
    if (!chatRecoHandoffRuntime || typeof chatRecoHandoffRuntime.buildRecoTimeoutDegradedEnvelope !== 'function') {
      throw new Error('aurora chat reco resolve runtime missing dependency: chatRecoHandoffRuntime');
    }
    if (!chatRecoResponseRuntime || typeof chatRecoResponseRuntime.finalizeRecoSuccess !== 'function') {
      throw new Error('aurora chat reco resolve runtime missing dependency: chatRecoResponseRuntime');
    }

    let matcherBundle = null;
    let matcherPayload = null;
    let matcherComputed = false;
    const computeMatcherIfNeeded = () => {
      if (matcherComputed) {
        return { matcherBundle, matcherPayload, mappedIngredientPlan };
      }
      matcherComputed = true;
      if (!(AURORA_PRODUCT_MATCHER_ENABLED && latestArtifact)) {
        return { matcherBundle, matcherPayload, mappedIngredientPlan };
      }
      try {
        const artifactPayload = latestArtifact.artifact_json && typeof latestArtifact.artifact_json === 'object'
          ? {
              ...latestArtifact.artifact_json,
              artifact_id: latestArtifact.artifact_id,
              created_at: latestArtifact.created_at || latestArtifact.artifact_json.created_at,
            }
          : latestArtifact;
        const planForMatcher =
          mappedIngredientPlan ||
          buildIngredientPlanFn({ artifact: artifactPayload, profile: profile || {} });
        if (!mappedIngredientPlan) mappedIngredientPlan = planForMatcher;

        matcherBundle = buildProductRecommendationsBundleFn({
          ingredientPlan: planForMatcher,
          artifact: artifactPayload,
          profile,
          language: ctx && ctx.lang,
          disallowTreatment: false,
          catalogPath: DIAG_PRODUCT_CATALOG_PATH,
        });
        matcherPayload = toLegacyRecommendationsPayloadFn(matcherBundle, { language: ctx && ctx.lang });
      } catch (err) {
        logger?.warn?.(
          { err: err && err.message ? err.message : String(err), request_id: ctx && ctx.request_id },
          'aurora bff: product matcher failed',
        );
      }
      return { matcherBundle, matcherPayload, mappedIngredientPlan };
    };

    let norm = null;
    let upstreamDebug = null;
    let alternativesDebug = null;
    let matcherFallbackUsed = false;
    let recoTimeoutDegraded = false;
    let upstreamFailureCode = '';
    let llmFailureClass = '';
    let recoLlmTrace = null;

    if (!matcherPayload || !Array.isArray(matcherPayload.recommendations) || matcherPayload.recommendations.length === 0) {
      try {
        const upstreamReco = await withTimeoutFn(
          generateProductRecommendationsFn({
            ctx,
            profile,
            recentLogs,
            message,
            ingredientContext: recoIngredientContext,
            includeAlternatives,
            debug: debugUpstream,
            logger,
          }),
          AURORA_BFF_CHAT_RECO_BUDGET_MS,
          'AURORA_CHAT_RECO_BUDGET_TIMEOUT',
        );
        norm = upstreamReco.norm;
        upstreamDebug = upstreamReco.upstreamDebug;
        alternativesDebug = upstreamReco.alternativesDebug;
        upstreamFailureCode = String(upstreamReco.upstreamFailureCode || '').trim().toUpperCase();
        llmFailureClass = normalizeRecoFailureClass(upstreamReco.llmFailureClass || '');
        recoLlmTrace = isPlainObject(upstreamReco.llmTrace) ? upstreamReco.llmTrace : null;
      } catch (err) {
        const transientCode = classifyRecoUpstreamFailureCode(err);
        if (!(err && err.code === 'AURORA_CHAT_RECO_BUDGET_TIMEOUT') && !isTransientRecoUpstreamFailureCode(transientCode)) {
          throw err;
        }
        recoTimeoutDegraded = true;
        llmFailureClass = 'timeout';
        recordAuroraRecoLlmCall({ stage: 'main', outcome: 'timeout' });
        logger?.warn?.(
          {
            request_id: ctx && ctx.request_id,
            trace_id: ctx && ctx.trace_id,
            budget_ms: AURORA_BFF_CHAT_RECO_BUDGET_MS,
            transient_code: transientCode || null,
          },
          'aurora bff: reco upstream timeout/transient failure, degraded to confidence_notice',
        );
      }
    }

    if (!recoLlmTrace && isPlainObject(norm?.payload?.recommendation_meta?.llm_trace)) {
      recoLlmTrace = norm.payload.recommendation_meta.llm_trace;
    }

    let recoSource = '';
    let llmPrimaryUsed = false;
    const generatedRecoCount = Array.isArray(norm?.payload?.recommendations) ? norm.payload.recommendations.length : 0;
    const generatedPayloadSource = String(norm?.payload?.source || '').trim().toLowerCase();
    const generatedSourceMode = String(norm?.payload?.recommendation_meta?.source_mode || '').trim().toLowerCase();
    const generatedPrimaryUsed =
      generatedRecoCount > 0 &&
      ['llm_primary', 'catalog_grounded', 'catalog_transient_fallback'].includes(generatedSourceMode);

    llmPrimaryUsed =
      generatedPrimaryUsed &&
      (generatedSourceMode === 'llm_primary' || generatedPayloadSource.includes('llm_primary'));
    if (llmPrimaryUsed) {
      recoSource = 'llm_primary_v1';
    } else if (generatedPrimaryUsed) {
      recoSource = generatedPayloadSource || generatedSourceMode || 'catalog_grounded_v1';
    } else if (generatedRecoCount > 0) {
      recoSource = generatedPayloadSource || 'rules_only';
    }

    let matcherRecoCount = 0;
    if (!generatedPrimaryUsed && !ingredientRecoOptInRequested) {
      ({ matcherBundle, matcherPayload, mappedIngredientPlan } = computeMatcherIfNeeded());
      matcherRecoCount = Array.isArray(matcherPayload?.recommendations) ? matcherPayload.recommendations.length : 0;
    }
    if (!generatedPrimaryUsed && !ingredientRecoOptInRequested && matcherRecoCount > 0) {
      norm = {
        payload: {
          ...matcherPayload,
          intent: 'reco_products',
          profile: summarizeProfileForContext(profile),
          source: 'artifact_matcher_v1',
        },
        field_missing: [],
      };
      matcherFallbackUsed = true;
      recoSource = 'artifact_matcher_v1';
      recoTimeoutDegraded = false;
    }

    if (ingredientRecoOptInRequested && isPlainObject(norm?.payload)) {
      const constrained = applyIngredientRecoConstraint(norm.payload, recoIngredientContext);
      if (constrained.constrained) {
        norm.payload = constrained.payload;
      }
      norm.payload = {
        ...norm.payload,
        constraint_match_summary: {
          total: Number(constrained.totalCount || 0),
          matched: Number(constrained.keptCount || 0),
          dropped: Number(constrained.droppedCount || 0),
        },
      };
      if (constrained.droppedCount > 0) {
        norm.field_missing = mergeFieldMissing(norm.field_missing, [
          { field: 'payload.recommendations', reason: 'ingredient_constraint_filtered' },
        ]);
      }
      if (constrained.keptCount === 0) {
        norm.payload = {
          ...norm.payload,
          products_empty_reason: 'ingredient_constraint_no_match',
        };
        norm.field_missing = mergeFieldMissing(norm.field_missing, [
          { field: 'payload.recommendations', reason: 'ingredient_constraint_no_match' },
        ]);
      }
    }

    if (recoTaskMode === 'ingredient_lookup_no_candidates' && isPlainObject(norm?.payload)) {
      norm.payload = {
        ...norm.payload,
        recommendations: [],
        products_empty_reason: norm.payload.products_empty_reason || 'ingredient_no_verified_candidates',
        recommendation_confidence_score: 0,
        recommendation_confidence_level: 'low',
        task_mode: recoTaskMode,
        empty_match_actions: [
          {
            action_id: 'broaden_to_goal',
            label: ctx && ctx.lang === 'CN' ? '扩展到目标推荐' : 'Broaden to goal-based products',
          },
          {
            action_id: 'check_product_inci',
            label: ctx && ctx.lang === 'CN' ? '查看某产品INCI表' : 'Check a product INCI',
          },
          {
            action_id: 'search_category',
            label: ctx && ctx.lang === 'CN' ? '按品类搜索' : 'Search within a category',
          },
        ],
      };
      norm.field_missing = mergeFieldMissing(norm.field_missing, [
        { field: 'payload.recommendations', reason: 'ingredient_no_verified_candidates' },
      ]);
    }

    if (String(recoTaskMode || '').startsWith('ingredient_') && isPlainObject(norm?.payload)) {
      const ingredientQueryForFilter = ingredient_query_normalize(recoContextIngredientQuery || '');
      if (ingredientQueryForFilter && isPlainObject(norm.payload.evidence) && isPlainObject(norm.payload.evidence.science)) {
        const rawKeyIngredients = Array.isArray(norm.payload.evidence.science.key_ingredients)
          ? norm.payload.evidence.science.key_ingredients
          : [];
        const filteredKeyIngredients = rawKeyIngredients.filter((item) => {
          const lower = String(item || '').trim().toLowerCase();
          return lower.includes(ingredientQueryForFilter) || ingredientQueryForFilter.includes(lower);
        });
        norm.payload.evidence.science.key_ingredients = filteredKeyIngredients;
      }
      norm.payload.ingredient_evidence = {
        query: recoContextIngredientQuery || '',
        task_mode: recoTaskMode,
        ingredient_candidates: recoIngredientCandidates,
        product_candidates_count: recoProductCandidates.length,
      };
    }

    if (llmPrimaryUsed && isPlainObject(norm?.payload)) {
      norm.payload = {
        ...norm.payload,
        metadata: {
          ...(isPlainObject(norm.payload.metadata) ? norm.payload.metadata : {}),
          matcher_check_result: {
            source: 'artifact_matcher_v1',
            pending: true,
            available: false,
            recommendation_count: 0,
            confidence: null,
          },
        },
      };
      if (AURORA_PRODUCT_MATCHER_ENABLED && latestArtifact) {
        const matcherHandle = scheduleImmediate(() => {
          const { matcherBundle: asyncMatcherBundle, matcherPayload: asyncMatcherPayload } = computeMatcherIfNeeded();
          const asyncRecoCount = Array.isArray(asyncMatcherPayload?.recommendations)
            ? asyncMatcherPayload.recommendations.length
            : 0;
          const asyncMatcherConfidence =
            asyncMatcherBundle &&
            asyncMatcherBundle.confidence &&
            Number.isFinite(Number(asyncMatcherBundle.confidence.score))
              ? Number(asyncMatcherBundle.confidence.score)
              : null;
          logger?.info?.(
            {
              request_id: ctx && ctx.request_id,
              trace_id: ctx && ctx.trace_id,
              recommendation_count: asyncRecoCount,
              confidence: asyncMatcherConfidence,
            },
            'aurora bff: matcher check finished asynchronously',
          );
        });
        if (matcherHandle && typeof matcherHandle.unref === 'function') matcherHandle.unref();
      }
    }

    let hasRecs = Array.isArray(norm?.payload?.recommendations) ? norm.payload.recommendations.length > 0 : false;
    if (
      !hasRecs &&
      isPlainObject(norm?.payload) &&
      Array.isArray(norm.payload.plan_only_recommendations) &&
      norm.payload.plan_only_recommendations.length > 0 &&
      String(norm.payload.products_empty_reason || '').trim() === 'strict_filter_fallback_only'
    ) {
      norm.payload.recommendations = norm.payload.plan_only_recommendations;
      norm.payload.grounding_status = 'plan_only';
      norm.payload.mainline_status = 'plan_only_fallback';
      hasRecs = true;
      recordAuroraSkinFlowMetric({ stage: 'reco_plan_only_fallback', hit: true });
      logger?.info?.(
        { request_id: ctx && ctx.request_id, plan_count: norm.payload.recommendations.length },
        'aurora bff: strict filter cleared grounded recs, falling back to plan_only recommendations',
      );
    }

    if (!hasRecs && isTransientRecoUpstreamFailureCode(upstreamFailureCode)) {
      recoTimeoutDegraded = true;
    }

    if (recoTimeoutDegraded) {
      logger?.info?.({ kind: 'metric', name: 'aurora.skin.reco.timeout_degraded_rate', value: 1 }, 'metric');
      recordAuroraSkinFlowMetric({ stage: 'reco_timeout_degraded', hit: true });
      return chatRecoHandoffRuntime.buildRecoTimeoutDegradedEnvelope({
        ctx,
        latestArtifactId: latestArtifact && latestArtifact.artifact_id,
        recoEntrySourceDetail,
        triggerSource: ctx && ctx.trigger_source,
        actionId,
        message: recoRequestMessage,
        includeAlternatives,
        ingredientQuery: recoContextIngredientQuery || '',
        goal: recoContextGoal || '',
        mappedIngredientPlan,
        refinementChips,
        recoLlmTrace,
        upstreamFailureCode,
        shouldAutoRerunRecommendationsFromProfilePatch,
        buildEnvelope,
        makeChatAssistantMessage,
        makeEvent,
      });
    }

    const envelope = chatRecoResponseRuntime.finalizeRecoSuccess({
      ctx,
      norm,
      debugUpstream,
      upstreamDebug,
      alternativesDebug,
      recoLlmTrace,
      llmFailureClass,
      llmPrimaryUsed,
      matcherFallbackUsed,
      generatedPrimaryUsed,
      generatedSourceMode,
      generatedPayloadSource,
      recoSource,
      recoTaskMode,
      profile,
      recentLogs,
      latestArtifact,
      mappedIngredientPlan,
      matcherBundle,
      identity,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      artifactGateOk,
      recoEntrySourceDetail,
      actionId,
      recoRequestMessage,
      includeAlternatives,
      recoContextIngredientQuery,
      recoContextGoal,
      recoIngredientCandidates,
      recoProductCandidates,
      recoIngredientContext,
      lowConfidenceArtifact,
      refinementChips,
      profileScore,
      shouldAutoRerunRecommendationsFromProfilePatch,
      safetyWarnText,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });
    return envelope.envelope;
  }

  return {
    resolveRecoEnvelope,
  };
}

module.exports = {
  createChatRecoResolveRuntime,
};
