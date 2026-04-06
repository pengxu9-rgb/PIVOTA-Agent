function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function applyResolverRejectedMetadata(
  enriched,
  resolverRejectedReason = null,
  resolverRejectedQueryUsed = null,
) {
  if (!isPlainObject(enriched)) return enriched;
  const enrichedMetaForGates =
    isPlainObject(enriched.metadata) ? enriched.metadata : {};
  return {
    ...enriched,
    metadata: {
      ...enrichedMetaForGates,
      resolver_rejected_reason:
        enrichedMetaForGates.resolver_rejected_reason ||
        resolverRejectedReason ||
        null,
      resolver_query_used:
        enrichedMetaForGates.resolver_query_used ||
        enrichedMetaForGates.resolve_query_used ||
        resolverRejectedQueryUsed ||
        null,
    },
  };
}

function createFindProductsInvokeSuccessRuntime(deps = {}) {
  const {
    withSearchDiagnostics,
    buildSearchRouteHealth,
    buildSearchTrace,
    buildDecisionAuthorityPatch,
    applyBeautySearchMetadataAuthority,
    finalizeGuidanceOnlySearchResponse,
    normalizeSearchUiSurface,
    postProcessTravelLookupProductsResponse,
    extractExplicitCommerceSurface,
    attachEligibleOfferFieldsToSearchResponse,
    normalizeInvokeFinalSearchResponse,
    extractSearchQueryText,
    normalizeShoppingFinalSearchResponse,
  } = deps;

  async function finalizeInvokeSuccessResponse({
    enriched,
    primaryPathUsed = null,
    invokeStartedAtMs = 0,
    fallbackTriggered = false,
    fallbackReason = null,
    normalizedDecisionObserverNodes = [],
    traceAmbiguityScorePre = null,
    searchDecision = null,
    primaryDecisionLocked = false,
    primaryDecisionState = null,
    hasClarification = false,
    routeDegradeFlags = [],
    gatewayRequestId = null,
    queryText = '',
    expandedQuery = '',
    expansionMode = '',
    traceQueryClass = null,
    traceRewriteGate = null,
    traceAssociationPlan = null,
    traceFlagsSnapshot = null,
    effectiveIntent = null,
    cacheStage = null,
    upstreamStage = null,
    resolverStage = null,
    searchStageLedger = null,
    finalDecision = null,
    relevanceDebug = null,
    isStrictEmpty = false,
    semanticOwnerDecision = null,
    defaultSelectionOwner = 'shopping_agent_beauty_mainline',
    fpmGateTrace = [],
    fpmSkippedGatesDueToBudget = [],
    fpmLatencyGuardApplied = false,
    lowConfidenceFlag = false,
    normalizedLowConfidenceReasons = [],
    semanticContractMeta = null,
    semanticRewriteResultMeta = null,
    semanticOwnerQueryAttempts = [],
    semanticOwnerExternalRescueQueriesAttempted = [],
    semanticOwnerCacheSourceIsolated = false,
    semanticOwnerCacheSourceIsolationReason = null,
    semanticOwnerLastResortCacheApplied = false,
    semanticOwnerLastResortCacheQuery = null,
    findProductsExpansionMeta = null,
    primarySearchTimeoutMs = null,
    gatewayTotalBudgetMs = null,
    blockingGateInfo = null,
    querySource = '',
    resolverRejectedReason = null,
    resolverRejectedQueryUsed = null,
    metadata = null,
    effectivePayload = null,
    req = null,
    queryParams = null,
    requestedTargetStepFamily = null,
    operation = '',
    rawUserQuery = '',
  } = {}) {
    let nextEnriched = withSearchDiagnostics(enriched, {
      route_health: buildSearchRouteHealth({
        primaryPathUsed,
        primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
        fallbackTriggered,
        fallbackReason,
        observerNodes: normalizedDecisionObserverNodes,
        ambiguityScorePre:
          Number.isFinite(Number(searchDecision?.ambiguity_score_pre))
            ? Number(searchDecision.ambiguity_score_pre)
            : traceAmbiguityScorePre,
        ambiguityScorePost: searchDecision?.ambiguity_score_post,
        clarifyTriggered: hasClarification || Boolean(searchDecision?.clarify_triggered),
        degradeFlags: routeDegradeFlags,
      }),
      search_trace: buildSearchTrace({
        traceId: gatewayRequestId,
        rawQuery: queryText,
        expandedQuery,
        expansionMode,
        queryClass: searchDecision?.query_class || traceQueryClass,
        rewriteGate: traceRewriteGate,
        associationPlan: traceAssociationPlan,
        flagsSnapshot: traceFlagsSnapshot,
        intent: effectiveIntent,
        cacheStage,
        upstreamStage,
        resolverStage,
        stageLedger: searchStageLedger,
        finalDecision,
      }),
      search_decision: buildDecisionAuthorityPatch({
        body: enriched,
        finalDecision,
        primaryPathUsed,
        decisionAuthority: querySource,
        decisionLocked: true,
        decisionLockReason:
          primaryDecisionLocked && primaryDecisionState?.decisionLockReason
            ? primaryDecisionState.decisionLockReason
            : null,
      }),
      observer_nodes: normalizedDecisionObserverNodes,
      ...(relevanceDebug ? { relevance_debug: relevanceDebug } : {}),
      ...(isStrictEmpty
        ? {
            strict_empty: true,
            strict_empty_reason: fallbackReason || 'no_candidates',
          }
        : {}),
    });

    nextEnriched = applyBeautySearchMetadataAuthority({
      enriched: nextEnriched,
      semanticOwnerDecision,
      defaultSelectionOwner,
      fpmGateTrace,
      fpmSkippedGatesDueToBudget,
      fpmLatencyGuardApplied,
      lowConfidenceFlag,
      normalizedLowConfidenceReasons,
      semanticContractMeta,
      semanticRewriteResultMeta,
      semanticOwnerQueryAttempts,
      semanticOwnerExternalRescueQueriesAttempted,
      semanticOwnerCacheSourceIsolated,
      semanticOwnerCacheSourceIsolationReason,
      semanticOwnerLastResortCacheApplied,
      semanticOwnerLastResortCacheQuery,
      searchStageLedger,
      findProductsExpansionMeta,
      primarySearchTimeoutMs,
      gatewayTotalBudgetMs,
      blockingGateInfo,
      querySource,
    });

    nextEnriched = applyResolverRejectedMetadata(
      nextEnriched,
      resolverRejectedReason,
      resolverRejectedQueryUsed,
    );

    const finalGuidanceResult = await finalizeGuidanceOnlySearchResponse({
      response: nextEnriched,
      uiSurface:
        nextEnriched?.metadata?.ui_surface ||
        metadata?.ui_surface ||
        effectivePayload?.metadata?.ui_surface ||
        effectivePayload?.context?.ui_surface ||
        req?.query?.ui_surface ||
        req?.query?.uiSurface ||
        queryParams?.ui_surface ||
        queryParams?.uiSurface,
      requestedTargetStepFamily,
      queryText,
      req,
      query: queryParams,
    });
    nextEnriched = finalGuidanceResult.response;

    if (
      normalizeSearchUiSurface(
        nextEnriched?.metadata?.ui_surface ||
          metadata?.ui_surface ||
          effectivePayload?.metadata?.ui_surface ||
          effectivePayload?.context?.ui_surface,
      ) === 'travel_lookup'
    ) {
      nextEnriched = postProcessTravelLookupProductsResponse(nextEnriched);
    }

    const strictSurfaceState = extractExplicitCommerceSurface(
      effectivePayload?.search || effectivePayload || {},
      metadata,
    );
    if (operation === 'find_products_multi' && strictSurfaceState.explicit) {
      nextEnriched = attachEligibleOfferFieldsToSearchResponse(
        nextEnriched,
        strictSurfaceState.commerceSurface,
      );
    }

    return normalizeInvokeFinalSearchResponse({
      enriched: nextEnriched,
      operation,
      metadata,
      effectivePayload,
      req,
      queryParams,
      effectiveIntent,
      traceQueryClass,
      rawUserQuery,
      extractSearchQueryText,
      normalizeShoppingFinalSearchResponse,
    });
  }

  return {
    finalizeInvokeSuccessResponse,
  };
}

module.exports = {
  createFindProductsInvokeSuccessRuntime,
};
