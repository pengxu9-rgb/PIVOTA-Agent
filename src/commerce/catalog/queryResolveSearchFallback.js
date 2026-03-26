const {
  finalizeResolveSearchFallbackResult: finalizeResolveSearchFallbackResultBase,
} = require('./resolverFallbackResponse');
const {
  getProxySearchApiBase: getProxySearchApiBaseBase,
} = require('./searchGuards');

function toResolveSources(input) {
  return Array.isArray(input?.metadata?.sources)
    ? input.metadata.sources
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          source: String(item.source || '').trim() || null,
          ok: item.ok === true,
          count: Number.isFinite(Number(item.count)) ? Number(item.count) : null,
          reason: String(item.reason || '').trim() || null,
          error_code: String(item.error_code || '').trim() || null,
        }))
    : [];
}

async function queryResolveSearchFallback({
  queryParams,
  checkoutToken,
  reason,
  requestSource,
  fetchDetail = true,
  timeoutMs,
  extractSearchQueryText,
  firstQueryParamValue,
  parseQueryStringArray,
  uniqueStrings,
  parseQueryBoolean,
  proxySearchResolverTimeoutMs,
  buildProxySearchResolverCacheKey,
  getProxySearchResolverCacheEntry,
  buildResolverQueryCandidates,
  resolveStableAliasByQuery,
  normalizeResolverText,
  tokenizeResolverQuery,
  resolveProductRef,
  getProxySearchApiBase = getProxySearchApiBaseBase,
  pivotaApiKey,
  setProxySearchResolverCacheEntry,
  proxySearchResolverMissCacheTtlMs,
  proxySearchResolverCacheTtlMs,
  proxySearchResolverDetailEnabled,
  proxySearchResolverDetailTimeoutMs,
  isLookupStyleSearchQuery,
  extractSearchAnchorTokens,
  normalizeAgentProductsListResponse,
  countUsableSearchProducts,
  withProxySearchFallbackMetadata,
  finalizeResolveSearchFallbackResult = finalizeResolveSearchFallbackResultBase,
  logger,
} = {}) {
  const query = queryParams && typeof queryParams === 'object' ? queryParams : {};
  const queryText = extractSearchQueryText(query);
  if (!queryText) return null;

  const lang = String(firstQueryParamValue(query.lang) || 'en').trim().toLowerCase() || 'en';
  const merchantId = String(firstQueryParamValue(query.merchant_id || query.merchantId) || '').trim();
  const merchantIds = parseQueryStringArray(query.merchant_ids || query.merchantIds);
  const preferMerchants = uniqueStrings([merchantId, ...merchantIds]);
  const searchAllMerchants = parseQueryBoolean(query.search_all_merchants || query.searchAllMerchants);
  const effectiveResolverTimeoutMs = Math.max(
    200,
    Number(timeoutMs || proxySearchResolverTimeoutMs) || proxySearchResolverTimeoutMs,
  );
  const resolveOptions = {
    ...(preferMerchants.length ? { prefer_merchants: preferMerchants } : {}),
    ...(searchAllMerchants !== undefined ? { search_all_merchants: searchAllMerchants } : {}),
    timeout_ms: effectiveResolverTimeoutMs,
    upstream_retries: 0,
    stable_alias_short_circuit: true,
  };
  const resolverCacheKey = buildProxySearchResolverCacheKey({
    queryText,
    lang,
    preferMerchants,
    searchAllMerchants,
    fetchDetail,
    resolverTimeoutMs: effectiveResolverTimeoutMs,
  });
  const cached = getProxySearchResolverCacheEntry(resolverCacheKey);
  if (cached) return cached;

  const resolverQueryCandidates = buildResolverQueryCandidates(queryText);
  let resolved = null;
  let resolvedQueryUsed = queryText;
  for (const candidateQuery of resolverQueryCandidates) {
    const candidateText = String(candidateQuery || '').trim();
    if (!candidateText) continue;

    let stableAliasMatch = null;
    if (resolveStableAliasByQuery) {
      try {
        const normalizedCandidate = normalizeResolverText(candidateText);
        const candidateTokens = Array.isArray(tokenizeResolverQuery(normalizedCandidate))
          ? tokenizeResolverQuery(normalizedCandidate)
          : [];
        if (normalizedCandidate && candidateTokens.length > 0) {
          stableAliasMatch = resolveStableAliasByQuery({
            query: candidateText,
            normalizedQuery: normalizedCandidate,
            queryTokens: candidateTokens,
          });
        }
      } catch {
        stableAliasMatch = null;
      }
    }

    if (
      stableAliasMatch &&
      stableAliasMatch.product_ref &&
      String(stableAliasMatch.product_ref.product_id || '').trim() &&
      String(stableAliasMatch.product_ref.merchant_id || '').trim()
    ) {
      resolved = {
        resolved: true,
        reason: 'stable_alias_match',
        reason_code: 'stable_alias_match',
        confidence: Number.isFinite(Number(stableAliasMatch.score))
          ? Number(stableAliasMatch.score)
          : 1,
        product_ref: {
          product_id: String(stableAliasMatch.product_ref.product_id || '').trim(),
          merchant_id: String(stableAliasMatch.product_ref.merchant_id || '').trim(),
        },
        candidates: [
          {
            title:
              String(
                stableAliasMatch.title || stableAliasMatch.alias || candidateText || '',
              ).trim() || null,
            product_ref: {
              product_id: String(stableAliasMatch.product_ref.product_id || '').trim(),
              merchant_id: String(stableAliasMatch.product_ref.merchant_id || '').trim(),
            },
            score: Number.isFinite(Number(stableAliasMatch.score))
              ? Number(stableAliasMatch.score)
              : 1,
          },
        ],
        metadata: {
          latency_ms: 0,
          sources: [
            {
              source: 'stable_alias_ref',
              ok: true,
              reason: stableAliasMatch.reason || 'stable_alias_match',
              count: 1,
            },
          ],
          stable_alias_short_circuit: true,
        },
      };
      resolvedQueryUsed = candidateText;
      break;
    }

    try {
      const candidateResolved = await resolveProductRef({
        query: candidateText,
        lang,
        hints: null,
        options: resolveOptions,
        pivotaApiBase: getProxySearchApiBase(requestSource),
        pivotaApiKey: pivotaApiKey,
        checkoutToken,
      });
      if (!resolved) {
        resolved = candidateResolved;
        resolvedQueryUsed = candidateText;
      }
      if (
        candidateResolved &&
        candidateResolved.resolved &&
        candidateResolved.product_ref &&
        String(candidateResolved.product_ref.product_id || '').trim() &&
        String(candidateResolved.product_ref.merchant_id || '').trim()
      ) {
        resolved = candidateResolved;
        resolvedQueryUsed = candidateText;
        break;
      }
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), query: candidateText },
        'proxy agent search resolver fallback failed',
      );
      continue;
    }
  }

  const resolvedRef = resolved && resolved.resolved ? resolved.product_ref : null;
  const resolvedProductId = String(resolvedRef?.product_id || '').trim();
  const resolvedMerchantId = String(resolvedRef?.merchant_id || '').trim();
  const resolveSources = toResolveSources(resolved);
  if (!resolvedProductId || !resolvedMerchantId) {
    const missResult = {
      status: 200,
      usableCount: 0,
      data: null,
      resolved: false,
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
    };
    setProxySearchResolverCacheEntry(
      resolverCacheKey,
      missResult,
      proxySearchResolverMissCacheTtlMs,
    );
    return missResult;
  }

  return finalizeResolveSearchFallbackResult({
    queryText,
    resolved,
    resolvedQueryUsed,
    resolvedMerchantId,
    resolvedProductId,
    resolveSources,
    reason,
    resolverCacheKey,
    resolverMissCacheTtlMs: proxySearchResolverMissCacheTtlMs,
    resolverCacheTtlMs: proxySearchResolverCacheTtlMs,
    fetchDetail,
    resolverDetailEnabled: proxySearchResolverDetailEnabled,
    resolverDetailTimeoutMs: proxySearchResolverDetailTimeoutMs,
    checkoutToken,
    setProxySearchResolverCacheEntry,
    isLookupStyleSearchQuery,
    extractSearchAnchorTokens,
    normalizeAgentProductsListResponse,
    countUsableSearchProducts,
    withProxySearchFallbackMetadata,
    logger,
  });
}

module.exports = {
  queryResolveSearchFallback,
};
