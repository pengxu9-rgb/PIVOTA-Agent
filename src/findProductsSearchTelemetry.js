function createFindProductsSearchTelemetryRuntime(deps = {}) {
  const {
    normalizeDecisionObserverNodes,
    buildServiceVersionMetadata,
    isPlainRecord,
    toNonNegativeNumberOrNull,
    toNonEmptyStringOrNull,
  } = deps;

  function buildSearchRouteHealth({
    primaryPathUsed,
    primaryLatencyMs,
    fallbackTriggered,
    fallbackReason,
    ambiguityScorePre = null,
    ambiguityScorePost = null,
    clarifyTriggered = false,
    degradeFlags = null,
    orchestratorPath = null,
    decisionNode = null,
    querySemanticClass = null,
    domainFilterDroppedExternal = 0,
    externalFillGateReason = null,
    semanticRetryApplied = false,
    semanticRetryActualAttempted = false,
    semanticRetryQuery = null,
    semanticRetryHits = 0,
    externalSeedQueryTimeout = false,
    externalSeedSkipReason = null,
    externalSeedCacheHit = false,
    externalSeedRowsFetched = 0,
    externalSeedRowsBuilt = 0,
    externalSeedBrandStrictRows = 0,
    externalSeedBrandRelevantRows = 0,
    externalSeedBroadFallbackUsed = false,
    externalSeedBroadScopeRows = 0,
    internalRawCount = 0,
    externalRawCount = 0,
    mergedPreLimitCount = 0,
    primaryQualityGatePassed = true,
    primaryQualityScore = null,
    primaryTargetRelevantCount = 0,
    primaryTop3QualityScore = null,
    primaryStrongEvidencePassed = null,
    primaryQualityReason = null,
    lowQualityNonemptyDetected = false,
    supplementAttempted = false,
    supplementSkipReason = null,
    retryAttemptCount = 0,
    fallbackAttemptCount = 0,
    selectedFallbackAttempt = 0,
    finalReturnedCount = 0,
    observerNodes = null,
  }) {
    const normalizedExternalSeedSkipReason = externalSeedSkipReason
      ? String(externalSeedSkipReason || '').trim() || null
      : null;
    const derivedExternalSeedCacheHit =
      Boolean(externalSeedCacheHit) || normalizedExternalSeedSkipReason === 'cache_hit';
    return {
      orchestrator_path: orchestratorPath ? String(orchestratorPath) : 'external_invoke_route',
      decision_node: decisionNode ? String(decisionNode) : String(primaryPathUsed || 'unknown'),
      primary_path_used: String(primaryPathUsed || 'unknown'),
      primary_latency_ms: Math.max(0, Number(primaryLatencyMs || 0) || 0),
      fallback_triggered: Boolean(fallbackTriggered),
      fallback_reason: fallbackReason ? String(fallbackReason) : null,
      query_semantic_class: querySemanticClass ? String(querySemanticClass) : 'default',
      domain_filter_dropped_external: Math.max(
        0,
        Number.isFinite(Number(domainFilterDroppedExternal)) ? Number(domainFilterDroppedExternal) : 0,
      ),
      external_fill_gate_reason: externalFillGateReason ? String(externalFillGateReason) : null,
      semantic_retry_applied: Boolean(semanticRetryApplied),
      semantic_retry_actual_attempted: Boolean(semanticRetryActualAttempted),
      semantic_retry_query: semanticRetryQuery ? String(semanticRetryQuery) : null,
      semantic_retry_hits: Math.max(
        0,
        Number.isFinite(Number(semanticRetryHits)) ? Number(semanticRetryHits) : 0,
      ),
      external_seed_query_timeout: Boolean(externalSeedQueryTimeout),
      external_seed_skip_reason: normalizedExternalSeedSkipReason,
      external_seed_cache_hit: derivedExternalSeedCacheHit,
      external_seed_rows_fetched: Math.max(
        0,
        Number.isFinite(Number(externalSeedRowsFetched)) ? Number(externalSeedRowsFetched) : 0,
      ),
      external_seed_rows_built: Math.max(
        0,
        Number.isFinite(Number(externalSeedRowsBuilt)) ? Number(externalSeedRowsBuilt) : 0,
      ),
      external_seed_brand_strict_rows: Math.max(
        0,
        Number.isFinite(Number(externalSeedBrandStrictRows)) ? Number(externalSeedBrandStrictRows) : 0,
      ),
      external_seed_brand_relevant_rows: Math.max(
        0,
        Number.isFinite(Number(externalSeedBrandRelevantRows)) ? Number(externalSeedBrandRelevantRows) : 0,
      ),
      external_seed_broad_fallback_used: Boolean(externalSeedBroadFallbackUsed),
      external_seed_broad_scope_rows: Math.max(
        0,
        Number.isFinite(Number(externalSeedBroadScopeRows)) ? Number(externalSeedBroadScopeRows) : 0,
      ),
      internal_raw_count: Math.max(
        0,
        Number.isFinite(Number(internalRawCount)) ? Number(internalRawCount) : 0,
      ),
      external_raw_count: Math.max(
        0,
        Number.isFinite(Number(externalRawCount)) ? Number(externalRawCount) : 0,
      ),
      merged_pre_limit_count: Math.max(
        0,
        Number.isFinite(Number(mergedPreLimitCount)) ? Number(mergedPreLimitCount) : 0,
      ),
      primary_quality_gate_passed: Boolean(primaryQualityGatePassed),
      primary_quality_score:
        Number.isFinite(Number(primaryQualityScore)) && Number(primaryQualityScore) >= 0
          ? Math.max(0, Math.min(1, Number(primaryQualityScore)))
          : null,
      primary_target_relevant_count: Math.max(
        0,
        Number.isFinite(Number(primaryTargetRelevantCount)) ? Number(primaryTargetRelevantCount) : 0,
      ),
      primary_top3_quality_score:
        Number.isFinite(Number(primaryTop3QualityScore)) ? Number(primaryTop3QualityScore) : null,
      primary_strong_evidence_passed:
        primaryStrongEvidencePassed == null ? null : Boolean(primaryStrongEvidencePassed),
      primary_quality_reason: primaryQualityReason ? String(primaryQualityReason) : null,
      low_quality_nonempty_detected: Boolean(lowQualityNonemptyDetected),
      supplement_attempted: Boolean(supplementAttempted),
      supplement_skip_reason: supplementSkipReason ? String(supplementSkipReason) : null,
      retry_attempt_count: Math.max(
        0,
        Number.isFinite(Number(retryAttemptCount)) ? Number(retryAttemptCount) : 0,
      ),
      fallback_attempt_count: Math.max(
        0,
        Number.isFinite(Number(fallbackAttemptCount)) ? Number(fallbackAttemptCount) : 0,
      ),
      selected_fallback_attempt: Math.max(
        0,
        Number.isFinite(Number(selectedFallbackAttempt)) ? Number(selectedFallbackAttempt) : 0,
      ),
      observer_nodes: normalizeDecisionObserverNodes(observerNodes),
      final_returned_count: Math.max(
        0,
        Number.isFinite(Number(finalReturnedCount)) ? Number(finalReturnedCount) : 0,
      ),
      ambiguity_score_pre: Number.isFinite(Number(ambiguityScorePre))
        ? Math.max(0, Math.min(1, Number(ambiguityScorePre)))
        : null,
      ambiguity_score_post: Number.isFinite(Number(ambiguityScorePost))
        ? Math.max(0, Math.min(1, Number(ambiguityScorePost)))
        : null,
      clarify_triggered: Boolean(clarifyTriggered),
      degrade_flags:
        degradeFlags && typeof degradeFlags === 'object' && !Array.isArray(degradeFlags)
          ? {
              vector_skipped: Boolean(degradeFlags.vector_skipped),
              behavior_skipped: Boolean(degradeFlags.behavior_skipped),
              nlu_degraded: Boolean(degradeFlags.nlu_degraded),
            }
          : null,
    };
  }

  function buildSearchTrace({
    traceId,
    rawQuery,
    expandedQuery,
    expansionMode,
    intent,
    cacheStage,
    upstreamStage,
    resolverStage,
    finalDecision,
    queryClass = null,
    rewriteGate = null,
    associationPlan = null,
    flagsSnapshot = null,
    stageLedger = null,
  }) {
    return {
      trace_id: String(traceId || ''),
      raw_query: String(rawQuery || ''),
      expanded_query: String(expandedQuery || rawQuery || ''),
      expansion_mode: String(expansionMode || 'conservative'),
      query_class: queryClass ? String(queryClass) : null,
      rewrite_gate:
        rewriteGate && typeof rewriteGate === 'object' && !Array.isArray(rewriteGate)
          ? rewriteGate
          : null,
      association_plan:
        associationPlan && typeof associationPlan === 'object' && !Array.isArray(associationPlan)
          ? associationPlan
          : null,
      flags_snapshot:
        flagsSnapshot && typeof flagsSnapshot === 'object' && !Array.isArray(flagsSnapshot)
          ? flagsSnapshot
          : null,
      intent_domain: intent?.primary_domain || null,
      intent_target: intent?.target_object?.type || null,
      intent_scenario: intent?.scenario?.name || null,
      scenario: intent?.scenario?.name || null,
      cache_stage: cacheStage || null,
      upstream_stage: upstreamStage || null,
      resolver_stage: resolverStage || null,
      stage_ledger:
        stageLedger && typeof stageLedger === 'object' && !Array.isArray(stageLedger)
          ? stageLedger
          : null,
      final_decision: String(finalDecision || 'unknown'),
    };
  }

  function buildSearchStageLedger({
    semanticContract = null,
    semanticRewriteResult = null,
    intentParseLatencyMs = null,
    semanticRewriteTimeoutMs = null,
    semanticOwnerLocked = false,
    primarySearchTimeoutMs = null,
    primaryPathUsed = null,
    primaryQueryPackAttempts = null,
    primarySourceTierCounts = null,
    primarySourceQualityCounts = null,
    primaryCacheOwnerPaths = null,
    primaryTopCandidateProvenance = null,
    primaryQualityGatePassed = null,
    primaryQualityReason = null,
    secondaryRetryApplied = false,
    secondaryRetryActualAttempted = false,
    secondaryRetryQuery = null,
    secondaryRetryHits = 0,
    secondaryRetrySuppressedReason = null,
    secondStageExpansionAttempted = false,
    secondStageExpansionReason = null,
    secondStageExpansionSuppressedReason = null,
    finalDecision = null,
    decisionOwner = null,
  } = {}) {
    return {
      intent_parse: {
        owner: 'shopping_agent_intent_parse',
        applied: true,
        latency_ms:
          Number.isFinite(Number(intentParseLatencyMs)) && Number(intentParseLatencyMs) >= 0
            ? Number(intentParseLatencyMs)
            : null,
      },
      semantic_rewrite: {
        owner:
          String(semanticRewriteResult?.owner || '').trim() || 'shopping_agent_semantic_rewrite',
        applied: Boolean(semanticRewriteResult?.applied),
        mode: String(semanticRewriteResult?.mode || 'deterministic_fallback'),
        provider: String(semanticRewriteResult?.provider || '').trim() || null,
        llm_provider_chain: Array.isArray(semanticRewriteResult?.llm_provider_chain)
          ? semanticRewriteResult.llm_provider_chain
          : [],
        llm_primary_provider: String(semanticRewriteResult?.llm_primary_provider || '').trim() || null,
        llm_fallback_provider: String(semanticRewriteResult?.llm_fallback_provider || '').trim() || null,
        llm_model: String(semanticRewriteResult?.llm_model || '').trim() || null,
        llm_model_owner: String(semanticRewriteResult?.llm_model_owner || '').trim() || null,
        llm_error_class: String(semanticRewriteResult?.llm_error_class || '').trim() || null,
        llm_error_stage: String(semanticRewriteResult?.llm_error_stage || '').trim() || null,
        llm_error_provider: String(semanticRewriteResult?.llm_error_provider || '').trim() || null,
        llm_error_message: String(semanticRewriteResult?.llm_error_message || '').trim() || null,
        llm_finish_reason: String(semanticRewriteResult?.llm_finish_reason || '').trim() || null,
        llm_raw_preview: String(semanticRewriteResult?.llm_raw_preview || '').trim() || null,
        llm_candidate_count:
          Number.isFinite(Number(semanticRewriteResult?.llm_candidate_count)) &&
          Number(semanticRewriteResult?.llm_candidate_count) >= 0
            ? Number(semanticRewriteResult.llm_candidate_count)
            : null,
        llm_upstream_status:
          Number.isFinite(Number(semanticRewriteResult?.llm_upstream_status)) &&
          Number(semanticRewriteResult?.llm_upstream_status) > 0
            ? Number(semanticRewriteResult.llm_upstream_status)
            : null,
        llm_upstream_error_code: String(semanticRewriteResult?.llm_upstream_error_code || '').trim() || null,
        llm_upstream_error_message:
          String(semanticRewriteResult?.llm_upstream_error_message || '').trim() || null,
        enable_owner: String(semanticRewriteResult?.enable_owner || '').trim() || null,
        provider_owner: String(semanticRewriteResult?.provider_owner || '').trim() || null,
        fallback_owner: String(semanticRewriteResult?.fallback_owner || '').trim() || null,
        latency_ms:
          Number.isFinite(Number(semanticRewriteResult?.latency_ms)) &&
          Number(semanticRewriteResult?.latency_ms) >= 0
            ? Number(semanticRewriteResult.latency_ms)
            : null,
        timeout_ms:
          Number.isFinite(Number(semanticRewriteTimeoutMs)) && Number(semanticRewriteTimeoutMs) >= 0
            ? Number(semanticRewriteTimeoutMs)
            : null,
        fallback_reason: String(semanticRewriteResult?.fallback_reason || '').trim() || null,
        llm_enrichment_attempted: Boolean(semanticRewriteResult?.llm_enrichment_attempted),
        llm_enrichment_applied: Boolean(semanticRewriteResult?.llm_enrichment_applied),
        llm_enrichment_status:
          String(semanticRewriteResult?.llm_enrichment_status || '').trim() || null,
        llm_enrichment_mode:
          String(semanticRewriteResult?.llm_enrichment_mode || '').trim() || null,
        normalized_query_pack: Array.isArray(semanticRewriteResult?.normalized_query_pack)
          ? semanticRewriteResult.normalized_query_pack
          : [],
        hard_filters:
          semanticRewriteResult?.hard_filters &&
          typeof semanticRewriteResult.hard_filters === 'object' &&
          !Array.isArray(semanticRewriteResult.hard_filters)
            ? semanticRewriteResult.hard_filters
            : {},
        soft_filters:
          semanticRewriteResult?.soft_filters &&
          typeof semanticRewriteResult.soft_filters === 'object' &&
          !Array.isArray(semanticRewriteResult.soft_filters)
            ? semanticRewriteResult.soft_filters
            : {},
        semantic_contract:
          semanticContract && typeof semanticContract === 'object' && !Array.isArray(semanticContract)
            ? semanticContract
            : null,
        owner_locked: Boolean(semanticOwnerLocked),
        single_provider_locked: Boolean(semanticRewriteResult?.single_provider_locked),
      },
      primary_search: {
        owner: 'shopping_agent_primary_search',
        applied: true,
        primary_path_used: String(primaryPathUsed || '').trim() || null,
        query_pack_attempts: Array.isArray(primaryQueryPackAttempts)
          ? primaryQueryPackAttempts
          : [],
        source_tier_counts:
          primarySourceTierCounts &&
          typeof primarySourceTierCounts === 'object' &&
          !Array.isArray(primarySourceTierCounts)
            ? primarySourceTierCounts
            : {},
        source_quality_counts:
          primarySourceQualityCounts &&
          typeof primarySourceQualityCounts === 'object' &&
          !Array.isArray(primarySourceQualityCounts)
            ? primarySourceQualityCounts
            : {},
        cache_owner_paths: Array.isArray(primaryCacheOwnerPaths) ? primaryCacheOwnerPaths : [],
        top_candidate_provenance:
          primaryTopCandidateProvenance &&
          typeof primaryTopCandidateProvenance === 'object' &&
          !Array.isArray(primaryTopCandidateProvenance)
            ? primaryTopCandidateProvenance
            : null,
        timeout_ms:
          Number.isFinite(Number(primarySearchTimeoutMs)) && Number(primarySearchTimeoutMs) >= 0
            ? Number(primarySearchTimeoutMs)
            : null,
      },
      quality_gate: {
        owner: 'shopping_agent_quality_gate',
        applied: true,
        passed:
          primaryQualityGatePassed == null ? null : Boolean(primaryQualityGatePassed),
        reason: String(primaryQualityReason || '').trim() || null,
      },
      secondary_retry: {
        owner: 'shopping_agent_secondary_retry',
        applied: Boolean(secondaryRetryApplied),
        actual_attempted: Boolean(secondaryRetryActualAttempted),
        query: String(secondaryRetryQuery || '').trim() || null,
        hits: Math.max(0, Number(secondaryRetryHits || 0) || 0),
        suppressed_reason: String(secondaryRetrySuppressedReason || '').trim() || null,
      },
      second_stage_expansion: {
        owner: 'shopping_agent_second_stage_expansion',
        applied: Boolean(secondStageExpansionAttempted),
        reason: String(secondStageExpansionReason || '').trim() || null,
        suppressed_reason: String(secondStageExpansionSuppressedReason || '').trim() || null,
      },
      final_decision: {
        owner: String(decisionOwner || '').trim() || null,
        decision: String(finalDecision || '').trim() || null,
      },
    };
  }

  function resolveInvokeFailureStage({
    statusCode = 200,
    body = null,
    metadata = null,
    finalDecision = null,
    hasClarification = false,
  } = {}) {
    const data = isPlainRecord(body) ? body : {};
    const meta = isPlainRecord(metadata) ? metadata : {};
    const routeTrace = isPlainRecord(meta.route_trace) ? meta.route_trace : {};
    const upstreamError = String(data.error || '').trim().toUpperCase();
    const finalDecisionToken = String(finalDecision || '').trim().toLowerCase();
    if (routeTrace.failure_stage) {
      return toNonEmptyStringOrNull(routeTrace.failure_stage);
    }
    if (upstreamError === 'INVALID_REQUEST') return 'request_validation';
    if (upstreamError === 'AUTH_INTROSPECT_UNAVAILABLE') return 'auth_introspection';
    if (upstreamError === 'UNAUTHORIZED') return 'auth_rejected';
    if (upstreamError === 'UPSTREAM_TIMEOUT') return 'upstream_timeout';
    if (
      upstreamError === 'UPSTREAM_UNAVAILABLE' ||
      upstreamError === 'UPSTREAM_ERROR' ||
      upstreamError === 'SERVICE_UNAVAILABLE'
    ) {
      return 'candidate_retrieval_error';
    }
    if (upstreamError === 'INTERNAL_ERROR') return 'gateway_internal';
    if (meta.budget_fx_unresolved === true) return 'budget_fx_unresolved';
    if (hasClarification || finalDecisionToken === 'clarify') return 'clarify_required';
    if (meta.strict_empty === true || finalDecisionToken === 'strict_empty') return 'search_no_candidates';
    if (Number(statusCode || 0) >= 500) return 'upstream_error';
    return null;
  }

  function buildInvokeRouteTrace({
    operation = '',
    req = null,
    routeContext = {},
    gatewayRequestId = null,
    debugRuntime = {},
    body = null,
    invokeStartedAtMs = 0,
    upstreamElapsedMs = 0,
  } = {}) {
    const data = isPlainRecord(body) ? body : {};
    const metadata = isPlainRecord(data.metadata) ? data.metadata : {};
    const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};
    const searchTrace = isPlainRecord(metadata.search_trace) ? metadata.search_trace : {};
    const totalLatencyMs = Math.max(0, Date.now() - Number(invokeStartedAtMs || Date.now()));
    const primaryLatencyMs =
      toNonNegativeNumberOrNull(routeHealth.primary_latency_ms) ||
      toNonNegativeNumberOrNull(metadata.gateway_latency_ms) ||
      null;
    const responseEnvelopeMs =
      primaryLatencyMs == null ? totalLatencyMs : Math.max(0, totalLatencyMs - primaryLatencyMs);
    const querySource = toNonEmptyStringOrNull(metadata.query_source);
    const hasClarification = Boolean(data?.clarification && data.clarification.question);
    const finalDecision = toNonEmptyStringOrNull(
      searchTrace.final_decision ||
        metadata?.search_decision?.final_decision ||
        metadata.final_decision ||
        null,
    );
    const routeTrace = isPlainRecord(metadata.route_trace) ? metadata.route_trace : {};
    return {
      gateway_request_id: gatewayRequestId || null,
      authoritative_endpoint:
        toNonEmptyStringOrNull(req?.baseUrl && req?.path ? `${req.baseUrl}${req.path}` : null) ||
        toNonEmptyStringOrNull(req?.originalUrl) ||
        '/agent/shop/v1/invoke',
      client_channel: toNonEmptyStringOrNull(routeContext.client_channel) || 'shop',
      invocation_surface:
        toNonEmptyStringOrNull(routeContext.invocation_surface) ||
        toNonEmptyStringOrNull(metadata?.gateway_invocation?.surface),
      operation: toNonEmptyStringOrNull(operation),
      query_source: querySource,
      final_decision: finalDecision,
      failure_stage: resolveInvokeFailureStage({
        statusCode: Number(req?.res?.statusCode || 0) || 200,
        body: data,
        metadata,
        finalDecision,
        hasClarification,
      }),
      node_timings_ms: {
        ingress_auth: null,
        source_profile_normalization: null,
        query_classification: toNonNegativeNumberOrNull(debugRuntime.nluLatencyMs),
        cache_lookup:
          querySource && querySource.startsWith('cache_') ? primaryLatencyMs : null,
        budget_fx_resolution:
          metadata.budget_currency != null || metadata.budget_fx_candidate_currency != null ? null : null,
        candidate_retrieval: primaryLatencyMs,
        ranking_shaping: toNonNegativeNumberOrNull(debugRuntime.rankLatencyMs),
        response_envelope: responseEnvelopeMs,
        gateway_total: totalLatencyMs,
        upstream_total: toNonNegativeNumberOrNull(upstreamElapsedMs),
        vector_routing: toNonNegativeNumberOrNull(debugRuntime.vectorLatencyMs),
        behavior_routing: toNonNegativeNumberOrNull(debugRuntime.behaviorLatencyMs),
      },
      primary_path_used:
        toNonEmptyStringOrNull(routeHealth.primary_path_used) ||
        toNonEmptyStringOrNull(searchTrace.primary_path_used) ||
        null,
      fallback_used: Boolean(routeHealth.fallback_triggered === true),
      primary_path_degraded: Boolean(routeHealth.fallback_triggered === true),
      contract_path: toNonEmptyStringOrNull(metadata?.contract_bridge?.resolved_contract),
      existing_failure_stage: toNonEmptyStringOrNull(routeTrace.failure_stage),
    };
  }

  function finalizeInvokeAuthoritativeResponseEnvelope({
    body = null,
    operation = '',
    req = null,
    routeContext = {},
    gatewayRequestId = null,
    debugRuntime = {},
    invokeStartedAtMs = 0,
    upstreamElapsedMs = 0,
  } = {}) {
    if (!isPlainRecord(body)) return body;
    const metadata = isPlainRecord(body.metadata) ? body.metadata : {};
    const routeTrace = buildInvokeRouteTrace({
      operation,
      req,
      routeContext,
      gatewayRequestId,
      debugRuntime,
      body,
      invokeStartedAtMs,
      upstreamElapsedMs,
    });
    return {
      ...body,
      metadata: {
        ...metadata,
        service_version: buildServiceVersionMetadata(),
        route_trace: {
          ...(isPlainRecord(metadata.route_trace) ? metadata.route_trace : {}),
          ...routeTrace,
        },
      },
    };
  }

  return {
    buildSearchRouteHealth,
    buildSearchTrace,
    buildSearchStageLedger,
    buildInvokeRouteTrace,
    finalizeInvokeAuthoritativeResponseEnvelope,
  };
}

module.exports = {
  createFindProductsSearchTelemetryRuntime,
};
