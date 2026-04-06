function createLegacyRecoFrameworkPassRuntime(deps = {}) {
  const {
    isPlainObject,
    pickFirstTrimmed,
    pickFirstString,
    asStringArray,
    uniqCaseInsensitiveStrings,
    runConcernSelectorRace,
    applyConcernSelectorRaceOrdering,
  } = deps;

  async function runLegacyRecoFrameworkPass({
    frameworkMode = false,
    targetContext = null,
    concernSemanticPlanBlockedReason = '',
    viablePoolState = null,
    payload = null,
    ctx,
    logger,
    userAsk = '',
    applyLegacyRecoPdpEnrichment,
    deadlineAtMs = null,
    pdpFastExternalFallbackReasonCode = null,
    RECO_PDP_LIGHT_ENRICH_ENABLED = false,
  } = {}) {
    let nextPayload = isPlainObject(payload) ? { ...payload } : payload;
    const metrics = {
      selectorRaceTrace: null,
      winnerSource: 'deterministic',
      supportRolesSurfaced: [],
      selectorRaceApplied: false,
      frameworkMainlineWarningNonBlocking: false,
      pdpEnrichmentApplied: false,
      selectorRaceLatencyMs: 0,
      pdpLatencyMs: 0,
    };

    if (
      frameworkMode &&
      isPlainObject(targetContext?.semantic_plan) &&
      !concernSemanticPlanBlockedReason &&
      viablePoolState?.primary_role_matched === true
    ) {
      const baseRecommendations = Array.isArray(nextPayload?.recommendations)
        ? nextPayload.recommendations
        : [];
      const selectorStartedAt = Date.now();
      const selectorOut = await runConcernSelectorRace({
        ctx,
        logger,
        requestText: userAsk,
        semanticPlan: targetContext.semantic_plan,
        recommendations: baseRecommendations,
      });
      metrics.selectorRaceLatencyMs = Math.max(0, Date.now() - selectorStartedAt);
      metrics.selectorRaceApplied = true;
      metrics.selectorRaceTrace = {
        ...(selectorOut.trace || {}),
        result: selectorOut.result || null,
      };
      const selectorApplied = applyConcernSelectorRaceOrdering(
        baseRecommendations,
        selectorOut.result,
      );
      metrics.winnerSource = selectorApplied.winner_source || 'deterministic';
      metrics.supportRolesSurfaced =
        selectorApplied.support_roles_surfaced || [];
      if (
        Array.isArray(selectorApplied.recommendations) &&
        selectorApplied.recommendations.length
      ) {
        const selectionNotesByProductId = isPlainObject(
          selectorApplied.selection_notes_by_product_id,
        )
          ? selectorApplied.selection_notes_by_product_id
          : {};
        nextPayload = {
          ...nextPayload,
          recommendations: selectorApplied.recommendations.map((row) => {
            const productId = pickFirstString(row?.product_id, row?.productId);
            const selectionNotes = productId
              ? asStringArray(selectionNotesByProductId[productId], 3)
              : [];
            if (!selectionNotes.length) return row;
            return {
              ...row,
              notes: uniqCaseInsensitiveStrings(
                [...selectionNotes, ...asStringArray(row?.notes, 4)],
                5,
              ),
            };
          }),
          primary_recommendation_id:
            selectorApplied.primary_recommendation_id ||
            nextPayload.primary_recommendation_id ||
            null,
        };
      }
    }

    if (
      frameworkMode &&
      !concernSemanticPlanBlockedReason &&
      viablePoolState?.primary_role_matched !== true
    ) {
      const frameworkWarningReason =
        pickFirstTrimmed(
          nextPayload?.products_empty_reason,
          viablePoolState?.candidate_drop_stage,
          viablePoolState?.weak_viable_pool ? 'weak_viable_pool' : '',
          'weak_viable_pool',
        ) || 'weak_viable_pool';
      if (
        Array.isArray(nextPayload?.recommendations) &&
        nextPayload.recommendations.length > 0
      ) {
        metrics.frameworkMainlineWarningNonBlocking = true;
        nextPayload = {
          ...nextPayload,
          mainline_status:
            pickFirstTrimmed(nextPayload?.mainline_status, 'grounded_success') ||
            'grounded_success',
          recommendation_meta: {
            ...(isPlainObject(nextPayload?.recommendation_meta)
              ? nextPayload.recommendation_meta
              : {}),
            framework_mainline_warning_reason: frameworkWarningReason,
            framework_mainline_warning_non_blocking: true,
          },
          metadata: {
            ...(isPlainObject(nextPayload?.metadata) ? nextPayload.metadata : {}),
            framework_mainline_warning_reason: frameworkWarningReason,
            framework_mainline_warning_non_blocking: true,
          },
        };
      } else {
        nextPayload = {
          ...nextPayload,
          recommendations: [],
          primary_recommendation_id: null,
          products_empty_reason: frameworkWarningReason,
        };
      }
      metrics.winnerSource = 'deterministic';
      metrics.supportRolesSurfaced = [];
    }

    if (
      frameworkMode &&
      Array.isArray(nextPayload?.recommendations) &&
      nextPayload.recommendations.length > 0
    ) {
      const pdpEnriched = await applyLegacyRecoPdpEnrichment({
        payload: nextPayload,
        recommendations: nextPayload.recommendations,
        deadlineAtMs,
        logger,
        fastExternalFallbackReasonCode: pdpFastExternalFallbackReasonCode,
        lightEnrich: RECO_PDP_LIGHT_ENRICH_ENABLED,
      });
      metrics.pdpLatencyMs = Number(pdpEnriched.latencyMs || 0);
      metrics.pdpEnrichmentApplied = pdpEnriched.applied === true;
      nextPayload = pdpEnriched.payload;
    }

    return {
      payload: nextPayload,
      ...metrics,
    };
  }

  return {
    runLegacyRecoFrameworkPass,
  };
}

module.exports = {
  createLegacyRecoFrameworkPassRuntime,
};
