function createLegacyChatRecoCompletionRuntime(deps = {}) {
  const {
    postProcessLegacyChatRecoResult,
    normalizeLegacyChatRecoPayload,
    finalizeLegacyChatRecoEnvelope,
  } = deps;

  async function completeLegacyChatRecoRequest({
    ctx,
    norm,
    upstreamReco,
    upstreamDebug,
    recoLlmTrace,
    recoContract,
    llmFailureClass,
    upstreamFailureCode,
    recoCatalogSkipReason,
    recoTelemetryFailureReason,
    recoMetaPromptTemplateId,
    recoMainlineStatus,
    recoTimeoutDegraded,
    recoTimeoutDegradedWarning,
    recoSource,
    genericConcernRecoMainline,
    hasDeterministicRecoTarget,
    ingredientRecoOptInRequested,
    travelRecoHandoff,
    latestRecoContextPatch,
    recoContextIngredientQuery,
    recoIngredientCandidates,
    recoIngredientContext,
    recoProductCandidates,
    chatRecoTargetContext,
    profile,
    recentLogs,
    latestArtifact,
    logger,
    productMatcherEnabled,
    computeMatcherIfNeeded,
    recoTaskMode,
    verifiedCandidateRestoreApplied,
    verifiedCandidateRestoreCount,
    debugUpstream,
    artifactConfidenceLevel,
    artifactConfidenceScore,
    lowConfidenceArtifact,
    matcherFallbackUsed,
    normalizedRecoTriggerSource,
    shouldAutoRerunRecommendationsFromProfilePatch,
    message,
    recoRequestMessage,
    safetyDecision,
    buildSafetyNoticeText,
    effectiveRecoEntrySourceDetail,
    mappedIngredientPlan,
    alternativesDebug,
    chatAnalysisTaskContext,
    attachAnalysisContextUsageToSessionPatch,
    identity,
    productMatcherEnabledFlag,
    refinementChips,
    llmPrimaryUsed = false,
    matcherBundle = null,
    generatedPrimaryUsed = false,
    generatedSourceMode = 'none',
    genericGoalDrivenNeedsMoreContextWarning = null,
    pendingClarificationPatchOverride = undefined,
    profileScore = null,
    normFieldMissing = [],
    wantsProductRecommendations = true,
  } = {}) {
    const postProcessedLegacyReco = postProcessLegacyChatRecoResult({
      ctx,
      norm,
      upstreamReco,
      upstreamDebug,
      recoLlmTrace,
      recoContract,
      llmFailureClass,
      upstreamFailureCode,
      recoCatalogSkipReason,
      recoTelemetryFailureReason,
      recoMetaPromptTemplateId,
      recoMainlineStatus,
      recoTimeoutDegraded,
      recoTimeoutDegradedWarning,
      recoSource,
      llmPrimaryUsed,
      genericConcernRecoMainline,
      hasDeterministicRecoTarget,
      ingredientRecoOptInRequested,
      travelRecoHandoff,
      latestRecoContextPatch,
      recoContextIngredientQuery,
      recoIngredientCandidates,
      recoIngredientContext,
      recoProductCandidates,
      chatRecoTargetContext,
      profile,
      recentLogs,
      latestArtifact,
      logger,
      productMatcherEnabled,
      computeMatcherIfNeeded,
      recoTaskMode,
      verifiedCandidateRestoreApplied,
      verifiedCandidateRestoreCount,
    });
    norm = postProcessedLegacyReco.norm;
    recoLlmTrace = postProcessedLegacyReco.recoLlmTrace;
    recoContract = postProcessedLegacyReco.recoContract;
    recoCatalogSkipReason = postProcessedLegacyReco.recoCatalogSkipReason;
    recoTelemetryFailureReason = postProcessedLegacyReco.recoTelemetryFailureReason;
    recoMetaPromptTemplateId = postProcessedLegacyReco.recoMetaPromptTemplateId;
    recoMainlineStatus = postProcessedLegacyReco.recoMainlineStatus;
    recoTimeoutDegraded = postProcessedLegacyReco.recoTimeoutDegraded;
    recoTimeoutDegradedWarning = postProcessedLegacyReco.recoTimeoutDegradedWarning;
    recoSource = postProcessedLegacyReco.recoSource;
    llmPrimaryUsed = postProcessedLegacyReco.llmPrimaryUsed;
    generatedPrimaryUsed = postProcessedLegacyReco.generatedPrimaryUsed;
    generatedSourceMode = postProcessedLegacyReco.generatedSourceMode;
    matcherBundle = postProcessedLegacyReco.matcherBundle;
    const matcherPayload = postProcessedLegacyReco.matcherPayload;
    latestRecoContextPatch = postProcessedLegacyReco.latestRecoContextPatch;
    recoIngredientContext = postProcessedLegacyReco.recoIngredientContext;
    verifiedCandidateRestoreApplied = postProcessedLegacyReco.verifiedCandidateRestoreApplied;
    verifiedCandidateRestoreCount = postProcessedLegacyReco.verifiedCandidateRestoreCount;
    const initialHasRecs = postProcessedLegacyReco.initialHasRecs;

    const normalizedLegacyRecoPayload = normalizeLegacyChatRecoPayload({
      norm,
      debugUpstream,
      recoLlmTrace,
      recoTaskMode,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      lowConfidenceArtifact,
      recoSource,
      recoContract,
      matcherFallbackUsed,
      generatedPrimaryUsed,
      generatedSourceMode,
      llmPrimaryUsed,
      genericConcernRecoMainline,
      hasDeterministicRecoTarget,
      normalizedRecoTriggerSource,
      shouldAutoRerunRecommendationsFromProfilePatch,
      recentLogs,
      profile,
      recoTelemetryFailureReason,
      llmFailureClass,
      recoCatalogSkipReason,
      upstreamFailureCode,
      recoMainlineStatus,
      initialHasRecs,
      latestRecoContextPatch,
      verifiedCandidateRestoreApplied,
      verifiedCandidateRestoreCount,
      recoMetaPromptTemplateId,
      genericGoalDrivenNeedsMoreContextWarning,
      recoTimeoutDegradedWarning,
      recoIngredientContext,
    });
    const payload = normalizedLegacyRecoPayload.payload;
    recoContract = normalizedLegacyRecoPayload.recoContract;
    recoMainlineStatus = normalizedLegacyRecoPayload.recoMainlineStatus;
    latestRecoContextPatch = normalizedLegacyRecoPayload.latestRecoContextPatch;
    const llmTraceRef = normalizedLegacyRecoPayload.llmTraceRef;

    return finalizeLegacyChatRecoEnvelope({
      ctx,
      payload,
      profile,
      profileScore,
      message,
      recoRequestMessage,
      safetyDecision,
      buildSafetyNoticeText,
      effectiveRecoEntrySourceDetail,
      recoTaskMode,
      recoContextIngredientQuery,
      recoIngredientCandidates,
      recoIngredientContext,
      latestRecoContextPatch,
      recoProductCandidates,
      normFieldMissing: normFieldMissing || norm.field_missing,
      mappedIngredientPlan,
      debugUpstream,
      upstreamDebug,
      alternativesDebug,
      chatAnalysisTaskContext,
      attachAnalysisContextUsageToSessionPatch,
      lowConfidenceArtifact,
      identity,
      llmPrimaryUsed,
      matcherFallbackUsed,
      generatedPrimaryUsed,
      generatedSourceMode,
      genericConcernRecoMainline,
      hasDeterministicRecoTarget,
      productMatcherEnabled: productMatcherEnabledFlag,
      matcherBundle,
      refinementChips,
      recoContract,
      recoSource,
      shouldAutoRerunRecommendationsFromProfilePatch,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      llmTraceRef,
      llmFailureClass,
      latestArtifact,
      logger,
      pendingClarificationPatchOverride,
      wantsProductRecommendations,
    });
  }

  return {
    completeLegacyChatRecoRequest,
  };
}

module.exports = {
  createLegacyChatRecoCompletionRuntime,
};
