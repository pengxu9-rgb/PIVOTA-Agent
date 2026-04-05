function createBeautyChatLegacyIsolationRuntime(deps = {}) {
  const {
    RECO_CATALOG_GROUNDED_ENABLED = false,
    looksLikeIngredientScienceIntent,
    looksLikeRoutineRequest,
    looksLikeSuitabilityRequest,
    looksLikeRecommendationRequest,
  } = deps;

  function shouldBlockLegacyBeautyOwnedRecoRoute({
    forceUpstreamAfterPendingAbandon = false,
    ingredientDrivenRecommendationRequested = false,
    recoEntrySourceDetail = '',
    typedRecoOwnershipKeepsV1Mainline = false,
    actionId = '',
    message = '',
    hasRecoContextForAutoRerun = false,
    budgetChipCanContinueReco = false,
    profileClarificationAction = false,
    shouldAutoRerunRecommendationsFromProfilePatch = false,
  } = {}) {
    return (
      RECO_CATALOG_GROUNDED_ENABLED &&
      !forceUpstreamAfterPendingAbandon &&
      !ingredientDrivenRecommendationRequested &&
      recoEntrySourceDetail !== 'travel_handoff' &&
      (
        typedRecoOwnershipKeepsV1Mainline ||
        actionId === 'chip.start.reco_products' ||
        actionId === 'chip_get_recos' ||
        (typeof looksLikeRecommendationRequest === 'function'
          ? looksLikeRecommendationRequest(message)
          : false) ||
        (
          hasRecoContextForAutoRerun &&
          (
            budgetChipCanContinueReco ||
            profileClarificationAction ||
            shouldAutoRerunRecommendationsFromProfilePatch
          )
        )
      )
    );
  }

  function shouldEnterLegacyProductRecommendations({
    forceUpstreamAfterPendingAbandon = false,
    allowRecoCards = false,
    legacyBeautyOwnedRecoRouteBlocked = false,
    message = '',
    normalizedActionPayload = null,
    ingredientRecoOptInRequested = false,
    recoInteractionAllowed = false,
    actionId = '',
    budgetChipCanContinueReco = false,
    profileClarificationAction = false,
    ingredientDrivenRecommendationRequested = false,
    shouldAutoRerunRecommendationsFromProfilePatch = false,
  } = {}) {
    return (
      !forceUpstreamAfterPendingAbandon &&
      allowRecoCards &&
      !legacyBeautyOwnedRecoRouteBlocked &&
      (
        typeof looksLikeIngredientScienceIntent !== 'function' ||
        !looksLikeIngredientScienceIntent(message, normalizedActionPayload) ||
        ingredientRecoOptInRequested
      ) &&
      (
        typeof looksLikeRoutineRequest !== 'function' ||
        !looksLikeRoutineRequest(message, normalizedActionPayload)
      ) &&
      (
        typeof looksLikeSuitabilityRequest !== 'function' ||
        !looksLikeSuitabilityRequest(message)
      ) &&
      recoInteractionAllowed &&
      (
        actionId === 'chip.start.reco_products' ||
        actionId === 'chip_get_recos' ||
        budgetChipCanContinueReco ||
        profileClarificationAction ||
        ingredientDrivenRecommendationRequested ||
        (typeof looksLikeRecommendationRequest === 'function'
          ? looksLikeRecommendationRequest(message)
          : false) ||
        shouldAutoRerunRecommendationsFromProfilePatch
      )
    );
  }

  function shouldUseLegacyVerifiedContextRestore({
    ingredientRecoOptInRequested = false,
    travelRecoHandoff = false,
    shouldApplySessionRecoContext = false,
    recoAutoAnchoredByAnalysis = false,
    effectiveRecoEntrySourceDetail = '',
    hasStableRecoTarget = false,
    recoContext = null,
  } = {}) {
    return (
      !ingredientRecoOptInRequested &&
      !travelRecoHandoff &&
      Boolean(
        shouldApplySessionRecoContext ||
        recoAutoAnchoredByAnalysis ||
        effectiveRecoEntrySourceDetail === 'analysis_handoff'
      ) &&
      hasStableRecoTarget &&
      Array.isArray(recoContext?.product_candidates) &&
      recoContext.product_candidates.length > 0
    );
  }

  return {
    shouldBlockLegacyBeautyOwnedRecoRoute,
    shouldEnterLegacyProductRecommendations,
    shouldUseLegacyVerifiedContextRestore,
  };
}

module.exports = {
  createBeautyChatLegacyIsolationRuntime,
};
