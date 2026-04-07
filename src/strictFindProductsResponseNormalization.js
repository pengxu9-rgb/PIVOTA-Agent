function createStrictFindProductsResponseNormalizationRuntime(deps = {}) {
  const {
    isPlainRecord,
    toNonEmptyStringOrNull,
    uniqueStrings,
    isShoppingSource,
    resolveLegacyBeautyCacheOwnerBypass,
    isRecoverableStrictSoftFallbackQuerySource,
    extractStrictBudgetConstraintFromInvokeRequestBody,
    extractStrictBudgetMetadataFromInvokeRequestBody,
    resolveStrictBudgetMetadata,
    productMatchesStrictBudgetConstraint,
    buildStrictEmptyFallbackResponse,
  } = deps;

  function recoverStrictMainPathResponseFromPrefetch({
    responseBody = null,
    invokeRequestBody = {},
    strictInvokeDecision = null,
  } = {}) {
    if (!isPlainRecord(responseBody)) return responseBody;
    if (!strictInvokeDecision?.strictConstraintQuery) return responseBody;
    const requestSource = String(
      invokeRequestBody?.metadata?.source ||
        invokeRequestBody?.payload?.metadata?.source ||
        invokeRequestBody?.payload?.context?.source ||
        '',
    ).trim();
    if (isShoppingSource(requestSource)) return responseBody;
    const legacyBeautyCacheBypass = resolveLegacyBeautyCacheOwnerBypass({
      search: invokeRequestBody?.payload?.search,
      metadata: {
        ...(isPlainRecord(invokeRequestBody?.payload?.metadata) ? invokeRequestBody.payload.metadata : {}),
        ...(isPlainRecord(invokeRequestBody?.metadata) ? invokeRequestBody.metadata : {}),
      },
      rawQuery:
        invokeRequestBody?.payload?.search?.query ||
        invokeRequestBody?.payload?.query ||
        '',
      queryClass:
        invokeRequestBody?.payload?.search?.query_class ||
        invokeRequestBody?.payload?.metadata?.query_class ||
        null,
      strictConstraintQuery: Boolean(strictInvokeDecision?.strictConstraintQuery),
    });
    if (legacyBeautyCacheBypass.bypass) return responseBody;
    const prefetchedCandidates = Array.isArray(invokeRequestBody?.metadata?.external_seed_candidates)
      ? invokeRequestBody.metadata.external_seed_candidates.filter((item) => isPlainRecord(item))
      : [];
    if (!prefetchedCandidates.length) return responseBody;
    const metadata = isPlainRecord(responseBody.metadata) ? responseBody.metadata : {};
    const products = Array.isArray(responseBody.products) ? responseBody.products : [];
    const hasClarification = Boolean(responseBody?.clarification && responseBody.clarification.question);
    const querySource = String(metadata.query_source || '').trim();
    const finalDecision = String(
      metadata?.search_trace?.final_decision ||
        metadata?.search_decision?.final_decision ||
        metadata.final_decision ||
        '',
    )
      .trim()
      .toLowerCase();
    const recoverableStrictSoftFallback =
      isRecoverableStrictSoftFallbackQuerySource(querySource) || finalDecision === 'strict_empty';
    if (products.length > 0 || hasClarification) return responseBody;
    if (
      metadata?.route_health?.fallback_triggered === true &&
      !recoverableStrictSoftFallback
    ) {
      return responseBody;
    }
    if (
      querySource &&
      !querySource.startsWith('cache_') &&
      !recoverableStrictSoftFallback
    ) {
      return responseBody;
    }
    const budgetConstraint = extractStrictBudgetConstraintFromInvokeRequestBody(invokeRequestBody);
    const limit = Math.max(
      1,
      Number(invokeRequestBody?.payload?.search?.limit || invokeRequestBody?.payload?.search?.page_size || 10) || 10,
    );
    const supplementedProducts = prefetchedCandidates
      .filter((item) => productMatchesStrictBudgetConstraint(item, budgetConstraint))
      .slice(0, limit);
    if (!supplementedProducts.length) return responseBody;

    const {
      strict_empty: _ignoredStrictEmpty,
      strict_empty_reason: _ignoredStrictEmptyReason,
      ...restMetadata
    } = metadata;
    const searchDecision = isPlainRecord(restMetadata.search_decision) ? restMetadata.search_decision : {};
    const searchTrace = isPlainRecord(restMetadata.search_trace) ? restMetadata.search_trace : {};
    const routeHealth = isPlainRecord(restMetadata.route_health) ? restMetadata.route_health : {};
    const sourceBreakdown = isPlainRecord(restMetadata.source_breakdown)
      ? restMetadata.source_breakdown
      : {};
    const contractBridge = isPlainRecord(restMetadata.contract_bridge)
      ? restMetadata.contract_bridge
      : {};
    const ingredientIntents = Array.isArray(restMetadata.ingredient_intents)
      ? restMetadata.ingredient_intents
          .map((value) => toNonEmptyStringOrNull(value))
          .filter(Boolean)
      : [];
    const strictIngredientIntents = Array.isArray(strictInvokeDecision?.ingredientIntents)
      ? strictInvokeDecision.ingredientIntents
          .map((value) => toNonEmptyStringOrNull(value))
          .filter(Boolean)
      : [];
    const matchedIngredientIds = Array.isArray(restMetadata.matched_ingredient_ids)
      ? restMetadata.matched_ingredient_ids
          .map((value) => toNonEmptyStringOrNull(value))
          .filter(Boolean)
      : [];
    const budgetMetadata = extractStrictBudgetMetadataFromInvokeRequestBody(invokeRequestBody);
    const nextMetadata = {
      ...restMetadata,
      ...budgetMetadata,
      query_source:
        querySource && querySource.startsWith('cache_')
          ? querySource
          : 'cache_multi_intent',
      strict_constraint_query: true,
      strict_constraint_reason:
        strictInvokeDecision.strictConstraintReason ||
        restMetadata.strict_constraint_reason ||
        null,
      ingredient_intents:
        ingredientIntents.length > 0 ? ingredientIntents : strictIngredientIntents,
      matched_ingredient_ids:
        matchedIngredientIds.length > 0
          ? matchedIngredientIds
          : ingredientIntents.length > 0
            ? ingredientIntents
            : strictIngredientIntents,
      external_seed_returned_count: supplementedProducts.length,
      external_seed_rows_fetched: Math.max(
        supplementedProducts.length,
        Number(restMetadata.external_seed_rows_fetched || 0) || 0,
      ),
      external_seed_rows_built: Math.max(
        supplementedProducts.length,
        Number(restMetadata.external_seed_rows_built || 0) || 0,
      ),
      source_breakdown: {
        ...sourceBreakdown,
        internal_count: Math.max(0, Number(sourceBreakdown.internal_count || 0) || 0),
        external_seed_count: supplementedProducts.length,
        strategy_applied:
          toNonEmptyStringOrNull(sourceBreakdown.strategy_applied) || 'strict_ingredient_mixed_parity',
      },
      contract_bridge: {
        ...contractBridge,
        attempted_contract: 'shop_invoke_strict',
        resolved_contract: 'shop_invoke_strict',
        legacy_fallback: false,
      },
      search_decision: {
        ...searchDecision,
        final_decision: 'cache_returned',
      },
      search_trace: {
        ...searchTrace,
        final_decision: 'cache_returned',
      },
      route_health: {
        ...routeHealth,
        fallback_triggered: false,
        fallback_reason: null,
        primary_path_used:
          toNonEmptyStringOrNull(routeHealth.primary_path_used) || 'cache_stage',
        external_seed_rows_fetched: Math.max(
          supplementedProducts.length,
          Number(routeHealth.external_seed_rows_fetched || 0) || 0,
        ),
        external_seed_rows_built: Math.max(
          supplementedProducts.length,
          Number(routeHealth.external_seed_rows_built || 0) || 0,
        ),
        external_seed_returned_count: supplementedProducts.length,
        final_returned_count: supplementedProducts.length,
      },
      strict_prefetch_recovered: true,
      strict_prefetch_recovery_source: 'agent_strict_ingredient_prefetch',
    };

    const {
      strict_empty: _bodyStrictEmpty,
      strict_empty_reason: _bodyStrictEmptyReason,
      ...restBody
    } = responseBody;
    return {
      ...restBody,
      products: supplementedProducts,
      total: supplementedProducts.length,
      page_size: supplementedProducts.length,
      reply: null,
      metadata: nextMetadata,
    };
  }

  function normalizeStrictCacheMainPathFallbackMetadata({
    responseBody = null,
    strictInvokeDecision = null,
  } = {}) {
    if (!isPlainRecord(responseBody)) return responseBody;
    if (!strictInvokeDecision?.strictConstraintQuery) return responseBody;

    const metadata = isPlainRecord(responseBody.metadata) ? responseBody.metadata : null;
    if (!metadata) return responseBody;

    const products = Array.isArray(responseBody.products) ? responseBody.products : [];
    if (products.length === 0) return responseBody;
    if (responseBody?.clarification?.question) return responseBody;

    const querySource = String(metadata.query_source || '').trim().toLowerCase();
    if (!querySource.startsWith('cache_')) return responseBody;

    const proxySearchFallback = isPlainRecord(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : null;
    const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};
    const searchTrace = isPlainRecord(metadata.search_trace) ? metadata.search_trace : {};
    const searchDecision = isPlainRecord(metadata.search_decision) ? metadata.search_decision : {};
    const fallbackReason = String(
      metadata.fallback_reason ||
        routeHealth.fallback_reason ||
        searchTrace.fallback_reason ||
        searchDecision.fallback_reason ||
        proxySearchFallback?.reason ||
        '',
    )
      .trim()
      .toLowerCase();
    const hasFallbackFlags =
      proxySearchFallback?.applied === true || routeHealth.fallback_triggered === true;
    if (!hasFallbackFlags) return responseBody;

    const hasUpstreamFallbackEvidence =
      String(metadata.upstream_error_code || '').trim().length > 0 ||
      String(metadata.upstream_error_message || '').trim().length > 0 ||
      Number(proxySearchFallback?.upstream_status || 0) > 0 ||
      String(proxySearchFallback?.upstream_error_code || '').trim().length > 0 ||
      String(proxySearchFallback?.upstream_error_message || '').trim().length > 0 ||
      Boolean(metadata.upstream_quota_guarded) ||
      /^resolver_after_primary$/i.test(fallbackReason) ||
      /^primary_unusable_/i.test(fallbackReason) ||
      /^secondary_after_primary_/i.test(fallbackReason);
    if (hasUpstreamFallbackEvidence) return responseBody;

    const nextMetadata = {
      ...metadata,
      proxy_search_fallback: proxySearchFallback
        ? {
            ...proxySearchFallback,
            applied: false,
            reason: null,
          }
        : {
            applied: false,
            reason: null,
          },
      route_health: {
        ...routeHealth,
        fallback_triggered: false,
        fallback_reason: null,
        primary_path_used: 'cache_stage',
        primary_path_degraded: false,
      },
      search_trace: {
        ...searchTrace,
        fallback_reason: null,
        primary_path_used: 'cache_stage',
        final_decision: toNonEmptyStringOrNull(searchTrace.final_decision) || 'cache_returned',
      },
      search_decision: {
        ...searchDecision,
        fallback_reason: null,
        primary_path_used: 'cache_stage',
        final_decision: toNonEmptyStringOrNull(searchDecision.final_decision) || 'cache_returned',
      },
    };
    delete nextMetadata.fallback_reason;
    delete nextMetadata.fallback_route;

    return {
      ...responseBody,
      metadata: nextMetadata,
    };
  }

  function normalizeStrictMainlineResponseMetadata({
    responseBody = null,
    strictInvokeDecision = null,
    invokeRequestBody = {},
  } = {}) {
    if (!isPlainRecord(responseBody)) return responseBody;
    if (!strictInvokeDecision?.strictConstraintQuery) return responseBody;

    const metadata = isPlainRecord(responseBody.metadata) ? responseBody.metadata : {};
    const budgetMetadata = extractStrictBudgetMetadataFromInvokeRequestBody(invokeRequestBody);
    const ingredientIntents = uniqueStrings([
      ...(Array.isArray(metadata.ingredient_intents) ? metadata.ingredient_intents : []),
      ...(Array.isArray(strictInvokeDecision?.ingredientIntents)
        ? strictInvokeDecision.ingredientIntents
        : []),
    ]);

    return {
      ...responseBody,
      metadata: {
        ...metadata,
        ...resolveStrictBudgetMetadata(budgetMetadata, metadata),
        strict_constraint_query: true,
        strict_constraint_reason:
          strictInvokeDecision.strictConstraintReason ||
          metadata.strict_constraint_reason ||
          null,
        ...(ingredientIntents.length > 0 ? { ingredient_intents: ingredientIntents } : {}),
        contract_bridge: {
          ...(isPlainRecord(metadata.contract_bridge) ? metadata.contract_bridge : {}),
          attempted_contract: 'shop_invoke_strict',
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        },
      },
    };
  }

  function normalizeShoppingStrictMainlineCacheResponse({
    responseBody = null,
    strictInvokeDecision = null,
    invokeRequestBody = {},
    queryParams = {},
    intent = null,
    queryClass = null,
    queryText = '',
  } = {}) {
    if (!isPlainRecord(responseBody)) return responseBody;
    if (!strictInvokeDecision?.strictConstraintQuery) return responseBody;

    const requestSource = String(
      invokeRequestBody?.metadata?.source ||
        invokeRequestBody?.payload?.metadata?.source ||
        invokeRequestBody?.payload?.context?.source ||
        '',
    ).trim();
    if (!isShoppingSource(requestSource)) return responseBody;

    const metadata = isPlainRecord(responseBody.metadata) ? responseBody.metadata : {};
    const querySource = String(metadata.query_source || '').trim().toLowerCase();
    const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};
    const primaryPathUsed = String(routeHealth.primary_path_used || '').trim().toLowerCase();
    const strictPrefetchRecovered = metadata.strict_prefetch_recovered === true;
    const strictPrefetchRecoverySource = toNonEmptyStringOrNull(
      metadata.strict_prefetch_recovery_source,
    );
    const hasBlockedCachePath =
      querySource.startsWith('cache_') ||
      primaryPathUsed === 'cache_stage' ||
      strictPrefetchRecovered ||
      Boolean(strictPrefetchRecoverySource);

    if (!hasBlockedCachePath) return responseBody;

    const strictReason = 'shopping_mainline_cache_blocked';
    const strictSource = 'agent_products_search';
    const strictEmpty = buildStrictEmptyFallbackResponse({
      body: null,
      queryParams,
      reason: strictReason,
      route: 'shopping_mainline_cache_blocked',
      querySource: strictSource,
      intent,
      queryClass,
      queryText,
    });

    const strictEmptyMetadata = isPlainRecord(strictEmpty?.metadata) ? strictEmpty.metadata : {};
    const strictEmptyRouteHealth = isPlainRecord(strictEmptyMetadata.route_health)
      ? strictEmptyMetadata.route_health
      : {};
    const strictEmptySearchTrace = isPlainRecord(strictEmptyMetadata.search_trace)
      ? strictEmptyMetadata.search_trace
      : {};
    const strictEmptySearchDecision = isPlainRecord(strictEmptyMetadata.search_decision)
      ? strictEmptyMetadata.search_decision
      : {};
    const budgetMetadata = extractStrictBudgetMetadataFromInvokeRequestBody(invokeRequestBody);
    const contractBridge = isPlainRecord(metadata.contract_bridge) ? metadata.contract_bridge : {};
    const ingredientIntents = uniqueStrings([
      ...(Array.isArray(metadata.ingredient_intents) ? metadata.ingredient_intents : []),
      ...(Array.isArray(strictInvokeDecision?.ingredientIntents)
        ? strictInvokeDecision.ingredientIntents
        : []),
    ]);
    const matchedIngredientIds = uniqueStrings(
      Array.isArray(metadata.matched_ingredient_ids) ? metadata.matched_ingredient_ids : [],
    );

    return {
      ...strictEmpty,
      metadata: {
        ...strictEmptyMetadata,
        ...metadata,
        ...resolveStrictBudgetMetadata(budgetMetadata, metadata),
        ...(metadata.service_version ? { service_version: metadata.service_version } : {}),
        query_source: strictSource,
        strict_constraint_query: true,
        strict_constraint_reason:
          strictInvokeDecision.strictConstraintReason ||
          metadata.strict_constraint_reason ||
          null,
        ...(ingredientIntents.length > 0 ? { ingredient_intents: ingredientIntents } : {}),
        ...(matchedIngredientIds.length > 0 ? { matched_ingredient_ids: matchedIngredientIds } : {}),
        ...(toNonEmptyStringOrNull(metadata.serving_mode)
          ? { serving_mode: toNonEmptyStringOrNull(metadata.serving_mode) }
          : {}),
        ...(Array.isArray(metadata.visible_option_intents)
          ? { visible_option_intents: metadata.visible_option_intents }
          : {}),
        ...(toNonEmptyStringOrNull(metadata.surface_reason)
          ? { surface_reason: toNonEmptyStringOrNull(metadata.surface_reason) }
          : {}),
        contract_bridge: {
          ...contractBridge,
          attempted_contract: 'shop_invoke_strict',
          resolved_contract: 'shop_invoke_strict',
          legacy_fallback: false,
        },
        proxy_search_fallback: {
          applied: false,
          reason: strictReason,
          route: 'shopping_mainline_cache_blocked',
        },
        route_health: {
          ...strictEmptyRouteHealth,
          fallback_triggered: false,
          fallback_reason: null,
          primary_path_used: 'upstream_stage',
        },
        search_trace: {
          ...strictEmptySearchTrace,
          final_decision: 'strict_empty',
          fallback_reason: null,
        },
        search_decision: {
          ...strictEmptySearchDecision,
          final_decision: 'strict_empty',
          fallback_reason: null,
          primary_path_used: 'upstream_stage',
          decision_authority: strictSource,
          decision_locked: true,
          decision_lock_reason: 'authoritative_no_fallback',
        },
        shopping_mainline_cache_blocked: true,
        blocked_cache_query_source: querySource || null,
        blocked_cache_primary_path_used: primaryPathUsed || null,
        ...(strictPrefetchRecoverySource
          ? { blocked_cache_recovery_source: strictPrefetchRecoverySource }
          : {}),
      },
    };
  }

  function shouldUseShoppingFreshMainlineSearch(source = null) {
    return isShoppingSource(source) && !process.env.DATABASE_URL;
  }

  function normalizeShoppingFreshMainlineCacheResponse({
    responseBody = null,
    requestSource = null,
    queryParams = {},
    intent = null,
    queryClass = null,
    queryText = '',
  } = {}) {
    if (!isPlainRecord(responseBody)) return responseBody;
    if (!shouldUseShoppingFreshMainlineSearch(requestSource)) return responseBody;

    const metadata = isPlainRecord(responseBody.metadata) ? responseBody.metadata : {};
    const querySource = String(metadata.query_source || '').trim().toLowerCase();
    const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};
    const primaryPathUsed = String(routeHealth.primary_path_used || '').trim().toLowerCase();
    const searchTrace = isPlainRecord(metadata.search_trace) ? metadata.search_trace : {};
    const searchDecision = isPlainRecord(metadata.search_decision) ? metadata.search_decision : {};
    const strictPrefetchRecovered = metadata.strict_prefetch_recovered === true;
    const strictPrefetchRecoverySource = toNonEmptyStringOrNull(
      metadata.strict_prefetch_recovery_source,
    );
    const hasBlockedCachePath =
      querySource.startsWith('cache_') ||
      primaryPathUsed === 'cache_stage' ||
      String(searchTrace.final_decision || '').trim().toLowerCase() === 'cache_returned' ||
      String(searchDecision.final_decision || '').trim().toLowerCase() === 'cache_returned' ||
      strictPrefetchRecovered ||
      Boolean(strictPrefetchRecoverySource);

    if (!hasBlockedCachePath) return responseBody;

    const strictReason = 'shopping_mainline_cache_blocked';
    const strictSource = 'agent_products_search';
    const strictEmpty = buildStrictEmptyFallbackResponse({
      body: null,
      queryParams,
      reason: strictReason,
      route: 'shopping_mainline_cache_blocked',
      querySource: strictSource,
      intent,
      queryClass,
      queryText,
    });

    const strictEmptyMetadata = isPlainRecord(strictEmpty?.metadata) ? strictEmpty.metadata : {};
    const strictEmptyRouteHealth = isPlainRecord(strictEmptyMetadata.route_health)
      ? strictEmptyMetadata.route_health
      : {};
    const strictEmptySearchTrace = isPlainRecord(strictEmptyMetadata.search_trace)
      ? strictEmptyMetadata.search_trace
      : {};
    const strictEmptySearchDecision = isPlainRecord(strictEmptyMetadata.search_decision)
      ? strictEmptyMetadata.search_decision
      : {};
    const contractBridge = isPlainRecord(metadata.contract_bridge) ? metadata.contract_bridge : {};

    return {
      ...strictEmpty,
      metadata: {
        ...strictEmptyMetadata,
        ...(metadata.service_version ? { service_version: metadata.service_version } : {}),
        ...(toNonEmptyStringOrNull(metadata.serving_mode)
          ? { serving_mode: toNonEmptyStringOrNull(metadata.serving_mode) }
          : {}),
        ...(Array.isArray(metadata.visible_category_intents)
          ? { visible_category_intents: metadata.visible_category_intents }
          : {}),
        ...(Array.isArray(metadata.visible_attribute_intents)
          ? { visible_attribute_intents: metadata.visible_attribute_intents }
          : {}),
        ...(Array.isArray(metadata.visible_option_intents)
          ? { visible_option_intents: metadata.visible_option_intents }
          : {}),
        ...(toNonEmptyStringOrNull(metadata.surface_reason)
          ? { surface_reason: toNonEmptyStringOrNull(metadata.surface_reason) }
          : {}),
        contract_bridge: {
          ...contractBridge,
          legacy_fallback: false,
        },
        query_source: strictSource,
        proxy_search_fallback: {
          applied: false,
          reason: strictReason,
          route: 'shopping_mainline_cache_blocked',
        },
        route_health: {
          ...strictEmptyRouteHealth,
          fallback_triggered: false,
          fallback_reason: null,
          primary_path_used: 'upstream_stage',
        },
        search_trace: {
          ...strictEmptySearchTrace,
          final_decision: 'strict_empty',
          fallback_reason: null,
        },
        search_decision: {
          ...strictEmptySearchDecision,
          final_decision: 'strict_empty',
          fallback_reason: null,
          primary_path_used: 'upstream_stage',
          decision_authority: strictSource,
          decision_locked: true,
          decision_lock_reason: 'authoritative_no_fallback',
        },
        shopping_mainline_cache_blocked: true,
        blocked_cache_query_source: querySource || null,
        blocked_cache_primary_path_used: primaryPathUsed || null,
        ...(strictPrefetchRecoverySource
          ? { blocked_cache_recovery_source: strictPrefetchRecoverySource }
          : {}),
      },
    };
  }

  function isShoppingBlockedFinalQuerySource(querySource = '') {
    const normalized = String(querySource || '').trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.startsWith('cache_')) return true;
    if (
      normalized === 'agent_products_error_fallback' ||
      normalized === 'agent_products_resolver_ref_fallback' ||
      normalized === 'agent_products_resolver_fallback'
    ) {
      return true;
    }
    return normalized.includes('invoke_outer_cache_guard');
  }

  function resolveShoppingBlockedFinalReason({
    querySource = '',
    primaryPathUsed = '',
    finalDecision = '',
    fallbackReason = '',
  } = {}) {
    const normalizedQuerySource = String(querySource || '').trim().toLowerCase();
    const normalizedPrimaryPath = String(primaryPathUsed || '').trim().toLowerCase();
    const normalizedFinalDecision = String(finalDecision || '').trim().toLowerCase();
    const normalizedFallbackReason = String(fallbackReason || '').trim().toLowerCase();

    if (
      normalizedQuerySource.startsWith('cache_') ||
      normalizedPrimaryPath === 'cache_stage' ||
      normalizedFinalDecision === 'cache_returned' ||
      normalizedFallbackReason === 'invoke_outer_cache_guard'
    ) {
      return 'shopping_mainline_cache_blocked';
    }
    if (
      normalizedQuerySource.includes('resolver') ||
      normalizedPrimaryPath === 'resolver_stage' ||
      normalizedFinalDecision === 'resolver_returned'
    ) {
      return 'shopping_mainline_resolver_blocked';
    }
    return 'shopping_mainline_fallback_blocked';
  }

  function normalizeShoppingFinalSearchResponse({
    responseBody = null,
    requestSource = null,
    queryParams = {},
    intent = null,
    queryClass = null,
    queryText = '',
  } = {}) {
    if (!isPlainRecord(responseBody)) return responseBody;
    if (!shouldUseShoppingFreshMainlineSearch(requestSource)) return responseBody;

    const metadata = isPlainRecord(responseBody.metadata) ? responseBody.metadata : {};
    const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};
    const searchTrace = isPlainRecord(metadata.search_trace) ? metadata.search_trace : {};
    const searchDecision = isPlainRecord(metadata.search_decision) ? metadata.search_decision : {};
    const proxySearchFallback = isPlainRecord(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : {};
    const querySource = String(metadata.query_source || '').trim();
    const strictEmptyReason = String(metadata.strict_empty_reason || '').trim().toLowerCase();
    const primaryPathUsed = String(routeHealth.primary_path_used || '').trim();
    const finalDecision = String(
      searchTrace.final_decision || searchDecision.final_decision || metadata.final_decision || '',
    ).trim();
    const fallbackReason = String(
      routeHealth.fallback_reason ||
        searchTrace.fallback_reason ||
        searchDecision.fallback_reason ||
        (proxySearchFallback.applied === true ? proxySearchFallback.reason : '') ||
        '',
    ).trim();
    const hasClarification = Boolean(responseBody?.clarification?.question);
    const hasBlockedSource = isShoppingBlockedFinalQuerySource(querySource);
    const hasBlockedDecision =
      String(finalDecision || '').trim().toLowerCase() === 'cache_returned' ||
      String(finalDecision || '').trim().toLowerCase() === 'resolver_returned';
    const hasBlockedPrimaryPath = ['cache_stage', 'resolver_stage', 'invoke_outer_cache_guard'].includes(
      String(primaryPathUsed || '').trim().toLowerCase(),
    );
    const hasBlockedFallbackState = Boolean(
      routeHealth.fallback_triggered === true ||
        proxySearchFallback.applied === true ||
        fallbackReason,
    );
    const hasShoppingMainlineStrictEmptyReason =
      strictEmptyReason.startsWith('shopping_mainline_') ||
      metadata.shopping_mainline_cache_blocked === true ||
      metadata.shopping_mainline_resolver_blocked === true;

    if (
      metadata.strict_empty === true &&
      hasShoppingMainlineStrictEmptyReason &&
      !hasBlockedFallbackState
    ) {
      return responseBody;
    }

    if (
      !hasBlockedSource &&
      !hasBlockedDecision &&
      !hasBlockedPrimaryPath &&
      !(metadata.strict_empty === true && hasShoppingMainlineStrictEmptyReason && hasBlockedFallbackState)
    ) {
      return responseBody;
    }

    const strictReason =
      strictEmptyReason.startsWith('shopping_mainline_')
        ? strictEmptyReason
        : resolveShoppingBlockedFinalReason({
            querySource,
            primaryPathUsed,
            finalDecision,
            fallbackReason,
          });
    const blockedFields = {
      shopping_blocked_query_source: querySource || null,
      shopping_blocked_primary_path_used: primaryPathUsed || null,
      shopping_blocked_final_decision: finalDecision || null,
      ...(fallbackReason ? { shopping_blocked_fallback_reason: fallbackReason } : {}),
    };

    if (hasClarification) {
      return {
        ...responseBody,
        products: [],
        total: 0,
        reply: null,
        metadata: {
          ...metadata,
          ...blockedFields,
          query_source: 'agent_products_search',
          route_health: {
            ...routeHealth,
            fallback_triggered: false,
            fallback_reason: null,
            primary_path_used: 'upstream_stage',
          },
          search_trace: {
            ...searchTrace,
            fallback_reason: null,
            primary_path_used: 'upstream_stage',
            final_decision: 'clarify',
          },
          search_decision: {
            ...searchDecision,
            fallback_reason: null,
            primary_path_used: 'upstream_stage',
            final_decision: 'clarify',
          },
        },
      };
    }

    const strictEmpty = buildStrictEmptyFallbackResponse({
      body: null,
      queryParams,
      reason: strictReason,
      route: 'shopping_final_source_blocked',
      querySource: 'agent_products_search',
      intent,
      queryClass,
      queryText,
    });
    const strictEmptyMetadata = isPlainRecord(strictEmpty?.metadata) ? strictEmpty.metadata : {};
    const strictEmptyRouteHealth = isPlainRecord(strictEmptyMetadata.route_health)
      ? strictEmptyMetadata.route_health
      : {};
    const strictEmptySearchTrace = isPlainRecord(strictEmptyMetadata.search_trace)
      ? strictEmptyMetadata.search_trace
      : {};
    const strictEmptySearchDecision = isPlainRecord(strictEmptyMetadata.search_decision)
      ? strictEmptyMetadata.search_decision
      : {};

    return {
      ...strictEmpty,
      metadata: {
        ...metadata,
        ...strictEmptyMetadata,
        ...(metadata.service_version ? { service_version: metadata.service_version } : {}),
        ...(toNonEmptyStringOrNull(metadata.serving_mode)
          ? { serving_mode: toNonEmptyStringOrNull(metadata.serving_mode) }
          : {}),
        ...(toNonEmptyStringOrNull(metadata.surface_reason)
          ? { surface_reason: toNonEmptyStringOrNull(metadata.surface_reason) }
          : {}),
        contract_bridge: {
          ...(isPlainRecord(metadata.contract_bridge) ? metadata.contract_bridge : {}),
          legacy_fallback: false,
        },
        ...blockedFields,
        ...(strictReason === 'shopping_mainline_cache_blocked'
          ? {
              shopping_mainline_cache_blocked: true,
              blocked_cache_query_source: metadata.blocked_cache_query_source || querySource || null,
              blocked_cache_primary_path_used:
                metadata.blocked_cache_primary_path_used || primaryPathUsed || null,
            }
          : {}),
        query_source: 'agent_products_search',
        proxy_search_fallback: {
          ...(isPlainRecord(strictEmptyMetadata.proxy_search_fallback)
            ? strictEmptyMetadata.proxy_search_fallback
            : {}),
          ...(isPlainRecord(metadata.proxy_search_fallback) ? metadata.proxy_search_fallback : {}),
          applied: false,
          reason: strictReason,
        },
        route_health: {
          ...strictEmptyRouteHealth,
          fallback_triggered: false,
          fallback_reason: null,
          primary_path_used: 'upstream_stage',
        },
        search_trace: {
          ...strictEmptySearchTrace,
          final_decision: 'strict_empty',
          fallback_reason: null,
          primary_path_used: 'upstream_stage',
        },
        search_decision: {
          ...strictEmptySearchDecision,
          final_decision: 'strict_empty',
          fallback_reason: null,
          primary_path_used: 'upstream_stage',
          decision_authority: 'agent_products_search',
          decision_locked: true,
          decision_lock_reason: 'authoritative_no_fallback',
        },
      },
    };
  }

  return {
    recoverStrictMainPathResponseFromPrefetch,
    normalizeStrictCacheMainPathFallbackMetadata,
    normalizeStrictMainlineResponseMetadata,
    normalizeShoppingStrictMainlineCacheResponse,
    shouldUseShoppingFreshMainlineSearch,
    normalizeShoppingFreshMainlineCacheResponse,
    normalizeShoppingFinalSearchResponse,
  };
}

module.exports = {
  createStrictFindProductsResponseNormalizationRuntime,
};
