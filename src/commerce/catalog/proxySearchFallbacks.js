function buildAuroraPrimaryIrrelevantSemanticRetryQueries(baseQueryText, {
  normalizeSearchTextForMatch,
  maxQueries = 1,
} = {}) {
  const normalize = typeof normalizeSearchTextForMatch === 'function'
    ? normalizeSearchTextForMatch
    : (value) => String(value || '').trim().toLowerCase();
  const base = String(baseQueryText || '').trim();
  if (!base) return [];
  const normalized = normalize(base);
  const peptideNormalizedBase = base
    .replace(/\b(tri|tetra|hexa)peptides?\b/gi, 'peptide')
    .replace(/\bpeptides\b/gi, 'peptide')
    .replace(/\bcopper peptide peptide\b/gi, 'copper peptide')
    .replace(/\bpeptide peptide\b/gi, 'peptide')
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = [];
  const seen = new Set([normalize(base)]);
  const push = (queryValue) => {
    const value = String(queryValue || '').trim();
    const key = normalize(value);
    if (!value || !key || seen.has(key)) return;
    seen.add(key);
    candidates.push(value);
  };

  if (/\bcopper\b/.test(normalized) && /\b(peptide|tripeptide|tetrapeptide|hexapeptide)/.test(normalized)) {
    push(peptideNormalizedBase);
    push(`${peptideNormalizedBase} multi peptide`);
    push(`${base} multi peptide`);
    push(`${base} copper tripeptide`);
  }
  if (/\b(peptide|tripeptide|tetrapeptide|hexapeptide)/.test(normalized) && /\b(serum|essence)\b/.test(normalized)) {
    push(`${peptideNormalizedBase} multi-peptide collection`);
    push(`${base} multi-peptide collection`);
  }
  if (/\bniacinamide\b/.test(normalized) && /\b(serum|essence)\b/.test(normalized)) {
    push(`${base} vitamin b3`);
  }

  return candidates.slice(0, Math.max(1, Number(maxQueries || 1) || 1));
}

const {
  buildSearchProductKey: buildSearchProductKeyBase,
} = require('./searchDedupe');

function createProxySearchFallbackHelpers({
  axiosClient,
  config = {},
  helpers = {},
} = {}) {
  const axios = axiosClient;
  const {
    PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
    PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
    PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE,
    PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED,
    PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
    SEARCH_FRAGRANCE_SEMANTIC_RETRY,
    proxySearchExternalSeedSupplementBudgetMs = Math.max(
      800,
      Number(process.env.PROXY_SEARCH_EXTERNAL_SEED_SUPPLEMENT_BUDGET_MS || 4400),
    ),
  } = config;
  const {
    extractSearchQueryText,
    detectBrandEntities,
    hasExplicitCategoryHint,
    normalizeSearchTextForMatch,
    buildBrandQueryVariants,
    hasFragranceQuerySignal,
    getProxySearchApiBase,
    buildInvokeUpstreamAuthHeaders,
    extractSearchAnchorTokens,
    tokenizeSearchTextForMatch,
    parseQueryBoolean,
    normalizeExternalSeedStrategy,
    getUpstreamTimeoutMs,
    normalizeAgentProductsListResponse,
    isExternalSeedProduct,
    buildSearchProductKey = buildSearchProductKeyBase,
    isSupplementCandidateRelevant,
    buildFindProductsMultiPayloadFromQuery,
    isAuroraSource,
    buildFragranceSemanticRetryQuery,
    parseQueryNumber,
    countUsableSearchProducts,
    isProxySearchFallbackRelevant,
    withProxySearchFallbackMetadata,
  } = helpers;

  async function fetchExternalSeedSupplementFromBackend({
    queryParams,
    checkoutToken,
    neededCount,
    source,
    externalSeedStrategy = 'supplement_internal_first',
  }) {
    const query = queryParams && typeof queryParams === 'object' ? queryParams : {};
    const queryText = extractSearchQueryText(query);
    if (!queryText) {
      return {
        products: [],
        metadata: {
          attempted: false,
          applied: false,
          reason: 'empty_query',
          requested_count: Number(neededCount || 0),
        },
      };
    }

    const requestedCount = Math.max(1, Number(neededCount || 1));
    const limit = Math.min(Math.max(requestedCount * 6, 48), 320);
    const hardBudgetMs = proxySearchExternalSeedSupplementBudgetMs;
    const startedAtMs = Date.now();
    const brandDetection = detectBrandEntities(queryText, { candidateProducts: [] });
    const hasExplicitCategory = hasExplicitCategoryHint(queryText, null);
    const brandTerms = Array.isArray(brandDetection?.brands)
      ? brandDetection.brands.map((item) => normalizeSearchTextForMatch(item)).filter(Boolean)
      : [];
    const baseVariants = buildBrandQueryVariants(queryText, brandTerms);
    const fragranceVariants =
      hasFragranceQuerySignal(queryText) || hasExplicitCategory
        ? ['perfume', 'fragrance', 'parfum', 'cologne', 'body mist', 'eau de parfum']
        : [];
    const queryVariants = Array.from(
      new Set(
        [queryText, ...baseVariants, ...fragranceVariants]
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      ),
    ).slice(0, 4);
    const url = `${getProxySearchApiBase(source)}/agent/v1/products/search`;
    const requestHeaders = {
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    };
    const seenKeys = new Set();
    const mergedProducts = [];
    let upstreamStatus = 0;
    let upstreamCalls = 0;
    let rawFetchedCount = 0;
    let budgetExhausted = false;
    const normalizedQuery = normalizeSearchTextForMatch(queryText);
    const anchorTokens = extractSearchAnchorTokens(queryText);
    const queryTokens = Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));

    for (const variant of queryVariants) {
      const elapsedMs = Date.now() - startedAtMs;
      const remainingBudgetMs = hardBudgetMs - elapsedMs;
      if (remainingBudgetMs <= 0) {
        budgetExhausted = true;
        break;
      }
      const upstreamParams = {
        merchant_id: 'external_seed',
        external_seed_only: true,
        query: variant,
        ...(query.category ? { category: query.category } : {}),
        ...(query.min_price != null ? { min_price: query.min_price } : {}),
        ...(query.max_price != null ? { max_price: query.max_price } : {}),
        in_stock_only: parseQueryBoolean(query.in_stock_only ?? query.inStockOnly) !== false,
        limit,
        offset: 0,
        allow_external_seed: true,
        allow_stale_cache: false,
        external_seed_strategy: normalizeExternalSeedStrategy(
          externalSeedStrategy,
          'supplement_internal_first',
        ),
        fast_mode: true,
      };
      const resp = await axios({
        method: 'GET',
        url,
        params: upstreamParams,
        headers: requestHeaders,
        timeout: Math.max(
          500,
          Math.min(remainingBudgetMs, 2500, getUpstreamTimeoutMs('find_products_multi')),
        ),
        validateStatus: () => true,
      });
      upstreamCalls += 1;
      upstreamStatus = Math.max(upstreamStatus, Number(resp.status || 0) || 0);
      if (!(resp.status >= 200 && resp.status < 300)) continue;

      const normalized = normalizeAgentProductsListResponse(resp.data, {
        limit,
        offset: 0,
      });
      const products = Array.isArray(normalized?.products)
        ? normalized.products.filter((product) => isExternalSeedProduct(product))
        : [];
      rawFetchedCount += products.length;
      for (const product of products) {
        const key = buildSearchProductKey(product);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        mergedProducts.push(product);
      }
      const relevantMergedCount = mergedProducts.reduce(
        (count, product) =>
          count +
          (isSupplementCandidateRelevant(product, queryText, {
            normalizedQuery,
            anchorTokens,
            queryTokens,
            brandTerms,
          })
            ? 1
            : 0),
        0,
      );
      if (relevantMergedCount > 0) {
        break;
      }
    }

    const relevantProducts = mergedProducts.filter((product) =>
      isSupplementCandidateRelevant(product, queryText, {
        normalizedQuery,
        anchorTokens,
        queryTokens,
        brandTerms,
      }),
    );
    const filteredOutIrrelevantCount = Math.max(0, mergedProducts.length - relevantProducts.length);

    return {
      products: relevantProducts,
      metadata: {
        attempted: true,
        applied: relevantProducts.length > 0,
        reason:
          relevantProducts.length > 0
            ? 'external_seed_candidates_found'
            : filteredOutIrrelevantCount > 0
              ? 'external_seed_candidates_filtered_irrelevant'
              : 'no_external_seed_candidates',
        requested_count: requestedCount,
        fetched_count: relevantProducts.length,
        fetched_raw_count: rawFetchedCount,
        fetched_variant_count: queryVariants.length,
        upstream_calls: upstreamCalls,
        brand_query_detected: Boolean(brandDetection?.brand_like),
        brand_entities: brandTerms,
        brand_scope: hasExplicitCategory ? 'category_scoped' : 'broad',
        filtered_out_irrelevant_count: filteredOutIrrelevantCount,
        query_variants: queryVariants,
        upstream_status: upstreamStatus,
        supplement_budget_ms: hardBudgetMs,
        supplement_budget_exhausted: budgetExhausted,
      },
    };
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
    timeoutMs = PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
  }) {
    const normalizedRequestSource = String(requestSource || '').trim().toLowerCase();
    const requestSourceValue = preserveAuroraSource
      ? normalizedRequestSource
      : fallbackSource || 'agent_search_proxy_fallback';
    const requestHeaders = {
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    };
    const searchPayload =
      payload?.search && typeof payload.search === 'object' ? payload.search : {};
    const requestTimeoutMs = Math.max(
      250,
      Number(timeoutMs || PROXY_SEARCH_FALLBACK_TIMEOUT_MS) || PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
    );

    const resp = useSearchEndpoint
      ? await axios({
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
      : await axios({
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

    const normalized = normalizeAgentProductsListResponse(resp.data, {
      limit: parseQueryNumber(payload?.search?.limit ?? payload?.search?.page_size),
      offset: parseQueryNumber(payload?.search?.offset),
    });
    const usableCount = countUsableSearchProducts(normalized?.products);
    const relevanceMatched = relevanceQuery
      ? isProxySearchFallbackRelevant(normalized, relevanceQuery)
      : usableCount > 0;

    return {
      status: Number(resp.status || 0) || 0,
      usableCount,
      relevanceMatched,
      queryUsed: String(payload?.search?.query || ''),
      productsPreview: [],
      data: withProxySearchFallbackMetadata(normalized, {
        applied: true,
        reason: triggerReason || 'unknown',
        query_variant:
          normalizeSearchTextForMatch(String(payload?.search?.query || '')) ===
          normalizeSearchTextForMatch(String(relevanceQuery || ''))
            ? 'primary'
            : 'semantic_retry',
      }),
    };
  }

  async function queryFindProductsMultiFallback({
    queryParams,
    checkoutToken,
    reason,
    requestSource,
    timeoutMs = null,
  }) {
    const payload = buildFindProductsMultiPayloadFromQuery(queryParams);
    if (!payload) return null;
    const fallbackSource = String(payload?.metadata?.source || '').trim();
    const normalizedRequestSource = String(requestSource || '').trim().toLowerCase();
    const searchApiBase = getProxySearchApiBase(normalizedRequestSource);
    const url = `${searchApiBase}/agent/shop/v1/invoke`;
    const searchUrl = `${searchApiBase}/agent/v1/products/search`;
    const preserveAuroraSource =
      PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE &&
      isAuroraSource(normalizedRequestSource);
    const baseQueryText = String(payload?.search?.query || '').trim();
    const isAuroraMonocultureRetry =
      isAuroraSource(normalizedRequestSource) &&
      String(reason || '').trim() === 'primary_monoculture';

    if (
      isAuroraSource(normalizedRequestSource) &&
      payload?.search &&
      typeof payload.search === 'object' &&
      String(payload.search.external_seed_strategy || '').trim().toLowerCase() === 'legacy'
    ) {
      payload.search.external_seed_strategy = PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY;
    }
    const isAuroraSemanticRetry =
      PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED &&
      isAuroraSource(normalizedRequestSource) &&
      (String(reason || '').trim() === 'primary_irrelevant' || isAuroraMonocultureRetry);
    const isFragranceSemanticRetry =
      SEARCH_FRAGRANCE_SEMANTIC_RETRY &&
      hasFragranceQuerySignal(baseQueryText);
    const semanticRetryEnabled = isAuroraSemanticRetry || isFragranceSemanticRetry;
    const normalizedBaseQuery = normalizeSearchTextForMatch(baseQueryText);
    const fragranceSemanticRetryQuery = isFragranceSemanticRetry
      ? buildFragranceSemanticRetryQuery(baseQueryText)
      : '';
    const fragranceSemanticRetryFallbackQuery = isFragranceSemanticRetry
      ? 'fragrance perfume parfum cologne eau de parfum eau de toilette body mist'
      : '';
    const auroraSemanticRetryQuery = isAuroraSemanticRetry
      ? buildAuroraPrimaryIrrelevantSemanticRetryQueries(baseQueryText, {
          normalizeSearchTextForMatch,
          maxQueries: PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
        })[0] || ''
      : '';
    const semanticRetryQueries = [];
    if (
      fragranceSemanticRetryQuery &&
      normalizeSearchTextForMatch(fragranceSemanticRetryQuery) !== normalizedBaseQuery
    ) {
      semanticRetryQueries.push(fragranceSemanticRetryQuery);
    } else if (
      fragranceSemanticRetryFallbackQuery &&
      normalizeSearchTextForMatch(fragranceSemanticRetryFallbackQuery) !== normalizedBaseQuery
    ) {
      semanticRetryQueries.push(fragranceSemanticRetryFallbackQuery);
    } else if (
      auroraSemanticRetryQuery &&
      normalizeSearchTextForMatch(auroraSemanticRetryQuery) !== normalizedBaseQuery
    ) {
      semanticRetryQueries.push(auroraSemanticRetryQuery);
    }
    const candidateQueries = Array.from(
      new Set([baseQueryText, ...semanticRetryQueries].filter(Boolean)),
    ).slice(0, 2);
    const configuredFallbackTimeoutMs = isAuroraSource(normalizedRequestSource)
      ? Math.min(PROXY_SEARCH_FALLBACK_TIMEOUT_MS, PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS)
      : PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
    const requestedBudgetMs =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : null;
    const totalFallbackBudgetMs =
      requestedBudgetMs == null ? configuredFallbackTimeoutMs : Math.max(100, requestedBudgetMs);
    const fallbackDeadlineMs = Date.now() + totalFallbackBudgetMs;

    let selectedAttempt = null;
    let selectedAttemptNo = 0;
    const attempts = [];
    const rankFallbackAttempt = (attempt) => {
      const statusOk = attempt && attempt.status >= 200 && attempt.status < 300;
      const usableCount = Math.max(0, Number(attempt?.usableCount || 0) || 0);
      const relevanceMatched = attempt?.relevanceMatched === true;
      return {
        statusOk,
        usableCount,
        relevanceMatched,
        total: (statusOk ? 100 : 0) + (usableCount * 12) + (relevanceMatched ? 8 : 0),
      };
    };
    for (let i = 0; i < candidateQueries.length; i += 1) {
      const remainingBudgetMs = Math.max(0, fallbackDeadlineMs - Date.now());
      if (remainingBudgetMs < 100) {
        break;
      }
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

      attempts.push({
        attempt: i + 1,
        query: attempt.queryUsed,
        status: attempt.status,
        usable_count: attempt.usableCount,
        relevance_matched: attempt.relevanceMatched,
        products_preview: attempt.productsPreview,
      });

      if (!selectedAttempt) {
        selectedAttempt = attempt;
        selectedAttemptNo = i + 1;
      } else {
        const selectedRank = rankFallbackAttempt(selectedAttempt);
        const candidateRank = rankFallbackAttempt(attempt);
        const shouldReplaceByRecall =
          candidateRank.statusOk &&
          candidateRank.usableCount >= Math.max(1, selectedRank.usableCount + 2);
        if (shouldReplaceByRecall || candidateRank.total > selectedRank.total) {
          selectedAttempt = attempt;
          selectedAttemptNo = i + 1;
        }
      }

      if (attempt.relevanceMatched && attempt.usableCount > 0) {
        const shouldForceNextSemanticAttempt =
          i === 0 &&
          candidateQueries.length > 1 &&
          (isAuroraMonocultureRetry || isFragranceSemanticRetry);
        if (!shouldForceNextSemanticAttempt) break;
      }
    }

    if (!selectedAttempt) return null;
    const attemptedSemanticRetry = attempts.some((attempt, index) => {
      if (!attempt || index === 0) return false;
      return (
        normalizeSearchTextForMatch(String(attempt.query || '')) !==
        normalizeSearchTextForMatch(String(baseQueryText || ''))
      );
    });
    const selectedAttemptIsSemanticRetry =
      normalizeSearchTextForMatch(String(selectedAttempt.queryUsed || '')) !==
      normalizeSearchTextForMatch(String(baseQueryText || ''));
    const semanticRetryApplied = attemptedSemanticRetry || selectedAttemptIsSemanticRetry;
    const semanticRetrySelectedQuery =
      semanticRetryApplied && selectedAttemptIsSemanticRetry
        ? String(selectedAttempt.queryUsed || '').trim()
        : semanticRetryApplied
          ? String(
              attempts.find(
                (attempt) =>
                  normalizeSearchTextForMatch(String(attempt?.query || '')) !==
                  normalizeSearchTextForMatch(String(baseQueryText || '')),
              )?.query || '',
            ).trim()
          : '';
    const semanticRetryHits = semanticRetryApplied
      ? Math.max(
          0,
          ...attempts
            .filter(
              (attempt) =>
                normalizeSearchTextForMatch(String(attempt?.query || '')) !==
                normalizeSearchTextForMatch(String(baseQueryText || '')),
            )
            .map((attempt) => Math.max(0, Number(attempt?.usable_count || 0) || 0)),
        )
      : 0;
    return {
      status: selectedAttempt.status,
      usableCount: selectedAttempt.usableCount,
      relevanceMatched: selectedAttempt.relevanceMatched,
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

  return {
    fetchExternalSeedSupplementFromBackend,
    queryFindProductsMultiFallback,
  };
}

module.exports = {
  buildAuroraPrimaryIrrelevantSemanticRetryQueries,
  createProxySearchFallbackHelpers,
};
