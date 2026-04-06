function createFindProductsInvokeStageMetadataRuntime(deps = {}) {
  const {
    isExternalSeedProduct,
    normalizeAgentSource,
  } = deps;

  function applyInvokeStageMetadata({
    operation = '',
    upstreamData = null,
    secondarySupplementMeta = null,
    shouldFallback = false,
    skipSecondaryFallback = false,
    normalizedSecondaryFallbackSkipReason = null,
    secondaryFallbackMeta = null,
    semanticRetryApplied = false,
    semanticRetryQuery = null,
    semanticRetryHits = 0,
    primaryQualityGatePassed = null,
    primaryQualityScore = null,
    primaryQualityDecision = null,
    primaryLowQualityNonempty = false,
    shoppingExactTitleSupplementMeta = null,
    fpmLatencyGuardApplied = false,
    fpmSkippedGatesDueToBudget = [],
    fpmGateTrace = [],
    metadata = null,
  } = {}) {
    let nextUpstreamData = upstreamData;

    if (
      operation === 'find_products_multi' &&
      secondarySupplementMeta &&
      nextUpstreamData &&
      typeof nextUpstreamData === 'object' &&
      !Array.isArray(nextUpstreamData)
    ) {
      const routeHealthProducts = Array.isArray(nextUpstreamData?.products)
        ? nextUpstreamData.products
        : [];
      const routeHealthExternalCount = routeHealthProducts.filter((product) =>
        isExternalSeedProduct(product),
      ).length;
      const routeHealthInternalCount = Math.max(
        0,
        routeHealthProducts.length - routeHealthExternalCount,
      );
      const mergedPreLimitCount = Number.isFinite(Number(nextUpstreamData?.total))
        ? Math.max(routeHealthProducts.length, Number(nextUpstreamData.total))
        : routeHealthProducts.length;
      const supplementAttempted = Boolean(secondarySupplementMeta?.attempted || shouldFallback);
      const supplementSkipReason = secondarySupplementMeta?.attempted
        ? secondarySupplementMeta?.reason || null
        : !shouldFallback
        ? 'not_needed'
        : skipSecondaryFallback
        ? normalizedSecondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
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
      nextUpstreamData = {
        ...nextUpstreamData,
        metadata: {
          ...(nextUpstreamData.metadata && typeof nextUpstreamData.metadata === 'object'
            ? nextUpstreamData.metadata
            : {}),
          search_stage_b: secondarySupplementMeta,
          semantic_retry_applied: Boolean(semanticRetryApplied),
          semantic_retry_actual_attempted: semanticRetryActualAttempted,
          semantic_retry_query: semanticRetryQuery ? String(semanticRetryQuery) : null,
          semantic_retry_hits: Math.max(0, Number(semanticRetryHits || 0) || 0),
          primary_quality_gate_passed: primaryQualityGatePassed,
          primary_quality_score:
            Number.isFinite(Number(primaryQualityScore)) && Number(primaryQualityScore) >= 0
              ? Number(primaryQualityScore)
              : null,
          primary_target_relevant_count: Math.max(
            0,
            Number(primaryQualityDecision?.targetRelevantCount || 0) || 0,
          ),
          primary_top3_quality_score: Number.isFinite(
            Number(primaryQualityDecision?.top3QualityScore),
          )
            ? Number(primaryQualityDecision.top3QualityScore)
            : null,
          primary_strong_evidence_passed:
            primaryQualityDecision?.strongEvidencePassed == null
              ? null
              : Boolean(primaryQualityDecision.strongEvidencePassed),
          primary_quality_reason:
            String(primaryQualityDecision?.reason || '').trim() || null,
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
              nextUpstreamData?.metadata?.route_health &&
              typeof nextUpstreamData.metadata.route_health === 'object' &&
              !Array.isArray(nextUpstreamData.metadata.route_health)
                ? nextUpstreamData.metadata.route_health
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
            primary_target_relevant_count: Math.max(
              0,
              Number(primaryQualityDecision?.targetRelevantCount || 0) || 0,
            ),
            primary_top3_quality_score: Number.isFinite(
              Number(primaryQualityDecision?.top3QualityScore),
            )
              ? Number(primaryQualityDecision.top3QualityScore)
              : null,
            primary_strong_evidence_passed:
              primaryQualityDecision?.strongEvidencePassed == null
                ? null
                : Boolean(primaryQualityDecision.strongEvidencePassed),
            primary_quality_reason:
              String(primaryQualityDecision?.reason || '').trim() || null,
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
        },
      };
    } else if (
      (operation === 'find_products' || operation === 'find_products_multi') &&
      nextUpstreamData &&
      typeof nextUpstreamData === 'object' &&
      !Array.isArray(nextUpstreamData)
    ) {
      const routeHealthProducts = Array.isArray(nextUpstreamData?.products)
        ? nextUpstreamData.products
        : [];
      const routeHealthExternalCount = routeHealthProducts.filter((product) =>
        isExternalSeedProduct(product),
      ).length;
      const routeHealthInternalCount = Math.max(
        0,
        routeHealthProducts.length - routeHealthExternalCount,
      );
      const mergedPreLimitCount = Number.isFinite(Number(nextUpstreamData?.total))
        ? Math.max(routeHealthProducts.length, Number(nextUpstreamData.total))
        : routeHealthProducts.length;
      const supplementAttempted = Boolean(shouldFallback);
      const supplementSkipReason = !shouldFallback
        ? 'not_needed'
        : skipSecondaryFallback
        ? normalizedSecondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
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
      nextUpstreamData = {
        ...nextUpstreamData,
        metadata: {
          ...(nextUpstreamData.metadata && typeof nextUpstreamData.metadata === 'object'
            ? nextUpstreamData.metadata
            : {}),
          ...(shoppingExactTitleSupplementMeta
            ? { search_stage_exact_title: shoppingExactTitleSupplementMeta }
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
          primary_target_relevant_count: Math.max(
            0,
            Number(primaryQualityDecision?.targetRelevantCount || 0) || 0,
          ),
          primary_top3_quality_score: Number.isFinite(
            Number(primaryQualityDecision?.top3QualityScore),
          )
            ? Number(primaryQualityDecision.top3QualityScore)
            : null,
          primary_strong_evidence_passed:
            primaryQualityDecision?.strongEvidencePassed == null
              ? null
              : Boolean(primaryQualityDecision.strongEvidencePassed),
          primary_quality_reason:
            String(primaryQualityDecision?.reason || '').trim() || null,
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
              nextUpstreamData?.metadata?.route_health &&
              typeof nextUpstreamData.metadata.route_health === 'object' &&
              !Array.isArray(nextUpstreamData.metadata.route_health)
                ? nextUpstreamData.metadata.route_health
                : {}
            ),
            semantic_retry_applied: Boolean(semanticRetryApplied),
            ...(shoppingExactTitleSupplementMeta
              ? { search_stage_exact_title: shoppingExactTitleSupplementMeta }
              : {}),
            semantic_retry_actual_attempted: semanticRetryActualAttempted,
            semantic_retry_query: semanticRetryQuery ? String(semanticRetryQuery) : null,
            semantic_retry_hits: Math.max(0, Number(semanticRetryHits || 0) || 0),
            primary_quality_gate_passed: primaryQualityGatePassed,
            primary_quality_score:
              Number.isFinite(Number(primaryQualityScore)) && Number(primaryQualityScore) >= 0
                ? Number(primaryQualityScore)
                : null,
            primary_target_relevant_count: Math.max(
              0,
              Number(primaryQualityDecision?.targetRelevantCount || 0) || 0,
            ),
            primary_top3_quality_score: Number.isFinite(
              Number(primaryQualityDecision?.top3QualityScore),
            )
              ? Number(primaryQualityDecision.top3QualityScore)
              : null,
            primary_strong_evidence_passed:
              primaryQualityDecision?.strongEvidencePassed == null
                ? null
                : Boolean(primaryQualityDecision.strongEvidencePassed),
            primary_quality_reason:
              String(primaryQualityDecision?.reason || '').trim() || null,
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
        },
      };
    }

    if (
      (operation === 'find_products' || operation === 'find_products_multi') &&
      nextUpstreamData &&
      typeof nextUpstreamData === 'object' &&
      !Array.isArray(nextUpstreamData)
    ) {
      const normalizedGuardSource = normalizeAgentSource(metadata?.source);
      nextUpstreamData = {
        ...nextUpstreamData,
        metadata: {
          ...(nextUpstreamData.metadata && typeof nextUpstreamData.metadata === 'object'
            ? nextUpstreamData.metadata
            : {}),
          guard_source_normalized: normalizedGuardSource || null,
          secondary_fallback_skipped: skipSecondaryFallback,
          secondary_fallback_skip_reason: skipSecondaryFallback
            ? normalizedSecondaryFallbackSkipReason || 'resolver_miss_skip_secondary'
            : null,
          latency_guard_applied: Boolean(fpmLatencyGuardApplied),
          skipped_gates_due_to_budget: Array.from(
            new Set(
              fpmSkippedGatesDueToBudget
                .map((gateId) => String(gateId || '').trim())
                .filter(Boolean),
            ),
          ),
          gate_trace: fpmGateTrace,
          gate_summary: {
            applied_count: fpmGateTrace.filter((item) => item && item.applied).length,
            blocked_count: fpmGateTrace.filter(
              (item) =>
                item &&
                (String(item.decision || '') === 'strict_empty' ||
                  String(item.decision || '') === 'clarify_only_early'),
            ).length,
            total_cost_ms_estimate: fpmGateTrace.reduce(
              (sum, item) => sum + Math.max(0, Number(item?.cost_ms_estimate || 0) || 0),
              0,
            ),
          },
        },
      };
    }

    return nextUpstreamData;
  }

  return {
    applyInvokeStageMetadata,
  };
}

module.exports = {
  createFindProductsInvokeStageMetadataRuntime,
};
