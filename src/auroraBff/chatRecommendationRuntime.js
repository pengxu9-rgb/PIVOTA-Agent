function createChatRecommendationRuntime(options = {}) {
  const {
    looksLikeIngredientScienceIntent = () => false,
    looksLikeRoutineRequest = () => false,
    looksLikeSuitabilityRequest = () => false,
    looksLikeRecommendationRequest = () => false,
    chatRecoPreludeRuntime,
    chatRecoArtifactRuntime,
    chatRecoResolveRuntime,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat recommendation runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function maybeBuildRecommendationEnvelope(args = {}) {
    const {
      forceUpstreamAfterPendingAbandon = false,
      allowRecoCards = false,
      message = '',
      normalizedActionPayload = null,
      ingredientRecoOptInRequested = false,
      actionId = '',
      budgetChipCanContinueReco = false,
      profileClarificationAction = false,
      ingredientDrivenRecommendationRequested = false,
      shouldAutoRerunRecommendationsFromProfilePatch = false,
      recoInteractionAllowed = false,
      ingredientRecoContext = null,
      ingredientActionData = null,
      ctx,
      recoEntrySourceDetail = '',
      safetyDecision = null,
      profile = null,
      identity = {},
      pendingSafetyAdvisory = null,
      pushGateDecision,
      enqueueGateAdvisory,
      pendingClarificationPatchOverride,
      buildDiagnosisChips,
      chatSafetyRuntime,
      chatDiagnosisGateRuntime,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      canonicalIntent = null,
      session = null,
      recentLogs = [],
      includeAlternatives = false,
      debugUpstream = false,
      recoRequestMessage = '',
      buildSafetyNoticeText = () => '',
    } = args;

    const prepareRecoRequestPrelude = requireMethod(
      chatRecoPreludeRuntime,
      'chatRecoPreludeRuntime',
      'prepareRecoRequestPrelude',
    );
    const prepareRecoArtifactContext = requireMethod(
      chatRecoArtifactRuntime,
      'chatRecoArtifactRuntime',
      'prepareRecoArtifactContext',
    );
    const resolveRecoEnvelope = requireMethod(
      chatRecoResolveRuntime,
      'chatRecoResolveRuntime',
      'resolveRecoEnvelope',
    );

    const wantsProductRecommendations =
      !forceUpstreamAfterPendingAbandon &&
      allowRecoCards &&
      (!looksLikeIngredientScienceIntent(message, normalizedActionPayload) || ingredientRecoOptInRequested) &&
      !looksLikeRoutineRequest(message, normalizedActionPayload) &&
      !looksLikeSuitabilityRequest(message) &&
      recoInteractionAllowed &&
      (
        actionId === 'chip.start.reco_products' ||
        actionId === 'chip_get_recos' ||
        budgetChipCanContinueReco ||
        profileClarificationAction ||
        ingredientDrivenRecommendationRequested ||
        looksLikeRecommendationRequest(message) ||
        shouldAutoRerunRecommendationsFromProfilePatch
      );

    if (!wantsProductRecommendations) {
      return {
        handled: false,
        envelope: null,
        ingredientRecoContext,
        profile,
        pendingSafetyAdvisory,
        pendingClarificationPatchOverride,
      };
    }

    const recoPrelude = await prepareRecoRequestPrelude({
      ingredientRecoContext,
      ingredientRecoOptInRequested,
      ingredientActionData,
      message,
      ctx,
      recoEntrySourceDetail,
      safetyDecision,
      profile,
      identity,
      pendingSafetyAdvisory,
      pushGateDecision,
      enqueueGateAdvisory,
      pendingClarificationPatchOverride,
      buildDiagnosisChips,
      chatSafetyRuntime,
      chatDiagnosisGateRuntime,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
      canonicalIntent,
    });

    const nextIngredientRecoContext = recoPrelude.recoIngredientContext;
    const nextProfile = recoPrelude.profile;
    const nextPendingSafetyAdvisory = recoPrelude.pendingSafetyAdvisory;
    const nextPendingClarificationPatchOverride = recoPrelude.pendingClarificationPatchOverride;

    if (recoPrelude.blockedEnvelope) {
      return {
        handled: true,
        envelope: recoPrelude.blockedEnvelope,
        ingredientRecoContext: nextIngredientRecoContext,
        profile: nextProfile,
        pendingSafetyAdvisory: nextPendingSafetyAdvisory,
        pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
      };
    }

    const {
      latestArtifact,
      mappedIngredientPlan,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      artifactGateOk,
      lowConfidenceArtifact,
    } = await prepareRecoArtifactContext({
      ctx,
      session,
      message,
      profile: nextProfile,
      identity,
      refinementChips: recoPrelude.refinementChips,
      pushGateDecision,
      enqueueGateAdvisory,
    });

    const safetyWarnText =
      safetyDecision && String(safetyDecision.block_level || '').trim().toLowerCase() === 'warn'
        ? String(buildSafetyNoticeText(safetyDecision) || '')
        : '';

    const envelope = await resolveRecoEnvelope({
      ctx,
      profile: nextProfile,
      recentLogs,
      message,
      recoIngredientContext: nextIngredientRecoContext,
      includeAlternatives,
      debugUpstream,
      latestArtifact,
      mappedIngredientPlan,
      recoEntrySourceDetail,
      actionId,
      recoRequestMessage,
      recoContextIngredientQuery: recoPrelude.recoContextIngredientQuery,
      recoContextGoal: recoPrelude.recoContextGoal,
      recoIngredientCandidates: recoPrelude.recoIngredientCandidates,
      recoProductCandidates: recoPrelude.recoProductCandidates,
      recoTaskMode: recoPrelude.recoTaskMode,
      identity,
      artifactConfidenceLevel,
      artifactConfidenceScore,
      artifactGateOk,
      lowConfidenceArtifact,
      refinementChips: recoPrelude.refinementChips,
      profileScore: recoPrelude.profileScore,
      shouldAutoRerunRecommendationsFromProfilePatch,
      ingredientRecoOptInRequested,
      safetyWarnText,
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });

    return {
      handled: true,
      envelope,
      ingredientRecoContext: nextIngredientRecoContext,
      profile: nextProfile,
      pendingSafetyAdvisory: nextPendingSafetyAdvisory,
      pendingClarificationPatchOverride: nextPendingClarificationPatchOverride,
    };
  }

  return {
    maybeBuildRecommendationEnvelope,
  };
}

module.exports = {
  createChatRecommendationRuntime,
};
