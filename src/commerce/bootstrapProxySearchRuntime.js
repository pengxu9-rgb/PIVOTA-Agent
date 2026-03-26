const {
  queryResolveSearchFallback: queryResolveSearchFallbackBase,
} = require('./catalog/queryResolveSearchFallback');
const {
  buildResolverQueryCandidates: buildResolverQueryCandidatesBase,
} = require('./catalog/resolverQueryCandidates');
const {
  createSearchGuardHelpers: createSearchGuardHelpersBase,
} = require('./catalog/searchGuards');
const {
  createSearchDedupeHelpers: createSearchDedupeHelpersBase,
} = require('./catalog/searchDedupe');
const {
  createProxySearchFallbackHelpers: createProxySearchFallbackHelpersBase,
} = require('./catalog/proxySearchFallbacks');
const {
  createProxyAgentSearchToBackend: createProxyAgentSearchToBackendBase,
} = require('./proxyAgentSearchToBackend');

function createProxySearchRuntime({
  axiosClient,
  logger,
  config = {},
  helpers = {},
  factories = {},
} = {}) {
  const createSearchGuardHelpers =
    factories.createSearchGuardHelpers || createSearchGuardHelpersBase;
  const createSearchDedupeHelpers =
    factories.createSearchDedupeHelpers || createSearchDedupeHelpersBase;
  const buildResolverQueryCandidatesImpl =
    factories.buildResolverQueryCandidates || buildResolverQueryCandidatesBase;
  const queryResolveSearchFallbackImpl =
    factories.queryResolveSearchFallback || queryResolveSearchFallbackBase;
  const createProxySearchFallbackHelpers =
    factories.createProxySearchFallbackHelpers ||
    createProxySearchFallbackHelpersBase;
  const createProxyAgentSearchToBackend =
    factories.createProxyAgentSearchToBackend ||
    createProxyAgentSearchToBackendBase;

  const {
    PIVOTA_API_BASE,
    PROXY_SEARCH_AURORA_API_BASE,
    PROXY_SEARCH_AURORA_FORCE_FAST_MODE,
    PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS,
    PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK,
    PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK,
    PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
    PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
    PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
    PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS,
    PROXY_SEARCH_RESOLVER_CACHE_TTL_MS,
    PROXY_SEARCH_RESOLVER_DETAIL_ENABLED,
    PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS,
    PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE,
    PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED,
    PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
    SEARCH_FRAGRANCE_SEMANTIC_RETRY,
    PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS,
    SEARCH_STRICT_EMPTY_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
    PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
    PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
    FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS,
    PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
    PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
    PROXY_SEARCH_AURORA_FORCE_TWO_PASS,
    PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
    SEARCH_EXTERNAL_HARD_RULE_PRUNE,
  } = config;

  const {
    firstQueryParamValue,
    normalizeResolverText,
    tokenizeResolverQuery,
    normalizeSearchTextForMatch,
    sanitizeSearchQueryForRelevance,
    extractSearchAnchorTokens,
    extractSearchQueryText,
    parseQueryStringArray,
    uniqueStrings,
    parseQueryBoolean,
    resolveStableAliasByQuery,
    resolveProductRef,
    normalizeAgentProductsListResponse,
    countUsableSearchProducts,
    withProxySearchFallbackMetadata,
    detectBrandEntities,
    hasExplicitCategoryHint,
    buildBrandQueryVariants,
    buildInvokeUpstreamAuthHeaders,
    getUpstreamTimeoutMs,
    isExternalSeedProduct,
    isSupplementCandidateRelevant,
    buildFindProductsMultiPayloadFromQuery,
    buildFragranceSemanticRetryQuery,
    parseQueryNumber,
    isProxySearchFallbackRelevant,
    createRequestId,
    isLookupStyleSearchQuery,
    isStrongResolverFirstQuery,
    withSearchDiagnostics,
    buildSearchRouteHealth,
    buildSearchTrace,
    shouldReducePrimaryTimeoutAfterResolverMiss,
    getSecondaryFallbackSkipReason,
    shouldAllowSecondaryFallback,
    shouldAllowResolverFallback,
    computePrimaryQualityScore,
    recordAuroraCompPass2Invoked,
    recordAuroraCompPass2Timeout,
    hasFragranceQuerySignal,
    buildProxySearchSoftFallbackResponse,
    withStrictEmptyFallback,
    extractUpstreamErrorCode,
    buildProxySearchResolverCacheKey,
    getProxySearchResolverCacheEntry,
    setProxySearchResolverCacheEntry,
  } = helpers;

  const searchGuards = createSearchGuardHelpers({
    pivotaApiBase: PIVOTA_API_BASE,
    proxySearchAuroraApiBase: PROXY_SEARCH_AURORA_API_BASE,
    proxySearchAuroraForceFastMode: PROXY_SEARCH_AURORA_FORCE_FAST_MODE,
    proxySearchAuroraDisableSkipAfterResolverMiss:
      PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS,
    proxySearchAuroraForceSecondaryFallback:
      PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK,
    proxySearchAuroraForceInvokeFallback:
      PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK,
    proxySearchAuroraAllowExternalSeed:
      PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
    proxySearchAuroraExternalSeedStrategy:
      PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
  });

  const searchDedupe = createSearchDedupeHelpers({
    normalizeSearchTextForMatch,
  });

  const buildResolverQueryCandidates = (queryText) =>
    buildResolverQueryCandidatesImpl({
      queryText,
      sanitizeSearchQueryForRelevance,
      extractSearchAnchorTokens,
    });

  const queryResolveSearchFallback = (args = {}) =>
    queryResolveSearchFallbackImpl({
      ...args,
      extractSearchQueryText,
      firstQueryParamValue,
      parseQueryStringArray,
      uniqueStrings,
      parseQueryBoolean,
      proxySearchResolverTimeoutMs: PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
      buildProxySearchResolverCacheKey,
      getProxySearchResolverCacheEntry,
      buildResolverQueryCandidates,
      resolveStableAliasByQuery,
      normalizeResolverText,
      tokenizeResolverQuery,
      resolveProductRef,
      getProxySearchApiBase: searchGuards.getProxySearchApiBase,
      pivotaApiKey: config.PIVOTA_API_KEY,
      setProxySearchResolverCacheEntry,
      proxySearchResolverMissCacheTtlMs:
        PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS,
      proxySearchResolverCacheTtlMs: PROXY_SEARCH_RESOLVER_CACHE_TTL_MS,
      proxySearchResolverDetailEnabled: PROXY_SEARCH_RESOLVER_DETAIL_ENABLED,
      proxySearchResolverDetailTimeoutMs:
        PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS,
      isLookupStyleSearchQuery,
      extractSearchAnchorTokens,
      normalizeAgentProductsListResponse,
      countUsableSearchProducts,
      withProxySearchFallbackMetadata,
      logger,
    });

  const {
    fetchExternalSeedSupplementFromBackend,
    queryFindProductsMultiFallback,
  } = createProxySearchFallbackHelpers({
    axiosClient,
    config: {
      PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
      PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE,
      PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED,
      PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
      SEARCH_FRAGRANCE_SEMANTIC_RETRY,
    },
    helpers: {
      extractSearchQueryText,
      detectBrandEntities,
      hasExplicitCategoryHint,
      normalizeSearchTextForMatch,
      buildBrandQueryVariants,
      hasFragranceQuerySignal,
      getProxySearchApiBase: searchGuards.getProxySearchApiBase,
      buildInvokeUpstreamAuthHeaders,
      extractSearchAnchorTokens,
      tokenizeSearchTextForMatch: helpers.tokenizeSearchTextForMatch,
      parseQueryBoolean,
      normalizeExternalSeedStrategy:
        helpers.normalizeExternalSeedStrategy,
      getUpstreamTimeoutMs,
      normalizeAgentProductsListResponse,
      isExternalSeedProduct,
      buildSearchProductKey: searchDedupe.buildSearchProductKey,
      isSupplementCandidateRelevant,
      buildFindProductsMultiPayloadFromQuery,
      isAuroraSource: searchGuards.isAuroraSource,
      buildFragranceSemanticRetryQuery,
      parseQueryNumber,
      countUsableSearchProducts,
      isProxySearchFallbackRelevant,
      withProxySearchFallbackMetadata,
      searchLimitMax: config.SEARCH_LIMIT_MAX,
    },
  });

  const proxyAgentSearchToBackend = createProxyAgentSearchToBackend({
    axiosClient,
    logger,
    config: {
      PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
      PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS,
      SEARCH_STRICT_EMPTY_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS,
      PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
      PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
      PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
      PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
      PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_FORCE_TWO_PASS,
      PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
      SEARCH_EXTERNAL_HARD_RULE_PRUNE,
    },
    helpers: {
      firstQueryParamValue,
      getProxySearchApiBase: searchGuards.getProxySearchApiBase,
      normalizeSearchQueryParams: helpers.normalizeSearchQueryParams,
      getAuroraFallbackOverrides: searchGuards.getAuroraFallbackOverrides,
      applyShoppingCatalogQueryGuards:
        searchGuards.applyShoppingCatalogQueryGuards,
      createRequestId,
      extractSearchAnchorTokens,
      isLookupStyleSearchQuery,
      isStrongResolverFirstQuery,
      withSearchDiagnostics,
      buildSearchRouteHealth,
      isExternalSeedProduct,
      buildSearchTrace,
      normalizeAgentSource: searchGuards.normalizeAgentSource,
      isAuroraSource: searchGuards.isAuroraSource,
      queryResolveSearchFallback,
      getUpstreamTimeoutMs,
      shouldReducePrimaryTimeoutAfterResolverMiss,
      detectBrandEntities,
      getSecondaryFallbackSkipReason,
      shouldAllowSecondaryFallback,
      shouldAllowResolverFallback,
      buildInvokeUpstreamAuthHeaders,
      normalizeAgentProductsListResponse,
      parseQueryNumber,
      countUsableSearchProducts,
      isProxySearchFallbackRelevant,
      evaluateCacheQualityGate: helpers.evaluateCacheQualityGate,
      computePrimaryQualityScore,
      recordAuroraCompPass2Invoked,
      recordAuroraCompPass2Timeout,
      queryFindProductsMultiFallback,
      hasFragranceQuerySignal,
      buildProxySearchSoftFallbackResponse,
      withStrictEmptyFallback,
      withProxySearchFallbackMetadata,
      extractUpstreamErrorCode,
      buildSearchProductKey: searchDedupe.buildSearchProductKey,
      resolveSearchDedupePerTitleLimit:
        searchDedupe.resolveSearchDedupePerTitleLimit,
      collapseNearDuplicateSearchProducts:
        searchDedupe.collapseNearDuplicateSearchProducts,
    },
  });

  return {
    ...searchGuards,
    ...searchDedupe,
    buildResolverQueryCandidates,
    queryResolveSearchFallback,
    fetchExternalSeedSupplementFromBackend,
    queryFindProductsMultiFallback,
    proxyAgentSearchToBackend,
  };
}

module.exports = {
  createProxySearchRuntime,
};
