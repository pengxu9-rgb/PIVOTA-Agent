const {
  getActivePromotions: getActivePromotionsBase,
  applyDealsToResponse: applyDealsToResponseBase,
} = require('../promotions');
const {
  isCreatorUiSource: isCreatorUiSourceBase,
  isCatalogGuardSource: isCatalogGuardSourceBase,
  isAuroraSource: isAuroraSourceBase,
  isShoppingSource: isShoppingSourceBase,
  normalizeExternalSeedStrategy: normalizeExternalSeedStrategyBase,
  isUnifiedLikeExternalSeedStrategy: isUnifiedLikeExternalSeedStrategyBase,
} = require('./searchGuards');
const {
  buildSearchRouteHealth: buildSearchRouteHealthBase,
} = require('./searchRouteHealth');
const {
  buildSearchTrace: buildSearchTraceBase,
} = require('./searchTrace');
const {
  extractCommerceSurfaceFromPayload: extractCommerceSurfaceFromPayloadBase,
  attachEligibleOfferFieldsToSearchResponse: attachEligibleOfferFieldsToSearchResponseBase,
} = require('./searchResponseFinalizer');
const {
  withStageBudget: withStageBudgetBase,
} = require('./searchFallbackRuntime');
const {
  buildSearchProductKey: buildSearchProductKeyBase,
  resolveSearchDedupePerTitleLimit: resolveSearchDedupePerTitleLimitBase,
  collapseNearDuplicateSearchProducts: collapseNearDuplicateSearchProductsBase,
} = require('./searchDedupe');

function getSearchPayload(effectivePayload) {
  if (effectivePayload && typeof effectivePayload === 'object') {
    return effectivePayload.search || effectivePayload;
  }
  return {};
}

function getClarification(body) {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    body.clarification &&
    typeof body.clarification === 'object' &&
    body.clarification.question
  ) {
    return body.clarification;
  }
  return null;
}

async function maybeHandleFindProductsMultiCrossMerchantCacheSearch({
  metadata,
  payload,
  effectivePayload,
  effectiveIntent,
  policyMetadata,
  rawUserQuery,
  findProductsExpansionMeta,
  traceQueryClass,
  traceRewriteGate,
  traceAssociationPlan,
  traceFlagsSnapshot,
  traceAmbiguityScorePre,
  gatewayRequestId,
  invokeStartedAtMs,
  now,
  creatorId,
  checkoutToken,
  hasDatabase,
  routeDebugEnabled,
  findProductsMultiCacheStageBudgetMs,
  searchExternalHardRulePrune,
  searchExternalFillGated,
  proxySearchCacheMissResolverFallbackEnabled,
  proxySearchAuroraResolverTimeoutMs,
  proxySearchResolverTimeoutMs,
  proxySearchAuroraBypassCacheStrictEmpty,
  searchForceControlledRecallForScenario,
  findProductsMultiExpansionMode,
  addFpmGateTrace,
  detectBrandEntities,
  isCreatorUiSource = isCreatorUiSourceBase,
  withStageBudget = withStageBudgetBase,
  searchCrossMerchantFromCache,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  normalizeSearchTextForMatch,
  tokenizeSearchTextForMatch,
  isSupplementCandidateRelevant,
  hasPetLeashSearchSignal,
  hasStrictPetHarnessCatalogSignal,
  buildFallbackCandidateText,
  hasPetHarnessSearchSignal,
  hasFragranceSearchSignal,
  isCatalogGuardSource = isCatalogGuardSourceBase,
  isBeautyGeneralDiversitySupplementCandidate,
  fetchExternalSeedSupplementFromBackend,
  firstQueryParamValue,
  buildSearchProductKey = buildSearchProductKeyBase,
  isExternalSeedProduct,
  blendBeautyDiversitySupplement,
  resolveSearchDedupePerTitleLimit = resolveSearchDedupePerTitleLimitBase,
  collapseNearDuplicateSearchProducts = collapseNearDuplicateSearchProductsBase,
  isProxySearchFallbackRelevant,
  hasPetSearchSignal,
  hasBeautyMakeupSearchSignal,
  hasBeautyCatalogProductSignal,
  isShoppingSource = isShoppingSourceBase,
  normalizeExternalSeedStrategy = normalizeExternalSeedStrategyBase,
  isUnifiedLikeExternalSeedStrategy = isUnifiedLikeExternalSeedStrategyBase,
  uniqueStrings,
  evaluateCacheQualityGate,
  getActivePromotions = getActivePromotionsBase,
  applyDealsToResponse = applyDealsToResponseBase,
  applyFindProductsMultiPolicy,
  withSearchDiagnostics,
  buildSearchRouteHealth = buildSearchRouteHealthBase,
  buildSearchTrace = buildSearchTraceBase,
  extractCommerceSurfaceFromPayload = extractCommerceSurfaceFromPayloadBase,
  attachEligibleOfferFieldsToSearchResponse = attachEligibleOfferFieldsToSearchResponseBase,
  isKnownLookupAliasQuery,
  queryResolveSearchFallback,
  isAuroraSource = isAuroraSourceBase,
  logger,
} = {}) {
  let crossMerchantCacheRouteDebug = null;
  let crossMerchantCacheProtectedResponse = null;

  if (!hasDatabase) {
    return {
      handled: false,
      crossMerchantCacheRouteDebug,
      crossMerchantCacheProtectedResponse,
    };
  }

  const source = metadata?.source;
  const search = getSearchPayload(effectivePayload);
  const queryText = String(search.query || '').trim();
  const inStockOnly = search.in_stock_only !== false;
  const isCreatorUi = Boolean(
    typeof isCreatorUiSource === 'function' && isCreatorUiSource(source),
  );
  const cacheQueryText = String(rawUserQuery || queryText || '').trim();
  const cacheSearchQueryText = String(
    findProductsExpansionMeta?.expanded_query || cacheQueryText,
  ).trim();
  const merchantId = String(search.merchant_id || search.merchantId || '').trim();
  const merchantIdsRaw = search.merchant_ids || search.merchantIds;
  const merchantIds = Array.isArray(merchantIdsRaw)
    ? merchantIdsRaw.map((value) => String(value || '').trim()).filter(Boolean)
    : typeof merchantIdsRaw === 'string'
      ? merchantIdsRaw
          .split(',')
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      : [];
  const hasMerchantScope = Boolean(merchantId) || merchantIds.length > 0;
  const isCrossMerchantQuerySearch =
    !isCreatorUi && cacheSearchQueryText.length > 0 && !hasMerchantScope;

  if (!isCrossMerchantQuerySearch) {
    return {
      handled: false,
      crossMerchantCacheRouteDebug,
      crossMerchantCacheProtectedResponse,
    };
  }

  try {
    const cacheStageStartedAt = Date.now();
    const page = search.page || 1;
    const limit = search.limit || search.page_size || 20;
    const fromCache = await withStageBudget(
      searchCrossMerchantFromCache(cacheSearchQueryText, page, limit, {
        inStockOnly,
      }),
      findProductsMultiCacheStageBudgetMs,
      'cache_stage',
    );
    const internalProducts = Array.isArray(fromCache.products) ? fromCache.products : [];
    const lookupAnchorTokens = extractSearchAnchorTokens(cacheQueryText);
    const isLookupQuery = isLookupStyleSearchQuery(cacheQueryText, lookupAnchorTokens);
    const normalizedLookupQuery = normalizeSearchTextForMatch(cacheQueryText);
    const lookupQueryTokens = Array.from(
      new Set(tokenizeSearchTextForMatch(normalizedLookupQuery)),
    );
    const lookupRelevantInternalProducts = isLookupQuery
      ? internalProducts.filter((product) =>
          isSupplementCandidateRelevant(product, cacheQueryText, {
            normalizedQuery: normalizedLookupQuery,
            anchorTokens: lookupAnchorTokens,
            queryTokens: lookupQueryTokens,
          }),
        )
      : internalProducts;
    const internalProductsForRecall =
      isLookupQuery && lookupRelevantInternalProducts.length > 0
        ? lookupRelevantInternalProducts
        : internalProducts;
    const leashAnchoredQuery = hasPetLeashSearchSignal(cacheQueryText);
    const leashAnchoredInternalProducts = leashAnchoredQuery
      ? internalProductsForRecall.filter((product) =>
          hasStrictPetHarnessCatalogSignal(buildFallbackCandidateText(product)),
        )
      : internalProductsForRecall;
    const internalProductsAfterAnchor = leashAnchoredInternalProducts;
    const safeResultLimit = Math.max(1, Number(limit || 20));
    const needsPrimaryFillSupplement = internalProductsAfterAnchor.length < safeResultLimit;
    const shouldSkipExternalSupplementForPetHarness =
      hasPetHarnessSearchSignal(cacheQueryText) && internalProductsAfterAnchor.length >= 3;
    const isFragranceQuery = hasFragranceSearchSignal(cacheQueryText);
    const needsBeautyDiversitySupplement =
      !(searchExternalHardRulePrune && isFragranceQuery) &&
      isCatalogGuardSource(source) &&
      Number(page) === 1 &&
      isBeautyGeneralDiversitySupplementCandidate(
        effectiveIntent,
        internalProductsAfterAnchor,
        safeResultLimit,
      );
    let supplementedProducts = internalProductsAfterAnchor;
    let supplementMeta = {
      attempted: false,
      applied: false,
      added_count: 0,
      reason: 'not_needed',
    };

    if (
      isCatalogGuardSource(source) &&
      Number(page) === 1 &&
      (needsPrimaryFillSupplement || needsBeautyDiversitySupplement)
    ) {
      const neededCount = needsPrimaryFillSupplement
        ? Math.max(0, safeResultLimit - internalProductsAfterAnchor.length)
        : Math.max(1, Math.ceil(safeResultLimit / 2));
      if (neededCount > 0) {
        const confidenceOverall = Number(effectiveIntent?.confidence?.overall || 0) || 0;
        const ambiguityScorePre =
          Number(findProductsExpansionMeta?.ambiguity_score_pre || 0) || 0;
        const externalFillMinInternal = Math.min(3, safeResultLimit);
        const externalFillGateWouldBlock =
          searchExternalFillGated &&
          !(
            internalProductsAfterAnchor.length >= externalFillMinInternal &&
            (confidenceOverall >= 0.7 || isLookupQuery) &&
            ambiguityScorePre <= 0.45
          );
        const canApplyExternalFillGate = searchExternalHardRulePrune
          ? true
          : !externalFillGateWouldBlock;

        if (shouldSkipExternalSupplementForPetHarness) {
          supplementMeta = {
            attempted: false,
            applied: false,
            added_count: 0,
            reason: 'pet_harness_internal_sufficient',
            gate: {
              internal_count: internalProductsAfterAnchor.length,
              min_internal_required: 3,
            },
          };
        } else if (!canApplyExternalFillGate) {
          supplementMeta = {
            attempted: false,
            applied: false,
            added_count: 0,
            reason: 'external_fill_gate_blocked',
            gate: {
              enabled: searchExternalFillGated,
              min_internal_required: externalFillMinInternal,
              internal_count: internalProductsAfterAnchor.length,
              overall_confidence: confidenceOverall,
              ambiguity_score_pre: ambiguityScorePre,
              lookup_query_bypass: Boolean(isLookupQuery),
            },
          };
        } else {
          supplementMeta = {
            attempted: true,
            applied: false,
            added_count: 0,
            reason:
              externalFillGateWouldBlock && searchExternalHardRulePrune
                ? 'external_fill_gate_soft_bypassed'
                : 'supplement_pending',
            diversity_targeted: needsBeautyDiversitySupplement,
            gate: {
              enabled: searchExternalFillGated,
              soft_bypassed: Boolean(
                externalFillGateWouldBlock && searchExternalHardRulePrune,
              ),
              min_internal_required: externalFillMinInternal,
              internal_count: internalProductsAfterAnchor.length,
              overall_confidence: confidenceOverall,
              ambiguity_score_pre: ambiguityScorePre,
              lookup_query_bypass: Boolean(isLookupQuery),
            },
          };
          try {
            const supplement = await fetchExternalSeedSupplementFromBackend({
              queryParams: {
                query: cacheSearchQueryText,
                ...(search.category ? { category: search.category } : {}),
                ...(search.price_min != null || search.min_price != null
                  ? { min_price: search.price_min ?? search.min_price }
                  : {}),
                ...(search.price_max != null || search.max_price != null
                  ? { max_price: search.price_max ?? search.max_price }
                  : {}),
                in_stock_only: inStockOnly,
              },
              checkoutToken,
              neededCount,
              source,
              externalSeedStrategy:
                firstQueryParamValue(
                  search?.external_seed_strategy ||
                    search?.externalSeedStrategy ||
                    payload?.search?.external_seed_strategy ||
                    payload?.search?.externalSeedStrategy,
                ) || 'supplement_internal_first',
            });
            const seen = new Set(
              internalProductsAfterAnchor
                .map((product) => buildSearchProductKey(product))
                .filter(Boolean),
            );
            const supplementCandidates = Array.isArray(supplement?.products)
              ? supplement.products
              : [];
            const toAppend = [];
            for (const product of supplementCandidates) {
              if (!isExternalSeedProduct(product)) continue;
              if (
                !isSupplementCandidateRelevant(product, cacheQueryText, {
                  normalizedQuery: normalizedLookupQuery,
                  anchorTokens: lookupAnchorTokens,
                  queryTokens: lookupQueryTokens,
                })
              ) {
                continue;
              }
              const key = buildSearchProductKey(product);
              if (!key || seen.has(key)) continue;
              seen.add(key);
              toAppend.push(product);
              if (toAppend.length >= neededCount) break;
            }
            supplementedProducts =
              needsBeautyDiversitySupplement &&
              internalProductsAfterAnchor.length >= safeResultLimit
                ? blendBeautyDiversitySupplement(
                    internalProductsAfterAnchor,
                    toAppend,
                    safeResultLimit,
                  )
                : internalProductsAfterAnchor.concat(toAppend);
            supplementMeta = {
              ...(supplement?.metadata && typeof supplement.metadata === 'object'
                ? supplement.metadata
                : {}),
              attempted: true,
              applied: toAppend.length > 0,
              added_count: toAppend.length,
              reason: toAppend.length > 0
                ? needsBeautyDiversitySupplement
                  ? 'supplemented_external_seed_diversity'
                  : 'supplemented_external_seed'
                : needsBeautyDiversitySupplement && !searchExternalHardRulePrune
                  ? 'no_external_candidates_for_diversity'
                  : 'no_external_candidates',
              diversity_targeted: needsBeautyDiversitySupplement,
            };
          } catch (supplementErr) {
            supplementMeta = {
              attempted: true,
              applied: false,
              added_count: 0,
              reason: 'supplement_error',
              error: String(
                supplementErr && supplementErr.message ? supplementErr.message : supplementErr,
              ),
              diversity_targeted: needsBeautyDiversitySupplement,
            };
            logger.warn(
              {
                err: supplementErr?.message || String(supplementErr),
                query: cacheQueryText,
              },
              'Cross-merchant cache search supplement failed; returning internal cache results',
            );
          }
        }
      }
    }

    const dedupePerTitleLimit = resolveSearchDedupePerTitleLimit({
      queryText: cacheQueryText,
      intent: effectiveIntent,
      queryClass: findProductsExpansionMeta?.query_class || effectiveIntent?.query_class || null,
    });
    const effectiveProducts = collapseNearDuplicateSearchProducts(supplementedProducts, {
      perTitleLimit: dedupePerTitleLimit,
    });
    const cacheRelevant = cacheQueryText
      ? isProxySearchFallbackRelevant({ products: effectiveProducts }, cacheQueryText)
      : true;
    const relaxCacheRelevanceGate =
      hasPetSearchSignal(cacheQueryText) ||
      (hasBeautyMakeupSearchSignal(cacheQueryText) &&
        effectiveProducts.some((product) =>
          hasBeautyCatalogProductSignal(buildFallbackCandidateText(product)),
        ));
    const effectiveCacheHitBase =
      effectiveProducts.length > 0 &&
      (!isShoppingSource(source) || cacheRelevant || relaxCacheRelevanceGate);
    let effectiveCacheHit = effectiveCacheHitBase;
    const normalizedSeedStrategyForCache = normalizeExternalSeedStrategy(
      firstQueryParamValue(
        search?.external_seed_strategy ||
          search?.externalSeedStrategy ||
          payload?.search?.external_seed_strategy ||
          payload?.search?.externalSeedStrategy,
      ) || (isCatalogGuardSource(source) ? 'supplement_internal_first' : 'legacy'),
      isCatalogGuardSource(source) ? 'supplement_internal_first' : 'legacy',
    );
    const unifiedRelevanceRequested = isUnifiedLikeExternalSeedStrategy(
      normalizedSeedStrategyForCache,
    );
    const externalCount = effectiveProducts.filter((product) => isExternalSeedProduct(product))
      .length;
    crossMerchantCacheRouteDebug = {
      attempted: true,
      mode: 'search',
      query: cacheQueryText,
      cache_query: cacheSearchQueryText,
      upstream_query: queryText,
      latency_ms: Math.max(0, Date.now() - cacheStageStartedAt),
      page,
      limit,
      in_stock_only: inStockOnly,
      cache_hit: effectiveCacheHit,
      cache_hit_base: effectiveCacheHitBase,
      products_count: effectiveProducts.length,
      internal_products_count: internalProducts.length,
      internal_products_relevant_count: internalProductsAfterAnchor.length,
      leash_anchor_applied: leashAnchoredQuery,
      external_products_count: externalCount,
      cache_relevant: cacheRelevant,
      cache_relevance_gate_relaxed: relaxCacheRelevanceGate,
      total: Number(fromCache.total || 0),
      retrieval_sources: fromCache.retrieval_sources || null,
      supplement: supplementMeta,
    };

    const merchantsReturned = uniqueStrings(
      effectiveProducts.map((product) => product?.merchant_id || product?.merchantId),
    );
    const upstreamData = {
      products: effectiveProducts,
      total: Math.max(Number(fromCache.total || 0), effectiveProducts.length),
      page: fromCache.page,
      page_size: effectiveProducts.length,
      reply: null,
      metadata: {
        query_source: supplementMeta.applied
          ? 'cache_cross_merchant_search_supplemented'
          : 'cache_cross_merchant_search',
        fetched_at: new Date().toISOString(),
        merchants_searched: merchantsReturned.length,
        source_breakdown: {
          internal_count: effectiveProducts.length - externalCount,
          external_seed_count: externalCount,
          stale_cache_used: false,
          strategy_applied: isCatalogGuardSource(source)
            ? normalizedSeedStrategyForCache || 'legacy'
            : 'cache_only',
        },
        ...(fromCache.retrieval_sources
          ? { retrieval_sources: fromCache.retrieval_sources }
          : {}),
        ...(routeDebugEnabled
          ? {
              route_debug: {
                cross_merchant_cache: crossMerchantCacheRouteDebug,
              },
            }
          : {}),
      },
    };

    const cacheBrandDetection = detectBrandEntities(cacheQueryText, {
      candidateProducts: effectiveProducts,
    });
    const cacheBrandLikeQuery = Boolean(cacheBrandDetection?.brand_like);
    const cachePolicyQueryClass = String(
      traceQueryClass || effectiveIntent?.query_class || '',
    ).toLowerCase();
    const cacheLookupClass =
      cachePolicyQueryClass === 'lookup' || cachePolicyQueryClass === 'attribute';
    const shouldSkipLookupPolicyForCacheHit =
      effectiveProducts.length > 0 &&
      (isLookupQuery || cacheLookupClass || cacheBrandLikeQuery) &&
      String(upstreamData?.metadata?.query_source || '').startsWith(
        'cache_cross_merchant_search',
      );
    const withPolicy =
      effectiveIntent && !shouldSkipLookupPolicyForCacheHit
        ? applyFindProductsMultiPolicy({
            response: upstreamData,
            intent: effectiveIntent,
            requestPayload: effectivePayload,
            metadata: policyMetadata,
            rawUserQuery,
          })
        : upstreamData;
    const withPolicyProducts = Array.isArray(withPolicy?.products) ? withPolicy.products : [];
    const cacheValidationQueryClass =
      traceQueryClass ||
      effectiveIntent?.query_class ||
      (isLookupQuery && !cacheBrandLikeQuery ? 'lookup' : null);
    const cacheValidation = evaluateCacheQualityGate({
      products: withPolicyProducts.length > 0 ? withPolicyProducts : effectiveProducts,
      queryText: cacheQueryText,
      intent: effectiveIntent,
      queryClass: cacheValidationQueryClass,
    });
    const cacheRejectedLowQuality = Boolean(
      cacheValidation.enabled && !cacheValidation.accepted,
    );
    if (cacheRejectedLowQuality) {
      effectiveCacheHit = false;
    }
    const cacheMissingExternalForUnified =
      unifiedRelevanceRequested &&
      !hasMerchantScope &&
      Boolean(cacheQueryText) &&
      externalCount <= 0 &&
      !isLookupQuery &&
      !(isFragranceQuery && effectiveProducts.length > 0);
    if (cacheMissingExternalForUnified) {
      effectiveCacheHit = false;
    }
    const cacheStrictEmptyBypassReason = cacheMissingExternalForUnified
      ? 'missing_external_for_unified'
      : cacheRejectedLowQuality
        ? 'cache_rejected_low_quality'
        : cacheBrandLikeQuery
          ? 'brand_query_search_first'
          : null;
    const bypassCacheStrictEmptyForUnified =
      Boolean(cacheStrictEmptyBypassReason) &&
      (unifiedRelevanceRequested || cacheBrandLikeQuery);
    if (crossMerchantCacheRouteDebug && typeof crossMerchantCacheRouteDebug === 'object') {
      crossMerchantCacheRouteDebug.cache_hit = effectiveCacheHit;
      crossMerchantCacheRouteDebug.cache_validation = cacheValidation;
      crossMerchantCacheRouteDebug.cache_rejected_low_quality = cacheRejectedLowQuality;
      crossMerchantCacheRouteDebug.cache_missing_external_for_unified =
        cacheMissingExternalForUnified;
      crossMerchantCacheRouteDebug.cache_strict_empty_bypassed =
        bypassCacheStrictEmptyForUnified;
      crossMerchantCacheRouteDebug.cache_strict_empty_bypass_reason =
        cacheStrictEmptyBypassReason;
    }

    const promotions = await getActivePromotions(now, creatorId);
    let enriched = applyDealsToResponse(withPolicy, promotions, now, creatorId);
    const { commerceSurface, explicit: explicitCommerceSurface } =
      extractCommerceSurfaceFromPayload(effectivePayload, metadata, {
        fallback: 'agent_api',
      });
    if (explicitCommerceSurface) {
      enriched = attachEligibleOfferFieldsToSearchResponse(enriched, commerceSurface);
    }
    const cacheClarification = getClarification(enriched);
    const cachePolicyTerminalDecision =
      effectiveProducts.length > 0 &&
      (Boolean(cacheClarification) ||
        (Array.isArray(withPolicyProducts) &&
          withPolicyProducts.length === 0 &&
          (Boolean(withPolicy?.metadata?.strict_empty) ||
            ['clarify', 'strict_empty'].includes(
              String(withPolicy?.metadata?.search_decision?.final_decision || '').trim(),
            ))));

    if (
      effectiveCacheHit &&
      internalProductsAfterAnchor.length > 0 &&
      (cacheRelevant || relaxCacheRelevanceGate)
    ) {
      crossMerchantCacheProtectedResponse =
        withPolicyProducts.length > 0
          ? enriched
          : applyDealsToResponse(upstreamData, promotions, now, creatorId);
    }

    if (effectiveCacheHit || cachePolicyTerminalDecision) {
      const diagnosed = withSearchDiagnostics(enriched, {
        route_health: buildSearchRouteHealth({
          primaryPathUsed: 'cache_stage',
          primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
          fallbackTriggered: false,
          fallbackReason: null,
          ambiguityScorePre: traceAmbiguityScorePre,
          clarifyTriggered: Boolean(cacheClarification),
        }),
        search_trace: buildSearchTrace({
          traceId: gatewayRequestId,
          rawQuery: cacheQueryText,
          expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
          expansionMode:
            findProductsExpansionMeta?.mode || findProductsMultiExpansionMode,
          queryClass: traceQueryClass,
          rewriteGate: traceRewriteGate,
          associationPlan: traceAssociationPlan,
          flagsSnapshot: traceFlagsSnapshot,
          intent: effectiveIntent,
          cacheStage: {
            hit: true,
            candidate_count: Number(effectiveProducts.length || 0),
            relevant_count: Number(internalProductsAfterAnchor.length || 0),
            retrieval_sources: fromCache.retrieval_sources || [],
          },
          upstreamStage: {
            called: false,
            timeout: false,
            status: null,
            latency_ms: 0,
          },
          resolverStage: {
            called: false,
            hit: false,
            miss: false,
            latency_ms: null,
          },
          finalDecision: cacheClarification ? 'clarify' : 'cache_returned',
        }),
      });
      return {
        handled: true,
        body: diagnosed,
        crossMerchantCacheRouteDebug,
        crossMerchantCacheProtectedResponse,
      };
    }

    const queryClassForEarlyDecision = String(
      traceQueryClass || effectiveIntent?.query_class || '',
    ).toLowerCase();
    const earlyDecisionBrandDetection = detectBrandEntities(cacheQueryText, {
      candidateProducts: effectiveProducts,
    });
    const isBrandLikeForEarlyDecision = Boolean(earlyDecisionBrandDetection?.brand_like);
    const queryClassMissing = queryClassForEarlyDecision.length === 0;
    const hasAmbiguitySignal = Boolean(effectiveIntent?.ambiguity?.needs_clarification);
    const forceControlledRecallForScenario =
      searchForceControlledRecallForScenario &&
      (['scenario', 'mission'].includes(queryClassForEarlyDecision) ||
        (queryClassMissing && hasAmbiguitySignal));
    const isStrongLookupForEarlyDecision =
      queryClassForEarlyDecision === 'lookup' || isKnownLookupAliasQuery(cacheQueryText);
    const hasEarlyDecisionClass = [
      'mission',
      'scenario',
      'gift',
      'exploratory',
      'non_shopping',
    ].includes(queryClassForEarlyDecision);
    const forceSearchFirstForClass = ['category', 'exploratory'].includes(
      queryClassForEarlyDecision,
    );
    const earlyDecisionCause =
      internalProductsAfterAnchor.length === 0
        ? 'cache_miss_ambiguity_sensitive'
        : 'cache_irrelevant_ambiguity_sensitive';
    const canUseEarlyAmbiguityDecision =
      effectiveIntent &&
      !isBrandLikeForEarlyDecision &&
      !isStrongLookupForEarlyDecision &&
      !forceSearchFirstForClass &&
      (hasEarlyDecisionClass || (queryClassMissing && hasAmbiguitySignal)) &&
      !forceControlledRecallForScenario;

    addFpmGateTrace({
      gateId: 'early_ambiguity_decision',
      applied: Boolean(effectiveIntent),
      decision: canUseEarlyAmbiguityDecision ? 'clarify_only_early' : 'pass',
      reason: canUseEarlyAmbiguityDecision
        ? earlyDecisionCause
        : isBrandLikeForEarlyDecision
          ? 'brand_like_search_first'
          : forceSearchFirstForClass
            ? 'search_first_query_class'
            : null,
      costMsEstimate: 110,
      queryClass: queryClassForEarlyDecision || traceQueryClass,
    });

    if (
      forceSearchFirstForClass &&
      crossMerchantCacheRouteDebug &&
      typeof crossMerchantCacheRouteDebug === 'object'
    ) {
      crossMerchantCacheRouteDebug.early_decision = {
        applied: false,
        reason: 'search_first_query_class',
        query_class: queryClassForEarlyDecision,
      };
    }
    if (
      forceControlledRecallForScenario &&
      crossMerchantCacheRouteDebug &&
      typeof crossMerchantCacheRouteDebug === 'object'
    ) {
      crossMerchantCacheRouteDebug.early_decision = {
        applied: false,
        reason: 'force_controlled_recall_for_scenario',
        query_class: queryClassForEarlyDecision,
      };
    }
    if (
      isBrandLikeForEarlyDecision &&
      crossMerchantCacheRouteDebug &&
      typeof crossMerchantCacheRouteDebug === 'object'
    ) {
      crossMerchantCacheRouteDebug.early_decision = {
        applied: false,
        reason: 'brand_like_search_first',
        query_class: queryClassForEarlyDecision,
        brand_entities: Array.isArray(earlyDecisionBrandDetection?.brands)
          ? earlyDecisionBrandDetection.brands
          : [],
      };
    }

    if (canUseEarlyAmbiguityDecision) {
      const earlyDecisionResponse = {
        products: [],
        total: 0,
        page: fromCache.page,
        page_size: 0,
        reply: null,
        metadata: {
          query_source: 'cache_cross_merchant_search_early_decision',
          fetched_at: new Date().toISOString(),
          merchants_searched: merchantsReturned.length,
          source_breakdown: {
            internal_count: 0,
            external_seed_count: 0,
            stale_cache_used: false,
            strategy_applied: 'ambiguity_gate_before_upstream',
          },
          ...(routeDebugEnabled
            ? {
                route_debug: {
                  cross_merchant_cache: {
                    ...(crossMerchantCacheRouteDebug &&
                    typeof crossMerchantCacheRouteDebug === 'object'
                      ? crossMerchantCacheRouteDebug
                      : {}),
                    early_decision: {
                      applied: true,
                      reason: earlyDecisionCause,
                      query_class: queryClassForEarlyDecision,
                    },
                  },
                },
              }
            : {}),
        },
      };
      const earlyWithPolicy = applyFindProductsMultiPolicy({
        response: earlyDecisionResponse,
        intent: effectiveIntent,
        requestPayload: effectivePayload,
        metadata: policyMetadata,
        rawUserQuery,
      });
      const earlyDecisionProducts = Array.isArray(earlyWithPolicy?.products)
        ? earlyWithPolicy.products
        : [];
      const earlyDecisionClarification = getClarification(earlyWithPolicy);
      const earlyDecisionStrictEmpty =
        Boolean(earlyWithPolicy?.metadata?.strict_empty) ||
        (earlyDecisionProducts.length === 0 && !earlyDecisionClarification);
      const earlyDecisionResponsePayload =
        earlyDecisionStrictEmpty &&
        earlyWithPolicy &&
        typeof earlyWithPolicy === 'object' &&
        !Array.isArray(earlyWithPolicy) &&
        !earlyWithPolicy?.metadata?.strict_empty
          ? {
              ...earlyWithPolicy,
              metadata: {
                ...(earlyWithPolicy.metadata &&
                typeof earlyWithPolicy.metadata === 'object'
                  ? earlyWithPolicy.metadata
                  : {}),
                strict_empty: true,
              },
            }
          : earlyWithPolicy;

      if (earlyDecisionClarification || earlyDecisionStrictEmpty) {
        const earlyDiagnosed = withSearchDiagnostics(earlyDecisionResponsePayload, {
          route_health: buildSearchRouteHealth({
            primaryPathUsed: 'cache_stage',
            primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
            fallbackTriggered: false,
            fallbackReason: null,
            ambiguityScorePre: traceAmbiguityScorePre,
            clarifyTriggered: Boolean(earlyDecisionClarification),
          }),
          search_trace: buildSearchTrace({
            traceId: gatewayRequestId,
            rawQuery: cacheQueryText,
            expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
            expansionMode:
              findProductsExpansionMeta?.mode || findProductsMultiExpansionMode,
            queryClass: traceQueryClass,
            rewriteGate: traceRewriteGate,
            associationPlan: traceAssociationPlan,
            flagsSnapshot: traceFlagsSnapshot,
            intent: effectiveIntent,
            cacheStage: {
              hit: false,
              candidate_count: 0,
              relevant_count: 0,
              retrieval_sources: fromCache.retrieval_sources || [],
            },
            upstreamStage: {
              called: false,
              timeout: false,
              status: null,
              latency_ms: 0,
            },
            resolverStage: {
              called: false,
              hit: false,
              miss: false,
              latency_ms: null,
            },
            finalDecision: earlyDecisionClarification ? 'clarify' : 'strict_empty',
          }),
        });
        return {
          handled: true,
          body: earlyDiagnosed,
          crossMerchantCacheRouteDebug,
          crossMerchantCacheProtectedResponse,
        };
      }
    }

    if (
      proxySearchCacheMissResolverFallbackEnabled &&
      isLookupQuery &&
      cacheQueryText.length > 0
    ) {
      try {
        const resolverFallback = await queryResolveSearchFallback({
          queryParams: {
            query: cacheQueryText,
            ...(search.category ? { category: search.category } : {}),
            ...(search.price_min != null || search.min_price != null
              ? { min_price: search.price_min ?? search.min_price }
              : {}),
            ...(search.price_max != null || search.max_price != null
              ? { max_price: search.price_max ?? search.max_price }
              : {}),
            in_stock_only: inStockOnly,
            limit,
            offset: 0,
            search_all_merchants: true,
            allow_external_seed: true,
            allow_stale_cache: false,
            external_seed_strategy: normalizedSeedStrategyForCache || 'unified_relevance',
            fast_mode: true,
          },
          checkoutToken,
          reason: 'resolver_after_cache_miss',
          requestSource: source,
          timeoutMs: isAuroraSource(source)
            ? proxySearchAuroraResolverTimeoutMs
            : proxySearchResolverTimeoutMs,
        });
        if (
          resolverFallback &&
          resolverFallback.status >= 200 &&
          resolverFallback.status < 300 &&
          resolverFallback.usableCount > 0
        ) {
          const resolverEnriched = applyDealsToResponse(
            resolverFallback.data,
            promotions,
            now,
            creatorId,
          );
          const resolverClarification = getClarification(resolverEnriched);
          const resolverDiagnosed = withSearchDiagnostics(resolverEnriched, {
            route_health: buildSearchRouteHealth({
              primaryPathUsed: 'resolver_stage',
              primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
              fallbackTriggered: true,
              fallbackReason: 'resolver_after_cache_miss',
              ambiguityScorePre: traceAmbiguityScorePre,
              clarifyTriggered: Boolean(resolverClarification),
            }),
            search_trace: buildSearchTrace({
              traceId: gatewayRequestId,
              rawQuery: cacheQueryText,
              expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
              expansionMode:
                findProductsExpansionMeta?.mode || findProductsMultiExpansionMode,
              queryClass: traceQueryClass,
              rewriteGate: traceRewriteGate,
              associationPlan: traceAssociationPlan,
              flagsSnapshot: traceFlagsSnapshot,
              intent: effectiveIntent,
              cacheStage: {
                hit: false,
                candidate_count: Number(effectiveProducts.length || 0),
                relevant_count: Number(internalProductsAfterAnchor.length || 0),
                retrieval_sources: fromCache.retrieval_sources || [],
              },
              upstreamStage: {
                called: false,
                timeout: false,
                status: null,
                latency_ms: 0,
              },
              resolverStage: {
                called: true,
                hit: true,
                miss: false,
                latency_ms: null,
              },
              finalDecision: resolverClarification ? 'clarify' : 'resolver_returned',
            }),
          });
          return {
            handled: true,
            body: resolverDiagnosed,
            crossMerchantCacheRouteDebug,
            crossMerchantCacheProtectedResponse,
          };
        }
      } catch (resolverFallbackErr) {
        logger.warn(
          {
            err: resolverFallbackErr?.message || String(resolverFallbackErr),
            query: cacheQueryText,
          },
          'Cross-merchant cache search resolver fallback failed after cache miss',
        );
      }
    }

    const bypassCacheStrictEmpty =
      isAuroraSource(source) && proxySearchAuroraBypassCacheStrictEmpty;
    const cacheStrictEmptyEarlyReturnEnabled = false;
    if (
      cacheStrictEmptyEarlyReturnEnabled &&
      isCatalogGuardSource(source) &&
      cacheQueryText.length > 0 &&
      !effectiveCacheHit &&
      !isLookupQuery &&
      !bypassCacheStrictEmpty &&
      !bypassCacheStrictEmptyForUnified &&
      !forceControlledRecallForScenario
    ) {
      const cacheStrictReason =
        effectiveProducts.length > 0
          ? 'cache_irrelevant_strict_empty'
          : 'cache_miss_strict_empty';
      const strictEmptyBase = {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        page: fromCache.page,
        page_size: 0,
        reply: null,
        metadata: {
          query_source: 'cache_cross_merchant_search',
          fetched_at: new Date().toISOString(),
          merchants_searched: merchantsReturned.length,
          source_breakdown: {
            internal_count: 0,
            external_seed_count: 0,
            stale_cache_used: false,
            strategy_applied: isCatalogGuardSource(source)
              ? normalizedSeedStrategyForCache || 'unified_relevance'
              : 'cache_only',
          },
          proxy_search_fallback: {
            applied: false,
            reason: cacheStrictReason,
          },
          ...(fromCache.retrieval_sources
            ? { retrieval_sources: fromCache.retrieval_sources }
            : {}),
          ...(routeDebugEnabled
            ? {
                route_debug: {
                  cross_merchant_cache: crossMerchantCacheRouteDebug,
                },
              }
            : {}),
        },
      };
      const strictEmptyWithPolicy = effectiveIntent
        ? applyFindProductsMultiPolicy({
            response: strictEmptyBase,
            intent: effectiveIntent,
            requestPayload: effectivePayload,
            metadata: policyMetadata,
            rawUserQuery: cacheQueryText,
          })
        : strictEmptyBase;
      const strictEmptyEnriched = applyDealsToResponse(
        strictEmptyWithPolicy,
        promotions,
        now,
        creatorId,
      );
      const strictEmptyClarification = getClarification(strictEmptyEnriched);
      const strictEmptyDiagnosed = withSearchDiagnostics(strictEmptyEnriched, {
        route_health: buildSearchRouteHealth({
          primaryPathUsed: 'cache_stage',
          primaryLatencyMs: Math.max(0, Date.now() - invokeStartedAtMs),
          fallbackTriggered: false,
          fallbackReason: cacheStrictReason,
          ambiguityScorePre: traceAmbiguityScorePre,
          ambiguityScorePost: 1,
          clarifyTriggered: Boolean(strictEmptyClarification),
        }),
        search_trace: buildSearchTrace({
          traceId: gatewayRequestId,
          rawQuery: cacheQueryText,
          expandedQuery: findProductsExpansionMeta?.expanded_query || cacheQueryText,
          expansionMode:
            findProductsExpansionMeta?.mode || findProductsMultiExpansionMode,
          queryClass: traceQueryClass,
          rewriteGate: traceRewriteGate,
          associationPlan: traceAssociationPlan,
          flagsSnapshot: traceFlagsSnapshot,
          intent: effectiveIntent,
          cacheStage: {
            hit: false,
            candidate_count: Number(effectiveProducts.length || 0),
            relevant_count: Number(internalProductsAfterAnchor.length || 0),
            retrieval_sources: fromCache.retrieval_sources || [],
          },
          upstreamStage: {
            called: false,
            timeout: false,
            status: null,
            latency_ms: 0,
          },
          resolverStage: {
            called: false,
            hit: false,
            miss: false,
            latency_ms: null,
          },
          finalDecision: strictEmptyClarification ? 'clarify' : 'strict_empty',
        }),
        ...(strictEmptyClarification
          ? {}
          : {
              strict_empty: true,
              strict_empty_reason: cacheStrictReason,
            }),
      });
      return {
        handled: true,
        body: strictEmptyDiagnosed,
        crossMerchantCacheRouteDebug,
        crossMerchantCacheProtectedResponse,
      };
    }

    if (
      isCatalogGuardSource(source) &&
      cacheQueryText.length > 0 &&
      !effectiveCacheHit &&
      !isLookupQuery &&
      (bypassCacheStrictEmpty || bypassCacheStrictEmptyForUnified)
    ) {
      logger.info(
        {
          source,
          query: cacheQueryText,
          reason: bypassCacheStrictEmptyForUnified
            ? cacheStrictEmptyBypassReason || 'unified_relevance'
            : 'aurora_override',
        },
        'Catalog cache miss strict-empty bypassed; continuing to upstream search',
      );
    }

    logger.info(
      { source, page, limit, inStockOnly, query: cacheQueryText },
      'Cross-merchant cache search returned empty; falling back to upstream',
    );
  } catch (err) {
    crossMerchantCacheRouteDebug = {
      attempted: true,
      mode: 'search',
      query: cacheQueryText,
      cache_query: cacheSearchQueryText,
      upstream_query: queryText,
      page: search.page || 1,
      limit: search.limit || search.page_size || 20,
      in_stock_only: inStockOnly,
      cache_hit: false,
      timeout_budget_ms: findProductsMultiCacheStageBudgetMs,
      stage_timeout: String(err?.code || '').toUpperCase() === 'STAGE_TIMEOUT',
      error: String(err && err.message ? err.message : err),
    };
    logger.warn(
      { err: err.message, source, query: cacheQueryText },
      'Cross-merchant cache search failed; falling back to upstream',
    );
  }

  return {
    handled: false,
    crossMerchantCacheRouteDebug,
    crossMerchantCacheProtectedResponse,
  };
}

module.exports = {
  maybeHandleFindProductsMultiCrossMerchantCacheSearch,
};
