function pickFirstTrimmed(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function createLegacyChatRecoTargetingRuntime(deps = {}) {
  const {
    buildLatestRecoContextFromAnalysisArtifacts,
    mergeIngredientRecoContextValue,
    buildPrimaryIngredientRecoSearchContext,
    buildIngredientOptInRecoRequestText,
    buildAutoAnchoredRecoRequestText,
    resolveRecommendationTargetContext,
    summarizeProfileForContext,
    normalizeRecoContextPrimaryFocus,
    normalizeRecoConfidencePolicy,
    normalizeRecoContextRankedTargets,
    normalizeRecoContextTargetIds,
  } = deps;

  function prepareLegacyChatRecoTargeting({
    profile = null,
    mappedIngredientPlan = null,
    latestArtifact = null,
    latestRecoContextSeed = null,
    ingredientDrivenRecommendationRequested = false,
    travelRecoHandoff = false,
    recoIngredientContext = null,
    recoContextIngredientQuery = '',
    recoContextGoal = '',
    recoContextSensitivity = '',
    recoIngredientCandidates = [],
    ingredientRecoOptInRequested = false,
    recoRequestMessage = '',
    message = '',
    language = 'EN',
    effectiveRecoEntrySourceDetail = '',
    triggerSource = '',
    actionId = '',
    includeAlternatives = false,
    rawMessageRecoTargetContext = null,
    minimumRecommendationContextRuleVersion = 'v1',
  } = {}) {
    const profileSummaryForRecoContext = summarizeProfileForContext(profile);
    const latestRecoContextForRecommendation =
      latestRecoContextSeed ||
      buildLatestRecoContextFromAnalysisArtifacts({
        ingredientPlan: mappedIngredientPlan,
        profileSummary: profileSummaryForRecoContext,
        artifactId: pickFirstTrimmed(latestArtifact && latestArtifact.artifact_id),
        contextOrigin: 'latest_artifact',
        analysisSource: pickFirstTrimmed(
          latestArtifact && latestArtifact.analysis_context && latestArtifact.analysis_context.analysis_source,
        ),
        usePhoto: latestArtifact && latestArtifact.use_photo === true,
        usedPhotos:
          latestArtifact && latestArtifact.analysis_context && latestArtifact.analysis_context.used_photos === true,
        photoQualityGrade: pickFirstTrimmed(
          latestArtifact && latestArtifact.analysis_context && latestArtifact.analysis_context.quality_grade,
        ),
      });
    const shouldApplyAnalysisDerivedRecoContext =
      Boolean(latestRecoContextForRecommendation) &&
      !ingredientDrivenRecommendationRequested &&
      !travelRecoHandoff &&
      !pickFirstTrimmed(
        recoIngredientContext && recoIngredientContext.target_step,
        recoIngredientContext && recoIngredientContext.step,
        recoContextIngredientQuery,
        recoContextGoal,
      ) &&
      !(rawMessageRecoTargetContext && rawMessageRecoTargetContext.step_aware_intent);

    let nextRecoIngredientContext = recoIngredientContext;
    let nextRecoContextIngredientQuery = recoContextIngredientQuery;
    let nextRecoContextGoal = recoContextGoal;
    let nextRecoContextSensitivity = recoContextSensitivity;
    let nextRecoIngredientCandidates = Array.isArray(recoIngredientCandidates) ? recoIngredientCandidates : [];

    if (shouldApplyAnalysisDerivedRecoContext) {
      nextRecoIngredientContext = mergeIngredientRecoContextValue(nextRecoIngredientContext, {
        target_step: pickFirstTrimmed(latestRecoContextForRecommendation.resolved_target_step),
        query: pickFirstTrimmed(latestRecoContextForRecommendation.ingredient_query),
        goal: pickFirstTrimmed(latestRecoContextForRecommendation.goal),
        primary_focus: latestRecoContextForRecommendation.primary_focus,
        confidence_policy: latestRecoContextForRecommendation.confidence_policy,
        ranked_targets: Array.isArray(latestRecoContextForRecommendation.ranked_targets)
          ? latestRecoContextForRecommendation.ranked_targets
          : [],
        primary_target_id: pickFirstTrimmed(latestRecoContextForRecommendation.primary_target_id),
        selected_target_ids: Array.isArray(latestRecoContextForRecommendation.selected_target_ids)
          ? latestRecoContextForRecommendation.selected_target_ids
          : [],
        product_candidates: Array.isArray(latestRecoContextForRecommendation.product_candidates)
          ? latestRecoContextForRecommendation.product_candidates.slice(0, 12)
          : [],
        source: pickFirstTrimmed(latestRecoContextForRecommendation.context_origin, 'analysis_handoff'),
        updated_at_ms: Date.now(),
      });
      nextRecoContextIngredientQuery = pickFirstTrimmed(
        nextRecoIngredientContext && (nextRecoIngredientContext.query || nextRecoIngredientContext.ingredient_query),
      );
      nextRecoContextGoal = pickFirstTrimmed(
        nextRecoIngredientContext && (nextRecoIngredientContext.goal || nextRecoIngredientContext.ingredient_goal),
      );
      nextRecoContextSensitivity = pickFirstTrimmed(
        nextRecoIngredientContext &&
          (nextRecoIngredientContext.sensitivity || nextRecoIngredientContext.ingredient_sensitivity),
      );
      nextRecoIngredientCandidates = Array.isArray(nextRecoIngredientContext?.candidates)
        ? nextRecoIngredientContext.candidates
        : [];
    }

    const recoAutoAnchoredByAnalysis = shouldApplyAnalysisDerivedRecoContext;
    const recoIngredientContextForMainline =
      ingredientRecoOptInRequested && !recoAutoAnchoredByAnalysis
        ? buildPrimaryIngredientRecoSearchContext(nextRecoIngredientContext) || nextRecoIngredientContext
        : nextRecoIngredientContext;
    const catalogExternalSeedStrategyForMainline =
      ingredientRecoOptInRequested && !recoAutoAnchoredByAnalysis ? 'supplement_internal_first' : '';
    const ingredientOptInRecoRequestText =
      ingredientRecoOptInRequested && !recoRequestMessage
        ? buildIngredientOptInRecoRequestText({
            recoContext: recoIngredientContextForMainline,
            language,
          })
        : '';
    const recoRequestMessageForMainline = recoAutoAnchoredByAnalysis
      ? buildAutoAnchoredRecoRequestText({
          rawMessage: recoRequestMessage,
          recoContext: latestRecoContextForRecommendation,
          language,
        })
      : ingredientOptInRecoRequestText || recoRequestMessage;
    const recoFocusForMainline = recoAutoAnchoredByAnalysis
      ? pickFirstTrimmed(
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.resolved_target_step,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.ingredient_query,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.goal,
        )
      : pickFirstTrimmed(
          recoIngredientContextForMainline && recoIngredientContextForMainline.resolved_target_step,
          recoIngredientContextForMainline && recoIngredientContextForMainline.ingredient_query,
          recoIngredientContextForMainline && recoIngredientContextForMainline.query,
          recoIngredientContextForMainline && recoIngredientContextForMainline.goal,
          Array.isArray(recoIngredientContextForMainline && recoIngredientContextForMainline.candidates)
            ? recoIngredientContextForMainline.candidates[0]
            : '',
          Array.isArray(recoIngredientContextForMainline && recoIngredientContextForMainline.ingredient_candidates)
            ? recoIngredientContextForMainline.ingredient_candidates[0]
            : '',
        );
    const chatRecoTargetContext = resolveRecommendationTargetContext({
      explicitStep: pickFirstTrimmed(
        nextRecoIngredientContext && nextRecoIngredientContext.target_step,
        nextRecoIngredientContext && nextRecoIngredientContext.step,
        latestRecoContextForRecommendation && latestRecoContextForRecommendation.resolved_target_step,
      ),
      focus: recoFocusForMainline,
      text: recoRequestMessageForMainline || message,
      entryType: 'chat',
    });
    const latestRecoContextPatch = {
      intent: 'reco_products',
      source_detail: effectiveRecoEntrySourceDetail,
      trigger_source: triggerSource,
      action_id: actionId || '',
      message: recoRequestMessageForMainline || recoRequestMessage || message,
      include_alternatives: includeAlternatives === true,
      ingredient_query:
        pickFirstTrimmed(
          nextRecoContextIngredientQuery,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.ingredient_query,
        ) || '',
      goal:
        pickFirstTrimmed(
          nextRecoContextGoal,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.goal,
        ) || '',
      context_origin:
        pickFirstTrimmed(
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.context_origin,
          latestRecoContextSeed && latestRecoContextSeed.context_origin,
        ) || '',
      resolved_target_step:
        pickFirstTrimmed(
          chatRecoTargetContext && chatRecoTargetContext.resolved_target_step,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.resolved_target_step,
        ) || '',
      resolved_target_step_confidence:
        pickFirstTrimmed(
          chatRecoTargetContext && chatRecoTargetContext.resolved_target_step_confidence,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.resolved_target_step_confidence,
        ) || '',
      resolved_target_step_source:
        pickFirstTrimmed(
          chatRecoTargetContext && chatRecoTargetContext.resolved_target_step_source,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.resolved_target_step_source,
          recoAutoAnchoredByAnalysis ? 'analysis_handoff' : '',
        ) || '',
      artifact_id:
        pickFirstTrimmed(
          latestArtifact && latestArtifact.artifact_id,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.artifact_id,
        ) || '',
      product_candidates: Array.isArray(nextRecoIngredientContext && nextRecoIngredientContext.product_candidates)
        ? nextRecoIngredientContext.product_candidates.slice(0, 12)
        : Array.isArray(latestRecoContextForRecommendation && latestRecoContextForRecommendation.product_candidates)
          ? latestRecoContextForRecommendation.product_candidates.slice(0, 12)
          : [],
      primary_focus:
        normalizeRecoContextPrimaryFocus(
          nextRecoIngredientContext && nextRecoIngredientContext.primary_focus,
        ) ||
        normalizeRecoContextPrimaryFocus(
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.primary_focus,
        ),
      confidence_policy:
        normalizeRecoConfidencePolicy(
          nextRecoIngredientContext && nextRecoIngredientContext.confidence_policy,
        ) ||
        normalizeRecoConfidencePolicy(
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.confidence_policy,
        ),
      ranked_targets: normalizeRecoContextRankedTargets(
        Array.isArray(nextRecoIngredientContext && nextRecoIngredientContext.ranked_targets)
          ? nextRecoIngredientContext.ranked_targets
          : Array.isArray(latestRecoContextForRecommendation && latestRecoContextForRecommendation.ranked_targets)
            ? latestRecoContextForRecommendation.ranked_targets
            : [],
      ),
      primary_target_id:
        pickFirstTrimmed(
          nextRecoIngredientContext && nextRecoIngredientContext.primary_target_id,
          latestRecoContextForRecommendation && latestRecoContextForRecommendation.primary_target_id,
        ) || '',
      selected_target_ids: normalizeRecoContextTargetIds(
        Array.isArray(nextRecoIngredientContext && nextRecoIngredientContext.selected_target_ids)
          ? nextRecoIngredientContext.selected_target_ids
          : Array.isArray(latestRecoContextForRecommendation && latestRecoContextForRecommendation.selected_target_ids)
            ? latestRecoContextForRecommendation.selected_target_ids
            : [],
      ),
    };
    const hasDeterministicRecoTarget = Boolean(
      pickFirstTrimmed(
        chatRecoTargetContext && chatRecoTargetContext.resolved_target_step,
        latestRecoContextPatch.ingredient_query,
        latestRecoContextPatch.goal,
      ),
    );
    const hasStableRecoTarget = Boolean(
      pickFirstTrimmed(
        chatRecoTargetContext && chatRecoTargetContext.resolved_target_step,
        latestRecoContextPatch.ingredient_query,
      ),
    );
    const genericConcernRecoMainline =
      String(chatRecoTargetContext?.intent_mode || '').trim().toLowerCase() === 'generic_concern' ||
      (chatRecoTargetContext &&
        Array.isArray(chatRecoTargetContext.framework_roles) &&
        chatRecoTargetContext.framework_roles.length > 0);
    const hasExplicitRecoTarget = Boolean(
      chatRecoTargetContext &&
        chatRecoTargetContext.step_aware_intent &&
        chatRecoTargetContext.resolved_target_step,
    );
    const genericGoalDrivenNeedsMoreContext =
      !genericConcernRecoMainline &&
      !hasStableRecoTarget &&
      !hasExplicitRecoTarget &&
      !ingredientDrivenRecommendationRequested &&
      !travelRecoHandoff;
    const genericGoalDrivenNeedsMoreContextWarning = genericGoalDrivenNeedsMoreContext
      ? {
          minimum_recommendation_context_warning: true,
          minimum_recommendation_context_reason: 'minimum_recommendation_context_unsatisfied',
          minimum_recommendation_context_missing: ['minimum_recommendation_context'],
          minimum_recommendation_context_rule_version: minimumRecommendationContextRuleVersion,
        }
      : null;

    return {
      profileSummaryForRecoContext,
      latestRecoContextForRecommendation,
      shouldApplyAnalysisDerivedRecoContext,
      recoIngredientContext: nextRecoIngredientContext,
      recoContextIngredientQuery: nextRecoContextIngredientQuery,
      recoContextGoal: nextRecoContextGoal,
      recoContextSensitivity: nextRecoContextSensitivity,
      recoIngredientCandidates: nextRecoIngredientCandidates,
      recoAutoAnchoredByAnalysis,
      recoIngredientContextForMainline,
      catalogExternalSeedStrategyForMainline,
      recoRequestMessageForMainline,
      recoFocusForMainline,
      chatRecoTargetContext,
      latestRecoContextPatch,
      hasDeterministicRecoTarget,
      hasStableRecoTarget,
      genericConcernRecoMainline,
      genericGoalDrivenNeedsMoreContext,
      genericGoalDrivenNeedsMoreContextWarning,
    };
  }

  return {
    prepareLegacyChatRecoTargeting,
  };
}

module.exports = {
  createLegacyChatRecoTargetingRuntime,
};
