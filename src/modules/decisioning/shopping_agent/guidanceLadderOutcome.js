const {
  GUIDANCE_ONLY_UI_SURFACE,
  GUIDANCE_ONLY_DECISION_MODE,
  GUIDANCE_RETRIEVAL_MODE,
  GUIDANCE_SOURCE_POLICY,
  GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER,
  GUIDANCE_FASTPATH_LATENCY_MODE,
  GUIDANCE_FASTPATH_TOTAL_BUDGET_MS,
  GUIDANCE_FASTPATH_CLIENT_TIMEOUT_RECOMMENDED_MS,
} = require('./guidanceContext');

function createGuidanceLadderOutcomeRuntime(deps = {}) {
  const {
    compareGuidanceCandidatePools,
    buildGuidanceFastpathFailureClass,
    stabilizeGuidanceFastpathDisplayProducts,
    normalizeGuidanceDiscoveryProductPdpContract,
    getGuidanceFastpathRemainingBudgetMs,
    countCandidateOriginBreakdown,
    inferGuidanceDiscoverySourceUsed,
  } = deps;

  function buildGuidanceAttemptRecord({
    attemptIndex,
    attempt,
    clusterQueries,
    internalProducts,
    externalProducts,
    internalQueryTraces,
    externalPhase,
    mergedProducts,
    searchDecision,
    candidateSummary,
    durationMs,
    adopted = false,
  } = {}) {
    return {
      attempt_index: attemptIndex,
      intent_strength: attempt?.intent_strength || null,
      selected_query: attempt?.selected_query || null,
      cluster_queries: Array.isArray(clusterQueries) ? clusterQueries : [],
      internal_candidate_count: Array.isArray(internalProducts) ? internalProducts.length : 0,
      external_candidate_count: Array.isArray(externalProducts) ? externalProducts.length : 0,
      merged_candidate_count: Array.isArray(mergedProducts) ? mergedProducts.length : 0,
      internal_query_traces: Array.isArray(internalQueryTraces) ? internalQueryTraces : [],
      external_query_traces: Array.isArray(externalPhase?.result?.metadata?.retrieval_query_debug)
        ? externalPhase.result.metadata.retrieval_query_debug
        : [],
      target_relevance_class_counts:
        searchDecision?.target_relevance_class_counts || candidateSummary?.counts || null,
      step_success_class: searchDecision?.step_success_class || null,
      success_contract_satisfied: searchDecision?.success_contract_result?.satisfied === true,
      duration_ms: Math.max(0, Number(durationMs || 0) || 0),
      adopted,
    };
  }

  function buildGuidanceSkippedAttemptRecord({
    attemptIndex,
    attempt,
    skippedReason = 'budget_exhausted',
  } = {}) {
    return {
      attempt_index: attemptIndex,
      intent_strength: attempt?.intent_strength || 'supportive_family',
      selected_query: attempt?.selected_query || null,
      cluster_queries: Array.isArray(attempt?.cluster_queries) ? attempt.cluster_queries : [],
      adopted: false,
      skipped_reason: skippedReason,
    };
  }

  function shouldAdoptGuidanceAttempt(selectedSummary, candidateSummary) {
    return !selectedSummary || compareGuidanceCandidatePools(candidateSummary, selectedSummary) > 0;
  }

  function buildGuidanceSuccessContractResult(selectedDecision, failureClass) {
    if (selectedDecision?.success_contract_result && typeof selectedDecision.success_contract_result === 'object') {
      return {
        ...selectedDecision.success_contract_result,
        failure_class:
          selectedDecision.success_contract_result.satisfied === true
            ? null
            : selectedDecision.success_contract_result.failure_class || failureClass,
      };
    }
    return {
      applied: true,
      satisfied: false,
      step_success_class: null,
      failure_class: failureClass,
    };
  }

  function finalizeGuidanceLadderResult({
    selectedAttempt,
    selectedSummary,
    attempts,
    queryText,
    guidanceContext,
    requestedLimit,
    startedAt,
    allowExternalSeed,
    normalizedIntent,
    attemptTrace,
    phaseTrace,
    externalSeedRowsRaw,
    externalSeedRowsRelevant,
    externalSeedRowsAppended,
    beautySearchDecisionContractVersion,
  } = {}) {
    const selectedDecision = selectedAttempt?.searchDecision || null;
    const selectedDisplayProducts = Array.isArray(selectedAttempt?.displayProducts)
      ? selectedAttempt.displayProducts
      : [];
    const selectedAttemptQuery = String(
      selectedAttempt?.selected_query || attempts?.[0]?.selected_query || queryText || '',
    ).trim();
    const failureClass = buildGuidanceFastpathFailureClass(selectedDecision, selectedSummary);
    const successContractResult = buildGuidanceSuccessContractResult(selectedDecision, failureClass);

    const stabilizedDisplayProducts = stabilizeGuidanceFastpathDisplayProducts(
      selectedDisplayProducts,
      queryText,
      guidanceContext,
    );
    const responseProducts = stabilizedDisplayProducts
      .slice(0, requestedLimit)
      .map((product) => normalizeGuidanceDiscoveryProductPdpContract(product));
    const finalDecision = responseProducts.length > 0 ? 'cache_returned' : null;
    const remainingBudgetMs = getGuidanceFastpathRemainingBudgetMs(startedAt);

    const selectedMergedProducts = Array.isArray(selectedAttempt?.mergedProducts)
      ? selectedAttempt.mergedProducts
      : responseProducts;
    const candidateOriginCounts = countCandidateOriginBreakdown(selectedMergedProducts);
    const responseOriginCounts = countCandidateOriginBreakdown(responseProducts);
    const discoverySourceUsed = inferGuidanceDiscoverySourceUsed(responseProducts, allowExternalSeed);

    const searchDecision = {
      contract_version: selectedDecision?.contract_version || beautySearchDecisionContractVersion,
      hit_quality: selectedDecision?.hit_quality || (responseProducts.length > 0 ? 'valid_hit' : 'empty'),
      invalid_hit_reason:
        selectedDecision?.invalid_hit_reason || (responseProducts.length > 0 ? null : failureClass),
      query_bucket: selectedDecision?.query_bucket || null,
      query_target_step_family: guidanceContext?.target_step_family || null,
      topk_bucket_mix: selectedDecision?.topk_bucket_mix || {},
      same_family_topk_count: selectedDecision?.same_family_topk_count || 0,
      exact_step_topk_count: selectedDecision?.exact_step_topk_count || 0,
      strong_goal_family_topk_count: selectedDecision?.strong_goal_family_topk_count || 0,
      supportive_same_family_topk_count: selectedDecision?.supportive_same_family_topk_count || 0,
      query_step_strength:
        selectedDecision?.query_step_strength ||
        selectedAttempt?.intent_strength ||
        attempts?.[0]?.intent_strength ||
        guidanceContext?.query_step_strength ||
        null,
      ...(finalDecision ? { final_decision: finalDecision } : {}),
      decision_mode: GUIDANCE_ONLY_DECISION_MODE,
      execution_mode: GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER,
      latency_mode: GUIDANCE_FASTPATH_LATENCY_MODE,
      normalized_intent: selectedDecision?.normalized_intent || normalizedIntent || null,
      step_success_class: selectedDecision?.step_success_class || null,
      success_contract_result: successContractResult,
      decision_authority: 'agent_products_guidance_fastpath',
      decision_locked: true,
      decision_lock_reason: 'guidance_fastpath_success_contract',
      candidate_origin_counts: candidateOriginCounts,
      candidate_class_counts: selectedDecision?.candidate_class_counts || selectedSummary?.counts || {},
      target_relevance_class_counts:
        selectedDecision?.target_relevance_class_counts || selectedSummary?.counts || {},
      noise_drop_counts: selectedDecision?.noise_drop_counts || {},
      raw_result_count: selectedDecision?.raw_result_count || selectedMergedProducts.length,
      displayable_candidate_count:
        selectedDecision?.displayable_candidate_count || responseProducts.length,
      products_returned_count: responseProducts.length,
      product_only_applied: true,
      service_rows_filtered_count: selectedDecision?.service_rows_filtered_count || 0,
      discovery_source_used: discoverySourceUsed,
      query_exhausted: true,
    };

    return {
      responseProducts,
      selectedAttemptQuery,
      searchDecision,
      metadata: {
        query_source: 'agent_products_guidance_fastpath',
        fetched_at: new Date().toISOString(),
        ui_surface: GUIDANCE_ONLY_UI_SURFACE,
        decision_mode: GUIDANCE_ONLY_DECISION_MODE,
        execution_mode: GUIDANCE_EXECUTION_MODE_SERVER_OWNED_LADDER,
        latency_mode: GUIDANCE_FASTPATH_LATENCY_MODE,
        retrieval_mode: GUIDANCE_RETRIEVAL_MODE,
        legacy_pipeline_bypassed: true,
        resolver_first_applied: false,
        pass2_attempted: false,
        secondary_attempted: false,
        second_stage_expansion_attempted: false,
        attempt_count: (Array.isArray(attemptTrace) ? attemptTrace : []).filter((attempt) => !attempt.skipped_reason)
          .length,
        selected_attempt_query: selectedAttemptQuery || null,
        attempt_trace: Array.isArray(attemptTrace) ? attemptTrace : [],
        phase_trace: Array.isArray(phaseTrace) ? phaseTrace : [],
        ...(finalDecision ? { final_decision: finalDecision } : {}),
        server_budget_ms: GUIDANCE_FASTPATH_TOTAL_BUDGET_MS,
        remaining_budget_ms: remainingBudgetMs,
        client_timeout_recommended_ms: GUIDANCE_FASTPATH_CLIENT_TIMEOUT_RECOMMENDED_MS,
        source_breakdown: {
          internal_count: responseOriginCounts.internal_live,
          external_seed_count: responseOriginCounts.external_supplement,
          stale_cache_used: false,
          strategy_applied: GUIDANCE_SOURCE_POLICY,
        },
        external_seed_rows_fetched: Math.max(0, Number(externalSeedRowsRaw || 0) || 0),
        external_seed_rows_relevant: Math.max(0, Number(externalSeedRowsRelevant || 0) || 0),
        external_seed_rows_appended: Math.max(0, Number(externalSeedRowsAppended || 0) || 0),
        external_seed_rows_built: Math.max(0, Number(externalSeedRowsRelevant || 0) || 0),
        external_seed_returned_count: responseOriginCounts.external_supplement,
        product_only_applied: true,
        service_rows_filtered_count: 0,
        discovery_source_used: discoverySourceUsed,
        query_step_strength: searchDecision.query_step_strength,
        query_target_step_family: guidanceContext?.target_step_family || null,
        target_relevance_class_counts: searchDecision.target_relevance_class_counts,
        search_trace: {
          ...(selectedDecision?.search_trace && typeof selectedDecision.search_trace === 'object'
            ? selectedDecision.search_trace
            : {}),
          ...(finalDecision ? { final_decision: finalDecision } : {}),
          primary_path_used: 'guidance_fastpath',
        },
        route_health: {
          ...(selectedDecision?.route_health && typeof selectedDecision.route_health === 'object'
            ? selectedDecision.route_health
            : {}),
          fallback_triggered: false,
          fallback_reason: null,
          primary_path_used: 'guidance_fastpath',
          observer_nodes: [],
        },
        search_decision: searchDecision,
        query_exhausted: true,
      },
    };
  }

  return {
    buildGuidanceAttemptRecord,
    buildGuidanceSkippedAttemptRecord,
    shouldAdoptGuidanceAttempt,
    buildGuidanceSuccessContractResult,
    finalizeGuidanceLadderResult,
  };
}

module.exports = {
  createGuidanceLadderOutcomeRuntime,
};
