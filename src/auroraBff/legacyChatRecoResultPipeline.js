const {
  createLegacyChatRecoExecutionRuntime,
} = require('./legacyChatRecoExecution');
const {
  createLegacyChatRecoCompletionRuntime,
} = require('./legacyChatRecoCompletion');
const {
  createLegacyChatRecoMatcherRuntime,
} = require('./legacyChatRecoMatcher');

function createLegacyChatRecoResultPipelineRuntime(deps = {}) {
  const {
    buildIngredientPlan,
    buildProductRecommendationsBundle,
    toLegacyRecommendationsPayload,
    summarizeProfileForContext,
    normalizeRecoSourceDetail,
    shouldUseLegacyVerifiedContextRestore,
    restoreRecoRecommendationsFromVerifiedContextCandidates,
    applyVerifiedCandidateRestoreToRecoPayload,
    generateProductRecommendations,
    extractRecoContextProductCandidatesFromCandidatePoolState,
    buildIngredientRecoContextTargetBundle,
    normalizeRecoTargetStep,
    mergeIngredientRecoContextValue,
    classifyRecoUpstreamFailureCode,
    isTransientRecoUpstreamFailureCode,
    recordAuroraRecoLlmCall,
    normalizeRecoFailureClass,
    postProcessLegacyChatRecoResult,
    normalizeLegacyChatRecoPayload,
    finalizeLegacyChatRecoEnvelope,
  } = deps;

  const {
    computeLegacyRecoMatcher,
  } = createLegacyChatRecoMatcherRuntime({
    buildIngredientPlan,
    buildProductRecommendationsBundle,
    toLegacyRecommendationsPayload,
  });

  const {
    executeLegacyChatReco,
  } = createLegacyChatRecoExecutionRuntime({
    summarizeProfileForContext,
    normalizeRecoSourceDetail,
    shouldUseLegacyVerifiedContextRestore,
    restoreRecoRecommendationsFromVerifiedContextCandidates,
    applyVerifiedCandidateRestoreToRecoPayload,
    generateProductRecommendations,
    extractRecoContextProductCandidatesFromCandidatePoolState,
    buildIngredientRecoContextTargetBundle,
    normalizeRecoTargetStep,
    mergeIngredientRecoContextValue,
    classifyRecoUpstreamFailureCode,
    isTransientRecoUpstreamFailureCode,
    recordAuroraRecoLlmCall,
    normalizeRecoFailureClass,
  });

  const {
    completeLegacyChatRecoRequest,
  } = createLegacyChatRecoCompletionRuntime({
    postProcessLegacyChatRecoResult,
    normalizeLegacyChatRecoPayload,
    finalizeLegacyChatRecoEnvelope,
  });

  async function runLegacyChatRecoResultPipeline({
    ctx,
    profile,
    recentLogs,
    message,
    includeAlternatives,
    logger,
    ingredientRecoOptInRequested,
    travelRecoHandoff,
    shouldApplySessionRecoContext,
    recoAutoAnchoredByAnalysis,
    effectiveRecoEntrySourceDetail,
    hasStableRecoTarget,
    recoIngredientContext,
    latestRecoContextPatch,
    chatRecoTargetContext,
    recoTaskMode,
    artifactConfidenceScore,
    artifactConfidenceLevel,
    lowConfidenceArtifact,
    recoContextIngredientQuery,
    recoContextGoal,
    recoIngredientCandidates,
    latestArtifact,
    mappedIngredientPlan,
    analysisContextSnapshotForConversation,
    requestScopedProfileOverride,
    debugUpstream,
    recoRequestMessageForMainline,
    recoFocusForMainline,
    recoIngredientContextForMainline,
    catalogExternalSeedStrategyForMainline,
    recoProductCandidates,
    genericConcernRecoMainline,
    hasDeterministicRecoTarget,
    buildSafetyNoticeText,
    shouldAutoRerunRecommendationsFromProfilePatch,
    recoRequestMessage,
    safetyDecision,
    chatAnalysisTaskContext,
    attachAnalysisContextUsageToSessionPatch,
    identity,
    refinementChips,
    pendingClarificationPatchOverride,
    profileScore,
    productMatcherEnabled,
    productMatcherBundledSeedFallbackEnabled,
    diagProductCatalogPath,
    recoBudgetMs,
    AURORA_PRODUCT_MATCHER_ENABLED,
  } = {}) {
    let matcherBundle = null;
    let matcherPayload = null;
    let matcherComputed = false;
    let mutableMappedIngredientPlan = mappedIngredientPlan;

    const computeMatcherIfNeeded = () => {
      if (matcherComputed) {
        return { matcherBundle, matcherPayload };
      }
      matcherComputed = true;
      const matcherResult = computeLegacyRecoMatcher({
        latestArtifact,
        mappedIngredientPlan: mutableMappedIngredientPlan,
        profile,
        language: ctx.lang,
        logger,
        requestId: ctx.request_id,
        productMatcherEnabled,
        productMatcherBundledSeedFallbackEnabled,
        diagProductCatalogPath,
      });
      matcherBundle = matcherResult.matcherBundle;
      matcherPayload = matcherResult.matcherPayload;
      if (!mutableMappedIngredientPlan && matcherResult.mappedIngredientPlan) {
        mutableMappedIngredientPlan = matcherResult.mappedIngredientPlan;
      }
      return { matcherBundle, matcherPayload };
    };

    const executionResult = await executeLegacyChatReco({
      ctx,
      profile,
      recentLogs,
      message,
      includeAlternatives,
      logger,
      ingredientRecoOptInRequested,
      travelRecoHandoff,
      shouldApplySessionRecoContext,
      recoAutoAnchoredByAnalysis,
      effectiveRecoEntrySourceDetail,
      hasStableRecoTarget,
      recoIngredientContext,
      latestRecoContextPatch,
      chatRecoTargetContext,
      recoTaskMode,
      artifactConfidenceScore,
      artifactConfidenceLevel,
      lowConfidenceArtifact,
      recoContextIngredientQuery,
      recoContextGoal,
      recoIngredientCandidates,
      matcherPayload,
      recoRequestMessageForMainline,
      recoFocusForMainline,
      recoIngredientContextForMainline,
      analysisContextSnapshotForConversation,
      requestScopedProfileOverride,
      debugUpstream,
      catalogExternalSeedStrategyForMainline,
      AURORA_BFF_CHAT_RECO_BUDGET_MS: recoBudgetMs,
    });

    return completeLegacyChatRecoRequest({
      ctx,
      norm: executionResult.norm,
      upstreamReco: executionResult.upstreamReco,
      upstreamDebug: executionResult.upstreamDebug,
      recoLlmTrace: executionResult.recoLlmTrace,
      recoContract: executionResult.recoContract,
      llmFailureClass: executionResult.llmFailureClass,
      upstreamFailureCode: executionResult.upstreamFailureCode,
      recoCatalogSkipReason: executionResult.recoCatalogSkipReason,
      recoTelemetryFailureReason: executionResult.recoTelemetryFailureReason,
      recoMetaPromptTemplateId: '',
      recoMainlineStatus: executionResult.recoMainlineStatus,
      recoTimeoutDegraded: executionResult.recoTimeoutDegraded,
      recoTimeoutDegradedWarning: executionResult.recoTimeoutDegradedWarning,
      recoSource: executionResult.recoSource,
      genericConcernRecoMainline,
      hasDeterministicRecoTarget,
      ingredientRecoOptInRequested,
      travelRecoHandoff,
      latestRecoContextPatch: executionResult.latestRecoContextPatch,
      recoContextIngredientQuery,
      recoIngredientCandidates,
      recoIngredientContext: executionResult.recoIngredientContext,
      recoProductCandidates,
      chatRecoTargetContext,
      profile,
      recentLogs,
      latestArtifact,
      logger,
      productMatcherEnabled,
      computeMatcherIfNeeded,
      recoTaskMode,
      verifiedCandidateRestoreApplied:
        executionResult.verifiedCandidateRestoreApplied,
      verifiedCandidateRestoreCount:
        executionResult.verifiedCandidateRestoreCount,
      debugUpstream,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      lowConfidenceArtifact,
      matcherFallbackUsed: false,
      normalizedRecoTriggerSource: normalizeRecoSourceDetail(
        effectiveRecoEntrySourceDetail,
      ),
      shouldAutoRerunRecommendationsFromProfilePatch,
      message,
      recoRequestMessage,
      safetyDecision,
      buildSafetyNoticeText,
      effectiveRecoEntrySourceDetail,
      mappedIngredientPlan: mutableMappedIngredientPlan,
      alternativesDebug: executionResult.alternativesDebug,
      chatAnalysisTaskContext,
      attachAnalysisContextUsageToSessionPatch,
      identity,
      productMatcherEnabledFlag: AURORA_PRODUCT_MATCHER_ENABLED,
      refinementChips,
      pendingClarificationPatchOverride,
      profileScore,
      normFieldMissing: executionResult.norm.field_missing,
      wantsProductRecommendations: true,
    });
  }

  return {
    runLegacyChatRecoResultPipeline,
  };
}

module.exports = {
  createLegacyChatRecoResultPipelineRuntime,
};
