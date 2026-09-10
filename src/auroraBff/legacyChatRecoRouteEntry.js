function createLegacyChatRecoRouteEntryRuntime(deps = {}) {
  const {
    shouldEnterLegacyProductRecommendations,
    handleLegacyChatRecoRequest,
  } = deps;

  async function maybeHandleLegacyChatRecoRouteEntry({
    ctx,
    logger,
    message,
    session,
    recentLogs,
    identity,
    canonicalIntent,
    safetyDecision,
    includeAlternatives,
    actionId,
    debugUpstream,
    requestScopedProfileOverride,
    ingredientRecoContext,
    ingredientRecoOptInRequested,
    ingredientActionData,
    ingredientDrivenRecommendationRequested,
    latestRecoContextFromSession,
    recoEntrySourceDetail,
    recoRequestMessage,
    shouldAutoRerunRecommendationsFromProfilePatch,
    travelSkillsContracts,
    looksLikeLowRiskSkincareTask,
    profile,
    forceUpstreamAfterPendingAbandon,
    allowRecoCards,
    normalizedActionPayload,
    recoInteractionAllowed,
    budgetChipCanContinueReco,
    profileClarificationAction,
    legacyRecoDeps = {},
  } = {}) {
    // Beauty-owned requests are filtered before this entry; this remains only
    // as the non-beauty compatibility route into legacy reco handling.
    const wantsProductRecommendations = shouldEnterLegacyProductRecommendations({
      forceUpstreamAfterPendingAbandon,
      allowRecoCards,
      message,
      normalizedActionPayload,
      ingredientRecoOptInRequested,
      recoInteractionAllowed,
      actionId,
      budgetChipCanContinueReco,
      profileClarificationAction,
      ingredientDrivenRecommendationRequested,
      shouldAutoRerunRecommendationsFromProfilePatch,
    });
    if (!wantsProductRecommendations) {
      return { handled: false };
    }

    const envelope = await handleLegacyChatRecoRequest({
      ctx,
      message,
      profile,
      session,
      recentLogs,
      logger,
      identity,
      attachAnalysisContextUsageToSessionPatch:
        legacyRecoDeps.attachAnalysisContextUsageToSessionPatch,
      canonicalIntent,
      safetyDecision,
      buildSafetyNoticeText: legacyRecoDeps.buildSafetyNoticeText,
      includeAlternatives,
      actionId,
      debugUpstream,
      requestScopedProfileOverride,
      ingredientRecoContext,
      ingredientRecoOptInRequested,
      ingredientActionData,
      ingredientDrivenRecommendationRequested,
      latestRecoContextFromSession,
      recoEntrySourceDetail,
      recoRequestMessage,
      shouldAutoRerunRecommendationsFromProfilePatch,
      travelSkillsContracts,
      looksLikeLowRiskSkincareTask,
      runAuroraTimedOperation: legacyRecoDeps.runAuroraTimedOperation,
      ensureLatestArtifactForConversation:
        legacyRecoDeps.ensureLatestArtifactForConversation,
      ensureAnalysisContextSnapshotForConversation:
        legacyRecoDeps.ensureAnalysisContextSnapshotForConversation,
      ensureTaskAnalysisContextForConversation:
        legacyRecoDeps.ensureTaskAnalysisContextForConversation,
      getIngredientPlanByArtifactIdForRoute:
        legacyRecoDeps.getIngredientPlanByArtifactIdForRoute,
      getAuroraStorageReadTimeoutMs:
        legacyRecoDeps.getAuroraStorageReadTimeoutMs,
      saveIngredientPlanForRoute: legacyRecoDeps.saveIngredientPlanForRoute,
      getAuroraStorageWriteTimeoutMs:
        legacyRecoDeps.getAuroraStorageWriteTimeoutMs,
      prepareLegacyChatRecoContext:
        legacyRecoDeps.prepareLegacyChatRecoContext,
      buildLegacyRecoSafetyGateEnvelope:
        legacyRecoDeps.buildLegacyRecoSafetyGateEnvelope,
      maybeBuildLegacyTravelRecoEnvelope:
        legacyRecoDeps.maybeBuildLegacyTravelRecoEnvelope,
      prepareLegacyChatRecoAnalysisContext:
        legacyRecoDeps.prepareLegacyChatRecoAnalysisContext,
      prepareLegacyChatRecoTargeting:
        legacyRecoDeps.prepareLegacyChatRecoTargeting,
      postProcessLegacyChatRecoResult:
        legacyRecoDeps.postProcessLegacyChatRecoResult,
      normalizeLegacyChatRecoPayload:
        legacyRecoDeps.normalizeLegacyChatRecoPayload,
      finalizeLegacyChatRecoEnvelope:
        legacyRecoDeps.finalizeLegacyChatRecoEnvelope,
      resolveSafetyGateActionV2:
        legacyRecoDeps.resolveSafetyGateActionV2,
      mergePendingSafetyAdvisory:
        legacyRecoDeps.mergePendingSafetyAdvisory,
      persistSafetyPromptAskedOnce:
        legacyRecoDeps.persistSafetyPromptAskedOnce,
      profileCompleteness: legacyRecoDeps.profileCompleteness,
      buildPendingClarificationForGate:
        legacyRecoDeps.buildPendingClarificationForGate,
      emitPendingClarificationPatch:
        legacyRecoDeps.emitPendingClarificationPatch,
      buildDiagnosisChips: legacyRecoDeps.buildDiagnosisChips,
      evaluateSafetyBoundary: legacyRecoDeps.evaluateSafetyBoundary,
      buildConfidenceNoticeCardPayload:
        legacyRecoDeps.buildConfidenceNoticeCardPayload,
      buildIngredientPlan: legacyRecoDeps.buildIngredientPlan,
      buildProductRecommendationsBundle:
        legacyRecoDeps.buildProductRecommendationsBundle,
      toLegacyRecommendationsPayload:
        legacyRecoDeps.toLegacyRecommendationsPayload,
      shouldUseLegacyVerifiedContextRestore:
        legacyRecoDeps.shouldUseLegacyVerifiedContextRestore,
      restoreRecoRecommendationsFromVerifiedContextCandidates:
        legacyRecoDeps.restoreRecoRecommendationsFromVerifiedContextCandidates,
      applyVerifiedCandidateRestoreToRecoPayload:
        legacyRecoDeps.applyVerifiedCandidateRestoreToRecoPayload,
      summarizeProfileForContext:
        legacyRecoDeps.summarizeProfileForContext,
      normalizeRecoSourceDetail:
        legacyRecoDeps.normalizeRecoSourceDetail,
      generateProductRecommendations:
        legacyRecoDeps.generateProductRecommendations,
      extractRecoContextProductCandidatesFromCandidatePoolState:
        legacyRecoDeps.extractRecoContextProductCandidatesFromCandidatePoolState,
      buildIngredientRecoContextTargetBundle:
        legacyRecoDeps.buildIngredientRecoContextTargetBundle,
      normalizeRecoTargetStep:
        legacyRecoDeps.normalizeRecoTargetStep,
      mergeIngredientRecoContextValue:
        legacyRecoDeps.mergeIngredientRecoContextValue,
      classifyRecoUpstreamFailureCode:
        legacyRecoDeps.classifyRecoUpstreamFailureCode,
      isTransientRecoUpstreamFailureCode:
        legacyRecoDeps.isTransientRecoUpstreamFailureCode,
      recordAuroraRecoLlmCall:
        legacyRecoDeps.recordAuroraRecoLlmCall,
      normalizeRecoFailureClass:
        legacyRecoDeps.normalizeRecoFailureClass,
      recordAuroraSkinFlowMetric:
        legacyRecoDeps.recordAuroraSkinFlowMetric,
      recordAuroraRecoEntrySource:
        legacyRecoDeps.recordAuroraRecoEntrySource,
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED:
        legacyRecoDeps.AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
      AURORA_INGREDIENT_PLAN_ENABLED:
        legacyRecoDeps.AURORA_INGREDIENT_PLAN_ENABLED,
      AURORA_PRODUCT_MATCHER_ENABLED:
        legacyRecoDeps.AURORA_PRODUCT_MATCHER_ENABLED,
      AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED:
        legacyRecoDeps.AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED,
      MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION:
        legacyRecoDeps.MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION,
      AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED:
        legacyRecoDeps.AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED,
      DIAG_PRODUCT_CATALOG_PATH:
        legacyRecoDeps.DIAG_PRODUCT_CATALOG_PATH,
      AURORA_BFF_CHAT_RECO_BUDGET_MS:
        legacyRecoDeps.AURORA_BFF_CHAT_RECO_BUDGET_MS,
    });

    return { handled: true, envelope };
  }

  return {
    maybeHandleLegacyChatRecoRouteEntry,
  };
}

module.exports = {
  createLegacyChatRecoRouteEntryRuntime,
};
