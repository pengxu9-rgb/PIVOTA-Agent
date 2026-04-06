function createFindProductsInvokeBeautyAuthorityRuntime(deps = {}) {
  const {
    buildSearchRelevanceDebug,
    normalizeDecisionObserverNodes,
    countCandidateOriginBreakdown,
    buildSearchStageLedger,
    applyBeautySearchAuthority,
    FPM_CLARIFY_NEVER_EMPTY,
    SEARCH_RELEVANCE_DEBUG_ENABLED,
    FIND_PRODUCTS_MULTI_EXPANSION_MODE,
    BEAUTY_DISCOVERY_MAINLINE_OWNER,
  } = deps;

  function applyInvokeBeautyAuthority({
    enriched,
    existingMeta = null,
    operation = '',
    invalidHitApplied = false,
    isStrictEmpty = false,
    hasClarification = false,
    beautyMainlineAuthorityActive = false,
    products = [],
    searchDecision = null,
    querySource = '',
    findProductsExpansionMeta = null,
    effectiveIntent = null,
    decisionObserverNodes = [],
    rawProductsForQualityGate = [],
    primaryPathUsed = null,
    semanticContractMeta = null,
    semanticRewriteResultMeta = null,
    semanticOwnerControlled = false,
    semanticOwnerQueryAttempts = [],
    semanticOwnerDecision = null,
    primarySearchTimeoutMs = null,
    primaryQualityGatePassed = false,
    guidanceDirectSupplementValidHit = false,
    primaryIrrelevant = false,
    primaryMonoculture = false,
    primaryLowQualityNonempty = false,
    semanticRetryApplied = false,
    secondaryFallbackMeta = null,
    secondarySupplementMeta = null,
    skipSecondaryFallback = false,
    normalizedSecondaryFallbackSkipReason = null,
    strictBeautyDirectSearch = false,
    beautyDecisionOwner = null,
    beautySemanticOwner = null,
    semanticOwnerCacheSourceIsolated = false,
    semanticOwnerLastResortCacheApplied = false,
  } = {}) {
    const finalDecision = invalidHitApplied
      ? 'invalid_hit'
      : isStrictEmpty
      ? 'strict_empty'
      : hasClarification && beautyMainlineAuthorityActive && products.length > 0
        ? 'products_returned_with_clarification'
      : hasClarification && (!FPM_CLARIFY_NEVER_EMPTY || products.length === 0)
        ? 'clarify'
        : searchDecision?.final_decision
          ? String(searchDecision.final_decision)
          : hasClarification
            ? 'products_returned_with_clarification'
            : querySource.startsWith('cache_')
              ? 'cache_returned'
              : querySource.includes('resolver')
                ? 'resolver_returned'
                : 'upstream_returned';
    const expansionMode =
      operation === 'find_products_multi'
        ? findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE
        : 'off';
    const policyRouteDebug =
      existingMeta?.route_debug && typeof existingMeta.route_debug === 'object'
        ? existingMeta.route_debug.policy
        : null;
    const relevanceDebug =
      operation === 'find_products_multi' && SEARCH_RELEVANCE_DEBUG_ENABLED
        ? buildSearchRelevanceDebug({
            intent: effectiveIntent,
            products,
            diversityPenaltyApplied: Boolean(policyRouteDebug?.diversity?.penalty_applied),
          })
        : null;
    const normalizedDecisionNodes = normalizeDecisionObserverNodes(decisionObserverNodes);
    const sourceObservabilityProducts =
      Array.isArray(products) && products.length > 0
        ? products
        : Array.isArray(rawProductsForQualityGate)
        ? rawProductsForQualityGate
        : [];
    const sourceObservability = countCandidateOriginBreakdown(sourceObservabilityProducts);
    const searchStageLedger =
      operation === 'find_products_multi'
        ? buildSearchStageLedger({
            semanticContract: semanticContractMeta,
            semanticRewriteResult: semanticRewriteResultMeta,
            intentParseLatencyMs: findProductsExpansionMeta?.intent_parse_latency_ms,
            semanticRewriteTimeoutMs: findProductsExpansionMeta?.semantic_rewrite_timeout_ms,
            semanticOwnerLocked: semanticOwnerControlled,
            primarySearchTimeoutMs,
            primaryPathUsed,
            primaryQueryPackAttempts: semanticOwnerQueryAttempts,
            primarySourceTierCounts: sourceObservability.source_tier_counts,
            primarySourceQualityCounts: sourceObservability.source_quality_counts,
            primaryCacheOwnerPaths: sourceObservability.cache_owner_paths,
            primaryTopCandidateProvenance: sourceObservability.top_candidate_provenance,
            primaryQualityGatePassed,
            primaryQualityReason: guidanceDirectSupplementValidHit
              ? 'guidance_direct_valid_hit'
              : primaryIrrelevant
              ? 'primary_irrelevant'
              : primaryMonoculture
              ? 'primary_monoculture'
              : primaryLowQualityNonempty
              ? 'primary_low_quality'
              : 'primary_pass',
            secondaryRetryApplied: semanticRetryApplied,
            secondaryRetryActualAttempted: Boolean(
              secondaryFallbackMeta?.semantic_retry_actual_attempted,
            ),
            secondaryRetryQuery: secondaryFallbackMeta?.semantic_retry_query || null,
            secondaryRetryHits: secondaryFallbackMeta?.semantic_retry_hits || null,
            secondaryRetrySuppressedReason: skipSecondaryFallback
              ? normalizedSecondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
              : null,
            secondStageExpansionAttempted: Boolean(secondarySupplementMeta?.attempted),
            secondStageExpansionReason: secondarySupplementMeta?.reason || null,
            secondStageExpansionSuppressedReason:
              secondarySupplementMeta?.attempted === false
                ? secondarySupplementMeta?.reason || null
                : null,
            finalDecision,
            decisionOwner:
              beautyMainlineAuthorityActive
                ? BEAUTY_DISCOVERY_MAINLINE_OWNER
                : (semanticOwnerDecision || querySource),
          })
        : null;
    const beautyAuthority = applyBeautySearchAuthority({
      enriched,
      existingMeta,
      operation,
      strictBeautyDirectSearch,
      semanticOwnerControlled,
      beautyDecisionOwner,
      beautySemanticOwner,
      products,
      finalDecision,
      hasClarification,
      querySource,
      searchStageLedger,
      defaultSelectionOwner: BEAUTY_DISCOVERY_MAINLINE_OWNER,
      sourceObservability,
      semanticOwnerCacheSourceIsolated,
      semanticOwnerLastResortCacheApplied,
      searchDecision,
    });

    return {
      finalDecision,
      expansionMode,
      relevanceDebug,
      normalizedDecisionObserverNodes: normalizedDecisionNodes,
      searchStageLedger,
      lowConfidenceFlag: beautyAuthority.lowConfidenceFlag,
      normalizedLowConfidenceReasons: beautyAuthority.normalizedLowConfidenceReasons,
      enriched: beautyAuthority.enriched,
      existingMeta: beautyAuthority.existingMeta,
    };
  }

  return {
    applyInvokeBeautyAuthority,
  };
}

module.exports = {
  createFindProductsInvokeBeautyAuthorityRuntime,
};
