function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseBooleanQueryValue(value) {
  const raw = firstQueryValue(value);
  if (raw == null) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function buildSemanticOwnerProductKey(product) {
  if (!isPlainObject(product)) return '';
  const merchantId = String(product.merchant_id || product.merchantId || '').trim().toLowerCase();
  const productId = String(product.product_id || product.productId || product.id || '').trim().toLowerCase();
  if (merchantId && productId) return `${merchantId}::${productId}`;
  if (productId) return productId;
  const url = String(
    product.canonical_url ||
      product.canonicalUrl ||
      product.destination_url ||
      product.destinationUrl ||
      product.url ||
      '',
  ).trim().toLowerCase();
  if (url) return url;
  const title = String(product.title || product.display_name || product.displayName || product.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  return title ? `${merchantId || 'unknown'}::${title}` : '';
}

function isSemanticOwnerExternalSeedProduct(product) {
  if (!isPlainObject(product)) return false;
  const merchantId = String(product.merchant_id || product.merchantId || '').trim().toLowerCase();
  const source = String(product.source || product.query_source || '').trim().toLowerCase();
  return merchantId === 'external_seed' || source === 'external_seed' || source.includes('external_seed');
}

function buildSemanticOwnerProductAnchorText(product) {
  if (!isPlainObject(product)) return '';
  return [
    product.display_name,
    product.displayName,
    product.name,
    product.title,
    product.category,
    product.category_name,
    product.categoryName,
    product.product_type,
    product.productType,
    product.type,
    product.brand,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function isSemanticOwnerBundleLikeProduct(product) {
  return /\b(set|kit|duo|trio|sampler|bundle|discovery|collection|vault)\b/.test(
    buildSemanticOwnerProductAnchorText(product),
  );
}

function getSemanticOwnerProductStepSignals(product) {
  const text = buildSemanticOwnerProductAnchorText(product);
  return {
    text,
    treatment: /\b(serum|treatment|spot treatment|retinol|retinoid|acid|niacinamide|salicylic|zinc pca|azelaic|benzoyl)\b/.test(text),
    moisturizer: /\b(moisturi[sz]er|cream|gel cream|lotion|emulsion|water cream)\b/.test(text),
    sunscreen: /\b(spf(?:\s*\d{1,3}\+?)?|sunscreen|broad spectrum|uv|sun fluid|sun cream|sun lotion)\b/.test(text),
  };
}

function isSemanticOwnerEligiblePrimaryExternalProduct(product, { targetStepFamily = '' } = {}) {
  if (!isPlainObject(product)) return false;
  if (!isSemanticOwnerExternalSeedProduct(product)) return false;
  if (isSemanticOwnerBundleLikeProduct(product)) return false;
  const normalizedTargetStepFamily = String(targetStepFamily || '').trim().toLowerCase();
  const signals = getSemanticOwnerProductStepSignals(product);
  if (!normalizedTargetStepFamily) return signals.treatment || signals.moisturizer || signals.sunscreen;
  if (normalizedTargetStepFamily === 'treatment' || normalizedTargetStepFamily === 'serum') {
    return signals.treatment && !signals.sunscreen;
  }
  if (normalizedTargetStepFamily === 'moisturizer') {
    return signals.moisturizer && !signals.sunscreen;
  }
  if (normalizedTargetStepFamily === 'sunscreen') {
    return signals.sunscreen;
  }
  return false;
}

function mergeSemanticOwnerProductPools(primaryProducts = [], externalProducts = [], {
  preferExternalFirst = false,
  limit = 20,
} = {}) {
  const out = [];
  const seen = new Set();
  const orderedGroups = preferExternalFirst
    ? [externalProducts, primaryProducts]
    : [primaryProducts, externalProducts];
  const cap = Math.max(1, Number(limit || 20) || 20);
  for (const group of orderedGroups) {
    for (const product of Array.isArray(group) ? group : []) {
      if (!isPlainObject(product)) continue;
      const key = buildSemanticOwnerProductKey(product);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(product);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

function getSemanticOwnerValidProductCount(adoption = null, products = []) {
  const validCount = Array.isArray(adoption?.hitDecision?.valid_products)
    ? adoption.hitDecision.valid_products.length
    : null;
  if (Number.isFinite(Number(validCount))) return Math.max(0, Number(validCount) || 0);
  const returnedCount = Number(adoption?.hitDecision?.products_returned_count);
  if (Number.isFinite(returnedCount)) return Math.max(0, returnedCount);
  return Array.isArray(products) ? products.length : 0;
}

function shouldAttemptSemanticOwnerCoverageSupplement({
  operation = '',
  semanticOwnerControlled = false,
  semanticOwnerAdoptedByValidHit = false,
  currentAdoption = null,
  upstreamData = null,
  queryParams = null,
  semanticOwnerTargetStepFamily = '',
} = {}) {
  if (operation !== 'find_products_multi') return false;
  if (!semanticOwnerControlled || !semanticOwnerAdoptedByValidHit) return false;
  if (parseBooleanQueryValue(queryParams?.allow_external_seed ?? queryParams?.allowExternalSeed) !== true) {
    return false;
  }
  const targetStepFamily = String(semanticOwnerTargetStepFamily || '').trim().toLowerCase();
  if (!['sunscreen', 'treatment', 'serum'].includes(targetStepFamily)) return false;
  const products = Array.isArray(upstreamData?.products) ? upstreamData.products : [];
  if (products.length <= 0 || products.length > 1) return false;
  if (products.some((product) => isSemanticOwnerExternalSeedProduct(product))) return false;
  if (currentAdoption?.hitDecision?.hit_quality !== 'valid_hit') return false;
  if (currentAdoption?.last_resort_cache_candidate === true) return false;
  return getSemanticOwnerValidProductCount(currentAdoption, products) <= 1;
}

function shouldPreferSemanticOwnerExternalCoverage({
  primaryProducts = [],
  externalProducts = [],
  externalAdoption = null,
  externalCoverageTrusted = false,
  targetStepFamily = '',
} = {}) {
  const primaryCount = Array.isArray(primaryProducts) ? primaryProducts.length : 0;
  const externalValidCount = getSemanticOwnerValidProductCount(externalAdoption, externalProducts);
  const externalCount = Array.isArray(externalProducts) ? externalProducts.length : 0;
  const externalHitQuality = String(externalAdoption?.hitDecision?.hit_quality || '').trim();
  const eligiblePrimaryExternalCount = (Array.isArray(externalProducts) ? externalProducts : []).filter((product) =>
    isSemanticOwnerEligiblePrimaryExternalProduct(product, { targetStepFamily }),
  ).length;
  const normalizedTargetStepFamily = String(targetStepFamily || '').trim().toLowerCase();
  const minimumEligibleExternalCount =
    normalizedTargetStepFamily === 'treatment' || normalizedTargetStepFamily === 'serum'
      ? 2
      : 1;
  return (
    primaryCount <= 1 &&
    eligiblePrimaryExternalCount >= minimumEligibleExternalCount &&
    (
      externalAdoption?.adopt === true ||
      externalCoverageTrusted ||
      externalHitQuality !== 'invalid_hit'
    ) &&
    (externalValidCount >= 2 || (externalCoverageTrusted && externalCount >= 2))
  );
}

function filterSemanticOwnerCoverageExternalProducts(externalProducts = [], {
  targetStepFamily = '',
} = {}) {
  return (Array.isArray(externalProducts) ? externalProducts : []).filter((product) =>
    isSemanticOwnerEligiblePrimaryExternalProduct(product, { targetStepFamily }),
  );
}

function createFindProductsInvokeSemanticOwnerExecutionRuntime(deps = {}) {
  const {
    FPM_GATE_SIMPLIFY_V1,
    FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS,
    SEARCH_LIMIT_MAX,
  } = deps;

  async function runInvokeSemanticOwnerExecution({
    operation = '',
    semanticOwnerControlled = false,
    semanticOwnerQueryPack = [],
    semanticOwnerQueryTotal = 0,
    semanticOwnerTargetStepFamily = '',
    semanticOwnerSemanticFamily = '',
    semanticOwnerQueryStepStrength = '',
    semanticOwnerMinQueriesBeforeBudgetGuard = 0,
    response = null,
    upstreamData = null,
    queryParams = null,
    requestBody = null,
    axiosConfig = null,
    strictCommerceFindProductsMulti = false,
    strictBeautyDirectSearch = false,
    routeMethod = 'GET',
    url = '',
    buildQueryString = null,
    normalizeUpstreamData = null,
    callTrackedUpstream = null,
    buildVariantRequestBody = null,
    evaluateSemanticOwnerBeautyAdoption = null,
    describeSemanticOwnerObservationFallback = null,
    buildSemanticOwnerExternalRescueQueryPack = null,
    fetchExternalSeedSupplementFromBackend = null,
    normalizeAgentProductsListResponse = null,
    checkoutToken = null,
    metadata = null,
    effectivePayload = null,
    getFpmRemainingBudgetMs = null,
    logger = null,
    rawUserQuery = '',
  } = {}) {
    const primarySemanticOwnerAdoption = evaluateSemanticOwnerBeautyAdoption({
      upstreamData,
      queryText: String(queryParams?.query || '').trim() || semanticOwnerQueryPack[0] || '',
      queryParamsValue: queryParams,
      requestBodyValue: requestBody,
    });
    const primarySemanticOwnerObservation = describeSemanticOwnerObservationFallback({
      upstreamData,
      hitDecision: primarySemanticOwnerAdoption.hitDecision,
      queryText: String(queryParams?.query || '').trim() || semanticOwnerQueryPack[0] || '',
    });
    let semanticOwnerAdoptedByValidHit = primarySemanticOwnerAdoption.adopt === true;
    let semanticOwnerIgnoredObservationCandidate =
      semanticOwnerControlled && primarySemanticOwnerObservation.ignore === true;
    let semanticOwnerDeferredLastResortCache =
      semanticOwnerControlled &&
      primarySemanticOwnerAdoption.last_resort_cache_candidate === true;
    let semanticOwnerLastResortCacheApplied = false;
    let semanticOwnerLastResortCacheQuery = null;
    let semanticOwnerCacheSourceIsolated = false;
    let semanticOwnerCacheSourceIsolationReason = null;
    let semanticOwnerExternalRescueQueriesAttempted = [];
    let semanticOwnerObservationFallback =
      semanticOwnerControlled &&
      primarySemanticOwnerAdoption.adopt !== true &&
      Array.isArray(upstreamData?.products) &&
      upstreamData.products.length > 0 &&
      primarySemanticOwnerObservation.ignore !== true
        ? {
            score: primarySemanticOwnerObservation.score,
            response,
            upstreamData,
            queryParams,
            requestBody,
            queryIndex: 0,
            last_resort_cache_candidate:
              primarySemanticOwnerObservation.last_resort_cache_candidate === true,
          }
        : null;
    let semanticOwnerQueryAttempts =
      semanticOwnerQueryPack.length > 0
        ? [
            {
              query: String(queryParams?.query || '').trim() || semanticOwnerQueryPack[0],
              query_index: 0,
              query_total: semanticOwnerQueryTotal,
              result_count: Array.isArray(upstreamData?.products)
                ? upstreamData.products.length
                : 0,
              adopted: primarySemanticOwnerAdoption.adopt,
              ...(primarySemanticOwnerAdoption.hitDecision
                ? {
                    hit_quality:
                      primarySemanticOwnerAdoption.hitDecision.hit_quality || null,
                    invalid_hit_reason:
                      primarySemanticOwnerAdoption.hitDecision.invalid_hit_reason || null,
                    post_quality_result_count: Array.isArray(
                      primarySemanticOwnerAdoption.hitDecision.valid_products,
                    )
                      ? primarySemanticOwnerAdoption.hitDecision.valid_products.length
                      : 0,
                    last_resort_cache_candidate:
                      primarySemanticOwnerAdoption.last_resort_cache_candidate === true,
                    observation_candidate_ignored:
                      primarySemanticOwnerObservation.ignore === true,
                    observation_ignore_reason:
                      primarySemanticOwnerObservation.ignore_reason || null,
                  }
                : {}),
            },
          ]
        : [];

    if (
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      semanticOwnerQueryPack.length > 1 &&
      response?.status >= 200 &&
      response?.status < 300 &&
      primarySemanticOwnerAdoption.adopt !== true
    ) {
      const semanticOwnerRetryLimit = Math.min(
        Math.max(Number(queryParams?.limit || queryParams?.page_size || 20) || 20, 1) * 2,
        80,
      );
      for (let queryIndex = 1; queryIndex < semanticOwnerQueryPack.length; queryIndex += 1) {
        const remainingBudgetForSemanticOwner =
          typeof getFpmRemainingBudgetMs === 'function' ? getFpmRemainingBudgetMs() : 0;
        const allowRequiredSemanticOwnerRetry =
          queryIndex < semanticOwnerMinQueriesBeforeBudgetGuard &&
          (
            semanticOwnerTargetStepFamily === 'treatment' ||
            remainingBudgetForSemanticOwner >=
              (semanticOwnerIgnoredObservationCandidate ? 100 : 250)
          );
        if (
          FPM_GATE_SIMPLIFY_V1 &&
          remainingBudgetForSemanticOwner < FPM_LATENCY_GUARD_SECOND_STAGE_MIN_REMAINING_MS &&
          !allowRequiredSemanticOwnerRetry
        ) {
          semanticOwnerQueryAttempts.push({
            query: semanticOwnerQueryPack[queryIndex],
            query_index: queryIndex,
            query_total: semanticOwnerQueryTotal,
            result_count: 0,
            adopted: false,
            skipped_reason: 'budget_guard',
          });
          break;
        }
        const variantQueryParams = {
          ...queryParams,
          query: semanticOwnerQueryPack[queryIndex],
          query_index: queryIndex,
          query_total: semanticOwnerQueryTotal,
          offset: 0,
          limit: semanticOwnerRetryLimit,
        };
        const variantRequestBody = buildVariantRequestBody(
          requestBody,
          semanticOwnerQueryPack[queryIndex],
          queryIndex,
        );
        const variantQueryString =
          strictCommerceFindProductsMulti &&
          operation === 'find_products_multi' &&
          !strictBeautyDirectSearch
            ? ''
            : buildQueryString(variantQueryParams);
        const variantAxiosConfig = {
          ...axiosConfig,
          url: `${url}${variantQueryString}`,
          ...((strictBeautyDirectSearch ? 'GET' : routeMethod) !== 'GET' &&
          Object.keys(variantRequestBody || {}).length > 0
            ? { data: variantRequestBody }
            : {}),
        };
        let variantResponse = null;
        let variantUpstreamData = null;
        try {
          variantResponse = await callTrackedUpstream(operation, variantAxiosConfig);
          variantUpstreamData = normalizeUpstreamData({
            responseBody: variantResponse.data,
            queryParamsOverride: variantQueryParams,
            requestBodyOverride: variantRequestBody,
          });
        } catch (semanticOwnerRetryErr) {
          semanticOwnerQueryAttempts.push({
            query: semanticOwnerQueryPack[queryIndex],
            query_index: queryIndex,
            query_total: semanticOwnerQueryTotal,
            result_count: 0,
            adopted: false,
            error: String(semanticOwnerRetryErr?.message || semanticOwnerRetryErr),
          });
          continue;
        }
        const variantProducts = Array.isArray(variantUpstreamData?.products)
          ? variantUpstreamData.products
          : [];
        const variantAdoption = evaluateSemanticOwnerBeautyAdoption({
          upstreamData: variantUpstreamData,
          queryText: semanticOwnerQueryPack[queryIndex],
          queryParamsValue: variantQueryParams,
          requestBodyValue: variantRequestBody,
        });
        const shouldAdoptVariant =
          variantResponse?.status >= 200 &&
          variantResponse?.status < 300 &&
          variantProducts.length > 0 &&
          variantAdoption.adopt === true;
        const variantObservationFallback =
          semanticOwnerControlled &&
          !shouldAdoptVariant &&
          variantProducts.length > 0
            ? describeSemanticOwnerObservationFallback({
                upstreamData: variantUpstreamData,
                hitDecision: variantAdoption.hitDecision,
                queryText: semanticOwnerQueryPack[queryIndex],
              })
            : null;
        if (
          semanticOwnerControlled &&
          !shouldAdoptVariant &&
          variantProducts.length > 0
        ) {
          const fallbackCandidate = variantObservationFallback;
          if (fallbackCandidate.ignore) {
            semanticOwnerIgnoredObservationCandidate = true;
          }
          if (variantAdoption.last_resort_cache_candidate === true) {
            semanticOwnerDeferredLastResortCache = true;
          }
          if (
            !fallbackCandidate.ignore &&
            (
              !semanticOwnerObservationFallback ||
              fallbackCandidate.score > semanticOwnerObservationFallback.score
            )
          ) {
            semanticOwnerObservationFallback = {
              score: fallbackCandidate.score,
              response: variantResponse,
              upstreamData: variantUpstreamData,
              queryParams: variantQueryParams,
              requestBody: variantRequestBody,
              queryIndex,
              last_resort_cache_candidate:
                fallbackCandidate.last_resort_cache_candidate === true,
            };
          }
        }
        semanticOwnerQueryAttempts.push({
          query: semanticOwnerQueryPack[queryIndex],
          query_index: queryIndex,
          query_total: semanticOwnerQueryTotal,
          result_count: variantProducts.length,
          adopted: shouldAdoptVariant,
          ...(variantAdoption.hitDecision
            ? {
                hit_quality: variantAdoption.hitDecision.hit_quality || null,
                invalid_hit_reason:
                  variantAdoption.hitDecision.invalid_hit_reason || null,
                post_quality_result_count: Array.isArray(
                  variantAdoption.hitDecision.valid_products,
                )
                  ? variantAdoption.hitDecision.valid_products.length
                  : 0,
                last_resort_cache_candidate:
                  variantAdoption.last_resort_cache_candidate === true,
                observation_candidate_ignored:
                  variantObservationFallback?.ignore === true,
                observation_ignore_reason:
                  variantObservationFallback?.ignore_reason || null,
              }
            : {}),
        });
        if (shouldAdoptVariant) {
          semanticOwnerAdoptedByValidHit = true;
          response = variantResponse;
          upstreamData = variantUpstreamData;
          queryParams = variantQueryParams;
          requestBody = variantRequestBody;
          axiosConfig.url = variantAxiosConfig.url;
          if ((strictBeautyDirectSearch ? 'GET' : routeMethod) !== 'GET') {
            axiosConfig.data = variantRequestBody;
          } else if (Object.prototype.hasOwnProperty.call(axiosConfig, 'data')) {
            delete axiosConfig.data;
          }
          break;
        }
      }
    }

    if (
      shouldAttemptSemanticOwnerCoverageSupplement({
        operation,
        semanticOwnerControlled,
        semanticOwnerAdoptedByValidHit,
        currentAdoption: evaluateSemanticOwnerBeautyAdoption({
          upstreamData,
          queryText:
            String(queryParams?.query || '').trim() ||
            semanticOwnerQueryPack[0] ||
            rawUserQuery ||
            '',
          queryParamsValue: queryParams,
          requestBodyValue: requestBody,
        }),
        upstreamData,
        queryParams,
        semanticOwnerTargetStepFamily,
      }) &&
      semanticOwnerQueryPack.length > 0
    ) {
      const currentQueryText =
        String(queryParams?.query || '').trim() ||
        semanticOwnerQueryPack.find((query) => String(query || '').trim()) ||
        rawUserQuery ||
        '';
      const semanticOwnerCoverageSupplementQueries =
        buildSemanticOwnerExternalRescueQueryPack({
          ignoredAttempt: null,
          queryAttempts: semanticOwnerQueryAttempts,
          fallbackQuery: String(rawUserQuery || currentQueryText || '').trim(),
        });
      if (semanticOwnerCoverageSupplementQueries.length > 0) {
        semanticOwnerExternalRescueQueriesAttempted = Array.from(
          new Set([
            ...semanticOwnerExternalRescueQueriesAttempted,
            ...semanticOwnerCoverageSupplementQueries,
          ]),
        );
        const coverageQueryParams = {
          ...(queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
            ? queryParams
            : {}),
          allow_external_seed: true,
          allow_stale_cache: false,
          external_seed_strategy: 'unified_relevance',
          ...(semanticOwnerTargetStepFamily
            ? { target_step_family: semanticOwnerTargetStepFamily }
            : {}),
          ...(semanticOwnerSemanticFamily
            ? { semantic_family: semanticOwnerSemanticFamily }
            : {}),
          ...(semanticOwnerQueryStepStrength
            ? { query_step_strength: semanticOwnerQueryStepStrength }
            : {}),
        };
        const coveragePage = Math.max(
          1,
          Number(queryParams?.page || effectivePayload?.search?.page || 1) || 1,
        );
        const coverageLimit = Math.min(
          Math.max(Number(queryParams?.limit || queryParams?.page_size || 20) || 20, 1),
          SEARCH_LIMIT_MAX,
        );
        for (const semanticOwnerCoverageSupplementQuery of semanticOwnerCoverageSupplementQueries) {
          try {
            const externalCoverageSupplement = await fetchExternalSeedSupplementFromBackend({
              queryParams: {
                ...coverageQueryParams,
                query: semanticOwnerCoverageSupplementQuery,
              },
              checkoutToken,
              neededCount: coverageLimit,
              source: metadata?.source,
            });
            const coverageExternalProducts = Array.isArray(externalCoverageSupplement?.products)
              ? externalCoverageSupplement.products
              : [];
            const coveragePrimaryExternalProducts = filterSemanticOwnerCoverageExternalProducts(
              coverageExternalProducts,
              { targetStepFamily: semanticOwnerTargetStepFamily },
            );
            if (coveragePrimaryExternalProducts.length <= 0) continue;
            const externalCoverageTrusted =
              externalCoverageSupplement?.metadata?.applied === true &&
              coveragePrimaryExternalProducts.length >= 2 &&
              coveragePrimaryExternalProducts.every((product) =>
                isSemanticOwnerExternalSeedProduct(product),
              );
            const coverageQueryParamsApplied = {
              ...coverageQueryParams,
              query: semanticOwnerCoverageSupplementQuery,
            };
            const externalOnlyBody = normalizeAgentProductsListResponse(
              {
                status: 'success',
                success: true,
                products: coveragePrimaryExternalProducts,
                total: coveragePrimaryExternalProducts.length,
                page: coveragePage,
                page_size: coveragePrimaryExternalProducts.length,
                reply: null,
                metadata: {
                  query_source: 'agent_products_search',
                  source_breakdown: {
                    internal_count: 0,
                    external_seed_count: coveragePrimaryExternalProducts.length,
                    stale_cache_used: false,
                    strategy_applied: 'semantic_owner_external_coverage_supplement',
                  },
                },
              },
              {
                limit: coverageLimit,
                offset: 0,
              },
            );
            const externalOnlyUpstreamData = normalizeUpstreamData({
              responseBody: externalOnlyBody,
              queryParamsOverride: coverageQueryParamsApplied,
              requestBodyOverride: requestBody,
            });
            const externalCoverageAdoption = evaluateSemanticOwnerBeautyAdoption({
              upstreamData: externalOnlyUpstreamData,
              queryText: semanticOwnerCoverageSupplementQuery,
              queryParamsValue: coverageQueryParamsApplied,
              requestBodyValue: requestBody,
            });
            const externalCoverageHitQuality = String(
              externalCoverageAdoption?.hitDecision?.hit_quality || '',
            ).trim();
            const externalCoverageAccepted =
              externalCoverageAdoption.adopt === true ||
              (
                externalCoverageTrusted &&
                externalCoverageHitQuality !== 'invalid_hit'
              ) ||
              (
                externalCoverageTrusted &&
                externalCoverageAdoption?.hitDecision?.invalid_hit_reason ===
                  'invalid_hit_no_same_family_candidates'
              );
            if (!externalCoverageAccepted) continue;
            const primaryProducts = Array.isArray(upstreamData?.products)
              ? upstreamData.products
              : [];
            const preferExternalFirst = shouldPreferSemanticOwnerExternalCoverage({
              primaryProducts,
              externalProducts: coveragePrimaryExternalProducts,
              externalAdoption: externalCoverageAdoption,
              externalCoverageTrusted,
              targetStepFamily: semanticOwnerTargetStepFamily,
            });
            const mergedProducts = mergeSemanticOwnerProductPools(
              preferExternalFirst ? [] : primaryProducts,
              coveragePrimaryExternalProducts,
              {
                preferExternalFirst,
                limit: coverageLimit,
              },
            );
            const existingMetadata =
              upstreamData?.metadata &&
              typeof upstreamData.metadata === 'object' &&
              !Array.isArray(upstreamData.metadata)
                ? upstreamData.metadata
                : {};
            const coverageBody = normalizeAgentProductsListResponse(
              {
                ...(upstreamData && typeof upstreamData === 'object' && !Array.isArray(upstreamData)
                  ? upstreamData
                  : {}),
                status: 'success',
                success: true,
                products: mergedProducts,
                total: Math.max(
                  Number(upstreamData?.total || 0) || 0,
                  mergedProducts.length,
                ),
                page: coveragePage,
                page_size: mergedProducts.length,
                reply: null,
                metadata: {
                  ...existingMetadata,
                  query_source: 'agent_products_search_external_seed_coverage_supplemented',
                  semantic_owner_external_coverage_supplement_applied: true,
                  semantic_owner_external_coverage_supplement_query:
                    semanticOwnerCoverageSupplementQuery,
                  semantic_owner_external_coverage_supplement_queries_attempted:
                    semanticOwnerCoverageSupplementQueries,
                  semantic_owner_external_coverage_supplement_mode:
                    preferExternalFirst ? 'external_replaced_sparse_internal' : 'merged',
                  semantic_owner_external_coverage_supplement_filtered_count:
                    Math.max(0, coverageExternalProducts.length - coveragePrimaryExternalProducts.length),
                  external_seed_rows_fetched: Math.max(
                    coverageExternalProducts.length,
                    Number(externalCoverageSupplement?.metadata?.external_seed_rows_raw || 0) || 0,
                  ),
                  external_seed_rows_built: coveragePrimaryExternalProducts.length,
                  external_seed_returned_count: coveragePrimaryExternalProducts.length,
                  source_breakdown: {
                    ...(existingMetadata.source_breakdown &&
                    typeof existingMetadata.source_breakdown === 'object' &&
                    !Array.isArray(existingMetadata.source_breakdown)
                      ? existingMetadata.source_breakdown
                      : {}),
                    internal_count: preferExternalFirst ? 0 : primaryProducts.length,
                    external_seed_count: coveragePrimaryExternalProducts.length,
                    stale_cache_used: false,
                    strategy_applied: 'semantic_owner_external_coverage_supplement',
                  },
                },
              },
              {
                limit: coverageLimit,
                offset: 0,
              },
            );
            response = { status: 200, data: coverageBody };
            upstreamData = normalizeUpstreamData({
              responseBody: coverageBody,
              queryParamsOverride: {
                ...queryParams,
                allow_external_seed: true,
                external_seed_strategy: 'unified_relevance',
              },
              requestBodyOverride: requestBody,
            });
            const adoptedAttempt = [...semanticOwnerQueryAttempts]
              .reverse()
              .find((attempt) => attempt && attempt.adopted === true);
            if (adoptedAttempt) {
              adoptedAttempt.coverage_supplemented = true;
              adoptedAttempt.external_seed_supplement_count = coveragePrimaryExternalProducts.length;
              adoptedAttempt.coverage_supplement_query = semanticOwnerCoverageSupplementQuery;
              adoptedAttempt.adoption_mode = preferExternalFirst
                ? 'external_seed_coverage_replaced_sparse_internal'
                : 'external_seed_coverage_supplemented';
              adoptedAttempt.external_seed_supplement_filtered_count =
                Math.max(0, coverageExternalProducts.length - coveragePrimaryExternalProducts.length);
            }
            break;
          } catch (semanticOwnerCoverageSupplementErr) {
            logger?.warn(
              {
                err:
                  semanticOwnerCoverageSupplementErr?.message ||
                  String(semanticOwnerCoverageSupplementErr),
                query: semanticOwnerCoverageSupplementQuery,
              },
              'semantic-owner external coverage supplement failed after sparse valid hit',
            );
          }
        }
      }
    }

    if (
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      !semanticOwnerAdoptedByValidHit &&
      (
        semanticOwnerIgnoredObservationCandidate ||
        semanticOwnerDeferredLastResortCache ||
        semanticOwnerQueryAttempts.every(
          (attempt) =>
            attempt &&
            !attempt.adopted &&
            !attempt.skipped_reason &&
            !attempt.error &&
            Number(attempt.result_count || 0) <= 0,
        )
      ) &&
      semanticOwnerQueryPack.length > 0
    ) {
      const semanticOwnerExternalRescueAttempt = [...semanticOwnerQueryAttempts]
        .reverse()
        .find(
          (attempt) =>
            attempt &&
            (
              attempt.observation_candidate_ignored === true ||
              attempt.last_resort_cache_candidate === true
            ) &&
            String(attempt.query || '').trim(),
        );
      const semanticOwnerExternalRescueQueries =
        buildSemanticOwnerExternalRescueQueryPack({
          ignoredAttempt: semanticOwnerExternalRescueAttempt,
          queryAttempts: semanticOwnerQueryAttempts,
          fallbackQuery: String(
            queryParams?.query ||
              semanticOwnerQueryPack[semanticOwnerQueryPack.length - 1] ||
              rawUserQuery ||
              '',
          ).trim(),
        });
      if (semanticOwnerExternalRescueQueries.length > 0) {
        semanticOwnerExternalRescueQueriesAttempted = semanticOwnerExternalRescueQueries;
        const rescueQueryParams = {
          ...(queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
            ? queryParams
            : {}),
          allow_external_seed: true,
          allow_stale_cache: false,
          external_seed_strategy: 'unified_relevance',
          ...(semanticOwnerTargetStepFamily
            ? { target_step_family: semanticOwnerTargetStepFamily }
            : {}),
          ...(semanticOwnerSemanticFamily
            ? { semantic_family: semanticOwnerSemanticFamily }
            : {}),
          ...(semanticOwnerQueryStepStrength
            ? { query_step_strength: semanticOwnerQueryStepStrength }
            : {}),
        };
        const semanticOwnerExternalRescuePage = Math.max(
          1,
          Number(queryParams?.page || effectivePayload?.search?.page || 1) || 1,
        );
        const rescueLimit = Math.min(
          Math.max(Number(queryParams?.limit || queryParams?.page_size || 20) || 20, 1),
          SEARCH_LIMIT_MAX,
        );
        let semanticOwnerExternalRescueApplied = false;
        for (const semanticOwnerExternalRescueQuery of semanticOwnerExternalRescueQueries) {
          try {
            const externalRescue = await fetchExternalSeedSupplementFromBackend({
              queryParams: {
                ...rescueQueryParams,
                query: semanticOwnerExternalRescueQuery,
              },
              checkoutToken,
              neededCount: rescueLimit,
              source: metadata?.source,
            });
            const rescueProducts = Array.isArray(externalRescue?.products)
              ? externalRescue.products
              : [];
            if (rescueProducts.length > 0) {
              const rescueBody = normalizeAgentProductsListResponse(
                {
                  status: 'success',
                  success: true,
                  products: rescueProducts,
                  total: rescueProducts.length,
                  page: semanticOwnerExternalRescuePage,
                  page_size: rescueProducts.length,
                  reply: null,
                  metadata: {
                    query_source: 'agent_products_search',
                    semantic_owner_external_rescue_applied: true,
                    semantic_owner_external_rescue_query:
                      semanticOwnerExternalRescueQuery,
                    semantic_owner_external_rescue_queries_attempted:
                      semanticOwnerExternalRescueQueries,
                    external_seed_rows_fetched: Math.max(
                      rescueProducts.length,
                      Number(externalRescue?.metadata?.external_seed_rows_raw || 0) || 0,
                    ),
                    external_seed_rows_built: rescueProducts.length,
                    external_seed_returned_count: rescueProducts.length,
                    source_breakdown: {
                      internal_count: 0,
                      external_seed_count: rescueProducts.length,
                      stale_cache_used: false,
                      strategy_applied: 'semantic_owner_external_rescue',
                    },
                  },
                },
                {
                  limit: rescueLimit,
                  offset: 0,
                },
              );
              const rescueResponse = { status: 200, data: rescueBody };
              const rescueQueryParamsApplied = {
                ...rescueQueryParams,
                query: semanticOwnerExternalRescueQuery,
              };
              const rescueUpstreamData = normalizeUpstreamData({
                responseBody: rescueBody,
                queryParamsOverride: rescueQueryParamsApplied,
                requestBodyOverride: requestBody,
              });
              const rescueAdoption = evaluateSemanticOwnerBeautyAdoption({
                upstreamData: rescueUpstreamData,
                queryText: semanticOwnerExternalRescueQuery,
                queryParamsValue: rescueQueryParamsApplied,
                requestBodyValue: requestBody,
              });
              const rescueObservation = describeSemanticOwnerObservationFallback({
                upstreamData: rescueUpstreamData,
                hitDecision: rescueAdoption.hitDecision,
                queryText: semanticOwnerExternalRescueQuery,
              });
              const shouldPreferDeferredLastResortCache =
                semanticOwnerObservationFallback?.last_resort_cache_candidate === true &&
                Number(semanticOwnerObservationFallback?.score || -1) >=
                  Number(rescueObservation?.score || -1);
              if (shouldPreferDeferredLastResortCache) {
                continue;
              }
              response = rescueResponse;
              upstreamData = rescueUpstreamData;
              queryParams = rescueQueryParamsApplied;
              const chosenAttempt = semanticOwnerQueryAttempts.find(
                (attempt) =>
                  attempt &&
                  String(attempt.query || '').trim() ===
                    semanticOwnerExternalRescueQuery &&
                  !attempt.skipped_reason &&
                  !attempt.error,
              );
              if (chosenAttempt && chosenAttempt.adopted !== true) {
                chosenAttempt.adopted = true;
                chosenAttempt.adoption_mode = 'external_seed_rescue';
              } else if (!chosenAttempt) {
                const matchedQueryIndex = semanticOwnerQueryPack.findIndex(
                  (query) =>
                    String(query || '').trim() === semanticOwnerExternalRescueQuery,
                );
                semanticOwnerQueryAttempts.push({
                  query: semanticOwnerExternalRescueQuery,
                  query_index:
                    matchedQueryIndex >= 0
                      ? matchedQueryIndex
                      : semanticOwnerQueryAttempts.length,
                  query_total: semanticOwnerQueryTotal,
                  result_count: rescueProducts.length,
                  adopted: true,
                  adoption_mode: 'external_seed_rescue',
                  rescue_only: true,
                });
              }
              semanticOwnerAdoptedByValidHit = true;
              semanticOwnerObservationFallback = null;
              semanticOwnerExternalRescueApplied = true;
              break;
            }
          } catch (semanticOwnerExternalRescueErr) {
            logger?.warn(
              {
                err:
                  semanticOwnerExternalRescueErr?.message ||
                  String(semanticOwnerExternalRescueErr),
                query: semanticOwnerExternalRescueQuery,
              },
              'semantic-owner external rescue failed after pure cache invalid query pack',
            );
          }
        }
        if (!semanticOwnerExternalRescueApplied && !semanticOwnerObservationFallback) {
          semanticOwnerCacheSourceIsolated = true;
          semanticOwnerCacheSourceIsolationReason = 'pure_cache_invalid_hit';
          const isolatedBody = normalizeAgentProductsListResponse(
            {
              status: 'success',
              success: true,
              products: [],
              total: 0,
              page: semanticOwnerExternalRescuePage,
              page_size: 0,
              reply: null,
              metadata: {
                query_source: 'agent_products_recall_clarify',
                semantic_owner_cache_source_isolated: true,
                semantic_owner_cache_source_isolation_reason: 'pure_cache_invalid_hit',
                semantic_owner_external_rescue_queries_attempted:
                  semanticOwnerExternalRescueQueries,
                source_breakdown: {
                  internal_count: 0,
                  external_seed_count: 0,
                  stale_cache_used: false,
                  strategy_applied: 'semantic_owner_cache_source_isolated',
                },
              },
            },
            {
              limit: rescueLimit,
              offset: 0,
            },
          );
          response = { status: 200, data: isolatedBody };
          upstreamData = normalizeUpstreamData({
            responseBody: isolatedBody,
            queryParamsOverride: rescueQueryParams,
            requestBodyOverride: requestBody,
          });
          queryParams = rescueQueryParams;
        }
      }
    }

    if (
      operation === 'find_products_multi' &&
      semanticOwnerControlled &&
      !semanticOwnerAdoptedByValidHit &&
      semanticOwnerObservationFallback &&
      Array.isArray(semanticOwnerObservationFallback.upstreamData?.products) &&
      semanticOwnerObservationFallback.upstreamData.products.length > 0
    ) {
      response = semanticOwnerObservationFallback.response;
      upstreamData = semanticOwnerObservationFallback.upstreamData;
      queryParams = semanticOwnerObservationFallback.queryParams;
      requestBody = semanticOwnerObservationFallback.requestBody;
      const chosenAttempt =
        semanticOwnerQueryAttempts[semanticOwnerObservationFallback.queryIndex];
      if (chosenAttempt && chosenAttempt.adopted !== true) {
        chosenAttempt.adopted = true;
        chosenAttempt.adoption_mode =
          semanticOwnerObservationFallback.last_resort_cache_candidate === true
            ? 'last_resort_cache'
            : 'observation_only';
      }
      if (semanticOwnerObservationFallback.last_resort_cache_candidate === true) {
        semanticOwnerLastResortCacheApplied = true;
        semanticOwnerLastResortCacheQuery =
          String(queryParams?.query || '').trim() || null;
      }
    }

    return {
      response,
      upstreamData,
      queryParams,
      requestBody,
      axiosConfig,
      semanticOwnerQueryAttempts,
      semanticOwnerExternalRescueQueriesAttempted,
      semanticOwnerCacheSourceIsolated,
      semanticOwnerCacheSourceIsolationReason,
      semanticOwnerLastResortCacheApplied,
      semanticOwnerLastResortCacheQuery,
    };
  }

  return {
    runInvokeSemanticOwnerExecution,
  };
}

module.exports = {
  createFindProductsInvokeSemanticOwnerExecutionRuntime,
  __internal: {
    isSemanticOwnerBundleLikeProduct,
    isSemanticOwnerEligiblePrimaryExternalProduct,
    filterSemanticOwnerCoverageExternalProducts,
    shouldPreferSemanticOwnerExternalCoverage,
  },
};
