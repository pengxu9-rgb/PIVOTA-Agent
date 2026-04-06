function finalizeExternalSeedOnlyDirectResponse({
  rawProducts = [],
  relevanceQueryText = '',
  normalizedQuery = '',
  anchorTokens = [],
  queryTokens = [],
  recallProfile = null,
  targetStepFamily = null,
  uiSurface = null,
  queryStepStrength = null,
  decisionMode = null,
  publicBrandSearchMainline = false,
  ingredientIntent = false,
  guidanceOnlyDiscovery = false,
  requestedProductOnly = false,
  guidanceFastpath = false,
  sessionSeenProductIds = [],
  safeOffset = 0,
  safeLimit = 20,
  safePage = 1,
  metadata = {},
  retrievalQueries = [],
  variantQueryDebug = [],
  useLeanGuidanceSql = false,
  retrievalBudget = null,
  shouldRunExactTitleRecall = false,
  deps = {},
} = {}) {
  const {
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
  } = deps;

  const prefilterCandidateClassCounts = {};
  const prefilterNoiseDropCounts = {};
  for (const product of rawProducts) {
    const coarse = classifySharedBeautyCoarseCandidate(product, {
      queryTargetStepFamily: targetStepFamily,
      queryText: relevanceQueryText,
      guidanceOnlyDiscovery,
      queryStepStrength,
      mode: decisionMode,
    });
    if (coarse?.target_relevance_class) {
      prefilterCandidateClassCounts[coarse.target_relevance_class] =
        Number(prefilterCandidateClassCounts[coarse.target_relevance_class] || 0) + 1;
    }
    if (coarse?.noise_reason) {
      prefilterNoiseDropCounts[coarse.noise_reason] =
        Number(prefilterNoiseDropCounts[coarse.noise_reason] || 0) + 1;
    }
  }

  const rankedProducts = rawProducts
    .map((product) => {
      const scored = scoreDirectExternalSeedProduct({
        product,
        queryText: relevanceQueryText,
        normalizedQuery,
        anchorTokens,
        queryTokens,
        recallProfile,
        targetStepFamily,
        uiSurface,
        queryStepStrength,
        decisionMode,
        brandSearchMainlineQuery: publicBrandSearchMainline,
      });
      const coarse = scored?.coarse || null;
      const relevant = publicBrandSearchMainline
        ? Boolean(
            normalizedQuery &&
              normalizeSearchTextForMatch(
                [
                  product?.title,
                  product?.name,
                  product?.brand,
                  product?.vendor,
                  product?.category,
                  product?.product_type,
                  product?.merchant_name,
                  product?.url,
                  product?.canonical_url,
                  product?.destination_url,
                ]
                  .map((value) => String(value || '').trim())
                  .filter(Boolean)
                  .join(' '),
              ).includes(normalizedQuery),
          )
        : isSupplementCandidateRelevant(product, relevanceQueryText, {
            normalizedQuery,
            anchorTokens,
            queryTokens,
            recallProfile,
            ingredientIntent,
            targetStepFamily,
            uiSurface,
            queryStepStrength,
            decisionMode,
          });
      return {
        product,
        score: Number(scored?.score || 0) || 0,
        coarse,
        relevance_rank: getTargetRelevanceClassRank(coarse?.target_relevance_class),
        sample_rank: coarse?.offer_type === 'sample' ? 1 : 0,
        relevant,
      };
    })
    .filter((row) => {
      if (ingredientIntent) return row.relevant;
      return row.relevant || row.score > 0;
    })
    .sort((a, b) => {
      if (a.relevance_rank !== b.relevance_rank) return a.relevance_rank - b.relevance_rank;
      if (a.sample_rank !== b.sample_rank) return a.sample_rank - b.sample_rank;
      if (b.score !== a.score) return b.score - a.score;
      const aTitle = normalizeSearchTextForMatch(a.product?.title || a.product?.name || '');
      const bTitle = normalizeSearchTextForMatch(b.product?.title || b.product?.name || '');
      const aTitleAnchorHits = anchorTokens.filter((token) => aTitle.includes(token)).length;
      const bTitleAnchorHits = anchorTokens.filter((token) => bTitle.includes(token)).length;
      if (bTitleAnchorHits !== aTitleAnchorHits) return bTitleAnchorHits - aTitleAnchorHits;
      return String(b.product?.title || '').localeCompare(String(a.product?.title || ''));
    })
    .map((row) => row.product);

  let serviceRowsFilteredCount = 0;
  const productOnlyProducts = rankedProducts.filter((product) => {
    if (!guidanceOnlyDiscovery || !requestedProductOnly) return true;
    const coarse = classifySharedBeautyCoarseCandidate(product, {
      queryTargetStepFamily: targetStepFamily,
      queryText: relevanceQueryText,
      guidanceOnlyDiscovery,
      queryStepStrength,
      mode: decisionMode,
    });
    const blocked =
      coarse?.object_type === 'service' ||
      coarse?.domain_scope === 'beauty_service' ||
      coarse?.object_type === 'tool' ||
      coarse?.domain_scope === 'beauty_tool';
    if (blocked) serviceRowsFilteredCount += 1;
    return !blocked;
  });

  const exactTitleMatches = shouldRunExactTitleRecall
    ? productOnlyProducts.filter((product) => hasStrongExactTitleLookupMatch(product, relevanceQueryText))
    : [];
  const skincareHitDecision = publicBrandSearchMainline
    ? null
    : buildSharedBeautySkincareHitQualityDecision({
        queryText: relevanceQueryText,
        products: productOnlyProducts,
        queryTargetStepFamily: targetStepFamily,
        guidanceOnlyDiscovery,
        queryStepStrength,
        mode: decisionMode,
        sessionSeenProductIds,
      });
  const validKeys = new Set(
    (Array.isArray(skincareHitDecision?.valid_products) ? skincareHitDecision.valid_products : [])
      .map((product) => buildSearchDecisionProductKey(product))
      .filter(Boolean),
  );
  const exactTitleBypassApplied = exactTitleMatches.length > 0;
  const scopedProducts = exactTitleBypassApplied
    ? productOnlyProducts
    : guidanceFastpath
    ? productOnlyProducts
    : skincareHitDecision?.applied && skincareHitDecision?.hit_quality !== 'valid_hit'
    ? []
    : skincareHitDecision?.applied
    ? productOnlyProducts.filter((product) => validKeys.has(buildSearchDecisionProductKey(product)))
    : productOnlyProducts;
  const pagedProducts = scopedProducts.slice(safeOffset, safeOffset + safeLimit);
  const queryIndex = Number.isFinite(Number(metadata?.query_index))
    ? Math.max(0, Math.floor(Number(metadata.query_index)))
    : null;
  const queryTotal = Number.isFinite(Number(metadata?.query_total))
    ? Math.max(0, Math.floor(Number(metadata.query_total)))
    : null;
  const responseProducts = guidanceOnlyDiscovery
    ? pagedProducts.map((product) => normalizeGuidanceDiscoveryProductPdpContract(product))
    : pagedProducts;
  const fillTargetCount = Number(skincareHitDecision?.fill_target_count || 0) || null;
  const fillCompletedCount = Number(skincareHitDecision?.fill_completed_count || 0) || 0;
  const queryExhausted =
    queryIndex != null && queryTotal != null
      ? queryTotal > 0 && queryIndex >= queryTotal - 1
      : responseProducts.length === 0;

  return {
    status: 'success',
    success: true,
    products: responseProducts,
    total: scopedProducts.length,
    page: safePage,
    page_size: responseProducts.length,
    reply: null,
    metadata: {
      query_source: 'agent_products_external_seed_direct',
      fetched_at: new Date().toISOString(),
      source_breakdown: {
        internal_count: 0,
        external_seed_count: responseProducts.length,
        stale_cache_used: false,
        strategy_applied: publicBrandSearchMainline
          ? 'brand_search_external_seed_mainline'
          : 'external_seed_only_direct',
      },
      external_seed_only_requested: true,
      external_seed_rows_fetched: rawProducts.length,
      external_seed_rows_built: scopedProducts.length,
      external_seed_returned_count: responseProducts.length,
      external_seed_exact_title_recall_attempted: shouldRunExactTitleRecall,
      external_seed_exact_title_recall_hit: exactTitleMatches.length > 0,
      external_seed_exact_title_match_count: exactTitleMatches.length,
      raw_result_count: skincareHitDecision?.applied
        ? skincareHitDecision.raw_result_count
        : productOnlyProducts.length,
      products_returned_count: responseProducts.length,
      brand_search_mainline_query: publicBrandSearchMainline,
      ...(guidanceOnlyDiscovery
        ? {
            product_only_applied: requestedProductOnly,
            service_rows_filtered_count: serviceRowsFilteredCount,
            discovery_source_used:
              responseProducts.length > 0 ? 'external_seed_direct' : 'external_seed_direct_exhausted',
            query_step_strength: queryStepStrength,
            decision_mode: decisionMode,
            normalized_intent: metadata?.normalized_intent || null,
            retrieval_query_variants: retrievalQueries,
            retrieval_query_variant_count: retrievalQueries.length,
            retrieval_query_debug: variantQueryDebug,
            lean_sql_applied: useLeanGuidanceSql,
            quality_gate_result: skincareHitDecision?.quality_gate_result || null,
            candidate_origin_counts:
              skincareHitDecision?.candidate_origin_counts ||
              countCandidateOriginBreakdown(responseProducts),
            displayable_candidate_count:
              Number(skincareHitDecision?.displayable_candidate_count || responseProducts.length) || 0,
            fill_target_count: fillTargetCount,
            fill_completed_count: fillTargetCount != null ? fillCompletedCount : null,
            valid_scoping_dropped_count: Number(skincareHitDecision?.valid_scoping_dropped_count || 0) || 0,
            dedupe_dropped_count: Number(skincareHitDecision?.dedupe_dropped_count || 0) || 0,
            selection_diversity: skincareHitDecision?.selection_diversity || null,
            stable_prior_applied: skincareHitDecision?.stable_prior_applied === true,
            stable_prior_source: skincareHitDecision?.stable_prior_source || null,
            fallback_mode: skincareHitDecision?.fallback_mode || 'normal',
            diversity_exception_applied: skincareHitDecision?.diversity_exception_applied === true,
            coverage_limited_after_fill: skincareHitDecision?.coverage_limited_after_fill === true,
            surface_reason: skincareHitDecision?.surface_reason || null,
            query_index: queryIndex,
            query_exhausted: queryExhausted,
            retrieval_budget: retrievalBudget,
          }
        : {}),
      search_decision: {
        contract_version:
          skincareHitDecision?.contract_version || BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
        hit_quality: exactTitleBypassApplied
          ? 'valid_hit'
          : skincareHitDecision?.applied
          ? skincareHitDecision.hit_quality
          : pagedProducts.length > 0
          ? 'valid_hit'
          : 'empty',
        invalid_hit_reason: skincareHitDecision?.applied ? skincareHitDecision.invalid_hit_reason : null,
        exact_title_bypass_applied: exactTitleBypassApplied,
        exact_title_match_count: exactTitleMatches.length,
        query_bucket: skincareHitDecision?.applied ? skincareHitDecision.query_bucket : null,
        query_target_step_family:
          skincareHitDecision?.applied
            ? skincareHitDecision.query_target_step_family
            : targetStepFamily || null,
        topk_bucket_mix: skincareHitDecision?.applied ? skincareHitDecision.topk_bucket_mix : {},
        same_family_topk_count: skincareHitDecision?.applied
          ? skincareHitDecision.same_family_topk_count
          : 0,
        exact_step_topk_count: skincareHitDecision?.applied
          ? skincareHitDecision.exact_step_topk_count
          : 0,
        strong_goal_family_topk_count: skincareHitDecision?.applied
          ? skincareHitDecision.strong_goal_family_topk_count
          : 0,
        supportive_same_family_topk_count: skincareHitDecision?.applied
          ? skincareHitDecision.supportive_same_family_topk_count
          : 0,
        query_step_strength: skincareHitDecision?.applied
          ? skincareHitDecision.query_step_strength
          : queryStepStrength,
        decision_mode: decisionMode,
        normalized_intent: metadata?.normalized_intent || null,
        brand_search_mainline_query: publicBrandSearchMainline,
        retrieval_query_variants: retrievalQueries,
        retrieval_query_variant_count: retrievalQueries.length,
        retrieval_query_debug: variantQueryDebug,
        retrieval_budget: retrievalBudget,
        step_success_class: skincareHitDecision?.applied ? skincareHitDecision.step_success_class : null,
        success_contract_result: skincareHitDecision?.applied
          ? skincareHitDecision.success_contract_result
          : null,
        quality_gate_result: skincareHitDecision?.applied ? skincareHitDecision.quality_gate_result : null,
        candidate_origin_counts: skincareHitDecision?.applied
          ? skincareHitDecision.candidate_origin_counts
          : countCandidateOriginBreakdown(responseProducts),
        candidate_class_counts: mergeSearchCountMaps(
          prefilterCandidateClassCounts,
          skincareHitDecision?.applied ? skincareHitDecision.candidate_class_counts : null,
        ),
        target_relevance_class_counts: mergeSearchCountMaps(
          prefilterCandidateClassCounts,
          skincareHitDecision?.applied ? skincareHitDecision.target_relevance_class_counts : null,
        ),
        noise_drop_counts: mergeSearchCountMaps(
          prefilterNoiseDropCounts,
          skincareHitDecision?.applied ? skincareHitDecision.noise_drop_counts : null,
        ),
        raw_result_count: skincareHitDecision?.applied
          ? skincareHitDecision.raw_result_count
          : productOnlyProducts.length,
        displayable_candidate_count: skincareHitDecision?.applied
          ? skincareHitDecision.displayable_candidate_count
          : responseProducts.length,
        fill_target_count: skincareHitDecision?.applied ? skincareHitDecision.fill_target_count : null,
        fill_completed_count: skincareHitDecision?.applied
          ? skincareHitDecision.fill_completed_count
          : null,
        valid_scoping_dropped_count: skincareHitDecision?.applied
          ? skincareHitDecision.valid_scoping_dropped_count
          : 0,
        dedupe_dropped_count: skincareHitDecision?.applied
          ? skincareHitDecision.dedupe_dropped_count
          : 0,
        selection_diversity: skincareHitDecision?.applied
          ? skincareHitDecision.selection_diversity
          : null,
        stable_prior_applied: skincareHitDecision?.applied
          ? skincareHitDecision.stable_prior_applied === true
          : false,
        stable_prior_source: skincareHitDecision?.applied
          ? skincareHitDecision.stable_prior_source || null
          : null,
        fallback_mode: skincareHitDecision?.applied
          ? skincareHitDecision.fallback_mode || 'normal'
          : 'normal',
        diversity_exception_applied: skincareHitDecision?.applied
          ? skincareHitDecision.diversity_exception_applied === true
          : false,
        coverage_limited_after_fill: skincareHitDecision?.applied
          ? skincareHitDecision.coverage_limited_after_fill === true
          : false,
        surface_reason: skincareHitDecision?.applied
          ? skincareHitDecision.surface_reason || null
          : null,
        products_returned_count: responseProducts.length,
        ...(guidanceOnlyDiscovery
          ? {
              product_only_applied: requestedProductOnly,
              service_rows_filtered_count: serviceRowsFilteredCount,
              discovery_source_used:
                pagedProducts.length > 0 ? 'external_seed_direct' : 'external_seed_direct_exhausted',
              query_index: queryIndex,
              query_exhausted:
                queryIndex != null && queryTotal != null
                  ? queryTotal > 0 && queryIndex >= queryTotal - 1
                  : pagedProducts.length === 0,
            }
          : {}),
        ...(skincareHitDecision?.applied && skincareHitDecision.hit_quality === 'invalid_hit'
          ? { final_decision: 'invalid_hit' }
          : {}),
      },
    },
  };
}

module.exports = {
  finalizeExternalSeedOnlyDirectResponse,
};
