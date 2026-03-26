const {
  fetchProductDetailFromProductsCache: fetchProductDetailFromProductsCacheBase,
  fetchProductDetailFromUpstream: fetchProductDetailFromUpstreamBase,
  productDetailStaleMaxAgeHours: productDetailStaleMaxAgeHoursBase,
} = require('./productDetailAdapters');

function buildResolvedSearchMetadata({ queryText, resolved, resolvedQueryUsed, detailSource }) {
  return {
    query_source: 'agent_products_resolver_fallback',
    resolve_reason: resolved?.reason || null,
    resolve_reason_code:
      resolved?.reason_code ||
      resolved?.metadata?.resolve_reason_code ||
      null,
    resolve_confidence:
      Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
    resolve_latency_ms:
      Number.isFinite(Number(resolved?.metadata?.latency_ms))
        ? Number(resolved.metadata.latency_ms)
        : null,
    resolve_query_used: resolvedQueryUsed || queryText,
    ...(detailSource ? { resolve_detail_source: detailSource } : {}),
  };
}

function buildResolverReferenceOnlyResult({
  queryText,
  resolved,
  resolvedQueryUsed,
  resolvedMerchantId,
  resolvedProductId,
  resolveSources,
  reason,
  normalizeAgentProductsListResponse,
  countUsableSearchProducts,
  withProxySearchFallbackMetadata,
} = {}) {
  const candidateTitle = Array.isArray(resolved?.candidates)
    ? String(resolved.candidates?.[0]?.title || '').trim()
    : '';
  const resolvedTitle = String(
    candidateTitle ||
      resolved?.title ||
      resolved?.alias ||
      resolvedQueryUsed ||
      queryText,
  ).trim();
  const productRow = {
    id: resolvedProductId,
    product_id: resolvedProductId,
    merchant_id: resolvedMerchantId,
    platform_product_id: resolvedProductId,
    ...(resolvedTitle ? { title: resolvedTitle, name: resolvedTitle } : {}),
    canonical_product_ref: {
      merchant_id: resolvedMerchantId,
      product_id: resolvedProductId,
    },
  };

  const normalized = normalizeAgentProductsListResponse({
    status: 'success',
    success: true,
    products: [productRow],
    total: 1,
    page: 1,
    page_size: 1,
    metadata: {
      query_source: 'agent_products_resolver_ref_fallback',
      resolve_reason: resolved?.reason || null,
      resolve_reason_code:
        resolved?.reason_code ||
        resolved?.metadata?.resolve_reason_code ||
        'detail_unavailable_ref_only',
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms))
          ? Number(resolved.metadata.latency_ms)
          : null,
      resolve_query_used: resolvedQueryUsed || queryText,
      resolve_detail_source: 'reference_only',
    },
  });

  return {
    status: 200,
    usableCount: countUsableSearchProducts(normalized?.products),
    resolved: true,
    resolve_reason: resolved?.reason || null,
    resolve_reason_code:
      resolved?.reason_code ||
      resolved?.metadata?.resolve_reason_code ||
      'detail_unavailable_ref_only',
    resolve_confidence:
      Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
    resolve_latency_ms:
      Number.isFinite(Number(resolved?.metadata?.latency_ms))
        ? Number(resolved.metadata.latency_ms)
        : null,
    resolve_sources: resolveSources,
    resolve_query_used: resolvedQueryUsed || queryText,
    data: withProxySearchFallbackMetadata(normalized, {
      applied: true,
      reason: reason || 'resolver_ref_only',
    }),
  };
}

async function finalizeResolveSearchFallbackResult({
  queryText,
  resolved,
  resolvedQueryUsed,
  resolvedMerchantId,
  resolvedProductId,
  resolveSources,
  reason,
  resolverCacheKey,
  resolverMissCacheTtlMs,
  resolverCacheTtlMs,
  fetchDetail = true,
  resolverDetailEnabled = true,
  resolverDetailTimeoutMs,
  checkoutToken,
  setProxySearchResolverCacheEntry,
  isLookupStyleSearchQuery,
  extractSearchAnchorTokens,
  normalizeAgentProductsListResponse,
  countUsableSearchProducts,
  withProxySearchFallbackMetadata,
  fetchProductDetailFromProductsCache = fetchProductDetailFromProductsCacheBase,
  fetchProductDetailFromUpstream = fetchProductDetailFromUpstreamBase,
  productDetailStaleMaxAgeHours = productDetailStaleMaxAgeHoursBase,
  logger,
} = {}) {
  let detail = null;
  let detailSource = null;
  if (fetchDetail && resolverDetailEnabled) {
    try {
      const detailFromCache = await fetchProductDetailFromProductsCache({
        merchantId: resolvedMerchantId,
        productId: resolvedProductId,
        includeExpired: true,
        staleMaxAgeHours: productDetailStaleMaxAgeHours,
      });
      if (detailFromCache?.product) {
        detail = detailFromCache.product;
        detailSource = detailFromCache?.stale_fallback_used
          ? 'products_cache_stale'
          : 'products_cache';
      }
      if (!detail) {
        detail = await fetchProductDetailFromUpstream({
          merchantId: resolvedMerchantId,
          productId: resolvedProductId,
          checkoutToken,
          timeoutMs: resolverDetailTimeoutMs,
          noRetry: true,
        });
        if (detail) detailSource = 'upstream';
      }
    } catch (err) {
      logger.warn(
        {
          err: err?.message || String(err),
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        'proxy agent search resolver fallback detail fetch failed',
      );
    }
  }

  if (fetchDetail && resolverDetailEnabled && !detail) {
    if (isLookupStyleSearchQuery(queryText, extractSearchAnchorTokens(queryText))) {
      const refOnlyResult = buildResolverReferenceOnlyResult({
        queryText,
        resolved,
        resolvedQueryUsed,
        resolvedMerchantId,
        resolvedProductId,
        resolveSources,
        reason,
        normalizeAgentProductsListResponse,
        countUsableSearchProducts,
        withProxySearchFallbackMetadata,
      });
      setProxySearchResolverCacheEntry(
        resolverCacheKey,
        refOnlyResult,
        resolverMissCacheTtlMs,
      );
      logger.info(
        {
          query: queryText,
          query_used: resolvedQueryUsed || queryText,
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        'proxy agent search resolver fallback returned reference-only candidate (detail unavailable)',
      );
      return refOnlyResult;
    }

    const missResult = {
      status: 200,
      usableCount: 0,
      data: null,
      resolved: false,
      resolve_reason: resolved?.reason || null,
      resolve_reason_code: 'detail_unavailable',
      resolve_confidence:
        Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
      resolve_latency_ms:
        Number.isFinite(Number(resolved?.metadata?.latency_ms))
          ? Number(resolved.metadata.latency_ms)
          : null,
      resolve_sources: resolveSources,
      resolve_query_used: resolvedQueryUsed || queryText,
    };
    setProxySearchResolverCacheEntry(
      resolverCacheKey,
      missResult,
      resolverMissCacheTtlMs,
    );
    logger.info(
      {
        query: queryText,
        query_used: resolvedQueryUsed || queryText,
        merchant_id: resolvedMerchantId,
        product_id: resolvedProductId,
      },
      'proxy agent search resolver fallback skipped unresolved detail candidate',
    );
    return missResult;
  }

  const candidateTitle = Array.isArray(resolved?.candidates)
    ? String(resolved.candidates?.[0]?.title || '').trim()
    : '';
  const title = String(
    detail?.title ||
      detail?.name ||
      detail?.display_name ||
      candidateTitle ||
      queryText,
  ).trim();

  const productRow = {
    ...(detail && typeof detail === 'object' ? detail : {}),
    id: String(detail?.id || detail?.product_id || resolvedProductId),
    product_id: String(detail?.product_id || detail?.id || resolvedProductId),
    merchant_id: String(detail?.merchant_id || resolvedMerchantId),
    platform_product_id: String(
      detail?.platform_product_id ||
        detail?.platformProductId ||
        detail?.product_id ||
        resolvedProductId,
    ),
    ...(title ? { title } : {}),
    ...(title && !detail?.name ? { name: title } : {}),
    canonical_product_ref: {
      merchant_id: resolvedMerchantId,
      product_id: resolvedProductId,
    },
  };

  const normalized = normalizeAgentProductsListResponse({
    status: 'success',
    success: true,
    products: [productRow],
    total: 1,
    page: 1,
    page_size: 1,
    metadata: buildResolvedSearchMetadata({
      queryText,
      resolved,
      resolvedQueryUsed,
      detailSource,
    }),
  });

  const successResult = {
    status: 200,
    usableCount: countUsableSearchProducts(normalized?.products),
    resolved: true,
    resolve_reason: resolved?.reason || null,
    resolve_reason_code:
      resolved?.reason_code ||
      resolved?.metadata?.resolve_reason_code ||
      null,
    resolve_confidence:
      Number.isFinite(Number(resolved?.confidence)) ? Number(resolved.confidence) : null,
    resolve_latency_ms:
      Number.isFinite(Number(resolved?.metadata?.latency_ms))
        ? Number(resolved.metadata.latency_ms)
        : null,
    resolve_sources: resolveSources,
    resolve_query_used: resolvedQueryUsed || queryText,
    data: withProxySearchFallbackMetadata(normalized, {
      applied: true,
      reason: reason || 'resolver_fallback',
    }),
  };
  setProxySearchResolverCacheEntry(
    resolverCacheKey,
    successResult,
    resolverCacheTtlMs,
  );
  return successResult;
}

module.exports = {
  buildResolverReferenceOnlyResult,
  finalizeResolveSearchFallbackResult,
};
