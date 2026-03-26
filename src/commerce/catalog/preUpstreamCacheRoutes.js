const {
  getActivePromotions: getActivePromotionsBase,
  applyDealsToResponse: applyDealsToResponseBase,
} = require('../promotions');

function buildCacheResponseBody({
  products,
  total,
  page,
  pageSize,
  metadata,
}) {
  return {
    products,
    total,
    page,
    page_size: pageSize,
    reply: null,
    metadata,
  };
}

async function maybeHandleFindProductsMultiCachePrelude({
  metadata,
  effectivePayload,
  effectiveIntent,
  policyMetadata,
  rawUserQuery,
  now,
  creatorId,
  hasDatabase,
  routeDebugEnabled,
  creatorCacheShortCircuitEnabled,
  findProductsMultiVectorEnabled,
  detectBrandEntities,
  isCreatorUiSource,
  loadCreatorSellableFromCache,
  searchCreatorSellableFromCache,
  probeCreatorCacheDbStats,
  loadCrossMerchantBrowseFromCache,
  applyFindProductsMultiPolicy,
  getActivePromotions = getActivePromotionsBase,
  applyDealsToResponse = applyDealsToResponseBase,
  uniqueStrings,
  logger,
} = {}) {
  let creatorCacheRouteDebug = null;
  let crossMerchantCacheRouteDebug = null;

  if (!hasDatabase) {
    return {
      handled: false,
      creatorCacheRouteDebug,
      crossMerchantCacheRouteDebug,
    };
  }

  const source = metadata?.source;
  const search =
    effectivePayload && typeof effectivePayload === 'object'
      ? effectivePayload.search || effectivePayload
      : {};
  const queryText = String(search.query || '').trim();
  const inStockOnly = search.in_stock_only !== false;
  const isCreatorUi = Boolean(
    typeof isCreatorUiSource === 'function' && isCreatorUiSource(source),
  );
  const isCreatorUiColdStart = isCreatorUi && queryText.length === 0;
  const creatorBrandLikeQuery =
    isCreatorUi && queryText.length > 0
      ? Boolean(detectBrandEntities(queryText, { candidateProducts: [] })?.brand_like)
      : false;
  const creatorCacheCanShortCircuit =
    creatorCacheShortCircuitEnabled && !creatorBrandLikeQuery;

  if (isCreatorUiColdStart) {
    try {
      const page = search.page || 1;
      const limit = search.limit || 20;
      const fromCache = await loadCreatorSellableFromCache(creatorId, page, limit, { inStockOnly });
      const cacheHit = Array.isArray(fromCache.products) && fromCache.products.length > 0;
      creatorCacheRouteDebug = {
        attempted: true,
        mode: 'featured',
        creator_id: creatorId,
        page,
        limit,
        in_stock_only: inStockOnly,
        products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
        total: Number(fromCache.total || 0),
        cache_hit: cacheHit,
      };

      const upstreamData = buildCacheResponseBody({
        products: fromCache.products,
        total: fromCache.total,
        page: fromCache.page,
        pageSize: fromCache.page_size,
        metadata: {
          query_source: 'cache_creator_featured',
          fetched_at: new Date().toISOString(),
          merchants_searched: fromCache.merchantIds.length,
          ...(routeDebugEnabled
            ? {
                route_debug: {
                  creator_cache: {
                    attempted: true,
                    mode: 'featured',
                    creator_id: creatorId,
                    page,
                    limit,
                    in_stock_only: inStockOnly,
                    cache_hit: cacheHit,
                  },
                },
              }
            : {}),
          ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
          ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
        },
      });

      const promotions = await getActivePromotions(now, creatorId);
      const enriched = applyDealsToResponse(upstreamData, promotions, now, creatorId);
      if (cacheHit && creatorCacheCanShortCircuit) {
        return {
          handled: true,
          body: enriched,
          creatorCacheRouteDebug,
          crossMerchantCacheRouteDebug,
        };
      }
      logger.info(
        { creatorId, source, page, limit, inStockOnly },
        'Creator UI cache cold-start returned empty; falling back to upstream',
      );
    } catch (err) {
      logger.warn(
        { err: err.message, creatorId, source },
        'Creator UI cache cold-start failed; falling back to upstream',
      );
    }
  }

  if (isCreatorUi && queryText.length > 0) {
    try {
      const page = search.page || 1;
      const limit = search.limit || 20;
      const intentTarget = String(effectiveIntent?.target_object?.type || '').toLowerCase();
      const fromCache = await searchCreatorSellableFromCache(creatorId, queryText, page, limit, {
        intent: effectiveIntent,
        inStockOnly,
      });

      creatorCacheRouteDebug = {
        attempted: true,
        mode: 'search',
        creator_id: creatorId,
        query: queryText,
        page,
        limit,
        products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
        total: Number(fromCache.total || 0),
        retrieval_sources: fromCache.retrieval_sources || null,
        vector_enabled: findProductsMultiVectorEnabled,
        intent_language: effectiveIntent?.language || null,
        intent_target: effectiveIntent?.target_object?.type || null,
        db_stats: await probeCreatorCacheDbStats(
          Array.isArray(fromCache.merchantIds) ? fromCache.merchantIds : [],
          intentTarget,
        ),
      };

      if (Array.isArray(fromCache.products) && fromCache.products.length > 0 && creatorCacheCanShortCircuit) {
        const upstreamData = buildCacheResponseBody({
          products: fromCache.products,
          total: fromCache.total,
          page: fromCache.page,
          pageSize: fromCache.page_size,
          metadata: {
            query_source: 'cache_creator_search',
            fetched_at: new Date().toISOString(),
            merchants_searched: fromCache.merchantIds.length,
            ...(fromCache.retrieval_sources ? { retrieval_sources: fromCache.retrieval_sources } : {}),
            ...(routeDebugEnabled ? { route_debug: { creator_cache: creatorCacheRouteDebug } } : {}),
            ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
            ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
          },
        });

        const withPolicy = effectiveIntent
          ? applyFindProductsMultiPolicy({
              response: upstreamData,
              intent: effectiveIntent,
              requestPayload: effectivePayload,
              metadata: policyMetadata,
              rawUserQuery,
            })
          : upstreamData;

        const promotions = await getActivePromotions(now, creatorId);
        const enriched = applyDealsToResponse(withPolicy, promotions, now, creatorId);
        return {
          handled: true,
          body: enriched,
          creatorCacheRouteDebug,
          crossMerchantCacheRouteDebug,
        };
      }
    } catch (err) {
      creatorCacheRouteDebug = {
        attempted: true,
        mode: 'search',
        creator_id: creatorId,
        query: queryText,
        error: String(err && err.message ? err.message : err),
        vector_enabled: findProductsMultiVectorEnabled,
        intent_language: effectiveIntent?.language || null,
        intent_target: effectiveIntent?.target_object?.type || null,
      };
      logger.warn(
        { err: err.message, creatorId, source, queryText },
        'Creator UI cache search failed; falling back to upstream',
      );
    }
  }

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
  const isCrossMerchantBrowseColdStart =
    !isCreatorUi && queryText.length === 0 && !hasMerchantScope;

  if (isCrossMerchantBrowseColdStart) {
    try {
      const page = search.page || 1;
      const limit = search.limit || search.page_size || 20;
      const fromCache = await loadCrossMerchantBrowseFromCache(page, limit, { inStockOnly });
      const cacheHit = Array.isArray(fromCache.products) && fromCache.products.length > 0;
      crossMerchantCacheRouteDebug = {
        attempted: true,
        mode: 'browse',
        page,
        limit,
        in_stock_only: inStockOnly,
        cache_hit: cacheHit,
        products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
        total: Number(fromCache.total || 0),
      };
      const merchantsReturned = uniqueStrings(
        (fromCache.products || []).map((product) => product?.merchant_id || product?.merchantId),
      );

      const upstreamData = buildCacheResponseBody({
        products: fromCache.products,
        total: fromCache.total,
        page: fromCache.page,
        pageSize: fromCache.page_size,
        metadata: {
          query_source: 'cache_cross_merchant_browse',
          fetched_at: new Date().toISOString(),
          merchants_searched: merchantsReturned.length,
          ...(routeDebugEnabled
            ? {
                route_debug: {
                  cross_merchant_cache: crossMerchantCacheRouteDebug,
                },
              }
            : {}),
        },
      });

      const promotions = await getActivePromotions(now, creatorId);
      const enriched = applyDealsToResponse(upstreamData, promotions, now, creatorId);
      if (cacheHit) {
        return {
          handled: true,
          body: enriched,
          creatorCacheRouteDebug,
          crossMerchantCacheRouteDebug,
        };
      }
      logger.info(
        { source, page, limit, inStockOnly },
        'Cross-merchant cache browse returned empty; falling back to upstream',
      );
    } catch (err) {
      crossMerchantCacheRouteDebug = {
        attempted: true,
        mode: 'browse',
        page: search.page || 1,
        limit: search.limit || search.page_size || 20,
        in_stock_only: inStockOnly,
        cache_hit: false,
        error: String(err && err.message ? err.message : err),
      };
      logger.warn(
        { err: err.message, source },
        'Cross-merchant cache browse failed; falling back to upstream',
      );
    }
  }

  return {
    handled: false,
    creatorCacheRouteDebug,
    crossMerchantCacheRouteDebug,
  };
}

async function maybeHandleFindProductsCachePrelude({
  metadata,
  effectivePayload,
  now,
  creatorId,
  hasDatabase,
  routeDebugEnabled,
  searchLimitMax,
  loadMerchantBrowseFromCache,
  getActivePromotions = getActivePromotionsBase,
  applyDealsToResponse = applyDealsToResponseBase,
  logger,
} = {}) {
  if (!hasDatabase) {
    return { handled: false };
  }

  const source = metadata?.source;
  const search =
    effectivePayload && typeof effectivePayload === 'object'
      ? effectivePayload.search || effectivePayload
      : {};
  const queryText = String(search.query || '').trim();
  const merchantId = String(search.merchant_id || search.merchantId || '').trim();
  const inStockOnly = search.in_stock_only !== false;
  const isBrowse = queryText.length === 0;

  if (!isBrowse || !merchantId) {
    return { handled: false };
  }

  try {
    const page = Math.max(1, Number(search.page || 1) || 1);
    const limit = Math.min(
      Math.max(1, Number(search.page_size || search.limit || 20) || 20),
      searchLimitMax,
    );
    const fromCache = await loadMerchantBrowseFromCache(merchantId, page, limit, { inStockOnly });
    const cacheHit = Array.isArray(fromCache.products) && fromCache.products.length > 0;

    const upstreamData = buildCacheResponseBody({
      products: fromCache.products,
      total: fromCache.total,
      page: fromCache.page,
      pageSize: fromCache.page_size,
      metadata: {
        query_source: 'cache_merchant_browse',
        fetched_at: new Date().toISOString(),
        merchant_id: merchantId,
        ...(source ? { source } : {}),
        ...(routeDebugEnabled
          ? {
              route_debug: {
                merchant_cache: {
                  attempted: true,
                  mode: 'browse',
                  merchant_id: merchantId,
                  page,
                  limit,
                  in_stock_only: inStockOnly,
                  cache_hit: cacheHit,
                },
              },
            }
          : {}),
      },
    });

    const promotions = await getActivePromotions(now, creatorId);
    const enriched = applyDealsToResponse(upstreamData, promotions, now, creatorId);
    if (cacheHit) {
      return { handled: true, body: enriched };
    }
    logger.info(
      { source, merchantId, page, limit, inStockOnly },
      'Merchant cache browse returned empty; falling back to upstream',
    );
  } catch (err) {
    logger.warn(
      { err: err.message, source, merchantId },
      'Merchant cache browse failed; falling back to upstream',
    );
  }

  return { handled: false };
}

module.exports = {
  maybeHandleFindProductsMultiCachePrelude,
  maybeHandleFindProductsCachePrelude,
};
