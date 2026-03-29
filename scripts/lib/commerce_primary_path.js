const FALLBACK_QUERY_SOURCES = new Set([
  'agent_products_error_fallback',
  'agent_products_resolver_fallback',
  'agent_products_resolver_ref_fallback',
]);

const FALLBACK_REASON_PATTERNS = [
  /^resolver_after_primary$/i,
  /^primary_unusable_/i,
  /^secondary_after_primary_unusable$/i,
];

function extractMetadata(bodyOrMetadata = {}) {
  if (
    bodyOrMetadata &&
    typeof bodyOrMetadata === 'object' &&
    !Array.isArray(bodyOrMetadata) &&
    bodyOrMetadata.metadata &&
    typeof bodyOrMetadata.metadata === 'object' &&
    !Array.isArray(bodyOrMetadata.metadata)
  ) {
    return bodyOrMetadata.metadata;
  }
  if (
    bodyOrMetadata &&
    typeof bodyOrMetadata === 'object' &&
    !Array.isArray(bodyOrMetadata)
  ) {
    return bodyOrMetadata;
  }
  return {};
}

function normalizeObserverNodes(nodes = []) {
  const values = Array.isArray(nodes) ? nodes : nodes == null ? [] : [nodes];
  return Array.from(
    new Set(values.map((item) => String(item || '').trim()).filter(Boolean)),
  );
}

function assessPrimaryPath(bodyOrMetadata = {}) {
  const metadata = extractMetadata(bodyOrMetadata);
  const routeHealth =
    metadata && typeof metadata.route_health === 'object' && !Array.isArray(metadata.route_health)
      ? metadata.route_health
      : {};
  const proxySearchFallback =
    metadata &&
    typeof metadata.proxy_search_fallback === 'object' &&
    !Array.isArray(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : {};
  const searchTrace =
    metadata && typeof metadata.search_trace === 'object' && !Array.isArray(metadata.search_trace)
      ? metadata.search_trace
      : {};
  const searchDecision =
    metadata &&
    typeof metadata.search_decision === 'object' &&
    !Array.isArray(metadata.search_decision)
      ? metadata.search_decision
      : {};
  const querySource = String(metadata.query_source || '').trim();
  const decisionAuthority = String(searchDecision.decision_authority || querySource || '').trim();
  const decisionLocked = searchDecision.decision_locked === true;
  const decisionLockReason = String(searchDecision.decision_lock_reason || '').trim() || null;
  const primaryPathUsed = String(
    routeHealth.primary_path_used || searchTrace.primary_path_used || searchDecision.primary_path_used || '',
  ).trim();
  const authorityPrimaryPathUsed = String(
    searchDecision.primary_path_used || routeHealth.primary_path_used || searchTrace.primary_path_used || '',
  ).trim();
  const fallbackReason = String(
    metadata.fallback_reason ||
      routeHealth.fallback_reason ||
      searchTrace.fallback_reason ||
      searchDecision.fallback_reason ||
      proxySearchFallback.reason ||
      '',
  ).trim();
  const finalDecision = String(
    searchTrace.final_decision || searchDecision.final_decision || metadata.final_decision || '',
  ).trim();
  const strictEmpty = metadata.strict_empty === true || finalDecision === 'strict_empty';
  const observerNodes = normalizeObserverNodes(routeHealth.observer_nodes);
  const reasons = [];
  const effectiveQuerySource = decisionAuthority || querySource || null;
  const observerOnlyFallbackSignals =
    decisionLocked &&
    effectiveQuerySource &&
    !FALLBACK_QUERY_SOURCES.has(effectiveQuerySource);

  if (FALLBACK_QUERY_SOURCES.has(effectiveQuerySource || '')) {
    reasons.push(`query_source=${effectiveQuerySource}`);
  }
  if (proxySearchFallback.applied === true && !observerOnlyFallbackSignals) {
    reasons.push('proxy_search_fallback.applied=true');
  }
  if (routeHealth.fallback_triggered === true && !observerOnlyFallbackSignals) {
    reasons.push('route_health.fallback_triggered=true');
  }
  if (/(fallback|primary_unusable)/i.test(authorityPrimaryPathUsed || primaryPathUsed) && !observerOnlyFallbackSignals) {
    reasons.push(`route_health.primary_path_used=${authorityPrimaryPathUsed || primaryPathUsed}`);
  }
  if (
    fallbackReason &&
    FALLBACK_REASON_PATTERNS.some((pattern) => pattern.test(fallbackReason)) &&
    !observerOnlyFallbackSignals
  ) {
    reasons.push(`fallback_reason=${fallbackReason}`);
  }

  return {
    degraded: reasons.length > 0,
    reasons,
    querySource: effectiveQuerySource,
    decisionAuthority: effectiveQuerySource,
    decisionLocked,
    decisionLockReason,
    observerNodes,
    primaryPathUsed: authorityPrimaryPathUsed || primaryPathUsed || null,
    fallbackReason: fallbackReason || null,
    finalDecision: finalDecision || null,
    strictEmpty,
  };
}

function evaluatePrimaryPathContract(bodyOrMetadata = {}, spec = {}) {
  const assessment = assessPrimaryPath(bodyOrMetadata);
  const reasons = [];
  const requirePrimaryPath = spec.require_primary_path !== false;
  const allowStrictEmpty = spec.allow_strict_empty === true;
  const allowedQuerySources = Array.isArray(spec.allowed_query_sources)
    ? spec.allowed_query_sources.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const mustNotMatchFallbackSources = Array.isArray(spec.must_not_match_fallback_sources)
    ? spec.must_not_match_fallback_sources.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (requirePrimaryPath && assessment.degraded) {
    reasons.push(...assessment.reasons);
  }
  if (allowedQuerySources.length > 0 && !allowedQuerySources.includes(assessment.querySource || '')) {
    reasons.push(
      `query_source_not_allowed:expected=${JSON.stringify(allowedQuerySources)} actual=${JSON.stringify(assessment.querySource)}`,
    );
  }
  if (
    mustNotMatchFallbackSources.length > 0 &&
    mustNotMatchFallbackSources.includes(assessment.querySource || '')
  ) {
    reasons.push(`query_source_forbidden:${assessment.querySource}`);
  }
  if (!allowStrictEmpty && assessment.strictEmpty) {
    reasons.push(`strict_empty_not_allowed:${assessment.finalDecision || 'strict_empty'}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    assessment,
  };
}

module.exports = {
  FALLBACK_QUERY_SOURCES,
  assessPrimaryPath,
  evaluatePrimaryPathContract,
};
