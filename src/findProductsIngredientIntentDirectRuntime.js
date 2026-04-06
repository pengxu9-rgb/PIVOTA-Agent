function createFindProductsIngredientIntentDirectRuntime(deps = {}) {
  const {
    prepareIngredientIntentDirectRecall,
    buildIngredientIntentDirectBaseMetadata,
    shouldTreatIngredientDirectRecallAsMiss,
    hasIngredientIntentExplicitEvidenceBreakdown,
    runIngredientIntentExternalSeedRescue,
    searchExternalSeedOnlyProductsDirect,
    stabilizeIngredientIntentDirectProducts,
    logger,
    buildIngredientIntentExternalSeedRescueResponse,
    normalizeGuidanceDiscoveryProductPdpContract,
    buildIngredientIntentDirectEmptyResponse,
    buildIngredientIntentDirectHitResponse,
  } = deps;

  async function searchIngredientIntentProductsDirect({ search = {}, metadata = {} } = {}) {
    if (!process.env.DATABASE_URL) return null;

    const preparedDirectRecall = await prepareIngredientIntentDirectRecall({
      search,
      metadata,
    });
    if (!preparedDirectRecall) return null;

    const {
      relevanceQueryText,
      recallProfile,
      recallProfileDiagnostics,
      ingredientIntentDetected,
      safeLimit,
      safePage,
      safeOffset,
      guidanceOnlyDiscovery,
      targetStepFamily,
      inStockOnly,
      strictConstraintReason,
      ingredientDirectMinimumProducts,
      ingredientDirectRecallLimit,
      diagnostics,
      directServiceProducts,
      hasServiceRecallMeta,
      ingredientIntentIds,
      ingredientBudgetRescueQueries,
      ingredientBudgetRescueAttempted,
      ingredientBudgetRescueRecovered,
      mergedRecalledProducts,
    } = preparedDirectRecall;

    const baseMetadata = buildIngredientIntentDirectBaseMetadata({
      diagnostics,
      recallProfileDiagnostics,
      recallProfile,
      ingredientIntentDetected,
      ingredientIntentIds,
      strictConstraintReason,
      mergedRecalledProducts,
      directServiceProducts,
      hasServiceRecallMeta,
      ingredientBudgetRescueAttempted,
      ingredientBudgetRescueRecovered,
      ingredientBudgetRescueQueries,
      ingredientDirectRecallLimit,
      ingredientDirectMinimumProducts,
    });
    const shouldTreatAsDirectMiss = shouldTreatIngredientDirectRecallAsMiss({
      baseMetadata,
      diagnostics,
      hasIngredientIntentExplicitEvidenceBreakdown,
    });
    if (shouldTreatAsDirectMiss) {
      const rescueLimit = Math.max(safeLimit + safeOffset, safeLimit);
      const rescuedProducts = await runIngredientIntentExternalSeedRescue({
        search,
        metadata,
        relevanceQueryText,
        targetStepFamily,
        recallProfile,
        inStockOnly,
        rescueLimit,
        searchExternalSeedOnlyProductsDirect,
        stabilizeIngredientIntentDirectProducts,
        logger,
      });
      if (rescuedProducts.length > 0) {
        return buildIngredientIntentExternalSeedRescueResponse({
          rescuedProducts,
          safeOffset,
          safeLimit,
          safePage,
          guidanceOnlyDiscovery,
          normalizeGuidanceDiscoveryProductPdpContract,
          baseMetadata,
          ingredientIntentIds,
          diagnostics,
          ingredientIntentDetected,
          recallProfileDiagnostics,
          targetStepFamily,
        });
      }
      return buildIngredientIntentDirectEmptyResponse({
        safePage,
        baseMetadata,
        ingredientIntentIds,
        diagnostics,
        ingredientIntentDetected,
        recallProfileDiagnostics,
        targetStepFamily,
      });
    }

    const pagedProducts = mergedRecalledProducts.slice(safeOffset, safeOffset + safeLimit);
    const responseProducts = guidanceOnlyDiscovery
      ? pagedProducts.map((product) => normalizeGuidanceDiscoveryProductPdpContract(product))
      : pagedProducts;

    return buildIngredientIntentDirectHitResponse({
      responseProducts,
      mergedRecalledProducts,
      safePage,
      baseMetadata,
      ingredientIntentIds,
      diagnostics,
      ingredientIntentDetected,
      recallProfileDiagnostics,
      targetStepFamily,
    });
  }

  return {
    searchIngredientIntentProductsDirect,
  };
}

module.exports = {
  createFindProductsIngredientIntentDirectRuntime,
};
