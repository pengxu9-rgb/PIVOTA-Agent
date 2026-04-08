function createFindProductsExternalSeedSupplementRuntime(deps = {}) {
  const {
    extractSearchQueryText,
    extractGuidanceRetrievalContext,
    detectBrandEntities,
    hasExplicitCategoryHint,
    normalizeSearchTextForMatch,
    buildBrandQueryVariants,
    buildGuidanceRecallSupplementQueries,
    hasFragranceFreeSkincareSignal,
    hasFragranceSearchSignal,
    firstQueryParamValue,
    normalizeRecoTargetStep,
    parseQueryBoolean,
    normalizeExternalSeedStrategy,
    isShoppingSource,
    searchExternalSeedOnlyProductsDirect,
    isExternalSeedProduct,
    logger,
    PIVOTA_API_BASE,
    getProxySearchApiBase,
    PIVOTA_API_KEY,
    GUIDANCE_ONLY_UI_SURFACE,
    GUIDANCE_ONLY_DECISION_MODE,
    GUIDANCE_RETRIEVAL_MODE,
    GUIDANCE_SOURCE_POLICY,
    PROXY_SEARCH_AURORA_GUIDANCE_EXTERNAL_SEED_LIMIT,
    PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
    SEARCH_LIMIT_MAX,
    axios,
    getUpstreamTimeoutMs,
    normalizeAgentProductsListResponse,
    buildSearchProductKey,
    extractSearchAnchorTokens,
    tokenizeSearchTextForMatch,
    isSupplementCandidateRelevant,
  } = deps;

  async function fetchExternalSeedSupplementFromBackend({
    queryParams,
    checkoutToken,
    neededCount,
    source,
    directOnly = false,
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

    const guidanceContext = extractGuidanceRetrievalContext(query, { queryText });
    const requestedCount = Math.max(1, Number(neededCount || 1));
    const limit = guidanceContext.is_guidance_recall_first
      ? Math.min(
          Math.max(requestedCount * 10, PROXY_SEARCH_AURORA_GUIDANCE_EXTERNAL_SEED_LIMIT),
          PROXY_SEARCH_AURORA_GUIDANCE_EXTERNAL_SEED_LIMIT,
        )
      : Math.min(Math.max(requestedCount * 6, 48), 320);
    const brandDetection = detectBrandEntities(queryText, { candidateProducts: [] });
    const hasExplicitCategory = hasExplicitCategoryHint(queryText, null);
    const brandTerms = Array.isArray(brandDetection?.brands)
      ? brandDetection.brands.map((item) => normalizeSearchTextForMatch(item)).filter(Boolean)
      : [];
    const baseVariants = buildBrandQueryVariants(queryText, brandTerms);
    const guidanceVariants = buildGuidanceRecallSupplementQueries(queryText, guidanceContext);
    const fragranceVariants =
      !hasFragranceFreeSkincareSignal(queryText) && hasFragranceSearchSignal(queryText)
        ? ['perfume', 'fragrance', 'parfum', 'cologne', 'body mist', 'eau de parfum']
        : [];
    const queryVariants = Array.from(
      new Set(
        [queryText, ...guidanceVariants, ...baseVariants, ...fragranceVariants]
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      ),
    ).slice(0, 8);
    const normalizedSource = String(source || '').trim().toLowerCase();
    const explicitTargetStepFamily = normalizeRecoTargetStep(
      firstQueryParamValue(query.target_step_family || query.targetStepFamily) || '',
    );
    const explicitSemanticFamily = String(
      firstQueryParamValue(query.semantic_family || query.semanticFamily) || '',
    )
      .trim()
      .toLowerCase();
    const explicitQueryStepStrength = String(
      firstQueryParamValue(query.query_step_strength || query.queryStepStrength) || '',
    ).trim();
    const explicitProductOnly = parseQueryBoolean(query.product_only ?? query.productOnly);
    const requestedExternalSeedStrategy = normalizeExternalSeedStrategy(
      firstQueryParamValue(query.external_seed_strategy ?? query.externalSeedStrategy),
      guidanceContext.is_guidance_only
        ? 'unified_relevance'
        : normalizedSource === 'aurora-bff' || normalizedSource === 'aurora-chatbox'
          ? PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY
          : 'unified_relevance',
    );
    const externalSeedStrategy =
      guidanceContext.is_guidance_only || isShoppingSource(source)
        ? 'unified_relevance'
        : requestedExternalSeedStrategy;

    if (process.env.NODE_ENV !== 'test' && process.env.DATABASE_URL) {
      try {
        const directResponse = await searchExternalSeedOnlyProductsDirect({
          search: {
            ...query,
            query: queryText,
            limit: Math.min(requestedCount, SEARCH_LIMIT_MAX),
            offset: 0,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: externalSeedStrategy,
            retrieval_query_variants: queryVariants,
            ...(explicitTargetStepFamily ? { target_step_family: explicitTargetStepFamily } : {}),
            ...(explicitSemanticFamily ? { semantic_family: explicitSemanticFamily } : {}),
            ...(explicitQueryStepStrength ? { query_step_strength: explicitQueryStepStrength } : {}),
            ...(explicitProductOnly !== null ? { product_only: explicitProductOnly } : {}),
          },
          metadata: {
            source,
            ...(guidanceContext.is_guidance_only
              ? {
                  ui_surface: guidanceContext.ui_surface || GUIDANCE_ONLY_UI_SURFACE,
                  decision_mode: guidanceContext.decision_mode || GUIDANCE_ONLY_DECISION_MODE,
                }
              : {}),
            ...(explicitTargetStepFamily ? { query_target_step_family: explicitTargetStepFamily } : {}),
            ...(explicitQueryStepStrength ? { query_step_strength: explicitQueryStepStrength } : {}),
          },
          guidanceFastpath: guidanceContext.is_guidance_recall_first,
        });
        if (directResponse && typeof directResponse === 'object') {
          const directProducts = Array.isArray(directResponse.products)
            ? directResponse.products.filter((product) => isExternalSeedProduct(product))
            : [];
          const directMeta =
            directResponse.metadata &&
            typeof directResponse.metadata === 'object' &&
            !Array.isArray(directResponse.metadata)
              ? directResponse.metadata
              : {};
          if (directProducts.length > 0) {
            return {
              products: directProducts,
              metadata: {
                attempted: true,
                applied: true,
                reason: 'external_seed_direct_local_hit',
                requested_count: requestedCount,
                fetched_count: directProducts.length,
                fetched_raw_count:
                  Number(directMeta.external_seed_rows_fetched || directProducts.length) ||
                  directProducts.length,
                fetched_variant_count: queryVariants.length,
                upstream_calls: 0,
                brand_query_detected: Boolean(brandDetection?.brand_like),
                brand_entities: brandTerms,
                brand_scope: hasExplicitCategory ? 'category_scoped' : 'broad',
                filtered_out_irrelevant_count: Math.max(
                  0,
                  (Number(directMeta.external_seed_rows_fetched || directProducts.length) ||
                    directProducts.length) - directProducts.length,
                ),
                query_variants: queryVariants,
                upstream_status: 200,
                retrieval_mode: guidanceContext.is_guidance_recall_first
                  ? GUIDANCE_RETRIEVAL_MODE
                  : 'direct_local',
                negative_constraints_applied: guidanceContext.negative_constraints,
                external_seed_rows_raw:
                  Number(directMeta.external_seed_rows_fetched || directProducts.length) ||
                  directProducts.length,
                external_seed_rows_relevant: directProducts.length,
              },
            };
          }
          if (directOnly) {
            return {
              products: [],
              metadata: {
                attempted: true,
                applied: false,
                reason: 'external_seed_direct_local_empty',
                requested_count: requestedCount,
                fetched_count: 0,
                fetched_raw_count:
                  Number(directMeta.external_seed_rows_fetched || 0) || 0,
                fetched_variant_count: queryVariants.length,
                upstream_calls: 0,
                brand_query_detected: Boolean(brandDetection?.brand_like),
                brand_entities: brandTerms,
                brand_scope: hasExplicitCategory ? 'category_scoped' : 'broad',
                filtered_out_irrelevant_count:
                  Number(directMeta.external_seed_rows_fetched || 0) || 0,
                query_variants: queryVariants,
                upstream_status: 200,
                retrieval_mode: guidanceContext.is_guidance_recall_first
                  ? GUIDANCE_RETRIEVAL_MODE
                  : 'direct_local',
                negative_constraints_applied: guidanceContext.negative_constraints,
                external_seed_rows_raw:
                  Number(directMeta.external_seed_rows_fetched || 0) || 0,
                external_seed_rows_relevant: 0,
              },
            };
          }
        }
      } catch (directExternalErr) {
        logger.warn(
          {
            err: directExternalErr?.message || String(directExternalErr),
            query: queryText,
          },
          'local external seed supplement direct path failed; falling back to public route',
        );
        if (directOnly) {
          return {
            products: [],
            metadata: {
              attempted: true,
              applied: false,
              reason: 'external_seed_direct_local_error',
              requested_count: requestedCount,
              fetched_count: 0,
              fetched_raw_count: 0,
              fetched_variant_count: queryVariants.length,
              upstream_calls: 0,
              upstream_status: 0,
              query_variants: queryVariants,
              error: directExternalErr?.message || String(directExternalErr),
            },
          };
        }
      }
    }
    if (directOnly) {
      return {
        products: [],
        metadata: {
          attempted: false,
          applied: false,
          reason: 'external_seed_direct_local_unavailable',
          requested_count: requestedCount,
          fetched_count: 0,
          fetched_raw_count: 0,
          fetched_variant_count: queryVariants.length,
          upstream_calls: 0,
          upstream_status: 0,
          query_variants: queryVariants,
        },
      };
    }

    const externalSupplementApiBase =
      normalizedSource === 'aurora-bff' || normalizedSource === 'aurora-chatbox'
        ? PIVOTA_API_BASE
        : getProxySearchApiBase(source);
    const url = `${externalSupplementApiBase}/agent/v1/products/search`;
    const requestHeaders = {
      ...(checkoutToken
        ? { 'X-Checkout-Token': checkoutToken }
        : {
            ...(PIVOTA_API_KEY && { 'X-API-Key': PIVOTA_API_KEY }),
            ...(PIVOTA_API_KEY && { Authorization: `Bearer ${PIVOTA_API_KEY}` }),
          }),
    };
    const seenKeys = new Set();
    const mergedProducts = [];
    let upstreamStatus = 0;
    let upstreamCalls = 0;
    let rawFetchedCount = 0;

    for (const variant of queryVariants) {
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
        external_seed_strategy: externalSeedStrategy,
        fast_mode: guidanceContext.is_guidance_recall_first ? false : true,
        ...(explicitTargetStepFamily ? { target_step_family: explicitTargetStepFamily } : {}),
        ...(explicitSemanticFamily ? { semantic_family: explicitSemanticFamily } : {}),
        ...(explicitQueryStepStrength ? { query_step_strength: explicitQueryStepStrength } : {}),
        ...(explicitProductOnly !== null ? { product_only: explicitProductOnly } : {}),
        ...(guidanceContext.is_guidance_only
          ? {
              ui_surface: guidanceContext.ui_surface || GUIDANCE_ONLY_UI_SURFACE,
              decision_mode: guidanceContext.decision_mode || GUIDANCE_ONLY_DECISION_MODE,
              retrieval_mode: guidanceContext.retrieval_mode || GUIDANCE_RETRIEVAL_MODE,
              source_policy: guidanceContext.source_policy || GUIDANCE_SOURCE_POLICY,
              ...(guidanceContext.target_step_family
                ? { target_step_family: guidanceContext.target_step_family }
                : {}),
              ...(guidanceContext.semantic_family
                ? { semantic_family: guidanceContext.semantic_family }
                : {}),
              ...(guidanceContext.query_step_strength
                ? { query_step_strength: guidanceContext.query_step_strength }
                : {}),
              ...(guidanceContext.product_only !== undefined
                ? { product_only: guidanceContext.product_only }
                : {}),
              ...(guidanceContext.negative_constraints.length
                ? { negative_constraints: guidanceContext.negative_constraints }
                : {}),
            }
          : {}),
      };
      const resp = await axios({
        method: 'GET',
        url,
        params: upstreamParams,
        headers: requestHeaders,
        timeout: Math.min(6500, getUpstreamTimeoutMs('find_products_multi')),
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
        ? normalized.products.filter((p) => isExternalSeedProduct(p))
        : [];
      rawFetchedCount += products.length;
      for (const product of products) {
        const key = buildSearchProductKey(product);
        if (!key || seenKeys.has(key)) continue;
        seenKeys.add(key);
        mergedProducts.push(product);
      }
      if (mergedProducts.length >= Math.max(requestedCount * 3, 48)) {
        break;
      }
    }

    const normalizedQuery = normalizeSearchTextForMatch(queryText);
    const anchorTokens = extractSearchAnchorTokens(queryText);
    const queryTokens = Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
    const relevantProducts = mergedProducts.filter((product) =>
      isSupplementCandidateRelevant(product, queryText, {
        normalizedQuery,
        anchorTokens,
        queryTokens,
        brandTerms,
        guidanceContext,
        queryLike: query,
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
        retrieval_mode: guidanceContext.is_guidance_recall_first
          ? GUIDANCE_RETRIEVAL_MODE
          : 'default',
        negative_constraints_applied: guidanceContext.negative_constraints,
        external_seed_rows_raw: rawFetchedCount,
        external_seed_rows_relevant: relevantProducts.length,
      },
    };
  }

  return {
    fetchExternalSeedSupplementFromBackend,
  };
}

module.exports = {
  createFindProductsExternalSeedSupplementRuntime,
};
