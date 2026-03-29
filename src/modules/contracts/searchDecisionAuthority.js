function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDecisionObserverNodes(...nodeLists) {
  const merged = [];
  for (const nodeList of nodeLists) {
    const items = Array.isArray(nodeList) ? nodeList : nodeList == null ? [] : [nodeList];
    for (const item of items) {
      const normalized = String(item || '').trim();
      if (!normalized || merged.includes(normalized)) continue;
      merged.push(normalized);
    }
  }
  return merged;
}

function inferDecisionLockReason({
  metadata = {},
  searchDecision = {},
  routeHealth = {},
  searchTrace = {},
  decisionAuthority = null,
} = {}) {
  const explicitReason = String(
    searchDecision.decision_lock_reason ||
      metadata.decision_lock_reason ||
      '',
  ).trim();
  if (explicitReason) return explicitReason;

  const crossMerchantCache =
    metadata?.route_debug?.cross_merchant_cache &&
    isPlainRecord(metadata.route_debug.cross_merchant_cache)
      ? metadata.route_debug.cross_merchant_cache
      : {};
  if (crossMerchantCache.main_path_contract_locked === true || metadata.main_path_contract_locked === true) {
    return 'guidance_cache_success_contract';
  }

  const finalDecision = String(
    searchDecision.final_decision ||
      searchTrace.final_decision ||
      metadata.final_decision ||
      '',
  )
    .trim()
    .toLowerCase();
  const primaryPathUsed = String(
    searchDecision.primary_path_used ||
      routeHealth.primary_path_used ||
      searchTrace.primary_path_used ||
      '',
  )
    .trim()
    .toLowerCase();
  const authority = String(decisionAuthority || metadata.query_source || '').trim().toLowerCase();
  if (finalDecision === 'cache_returned') return 'cache_main_path';
  if (finalDecision === 'resolver_returned') return 'resolver_authority';
  if (finalDecision === 'upstream_returned' || finalDecision === 'products_returned') {
    return 'primary_authority';
  }
  if (finalDecision === 'products_returned_with_clarification' || finalDecision === 'clarify') {
    return 'clarify_contract';
  }
  if (finalDecision === 'strict_empty') return 'strict_empty_contract';
  if (finalDecision === 'invalid_hit') return 'invalid_hit_contract';
  if (primaryPathUsed === 'guidance_fastpath' || authority === 'agent_products_guidance_fastpath') {
    return 'guidance_fastpath_success_contract';
  }
  return null;
}

function extractSearchDecisionAuthorityState(bodyOrMetadata = {}) {
  const metadata =
    isPlainRecord(bodyOrMetadata) && isPlainRecord(bodyOrMetadata.metadata)
      ? bodyOrMetadata.metadata
      : isPlainRecord(bodyOrMetadata)
      ? bodyOrMetadata
      : {};
  const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};
  const searchTrace = isPlainRecord(metadata.search_trace) ? metadata.search_trace : {};
  const searchDecision = isPlainRecord(metadata.search_decision) ? metadata.search_decision : {};
  const crossMerchantCache =
    metadata?.route_debug?.cross_merchant_cache &&
    isPlainRecord(metadata.route_debug.cross_merchant_cache)
      ? metadata.route_debug.cross_merchant_cache
      : {};
  const explicitDecisionLocked =
    searchDecision.decision_locked != null
      ? Boolean(searchDecision.decision_locked)
      : metadata.decision_locked != null
      ? Boolean(metadata.decision_locked)
      : null;
  const decisionLocked =
    explicitDecisionLocked != null
      ? explicitDecisionLocked
      : crossMerchantCache.main_path_contract_locked === true || metadata.main_path_contract_locked === true;
  const decisionAuthority =
    String(
      searchDecision.decision_authority ||
        metadata.query_source ||
        searchDecision.primary_path_used ||
        routeHealth.primary_path_used ||
        searchTrace.primary_path_used ||
        '',
    ).trim() || null;
  const observerNodes = normalizeDecisionObserverNodes(
    routeHealth.observer_nodes,
    metadata.observer_nodes,
  );
  return {
    decisionAuthority,
    decisionLocked,
    decisionLockReason: inferDecisionLockReason({
      metadata,
      searchDecision,
      routeHealth,
      searchTrace,
      decisionAuthority,
    }),
    observerNodes,
  };
}

function buildDecisionAuthorityPatch({
  body = null,
  finalDecision = null,
  primaryPathUsed = null,
  decisionAuthority = null,
  decisionLocked = true,
  decisionLockReason = null,
} = {}) {
  const metadata = isPlainRecord(body?.metadata) ? body.metadata : {};
  const resolvedAuthority =
    String(
      decisionAuthority ||
        metadata.query_source ||
        primaryPathUsed ||
        '',
    ).trim() || null;
  const searchDecision = isPlainRecord(metadata.search_decision) ? metadata.search_decision : {};
  const searchTrace = isPlainRecord(metadata.search_trace) ? metadata.search_trace : {};
  const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};

  return {
    final_decision:
      String(finalDecision || searchDecision.final_decision || searchTrace.final_decision || '').trim() || null,
    primary_path_used:
      String(primaryPathUsed || searchDecision.primary_path_used || routeHealth.primary_path_used || '').trim() ||
      null,
    decision_authority: resolvedAuthority,
    decision_locked: Boolean(decisionLocked),
    decision_lock_reason:
      String(
        decisionLockReason ||
          inferDecisionLockReason({
            metadata,
            searchDecision: {
              ...searchDecision,
              final_decision: finalDecision || searchDecision.final_decision || searchTrace.final_decision || null,
              primary_path_used:
                primaryPathUsed ||
                searchDecision.primary_path_used ||
                routeHealth.primary_path_used ||
                null,
            },
            routeHealth,
            searchTrace: {
              ...searchTrace,
              final_decision: finalDecision || searchTrace.final_decision || searchDecision.final_decision || null,
              primary_path_used:
                primaryPathUsed ||
                searchTrace.primary_path_used ||
                routeHealth.primary_path_used ||
                null,
            },
            decisionAuthority: resolvedAuthority,
          }) ||
          '',
      ).trim() || null,
  };
}

module.exports = {
  normalizeDecisionObserverNodes,
  inferDecisionLockReason,
  extractSearchDecisionAuthorityState,
  buildDecisionAuthorityPatch,
};
