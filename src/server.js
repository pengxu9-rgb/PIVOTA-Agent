/*
 * Pivota Agent gateway.
 * Exposes /agent/shop/v1/invoke and forwards to Pivota internal API based on operation.
 */
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { InvokeRequestSchema, OperationEnum } = require('./schema');
const {
  proxySearchResolverCacheTtlMs: PROXY_SEARCH_RESOLVER_CACHE_TTL_MS,
  proxySearchResolverMissCacheTtlMs: PROXY_SEARCH_RESOLVER_MISS_CACHE_TTL_MS,
  buildProxySearchResolverCacheKey,
  getProxySearchResolverCacheEntry,
  setProxySearchResolverCacheEntry,
} = require('./commerce/catalog/resolverCache');
const {
  isKnownLookupAliasQuery: isKnownLookupAliasQueryBase,
  expandLookupAnchorTokens: expandLookupAnchorTokensBase,
} = require('./commerce/catalog/resolverPolicy');
const { runInvokeOperationFlow } = require('./commerce/runInvokeOperationFlow');
const {
  initializeInvokeRequestContext,
} = require('./commerce/invokeRequestContext');
const {
  configureInvokeResponseShell,
} = require('./commerce/configureInvokeResponseShell');
const {
  prepareInvokeExecutionMode,
  sendInvokeOperationResponse,
  handleUnhandledInvokeRequestError,
} = require('./commerce/invokeAppShell');
const {
  createCommerceEntrypoints,
} = require('./commerce/bootstrapCommerceEntrypoints');
const {
  createExternalInvokeAuthRuntime,
} = require('./commerce/externalInvokeAuth');
const {
  createUpstreamRetryRuntime,
} = require('./commerce/upstreamRetryRuntime');
const {
  registerGlobalErrorHandler,
  registerRecommendRoute,
  runPdpCorePrewarmPass: runPdpCorePrewarmPassBase,
} = require('./serverTail');
const {
  bootstrapGatewaySupportSurface,
} = require('./bootstrapGatewaySupportSurface');
const {
  bootstrapOptionalRouteOwners,
} = require('./bootstrapOptionalRouteOwners');
const {
  createGatewayConfig,
} = require('./gatewayConfig');
const {
  createRequireAdmin,
} = require('./adminAuth');
const {
  createPdpCorePrewarmRuntime,
} = require('./pdpCorePrewarmRuntime');
const {
  startGatewayServer,
} = require('./serverStartup');
const {
  registerUiChatRuntime,
} = require('./uiChatRuntime');
const {
  createProxySearchRuntime,
} = require('./commerce/bootstrapProxySearchRuntime');
const {
  createOffersResolveOwner,
  normalizeOffersResolveReasonCode,
} = require('./commerce/offers/resolveOffers');
const {
  computeHumanReadableRule,
  sanitizePromotionForResponse,
  computePromotionStatus,
  validateAndNormalizePromotion,
} = require('./commerce/promotions');
const {
  configureProductDetailAdapters,
  productDetailCacheEnabled: PRODUCT_DETAIL_CACHE_ENABLED,
  productDetailCacheTtlMs: PRODUCT_DETAIL_CACHE_TTL_MS,
  productDetailStaleMaxAgeHours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
  productDetailCacheMetrics: PRODUCT_DETAIL_CACHE_METRICS,
  snapshotProductDetailCacheStats,
} = require('./commerce/catalog/productDetailAdapters');
const {
  handleMockInvokeOperation,
} = require('./commerce/mock/mockInvokeOperation');
const {
  normalizeExternalSeedStrategy,
  isUnifiedLikeExternalSeedStrategy,
} = require('./commerce/catalog/searchGuards');
const {
  buildQueryString,
} = require('./commerce/shared/buildQueryString');
const {
  createShopifyCurrencyRuntime,
} = require('./commerce/catalog/shopifyCurrencyRuntime');
const {
  createCreatorCacheDiagnostics,
} = require('./commerce/catalog/creatorCacheDiagnostics');
const {
  createConfiguredResolverPolicy,
} = require('./commerce/catalog/configuredResolverPolicy');
const {
  normalizeAgentProductDetailResponse,
} = require('./commerce/catalog/normalizeAgentProductDetailResponse');
const {
  createSearchRelevanceHelpers,
} = require('./commerce/catalog/searchRelevance');
const {
  buildFindProductsMultiPayloadFromQuery,
  firstQueryParamValue,
  parseQueryBoolean,
  parseQueryNumber,
  parseQueryStringArray,
} = require('./commerce/catalog/searchQueryParams');
const {
  createCatalogCacheRuntime,
} = require('./commerce/catalog/cacheSearchRuntime');
const {
  buildSellableStatusPredicate,
} = require('./commerce/catalog/sellability');
const {
  normalizeProductImages,
  normalizeAgentProductsListResponse,
} = require('./commerce/catalog/agentProductsListResponse');
const {
  isExternalSeedProduct,
} = require('./commerce/catalog/searchFallbackRuntime');
const {
  buildSearchRouteHealth,
} = require('./commerce/catalog/searchRouteHealth');
const { buildSearchTrace } = require('./commerce/catalog/searchTrace');
const {
  createCreatorCatalogAutoSyncRuntime,
} = require('./creatorCatalogAutoSyncRuntime');
const {
  createSearchDiagnosticsHelpers,
} = require('./commerce/catalog/searchDiagnosticsHelpers');
const {
  extractUpstreamErrorCode,
} = require('./commerce/shared/extractUpstreamErrorCode');
const {
  configurePdpUpstreamAdapters,
} = require('./commerce/pdp/upstreamAdapters');
const {
  handleGetPdpV2Operation,
} = require('./commerce/pdp/getPdpV2');
const {
  handleGetPdpOperation,
} = require('./commerce/pdp/getPdp');
const {
  handleResolveProductGroupOperation,
} = require('./commerce/pdp/resolveProductGroup');
const {
  handleResolveProductCandidatesOperation,
} = require('./commerce/pdp/resolveProductCandidates');
const {
  resolveProductCandidatesCacheEnabled,
  resolveProductCandidatesCacheMetrics,
  resolveProductCandidatesTtlMs,
  getResolveProductCandidatesCacheEntry,
  setResolveProductCandidatesCache,
  snapshotResolveProductCandidatesCacheStats,
  snapshotResolveProductGroupCacheStats,
} = require('./commerce/pdp/hotCaches');
const {
  resolveProductGroupCached,
  buildOffersFromGroupMembers,
} = require('./commerce/pdp/groupHelpers');
const logger = require('./logger');
const { runMigrations } = require('./db/migrate');
const { query } = require('./db');
const { CREATOR_CONFIGS, getCreatorConfig } = require('./creatorConfig');
const { mockProducts, searchProducts, getProductById } = require('./mockProducts');
const {
  buildOfferId,
  buildProductGroupId,
  extractMerchantIdFromOfferId,
  parseOfferId,
} = require('./offers/offerIds');
const { buildPdpPayload } = require('./pdpBuilder');
const {
  getAllPromotions,
  getPromotionById,
  upsertPromotion,
  softDeletePromotion,
} = require('./promotionStore');
const {
  buildCreatorCategoryTree,
  getCreatorCategoryProducts,
} = require('./services/categories');
const { recommendHandler } = require('./recommend/index');
const {
  buildFindProductsMultiContext,
  applyFindProductsMultiPolicy,
} = require('./findProductsMulti/policy');
const {
  detectBrandEntities,
  buildBrandQueryVariants,
  hasExplicitCategoryHint,
} = require('./findProductsMulti/brandLexicon');
const { buildClarification } = require('./findProductsMulti/clarification');
const { maybeRerankFindProductsMultiResponse } = require('./findProductsMulti/rerankLlm');
const { embedText } = require('./services/embeddings');
const {
  semanticSearchCreatorProductsFromCache,
} = require('./services/productsCacheVectorSearch');
const {
  scoreByTagFacetOverlap,
  scorePairOverlap,
} = require('./services/productTagSignals');
const { mountOutcomeTelemetryRoutes, mountLookReplicatorEventRoutes, mountUiEventRoutes } = require('./telemetry');
const { mountLayer1CompatibilityRoutes } = require('./layer1/routes/layer1Compatibility');
const { mountLayer1BundleRoutes } = require('./layer1/routes/layer1BundleValidate');
const { mountExternalOfferRoutes } = require('./layer3/routes/externalOffers');
const { mountRecommendationRoutes } = require('./recommendations/routes');
const { applyGatewayGuardrails } = require('./guardrails/gatewayGuardrails');
const { recommend: recommendPdpProducts, getCacheStats: getPdpRecsCacheStats } = require('./services/RecommendationEngine');
const {
  resolveProductRef,
  _internals: productGroundingResolverInternals = {},
} = require('./services/productGroundingResolver');
const {
  upsertMissingCatalogProduct,
  listMissingCatalogProducts,
  toCsv: missingCatalogProductsToCsv,
} = require('./services/missingCatalogProductsStore');
const {
  recordAuroraCompPass2Invoked,
  recordAuroraCompPass2Timeout,
} = require('./auroraBff/visionMetrics');

const resolveStableAliasByQuery =
  typeof productGroundingResolverInternals.resolveKnownStableProductRef === 'function'
    ? productGroundingResolverInternals.resolveKnownStableProductRef
    : null;
const normalizeResolverText =
  typeof productGroundingResolverInternals.normalizeTextForResolver === 'function'
    ? productGroundingResolverInternals.normalizeTextForResolver
    : (value) => String(value || '').trim().toLowerCase();
const tokenizeResolverQuery =
  typeof productGroundingResolverInternals.tokenizeNormalizedResolverQuery === 'function'
    ? productGroundingResolverInternals.tokenizeNormalizedResolverQuery
    : (value) =>
        String(value || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);

const {
  auroraRoutesFailClosed: AURORA_ROUTES_FAIL_CLOSED,
  auroraRoutesReady,
  auroraRoutesLoadError,
  mountLookReplicatorRoutes,
  mountAuroraBffRoutes,
  getAuroraPdpPrefetchStateSnapshot,
  getAuroraRequiredRouteContractsHealth,
  isAuroraDegradedPath,
} = bootstrapOptionalRouteOwners({
  logger,
  env: process.env,
});

const {
  parsePositiveInt,
  PORT,
  SERVICE_STARTED_AT,
  SERVICE_DEPLOYMENT_ID,
  SERVICE_GIT_SHA,
  SERVICE_GIT_SHA_SHORT,
  SERVICE_GIT_BRANCH,
  SERVICE_NAME,
  SERVICE_BUILD_ID,
  DEFAULT_MERCHANT_ID,
  PIVOTA_API_BASE,
  PROXY_SEARCH_AURORA_API_BASE,
  PIVOTA_API_KEY,
  REVIEWS_API_BASE,
  UI_GATEWAY_URL,
  ADMIN_API_KEY,
  AGENT_AUTH_INTROSPECT_URL,
  AGENT_AUTH_INTROSPECT_INTERNAL_KEY,
  AGENT_AUTH_INTROSPECT_TIMEOUT_MS,
  AGENT_AUTH_CACHE_POSITIVE_TTL_MS,
  AGENT_AUTH_CACHE_NEGATIVE_TTL_MS,
  AGENT_AUTH_CACHE_MAX_ENTRIES,
  MAX_AGENT_STEPS_PER_TURN,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOTAL_RUNTIME_MS,
  MAX_TOOL_LOOP_DUPLICATES,
  MAX_CONTEXT_MESSAGES,
  MAX_TOOL_CONTENT_CHARS,
  MAX_TASK_POLL_ATTEMPTS,
  TASK_POLL_INTERVAL_MS,
  ROUTE_DEBUG_ENABLED,
  SEARCH_RELEVANCE_DEBUG_ENABLED,
  CREATOR_CATALOG_CACHE_TTL_SECONDS,
  UPSTREAM_TIMEOUT_ADMIN_MS,
  UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS,
  UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
  UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS,
  UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS,
  UPSTREAM_TIMEOUT_REVIEWS_MS,
  UPSTREAM_TIMEOUT_SEARCH_RETRY_MS,
  UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT,
  CHECKOUT_RETRY_MAX_ATTEMPTS,
  CHECKOUT_RETRY_BASE_MS,
  CHECKOUT_RETRY_MAX_MS,
  PDP_CORE_PREWARM_ENABLED,
  PDP_CORE_PREWARM_TIMEOUT_MS,
  PDP_CORE_PREWARM_INTERVAL_MS,
  PDP_CORE_PREWARM_INITIAL_DELAY_MS,
  PDP_CORE_PREWARM_GATEWAY_URL,
  PDP_CORE_PREWARM_TARGETS,
  getUpstreamTimeoutMs,
  PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
  PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
  PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
  PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
  PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
  PROXY_SEARCH_RESOLVER_DETAIL_TIMEOUT_MS,
  PROXY_SEARCH_RESOLVER_DETAIL_ENABLED,
  PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
  PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
  PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
  PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
  PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
  PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
  PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
  PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS,
  PROXY_SEARCH_AURORA_FORCE_FAST_MODE,
  PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK,
  PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK,
  PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS,
  PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
  PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
  PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_ENABLED,
  PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_STRATEGY,
  CREATOR_CACHE_SHORT_CIRCUIT_ENABLED,
  PROXY_SEARCH_CREATOR_SCOPE_TO_CONFIG,
  PROXY_SEARCH_AURORA_VIEW_DETAILS_MIN_TIMEOUT_MS,
  PROXY_SEARCH_AURORA_FORCE_TWO_PASS,
  PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS,
  PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS,
  PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS,
  PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
  PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE,
  PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY,
  PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED,
  PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
  PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
  PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
  FIND_PRODUCTS_MULTI_EXPANSION_MODE,
  FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
  SEARCH_STRICT_EMPTY_ENABLED,
  SEARCH_EXTERNAL_FILL_GATED,
  SEARCH_LIMIT_MAX,
  SEARCH_EXTERNAL_HARD_RULE_PRUNE,
  SEARCH_FRAGRANCE_SEMANTIC_RETRY,
  SEARCH_CACHE_VALIDATE,
  SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO,
  SEARCH_CACHE_MIN_ANCHOR,
  SEARCH_CACHE_MAX_DOMAIN_ENTROPY,
  SEARCH_CACHE_MIN_COUNT,
  SEARCH_CACHE_MAX_CROSS_DOMAIN_RATIO,
  SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED,
  SEARCH_UPSTREAM_QUOTA_CLARIFY_QUERY_CLASSES,
  PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED,
  FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS,
  FIND_PRODUCTS_MULTI_RESOLVER_STAGE_BUDGET_MS,
  FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS,
  FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS,
  FPM_GATE_SIMPLIFY_V1,
  FPM_LOOKUP_ONLY_RESOLVER,
  FPM_CLARIFY_NEVER_EMPTY,
  FPM_GATEWAY_TOTAL_BUDGET_MS,
  FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS,
  FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS,
  OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS,
  OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS,
  OFFERS_RESOLVE_SUBJECT_RETRY_MAX,
  OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX,
  OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS,
  OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS,
  OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD,
  OFFERS_RESOLVE_CIRCUIT_OPEN_MS,
  OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT,
  OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES,
  API_MODE,
  USE_MOCK,
  USE_HYBRID,
  REAL_API_ENABLED,
  FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
  HAS_DATABASE,
  NODE_ENV,
  CREATOR_CATALOG_AUTO_SYNC_INITIAL_DELAY_MS,
} = createGatewayConfig({
  env: process.env,
  logger,
  axiosClient: axios,
});

const {
  creatorCatalogAutoSyncEnabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
  creatorCatalogAutoSyncTimeoutMs: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
  getCreatorCatalogAutoSyncIntervalConfig,
  getCreatorCatalogAutoSyncLimitConfig,
  getCreatorCatalogMerchantIds,
  resolveCatalogSyncMerchantIds,
  getCatalogSyncSuppressionStatus,
  buildCatalogSyncSnapshot,
  runCreatorCatalogAutoSync,
  isCatalogSyncRetryableError,
  isCatalogSyncTimeoutError,
  isCatalogSyncInvalidMerchantError,
  catalogSyncState,
} = createCreatorCatalogAutoSyncRuntime({
  env: process.env,
  logger,
  queryDb: query,
  axiosClient: axios,
  parsePositiveInt,
  creatorConfigs: CREATOR_CONFIGS,
  creatorCatalogCacheTtlSeconds: CREATOR_CATALOG_CACHE_TTL_SECONDS,
  pivotaApiBase: PIVOTA_API_BASE,
  adminApiKey: ADMIN_API_KEY,
});

const {
  snapshotPdpV2CoreHotCacheStats,
  runPdpCorePrewarmPass,
} = createPdpCorePrewarmRuntime({
  getAuroraPdpPrefetchStateSnapshot,
  runPdpCorePrewarmPassBase,
  targets: PDP_CORE_PREWARM_TARGETS,
  gatewayUrl: PDP_CORE_PREWARM_GATEWAY_URL,
  port: PORT,
  timeoutMs: PDP_CORE_PREWARM_TIMEOUT_MS,
  intervalMs: PDP_CORE_PREWARM_INTERVAL_MS,
  axiosClient: axios,
  logger,
});

const {
  applyShopifyCurrencyOverride,
} = createShopifyCurrencyRuntime({
  queryDb: query,
  axiosClient: axios,
  logger,
  databaseUrl: process.env.DATABASE_URL,
});

const {
  loadCreatorSellableFromCache,
  buildPetSignalSql,
  hasPetSearchSignal,
  hasPetHarnessSearchSignal,
  hasPetLeashSearchSignal,
  hasStrictPetHarnessCatalogSignal,
  hasBeautyMakeupSearchSignal,
  hasBeautyCatalogProductSignal,
  isBeautyGeneralDiversitySupplementCandidate,
  blendBeautyDiversitySupplement,
  searchCreatorSellableFromCache,
  searchCrossMerchantFromCache,
  loadCrossMerchantBrowseFromCache,
  loadMerchantBrowseFromCache,
  buildPetFallbackQuery,
  findSimilarCreatorFromCache,
} = createCatalogCacheRuntime({
  logger,
  queryDb: query,
  config: {
    searchLimitMax: SEARCH_LIMIT_MAX,
    findProductsMultiVectorEnabled: FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
    hasDatabase: HAS_DATABASE,
  },
  helpers: {
    getCreatorConfig,
    applyShopifyCurrencyOverride,
    scoreByTagFacetOverlap,
    scorePairOverlap,
    embedText,
    semanticSearchCreatorProductsFromCache,
  },
});

const {
  uniqueStrings,
  probeCreatorCacheDbStats,
} = createCreatorCacheDiagnostics({
  queryDb: query,
  buildSellableStatusPredicate,
  buildPetSignalSql,
  routeDebugEnabled: ROUTE_DEBUG_ENABLED,
  databaseUrl: process.env.DATABASE_URL,
});

const {
  extractSearchQueryText,
  normalizeSearchQueryParams,
  extractSearchProductId,
  hasUsableSearchProduct,
  countUsableSearchProducts,
  normalizeSearchTextForMatch,
  tokenizeSearchTextForMatch,
  sanitizeSearchQueryForRelevance,
  extractSearchAnchorTokens,
  isKnownLookupAliasQuery,
  expandLookupAnchorTokens,
  isLookupStyleSearchQuery,
  hasFragranceQuerySignal,
  buildFragranceSemanticRetryQuery,
  buildFallbackCandidateText,
  hasBrandTermMatch,
  hasBeautyIngredientIntentSignal,
  buildBeautyIngredientIntentTokens,
  buildFallbackOverlapPreview,
  hasFragranceSearchSignal,
  hasLingerieSearchSignal,
  hasLingerieCatalogProductSignal,
  isProxySearchFallbackRelevant,
  isSupplementCandidateRelevant,
  inferCacheProductDomainKey,
  inferIntentDomainKeyForCacheValidation,
  computeDomainEntropyTopK,
  computeAnchorRatioTopK,
  resolveCacheValidationMinCount,
  evaluateCacheQualityGate,
  computePrimaryQualityScore,
} = createSearchRelevanceHelpers({
  firstQueryParamValue,
  normalizeResolverText,
  tokenizeResolverQuery,
  isKnownLookupAliasQueryBase,
  expandLookupAnchorTokensBase,
  hasPetSearchSignal,
  hasPetHarnessSearchSignal,
  hasBeautyMakeupSearchSignal,
  searchExternalHardRulePrune: SEARCH_EXTERNAL_HARD_RULE_PRUNE,
  searchCacheValidate: SEARCH_CACHE_VALIDATE,
  searchCacheMinCount: SEARCH_CACHE_MIN_COUNT,
  searchCacheMinAnchor: SEARCH_CACHE_MIN_ANCHOR,
  searchCacheMaxDomainEntropy: SEARCH_CACHE_MAX_DOMAIN_ENTROPY,
  searchCacheMaxCrossDomainRatio: SEARCH_CACHE_MAX_CROSS_DOMAIN_RATIO,
});

const {
  withProxySearchFallbackMetadata,
  buildSearchRelevanceDebug,
  withSearchDiagnostics,
  withStrictEmptyFallback,
  buildProxySearchSoftFallbackResponse,
} = createSearchDiagnosticsHelpers({
  buildFallbackCandidateText,
  hasFragranceQuerySignal,
  normalizeSearchTextForMatch,
  parseQueryNumber,
  normalizeAgentProductsListResponse,
  isExternalSeedProduct,
  hasLingerieSearchSignal,
  hasLingerieCatalogProductSignal,
  buildClarification,
  searchUpstreamQuotaClarifyEnabled: SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED,
  searchUpstreamQuotaClarifyQueryClasses:
    SEARCH_UPSTREAM_QUOTA_CLARIFY_QUERY_CLASSES,
});

const {
  invokeAuthContext: INVOKE_AUTH_CONTEXT,
  requireExternalInvokeAuth,
  buildInvokeUpstreamAuthHeaders,
} = createExternalInvokeAuthRuntime({
  axiosClient: axios,
  logger,
  pivotaApiKey: PIVOTA_API_KEY,
  agentAuthIntrospectUrl: AGENT_AUTH_INTROSPECT_URL,
  agentAuthIntrospectInternalKey: AGENT_AUTH_INTROSPECT_INTERNAL_KEY,
  agentAuthIntrospectTimeoutMs: AGENT_AUTH_INTROSPECT_TIMEOUT_MS,
  agentAuthCachePositiveTtlMs: AGENT_AUTH_CACHE_POSITIVE_TTL_MS,
  agentAuthCacheNegativeTtlMs: AGENT_AUTH_CACHE_NEGATIVE_TTL_MS,
  agentAuthCacheMaxEntries: AGENT_AUTH_CACHE_MAX_ENTRIES,
  nodeEnv: NODE_ENV,
});

const {
  callUpstreamWithOptionalRetry,
  isRetryableQuoteError,
  isPydanticMissingBodyField,
  sleepMs,
} = createUpstreamRetryRuntime({
  axiosClient: axios,
  logger,
  upstreamRetryFindProductsMultiOnTimeout:
    UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT,
  upstreamTimeoutFindProductsMultiRetryMs:
    UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_RETRY_MS,
  upstreamTimeoutFindProductsMultiMs: UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
  upstreamTimeoutFindProductsRetryMs: UPSTREAM_TIMEOUT_FIND_PRODUCTS_RETRY_MS,
  upstreamTimeoutFindProductsMs: UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS,
  upstreamTimeoutSearchRetryMs: UPSTREAM_TIMEOUT_SEARCH_RETRY_MS,
  checkoutRetryMaxAttempts: CHECKOUT_RETRY_MAX_ATTEMPTS,
  checkoutRetryBaseMs: CHECKOUT_RETRY_BASE_MS,
  checkoutRetryMaxMs: CHECKOUT_RETRY_MAX_MS,
  randomFn: Math.random,
});

let configuredResolverPolicy = null;
const shouldReducePrimaryTimeoutAfterResolverMissConfigured = (...args) =>
  configuredResolverPolicy
    ? configuredResolverPolicy.shouldReducePrimaryTimeoutAfterResolverMiss(...args)
    : false;
const getSecondaryFallbackSkipReasonConfigured = (...args) =>
  configuredResolverPolicy
    ? configuredResolverPolicy.getSecondaryFallbackSkipReason(...args)
    : null;
const shouldAllowSecondaryFallbackConfigured = (...args) =>
  configuredResolverPolicy
    ? configuredResolverPolicy.shouldAllowSecondaryFallback(...args)
    : false;
const shouldAllowResolverFallbackConfigured = (...args) =>
  configuredResolverPolicy
    ? configuredResolverPolicy.shouldAllowResolverFallback(...args)
    : false;
const isStrongResolverFirstQueryConfigured = (...args) =>
  configuredResolverPolicy
    ? configuredResolverPolicy.isStrongResolverFirstQuery(...args)
    : false;

const {
  normalizeAgentSource,
  isShoppingSource,
  isCreatorUiSource,
  isCatalogGuardSource,
  isResolverFirstCatalogSource,
  isAuroraSource,
  getProxySearchApiBase,
  getAuroraFallbackOverrides,
  applyShoppingCatalogQueryGuards,
  buildSearchProductKey,
  collapseNearDuplicateSearchProducts,
  resolveSearchDedupePerTitleLimit,
  buildResolverQueryCandidates,
  queryResolveSearchFallback,
  fetchExternalSeedSupplementFromBackend,
  queryFindProductsMultiFallback,
  proxyAgentSearchToBackend,
} = createProxySearchRuntime({
  axiosClient: axios,
  logger,
  config: {
    PIVOTA_API_BASE,
    PIVOTA_API_KEY,
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
    SEARCH_LIMIT_MAX,
  },
  helpers: {
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
    createRequestId: randomUUID,
    isLookupStyleSearchQuery,
    isStrongResolverFirstQuery: isStrongResolverFirstQueryConfigured,
    withSearchDiagnostics,
    buildSearchRouteHealth,
    buildSearchTrace,
    shouldReducePrimaryTimeoutAfterResolverMiss:
      shouldReducePrimaryTimeoutAfterResolverMissConfigured,
    getSecondaryFallbackSkipReason: getSecondaryFallbackSkipReasonConfigured,
    shouldAllowSecondaryFallback: shouldAllowSecondaryFallbackConfigured,
    shouldAllowResolverFallback: shouldAllowResolverFallbackConfigured,
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
    tokenizeSearchTextForMatch,
    normalizeSearchQueryParams,
    normalizeExternalSeedStrategy,
    evaluateCacheQualityGate,
  },
});

const {
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
} = (configuredResolverPolicy = createConfiguredResolverPolicy({
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
  config: {
    proxySearchSkipSecondaryFallbackAfterResolverMiss:
      PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS,
    proxySearchSecondaryFallbackMultiEnabled:
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
    proxySearchInvokeFallbackEnabled: PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
    proxySearchResolverFallbackEnabled: PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
    proxySearchResolverFirstEnabled: PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
    proxySearchResolverFirstStrongOnly:
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
    proxySearchResolverFirstDisableAurora:
      PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
    fpmLatencyGuardResolverMinRemainingMs:
      FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS,
    fpmGateSimplifyV1: FPM_GATE_SIMPLIFY_V1,
    fpmLookupOnlyResolver: FPM_LOOKUP_ONLY_RESOLVER,
  },
}));

const app = express();
const commerceEntrypoints = createCommerceEntrypoints({
  defaultClientChannel: 'shop',
  defaultVersion: 'v1',
});
const {
  commerceKernel,
  commerceClient: lookReplicatorCommerceClient,
  bindInvokeHandler,
} = commerceEntrypoints;
const requireAdmin = createRequireAdmin({
  adminApiKey: ADMIN_API_KEY,
});

configurePdpUpstreamAdapters({
  axios,
  buildQueryString,
  buildInvokeUpstreamAuthHeaders,
  callUpstreamWithOptionalRetry,
  getUpstreamTimeoutMs,
  pivotaApiBase: PIVOTA_API_BASE,
  reviewsApiBase: REVIEWS_API_BASE,
  upstreamTimeoutReviewsMs: UPSTREAM_TIMEOUT_REVIEWS_MS,
  recommendPdpProducts,
});

configureProductDetailAdapters({
  axios,
  query,
  logger,
  buildInvokeUpstreamAuthHeaders,
  callUpstreamWithOptionalRetry,
  getUpstreamTimeoutMs,
  pivotaApiBase: PIVOTA_API_BASE,
});

bootstrapGatewaySupportSurface({
  app,
  expressModule: express,
  publicDir: path.join(__dirname, '..', 'public'),
  env: process.env,
  logger,
  serviceName: SERVICE_NAME,
  serviceGitShaShort: SERVICE_GIT_SHA_SHORT,
  serviceBuildId: SERVICE_BUILD_ID,
  serviceGitBranch: SERVICE_GIT_BRANCH,
  serviceDeploymentId: SERVICE_DEPLOYMENT_ID,
  health: {
    getCreatorConfig,
    uniqueStrings,
    probeCreatorCacheDbStats,
    getAuroraRequiredRouteContractsHealth,
    auroraRoutesFailClosed: AURORA_ROUTES_FAIL_CLOSED,
    auroraRoutesReady,
    auroraRoutesLoadError,
    useMock: USE_MOCK,
    port: PORT,
    apiMode: API_MODE,
    useHybrid: USE_HYBRID,
    realApiEnabled: REAL_API_ENABLED,
    serviceStartedAt: SERVICE_STARTED_AT,
    pivotaApiBase: PIVOTA_API_BASE,
    proxySearchAuroraApiBase: PROXY_SEARCH_AURORA_API_BASE,
    pivotaApiKey: PIVOTA_API_KEY,
    snapshotResolveProductCandidatesCacheStats,
    snapshotResolveProductGroupCacheStats,
    snapshotProductDetailCacheStats,
    snapshotPdpV2CoreHotCacheStats,
    getPdpRecsCacheStats,
    buildCatalogSyncSnapshot,
  },
  supportRoutes: {
    queryDb: query,
    serviceGitSha: SERVICE_GIT_SHA,
    serviceStartedAt: SERVICE_STARTED_AT,
    mountLookReplicatorRoutes,
    lookReplicatorCommerceClient,
    mountOutcomeTelemetryRoutes,
    mountLookReplicatorEventRoutes,
    mountUiEventRoutes,
    mountExternalOfferRoutes,
    mountRecommendationRoutes,
    mountAuroraBffRoutes,
    auroraRoutesReady,
    auroraRoutesLoadError,
    isAuroraDegradedPath,
    createRequestId: randomUUID,
    mountLayer1CompatibilityRoutes,
    mountLayer1BundleRoutes,
    buildCreatorCategoryTree,
    getCreatorCategoryProducts,
    requireAdmin,
    getAllPromotions,
  },
  merchantOps: {
    requireAdmin,
    getAllPromotions,
    getPromotionById,
    upsertPromotion,
    softDeletePromotion,
    computeHumanReadableRule,
    sanitizePromotionForResponse,
    computePromotionStatus,
    validateAndNormalizePromotion,
    extractUpstreamErrorCode,
    adminApiKey: ADMIN_API_KEY,
    pivotaApiBase: PIVOTA_API_BASE,
    axiosClient: axios,
    upstreamTimeoutAdminMs: UPSTREAM_TIMEOUT_ADMIN_MS,
    buildInvokeUpstreamAuthHeaders,
  },
  productResolve: {
    resolveProductRef,
    parseQueryNumber,
    firstQueryParamValue,
    resolveCatalogSyncMerchantIds,
    upsertMissingCatalogProduct,
    pivotaApiBase: PIVOTA_API_BASE,
    pivotaApiKey: PIVOTA_API_KEY,
    proxySearchAuroraViewDetailsExternalSeedEnabled:
      PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_ENABLED,
    proxySearchAuroraViewDetailsExternalSeedStrategy:
      PROXY_SEARCH_AURORA_VIEW_DETAILS_EXTERNAL_SEED_STRATEGY,
    proxySearchAuroraViewDetailsMinTimeoutMs:
      PROXY_SEARCH_AURORA_VIEW_DETAILS_MIN_TIMEOUT_MS,
  },
  adminCatalogOps: {
    requireAdmin,
    listMissingCatalogProducts,
    missingCatalogProductsToCsv,
    creatorCatalogAutoSyncEnabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
    adminApiKey: ADMIN_API_KEY,
    creatorCatalogCacheTtlSeconds: CREATOR_CATALOG_CACHE_TTL_SECONDS,
    creatorCatalogAutoSyncTimeoutMs: CREATOR_CATALOG_AUTO_SYNC_TIMEOUT_MS,
    pivotaApiBase: PIVOTA_API_BASE,
    axiosClient: axios,
    parsePositiveInt,
    getCreatorCatalogAutoSyncLimitConfig,
    resolveCatalogSyncMerchantIds,
    getCatalogSyncSuppressionStatus,
    catalogSyncState,
    isCatalogSyncTimeoutError,
    isCatalogSyncInvalidMerchantError,
  },
  adminDiagnostics: {
    requireAdmin,
    parseQueryNumber,
    parseQueryBoolean,
    shouldUseResolverFirstSearch,
    isStrongResolverFirstQuery,
    resolveProductRef,
    proxySearchResolverTimeoutMs: PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
    pivotaApiBase: PIVOTA_API_BASE,
    pivotaApiKey: PIVOTA_API_KEY,
    hasDatabase: HAS_DATABASE,
    creatorCatalogAutoSyncEnabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
    buildCatalogSyncSnapshot,
    searchCrossMerchantFromCache,
    getCreatorCatalogMerchantIds,
    resolveCatalogSyncMerchantIds,
    queryDb: query,
    createHashFn: createHash,
    proxySearchResolverFirstEnabled: PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
    proxySearchResolverFirstStrongOnly: PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
    proxySearchResolverFirstDisableAurora:
      PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
  },
});

commerceEntrypoints.registerHttpRoutes({
  app,
  requireExternalInvokeAuth,
  invokeAuthContext: INVOKE_AUTH_CONTEXT,
  proxyAgentSearchToBackend,
  buildFindProductsMultiPayloadFromQuery,
  firstQueryParamValue,
  buildQueryString,
});

const {
  handleOffersResolveOperation,
  inferOffersResolveFailureReasonCode,
  buildOffersResolvePdpTargetExternal,
  buildOffersResolveResponse,
} = createOffersResolveOwner({
  axiosClient: axios,
  pivotaApiBase: PIVOTA_API_BASE,
  buildInvokeUpstreamAuthHeaders,
  resolveStableAliasByQuery,
  normalizeResolverText,
  tokenizeResolverQuery,
  config: {
    subjectTimeoutMs: OFFERS_RESOLVE_SUBJECT_TIMEOUT_MS,
    cacheSearchTimeoutMs: OFFERS_RESOLVE_CACHE_SEARCH_TIMEOUT_MS,
    subjectRetryMax: OFFERS_RESOLVE_SUBJECT_RETRY_MAX,
    cacheSearchRetryMax: OFFERS_RESOLVE_CACHE_SEARCH_RETRY_MAX,
    subjectRetryBackoffMs: OFFERS_RESOLVE_SUBJECT_RETRY_BACKOFF_MS,
    cacheSearchRetryBackoffMs: OFFERS_RESOLVE_CACHE_SEARCH_RETRY_BACKOFF_MS,
    circuitFailureThreshold: OFFERS_RESOLVE_CIRCUIT_FAILURE_THRESHOLD,
    circuitOpenMs: OFFERS_RESOLVE_CIRCUIT_OPEN_MS,
    skipCacheSearchOnSubjectTimeout:
      OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_TIMEOUT,
    skipCacheSearchOnSubjectNoCandidates:
      OFFERS_RESOLVE_SKIP_CACHE_SEARCH_ON_SUBJECT_NO_CANDIDATES,
  },
});

// ---------------- Main invoke endpoint ----------------
const CHECKOUT_TIMING_OPS = new Set(['preview_quote', 'create_order', 'confirm_payment', 'submit_payment']);

bindInvokeHandler({
  createRequestId: randomUUID,
  nowMs: () => Date.now(),
  configureInvokeResponseShell,
  initializeInvokeRequestContext,
  prepareInvokeExecutionMode,
  runInvokeOperationFlow,
  sendInvokeOperationResponse,
  handleUnhandledInvokeRequestError,
  invokeRequestSchema: InvokeRequestSchema,
  operationEnum: OperationEnum,
  creatorConfigs: CREATOR_CONFIGS,
  isCreatorUiSource,
  buildFindProductsMultiContext,
  defaultFindProductsMultiExpansionMode: FIND_PRODUCTS_MULTI_EXPANSION_MODE,
  searchCacheValidate: SEARCH_CACHE_VALIDATE,
  searchForceControlledRecallForScenario:
    SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO,
  searchCacheMinAnchor: SEARCH_CACHE_MIN_ANCHOR,
  searchCacheMaxDomainEntropy: SEARCH_CACHE_MAX_DOMAIN_ENTROPY,
  searchCacheMinCount: SEARCH_CACHE_MIN_COUNT,
  searchCacheMaxCrossDomainRatio: SEARCH_CACHE_MAX_CROSS_DOMAIN_RATIO,
  searchUpstreamQuotaClarifyEnabled: SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED,
  searchUpstreamQuotaClarifyQueryClasses:
    SEARCH_UPSTREAM_QUOTA_CLARIFY_QUERY_CLASSES,
  fpmGatewayTotalBudgetMs: FPM_GATEWAY_TOTAL_BUDGET_MS,
  apiMode: API_MODE,
  useMock: USE_MOCK,
  useHybrid: USE_HYBRID,
  applyGatewayGuardrails,
  defaultMerchantId: DEFAULT_MERCHANT_ID,
  serviceGitSha: SERVICE_GIT_SHA,
  hasDatabase: HAS_DATABASE,
  routeDebugEnabled: ROUTE_DEBUG_ENABLED,
  creatorCacheShortCircuitEnabled: CREATOR_CACHE_SHORT_CIRCUIT_ENABLED,
  findProductsMultiVectorEnabled: FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
  findProductsMultiCacheStageBudgetMs:
    FIND_PRODUCTS_MULTI_CACHE_STAGE_BUDGET_MS,
  searchExternalHardRulePrune: SEARCH_EXTERNAL_HARD_RULE_PRUNE,
  searchExternalFillGated: SEARCH_EXTERNAL_FILL_GATED,
  proxySearchCacheMissResolverFallbackEnabled:
    PROXY_SEARCH_CACHE_MISS_RESOLVER_FALLBACK_ENABLED,
  proxySearchAuroraResolverTimeoutMs: PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
  proxySearchResolverTimeoutMs: PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
  proxySearchResolverFirstOnSearchRouteEnabled:
    PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
  proxySearchAuroraBypassCacheStrictEmpty:
    PROXY_SEARCH_AURORA_BYPASS_CACHE_STRICT_EMPTY,
  findProductsMultiExpansionMode: FIND_PRODUCTS_MULTI_EXPANSION_MODE,
  findProductsMultiSecondStageExpansionMode:
    FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
  searchLimitMax: SEARCH_LIMIT_MAX,
  proxySearchCreatorScopeToConfig: PROXY_SEARCH_CREATOR_SCOPE_TO_CONFIG,
  pivotaApiBase: PIVOTA_API_BASE,
  buildQueryString,
  buildInvokeUpstreamAuthHeaders,
  getUpstreamTimeoutMs,
  extractSearchQueryText,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  callUpstreamWithOptionalRetry,
  checkoutTimingOps: CHECKOUT_TIMING_OPS,
  shouldUseResolverFirstSearch,
  shouldReducePrimaryTimeoutAfterResolverMiss,
  fpmGateSimplifyV1: FPM_GATE_SIMPLIFY_V1,
  fpmLatencyGuardResolverMinRemainingMs:
    FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS,
  fpmLatencyGuardSecondStageMinRemainingMs:
    FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS,
  proxySearchPrimaryTimeoutAfterResolverMissMs:
    PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
  checkoutRetryBaseMs: CHECKOUT_RETRY_BASE_MS,
  extractUpstreamErrorCode,
  isRetryableQuoteError,
  isPydanticMissingBodyField,
  sleep: sleepMs,
  randomFn: Math.random,
  shouldSkipSecondaryFallbackAfterResolverMiss,
  shouldAllowResolverFallback,
  shouldAllowSecondaryFallback,
  shouldAllowInvokeFallback,
  findProductsMultiUpstreamLookupTimeoutMs:
    FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS,
  findProductsMultiUpstreamDefaultTimeoutMs:
    FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS,
  auroraAllowExternalSeed: PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
  auroraExternalSeedStrategy: PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
  countUsableSearchProducts,
  computePrimaryQualityScore,
  hasFragranceQuerySignal,
  getSecondaryFallbackSkipReason,
  axios,
  normalizeAgentSource,
  normalizeAgentProductsListResponse,
  normalizeAgentProductDetailResponse,
  withProxySearchFallbackMetadata,
  buildProxySearchSoftFallbackResponse,
  withSearchDiagnostics,
  buildSearchRelevanceDebug,
  withStrictEmptyFallback,
  searchStrictEmptyEnabled: SEARCH_STRICT_EMPTY_ENABLED,
  fpmClarifyNeverEmpty: FPM_CLARIFY_NEVER_EMPTY,
  searchRelevanceDebugEnabled: SEARCH_RELEVANCE_DEBUG_ENABLED,
  buildPetFallbackQuery,
  maybeRerankFindProductsMultiResponse,
  detectBrandEntities,
  loadCreatorSellableFromCache,
  searchCreatorSellableFromCache,
  probeCreatorCacheDbStats,
  loadCrossMerchantBrowseFromCache,
  uniqueStrings,
  searchCrossMerchantFromCache,
  normalizeSearchTextForMatch,
  tokenizeSearchTextForMatch,
  isSupplementCandidateRelevant,
  hasPetLeashSearchSignal,
  hasStrictPetHarnessCatalogSignal,
  buildFallbackCandidateText,
  hasPetHarnessSearchSignal,
  hasFragranceSearchSignal,
  isCatalogGuardSource,
  isBeautyGeneralDiversitySupplementCandidate,
  fetchExternalSeedSupplementFromBackend,
  firstQueryParamValue,
  buildSearchProductKey,
  isExternalSeedProduct,
  blendBeautyDiversitySupplement,
  resolveSearchDedupePerTitleLimit,
  collapseNearDuplicateSearchProducts,
  isProxySearchFallbackRelevant,
  hasPetSearchSignal,
  hasBeautyMakeupSearchSignal,
  hasBeautyCatalogProductSignal,
  isShoppingSource,
  normalizeExternalSeedStrategy,
  isUnifiedLikeExternalSeedStrategy,
  evaluateCacheQualityGate,
  isKnownLookupAliasQuery,
  queryResolveSearchFallback,
  queryFindProductsMultiFallback,
  isAuroraSource,
  loadMerchantBrowseFromCache,
  applyShoppingCatalogQueryGuards,
  getCreatorConfig,
  findSimilarCreatorFromCache,
  getProxySearchApiBase,
  getAuroraFallbackOverrides,
  applyFindProductsMultiPolicy,
  handleOffersResolveOperation,
  inferOffersResolveFailureReasonCode,
  buildOffersResolvePdpTargetExternal,
  buildOffersResolveResponse,
  resolveProductGroupCached,
  resolveCatalogSyncMerchantIds,
  getResolveProductCandidatesCacheEntry,
  setResolveProductCandidatesCache,
  resolveProductCandidatesCacheEnabled,
  resolveProductCandidatesCacheMetrics,
  resolveProductCandidatesTtlMs,
  nodeEnv: NODE_ENV,
  logger,
});

registerGlobalErrorHandler({
  app,
  logger,
});

registerRecommendRoute({
  app,
  recommendHandler,
});

module.exports = app;
module.exports._debug = {
  loadCreatorSellableFromCache,
  searchCreatorSellableFromCache,
  searchCrossMerchantFromCache,
  normalizeProductImages,
  resolveSearchDedupePerTitleLimit,
  resolveCatalogSyncMerchantIds,
  runCreatorCatalogAutoSync,
  isCatalogSyncRetryableError,
  catalogSyncState,
};

if (require.main === module) {
  (async () => {
    await startGatewayServer({
      app,
      port: PORT,
      useMock: USE_MOCK,
      apiMode: API_MODE,
      pivotaApiBase: PIVOTA_API_BASE,
      logger,
      auroraRoutesFailClosed: AURORA_ROUTES_FAIL_CLOSED,
      auroraRoutesReady,
      auroraRoutesLoadError,
      runMigrations,
      creatorCatalogAutoSyncEnabled: CREATOR_CATALOG_AUTO_SYNC_ENABLED,
      getCreatorCatalogAutoSyncIntervalConfig,
      creatorCatalogCacheTtlSeconds: CREATOR_CATALOG_CACHE_TTL_SECONDS,
      creatorCatalogAutoSyncInitialDelayMs: CREATOR_CATALOG_AUTO_SYNC_INITIAL_DELAY_MS,
      runCreatorCatalogAutoSync,
      pdpCorePrewarmEnabled: PDP_CORE_PREWARM_ENABLED,
      pdpCorePrewarmTargets: PDP_CORE_PREWARM_TARGETS,
      pdpCorePrewarmInitialDelayMs: PDP_CORE_PREWARM_INITIAL_DELAY_MS,
      pdpCorePrewarmIntervalMs: PDP_CORE_PREWARM_INTERVAL_MS,
      runPdpCorePrewarmPass,
    });
  })().catch((err) => {
    logger.error({ err: err?.message || String(err) }, 'Startup failed');
    process.exit(1);
  });
}

registerUiChatRuntime({
  app,
  logger,
  axiosClient: axios,
  gatewayUrl: UI_GATEWAY_URL,
  maxTaskPollAttempts: MAX_TASK_POLL_ATTEMPTS,
  taskPollIntervalMs: TASK_POLL_INTERVAL_MS,
  timeoutMs: 15000,
  maxAgentStepsPerTurn: MAX_AGENT_STEPS_PER_TURN,
  maxToolCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
  maxTotalRuntimeMs: MAX_TOTAL_RUNTIME_MS,
  maxToolLoopDuplicates: MAX_TOOL_LOOP_DUPLICATES,
  maxContextMessages: MAX_CONTEXT_MESSAGES,
  maxToolContentChars: MAX_TOOL_CONTENT_CHARS,
});
