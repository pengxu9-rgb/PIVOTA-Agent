function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function createLegacyChatRecoExecutionRuntime(deps = {}) {
  const {
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
  } = deps;

  async function executeLegacyChatReco({
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
    AURORA_BFF_CHAT_RECO_BUDGET_MS,
  } = {}) {
    let norm = null;
    let upstreamDebug = null;
    let alternativesDebug = null;
    let recoTimeoutDegraded = false;
    let recoTimeoutDegradedWarning = null;
    let upstreamFailureCode = '';
    let llmFailureClass = '';
    let recoLlmTrace = null;
    let recoContract = null;
    let recoMainlineStatus = '';
    let recoCatalogSkipReason = '';
    let recoTelemetryFailureReason = '';
    let recoSource = '';
    let upstreamReco = null;
    let verifiedCandidateRestoreApplied = false;
    let verifiedCandidateRestoreCount = 0;

    const shouldShortCircuitVerifiedContextRestore = shouldUseLegacyVerifiedContextRestore({
      ingredientRecoOptInRequested,
      travelRecoHandoff,
      shouldApplySessionRecoContext,
      recoAutoAnchoredByAnalysis,
      effectiveRecoEntrySourceDetail,
      hasStableRecoTarget,
      recoContext: recoIngredientContext || latestRecoContextPatch,
    });
    if (shouldShortCircuitVerifiedContextRestore) {
      const restoredFromVerifiedCandidates = restoreRecoRecommendationsFromVerifiedContextCandidates({
        recoContext: recoIngredientContext || latestRecoContextPatch,
        targetContext: chatRecoTargetContext,
        language: ctx.lang,
      });
      const restoredRecommendations = Array.isArray(restoredFromVerifiedCandidates?.recommendations)
        ? restoredFromVerifiedCandidates.recommendations
        : [];
      if (restoredRecommendations.length > 0) {
        verifiedCandidateRestoreApplied = true;
        verifiedCandidateRestoreCount = restoredRecommendations.length;
        const restoredPayload = applyVerifiedCandidateRestoreToRecoPayload({
          intent: 'reco_products',
          profile: summarizeProfileForContext(profile),
          recommendations: [],
          source: 'catalog_grounded_v1',
          task_mode: recoTaskMode,
          recommendation_confidence_score: artifactConfidenceScore != null ? artifactConfidenceScore : 0.61,
          recommendation_confidence_level:
            artifactConfidenceLevel && artifactConfidenceLevel !== 'unknown'
              ? artifactConfidenceLevel
              : 'medium',
          recommendation_meta: {
            task_mode: recoTaskMode,
            trigger_source: normalizeRecoSourceDetail(effectiveRecoEntrySourceDetail),
            used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
            used_itinerary: Boolean(profile && (profile.itinerary || profile.travel_plan || profile.travel_plans)),
            used_safety_flags: lowConfidenceArtifact,
          },
        }, restoredRecommendations);
        norm = {
          payload: restoredPayload.payload,
          field_missing: [],
        };
        recoSource = 'catalog_grounded_v1';
        recoMainlineStatus = 'grounded_success';
        recoTelemetryFailureReason = '';
      }
    }

    const normHasRecommendations =
      Array.isArray(norm?.payload?.recommendations) && norm.payload.recommendations.length > 0;
    const shouldAttemptIngredientOptInCatalogRecovery =
      ingredientRecoOptInRequested
      && !travelRecoHandoff
      && Boolean(pickFirstTrimmed(recoContextIngredientQuery, recoContextGoal) || recoIngredientCandidates.length > 0)
      && !normHasRecommendations;

    if (
      (!norm || shouldAttemptIngredientOptInCatalogRecovery)
      && (!matcherPayload || !Array.isArray(matcherPayload.recommendations) || matcherPayload.recommendations.length === 0)
    ) {
      try {
        upstreamReco = await generateProductRecommendations({
          ctx,
          profile,
          recentLogs,
          message: recoRequestMessageForMainline || message,
          focus: recoFocusForMainline,
          ingredientContext: recoIngredientContextForMainline,
          analysisContextSnapshot: analysisContextSnapshotForConversation,
          requestOverride: requestScopedProfileOverride,
          includeAlternatives,
          debug: debugUpstream,
          logger,
          budgetMs: AURORA_BFF_CHAT_RECO_BUDGET_MS,
          entryType: 'chat',
          catalogExternalSeedStrategy: catalogExternalSeedStrategyForMainline,
        });
        norm = upstreamReco.norm;
        upstreamDebug = upstreamReco.upstreamDebug;
        alternativesDebug = upstreamReco.alternativesDebug;
        upstreamFailureCode = String(upstreamReco.upstreamFailureCode || '').trim().toUpperCase();
        llmFailureClass = normalizeRecoFailureClass(upstreamReco.llmFailureClass || '');
        recoLlmTrace = isPlainObject(upstreamReco.llmTrace) ? upstreamReco.llmTrace : null;
        recoContract = isPlainObject(upstreamReco.contract) ? upstreamReco.contract : null;
        recoMainlineStatus = String(upstreamReco.mainlineStatus || '').trim();
        recoCatalogSkipReason = String(upstreamReco.catalogSkipReason || '').trim();
        recoTelemetryFailureReason = String(upstreamReco.telemetryFailureReason || '').trim();

        const selectedIngredientCandidates =
          ingredientRecoOptInRequested
            ? extractRecoContextProductCandidatesFromCandidatePoolState(upstreamReco.candidatePoolState, { max: 12 })
            : [];
        if (
          ingredientRecoOptInRequested
          && selectedIngredientCandidates.length > 0
          && (!Array.isArray(recoIngredientContext?.product_candidates) || recoIngredientContext.product_candidates.length === 0)
        ) {
          const ingredientContextOrigin = pickFirstTrimmed(
            recoIngredientContext && recoIngredientContext.context_origin,
            latestRecoContextPatch && latestRecoContextPatch.context_origin,
            effectiveRecoEntrySourceDetail,
            'ingredient_goal_match',
          ) || 'ingredient_goal_match';
          const inferredIngredientStep = normalizeRecoTargetStep(
            pickFirstTrimmed(
              chatRecoTargetContext && chatRecoTargetContext.resolved_target_step,
              recoIngredientContext && recoIngredientContext.resolved_target_step,
              recoIngredientContext && recoIngredientContext.target_step,
              recoIngredientContext && recoIngredientContext.step,
              selectedIngredientCandidates[0] && (selectedIngredientCandidates[0].product_type || selectedIngredientCandidates[0].category),
            ),
          ) || '';
          const inferredTargetBundle = buildIngredientRecoContextTargetBundle({
            ingredientQuery: recoContextIngredientQuery,
            candidates: recoIngredientCandidates,
            goal: recoContextGoal,
            resolvedTargetStep: inferredIngredientStep,
            source: ingredientContextOrigin,
          });
          const effectiveStepConfidence = (() => {
            const raw = String(pickFirstTrimmed(
              recoIngredientContext && recoIngredientContext.resolved_target_step_confidence,
              latestRecoContextPatch && latestRecoContextPatch.resolved_target_step_confidence,
            ) || '').trim().toLowerCase();
            return raw && raw !== 'none' ? raw : 'medium';
          })();
          const effectiveStepSource = (() => {
            const raw = String(pickFirstTrimmed(
              recoIngredientContext && recoIngredientContext.resolved_target_step_source,
              latestRecoContextPatch && latestRecoContextPatch.resolved_target_step_source,
            ) || '').trim().toLowerCase();
            return raw && raw !== 'none' ? raw : 'catalog_candidate_state';
          })();
          recoIngredientContext = mergeIngredientRecoContextValue(recoIngredientContext, {
            product_candidates: selectedIngredientCandidates,
            context_origin: ingredientContextOrigin,
            ...inferredTargetBundle,
            ...(inferredIngredientStep
              ? {
                  resolved_target_step: inferredIngredientStep,
                  target_step: inferredIngredientStep,
                  step: inferredIngredientStep,
                  resolved_target_step_confidence: effectiveStepConfidence,
                  resolved_target_step_source: effectiveStepSource,
                }
              : {}),
            updated_at_ms: Date.now(),
          });
          latestRecoContextPatch = mergeIngredientRecoContextValue(latestRecoContextPatch, {
            product_candidates: selectedIngredientCandidates,
            context_origin: ingredientContextOrigin,
            ...inferredTargetBundle,
            ...(inferredIngredientStep
              ? {
                  resolved_target_step: inferredIngredientStep,
                  target_step: inferredIngredientStep,
                  step: inferredIngredientStep,
                  resolved_target_step_confidence: effectiveStepConfidence,
                  resolved_target_step_source: effectiveStepSource,
                }
              : {}),
            updated_at_ms: Date.now(),
          });
        }
      } catch (err) {
        const transientCode = classifyRecoUpstreamFailureCode(err);
        if (!isTransientRecoUpstreamFailureCode(transientCode)) {
          throw err;
        }
        recoTimeoutDegraded = true;
        llmFailureClass = 'timeout';
        upstreamFailureCode = transientCode || '';
        recoMainlineStatus = 'upstream_timeout';
        recoTelemetryFailureReason = 'timeout_degraded';
        recordAuroraRecoLlmCall({ stage: 'main', outcome: 'timeout' });
        logger?.warn(
          {
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
            budget_ms: AURORA_BFF_CHAT_RECO_BUDGET_MS,
            transient_code: transientCode || null,
          },
          'aurora bff: reco upstream timeout/transient failure, degraded to confidence_notice',
        );
      }
    }

    return {
      norm,
      upstreamDebug,
      alternativesDebug,
      recoTimeoutDegraded,
      recoTimeoutDegradedWarning,
      upstreamFailureCode,
      llmFailureClass,
      recoLlmTrace,
      recoContract,
      recoMainlineStatus,
      recoCatalogSkipReason,
      recoTelemetryFailureReason,
      recoSource,
      upstreamReco,
      verifiedCandidateRestoreApplied,
      verifiedCandidateRestoreCount,
      recoIngredientContext,
      latestRecoContextPatch,
    };
  }

  return {
    executeLegacyChatReco,
  };
}

module.exports = {
  createLegacyChatRecoExecutionRuntime,
};
