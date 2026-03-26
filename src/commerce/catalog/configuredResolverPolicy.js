const {
  isResolverMiss: isResolverMissBase,
  shouldReducePrimaryTimeoutAfterResolverMiss: shouldReducePrimaryTimeoutAfterResolverMissBase,
  isUuidLikeSearchQuery: isUuidLikeSearchQueryBase,
  isStrongResolverFirstQuery: isStrongResolverFirstQueryBase,
  getSecondaryFallbackSkipReason: getSecondaryFallbackSkipReasonBase,
  shouldSkipSecondaryFallbackAfterResolverMiss: shouldSkipSecondaryFallbackAfterResolverMissBase,
  shouldAllowSecondaryFallback: shouldAllowSecondaryFallbackBase,
  shouldAllowInvokeFallback: shouldAllowInvokeFallbackBase,
  shouldAllowResolverFallback: shouldAllowResolverFallbackBase,
  shouldUseResolverFirstSearch: shouldUseResolverFirstSearchBase,
} = require('./resolverPolicy');

function createConfiguredResolverPolicy({
  hasPetSearchSignal,
  hasFragranceQuerySignal,
  normalizeOffersResolveReasonCode,
  isKnownLookupAliasQuery,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  resolveStableAliasByQuery,
  buildResolverQueryCandidates,
  normalizeResolverText,
  tokenizeResolverQuery,
  normalizeAgentSource,
  isCreatorUiSource,
  isAuroraSource,
  isResolverFirstCatalogSource,
  config = {},
} = {}) {
  function isResolverMiss(result) {
    return isResolverMissBase(result);
  }

  function shouldReducePrimaryTimeoutAfterResolverMiss(result, queryText = '') {
    return shouldReducePrimaryTimeoutAfterResolverMissBase({
      result,
      queryText,
      hasPetSearchSignal,
      normalizeOffersResolveReasonCode,
    });
  }

  function getSecondaryFallbackSkipReason(
    result,
    queryText = '',
    { disableSkipAfterResolverMiss = false, queryClass = null, brandLike = false } = {},
  ) {
    return getSecondaryFallbackSkipReasonBase({
      result,
      queryText,
      disableSkipAfterResolverMiss,
      queryClass,
      brandLike,
      proxySearchSkipSecondaryFallbackAfterResolverMiss:
        config.proxySearchSkipSecondaryFallbackAfterResolverMiss,
      hasPetSearchSignal,
      hasFragranceQuerySignal,
      shouldReducePrimaryTimeoutAfterResolverMiss,
      isKnownLookupAliasQuery,
      extractSearchAnchorTokens,
      isLookupStyleSearchQuery,
      fpmGateSimplifyV1: config.fpmGateSimplifyV1,
      fpmLookupOnlyResolver: config.fpmLookupOnlyResolver,
      isStrongResolverFirstQuery,
    });
  }

  function shouldSkipSecondaryFallbackAfterResolverMiss(
    result,
    queryText = '',
    { disableSkipAfterResolverMiss = false, queryClass = null, brandLike = false } = {},
  ) {
    return shouldSkipSecondaryFallbackAfterResolverMissBase({
      result,
      queryText,
      disableSkipAfterResolverMiss,
      queryClass,
      brandLike,
      getSecondaryFallbackSkipReason,
    });
  }

  function shouldAllowSecondaryFallback(operation, { forceSecondaryFallback = false } = {}) {
    return shouldAllowSecondaryFallbackBase({
      operation,
      forceSecondaryFallback,
      proxySearchSecondaryFallbackMultiEnabled: config.proxySearchSecondaryFallbackMultiEnabled,
    });
  }

  function shouldAllowInvokeFallback(operation, { forceInvokeFallback = false } = {}) {
    return shouldAllowInvokeFallbackBase({
      operation,
      forceInvokeFallback,
      proxySearchInvokeFallbackEnabled: config.proxySearchInvokeFallbackEnabled,
    });
  }

  function shouldAllowResolverFallback(operation) {
    return shouldAllowResolverFallbackBase({
      operation,
      proxySearchResolverFallbackEnabled: config.proxySearchResolverFallbackEnabled,
    });
  }

  function isStrongResolverFirstQuery(queryText) {
    return isStrongResolverFirstQueryBase({
      queryText,
      isKnownLookupAliasQuery,
      resolveStableAliasByQuery,
      buildResolverQueryCandidates,
      normalizeResolverText,
      tokenizeResolverQuery,
    });
  }

  function isUuidLikeSearchQuery(value) {
    return isUuidLikeSearchQueryBase(value);
  }

  function shouldUseResolverFirstSearch({
    operation,
    metadata,
    queryText,
    remainingBudgetMs = null,
    queryClass = null,
    brandLike = false,
    allowBroadCatalog = false,
  }) {
    return shouldUseResolverFirstSearchBase({
      operation,
      metadata,
      queryText,
      remainingBudgetMs,
      queryClass,
      brandLike,
      allowBroadCatalog,
      proxySearchResolverFirstEnabled: config.proxySearchResolverFirstEnabled,
      fpmLatencyGuardResolverMinRemainingMs:
        config.fpmLatencyGuardResolverMinRemainingMs,
      fpmGateSimplifyV1: config.fpmGateSimplifyV1,
      extractSearchAnchorTokens,
      isLookupStyleSearchQuery,
      isStrongResolverFirstQuery,
      fpmLookupOnlyResolver: config.fpmLookupOnlyResolver,
      normalizeAgentSource,
      isCreatorUiSource,
      isAuroraSource,
      proxySearchResolverFirstDisableAurora:
        config.proxySearchResolverFirstDisableAurora,
      isResolverFirstCatalogSource,
      proxySearchResolverFirstStrongOnly:
        config.proxySearchResolverFirstStrongOnly,
    });
  }

  return {
    isResolverMiss,
    shouldReducePrimaryTimeoutAfterResolverMiss,
    shouldSkipSecondaryFallbackAfterResolverMiss,
    getSecondaryFallbackSkipReason,
    shouldAllowSecondaryFallback,
    shouldAllowInvokeFallback,
    shouldAllowResolverFallback,
    isStrongResolverFirstQuery,
    isUuidLikeSearchQuery,
    shouldUseResolverFirstSearch,
  };
}

module.exports = {
  createConfiguredResolverPolicy,
};
