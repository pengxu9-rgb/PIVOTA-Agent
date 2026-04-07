function createFindProductsInvokeSemanticOwnerRuntime(deps = {}) {
  const {
    normalizeAgentSource,
    normalizeRecoTargetStep,
    firstQueryParamValue,
    buildBeautyFamilySupplementQueries,
    normalizeSearchTextForMatch,
    detectBeautyQueryBucket,
    normalizeSearchUiSurface,
    normalizeRecommendationDecisionMode,
    resolveGuidanceSearchStepStrength,
    shouldUseSharedTargetRelevancePipeline,
    buildBeautySkincareHitQualityDecision,
    summarizeSharedCandidateSources,
    scoreSharedBeautyCandidateForTarget,
    BEAUTY_DISCOVERY_MAINLINE_OWNER,
  } = deps;

  const SEMANTIC_OWNER_CACHE_INVALID_OBSERVATION_REASONS = new Set([
    'invalid_hit_all_non_skincare',
    'invalid_hit_no_same_family_candidates',
    'invalid_hit_wrong_beauty_bucket',
    'invalid_hit_adjacent_noise_dominant',
    'invalid_hit_tools_dominant',
  ]);

  const normalizeSemanticOwnerQueryPack = (values = [], limit = 3) =>
    Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ).slice(0, limit);

  const isSemanticOwnerLastResortCacheSourceSummary = (sourceSummary = {}) => {
    const cacheFreshCount = Number(sourceSummary?.source_tier_counts?.cache_fresh || 0) || 0;
    const freshInternalCount = Number(sourceSummary?.source_tier_counts?.fresh_internal || 0) || 0;
    const freshExternalCount = Number(sourceSummary?.source_tier_counts?.fresh_external || 0) || 0;
    const cacheStaleCount = Number(sourceSummary?.source_tier_counts?.cache_stale || 0) || 0;
    const cacheOwnerPaths = Array.isArray(sourceSummary?.cache_owner_paths)
      ? sourceSummary.cache_owner_paths
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean)
      : [];
    const topSourceOwner = String(sourceSummary?.top_candidate_provenance?.source_owner || '')
      .trim()
      .toLowerCase();
    return (
      cacheFreshCount > 0 &&
      freshInternalCount <= 0 &&
      freshExternalCount <= 0 &&
      cacheStaleCount <= 0 &&
      (cacheOwnerPaths.includes('cache_all_platforms') || topSourceOwner === 'cache_all_platforms')
    );
  };

  function prepareInvokeSemanticOwnerContext({
    operation = '',
    semanticOwnerControlled = false,
    strictFindProductsMultiDecision = null,
    metadata = null,
    traceQueryClass = '',
    rawUserQuery = '',
    semanticRewriteResultMeta = null,
    semanticContractMeta = null,
    queryParams = null,
    effectivePayload = null,
  } = {}) {
    const preserveRawSemanticOwnerPrimaryQuery =
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      Boolean(strictFindProductsMultiDecision?.strictConstraintQuery) &&
      normalizeAgentSource(metadata?.source) === 'search' &&
      ['lookup', 'attribute'].includes(String(traceQueryClass || '').trim().toLowerCase());
    const semanticOwnerQueryPack =
      operation === 'find_products_multi' && semanticOwnerControlled
        ? normalizeSemanticOwnerQueryPack(
            preserveRawSemanticOwnerPrimaryQuery
              ? [
                  rawUserQuery,
                  ...(Array.isArray(semanticRewriteResultMeta?.normalized_query_pack)
                    ? semanticRewriteResultMeta.normalized_query_pack
                    : []),
                ]
              : semanticRewriteResultMeta?.normalized_query_pack,
          )
        : [];
    const semanticOwnerQueryTotal = semanticOwnerQueryPack.length;
    const semanticOwnerIngredientHypotheses = Array.isArray(
      semanticContractMeta?.ingredient_hypotheses,
    )
      ? Array.from(
          new Set(
            semanticContractMeta.ingredient_hypotheses
              .map((value) => String(value || '').trim())
              .filter(Boolean),
          ),
        )
      : [];
    const semanticOwnerSupportRoleIds = Array.isArray(semanticContractMeta?.support_role_ids)
      ? Array.from(
          new Set(
            semanticContractMeta.support_role_ids
              .map((value) => String(value || '').trim().toLowerCase())
              .filter(Boolean),
          ),
        )
      : [];
    const semanticOwnerTargetStepFamily = normalizeRecoTargetStep(
      semanticContractMeta?.target_step_family ||
        semanticContractMeta?.primary_step_family ||
        '',
    );
    const semanticOwnerSemanticFamily = String(
      firstQueryParamValue(
        semanticContractMeta?.semantic_family ||
          queryParams?.semantic_family ||
          queryParams?.semanticFamily ||
          effectivePayload?.search?.semantic_family ||
          effectivePayload?.search?.semanticFamily ||
          metadata?.semantic_family,
      ) || '',
    )
      .trim()
      .toLowerCase();
    const semanticOwnerQueryStepStrength = String(
      firstQueryParamValue(
        queryParams?.query_step_strength ||
          queryParams?.queryStepStrength ||
          effectivePayload?.search?.query_step_strength ||
          effectivePayload?.search?.queryStepStrength ||
          metadata?.query_step_strength,
      ) || '',
    ).trim();
    const semanticOwnerMinQueriesBeforeBudgetGuard =
      semanticOwnerQueryTotal > 0
        ? semanticOwnerTargetStepFamily === 'treatment'
          ? Math.min(semanticOwnerQueryTotal, 2)
          : Math.min(semanticOwnerQueryTotal, 3)
        : semanticOwnerTargetStepFamily === 'sunscreen'
          ? 2
          : 1;
    const buildSemanticOwnerSupportRoleQuery = (roleId = '') => {
      const normalizedRoleId = String(roleId || '').trim().toLowerCase();
      if (!normalizedRoleId) return '';
      const oilySignal =
        semanticOwnerSemanticFamily === 'oil_control' ||
        /\b(oily|oil control|sebum|shine control|mattify|mattifying|non-greasy|non greasy)\b/.test(
          `${String(rawUserQuery || '').trim().toLowerCase()} ${semanticOwnerSemanticFamily}`,
        );
      if (normalizedRoleId === 'lightweight_moisturizer') {
        return oilySignal ? 'lightweight moisturizer oily skin' : 'lightweight moisturizer';
      }
      if (normalizedRoleId === 'barrier_moisturizer') return 'barrier moisturizer';
      if (normalizedRoleId === 'daily_sunscreen') {
        return oilySignal ? 'oil control sunscreen' : 'daily sunscreen';
      }
      return normalizedRoleId.replace(/_/g, ' ');
    };
    const semanticOwnerSupportRoleQueryPack = normalizeSemanticOwnerQueryPack(
      semanticOwnerSupportRoleIds.map((roleId) => buildSemanticOwnerSupportRoleQuery(roleId)),
      4,
    );

    const buildSemanticOwnerExternalRescueQueryPack = ({
      ignoredAttempt = null,
      queryAttempts = [],
      fallbackQuery = '',
    } = {}) => {
      const rescueQueries = [];
      if (semanticOwnerTargetStepFamily === 'sunscreen') {
        const rescueBaseQuery = String(rawUserQuery || fallbackQuery || '').trim();
        rescueQueries.push(
          ...buildBeautyFamilySupplementQueries(rescueBaseQuery, {
            target_step_family: semanticOwnerTargetStepFamily,
            semantic_family: semanticOwnerSemanticFamily,
            query_step_strength: semanticOwnerQueryStepStrength,
          }),
        );
        const normalizedRescueBaseQuery = normalizeSearchTextForMatch(rescueBaseQuery);
        const explicitSerumRequested = /\b(?:spf|sunscreen|uv filters)\s+serum\b|\bserum\b/.test(
          normalizedRescueBaseQuery,
        );
        if (!explicitSerumRequested) rescueQueries.push('face sunscreen spf');
      }
      if (semanticOwnerTargetStepFamily === 'treatment') {
        for (const hypothesis of semanticOwnerIngredientHypotheses.slice(0, 2)) {
          rescueQueries.push(`${hypothesis} treatment`, `${hypothesis} serum`);
        }
        if (semanticOwnerSemanticFamily === 'oil_control') {
          rescueQueries.push('oil control treatment', 'oil control serum');
        }
      }
      if (
        String(semanticContractMeta?.planner_mode || '').trim().toLowerCase() ===
          'framework_generic' &&
        semanticOwnerSupportRoleQueryPack.length > 0
      ) {
        rescueQueries.push(...semanticOwnerSupportRoleQueryPack);
      }
      if (ignoredAttempt?.query) rescueQueries.push(ignoredAttempt.query);
      for (const attempt of Array.isArray(queryAttempts) ? [...queryAttempts].reverse() : []) {
        if (
          (
            attempt?.observation_candidate_ignored === true ||
            attempt?.last_resort_cache_candidate === true
          ) &&
          String(attempt?.query || '').trim()
        ) {
          rescueQueries.push(String(attempt.query || '').trim());
        }
      }
      if (fallbackQuery) rescueQueries.push(fallbackQuery);
      return normalizeSemanticOwnerQueryPack(rescueQueries, 6);
    };

    const buildVariantRequestBody = (baseRequestBody, queryValue, queryIndex) => {
      const normalizedQuery = String(queryValue || '').trim();
      if (
        !normalizedQuery ||
        !baseRequestBody ||
        typeof baseRequestBody !== 'object' ||
        Array.isArray(baseRequestBody)
      ) {
        return baseRequestBody;
      }
      if (
        operation === 'find_products_multi' &&
        baseRequestBody.payload &&
        typeof baseRequestBody.payload === 'object' &&
        !Array.isArray(baseRequestBody.payload)
      ) {
        return {
          ...baseRequestBody,
          payload: {
            ...baseRequestBody.payload,
            search: {
              ...(baseRequestBody.payload.search &&
              typeof baseRequestBody.payload.search === 'object' &&
              !Array.isArray(baseRequestBody.payload.search)
                ? baseRequestBody.payload.search
                : {}),
              query: normalizedQuery,
              ...(queryIndex != null ? { query_index: queryIndex } : {}),
              ...(semanticOwnerQueryTotal > 0 ? { query_total: semanticOwnerQueryTotal } : {}),
            },
          },
        };
      }
      if (
        baseRequestBody.search &&
        typeof baseRequestBody.search === 'object' &&
        !Array.isArray(baseRequestBody.search)
      ) {
        return {
          ...baseRequestBody,
          search: {
            ...baseRequestBody.search,
            query: normalizedQuery,
            ...(queryIndex != null ? { query_index: queryIndex } : {}),
            ...(semanticOwnerQueryTotal > 0 ? { query_total: semanticOwnerQueryTotal } : {}),
          },
        };
      }
      if (Object.prototype.hasOwnProperty.call(baseRequestBody, 'query')) {
        return {
          ...baseRequestBody,
          query: normalizedQuery,
          ...(queryIndex != null ? { query_index: queryIndex } : {}),
          ...(semanticOwnerQueryTotal > 0 ? { query_total: semanticOwnerQueryTotal } : {}),
        };
      }
      return baseRequestBody;
    };

    const evaluateSemanticOwnerBeautyAdoption = ({
      upstreamData,
      queryText,
      queryParamsValue,
      requestBodyValue,
    }) => {
      const products = Array.isArray(upstreamData?.products) ? upstreamData.products : [];
      if (!products.length) {
        return {
          adopt: false,
          hitDecision: null,
          beautyScoped: false,
        };
      }
      const requestSearch =
        requestBodyValue?.payload &&
        typeof requestBodyValue.payload === 'object' &&
        !Array.isArray(requestBodyValue.payload) &&
        requestBodyValue.payload.search &&
        typeof requestBodyValue.payload.search === 'object' &&
        !Array.isArray(requestBodyValue.payload.search)
          ? requestBodyValue.payload.search
          : requestBodyValue?.search &&
              typeof requestBodyValue.search === 'object' &&
              !Array.isArray(requestBodyValue.search)
            ? requestBodyValue.search
            : {};
      const responseMeta =
        upstreamData?.metadata &&
        typeof upstreamData.metadata === 'object' &&
        !Array.isArray(upstreamData.metadata)
          ? upstreamData.metadata
          : {};
      const uiSurface = normalizeSearchUiSurface(
        requestSearch?.ui_surface ||
          requestSearch?.uiSurface ||
          responseMeta?.ui_surface ||
          metadata?.ui_surface ||
          queryParamsValue?.ui_surface ||
          queryParamsValue?.uiSurface,
      );
      const guidanceOnlyDiscovery = uiSurface === 'ingredient_plan_guidance_only';
      const targetStepFamily = normalizeRecoTargetStep(
        responseMeta?.query_target_step_family ||
          requestSearch?.target_step_family ||
          requestSearch?.targetStepFamily ||
          queryParamsValue?.target_step_family ||
          queryParamsValue?.targetStepFamily ||
          semanticContractMeta?.target_step_family,
      );
      const queryBucket = detectBeautyQueryBucket(queryText);
      if (queryBucket !== 'skincare' || !targetStepFamily) {
        return {
          adopt: products.length > 0,
          hitDecision: null,
          beautyScoped: false,
        };
      }
      const decisionMode = normalizeRecommendationDecisionMode(
        responseMeta?.decision_mode ||
          requestSearch?.decision_mode ||
          requestSearch?.decisionMode ||
          queryParamsValue?.decision_mode ||
          queryParamsValue?.decisionMode ||
          metadata?.decision_mode ||
          metadata?.decisionMode ||
          (semanticContractMeta?.planner_mode === 'step_aware' ? 'step_aware_reco' : null),
        { guidanceOnlyDiscovery },
      );
      const requestedStepStrength = resolveGuidanceSearchStepStrength(
        responseMeta?.query_step_strength ||
          requestSearch?.query_step_strength ||
          requestSearch?.queryStepStrength ||
          queryParamsValue?.query_step_strength ||
          queryParamsValue?.queryStepStrength,
        queryText,
        targetStepFamily,
      );
      const queryStepStrength = shouldUseSharedTargetRelevancePipeline({
        mode: decisionMode,
        targetStepFamily,
        queryStepStrength: requestedStepStrength,
      })
        ? requestedStepStrength
        : null;
      const hitDecision = buildBeautySkincareHitQualityDecision({
        queryText,
        products,
        queryTargetStepFamily: targetStepFamily,
        guidanceOnlyDiscovery,
        queryStepStrength,
        mode: decisionMode,
      });
      const rankedProducts =
        Array.isArray(hitDecision?.ranked_products) && hitDecision.ranked_products.length > 0
          ? hitDecision.ranked_products
          : products;
      const sourceSummary = summarizeSharedCandidateSources(rankedProducts.slice(0, 5));
      const lastResortCacheCandidate =
        semanticOwnerControlled &&
        hitDecision?.applied === true &&
        hitDecision.hit_quality === 'valid_hit' &&
        isSemanticOwnerLastResortCacheSourceSummary(sourceSummary);
      return {
        adopt:
          hitDecision?.applied === true
            ? hitDecision.hit_quality === 'valid_hit' && !lastResortCacheCandidate
            : products.length > 0,
        hitDecision,
        beautyScoped: true,
        last_resort_cache_candidate: lastResortCacheCandidate,
        source_summary: sourceSummary,
      };
    };

    const describeSemanticOwnerObservationFallback = ({
      upstreamData,
      hitDecision,
      queryText,
    }) => {
      const products = Array.isArray(upstreamData?.products) ? upstreamData.products : [];
      if (!products.length) {
        return {
          score: -1,
          ignore: false,
          ignore_reason: null,
          last_resort_cache_candidate: false,
          source_summary: summarizeSharedCandidateSources([]),
        };
      }
      if (!hitDecision?.applied) {
        const sourceSummary = summarizeSharedCandidateSources(products.slice(0, 5));
        return {
          score: products.length,
          ignore: false,
          ignore_reason: null,
          last_resort_cache_candidate: isSemanticOwnerLastResortCacheSourceSummary(sourceSummary),
          source_summary: sourceSummary,
        };
      }
      const rankedProducts =
        Array.isArray(hitDecision?.ranked_products) && hitDecision.ranked_products.length > 0
          ? hitDecision.ranked_products
          : products;
      const sourceSummary = summarizeSharedCandidateSources(rankedProducts.slice(0, 5));
      const scoredTopRows = rankedProducts.slice(0, 5).map((product) =>
        scoreSharedBeautyCandidateForTarget(product, {
          queryTargetStepFamily: hitDecision?.query_target_step_family || null,
          queryText,
          queryStepStrength: hitDecision?.query_step_strength || null,
          mode: BEAUTY_DISCOVERY_MAINLINE_OWNER,
        }),
      );
      const topScore = Number(scoredTopRows[0]?.score || 0) || 0;
      const meanTopScore =
        scoredTopRows.length > 0
          ? scoredTopRows.reduce((sum, row) => sum + Number(row?.score || 0), 0) /
            scoredTopRows.length
          : 0;
      const pureCacheOnly =
        Number(sourceSummary.source_tier_counts?.cache_fresh || 0) > 0 &&
        Number(sourceSummary.source_tier_counts?.fresh_internal || 0) <= 0 &&
        Number(sourceSummary.source_tier_counts?.fresh_external || 0) <= 0 &&
        Number(sourceSummary.source_tier_counts?.cache_stale || 0) <= 0;
      const normalizedInvalidReason = String(hitDecision?.invalid_hit_reason || '')
        .trim()
        .toLowerCase();
      const ignore =
        hitDecision?.hit_quality === 'invalid_hit' &&
        pureCacheOnly &&
        SEMANTIC_OWNER_CACHE_INVALID_OBSERVATION_REASONS.has(normalizedInvalidReason);
      const lastResortCacheCandidate =
        hitDecision?.hit_quality === 'valid_hit' &&
        isSemanticOwnerLastResortCacheSourceSummary(sourceSummary);
      const score =
        Number(hitDecision.exact_step_topk_count || 0) * 1000 +
        Number(hitDecision.strong_goal_family_topk_count || 0) * 100 +
        Number(hitDecision.supportive_same_family_topk_count || 0) * 25 +
        Number(hitDecision.same_family_topk_count || 0) * 10 +
        Number(hitDecision.raw_result_count || products.length || 0) +
        topScore * 4 +
        meanTopScore +
        Number(sourceSummary.source_tier_counts?.fresh_internal || 0) * 18 +
        Number(sourceSummary.source_tier_counts?.fresh_external || 0) * 12 -
        Number(sourceSummary.source_tier_counts?.cache_fresh || 0) * 24 -
        Number(sourceSummary.source_tier_counts?.cache_stale || 0) * 40 -
        Number(sourceSummary.source_quality_counts?.degraded || 0) * 24;
      return {
        score: ignore ? -1 : score,
        ignore,
        ignore_reason: ignore ? 'pure_cache_invalid_hit' : null,
        last_resort_cache_candidate: lastResortCacheCandidate,
        source_summary: sourceSummary,
      };
    };

    return {
      semanticOwnerQueryPack,
      semanticOwnerQueryTotal,
      semanticOwnerSupportRoleQueryPack,
      semanticOwnerTargetStepFamily,
      semanticOwnerSemanticFamily,
      semanticOwnerQueryStepStrength,
      semanticOwnerMinQueriesBeforeBudgetGuard,
      buildSemanticOwnerExternalRescueQueryPack,
      buildVariantRequestBody,
      evaluateSemanticOwnerBeautyAdoption,
      describeSemanticOwnerObservationFallback,
    };
  }

  return {
    prepareInvokeSemanticOwnerContext,
  };
}

module.exports = {
  createFindProductsInvokeSemanticOwnerRuntime,
};
