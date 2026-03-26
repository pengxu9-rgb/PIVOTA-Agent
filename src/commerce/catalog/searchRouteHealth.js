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
  lowQualityNonemptyDetected = false,
  supplementAttempted = false,
  supplementSkipReason = null,
  retryAttemptCount = 0,
  fallbackAttemptCount = 0,
  selectedFallbackAttempt = 0,
  finalReturnedCount = 0,
} = {}) {
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
      Number.isFinite(Number(domainFilterDroppedExternal))
        ? Number(domainFilterDroppedExternal)
        : 0,
    ),
    external_fill_gate_reason: externalFillGateReason
      ? String(externalFillGateReason)
      : null,
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
      Number.isFinite(Number(externalSeedRowsFetched))
        ? Number(externalSeedRowsFetched)
        : 0,
    ),
    external_seed_rows_built: Math.max(
      0,
      Number.isFinite(Number(externalSeedRowsBuilt)) ? Number(externalSeedRowsBuilt) : 0,
    ),
    external_seed_brand_strict_rows: Math.max(
      0,
      Number.isFinite(Number(externalSeedBrandStrictRows))
        ? Number(externalSeedBrandStrictRows)
        : 0,
    ),
    external_seed_brand_relevant_rows: Math.max(
      0,
      Number.isFinite(Number(externalSeedBrandRelevantRows))
        ? Number(externalSeedBrandRelevantRows)
        : 0,
    ),
    external_seed_broad_fallback_used: Boolean(externalSeedBroadFallbackUsed),
    external_seed_broad_scope_rows: Math.max(
      0,
      Number.isFinite(Number(externalSeedBroadScopeRows))
        ? Number(externalSeedBroadScopeRows)
        : 0,
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
      Number.isFinite(Number(selectedFallbackAttempt))
        ? Number(selectedFallbackAttempt)
        : 0,
    ),
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

module.exports = {
  buildSearchRouteHealth,
};
