function normalizeInvokePrimarySearchResponse({
  normalized,
  operation = '',
  queryParamsOverride = null,
  searchContractBridgeMeta = null,
  shoppingFreshMainlineSearch = false,
  metadata = null,
  effectiveIntent = null,
  traceQueryClass = null,
  rawUserQuery = '',
  requestBodyOverride = null,
  strictCommerceFindProductsMulti = false,
  strictFindProductsMultiDecision = null,
  extractSearchQueryText,
  normalizeAgentProductsListResponse,
  normalizeShoppingFreshMainlineCacheResponse,
  recoverStrictMainPathResponseFromPrefetch,
  normalizeStrictCacheMainPathFallbackMetadata,
  normalizeShoppingStrictMainlineCacheResponse,
  normalizeStrictMainlineResponseMetadata,
} = {}) {
  if (!(operation === 'find_products' || operation === 'find_products_multi')) return normalized;
  let next = normalizeAgentProductsListResponse(normalized, {
    limit: queryParamsOverride?.limit,
    offset: queryParamsOverride?.offset,
  });
  if (searchContractBridgeMeta) {
    next = {
      ...next,
      metadata: {
        ...(next?.metadata || {}),
        contract_bridge: searchContractBridgeMeta,
      },
    };
  }
  if (shoppingFreshMainlineSearch) {
    next = normalizeShoppingFreshMainlineCacheResponse({
      responseBody: next,
      requestSource: metadata?.source,
      queryParams: queryParamsOverride,
      intent: effectiveIntent,
      queryClass: traceQueryClass,
      queryText: String(rawUserQuery || extractSearchQueryText(queryParamsOverride) || '').trim(),
    });
  }
  if (operation === 'find_products_multi' && strictCommerceFindProductsMulti) {
    next = recoverStrictMainPathResponseFromPrefetch({
      responseBody: next,
      invokeRequestBody: requestBodyOverride,
      strictInvokeDecision: strictFindProductsMultiDecision,
    });
    next = normalizeStrictCacheMainPathFallbackMetadata({
      responseBody: next,
      strictInvokeDecision: strictFindProductsMultiDecision,
    });
    next = normalizeShoppingStrictMainlineCacheResponse({
      responseBody: next,
      strictInvokeDecision: strictFindProductsMultiDecision,
      invokeRequestBody: requestBodyOverride,
      queryParams: queryParamsOverride,
      intent: effectiveIntent,
      queryClass: traceQueryClass,
      queryText: String(rawUserQuery || extractSearchQueryText(queryParamsOverride) || '').trim(),
    });
    next = normalizeStrictMainlineResponseMetadata({
      responseBody: next,
      strictInvokeDecision: strictFindProductsMultiDecision,
      invokeRequestBody: requestBodyOverride,
    });
  }
  return next;
}

function normalizeInvokeSearchOperationResponseData({
  responseBody,
  operation = '',
  queryParamsOverride = null,
  requestBodyOverride = null,
  includeRouteDebug = false,
  routeDebugEnabled = false,
  creatorCacheRouteDebug = null,
  creatorHumanApparelDirectRouteDebug = null,
  crossMerchantCacheRouteDebug = null,
  searchContractBridgeMeta = null,
  shoppingFreshMainlineSearch = false,
  metadata = null,
  effectiveIntent = null,
  traceQueryClass = null,
  rawUserQuery = '',
  strictCommerceFindProductsMulti = false,
  strictFindProductsMultiDecision = null,
  extractSearchQueryText,
  normalizeAgentProductsListResponse,
  normalizeShoppingFreshMainlineCacheResponse,
  recoverStrictMainPathResponseFromPrefetch,
  normalizeStrictCacheMainPathFallbackMetadata,
  normalizeShoppingStrictMainlineCacheResponse,
  normalizeStrictMainlineResponseMetadata,
} = {}) {
  let normalized = responseBody;
  if (
    includeRouteDebug &&
    operation === 'find_products_multi' &&
    routeDebugEnabled &&
    (creatorCacheRouteDebug || creatorHumanApparelDirectRouteDebug || crossMerchantCacheRouteDebug)
  ) {
    normalized = {
      ...normalized,
      metadata: {
        ...(normalized?.metadata || {}),
        route_debug: {
          ...((normalized?.metadata && normalized.metadata.route_debug) || {}),
          ...(creatorCacheRouteDebug ? { creator_cache: creatorCacheRouteDebug } : {}),
          ...(creatorHumanApparelDirectRouteDebug
            ? { creator_external_seed_direct: creatorHumanApparelDirectRouteDebug }
            : {}),
          ...(crossMerchantCacheRouteDebug ? { cross_merchant_cache: crossMerchantCacheRouteDebug } : {}),
        },
      },
    };
  }
  return normalizeInvokePrimarySearchResponse({
    normalized,
    operation,
    queryParamsOverride,
    searchContractBridgeMeta,
    shoppingFreshMainlineSearch,
    metadata,
    effectiveIntent,
    traceQueryClass,
    rawUserQuery,
    requestBodyOverride,
    strictCommerceFindProductsMulti,
    strictFindProductsMultiDecision,
    extractSearchQueryText,
    normalizeAgentProductsListResponse,
    normalizeShoppingFreshMainlineCacheResponse,
    recoverStrictMainPathResponseFromPrefetch,
    normalizeStrictCacheMainPathFallbackMetadata,
    normalizeShoppingStrictMainlineCacheResponse,
    normalizeStrictMainlineResponseMetadata,
  });
}

function normalizeInvokeMaybePolicyResponse({
  maybePolicy,
  strictCommerceFindProductsMulti = false,
  strictFindProductsMultiDecision = null,
  requestBody = null,
  normalizeStrictMainlineResponseMetadata,
} = {}) {
  if (!strictCommerceFindProductsMulti) return maybePolicy;
  return normalizeStrictMainlineResponseMetadata({
    responseBody: maybePolicy,
    strictInvokeDecision: strictFindProductsMultiDecision,
    invokeRequestBody: requestBody,
  });
}

function normalizeInvokeFinalSearchResponse({
  enriched,
  operation = '',
  metadata = null,
  effectivePayload = null,
  req = null,
  queryParams = null,
  effectiveIntent = null,
  traceQueryClass = null,
  rawUserQuery = '',
  extractSearchQueryText,
  normalizeShoppingFinalSearchResponse,
} = {}) {
  if (operation !== 'find_products_multi') return enriched;
  return normalizeShoppingFinalSearchResponse({
    responseBody: enriched,
    requestSource:
      metadata?.source ||
      effectivePayload?.metadata?.source ||
      effectivePayload?.context?.source ||
      req?.query?.source ||
      queryParams?.source ||
      null,
    queryParams,
    intent: effectiveIntent,
    queryClass: traceQueryClass,
    queryText: String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim(),
  });
}

module.exports = {
  normalizeInvokeSearchOperationResponseData,
  normalizeInvokePrimarySearchResponse,
  normalizeInvokeMaybePolicyResponse,
  normalizeInvokeFinalSearchResponse,
};
