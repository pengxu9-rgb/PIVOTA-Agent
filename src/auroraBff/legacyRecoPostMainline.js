function createLegacyRecoPostMainlineRuntime(deps = {}) {
  const {
    isPlainObject,
    pickFirstTrimmed,
    normalizeRecoEffectiveFailureClass,
    normalizeRecoGroundingStatus,
    groundRecoRecommendationsFromCatalog,
    coerceRecoItemForUi,
    normalizeRecoGenerate,
    finalizeConcernFrameworkCandidatePools,
    finalizeRecommendationCandidatePools,
    buildConcernFrameworkDecisionTrace,
    deriveRecoFailureFromStepAwareLlmFallback,
    deriveStepAwareEmptyReason,
    buildConcernFrameworkSummary,
    applyLegacyRecoRecommendationPostFilters,
    mergeFieldMissing,
    applyLegacyRecoFilterDebug,
  } = deps;

  async function runLegacyRecoPostMainline({
    structured = null,
    structuredSource = null,
    ctx,
    logger,
    targetContext = null,
    catalogDebug = null,
    catalogCandidateState = null,
    recommendationTaskContext = null,
    preLlmSelectedCandidateCount = null,
    stepAwareFailurePolicyEnabled = false,
    initialLlmOutcome = 'not_invoked',
    llmFailureClass = '',
    upstreamFailureCode = '',
    promptContract = { ok: true, issues: [] },
    concernSemanticPlanBlockedReason = '',
    concernSemanticPlanBlockedTelemetryReason = '',
    concernSemanticPlanBlockedFailureClass = '',
    concernSelectorRaceTrace = null,
    concernOpenWorldExpansionUsed = false,
    effectiveFailureClass = 'none',
    failureOrigin = 'none',
    presentationMode = '',
    successMode = '',
    profileSummary = null,
    includeAlternatives = false,
    upstreamDebug = null,
    ingredientContext = null,
  } = {}) {
    let mapped =
      structured && typeof structured === 'object' && !Array.isArray(structured)
        ? { ...structured }
        : null;
    let groundingResult = null;
    let nextCatalogDebug = catalogDebug;

    if (
      mapped &&
      Array.isArray(mapped.recommendations) &&
      mapped.recommendations.length &&
      structuredSource === 'llm_primary'
    ) {
      groundingResult = await groundRecoRecommendationsFromCatalog({
        recommendations: mapped.recommendations,
        ctx,
        logger,
        defaultTargetContext: targetContext,
      });
      mapped = {
        ...mapped,
        recommendations: groundingResult.recommendations,
        grounding_status: groundingResult.grounding_status,
        grounded_count: groundingResult.grounded_count,
        ungrounded_count: groundingResult.ungrounded_count,
      };
      if (!nextCatalogDebug && isPlainObject(groundingResult.debug)) {
        nextCatalogDebug = groundingResult.debug;
      }
    }

    if (mapped && Array.isArray(mapped.recommendations)) {
      mapped.recommendations = mapped.recommendations.map((r) =>
        coerceRecoItemForUi(r, { lang: ctx.lang }),
      );
    }

    const frameworkMode = Boolean(
      targetContext && Array.isArray(targetContext.framework_roles) && targetContext.framework_roles.length > 0,
    );
    const norm = normalizeRecoGenerate(mapped);
    const viablePoolState = isPlainObject(catalogCandidateState)
      ? catalogCandidateState
      : frameworkMode
        ? finalizeConcernFrameworkCandidatePools(
            Array.isArray(norm.payload?.recommendations)
              ? norm.payload.recommendations
              : [],
            { targetContext },
          )
        : finalizeRecommendationCandidatePools(
            Array.isArray(norm.payload?.recommendations)
              ? norm.payload.recommendations
              : [],
            { targetContext, recoContext: recommendationTaskContext },
          );
    const frameworkPartialSurface =
      frameworkMode &&
      Array.isArray(norm.payload?.recommendations) &&
      norm.payload.recommendations.length > 0 &&
      !viablePoolState.terminal_success;
    const frameworkTraceId = frameworkMode
      ? `recofw_trace_${String(targetContext.framework_id || '').slice(0, 12)}`
      : null;
    const frameworkDecisionTrace = frameworkMode
      ? (
          Array.isArray(nextCatalogDebug?.reco_framework_decision_trace)
            ? nextCatalogDebug.reco_framework_decision_trace
            : buildConcernFrameworkDecisionTrace({
                targetContext,
                queryLevels: [],
                candidateState: viablePoolState,
              })
        )
      : null;
    let nextPreLlmSelectedCandidateCount = preLlmSelectedCandidateCount;
    if (!Number.isFinite(Number(nextPreLlmSelectedCandidateCount))) {
      nextPreLlmSelectedCandidateCount = Number.isFinite(
        Number(viablePoolState.pre_llm_selected_candidate_count),
      )
        ? Math.max(
            0,
            Math.trunc(Number(viablePoolState.pre_llm_selected_candidate_count)),
          )
        : Number.isFinite(Number(viablePoolState.selected_candidate_count))
          ? Math.max(0, Math.trunc(Number(viablePoolState.selected_candidate_count)))
          : 0;
    }

    const stepAwareDeterministicSuccess = Boolean(
      targetContext.step_aware_intent &&
        viablePoolState?.terminal_success &&
        Array.isArray(norm.payload?.recommendations) &&
        norm.payload.recommendations.length > 0,
    );
    const stepAwareMainlineFailure =
      stepAwareFailurePolicyEnabled && !stepAwareDeterministicSuccess
        ? deriveRecoFailureFromStepAwareLlmFallback({
            initialLlmOutcome,
            llmFailureClass,
            upstreamFailureCode,
            promptContractOk: promptContract.ok,
          })
        : null;
    const stepAwareHasRecommendations =
      Array.isArray(norm.payload?.recommendations) &&
      norm.payload.recommendations.length > 0;
    const stepAwareMainlineFailureBlocking = Boolean(
      stepAwareMainlineFailure && !stepAwareHasRecommendations,
    );
    let stepAwarePoolWarningNonBlocking = false;
    let nextEffectiveFailureClass = effectiveFailureClass;
    let nextFailureOrigin = failureOrigin;
    let nextPresentationMode = presentationMode;
    let nextSuccessMode = successMode;

    if (stepAwareMainlineFailureBlocking) {
      nextEffectiveFailureClass =
        stepAwareMainlineFailure.effectiveFailureClass ||
        nextEffectiveFailureClass;
      nextFailureOrigin =
        stepAwareMainlineFailure.failureOrigin || nextFailureOrigin;
      nextPresentationMode = '';
      nextSuccessMode = '';
    } else if (stepAwareMainlineFailure && stepAwareHasRecommendations) {
      norm.payload = {
        ...norm.payload,
        mainline_status:
          pickFirstTrimmed(norm.payload?.mainline_status, 'grounded_success') ||
          'grounded_success',
        recommendation_meta: {
          ...(isPlainObject(norm.payload?.recommendation_meta)
            ? norm.payload.recommendation_meta
            : {}),
          step_aware_mainline_warning_reason:
            stepAwareMainlineFailure.productsEmptyReason ||
            stepAwareMainlineFailure.effectiveFailureClass ||
            'step_aware_non_terminal',
          step_aware_mainline_warning_non_blocking: true,
        },
        metadata: {
          ...(isPlainObject(norm.payload?.metadata) ? norm.payload.metadata : {}),
          step_aware_mainline_warning_reason:
            stepAwareMainlineFailure.productsEmptyReason ||
            stepAwareMainlineFailure.effectiveFailureClass ||
            'step_aware_non_terminal',
          step_aware_mainline_warning_non_blocking: true,
        },
      };
      nextEffectiveFailureClass = 'none';
      nextFailureOrigin = 'none';
      nextPresentationMode =
        nextPresentationMode || 'deterministic_degraded';
      nextSuccessMode = nextSuccessMode || 'degraded_success';
    }

    if (concernSemanticPlanBlockedReason) {
      norm.payload.recommendations = [];
      norm.payload.products_empty_reason = concernSemanticPlanBlockedReason;
      norm.payload.telemetry_reason =
        concernSemanticPlanBlockedTelemetryReason || null;
      norm.payload.mainline_status =
        concernSemanticPlanBlockedFailureClass === 'upstream_timeout'
          ? 'upstream_timeout'
          : 'severe_parse_or_prompt_failure';
    } else if (stepAwareMainlineFailureBlocking) {
      norm.payload.recommendations = [];
      norm.payload.products_empty_reason =
        stepAwareMainlineFailure.productsEmptyReason;
      norm.payload.telemetry_reason =
        stepAwareMainlineFailure.telemetryReason || null;
      norm.payload.mainline_status = stepAwareMainlineFailure.mainlineStatus;
    } else if (
      frameworkMode &&
      !viablePoolState.terminal_success &&
      (!Array.isArray(norm.payload.recommendations) ||
        norm.payload.recommendations.length === 0)
    ) {
      norm.payload.recommendations = [];
      norm.payload.products_empty_reason =
        pickFirstTrimmed(
          viablePoolState?.candidate_drop_stage,
          concernSelectorRaceTrace?.result?.open_world_candidate_expansion_needed &&
            concernOpenWorldExpansionUsed
            ? 'selector_disagreement_no_safe_winner'
            : '',
          'no_mainline_match_for_framework',
        ) || 'no_mainline_match_for_framework';
      if (
        normalizeRecoEffectiveFailureClass(nextEffectiveFailureClass || 'none') ===
        'none'
      ) {
        nextEffectiveFailureClass =
          pickFirstTrimmed(
            norm.payload.products_empty_reason === 'weak_viable_pool'
              ? 'weak_viable_pool'
              : '',
            norm.payload.products_empty_reason === 'filtered_after_recall'
              ? 'weak_viable_pool'
              : '',
            norm.payload.products_empty_reason ===
              'selector_disagreement_no_safe_winner'
              ? 'selector_disagreement_no_safe_winner'
              : '',
            norm.payload.products_empty_reason ===
              'no_mainline_match_for_framework'
              ? 'no_recall_from_planned_sources'
              : '',
          ) || nextEffectiveFailureClass;
        nextFailureOrigin = 'user_input';
      }
    } else if (
      promptContract.ok === false &&
      (!Array.isArray(norm.payload.recommendations) ||
        norm.payload.recommendations.length === 0)
    ) {
      norm.payload.products_empty_reason = 'prompt_contract_mismatch';
    } else if (
      targetContext.step_aware_intent &&
      !viablePoolState.terminal_success
    ) {
      const stepAwareWarningReason = deriveStepAwareEmptyReason(
        targetContext,
        viablePoolState,
      );
      if (stepAwareHasRecommendations) {
        stepAwarePoolWarningNonBlocking = true;
        const nextPayload = {
          ...norm.payload,
          mainline_status:
            pickFirstTrimmed(norm.payload?.mainline_status, 'grounded_success') ||
            'grounded_success',
          recommendation_meta: {
            ...(isPlainObject(norm.payload?.recommendation_meta)
              ? norm.payload.recommendation_meta
              : {}),
            step_aware_pool_warning_reason: stepAwareWarningReason,
            step_aware_pool_warning_non_blocking: true,
          },
          metadata: {
            ...(isPlainObject(norm.payload?.metadata) ? norm.payload.metadata : {}),
            step_aware_pool_warning_reason: stepAwareWarningReason,
            step_aware_pool_warning_non_blocking: true,
          },
        };
        if (Object.prototype.hasOwnProperty.call(nextPayload, 'products_empty_reason')) {
          delete nextPayload.products_empty_reason;
        }
        norm.payload = nextPayload;
      } else {
        norm.payload.recommendations = [];
        norm.payload.products_empty_reason = stepAwareWarningReason;
      }
    }

    const effectiveGroundingStatus = stepAwareMainlineFailureBlocking
      ? ''
      : frameworkPartialSurface
        ? 'partially_grounded'
        : normalizeRecoGroundingStatus(mapped && mapped.grounding_status) ||
          (structuredSource === 'catalog_grounded'
            ? 'grounded'
            : structuredSource === 'catalog_transient_fallback'
              ? 'partially_grounded'
              : '');
    const effectiveGroundedCount = stepAwareMainlineFailureBlocking
      ? 0
      : Number.isFinite(Number(mapped?.grounded_count))
        ? Math.max(0, Math.trunc(Number(mapped?.grounded_count)))
        : structuredSource === 'catalog_grounded'
          ? (
              Array.isArray(norm.payload.recommendations)
                ? norm.payload.recommendations.length
                : 0
            )
          : 0;
    const effectiveUngroundedCount = stepAwareMainlineFailureBlocking
      ? 0
      : Number.isFinite(Number(mapped?.ungrounded_count))
        ? Math.max(0, Math.trunc(Number(mapped?.ungrounded_count)))
        : 0;
    const effectiveMainlineStatus =
      pickFirstTrimmed(
        groundingResult && groundingResult.mainline_status,
        mapped && mapped.mainline_status,
        stepAwareMainlineFailureBlocking
          ? stepAwareMainlineFailure.mainlineStatus
          : '',
        frameworkPartialSurface ? 'partially_grounded' : '',
        frameworkMode && !viablePoolState.terminal_success
          ? 'needs_more_context'
          : '',
        promptContract.ok === false ? 'severe_parse_or_prompt_failure' : '',
        targetContext.step_aware_intent &&
          !viablePoolState.terminal_success &&
          !stepAwareHasRecommendations
          ? 'needs_more_context'
          : '',
        structuredSource === 'catalog_grounded'
          ? 'grounded_success'
          : structuredSource === 'catalog_transient_fallback'
            ? 'partially_grounded'
            : Array.isArray(norm.payload.recommendations) &&
                norm.payload.recommendations.length
              ? effectiveGroundingStatus === 'grounded'
                ? 'grounded_success'
                : effectiveGroundingStatus === 'partially_grounded'
                  ? 'partially_grounded'
                  : 'ungrounded_success'
              : 'empty_structured',
      ) || 'empty_structured';
    const effectiveCatalogSkipReason =
      pickFirstTrimmed(
        groundingResult && groundingResult.catalog_skip_reason,
        mapped && mapped.catalog_skip_reason,
      ) || null;
    const effectiveTelemetryReason =
      pickFirstTrimmed(
        groundingResult && groundingResult.telemetry_reason,
        mapped && mapped.telemetry_reason,
        stepAwareMainlineFailureBlocking
          ? stepAwareMainlineFailure.telemetryReason
          : '',
        promptContract.ok === false ? 'prompt_contract_mismatch' : '',
        llmFailureClass === 'timeout' || upstreamFailureCode === 'UPSTREAM_TIMEOUT'
          ? 'timeout_degraded'
          : '',
      ) || null;

    norm.payload = {
      ...norm.payload,
      intent: 'reco_products',
      profile: profileSummary || null,
      ...(frameworkMode
        ? {
            semantic_plan: isPlainObject(targetContext?.semantic_plan)
              ? targetContext.semantic_plan
              : null,
            core_roles: Array.isArray(targetContext?.semantic_plan?.core_roles)
              ? targetContext.semantic_plan.core_roles
              : [],
            support_roles: Array.isArray(
              targetContext?.semantic_plan?.support_roles,
            )
              ? targetContext.semantic_plan.support_roles
              : [],
            ingredient_hypotheses: Array.isArray(
              targetContext?.semantic_plan?.ingredient_hypotheses,
            )
              ? targetContext.semantic_plan.ingredient_hypotheses
              : [],
            routine_shell: isPlainObject(targetContext?.routine_shell)
              ? targetContext.routine_shell
              : isPlainObject(targetContext?.semantic_plan?.routine_shell)
                ? targetContext.semantic_plan.routine_shell
                : null,
            selection_owner_source:
              pickFirstTrimmed(
                targetContext?.selection_owner_source,
                targetContext?.framework_owner_source,
              ) || null,
            selection_owner_state:
              pickFirstTrimmed(
                targetContext?.selection_owner_state,
                targetContext?.framework_owner_state,
              ) || null,
            selector_race: isPlainObject(concernSelectorRaceTrace?.result)
              ? concernSelectorRaceTrace.result
              : null,
            winner_source: concernWinnerSource || 'deterministic',
            open_world_expansion_used: concernOpenWorldExpansionUsed,
            framework_summary:
              mapped && mapped.framework_summary
                ? mapped.framework_summary
                : buildConcernFrameworkSummary({
                    targetContext,
                    recommendations: Array.isArray(norm.payload?.recommendations)
                      ? norm.payload.recommendations
                      : [],
                    language: ctx.lang,
                  }),
            roles: Array.isArray(mapped?.roles)
              ? mapped.roles
              : Array.isArray(targetContext?.framework_roles)
                ? targetContext.framework_roles.map((role) => ({
                    role_id: String(role?.role_id || '').trim() || null,
                    label: String(role?.label || '').trim() || null,
                    why_this_role:
                      String(role?.why_this_role || '').trim() || null,
                    rank: Number.isFinite(Number(role?.rank))
                      ? Number(role.rank)
                      : null,
                    preferred_step:
                      String(role?.preferred_step || '').trim() || null,
                  }))
                : [],
            primary_role_id: targetContext.primary_role_id || null,
            primary_recommendation_id: viablePoolState.primary_role_matched
              ? viablePoolState.primary_recommendation_id || null
              : null,
            primary_role_matched: Boolean(viablePoolState.primary_role_matched),
            best_available_role_id:
              viablePoolState.best_available_role_id || null,
            late_conflict_without_override: Boolean(
              viablePoolState.late_conflict_without_override,
            ),
          }
        : {}),
      metadata: {
        ...(isPlainObject(norm.payload?.metadata) ? norm.payload.metadata : {}),
        ...(frameworkMode
          ? {
              reco_framework_trace_id: frameworkTraceId,
              reco_framework_decision_trace: frameworkDecisionTrace,
            }
          : {}),
      },
      grounding_status: effectiveGroundingStatus,
      grounded_count: effectiveGroundedCount,
      ungrounded_count: effectiveUngroundedCount,
      mainline_status: effectiveMainlineStatus,
      ...(effectiveCatalogSkipReason
        ? { catalog_skip_reason: effectiveCatalogSkipReason }
        : {}),
      ...(effectiveTelemetryReason
        ? { telemetry_reason: effectiveTelemetryReason }
        : {}),
      ...(ingredientContext && typeof ingredientContext === 'object'
        ? { ingredient_context: ingredientContext }
        : {}),
    };

    const {
      norm: postFilterNorm,
      recoSeedFilterInfo,
      recoDiversityInfo,
      itineraryAvailable,
    } = applyLegacyRecoRecommendationPostFilters({
      ctx,
      norm,
      profileSummary,
    });
    norm.payload = postFilterNorm.payload;
    norm.field_missing = postFilterNorm.field_missing;
    applyLegacyRecoFilterDebug(upstreamDebug, recoSeedFilterInfo, recoDiversityInfo);

    if (includeAlternatives) {
      norm.field_missing = mergeFieldMissing(norm.field_missing, [
        {
          field: 'recommendations[].alternatives',
          reason: 'lazy_alternatives_deferred',
        },
      ]);
    }

    return {
      norm,
      mapped,
      groundingResult,
      catalogDebug: nextCatalogDebug,
      viablePoolState,
      frameworkMode,
      frameworkPartialSurface,
      frameworkTraceId,
      frameworkDecisionTrace,
      preLlmSelectedCandidateCount: nextPreLlmSelectedCandidateCount,
      stepAwareMainlineFailure,
      stepAwareMainlineFailureBlocking,
      stepAwarePoolWarningNonBlocking,
      effectiveFailureClass: nextEffectiveFailureClass,
      failureOrigin: nextFailureOrigin,
      presentationMode: nextPresentationMode,
      successMode: nextSuccessMode,
      effectiveGroundingStatus,
      effectiveGroundedCount,
      effectiveUngroundedCount,
      effectiveMainlineStatus,
      effectiveCatalogSkipReason,
      effectiveTelemetryReason,
      itineraryAvailable,
    };
  }

  return {
    runLegacyRecoPostMainline,
  };
}

module.exports = {
  createLegacyRecoPostMainlineRuntime,
};
