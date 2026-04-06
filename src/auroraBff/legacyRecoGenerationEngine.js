const {
  createLegacyRecoGenerationDebugRuntime,
} = require('./legacyRecoGenerationDebug');
const {
  createLegacyRecoRecommendationPostFiltersRuntime,
} = require('./legacyRecoRecommendationPostFilters');
const {
  createLegacyRecoGenerationResultRuntime,
} = require('./legacyRecoGenerationResult');
const {
  createLegacyRecoPdpEnrichmentRuntime,
} = require('./legacyRecoPdpEnrichment');
const {
  createLegacyRecoFrameworkPassRuntime,
} = require('./legacyRecoFrameworkPass');
const {
  createLegacyRecoMainlineExecutionRuntime,
} = require('./legacyRecoMainlineExecution');
const {
  createLegacyRecoPostMainlineRuntime,
} = require('./legacyRecoPostMainline');
const {
  createLegacyRecoGenerationContextRuntime,
} = require('./legacyRecoGenerationContext');

function createLegacyRecoGenerationEngineRuntime(deps = {}) {
  const {
    pickFirstTrimmed,
    pickFirstString,
    isPlainObject,
    asStringArray,
    uniqCaseInsensitiveStrings,
    summarizeProfileForContext,
    normalizeIngredientRecoContextValue,
    buildAnalysisContextSnapshotForRoute,
    buildTaskAnalysisContextForPrefix,
    buildAnalysisContextPromptBlock,
    buildContextPrefix,
    resolveRecommendationTargetContext,
    runConcernSemanticPlanner,
    buildConcernTargetContextFromSemanticPlan,
    normalizeRecoEffectiveFailureClass,
    normalizeRecoFailureClass,
    normalizeRecoFailureOrigin,
    normalizeRecoGroundingStatus,
    normalizeRecoViablePoolStrength,
    normalizeRecoTargetFidelityLevel,
    deriveRecoContractStatus,
    deriveRecoMainlineStatus,
    deriveRecoTelemetryFailureReason,
    buildRecoMainlineContract,
    applyRecoWarningVisibilityContract,
    attachRecoContractMeta,
    mergeFieldMissing,
    isRecoUngroundedItem,
    enrichRecommendationsWithPdpOpenContract,
    dedupeRecoRecommendationsStrict,
    limitRecoKnownTestSeedRecommendations,
    buildRecoDiversityHistoryKey,
    getRecoRecentExposureState,
    applyRecoRecentDiversityGuard,
    buildRecoDiversityToken,
    updateRecoRecentExposureTokens,
    normalizeBudgetHint,
    hasItineraryContextForReco,
    runConcernSelectorRace,
    applyConcernSelectorRaceOrdering,
    finalizeConcernFrameworkCandidatePools,
    finalizeRecommendationCandidatePools,
    buildRecoGenerateFromCatalog,
    deriveRecoPdpFastFallbackReasonCode,
    buildRecoLlmPromptState,
    runRecoLlmPrimary,
    resolveConcernMainlineFailure,
    resolveRecoEffectiveFailure,
    hasEmptyStructuredRecommendations,
    shouldUseRecoCatalogTransientFallback,
    buildRecoCatalogTransientFallbackStructured,
    recordAuroraRecoLlmCall,
    groundRecoRecommendationsFromCatalog,
    coerceRecoItemForUi,
    normalizeRecoGenerate,
    buildConcernFrameworkDecisionTrace,
    deriveRecoFailureFromStepAwareLlmFallback,
    deriveStepAwareEmptyReason,
    buildConcernFrameworkSummary,
    RECO_CATALOG_GROUNDED_ENABLED,
    RECO_UPSTREAM_TIMEOUT_MS,
    RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS,
    RECO_PDP_ENRICH_CONCURRENCY,
    RECO_PDP_ENRICH_MAX_NETWORK_ITEMS,
    RECO_PDP_RESOLVE_ENABLED,
    RECO_PDP_RESOLVE_TIMEOUT_MS,
    RECO_PDP_RESOLVE_TIMEOUT_STRICT_MIN_MS,
    RECO_PDP_STRICT_INTERNAL_FIRST,
    PIVOTA_BACKEND_BASE_URL,
    RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP,
    RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED,
    RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT,
    RECO_CATALOG_TRANSIENT_FALLBACK_ENABLED,
    RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED,
    RECOMMENDATION_RECO_POLICY_V1,
    RECO_TEST_SEED_MAX_PER_RESPONSE,
    RECO_TEST_SEED_MIN_TOTAL,
    isProductionLikeAuroraBffEnv,
    RECO_DIVERSITY_ENABLED,
    RECO_DIVERSITY_MAX_REPEAT_PER_RESPONSE,
    RECO_DIVERSITY_MIN_TOTAL,
    RECO_MAIN_PROMPT_TEMPLATE_ID,
    RECO_PDP_LIGHT_ENRICH_ENABLED,
    AURORA_BFF_RECO_STEP_AWARE_CATALOG_FIRST_ENABLED,
    AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED,
    CONCERN_SEMANTIC_PLAN_VERSION,
    CONCERN_SELECTOR_RACE_VERSION,
    RECOMMENDATION_STEP_QUERY_POLICY_V1,
    RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1,
    CANDIDATE_POOL_SIGNATURE_VERSION,
    GROUP_SEMANTICS_VERSION,
  } = deps;

  async function generateProductRecommendations({
    ctx,
    profile,
    recentLogs,
    message,
    focus = '',
    ingredientContext,
    analysisContextSnapshot = null,
    requestOverride = null,
    includeAlternatives,
    debug,
    logger,
    recoTriggerSource = null,
    recomputeFromProfileUpdate = false,
    budgetMs = null,
    entryType = 'chat',
    catalogExternalSeedStrategy = '',
  }) {
    const {
      buildLegacyRecoUpstreamDebug,
      applyLegacyRecoFilterDebug,
      applyLegacyRecoOutcomeDebug,
    } = createLegacyRecoGenerationDebugRuntime({
      pickFirstTrimmed,
      isPlainObject,
      RECO_CATALOG_GROUNDED_ENABLED,
      RECO_UPSTREAM_TIMEOUT_MS,
      RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS,
      RECO_PDP_ENRICH_CONCURRENCY,
      RECO_PDP_ENRICH_MAX_NETWORK_ITEMS,
      RECO_PDP_RESOLVE_ENABLED,
      RECO_PDP_RESOLVE_TIMEOUT_MS,
      RECO_PDP_RESOLVE_TIMEOUT_STRICT_MIN_MS,
      RECO_PDP_STRICT_INTERNAL_FIRST,
      PIVOTA_BACKEND_BASE_URL,
      RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP,
      RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED,
      RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT,
      RECO_CATALOG_TRANSIENT_FALLBACK_ENABLED,
      RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED,
      RECOMMENDATION_RECO_POLICY_V1,
      RECO_TEST_SEED_MAX_PER_RESPONSE,
      RECO_TEST_SEED_MIN_TOTAL,
      isProductionLikeAuroraBffEnv,
    });
    const {
      applyLegacyRecoRecommendationPostFilters,
    } = createLegacyRecoRecommendationPostFiltersRuntime({
      dedupeRecoRecommendationsStrict,
      limitRecoKnownTestSeedRecommendations,
      buildRecoDiversityHistoryKey,
      getRecoRecentExposureState,
      applyRecoRecentDiversityGuard,
      buildRecoDiversityToken,
      updateRecoRecentExposureTokens,
      normalizeBudgetHint,
      hasItineraryContextForReco,
      RECO_DIVERSITY_ENABLED,
      RECO_DIVERSITY_MAX_REPEAT_PER_RESPONSE,
      RECO_DIVERSITY_MIN_TOTAL,
    });
    const {
      buildLegacyRecoGenerationContext,
    } = createLegacyRecoGenerationContextRuntime({
      summarizeProfileForContext,
      normalizeIngredientRecoContextValue,
      buildAnalysisContextSnapshotForRoute,
      buildTaskAnalysisContextForPrefix,
      buildAnalysisContextPromptBlock,
      buildContextPrefix,
      pickFirstTrimmed,
      resolveRecommendationTargetContext,
      runConcernSemanticPlanner,
      buildConcernTargetContextFromSemanticPlan,
    });
    const {
      buildLegacyRecoGenerationResult,
    } = createLegacyRecoGenerationResultRuntime({
      isPlainObject,
      pickFirstTrimmed,
      normalizeRecoEffectiveFailureClass,
      deriveRecoContractStatus,
      deriveRecoMainlineStatus,
      deriveRecoTelemetryFailureReason,
      normalizeRecoFailureOrigin,
      normalizeRecoViablePoolStrength,
      normalizeRecoTargetFidelityLevel,
      buildRecoMainlineContract,
      applyRecoWarningVisibilityContract,
      attachRecoContractMeta,
    });
    const {
      applyLegacyRecoPdpEnrichment,
    } = createLegacyRecoPdpEnrichmentRuntime({
      isPlainObject,
      isRecoUngroundedItem,
      dedupeRecoRecommendationsStrict,
      enrichRecommendationsWithPdpOpenContract,
    });
    const {
      runLegacyRecoFrameworkPass,
    } = createLegacyRecoFrameworkPassRuntime({
      isPlainObject,
      pickFirstTrimmed,
      pickFirstString,
      asStringArray,
      uniqCaseInsensitiveStrings,
      runConcernSelectorRace,
      applyConcernSelectorRaceOrdering,
    });
    const {
      runLegacyRecoMainlineExecution,
    } = createLegacyRecoMainlineExecutionRuntime({
      pickFirstTrimmed,
      isPlainObject,
      finalizeConcernFrameworkCandidatePools,
      finalizeRecommendationCandidatePools,
      buildRecoGenerateFromCatalog,
      deriveRecoPdpFastFallbackReasonCode,
      buildRecoLlmPromptState,
      runRecoLlmPrimary,
      resolveConcernMainlineFailure,
      resolveRecoEffectiveFailure,
      normalizeRecoFailureClass,
      hasEmptyStructuredRecommendations,
      shouldUseRecoCatalogTransientFallback,
      buildRecoCatalogTransientFallbackStructured,
      recordAuroraRecoLlmCall,
    });
    const {
      runLegacyRecoPostMainline,
    } = createLegacyRecoPostMainlineRuntime({
      isPlainObject,
      pickFirstTrimmed,
      normalizeRecoEffectiveFailureClass,
      normalizeRecoGroundingStatus,
      groundRecoRecommendationsFromCatalog,
      coerceRecoItemForUi,
      normalizeRecoGenerate,
      finalizeConcernFrameworkCandidatePools,
      finalizeRecommendationCandidatePools,
      buildConcernFrameworkDecisionTrace,
      deriveRecoFailureFromStepAwareLlmFallback,
      deriveStepAwareEmptyReason,
      buildConcernFrameworkSummary,
      applyLegacyRecoRecommendationPostFilters,
      mergeFieldMissing,
      applyLegacyRecoFilterDebug,
    });
    let concernSelectorRaceTrace = null;
    let concernOpenWorldExpansionTrace = null;
    let concernWinnerSource = 'deterministic';
    let concernSupportRolesSurfaced = [];
    let concernOpenWorldExpansionUsed = false;
    let selectorRaceApplied = false;
    let pdpEnrichmentApplied = false;
    const {
      profileSummary,
      normalizedIngredientContext,
      effectiveAnalysisContextSnapshot,
      recommendationTaskContext,
      prefix,
      userAsk,
      targetContext,
      concernSemanticPlanTrace,
      concernSemanticPlanBlockedReason,
      concernSemanticPlanBlockedFailureClass,
      concernSemanticPlanBlockedFailureOrigin,
      concernSemanticPlanBlockedTelemetryReason,
      mainlineStageTimingsMs,
    } = await buildLegacyRecoGenerationContext({
      ctx,
      profile,
      recentLogs,
      message,
      focus,
      ingredientContext,
      analysisContextSnapshot,
      requestOverride,
      entryType,
      logger,
    });
    const normalizedRecoTriggerSource = normalizeRecoSourceDetail(
      pickFirstTrimmed(recoTriggerSource, ctx && ctx.trigger_source, 'text'),
    );
    const recomputeFromProfileUpdateFlag = recomputeFromProfileUpdate === true;
    const deadlineAtMs = Number.isFinite(Number(budgetMs))
      ? Date.now() + Math.max(0, Math.trunc(Number(budgetMs)))
      : null;

    const globalStatus = {
      budget_known: Boolean(normalizeBudgetHint(profileSummary && profileSummary.budgetTier)),
      itinerary_provided: hasItineraryContextForReco(profileSummary),
      recent_logs_provided: Array.isArray(recentLogs) && recentLogs.length > 0,
    };
    const frameworkCatalogFirstEnabled = Boolean(
      Array.isArray(targetContext?.framework_roles) && targetContext.framework_roles.length > 0,
    );
    const deterministicCatalogFirstEnabled = Boolean(
      AURORA_BFF_RECO_STEP_AWARE_CATALOG_FIRST_ENABLED
        && (targetContext.step_aware_intent || frameworkCatalogFirstEnabled),
    );
    const stepAwareFailurePolicyEnabled = Boolean(
      deterministicCatalogFirstEnabled && targetContext.step_aware_intent && !frameworkCatalogFirstEnabled,
    );
    const mainlineExecution = await runLegacyRecoMainlineExecution({
      concernSemanticPlanBlockedReason,
      concernSemanticPlanBlockedTelemetryReason,
      concernSemanticPlanBlockedFailureClass,
      concernSemanticPlanBlockedFailureOrigin,
      frameworkCatalogFirstEnabled,
      deterministicCatalogFirstEnabled,
      targetContext,
      recommendationTaskContext,
      profileSummary,
      normalizedIngredientContext,
      catalogExternalSeedStrategy,
      debug,
      logger,
      ctx,
      userAsk,
      prefix,
      recentLogs,
      globalStatus,
      mainlineStageTimingsMs,
      RECO_MAIN_PROMPT_TEMPLATE_ID,
      RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED,
    });
    let upstream = mainlineExecution.upstream;
    let contextMeta = mainlineExecution.contextMeta;
    let upstreamFailureCode = mainlineExecution.upstreamFailureCode;
    let llmFailureClass = mainlineExecution.llmFailureClass;
    let llmLatencyMs = mainlineExecution.llmLatencyMs;
    let catalogStructured = mainlineExecution.catalogStructured;
    let catalogCandidatePool = mainlineExecution.catalogCandidatePool;
    let catalogCandidateState = mainlineExecution.catalogCandidateState;
    let catalogDebug = mainlineExecution.catalogDebug;
    let pdpFastFallbackReasonCode = mainlineExecution.pdpFastFallbackReasonCode;
    let pdpFastExternalFallbackReasonCode = mainlineExecution.pdpFastExternalFallbackReasonCode;
    let catalogTransientFallbackStructured = mainlineExecution.catalogTransientFallbackStructured;
    let answerJson = mainlineExecution.answerJson;
    let structured = mainlineExecution.structured;
    let structuredSource = mainlineExecution.structuredSource;
    let llmStructured = mainlineExecution.llmStructured;
    let llmStructuredSource = mainlineExecution.llmStructuredSource;
    let promptBundle = mainlineExecution.promptBundle;
    let query = mainlineExecution.query;
    let promptContract = mainlineExecution.promptContract;
    let llmTrace = mainlineExecution.llmTrace;
    let llmInvoked = mainlineExecution.llmInvoked;
    let initialLlmOutcome = mainlineExecution.initialLlmOutcome;
    let presentationMode = mainlineExecution.presentationMode;
    let nonBlockingLlmIssue = mainlineExecution.nonBlockingLlmIssue;
    let successMode = mainlineExecution.successMode;
    let effectiveFailureClass = mainlineExecution.effectiveFailureClass;
    let failureOrigin = mainlineExecution.failureOrigin;
    let preLlmSelectedCandidateCount = mainlineExecution.preLlmSelectedCandidateCount;
    let finalSelectedCandidateCount = mainlineExecution.finalSelectedCandidateCount;
    let postGuardrailCount = null;
    Object.assign(mainlineStageTimingsMs, mainlineExecution.mainlineStageTimingsMs || {});

    const upstreamDebug = buildLegacyRecoUpstreamDebug({
      debugEnabled: debug,
      upstream,
      structuredSource,
      answerJson,
      structured,
      catalogStructured,
      catalogTransientFallbackStructured,
      catalogDebug,
      pdpFastFallbackReasonCode,
      normalizedIngredientContext,
      llmStructuredSource,
      llmFailureClass,
      llmInvoked,
      initialLlmOutcome,
      presentationMode,
      successMode,
      nonBlockingLlmIssue,
      llmTrace,
      query,
      promptBundle,
      catalogCandidatePool,
      targetContext,
      catalogCandidateState,
      effectiveFailureClass,
      failureOrigin,
      effectiveAnalysisContextSnapshot,
      recommendationTaskContext,
    });
    let alternativesDebug = null;
    const postMainline = await runLegacyRecoPostMainline({
      structured,
      structuredSource,
      ctx,
      logger,
      targetContext,
      catalogDebug,
      catalogCandidateState,
      recommendationTaskContext,
      preLlmSelectedCandidateCount,
      stepAwareFailurePolicyEnabled,
      initialLlmOutcome,
      llmFailureClass,
      upstreamFailureCode,
      promptContract,
      concernSemanticPlanBlockedReason,
      concernSemanticPlanBlockedTelemetryReason,
      concernSemanticPlanBlockedFailureClass,
      concernSelectorRaceTrace,
      concernOpenWorldExpansionUsed,
      effectiveFailureClass,
      failureOrigin,
      presentationMode,
      successMode,
      profileSummary,
      includeAlternatives,
      upstreamDebug,
      ingredientContext,
    });
    let mapped = postMainline.mapped;
    let groundingResult = postMainline.groundingResult;
    catalogDebug = postMainline.catalogDebug;
    const frameworkMode = postMainline.frameworkMode;
    const viablePoolState = postMainline.viablePoolState;
    const frameworkPartialSurface = postMainline.frameworkPartialSurface;
    const frameworkTraceId = postMainline.frameworkTraceId;
    const frameworkDecisionTrace = postMainline.frameworkDecisionTrace;
    preLlmSelectedCandidateCount = postMainline.preLlmSelectedCandidateCount;
    const stepAwareMainlineFailure = postMainline.stepAwareMainlineFailure;
    const stepAwareMainlineFailureBlocking = postMainline.stepAwareMainlineFailureBlocking;
    const stepAwarePoolWarningNonBlocking = postMainline.stepAwarePoolWarningNonBlocking;
    effectiveFailureClass = postMainline.effectiveFailureClass;
    failureOrigin = postMainline.failureOrigin;
    presentationMode = postMainline.presentationMode;
    successMode = postMainline.successMode;
    const effectiveGroundingStatus = postMainline.effectiveGroundingStatus;
    const effectiveGroundedCount = postMainline.effectiveGroundedCount;
    const effectiveUngroundedCount = postMainline.effectiveUngroundedCount;
    const effectiveMainlineStatus = postMainline.effectiveMainlineStatus;
    const effectiveCatalogSkipReason = postMainline.effectiveCatalogSkipReason;
    const effectiveTelemetryReason = postMainline.effectiveTelemetryReason;
    let itineraryAvailable = postMainline.itineraryAvailable;
    let norm = postMainline.norm;

    const recoRowsForPdp = Array.isArray(norm.payload.recommendations)
      ? norm.payload.recommendations
      : [];
    const shouldDelayPdpEnrichment = frameworkMode;
    if (shouldDelayPdpEnrichment) {
      const pdpDeferred = await applyLegacyRecoPdpEnrichment({
        payload: norm.payload,
        recommendations: recoRowsForPdp,
        deadlineAtMs,
        logger,
        fastExternalFallbackReasonCode: pdpFastExternalFallbackReasonCode,
        lightEnrich: RECO_PDP_LIGHT_ENRICH_ENABLED,
        deferUntilSafeWinner: true,
      });
      norm.payload = pdpDeferred.payload;
    } else {
      const pdpEnriched = await applyLegacyRecoPdpEnrichment({
        payload: norm.payload,
        recommendations: recoRowsForPdp,
        deadlineAtMs,
        logger,
        fastExternalFallbackReasonCode: pdpFastExternalFallbackReasonCode,
        lightEnrich: RECO_PDP_LIGHT_ENRICH_ENABLED,
      });
      mainlineStageTimingsMs.pdp_enrichment = Math.max(
        0,
        Number(pdpEnriched.latencyMs || 0),
      );
      pdpEnrichmentApplied = pdpEnriched.applied === true;
      norm.payload = pdpEnriched.payload;
    }
    let frameworkMainlineWarningNonBlocking = false;
    let beautyMainlineHandoffNonBlocking = false;
    const frameworkPass = await runLegacyRecoFrameworkPass({
      frameworkMode,
      targetContext,
      concernSemanticPlanBlockedReason,
      viablePoolState,
      payload: norm.payload,
      ctx,
      logger,
      userAsk,
      applyLegacyRecoPdpEnrichment,
      deadlineAtMs,
      pdpFastExternalFallbackReasonCode,
      RECO_PDP_LIGHT_ENRICH_ENABLED,
    });
    mainlineStageTimingsMs.selector_race = Math.max(
      0,
      Number(frameworkPass.selectorRaceLatencyMs || 0),
    );
    mainlineStageTimingsMs.pdp_enrichment = Math.max(
      Number(mainlineStageTimingsMs.pdp_enrichment || 0),
      Number(frameworkPass.pdpLatencyMs || 0),
    );
    selectorRaceApplied = frameworkPass.selectorRaceApplied === true;
    concernSelectorRaceTrace = frameworkPass.selectorRaceTrace;
    concernWinnerSource = frameworkPass.winnerSource || 'deterministic';
    concernSupportRolesSurfaced = Array.isArray(frameworkPass.supportRolesSurfaced)
      ? frameworkPass.supportRolesSurfaced
      : [];
    frameworkMainlineWarningNonBlocking =
      frameworkPass.frameworkMainlineWarningNonBlocking === true;
    pdpEnrichmentApplied =
      pdpEnrichmentApplied || frameworkPass.pdpEnrichmentApplied === true;
    norm.payload = frameworkPass.payload;
    let finalRecommendations = Array.isArray(norm.payload?.recommendations)
      ? norm.payload.recommendations
      : [];
    finalSelectedCandidateCount = finalRecommendations.length;
    postGuardrailCount = finalSelectedCandidateCount;
    if (deterministicCatalogFirstEnabled && !stepAwareMainlineFailureBlocking) {
      const failureSignals = frameworkMode
        ? resolveConcernMainlineFailure({
            plannerBlocked: Boolean(concernSemanticPlanBlockedReason),
            plannerFailureClass:
              concernSemanticPlanBlockedTelemetryReason === 'planner_timeout'
                ? 'timeout'
                : concernSemanticPlanBlockedFailureClass,
            viablePoolState: {
              ...viablePoolState,
              final_selected_candidate_count: finalSelectedCandidateCount,
            },
            catalogDebug,
            postGuardrailCount,
          })
        : resolveRecoEffectiveFailure({
            targetContext,
            viablePoolState: {
              ...viablePoolState,
              final_selected_candidate_count: finalSelectedCandidateCount,
            },
            catalogDebug,
            postGuardrailCount,
          });
      const returnedProductsWarningNonBlocking =
        finalRecommendations.length > 0
        && (
          frameworkMainlineWarningNonBlocking
          || stepAwarePoolWarningNonBlocking
          || beautyMainlineHandoffNonBlocking
          || Boolean(stepAwareMainlineFailure && !stepAwareMainlineFailureBlocking)
        );
      const normalizedFailureClass = normalizeRecoEffectiveFailureClass(
        failureSignals.effective_failure_class || 'none',
      );
      if (
        returnedProductsWarningNonBlocking
        && (
          normalizedFailureClass === 'weak_viable_pool'
          || normalizedFailureClass === 'no_recall_from_planned_sources'
        )
      ) {
        effectiveFailureClass = 'none';
        failureOrigin = 'none';
      } else {
        effectiveFailureClass = failureSignals.effective_failure_class || 'none';
        failureOrigin = failureSignals.failure_origin || 'none';
      }
    }
    const terminalSuccess = finalRecommendations.length > 0
      && normalizeRecoEffectiveFailureClass(effectiveFailureClass || 'none') === 'none';
    const generationResult = buildLegacyRecoGenerationResult({
      norm,
      finalRecommendations,
      structuredSource,
      frameworkMode,
      targetContext,
      effectiveCatalogSkipReason,
      catalogDebug,
      promptContract,
      llmFailureClass,
      upstreamFailureCode,
      effectiveMainlineStatus,
      effectiveTelemetryReason,
      applyLegacyRecoOutcomeDebug,
      upstreamDebug,
      effectiveGroundingStatus,
      effectiveGroundedCount,
      effectiveUngroundedCount,
      promptBundle,
      finalSelectedCandidateCount,
      postGuardrailCount,
      effectiveFailureClass,
      failureOrigin,
      concernSemanticPlanTrace,
      concernSelectorRaceTrace,
      concernOpenWorldExpansionTrace,
      viablePoolState,
      mainlineStageTimingsMs,
      normalizedRecoTriggerSource,
      recomputeFromProfileUpdateFlag,
      recentLogs,
      itineraryAvailable,
      deterministicCatalogFirstEnabled,
      AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED,
      preLlmSelectedCandidateCount,
      query,
      concernWinnerSource,
      concernOpenWorldExpansionUsed,
      concernSupportRolesSurfaced,
      frameworkTraceId,
      CONCERN_SEMANTIC_PLAN_VERSION,
      CONCERN_SELECTOR_RACE_VERSION,
      RECOMMENDATION_STEP_QUERY_POLICY_V1,
      RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1,
      RECOMMENDATION_RECO_POLICY_V1,
      CANDIDATE_POOL_SIGNATURE_VERSION,
      GROUP_SEMANTICS_VERSION,
      terminalSuccess,
      entryType,
      stepAwareMainlineFailure,
      normalizedIngredientContext,
      llmTrace,
      frameworkMainlineWarningNonBlocking,
      beautyMainlineHandoffNonBlocking,
      stepAwarePoolWarningNonBlocking,
      stepAwareMainlineFailureBlocking,
      successMode,
      presentationMode,
      nonBlockingLlmIssue,
      llmInvoked,
      initialLlmOutcome,
    });

    return {
      ...generationResult,
      alternativesDebug,
      candidatePoolState: viablePoolState,
      upstreamFailureCode,
      llmFailureClass,
      llmTrace,
    };
  }

  return {
    generateProductRecommendations,
  };
}

function normalizeRecoSourceDetail(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'text';
  if (['action', 'chip', 'planner', 'analysis_handoff', 'latest_reco_context', 'session_reco_context', 'text'].includes(normalized)) {
    return normalized;
  }
  return normalized.slice(0, 64) || 'text';
}

module.exports = {
  createLegacyRecoGenerationEngineRuntime,
};
