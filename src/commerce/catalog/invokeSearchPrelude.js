async function runInvokeSearchPrelude({
  operation,
  metadata,
  queryParams,
  rawUserQuery,
  checkoutToken,
  traceQueryClass,
  isProxySearchRoute,
  auroraFallbackOverrides,
  currentTimeoutMs,
  fpmLatencyGuardApplied = false,
  fpmSkippedGatesDueToBudget = [],
  getFpmRemainingBudgetMs,
  addFpmGateTrace,
  queryResolveSearchFallback,
  shouldUseResolverFirstSearch,
  shouldReducePrimaryTimeoutAfterResolverMiss,
  detectBrandEntities,
  extractSearchQueryText,
  logger,
  proxySearchAuroraResolverTimeoutMs = 0,
  proxySearchResolverTimeoutMs = 0,
  proxySearchResolverFirstOnSearchRouteEnabled = false,
  fpmGateSimplifyV1 = false,
  fpmLatencyGuardResolverMinRemainingMs = 0,
  proxySearchPrimaryTimeoutAfterResolverMissMs = 0,
} = {}) {
  const searchQueryText = String(
    (typeof extractSearchQueryText === 'function'
      ? extractSearchQueryText(queryParams)
      : queryParams?.query) || rawUserQuery || '',
  ).trim();
  const resolverQueryText = String(rawUserQuery || searchQueryText || '').trim();
  const resolverQueryParams = resolverQueryText
    ? { ...(queryParams && typeof queryParams === 'object' ? queryParams : {}), query: resolverQueryText }
    : queryParams;
  const auroraOverrides =
    auroraFallbackOverrides && typeof auroraFallbackOverrides === 'object'
      ? auroraFallbackOverrides
      : {};
  const resolverTimeoutMs = auroraOverrides.active
    ? proxySearchAuroraResolverTimeoutMs
    : proxySearchResolverTimeoutMs;
  const resolverRemainingBudgetMs =
    typeof getFpmRemainingBudgetMs === 'function' ? getFpmRemainingBudgetMs() : null;
  const resolverBrandLike = Boolean(
    typeof detectBrandEntities === 'function'
      ? detectBrandEntities(resolverQueryText, { candidateProducts: [] })?.brand_like
      : false,
  );

  let nextFpmLatencyGuardApplied = Boolean(fpmLatencyGuardApplied);
  const nextFpmSkippedGatesDueToBudget = Array.isArray(fpmSkippedGatesDueToBudget)
    ? [...fpmSkippedGatesDueToBudget]
    : [];

  let shouldAttemptResolverFirst =
    typeof shouldUseResolverFirstSearch === 'function'
      ? shouldUseResolverFirstSearch({
          operation,
          metadata,
          queryText: resolverQueryText,
          remainingBudgetMs: resolverRemainingBudgetMs,
          queryClass: traceQueryClass,
          brandLike: resolverBrandLike,
        })
      : false;

  if (isProxySearchRoute && operation === 'find_products_multi') {
    shouldAttemptResolverFirst =
      shouldAttemptResolverFirst && Boolean(proxySearchResolverFirstOnSearchRouteEnabled);
  }

  if (
    operation === 'find_products_multi' &&
    fpmGateSimplifyV1 &&
    shouldAttemptResolverFirst &&
    Number(resolverRemainingBudgetMs) < Number(fpmLatencyGuardResolverMinRemainingMs || 0)
  ) {
    shouldAttemptResolverFirst = false;
    nextFpmLatencyGuardApplied = true;
    nextFpmSkippedGatesDueToBudget.push('resolver_first');
    if (typeof addFpmGateTrace === 'function') {
      addFpmGateTrace({
        gateId: 'resolver_first',
        applied: false,
        decision: 'skipped',
        reason: 'budget_guard',
        costMsEstimate: 220,
        queryClass: traceQueryClass,
      });
    }
  }

  if (!shouldAttemptResolverFirst && typeof addFpmGateTrace === 'function') {
    addFpmGateTrace({
      gateId: 'resolver_first',
      applied: false,
      decision: 'pass',
      reason: 'disabled_or_not_lookup',
      costMsEstimate: 0,
      queryClass: traceQueryClass,
    });
  }

  let resolverFirstResult = null;
  let response = null;
  if (shouldAttemptResolverFirst) {
    if (typeof addFpmGateTrace === 'function') {
      addFpmGateTrace({
        gateId: 'resolver_first',
        applied: true,
        decision: 'attempted',
        reason: 'lookup_first',
        costMsEstimate: 220,
        queryClass: traceQueryClass,
      });
    }
    try {
      resolverFirstResult = await queryResolveSearchFallback({
        queryParams: resolverQueryParams,
        checkoutToken,
        reason: 'resolver_first',
        requestSource: metadata?.source,
        timeoutMs: resolverTimeoutMs,
      });
      if (
        resolverFirstResult &&
        resolverFirstResult.status >= 200 &&
        resolverFirstResult.status < 300 &&
        resolverFirstResult.usableCount > 0
      ) {
        response = { status: resolverFirstResult.status, data: resolverFirstResult.data };
        if (typeof addFpmGateTrace === 'function') {
          addFpmGateTrace({
            gateId: 'resolver_first_result',
            applied: true,
            decision: 'adopted',
            reason: 'resolver_hit',
            costMsEstimate: 15,
            queryClass: traceQueryClass,
          });
        }
      } else if (typeof addFpmGateTrace === 'function') {
        addFpmGateTrace({
          gateId: 'resolver_first_result',
          applied: true,
          decision: 'miss',
          reason: 'resolver_no_usable',
          costMsEstimate: 15,
          queryClass: traceQueryClass,
        });
      }
    } catch (resolverErr) {
      if (typeof addFpmGateTrace === 'function') {
        addFpmGateTrace({
          gateId: 'resolver_first_result',
          applied: true,
          decision: 'error',
          reason: 'resolver_exception',
          costMsEstimate: 15,
          queryClass: traceQueryClass,
        });
      }
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          { err: resolverErr?.message || String(resolverErr), operation },
          `${operation} resolver-first failed; falling back to upstream`,
        );
      }
    }
  }

  let nextTimeoutMs = currentTimeoutMs;
  if (
    !response &&
    operation === 'find_products_multi' &&
    typeof shouldReducePrimaryTimeoutAfterResolverMiss === 'function' &&
    shouldReducePrimaryTimeoutAfterResolverMiss(resolverFirstResult, resolverQueryText)
  ) {
    nextTimeoutMs = Math.min(
      Number(currentTimeoutMs || proxySearchPrimaryTimeoutAfterResolverMissMs),
      Number(proxySearchPrimaryTimeoutAfterResolverMissMs || currentTimeoutMs),
    );
  }

  return {
    searchQueryText,
    resolverQueryText,
    resolverQueryParams,
    resolverTimeoutMs,
    resolverBrandLike,
    resolverRemainingBudgetMs,
    shouldAttemptResolverFirst,
    resolverFirstResult,
    response,
    nextTimeoutMs,
    fpmLatencyGuardApplied: nextFpmLatencyGuardApplied,
    fpmSkippedGatesDueToBudget: nextFpmSkippedGatesDueToBudget,
  };
}

module.exports = {
  runInvokeSearchPrelude,
};
