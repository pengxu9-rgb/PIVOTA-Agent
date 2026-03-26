const {
  extractUpstreamErrorCode: extractUpstreamErrorCodeBase,
} = require('../shared/extractUpstreamErrorCode');
const {
  applyDealsToResponse: applyDealsToResponseBase,
} = require('../promotions');
const {
  buildSearchRouteHealth: buildSearchRouteHealthBase,
} = require('./searchRouteHealth');
const {
  buildSearchTrace: buildSearchTraceBase,
} = require('./searchTrace');

function getMetadata(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.metadata &&
    typeof value.metadata === 'object' &&
    !Array.isArray(value.metadata)
  ) {
    return value.metadata;
  }
  return {};
}

function getSearchPayload(effectivePayload) {
  if (effectivePayload && typeof effectivePayload === 'object') {
    return effectivePayload.search || effectivePayload;
  }
  return {};
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const token = String(value || '').trim();
    if (token) return token;
  }
  return '';
}

function normalizeCommerceSurface(raw, fallback = 'agent_api') {
  const token = String(raw || '').trim().toLowerCase();
  if (token === 'agent_api' || token === 'ucp' || token === 'acp') return token;
  return fallback;
}

function extractCommerceSurfaceFromPayload(payload, metadata, { fallback = 'agent_api' } = {}) {
  const body = isRecord(payload) ? payload : {};
  const search = isRecord(body.search) ? body.search : {};
  const meta = isRecord(metadata) ? metadata : {};
  const raw = pickFirstTrimmed(
    body.commerce_surface,
    body.commerceSurface,
    search.commerce_surface,
    search.commerceSurface,
    search.catalog_surface,
    search.catalogSurface,
    meta.commerce_surface,
    meta.commerceSurface,
  );
  return {
    commerceSurface: normalizeCommerceSurface(raw, fallback),
    explicit: Boolean(raw),
  };
}

function variantRefFromContract(variant) {
  return (
    pickFirstTrimmed(
      variant?.variant_id,
      variant?.variantId,
      variant?.id,
      variant?.sku,
      variant?.sku_id,
      variant?.skuId,
    ) || null
  );
}

function variantSkuFromContract(variant) {
  return pickFirstTrimmed(variant?.sku, variant?.sku_id, variant?.skuId) || null;
}

function coercePositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function protocolCoverageReady(candidate, commerceSurface) {
  const record = isRecord(candidate) ? candidate : {};
  const direct = isRecord(record.channel_coverage) ? record.channel_coverage : null;
  const readiness = isRecord(record.readiness) ? record.readiness : null;
  const readinessCoverage = isRecord(readiness?.channel_coverage) ? readiness.channel_coverage : null;
  const coverage =
    (readinessCoverage && isRecord(readinessCoverage[commerceSurface]) && readinessCoverage[commerceSurface]) ||
    (direct && isRecord(direct[commerceSurface]) && direct[commerceSurface]) ||
    null;
  if (!coverage) return null;
  if (coverage.ready === true || coverage.eligible === true || coverage.servable === true) {
    return true;
  }
  const status = String(coverage.status || '').trim().toLowerCase();
  if (status === 'ready' || status === 'eligible' || status === 'servable') return true;
  if (status === 'blocked' || status === 'excluded' || status === 'not_ready') return false;
  return null;
}

function isCandidateAgentPushExcluded(candidate) {
  const record = isRecord(candidate) ? candidate : {};
  const status = String(record.agent_push_status || '').trim().toLowerCase();
  if (status === 'excluded_from_agent_push') return true;
  const reasons = Array.isArray(record.agent_push_reason_codes) ? record.agent_push_reason_codes : [];
  return reasons.some((reason) => String(reason || '').trim().length > 0);
}

function pickFirstEligibleVariantFromProductContract(product, commerceSurface = 'agent_api') {
  const item = isRecord(product) ? product : {};
  const variants =
    Array.isArray(item.variants) && item.variants.length > 0
      ? item.variants
      : [
          {
            id: item.variant_id || item.variantId || item.sku || item.sku_id || item.skuId || item.id,
            sku: item.sku || item.sku_id || item.skuId || null,
            price: item.price,
            inventory_quantity: item.inventory_quantity,
            in_stock: item.in_stock,
            currency: item.currency,
            agent_push_status: item.agent_push_status,
            agent_push_reason_codes: item.agent_push_reason_codes,
            channel_coverage: item.channel_coverage,
            readiness: item.readiness,
          },
        ];

  for (const rawVariant of variants) {
    const variant = isRecord(rawVariant) ? rawVariant : {};
    if (isCandidateAgentPushExcluded(item) || isCandidateAgentPushExcluded(variant)) continue;
    const price = coercePositiveNumber(variant.price != null ? variant.price : item.price);
    const inventoryRaw =
      variant.inventory_quantity != null ? variant.inventory_quantity : item.inventory_quantity;
    const inventory = Number.isFinite(Number(inventoryRaw)) ? Number(inventoryRaw) : null;
    const explicitInStock =
      typeof variant.in_stock === 'boolean'
        ? variant.in_stock
        : typeof item.in_stock === 'boolean'
          ? item.in_stock
          : null;
    const inStock =
      explicitInStock != null ? explicitInStock : inventory == null ? true : inventory > 0;
    if (!price || !inStock) continue;

    if (commerceSurface === 'ucp' || commerceSurface === 'acp') {
      const coverageReady =
        protocolCoverageReady(variant, commerceSurface) ??
        protocolCoverageReady(item, commerceSurface);
      if (coverageReady === false) continue;
    }

    return {
      variant,
      price,
      currency: String(variant.currency || item.currency || 'USD').trim().toUpperCase() || 'USD',
      commerce_surface: normalizeCommerceSurface(commerceSurface),
    };
  }
  return null;
}

function attachEligibleOfferFieldsToSearchResponse(responseBody, commerceSurface = 'agent_api') {
  const body = isRecord(responseBody) ? { ...responseBody } : {};
  const rawProducts = Array.isArray(body.products) ? body.products : [];
  const filteredProducts = [];

  for (const rawProduct of rawProducts) {
    const product = isRecord(rawProduct) ? { ...rawProduct } : null;
    if (!product) continue;
    if (
      String(product.merchant_id || '').trim() === 'external_seed' ||
      String(product.source || '').trim().toLowerCase() === 'external_seed' ||
      String(product.platform || '').trim().toLowerCase() === 'external'
    ) {
      continue;
    }
    const eligible = pickFirstEligibleVariantFromProductContract(product, commerceSurface);
    if (!eligible) continue;
    const variantId = variantRefFromContract(eligible.variant);
    const skuId = variantSkuFromContract(eligible.variant);
    filteredProducts.push({
      ...product,
      commerce_surface: normalizeCommerceSurface(commerceSurface),
      top_offer_summary: {
        purchase_route: 'internal_checkout',
        merchant_id: product.merchant_id || null,
        product_id: product.product_id || product.id || null,
        ...(variantId ? { variant_id: variantId } : {}),
        ...(skuId ? { sku_id: skuId } : {}),
        price: eligible.price,
        currency: eligible.currency,
        commerce_surface: normalizeCommerceSurface(commerceSurface),
      },
      exact_resolution_identifiers: {
        merchant_id: product.merchant_id || null,
        product_id: product.product_id || product.id || null,
        ...(variantId ? { variant_id: variantId } : {}),
        ...(skuId ? { sku_id: skuId } : {}),
      },
    });
  }

  const metadata = getMetadata(body);
  return {
    ...body,
    products: filteredProducts,
    total: filteredProducts.length,
    page_size: filteredProducts.length,
    metadata: {
      ...metadata,
      commerce_surface: normalizeCommerceSurface(commerceSurface),
      serving_mode: 'eligible_only',
    },
  };
}

function normalizeStringList(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

async function finalizeInvokeSearchResponse({
  operation,
  upstreamData,
  responseStatus,
  queryParams,
  metadata,
  rawUserQuery,
  effectiveIntent,
  effectivePayload,
  policyMetadata,
  creatorId,
  hasDatabase,
  promotions,
  now,
  crossMerchantCacheRouteDebug,
  shouldAttemptResolverFirst,
  resolverFirstResult,
  invokeStartedAtMs,
  gatewayRequestId,
  traceQueryClass,
  traceRewriteGate,
  traceAssociationPlan,
  traceFlagsSnapshot,
  traceAmbiguityScorePre,
  proxyRouteFallbackStrategy,
  findProductsExpansionMeta,
  fpmGateTrace,
  fpmSkippedGatesDueToBudget,
  fpmLatencyGuardApplied,
  searchLimitMax,
  routeDebugEnabled,
  searchStrictEmptyEnabled,
  fpmClarifyNeverEmpty,
  searchRelevanceDebugEnabled,
  defaultFindProductsMultiExpansionMode,
  extractSearchQueryText,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  isKnownLookupAliasQuery,
  applyFindProductsMultiPolicy,
  buildPetFallbackQuery,
  searchCreatorSellableFromCache,
  maybeRerankFindProductsMultiResponse,
  applyDealsToResponse = applyDealsToResponseBase,
  withSearchDiagnostics,
  buildSearchRouteHealth = buildSearchRouteHealthBase,
  buildSearchTrace = buildSearchTraceBase,
  buildSearchRelevanceDebug,
  logger,
} = {}) {
  if (!(operation === 'find_products' || operation === 'find_products_multi')) {
    return upstreamData;
  }

  let maybePolicy = upstreamData;
  if (operation === 'find_products_multi' && effectiveIntent) {
    const upstreamMetadata = getMetadata(upstreamData);
    const policyQueryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
    const isLookupPolicyQuery = isLookupStyleSearchQuery(
      policyQueryText,
      extractSearchAnchorTokens(policyQueryText),
    );
    const querySource = String(upstreamMetadata.query_source || '').trim();
    const isResolverLookupSource =
      querySource === 'agent_products_resolver_ref_fallback' ||
      querySource === 'agent_products_resolver_fallback';
    const isCacheLookupSource =
      querySource === 'cache_cross_merchant_search' ||
      querySource === 'cache_cross_merchant_search_supplemented';
    const isErrorSoftFallbackSource = querySource === 'agent_products_error_fallback';
    const isAliasLookupQuery = isKnownLookupAliasQuery(policyQueryText);
    const skipPolicyForLookupSoftFallback =
      isErrorSoftFallbackSource ||
      (isResolverLookupSource && isLookupPolicyQuery) ||
      (isCacheLookupSource && isLookupPolicyQuery) ||
      (querySource === 'agent_products_search' && isAliasLookupQuery);

    maybePolicy = skipPolicyForLookupSoftFallback
      ? upstreamData
      : applyFindProductsMultiPolicy({
          response: upstreamData,
          intent: effectiveIntent,
          requestPayload: effectivePayload,
          metadata: policyMetadata,
          rawUserQuery,
        });

    const effTarget = effectiveIntent?.target_object?.type || 'unknown';
    const productsAfterPolicy = Array.isArray(maybePolicy?.products) ? maybePolicy.products : [];
    const upstreamTotal = Array.isArray(upstreamData?.products)
      ? upstreamData.products.length
      : upstreamData?.total || 0;

    if (
      effTarget === 'pet' &&
      productsAfterPolicy.length === 0 &&
      creatorId &&
      hasDatabase &&
      upstreamTotal > 0
    ) {
      try {
        const fallbackQuery = buildPetFallbackQuery(effectiveIntent, rawUserQuery);
        const search = getSearchPayload(effectivePayload);
        const page = search.page || 1;
        const limit = search.limit || search.page_size || 20;
        const inStockOnly = search.in_stock_only !== false;
        const fromCache = await searchCreatorSellableFromCache(
          creatorId,
          fallbackQuery,
          page,
          limit,
          {
            intent: effectiveIntent,
            inStockOnly,
          },
        );

        if (fromCache.products && fromCache.products.length > 0) {
          const fallbackData = {
            products: fromCache.products,
            total: fromCache.total,
            page: fromCache.page,
            page_size: fromCache.page_size,
            reply: null,
            metadata: {
              query_source: 'cache_creator_pet_fallback',
              fetched_at: new Date().toISOString(),
              merchants_searched: fromCache.merchantIds.length,
              ...(fromCache.retrieval_sources
                ? { retrieval_sources: fromCache.retrieval_sources }
                : {}),
              ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
              ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
            },
          };

          maybePolicy = applyFindProductsMultiPolicy({
            response: fallbackData,
            intent: effectiveIntent,
            requestPayload: {
              ...effectivePayload,
              search: {
                ...(effectivePayload?.search || {}),
                query: fallbackQuery,
              },
            },
            metadata: policyMetadata,
            rawUserQuery: fallbackQuery,
          });
        }
      } catch (err) {
        logger.warn(
          { err: err?.message || String(err), creatorId, source: metadata?.source },
          'Pet apparel fallback from creator cache failed',
        );
      }
    }
  }

  if (operation === 'find_products_multi') {
    try {
      const search = getSearchPayload(effectivePayload);
      const limit = Math.min(
        Math.max(1, Number(search.limit || search.page_size || 20) || 20),
        searchLimitMax,
      );
      const reranked = await maybeRerankFindProductsMultiResponse({
        response: maybePolicy,
        userQuery: rawUserQuery,
        limit,
      });
      if (reranked?.applied) {
        maybePolicy = reranked.response;
        if (routeDebugEnabled) {
          maybePolicy = {
            ...maybePolicy,
            metadata: {
              ...getMetadata(maybePolicy),
              route_debug: {
                ...(getMetadata(maybePolicy).route_debug || {}),
                llm_rerank: {
                  applied: true,
                  provider: reranked.provider || null,
                  items_count: reranked.items_count || null,
                  duration_ms: reranked.duration_ms || null,
                },
              },
            },
          };
        }
      }
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err) },
        'find_products_multi llm rerank failed; keeping ordering',
      );
    }
  }

  let enriched = applyDealsToResponse(maybePolicy, promotions, now, creatorId);
  if (operation === 'find_products_multi') {
    const { commerceSurface, explicit } = extractCommerceSurfaceFromPayload(
      effectivePayload,
      metadata,
      { fallback: 'agent_api' },
    );
    if (explicit) {
      enriched = attachEligibleOfferFieldsToSearchResponse(enriched, commerceSurface);
    }
  }
  const queryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
  const existingMeta = getMetadata(enriched);
  const fallbackMeta =
    existingMeta.proxy_search_fallback &&
    typeof existingMeta.proxy_search_fallback === 'object' &&
    !Array.isArray(existingMeta.proxy_search_fallback)
      ? existingMeta.proxy_search_fallback
      : null;
  const products = Array.isArray(enriched?.products) ? enriched.products : [];
  const clarificationPayload =
    enriched &&
    typeof enriched === 'object' &&
    !Array.isArray(enriched) &&
    enriched.clarification &&
    typeof enriched.clarification === 'object'
      ? enriched.clarification
      : null;
  const hasClarification = Boolean(clarificationPayload?.question);
  const searchDecision =
    existingMeta.search_decision &&
    typeof existingMeta.search_decision === 'object' &&
    !Array.isArray(existingMeta.search_decision)
      ? existingMeta.search_decision
      : null;
  const isStrictEmpty =
    searchStrictEmptyEnabled &&
    queryText.length > 0 &&
    products.length === 0 &&
    !hasClarification;
  const querySource = String(existingMeta.query_source || '').trim() || 'agent_products_search';
  const primaryPathUsed = querySource.startsWith('cache_')
    ? 'cache_stage'
    : querySource.includes('resolver')
      ? 'resolver_stage'
      : 'upstream_stage';
  const fallbackTriggered =
    Boolean(fallbackMeta?.applied) ||
    querySource === 'agent_products_error_fallback' ||
    (isStrictEmpty && Boolean(fallbackMeta?.reason));
  const fallbackReason =
    (fallbackMeta && typeof fallbackMeta.reason === 'string' && fallbackMeta.reason.trim()) ||
    (querySource === 'agent_products_error_fallback' ? 'error_soft_fallback' : null);
  const cacheStage = crossMerchantCacheRouteDebug
    ? {
        hit: Boolean(crossMerchantCacheRouteDebug.cache_hit),
        candidate_count: Number(crossMerchantCacheRouteDebug.products_count || 0),
        relevant_count: Number(
          crossMerchantCacheRouteDebug.internal_products_relevant_count ??
            crossMerchantCacheRouteDebug.products_count ??
            0,
        ),
        retrieval_sources: crossMerchantCacheRouteDebug.retrieval_sources || [],
      }
    : {
        hit: false,
        candidate_count: 0,
        relevant_count: 0,
        retrieval_sources: [],
      };
  const resolverStage = {
    called: Boolean(shouldAttemptResolverFirst),
    hit: Boolean(resolverFirstResult && Number(resolverFirstResult.usableCount || 0) > 0),
    miss: Boolean(
      shouldAttemptResolverFirst &&
        (!resolverFirstResult || Number(resolverFirstResult.usableCount || 0) <= 0),
    ),
    latency_ms: Number(
      resolverFirstResult?.resolve_latency_ms ||
        resolverFirstResult?.data?.metadata?.resolve_latency_ms ||
        0,
    ) || null,
  };
  const upstreamStage = {
    called: !(querySource.startsWith('cache_') && products.length > 0),
    timeout:
      String(existingMeta?.upstream_error_code || '').toUpperCase() === 'ECONNABORTED' ||
      String(existingMeta?.proxy_search_fallback?.upstream_error_code || '').toUpperCase() ===
        'ECONNABORTED',
    status: Number(existingMeta?.upstream_status || responseStatus || 0) || null,
    latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
  };
  const finalDecision = isStrictEmpty
    ? 'strict_empty'
    : hasClarification && (!fpmClarifyNeverEmpty || products.length === 0)
      ? 'clarify'
      : searchDecision?.final_decision
        ? String(searchDecision.final_decision)
        : hasClarification
          ? 'products_returned_with_clarification'
          : querySource.startsWith('cache_')
            ? 'cache_returned'
            : querySource.includes('resolver')
              ? 'resolver_returned'
              : 'upstream_returned';
  const expansionMode =
    operation === 'find_products_multi'
      ? findProductsExpansionMeta?.mode || defaultFindProductsMultiExpansionMode
      : 'off';
  const expandedQuery =
    operation === 'find_products_multi'
      ? findProductsExpansionMeta?.expanded_query || queryText
      : queryText;
  const policyRouteDebug =
    existingMeta.route_debug && typeof existingMeta.route_debug === 'object'
      ? existingMeta.route_debug.policy
      : null;
  const relevanceDebug =
    operation === 'find_products_multi' && searchRelevanceDebugEnabled
      ? buildSearchRelevanceDebug({
          intent: effectiveIntent,
          products,
          diversityPenaltyApplied: Boolean(policyRouteDebug?.diversity?.penalty_applied),
        })
      : null;
  const routeDegradeFlags =
    searchDecision?.degrade_flags && typeof searchDecision.degrade_flags === 'object'
      ? searchDecision.degrade_flags
      : { vector_skipped: false, behavior_skipped: false, nlu_degraded: false };

  enriched = withSearchDiagnostics(enriched, {
    route_health: buildSearchRouteHealth({
      primaryPathUsed,
      primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
      fallbackTriggered,
      fallbackReason,
      ambiguityScorePre: Number.isFinite(Number(searchDecision?.ambiguity_score_pre))
        ? Number(searchDecision.ambiguity_score_pre)
        : traceAmbiguityScorePre,
      ambiguityScorePost: searchDecision?.ambiguity_score_post,
      clarifyTriggered: hasClarification || Boolean(searchDecision?.clarify_triggered),
      degradeFlags: routeDegradeFlags,
    }),
    search_trace: buildSearchTrace({
      traceId: gatewayRequestId,
      rawQuery: queryText,
      expandedQuery,
      expansionMode,
      queryClass: searchDecision?.query_class || traceQueryClass,
      rewriteGate: traceRewriteGate,
      associationPlan: traceAssociationPlan,
      flagsSnapshot: traceFlagsSnapshot,
      intent: effectiveIntent,
      cacheStage,
      upstreamStage,
      resolverStage,
      finalDecision,
    }),
    ...(proxyRouteFallbackStrategy ? { fallback_strategy: proxyRouteFallbackStrategy } : {}),
    ...(relevanceDebug ? { relevance_debug: relevanceDebug } : {}),
    ...(isStrictEmpty
      ? {
          strict_empty: true,
          strict_empty_reason: fallbackReason || 'no_candidates',
        }
      : {}),
  });

  if (
    enriched &&
    typeof enriched === 'object' &&
    !Array.isArray(enriched)
  ) {
    const existingMetaForGates = getMetadata(enriched);
    const existingGateTrace = Array.isArray(existingMetaForGates.gate_trace)
      ? existingMetaForGates.gate_trace
      : [];
    const combinedGateTrace = existingGateTrace.concat(
      Array.isArray(fpmGateTrace) ? fpmGateTrace : [],
    );
    const dedupSkippedGates = normalizeStringList(fpmSkippedGatesDueToBudget);
    const existingLowConfidenceReasons = Array.isArray(existingMetaForGates.low_confidence_reasons)
      ? existingMetaForGates.low_confidence_reasons
      : Array.isArray(searchDecision?.low_confidence_reasons)
        ? searchDecision.low_confidence_reasons
        : [];
    const normalizedLowConfidenceReasons = normalizeStringList(existingLowConfidenceReasons);
    const lowConfidenceFlag =
      Boolean(existingMetaForGates.low_confidence) ||
      Boolean(searchDecision?.low_confidence) ||
      normalizedLowConfidenceReasons.length > 0;

    enriched = {
      ...enriched,
      metadata: {
        ...existingMetaForGates,
        gate_trace: combinedGateTrace,
        gate_summary: {
          applied_count: combinedGateTrace.filter((item) => item && item.applied).length,
          blocked_count: combinedGateTrace.filter(
            (item) =>
              item &&
              (String(item.decision || '') === 'strict_empty' ||
                String(item.decision || '') === 'clarify_only_early'),
          ).length,
          total_cost_ms_estimate: combinedGateTrace.reduce(
            (sum, item) => sum + Math.max(0, Number(item?.cost_ms_estimate || 0) || 0),
            0,
          ),
        },
        latency_guard_applied: Boolean(fpmLatencyGuardApplied),
        skipped_gates_due_to_budget: dedupSkippedGates,
        low_confidence: lowConfidenceFlag,
        low_confidence_reasons: normalizedLowConfidenceReasons,
      },
    };
  }

  return enriched;
}

function buildInvokeSearchOuterCatchResponse({
  operation,
  err,
  crossMerchantCacheProtectedResponse,
  queryParams,
  rawUserQuery,
  effectiveIntent,
  traceQueryClass,
  traceRewriteGate,
  traceAssociationPlan,
  traceFlagsSnapshot,
  traceAmbiguityScorePre,
  gatewayRequestId,
  invokeStartedAtMs,
  findProductsExpansionMeta,
  defaultFindProductsMultiExpansionMode,
  normalizeAgentProductsListResponse,
  withProxySearchFallbackMetadata,
  withSearchDiagnostics,
  buildSearchRouteHealth = buildSearchRouteHealthBase,
  buildSearchTrace = buildSearchTraceBase,
  extractSearchQueryText,
  extractUpstreamErrorCode = extractUpstreamErrorCodeBase,
  withStrictEmptyFallback,
  logger,
} = {}) {
  if (!(operation === 'find_products' || operation === 'find_products_multi')) {
    return { handled: false };
  }

  const queryText = String(rawUserQuery || extractSearchQueryText(queryParams) || '').trim();
  const expandedQuery = findProductsExpansionMeta?.expanded_query || queryText;
  const expansionMode =
    findProductsExpansionMeta?.mode || defaultFindProductsMultiExpansionMode;

  if (
    operation === 'find_products_multi' &&
    crossMerchantCacheProtectedResponse &&
    Array.isArray(crossMerchantCacheProtectedResponse.products) &&
    crossMerchantCacheProtectedResponse.products.length > 0
  ) {
    const cacheGuardBody = normalizeAgentProductsListResponse(
      crossMerchantCacheProtectedResponse,
      {
        limit: queryParams?.limit,
        offset: queryParams?.offset,
      },
    );
    const cacheGuardDiagnosed = withSearchDiagnostics(
      withProxySearchFallbackMetadata(cacheGuardBody, {
        applied: false,
        reason: 'invoke_outer_cache_guard',
        route: 'invoke_outer_catch_cache_guard',
      }),
      {
        route_health: buildSearchRouteHealth({
          primaryPathUsed: 'invoke_outer_cache_guard',
          primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
          fallbackTriggered: true,
          fallbackReason: 'invoke_outer_cache_guard',
          ambiguityScorePre: traceAmbiguityScorePre,
          clarifyTriggered: false,
        }),
        search_trace: buildSearchTrace({
          traceId: gatewayRequestId,
          rawQuery: queryText,
          expandedQuery,
          expansionMode,
          queryClass: traceQueryClass,
          rewriteGate: traceRewriteGate,
          associationPlan: traceAssociationPlan,
          flagsSnapshot: traceFlagsSnapshot,
          intent: effectiveIntent,
          cacheStage: {
            hit: true,
            candidate_count: Number(crossMerchantCacheProtectedResponse.products.length || 0),
            relevant_count: Number(crossMerchantCacheProtectedResponse.products.length || 0),
            retrieval_sources: [],
          },
          upstreamStage: {
            called: true,
            timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
            status: Number(err?.response?.status || err?.status || 0) || null,
            latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
          },
          resolverStage: {
            called: false,
            hit: false,
            miss: false,
            latency_ms: null,
          },
          finalDecision: 'cache_returned',
        }),
      },
    );
    return {
      handled: true,
      statusCode: 200,
      body: cacheGuardDiagnosed,
    };
  }

  const { code, message } = extractUpstreamErrorCode(err);
  const upstreamStatus =
    err?.response?.status || err?.status || (err?.code === 'ECONNABORTED' ? 504 : 502);
  logger.warn(
    {
      gateway_request_id: gatewayRequestId,
      operation,
      upstream_status: upstreamStatus,
      upstream_code: code || err?.code || null,
      upstream_message: message || err?.message || null,
    },
    'search operation failed in invoke outer catch; returning soft fallback',
  );
  const reason =
    err?.code === 'ECONNABORTED' ? 'invoke_outer_timeout' : 'invoke_outer_exception';
  const strictEmpty = withStrictEmptyFallback({
    body: null,
    queryParams,
    reason,
    upstreamStatus,
    upstreamCode: code || err?.code || null,
    upstreamMessage: message || err?.message || null,
    route: 'invoke_outer_catch',
    intent: effectiveIntent,
    queryClass: traceQueryClass,
    queryText,
  });
  const strictEmptyHasClarification = Boolean(strictEmpty?.clarification?.question);
  const diagnosed = withSearchDiagnostics(strictEmpty, {
    route_health: buildSearchRouteHealth({
      primaryPathUsed: 'invoke_outer_catch',
      primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
      fallbackTriggered: true,
      fallbackReason: reason,
      ambiguityScorePre: traceAmbiguityScorePre,
      clarifyTriggered: strictEmptyHasClarification,
    }),
    search_trace: buildSearchTrace({
      traceId: gatewayRequestId,
      rawQuery: queryText,
      expandedQuery,
      expansionMode,
      queryClass: traceQueryClass,
      rewriteGate: traceRewriteGate,
      associationPlan: traceAssociationPlan,
      flagsSnapshot: traceFlagsSnapshot,
      intent: effectiveIntent,
      cacheStage: {
        hit: false,
        candidate_count: 0,
        relevant_count: 0,
        retrieval_sources: [],
      },
      upstreamStage: {
        called: true,
        timeout: String(err?.code || '').toUpperCase() === 'ECONNABORTED',
        status: Number(upstreamStatus || 0) || null,
        latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
      },
      resolverStage: {
        called: false,
        hit: false,
        miss: false,
        latency_ms: null,
      },
      finalDecision: strictEmptyHasClarification ? 'clarify' : 'strict_empty',
    }),
    strict_empty: !strictEmptyHasClarification,
    ...(strictEmptyHasClarification ? {} : { strict_empty_reason: reason }),
  });

  return {
    handled: true,
    statusCode: 200,
    body: diagnosed,
  };
}

module.exports = {
  attachEligibleOfferFieldsToSearchResponse,
  finalizeInvokeSearchResponse,
  buildInvokeSearchOuterCatchResponse,
  extractCommerceSurfaceFromPayload,
};
