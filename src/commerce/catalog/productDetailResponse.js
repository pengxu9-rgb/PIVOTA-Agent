const {
  shouldIncludePdp: shouldIncludePdpBase,
  getPdpOptions: getPdpOptionsBase,
} = require('../pdp/options');
const {
  buildPdpPayload: buildPdpPayloadBase,
  recommendPdpProducts: recommendPdpProductsBase,
} = require('../pdp/runtime');
const {
  productDetailCacheEnabled: productDetailCacheEnabledBase,
  productDetailCacheTtlMs: productDetailCacheTtlMsBase,
  productDetailStaleMaxAgeHours: productDetailStaleMaxAgeHoursBase,
  productDetailCacheMetrics: productDetailCacheMetricsBase,
  getProductDetailCacheEntry: getProductDetailCacheEntryBase,
  fetchProductDetailFromProductsCache: fetchProductDetailFromProductsCacheBase,
  setProductDetailCache: setProductDetailCacheBase,
} = require('./productDetailAdapters');

function safeCloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

async function maybeLoadInvokeProductDetailResponse({
  operation,
  productDetailCacheKey,
  productDetailMerchantId,
  productDetailProductId,
  productDetailBypassCache,
  productDetailCacheEnabled = productDetailCacheEnabledBase,
  productDetailCacheTtlMs = productDetailCacheTtlMsBase,
  productDetailStaleMaxAgeHours = productDetailStaleMaxAgeHoursBase,
  hasDatabase,
  metrics = productDetailCacheMetricsBase,
  getProductDetailCacheEntry = getProductDetailCacheEntryBase,
  safeCloneJson: cloneJson = safeCloneJson,
  fetchProductDetailFromProductsCache = fetchProductDetailFromProductsCacheBase,
} = {}) {
  if (operation !== 'get_product_detail' || !productDetailCacheKey) {
    return {
      handled: false,
      response: null,
      productDetailCacheMeta: null,
    };
  }

  if (productDetailCacheEnabled && !productDetailBypassCache) {
    const cachedEntry = getProductDetailCacheEntry(productDetailCacheKey);
    if (cachedEntry?.value) {
      const ageMs =
        typeof cachedEntry.storedAtMs === 'number'
          ? Math.max(0, Date.now() - cachedEntry.storedAtMs)
          : 0;
      return {
        handled: true,
        response: { status: 200, data: cloneJson(cachedEntry.value) },
        productDetailCacheMeta: {
          hit: true,
          source: 'memory',
          age_ms: ageMs,
          ttl_ms: productDetailCacheTtlMs,
        },
      };
    }

    if (hasDatabase) {
      const fromDb = await fetchProductDetailFromProductsCache({
        merchantId: productDetailMerchantId,
        productId: productDetailProductId,
        includeExpired: true,
        staleMaxAgeHours: productDetailStaleMaxAgeHours,
      });
      if (fromDb?.product) {
        if (metrics && typeof metrics === 'object') {
          metrics.db_hits = Math.max(0, Number(metrics.db_hits || 0)) + 1;
        }
        return {
          handled: true,
          response: {
            status: 200,
            data: {
              status: 'success',
              success: true,
              product: fromDb.product,
              metadata: {
                query_source: 'products_cache',
                cached_at: fromDb.cached_at || null,
              },
            },
          },
          productDetailCacheMeta: {
            hit: true,
            source: 'products_cache',
            age_ms: 0,
            ttl_ms: productDetailCacheTtlMs,
          },
        };
      }
    }
  } else if (productDetailBypassCache && metrics && typeof metrics === 'object') {
    metrics.bypasses = Math.max(0, Number(metrics.bypasses || 0)) + 1;
  }

  return {
    handled: false,
    response: null,
    productDetailCacheMeta: null,
  };
}

function getProductDetailResponseProduct(upstreamData) {
  if (!upstreamData || typeof upstreamData !== 'object') return null;
  return upstreamData.product || upstreamData?.data?.product || null;
}

function shouldBypassCache(payload) {
  return (
    payload?.options?.no_cache === true ||
    payload?.options?.cache_bypass === true ||
    payload?.options?.bypass_cache === true
  );
}

async function finalizeInvokeProductDetailResponse({
  operation,
  upstreamData,
  responseStatus,
  payload,
  productDetailCacheKey,
  productDetailCacheMeta,
  productDetailDebug,
  productDetailBypassCache,
  productDetailCacheEnabled = productDetailCacheEnabledBase,
  normalizeAgentProductDetailResponse,
  setProductDetailCache = setProductDetailCacheBase,
  shouldIncludePdp = shouldIncludePdpBase,
  getPdpOptions = getPdpOptionsBase,
  recommendPdpProducts = recommendPdpProductsBase,
  buildPdpPayload = buildPdpPayloadBase,
  logger,
} = {}) {
  if (operation !== 'get_product_detail') {
    return upstreamData;
  }

  let finalized = normalizeAgentProductDetailResponse(upstreamData);

  if (
    productDetailCacheKey &&
    productDetailCacheEnabled &&
    !productDetailBypassCache &&
    finalized &&
    typeof finalized === 'object' &&
    !Array.isArray(finalized)
  ) {
    const shouldCache =
      responseStatus === 200 &&
      Boolean(getProductDetailResponseProduct(finalized));
    if (
      shouldCache &&
      (!productDetailCacheMeta || productDetailCacheMeta.source !== 'memory')
    ) {
      setProductDetailCache(productDetailCacheKey, finalized);
    }
  }

  if (productDetailDebug && productDetailCacheMeta) {
    finalized = {
      ...finalized,
      cache: productDetailCacheMeta,
    };
  }

  if (shouldIncludePdp(payload)) {
    const product = getProductDetailResponseProduct(finalized);
    if (product) {
      const pdpOptions = getPdpOptions(payload);
      let relatedProducts = [];
      if (pdpOptions.includeRecommendations) {
        const bypassCache = shouldBypassCache(payload);
        try {
          const rec = await recommendPdpProducts({
            pdp_product: product,
            k: payload?.recommendations?.limit || 6,
            locale:
              payload?.context?.locale ||
              payload?.context?.language ||
              payload?.locale ||
              'en-US',
            currency: product.currency || 'USD',
            options: {
              debug: pdpOptions.debug,
              no_cache: bypassCache,
              cache_bypass: bypassCache,
              bypass_cache: bypassCache,
            },
          });
          relatedProducts = Array.isArray(rec?.items) ? rec.items : [];
        } catch (err) {
          logger.warn(
            {
              err: err?.message || String(err),
              merchant_id: product.merchant_id,
              product_id: product.product_id,
            },
            'PDP recommendations failed (get_product_detail include=pdp); continuing without recommendations module',
          );
          relatedProducts = [];
        }
      }

      finalized = {
        ...finalized,
        pdp_payload: buildPdpPayload({
          product,
          relatedProducts,
          entryPoint: pdpOptions.entryPoint,
          experiment: pdpOptions.experiment,
          templateHint: pdpOptions.templateHint,
          includeEmptyReviews: pdpOptions.includeEmptyReviews,
          debug: pdpOptions.debug,
        }),
      };
    }
  }

  return finalized;
}

module.exports = {
  maybeLoadInvokeProductDetailResponse,
  finalizeInvokeProductDetailResponse,
};
