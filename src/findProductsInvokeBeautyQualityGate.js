function createFindProductsInvokeBeautyQualityGateRuntime(deps = {}) {
  const {
    firstQueryParamValue,
    normalizeSearchUiSurface,
    normalizeRecommendationDecisionMode,
    normalizeRecoTargetStep,
    parseQueryBoolean,
    parseQueryNumber,
    shouldUseSharedTargetRelevancePipeline,
    resolveGuidanceSearchStepStrength,
    shouldUseBeautyMainlineContractAuthority,
    buildBeautySkincareHitQualityDecision,
    buildSearchDecisionProductKey,
    buildGuidanceOnlySearchDecisionPatches,
    buildFashionConstraintMetadata,
    mergeSearchCountMaps,
    BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
  } = deps;

  function applyInvokeBeautyQualityGate({
    reqQuery = null,
    queryParams = null,
    existingMeta = null,
    metadata = null,
    effectivePayload = null,
    operation = '',
    strictBeautyDirectSearch = false,
    semanticOwnerControlled = false,
    queryText = '',
    enriched = null,
    upstreamData = null,
  } = {}) {
    let nextEnriched = enriched;
    let nextExistingMeta = existingMeta;

    const uiSurface = normalizeSearchUiSurface(
      nextExistingMeta?.ui_surface ||
        firstQueryParamValue(reqQuery?.ui_surface || reqQuery?.uiSurface) ||
        firstQueryParamValue(queryParams?.ui_surface || queryParams?.uiSurface),
    );
    const guidanceOnlyDiscovery = uiSurface === 'ingredient_plan_guidance_only';
    const requestedDecisionMode = normalizeRecommendationDecisionMode(
      firstQueryParamValue(
        reqQuery?.decision_mode ||
          reqQuery?.decisionMode ||
          queryParams?.decision_mode ||
          queryParams?.decisionMode ||
          nextExistingMeta?.decision_mode,
      ),
      { guidanceOnlyDiscovery },
    );
    const requestedTargetStepFamily = normalizeRecoTargetStep(
      nextExistingMeta?.query_target_step_family ||
        firstQueryParamValue(
          reqQuery?.target_step_family || reqQuery?.targetStepFamily,
        ) ||
        firstQueryParamValue(
          queryParams?.target_step_family || queryParams?.targetStepFamily,
        ),
    );
    const requestedProductOnly = parseQueryBoolean(
      reqQuery?.product_only ??
        reqQuery?.productOnly ??
        queryParams?.product_only ??
        queryParams?.productOnly,
    );
    const requestedAllowExternalSeed = parseQueryBoolean(
      reqQuery?.allow_external_seed ??
        reqQuery?.allowExternalSeed ??
        queryParams?.allow_external_seed ??
        queryParams?.allowExternalSeed,
    );
    const requestedQueryIndex = parseQueryNumber(
      reqQuery?.query_index ??
        reqQuery?.queryIndex ??
        queryParams?.query_index ??
        queryParams?.queryIndex,
    );
    const requestedQueryTotal = parseQueryNumber(
      reqQuery?.query_total ??
        reqQuery?.queryTotal ??
        queryParams?.query_total ??
        queryParams?.queryTotal,
    );
    const requestedQueryStepStrength = shouldUseSharedTargetRelevancePipeline({
      mode: requestedDecisionMode,
      targetStepFamily: requestedTargetStepFamily,
      queryStepStrength: resolveGuidanceSearchStepStrength(
        reqQuery?.query_step_strength ??
          reqQuery?.queryStepStrength ??
          queryParams?.query_step_strength ??
          queryParams?.queryStepStrength ??
          nextExistingMeta?.query_step_strength,
        queryText,
        requestedTargetStepFamily,
      ),
    })
      ? resolveGuidanceSearchStepStrength(
          reqQuery?.query_step_strength ??
            reqQuery?.queryStepStrength ??
            queryParams?.query_step_strength ??
            queryParams?.queryStepStrength ??
            nextExistingMeta?.query_step_strength,
          queryText,
          requestedTargetStepFamily,
        )
      : null;
    const requestedExternalSeedStrategy = String(
      firstQueryParamValue(
        reqQuery?.external_seed_strategy ||
          reqQuery?.externalSeedStrategy ||
          queryParams?.external_seed_strategy ||
          queryParams?.externalSeedStrategy,
      ) || '',
    ).trim();
    const strictResolvedContract = String(
      nextExistingMeta?.contract_bridge?.resolved_contract || '',
    )
      .trim()
      .toLowerCase();
    const beautyDecisionOwner = String(nextExistingMeta?.decision_owner || '')
      .trim()
      .toLowerCase();
    const beautySemanticOwner = String(nextExistingMeta?.semantic_owner || '')
      .trim()
      .toLowerCase();
    const beautyMainlineAuthorityActive =
      shouldUseBeautyMainlineContractAuthority({
        operation,
        strictBeautyDirectSearch,
        semanticOwnerControlled,
        beautyDecisionOwner,
        beautySemanticOwner,
      });
    const observationOnlyBeautySkincareHitQualityGate =
      semanticOwnerControlled ||
      beautyDecisionOwner === 'shopping_agent_beauty_mainline' ||
      beautySemanticOwner === 'shopping_agent_beauty_mainline' ||
      strictResolvedContract === 'agent_v1_search_beauty_mainline';
    const bypassBeautySkincareHitQualityGate =
      strictResolvedContract === 'shop_invoke_strict' ||
      observationOnlyBeautySkincareHitQualityGate;
    const rawProductsBeforeQualityGate = Array.isArray(nextEnriched?.products)
      ? nextEnriched.products
      : [];
    const strictContractPolicyAuthoritative =
      strictResolvedContract === 'shop_invoke_strict' ||
      nextExistingMeta?.strict_constraint_query === true;
    const rawProductsForQualityGate = Array.isArray(upstreamData?.products)
      ? strictContractPolicyAuthoritative
        ? rawProductsBeforeQualityGate
        : upstreamData.products
      : rawProductsBeforeQualityGate;
    const skincareHitDecision =
      rawProductsForQualityGate.length > 0 || !bypassBeautySkincareHitQualityGate
        ? buildBeautySkincareHitQualityDecision({
            queryText,
            products: rawProductsForQualityGate,
            queryTargetStepFamily: requestedTargetStepFamily,
            guidanceOnlyDiscovery,
            queryStepStrength: requestedQueryStepStrength,
            mode: requestedDecisionMode,
          })
        : { applied: false, hit_quality: null };
    const promoteObservedValidBeautyHit =
      observationOnlyBeautySkincareHitQualityGate &&
      skincareHitDecision?.hit_quality === 'valid_hit' &&
      skincareHitDecision?.success_contract_result?.satisfied === true;
    const effectiveObservationOnlyBeautySkincareHitQualityGate =
      observationOnlyBeautySkincareHitQualityGate && !promoteObservedValidBeautyHit;

    if (skincareHitDecision.applied) {
      const existingSearchDecision =
        nextExistingMeta &&
        typeof nextExistingMeta === 'object' &&
        !Array.isArray(nextExistingMeta) &&
        nextExistingMeta.search_decision &&
        typeof nextExistingMeta.search_decision === 'object'
          ? nextExistingMeta.search_decision
          : {};
      const validProductKeys = new Set(
        (
          Array.isArray(skincareHitDecision.valid_products)
            ? skincareHitDecision.valid_products
            : []
        )
          .map((product) => buildSearchDecisionProductKey(product))
          .filter(Boolean),
      );
      const blockingBeautySkincareHitQualityGate =
        !effectiveObservationOnlyBeautySkincareHitQualityGate &&
        skincareHitDecision.hit_quality === 'invalid_hit';
      const policyScopedValidProducts =
        skincareHitDecision.hit_quality === 'valid_hit'
          ? rawProductsBeforeQualityGate.filter((product) => {
              const productKey = buildSearchDecisionProductKey(product);
              return productKey && validProductKeys.has(productKey);
            })
          : [];
      const rankedProductsForReturn = Array.isArray(
        skincareHitDecision.ranked_products,
      )
        ? skincareHitDecision.ranked_products
        : [];
      const nextProducts = effectiveObservationOnlyBeautySkincareHitQualityGate
        ? rankedProductsForReturn.length > 0
          ? rankedProductsForReturn
          : rawProductsBeforeQualityGate.length > 0
            ? rawProductsBeforeQualityGate
            : rawProductsForQualityGate
        : skincareHitDecision.hit_quality === 'valid_hit'
          ? Array.isArray(skincareHitDecision.valid_products) &&
            skincareHitDecision.valid_products.length > 0
            ? skincareHitDecision.valid_products
            : policyScopedValidProducts.length > 0
              ? policyScopedValidProducts
              : []
          : [];
      const guidanceOnlyPatches = buildGuidanceOnlySearchDecisionPatches({
        guidanceOnlyDiscovery,
        requestedProductOnly,
        requestedAllowExternalSeed,
        requestedExternalSeedStrategy,
        requestedQueryIndex,
        requestedQueryTotal,
        requestedDecisionMode,
        requestedTargetStepFamily,
        requestedQueryStepStrength,
        existingMeta: nextExistingMeta,
        rawProductsForQualityGate,
        nextProducts,
        hitDecision: skincareHitDecision,
      });
      const nextSearchDecision = {
        ...existingSearchDecision,
        ...(effectiveObservationOnlyBeautySkincareHitQualityGate
          ? {
              quality_gate_mode: 'observe_only',
              hit_quality_observation: {
                contract_version:
                  skincareHitDecision.contract_version ||
                  BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
                hit_quality: skincareHitDecision.hit_quality,
                invalid_hit_reason: skincareHitDecision.invalid_hit_reason,
                query_bucket: skincareHitDecision.query_bucket,
                query_target_step_family:
                  skincareHitDecision.query_target_step_family,
                topk_bucket_mix: skincareHitDecision.topk_bucket_mix,
                same_family_topk_count:
                  skincareHitDecision.same_family_topk_count,
                exact_step_topk_count:
                  skincareHitDecision.exact_step_topk_count,
                strong_goal_family_topk_count:
                  skincareHitDecision.strong_goal_family_topk_count,
                supportive_same_family_topk_count:
                  skincareHitDecision.supportive_same_family_topk_count,
                query_step_strength:
                  skincareHitDecision.query_step_strength ||
                  requestedQueryStepStrength,
                decision_mode: requestedDecisionMode,
                step_success_class:
                  skincareHitDecision.step_success_class || null,
                success_contract_result:
                  skincareHitDecision.success_contract_result || null,
                candidate_class_counts: mergeSearchCountMaps(
                  existingSearchDecision?.hit_quality_observation
                    ?.candidate_class_counts,
                  skincareHitDecision.candidate_class_counts,
                ),
                target_relevance_class_counts: mergeSearchCountMaps(
                  existingSearchDecision?.hit_quality_observation
                    ?.target_relevance_class_counts,
                  skincareHitDecision.target_relevance_class_counts,
                ),
                noise_drop_counts: mergeSearchCountMaps(
                  existingSearchDecision?.hit_quality_observation
                    ?.noise_drop_counts,
                  skincareHitDecision.noise_drop_counts,
                ),
                raw_result_count: skincareHitDecision.raw_result_count,
                products_returned_count:
                  skincareHitDecision.products_returned_count,
              },
            }
          : {
              contract_version:
                skincareHitDecision.contract_version ||
                BEAUTY_SEARCH_DECISION_CONTRACT_VERSION,
              hit_quality: skincareHitDecision.hit_quality,
              invalid_hit_reason: skincareHitDecision.invalid_hit_reason,
              query_bucket: skincareHitDecision.query_bucket,
              query_target_step_family:
                skincareHitDecision.query_target_step_family,
              topk_bucket_mix: skincareHitDecision.topk_bucket_mix,
              same_family_topk_count:
                skincareHitDecision.same_family_topk_count,
              exact_step_topk_count:
                skincareHitDecision.exact_step_topk_count,
              strong_goal_family_topk_count:
                skincareHitDecision.strong_goal_family_topk_count,
              supportive_same_family_topk_count:
                skincareHitDecision.supportive_same_family_topk_count,
              query_step_strength:
                skincareHitDecision.query_step_strength ||
                requestedQueryStepStrength,
              decision_mode: requestedDecisionMode,
              step_success_class:
                skincareHitDecision.step_success_class || null,
              success_contract_result:
                skincareHitDecision.success_contract_result || null,
              candidate_class_counts: mergeSearchCountMaps(
                existingSearchDecision.candidate_class_counts,
                skincareHitDecision.candidate_class_counts,
              ),
              target_relevance_class_counts: mergeSearchCountMaps(
                existingSearchDecision.target_relevance_class_counts,
                skincareHitDecision.target_relevance_class_counts,
              ),
              noise_drop_counts: mergeSearchCountMaps(
                existingSearchDecision.noise_drop_counts,
                skincareHitDecision.noise_drop_counts,
              ),
              raw_result_count: skincareHitDecision.raw_result_count,
              products_returned_count:
                skincareHitDecision.products_returned_count,
            }),
        ...guidanceOnlyPatches.searchDecisionPatch,
        ...(blockingBeautySkincareHitQualityGate
          ? { final_decision: 'invalid_hit' }
          : {}),
      };
      const refreshedFashionConstraintMetadata =
        nextProducts.length > 0 &&
        (Array.isArray(nextExistingMeta?.visible_category_intents) ||
          Array.isArray(nextExistingMeta?.visible_attribute_intents) ||
          Array.isArray(nextExistingMeta?.visible_option_intents))
          ? buildFashionConstraintMetadata({
              rawQuery: queryText,
              products: nextProducts,
              existingMetadata: nextExistingMeta,
            })
          : {};
      nextEnriched = {
        ...nextEnriched,
        products: nextProducts,
        total: nextProducts.length,
        metadata: {
          ...nextExistingMeta,
          ...refreshedFashionConstraintMetadata,
          raw_result_count: skincareHitDecision.raw_result_count,
          products_returned_count: skincareHitDecision.products_returned_count,
          ...guidanceOnlyPatches.metadataPatch,
          search_decision: nextSearchDecision,
        },
      };
      nextExistingMeta =
        nextEnriched &&
        typeof nextEnriched === 'object' &&
        !Array.isArray(nextEnriched) &&
        nextEnriched.metadata
          ? nextEnriched.metadata
          : {};
    }

    return {
      enriched: nextEnriched,
      existingMeta: nextExistingMeta,
      requestedTargetStepFamily,
      beautyMainlineAuthorityActive,
      effectiveObservationOnlyBeautySkincareHitQualityGate,
      rawProductsForQualityGate,
      skincareHitDecision,
      beautyDecisionOwner,
      beautySemanticOwner,
    };
  }

  return {
    applyInvokeBeautyQualityGate,
  };
}

module.exports = {
  createFindProductsInvokeBeautyQualityGateRuntime,
};
