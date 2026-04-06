function createFindProductsIngredientIntentDirectPreparationRuntime(deps = {}) {
  const {
    extractSearchQueryText,
    firstQueryParamValue,
    resolveIngredientRecallProfileKnowledge,
    resolveIngredientRecallProfile,
    hasBeautyIngredientIntentSignal,
    getSearchLimitMax,
    normalizeSearchUiSurface,
    normalizeRecommendationDecisionMode,
    normalizeRecoTargetStep,
    resolveRecoTargetStepIntent,
    resolveIngredientIntentTargetStepFamily,
    parseQueryBoolean,
    getStrictFindProductsMultiConstraintDecision,
    extractIntentRuleBased,
    recallIngredientProducts,
    stabilizeIngredientIntentDirectProducts,
    buildStrictIngredientBudgetRescueQueries,
    hasIngredientIntentExplicitEvidenceBreakdown,
    hasBudgetQualifiedIngredientCandidate,
    hasPriceQualifiedCandidate,
    fetchExternalSeedSupplementFromBackend,
    logger,
  } = deps;

  async function prepareIngredientIntentDirectRecall({
    search = {},
    metadata = {},
  } = {}) {
    const queryText = extractSearchQueryText(search);
    const source = String(
      (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? metadata.source
        : null) || '',
    ).trim();
    const relevanceQueryText = String(
      firstQueryParamValue(
        metadata?.relevance_query_text ??
          metadata?.relevanceQueryText ??
          search?.relevance_query_text ??
          search?.relevanceQueryText ??
          queryText,
      ) || '',
    ).trim();
    const recallKnowledge =
      typeof resolveIngredientRecallProfileKnowledge === 'function'
        ? await resolveIngredientRecallProfileKnowledge({ query: relevanceQueryText })
        : (() => {
            const fallbackProfile = resolveIngredientRecallProfile({ query: relevanceQueryText });
            return {
              profile: fallbackProfile,
              diagnostics: {
                profile_source: fallbackProfile ? 'base_only' : 'none',
              },
            };
          })();
    const recallProfile = recallKnowledge?.profile || null;
    const recallProfileDiagnostics =
      recallKnowledge?.diagnostics && typeof recallKnowledge.diagnostics === 'object'
        ? recallKnowledge.diagnostics
        : {};
    const ingredientIntentDetected =
      hasBeautyIngredientIntentSignal(relevanceQueryText) || Boolean(recallProfile);
    if (!relevanceQueryText || !ingredientIntentDetected) return null;

    const safeLimit = Math.max(
      1,
      Math.min(
        Number.isFinite(Number(getSearchLimitMax?.()))
          ? Number(getSearchLimitMax())
          : 20,
        Math.floor(Number(search.limit || 20) || 20),
      ),
    );
    const safePage = Math.max(1, Math.floor(Number(search.page || 1) || 1));
    const safeOffset = Math.max(
      0,
      Number.isFinite(Number(search.offset))
        ? Math.floor(Number(search.offset))
        : (safePage - 1) * safeLimit,
    );
    const uiSurface = normalizeSearchUiSurface(
      metadata?.ui_surface || search?.ui_surface || search?.uiSurface,
    );
    const decisionMode = normalizeRecommendationDecisionMode(
      metadata?.decision_mode || search?.decision_mode || search?.decisionMode,
      { guidanceOnlyDiscovery: uiSurface === 'ingredient_plan_guidance_only' },
    );
    const guidanceOnlyDiscovery =
      uiSurface === 'ingredient_plan_guidance_only' || decisionMode === 'guidance_only';
    const explicitTargetStepFamily = normalizeRecoTargetStep(
      metadata?.query_target_step_family ||
        search?.target_step_family ||
        search?.targetStepFamily,
    );
    const inferredTargetStepFamily = normalizeRecoTargetStep(
      resolveRecoTargetStepIntent({ text: relevanceQueryText })?.resolved_target_step || '',
    );
    const targetStepFamily = resolveIngredientIntentTargetStepFamily({
      queryText: relevanceQueryText,
      explicitTargetStepFamily,
      inferredTargetStepFamily,
      recallProfile,
    });
    const inStockOnly = parseQueryBoolean(search.in_stock_only ?? search.inStockOnly) !== false;
    const directStrictDecision = getStrictFindProductsMultiConstraintDecision({
      search: relevanceQueryText ? { query: relevanceQueryText } : {},
      metadata,
    });
    const directRuleBasedIntent =
      relevanceQueryText && typeof extractIntentRuleBased === 'function'
        ? extractIntentRuleBased(relevanceQueryText, [], [])
        : null;
    const directPriceConstraint =
      directRuleBasedIntent?.hard_constraints &&
      directRuleBasedIntent.hard_constraints.price &&
      typeof directRuleBasedIntent.hard_constraints.price === 'object'
        ? { ...directRuleBasedIntent.hard_constraints.price }
        : null;
    const strictConstraintReason =
      directStrictDecision?.strictConstraintReason ||
      (recallProfile && String(recallProfile.ingredient_id || '').trim()
        ? 'ingredient'
        : null);
    const directRecallResultWindow = Math.max(safeLimit + safeOffset, safeLimit);
    const useTighterStrictIngredientRecallWindow =
      source === 'search' && Boolean(strictConstraintReason);
    const ingredientDirectMinimumProducts =
      useTighterStrictIngredientRecallWindow ||
      (strictConstraintReason === 'multi_constraint' && directPriceConstraint)
        ? 2
        : null;
    const ingredientDirectRecallLimit = useTighterStrictIngredientRecallWindow
      ? Math.min(directRecallResultWindow, 6)
      : directRecallResultWindow;

    const recalled = await recallIngredientProducts({
      query: relevanceQueryText,
      ingredientId: recallProfile?.ingredient_id || '',
      recallKnowledge,
      targetStepFamily,
      limit: ingredientDirectRecallLimit,
      inStockOnly,
      allowFamilyFallback: true,
      minimumDirectProductCount: ingredientDirectMinimumProducts,
    });
    const diagnostics =
      recalled?.diagnostics &&
      typeof recalled.diagnostics === 'object' &&
      !Array.isArray(recalled.diagnostics)
        ? recalled.diagnostics
        : {};
    const directServiceProducts = Array.isArray(recalled?.products)
      ? recalled.products
      : [];
    const hasServiceRecallMeta = directServiceProducts.some(
      (product) =>
        product &&
        typeof product === 'object' &&
        product.__ingredient_recall_meta &&
        typeof product.__ingredient_recall_meta === 'object',
    );
    const recalledProducts = hasServiceRecallMeta
      ? directServiceProducts.slice()
      : stabilizeIngredientIntentDirectProducts(directServiceProducts, {
          recallProfile,
          targetStepFamily,
          queryText: relevanceQueryText,
        });
    const ingredientIntentIds =
      recallProfile && String(recallProfile.ingredient_id || '').trim()
        ? [String(recallProfile.ingredient_id || '').trim()]
        : [];
    const ingredientBudgetRescueQueries = buildStrictIngredientBudgetRescueQueries(
      relevanceQueryText,
      recallProfile,
      targetStepFamily,
    );
    const explicitDirectEvidencePresent = hasIngredientIntentExplicitEvidenceBreakdown(
      diagnostics.ingredient_candidate_evidence_breakdown,
    );
    const hasBudgetQualifiedDirectCandidate =
      hasBudgetQualifiedIngredientCandidate(recalledProducts, directPriceConstraint) ||
      (explicitDirectEvidencePresent &&
        hasPriceQualifiedCandidate(recalledProducts, directPriceConstraint));
    const shouldAttemptIngredientBudgetRescue =
      ingredientBudgetRescueQueries.length > 0 && !hasBudgetQualifiedDirectCandidate;
    let ingredientBudgetRescueAttempted = false;
    let ingredientBudgetRescueRecovered = false;
    let ingredientBudgetRescueProducts = [];

    if (shouldAttemptIngredientBudgetRescue) {
      ingredientBudgetRescueAttempted = true;
      try {
        const budgetRescueLimit = ingredientDirectRecallLimit;
        const budgetRescueResponse = await fetchExternalSeedSupplementFromBackend({
          queryParams: {
            ...(search && typeof search === 'object' && !Array.isArray(search)
              ? search
              : {}),
            query: ingredientBudgetRescueQueries[0],
            limit: budgetRescueLimit,
            page: 1,
            offset: 0,
            in_stock_only: inStockOnly,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: 'unified_relevance',
            product_only: true,
            ...(targetStepFamily ? { target_step_family: targetStepFamily } : {}),
          },
          neededCount: budgetRescueLimit,
          source:
            (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
              ? metadata.source
              : null) || null,
        });
        const budgetRescueRawProducts = Array.isArray(budgetRescueResponse?.products)
          ? budgetRescueResponse.products
          : [];
        ingredientBudgetRescueProducts = budgetRescueRawProducts.filter(Boolean);
        ingredientBudgetRescueRecovered = ingredientBudgetRescueProducts.length > 0;
      } catch (ingredientBudgetRescueErr) {
        logger?.warn(
          {
            err: ingredientBudgetRescueErr?.message || String(ingredientBudgetRescueErr),
            query: relevanceQueryText,
            rescue_query: ingredientBudgetRescueQueries[0],
          },
          'ingredient budget rescue failed after direct recall',
        );
      }
    }

    const mergedRecalledProducts =
      ingredientBudgetRescueProducts.length > 0
        ? stabilizeIngredientIntentDirectProducts(
            [...recalledProducts, ...ingredientBudgetRescueProducts],
            {
              recallProfile,
              targetStepFamily,
              queryText: ingredientBudgetRescueQueries[0] || relevanceQueryText,
            },
          )
        : recalledProducts;

    return {
      queryText,
      source,
      relevanceQueryText,
      recallKnowledge,
      recallProfile,
      recallProfileDiagnostics,
      ingredientIntentDetected,
      safeLimit,
      safePage,
      safeOffset,
      uiSurface,
      decisionMode,
      guidanceOnlyDiscovery,
      targetStepFamily,
      inStockOnly,
      directPriceConstraint,
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
      recalledProducts,
      mergedRecalledProducts,
    };
  }

  return {
    prepareIngredientIntentDirectRecall,
  };
}

module.exports = {
  createFindProductsIngredientIntentDirectPreparationRuntime,
};
