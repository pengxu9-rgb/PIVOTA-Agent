function pickFirstTrimmed(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function createLegacyChatRecoPreparationRuntime(deps = {}) {
  const {
    mergeIngredientRecoContextValue,
    normalizeIngredientCandidateList,
    extractIngredientLookupTargetFromText,
    buildTravelRecoHandoffContext,
    resolveRecommendationTargetContext,
  } = deps;

  async function prepareLegacyChatRecoContext({
    ingredientRecoContext = null,
    ingredientRecoOptInRequested = false,
    ingredientActionData = null,
    message = '',
    language = 'EN',
    recoEntrySourceDetail = '',
    latestRecoContextFromSession = null,
    profile = null,
    session = null,
    recoRequestMessage = '',
  } = {}) {
    let nextRecoIngredientContext = mergeIngredientRecoContextValue(
      ingredientRecoContext,
      ingredientRecoOptInRequested
        ? {
            query: pickFirstTrimmed(
              ingredientActionData && ingredientActionData.ingredient_query,
              ingredientActionData && ingredientActionData.ingredientQuery,
              ingredientActionData && ingredientActionData.inci,
              ingredientActionData && ingredientActionData.ingredient_name,
            ),
            goal: pickFirstTrimmed(
              ingredientActionData && ingredientActionData.ingredient_goal,
              ingredientActionData && ingredientActionData.ingredientGoal,
              ingredientActionData && ingredientActionData.goal,
            ),
            candidates: normalizeIngredientCandidateList(
              (ingredientActionData &&
                (
                  ingredientActionData.ingredient_candidates ||
                  ingredientActionData.ingredientCandidates ||
                  ingredientActionData.candidates
                )) || [],
              8,
            ),
            product_candidates: Array.isArray(
              ingredientActionData &&
                (ingredientActionData.product_candidates || ingredientActionData.productCandidates),
            )
              ? (ingredientActionData.product_candidates || ingredientActionData.productCandidates).slice(0, 12)
              : [],
            sensitivity: pickFirstTrimmed(
              ingredientActionData && ingredientActionData.ingredient_sensitivity,
              ingredientActionData && ingredientActionData.ingredientSensitivity,
              ingredientActionData && ingredientActionData.sensitivity,
            ),
            source: pickFirstTrimmed(
              ingredientActionData && ingredientActionData.entry_source,
              ingredientActionData && ingredientActionData.trigger_source,
              'ingredient_reco_optin',
            ),
            updated_at_ms: Date.now(),
          }
        : null,
    );
    if (!nextRecoIngredientContext) {
      const lookupTargetFromRecoText = await extractIngredientLookupTargetFromText(message, language);
      nextRecoIngredientContext = mergeIngredientRecoContextValue(nextRecoIngredientContext, {
        query: lookupTargetFromRecoText,
        source: lookupTargetFromRecoText ? 'text_reco' : '',
        updated_at_ms: lookupTargetFromRecoText ? Date.now() : 0,
      });
    }

    let recoContextIngredientQuery = pickFirstTrimmed(
      nextRecoIngredientContext && (nextRecoIngredientContext.query || nextRecoIngredientContext.ingredient_query),
    );
    let recoContextGoal = pickFirstTrimmed(
      nextRecoIngredientContext && (nextRecoIngredientContext.goal || nextRecoIngredientContext.ingredient_goal),
    );
    let recoContextSensitivity = pickFirstTrimmed(
      nextRecoIngredientContext &&
        (nextRecoIngredientContext.sensitivity || nextRecoIngredientContext.ingredient_sensitivity),
    );
    let recoIngredientCandidates = Array.isArray(nextRecoIngredientContext?.candidates)
      ? nextRecoIngredientContext.candidates
      : [];
    const recoProductCandidates = Array.isArray(
      ingredientActionData?.product_candidates || ingredientActionData?.productCandidates,
    )
      ? ingredientActionData.product_candidates || ingredientActionData.productCandidates
      : [];
    const travelRecoContext = buildTravelRecoHandoffContext({
      session,
      profile,
    });
    const travelRecoHandoff =
      recoEntrySourceDetail === 'travel_handoff' && !ingredientRecoOptInRequested;
    const latestRecoContextSeed =
      latestRecoContextFromSession &&
      String(latestRecoContextFromSession.intent || '').trim().toLowerCase() === 'reco_products'
        ? latestRecoContextFromSession
        : null;
    const rawMessageRecoTargetContext = resolveRecommendationTargetContext({
      explicitStep: pickFirstTrimmed(
        nextRecoIngredientContext && nextRecoIngredientContext.target_step,
        nextRecoIngredientContext && nextRecoIngredientContext.step,
      ),
      focus: '',
      text: recoRequestMessage || message,
      entryType: 'chat',
    });
    const hasExplicitUserRecoContext = Boolean(
      pickFirstTrimmed(
        nextRecoIngredientContext && nextRecoIngredientContext.target_step,
        nextRecoIngredientContext && nextRecoIngredientContext.step,
        recoContextIngredientQuery,
        recoContextGoal,
      ) || (rawMessageRecoTargetContext && rawMessageRecoTargetContext.step_aware_intent),
    );
    const shouldApplySessionRecoContext =
      Boolean(latestRecoContextSeed) &&
      !ingredientRecoOptInRequested &&
      !travelRecoHandoff &&
      !hasExplicitUserRecoContext;
    if (shouldApplySessionRecoContext) {
      nextRecoIngredientContext = mergeIngredientRecoContextValue(nextRecoIngredientContext, {
        target_step: pickFirstTrimmed(latestRecoContextSeed.resolved_target_step),
        query: pickFirstTrimmed(latestRecoContextSeed.ingredient_query),
        goal: pickFirstTrimmed(latestRecoContextSeed.goal),
        primary_focus: latestRecoContextSeed.primary_focus,
        confidence_policy: latestRecoContextSeed.confidence_policy,
        ranked_targets: Array.isArray(latestRecoContextSeed.ranked_targets)
          ? latestRecoContextSeed.ranked_targets
          : [],
        primary_target_id: pickFirstTrimmed(latestRecoContextSeed.primary_target_id),
        selected_target_ids: Array.isArray(latestRecoContextSeed.selected_target_ids)
          ? latestRecoContextSeed.selected_target_ids
          : [],
        product_candidates: Array.isArray(latestRecoContextSeed.product_candidates)
          ? latestRecoContextSeed.product_candidates.slice(0, 12)
          : [],
        source: pickFirstTrimmed(latestRecoContextSeed.context_origin, 'analysis_handoff'),
        updated_at_ms: Date.now(),
      });
      recoContextIngredientQuery = pickFirstTrimmed(
        nextRecoIngredientContext &&
          (nextRecoIngredientContext.query || nextRecoIngredientContext.ingredient_query),
      );
      recoContextGoal = pickFirstTrimmed(
        nextRecoIngredientContext &&
          (nextRecoIngredientContext.goal || nextRecoIngredientContext.ingredient_goal),
      );
      recoContextSensitivity = pickFirstTrimmed(
        nextRecoIngredientContext &&
          (nextRecoIngredientContext.sensitivity || nextRecoIngredientContext.ingredient_sensitivity),
      );
      recoIngredientCandidates = Array.isArray(nextRecoIngredientContext?.candidates)
        ? nextRecoIngredientContext.candidates
        : [];
    }
    const effectiveRecoEntrySourceDetail = shouldApplySessionRecoContext
      ? 'analysis_handoff'
      : recoEntrySourceDetail;
    const recoTaskMode = ingredientRecoOptInRequested
      ? (recoProductCandidates.length > 0
        ? 'ingredient_filtered_products'
        : recoIngredientCandidates.length > 0
          ? 'ingredient_filtered_products'
          : 'ingredient_lookup_no_candidates')
      : travelRecoHandoff
        ? 'travel_readiness_products'
        : 'goal_based_products';

    return {
      recoIngredientContext: nextRecoIngredientContext,
      recoContextIngredientQuery,
      recoContextGoal,
      recoContextSensitivity,
      recoIngredientCandidates,
      recoProductCandidates,
      travelRecoContext,
      travelRecoHandoff,
      latestRecoContextSeed,
      rawMessageRecoTargetContext,
      hasExplicitUserRecoContext,
      shouldApplySessionRecoContext,
      effectiveRecoEntrySourceDetail,
      recoTaskMode,
    };
  }

  return {
    prepareLegacyChatRecoContext,
  };
}

module.exports = {
  createLegacyChatRecoPreparationRuntime,
};
