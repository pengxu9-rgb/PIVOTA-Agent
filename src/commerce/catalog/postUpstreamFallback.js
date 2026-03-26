const {
  shouldFallbackProxySearch: shouldFallbackProxySearchBase,
  detectAuroraExternalSeedMonoculture: detectAuroraExternalSeedMonocultureBase,
  getFallbackAdoptUsableThreshold: getFallbackAdoptUsableThresholdBase,
} = require('./searchFallbackRuntime');
const {
  buildSearchProductKey: buildSearchProductKeyBase,
} = require('./searchDedupe');

function buildRouteHealthMetadataPatch({
  upstreamData,
  operation,
  secondarySupplementMeta,
  shouldFallback,
  skipSecondaryFallback,
  secondaryFallbackSkipReason,
  secondaryFallbackMeta,
  semanticRetryApplied,
  semanticRetryQuery,
  semanticRetryHits,
  primaryQualityGatePassed,
  primaryQualityScore,
  primaryLowQualityNonempty,
  isExternalSeedProduct,
}) {
  const routeHealthProducts = Array.isArray(upstreamData?.products) ? upstreamData.products : [];
  const routeHealthExternalCount = routeHealthProducts.filter((product) =>
    isExternalSeedProduct(product),
  ).length;
  const routeHealthInternalCount = Math.max(
    0,
    routeHealthProducts.length - routeHealthExternalCount,
  );
  const mergedPreLimitCount = Number.isFinite(Number(upstreamData?.total))
    ? Math.max(routeHealthProducts.length, Number(upstreamData.total))
    : routeHealthProducts.length;
  const supplementAttempted =
    operation === 'find_products_multi'
      ? Boolean(secondarySupplementMeta?.attempted || shouldFallback)
      : Boolean(shouldFallback);
  const supplementSkipReason =
    operation === 'find_products_multi' && secondarySupplementMeta?.attempted
      ? secondarySupplementMeta?.reason || null
      : !shouldFallback
        ? 'not_needed'
        : skipSecondaryFallback
          ? secondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
          : 'not_attempted';
  const retryAttemptCount = Math.max(
    0,
    Number(secondaryFallbackMeta?.attempt_count || 0) || 0,
  );
  const fallbackAttemptCount = retryAttemptCount;
  const selectedFallbackAttempt = Math.max(
    0,
    Number(secondaryFallbackMeta?.selected_attempt || 0) || 0,
  );
  const semanticRetryActualAttempted = Boolean(
    secondaryFallbackMeta?.semantic_retry_actual_attempted,
  );

  return {
    ...(operation === 'find_products_multi' && secondarySupplementMeta
      ? { search_stage_b: secondarySupplementMeta }
      : {}),
    semantic_retry_applied: Boolean(semanticRetryApplied),
    semantic_retry_actual_attempted: semanticRetryActualAttempted,
    semantic_retry_query: semanticRetryQuery ? String(semanticRetryQuery) : null,
    semantic_retry_hits: Math.max(0, Number(semanticRetryHits || 0) || 0),
    primary_quality_gate_passed: primaryQualityGatePassed,
    primary_quality_score:
      Number.isFinite(Number(primaryQualityScore)) && Number(primaryQualityScore) >= 0
        ? Number(primaryQualityScore)
        : null,
    low_quality_nonempty_detected: primaryLowQualityNonempty,
    internal_raw_count: routeHealthInternalCount,
    external_raw_count: routeHealthExternalCount,
    merged_pre_limit_count: mergedPreLimitCount,
    supplement_attempted: supplementAttempted,
    supplement_skip_reason: supplementSkipReason,
    retry_attempt_count: retryAttemptCount,
    fallback_attempt_count: fallbackAttemptCount,
    selected_fallback_attempt: selectedFallbackAttempt,
    route_health: {
      ...(
        upstreamData?.metadata?.route_health &&
        typeof upstreamData.metadata.route_health === 'object' &&
        !Array.isArray(upstreamData.metadata.route_health)
          ? upstreamData.metadata.route_health
          : {}
      ),
      semantic_retry_applied: Boolean(semanticRetryApplied),
      semantic_retry_actual_attempted: semanticRetryActualAttempted,
      semantic_retry_query: semanticRetryQuery ? String(semanticRetryQuery) : null,
      semantic_retry_hits: Math.max(0, Number(semanticRetryHits || 0) || 0),
      primary_quality_gate_passed: primaryQualityGatePassed,
      primary_quality_score:
        Number.isFinite(Number(primaryQualityScore)) && Number(primaryQualityScore) >= 0
          ? Number(primaryQualityScore)
          : null,
      low_quality_nonempty_detected: Boolean(primaryLowQualityNonempty),
      internal_raw_count: routeHealthInternalCount,
      external_raw_count: routeHealthExternalCount,
      merged_pre_limit_count: mergedPreLimitCount,
      supplement_attempted: supplementAttempted,
      supplement_skip_reason: supplementSkipReason,
      retry_attempt_count: retryAttemptCount,
      fallback_attempt_count: fallbackAttemptCount,
      selected_fallback_attempt: selectedFallbackAttempt,
      final_returned_count: routeHealthProducts.length,
    },
  };
}

async function applyInvokeSearchPostUpstreamFlow({
  operation,
  upstreamData,
  responseStatus,
  payload,
  queryParams,
  metadata,
  rawUserQuery,
  effectiveIntent,
  traceQueryClass,
  checkoutToken,
  resolverFirstResult,
  resolverTimeoutMs,
  shouldAttemptResolverFirst,
  isProxySearchRoute,
  proxyRouteFallbackStrategy,
  auroraFallbackOverrides,
  auroraExternalSeedEnabled,
  auroraExternalSeedStrategy,
  auroraUpstreamBase,
  fpmLatencyGuardApplied,
  fpmSkippedGatesDueToBudget,
  addFpmGateTrace,
  getFpmRemainingBudgetMs,
  searchLimitMax,
  findProductsMultiSecondStageExpansionMode,
  fpmGateSimplifyV1,
  fpmLatencyGuardSecondStageMinRemainingMs,
  searchExternalHardRulePrune,
  detectBrandEntities,
  extractSearchQueryText,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  normalizeAgentProductsListResponse,
  countUsableSearchProducts,
  shouldFallbackProxySearch = shouldFallbackProxySearchBase,
  isProxySearchFallbackRelevant,
  evaluateCacheQualityGate,
  computePrimaryQualityScore,
  isExternalSeedProduct,
  detectAuroraExternalSeedMonoculture = detectAuroraExternalSeedMonocultureBase,
  hasFragranceQuerySignal,
  getSecondaryFallbackSkipReason,
  shouldAllowResolverFallback,
  shouldAllowSecondaryFallback,
  shouldAllowInvokeFallback,
  buildFindProductsMultiContext,
  axios,
  url,
  buildQueryString,
  axiosConfig,
  buildSearchProductKey = buildSearchProductKeyBase,
  isSupplementCandidateRelevant,
  queryResolveSearchFallback,
  queryFindProductsMultiFallback,
  getFallbackAdoptUsableThreshold = getFallbackAdoptUsableThresholdBase,
  buildProxySearchSoftFallbackResponse,
  withProxySearchFallbackMetadata,
  normalizeAgentSource,
  logger,
} = {}) {
  if (!(operation === 'find_products' || operation === 'find_products_multi')) {
    return {
      upstreamData,
      proxyRouteFallbackStrategy,
      fpmLatencyGuardApplied,
      fpmSkippedGatesDueToBudget,
    };
  }

  const queryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
  const fallbackQueryClass =
    traceQueryClass ||
    (isLookupStyleSearchQuery(queryText, extractSearchAnchorTokens(queryText))
      ? 'lookup'
      : null);
  const primaryProducts = Array.isArray(upstreamData?.products) ? upstreamData.products : [];
  const primaryUsableCount = countUsableSearchProducts(upstreamData?.products);
  const keepNonemptySingleMerchantPrimary =
    operation === 'find_products' && primaryProducts.length > 0;
  const primaryUnusable =
    !keepNonemptySingleMerchantPrimary &&
    Boolean(queryText) &&
    shouldFallbackProxySearch(upstreamData, responseStatus);
  const primaryRelevant = keepNonemptySingleMerchantPrimary
    ? true
    : queryText
      ? isProxySearchFallbackRelevant(upstreamData, queryText)
      : true;
  const primaryQualityGate = evaluateCacheQualityGate({
    products: primaryProducts,
    queryText,
    intent: effectiveIntent,
    queryClass: fallbackQueryClass,
  });
  const primaryQualityScore = computePrimaryQualityScore(primaryQualityGate);
  const primaryHasExternalSeed = primaryProducts.some((product) =>
    isExternalSeedProduct(product),
  );
  const primaryBrandLike = Boolean(
    detectBrandEntities(queryText, { candidateProducts: primaryProducts })?.brand_like,
  );
  const primaryLowQualityNonempty =
    !keepNonemptySingleMerchantPrimary &&
    Boolean(queryText) &&
    primaryUsableCount > 0 &&
    primaryQualityGate.enabled &&
    !primaryQualityGate.accepted &&
    !primaryBrandLike &&
    !primaryHasExternalSeed;
  const primaryMonocultureSignal = detectAuroraExternalSeedMonoculture({
    normalized: upstreamData,
    queryText,
    source: metadata?.source,
  });
  const primaryMonoculture = Boolean(primaryMonocultureSignal.detected);
  const primaryIrrelevant =
    !keepNonemptySingleMerchantPrimary &&
    Boolean(queryText) &&
    ((primaryUsableCount > 0 && !primaryRelevant) || primaryMonoculture);
  const shouldFallback =
    primaryUnusable || primaryIrrelevant || primaryLowQualityNonempty;
  const forceInvokeFallbackForFragrance =
    hasFragranceQuerySignal(queryText) &&
    (primaryUsableCount === 0 || primaryLowQualityNonempty);
  const primaryQualityGatePassed = !primaryLowQualityNonempty && primaryUsableCount > 0;
  const requestedLimit = Math.min(
    Math.max(1, Number(queryParams?.limit || queryParams?.page_size || 20) || 20),
    searchLimitMax,
  );
  const requestedOffset = Math.max(0, Number(queryParams?.offset || 0) || 0);
  const requestedPageFromPayload = Number(queryParams?.page || 0) || 0;
  const requestedFindProductsMultiPage =
    requestedPageFromPayload > 0
      ? requestedPageFromPayload
      : Math.floor(requestedOffset / Math.max(1, requestedLimit)) + 1;
  const secondarySkipBrandLike = Boolean(
    detectBrandEntities(queryText, { candidateProducts: [] })?.brand_like,
  );
  const secondaryFallbackSkipReason = getSecondaryFallbackSkipReason(
    resolverFirstResult,
    queryText,
    {
      disableSkipAfterResolverMiss: auroraFallbackOverrides.disableSkipAfterResolverMiss,
      queryClass: traceQueryClass,
      brandLike: secondarySkipBrandLike,
    },
  );
  const skipSecondaryFallback = Boolean(secondaryFallbackSkipReason);

  addFpmGateTrace({
    gateId: 'secondary_fallback_skip_check',
    applied: true,
    decision: skipSecondaryFallback ? 'skipped' : 'pass',
    reason: skipSecondaryFallback
      ? secondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
      : null,
    costMsEstimate: 25,
    queryClass: traceQueryClass,
  });

  const allowResolverFallback = shouldAllowResolverFallback(operation);
  const allowSecondaryFallback = shouldAllowSecondaryFallback(operation, {
    forceSecondaryFallback: auroraFallbackOverrides.forceSecondaryFallback,
  });
  const allowInvokeFallback =
    operation === 'find_products_multi' &&
    shouldAllowInvokeFallback(operation, {
      forceInvokeFallback: auroraFallbackOverrides.forceInvokeFallback,
    });

  let nextProxyRouteFallbackStrategy = proxyRouteFallbackStrategy;
  if (isProxySearchRoute) {
    nextProxyRouteFallbackStrategy = {
      source: auroraFallbackOverrides.strategySource,
      request_source: metadata?.source || null,
      resolver_attempted: Boolean(shouldAttemptResolverFirst),
      secondary_attempted: false,
      secondary_skipped_reason: skipSecondaryFallback
        ? secondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
        : null,
      allow_secondary_fallback: allowSecondaryFallback,
      allow_invoke_fallback: Boolean(
        allowInvokeFallback || forceInvokeFallbackForFragrance,
      ),
      skip_secondary_after_resolver_miss: skipSecondaryFallback,
      aurora_external_seed_forced: Boolean(auroraFallbackOverrides.active),
      aurora_external_seed_enabled: Boolean(
        auroraFallbackOverrides.active && auroraExternalSeedEnabled,
      ),
      aurora_seed_strategy: auroraFallbackOverrides.active
        ? auroraExternalSeedStrategy
        : null,
      aurora_upstream_base: auroraFallbackOverrides.active
        ? auroraUpstreamBase
        : null,
    };
  }

  let secondarySupplementMeta = null;
  let semanticRetryApplied = false;
  let semanticRetryQuery = null;
  let semanticRetryHits = 0;
  let secondaryFallbackMeta = null;
  let nextFpmLatencyGuardApplied = Boolean(fpmLatencyGuardApplied);
  const nextFpmSkippedGatesDueToBudget = Array.isArray(fpmSkippedGatesDueToBudget)
    ? [...fpmSkippedGatesDueToBudget]
    : [];

  if (
    operation === 'find_products_multi' &&
    queryText &&
    responseStatus >= 200 &&
    responseStatus < 300 &&
    !shouldFallback &&
    primaryUsableCount < requestedLimit &&
    findProductsMultiSecondStageExpansionMode !== 'off'
  ) {
    const remainingBudgetForSecondStage = getFpmRemainingBudgetMs();
    const shouldSkipSecondStageByBudget =
      fpmGateSimplifyV1 &&
      remainingBudgetForSecondStage < fpmLatencyGuardSecondStageMinRemainingMs;
    if (shouldSkipSecondStageByBudget) {
      nextFpmLatencyGuardApplied = true;
      nextFpmSkippedGatesDueToBudget.push('second_stage_expansion');
      addFpmGateTrace({
        gateId: 'second_stage_expansion',
        applied: false,
        decision: 'skipped',
        reason: 'budget_guard',
        costMsEstimate: 260,
        queryClass: traceQueryClass,
      });
      secondarySupplementMeta = {
        attempted: true,
        applied: false,
        added_count: 0,
        expansion_mode: findProductsMultiSecondStageExpansionMode,
        reason: 'disabled_for_budget_guard',
        page: requestedFindProductsMultiPage,
      };
    } else if (requestedFindProductsMultiPage > 1) {
      addFpmGateTrace({
        gateId: 'second_stage_expansion',
        applied: false,
        decision: 'skipped',
        reason: 'disabled_for_page_gt_1',
        costMsEstimate: 0,
        queryClass: traceQueryClass,
      });
      secondarySupplementMeta = {
        attempted: true,
        applied: false,
        added_count: 0,
        expansion_mode: findProductsMultiSecondStageExpansionMode,
        reason: 'disabled_for_page_gt_1',
        page: requestedFindProductsMultiPage,
      };
    } else {
      addFpmGateTrace({
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
            expansion_mode: findProductsMultiSecondStageExpansionMode,
          },
        });
        const expandedSecondaryQuery = String(
          secondStageCtx?.adjustedPayload?.search?.query || queryText,
        ).trim();
        if (expandedSecondaryQuery && expandedSecondaryQuery !== queryText) {
          const secondaryQueryParams = {
            ...queryParams,
            query: expandedSecondaryQuery,
            offset: 0,
            limit: Math.min(Math.max(requestedLimit * 2, 20), 80),
          };
          const secondaryResp = await axios({
            method: 'GET',
            url: `${url}${buildQueryString(secondaryQueryParams)}`,
            headers: axiosConfig.headers,
            timeout: Math.min(2400, Number(axiosConfig.timeout || 2400)),
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
            const currentPrimaryProducts = Array.isArray(upstreamData?.products)
              ? upstreamData.products
              : [];
            const seen = new Set(
              currentPrimaryProducts
                .map((product) => buildSearchProductKey(product))
                .filter(Boolean),
            );
            const toAppend = [];
            for (const product of secondaryProducts) {
              if (!isSupplementCandidateRelevant(product, queryText)) continue;
              const key = buildSearchProductKey(product);
              if (!key || seen.has(key)) continue;
              seen.add(key);
              toAppend.push(product);
              if (currentPrimaryProducts.length + toAppend.length >= requestedLimit) break;
            }
            if (toAppend.length > 0) {
              const mergedProducts = currentPrimaryProducts.concat(toAppend);
              upstreamData = normalizeAgentProductsListResponse(
                {
                  ...(upstreamData &&
                  typeof upstreamData === 'object' &&
                  !Array.isArray(upstreamData)
                    ? upstreamData
                    : {}),
                  products: mergedProducts,
                  total: Math.max(
                    Number(upstreamData?.total || 0) || 0,
                    mergedProducts.length,
                  ),
                },
                {
                  limit: queryParams?.limit,
                  offset: queryParams?.offset,
                },
              );
            }
            secondarySupplementMeta = {
              attempted: true,
              applied: toAppend.length > 0,
              added_count: toAppend.length,
              expansion_mode: findProductsMultiSecondStageExpansionMode,
              expanded_query: expandedSecondaryQuery,
              reason: toAppend.length > 0
                ? 'second_stage_supplemented'
                : 'second_stage_no_relevant_candidates',
            };
            addFpmGateTrace({
              gateId: 'second_stage_expansion_result',
              applied: true,
              decision: toAppend.length > 0 ? 'applied' : 'no_change',
              reason: toAppend.length > 0
                ? 'second_stage_supplemented'
                : 'second_stage_no_relevant_candidates',
              costMsEstimate: 25,
              queryClass: traceQueryClass,
            });
          } else {
            secondarySupplementMeta = {
              attempted: true,
              applied: false,
              added_count: 0,
              expansion_mode: findProductsMultiSecondStageExpansionMode,
              expanded_query: expandedSecondaryQuery,
              reason: 'second_stage_unavailable',
            };
            addFpmGateTrace({
              gateId: 'second_stage_expansion_result',
              applied: true,
              decision: 'no_change',
              reason: 'second_stage_unavailable',
              costMsEstimate: 25,
              queryClass: traceQueryClass,
            });
          }
        } else {
          secondarySupplementMeta = {
            attempted: true,
            applied: false,
            added_count: 0,
            expansion_mode: findProductsMultiSecondStageExpansionMode,
            expanded_query: expandedSecondaryQuery || queryText,
            reason: 'second_stage_query_unchanged',
          };
          addFpmGateTrace({
            gateId: 'second_stage_expansion_result',
            applied: true,
            decision: 'no_change',
            reason: 'second_stage_query_unchanged',
            costMsEstimate: 10,
            queryClass: traceQueryClass,
          });
        }
      } catch (secondaryErr) {
        secondarySupplementMeta = {
          attempted: true,
          applied: false,
          added_count: 0,
          expansion_mode: findProductsMultiSecondStageExpansionMode,
          reason: 'second_stage_error',
          error: String(secondaryErr?.message || secondaryErr),
        };
        addFpmGateTrace({
          gateId: 'second_stage_expansion_result',
          applied: true,
          decision: 'error',
          reason: 'second_stage_error',
          costMsEstimate: 25,
          queryClass: traceQueryClass,
        });
        logger.warn(
          { err: secondaryErr?.message || String(secondaryErr), query: queryText },
          `${operation} second-stage conservative->aggressive supplement failed`,
        );
      }
    }
  }

  if (shouldFallback) {
    let replacedByFallback = false;

    if (allowResolverFallback && !skipSecondaryFallback) {
      try {
        const resolverFallback = await queryResolveSearchFallback({
          queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
          checkoutToken,
          reason: 'resolver_after_primary',
          requestSource: metadata?.source,
          timeoutMs: resolverTimeoutMs,
        });
        if (
          resolverFallback &&
          resolverFallback.status >= 200 &&
          resolverFallback.status < 300 &&
          resolverFallback.usableCount > 0
        ) {
          upstreamData = resolverFallback.data;
          replacedByFallback = true;
        }
      } catch (resolverErr) {
        logger.warn(
          { err: resolverErr?.message || String(resolverErr) },
          `${operation} resolver fallback failed after primary response`,
        );
      }
    }

    if (
      !replacedByFallback &&
      allowSecondaryFallback &&
      (allowInvokeFallback || forceInvokeFallbackForFragrance) &&
      !skipSecondaryFallback
    ) {
      if (
        nextProxyRouteFallbackStrategy &&
        typeof nextProxyRouteFallbackStrategy === 'object'
      ) {
        nextProxyRouteFallbackStrategy.secondary_attempted = true;
        nextProxyRouteFallbackStrategy.secondary_skipped_reason = null;
      }
      try {
        const fallback = await queryFindProductsMultiFallback({
          queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
          checkoutToken,
          reason: primaryUnusable
            ? primaryUsableCount > 0
              ? 'insufficient_primary'
              : 'empty_or_unusable_primary'
            : primaryMonoculture
              ? 'primary_monoculture'
              : primaryLowQualityNonempty
                ? 'primary_low_quality'
                : 'primary_irrelevant',
          requestSource: metadata?.source,
        });
        const fallbackAttempts = Array.isArray(fallback?.attempts)
          ? fallback.attempts
          : fallback
            ? [{ query: fallback.selectedQuery || queryText }]
            : [];
        const fallbackSemanticRetryApplied = Boolean(fallback?.actualRetryAttempted);
        semanticRetryApplied = fallbackSemanticRetryApplied;
        semanticRetryQuery = fallbackSemanticRetryApplied
          ? String(
              fallback?.selectedQuery ||
                fallbackAttempts[fallbackAttempts.length - 1]?.query ||
                '',
            ).trim() || null
          : null;
        semanticRetryHits = Math.max(0, Number(fallback?.usableCount || 0) || 0);
        secondaryFallbackMeta = {
          attempt_count: fallbackAttempts.length,
          selected_attempt: Math.max(0, Number(fallback?.selectedAttemptNo || 0) || 0),
          attempts: fallbackAttempts.slice(0, 3),
          selected_query: fallback?.selectedQuery || null,
          semantic_retry_applied: fallbackSemanticRetryApplied,
          semantic_retry_actual_attempted: Boolean(fallback?.actualRetryAttempted),
          semantic_retry_query: semanticRetryQuery,
          semantic_retry_hits: Math.max(0, Number(fallback?.usableCount || 0) || 0),
        };
        const fallbackAdoptUsableThreshold = getFallbackAdoptUsableThreshold({
          operation,
          source: metadata?.source,
          primaryUsableCount,
          primaryIrrelevant,
        });
        const fallbackRelevant = Boolean(
          fallback &&
            ((hasFragranceQuerySignal(queryText) &&
              Number(fallback?.usableCount || 0) > 0) ||
              isProxySearchFallbackRelevant(fallback.data, queryText)),
        );
        const fallbackUsableCount = Math.max(0, Number(fallback?.usableCount || 0) || 0);
        const fallbackRecallImproved = fallbackUsableCount >= Math.max(
          fallbackAdoptUsableThreshold,
          primaryUsableCount + (primaryLowQualityNonempty ? 1 : 2),
        );
        if (
          fallback &&
          fallback.status >= 200 &&
          fallback.status < 300 &&
          fallbackUsableCount >= fallbackAdoptUsableThreshold &&
          ((primaryLowQualityNonempty &&
            (fallbackRecallImproved || fallbackRelevant)) ||
            (hasFragranceQuerySignal(queryText) && fallbackUsableCount > 0) ||
            fallbackRelevant)
        ) {
          upstreamData = fallback.data;
          replacedByFallback = true;
        }
      } catch (fallbackErr) {
        logger.warn(
          { err: fallbackErr?.message || String(fallbackErr) },
          `${operation} invoke fallback failed after primary response`,
        );
      }
    }

    if (!replacedByFallback) {
      if (primaryIrrelevant) {
        upstreamData = buildProxySearchSoftFallbackResponse({
          queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
          reason: skipSecondaryFallback
            ? primaryMonoculture
              ? 'primary_monoculture_skip_secondary'
              : 'primary_irrelevant_skip_secondary'
            : primaryMonoculture
              ? 'primary_monoculture_no_fallback'
              : 'primary_irrelevant_no_fallback',
          upstreamStatus: responseStatus,
          route: 'invoke_primary_irrelevant',
          intent: effectiveIntent,
          queryClass: traceQueryClass,
          queryText,
          querySource: semanticRetryApplied
            ? 'agent_products_semantic_retry_exhausted'
            : 'agent_products_error_fallback',
          semanticRetryApplied,
          semanticRetryQuery,
          semanticRetryHits,
        });
      } else if (primaryLowQualityNonempty) {
        const lowQualityReason = secondaryFallbackMeta?.semantic_retry_applied
          ? 'low_quality_semantic_retry_exhausted'
          : skipSecondaryFallback
            ? 'primary_low_quality_skip_secondary'
            : 'primary_low_quality_no_fallback';
        upstreamData = buildProxySearchSoftFallbackResponse({
          queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
          reason: lowQualityReason,
          upstreamStatus: responseStatus,
          route: 'invoke_primary_low_quality',
          intent: effectiveIntent,
          queryClass: traceQueryClass,
          queryText,
          querySource: secondaryFallbackMeta?.semantic_retry_applied
            ? 'agent_products_semantic_retry_exhausted'
            : 'agent_products_error_fallback',
          semanticRetryApplied: Boolean(secondaryFallbackMeta?.semantic_retry_applied),
          semanticRetryQuery: secondaryFallbackMeta?.semantic_retry_query || null,
          semanticRetryHits: Math.max(
            0,
            Number(secondaryFallbackMeta?.semantic_retry_hits || 0) || 0,
          ),
        });
      } else {
        const fallbackReason = skipSecondaryFallback
          ? 'resolver_miss_skip_secondary'
          : secondaryFallbackMeta?.semantic_retry_applied
            ? 'semantic_retry_exhausted'
            : 'fallback_not_better';
        const upstreamProducts = Array.isArray(upstreamData?.products)
          ? upstreamData.products
          : [];
        const shouldForceClarifyAfterRetry =
          searchExternalHardRulePrune &&
          upstreamProducts.length === 0 &&
          !skipSecondaryFallback &&
          Boolean(secondaryFallbackMeta?.semantic_retry_applied);
        if (shouldForceClarifyAfterRetry) {
          upstreamData = buildProxySearchSoftFallbackResponse({
            queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
            reason: fallbackReason,
            upstreamStatus: responseStatus,
            route: 'invoke_fallback_exhausted',
            intent: effectiveIntent,
            queryClass: traceQueryClass,
            queryText,
            querySource:
              fallbackReason === 'semantic_retry_exhausted'
                ? 'agent_products_semantic_retry_exhausted'
                : 'agent_products_error_fallback',
            semanticRetryApplied: Boolean(
              secondaryFallbackMeta?.semantic_retry_applied,
            ),
            semanticRetryQuery: secondaryFallbackMeta?.semantic_retry_query || null,
            semanticRetryHits: Math.max(
              0,
              Number(secondaryFallbackMeta?.semantic_retry_hits || 0) || 0,
            ),
          });
        } else {
          upstreamData = withProxySearchFallbackMetadata(upstreamData, {
            applied: false,
            reason: fallbackReason,
            ...(secondaryFallbackMeta?.semantic_retry_applied
              ? { query_variant: 'semantic_retry' }
              : {}),
          });
        }
        if (
          upstreamData &&
          typeof upstreamData === 'object' &&
          !Array.isArray(upstreamData)
        ) {
          const upstreamMeta =
            upstreamData.metadata && typeof upstreamData.metadata === 'object'
              ? { ...upstreamData.metadata }
              : {};
          upstreamMeta.semantic_retry_applied = Boolean(
            secondaryFallbackMeta?.semantic_retry_applied,
          );
          upstreamMeta.semantic_retry_query =
            secondaryFallbackMeta?.semantic_retry_query || null;
          upstreamMeta.semantic_retry_hits = Math.max(
            0,
            Number(secondaryFallbackMeta?.semantic_retry_hits || 0) || 0,
          );
          upstreamData = {
            ...upstreamData,
            metadata: upstreamMeta,
          };
        }
      }
    }
  }

  if (upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData)) {
    upstreamData = {
      ...upstreamData,
      metadata: {
        ...(upstreamData.metadata && typeof upstreamData.metadata === 'object'
          ? upstreamData.metadata
          : {}),
        ...buildRouteHealthMetadataPatch({
          upstreamData,
          operation,
          secondarySupplementMeta,
          shouldFallback,
          skipSecondaryFallback,
          secondaryFallbackSkipReason,
          secondaryFallbackMeta,
          semanticRetryApplied,
          semanticRetryQuery,
          semanticRetryHits,
          primaryQualityGatePassed,
          primaryQualityScore,
          primaryLowQualityNonempty,
          isExternalSeedProduct,
        }),
      },
    };
  }

  if (upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData)) {
    const normalizedGuardSource = normalizeAgentSource(metadata?.source);
    upstreamData = {
      ...upstreamData,
      metadata: {
        ...(upstreamData.metadata && typeof upstreamData.metadata === 'object'
          ? upstreamData.metadata
          : {}),
        guard_source_normalized: normalizedGuardSource || null,
        secondary_fallback_skipped: skipSecondaryFallback,
        secondary_fallback_skip_reason: skipSecondaryFallback
          ? secondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
          : null,
        latency_guard_applied: Boolean(nextFpmLatencyGuardApplied),
        skipped_gates_due_to_budget: Array.from(
          new Set(
            nextFpmSkippedGatesDueToBudget
              .map((gateId) => String(gateId || '').trim())
              .filter(Boolean),
          ),
        ),
      },
    };
  }

  return {
    upstreamData,
    proxyRouteFallbackStrategy: nextProxyRouteFallbackStrategy,
    fpmLatencyGuardApplied: nextFpmLatencyGuardApplied,
    fpmSkippedGatesDueToBudget: nextFpmSkippedGatesDueToBudget,
  };
}

module.exports = {
  applyInvokeSearchPostUpstreamFlow,
};
