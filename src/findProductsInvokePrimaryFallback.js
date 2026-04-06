function createFindProductsInvokePrimaryFallbackRuntime(deps = {}) {
  const {
    queryResolveSearchFallback,
    getResolverFallbackAdoptionDecision,
    extractResolverFallbackData,
    queryFindProductsMultiFallback,
    getSecondaryFallbackOutcomeDecision,
    getPrimaryFallbackOutcomeDecision,
    buildProxySearchSoftFallbackResponse,
    buildStrictEmptyFallbackResponse,
    applyProxySearchFallbackMetadata,
    SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO,
  } = deps;

  async function applyInvokePrimaryFallback({
    operation = '',
    shouldFallback = false,
    shoppingFreshMainlineSearch = false,
    strictCommerceFindProductsMulti = false,
    skipSecondaryFallback = false,
    normalizedSecondaryFallbackSkipReason = null,
    allowResolverFallbackEffective = false,
    allowSecondaryFallback = false,
    allowInvokeFallback = false,
    forceInvokeFallbackForFragrance = false,
    queryText = '',
    queryParams = null,
    checkoutToken = null,
    metadata = null,
    resolverTimeoutMs = 0,
    traceQueryClass = null,
    primaryUsableCount = 0,
    primaryIrrelevant = false,
    primaryLowQualityNonempty = false,
    primaryUnusable = false,
    primaryMonoculture = false,
    effectiveIntent = null,
    payload = null,
    responseStatus = null,
    upstreamData = null,
    resolverRejectedReason = null,
    resolverRejectedQueryUsed = null,
    semanticRetryApplied = false,
    semanticRetryQuery = null,
    semanticRetryHits = 0,
    secondaryFallbackMeta = null,
    secondaryFallbackOutcome = null,
    semanticOwnerControlled = false,
    semanticOwnerLastResortCacheApplied = false,
    semanticOwnerLastResortCacheQuery = null,
    logger = null,
  } = {}) {
    if (!(shouldFallback && !shoppingFreshMainlineSearch)) {
      return {
        upstreamData,
        resolverRejectedReason,
        resolverRejectedQueryUsed,
        semanticRetryApplied,
        semanticRetryQuery,
        semanticRetryHits,
        secondaryFallbackMeta,
        secondaryFallbackOutcome,
        semanticOwnerLastResortCacheApplied,
        semanticOwnerLastResortCacheQuery,
      };
    }

    let nextUpstreamData = upstreamData;
    let nextResolverRejectedReason = resolverRejectedReason;
    let nextResolverRejectedQueryUsed = resolverRejectedQueryUsed;
    let nextSemanticRetryApplied = semanticRetryApplied;
    let nextSemanticRetryQuery = semanticRetryQuery;
    let nextSemanticRetryHits = semanticRetryHits;
    let nextSecondaryFallbackMeta = secondaryFallbackMeta;
    let nextSecondaryFallbackOutcome = secondaryFallbackOutcome;
    let nextSemanticOwnerLastResortCacheApplied = semanticOwnerLastResortCacheApplied;
    let nextSemanticOwnerLastResortCacheQuery = semanticOwnerLastResortCacheQuery;

    let replacedByFallback = false;
    const skipSecondaryFallbackEffective =
      skipSecondaryFallback || strictCommerceFindProductsMulti;
    const secondaryFallbackSkipReason =
      strictCommerceFindProductsMulti
        ? 'strict_main_path'
        : normalizedSecondaryFallbackSkipReason || 'resolver_miss_skip_secondary';

    if (allowResolverFallbackEffective && !skipSecondaryFallbackEffective) {
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
          const resolverAdoption = getResolverFallbackAdoptionDecision({
            result: resolverFallback,
            queryText,
            queryClass: traceQueryClass,
          });
          if (resolverAdoption.adopt) {
            nextUpstreamData = extractResolverFallbackData(resolverFallback);
            replacedByFallback = true;
          } else {
            nextResolverRejectedReason =
              resolverAdoption.reason || nextResolverRejectedReason;
            nextResolverRejectedQueryUsed =
              resolverAdoption.resolveQueryUsed || nextResolverRejectedQueryUsed;
          }
        }
      } catch (resolverErr) {
        logger?.warn(
          { err: resolverErr?.message || String(resolverErr) },
          `${operation} resolver fallback failed after primary response`,
        );
      }
    }

    if (
      !replacedByFallback &&
      allowSecondaryFallback &&
      (allowInvokeFallback || forceInvokeFallbackForFragrance) &&
      !skipSecondaryFallbackEffective
    ) {
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
        nextSecondaryFallbackOutcome = getSecondaryFallbackOutcomeDecision({
          fallback,
          queryText,
          queryClass: traceQueryClass,
          operation,
          source: metadata?.source,
          primaryUsableCount,
          primaryIrrelevant,
          primaryLowQualityNonempty,
          primaryUnusable,
          primaryMonoculture,
        });
        nextSemanticRetryApplied = Boolean(
          nextSecondaryFallbackOutcome.semantic_retry_applied,
        );
        nextSemanticRetryQuery =
          nextSecondaryFallbackOutcome.semantic_retry_query || null;
        nextSemanticRetryHits = Math.max(
          0,
          Number(nextSecondaryFallbackOutcome.semantic_retry_hits || 0) || 0,
        );
        nextSecondaryFallbackMeta = {
          attempt_count: nextSecondaryFallbackOutcome.attempt_count,
          selected_attempt: nextSecondaryFallbackOutcome.selected_attempt,
          attempts: nextSecondaryFallbackOutcome.attempts,
          selected_query: nextSecondaryFallbackOutcome.selected_query,
          target_relevant_count: nextSecondaryFallbackOutcome.targetRelevantCount,
          top3_quality_score: nextSecondaryFallbackOutcome.top3QualityScore,
          strong_evidence_passed: nextSecondaryFallbackOutcome.strongAdoptionEvidence,
          semantic_retry_applied: nextSecondaryFallbackOutcome.semantic_retry_applied,
          semantic_retry_actual_attempted:
            nextSecondaryFallbackOutcome.semantic_retry_actual_attempted,
          semantic_retry_query: nextSecondaryFallbackOutcome.semantic_retry_query,
          semantic_retry_hits: nextSecondaryFallbackOutcome.semantic_retry_hits,
        };
        if (nextSecondaryFallbackOutcome.decision === 'adopt') {
          nextUpstreamData = fallback.data;
          replacedByFallback = true;
        }
      } catch (fallbackErr) {
        logger?.warn(
          { err: fallbackErr?.message || String(fallbackErr) },
          `${operation} invoke fallback failed after primary response`,
        );
      }
    }

    if (!replacedByFallback) {
      const fallbackReason = skipSecondaryFallbackEffective
        ? secondaryFallbackSkipReason
        : nextSecondaryFallbackOutcome?.reason ||
          (nextSecondaryFallbackMeta?.semantic_retry_applied
            ? 'semantic_retry_exhausted'
            : 'fallback_not_better');
      const primaryOutcomeDecision = getPrimaryFallbackOutcomeDecision({
        shouldFallback,
        primaryUsableCount,
        primaryUnusable,
        primaryIrrelevant,
        primaryLowQualityNonempty,
        primaryMonoculture,
        skipSecondaryFallback: skipSecondaryFallbackEffective,
        secondaryFallbackOutcome: nextSecondaryFallbackOutcome,
        semanticRetryApplied: Boolean(nextSecondaryFallbackMeta?.semantic_retry_applied),
        fallbackNotBetterReason: fallbackReason,
      });
      const forceStrictEmptyControlledRecall =
        SEARCH_FORCE_CONTROLLED_RECALL_FOR_SCENARIO &&
        ['scenario', 'mission', 'gift', 'category'].includes(
          String(traceQueryClass || '').trim().toLowerCase(),
        ) &&
        primaryIrrelevant &&
        shouldFallback;
      const effectivePrimaryOutcomeDecision = forceStrictEmptyControlledRecall
        ? {
            ...primaryOutcomeDecision,
            decision: 'strict_empty',
            reason:
              primaryOutcomeDecision.reason ||
              fallbackReason ||
              'primary_irrelevant_no_fallback',
            querySource: 'agent_products_error_fallback',
            resolution_authority: 'agent_products_error_fallback',
            fallback_applied: true,
            fallback_reason_codes: [
              primaryOutcomeDecision.reason ||
                fallbackReason ||
                'primary_irrelevant_no_fallback',
            ],
          }
        : primaryOutcomeDecision;
      const semanticOwnerRawProductsPresent =
        semanticOwnerControlled &&
        Array.isArray(nextUpstreamData?.products) &&
        nextUpstreamData.products.length > 0;
      const currentUpstreamMeta =
        nextUpstreamData &&
        typeof nextUpstreamData === 'object' &&
        !Array.isArray(nextUpstreamData) &&
        nextUpstreamData.metadata &&
        typeof nextUpstreamData.metadata === 'object' &&
        !Array.isArray(nextUpstreamData.metadata)
          ? nextUpstreamData.metadata
          : {};
      const primaryFallbackUpstreamStatus =
        Number(
          currentUpstreamMeta?.upstream_status ??
            currentUpstreamMeta?.proxy_search_fallback?.upstream_status ??
            responseStatus ??
            0,
        ) ||
        Number(responseStatus || 0) ||
        null;
      const primaryFallbackUpstreamCode =
        String(
          currentUpstreamMeta?.upstream_error_code ||
            currentUpstreamMeta?.proxy_search_fallback?.upstream_error_code ||
            '',
        ).trim() || null;
      const primaryFallbackUpstreamMessage =
        String(
          currentUpstreamMeta?.upstream_error_message ||
            currentUpstreamMeta?.proxy_search_fallback?.upstream_error_message ||
            '',
        ).trim() || null;

      if (
        semanticOwnerRawProductsPresent &&
        (
          effectivePrimaryOutcomeDecision.decision === 'clarify' ||
          effectivePrimaryOutcomeDecision.decision === 'strict_empty'
        )
      ) {
        const preservedMeta =
          nextUpstreamData?.metadata && typeof nextUpstreamData.metadata === 'object'
            ? { ...nextUpstreamData.metadata }
            : {};
        const preservedFallbackMeta =
          preservedMeta.proxy_search_fallback &&
          typeof preservedMeta.proxy_search_fallback === 'object'
            ? { ...preservedMeta.proxy_search_fallback }
            : {};
        nextUpstreamData = {
          ...nextUpstreamData,
          metadata: {
            ...preservedMeta,
            proxy_search_fallback: {
              ...preservedFallbackMeta,
              applied: false,
              reason: null,
              upstream_status: primaryFallbackUpstreamStatus,
              upstream_error_code: primaryFallbackUpstreamCode,
              upstream_error_message: primaryFallbackUpstreamMessage,
            },
            primary_outcome_decision: effectivePrimaryOutcomeDecision.decision,
            primary_outcome_reason: effectivePrimaryOutcomeDecision.reason,
            primary_outcome_query_source: effectivePrimaryOutcomeDecision.querySource,
          },
        };
      } else if (effectivePrimaryOutcomeDecision.decision === 'clarify') {
        nextUpstreamData = buildProxySearchSoftFallbackResponse({
          queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
          reason: effectivePrimaryOutcomeDecision.reason,
          upstreamStatus: primaryFallbackUpstreamStatus,
          upstreamCode: primaryFallbackUpstreamCode,
          upstreamMessage: primaryFallbackUpstreamMessage,
          route: primaryIrrelevant
            ? 'invoke_primary_irrelevant'
            : primaryLowQualityNonempty
            ? 'invoke_primary_low_quality'
            : 'invoke_fallback_exhausted',
          intent: effectiveIntent,
          queryClass: traceQueryClass,
          queryText,
          querySource: effectivePrimaryOutcomeDecision.querySource,
          semanticRetryApplied: Boolean(nextSecondaryFallbackMeta?.semantic_retry_applied),
          semanticRetryQuery: nextSecondaryFallbackMeta?.semantic_retry_query || null,
          semanticRetryHits: Math.max(
            0,
            Number(nextSecondaryFallbackMeta?.semantic_retry_hits || 0) || 0,
          ),
          forceClarify: true,
          slotStateInput: metadata?.slot_state || payload?.context || null,
        });
      } else if (effectivePrimaryOutcomeDecision.decision === 'strict_empty') {
        nextUpstreamData = buildStrictEmptyFallbackResponse({
          body: nextUpstreamData,
          queryParams: queryText ? { ...queryParams, query: queryText } : queryParams,
          reason: effectivePrimaryOutcomeDecision.reason,
          upstreamStatus: primaryFallbackUpstreamStatus,
          upstreamCode: primaryFallbackUpstreamCode,
          upstreamMessage: primaryFallbackUpstreamMessage,
          route: primaryUnusable
            ? 'invoke_primary_unusable'
            : 'invoke_fallback_strict_empty',
          intent: effectiveIntent,
          queryClass: traceQueryClass,
          queryText,
          querySource: effectivePrimaryOutcomeDecision.querySource,
          semanticRetryApplied: Boolean(nextSecondaryFallbackMeta?.semantic_retry_applied),
          semanticRetryQuery: nextSecondaryFallbackMeta?.semantic_retry_query || null,
          semanticRetryHits: Math.max(
            0,
            Number(nextSecondaryFallbackMeta?.semantic_retry_hits || 0) || 0,
          ),
        });
        if (
          forceStrictEmptyControlledRecall &&
          nextUpstreamData &&
          typeof nextUpstreamData === 'object' &&
          !Array.isArray(nextUpstreamData)
        ) {
          nextUpstreamData = {
            ...nextUpstreamData,
            metadata: {
              ...(nextUpstreamData.metadata && typeof nextUpstreamData.metadata === 'object'
                ? nextUpstreamData.metadata
                : {}),
              strict_empty: true,
              strict_empty_reason:
                effectivePrimaryOutcomeDecision.reason ||
                fallbackReason ||
                'primary_irrelevant_no_fallback',
            },
          };
        }
      } else {
        nextUpstreamData = applyProxySearchFallbackMetadata(nextUpstreamData, {
          applied: false,
          reason: effectivePrimaryOutcomeDecision.reason,
          ...(nextSecondaryFallbackMeta?.semantic_retry_applied
            ? { query_variant: 'semantic_retry' }
            : {}),
        });
      }
      if (
        nextUpstreamData &&
        typeof nextUpstreamData === 'object' &&
        !Array.isArray(nextUpstreamData)
      ) {
        const upstreamMeta =
          nextUpstreamData.metadata && typeof nextUpstreamData.metadata === 'object'
            ? { ...nextUpstreamData.metadata }
            : {};
        upstreamMeta.semantic_retry_applied = Boolean(
          nextSecondaryFallbackMeta?.semantic_retry_applied,
        );
        upstreamMeta.semantic_retry_query =
          nextSecondaryFallbackMeta?.semantic_retry_query || null;
        upstreamMeta.semantic_retry_hits = Math.max(
          0,
          Number(nextSecondaryFallbackMeta?.semantic_retry_hits || 0) || 0,
        );
        upstreamMeta.secondary_target_relevant_count = Math.max(
          0,
          Number(nextSecondaryFallbackMeta?.target_relevant_count || 0) || 0,
        );
        upstreamMeta.secondary_top3_quality_score =
          Number(nextSecondaryFallbackMeta?.top3_quality_score || 0) || 0;
        upstreamMeta.secondary_strong_evidence_passed = Boolean(
          nextSecondaryFallbackMeta?.strong_evidence_passed,
        );
        nextUpstreamData = {
          ...nextUpstreamData,
          metadata: upstreamMeta,
        };
      }
    }

    return {
      upstreamData: nextUpstreamData,
      resolverRejectedReason: nextResolverRejectedReason,
      resolverRejectedQueryUsed: nextResolverRejectedQueryUsed,
      semanticRetryApplied: nextSemanticRetryApplied,
      semanticRetryQuery: nextSemanticRetryQuery,
      semanticRetryHits: nextSemanticRetryHits,
      secondaryFallbackMeta: nextSecondaryFallbackMeta,
      secondaryFallbackOutcome: nextSecondaryFallbackOutcome,
      semanticOwnerLastResortCacheApplied: nextSemanticOwnerLastResortCacheApplied,
      semanticOwnerLastResortCacheQuery: nextSemanticOwnerLastResortCacheQuery,
    };
  }

  return {
    applyInvokePrimaryFallback,
  };
}

module.exports = {
  createFindProductsInvokePrimaryFallbackRuntime,
};
