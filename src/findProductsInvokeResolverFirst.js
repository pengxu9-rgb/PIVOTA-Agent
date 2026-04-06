function createFindProductsInvokeResolverFirstRuntime(deps = {}) {
  const {
    shouldUseResolverFirstSearch,
    queryResolveSearchFallback,
    getResolverFallbackAdoptionDecision,
    buildDirectResolverFallbackResponse,
    shouldReducePrimaryTimeoutAfterResolverMiss,
    getUpstreamTimeoutMs,
    FPM_GATE_SIMPLIFY_V1,
    FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS,
    PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
  } = deps;

  async function maybeApplyInvokeResolverFirst({
    response = null,
    operation = '',
    metadata = null,
    resolverQueryText = '',
    resolverRemainingBudgetMs = 0,
    traceQueryClass = null,
    resolverBrandLike = false,
    strictCommerceFindProductsMulti = false,
    semanticOwnerControlled = false,
    fpmLatencyGuardApplied = false,
    fpmSkippedGatesDueToBudget = [],
    addFpmGateTrace = null,
    resolverQueryParams = null,
    checkoutToken = null,
    resolverTimeoutMs = 0,
    resolverRejectedReason = null,
    resolverRejectedQueryUsed = null,
    logger = null,
    axiosConfig = null,
  } = {}) {
    let nextResponse = response;
    let nextResolverRejectedReason = resolverRejectedReason;
    let nextResolverRejectedQueryUsed = resolverRejectedQueryUsed;
    let nextResolverFirstResult = null;
    let nextAxiosConfig = axiosConfig;
    let nextFpmLatencyGuardApplied = fpmLatencyGuardApplied;
    let nextFpmSkippedGatesDueToBudget = Array.isArray(fpmSkippedGatesDueToBudget)
      ? [...fpmSkippedGatesDueToBudget]
      : [];
    let resolverFirstAttempted = false;

    let shouldAttemptResolverFirst = shouldUseResolverFirstSearch({
      operation,
      metadata,
      queryText: resolverQueryText,
      remainingBudgetMs: resolverRemainingBudgetMs,
      queryClass: traceQueryClass,
      brandLike: resolverBrandLike,
    });
    let resolverFirstSkipReason = 'disabled_or_not_lookup';
    if (
      operation === 'find_products_multi' &&
      strictCommerceFindProductsMulti &&
      shouldAttemptResolverFirst
    ) {
      shouldAttemptResolverFirst = false;
      resolverFirstSkipReason = 'strict_main_path';
    }
    if (
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      shouldAttemptResolverFirst
    ) {
      shouldAttemptResolverFirst = false;
      resolverFirstSkipReason = 'semantic_owner_primary';
    }
    if (
      operation === 'find_products_multi' &&
      FPM_GATE_SIMPLIFY_V1 &&
      shouldAttemptResolverFirst &&
      resolverRemainingBudgetMs < FPM_LATENCY_GUARD_RESOLVER_MIN_REMAINING_MS
    ) {
      shouldAttemptResolverFirst = false;
      resolverFirstSkipReason = 'budget_guard';
      nextFpmLatencyGuardApplied = true;
      nextFpmSkippedGatesDueToBudget.push('resolver_first');
      addFpmGateTrace?.({
        gateId: 'resolver_first',
        applied: false,
        decision: 'skipped',
        reason: 'budget_guard',
        costMsEstimate: 220,
        queryClass: traceQueryClass,
      });
    }
    if (!shouldAttemptResolverFirst) {
      addFpmGateTrace?.({
        gateId: 'resolver_first',
        applied: false,
        decision: 'pass',
        reason: resolverFirstSkipReason,
        costMsEstimate: 0,
        queryClass: traceQueryClass,
      });
    }

    if (shouldAttemptResolverFirst) {
      resolverFirstAttempted = true;
      addFpmGateTrace?.({
        gateId: 'resolver_first',
        applied: true,
        decision: 'attempted',
        reason: 'lookup_first',
        costMsEstimate: 220,
        queryClass: traceQueryClass,
      });
      try {
        nextResolverFirstResult = await queryResolveSearchFallback({
          queryParams: resolverQueryParams,
          checkoutToken,
          reason: 'resolver_first',
          requestSource: metadata?.source,
          timeoutMs: resolverTimeoutMs,
        });
        if (
          nextResolverFirstResult &&
          nextResolverFirstResult.status >= 200 &&
          nextResolverFirstResult.status < 300 &&
          nextResolverFirstResult.usableCount > 0
        ) {
          const resolverAdoption = getResolverFallbackAdoptionDecision({
            result: nextResolverFirstResult,
            queryText: resolverQueryText,
            queryClass: traceQueryClass,
          });
          if (resolverAdoption.adopt) {
            nextResponse = buildDirectResolverFallbackResponse({
              result: nextResolverFirstResult,
            });
            addFpmGateTrace?.({
              gateId: 'resolver_first_result',
              applied: true,
              decision: 'adopted',
              reason: 'resolver_hit',
              costMsEstimate: 15,
              queryClass: traceQueryClass,
            });
          } else {
            nextResolverRejectedReason =
              resolverAdoption.reason || nextResolverRejectedReason;
            nextResolverRejectedQueryUsed =
              resolverAdoption.resolveQueryUsed || nextResolverRejectedQueryUsed;
            addFpmGateTrace?.({
              gateId: 'resolver_first_result',
              applied: true,
              decision: 'rejected',
              reason: resolverAdoption.reason || 'resolver_rejected',
              costMsEstimate: 15,
              queryClass: traceQueryClass,
            });
          }
        } else {
          addFpmGateTrace?.({
            gateId: 'resolver_first_result',
            applied: true,
            decision: 'miss',
            reason: 'resolver_no_usable',
            costMsEstimate: 15,
            queryClass: traceQueryClass,
          });
        }
      } catch (resolverErr) {
        addFpmGateTrace?.({
          gateId: 'resolver_first_result',
          applied: true,
          decision: 'error',
          reason: 'resolver_exception',
          costMsEstimate: 15,
          queryClass: traceQueryClass,
        });
        logger?.warn(
          { err: resolverErr?.message || String(resolverErr), operation },
          `${operation} resolver-first failed; falling back to upstream`,
        );
      }
    }

    if (
      !nextResponse &&
      operation === 'find_products_multi' &&
      shouldReducePrimaryTimeoutAfterResolverMiss(
        nextResolverFirstResult,
        resolverQueryText,
      )
    ) {
      nextAxiosConfig = {
        ...(nextAxiosConfig || {}),
        timeout: Math.min(
          Number(nextAxiosConfig?.timeout || getUpstreamTimeoutMs(operation)),
          PROXY_SEARCH_PRIMARY_TIMEOUT_AFTER_RESOLVER_MISS_MS,
        ),
      };
    }

    return {
      response: nextResponse,
      resolverFirstResult: nextResolverFirstResult,
      resolverRejectedReason: nextResolverRejectedReason,
      resolverRejectedQueryUsed: nextResolverRejectedQueryUsed,
      axiosConfig: nextAxiosConfig,
      fpmLatencyGuardApplied: nextFpmLatencyGuardApplied,
      fpmSkippedGatesDueToBudget: nextFpmSkippedGatesDueToBudget,
      resolverFirstAttempted,
    };
  }

  return {
    maybeApplyInvokeResolverFirst,
  };
}

module.exports = {
  createFindProductsInvokeResolverFirstRuntime,
};
