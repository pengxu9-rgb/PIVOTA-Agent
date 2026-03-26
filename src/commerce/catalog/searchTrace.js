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
} = {}) {
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
    final_decision: String(finalDecision || 'unknown'),
  };
}

module.exports = {
  buildSearchTrace,
};
