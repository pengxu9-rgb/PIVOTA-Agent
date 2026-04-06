function createLegacyRecoGenerationResultRuntime(deps = {}) {
  const {
    isPlainObject,
    pickFirstTrimmed,
    normalizeRecoEffectiveFailureClass,
    deriveRecoContractStatus,
    deriveRecoMainlineStatus,
    deriveRecoTelemetryFailureReason,
    normalizeRecoFailureOrigin,
    normalizeRecoViablePoolStrength,
    normalizeRecoTargetFidelityLevel,
    buildRecoMainlineContract,
    applyRecoWarningVisibilityContract,
    attachRecoContractMeta,
  } = deps;

  function buildLegacyRecoGenerationResult({
    norm,
    finalRecommendations = [],
    structuredSource = null,
    frameworkMode = false,
    targetContext = {},
    effectiveCatalogSkipReason = null,
    catalogDebug = null,
    promptContract = { ok: true, issues: [] },
    llmFailureClass = '',
    upstreamFailureCode = '',
    effectiveMainlineStatus = '',
    effectiveTelemetryReason = null,
    applyLegacyRecoOutcomeDebug,
    upstreamDebug,
    effectiveGroundingStatus = '',
    effectiveGroundedCount = 0,
    effectiveUngroundedCount = 0,
    promptBundle,
    finalSelectedCandidateCount = 0,
    postGuardrailCount = 0,
    effectiveFailureClass = 'none',
    failureOrigin = 'none',
    concernSemanticPlanTrace = null,
    concernSelectorRaceTrace = null,
    concernOpenWorldExpansionTrace = null,
    viablePoolState = {},
    mainlineStageTimingsMs = {},
    sourceModeOverride = '',
    normalizedRecoTriggerSource = '',
    recomputeFromProfileUpdateFlag = false,
    recentLogs = [],
    itineraryAvailable = false,
    deterministicCatalogFirstEnabled = false,
    AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED = false,
    preLlmSelectedCandidateCount = 0,
    query = '',
    concernWinnerSource = 'deterministic',
    concernOpenWorldExpansionUsed = false,
    concernSupportRolesSurfaced = [],
    frameworkTraceId = null,
    CONCERN_SEMANTIC_PLAN_VERSION = '',
    CONCERN_SELECTOR_RACE_VERSION = '',
    RECOMMENDATION_STEP_QUERY_POLICY_V1 = '',
    RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1 = '',
    RECOMMENDATION_RECO_POLICY_V1 = '',
    CANDIDATE_POOL_SIGNATURE_VERSION = '',
    GROUP_SEMANTICS_VERSION = '',
    terminalSuccess = false,
    entryType = 'chat',
    stepAwareMainlineFailure = null,
    normalizedIngredientContext = null,
    llmTrace = null,
    frameworkMainlineWarningNonBlocking = false,
    beautyMainlineHandoffNonBlocking = false,
    stepAwarePoolWarningNonBlocking = false,
    stepAwareMainlineFailureBlocking = false,
    successMode = '',
    presentationMode = '',
    nonBlockingLlmIssue = 'none',
    llmInvoked = false,
    initialLlmOutcome = 'not_invoked',
  } = {}) {
    const sourceMode = sourceModeOverride || (
      finalRecommendations.length > 0
        ? structuredSource === 'llm_primary'
          ? 'llm_primary'
          : structuredSource === 'catalog_grounded'
            ? 'catalog_grounded'
            : structuredSource === 'catalog_transient_fallback'
              ? 'catalog_transient_fallback'
              : frameworkMode
                ? 'framework_mainline'
                : targetContext.step_aware_intent
                  ? 'step_aware_mainline'
                  : 'llm_primary'
        : frameworkMode
          ? structuredSource === 'catalog_transient_fallback'
            ? 'catalog_transient_fallback'
            : structuredSource === 'catalog_grounded'
              ? 'catalog_grounded'
              : 'framework_mainline'
          : targetContext.step_aware_intent
            ? structuredSource === 'catalog_grounded'
              ? 'catalog_grounded'
              : structuredSource === 'catalog_transient_fallback'
                ? 'catalog_transient_fallback'
                : 'step_aware_mainline'
            : 'legacy_notice'
    );

    const catalogSkipReason =
      effectiveCatalogSkipReason ||
      pickFirstTrimmed(catalogDebug && catalogDebug.skipped_reason) ||
      null;
    const contractStatus = deriveRecoContractStatus({
      promptContractOk: promptContract.ok,
      recommendations: finalRecommendations,
      llmFailureClass,
      fieldMissing: norm.field_missing,
      productsEmptyReason: norm.payload?.products_empty_reason,
    });
    const mainlineStatus =
      effectiveMainlineStatus ||
      deriveRecoMainlineStatus({
        recommendations: finalRecommendations,
        structuredSource,
        catalogSkipReason,
        llmFailureClass,
        upstreamFailureCode,
        contractStatus,
        productsEmptyReason: norm.payload?.products_empty_reason,
      });
    const telemetryFailureReason =
      effectiveTelemetryReason ||
      deriveRecoTelemetryFailureReason({
        llmFailureClass,
        upstreamFailureCode,
        contractStatus,
      });
    const primaryFailureReason = finalRecommendations.length > 0
      ? ''
      : (
        pickFirstTrimmed(
          norm.payload?.products_empty_reason,
          effectiveFailureClass,
        ) || 'no_recall_from_planned_sources'
      );

    applyLegacyRecoOutcomeDebug(upstreamDebug, {
      contractStatus,
      mainlineStatus,
      primaryFailureReason,
      telemetryFailureReason,
      catalogSkipReason,
      upstreamFailureCode,
      effectiveGroundingStatus,
      effectiveGroundedCount,
      effectiveUngroundedCount,
      promptTemplateId: promptBundle.prompt_spec.template_id,
      finalSelectedCandidateCount,
      postGuardrailCount,
      effectiveFailureClass,
      failureOrigin,
      concernSemanticPlanTrace,
      concernSelectorRaceTrace,
      concernOpenWorldExpansionTrace,
      viablePoolState,
      mainlineStageTimingsMs,
    });

    const normalizedViablePoolStrength =
      normalizeRecoViablePoolStrength(viablePoolState?.viable_pool_strength) ||
      (terminalSuccess ? 'strong' : finalRecommendations.length > 0 ? 'weak' : 'empty');
    const normalizedTargetFidelityLevel =
      normalizeRecoTargetFidelityLevel(viablePoolState?.target_fidelity_level) ||
      (
        Boolean(viablePoolState?.overall_target_fidelity_satisfied)
          ? 'satisfied'
          : finalRecommendations.length > 0
            ? 'partial'
            : 'failed'
      );

    let nextPayload = {
      ...norm.payload,
      source:
        sourceMode === 'llm_primary'
          ? (effectiveGroundingStatus === 'ungrounded'
            ? 'llm_editorial_v1'
            : 'llm_primary_v1')
          : sourceMode === 'catalog_grounded'
            ? 'catalog_grounded_v1'
            : sourceMode === 'catalog_transient_fallback'
              ? 'catalog_transient_fallback'
              : sourceMode === 'framework_mainline'
                ? 'framework_mainline_v1'
                : sourceMode === 'step_aware_mainline'
                  ? 'step_aware_mainline_v1'
                  : 'legacy_notice',
      recommendation_meta: {
        ...(isPlainObject(norm.payload?.recommendation_meta)
          ? norm.payload.recommendation_meta
          : {}),
        source_mode: sourceMode,
        trigger_source: normalizedRecoTriggerSource,
        recompute_from_profile_update: recomputeFromProfileUpdateFlag,
        used_recent_logs: Array.isArray(recentLogs) && recentLogs.length > 0,
        used_itinerary: itineraryAvailable,
        used_safety_flags: false,
        prompt_contract_ok: promptContract.ok,
        primary_failure_reason: primaryFailureReason || null,
        telemetry_failure_reason: telemetryFailureReason || null,
        failure_class:
          AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED &&
          normalizeRecoEffectiveFailureClass(effectiveFailureClass || 'none') !== 'none'
            ? effectiveFailureClass
            : llmFailureClass || null,
        ...(deterministicCatalogFirstEnabled
          ? {
              effective_failure_class:
                normalizeRecoEffectiveFailureClass(effectiveFailureClass || 'none') || 'none',
              failure_origin: normalizeRecoFailureOrigin(failureOrigin || 'none'),
            }
          : {}),
        contract_status: contractStatus,
        catalog_skip_reason: catalogSkipReason,
        upstream_failure_code: upstreamFailureCode || null,
        mainline_status: mainlineStatus,
        ...(!finalRecommendations.length &&
        pickFirstTrimmed(norm.payload?.products_empty_reason)
          ? { products_empty_reason: pickFirstTrimmed(norm.payload?.products_empty_reason) }
          : {}),
        ...(!finalRecommendations.length && stepAwareMainlineFailure?.productsEmptyReason
          ? {
              step_aware_mainline_blocked_reason:
                stepAwareMainlineFailure.productsEmptyReason,
            }
          : {}),
        grounding_status: effectiveGroundingStatus || null,
        grounded_count: effectiveGroundedCount,
        ungrounded_count: effectiveUngroundedCount,
        prompt_template_id: promptBundle.prompt_spec.template_id,
        llm_prompt_chars: typeof query === 'string' ? query.length : 0,
        llm_schema_chars: Number(promptBundle.schema_chars || 0),
        llm_mode: promptBundle.prompt_spec.llm_mode,
        catalog_query_count: Number.isFinite(Number(catalogDebug?.query_count))
          ? Number(catalogDebug?.query_count)
          : 0,
        llm_trace: llmTrace,
        resolved_target_step: targetContext.resolved_target_step || null,
        resolved_target_step_confidence:
          targetContext.resolved_target_step_confidence || 'none',
        resolved_target_step_source:
          targetContext.resolved_target_step_source || 'none',
        selected_source_counts:
          isPlainObject(catalogDebug?.selected_source_counts)
            ? catalogDebug.selected_source_counts
            : {},
        raw_source_counts:
          isPlainObject(viablePoolState?.raw_source_counts)
            ? viablePoolState.raw_source_counts
            : {},
        viable_source_counts:
          isPlainObject(viablePoolState?.viable_source_counts)
            ? viablePoolState.viable_source_counts
            : {},
        external_seed_used_count: Number.isFinite(Number(catalogDebug?.external_seed_used_count))
          ? Number(catalogDebug.external_seed_used_count)
          : 0,
        recall_plan_version: pickFirstTrimmed(catalogDebug?.recall_plan_version) || null,
        executed_query_count: Number.isFinite(Number(catalogDebug?.executed_query_count))
          ? Number(catalogDebug.executed_query_count)
          : Number.isFinite(Number(catalogDebug?.query_count))
            ? Number(catalogDebug.query_count)
            : 0,
        executed_upstream_attempt_count: Number.isFinite(
          Number(catalogDebug?.executed_upstream_attempt_count),
        )
          ? Number(catalogDebug.executed_upstream_attempt_count)
          : 0,
        actual_http_attempt_count: Number.isFinite(Number(catalogDebug?.actual_http_attempt_count))
          ? Number(catalogDebug.actual_http_attempt_count)
          : 0,
        stage_timeout_counts:
          isPlainObject(catalogDebug?.stage_timeout_counts)
            ? catalogDebug.stage_timeout_counts
            : {},
        primary_stage_timeout_class:
          pickFirstTrimmed(catalogDebug?.primary_stage_timeout_class) || null,
        transport_policy_mode:
          pickFirstTrimmed(catalogDebug?.transport_policy_mode) || null,
        candidate_drop_stage:
          pickFirstTrimmed(catalogDebug?.candidate_drop_stage) || null,
        hard_reject_preview:
          Array.isArray(viablePoolState?.hard_reject_preview)
            ? viablePoolState.hard_reject_preview
            : [],
        semantic_plan_version: frameworkMode
          ? pickFirstTrimmed(
              targetContext?.semantic_plan_version,
              CONCERN_SEMANTIC_PLAN_VERSION,
            ) || CONCERN_SEMANTIC_PLAN_VERSION
          : null,
        selection_contract_version: frameworkMode
          ? CONCERN_SELECTOR_RACE_VERSION
          : null,
        winner_source: frameworkMode ? concernWinnerSource || 'deterministic' : null,
        open_world_expansion_used: frameworkMode ? concernOpenWorldExpansionUsed : false,
        support_roles_surfaced: frameworkMode ? concernSupportRolesSurfaced : [],
        framework_id: frameworkMode ? targetContext.framework_id || null : null,
        framework_owner_source: frameworkMode
          ? targetContext.framework_owner_source || null
          : null,
        framework_owner_state: frameworkMode
          ? targetContext.framework_owner_state || null
          : null,
        semantic_planner_requested_provider: frameworkMode
          ? pickFirstTrimmed(concernSemanticPlanTrace?.planner_requested_provider) || null
          : null,
        semantic_planner_requested_model: frameworkMode
          ? pickFirstTrimmed(concernSemanticPlanTrace?.planner_requested_model) || null
          : null,
        semantic_planner_effective_provider: frameworkMode
          ? pickFirstTrimmed(concernSemanticPlanTrace?.planner_effective_provider) || null
          : null,
        semantic_planner_effective_model: frameworkMode
          ? pickFirstTrimmed(concernSemanticPlanTrace?.planner_effective_model) || null
          : null,
        semantic_planner_selection_source: frameworkMode
          ? pickFirstTrimmed(concernSemanticPlanTrace?.planner_selection_source) || null
          : null,
        selector_requested_model: frameworkMode
          ? pickFirstTrimmed(concernSelectorRaceTrace?.selector_requested_model) || null
          : null,
        selector_effective_model: frameworkMode
          ? pickFirstTrimmed(concernSelectorRaceTrace?.selector_effective_model) || null
          : null,
        selector_selection_source: frameworkMode
          ? pickFirstTrimmed(concernSelectorRaceTrace?.selector_selection_source) || null
          : null,
        semantic_planner_owner_state: frameworkMode
          ? pickFirstTrimmed(
              targetContext?.selection_owner_state,
              targetContext?.framework_owner_state,
            ) || null
          : null,
        primary_role_id: frameworkMode ? targetContext.primary_role_id || null : null,
        primary_recommendation_id: frameworkMode
          ? (
            viablePoolState.primary_role_matched === true
              ? (pickFirstTrimmed(
                  norm.payload?.primary_recommendation_id,
                  viablePoolState.primary_recommendation_id,
                ) || null)
              : null
          )
          : null,
        primary_role_matched: frameworkMode
          ? Boolean(viablePoolState.primary_role_matched)
          : false,
        best_available_role_id: frameworkMode
          ? viablePoolState.best_available_role_id || null
          : null,
        role_conflict_present: frameworkMode
          ? Boolean(viablePoolState.role_conflict_present)
          : false,
        late_conflict_without_override: frameworkMode
          ? Boolean(viablePoolState.late_conflict_without_override)
          : false,
        reco_framework_trace_id: frameworkTraceId,
        step_resolution_version: targetContext.step_resolution_version || null,
        step_query_policy_version: RECOMMENDATION_STEP_QUERY_POLICY_V1,
        viability_policy_version: RECOMMENDATION_VIABLE_THRESHOLD_POLICY_V1,
        candidate_pool_signature_version: CANDIDATE_POOL_SIGNATURE_VERSION,
        group_semantics_version: GROUP_SEMANTICS_VERSION,
        ...(frameworkMode
          ? {
              concern_framework_policy_version:
                targetContext.concern_framework_policy_version || null,
            }
          : {}),
        ...(deterministicCatalogFirstEnabled
          ? {
              reco_policy_version:
                pickFirstTrimmed(
                  viablePoolState.reco_policy_version,
                  RECOMMENDATION_RECO_POLICY_V1,
                ) || null,
            }
          : {}),
        raw_candidate_count: Number(viablePoolState.raw_candidate_count || 0),
        viable_candidate_count: Number(viablePoolState.viable_candidate_count || 0),
        exact_step_viable_count: Number(viablePoolState.exact_step_viable_count || 0),
        same_family_viable_count: Number(viablePoolState.same_family_viable_count || 0),
        soft_mismatch_count: Number(viablePoolState.soft_mismatch_count || 0),
        hard_reject_count: Number(viablePoolState.hard_reject_count || 0),
        ...(deterministicCatalogFirstEnabled
          ? {
              pre_llm_selected_candidate_count: Number(preLlmSelectedCandidateCount || 0),
              final_selected_candidate_count: Number(finalSelectedCandidateCount || 0),
              post_guardrail_count: Number(postGuardrailCount || 0),
            }
          : {}),
        selected_candidate_count: Number(viablePoolState.selected_candidate_count || 0),
        ...(deterministicCatalogFirstEnabled
          ? {
              llm_invoked: llmInvoked,
              initial_llm_outcome: initialLlmOutcome,
              ...(presentationMode ? { presentation_mode: presentationMode } : {}),
              ...(successMode ? { success_mode: successMode } : {}),
              ...(nonBlockingLlmIssue !== 'none'
                ? { non_blocking_llm_issue: nonBlockingLlmIssue }
                : {}),
              terminal_success: terminalSuccess,
              viable_pool_strength: normalizedViablePoolStrength,
              target_fidelity_level: normalizedTargetFidelityLevel,
              same_family_success_threshold_met: Boolean(
                viablePoolState.same_family_success_threshold_met,
              ),
            }
          : {}),
        overall_target_fidelity_satisfied: Boolean(
          viablePoolState.overall_target_fidelity_satisfied,
        ),
        weak_viable_pool: Boolean(viablePoolState.weak_viable_pool),
        candidate_pool_signature: viablePoolState.candidate_pool_signature,
        candidate_drop_stage: frameworkMode
          ? pickFirstTrimmed(viablePoolState.candidate_drop_stage) || null
          : null,
        effective_failure_class: frameworkMode
          ? (
            normalizeRecoEffectiveFailureClass(effectiveFailureClass || '') ||
            (finalRecommendations.length > 0 ? 'none' : null)
          )
          : (
            deterministicCatalogFirstEnabled
              ? (normalizeRecoEffectiveFailureClass(effectiveFailureClass || '') || 'none')
              : undefined
          ),
      },
    };

    if (finalRecommendations.length > 0) {
      delete nextPayload.products_empty_reason;
      delete nextPayload.telemetry_reason;
    }

    const recoContract = buildRecoMainlineContract({
      recommendations: nextPayload.recommendations,
      sourceMode,
      source: nextPayload.source,
      llmFailureClass:
        AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED &&
        normalizeRecoEffectiveFailureClass(effectiveFailureClass || 'none') !== 'none'
          ? effectiveFailureClass
          : llmFailureClass,
      upstreamFailureCode,
      promptContractOk: promptContract.ok,
      fieldMissing: norm.field_missing,
      structuredSource,
      catalogSkipReason,
      productsEmptyReason: nextPayload.products_empty_reason,
      groundingStatus: effectiveGroundingStatus,
      groundedCount: effectiveGroundedCount,
      ungroundedCount: effectiveUngroundedCount,
      mainlineStatusOverride: mainlineStatus,
      promptTemplateId: promptBundle.prompt_spec.template_id,
      entryType,
      effectiveFailureClass,
      failureOrigin,
      terminalSuccess,
      viablePoolStrength: normalizedViablePoolStrength,
      targetFidelityLevel: normalizedTargetFidelityLevel,
      presentationMode,
      successMode,
      preLlmSelectedCandidateCount,
      finalSelectedCandidateCount,
      postGuardrailCount,
    });
    const warningContract = applyRecoWarningVisibilityContract(nextPayload);
    nextPayload = {
      ...warningContract.payload,
      prompt_contract_ok: promptContract.ok,
      ...(promptContract.ok
        ? {}
        : { prompt_contract_issues: promptContract.issues.slice(0, 6) }),
    };
    nextPayload = attachRecoContractMeta(nextPayload, recoContract);
    if (normalizedIngredientContext) {
      const recoCount = Array.isArray(nextPayload.recommendations)
        ? nextPayload.recommendations.length
        : 0;
      nextPayload.constraint_match_summary = {
        total: recoCount,
        matched: null,
        dropped: null,
      };
    }

    norm.payload = nextPayload;
    norm.contract = recoContract;

    return {
      norm,
      upstreamDebug,
      contract: recoContract,
      contractStatus,
      mainlineStatus,
      primaryFailureReason,
      telemetryFailureReason,
      catalogSkipReason,
      llmPromptChars: typeof query === 'string' ? query.length : 0,
      llmSchemaChars: Number(promptBundle.schema_chars || 0),
      llmMode: promptBundle.prompt_spec.llm_mode,
      frameworkMainlineWarningNonBlocking,
      beautyMainlineHandoffNonBlocking,
      stepAwarePoolWarningNonBlocking,
      stepAwareMainlineFailureBlocking,
    };
  }

  return {
    buildLegacyRecoGenerationResult,
  };
}

module.exports = {
  createLegacyRecoGenerationResultRuntime,
};
