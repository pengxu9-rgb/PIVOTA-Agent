function createFindProductsExternalSeedDirectRuntime(deps = {}) {
  const {
    prepareExternalSeedDirectSearchPlan,
    runExternalSeedBrandMainlineFastpath,
    retrieveExternalSeedDirectCandidates,
    finalizeExternalSeedOnlyDirectResponse,
    extractSearchQueryText,
    firstQueryParamValue,
    SEARCH_LIMIT_MAX,
    parseQueryBoolean,
    normalizeSearchTextForMatch,
    isPublicSearchSource,
    detectBrandEntities,
    hasExplicitCategoryHint,
    resolveIngredientRecallProfileKnowledge,
    resolveIngredientRecallProfile,
    hasBeautyIngredientIntentSignal,
    normalizeRecoTargetStep,
    resolveRecoTargetStepIntent,
    resolveIngredientIntentTargetStepFamily,
    normalizeSearchUiSurface,
    normalizeRecommendationDecisionMode,
    resolveGuidanceSearchSessionId,
    loadGuidanceSearchSessionSeenProductIds,
    shouldUseSharedTargetRelevancePipeline,
    resolveGuidanceSearchStepStrength,
    buildGuidanceSearchNormalizedIntent,
    buildSerumCanaryBackboneQueries,
    buildGuidanceRecallSupplementQueries,
    buildBeautyFamilySupplementQueries,
    buildIngredientRecallQueryVariants,
    parseQueryStringArray,
    extractSearchAnchorTokens,
    tokenizeSearchTextForMatch,
    buildBrandQueryVariants,
    normalizeBrandText,
    buildExternalSeedProduct,
    buildExternalSeedBrandSearchProduct,
    buildExternalSeedProduct,
    buildSearchProductKey,
    query,
    logger,
    resolveGuidanceDirectExternalSeedRetrievalBudget,
    shouldRunExternalSeedExactTitleRecall,
    queryExternalSeedExactTitleRows,
    normalizeExactTitleLookupText,
    compactExactTitleLookupText,
    BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
    classifySharedBeautyCoarseCandidate,
    scoreDirectExternalSeedProduct,
    isSupplementCandidateRelevant,
    getTargetRelevanceClassRank,
    hasStrongExactTitleLookupMatch,
    buildSharedBeautySkincareHitQualityDecision,
    buildSearchDecisionProductKey,
    normalizeGuidanceDiscoveryProductPdpContract,
    countCandidateOriginBreakdown,
    mergeSearchCountMaps,
  } = deps;

  async function searchExternalSeedOnlyProductsDirect({
    search = {},
    metadata = {},
    guidanceFastpath = false,
  } = {}) {
    if (!process.env.DATABASE_URL) return null;

    const directSearchPlan = await prepareExternalSeedDirectSearchPlan({
      search,
      metadata,
      guidanceFastpath,
      deps: {
        extractSearchQueryText,
        firstQueryParamValue,
        SEARCH_LIMIT_MAX,
        parseQueryBoolean,
        normalizeSearchTextForMatch,
        isPublicSearchSource,
        detectBrandEntities,
        hasExplicitCategoryHint,
        resolveIngredientRecallProfileKnowledge,
        resolveIngredientRecallProfile,
        hasBeautyIngredientIntentSignal,
        normalizeRecoTargetStep,
        resolveRecoTargetStepIntent,
        resolveIngredientIntentTargetStepFamily,
        normalizeSearchUiSurface,
        normalizeRecommendationDecisionMode,
        resolveGuidanceSearchSessionId,
        loadGuidanceSearchSessionSeenProductIds,
        shouldUseSharedTargetRelevancePipeline,
        resolveGuidanceSearchStepStrength,
        buildGuidanceSearchNormalizedIntent,
        buildSerumCanaryBackboneQueries,
        buildGuidanceRecallSupplementQueries,
        buildBeautyFamilySupplementQueries,
        buildIngredientRecallQueryVariants,
        parseQueryStringArray,
        extractSearchAnchorTokens,
        tokenizeSearchTextForMatch,
      },
    });
    if (!directSearchPlan) return null;
    if (directSearchPlan.emptyResponse) return directSearchPlan.emptyResponse;

    const {
      queryText,
      relevanceQueryText,
      safeLimit,
      safePage,
      safeOffset,
      inStockOnly,
      market,
      tool,
      normalizedQuery,
      publicBrandSearchMainline,
      recallProfile,
      targetStepFamily,
      uiSurface,
      decisionMode,
      guidanceOnlyDiscovery,
      sessionSeenProductIds,
      queryStepStrength,
      requestedProductOnly,
      normalizedIntent,
      retrievalQueries,
      anchorTokens,
      queryTokens,
      ingredientIntent,
      useLeanGuidanceSql,
    } = directSearchPlan;

    if (publicBrandSearchMainline) {
      const brandFastpathResponse = await runExternalSeedBrandMainlineFastpath({
        relevanceQueryText,
        market,
        tool,
        inStockOnly,
        safePage,
        safeLimit,
        safeOffset,
        deps: {
          detectBrandEntities,
          normalizeSearchTextForMatch,
          buildBrandQueryVariants,
          normalizeBrandText,
          buildExternalSeedBrandSearchProduct,
          buildSearchProductKey,
          query,
          logger,
        },
      });
      if (brandFastpathResponse) return brandFastpathResponse;
    }

    try {
      const {
        rawProducts,
        variantQueryDebug,
        retrievalBudget,
        shouldRunExactTitleRecall,
      } = await retrieveExternalSeedDirectCandidates({
        retrievalQueries,
        relevanceQueryText,
        queryTokens,
        ingredientIntent,
        market,
        tool,
        inStockOnly,
        useLeanGuidanceSql,
        safeLimit,
        guidanceOnlyDiscovery,
        targetStepFamily,
        deps: {
          resolveGuidanceDirectExternalSeedRetrievalBudget,
          shouldRunExternalSeedExactTitleRecall,
          queryExternalSeedExactTitleRows,
          normalizeExactTitleLookupText,
          compactExactTitleLookupText,
          buildExternalSeedProduct,
          buildSearchProductKey,
          normalizeSearchTextForMatch,
          extractSearchAnchorTokens,
          tokenizeSearchTextForMatch,
          query,
        },
      });

      return finalizeExternalSeedOnlyDirectResponse({
        rawProducts,
        relevanceQueryText,
        normalizedQuery,
        anchorTokens,
        queryTokens,
        recallProfile,
        targetStepFamily,
        uiSurface,
        queryStepStrength,
        decisionMode,
        publicBrandSearchMainline,
        ingredientIntent,
        guidanceOnlyDiscovery,
        requestedProductOnly,
        guidanceFastpath,
        sessionSeenProductIds,
        safeOffset,
        safeLimit,
        safePage,
        metadata: {
          ...metadata,
          normalized_intent: normalizedIntent,
        },
        retrievalQueries,
        variantQueryDebug,
        useLeanGuidanceSql,
        retrievalBudget,
        shouldRunExactTitleRecall,
        deps: {
          BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
          classifySharedBeautyCoarseCandidate,
          scoreDirectExternalSeedProduct,
          normalizeSearchTextForMatch,
          isSupplementCandidateRelevant,
          getTargetRelevanceClassRank,
          hasStrongExactTitleLookupMatch,
          buildSharedBeautySkincareHitQualityDecision,
          buildSearchDecisionProductKey,
          normalizeGuidanceDiscoveryProductPdpContract,
          countCandidateOriginBreakdown,
          mergeSearchCountMaps,
        },
      });
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (msg.includes('external_product_seeds') && msg.includes('does not exist')) {
        return null;
      }
      logger.warn(
        { err: err?.message || String(err), query: queryText },
        'external seed direct search failed',
      );
      return null;
    }
  }

  return {
    searchExternalSeedOnlyProductsDirect,
  };
}

module.exports = {
  createFindProductsExternalSeedDirectRuntime,
};
