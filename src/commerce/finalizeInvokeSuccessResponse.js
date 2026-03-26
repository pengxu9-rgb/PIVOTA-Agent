const { prioritizeOffersResolveResponse: prioritizeOffersResolveResponseBase } = require('../offers/offersPriority');
const {
  finalizeInvokeProductDetailResponse: finalizeInvokeProductDetailResponseBase,
} = require('./catalog/productDetailResponse');
const {
  finalizeInvokeSearchResponse: finalizeInvokeSearchResponseBase,
} = require('./catalog/searchResponseFinalizer');
const {
  finalizeCheckoutInvokeResponse: finalizeCheckoutInvokeResponseBase,
} = require('./checkout/finalizeCheckoutResponse');
const {
  getActivePromotions: getActivePromotionsBase,
  applyDealsToResponse: applyDealsToResponseBase,
} = require('./promotions');
const {
  buildSearchTrace: buildSearchTraceBase,
} = require('./catalog/searchTrace');

function attachSearchGateTrace(upstreamData, fpmGateTrace) {
  if (
    !upstreamData ||
    typeof upstreamData !== 'object' ||
    Array.isArray(upstreamData) ||
    !Array.isArray(fpmGateTrace)
  ) {
    return upstreamData;
  }

  return {
    ...upstreamData,
    metadata: {
      ...(upstreamData.metadata && typeof upstreamData.metadata === 'object'
        ? upstreamData.metadata
        : {}),
      gate_trace: fpmGateTrace,
      gate_summary: {
        applied_count: fpmGateTrace.filter((item) => item && item.applied).length,
        blocked_count: fpmGateTrace.filter(
          (item) =>
            item &&
            (String(item.decision || '') === 'strict_empty' ||
              String(item.decision || '') === 'clarify_only_early'),
        ).length,
        total_cost_ms_estimate: fpmGateTrace.reduce(
          (sum, item) => sum + Math.max(0, Number(item?.cost_ms_estimate || 0) || 0),
          0,
        ),
      },
    },
  };
}

async function finalizeInvokeSuccessResponse({
  operation,
  upstreamData,
  responseStatus,
  requestBody,
  resolvedOfferId,
  resolvedMerchantId,
  gatewayRequestId,
  payload,
  productDetailCacheKey,
  productDetailCacheMeta,
  productDetailDebug,
  productDetailBypassCache,
  normalizeAgentProductDetailResponse,
  queryParams,
  metadata,
  rawUserQuery,
  effectiveIntent,
  effectivePayload,
  policyMetadata,
  creatorId,
  hasDatabase,
  now,
  crossMerchantCacheRouteDebug,
  shouldAttemptResolverFirst,
  resolverFirstResult,
  invokeStartedAtMs,
  traceQueryClass,
  traceRewriteGate,
  traceAssociationPlan,
  traceFlagsSnapshot,
  traceAmbiguityScorePre,
  proxyRouteFallbackStrategy,
  findProductsExpansionMeta,
  fpmGateTrace,
  fpmSkippedGatesDueToBudget,
  fpmLatencyGuardApplied,
  searchLimitMax,
  routeDebugEnabled,
  searchStrictEmptyEnabled,
  fpmClarifyNeverEmpty,
  searchRelevanceDebugEnabled,
  defaultFindProductsMultiExpansionMode,
  extractSearchQueryText,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  isKnownLookupAliasQuery,
  applyFindProductsMultiPolicy,
  buildPetFallbackQuery,
  searchCreatorSellableFromCache,
  maybeRerankFindProductsMultiResponse,
  getActivePromotions = getActivePromotionsBase,
  applyDealsToResponse = applyDealsToResponseBase,
  withSearchDiagnostics,
  buildSearchRouteHealth,
  buildSearchTrace = buildSearchTraceBase,
  buildSearchRelevanceDebug,
  finalizeInvokeProductDetailResponse = finalizeInvokeProductDetailResponseBase,
  finalizeInvokeSearchResponse = finalizeInvokeSearchResponseBase,
  finalizeCheckoutInvokeResponse = finalizeCheckoutInvokeResponseBase,
  prioritizeOffersResolveResponse = prioritizeOffersResolveResponseBase,
  logger,
} = {}) {
  let finalizedUpstreamData =
    operation === 'find_products' || operation === 'find_products_multi'
      ? attachSearchGateTrace(upstreamData, fpmGateTrace)
      : upstreamData;

  if (operation === 'offers.resolve') {
    finalizedUpstreamData = prioritizeOffersResolveResponse(finalizedUpstreamData);
  }

  finalizedUpstreamData = await finalizeInvokeProductDetailResponse({
    operation,
    upstreamData: finalizedUpstreamData,
    responseStatus,
    payload,
    productDetailCacheKey,
    productDetailCacheMeta,
    productDetailDebug,
    productDetailBypassCache,
    normalizeAgentProductDetailResponse,
    logger,
  });

  const checkoutFinalize = finalizeCheckoutInvokeResponse({
    operation,
    upstreamData: finalizedUpstreamData,
    requestBody,
    resolvedOfferId,
    resolvedMerchantId,
    gatewayRequestId,
    logger,
  });
  finalizedUpstreamData = checkoutFinalize.upstreamData;

  if (checkoutFinalize.handled) {
    return {
      handled: true,
      body: checkoutFinalize.body,
      upstreamData: finalizedUpstreamData,
      checkoutRuntime: checkoutFinalize.checkoutRuntime,
    };
  }

  const promotions = await getActivePromotions(now, creatorId);
  const body =
    operation === 'find_products' || operation === 'find_products_multi'
      ? await finalizeInvokeSearchResponse({
          operation,
          upstreamData: finalizedUpstreamData,
          responseStatus,
          queryParams,
          metadata,
          rawUserQuery,
          effectiveIntent,
          effectivePayload,
          policyMetadata,
          creatorId,
          hasDatabase,
          promotions,
          now,
          crossMerchantCacheRouteDebug,
          shouldAttemptResolverFirst,
          resolverFirstResult,
          invokeStartedAtMs,
          gatewayRequestId,
          traceQueryClass,
          traceRewriteGate,
          traceAssociationPlan,
          traceFlagsSnapshot,
          traceAmbiguityScorePre,
          proxyRouteFallbackStrategy,
          findProductsExpansionMeta,
          fpmGateTrace,
          fpmSkippedGatesDueToBudget,
          fpmLatencyGuardApplied,
          searchLimitMax,
          routeDebugEnabled,
          searchStrictEmptyEnabled,
          fpmClarifyNeverEmpty,
          searchRelevanceDebugEnabled,
          defaultFindProductsMultiExpansionMode,
          extractSearchQueryText,
          extractSearchAnchorTokens,
          isLookupStyleSearchQuery,
          isKnownLookupAliasQuery,
          applyFindProductsMultiPolicy,
          buildPetFallbackQuery,
          searchCreatorSellableFromCache,
          maybeRerankFindProductsMultiResponse,
          applyDealsToResponse,
          withSearchDiagnostics,
          buildSearchRouteHealth,
          buildSearchTrace,
          buildSearchRelevanceDebug,
          logger,
        })
      : applyDealsToResponse(finalizedUpstreamData, promotions, now, creatorId);

  return {
    handled: false,
    body,
    upstreamData: finalizedUpstreamData,
    checkoutRuntime: checkoutFinalize.checkoutRuntime || null,
  };
}

module.exports = {
  attachSearchGateTrace,
  finalizeInvokeSuccessResponse,
};
