function createFindProductsInvokeSemanticOwnerExecutionRuntime(deps = {}) {
  const {
    FPM_GATE_SIMPLIFY_V1,
    FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS,
    SEARCH_LIMIT_MAX,
  } = deps;

  async function runInvokeSemanticOwnerExecution({
    operation = '',
    semanticOwnerControlled = false,
    semanticOwnerQueryPack = [],
    semanticOwnerQueryTotal = 0,
    semanticOwnerTargetStepFamily = '',
    semanticOwnerSemanticFamily = '',
    semanticOwnerQueryStepStrength = '',
    semanticOwnerMinQueriesBeforeBudgetGuard = 0,
    response = null,
    upstreamData = null,
    queryParams = null,
    requestBody = null,
    axiosConfig = null,
    strictCommerceFindProductsMulti = false,
    strictBeautyDirectSearch = false,
    routeMethod = 'GET',
    url = '',
    buildQueryString = null,
    normalizeUpstreamData = null,
    callTrackedUpstream = null,
    buildVariantRequestBody = null,
    evaluateSemanticOwnerBeautyAdoption = null,
    describeSemanticOwnerObservationFallback = null,
    buildSemanticOwnerExternalRescueQueryPack = null,
    fetchExternalSeedSupplementFromBackend = null,
    normalizeAgentProductsListResponse = null,
    checkoutToken = null,
    metadata = null,
    effectivePayload = null,
    getFpmRemainingBudgetMs = null,
    logger = null,
    rawUserQuery = '',
  } = {}) {
    const primarySemanticOwnerAdoption = evaluateSemanticOwnerBeautyAdoption({
      upstreamData,
      queryText: String(queryParams?.query || '').trim() || semanticOwnerQueryPack[0] || '',
      queryParamsValue: queryParams,
      requestBodyValue: requestBody,
    });
    const primarySemanticOwnerObservation = describeSemanticOwnerObservationFallback({
      upstreamData,
      hitDecision: primarySemanticOwnerAdoption.hitDecision,
      queryText: String(queryParams?.query || '').trim() || semanticOwnerQueryPack[0] || '',
    });
    let semanticOwnerAdoptedByValidHit = primarySemanticOwnerAdoption.adopt === true;
    let semanticOwnerIgnoredObservationCandidate =
      semanticOwnerControlled && primarySemanticOwnerObservation.ignore === true;
    let semanticOwnerDeferredLastResortCache =
      semanticOwnerControlled &&
      primarySemanticOwnerAdoption.last_resort_cache_candidate === true;
    let semanticOwnerLastResortCacheApplied = false;
    let semanticOwnerLastResortCacheQuery = null;
    let semanticOwnerCacheSourceIsolated = false;
    let semanticOwnerCacheSourceIsolationReason = null;
    let semanticOwnerExternalRescueQueriesAttempted = [];
    let semanticOwnerObservationFallback =
      semanticOwnerControlled &&
      primarySemanticOwnerAdoption.adopt !== true &&
      Array.isArray(upstreamData?.products) &&
      upstreamData.products.length > 0 &&
      primarySemanticOwnerObservation.ignore !== true
        ? {
            score: primarySemanticOwnerObservation.score,
            response,
            upstreamData,
            queryParams,
            requestBody,
            queryIndex: 0,
            last_resort_cache_candidate:
              primarySemanticOwnerObservation.last_resort_cache_candidate === true,
          }
        : null;
    let semanticOwnerQueryAttempts =
      semanticOwnerQueryPack.length > 0
        ? [
            {
              query: String(queryParams?.query || '').trim() || semanticOwnerQueryPack[0],
              query_index: 0,
              query_total: semanticOwnerQueryTotal,
              result_count: Array.isArray(upstreamData?.products)
                ? upstreamData.products.length
                : 0,
              adopted: primarySemanticOwnerAdoption.adopt,
              ...(primarySemanticOwnerAdoption.hitDecision
                ? {
                    hit_quality:
                      primarySemanticOwnerAdoption.hitDecision.hit_quality || null,
                    invalid_hit_reason:
                      primarySemanticOwnerAdoption.hitDecision.invalid_hit_reason || null,
                    post_quality_result_count: Array.isArray(
                      primarySemanticOwnerAdoption.hitDecision.valid_products,
                    )
                      ? primarySemanticOwnerAdoption.hitDecision.valid_products.length
                      : 0,
                    last_resort_cache_candidate:
                      primarySemanticOwnerAdoption.last_resort_cache_candidate === true,
                    observation_candidate_ignored:
                      primarySemanticOwnerObservation.ignore === true,
                    observation_ignore_reason:
                      primarySemanticOwnerObservation.ignore_reason || null,
                  }
                : {}),
            },
          ]
        : [];

    if (
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      semanticOwnerQueryPack.length > 1 &&
      response?.status >= 200 &&
      response?.status < 300 &&
      primarySemanticOwnerAdoption.adopt !== true
    ) {
      const semanticOwnerRetryLimit = Math.min(
        Math.max(Number(queryParams?.limit || queryParams?.page_size || 20) || 20, 1) * 2,
        80,
      );
      for (let queryIndex = 1; queryIndex < semanticOwnerQueryPack.length; queryIndex += 1) {
        const remainingBudgetForSemanticOwner =
          typeof getFpmRemainingBudgetMs === 'function' ? getFpmRemainingBudgetMs() : 0;
        const allowRequiredSemanticOwnerRetry =
          queryIndex < semanticOwnerMinQueriesBeforeBudgetGuard &&
          (
            semanticOwnerTargetStepFamily === 'treatment' ||
            remainingBudgetForSemanticOwner >=
              (semanticOwnerIgnoredObservationCandidate ? 100 : 250)
          );
        if (
          FPM_GATE_SIMPLIFY_V1 &&
          remainingBudgetForSemanticOwner < FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS &&
          !allowRequiredSemanticOwnerRetry
        ) {
          semanticOwnerQueryAttempts.push({
            query: semanticOwnerQueryPack[queryIndex],
            query_index: queryIndex,
            query_total: semanticOwnerQueryTotal,
            result_count: 0,
            adopted: false,
            skipped_reason: 'budget_guard',
          });
          break;
        }
        const variantQueryParams = {
          ...queryParams,
          query: semanticOwnerQueryPack[queryIndex],
          query_index: queryIndex,
          query_total: semanticOwnerQueryTotal,
          offset: 0,
          limit: semanticOwnerRetryLimit,
        };
        const variantRequestBody = buildVariantRequestBody(
          requestBody,
          semanticOwnerQueryPack[queryIndex],
          queryIndex,
        );
        const variantQueryString =
          strictCommerceFindProductsMulti &&
          operation === 'find_products_multi' &&
          !strictBeautyDirectSearch
            ? ''
            : buildQueryString(variantQueryParams);
        const variantAxiosConfig = {
          ...axiosConfig,
          url: `${url}${variantQueryString}`,
          ...((strictBeautyDirectSearch ? 'GET' : routeMethod) !== 'GET' &&
          Object.keys(variantRequestBody || {}).length > 0
            ? { data: variantRequestBody }
            : {}),
        };
        let variantResponse = null;
        let variantUpstreamData = null;
        try {
          variantResponse = await callTrackedUpstream(operation, variantAxiosConfig);
          variantUpstreamData = normalizeUpstreamData({
            responseBody: variantResponse.data,
            queryParamsOverride: variantQueryParams,
            requestBodyOverride: variantRequestBody,
          });
        } catch (semanticOwnerRetryErr) {
          semanticOwnerQueryAttempts.push({
            query: semanticOwnerQueryPack[queryIndex],
            query_index: queryIndex,
            query_total: semanticOwnerQueryTotal,
            result_count: 0,
            adopted: false,
            error: String(semanticOwnerRetryErr?.message || semanticOwnerRetryErr),
          });
          continue;
        }
        const variantProducts = Array.isArray(variantUpstreamData?.products)
          ? variantUpstreamData.products
          : [];
        const variantAdoption = evaluateSemanticOwnerBeautyAdoption({
          upstreamData: variantUpstreamData,
          queryText: semanticOwnerQueryPack[queryIndex],
          queryParamsValue: variantQueryParams,
          requestBodyValue: variantRequestBody,
        });
        const shouldAdoptVariant =
          variantResponse?.status >= 200 &&
          variantResponse?.status < 300 &&
          variantProducts.length > 0 &&
          variantAdoption.adopt === true;
        const variantObservationFallback =
          semanticOwnerControlled &&
          !shouldAdoptVariant &&
          variantProducts.length > 0
            ? describeSemanticOwnerObservationFallback({
                upstreamData: variantUpstreamData,
                hitDecision: variantAdoption.hitDecision,
                queryText: semanticOwnerQueryPack[queryIndex],
              })
            : null;
        if (
          semanticOwnerControlled &&
          !shouldAdoptVariant &&
          variantProducts.length > 0
        ) {
          const fallbackCandidate = variantObservationFallback;
          if (fallbackCandidate.ignore) {
            semanticOwnerIgnoredObservationCandidate = true;
          }
          if (variantAdoption.last_resort_cache_candidate === true) {
            semanticOwnerDeferredLastResortCache = true;
          }
          if (
            !fallbackCandidate.ignore &&
            (
              !semanticOwnerObservationFallback ||
              fallbackCandidate.score > semanticOwnerObservationFallback.score
            )
          ) {
            semanticOwnerObservationFallback = {
              score: fallbackCandidate.score,
              response: variantResponse,
              upstreamData: variantUpstreamData,
              queryParams: variantQueryParams,
              requestBody: variantRequestBody,
              queryIndex,
              last_resort_cache_candidate:
                fallbackCandidate.last_resort_cache_candidate === true,
            };
          }
        }
        semanticOwnerQueryAttempts.push({
          query: semanticOwnerQueryPack[queryIndex],
          query_index: queryIndex,
          query_total: semanticOwnerQueryTotal,
          result_count: variantProducts.length,
          adopted: shouldAdoptVariant,
          ...(variantAdoption.hitDecision
            ? {
                hit_quality: variantAdoption.hitDecision.hit_quality || null,
                invalid_hit_reason:
                  variantAdoption.hitDecision.invalid_hit_reason || null,
                post_quality_result_count: Array.isArray(
                  variantAdoption.hitDecision.valid_products,
                )
                  ? variantAdoption.hitDecision.valid_products.length
                  : 0,
                last_resort_cache_candidate:
                  variantAdoption.last_resort_cache_candidate === true,
                observation_candidate_ignored:
                  variantObservationFallback?.ignore === true,
                observation_ignore_reason:
                  variantObservationFallback?.ignore_reason || null,
              }
            : {}),
        });
        if (shouldAdoptVariant) {
          semanticOwnerAdoptedByValidHit = true;
          response = variantResponse;
          upstreamData = variantUpstreamData;
          queryParams = variantQueryParams;
          requestBody = variantRequestBody;
          axiosConfig.url = variantAxiosConfig.url;
          if ((strictBeautyDirectSearch ? 'GET' : routeMethod) !== 'GET') {
            axiosConfig.data = variantRequestBody;
          } else if (Object.prototype.hasOwnProperty.call(axiosConfig, 'data')) {
            delete axiosConfig.data;
          }
          break;
        }
      }
    }

    if (
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      !semanticOwnerAdoptedByValidHit &&
      (
        semanticOwnerIgnoredObservationCandidate ||
        semanticOwnerDeferredLastResortCache ||
        semanticOwnerQueryAttempts.every(
          (attempt) =>
            attempt &&
            !attempt.adopted &&
            !attempt.skipped_reason &&
            !attempt.error &&
            Number(attempt.result_count || 0) <= 0,
        )
      ) &&
      semanticOwnerQueryPack.length > 0
    ) {
      const semanticOwnerExternalRescueAttempt = [...semanticOwnerQueryAttempts]
        .reverse()
        .find(
          (attempt) =>
            attempt &&
            (
              attempt.observation_candidate_ignored === true ||
              attempt.last_resort_cache_candidate === true
            ) &&
            String(attempt.query || '').trim(),
        );
      const semanticOwnerExternalRescueQueries =
        buildSemanticOwnerExternalRescueQueryPack({
          ignoredAttempt: semanticOwnerExternalRescueAttempt,
          queryAttempts: semanticOwnerQueryAttempts,
          fallbackQuery: String(
            queryParams?.query ||
              semanticOwnerQueryPack[semanticOwnerQueryPack.length - 1] ||
              rawUserQuery ||
              '',
          ).trim(),
        });
      if (semanticOwnerExternalRescueQueries.length > 0) {
        semanticOwnerExternalRescueQueriesAttempted = semanticOwnerExternalRescueQueries;
        const rescueQueryParams = {
          ...(queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
            ? queryParams
            : {}),
          allow_external_seed: true,
          allow_stale_cache: false,
          external_seed_strategy: 'unified_relevance',
          ...(semanticOwnerTargetStepFamily
            ? { target_step_family: semanticOwnerTargetStepFamily }
            : {}),
          ...(semanticOwnerSemanticFamily
            ? { semantic_family: semanticOwnerSemanticFamily }
            : {}),
          ...(semanticOwnerQueryStepStrength
            ? { query_step_strength: semanticOwnerQueryStepStrength }
            : {}),
        };
        const semanticOwnerExternalRescuePage = Math.max(
          1,
          Number(queryParams?.page || effectivePayload?.search?.page || 1) || 1,
        );
        const rescueLimit = Math.min(
          Math.max(Number(queryParams?.limit || queryParams?.page_size || 20) || 20, 1),
          SEARCH_LIMIT_MAX,
        );
        let semanticOwnerExternalRescueApplied = false;
        for (const semanticOwnerExternalRescueQuery of semanticOwnerExternalRescueQueries) {
          try {
            const externalRescue = await fetchExternalSeedSupplementFromBackend({
              queryParams: {
                ...rescueQueryParams,
                query: semanticOwnerExternalRescueQuery,
              },
              checkoutToken,
              neededCount: rescueLimit,
              source: metadata?.source,
            });
            const rescueProducts = Array.isArray(externalRescue?.products)
              ? externalRescue.products
              : [];
            if (rescueProducts.length > 0) {
              const rescueBody = normalizeAgentProductsListResponse(
                {
                  status: 'success',
                  success: true,
                  products: rescueProducts,
                  total: rescueProducts.length,
                  page: semanticOwnerExternalRescuePage,
                  page_size: rescueProducts.length,
                  reply: null,
                  metadata: {
                    query_source: 'agent_products_search',
                    semantic_owner_external_rescue_applied: true,
                    semantic_owner_external_rescue_query:
                      semanticOwnerExternalRescueQuery,
                    semantic_owner_external_rescue_queries_attempted:
                      semanticOwnerExternalRescueQueries,
                    external_seed_rows_fetched: Math.max(
                      rescueProducts.length,
                      Number(externalRescue?.metadata?.external_seed_rows_raw || 0) || 0,
                    ),
                    external_seed_rows_built: rescueProducts.length,
                    external_seed_returned_count: rescueProducts.length,
                    source_breakdown: {
                      internal_count: 0,
                      external_seed_count: rescueProducts.length,
                      stale_cache_used: false,
                      strategy_applied: 'semantic_owner_external_rescue',
                    },
                  },
                },
                {
                  limit: rescueLimit,
                  offset: 0,
                },
              );
              const rescueResponse = { status: 200, data: rescueBody };
              const rescueQueryParamsApplied = {
                ...rescueQueryParams,
                query: semanticOwnerExternalRescueQuery,
              };
              const rescueUpstreamData = normalizeUpstreamData({
                responseBody: rescueBody,
                queryParamsOverride: rescueQueryParamsApplied,
                requestBodyOverride: requestBody,
              });
              const rescueAdoption = evaluateSemanticOwnerBeautyAdoption({
                upstreamData: rescueUpstreamData,
                queryText: semanticOwnerExternalRescueQuery,
                queryParamsValue: rescueQueryParamsApplied,
                requestBodyValue: requestBody,
              });
              const rescueObservation = describeSemanticOwnerObservationFallback({
                upstreamData: rescueUpstreamData,
                hitDecision: rescueAdoption.hitDecision,
                queryText: semanticOwnerExternalRescueQuery,
              });
              const shouldPreferDeferredLastResortCache =
                semanticOwnerObservationFallback?.last_resort_cache_candidate === true &&
                Number(semanticOwnerObservationFallback?.score || -1) >=
                  Number(rescueObservation?.score || -1);
              if (shouldPreferDeferredLastResortCache) {
                continue;
              }
              response = rescueResponse;
              upstreamData = rescueUpstreamData;
              queryParams = rescueQueryParamsApplied;
              const chosenAttempt = semanticOwnerQueryAttempts.find(
                (attempt) =>
                  attempt &&
                  String(attempt.query || '').trim() ===
                    semanticOwnerExternalRescueQuery &&
                  !attempt.skipped_reason &&
                  !attempt.error,
              );
              if (chosenAttempt && chosenAttempt.adopted !== true) {
                chosenAttempt.adopted = true;
                chosenAttempt.adoption_mode = 'external_seed_rescue';
              } else if (!chosenAttempt) {
                const matchedQueryIndex = semanticOwnerQueryPack.findIndex(
                  (query) =>
                    String(query || '').trim() === semanticOwnerExternalRescueQuery,
                );
                semanticOwnerQueryAttempts.push({
                  query: semanticOwnerExternalRescueQuery,
                  query_index:
                    matchedQueryIndex >= 0
                      ? matchedQueryIndex
                      : semanticOwnerQueryAttempts.length,
                  query_total: semanticOwnerQueryTotal,
                  result_count: rescueProducts.length,
                  adopted: true,
                  adoption_mode: 'external_seed_rescue',
                  rescue_only: true,
                });
              }
              semanticOwnerAdoptedByValidHit = true;
              semanticOwnerObservationFallback = null;
              semanticOwnerExternalRescueApplied = true;
              break;
            }
          } catch (semanticOwnerExternalRescueErr) {
            logger?.warn(
              {
                err:
                  semanticOwnerExternalRescueErr?.message ||
                  String(semanticOwnerExternalRescueErr),
                query: semanticOwnerExternalRescueQuery,
              },
              'semantic-owner external rescue failed after pure cache invalid query pack',
            );
          }
        }
        if (!semanticOwnerExternalRescueApplied && !semanticOwnerObservationFallback) {
          semanticOwnerCacheSourceIsolated = true;
          semanticOwnerCacheSourceIsolationReason = 'pure_cache_invalid_hit';
          const isolatedBody = normalizeAgentProductsListResponse(
            {
              status: 'success',
              success: true,
              products: [],
              total: 0,
              page: semanticOwnerExternalRescuePage,
              page_size: 0,
              reply: null,
              metadata: {
                query_source: 'agent_products_recall_clarify',
                semantic_owner_cache_source_isolated: true,
                semantic_owner_cache_source_isolation_reason: 'pure_cache_invalid_hit',
                semantic_owner_external_rescue_queries_attempted:
                  semanticOwnerExternalRescueQueries,
                source_breakdown: {
                  internal_count: 0,
                  external_seed_count: 0,
                  stale_cache_used: false,
                  strategy_applied: 'semantic_owner_cache_source_isolated',
                },
              },
            },
            {
              limit: rescueLimit,
              offset: 0,
            },
          );
          response = { status: 200, data: isolatedBody };
          upstreamData = normalizeUpstreamData({
            responseBody: isolatedBody,
            queryParamsOverride: rescueQueryParams,
            requestBodyOverride: requestBody,
          });
          queryParams = rescueQueryParams;
        }
      }
    }

    if (
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      !semanticOwnerAdoptedByValidHit &&
      semanticOwnerObservationFallback &&
      Array.isArray(semanticOwnerObservationFallback.upstreamData?.products) &&
      semanticOwnerObservationFallback.upstreamData.products.length > 0
    ) {
      response = semanticOwnerObservationFallback.response;
      upstreamData = semanticOwnerObservationFallback.upstreamData;
      queryParams = semanticOwnerObservationFallback.queryParams;
      requestBody = semanticOwnerObservationFallback.requestBody;
      const chosenAttempt =
        semanticOwnerQueryAttempts[semanticOwnerObservationFallback.queryIndex];
      if (chosenAttempt && chosenAttempt.adopted !== true) {
        chosenAttempt.adopted = true;
        chosenAttempt.adoption_mode =
          semanticOwnerObservationFallback.last_resort_cache_candidate === true
            ? 'last_resort_cache'
            : 'observation_only';
      }
      if (semanticOwnerObservationFallback.last_resort_cache_candidate === true) {
        semanticOwnerLastResortCacheApplied = true;
        semanticOwnerLastResortCacheQuery =
          String(queryParams?.query || '').trim() || null;
      }
    }

    return {
      response,
      upstreamData,
      queryParams,
      requestBody,
      axiosConfig,
      semanticOwnerQueryAttempts,
      semanticOwnerExternalRescueQueriesAttempted,
      semanticOwnerCacheSourceIsolated,
      semanticOwnerCacheSourceIsolationReason,
      semanticOwnerLastResortCacheApplied,
      semanticOwnerLastResortCacheQuery,
    };
  }

  return {
    runInvokeSemanticOwnerExecution,
  };
}

module.exports = {
  createFindProductsInvokeSemanticOwnerExecutionRuntime,
};
