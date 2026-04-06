function createFindProductsInvokeDecisionContextRuntime(deps = {}) {
  const {
    buildFashionConstraintMetadata,
    toNonEmptyStringOrNull,
    isErrorSoftFallbackQuerySource,
    SEARCH_STRICT_EMPTY_ENABLED,
  } = deps;

  function prepareInvokeSearchDecisionContext({
    enriched = null,
    existingMeta = null,
    queryText = '',
    skincareHitDecision = {},
    effectiveObservationOnlyBeautySkincareHitQualityGate = false,
    rawProductsForQualityGate = [],
    crossMerchantCacheRouteDebug = null,
    shouldAttemptResolverFirst = false,
    resolverFirstResult = null,
    responseStatus = null,
    invokeStartedAtMs = 0,
    operation = '',
    findProductsExpansionMeta = null,
  } = {}) {
    const fallbackMeta =
      existingMeta &&
      typeof existingMeta === 'object' &&
      !Array.isArray(existingMeta) &&
      existingMeta.proxy_search_fallback &&
      typeof existingMeta.proxy_search_fallback === 'object' &&
      !Array.isArray(existingMeta.proxy_search_fallback)
        ? existingMeta.proxy_search_fallback
        : null;
    let nextEnriched = enriched;
    let nextExistingMeta = existingMeta;
    const products = Array.isArray(nextEnriched?.products) ? nextEnriched.products : [];
    const clarificationPayload =
      nextEnriched &&
      typeof nextEnriched === 'object' &&
      !Array.isArray(nextEnriched) &&
      nextEnriched.clarification &&
      typeof nextEnriched.clarification === 'object'
        ? nextEnriched.clarification
        : null;
    const shouldRefreshFashionConstraintMatches =
      products.length > 0 &&
      (
        Array.isArray(nextExistingMeta?.visible_category_intents) ||
        Array.isArray(nextExistingMeta?.visible_attribute_intents) ||
        Array.isArray(nextExistingMeta?.visible_option_intents)
      ) &&
      (
        !Array.isArray(nextExistingMeta?.matched_visible_categories) ||
        nextExistingMeta.matched_visible_categories.length === 0 ||
        !Array.isArray(nextExistingMeta?.matched_visible_attribute_labels) ||
        nextExistingMeta.matched_visible_attribute_labels.length === 0 ||
        !Array.isArray(nextExistingMeta?.matched_visible_option_labels) ||
        nextExistingMeta.matched_visible_option_labels.length === 0
      );
    if (shouldRefreshFashionConstraintMatches) {
      const refreshedFashionConstraintMetadata = buildFashionConstraintMetadata({
        rawQuery: queryText,
        products,
        existingMetadata: nextExistingMeta,
      });
      nextEnriched = {
        ...nextEnriched,
        metadata: {
          ...nextExistingMeta,
          ...refreshedFashionConstraintMetadata,
        },
      };
      nextExistingMeta =
        nextEnriched &&
        typeof nextEnriched === 'object' &&
        !Array.isArray(nextEnriched) &&
        nextEnriched.metadata
          ? nextEnriched.metadata
          : {};
    }
    const hasClarification = Boolean(clarificationPayload?.question);
    const searchDecision =
      nextExistingMeta &&
      typeof nextExistingMeta === 'object' &&
      !Array.isArray(nextExistingMeta) &&
      nextExistingMeta.search_decision &&
      typeof nextExistingMeta.search_decision === 'object'
        ? nextExistingMeta.search_decision
        : null;
    const invalidHitApplied =
      skincareHitDecision.applied &&
      skincareHitDecision.hit_quality === 'invalid_hit' &&
      !effectiveObservationOnlyBeautySkincareHitQualityGate;
    const isStrictEmpty =
      SEARCH_STRICT_EMPTY_ENABLED &&
      queryText.length > 0 &&
      products.length === 0 &&
      !hasClarification &&
      !invalidHitApplied;
    const querySource =
      String(nextExistingMeta?.query_source || '').trim() || 'agent_products_search';
    const existingRouteHealth =
      nextExistingMeta &&
      typeof nextExistingMeta === 'object' &&
      !Array.isArray(nextExistingMeta) &&
      nextExistingMeta.route_health &&
      typeof nextExistingMeta.route_health === 'object' &&
      !Array.isArray(nextExistingMeta.route_health)
        ? nextExistingMeta.route_health
        : null;
    const existingSearchTrace =
      nextExistingMeta &&
      typeof nextExistingMeta === 'object' &&
      !Array.isArray(nextExistingMeta) &&
      nextExistingMeta.search_trace &&
      typeof nextExistingMeta.search_trace === 'object' &&
      !Array.isArray(nextExistingMeta.search_trace)
        ? nextExistingMeta.search_trace
        : null;
    const existingPrimaryPathUsed =
      toNonEmptyStringOrNull(existingRouteHealth?.primary_path_used) ||
      toNonEmptyStringOrNull(searchDecision?.primary_path_used) ||
      toNonEmptyStringOrNull(existingSearchTrace?.primary_path_used) ||
      null;
    const primaryPathUsed =
      existingPrimaryPathUsed ||
      (querySource.startsWith('cache_')
        ? 'cache_stage'
        : querySource.includes('resolver')
        ? 'resolver_stage'
        : querySource.includes('brand_search_mainline')
        ? 'brand_search_multi_source'
        : querySource.includes('external_seed_direct') ||
          querySource.includes('external_seed_rescue')
        ? 'external_seed_direct_rescue'
        : 'upstream_stage');
    const fallbackTriggered =
      Boolean(fallbackMeta?.applied) ||
      isErrorSoftFallbackQuerySource(querySource) ||
      (isStrictEmpty && Boolean(fallbackMeta?.reason));
    const fallbackReason =
      (fallbackMeta && typeof fallbackMeta.reason === 'string' && fallbackMeta.reason.trim()) ||
      (isErrorSoftFallbackQuerySource(querySource) ? 'error_soft_fallback' : null);
    const blockingGateInfo = (() => {
      const preGateCount = Array.isArray(rawProductsForQualityGate)
        ? rawProductsForQualityGate.length
        : 0;
      const postGateCount = Array.isArray(products) ? products.length : 0;
      if (preGateCount <= 0 || postGateCount > 0) return null;
      if (invalidHitApplied) {
        return {
          blocking_gate_id: 'beauty_skincare_hit_quality',
          pre_gate_count: preGateCount,
          post_gate_count: postGateCount,
          blocking_reason:
            String(
              skincareHitDecision.invalid_hit_reason ||
                skincareHitDecision.hit_quality ||
                'invalid_hit',
            ).trim() || 'invalid_hit',
        };
      }
      if (isStrictEmpty) {
        return {
          blocking_gate_id: 'beauty_mainline_strict_empty',
          pre_gate_count: preGateCount,
          post_gate_count: postGateCount,
          blocking_reason:
            String(fallbackReason || searchDecision?.invalid_hit_reason || 'strict_empty').trim() ||
            'strict_empty',
        };
      }
      return null;
    })();
    const cacheStage = crossMerchantCacheRouteDebug
      ? {
          hit: Boolean(crossMerchantCacheRouteDebug.cache_hit),
          candidate_count: Number(crossMerchantCacheRouteDebug.products_count || 0),
          relevant_count: Number(
            crossMerchantCacheRouteDebug.internal_products_relevant_count ??
              crossMerchantCacheRouteDebug.products_count ??
              0,
          ),
          retrieval_sources: crossMerchantCacheRouteDebug.retrieval_sources || [],
        }
      : {
          hit: false,
          candidate_count: 0,
          relevant_count: 0,
          retrieval_sources: [],
        };
    const resolverStage = {
      called: Boolean(shouldAttemptResolverFirst),
      hit: Boolean(resolverFirstResult && Number(resolverFirstResult.usableCount || 0) > 0),
      miss: Boolean(
        shouldAttemptResolverFirst &&
          (!resolverFirstResult || Number(resolverFirstResult.usableCount || 0) <= 0),
      ),
      latency_ms:
        Number(
          resolverFirstResult?.resolve_latency_ms ||
            resolverFirstResult?.data?.metadata?.resolve_latency_ms ||
            0,
        ) || null,
    };
    const cacheSourceReturned = querySource.startsWith('cache_');
    const cacheSourceUpstreamEvidence =
      Number(nextExistingMeta?.upstream_status || 0) > 0 ||
      String(nextExistingMeta?.upstream_error_code || '').trim().length > 0 ||
      Number(nextExistingMeta?.proxy_search_fallback?.upstream_status || 0) > 0 ||
      String(nextExistingMeta?.proxy_search_fallback?.upstream_error_code || '').trim().length > 0 ||
      Boolean(nextExistingMeta?.proxy_search_fallback?.applied);
    const upstreamStage = {
      called: cacheSourceReturned ? cacheSourceUpstreamEvidence : true,
      timeout:
        String(nextExistingMeta?.upstream_error_code || '').toUpperCase() === 'ECONNABORTED' ||
        String(nextExistingMeta?.proxy_search_fallback?.upstream_error_code || '').toUpperCase() ===
          'ECONNABORTED',
      status:
        Number(nextExistingMeta?.upstream_status || responseStatus || 0) ||
        Number(responseStatus || 0) ||
        null,
      latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
    };
    const expandedQuery =
      operation === 'find_products_multi'
        ? findProductsExpansionMeta?.expanded_query || queryText
        : queryText;
    const routeDegradeFlags =
      searchDecision?.degrade_flags && typeof searchDecision.degrade_flags === 'object'
        ? searchDecision.degrade_flags
        : { vector_skipped: false, behavior_skipped: false, nlu_degraded: false };

    return {
      enriched: nextEnriched,
      existingMeta: nextExistingMeta,
      products,
      hasClarification,
      searchDecision,
      invalidHitApplied,
      isStrictEmpty,
      querySource,
      primaryPathUsed,
      fallbackTriggered,
      fallbackReason,
      blockingGateInfo,
      cacheStage,
      resolverStage,
      upstreamStage,
      expandedQuery,
      routeDegradeFlags,
    };
  }

  return {
    prepareInvokeSearchDecisionContext,
  };
}

module.exports = {
  createFindProductsInvokeDecisionContextRuntime,
};
