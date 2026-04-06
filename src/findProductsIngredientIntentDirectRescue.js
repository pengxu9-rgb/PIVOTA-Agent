async function runIngredientIntentExternalSeedRescue({
  search = {},
  metadata = {},
  relevanceQueryText = '',
  targetStepFamily = null,
  recallProfile = null,
  inStockOnly = true,
  rescueLimit = 0,
  searchExternalSeedOnlyProductsDirect,
  stabilizeIngredientIntentDirectProducts,
  logger = null,
} = {}) {
  try {
    const externalSeedRescueResponse = await searchExternalSeedOnlyProductsDirect({
      search: {
        ...(search && typeof search === 'object' && !Array.isArray(search) ? search : {}),
        query: relevanceQueryText,
        limit: rescueLimit,
        page: 1,
        offset: 0,
        in_stock_only: inStockOnly,
        allow_external_seed: true,
        allow_stale_cache: false,
        external_seed_strategy: 'unified_relevance',
        product_only: true,
        ...(targetStepFamily ? { target_step_family: targetStepFamily } : {}),
      },
      metadata: {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        relevance_query_text: relevanceQueryText,
        ...(targetStepFamily ? { query_target_step_family: targetStepFamily } : {}),
      },
    });
    const rescueResponseProductsRaw = Array.isArray(externalSeedRescueResponse?.products)
      ? externalSeedRescueResponse.products
      : [];
    return stabilizeIngredientIntentDirectProducts(rescueResponseProductsRaw, {
      recallProfile,
      targetStepFamily,
      queryText: relevanceQueryText,
    });
  } catch (ingredientExternalSeedRescueErr) {
    logger?.warn(
      {
        err:
          ingredientExternalSeedRescueErr?.message ||
          String(ingredientExternalSeedRescueErr),
        query: relevanceQueryText,
      },
      'ingredient external seed rescue failed after direct miss',
    );
    return [];
  }
}

module.exports = {
  runIngredientIntentExternalSeedRescue,
};
