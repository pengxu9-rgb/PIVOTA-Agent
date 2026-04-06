function createLegacyRecoGenerationDebugRuntime(deps = {}) {
  const {
    pickFirstTrimmed,
    isPlainObject,
    RECO_CATALOG_GROUNDED_ENABLED,
    RECO_UPSTREAM_TIMEOUT_MS,
    RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS,
    RECO_PDP_ENRICH_CONCURRENCY,
    RECO_PDP_ENRICH_MAX_NETWORK_ITEMS,
    RECO_PDP_RESOLVE_ENABLED,
    RECO_PDP_RESOLVE_TIMEOUT_MS,
    RECO_PDP_RESOLVE_TIMEOUT_STRICT_MIN_MS,
    RECO_PDP_STRICT_INTERNAL_FIRST,
    PIVOTA_BACKEND_BASE_URL,
    RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP,
    RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED,
    RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT,
    RECO_CATALOG_TRANSIENT_FALLBACK_ENABLED,
    RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED,
    RECOMMENDATION_RECO_POLICY_V1,
    RECO_TEST_SEED_MAX_PER_RESPONSE,
    RECO_TEST_SEED_MIN_TOTAL,
    isProductionLikeAuroraBffEnv,
  } = deps;

  function buildLegacyRecoUpstreamDebug({
    debugEnabled = false,
    upstream = null,
    structuredSource = null,
    answerJson = null,
    structured = null,
    catalogStructured = null,
    catalogTransientFallbackStructured = null,
    catalogDebug = null,
    pdpFastFallbackReasonCode = null,
    normalizedIngredientContext = null,
    llmStructuredSource = null,
    llmFailureClass = '',
    llmInvoked = false,
    initialLlmOutcome = '',
    presentationMode = '',
    successMode = '',
    nonBlockingLlmIssue = 'none',
    llmTrace = null,
    query = '',
    promptBundle = null,
    catalogCandidatePool = [],
    targetContext = null,
    catalogCandidateState = null,
    effectiveFailureClass = '',
    failureOrigin = '',
    effectiveAnalysisContextSnapshot = null,
    recommendationTaskContext = null,
  } = {}) {
    if (!debugEnabled) return null;
    return {
      intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
      has_structured: Boolean(upstream && upstream.structured),
      structured_keys:
        upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
          ? Object.keys(upstream.structured).slice(0, 24)
          : [],
      answer_preview:
        upstream && typeof upstream.answer === 'string' ? upstream.answer.slice(0, 800) : null,
      cards_types: Array.isArray(upstream && upstream.cards)
        ? upstream.cards
          .map((c) => (c && typeof c === 'object' && typeof c.type === 'string' ? c.type : null))
          .filter(Boolean)
          .slice(0, 12)
        : [],
      clarification:
        upstream && upstream.clarification && typeof upstream.clarification === 'object' ? upstream.clarification : null,
      context_keys:
        upstream && upstream.context && typeof upstream.context === 'object' && !Array.isArray(upstream.context)
          ? Object.keys(upstream.context).slice(0, 24)
          : [],
      structured_source: structuredSource,
      extracted_answer_json_keys:
        answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? Object.keys(answerJson).slice(0, 24) : [],
      extracted_structured_keys:
        structured && typeof structured === 'object' && !Array.isArray(structured) ? Object.keys(structured).slice(0, 24) : [],
      reco_catalog_grounded_enabled: RECO_CATALOG_GROUNDED_ENABLED,
      reco_catalog_grounded_available: Boolean(catalogStructured && Array.isArray(catalogStructured.recommendations) && catalogStructured.recommendations.length),
      reco_upstream_timeout_ms: RECO_UPSTREAM_TIMEOUT_MS,
      reco_upstream_timeout_hard_cap_ms: RECO_UPSTREAM_TIMEOUT_HARD_CAP_MS,
      reco_pdp_enrich_concurrency: RECO_PDP_ENRICH_CONCURRENCY,
      reco_pdp_enrich_max_network_items: RECO_PDP_ENRICH_MAX_NETWORK_ITEMS,
      reco_pdp_resolve_enabled: RECO_PDP_RESOLVE_ENABLED,
      reco_pdp_resolve_timeout_ms: RECO_PDP_RESOLVE_TIMEOUT_MS,
      reco_pdp_resolve_timeout_strict_min_ms: RECO_PDP_RESOLVE_TIMEOUT_STRICT_MIN_MS,
      reco_pdp_strict_internal_first: RECO_PDP_STRICT_INTERNAL_FIRST,
      pivota_backend_base_configured: Boolean(PIVOTA_BACKEND_BASE_URL),
      reco_pdp_chat_disable_local_double_hop: RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP,
      reco_local_fallback_chat_enabled: RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT_ENABLED,
      reco_local_search_fallback_on_transient: RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT,
      reco_catalog_transient_fallback_enabled: RECO_CATALOG_TRANSIENT_FALLBACK_ENABLED,
      reco_catalog_transient_fallback_applied: Boolean(catalogTransientFallbackStructured),
      reco_pdp_fast_external_fallback_enabled: RECO_PDP_FAST_EXTERNAL_FALLBACK_ENABLED,
      reco_catalog_debug: catalogDebug,
      reco_pdp_fast_fallback_reason: pdpFastFallbackReasonCode,
      ingredient_context: normalizedIngredientContext || null,
      llm_structured_source: llmStructuredSource,
      llm_failure_class: llmFailureClass || null,
      llm_invoked: llmInvoked,
      initial_llm_outcome: initialLlmOutcome,
      presentation_mode: presentationMode,
      success_mode: successMode,
      non_blocking_llm_issue: nonBlockingLlmIssue !== 'none' ? nonBlockingLlmIssue : null,
      llm_prompt_trace: llmTrace,
      llm_prompt_query_chars: typeof query === 'string' ? query.length : 0,
      llm_prompt_template_id: promptBundle?.prompt_spec?.template_id || null,
      llm_prompt_schema_chars: Number(promptBundle?.schema_chars || 0),
      llm_prompt_mode: promptBundle?.prompt_spec?.llm_mode || null,
      llm_skipped_reason:
        !llmInvoked && catalogStructured && Array.isArray(catalogStructured.recommendations) && catalogStructured.recommendations.length > 0
          ? 'catalog_grounded_primary'
          : null,
      llm_candidate_count: Array.isArray(catalogCandidatePool) ? catalogCandidatePool.length : 0,
      resolved_target_step: targetContext?.resolved_target_step || null,
      resolved_target_step_confidence: targetContext?.resolved_target_step_confidence || 'none',
      resolved_target_step_source: targetContext?.resolved_target_step_source || 'none',
      step_resolution_version: targetContext?.step_resolution_version || null,
      candidate_pool_signature: pickFirstTrimmed(catalogDebug?.candidate_pool_signature) || null,
      raw_candidate_count: Number(catalogDebug?.raw_candidate_count || 0),
      viable_candidate_count: Number(catalogDebug?.viable_candidate_count || 0),
      exact_step_viable_count: Number(catalogDebug?.exact_step_viable_count || 0),
      same_family_viable_count: Number(catalogDebug?.same_family_viable_count || 0),
      soft_mismatch_count: Number(catalogDebug?.soft_mismatch_count || 0),
      hard_reject_count: Number(catalogDebug?.hard_reject_count || 0),
      raw_source_counts:
        isPlainObject(catalogCandidateState?.raw_source_counts)
          ? catalogCandidateState.raw_source_counts
          : {},
      viable_source_counts:
        isPlainObject(catalogCandidateState?.viable_source_counts)
          ? catalogCandidateState.viable_source_counts
          : {},
      selected_source_counts:
        isPlainObject(catalogDebug?.selected_source_counts)
          ? catalogDebug.selected_source_counts
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
      executed_upstream_attempt_count: Number.isFinite(Number(catalogDebug?.executed_upstream_attempt_count))
        ? Number(catalogDebug.executed_upstream_attempt_count)
        : 0,
      actual_http_attempt_count: Number.isFinite(Number(catalogDebug?.actual_http_attempt_count))
        ? Number(catalogDebug.actual_http_attempt_count)
        : 0,
      stage_timeout_counts:
        isPlainObject(catalogDebug?.stage_timeout_counts)
          ? catalogDebug.stage_timeout_counts
          : {},
      primary_stage_timeout_class: pickFirstTrimmed(catalogDebug?.primary_stage_timeout_class) || null,
      transport_policy_mode: pickFirstTrimmed(catalogDebug?.transport_policy_mode) || null,
      candidate_drop_stage: pickFirstTrimmed(catalogDebug?.candidate_drop_stage) || null,
      hard_reject_preview:
        Array.isArray(catalogCandidateState?.hard_reject_preview)
          ? catalogCandidateState.hard_reject_preview
          : [],
      pre_llm_selected_candidate_count: Number(catalogCandidateState?.pre_llm_selected_candidate_count || 0),
      weak_viable_pool: Boolean(catalogDebug?.weak_viable_pool),
      viable_pool_strength: pickFirstTrimmed(catalogCandidateState?.viable_pool_strength) || null,
      target_fidelity_level: pickFirstTrimmed(catalogCandidateState?.target_fidelity_level) || null,
      reco_policy_version: pickFirstTrimmed(catalogCandidateState?.reco_policy_version, RECOMMENDATION_RECO_POLICY_V1) || null,
      same_family_success_threshold_met: Boolean(catalogCandidateState?.same_family_success_threshold_met),
      overall_target_fidelity_satisfied: Boolean(catalogDebug?.overall_target_fidelity_satisfied),
      effective_failure_class: effectiveFailureClass || null,
      failure_origin: failureOrigin || null,
      analysis_context_usage: {
        snapshot_present: Boolean(effectiveAnalysisContextSnapshot),
        snapshot_fields_used: Array.isArray(recommendationTaskContext?.snapshot_fields_used)
          ? recommendationTaskContext.snapshot_fields_used
          : [],
        hard_context_fields_used: Array.isArray(recommendationTaskContext?.hard_context_fields_used)
          ? recommendationTaskContext.hard_context_fields_used
          : [],
        soft_context_fields_used: Array.isArray(recommendationTaskContext?.soft_context_fields_used)
          ? recommendationTaskContext.soft_context_fields_used
          : [],
        explicit_override_applied: Boolean(recommendationTaskContext?.explicit_override_applied),
        context_mode: String(recommendationTaskContext?.context_mode || '').trim() || 'no_context',
        adapter_version: String(recommendationTaskContext?.adapter_version || '').trim() || null,
      },
    };
  }

  function applyLegacyRecoFilterDebug(upstreamDebug, recoSeedFilterInfo = {}, recoDiversityInfo = {}) {
    if (!upstreamDebug || typeof upstreamDebug !== 'object') return upstreamDebug;
    upstreamDebug.reco_test_seed_max_per_response = RECO_TEST_SEED_MAX_PER_RESPONSE;
    upstreamDebug.reco_test_seed_min_total = RECO_TEST_SEED_MIN_TOTAL;
    upstreamDebug.reco_seed_filter_applied = Boolean(recoSeedFilterInfo.applied);
    upstreamDebug.reco_seed_count_before = Number(recoSeedFilterInfo.seed_count_before || 0);
    upstreamDebug.reco_seed_count_after = Number(recoSeedFilterInfo.seed_count_after || 0);
    upstreamDebug.reco_seed_filtered_count = Number(recoSeedFilterInfo.filtered_count || 0);
    upstreamDebug.reco_diversity_enabled = Boolean(recoDiversityInfo.enabled);
    upstreamDebug.reco_diversity_applied = Boolean(recoDiversityInfo.applied);
    upstreamDebug.reco_diversity_repeated_before = Number(recoDiversityInfo.repeated_before || 0);
    upstreamDebug.reco_diversity_repeated_after = Number(recoDiversityInfo.repeated_after || 0);
    upstreamDebug.reco_diversity_filtered_count = Number(recoDiversityInfo.filtered_count || 0);
    upstreamDebug.reco_diversity_history_size_before = Number(recoDiversityInfo.history_size_before || 0);
    upstreamDebug.reco_diversity_history_size_after = Number(recoDiversityInfo.history_size_after || 0);
    return upstreamDebug;
  }

  function applyLegacyRecoOutcomeDebug(upstreamDebug, {
    contractStatus = '',
    mainlineStatus = '',
    primaryFailureReason = '',
    telemetryFailureReason = '',
    catalogSkipReason = null,
    upstreamFailureCode = '',
    effectiveGroundingStatus = '',
    effectiveGroundedCount = 0,
    effectiveUngroundedCount = 0,
    promptTemplateId = null,
    finalSelectedCandidateCount = 0,
    postGuardrailCount = 0,
    effectiveFailureClass = '',
    failureOrigin = '',
    concernSemanticPlanTrace = null,
    concernSelectorRaceTrace = null,
    concernOpenWorldExpansionTrace = null,
    viablePoolState = null,
    mainlineStageTimingsMs = {},
  } = {}) {
    if (!upstreamDebug || typeof upstreamDebug !== 'object') return upstreamDebug;
    upstreamDebug.contract_status = contractStatus;
    upstreamDebug.mainline_status = mainlineStatus;
    upstreamDebug.primary_failure_reason = primaryFailureReason || null;
    upstreamDebug.telemetry_failure_reason = telemetryFailureReason || null;
    upstreamDebug.catalog_skip_reason = catalogSkipReason;
    upstreamDebug.upstream_failure_code = upstreamFailureCode || null;
    upstreamDebug.grounding_status = effectiveGroundingStatus || null;
    upstreamDebug.grounded_count = effectiveGroundedCount;
    upstreamDebug.ungrounded_count = effectiveUngroundedCount;
    upstreamDebug.prompt_template_id = promptTemplateId;
    upstreamDebug.final_selected_candidate_count = finalSelectedCandidateCount;
    upstreamDebug.post_guardrail_count = postGuardrailCount;
    upstreamDebug.effective_failure_class = effectiveFailureClass || null;
    upstreamDebug.failure_origin = failureOrigin || null;
    upstreamDebug.semantic_plan_trace = concernSemanticPlanTrace;
    upstreamDebug.selector_race_trace = concernSelectorRaceTrace;
    upstreamDebug.open_world_expansion_trace = concernOpenWorldExpansionTrace;
    upstreamDebug.scope_classification_stats = isPlainObject(viablePoolState?.scope_classification_stats)
      ? viablePoolState.scope_classification_stats
      : null;
    upstreamDebug.role_pool_stats = isPlainObject(viablePoolState?.role_pool_stats)
      ? viablePoolState.role_pool_stats
      : null;
    upstreamDebug.model_policy_trace = Array.isArray(concernSemanticPlanTrace?.model_policy_trace)
      ? concernSemanticPlanTrace.model_policy_trace
      : [];
    upstreamDebug.mainline_stage_timings_ms = { ...mainlineStageTimingsMs };
    upstreamDebug.mock_block_trace = {
      requested_use_mock: String(process.env.AURORA_BFF_USE_MOCK || '').trim().toLowerCase() === 'true',
      production_like: isProductionLikeAuroraBffEnv(),
      effective_use_mock: false,
    };
    return upstreamDebug;
  }

  return {
    buildLegacyRecoUpstreamDebug,
    applyLegacyRecoFilterDebug,
    applyLegacyRecoOutcomeDebug,
  };
}

module.exports = {
  createLegacyRecoGenerationDebugRuntime,
};
