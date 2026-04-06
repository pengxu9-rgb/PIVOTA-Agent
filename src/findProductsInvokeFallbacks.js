function createFindProductsInvokeFallbackRuntime(deps = {}) {
  const {
    normalizeAgentProductsListResponse,
    applyProxySearchFallbackMetadata,
    withSearchDiagnostics,
    buildSearchRouteHealth,
    buildSearchTrace,
    buildDecisionAuthorityPatch,
    buildCacheStageSnapshot,
    normalizeSearchUiSurface,
    postProcessTravelLookupProductsResponse,
    normalizeShoppingFinalSearchResponse,
    buildStrictEmptyFallbackResponse,
    extractSearchQueryText,
  } = deps;

  function buildInvokeOuterCacheGuardResponse({
    crossMerchantCacheProtectedResponse = null,
    queryParams = null,
    metadata = null,
    effectivePayload = null,
    err = null,
    invokeStartedAtMs = 0,
    traceAmbiguityScorePre = null,
    gatewayRequestId = null,
    rawUserQuery = '',
    findProductsExpansionMeta = null,
    traceQueryClass = null,
    traceRewriteGate = null,
    traceAssociationPlan = null,
    traceFlagsSnapshot = null,
    effectiveIntent = null,
    crossMerchantCacheRouteDebug = null,
    FIND_PRODUCTS_MULTI_EXPANSION_MODE = '',
  } = {}) {
    const queryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
    const cacheGuardBody = normalizeAgentProductsListResponse(crossMerchantCacheProtectedResponse, {
      limit: queryParams?.limit,
      offset: queryParams?.offset,
    });
    const cacheGuardDiagnosed = withSearchDiagnostics(
      applyProxySearchFallbackMetadata(cacheGuardBody, {
        applied: false,
        reason: 'invoke_outer_cache_guard',
        route: 'invoke_outer_catch_cache_guard',
      }),
      {
        route_health: buildSearchRouteHealth({
          primaryPathUsed: 'invoke_outer_cache_guard',
          primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
          fallbackTriggered: true,
          fallbackReason: 'invoke_outer_cache_guard',
          ambiguityScorePre: traceAmbiguityScorePre,
          clarifyTriggered: false,
        }),
        search_trace: buildSearchTrace({
          traceId: gatewayRequestId,
          rawQuery: queryText,
          expandedQuery: findProductsExpansionMeta?.expanded_query || queryText,
          expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
          queryClass: traceQueryClass,
          rewriteGate: traceRewriteGate,
          associationPlan: traceAssociationPlan,
          flagsSnapshot: traceFlagsSnapshot,
          intent: effectiveIntent,
          cacheStage: buildCacheStageSnapshot({
            hit: true,
            candidateCount: Number(crossMerchantCacheProtectedResponse?.products?.length || 0),
            relevantCount: Number(crossMerchantCacheProtectedResponse?.products?.length || 0),
            retrievalSources: [],
            cacheRouteDebug: crossMerchantCacheRouteDebug,
            selectedSource: 'internal_cache',
          }),
          upstreamStage: {
            called: true,
            timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
            status: Number(err?.response?.status || err?.status || 0) || null,
            latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
          },
          resolverStage: {
            called: false,
            hit: false,
            miss: false,
            latency_ms: null,
          },
          finalDecision: 'cache_returned',
        }),
        search_decision: buildDecisionAuthorityPatch({
          body: cacheGuardBody,
          finalDecision: 'cache_returned',
          primaryPathUsed: 'invoke_outer_cache_guard',
          decisionAuthority:
            cacheGuardBody?.metadata?.query_source || 'cache_cross_merchant_search',
          decisionLocked: true,
          decisionLockReason: 'cache_main_path',
        }),
      },
    );
    const finalCacheGuardBody =
      normalizeSearchUiSurface(
        metadata?.ui_surface ||
          effectivePayload?.metadata?.ui_surface ||
          effectivePayload?.context?.ui_surface,
      ) === 'travel_lookup'
        ? postProcessTravelLookupProductsResponse(cacheGuardDiagnosed)
        : cacheGuardDiagnosed;
    return {
      statusCode: 200,
      body: normalizeShoppingFinalSearchResponse({
        responseBody: finalCacheGuardBody,
        requestSource:
          metadata?.source ||
          effectivePayload?.metadata?.source ||
          effectivePayload?.context?.source ||
          queryParams?.source ||
          null,
        queryParams,
        intent: effectiveIntent,
        queryClass: traceQueryClass,
        queryText,
      }),
    };
  }

  function buildInvokeOuterStrictEmptyResponse({
    queryParams = null,
    err = null,
    upstreamStatus = null,
    upstreamCode = null,
    upstreamMessage = null,
    reason = '',
    invokeStartedAtMs = 0,
    traceAmbiguityScorePre = null,
    gatewayRequestId = null,
    rawUserQuery = '',
    findProductsExpansionMeta = null,
    traceQueryClass = null,
    traceRewriteGate = null,
    traceAssociationPlan = null,
    traceFlagsSnapshot = null,
    effectiveIntent = null,
    crossMerchantCacheRouteDebug = null,
    FIND_PRODUCTS_MULTI_EXPANSION_MODE = '',
  } = {}) {
    const queryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
    const strictEmpty = buildStrictEmptyFallbackResponse({
      body: null,
      queryParams,
      reason,
      upstreamStatus,
      upstreamCode,
      upstreamMessage,
      route: 'invoke_outer_catch',
      intent: effectiveIntent,
      queryClass: traceQueryClass,
      queryText,
    });
    const strictEmptyHasClarification = Boolean(strictEmpty?.clarification?.question);
    return {
      statusCode: 200,
      body: withSearchDiagnostics(strictEmpty, {
        route_health: buildSearchRouteHealth({
          primaryPathUsed: 'invoke_outer_catch',
          primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
          fallbackTriggered: true,
          fallbackReason: reason,
          ambiguityScorePre: traceAmbiguityScorePre,
          clarifyTriggered: strictEmptyHasClarification,
        }),
        search_trace: buildSearchTrace({
          traceId: gatewayRequestId,
          rawQuery: queryText,
          expandedQuery: findProductsExpansionMeta?.expanded_query || queryText,
          expansionMode: findProductsExpansionMeta?.mode || FIND_PRODUCTS_MULTI_EXPANSION_MODE,
          queryClass: traceQueryClass,
          rewriteGate: traceRewriteGate,
          associationPlan: traceAssociationPlan,
          flagsSnapshot: traceFlagsSnapshot,
          intent: effectiveIntent,
          cacheStage: buildCacheStageSnapshot({
            hit: false,
            candidateCount: 0,
            relevantCount: 0,
            retrievalSources: [],
            cacheRouteDebug: crossMerchantCacheRouteDebug,
            selectedSource: 'invoke_outer_exception',
          }),
          upstreamStage: {
            called: true,
            timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
            status: Number(upstreamStatus || 0) || null,
            latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
          },
          resolverStage: {
            called: false,
            hit: false,
            miss: false,
            latency_ms: null,
          },
          finalDecision: strictEmptyHasClarification ? 'clarify' : 'strict_empty',
        }),
        search_decision: buildDecisionAuthorityPatch({
          body: strictEmpty,
          finalDecision: strictEmptyHasClarification ? 'clarify' : 'strict_empty',
          primaryPathUsed: 'invoke_outer_catch',
          decisionAuthority:
            strictEmpty?.metadata?.query_source || 'agent_products_error_fallback',
          decisionLocked: true,
          decisionLockReason: strictEmptyHasClarification
            ? 'clarify_contract'
            : 'strict_empty_contract',
        }),
        strict_empty: !strictEmptyHasClarification,
        ...(strictEmptyHasClarification ? {} : { strict_empty_reason: reason }),
      }),
    };
  }

  return {
    buildInvokeOuterCacheGuardResponse,
    buildInvokeOuterStrictEmptyResponse,
  };
}

module.exports = {
  createFindProductsInvokeFallbackRuntime,
};
