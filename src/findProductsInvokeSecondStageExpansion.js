function createFindProductsInvokeSecondStageExpansionRuntime(deps = {}) {
  const {
    axios,
    buildFindProductsMultiContext,
    getFindProductsMultiSecondStageSupplementDecision,
    normalizeAgentProductsListResponse,
    buildSearchProductKey,
    isSupplementCandidateRelevant,
    normalizeDecisionObserverNodes,
    extractGuidanceRetrievalContext,
    FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
    FPM_GATE_SIMPLIFY_V1,
    FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS,
  } = deps;

  async function maybeApplyInvokeSecondStageExpansion({
    operation = '',
    queryText = '',
    responseStatus = null,
    shouldFallback = false,
    primaryDecisionLocked = false,
    primaryUsableCount = 0,
    requestedLimit = 0,
    secondStageExpansionAllowed = false,
    requestedFindProductsMultiPage = 1,
    semanticOwnerControlled = false,
    semanticOwnerAllowsBroadening = false,
    getFpmRemainingBudgetMs = null,
    effectiveIntent = null,
    traceQueryClass = null,
    queryParams = null,
    metadata = null,
    payload = null,
    upstreamData = null,
    url = '',
    buildQueryString = null,
    axiosHeaders = null,
    axiosTimeout = 0,
    addFpmGateTrace = null,
    fpmSkippedGatesDueToBudget = null,
    fpmLatencyGuardApplied = false,
    decisionObserverNodes = [],
    logger = null,
  } = {}) {
    let nextUpstreamData = upstreamData;
    let nextSecondarySupplementMeta = null;
    let nextDecisionObserverNodes = decisionObserverNodes;
    let nextFpmLatencyGuardApplied = fpmLatencyGuardApplied;

    if (
      operation === 'find_products_multi' &&
      queryText &&
      responseStatus >= 200 &&
      responseStatus < 300 &&
      !shouldFallback &&
      !primaryDecisionLocked &&
      primaryUsableCount < requestedLimit &&
      semanticOwnerControlled &&
      !semanticOwnerAllowsBroadening
    ) {
      nextSecondarySupplementMeta = {
        attempted: false,
        applied: false,
        added_count: 0,
        expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
        reason: 'semantic_owner_primary',
        page: requestedFindProductsMultiPage,
      };
      addFpmGateTrace?.({
        gateId: 'second_stage_expansion',
        applied: false,
        decision: 'skipped',
        reason: 'semantic_owner_primary',
        costMsEstimate: 0,
        queryClass: traceQueryClass,
      });
    }

    if (
      operation === 'find_products_multi' &&
      queryText &&
      responseStatus >= 200 &&
      responseStatus < 300 &&
      !shouldFallback &&
      !primaryDecisionLocked &&
      primaryUsableCount < requestedLimit &&
      secondStageExpansionAllowed
    ) {
      const remainingBudgetForSecondStage =
        typeof getFpmRemainingBudgetMs === 'function' ? getFpmRemainingBudgetMs() : 0;
      const secondStageGuidanceContext = extractGuidanceRetrievalContext(
        {
          ...(queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
            ? queryParams
            : {}),
          ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? {
                ui_surface: metadata.ui_surface,
                decision_mode: metadata.decision_mode,
                retrieval_mode: metadata.retrieval_mode,
              }
            : {}),
        },
        { queryText },
      );
      const shouldSkipSecondStageByBudget =
        FPM_GATE_SIMPLIFY_V1 &&
        !secondStageGuidanceContext.is_guidance_recall_first &&
        remainingBudgetForSecondStage < FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS;
      if (shouldSkipSecondStageByBudget) {
        nextFpmLatencyGuardApplied = true;
        if (Array.isArray(fpmSkippedGatesDueToBudget)) {
          fpmSkippedGatesDueToBudget.push('second_stage_expansion');
        }
        addFpmGateTrace?.({
          gateId: 'second_stage_expansion',
          applied: false,
          decision: 'skipped',
          reason: 'budget_guard',
          costMsEstimate: 260,
          queryClass: traceQueryClass,
        });
        nextSecondarySupplementMeta = {
          attempted: true,
          applied: false,
          added_count: 0,
          expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
          reason: 'disabled_for_budget_guard',
          page: requestedFindProductsMultiPage,
        };
      } else if (requestedFindProductsMultiPage > 1) {
        addFpmGateTrace?.({
          gateId: 'second_stage_expansion',
          applied: false,
          decision: 'skipped',
          reason: 'disabled_for_page_gt_1',
          costMsEstimate: 0,
          queryClass: traceQueryClass,
        });
        nextSecondarySupplementMeta = {
          attempted: true,
          applied: false,
          added_count: 0,
          expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
          reason: 'disabled_for_page_gt_1',
          page: requestedFindProductsMultiPage,
        };
      } else {
        addFpmGateTrace?.({
          gateId: 'second_stage_expansion',
          applied: true,
          decision: 'attempted',
          reason: 'under_limit_first_page',
          costMsEstimate: 260,
          queryClass: traceQueryClass,
        });
        try {
          const secondStageCtx = await buildFindProductsMultiContext({
            payload,
            metadata: {
              ...(metadata || {}),
              expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
            },
          });
          const expandedSecondaryQuery = String(
            secondStageCtx?.adjustedPayload?.search?.query || queryText,
          ).trim();
          if (expandedSecondaryQuery && expandedSecondaryQuery !== queryText) {
            const secondStageDecision = getFindProductsMultiSecondStageSupplementDecision({
              queryText,
              expandedQuery: expandedSecondaryQuery,
              traceQueryClass,
              effectiveIntent,
              expansionMeta: secondStageCtx?.expansion_meta || null,
            });
            if (!secondStageDecision.allowSupplement) {
              nextSecondarySupplementMeta = {
                attempted: true,
                applied: false,
                added_count: 0,
                expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
                expanded_query: expandedSecondaryQuery,
                query_class: secondStageDecision.queryClass || null,
                added_tokens: secondStageDecision.addedTokens || [],
                reason: secondStageDecision.reason || 'disabled_for_second_stage_gate',
              };
              addFpmGateTrace?.({
                gateId: 'second_stage_expansion_result',
                applied: true,
                decision: 'skipped',
                reason: secondStageDecision.reason || 'disabled_for_second_stage_gate',
                costMsEstimate: 25,
                queryClass: traceQueryClass,
              });
            } else {
              const secondaryQueryParams = {
                ...queryParams,
                query: expandedSecondaryQuery,
                offset: 0,
                limit: Math.min(Math.max(requestedLimit * 2, 20), 80),
              };
              const secondaryResp = await axios({
                method: 'GET',
                url: `${url}${buildQueryString(secondaryQueryParams)}`,
                headers: axiosHeaders,
                timeout: Math.min(2400, Number(axiosTimeout || 2400)),
                validateStatus: () => true,
              });
              const secondaryNormalized = normalizeAgentProductsListResponse(
                secondaryResp.data,
                {
                  limit: secondaryQueryParams.limit,
                  offset: 0,
                },
              );
              const secondaryProducts = Array.isArray(secondaryNormalized?.products)
                ? secondaryNormalized.products
                : [];
              if (
                secondaryResp.status >= 200 &&
                secondaryResp.status < 300 &&
                secondaryProducts.length > 0
              ) {
                const primaryProducts = Array.isArray(nextUpstreamData?.products)
                  ? nextUpstreamData.products
                  : [];
                const seen = new Set(
                  primaryProducts.map((product) => buildSearchProductKey(product)).filter(Boolean),
                );
                const toAppend = [];
                for (const product of secondaryProducts) {
                  if (
                    !isSupplementCandidateRelevant(product, queryText, {
                      targetStepFamily:
                        queryParams?.target_step_family || queryParams?.targetStepFamily || null,
                      uiSurface: queryParams?.ui_surface || queryParams?.uiSurface || null,
                      queryStepStrength:
                        queryParams?.query_step_strength ||
                        queryParams?.queryStepStrength ||
                        null,
                    })
                  ) {
                    continue;
                  }
                  const key = buildSearchProductKey(product);
                  if (!key || seen.has(key)) continue;
                  seen.add(key);
                  toAppend.push(product);
                  if (primaryProducts.length + toAppend.length >= requestedLimit) break;
                }
                if (toAppend.length > 0) {
                  const mergedProducts = primaryProducts.concat(toAppend);
                  nextUpstreamData = normalizeAgentProductsListResponse(
                    {
                      ...(nextUpstreamData &&
                      typeof nextUpstreamData === 'object' &&
                      !Array.isArray(nextUpstreamData)
                        ? nextUpstreamData
                        : {}),
                      products: mergedProducts,
                      total: Math.max(
                        Number(nextUpstreamData?.total || 0) || 0,
                        mergedProducts.length,
                      ),
                    },
                    {
                      limit: queryParams?.limit,
                      offset: queryParams?.offset,
                    },
                  );
                }
                nextSecondarySupplementMeta = {
                  attempted: true,
                  applied: toAppend.length > 0,
                  added_count: toAppend.length,
                  expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
                  expanded_query: expandedSecondaryQuery,
                  query_class: secondStageDecision.queryClass || null,
                  added_tokens: secondStageDecision.addedTokens || [],
                  reason:
                    toAppend.length > 0
                      ? 'second_stage_supplemented'
                      : 'second_stage_no_relevant_candidates',
                };
                addFpmGateTrace?.({
                  gateId: 'second_stage_expansion_result',
                  applied: true,
                  decision: toAppend.length > 0 ? 'applied' : 'no_change',
                  reason:
                    toAppend.length > 0
                      ? 'second_stage_supplemented'
                      : 'second_stage_no_relevant_candidates',
                  costMsEstimate: 25,
                  queryClass: traceQueryClass,
                });
              } else {
                nextSecondarySupplementMeta = {
                  attempted: true,
                  applied: false,
                  added_count: 0,
                  expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
                  expanded_query: expandedSecondaryQuery,
                  query_class: secondStageDecision.queryClass || null,
                  added_tokens: secondStageDecision.addedTokens || [],
                  reason: 'second_stage_unavailable',
                };
                addFpmGateTrace?.({
                  gateId: 'second_stage_expansion_result',
                  applied: true,
                  decision: 'no_change',
                  reason: 'second_stage_unavailable',
                  costMsEstimate: 25,
                  queryClass: traceQueryClass,
                });
              }
            }
          }
        } catch (secondaryErr) {
          nextSecondarySupplementMeta = {
            attempted: true,
            applied: false,
            added_count: 0,
            expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
            reason: 'second_stage_error',
            error: String(secondaryErr?.message || secondaryErr),
          };
          addFpmGateTrace?.({
            gateId: 'second_stage_expansion_result',
            applied: true,
            decision: 'error',
            reason: 'second_stage_error',
            costMsEstimate: 25,
            queryClass: traceQueryClass,
          });
          logger?.warn(
            { err: secondaryErr?.message || String(secondaryErr), query: queryText },
            `${operation} second-stage conservative->aggressive supplement failed`,
          );
        }
      }
    }

    if (
      operation === 'find_products_multi' &&
      queryText &&
      responseStatus >= 200 &&
      responseStatus < 300 &&
      !shouldFallback &&
      primaryDecisionLocked &&
      primaryUsableCount < requestedLimit &&
      secondStageExpansionAllowed
    ) {
      nextDecisionObserverNodes = normalizeDecisionObserverNodes(
        nextDecisionObserverNodes,
        'second_stage_expansion_suppressed_by_locked_decision',
      );
      nextSecondarySupplementMeta = {
        attempted: false,
        applied: false,
        added_count: 0,
        expansion_mode: FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE,
        reason: 'decision_locked',
        page: requestedFindProductsMultiPage,
      };
      addFpmGateTrace?.({
        gateId: 'second_stage_expansion',
        applied: false,
        decision: 'skipped',
        reason: 'decision_locked',
        costMsEstimate: 0,
        queryClass: traceQueryClass,
      });
    }

    return {
      upstreamData: nextUpstreamData,
      secondarySupplementMeta: nextSecondarySupplementMeta,
      decisionObserverNodes: nextDecisionObserverNodes,
      fpmLatencyGuardApplied: nextFpmLatencyGuardApplied,
    };
  }

  return {
    maybeApplyInvokeSecondStageExpansion,
  };
}

module.exports = {
  createFindProductsInvokeSecondStageExpansionRuntime,
};
