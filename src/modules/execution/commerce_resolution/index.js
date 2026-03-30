const axios = require('axios');

const {
  createExecutionFacingInput,
  createExecutionFacingOutput,
} = require('../../contracts/executionFacingContracts');

const BEAUTY_FORM_FACTOR_TOKENS = new Set([
  'serum',
  'essence',
  'ampoule',
  'lotion',
  'cream',
  'moisturizer',
  'moisturiser',
  'cleanser',
  'toner',
  'mask',
  'spf',
  'sunscreen',
]);

function createCommerceResolutionRuntime(deps = {}) {
  const isAuroraSourceImpl =
    typeof deps.isAuroraSource === 'function' ? deps.isAuroraSource : () => false;
  const isKnownLookupAliasQueryImpl =
    typeof deps.isKnownLookupAliasQuery === 'function' ? deps.isKnownLookupAliasQuery : () => false;
  const hasPetSearchSignalImpl =
    typeof deps.hasPetSearchSignal === 'function' ? deps.hasPetSearchSignal : () => false;
  const normalizeOffersResolveReasonCodeImpl =
    typeof deps.normalizeOffersResolveReasonCode === 'function'
      ? deps.normalizeOffersResolveReasonCode
      : (reasonCode) => String(reasonCode || '').trim().toLowerCase();
  const hasFragranceQuerySignalImpl =
    typeof deps.hasFragranceQuerySignal === 'function'
      ? deps.hasFragranceQuerySignal
      : () => false;
  const extractSearchAnchorTokensImpl =
    typeof deps.extractSearchAnchorTokens === 'function'
      ? deps.extractSearchAnchorTokens
      : () => [];
  const isLookupStyleSearchQueryImpl =
    typeof deps.isLookupStyleSearchQuery === 'function'
      ? deps.isLookupStyleSearchQuery
      : () => false;
  const detectBeautyQueryBucketImpl =
    typeof deps.detectBeautyQueryBucket === 'function' ? deps.detectBeautyQueryBucket : () => null;
  const isProxySearchFallbackRelevantImpl =
    typeof deps.isProxySearchFallbackRelevant === 'function'
      ? deps.isProxySearchFallbackRelevant
      : null;
  const buildFallbackCandidateTextImpl =
    typeof deps.buildFallbackCandidateText === 'function'
      ? deps.buildFallbackCandidateText
      : () => '';
  const normalizeSearchTextForMatchImpl =
    typeof deps.normalizeSearchTextForMatch === 'function'
      ? deps.normalizeSearchTextForMatch
      : (value) => String(value || '').trim().toLowerCase();
  const tokenizeSearchTextForMatchImpl =
    typeof deps.tokenizeSearchTextForMatch === 'function'
      ? deps.tokenizeSearchTextForMatch
      : (value) => String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hasUsableSearchProductImpl =
    typeof deps.hasUsableSearchProduct === 'function'
      ? deps.hasUsableSearchProduct
      : (product) => Boolean(product && typeof product === 'object');
  const hasBeautyIngredientIntentSignalImpl =
    typeof deps.hasBeautyIngredientIntentSignal === 'function'
      ? deps.hasBeautyIngredientIntentSignal
      : () => false;
  const buildBeautyIngredientIntentTokensImpl =
    typeof deps.buildBeautyIngredientIntentTokens === 'function'
      ? deps.buildBeautyIngredientIntentTokens
      : () => [];
  const expandLookupAnchorTokensImpl =
    typeof deps.expandLookupAnchorTokens === 'function'
      ? deps.expandLookupAnchorTokens
      : (_, anchorTokens) => anchorTokens || [];
  const classifyBeautyBucketFromProductImpl =
    typeof deps.classifyBeautyBucketFromProduct === 'function'
      ? deps.classifyBeautyBucketFromProduct
      : () => null;
  const isBeautyBucketCompatibleForQueryImpl =
    typeof deps.isBeautyBucketCompatibleForQuery === 'function'
      ? deps.isBeautyBucketCompatibleForQuery
      : () => true;
  const hasPetHarnessSearchSignalImpl =
    typeof deps.hasPetHarnessSearchSignal === 'function'
      ? deps.hasPetHarnessSearchSignal
      : () => false;
  const hasStrictPetHarnessCatalogSignalImpl =
    typeof deps.hasStrictPetHarnessCatalogSignal === 'function'
      ? deps.hasStrictPetHarnessCatalogSignal
      : () => false;
  const applyDealsToResponseImpl =
    typeof deps.applyDealsToResponse === 'function'
      ? deps.applyDealsToResponse
      : (response) => response;
  const isUpstreamQuotaExhaustedImpl =
    typeof deps.isUpstreamQuotaExhausted === 'function'
      ? deps.isUpstreamQuotaExhausted
      : () => false;
  const shouldClarifyOnQuotaImpl =
    typeof deps.shouldClarifyOnQuota === 'function' ? deps.shouldClarifyOnQuota : () => false;
  const normalizeTravelLookupSlotStateImpl =
    typeof deps.normalizeTravelLookupSlotState === 'function'
      ? deps.normalizeTravelLookupSlotState
      : (value) => value || { asked_slots: [], resolved_slots: {} };
  const parseQueryJsonObjectImpl =
    typeof deps.parseQueryJsonObject === 'function' ? deps.parseQueryJsonObject : () => null;
  const firstQueryParamValueImpl =
    typeof deps.firstQueryParamValue === 'function' ? deps.firstQueryParamValue : (value) => value;
  const hasTravelLookupSlotStateImpl =
    typeof deps.hasTravelLookupSlotState === 'function'
      ? deps.hasTravelLookupSlotState
      : () => false;
  const buildClarificationImpl =
    typeof deps.buildClarification === 'function' ? deps.buildClarification : () => null;
  const buildClarificationReplyTextImpl =
    typeof deps.buildClarificationReplyText === 'function'
      ? deps.buildClarificationReplyText
      : (clarification) => clarification?.question || null;
  const buildSearchRouteHealthImpl =
    typeof deps.buildSearchRouteHealth === 'function'
      ? deps.buildSearchRouteHealth
      : (routeHealth) => routeHealth;
  const buildSearchTraceImpl =
    typeof deps.buildSearchTrace === 'function'
      ? deps.buildSearchTrace
      : (searchTrace) => searchTrace;
  const buildCacheStageSnapshotImpl =
    typeof deps.buildCacheStageSnapshot === 'function'
      ? deps.buildCacheStageSnapshot
      : (cacheStage) => cacheStage;
  const withSearchDiagnosticsImpl =
    typeof deps.withSearchDiagnostics === 'function'
      ? deps.withSearchDiagnostics
      : (body) => body;
  const withProxySearchFallbackMetadataImpl =
    typeof deps.withProxySearchFallbackMetadata === 'function'
      ? deps.withProxySearchFallbackMetadata
      : (body, patch) => {
          if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
          const metadata =
            body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
              ? { ...body.metadata }
              : {};
          metadata.proxy_search_fallback = {
            ...(metadata.proxy_search_fallback &&
            typeof metadata.proxy_search_fallback === 'object' &&
            !Array.isArray(metadata.proxy_search_fallback)
              ? metadata.proxy_search_fallback
              : {}),
            ...patch,
          };
          return { ...body, metadata };
        };
  const normalizeAgentProductsListResponseImpl =
    typeof deps.normalizeAgentProductsListResponse === 'function'
      ? deps.normalizeAgentProductsListResponse
      : (response) => response;
  const countUsableSearchProductsImpl =
    typeof deps.countUsableSearchProducts === 'function'
      ? deps.countUsableSearchProducts
      : (products) => (Array.isArray(products) ? products.length : 0);
  const parseQueryNumberImpl =
    typeof deps.parseQueryNumber === 'function'
      ? deps.parseQueryNumber
      : (value) => {
          const num = Number(value);
          return Number.isFinite(num) ? num : undefined;
        };
  const resolveStableAliasByQueryImpl =
    typeof deps.resolveStableAliasByQuery === 'function' ? deps.resolveStableAliasByQuery : null;
  const buildResolverQueryCandidatesImpl =
    typeof deps.buildResolverQueryCandidates === 'function'
      ? deps.buildResolverQueryCandidates
      : (query) => [String(query || '').trim()].filter(Boolean);
  const normalizeResolverTextImpl =
    typeof deps.normalizeResolverText === 'function'
      ? deps.normalizeResolverText
      : (value) => String(value || '').trim().toLowerCase();
  const tokenizeResolverQueryImpl =
    typeof deps.tokenizeResolverQuery === 'function'
      ? deps.tokenizeResolverQuery
      : (value) => String(value || '').trim().split(/\s+/).filter(Boolean);
  const extractGuidanceRetrievalContextImpl =
    typeof deps.extractGuidanceRetrievalContext === 'function'
      ? deps.extractGuidanceRetrievalContext
      : () => ({});
  const hasGuidanceLookupStyleQueryImpl =
    typeof deps.hasGuidanceLookupStyleQuery === 'function'
      ? deps.hasGuidanceLookupStyleQuery
      : () => false;
  const normalizeAgentSourceImpl =
    typeof deps.normalizeAgentSource === 'function'
      ? deps.normalizeAgentSource
      : (value) => String(value || '').trim().toLowerCase();
  const isCreatorUiSourceImpl =
    typeof deps.isCreatorUiSource === 'function' ? deps.isCreatorUiSource : () => false;
  const isResolverFirstCatalogSourceImpl =
    typeof deps.isResolverFirstCatalogSource === 'function'
      ? deps.isResolverFirstCatalogSource
      : () => false;
  const getSkipSecondaryFallbackAfterResolverMissEnabled =
    typeof deps.skipSecondaryFallbackAfterResolverMissEnabled === 'function'
      ? deps.skipSecondaryFallbackAfterResolverMissEnabled
      : () => deps.skipSecondaryFallbackAfterResolverMissEnabled === true;
  const getSimplifyGateEnabled =
    typeof deps.simplifyGateEnabled === 'function'
      ? deps.simplifyGateEnabled
      : () => deps.simplifyGateEnabled === true;
  const getLookupOnlyResolverEnabled =
    typeof deps.lookupOnlyResolverEnabled === 'function'
      ? deps.lookupOnlyResolverEnabled
      : () => deps.lookupOnlyResolverEnabled === true;
  const getResolverFallbackEnabled =
    typeof deps.resolverFallbackEnabled === 'function'
      ? deps.resolverFallbackEnabled
      : () => deps.resolverFallbackEnabled === true;
  const getSecondaryFallbackMultiEnabled =
    typeof deps.secondaryFallbackMultiEnabled === 'function'
      ? deps.secondaryFallbackMultiEnabled
      : () => deps.secondaryFallbackMultiEnabled !== false;
  const getInvokeFallbackEnabled =
    typeof deps.invokeFallbackEnabled === 'function'
      ? deps.invokeFallbackEnabled
      : () => deps.invokeFallbackEnabled !== false;
  const getResolverFirstEnabled =
    typeof deps.resolverFirstEnabled === 'function'
      ? deps.resolverFirstEnabled
      : () => deps.resolverFirstEnabled === true;
  const getResolverFirstStrongOnly =
    typeof deps.resolverFirstStrongOnly === 'function'
      ? deps.resolverFirstStrongOnly
      : () => deps.resolverFirstStrongOnly === true;
  const getAuroraRelaxPrimaryIrrelevantAdopt =
    typeof deps.auroraRelaxPrimaryIrrelevantAdopt === 'function'
      ? deps.auroraRelaxPrimaryIrrelevantAdopt
      : () => deps.auroraRelaxPrimaryIrrelevantAdopt === true;
  const getResolverMinRemainingBudgetMs =
    typeof deps.resolverMinRemainingBudgetMs === 'function'
      ? deps.resolverMinRemainingBudgetMs
      : () => Math.max(0, Number(deps.resolverMinRemainingBudgetMs || 0) || 0);
  const extractSearchQueryTextImpl =
    typeof deps.extractSearchQueryText === 'function'
      ? deps.extractSearchQueryText
      : (query) => String(query?.query || '').trim();
  const parseQueryStringArrayImpl =
    typeof deps.parseQueryStringArray === 'function'
      ? deps.parseQueryStringArray
      : (value) => (Array.isArray(value) ? value : value ? [String(value)] : []);
  const parseQueryBooleanImpl =
    typeof deps.parseQueryBoolean === 'function'
      ? deps.parseQueryBoolean
      : (value) => {
          const normalized = String(value == null ? '' : value).trim().toLowerCase();
          if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
          if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
          return undefined;
        };
  const uniqueStringsImpl =
    typeof deps.uniqueStrings === 'function'
      ? deps.uniqueStrings
      : (values) => Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
  const buildProxySearchResolverCacheKeyImpl =
    typeof deps.buildProxySearchResolverCacheKey === 'function'
      ? deps.buildProxySearchResolverCacheKey
      : () => null;
  const getProxySearchResolverCacheEntryImpl =
    typeof deps.getProxySearchResolverCacheEntry === 'function'
      ? deps.getProxySearchResolverCacheEntry
      : () => null;
  const setProxySearchResolverCacheEntryImpl =
    typeof deps.setProxySearchResolverCacheEntry === 'function'
      ? deps.setProxySearchResolverCacheEntry
      : () => {};
  const resolveProductRefImpl =
    typeof deps.resolveProductRef === 'function' ? deps.resolveProductRef : async () => null;
  const getProxySearchApiBaseImpl =
    typeof deps.getProxySearchApiBase === 'function'
      ? deps.getProxySearchApiBase
      : () => '';
  const buildInvokeUpstreamAuthHeadersImpl =
    typeof deps.buildInvokeUpstreamAuthHeaders === 'function'
      ? deps.buildInvokeUpstreamAuthHeaders
      : () => ({});
  const buildFindProductsMultiPayloadFromQueryImpl =
    typeof deps.buildFindProductsMultiPayloadFromQuery === 'function'
      ? deps.buildFindProductsMultiPayloadFromQuery
      : () => null;
  const summarizeGuidanceCandidatePoolImpl =
    typeof deps.summarizeGuidanceCandidatePool === 'function'
      ? deps.summarizeGuidanceCandidatePool
      : () => null;
  const buildBeautyQueryProfileImpl =
    typeof deps.buildBeautyQueryProfile === 'function'
      ? deps.buildBeautyQueryProfile
      : () => null;
  const buildAuroraPrimaryIrrelevantSemanticRetryQueriesImpl =
    typeof deps.buildAuroraPrimaryIrrelevantSemanticRetryQueries === 'function'
      ? deps.buildAuroraPrimaryIrrelevantSemanticRetryQueries
      : () => [];
  const hasFragranceSearchSignalImpl =
    typeof deps.hasFragranceSearchSignal === 'function'
      ? deps.hasFragranceSearchSignal
      : () => false;
  const hasBeautyMakeupSearchSignalImpl =
    typeof deps.hasBeautyMakeupSearchSignal === 'function'
      ? deps.hasBeautyMakeupSearchSignal
      : () => false;
  const customInvokeFindProductsMultiFallbackOnceImpl =
    typeof deps.invokeFindProductsMultiFallbackOnce === 'function'
      ? deps.invokeFindProductsMultiFallbackOnce
      : null;
  const httpRequestImpl =
    typeof deps.httpRequest === 'function'
      ? deps.httpRequest
      : (requestConfig) => axios(requestConfig);
  const pivotaApiKeyImpl = typeof deps.pivotaApiKey === 'function' ? deps.pivotaApiKey : () => deps.pivotaApiKey;
  const loggerImpl =
    deps.logger && typeof deps.logger === 'object'
      ? deps.logger
      : { warn() {}, info() {} };
  const fetchProductDetailFromProductsCacheImpl =
    typeof deps.fetchProductDetailFromProductsCache === 'function'
      ? deps.fetchProductDetailFromProductsCache
      : async () => null;
  const fetchProductDetailFromUpstreamImpl =
    typeof deps.fetchProductDetailFromUpstream === 'function'
      ? deps.fetchProductDetailFromUpstream
      : async () => null;
  const getResolverDetailEnabled =
    typeof deps.resolverDetailEnabled === 'function'
      ? deps.resolverDetailEnabled
      : () => deps.resolverDetailEnabled === true;
  const getProductDetailStaleMaxAgeHours =
    typeof deps.productDetailStaleMaxAgeHours === 'function'
      ? deps.productDetailStaleMaxAgeHours
      : () => Number(deps.productDetailStaleMaxAgeHours || 0) || 0;
  const getResolverDetailTimeoutMs =
    typeof deps.resolverDetailTimeoutMs === 'function'
      ? deps.resolverDetailTimeoutMs
      : () => Number(deps.resolverDetailTimeoutMs || 0) || 0;
  const getResolverTimeoutMs =
    typeof deps.resolverTimeoutMs === 'function'
      ? deps.resolverTimeoutMs
      : () => Number(deps.resolverTimeoutMs || 0) || 0;
  const getResolverCacheTtlMs =
    typeof deps.resolverCacheTtlMs === 'function'
      ? deps.resolverCacheTtlMs
      : () => Number(deps.resolverCacheTtlMs || 0) || 0;
  const getResolverMissCacheTtlMs =
    typeof deps.resolverMissCacheTtlMs === 'function'
      ? deps.resolverMissCacheTtlMs
      : () => Number(deps.resolverMissCacheTtlMs || 0) || 0;
  const getProxySearchAuroraPreserveSourceOnInvoke =
    typeof deps.proxySearchAuroraPreserveSourceOnInvoke === 'function'
      ? deps.proxySearchAuroraPreserveSourceOnInvoke
      : () => deps.proxySearchAuroraPreserveSourceOnInvoke === true;
  const getProxySearchAuroraPrimaryIrrelevantSemanticRetryEnabled =
    typeof deps.proxySearchAuroraPrimaryIrrelevantSemanticRetryEnabled === 'function'
      ? deps.proxySearchAuroraPrimaryIrrelevantSemanticRetryEnabled
      : () => deps.proxySearchAuroraPrimaryIrrelevantSemanticRetryEnabled === true;
  const getSearchCacheValidate =
    typeof deps.searchCacheValidate === 'function'
      ? deps.searchCacheValidate
      : () => deps.searchCacheValidate === true;
  const getSearchCacheMinAnchor =
    typeof deps.searchCacheMinAnchor === 'function'
      ? deps.searchCacheMinAnchor
      : () => Math.max(0, Math.min(1, Number(deps.searchCacheMinAnchor || 0) || 0));
  const getSearchCacheMaxDomainEntropy =
    typeof deps.searchCacheMaxDomainEntropy === 'function'
      ? deps.searchCacheMaxDomainEntropy
      : () => Math.max(0, Math.min(1, Number(deps.searchCacheMaxDomainEntropy || 1) || 1));
  const getSearchCacheMinCount =
    typeof deps.searchCacheMinCount === 'function'
      ? deps.searchCacheMinCount
      : () => Math.max(1, Number(deps.searchCacheMinCount || 1) || 1);
  const getSearchCacheMaxCrossDomainRatio =
    typeof deps.searchCacheMaxCrossDomainRatio === 'function'
      ? deps.searchCacheMaxCrossDomainRatio
      : () => Math.max(0, Math.min(1, Number(deps.searchCacheMaxCrossDomainRatio || 1) || 1));
  const getSearchExternalHardRulePrune =
    typeof deps.searchExternalHardRulePrune === 'function'
      ? deps.searchExternalHardRulePrune
      : () => deps.searchExternalHardRulePrune === true;
  const getProxySearchFallbackTimeoutMs =
    typeof deps.proxySearchFallbackTimeoutMs === 'function'
      ? deps.proxySearchFallbackTimeoutMs
      : () => Math.max(100, Number(deps.proxySearchFallbackTimeoutMs || 0) || 100);
  const getProxySearchAuroraFallbackTimeoutMs =
    typeof deps.proxySearchAuroraFallbackTimeoutMs === 'function'
      ? deps.proxySearchAuroraFallbackTimeoutMs
      : () =>
          Math.max(
            100,
            Number(deps.proxySearchAuroraFallbackTimeoutMs || 0) ||
              getProxySearchFallbackTimeoutMs(),
          );

  function shouldAttemptCacheMissResolverFallback({
    resolverFallbackEnabled = false,
    isLookupQuery = false,
    cacheQueryText = '',
  } = {}) {
    return Boolean(
      resolverFallbackEnabled &&
        isLookupQuery &&
        String(cacheQueryText || '').trim().length > 0,
    );
  }

  function buildCacheMissResolverFallbackRequest({
    search = {},
    cacheQueryText = '',
    inStockOnly = true,
    limit = 20,
    normalizedSeedStrategyForCache = 'unified_relevance',
    checkoutToken = null,
    source = '',
    auroraResolverTimeoutMs = 0,
    resolverTimeoutMs = 0,
  } = {}) {
    const queryText = String(cacheQueryText || '').trim();
    const priceMin = search.price_min ?? search.min_price;
    const priceMax = search.price_max ?? search.max_price;

    return {
      queryParams: {
        query: queryText,
        ...(search.category ? { category: search.category } : {}),
        ...(priceMin != null ? { min_price: priceMin } : {}),
        ...(priceMax != null ? { max_price: priceMax } : {}),
        in_stock_only: inStockOnly,
        limit,
        offset: 0,
        search_all_merchants: true,
        allow_external_seed: true,
        allow_stale_cache: false,
        external_seed_strategy: normalizedSeedStrategyForCache || 'unified_relevance',
        fast_mode: true,
      },
      checkoutToken,
      reason: 'resolver_after_cache_miss',
      requestSource: source,
      timeoutMs: isAuroraSourceImpl(source)
        ? auroraResolverTimeoutMs
        : resolverTimeoutMs,
    };
  }

  function isUuidLikeSearchQuery(value) {
    const s = String(value || '').trim();
    if (!s) return false;
    return (
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s) ||
      /^[0-9a-f]{32}$/i.test(s)
    );
  }

  function isResolverMiss(result) {
    if (!result || typeof result !== 'object') return false;
    return Number(result.usableCount || 0) <= 0;
  }

  function getCanonicalSearchFallbackReason(err) {
    const status = Number(err?.response?.status || 0) || 0;
    if ([404, 405, 415, 422].includes(status)) return `status_${status}`;
    const message = String(err?.message || '').toLowerCase();
    if (message.includes('nock: no match for request')) return 'contract_not_mocked';
    return null;
  }

  function shouldFallbackProxySearch(normalized, statusCode) {
    const status = Number(statusCode || 0);
    if (status >= 500) return true;
    if (status === 408 || status === 409 || status === 425 || status === 429) return true;
    if (status < 200 || status >= 300) return false;
    const products = Array.isArray(normalized?.products) ? normalized.products : [];
    const usableCount = countUsableSearchProductsImpl(products);
    const total = Number(normalized?.total);
    if (products.length > 0 && usableCount === 0) return true;
    if (Number.isFinite(total) && total > 0 && usableCount === 0) return true;
    if (products.length === 0 && Number.isFinite(total) && total === 0) return true;
    return false;
  }

  function getFallbackAdoptUsableThreshold({
    operation,
    source,
    primaryUsableCount,
    primaryIrrelevant,
  } = {}) {
    const baseThreshold = Math.max(1, Number(primaryUsableCount || 0));
    const op = String(operation || '').trim();
    if (op !== 'find_products_multi') return baseThreshold;
    if (!primaryIrrelevant) return baseThreshold;
    if (isAuroraSourceImpl(source) && getAuroraRelaxPrimaryIrrelevantAdopt()) return 1;
    return baseThreshold;
  }

  function buildFallbackOverlapPreview(products, queryText, maxItems = 3) {
    const rows = [];
    const normalizedQuery = normalizeSearchTextForMatchImpl(queryText);
    const baseTokens = Array.from(new Set(tokenizeSearchTextForMatchImpl(normalizedQuery)));
    const ingredientIntent = hasBeautyIngredientIntentSignalImpl(queryText);
    const meaningfulTokens = ingredientIntent
      ? baseTokens.filter((token) => token && !BEAUTY_FORM_FACTOR_TOKENS.has(token))
      : baseTokens;
    const intentTokens = ingredientIntent
      ? buildBeautyIngredientIntentTokensImpl(queryText, meaningfulTokens)
      : [];
    const effectiveTokens = Array.from(new Set([...meaningfulTokens, ...intentTokens])).slice(0, 12);

    for (const product of Array.isArray(products) ? products : []) {
      if (rows.length >= maxItems) break;
      if (!hasUsableSearchProductImpl(product)) continue;
      const candidateText = buildFallbackCandidateTextImpl(product);
      if (!candidateText) continue;
      const matched = effectiveTokens.filter((token) => candidateText.includes(token)).slice(0, 4);
      rows.push({
        product_id: String(product?.product_id || product?.id || ''),
        title: String(product?.title || product?.name || ''),
        overlap_count: matched.length,
        matched_tokens: matched,
      });
    }
    return rows;
  }

  function inferCacheProductDomainKey(product) {
    if (!product || typeof product !== 'object') return 'general';
    const pivotaDomain = String(
      product?.attributes?.pivota?.domain || product?.domain || product?.category_domain || '',
    )
      .trim()
      .toLowerCase();
    if (pivotaDomain) {
      if (pivotaDomain === 'beauty') return 'beauty';
      if (pivotaDomain === 'pet' || pivotaDomain === 'pet_supplies') return 'pet';
      if (pivotaDomain === 'travel') return 'travel';
      if (
        pivotaDomain === 'hiking' ||
        pivotaDomain === 'outdoor' ||
        pivotaDomain === 'sports_outdoor'
      ) {
        return 'hiking';
      }
    }
    const text = buildFallbackCandidateTextImpl(product);
    if (!text) return 'general';
    if (
      /\b(dog|dogs|cat|cats|pet|harness|leash|collar|puppy|kitten)\b/i.test(text) ||
      /宠物|狗|猫|牵引|狗链|背带|项圈/.test(text)
    ) {
      return 'pet';
    }
    if (
      /\b(foundation|concealer|mascara|lipstick|serum|toner|moisturizer|makeup|cosmetic)\b/i.test(
        text,
      ) ||
      /化妆|美妆|护肤|精华|口红|粉底|防晒|唇膏|眼影/.test(text)
    ) {
      return 'beauty';
    }
    if (
      /\b(hiking|outdoor|camping|trekking|trail|parka|shell)\b/i.test(text) ||
      /徒步|登山|露营|冲锋衣|户外/.test(text)
    ) {
      return 'hiking';
    }
    if (
      /\b(luggage|packing|travel|toiletry|carry-on|adapter)\b/i.test(text) ||
      /行李|收纳|旅行|出差|分装|登机/.test(text)
    ) {
      return 'travel';
    }
    return 'general';
  }

  function inferIntentDomainKeyForCacheValidation(intent, queryText) {
    const target = String(intent?.target_object?.type || '').toLowerCase();
    const primaryDomain = String(intent?.primary_domain || '').toLowerCase();
    const normalizedQuery = normalizeSearchTextForMatchImpl(queryText);
    if (target === 'pet' || hasPetSearchSignalImpl(normalizedQuery)) return 'pet';
    if (primaryDomain === 'beauty' || hasBeautyMakeupSearchSignalImpl(normalizedQuery)) return 'beauty';
    if (/travel|trip|business trip|packing|luggage|toiletry|出差|旅行|旅游|差旅/.test(normalizedQuery)) {
      return 'travel';
    }
    if (/hiking|trail|camping|outdoor|徒步|登山|露营|户外/.test(normalizedQuery)) {
      return 'hiking';
    }
    if (primaryDomain === 'sports_outdoor') return 'hiking';
    return null;
  }

  function computeDomainEntropyTopK(products, topK = 10) {
    const list = Array.isArray(products) ? products.slice(0, topK) : [];
    if (!list.length) return 1;
    const counts = new Map();
    for (const product of list) {
      const key = inferCacheProductDomainKey(product);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const total = list.length;
    if (!total || counts.size <= 1) return 0;
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log(p);
    }
    const maxEntropy = Math.log(counts.size);
    if (!(maxEntropy > 0)) return 0;
    return Math.max(0, Math.min(1, entropy / maxEntropy));
  }

  function computeAnchorRatioTopK(queryText, products, topK = 10) {
    const anchors = extractSearchAnchorTokensImpl(queryText);
    if (!anchors.length) return 1;
    const list = Array.isArray(products) ? products.slice(0, topK) : [];
    if (!list.length) return 0;
    let matched = 0;
    for (const product of list) {
      const text = buildFallbackCandidateTextImpl(product);
      if (!text) continue;
      if (anchors.some((token) => text.includes(token))) matched += 1;
    }
    return Math.max(0, Math.min(1, matched / list.length));
  }

  function resolveCacheValidationMinCount(queryClass) {
    const qc = String(queryClass || '').toLowerCase();
    if (qc === 'lookup') return 1;
    if (qc === 'scenario' || qc === 'mission') {
      return Math.max(1, Math.min(getSearchCacheMinCount(), 4));
    }
    return getSearchCacheMinCount();
  }

  function evaluateCacheQualityGate({ products, queryText, intent, queryClass } = {}) {
    const list = Array.isArray(products) ? products : [];
    const beautyQueryProfile = buildBeautyQueryProfileImpl({
      rawQuery: queryText,
      queryClass,
      intent,
    });
    const minCount =
      beautyQueryProfile?.isSpecificBeautyQuery === true &&
      beautyQueryProfile?.bucket === 'skincare'
        ? 1
        : resolveCacheValidationMinCount(queryClass);
    const anchorRatio = computeAnchorRatioTopK(queryText, list, 10);
    const domainEntropy = computeDomainEntropyTopK(list, 10);
    const expectedDomain = inferIntentDomainKeyForCacheValidation(intent, queryText);
    const topDomains = list.slice(0, 10).map((item) => inferCacheProductDomainKey(item));
    const crossDomainRatio =
      expectedDomain && topDomains.length > 0
        ? topDomains.filter(
            (domain) => domain && domain !== 'general' && domain !== expectedDomain,
          ).length / topDomains.length
        : null;
    const countOk = list.length >= minCount;
    const anchorOk = anchorRatio >= getSearchCacheMinAnchor();
    const entropyOk = domainEntropy <= getSearchCacheMaxDomainEntropy();
    const crossDomainOk =
      crossDomainRatio == null || crossDomainRatio <= getSearchCacheMaxCrossDomainRatio();
    const accepted = countOk && anchorOk && entropyOk && crossDomainOk;
    return {
      enabled: getSearchCacheValidate(),
      accepted,
      min_count: minCount,
      count: list.length,
      anchor_ratio: anchorRatio,
      min_anchor: getSearchCacheMinAnchor(),
      domain_entropy_topk: domainEntropy,
      max_domain_entropy: getSearchCacheMaxDomainEntropy(),
      expected_domain: expectedDomain,
      cross_domain_ratio: crossDomainRatio,
      max_cross_domain_ratio: getSearchCacheMaxCrossDomainRatio(),
      reason: accepted
        ? 'ok'
        : !countOk
        ? 'count_below_threshold'
        : !anchorOk
        ? 'anchor_below_threshold'
        : !entropyOk
        ? 'domain_entropy_above_threshold'
        : 'cross_domain_ratio_above_threshold',
    };
  }

  function computePrimaryQualityScore(gateResult) {
    if (!gateResult || typeof gateResult !== 'object') return null;
    const count = Math.max(0, Number(gateResult.count || 0) || 0);
    const minCount = Math.max(1, Number(gateResult.min_count || 1) || 1);
    const countScore = Math.max(0, Math.min(1, count / minCount));
    const anchorScore = Math.max(0, Math.min(1, Number(gateResult.anchor_ratio || 0) || 0));
    const entropyTopK = Math.max(0, Number(gateResult.domain_entropy_topk || 0) || 0);
    const maxEntropy = Math.max(0.01, Number(gateResult.max_domain_entropy || 1) || 1);
    const entropyScore = Math.max(0, Math.min(1, 1 - entropyTopK / maxEntropy));
    const crossDomainRatioRaw = gateResult.cross_domain_ratio;
    const maxCrossDomain = Math.max(
      0.01,
      Number(
        gateResult.max_cross_domain_ratio == null ? 1 : gateResult.max_cross_domain_ratio,
      ) || 1,
    );
    const crossDomainScore =
      crossDomainRatioRaw == null
        ? 1
        : Math.max(
            0,
            Math.min(1, 1 - (Math.max(0, Number(crossDomainRatioRaw) || 0) / maxCrossDomain)),
          );
    const composite = (countScore + anchorScore + entropyScore + crossDomainScore) / 4;
    return Math.max(0, Math.min(1, Number(composite.toFixed(3)) || 0));
  }

  function isProxySearchFallbackRelevant(normalized, queryText) {
    if (typeof isProxySearchFallbackRelevantImpl === 'function') {
      return Boolean(isProxySearchFallbackRelevantImpl(normalized, queryText));
    }
    const products = Array.isArray(normalized?.products) ? normalized.products : [];
    if (!products.length) return false;

    const normalizedQuery = normalizeSearchTextForMatchImpl(queryText);
    if (!normalizedQuery) return true;
    if (hasFragranceQuerySignalImpl(queryText)) {
      return products.slice(0, 8).some((product) => hasUsableSearchProductImpl(product));
    }

    const hasLingerieScopeSignal =
      /\b(lingerie|underwear|bra|panties|bodysuit)\b/i.test(String(queryText || '')) ||
      /内衣|文胸|胸罩|下着|ランジェリー/.test(String(queryText || ''));
    if (hasLingerieScopeSignal) {
      return products.slice(0, 8).some((product) => {
        if (!hasUsableSearchProductImpl(product)) return false;
        const candidateText = buildFallbackCandidateTextImpl(product);
        if (!candidateText) return false;
        return (
          /\b(lingerie|underwear|bra|panties|bodysuit)\b/i.test(candidateText) ||
          /内衣|文胸|胸罩|下着|ランジェリー/.test(candidateText)
        );
      });
    }

    const hasPetHarnessSignal = hasPetHarnessSearchSignalImpl(queryText);
    if (hasPetHarnessSignal) {
      for (const product of products.slice(0, 8)) {
        if (!hasUsableSearchProductImpl(product)) continue;
        const candidateText = buildFallbackCandidateTextImpl(product);
        if (!candidateText) continue;
        if (hasStrictPetHarnessCatalogSignalImpl(candidateText)) return true;
      }
      return false;
    }

    const anchorTokens = extractSearchAnchorTokensImpl(queryText);
    const lookupTokens = expandLookupAnchorTokensImpl(queryText, anchorTokens);
    const queryTokens = Array.from(new Set(tokenizeSearchTextForMatchImpl(normalizedQuery)));
    const ingredientIntent = hasBeautyIngredientIntentSignalImpl(queryText);
    const meaningfulTokens = ingredientIntent
      ? queryTokens.filter((token) => token && !BEAUTY_FORM_FACTOR_TOKENS.has(token))
      : queryTokens;
    const intentTokens = ingredientIntent
      ? buildBeautyIngredientIntentTokensImpl(queryText, meaningfulTokens)
      : [];
    const effectiveTokens = Array.from(new Set([...meaningfulTokens, ...intentTokens]));
    const longQuery = effectiveTokens.length >= 2;
    const requiredOverlap = ingredientIntent ? 1 : 2;
    const beautyQueryBucket = detectBeautyQueryBucketImpl(queryText);

    if (beautyQueryBucket) {
      for (const product of products.slice(0, 8)) {
        if (!hasUsableSearchProductImpl(product)) continue;
        const candidateBucket = classifyBeautyBucketFromProductImpl(product);
        if (!isBeautyBucketCompatibleForQueryImpl(candidateBucket, beautyQueryBucket)) continue;
        const candidateText = buildFallbackCandidateTextImpl(product);
        if (!candidateText) continue;
        if (candidateText.includes(normalizedQuery)) return true;
        if (!effectiveTokens.length) return true;
        if (effectiveTokens.length === 1) return candidateText.includes(effectiveTokens[0]);
        if (!longQuery) return true;
        const overlapCount = effectiveTokens.filter((token) => candidateText.includes(token)).length;
        if (overlapCount >= requiredOverlap) return true;
      }
      return false;
    }

    if (isLookupStyleSearchQueryImpl(queryText, anchorTokens) && lookupTokens.length > 0) {
      for (const product of products.slice(0, 8)) {
        if (!hasUsableSearchProductImpl(product)) continue;
        const candidateText = buildFallbackCandidateTextImpl(product);
        if (!candidateText) continue;
        if (lookupTokens.some((token) => candidateText.includes(token))) return true;
      }
      return false;
    }

    for (const product of products.slice(0, 8)) {
      if (!hasUsableSearchProductImpl(product)) continue;
      const candidateText = buildFallbackCandidateTextImpl(product);
      if (!candidateText) continue;
      if (candidateText.includes(normalizedQuery)) return true;
      if (!effectiveTokens.length) return true;
      if (effectiveTokens.length === 1) return candidateText.includes(effectiveTokens[0]);
      if (!longQuery) return true;
      const overlapCount = effectiveTokens.filter((token) => candidateText.includes(token)).length;
      if (overlapCount >= requiredOverlap) return true;
    }

    return false;
  }

  function shouldReducePrimaryTimeoutAfterResolverMiss(result, queryText = '') {
    if (!isResolverMiss(result)) return false;
    if (hasPetSearchSignalImpl(queryText)) return false;
    const reasonCode = normalizeOffersResolveReasonCodeImpl(
      result?.resolve_reason_code || result?.resolve_reason || '',
      '',
    );
    return (
      reasonCode === 'no_candidates' ||
      reasonCode === 'upstream_timeout' ||
      reasonCode === 'db_timeout'
    );
  }

  function isStrongResolverFirstQuery(queryText) {
    const raw = String(queryText || '').trim();
    if (!raw) return false;
    if (isKnownLookupAliasQueryImpl(raw)) return true;
    if (isUuidLikeSearchQuery(raw)) return true;
    if (!resolveStableAliasByQueryImpl) return false;

    const queryCandidates = buildResolverQueryCandidatesImpl(raw);
    for (const candidate of queryCandidates) {
      try {
        const normalized = normalizeResolverTextImpl(candidate);
        const tokens = tokenizeResolverQueryImpl(normalized);
        if (!normalized || !tokens.length) continue;
        const match = resolveStableAliasByQueryImpl({
          query: candidate,
          normalizedQuery: normalized,
          queryTokens: tokens,
        });
        if (
          match &&
          match.product_ref &&
          String(match.product_ref.product_id || '').trim() &&
          String(match.product_ref.merchant_id || '').trim()
        ) {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  }

  function getSecondaryFallbackSkipReason(
    result,
    queryText = '',
    { disableSkipAfterResolverMiss = false, queryClass = null, brandLike = false } = {},
  ) {
    if (disableSkipAfterResolverMiss) return null;
    if (!getSkipSecondaryFallbackAfterResolverMissEnabled()) return null;
    if (hasPetSearchSignalImpl(queryText)) return null;
    if (hasFragranceQuerySignalImpl(queryText)) return null;
    if (!shouldReducePrimaryTimeoutAfterResolverMiss(result, queryText)) return null;
    if (brandLike) return null;

    const normalizedQueryClass = String(queryClass || '').trim().toLowerCase();
    const lookupOnlyClasses = new Set(['lookup', 'attribute']);
    const forceSearchFirstClasses = new Set([
      'category',
      'exploratory',
      'scenario',
      'mission',
      'gift',
      'non_shopping',
    ]);
    if (normalizedQueryClass && forceSearchFirstClasses.has(normalizedQueryClass)) {
      return null;
    }

    const anchorTokens = extractSearchAnchorTokensImpl(queryText);
    const lookupStyle = isLookupStyleSearchQueryImpl(queryText, anchorTokens);
    if (isKnownLookupAliasQueryImpl(queryText)) return null;
    if (isUuidLikeSearchQuery(queryText)) return null;
    if (isStrongResolverFirstQuery(queryText)) return null;
    if (lookupStyle) return null;
    if (
      getSimplifyGateEnabled() &&
      getLookupOnlyResolverEnabled() &&
      ((!normalizedQueryClass && !lookupStyle) ||
        (normalizedQueryClass && !lookupOnlyClasses.has(normalizedQueryClass)))
    ) {
      return null;
    }
    const reasonCode = normalizeOffersResolveReasonCodeImpl(
      result?.resolve_reason_code || result?.resolve_reason || '',
      '',
    );
    if (reasonCode === 'upstream_timeout') return 'resolver_miss_upstream_timeout';
    if (reasonCode === 'db_timeout' || reasonCode === 'no_candidates') {
      return 'resolver_miss_no_positive_sources';
    }
    return 'resolver_miss_skip_secondary';
  }

  function shouldSkipSecondaryFallbackAfterResolverMiss(
    result,
    queryText = '',
    { disableSkipAfterResolverMiss = false, queryClass = null, brandLike = false } = {},
  ) {
    return Boolean(
      getSecondaryFallbackSkipReason(result, queryText, {
        disableSkipAfterResolverMiss,
        queryClass,
        brandLike,
      }),
    );
  }

  function shouldAllowResolverFallback(operation) {
    if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
    return getResolverFallbackEnabled();
  }

  function shouldAllowSecondaryFallback(operation, { forceSecondaryFallback = false } = {}) {
    if (forceSecondaryFallback) return true;
    if (operation === 'find_products_multi') {
      return getSecondaryFallbackMultiEnabled();
    }
    return true;
  }

  function shouldAllowInvokeFallback(operation, { forceInvokeFallback = false } = {}) {
    if (forceInvokeFallback) return true;
    if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
    return getInvokeFallbackEnabled();
  }

  function shouldBypassSecondaryFallbackSkipOnPrimaryException({ err }) {
    const status = Number(err?.response?.status || err?.status || 0);
    if (Number.isFinite(status) && status >= 500) return true;

    const code = String(err?.code || '').trim().toUpperCase();
    if (
      code === 'ECONNABORTED' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      code === 'EAI_AGAIN'
    ) {
      return true;
    }

    const message = String(err?.message || '').trim();
    return /timeout|timed out|socket hang up|aborted|network error/i.test(message);
  }

  function shouldUseResolverFirstSearch({
    operation,
    metadata,
    queryText,
    remainingBudgetMs = null,
    queryClass = null,
    brandLike = false,
    queryParams = null,
  }) {
    if (!getResolverFirstEnabled()) return false;
    if (!(operation === 'find_products' || operation === 'find_products_multi')) return false;
    if (!String(queryText || '').trim()) return false;
    if (
      Number.isFinite(Number(remainingBudgetMs)) &&
      Number(remainingBudgetMs) < getResolverMinRemainingBudgetMs()
    ) {
      return false;
    }

    const guidanceContext = extractGuidanceRetrievalContextImpl(
      queryParams || metadata?.queryParams || metadata?.search || {},
      { queryText },
    );
    if (
      guidanceContext.is_guidance_recall_first &&
      !hasGuidanceLookupStyleQueryImpl(queryText, guidanceContext)
    ) {
      return false;
    }

    const source = normalizeAgentSourceImpl(metadata?.source);
    const auroraSource = isAuroraSourceImpl(source);
    const isCatalogSource = isResolverFirstCatalogSourceImpl(source);
    const strongResolverQuery = isStrongResolverFirstQuery(queryText);
    if (brandLike && !(strongResolverQuery && isCatalogSource && !auroraSource)) return false;
    const normalizedQueryClass = String(queryClass || '').trim().toLowerCase();
    const forceSearchFirstClasses = new Set([
      'category',
      'exploratory',
      'scenario',
      'mission',
      'gift',
      'non_shopping',
    ]);
    if (
      getSimplifyGateEnabled() &&
      normalizedQueryClass &&
      forceSearchFirstClasses.has(normalizedQueryClass) &&
      !strongResolverQuery
    ) {
      return false;
    }

    const anchorTokens = extractSearchAnchorTokensImpl(queryText);
    const lookupStyle = isLookupStyleSearchQueryImpl(queryText, anchorTokens);
    const lookupOnlyClasses = new Set(['lookup', 'attribute']);
    if (
      getSimplifyGateEnabled() &&
      getLookupOnlyResolverEnabled() &&
      !strongResolverQuery &&
      ((!normalizedQueryClass && !lookupStyle) ||
        (normalizedQueryClass && !lookupOnlyClasses.has(normalizedQueryClass)))
    ) {
      return false;
    }

    if (isCreatorUiSourceImpl(source)) return false;
    if (!source) return true;
    if (getResolverFirstStrongOnly() && (isCatalogSource || auroraSource)) {
      return strongResolverQuery || lookupStyle;
    }

    return isCatalogSource || auroraSource;
  }

  function getResolverFallbackResolveQueryUsed(result, queryText = '') {
    return String(
      result?.resolve_query_used || result?.data?.metadata?.resolve_query_used || queryText || '',
    ).trim() || null;
  }

  function isStrongResolverLookupQuery(queryText, queryClass = null) {
    const raw = String(queryText || '').trim();
    if (!raw) return false;
    const normalizedClass = String(queryClass || '').trim().toLowerCase();
    if (normalizedClass === 'lookup') return true;
    if (isKnownLookupAliasQueryImpl(raw)) return true;
    const hasModelLikeToken = /\b[a-z]{1,6}\d{2,}\b/i.test(raw);
    const hasBeautySpfToken = /\bspf\d{2,3}\b/i.test(raw);
    if ((hasModelLikeToken && !hasBeautySpfToken) || /\b(sku|model|型号|型號)\b/i.test(raw)) {
      return true;
    }
    return false;
  }

  function getResolverFallbackAdoptionDecision({ result, queryText, queryClass = null }) {
    const resolveQueryUsed = getResolverFallbackResolveQueryUsed(result, queryText);
    if (
      !result ||
      result.status < 200 ||
      result.status >= 300 ||
      Number(result.usableCount || 0) <= 0 ||
      !result.data
    ) {
      return {
        adopt: false,
        reason: 'resolver_empty',
        resolveQueryUsed,
      };
    }
    if (!queryText) {
      return {
        adopt: true,
        reason: null,
        resolveQueryUsed,
      };
    }
    if (isStrongResolverLookupQuery(queryText, queryClass)) {
      return {
        adopt: true,
        reason: null,
        resolveQueryUsed,
      };
    }
    if (detectBeautyQueryBucketImpl(queryText)) {
      return {
        adopt: false,
        reason: 'resolver_irrelevant_to_original_query',
        resolveQueryUsed,
      };
    }
    const resolverQuerySource = String(result?.data?.metadata?.query_source || '')
      .trim()
      .toLowerCase();
    const resolverDetailSource = String(result?.data?.metadata?.resolve_detail_source || '')
      .trim()
      .toLowerCase();
    if (
      resolverQuerySource === 'agent_products_resolver_ref_fallback' ||
      resolverDetailSource === 'reference_only'
    ) {
      return {
        adopt: false,
        reason: 'resolver_irrelevant_to_original_query',
        resolveQueryUsed,
      };
    }
    const relevant = isProxySearchFallbackRelevant(result.data, queryText);
    return {
      adopt: relevant,
      reason: relevant ? null : 'resolver_irrelevant_to_original_query',
      resolveQueryUsed,
    };
  }

  function extractResolverFallbackClarification(response) {
    return response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      response.clarification &&
      typeof response.clarification === 'object' &&
      response.clarification.question
      ? response.clarification
      : null;
  }

  function shapeAdoptedResolverFallbackResponse({
    result,
    promotions,
    now,
    creatorId,
  } = {}) {
    const response = applyDealsToResponseImpl(result?.data, promotions, now, creatorId);
    const clarification = extractResolverFallbackClarification(response);
    return {
      response,
      clarification,
      finalDecision: clarification ? 'clarify' : 'resolver_returned',
    };
  }

  function buildCacheMissResolverFallbackDiagnosticsState({
    primaryLatencyMs = 0,
    ambiguityScorePre = null,
    clarification = null,
    effectiveProducts = [],
    internalProductsAfterAnchor = [],
    retrievalSources = [],
    cacheRouteDebug = null,
  } = {}) {
    return {
      routeHealthInput: {
        primaryPathUsed: 'resolver_stage',
        primaryLatencyMs: Math.max(0, Number(primaryLatencyMs || 0) || 0),
        fallbackTriggered: true,
        fallbackReason: 'resolver_after_cache_miss',
        ambiguityScorePre,
        clarifyTriggered: Boolean(clarification),
      },
      searchTraceState: {
        cacheStage: {
          hit: false,
          candidateCount: Number(effectiveProducts.length || 0),
          relevantCount: Number(internalProductsAfterAnchor.length || 0),
          retrievalSources: Array.isArray(retrievalSources) ? retrievalSources : [],
          cacheRouteDebug,
          selectedSource: 'resolver_fallback',
        },
        upstreamStage: {
          called: false,
          timeout: false,
          status: null,
          latency_ms: 0,
        },
        resolverStage: {
          called: true,
          hit: true,
          miss: false,
          latency_ms: null,
        },
        finalDecision: clarification ? 'clarify' : 'resolver_returned',
      },
    };
  }

  function buildCacheMissResolverFallbackDiagnosedResponse({
    result,
    promotions,
    now,
    creatorId,
    primaryLatencyMs = 0,
    ambiguityScorePre = null,
    effectiveProducts = [],
    internalProductsAfterAnchor = [],
    retrievalSources = [],
    cacheRouteDebug = null,
    traceId = null,
    rawQuery = '',
    expandedQuery = '',
    expansionMode = '',
    queryClass = null,
    rewriteGate = null,
    associationPlan = null,
    flagsSnapshot = null,
    intent = null,
  } = {}) {
    const {
      response,
      clarification,
      finalDecision,
    } = shapeAdoptedResolverFallbackResponse({
      result,
      promotions,
      now,
      creatorId,
    });
    const {
      routeHealthInput,
      searchTraceState,
    } = buildCacheMissResolverFallbackDiagnosticsState({
      primaryLatencyMs,
      ambiguityScorePre,
      clarification,
      effectiveProducts,
      internalProductsAfterAnchor,
      retrievalSources,
      cacheRouteDebug,
    });

    return {
      response: {
        ...response,
        route_health: buildSearchRouteHealthImpl(routeHealthInput),
        search_trace: buildSearchTraceImpl({
          traceId,
          rawQuery,
          expandedQuery,
          expansionMode,
          queryClass,
          rewriteGate,
          associationPlan,
          flagsSnapshot,
          intent,
          cacheStage: buildCacheStageSnapshotImpl(searchTraceState.cacheStage),
          upstreamStage: searchTraceState.upstreamStage,
          resolverStage: searchTraceState.resolverStage,
          finalDecision: finalDecision || searchTraceState.finalDecision,
        }),
      },
      clarification,
      finalDecision,
    };
  }

  function buildProxySearchResolverFallbackResponse({
    result,
    fallbackReason = 'resolver_after_primary',
    primaryPathUsed = 'proxy_search_primary',
    upstreamStage = null,
    fallbackStrategy = null,
  } = {}) {
    return {
      status: result?.status ?? 200,
      data: result?.data ?? null,
      respondSearchOptions: {
        finalDecision: 'resolver_returned',
        primaryPathUsed,
        fallbackTriggered: true,
        fallbackReason,
        upstreamStage,
        fallbackStrategy,
      },
    };
  }

  function buildDirectResolverFallbackResponse({ result } = {}) {
    return {
      status: result?.status ?? 200,
      data: result?.data ?? null,
    };
  }

  function normalizePrimaryClarifyContract(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? { ...body.metadata }
        : null;
    if (!metadata) return body;

    const querySource = String(metadata.query_source || '').trim().toLowerCase();
    if (querySource !== 'agent_products_error_fallback') return body;

    const clarification =
      body.clarification && typeof body.clarification === 'object' && !Array.isArray(body.clarification)
        ? body.clarification
        : null;
    if (!clarification?.question) return body;

    const searchDecision =
      metadata.search_decision && typeof metadata.search_decision === 'object' && !Array.isArray(metadata.search_decision)
        ? metadata.search_decision
        : null;
    if (String(searchDecision?.final_decision || '').trim().toLowerCase() !== 'clarify') return body;

    const fallbackMeta =
      metadata.proxy_search_fallback &&
      typeof metadata.proxy_search_fallback === 'object' &&
      !Array.isArray(metadata.proxy_search_fallback)
        ? { ...metadata.proxy_search_fallback }
        : null;
    const fallbackReason = String(
      fallbackMeta?.reason || metadata.fallback_reason || '',
    )
      .trim()
      .toLowerCase();
    const recoverableFallbackReasons = new Set([
      'primary_unusable_no_fallback',
      'primary_irrelevant_no_fallback',
      'primary_monoculture_no_fallback',
      'primary_low_quality_no_fallback',
      'fallback_not_better',
    ]);
    if (!recoverableFallbackReasons.has(fallbackReason)) return body;

    const policyAmbiguity =
      metadata.route_debug &&
      typeof metadata.route_debug === 'object' &&
      metadata.route_debug.policy &&
      typeof metadata.route_debug.policy === 'object' &&
      metadata.route_debug.policy.ambiguity &&
      typeof metadata.route_debug.policy.ambiguity === 'object'
        ? metadata.route_debug.policy.ambiguity
        : null;
    const ambiguityTriggered =
      Boolean(searchDecision?.clarify_triggered) || Boolean(policyAmbiguity?.clarify_triggered);
    if (!ambiguityTriggered) return body;

    const upstreamStatus = Number(
      metadata.upstream_status ?? fallbackMeta?.upstream_status ?? 0,
    );
    const upstreamErrorCode = String(
      metadata.upstream_error_code || fallbackMeta?.upstream_error_code || '',
    ).trim();
    const upstreamErrorMessage = String(
      metadata.upstream_error_message || fallbackMeta?.upstream_error_message || '',
    ).trim();
    const upstreamHealthy =
      upstreamStatus >= 200 &&
      upstreamStatus < 300 &&
      !upstreamErrorCode &&
      !upstreamErrorMessage &&
      metadata.upstream_quota_guarded !== true;
    if (!upstreamHealthy) return body;

    const nextMetadata = {
      ...metadata,
      query_source: 'agent_products_search',
      proxy_search_fallback: fallbackMeta
        ? {
            ...fallbackMeta,
            applied: false,
            reason: null,
          }
        : {
            applied: false,
            reason: null,
          },
      route_health:
        metadata.route_health && typeof metadata.route_health === 'object' && !Array.isArray(metadata.route_health)
          ? {
              ...metadata.route_health,
              fallback_triggered: false,
              fallback_reason: null,
            }
          : metadata.route_health,
      search_trace:
        metadata.search_trace && typeof metadata.search_trace === 'object' && !Array.isArray(metadata.search_trace)
          ? {
              ...metadata.search_trace,
              final_decision: 'clarify',
              fallback_reason: null,
            }
          : metadata.search_trace,
      search_decision:
        searchDecision
          ? {
              ...searchDecision,
              final_decision: 'clarify',
              decision_authority: 'agent_products_search',
              decision_locked: true,
              decision_lock_reason: 'primary_clarify_contract',
              fallback_reason: null,
            }
          : metadata.search_decision,
      primary_clarify_contract: {
        normalized: true,
        recovery_reason: 'ambiguity_gate_primary_clarify',
        original_query_source: querySource,
        original_fallback_reason: fallbackReason,
        primary_authority_retained: true,
        fallback_adopted: false,
      },
    };
    delete nextMetadata.strict_empty;
    delete nextMetadata.strict_empty_reason;
    delete nextMetadata.fallback_reason;
    delete nextMetadata.fallback_route;

    return {
      ...body,
      metadata: nextMetadata,
    };
  }

  function buildInvokeResolverFallbackResponse({
    result,
    fallbackReason = 'resolver_after_exception',
    route = 'invoke_exception_resolver',
    upstreamStatus = null,
    upstreamErrorCode = null,
    upstreamErrorMessage = null,
  } = {}) {
    return buildProxySearchFallbackMetadataResponse({
      status: result?.status ?? 200,
      body: result?.data ?? null,
      patch: {
        applied: true,
        reason: fallbackReason,
        route,
        upstream_status: upstreamStatus,
        upstream_error_code: upstreamErrorCode,
        upstream_error_message: upstreamErrorMessage,
      },
    });
  }

  function applyProxySearchFallbackMetadata(body, patch = {}) {
    return withProxySearchFallbackMetadataImpl(body, patch);
  }

  function buildProxySearchFallbackMetadataResponse({
    status = 200,
    body = null,
    patch = {},
  } = {}) {
    return {
      status,
      data: applyProxySearchFallbackMetadata(body, patch),
    };
  }

  function extractResolverFallbackData(result) {
    return result?.data ?? null;
  }

  function buildProxySearchSoftFallbackResponse({
    queryParams,
    reason,
    upstreamStatus = null,
    upstreamCode = null,
    upstreamMessage = null,
    route = null,
    reply = 'Search is temporarily unavailable. Please retry shortly.',
    intent = null,
    queryClass = null,
    queryText = '',
    querySource = 'agent_products_error_fallback',
    semanticRetryApplied = false,
    semanticRetryQuery = null,
    semanticRetryHits = 0,
    forceClarify = false,
    slotStateInput = null,
  }) {
    const quotaExhausted = isUpstreamQuotaExhaustedImpl({
      upstreamStatus,
      upstreamCode,
      upstreamMessage,
    });
    const fallbackReasonToken = String(reason || '').trim().toLowerCase();
    const forceClarifyByRecallExhaustion = [
      'semantic_retry_exhausted',
      'fallback_not_better',
      'low_quality_no_improvement',
      'low_quality_semantic_retry_exhausted',
      'primary_low_quality_no_fallback',
      'primary_low_quality_skip_secondary',
      'primary_irrelevant_no_fallback',
      'primary_monoculture_no_fallback',
      'primary_irrelevant_skip_secondary',
      'primary_monoculture_skip_secondary',
      'resolver_miss_skip_secondary',
      'cache_miss_strict_empty',
      'cache_irrelevant_strict_empty',
      'no_candidates',
    ].includes(fallbackReasonToken);
    const shouldClarify =
      Boolean(forceClarify) ||
      forceClarifyByRecallExhaustion ||
      (quotaExhausted && shouldClarifyOnQuotaImpl({ queryClass, intent }));
    const slotState = (() => {
      const parsed = normalizeTravelLookupSlotStateImpl(slotStateInput);
      const fromQuery = normalizeTravelLookupSlotStateImpl(
        parseQueryJsonObjectImpl(queryParams?.slot_state || queryParams?.slotState),
      );
      parsed.asked_slots = Array.from(new Set([...parsed.asked_slots, ...fromQuery.asked_slots]));
      parsed.resolved_slots = {
        ...parsed.resolved_slots,
        ...fromQuery.resolved_slots,
      };
      const clarificationSlot = String(
        firstQueryParamValueImpl(queryParams?.clarification_slot || queryParams?.clarificationSlot) ||
          '',
      )
        .trim()
        .toLowerCase();
      const clarificationAnswer = String(
        firstQueryParamValueImpl(
          queryParams?.clarification_answer || queryParams?.clarificationAnswer,
        ) || '',
      ).trim();
      if (clarificationSlot) {
        parsed.asked_slots = Array.from(new Set([...parsed.asked_slots, clarificationSlot]));
      }
      if (clarificationSlot && clarificationAnswer) {
        parsed.resolved_slots = {
          ...parsed.resolved_slots,
          [clarificationSlot]: clarificationAnswer,
        };
      }
      return hasTravelLookupSlotStateImpl(parsed) ? parsed : null;
    })();
    const clarification = shouldClarify
      ? buildClarificationImpl({
          queryClass: String(queryClass || intent?.query_class || 'exploratory').toLowerCase(),
          intent:
            intent && typeof intent === 'object' ? intent : { language: 'en', query_class: queryClass },
          language:
            (intent && typeof intent === 'object' ? intent.language : null) ||
            (typeof queryText === 'string' && /[\u4e00-\u9fff]/.test(queryText) ? 'zh' : 'en'),
          slotState,
        })
      : null;
    const resolvedReply =
      shouldClarify && clarification ? buildClarificationReplyTextImpl(clarification) : reply;
    const normalized = normalizeAgentProductsListResponseImpl(
      {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        page: 1,
        page_size: parseQueryNumberImpl(queryParams?.limit ?? queryParams?.page_size) || 0,
        reply: resolvedReply,
        ...(clarification
          ? {
              clarification: {
                question: clarification.question,
                options: clarification.options,
                reason_code: clarification.reason_code,
                ...(clarification.slot ? { slot: clarification.slot } : {}),
                ...(clarification.dedup_key ? { dedup_key: clarification.dedup_key } : {}),
              },
            }
          : {}),
        ...(shouldClarify
          ? {
              reason_codes: forceClarify
                ? ['SEMANTIC_RETRY_EXHAUSTED', 'AMBIGUITY_CLARIFY']
                : forceClarifyByRecallExhaustion
                  ? ['SEMANTIC_RETRY_EXHAUSTED', 'AMBIGUITY_CLARIFY']
                  : ['UPSTREAM_QUOTA_EXHAUSTED', 'AMBIGUITY_CLARIFY'],
            }
          : {}),
        metadata: {
          query_source: String(querySource || 'agent_products_error_fallback'),
          upstream_status: Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null,
          upstream_error_code: upstreamCode ? String(upstreamCode) : null,
          upstream_error_message: upstreamMessage ? String(upstreamMessage) : null,
          fallback_route: route || null,
          semantic_retry_applied: Boolean(semanticRetryApplied),
          semantic_retry_query: semanticRetryQuery ? String(semanticRetryQuery) : null,
          semantic_retry_hits: Math.max(0, Number(semanticRetryHits || 0) || 0),
          ...(forceClarifyByRecallExhaustion
            ? {
                strict_empty: true,
                strict_empty_reason: String(reason || 'strict_empty'),
              }
            : {}),
          ...(quotaExhausted && shouldClarify ? { upstream_quota_guarded: true } : {}),
          ...(slotState ? { slot_state: slotState } : {}),
        },
      },
      {
        limit: queryParams?.limit,
        offset: queryParams?.offset,
      },
    );
    return applyProxySearchFallbackMetadata(normalized, {
      applied: true,
      reason: reason || 'error_soft_fallback',
      route: route || null,
      upstream_status: Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null,
      upstream_error_code: upstreamCode ? String(upstreamCode) : null,
      upstream_error_message: upstreamMessage ? String(upstreamMessage) : null,
    });
  }

  function buildStrictEmptyFallbackResponse({
    body = null,
    queryParams,
    reason,
    upstreamStatus = null,
    upstreamCode = null,
    upstreamMessage = null,
    route = null,
    fallbackStrategy = null,
    intent = null,
    queryClass = null,
    queryText = '',
    querySource = null,
    semanticRetryApplied = false,
    semanticRetryQuery = null,
    semanticRetryHits = 0,
  } = {}) {
    const emptyBody = buildProxySearchSoftFallbackResponse({
      queryParams,
      reason,
      upstreamStatus,
      upstreamCode,
      upstreamMessage,
      route,
      intent,
      queryClass,
      queryText,
      querySource,
      semanticRetryApplied,
      semanticRetryQuery,
      semanticRetryHits,
    });
    const hasClarification = Boolean(emptyBody?.clarification?.question);
    return withSearchDiagnosticsImpl(emptyBody, {
      strict_empty: !hasClarification,
      ...(hasClarification ? {} : { strict_empty_reason: reason || 'strict_empty' }),
      ...(fallbackStrategy && typeof fallbackStrategy === 'object'
        ? { fallback_strategy: fallbackStrategy }
        : {}),
    });
  }

  async function invokeFindProductsMultiFallbackOnce({
    url,
    searchUrl,
    payload,
    checkoutToken,
    requestSource,
    triggerReason,
    preserveAuroraSource,
    fallbackSource,
    relevanceQuery,
    attemptNo,
    useSearchEndpoint = false,
    timeoutMs = getProxySearchFallbackTimeoutMs(),
  } = {}) {
    if (customInvokeFindProductsMultiFallbackOnceImpl !== null) {
      return customInvokeFindProductsMultiFallbackOnceImpl({
        url,
        searchUrl,
        payload,
        checkoutToken,
        requestSource,
        triggerReason,
        preserveAuroraSource,
        fallbackSource,
        relevanceQuery,
        attemptNo,
        useSearchEndpoint,
        timeoutMs,
      });
    }

    const normalizedRequestSource = String(requestSource || '').trim().toLowerCase();
    const requestSourceValue = preserveAuroraSource
      ? normalizedRequestSource
      : fallbackSource || 'agent_search_proxy_fallback';
    const requestHeaders = {
      ...buildInvokeUpstreamAuthHeadersImpl({ checkoutToken }),
    };
    const searchPayload =
      payload?.search && typeof payload.search === 'object' ? payload.search : {};
    const requestTimeoutMs = Math.max(
      250,
      Number(timeoutMs || getProxySearchFallbackTimeoutMs()) || getProxySearchFallbackTimeoutMs(),
    );

    const response = useSearchEndpoint
      ? await httpRequestImpl({
          method: 'GET',
          url: searchUrl,
          params: {
            ...searchPayload,
            source: requestSourceValue,
          },
          headers: requestHeaders,
          timeout: requestTimeoutMs,
          validateStatus: () => true,
        })
      : await httpRequestImpl({
          method: 'POST',
          url,
          data: {
            operation: 'find_products_multi',
            payload,
            metadata: {
              source: requestSourceValue,
              ...(normalizedRequestSource ? { request_source: normalizedRequestSource } : {}),
              trigger_reason: triggerReason || 'unknown',
              proxy_fallback_source: 'agent_search_proxy_fallback',
              proxy_fallback_attempt: Number(attemptNo || 1),
            },
          },
          headers: {
            'Content-Type': 'application/json',
            ...requestHeaders,
          },
          timeout: requestTimeoutMs,
          validateStatus: () => true,
        });

    const normalized = normalizeAgentProductsListResponseImpl(response?.data, {
      limit: parseQueryNumberImpl(payload?.search?.limit ?? payload?.search?.page_size),
      offset: parseQueryNumberImpl(payload?.search?.offset),
    });
    const usableCount = countUsableSearchProductsImpl(normalized?.products);
    const guidanceSummary = summarizeGuidanceCandidatePoolImpl(
      normalized?.products,
      relevanceQuery,
      payload?.search,
    );
    const relevanceMatched = relevanceQuery
      ? guidanceSummary
        ? Number(guidanceSummary.target_relevant_count || 0) > 0
        : isProxySearchFallbackRelevant(normalized, relevanceQuery)
      : usableCount > 0;

    return {
      status: Number(response?.status || 0) || 0,
      usableCount,
      relevanceMatched,
      targetRelevantCount: guidanceSummary ? guidanceSummary.target_relevant_count : 0,
      targetRelevanceCounts: guidanceSummary ? guidanceSummary.counts : null,
      top3QualityScore: guidanceSummary ? guidanceSummary.top3_quality_score : null,
      queryUsed: String(payload?.search?.query || ''),
      productsPreview: buildFallbackOverlapPreview(normalized?.products, relevanceQuery, 3),
      data: applyProxySearchFallbackMetadata(normalized, {
        applied: true,
        reason: triggerReason || 'unknown',
        query_variant:
          normalizeSearchTextForMatchImpl(String(payload?.search?.query || '')) ===
          normalizeSearchTextForMatchImpl(String(relevanceQuery || ''))
            ? 'primary'
            : 'semantic_retry',
      }),
    };
  }

  function buildSecondaryFallbackMeta(fallback = null, queryText = '') {
    const attempts = Array.isArray(fallback?.attempts)
      ? fallback.attempts.slice(0, 3)
      : fallback
        ? [{ query: fallback?.selectedQuery || queryText }]
        : [];
    const semanticRetryApplied = Boolean(fallback?.actualRetryAttempted);
    const semanticRetryQuery = semanticRetryApplied
      ? String(
          fallback?.selectedQuery || attempts[attempts.length - 1]?.query || '',
        ).trim() || null
      : null;
    const selectedQuery = String(fallback?.selectedQuery || '').trim() || null;
    const selectedQueryMatchesPrimary =
      selectedQuery != null &&
      normalizeSearchTextForMatchImpl(selectedQuery) ===
        normalizeSearchTextForMatchImpl(String(queryText || ''));
    const targetRelevantCount = Math.max(0, Number(fallback?.targetRelevantCount || 0) || 0);
    const top3QualityScore = Number(fallback?.top3QualityScore || 0) || 0;

    return {
      attempt_count: attempts.length,
      selected_attempt: Math.max(0, Number(fallback?.selectedAttemptNo || 0) || 0),
      attempts,
      selected_query: selectedQuery,
      selected_query_matches_primary: selectedQueryMatchesPrimary,
      semantic_retry_applied: semanticRetryApplied,
      semantic_retry_actual_attempted: Boolean(fallback?.actualRetryAttempted),
      semantic_retry_query: semanticRetryQuery,
      semantic_retry_hits: Math.max(0, Number(fallback?.usableCount || 0) || 0),
      usable_count: Math.max(0, Number(fallback?.usableCount || 0) || 0),
      target_relevant_count: targetRelevantCount,
      top3_quality_score: top3QualityScore,
    };
  }

  function getPrimarySearchQualityDecision({
    normalized = null,
    products = null,
    queryText = '',
    queryClass = null,
    primaryQualityGate = null,
    lowQualityNonempty = false,
    usableCount = null,
    hasExternalSeed = false,
    brandLike = false,
  } = {}) {
    const list = Array.isArray(products)
      ? products
      : Array.isArray(normalized?.products)
      ? normalized.products
      : [];
    const resolvedUsableCount = Math.max(
      0,
      Number(
        usableCount != null ? usableCount : countUsableSearchProductsImpl(list),
      ) || 0,
    );
    const normalizedQuery = normalizeSearchTextForMatchImpl(queryText);
    const normalizedQueryClass = String(queryClass || '').trim().toLowerCase();
    const gateReason =
      primaryQualityGate && typeof primaryQualityGate === 'object'
        ? String(primaryQualityGate.reason || '').trim() || null
        : null;
    const gateRejected = Boolean(lowQualityNonempty);
    const anchorTokens = extractSearchAnchorTokensImpl(queryText);
    const lookupLike = Boolean(
      normalizedQuery &&
        (normalizedQueryClass === 'lookup' ||
          isStrongResolverLookupQuery(queryText, queryClass) ||
          (anchorTokens.length >= 2 && isLookupStyleSearchQueryImpl(queryText, anchorTokens))),
    );
    const fragranceLike = Boolean(normalizedQuery && hasFragranceQuerySignalImpl(queryText));
    const resolutionLike = lookupLike || fragranceLike;
    let targetRelevantCount = 0;
    let top3QualityScore = null;
    let strongEvidencePassed = null;

    if (resolvedUsableCount > 0 && resolutionLike) {
      const baseTokens = Array.from(new Set(tokenizeSearchTextForMatchImpl(normalizedQuery)));
      const expandedLookupTokens = lookupLike
        ? expandLookupAnchorTokensImpl(queryText, anchorTokens)
        : anchorTokens;
      const effectiveTokens = Array.from(
        new Set([...(Array.isArray(expandedLookupTokens) ? expandedLookupTokens : []), ...baseTokens]),
      )
        .filter(Boolean)
        .slice(0, 12);
      const topCandidates = list.filter((product) => hasUsableSearchProductImpl(product)).slice(0, 3);
      const requiredStrongOverlap = Math.min(
        2,
        Math.max(1, effectiveTokens.length || baseTokens.length || 1),
      );
      let exactMatchCount = 0;
      let qualityScore = 0;

      for (const product of topCandidates) {
        const candidateText = buildFallbackCandidateTextImpl(product);
        if (!candidateText) {
          qualityScore -= 25;
          continue;
        }
        const overlapCount = effectiveTokens.filter((token) => candidateText.includes(token)).length;
        const exactMatch = Boolean(normalizedQuery) && candidateText.includes(normalizedQuery);
        const strongMatch = exactMatch || overlapCount >= requiredStrongOverlap;
        const supportiveMatch = overlapCount > 0;

        if (exactMatch) exactMatchCount += 1;
        if (strongMatch) targetRelevantCount += 1;

        if (exactMatch) qualityScore += 120;
        else if (strongMatch) qualityScore += 90;
        else if (supportiveMatch) qualityScore += 35;
        else qualityScore -= 25;
      }

      top3QualityScore = qualityScore;
      strongEvidencePassed =
        exactMatchCount > 0 ||
        targetRelevantCount > 0 ||
        (lookupLike
          ? qualityScore >= 90
          : fragranceLike
          ? qualityScore >= 100
          : false);
    }

    const weakEvidenceLowQuality =
      !gateRejected &&
      resolvedUsableCount > 0 &&
      resolutionLike &&
      !brandLike &&
      !hasExternalSeed &&
      strongEvidencePassed === false;
    const reason = gateRejected
      ? gateReason ||
        (resolutionLike && strongEvidencePassed === false
          ? fragranceLike
            ? 'weak_fragrance_evidence'
            : 'weak_resolution_evidence'
          : 'quality_gate_rejected')
      : weakEvidenceLowQuality
      ? fragranceLike
        ? 'weak_fragrance_evidence'
        : 'weak_resolution_evidence'
      : null;

    return {
      lowQualityNonempty: gateRejected || weakEvidenceLowQuality,
      reason,
      queryType: lookupLike ? 'lookup_like' : fragranceLike ? 'fragrance_like' : 'generic',
      targetRelevantCount: Math.max(0, Number(targetRelevantCount || 0) || 0),
      top3QualityScore:
        top3QualityScore != null && Number.isFinite(Number(top3QualityScore))
          ? Number(top3QualityScore)
          : null,
      strongEvidencePassed,
    };
  }

  function getSecondaryFallbackOutcomeDecision({
    fallback = null,
    queryText = '',
    queryClass = null,
    operation = 'find_products_multi',
    source = '',
    primaryUsableCount = 0,
    primaryIrrelevant = false,
    primaryLowQualityNonempty = false,
    primaryUnusable = false,
    primaryMonoculture = false,
  } = {}) {
    const meta = buildSecondaryFallbackMeta(fallback, queryText);
    const adoptUsableThreshold = getFallbackAdoptUsableThreshold({
      operation,
      source,
      primaryUsableCount,
      primaryIrrelevant,
    });
    const anchorTokens = extractSearchAnchorTokensImpl(queryText);
    const normalizedQueryClass = String(queryClass || '').trim().toLowerCase();
    const lookupLike =
      isStrongResolverLookupQuery(queryText, queryClass) ||
      normalizedQueryClass === 'lookup' ||
      isLookupStyleSearchQueryImpl(queryText, anchorTokens);
    const fragranceLike = hasFragranceQuerySignalImpl(queryText);
    const adoptableQueryType = lookupLike || fragranceLike;
    const fallbackRelevant = Boolean(
      fallback &&
        ((fragranceLike && meta.usable_count > 0) ||
          fallback.relevanceMatched === true ||
          (fallback.relevanceMatched == null &&
            isProxySearchFallbackRelevant(fallback.data, queryText))),
    );
    const fallbackRecallImproved = meta.usable_count >= Math.max(
      adoptUsableThreshold,
      Number(primaryUsableCount || 0) + (primaryLowQualityNonempty ? 1 : 2),
    );
    const semanticRetryAdoptable =
      !meta.semantic_retry_applied ||
      (lookupLike &&
        (meta.selected_query_matches_primary ||
          meta.target_relevant_count > 0 ||
          meta.top3_quality_score >= 100)) ||
      (fragranceLike &&
        meta.target_relevant_count > 1 &&
        meta.top3_quality_score >= 140);
    const strongAdoptionEvidence =
      fallbackRelevant &&
      (!meta.semantic_retry_actual_attempted
        ? lookupLike
          ? meta.selected_query_matches_primary ||
            meta.target_relevant_count > 0 ||
            meta.top3_quality_score >= 80
          : fragranceLike
          ? meta.target_relevant_count > 0 || meta.top3_quality_score >= 100
          : false
        : lookupLike
        ? meta.target_relevant_count > 0 || meta.top3_quality_score >= 100
        : fragranceLike
        ? meta.target_relevant_count > 1 && meta.top3_quality_score >= 140
        : false);
    const adopted =
      Boolean(fallback) &&
      fallback.status >= 200 &&
      fallback.status < 300 &&
      meta.usable_count >= adoptUsableThreshold &&
      fallbackRelevant &&
      adoptableQueryType &&
      semanticRetryAdoptable &&
      strongAdoptionEvidence &&
      (lookupLike || fragranceLike || fallbackRecallImproved);

    const adoptReason = primaryUnusable
      ? 'secondary_after_primary_unusable'
      : primaryMonoculture
      ? 'secondary_after_primary_monoculture'
      : primaryLowQualityNonempty
      ? 'secondary_after_primary_low_quality'
      : 'secondary_after_primary_irrelevant';

    let rejectionReason = null;
    if (!fallback) {
      rejectionReason = 'secondary_unavailable';
    } else if (fallback.status < 200 || fallback.status >= 300) {
      rejectionReason = 'secondary_status_non_2xx';
    } else if (meta.usable_count < adoptUsableThreshold) {
      rejectionReason = 'secondary_below_usable_threshold';
    } else if (!fallbackRelevant) {
      rejectionReason = 'secondary_irrelevant';
    } else if (!adoptableQueryType) {
      rejectionReason = 'secondary_not_resolution_like';
    } else if (!semanticRetryAdoptable) {
      rejectionReason = 'secondary_semantic_retry_not_adoptable';
    } else if (!strongAdoptionEvidence) {
      rejectionReason = meta.semantic_retry_actual_attempted
        ? 'secondary_semantic_retry_weak_evidence'
        : 'secondary_weak_resolution_evidence';
    } else if (!fallbackRecallImproved && !lookupLike && !fragranceLike) {
      rejectionReason = 'secondary_not_improved';
    }

    const nonAdoptReason = primaryIrrelevant
      ? primaryMonoculture
        ? 'primary_monoculture_no_fallback'
        : 'primary_irrelevant_no_fallback'
      : primaryLowQualityNonempty
      ? meta.semantic_retry_applied
        ? 'low_quality_semantic_retry_exhausted'
        : 'primary_low_quality_no_fallback'
      : meta.semantic_retry_applied
      ? 'semantic_retry_exhausted'
      : 'fallback_not_better';

    const decision = adopted
      ? 'adopt'
      : primaryIrrelevant || primaryLowQualityNonempty || meta.semantic_retry_applied
      ? 'clarify'
      : 'strict_empty';

    return {
      decision,
      reason: adopted ? adoptReason : nonAdoptReason,
      rejectionReason: adopted ? null : rejectionReason || nonAdoptReason,
      querySource:
        adopted || decision === 'strict_empty'
          ? 'agent_products_error_fallback'
          : meta.semantic_retry_applied
          ? 'agent_products_semantic_retry_exhausted'
          : 'agent_products_error_fallback',
      fallbackRelevant,
      fallbackRecallImproved,
      strongAdoptionEvidence,
      adoptUsableThreshold,
      usableCount: meta.usable_count,
      targetRelevantCount: meta.target_relevant_count,
      top3QualityScore: meta.top3_quality_score,
      ...meta,
    };
  }

  function getPrimaryFallbackOutcomeDecision({
    shouldFallback = false,
    decisionLocked = false,
    decisionAuthority = null,
    decisionLockReason = null,
    primaryUsableCount = 0,
    primaryUnusable = false,
    primaryIrrelevant = false,
    primaryLowQualityNonempty = false,
    primaryMonoculture = false,
    skipSecondaryFallback = false,
    secondaryFallbackOutcome = null,
    semanticRetryApplied = false,
    fallbackNotBetterReason = null,
  } = {}) {
    const semanticRetryExhausted = Boolean(semanticRetryApplied);
    const querySource = secondaryFallbackOutcome?.querySource ||
      (semanticRetryExhausted
        ? 'agent_products_semantic_retry_exhausted'
        : 'agent_products_error_fallback');
    const irrelevantReason = skipSecondaryFallback
      ? primaryMonoculture
        ? 'primary_monoculture_skip_secondary'
        : 'primary_irrelevant_skip_secondary'
      : primaryMonoculture
      ? 'primary_monoculture_no_fallback'
      : 'primary_irrelevant_no_fallback';
    const lowQualityReason = semanticRetryExhausted
      ? 'low_quality_semantic_retry_exhausted'
      : skipSecondaryFallback
      ? 'primary_low_quality_skip_secondary'
      : 'primary_low_quality_no_fallback';
    const unusableReason = semanticRetryExhausted
      ? 'primary_unusable_semantic_retry_exhausted'
      : skipSecondaryFallback
      ? 'primary_unusable_skip_secondary'
      : 'primary_unusable_no_fallback';
    const exhaustedReason =
      String(fallbackNotBetterReason || '').trim() ||
      (semanticRetryExhausted
        ? 'semantic_retry_exhausted'
        : skipSecondaryFallback
        ? 'resolver_miss_skip_secondary'
        : 'fallback_not_better');
    const clarifyAfterFallback = Boolean(
      shouldFallback &&
        !primaryIrrelevant &&
        !primaryLowQualityNonempty &&
        (
          secondaryFallbackOutcome?.decision === 'clarify' ||
          (
            getSearchExternalHardRulePrune() &&
            semanticRetryExhausted &&
            !skipSecondaryFallback &&
            Number(primaryUsableCount || 0) === 0
          )
        ),
    );

    if (decisionLocked) {
      return {
        decision: 'authority_locked',
        reason: String(decisionLockReason || '').trim() || 'decision_locked',
        querySource: String(decisionAuthority || '').trim() || querySource,
        resolution_authority: String(decisionAuthority || '').trim() || querySource,
        fallback_applied: false,
        fallback_reason_codes: [String(decisionLockReason || '').trim() || 'decision_locked'],
      };
    }

    if (primaryIrrelevant) {
      return {
        decision: 'clarify',
        reason: irrelevantReason,
        querySource,
        resolution_authority: querySource,
        fallback_applied: Boolean(shouldFallback),
        fallback_reason_codes: [irrelevantReason],
      };
    }

    if (primaryLowQualityNonempty && shouldFallback) {
      return {
        decision: 'clarify',
        reason: lowQualityReason,
        querySource,
        resolution_authority: querySource,
        fallback_applied: true,
        fallback_reason_codes: [lowQualityReason],
      };
    }

    if (shouldFallback && primaryUnusable) {
      return {
        decision: 'strict_empty',
        reason: unusableReason,
        querySource,
        resolution_authority: querySource,
        fallback_applied: true,
        fallback_reason_codes: [unusableReason],
      };
    }

    if (Number(primaryUsableCount || 0) > 0) {
      return {
        decision: 'upstream_returned',
        reason: shouldFallback ? exhaustedReason : 'not_needed',
        querySource: 'agent_products_search',
        resolution_authority: 'primary_upstream',
        fallback_applied: false,
        fallback_reason_codes: [],
      };
    }

    if (clarifyAfterFallback) {
      return {
        decision: 'clarify',
        reason: exhaustedReason,
        querySource,
        resolution_authority: querySource,
        fallback_applied: true,
        fallback_reason_codes: [exhaustedReason],
      };
    }

    if (secondaryFallbackOutcome?.decision === 'strict_empty' && shouldFallback && !primaryIrrelevant) {
      return {
        decision: 'strict_empty',
        reason: exhaustedReason,
        querySource,
        resolution_authority: querySource,
        fallback_applied: true,
        fallback_reason_codes: [exhaustedReason],
      };
    }

    return {
      decision: 'strict_empty',
      reason: shouldFallback ? exhaustedReason : 'no_candidates',
      querySource,
      resolution_authority: shouldFallback ? querySource : 'primary_upstream',
      fallback_applied: Boolean(shouldFallback),
      fallback_reason_codes: [shouldFallback ? exhaustedReason : 'no_candidates'],
    };
  }

  async function queryFindProductsMultiFallback({
    queryParams,
    checkoutToken,
    reason,
    requestSource,
    timeoutMs = null,
  } = {}) {
    const payload = buildFindProductsMultiPayloadFromQueryImpl(queryParams);
    if (!payload || typeof invokeFindProductsMultiFallbackOnce !== 'function') return null;

    const fallbackSource = String(payload?.metadata?.source || '').trim();
    const normalizedRequestSource = String(requestSource || '').trim().toLowerCase();
    const searchApiBase = getProxySearchApiBaseImpl(normalizedRequestSource);
    const url = `${searchApiBase}/agent/shop/v1/invoke`;
    const searchUrl = `${searchApiBase}/agent/v1/products/search`;
    const preserveAuroraSource =
      getProxySearchAuroraPreserveSourceOnInvoke() && isAuroraSourceImpl(normalizedRequestSource);
    const baseQueryText = String(payload?.search?.query || '').trim();
    const normalizedReason = String(reason || '').trim();
    const isAuroraMonocultureRetry =
      isAuroraSourceImpl(normalizedRequestSource) && normalizedReason === 'primary_monoculture';
    const isAuroraSemanticRetry =
      getProxySearchAuroraPrimaryIrrelevantSemanticRetryEnabled() &&
      isAuroraSourceImpl(normalizedRequestSource) &&
      (normalizedReason === 'primary_irrelevant' || isAuroraMonocultureRetry);
    const isFragranceSemanticRetry =
      getSearchExternalHardRulePrune() &&
      hasFragranceSearchSignalImpl(baseQueryText) &&
      normalizedReason !== 'primary_request_failed';
    const semanticRetryEnabled = isAuroraSemanticRetry || isFragranceSemanticRetry;
    const semanticRetryQueries = semanticRetryEnabled
      ? buildAuroraPrimaryIrrelevantSemanticRetryQueriesImpl(baseQueryText)
      : [];
    const candidateQueries = [baseQueryText, ...semanticRetryQueries].filter(Boolean);
    const defaultFallbackTimeoutMs = Math.max(100, Number(getProxySearchFallbackTimeoutMs()) || 100);
    const auroraFallbackTimeoutMs = Math.max(
      100,
      Number(getProxySearchAuroraFallbackTimeoutMs()) || defaultFallbackTimeoutMs,
    );
    const configuredFallbackTimeoutMs = isAuroraSourceImpl(normalizedRequestSource)
      ? Math.min(defaultFallbackTimeoutMs, auroraFallbackTimeoutMs)
      : defaultFallbackTimeoutMs;
    const requestedBudgetMs =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
    const totalFallbackBudgetMs =
      requestedBudgetMs == null ? configuredFallbackTimeoutMs : Math.max(100, requestedBudgetMs);
    const fallbackDeadlineMs = Date.now() + totalFallbackBudgetMs;

    let selectedAttempt = null;
    let selectedAttemptNo = 0;
    const attempts = [];

    for (let i = 0; i < candidateQueries.length; i += 1) {
      const remainingBudgetMs = Math.max(0, fallbackDeadlineMs - Date.now());
      if (remainingBudgetMs < 100) break;

      const attemptTimeoutMs = Math.max(
        100,
        Math.min(configuredFallbackTimeoutMs, remainingBudgetMs),
      );
      const queryText = candidateQueries[i];
      const attemptPayload =
        i === 0
          ? payload
          : {
              ...payload,
              search: {
                ...(payload?.search && typeof payload.search === 'object' ? payload.search : {}),
                query: queryText,
              },
            };
      const useSearchEndpoint = semanticRetryEnabled && i > 0;
      const attempt = await invokeFindProductsMultiFallbackOnce({
        url,
        searchUrl,
        payload: attemptPayload,
        checkoutToken,
        requestSource: normalizedRequestSource,
        triggerReason: reason,
        preserveAuroraSource,
        fallbackSource,
        relevanceQuery: queryText,
        attemptNo: i + 1,
        useSearchEndpoint,
        timeoutMs: attemptTimeoutMs,
      });

      if (!attempt || typeof attempt !== 'object') continue;

      attempts.push({
        attempt: i + 1,
        query: attempt.queryUsed,
        status: attempt.status,
        usable_count: attempt.usableCount,
        target_relevant_count: Number(attempt.targetRelevantCount || 0),
        relevance_matched: attempt.relevanceMatched,
        products_preview: attempt.productsPreview,
      });

      if (!selectedAttempt) {
        selectedAttempt = attempt;
        selectedAttemptNo = i + 1;
      } else {
        const selectedScore =
          (selectedAttempt.status >= 200 && selectedAttempt.status < 300 ? 100 : 0) +
          (selectedAttempt.relevanceMatched ? 50 : 0) +
          Math.min(120, Number(selectedAttempt.targetRelevantCount || 0) * 30) +
          Math.min(120, Number(selectedAttempt.top3QualityScore || 0)) +
          Math.min(20, selectedAttempt.usableCount);
        const candidateScore =
          (attempt.status >= 200 && attempt.status < 300 ? 100 : 0) +
          (attempt.relevanceMatched ? 50 : 0) +
          Math.min(120, Number(attempt.targetRelevantCount || 0) * 30) +
          Math.min(120, Number(attempt.top3QualityScore || 0)) +
          Math.min(20, attempt.usableCount);
        if (candidateScore > selectedScore) {
          selectedAttempt = attempt;
          selectedAttemptNo = i + 1;
        }
      }

      if (attempt.relevanceMatched && attempt.usableCount > 0) {
        const shouldForceNextSemanticAttempt =
          isAuroraMonocultureRetry && i === 0 && candidateQueries.length > 1;
        if (!shouldForceNextSemanticAttempt) break;
      }
    }

    if (!selectedAttempt) return null;

    const attemptedSemanticRetry = attempts.some((attempt, index) => {
      if (!attempt || index === 0) return false;
      return (
        normalizeSearchTextForMatchImpl(String(attempt.query || '')) !==
        normalizeSearchTextForMatchImpl(String(baseQueryText || ''))
      );
    });
    const selectedAttemptIsSemanticRetry =
      normalizeSearchTextForMatchImpl(String(selectedAttempt.queryUsed || '')) !==
      normalizeSearchTextForMatchImpl(String(baseQueryText || ''));
    const semanticRetryApplied = attemptedSemanticRetry || selectedAttemptIsSemanticRetry;
    const semanticRetrySelectedQuery =
      semanticRetryApplied && selectedAttemptIsSemanticRetry
        ? String(selectedAttempt.queryUsed || '').trim()
        : semanticRetryApplied
          ? String(
              attempts.find(
                (attempt) =>
                  normalizeSearchTextForMatchImpl(String(attempt?.query || '')) !==
                  normalizeSearchTextForMatchImpl(String(baseQueryText || '')),
              )?.query || '',
            ).trim()
          : '';
    const semanticRetryHits = semanticRetryApplied
      ? Math.max(
          0,
          ...attempts
            .filter(
              (attempt) =>
                normalizeSearchTextForMatchImpl(String(attempt?.query || '')) !==
                normalizeSearchTextForMatchImpl(String(baseQueryText || '')),
            )
            .map((attempt) => Math.max(0, Number(attempt?.usable_count || 0) || 0)),
        )
      : 0;

    return {
      status: selectedAttempt.status,
      usableCount: selectedAttempt.usableCount,
      relevanceMatched: selectedAttempt.relevanceMatched,
      targetRelevantCount: Number(selectedAttempt.targetRelevantCount || 0),
      targetRelevanceCounts: selectedAttempt.targetRelevanceCounts || null,
      top3QualityScore: Number(selectedAttempt.top3QualityScore || 0) || 0,
      selectedQuery: selectedAttempt.queryUsed,
      selectedAttemptNo,
      semanticRetryApplied,
      semanticRetryQuery: semanticRetryApplied ? semanticRetrySelectedQuery || null : null,
      semanticRetryHits,
      actualRetryAttempted: attemptedSemanticRetry,
      attempts,
      data: selectedAttempt.data,
    };
  }

  function normalizeAgentProductDetailResponse(raw) {
    if (!raw) return raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (raw.product) return raw;
      if (raw.data && typeof raw.data === 'object' && raw.data.product) {
        return { ...raw, product: raw.data.product };
      }
      const looksLikeProduct =
        (raw.id || raw.product_id || raw.productId || raw.title || raw.name) &&
        typeof raw !== 'string';
      if (looksLikeProduct) {
        return { status: 'success', success: true, product: raw };
      }
      if (raw.data && typeof raw.data === 'object') {
        const d = raw.data;
        const dLooksLikeProduct = d && (d.id || d.product_id || d.productId || d.title || d.name);
        if (dLooksLikeProduct) {
          return { ...raw, product: d };
        }
      }
    }
    return raw;
  }

  function buildResolverReferenceOnlyResult({
    queryText,
    resolved,
    resolvedQueryUsed,
    resolvedMerchantId,
    resolvedProductId,
    resolveSources,
    reason,
  } = {}) {
    const candidateTitle = Array.isArray(resolved?.candidates)
      ? String(resolved?.candidates?.[0]?.title || '').trim()
      : '';
    const resolvedTitle = String(
      candidateTitle ||
        resolved?.title ||
        resolved?.alias ||
        resolvedQueryUsed ||
        queryText,
    ).trim();
    const productRow = {
      id: resolvedProductId,
      product_id: resolvedProductId,
      merchant_id: resolvedMerchantId,
      platform_product_id: resolvedProductId,
      ...(resolvedTitle ? { title: resolvedTitle, name: resolvedTitle } : {}),
      canonical_product_ref: {
        merchant_id: resolvedMerchantId,
        product_id: resolvedProductId,
      },
    };

    const normalized = normalizeAgentProductsListResponseImpl({
      status: 'success',
      success: true,
      products: [productRow],
      total: 1,
      page: 1,
      page_size: 1,
      metadata: {
        query_source: 'agent_products_resolver_ref_fallback',
        resolve_reason: resolved?.reason || null,
        resolve_reason_code:
          resolved?.reason_code ||
          resolved?.metadata?.resolve_reason_code ||
          'detail_unavailable_ref_only',
        resolve_confidence:
          Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
        resolve_latency_ms:
          Number.isFinite(Number(resolved?.metadata?.latency_ms))
            ? Number(resolved.metadata.latency_ms)
            : null,
        resolve_query_used: resolvedQueryUsed || queryText,
        resolve_detail_source: 'reference_only',
      },
    });

    return {
      status: 200,
      usableCount: countUsableSearchProductsImpl(normalized?.products),
      resolved: true,
      resolve_reason: resolved?.reason || null,
      resolve_reason_code:
        resolved?.reason_code ||
        resolved?.metadata?.resolve_reason_code ||
        'detail_unavailable_ref_only',
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms))
          ? Number(resolved.metadata.latency_ms)
          : null,
      resolve_sources: resolveSources,
      resolve_query_used: resolvedQueryUsed || queryText,
      data: applyProxySearchFallbackMetadata(normalized, {
        applied: true,
        reason: reason || 'resolver_ref_only',
      }),
    };
  }

  function buildResolverSuccessResult({
    queryText,
    resolved,
    resolvedQueryUsed,
    resolvedMerchantId,
    resolvedProductId,
    resolveSources,
    reason,
    detail,
    detailSource = null,
  } = {}) {
    const candidateTitle = Array.isArray(resolved?.candidates)
      ? String(resolved?.candidates?.[0]?.title || '').trim()
      : '';
    const title = String(
      detail?.title ||
        detail?.name ||
        detail?.display_name ||
        candidateTitle ||
        queryText,
    ).trim();

    const productRow = {
      ...(detail && typeof detail === 'object' ? detail : {}),
      id: String(detail?.id || detail?.product_id || resolvedProductId),
      product_id: String(detail?.product_id || detail?.id || resolvedProductId),
      merchant_id: String(detail?.merchant_id || resolvedMerchantId),
      platform_product_id: String(
        detail?.platform_product_id ||
          detail?.platformProductId ||
          detail?.product_id ||
          resolvedProductId,
      ),
      ...(title ? { title } : {}),
      ...(title && !detail?.name ? { name: title } : {}),
      canonical_product_ref: {
        merchant_id: resolvedMerchantId,
        product_id: resolvedProductId,
      },
    };

    const normalized = normalizeAgentProductsListResponseImpl({
      status: 'success',
      success: true,
      products: [productRow],
      total: 1,
      page: 1,
      page_size: 1,
      metadata: {
        query_source: 'agent_products_resolver_fallback',
        resolve_reason: resolved?.reason || null,
        resolve_reason_code:
          resolved?.reason_code ||
          resolved?.metadata?.resolve_reason_code ||
          null,
        resolve_confidence:
          Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
        resolve_latency_ms:
          Number.isFinite(Number(resolved?.metadata?.latency_ms))
            ? Number(resolved.metadata.latency_ms)
            : null,
        resolve_query_used: resolvedQueryUsed || queryText,
        ...(detailSource ? { resolve_detail_source: detailSource } : {}),
      },
    });

    return {
      status: 200,
      usableCount: countUsableSearchProductsImpl(normalized?.products),
      resolved: true,
      resolve_reason: resolved?.reason || null,
      resolve_reason_code:
        resolved?.reason_code ||
        resolved?.metadata?.resolve_reason_code ||
        null,
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms))
          ? Number(resolved.metadata.latency_ms)
          : null,
      resolve_sources: resolveSources,
      resolve_query_used: resolvedQueryUsed || queryText,
      data: applyProxySearchFallbackMetadata(normalized, {
        applied: true,
        reason: reason || 'resolver_fallback',
      }),
    };
  }

  async function queryResolveSearchFallback({
    queryParams,
    checkoutToken,
    reason,
    requestSource,
    fetchDetail = true,
    timeoutMs,
  }) {
    const query = queryParams && typeof queryParams === 'object' ? queryParams : {};
    const queryText = extractSearchQueryTextImpl(query);
    if (!queryText) return null;

    const lang = String(firstQueryParamValueImpl(query.lang) || 'en').trim().toLowerCase() || 'en';
    const merchantId = String(firstQueryParamValueImpl(query.merchant_id || query.merchantId) || '').trim();
    const merchantIds = parseQueryStringArrayImpl(query.merchant_ids || query.merchantIds);
    const preferMerchants = uniqueStringsImpl([merchantId, ...merchantIds]);
    const searchAllMerchants = parseQueryBooleanImpl(
      query.search_all_merchants || query.searchAllMerchants,
    );
    const defaultResolverTimeoutMs = getResolverTimeoutMs();
    const effectiveResolverTimeoutMs = Math.max(
      200,
      Number(timeoutMs || defaultResolverTimeoutMs) || defaultResolverTimeoutMs,
    );
    const resolveOptions = {
      ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
      ...(searchAllMerchants !== undefined ? { search_all_merchants: searchAllMerchants } : {}),
      timeout_ms: effectiveResolverTimeoutMs,
      upstream_retries: 0,
      stable_alias_short_circuit: true,
    };
    const resolverCacheKey = buildProxySearchResolverCacheKeyImpl({
      queryText,
      lang,
      preferMerchants,
      searchAllMerchants,
      fetchDetail,
      resolverTimeoutMs: effectiveResolverTimeoutMs,
    });
    const cached = getProxySearchResolverCacheEntryImpl(resolverCacheKey);
    if (cached) return cached;

    const toResolveSources = (input) =>
      Array.isArray(input?.metadata?.sources)
        ? input.metadata.sources
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
              source: String(item.source || '').trim() || null,
              ok: item.ok === true,
              count: Number.isFinite(Number(item.count)) ? Number(item.count) : null,
              reason: String(item.reason || '').trim() || null,
              error_code: String(item.error_code || '').trim() || null,
            }))
        : [];

    const resolverQueryCandidates = buildResolverQueryCandidatesImpl(queryText);
    let resolved = null;
    let resolvedQueryUsed = queryText;
    for (const candidateQuery of resolverQueryCandidates) {
      const candidateText = String(candidateQuery || '').trim();
      if (!candidateText) continue;

      let stableAliasMatch = null;
      if (resolveStableAliasByQueryImpl) {
        try {
          const normalizedCandidate = normalizeResolverTextImpl(candidateText);
          const candidateTokens = tokenizeResolverQueryImpl(normalizedCandidate);
          if (normalizedCandidate && candidateTokens.length > 0) {
            stableAliasMatch = resolveStableAliasByQueryImpl({
              query: candidateText,
              normalizedQuery: normalizedCandidate,
              queryTokens: candidateTokens,
            });
          }
        } catch {
          stableAliasMatch = null;
        }
      }

      if (
        stableAliasMatch &&
        stableAliasMatch.product_ref &&
        String(stableAliasMatch.product_ref.product_id || '').trim() &&
        String(stableAliasMatch.product_ref.merchant_id || '').trim()
      ) {
        resolved = {
          resolved: true,
          reason: 'stable_alias_match',
          reason_code: 'stable_alias_match',
          confidence: Number.isFinite(Number(stableAliasMatch.score))
            ? Number(stableAliasMatch.score)
            : 1,
          product_ref: {
            product_id: String(stableAliasMatch.product_ref.product_id || '').trim(),
            merchant_id: String(stableAliasMatch.product_ref.merchant_id || '').trim(),
          },
          candidates: [
            {
              title:
                String(stableAliasMatch.title || stableAliasMatch.alias || candidateText || '').trim() ||
                null,
              product_ref: {
                product_id: String(stableAliasMatch.product_ref.product_id || '').trim(),
                merchant_id: String(stableAliasMatch.product_ref.merchant_id || '').trim(),
              },
              score: Number.isFinite(Number(stableAliasMatch.score))
                ? Number(stableAliasMatch.score)
                : 1,
            },
          ],
          metadata: {
            latency_ms: 0,
            sources: [
              {
                source: 'stable_alias_ref',
                ok: true,
                reason: stableAliasMatch.reason || 'stable_alias_match',
                count: 1,
              },
            ],
            stable_alias_short_circuit: true,
          },
        };
        resolvedQueryUsed = candidateText;
        break;
      }

      try {
        const candidateResolved = await resolveProductRefImpl({
          query: candidateText,
          lang,
          hints: null,
          options: resolveOptions,
          pivotaApiBase: getProxySearchApiBaseImpl(requestSource),
          pivotaApiKey: pivotaApiKeyImpl(),
          checkoutToken,
        });
        if (!resolved) {
          resolved = candidateResolved;
          resolvedQueryUsed = candidateText;
        }
        if (
          candidateResolved &&
          candidateResolved.resolved &&
          candidateResolved.product_ref &&
          String(candidateResolved.product_ref.product_id || '').trim() &&
          String(candidateResolved.product_ref.merchant_id || '').trim()
        ) {
          resolved = candidateResolved;
          resolvedQueryUsed = candidateText;
          break;
        }
      } catch (err) {
        loggerImpl.warn(
          { err: err?.message || String(err), query: candidateText },
          'proxy agent search resolver fallback failed',
        );
      }
    }

    const resolvedRef = resolved && resolved.resolved ? resolved.product_ref : null;
    const resolvedProductId = String(resolvedRef?.product_id || '').trim();
    const resolvedMerchantId = String(resolvedRef?.merchant_id || '').trim();
    const resolveSources = toResolveSources(resolved);
    if (!resolvedProductId || !resolvedMerchantId) {
      const missResult = {
        status: 200,
        usableCount: 0,
        data: null,
        resolved: false,
        resolve_reason: resolved?.reason || null,
        resolve_reason_code:
          resolved?.reason_code || resolved?.metadata?.resolve_reason_code || null,
        resolve_confidence:
          Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
        resolve_latency_ms:
          Number.isFinite(Number(resolved?.metadata?.latency_ms))
            ? Number(resolved.metadata.latency_ms)
            : null,
        resolve_sources: resolveSources,
        resolve_query_used: resolvedQueryUsed || queryText,
      };
      setProxySearchResolverCacheEntryImpl(
        resolverCacheKey,
        missResult,
        getResolverMissCacheTtlMs(),
      );
      return missResult;
    }

    let detail = null;
    let detailSource = null;
    if (fetchDetail && getResolverDetailEnabled()) {
      try {
        const detailFromCache = await fetchProductDetailFromProductsCacheImpl({
          merchantId: resolvedMerchantId,
          productId: resolvedProductId,
          includeExpired: true,
          staleMaxAgeHours: getProductDetailStaleMaxAgeHours(),
        });
        if (detailFromCache?.product) {
          detail = detailFromCache.product;
          detailSource = detailFromCache?.stale_fallback_used
            ? 'products_cache_stale'
            : 'products_cache';
        }
        if (!detail) {
          detail = await fetchProductDetailFromUpstreamImpl({
            merchantId: resolvedMerchantId,
            productId: resolvedProductId,
            checkoutToken,
            timeoutMs: getResolverDetailTimeoutMs(),
            noRetry: true,
          });
          if (detail) detailSource = 'upstream';
        }
      } catch (err) {
        loggerImpl.warn(
          {
            err: err?.message || String(err),
            merchant_id: resolvedMerchantId,
            product_id: resolvedProductId,
          },
          'proxy agent search resolver fallback detail fetch failed',
        );
      }
    }

    if (fetchDetail && getResolverDetailEnabled() && !detail) {
      if (isLookupStyleSearchQueryImpl(queryText, extractSearchAnchorTokensImpl(queryText))) {
        const refOnlyResult = buildResolverReferenceOnlyResult({
          queryText,
          resolved,
          resolvedQueryUsed,
          resolvedMerchantId,
          resolvedProductId,
          resolveSources,
          reason,
        });
        setProxySearchResolverCacheEntryImpl(
          resolverCacheKey,
          refOnlyResult,
          getResolverMissCacheTtlMs(),
        );
        loggerImpl.info(
          {
            query: queryText,
            query_used: resolvedQueryUsed || queryText,
            merchant_id: resolvedMerchantId,
            product_id: resolvedProductId,
          },
          'proxy agent search resolver fallback returned reference-only candidate (detail unavailable)',
        );
        return refOnlyResult;
      }

      const missResult = {
        status: 200,
        usableCount: 0,
        data: null,
        resolved: false,
        resolve_reason: resolved?.reason || null,
        resolve_reason_code: 'detail_unavailable',
        resolve_confidence:
          Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
        resolve_latency_ms:
          Number.isFinite(Number(resolved?.metadata?.latency_ms))
            ? Number(resolved.metadata.latency_ms)
            : null,
        resolve_sources: resolveSources,
        resolve_query_used: resolvedQueryUsed || queryText,
      };
      setProxySearchResolverCacheEntryImpl(
        resolverCacheKey,
        missResult,
        getResolverMissCacheTtlMs(),
      );
      loggerImpl.info(
        {
          query: queryText,
          query_used: resolvedQueryUsed || queryText,
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        'proxy agent search resolver fallback skipped unresolved detail candidate',
      );
      return missResult;
    }

    const successResult = buildResolverSuccessResult({
      queryText,
      resolved,
      resolvedQueryUsed,
      resolvedMerchantId,
      resolvedProductId,
      resolveSources,
      reason,
      detail,
      detailSource,
    });
    setProxySearchResolverCacheEntryImpl(
      resolverCacheKey,
      successResult,
      getResolverCacheTtlMs(),
    );
    return successResult;
  }

  async function handleCommerceResolution(input = {}) {
    const normalized = createExecutionFacingInput(input);
    return createExecutionFacingOutput({
      context: normalized.context,
      status: 'not_resolved',
      resolution_authority: 'execution_facing',
      fallback_applied: false,
      fallback_reason_codes: [],
      blockers: ['milestone0_execution_facade_not_yet_bound'],
    });
  }

  return {
    handleCommerceResolution,
    shouldAttemptCacheMissResolverFallback,
    buildCacheMissResolverFallbackRequest,
    isResolverMiss,
    getCanonicalSearchFallbackReason,
    shouldFallbackProxySearch,
    evaluateCacheQualityGate,
    computePrimaryQualityScore,
    getFallbackAdoptUsableThreshold,
    buildFallbackOverlapPreview,
    isProxySearchFallbackRelevant,
    shouldReducePrimaryTimeoutAfterResolverMiss,
    getSecondaryFallbackSkipReason,
    shouldSkipSecondaryFallbackAfterResolverMiss,
    shouldAllowResolverFallback,
    shouldAllowSecondaryFallback,
    shouldAllowInvokeFallback,
    shouldBypassSecondaryFallbackSkipOnPrimaryException,
    isStrongResolverFirstQuery,
    shouldUseResolverFirstSearch,
    getResolverFallbackAdoptionDecision,
    extractResolverFallbackClarification,
    shapeAdoptedResolverFallbackResponse,
    buildCacheMissResolverFallbackDiagnosticsState,
    buildCacheMissResolverFallbackDiagnosedResponse,
    buildProxySearchResolverFallbackResponse,
    buildDirectResolverFallbackResponse,
    normalizePrimaryClarifyContract,
    buildInvokeResolverFallbackResponse,
    applyProxySearchFallbackMetadata,
    buildProxySearchFallbackMetadataResponse,
    extractResolverFallbackData,
    buildProxySearchSoftFallbackResponse,
    buildStrictEmptyFallbackResponse,
    invokeFindProductsMultiFallbackOnce,
    buildSecondaryFallbackMeta,
    getPrimarySearchQualityDecision,
    getSecondaryFallbackOutcomeDecision,
    getPrimaryFallbackOutcomeDecision,
    queryFindProductsMultiFallback,
    normalizeAgentProductDetailResponse,
    buildResolverReferenceOnlyResult,
    buildResolverSuccessResult,
    queryResolveSearchFallback,
  };
}

const defaultCommerceResolutionRuntime = createCommerceResolutionRuntime();

module.exports = {
  createCommerceResolutionRuntime,
  handleCommerceResolution: defaultCommerceResolutionRuntime.handleCommerceResolution,
};
