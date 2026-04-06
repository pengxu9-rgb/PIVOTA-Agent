function createFindProductsInvokeSearchSupplementsRuntime(deps = {}) {
  const {
    buildGuidanceOnlyDirectSupplementPlan,
    searchExternalSeedOnlyProductsDirect,
    parseQueryBoolean,
    firstQueryParamValue,
    resolveGuidanceSearchStepStrength,
    normalizeGuidanceDiscoverySourcePolicy,
    resolveGuidanceSearchSessionId,
    buildGuidanceOnlyDirectSupplementOutcome,
    shouldAttemptShoppingExactTitleExternalSeedRescue,
    resolveShoppingExactTitleExternalSeedSupplement,
    hasStrongExactTitleLookupMatch,
    buildSearchProductKey,
    normalizeAgentProductsListResponse,
    isExternalSeedProduct,
  } = deps;

  async function applyInvokeSearchSupplements({
    upstreamData,
    operation = '',
    queryText = '',
    traceQueryClass = null,
    requestedLimit = 20,
    requestedFindProductsMultiPage = 1,
    guidanceUiSurface = null,
    requestedTargetStepFamily = null,
    requestedAllowExternalSeed = false,
    requestedProductOnly = false,
    requestedQueryIndex = null,
    requestedQueryTotal = null,
    queryParams = null,
    metadata = null,
    effectivePayload = null,
    req = null,
    checkoutToken = null,
  } = {}) {
    let nextUpstreamData = upstreamData;
    let shoppingExactTitleSupplementMeta = null;
    const guidanceOnlyDiscovery = guidanceUiSurface === 'ingredient_plan_guidance_only';

    if (
      guidanceOnlyDiscovery &&
      requestedAllowExternalSeed === true &&
      requestedTargetStepFamily &&
      queryText
    ) {
      const guidanceDirectSupplementPlan = buildGuidanceOnlyDirectSupplementPlan({
        guidanceOnlyDiscovery,
        requestedAllowExternalSeed,
        requestedTargetStepFamily,
        queryText,
        upstreamData: nextUpstreamData,
        requestedLimit,
      });
      const {
        existingMeta,
        primaryProductsBeforeGuidance,
        primaryHasValidGuidanceHit,
        shouldAttemptDirectSupplement: shouldAttemptGuidanceDirectSupplement,
      } = guidanceDirectSupplementPlan;

      if (shouldAttemptGuidanceDirectSupplement) {
        const directSupplement = await searchExternalSeedOnlyProductsDirect({
          search: {
            query: queryText,
            limit: requestedLimit,
            offset: 0,
            in_stock_only:
              parseQueryBoolean(
                queryParams?.in_stock_only ??
                  queryParams?.inStockOnly ??
                  effectivePayload?.search?.in_stock_only ??
                  effectivePayload?.search?.inStockOnly,
              ) !== false,
            target_step_family: requestedTargetStepFamily,
            ui_surface: guidanceUiSurface,
            product_only: requestedProductOnly === true,
            catalog_surface:
              firstQueryParamValue(
                queryParams?.catalog_surface ||
                  queryParams?.catalogSurface ||
                  effectivePayload?.search?.catalog_surface ||
                  effectivePayload?.search?.catalogSurface,
              ) || null,
            source: metadata?.source || null,
          },
          metadata: {
            ui_surface: guidanceUiSurface,
            product_only_requested: requestedProductOnly === true,
            query_target_step_family: requestedTargetStepFamily,
            query_step_strength: resolveGuidanceSearchStepStrength(
              metadata?.query_step_strength ??
                queryParams?.query_step_strength ??
                queryParams?.queryStepStrength,
              queryText,
              requestedTargetStepFamily,
            ),
            decision_mode: 'guidance_only',
            source_policy: normalizeGuidanceDiscoverySourcePolicy(
              metadata?.source_policy ??
                queryParams?.source_policy ??
                queryParams?.sourcePolicy,
            ),
            session_id: resolveGuidanceSearchSessionId({ req, query: queryParams, metadata }),
            query_index: requestedQueryIndex,
            query_total: requestedQueryTotal,
          },
        });
        const guidanceDirectSupplementOutcome = buildGuidanceOnlyDirectSupplementOutcome({
          upstreamData: nextUpstreamData,
          directSupplement,
          existingMeta,
          primaryHasValidGuidanceHit,
          primaryProductsBeforeGuidance,
          requestedLimit,
          queryLimit: queryParams?.limit,
          queryOffset: queryParams?.offset,
        });
        if (guidanceDirectSupplementOutcome.applied) {
          nextUpstreamData = guidanceDirectSupplementOutcome.response;
        }
      }
    }

    const primaryProductsBeforeExactTitleSupplement = Array.isArray(nextUpstreamData?.products)
      ? nextUpstreamData.products
      : [];
    if (
      operation === 'find_products_multi' &&
      queryText &&
      shouldAttemptShoppingExactTitleExternalSeedRescue({
        source: metadata?.source,
        queryText,
        queryClass: traceQueryClass,
        requestedAllowExternalSeed,
        requestedPage: requestedFindProductsMultiPage,
        primaryProducts: primaryProductsBeforeExactTitleSupplement,
      })
    ) {
      const exactTitleSupplement = await resolveShoppingExactTitleExternalSeedSupplement({
        queryText,
        requestedLimit,
        queryParams,
        metadata,
        payload: effectivePayload,
        checkoutToken,
      });
      const directProducts = Array.isArray(exactTitleSupplement?.products)
        ? exactTitleSupplement.products
        : [];
      const exactMatches = directProducts.filter((product) =>
        hasStrongExactTitleLookupMatch(product, queryText),
      );
      if (exactMatches.length > 0) {
        const seen = new Set();
        const mergedProducts = [];
        for (const product of exactMatches) {
          const key = buildSearchProductKey(product);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          mergedProducts.push(product);
        }
        for (const product of primaryProductsBeforeExactTitleSupplement) {
          const key = buildSearchProductKey(product);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          mergedProducts.push(product);
          if (mergedProducts.length >= requestedLimit) break;
        }
        const baseUpstreamData =
          nextUpstreamData && typeof nextUpstreamData === 'object' && !Array.isArray(nextUpstreamData)
            ? nextUpstreamData
            : {};
        const { clarification: _ignoredClarification, ...upstreamDataWithoutClarification } =
          baseUpstreamData;
        nextUpstreamData = normalizeAgentProductsListResponse(
          {
            ...upstreamDataWithoutClarification,
            products: mergedProducts,
            total: Math.max(
              Number(nextUpstreamData?.total || 0) || 0,
              mergedProducts.length,
            ),
            metadata: {
              ...(nextUpstreamData?.metadata && typeof nextUpstreamData.metadata === 'object'
                ? nextUpstreamData.metadata
                : {}),
              query_source: 'agent_products_search_exact_title_supplemented',
              shopping_exact_title_external_seed_applied: true,
              shopping_exact_title_external_seed_match_count: exactMatches.length,
              external_seed_executed: true,
              external_seed_skip_reason: null,
              external_seed_cache_hit: false,
              external_seed_exact_title_recall_attempted: true,
              external_seed_exact_title_recall_hit: true,
              source_breakdown: {
                ...(
                  nextUpstreamData?.metadata?.source_breakdown &&
                  typeof nextUpstreamData.metadata.source_breakdown === 'object'
                    ? nextUpstreamData.metadata.source_breakdown
                    : {}
                ),
                internal_count: Math.max(
                  0,
                  mergedProducts.filter((product) => !isExternalSeedProduct(product)).length,
                ),
                external_seed_count: mergedProducts.filter((product) => isExternalSeedProduct(product)).length,
                stale_cache_used: false,
                strategy_applied: 'shopping_exact_title_external_seed_rescue',
              },
            },
          },
          {
            limit: queryParams?.limit,
            offset: queryParams?.offset,
          },
        );
        shoppingExactTitleSupplementMeta = {
          attempted: true,
          applied: true,
          added_count: exactMatches.length,
          reason: 'shopping_exact_title_external_seed_rescue',
        };
      } else {
        shoppingExactTitleSupplementMeta = {
          attempted: true,
          applied: false,
          added_count: 0,
          reason: 'shopping_exact_title_external_seed_no_match',
        };
      }
    }

    return {
      upstreamData: nextUpstreamData,
      shoppingExactTitleSupplementMeta,
    };
  }

  return {
    applyInvokeSearchSupplements,
  };
}

module.exports = {
  createFindProductsInvokeSearchSupplementsRuntime,
};
