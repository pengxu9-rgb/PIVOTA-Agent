const {
  createLegacyChatRecoPreflightRuntime,
} = require('./legacyChatRecoPreflight');

function createLegacyChatRecoContextPipelineRuntime(deps = {}) {
  const {
    prepareLegacyChatRecoContext,
    prepareLegacyChatRecoAnalysisContext,
    prepareLegacyChatRecoTargeting,
    resolveSafetyGateActionV2,
    mergePendingSafetyAdvisory,
    persistSafetyPromptAskedOnce,
    buildLegacyRecoSafetyGateEnvelope,
    buildSafetyNoticeText,
    profileCompleteness,
    buildPendingClarificationForGate,
    emitPendingClarificationPatch,
    buildDiagnosisChips,
    evaluateSafetyBoundary,
    buildConfidenceNoticeCardPayload,
    maybeBuildLegacyTravelRecoEnvelope,
    recordAuroraSkinFlowMetric,
    recordAuroraRecoEntrySource,
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
    AURORA_INGREDIENT_PLAN_ENABLED,
    AURORA_PRODUCT_MATCHER_ENABLED,
    AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED,
    MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION,
  } = deps;

  const {
    runLegacyChatRecoPreflight,
  } = createLegacyChatRecoPreflightRuntime({
    resolveSafetyGateActionV2,
    mergePendingSafetyAdvisory,
    persistSafetyPromptAskedOnce,
    buildLegacyRecoSafetyGateEnvelope,
    buildSafetyNoticeText,
    profileCompleteness,
    buildPendingClarificationForGate,
    emitPendingClarificationPatch,
    buildDiagnosisChips,
    evaluateSafetyBoundary,
    buildConfidenceNoticeCardPayload,
    maybeBuildLegacyTravelRecoEnvelope,
    recordAuroraSkinFlowMetric,
    recordAuroraRecoEntrySource,
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
  });

  async function prepareLegacyChatRecoRequestContext({
    ctx,
    message,
    profile,
    session,
    recentLogs,
    logger,
    identity,
    canonicalIntent,
    safetyDecision,
    includeAlternatives,
    actionId,
    ingredientRecoContext,
    ingredientRecoOptInRequested,
    ingredientActionData,
    ingredientDrivenRecommendationRequested,
    latestRecoContextFromSession,
    recoEntrySourceDetail,
    recoRequestMessage,
    travelSkillsContracts,
    looksLikeLowRiskSkincareTask,
    runAuroraTimedOperation,
    ensureLatestArtifactForConversation,
    ensureAnalysisContextSnapshotForConversation,
    ensureTaskAnalysisContextForConversation,
    getIngredientPlanByArtifactIdForRoute,
    getAuroraStorageReadTimeoutMs,
    saveIngredientPlanForRoute,
    getAuroraStorageWriteTimeoutMs,
  } = {}) {
    let pendingClarificationPatchOverride;

    const preparedLegacyRecoContext = await prepareLegacyChatRecoContext({
      ingredientRecoContext,
      ingredientRecoOptInRequested,
      ingredientActionData,
      message,
      language: ctx.lang,
      recoEntrySourceDetail,
      latestRecoContextFromSession,
      profile,
      session,
      recoRequestMessage,
    });

    let recoIngredientContext = preparedLegacyRecoContext.recoIngredientContext;
    let recoContextIngredientQuery = preparedLegacyRecoContext.recoContextIngredientQuery;
    let recoContextGoal = preparedLegacyRecoContext.recoContextGoal;
    let recoContextSensitivity = preparedLegacyRecoContext.recoContextSensitivity;
    let recoIngredientCandidates = preparedLegacyRecoContext.recoIngredientCandidates;

    const {
      recoProductCandidates,
      travelRecoContext,
      travelRecoHandoff,
      latestRecoContextSeed,
      rawMessageRecoTargetContext,
      shouldApplySessionRecoContext,
      effectiveRecoEntrySourceDetail,
      recoTaskMode,
    } = preparedLegacyRecoContext;

    const preflight = await runLegacyChatRecoPreflight({
      ctx,
      message,
      profile,
      logger,
      canonicalIntent,
      safetyDecision,
      travelRecoHandoff,
      travelSkillsContracts,
      travelRecoContext,
      recoTaskMode,
      recentLogs,
      recoEntrySourceDetail,
      actionId,
      recoRequestMessage,
      includeAlternatives,
      effectiveRecoEntrySourceDetail,
    });
    if (preflight.envelope) {
      return { envelope: preflight.envelope };
    }

    pendingClarificationPatchOverride =
      preflight.pendingClarificationPatchOverride || pendingClarificationPatchOverride;

    const preparedLegacyRecoAnalysisContext = await prepareLegacyChatRecoAnalysisContext({
      ctx,
      logger,
      message,
      profile,
      identity,
      ingredientPlanEnabled: AURORA_INGREDIENT_PLAN_ENABLED,
      productMatcherEnabled: AURORA_PRODUCT_MATCHER_ENABLED,
      nonblockingGateEnabled: AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED,
      ensureLatestArtifactForConversation,
      ensureAnalysisContextSnapshotForConversation,
      ensureTaskAnalysisContextForConversation,
      looksLikeLowRiskSkincareTask,
      recordAuroraSkinFlowMetric,
      runAuroraTimedOperation,
      getIngredientPlanByArtifactIdForRoute,
      getAuroraStorageReadTimeoutMs,
      saveIngredientPlanForRoute,
      getAuroraStorageWriteTimeoutMs,
    });

    const latestArtifact = preparedLegacyRecoAnalysisContext.latestArtifact;
    const artifactGate = preparedLegacyRecoAnalysisContext.artifactGate;
    let mappedIngredientPlan =
      preparedLegacyRecoAnalysisContext.mappedIngredientPlan;

    const preparedLegacyRecoTargeting = prepareLegacyChatRecoTargeting({
      profile,
      mappedIngredientPlan,
      latestArtifact,
      latestRecoContextSeed,
      ingredientDrivenRecommendationRequested,
      travelRecoHandoff,
      recoIngredientContext,
      recoContextIngredientQuery,
      recoContextGoal,
      recoContextSensitivity,
      recoIngredientCandidates,
      ingredientRecoOptInRequested,
      recoRequestMessage,
      message,
      language: ctx.lang,
      effectiveRecoEntrySourceDetail,
      triggerSource: ctx.trigger_source,
      actionId,
      includeAlternatives,
      rawMessageRecoTargetContext,
      minimumRecommendationContextRuleVersion:
        MINIMUM_RECOMMENDATION_CONTEXT_RULE_VERSION,
    });

    recoIngredientContext = preparedLegacyRecoTargeting.recoIngredientContext;
    recoContextIngredientQuery =
      preparedLegacyRecoTargeting.recoContextIngredientQuery;
    recoContextGoal = preparedLegacyRecoTargeting.recoContextGoal;
    recoContextSensitivity = preparedLegacyRecoTargeting.recoContextSensitivity;
    recoIngredientCandidates =
      preparedLegacyRecoTargeting.recoIngredientCandidates;

    return {
      profileScore: preflight.profileScore,
      refinementChips: preflight.refinementChips,
      pendingClarificationPatchOverride,
      analysisContextSnapshotForConversation:
        preparedLegacyRecoAnalysisContext.analysisContextSnapshotForConversation,
      chatAnalysisTaskContext:
        preparedLegacyRecoAnalysisContext.chatAnalysisTaskContext,
      latestArtifact,
      artifactGate,
      mappedIngredientPlan,
      recoIngredientContext,
      recoContextIngredientQuery,
      recoContextGoal,
      recoIngredientCandidates,
      recoProductCandidates,
      travelRecoHandoff,
      shouldApplySessionRecoContext,
      effectiveRecoEntrySourceDetail,
      recoTaskMode,
      recoAutoAnchoredByAnalysis:
        preparedLegacyRecoTargeting.recoAutoAnchoredByAnalysis,
      recoIngredientContextForMainline:
        preparedLegacyRecoTargeting.recoIngredientContextForMainline,
      catalogExternalSeedStrategyForMainline:
        preparedLegacyRecoTargeting.catalogExternalSeedStrategyForMainline,
      recoRequestMessageForMainline:
        preparedLegacyRecoTargeting.recoRequestMessageForMainline,
      recoFocusForMainline:
        preparedLegacyRecoTargeting.recoFocusForMainline,
      chatRecoTargetContext:
        preparedLegacyRecoTargeting.chatRecoTargetContext,
      latestRecoContextPatch:
        preparedLegacyRecoTargeting.latestRecoContextPatch,
      hasDeterministicRecoTarget:
        preparedLegacyRecoTargeting.hasDeterministicRecoTarget,
      hasStableRecoTarget:
        preparedLegacyRecoTargeting.hasStableRecoTarget,
      genericConcernRecoMainline:
        preparedLegacyRecoTargeting.genericConcernRecoMainline,
    };
  }

  return {
    prepareLegacyChatRecoRequestContext,
  };
}

module.exports = {
  createLegacyChatRecoContextPipelineRuntime,
};
