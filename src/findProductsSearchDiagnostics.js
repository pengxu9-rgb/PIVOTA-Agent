function createFindProductsSearchDiagnosticsRuntime(deps = {}) {
  const {
    normalizeSearchTextForMatch,
    isExternalSeedProduct,
    inferFragranceSemanticClass,
    normalizeDecisionObserverNodes,
    extractSearchDecisionAuthorityState,
    buildFallbackCandidateText,
    buildCacheStageDiagnosticBundle,
    buildServiceVersionMetadata,
  } = deps;

  function withSearchDiagnostics(body, diagnostics = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? { ...body.metadata }
        : {};
    const existingRouteHealth =
      metadata.route_health && typeof metadata.route_health === 'object' && !Array.isArray(metadata.route_health)
        ? { ...metadata.route_health }
        : {};
    const routeHealthPatch =
      diagnostics.route_health && typeof diagnostics.route_health === 'object' && !Array.isArray(diagnostics.route_health)
        ? diagnostics.route_health
        : null;
    const routeHealth = routeHealthPatch ? { ...existingRouteHealth, ...routeHealthPatch } : existingRouteHealth;
    const existingSearchTrace =
      metadata.search_trace && typeof metadata.search_trace === 'object' && !Array.isArray(metadata.search_trace)
        ? { ...metadata.search_trace }
        : null;
    const searchTracePatch =
      diagnostics.search_trace && typeof diagnostics.search_trace === 'object' && !Array.isArray(diagnostics.search_trace)
        ? diagnostics.search_trace
        : null;
    const searchTrace = searchTracePatch
      ? { ...(existingSearchTrace || {}), ...searchTracePatch }
      : existingSearchTrace;
    const searchDecisionPatch =
      diagnostics.search_decision && typeof diagnostics.search_decision === 'object' && !Array.isArray(diagnostics.search_decision)
        ? diagnostics.search_decision
        : null;
    const baseSearchDecision =
      metadata.search_decision && typeof metadata.search_decision === 'object' && !Array.isArray(metadata.search_decision)
        ? { ...metadata.search_decision }
        : null;
    let existingSearchDecision = searchDecisionPatch
      ? { ...(baseSearchDecision || {}), ...searchDecisionPatch }
      : baseSearchDecision;
    if (
      !existingSearchDecision &&
      (
        searchTrace?.final_decision ||
        routeHealth?.primary_path_used ||
        metadata.query_source
      )
    ) {
      existingSearchDecision = {};
    }
    if (existingSearchDecision && searchTrace?.final_decision && !existingSearchDecision.final_decision) {
      existingSearchDecision.final_decision = searchTrace.final_decision;
    }
    if (existingSearchDecision && routeHealth?.primary_path_used && !existingSearchDecision.primary_path_used) {
      existingSearchDecision.primary_path_used = routeHealth.primary_path_used;
    }
    const intNonNegative = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    };
    const fallbackStrategy =
      metadata.fallback_strategy && typeof metadata.fallback_strategy === 'object'
        ? metadata.fallback_strategy
        : {};
    const secondaryAttempts = Array.isArray(fallbackStrategy.secondary_attempts)
      ? fallbackStrategy.secondary_attempts.filter((item) => item && typeof item === 'object')
      : [];
    const secondaryAttemptCount = intNonNegative(fallbackStrategy.secondary_attempt_count);
    const retryBaseQueryNormalized = normalizeSearchTextForMatch(
      String(
        diagnostics?.search_trace?.raw_query ||
          metadata?.search_trace?.raw_query ||
          '',
      ).trim(),
    );
    const semanticRetryQueryCandidate =
      metadata.semantic_retry_query ||
      routeHealth.semantic_retry_query ||
      fallbackStrategy.secondary_selected_query ||
      (secondaryAttempts.length > 1 ? secondaryAttempts[secondaryAttempts.length - 1]?.query : null) ||
      null;
    const semanticRetryQueryNormalized = normalizeSearchTextForMatch(
      String(semanticRetryQueryCandidate || '').trim(),
    );
    const semanticRetryActualAttemptedDerived = Boolean(
      metadata.semantic_retry_actual_attempted === true ||
        routeHealth.semantic_retry_actual_attempted === true ||
        fallbackStrategy.secondary_actual_retry_attempted === true ||
        String(metadata?.proxy_search_fallback?.query_variant || '').trim() === 'semantic_retry' ||
        secondaryAttempts.length > 1 ||
        secondaryAttemptCount > 1 ||
        (
          semanticRetryQueryNormalized &&
          retryBaseQueryNormalized &&
          semanticRetryQueryNormalized !== retryBaseQueryNormalized
        ),
    );
    const semanticRetryAppliedDerived = semanticRetryActualAttemptedDerived;
    const semanticRetryQueryDerived = semanticRetryAppliedDerived ? semanticRetryQueryCandidate : null;
    const semanticRetryHitsDerived = intNonNegative(
      metadata.semantic_retry_hits != null
        ? metadata.semantic_retry_hits
        : routeHealth.semantic_retry_hits != null
        ? routeHealth.semantic_retry_hits
        : semanticRetryAppliedDerived
        ? fallbackStrategy.secondary_usable_count
        : 0,
    );
    const bodyProductsForHealth = Array.isArray(body?.products) ? body.products : [];
    const bodyExternalCountForHealth = bodyProductsForHealth.filter((product) =>
      isExternalSeedProduct(product),
    ).length;
    const bodyInternalCountForHealth = Math.max(0, bodyProductsForHealth.length - bodyExternalCountForHealth);
    routeHealth.orchestrator_path = String(
      routeHealth.orchestrator_path || metadata.orchestrator_path || 'external_invoke_route',
    );
    routeHealth.decision_node = String(
      routeHealth.decision_node ||
        metadata.decision_node ||
        metadata.query_source ||
        routeHealth.primary_path_used ||
        'unknown',
    );
    const normalizedQuerySemanticClass = (() => {
      const routeDebugSemanticClass = String(
        metadata?.route_debug?.policy?.ambiguity?.query_semantic_class || '',
      )
        .trim()
        .toLowerCase();
      const inferredByRawQuery = (() => {
        const raw =
          String(diagnostics?.search_trace?.raw_query || metadata?.search_trace?.raw_query || '').trim();
        if (!raw) return '';
        return inferFragranceSemanticClass(raw);
      })();
      const candidate =
        [
          routeHealth.query_semantic_class,
          metadata.query_semantic_class,
          existingSearchDecision?.query_semantic_class,
          routeDebugSemanticClass,
        ].find((value) => value != null && String(value).trim() !== '') || null;
      let value = String(candidate || '').trim().toLowerCase();
      if (inferredByRawQuery === 'fragrance_free_skincare') {
        value = inferredByRawQuery;
      } else if ((!value || value === 'default') && inferredByRawQuery) {
        value = inferredByRawQuery;
      }
      return value || null;
    })();
    routeHealth.query_semantic_class = normalizedQuerySemanticClass;
    routeHealth.domain_filter_dropped_external = intNonNegative(
      routeHealth.domain_filter_dropped_external != null
        ? routeHealth.domain_filter_dropped_external
        : metadata.domain_filter_dropped_external != null
        ? metadata.domain_filter_dropped_external
        : existingSearchDecision?.domain_filter_dropped_external,
    );
    routeHealth.external_fill_gate_reason =
      routeHealth.external_fill_gate_reason != null
        ? routeHealth.external_fill_gate_reason
        : metadata.external_fill_gate_reason || null;
    routeHealth.semantic_retry_applied = semanticRetryAppliedDerived;
    routeHealth.semantic_retry_actual_attempted = semanticRetryActualAttemptedDerived;
    routeHealth.semantic_retry_query = semanticRetryQueryDerived ? String(semanticRetryQueryDerived) : null;
    routeHealth.semantic_retry_hits = semanticRetryHitsDerived;
    routeHealth.external_seed_query_timeout = Boolean(
      routeHealth.external_seed_query_timeout != null
        ? routeHealth.external_seed_query_timeout
        : metadata.external_seed_query_timeout,
    );
    routeHealth.external_seed_skip_reason =
      routeHealth.external_seed_skip_reason != null
        ? String(routeHealth.external_seed_skip_reason || '').trim() || null
        : String(metadata.external_seed_skip_reason || '').trim() || null;
    routeHealth.external_seed_cache_hit =
      Boolean(
        routeHealth.external_seed_cache_hit != null
          ? routeHealth.external_seed_cache_hit
          : metadata.external_seed_cache_hit,
      ) || routeHealth.external_seed_skip_reason === 'cache_hit';
    routeHealth.external_seed_rows_fetched = intNonNegative(
      routeHealth.external_seed_rows_fetched != null
        ? routeHealth.external_seed_rows_fetched
        : metadata.external_seed_rows_fetched,
    );
    routeHealth.external_seed_rows_built = intNonNegative(
      routeHealth.external_seed_rows_built != null
        ? routeHealth.external_seed_rows_built
        : metadata.external_seed_rows_built,
    );
    const fallbackReasonToken = String(
      routeHealth.fallback_reason != null ? routeHealth.fallback_reason : metadata.fallback_reason || '',
    )
      .trim()
      .toLowerCase();
    const lowQualityReasonHint = fallbackReasonToken.includes('low_quality');
    routeHealth.external_seed_brand_strict_rows = intNonNegative(
      routeHealth.external_seed_brand_strict_rows != null
        ? routeHealth.external_seed_brand_strict_rows
        : metadata.external_seed_brand_strict_rows,
    );
    routeHealth.external_seed_brand_relevant_rows = intNonNegative(
      routeHealth.external_seed_brand_relevant_rows != null
        ? routeHealth.external_seed_brand_relevant_rows
        : metadata.external_seed_brand_relevant_rows,
    );
    routeHealth.external_seed_broad_fallback_used = Boolean(
      routeHealth.external_seed_broad_fallback_used != null
        ? routeHealth.external_seed_broad_fallback_used
        : metadata.external_seed_broad_fallback_used,
    );
    routeHealth.external_seed_broad_scope_rows = intNonNegative(
      routeHealth.external_seed_broad_scope_rows != null
        ? routeHealth.external_seed_broad_scope_rows
        : metadata.external_seed_broad_scope_rows,
    );
    routeHealth.internal_raw_count = Math.max(
      intNonNegative(
        routeHealth.internal_raw_count != null
          ? routeHealth.internal_raw_count
          : metadata.internal_raw_count != null
          ? metadata.internal_raw_count
          : metadata?.source_breakdown?.internal_count,
      ),
      bodyInternalCountForHealth,
    );
    routeHealth.external_raw_count = Math.max(
      intNonNegative(
        routeHealth.external_raw_count != null
          ? routeHealth.external_raw_count
          : metadata.external_raw_count != null
          ? metadata.external_raw_count
          : metadata?.source_breakdown?.external_seed_count,
      ),
      bodyExternalCountForHealth,
    );
    const externalSeedReturnedCount = routeHealth.external_raw_count;
    routeHealth.external_seed_rows_fetched = Math.max(
      routeHealth.external_seed_rows_fetched,
      intNonNegative(metadata.external_seed_returned_count),
      bodyExternalCountForHealth,
    );
    routeHealth.external_seed_rows_built = Math.max(
      routeHealth.external_seed_rows_built,
      intNonNegative(metadata.external_seed_returned_count),
      bodyExternalCountForHealth,
    );
    routeHealth.external_seed_returned_count = externalSeedReturnedCount;
    routeHealth.merged_pre_limit_count = Math.max(
      routeHealth.merged_pre_limit_count != null
        ? intNonNegative(routeHealth.merged_pre_limit_count)
        : metadata.merged_pre_limit_count != null
        ? intNonNegative(metadata.merged_pre_limit_count)
        : intNonNegative(body?.total),
      bodyProductsForHealth.length,
    );
    const primaryQualityScoreRaw =
      routeHealth.primary_quality_score != null
        ? routeHealth.primary_quality_score
        : metadata.primary_quality_score;
    routeHealth.primary_quality_score =
      Number.isFinite(Number(primaryQualityScoreRaw)) && Number(primaryQualityScoreRaw) >= 0
        ? Math.max(0, Math.min(1, Number(primaryQualityScoreRaw)))
        : null;
    routeHealth.primary_target_relevant_count = intNonNegative(
      routeHealth.primary_target_relevant_count != null
        ? routeHealth.primary_target_relevant_count
        : metadata.primary_target_relevant_count,
    );
    const primaryTop3QualityScoreRaw =
      routeHealth.primary_top3_quality_score != null
        ? routeHealth.primary_top3_quality_score
        : metadata.primary_top3_quality_score;
    routeHealth.primary_top3_quality_score =
      Number.isFinite(Number(primaryTop3QualityScoreRaw))
        ? Number(primaryTop3QualityScoreRaw)
        : null;
    routeHealth.primary_strong_evidence_passed =
      routeHealth.primary_strong_evidence_passed != null
        ? Boolean(routeHealth.primary_strong_evidence_passed)
        : metadata.primary_strong_evidence_passed != null
        ? Boolean(metadata.primary_strong_evidence_passed)
        : null;
    routeHealth.primary_quality_reason =
      routeHealth.primary_quality_reason != null
        ? String(routeHealth.primary_quality_reason || '').trim() || null
        : String(metadata.primary_quality_reason || '').trim() || null;
    const lowQualityNonemptyDerived = Boolean(
      routeHealth.low_quality_nonempty_detected != null
        ? routeHealth.low_quality_nonempty_detected
        : metadata.low_quality_nonempty_detected,
    );
    routeHealth.low_quality_nonempty_detected = lowQualityNonemptyDerived || lowQualityReasonHint;
    if (lowQualityReasonHint) {
      routeHealth.primary_quality_gate_passed = false;
    } else {
      routeHealth.primary_quality_gate_passed = Boolean(
        routeHealth.primary_quality_gate_passed != null
          ? routeHealth.primary_quality_gate_passed
          : metadata.primary_quality_gate_passed != null
          ? metadata.primary_quality_gate_passed
          : !routeHealth.low_quality_nonempty_detected,
      );
    }
    routeHealth.supplement_attempted = Boolean(
      routeHealth.supplement_attempted != null
        ? routeHealth.supplement_attempted
        : metadata.supplement_attempted != null
        ? metadata.supplement_attempted
        : metadata?.search_stage_b?.attempted,
    );
    routeHealth.supplement_skip_reason =
      routeHealth.supplement_skip_reason != null
        ? String(routeHealth.supplement_skip_reason || '').trim() || null
        : String(
            metadata.supplement_skip_reason != null
              ? metadata.supplement_skip_reason
              : metadata?.search_stage_b?.reason || '',
          ).trim() || null;
    const retryAttemptCountDerived = intNonNegative(
      routeHealth.retry_attempt_count != null
        ? routeHealth.retry_attempt_count
        : metadata.retry_attempt_count != null
        ? metadata.retry_attempt_count
        : metadata?.fallback_strategy?.secondary_attempt_count,
    );
    routeHealth.retry_attempt_count = Math.max(
      retryAttemptCountDerived,
      secondaryAttemptCount,
      semanticRetryActualAttemptedDerived ? 1 : 0,
    );
    routeHealth.fallback_attempt_count = Math.max(
      intNonNegative(routeHealth.fallback_attempt_count),
      intNonNegative(metadata.fallback_attempt_count),
      secondaryAttemptCount,
    );
    routeHealth.selected_fallback_attempt = Math.max(
      intNonNegative(routeHealth.selected_fallback_attempt),
      intNonNegative(metadata.selected_fallback_attempt),
      intNonNegative(fallbackStrategy.secondary_selected_attempt),
    );
    routeHealth.final_returned_count = Math.max(
      intNonNegative(
        routeHealth.final_returned_count != null
          ? routeHealth.final_returned_count
          : metadata.final_returned_count != null
          ? metadata.final_returned_count
          : Array.isArray(body?.products)
          ? body.products.length
          : 0,
      ),
      bodyProductsForHealth.length,
    );
    const fallbackReason =
      routeHealth.fallback_reason != null
        ? routeHealth.fallback_reason
        : metadata.fallback_reason != null
        ? metadata.fallback_reason
        : null;
    routeHealth.fallback_reason = fallbackReason;
    metadata.orchestrator_path = routeHealth.orchestrator_path;
    metadata.decision_node = routeHealth.decision_node;
    metadata.query_semantic_class = routeHealth.query_semantic_class;
    metadata.domain_filter_dropped_external = routeHealth.domain_filter_dropped_external;
    metadata.external_fill_gate_reason = routeHealth.external_fill_gate_reason;
    metadata.semantic_retry_applied = routeHealth.semantic_retry_applied;
    metadata.semantic_retry_actual_attempted = routeHealth.semantic_retry_actual_attempted;
    metadata.semantic_retry_query = routeHealth.semantic_retry_query;
    metadata.semantic_retry_hits = routeHealth.semantic_retry_hits;
    metadata.external_seed_query_timeout = routeHealth.external_seed_query_timeout;
    metadata.external_seed_skip_reason = routeHealth.external_seed_skip_reason;
    metadata.external_seed_cache_hit = routeHealth.external_seed_cache_hit;
    metadata.external_seed_rows_fetched = routeHealth.external_seed_rows_fetched;
    metadata.external_seed_rows_built = routeHealth.external_seed_rows_built;
    metadata.external_seed_brand_strict_rows = routeHealth.external_seed_brand_strict_rows;
    metadata.external_seed_brand_relevant_rows = routeHealth.external_seed_brand_relevant_rows;
    metadata.external_seed_broad_fallback_used = routeHealth.external_seed_broad_fallback_used;
    metadata.external_seed_broad_scope_rows = routeHealth.external_seed_broad_scope_rows;
    metadata.external_seed_returned_count = externalSeedReturnedCount;
    metadata.internal_raw_count = routeHealth.internal_raw_count;
    metadata.external_raw_count = routeHealth.external_raw_count;
    metadata.merged_pre_limit_count = routeHealth.merged_pre_limit_count;
    metadata.primary_quality_gate_passed = routeHealth.primary_quality_gate_passed;
    metadata.primary_quality_score = routeHealth.primary_quality_score;
    metadata.primary_target_relevant_count = routeHealth.primary_target_relevant_count;
    metadata.primary_top3_quality_score = routeHealth.primary_top3_quality_score;
    metadata.primary_strong_evidence_passed = routeHealth.primary_strong_evidence_passed;
    metadata.primary_quality_reason = routeHealth.primary_quality_reason;
    metadata.low_quality_nonempty_detected = routeHealth.low_quality_nonempty_detected;
    metadata.supplement_attempted = routeHealth.supplement_attempted;
    metadata.supplement_skip_reason = routeHealth.supplement_skip_reason;
    metadata.retry_attempt_count = routeHealth.retry_attempt_count;
    metadata.fallback_attempt_count = routeHealth.fallback_attempt_count;
    metadata.selected_fallback_attempt = routeHealth.selected_fallback_attempt;
    metadata.final_returned_count = routeHealth.final_returned_count;
    metadata.fallback_reason = fallbackReason;
    const observerNodes = normalizeDecisionObserverNodes(
      routeHealth.observer_nodes,
      diagnostics.observer_nodes,
      existingSearchDecision?.observer_nodes,
    );
    routeHealth.observer_nodes = observerNodes;
    const brandQueryBypassAmbiguity = Boolean(
      metadata.brand_query_bypass_ambiguity === true ||
        existingSearchDecision?.brand_query_bypass_ambiguity === true ||
        metadata?.route_debug?.policy?.ambiguity?.brand_query_bypass_ambiguity === true,
    );
    metadata.brand_query_bypass_ambiguity = brandQueryBypassAmbiguity;
    if (existingSearchDecision) {
      existingSearchDecision.query_semantic_class = routeHealth.query_semantic_class;
      existingSearchDecision.domain_filter_dropped_external = routeHealth.domain_filter_dropped_external;
      existingSearchDecision.brand_query_bypass_ambiguity = brandQueryBypassAmbiguity;
      const bodyProducts = Array.isArray(body?.products) ? body.products : [];
      const hasBodyClarification = Boolean(body?.clarification?.question);
      const decisionToken = String(existingSearchDecision.final_decision || '').trim();
      const productsEmpty = bodyProducts.length === 0;
      if (productsEmpty) {
        if (hasBodyClarification) {
          if (
            decisionToken === 'products_returned' ||
            decisionToken === 'upstream_returned' ||
            decisionToken === 'cache_returned' ||
            decisionToken === 'resolver_returned'
          ) {
            existingSearchDecision.final_decision = 'clarify';
          }
        } else if (
          decisionToken === 'products_returned' ||
          decisionToken === 'products_returned_with_clarification' ||
          decisionToken === 'upstream_returned' ||
          decisionToken === 'cache_returned' ||
          decisionToken === 'resolver_returned'
        ) {
          existingSearchDecision.final_decision = 'strict_empty';
        }
      }
      const authorityState = extractSearchDecisionAuthorityState({
        metadata: {
          ...metadata,
          route_health: routeHealth,
          ...(searchTrace ? { search_trace: searchTrace } : {}),
          search_decision: existingSearchDecision,
        },
      });
      existingSearchDecision.decision_authority = authorityState.decisionAuthority;
      existingSearchDecision.decision_locked = authorityState.decisionLocked;
      existingSearchDecision.decision_lock_reason = authorityState.decisionLockReason;
      metadata.search_decision = existingSearchDecision;
    }
    metadata.route_health = routeHealth;

    if (searchTrace) metadata.search_trace = searchTrace;
    const metadataSearchTrace = searchTrace
      ? { ...searchTrace }
      : null;
    if (metadataSearchTrace) {
      const rawTraceQuery = String(metadataSearchTrace.raw_query || '').trim();
      const lingerieScopedQuery =
        /\b(lingerie|underwear)\b/i.test(rawTraceQuery) || /内衣|文胸|胸罩|下着|ランジェリー/.test(rawTraceQuery);
      if (lingerieScopedQuery) {
        const fromPolicyHardBlocked = Math.max(
          0,
          Number(metadata?.route_debug?.policy?.filter_debug?.hard_blocked || 0) || 0,
        );
        const preFilterCount = Math.max(
          0,
          Number(
            metadata?.route_debug?.cross_merchant_cache?.internal_products_count ??
              metadata?.route_debug?.cross_merchant_cache?.products_count ??
              metadata?.internal_raw_count ??
              body?.total ??
              0,
          ) || 0,
        );
        const returnedCount = Array.isArray(body?.products) ? body.products.length : 0;
        const fromRecallDrop = Math.max(0, preFilterCount - returnedCount);
        let lingerieFilteredOut = Math.max(fromPolicyHardBlocked, fromRecallDrop);
        if (lingerieFilteredOut <= 0 && Array.isArray(body?.products) && body.products.length > 0) {
          const returnedHasToolLike = body.products.some((product) =>
            /\b(brush|tool|tools|applicator|sponge)\b/i.test(buildFallbackCandidateText(product)),
          );
          if (!returnedHasToolLike) {
            lingerieFilteredOut = 1;
          }
        }
        metadata.search_trace = {
          ...metadataSearchTrace,
          strict_scope: 'lingerie',
          lingerie_filtered_out: lingerieFilteredOut,
        };
      }
    }
    if (diagnostics.strict_empty != null) metadata.strict_empty = Boolean(diagnostics.strict_empty);
    if (diagnostics.strict_empty_reason) {
      metadata.strict_empty_reason = String(diagnostics.strict_empty_reason);
    }
    const cacheRouteDebug =
      metadata.route_debug &&
      typeof metadata.route_debug === 'object' &&
      !Array.isArray(metadata.route_debug) &&
      metadata.route_debug.cross_merchant_cache &&
      typeof metadata.route_debug.cross_merchant_cache === 'object' &&
      !Array.isArray(metadata.route_debug.cross_merchant_cache)
        ? metadata.route_debug.cross_merchant_cache
        : null;
    const cacheStageBundle = buildCacheStageDiagnosticBundle(
      diagnostics?.search_trace?.cache_stage || metadata?.search_trace?.cache_stage || null,
      cacheRouteDebug,
    );
    if (cacheStageBundle && cacheStageBundle.cache_stage_attempted) {
      Object.assign(metadata, cacheStageBundle);
    }
    metadata.service_version = buildServiceVersionMetadata();
    if (diagnostics.relevance_debug && typeof diagnostics.relevance_debug === 'object') {
      metadata.relevance_debug = diagnostics.relevance_debug;
    }
    if (diagnostics.fallback_strategy && typeof diagnostics.fallback_strategy === 'object') {
      metadata.fallback_strategy = diagnostics.fallback_strategy;
    }

    return {
      ...body,
      metadata,
    };
  }

  return {
    withSearchDiagnostics,
  };
}

module.exports = {
  createFindProductsSearchDiagnosticsRuntime,
};
