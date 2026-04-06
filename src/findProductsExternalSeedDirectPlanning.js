async function prepareExternalSeedDirectSearchPlan({
  search = {},
  metadata = {},
  guidanceFastpath = false,
  deps = {},
} = {}) {
  const {
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
  } = deps;

  const queryText = extractSearchQueryText(search);
  const relevanceQueryText = String(
    firstQueryParamValue(
      metadata?.relevance_query_text ??
        metadata?.relevanceQueryText ??
        search?.relevance_query_text ??
        search?.relevanceQueryText ??
        queryText,
    ) || '',
  ).trim();

  if (!relevanceQueryText) {
    return {
      emptyResponse: {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        page: 1,
        page_size: 0,
        reply: null,
        metadata: {
          query_source: 'agent_products_external_seed_direct',
          fetched_at: new Date().toISOString(),
          external_seed_only_requested: true,
          external_seed_rows_fetched: 0,
          external_seed_rows_built: 0,
          external_seed_returned_count: 0,
          strict_empty: true,
          strict_empty_reason: 'external_seed_only_empty_query',
        },
      },
    };
  }

  const safeLimit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(Number(search.limit || 20) || 20)));
  const safePage = Math.max(1, Math.floor(Number(search.page || 1) || 1));
  const safeOffset = Math.max(
    0,
    Number.isFinite(Number(search.offset))
      ? Math.floor(Number(search.offset))
      : (safePage - 1) * safeLimit,
  );
  const inStockOnly = parseQueryBoolean(search.in_stock_only ?? search.inStockOnly) !== false;
  const market =
    String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US').trim().toUpperCase() || 'US';
  const tool = 'creator_agents';
  const normalizedQuery = normalizeSearchTextForMatch(relevanceQueryText);
  const publicBrandSearchMainline =
    isPublicSearchSource(metadata?.source) &&
    Boolean(detectBrandEntities(relevanceQueryText, { candidateProducts: [] })?.brand_like) &&
    !hasExplicitCategoryHint(relevanceQueryText, null);

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
  const ingredientIntentDetected =
    hasBeautyIngredientIntentSignal(relevanceQueryText) || Boolean(recallProfile);
  const explicitTargetStepFamily = normalizeRecoTargetStep(
    metadata?.query_target_step_family || search?.target_step_family || search?.targetStepFamily,
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
  const uiSurface = normalizeSearchUiSurface(metadata?.ui_surface || search?.ui_surface || search?.uiSurface);
  const decisionMode = normalizeRecommendationDecisionMode(
    metadata?.decision_mode || search?.decision_mode || search?.decisionMode,
    { guidanceOnlyDiscovery: uiSurface === 'ingredient_plan_guidance_only' },
  );
  const guidanceOnlyDiscovery = decisionMode === 'guidance_only';
  const sessionId = resolveGuidanceSearchSessionId({ query: search, metadata });
  const sessionSeenProductIds = guidanceOnlyDiscovery
    ? await loadGuidanceSearchSessionSeenProductIds(sessionId)
    : [];
  const resolvedQueryStepStrength = resolveGuidanceSearchStepStrength(
    metadata?.query_step_strength || search?.query_step_strength || search?.queryStepStrength,
    queryText,
    targetStepFamily,
  );
  const queryStepStrength = shouldUseSharedTargetRelevancePipeline({
    mode: decisionMode,
    targetStepFamily,
    queryStepStrength: resolvedQueryStepStrength,
  })
    ? resolvedQueryStepStrength
    : null;
  const requestedProductOnly =
    parseQueryBoolean(metadata?.product_only_requested ?? search?.product_only ?? search?.productOnly) === true;
  const normalizedIntent = buildGuidanceSearchNormalizedIntent({
    queryText: relevanceQueryText,
    targetStepFamily,
    uiSurface,
    decisionMode,
    queryStepStrength,
  });
  const serumCanaryQueryVariants = normalizedIntent?.backbone_id
    ? buildSerumCanaryBackboneQueries(queryText)
    : [];
  const guidanceFamilyQueryVariants = guidanceOnlyDiscovery
    ? buildGuidanceRecallSupplementQueries(relevanceQueryText, {
        is_guidance_only: true,
        target_step_family: targetStepFamily,
      })
    : [];
  const beautyFamilyQueryVariants = buildBeautyFamilySupplementQueries(relevanceQueryText, {
    target_step_family: targetStepFamily,
    semantic_family:
      metadata?.semantic_family ||
      metadata?.semanticFamily ||
      search?.semantic_family ||
      search?.semanticFamily ||
      null,
  });
  const ingredientRecallQueryVariants = ingredientIntentDetected
    ? buildIngredientRecallQueryVariants(relevanceQueryText, recallProfile, targetStepFamily)
    : [];
  const retrievalQueryVariantsOverride = parseQueryStringArray(
    metadata?.retrieval_query_variants ??
      metadata?.retrievalQueryVariants ??
      search?.retrieval_query_variants ??
      search?.retrievalQueryVariants,
  );
  const retrievalQueries = Array.from(
    new Set(
      (
        retrievalQueryVariantsOverride.length > 0
          ? [...retrievalQueryVariantsOverride, ...beautyFamilyQueryVariants]
          : [
              queryText,
              ...ingredientRecallQueryVariants,
              ...serumCanaryQueryVariants,
              ...guidanceFamilyQueryVariants,
              ...beautyFamilyQueryVariants,
            ]
      )
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
  const anchorTokens = extractSearchAnchorTokens(relevanceQueryText);
  const queryTokens = Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
  const ingredientIntent = ingredientIntentDetected;
  const useLeanGuidanceSql =
    guidanceOnlyDiscovery &&
    targetStepFamily === 'moisturizer' &&
    (guidanceFastpath || retrievalQueryVariantsOverride.length > 0 || retrievalQueries.length > 1);

  return {
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
    ingredientIntentDetected,
  };
}

module.exports = {
  prepareExternalSeedDirectSearchPlan,
};
