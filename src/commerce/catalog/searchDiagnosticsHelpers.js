function createSearchDiagnosticsHelpers({
  buildFallbackCandidateText,
  hasFragranceQuerySignal,
  normalizeSearchTextForMatch,
  parseQueryNumber,
  normalizeAgentProductsListResponse,
  isExternalSeedProduct,
  hasLingerieSearchSignal,
  hasLingerieCatalogProductSignal,
  buildClarification,
  searchUpstreamQuotaClarifyEnabled = true,
  searchUpstreamQuotaClarifyQueryClasses = [],
} = {}) {
  const clarifyQueryClasses =
    searchUpstreamQuotaClarifyQueryClasses instanceof Set
      ? searchUpstreamQuotaClarifyQueryClasses
      : new Set(searchUpstreamQuotaClarifyQueryClasses);

  function withProxySearchFallbackMetadata(body, patch) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? { ...body.metadata }
        : {};
    metadata.proxy_search_fallback = {
      ...(metadata.proxy_search_fallback &&
      typeof metadata.proxy_search_fallback === 'object' &&
      !Array.isArray(metadata.proxy_search_fallback)
        ? metadata.proxy_search_fallback
        : {}),
      ...patch,
    };
    return { ...body, metadata };
  }

  function classifyBeautyMixBucket(product) {
    const text = buildFallbackCandidateText(product);
    if (!text) return 'other';
    if (
      /\b(foundation|concealer|primer|powder|cushion|bb cream|cc cream)\b/i.test(text) ||
      /(粉底|遮瑕|妆前|妝前|定妆|定妝|气垫|氣墊)/.test(text)
    ) {
      return 'base_makeup';
    }
    if (
      /\b(eyeshadow|eye shadow|eyeliner|mascara|brow|eyebrow)\b/i.test(text) ||
      /(眼影|眼线|眼線|睫毛膏|眉笔|眉筆|眉粉)/.test(text)
    ) {
      return 'eye_makeup';
    }
    if (
      /\b(lipstick|lip gloss|lip tint|lip balm|lip liner)\b/i.test(text) ||
      /(口红|口紅|唇釉|唇膏|唇蜜|唇线|唇線)/.test(text)
    ) {
      return 'lip_makeup';
    }
    if (
      /\b(brush|brush set|puff|sponge|applicator|curler|tweezer|tool|tools)\b/i.test(text) ||
      /(化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|睫毛夹|睫毛夾|工具)/.test(text)
    ) {
      return 'tools';
    }
    if (
      /\b(toner|serum|essence|lotion|moisturizer|sunscreen|cleanser|cream)\b/i.test(text) ||
      /(化妆水|化妝水|精华|精華|乳液|面霜|防晒|防曬|洁面|潔面|面膜)/.test(text)
    ) {
      return 'skincare';
    }
    return 'other';
  }

  function buildCategoryMixTopN(products, topN = 10) {
    const list = Array.isArray(products) ? products.slice(0, Math.max(1, Number(topN) || 10)) : [];
    const buckets = {};
    for (const product of list) {
      const bucket = classifyBeautyMixBucket(product);
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    }
    return buckets;
  }

  function buildSearchRelevanceDebug({ intent, products, diversityPenaltyApplied = false }) {
    const domain = String(intent?.primary_domain || '');
    if (!domain) return null;
    const out = {
      intent_domain: intent?.primary_domain || null,
      intent_scenario: intent?.scenario?.name || null,
      diversity_penalty_applied: Boolean(diversityPenaltyApplied),
    };
    if (domain === 'beauty') {
      out.category_mix_topN = buildCategoryMixTopN(products, 10);
    } else {
      out.category_mix_topN = null;
    }
    return out;
  }

  function withSearchDiagnostics(body, diagnostics = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? { ...body.metadata }
        : {};
    const existingRouteHealth =
      metadata.route_health &&
      typeof metadata.route_health === 'object' &&
      !Array.isArray(metadata.route_health)
        ? { ...metadata.route_health }
        : {};
    const routeHealthPatch =
      diagnostics.route_health &&
      typeof diagnostics.route_health === 'object' &&
      !Array.isArray(diagnostics.route_health)
        ? diagnostics.route_health
        : null;
    const routeHealth = routeHealthPatch ? { ...existingRouteHealth, ...routeHealthPatch } : existingRouteHealth;
    const existingSearchDecision =
      metadata.search_decision &&
      typeof metadata.search_decision === 'object' &&
      !Array.isArray(metadata.search_decision)
        ? { ...metadata.search_decision }
        : null;
    const existingSearchTrace =
      metadata.search_trace &&
      typeof metadata.search_trace === 'object' &&
      !Array.isArray(metadata.search_trace)
        ? { ...metadata.search_trace }
        : {};
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
      String(diagnostics?.search_trace?.raw_query || metadata?.search_trace?.raw_query || '').trim(),
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
        return hasFragranceQuerySignal(raw) ? 'fragrance' : '';
      })();
      const candidate =
        [
          routeHealth.query_semantic_class,
          metadata.query_semantic_class,
          existingSearchDecision?.query_semantic_class,
          routeDebugSemanticClass,
        ].find((value) => value != null && String(value).trim() !== '') || null;
      let value = String(candidate || '').trim().toLowerCase();
      if ((!value || value === 'default') && inferredByRawQuery) {
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
    metadata.low_quality_nonempty_detected = routeHealth.low_quality_nonempty_detected;
    metadata.supplement_attempted = routeHealth.supplement_attempted;
    metadata.supplement_skip_reason = routeHealth.supplement_skip_reason;
    metadata.retry_attempt_count = routeHealth.retry_attempt_count;
    metadata.fallback_attempt_count = routeHealth.fallback_attempt_count;
    metadata.selected_fallback_attempt = routeHealth.selected_fallback_attempt;
    metadata.final_returned_count = routeHealth.final_returned_count;
    metadata.fallback_reason = fallbackReason;
    if (existingSearchDecision) {
      existingSearchDecision.query_semantic_class = routeHealth.query_semantic_class;
      existingSearchDecision.domain_filter_dropped_external = routeHealth.domain_filter_dropped_external;
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
      metadata.search_decision = existingSearchDecision;
    }
    const cacheRouteDebug =
      metadata?.route_debug?.cross_merchant_cache &&
      typeof metadata.route_debug.cross_merchant_cache === 'object' &&
      !Array.isArray(metadata.route_debug.cross_merchant_cache)
        ? metadata.route_debug.cross_merchant_cache
        : null;
    const cacheSupplementMeta =
      cacheRouteDebug?.supplement && typeof cacheRouteDebug.supplement === 'object'
        ? cacheRouteDebug.supplement
        : null;
    const brandQueryDetectedDerived = Boolean(
      metadata.brand_query_detected === true ||
        existingSearchDecision?.brand_query_detected === true ||
        cacheSupplementMeta?.brand_query_detected === true,
    );
    const brandQueryBypassAmbiguityDerived = Boolean(
      metadata.brand_query_bypass_ambiguity === true ||
        existingSearchDecision?.brand_query_bypass_ambiguity === true ||
        cacheRouteDebug?.cache_strict_empty_bypass_reason === 'brand_query_search_first',
    );
    const brandEntitiesDerived = Array.from(
      new Set(
        [
          ...(Array.isArray(metadata.brand_entities) ? metadata.brand_entities : []),
          ...(Array.isArray(existingSearchDecision?.brand_entities) ? existingSearchDecision.brand_entities : []),
          ...(Array.isArray(cacheSupplementMeta?.brand_entities) ? cacheSupplementMeta.brand_entities : []),
        ]
          .map((item) => String(item || '').trim())
          .filter(Boolean),
      ),
    );
    const brandScopeDerived =
      [
        metadata.brand_scope,
        existingSearchDecision?.brand_scope,
        cacheSupplementMeta?.brand_scope,
        brandQueryDetectedDerived ? 'broad' : null,
      ].find((value) => value != null && String(value).trim() !== '') || null;
    metadata.brand_query_detected = brandQueryDetectedDerived;
    metadata.brand_query_bypass_ambiguity = brandQueryBypassAmbiguityDerived;
    metadata.brand_entities = brandEntitiesDerived;
    metadata.brand_scope = brandScopeDerived;
    metadata.search_decision = {
      ...(existingSearchDecision || {}),
      ...(existingSearchDecision?.query_class ? { query_class: existingSearchDecision.query_class } : {}),
      ...(existingSearchDecision?.query_semantic_class
        ? { query_semantic_class: existingSearchDecision.query_semantic_class }
        : {}),
      ...(existingSearchDecision?.final_decision
        ? { final_decision: existingSearchDecision.final_decision }
        : {}),
      brand_query_detected: brandQueryDetectedDerived,
      brand_entities: brandEntitiesDerived,
      brand_scope: brandScopeDerived,
      brand_query_bypass_ambiguity: brandQueryBypassAmbiguityDerived,
      domain_filter_dropped_external: routeHealth.domain_filter_dropped_external,
    };
    metadata.route_health = routeHealth;

    const mergedSearchTrace = diagnostics.search_trace
      ? {
          ...existingSearchTrace,
          ...diagnostics.search_trace,
        }
      : existingSearchTrace;
    const lingerieTraceSignal =
      String(mergedSearchTrace.intent_scenario || mergedSearchTrace.scenario || '').trim().toLowerCase() ===
        'lingerie' ||
      hasLingerieSearchSignal(mergedSearchTrace.raw_query || mergedSearchTrace.expanded_query || '');
    if (lingerieTraceSignal) {
      const sourceCandidateCount = Array.isArray(metadata.retrieval_sources)
        ? metadata.retrieval_sources.reduce((maxCount, source) => {
            const candidateCount = Number(source?.candidate_count ?? source?.count ?? 0);
            return Number.isFinite(candidateCount) && candidateCount > maxCount ? candidateCount : maxCount;
          }, 0)
        : 0;
      const bodyProducts = Array.isArray(body?.products) ? body.products : [];
      const visibleLingerieCount = bodyProducts.filter((product) =>
        hasLingerieCatalogProductSignal(buildFallbackCandidateText(product)),
      ).length;
      const visibleCandidateCount = bodyProducts.length;
      const lingerieFilteredOut =
        sourceCandidateCount > visibleCandidateCount
          ? sourceCandidateCount - visibleCandidateCount
          : Math.max(0, visibleCandidateCount - visibleLingerieCount);
      metadata.search_trace = {
        ...mergedSearchTrace,
        strict_scope: 'lingerie',
        lingerie_filtered_out: lingerieFilteredOut,
      };
    } else if (diagnostics.search_trace) {
      metadata.search_trace = mergedSearchTrace;
    }
    if (diagnostics.strict_empty != null) metadata.strict_empty = Boolean(diagnostics.strict_empty);
    if (diagnostics.strict_empty_reason) {
      metadata.strict_empty_reason = String(diagnostics.strict_empty_reason);
    }
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

  function isUpstreamQuotaExhausted({ upstreamStatus = null, upstreamCode = null, upstreamMessage = null }) {
    const status = Number(upstreamStatus || 0);
    const code = String(upstreamCode || '').trim().toUpperCase();
    const message = String(upstreamMessage || '').trim().toUpperCase();
    if (code.includes('RATE_LIMIT_EXCEEDED') || code.includes('DAILY_QUOTA_EXCEEDED')) return true;
    if (status === 429) return true;
    if (message.includes('QUOTA EXCEEDED') || message.includes('RATE LIMIT')) return true;
    return false;
  }

  function shouldClarifyOnQuota({ queryClass = null, intent = null }) {
    if (!searchUpstreamQuotaClarifyEnabled) return false;
    const normalizedClass = String(queryClass || intent?.query_class || '').trim().toLowerCase();
    if (!normalizedClass) return false;
    return clarifyQueryClasses.has(normalizedClass);
  }

  function buildClarificationReplyText(clarification) {
    if (!clarification || typeof clarification !== 'object') return '';
    const question = String(clarification.question || '').trim();
    if (!question) return '';
    const options = Array.isArray(clarification.options)
      ? clarification.options
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 4)
      : [];
    if (!options.length) return question;
    return `${question}\n${options.map((item, idx) => `${idx + 1}) ${item}`).join('\n')}`;
  }

  function buildProxySearchSoftFallbackResponse({
    queryParams,
    reason,
    upstreamStatus = null,
    upstreamCode = null,
    upstreamMessage = null,
    route = null,
    reply = 'Search is temporarily unavailable. Please retry shortly.',
    intent = null,
    queryClass = null,
    queryText = '',
    querySource = 'agent_products_error_fallback',
    semanticRetryApplied = false,
    semanticRetryQuery = null,
    semanticRetryHits = 0,
    forceClarify = false,
  }) {
    const quotaExhausted = isUpstreamQuotaExhausted({
      upstreamStatus,
      upstreamCode,
      upstreamMessage,
    });
    const forceClarifyByRecallExhaustion = false;
    const shouldClarify =
      Boolean(forceClarify) ||
      forceClarifyByRecallExhaustion ||
      (quotaExhausted && shouldClarifyOnQuota({ queryClass, intent }));
    const clarification = shouldClarify
      ? buildClarification({
          queryClass: String(queryClass || intent?.query_class || 'exploratory').toLowerCase(),
          intent:
            intent && typeof intent === 'object'
              ? intent
              : { language: 'en', query_class: queryClass },
          language:
            (intent && typeof intent === 'object' ? intent.language : null) ||
            (typeof queryText === 'string' && /[\u4e00-\u9fff]/.test(queryText) ? 'zh' : 'en'),
        })
      : null;
    const resolvedReply =
      shouldClarify && clarification ? buildClarificationReplyText(clarification) : reply;
    const normalized = normalizeAgentProductsListResponse(
      {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        page: 1,
        page_size: parseQueryNumber(queryParams?.limit ?? queryParams?.page_size) || 0,
        reply: resolvedReply,
        ...(clarification
          ? {
              clarification: {
                question: clarification.question,
                options: clarification.options,
                reason_code: clarification.reason_code,
                slot: clarification.slot,
                dedup_key: clarification.dedup_key,
              },
            }
          : {}),
        ...(shouldClarify
          ? {
              reason_codes: forceClarify
                ? ['SEMANTIC_RETRY_EXHAUSTED', 'AMBIGUITY_CLARIFY']
                : forceClarifyByRecallExhaustion
                ? ['SEMANTIC_RETRY_EXHAUSTED', 'AMBIGUITY_CLARIFY']
                : ['UPSTREAM_QUOTA_EXHAUSTED', 'AMBIGUITY_CLARIFY'],
            }
          : {}),
        metadata: {
          query_source: String(querySource || 'agent_products_error_fallback'),
          upstream_status: Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null,
          upstream_error_code: upstreamCode ? String(upstreamCode) : null,
          upstream_error_message: upstreamMessage ? String(upstreamMessage) : null,
          fallback_route: route || null,
          semantic_retry_applied: Boolean(semanticRetryApplied),
          semantic_retry_query: semanticRetryQuery ? String(semanticRetryQuery) : null,
          semantic_retry_hits: Math.max(0, Number(semanticRetryHits || 0) || 0),
          ...(quotaExhausted && shouldClarify ? { upstream_quota_guarded: true } : {}),
        },
      },
      {
        limit: queryParams?.limit,
        offset: queryParams?.offset,
      },
    );
    return withProxySearchFallbackMetadata(normalized, {
      applied: true,
      reason: reason || 'error_soft_fallback',
      route: route || null,
      upstream_status: Number.isFinite(Number(upstreamStatus)) ? Number(upstreamStatus) : null,
      upstream_error_code: upstreamCode ? String(upstreamCode) : null,
      upstream_error_message: upstreamMessage ? String(upstreamMessage) : null,
    });
  }

  function withStrictEmptyFallback({
    body,
    queryParams,
    reason,
    upstreamStatus = null,
    upstreamCode = null,
    upstreamMessage = null,
    route = null,
    fallbackStrategy = null,
    intent = null,
    queryClass = null,
    queryText = '',
  }) {
    const emptyBody = buildProxySearchSoftFallbackResponse({
      queryParams,
      reason,
      upstreamStatus,
      upstreamCode,
      upstreamMessage,
      route,
      intent,
      queryClass,
      queryText,
      querySource: 'agent_products_error_fallback',
    });
    const hasClarification = Boolean(emptyBody?.clarification?.question);
    return withSearchDiagnostics(emptyBody, {
      strict_empty: !hasClarification,
      ...(hasClarification ? {} : { strict_empty_reason: reason || 'strict_empty' }),
      ...(fallbackStrategy && typeof fallbackStrategy === 'object'
        ? { fallback_strategy: fallbackStrategy }
        : {}),
    });
  }

  return {
    withProxySearchFallbackMetadata,
    buildSearchRelevanceDebug,
    withSearchDiagnostics,
    withStrictEmptyFallback,
    buildProxySearchSoftFallbackResponse,
  };
}

module.exports = {
  createSearchDiagnosticsHelpers,
};
