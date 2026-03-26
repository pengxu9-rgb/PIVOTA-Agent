const {
  shouldBypassSecondaryFallbackSkipOnPrimaryException:
    shouldBypassSecondaryFallbackSkipOnPrimaryExceptionBase,
} = require('./searchFallbackRuntime');

async function handleInvokeSearchExceptionFallback({
  operation,
  err,
  metadata,
  traceQueryClass,
  effectiveIntent,
  queryParams,
  queryText = '',
  resolverQueryParams,
  resolverFirstResult,
  auroraFallbackOverrides,
  checkoutToken,
  resolverTimeoutMs,
  crossMerchantCacheProtectedResponse,
  extractUpstreamErrorCode,
  detectBrandEntities,
  shouldSkipSecondaryFallbackAfterResolverMiss,
  shouldAllowResolverFallback,
  shouldAllowSecondaryFallback,
  shouldAllowInvokeFallback,
  shouldBypassSecondaryFallbackSkipOnPrimaryException =
    shouldBypassSecondaryFallbackSkipOnPrimaryExceptionBase,
  queryResolveSearchFallback,
  queryFindProductsMultiFallback,
  isProxySearchFallbackRelevant,
  normalizeAgentProductsListResponse,
  withProxySearchFallbackMetadata,
  buildProxySearchSoftFallbackResponse,
  logger,
} = {}) {
  if (!(operation === 'find_products' || operation === 'find_products_multi')) {
    return { handled: false, response: null };
  }

  const normalizedQueryText = String(queryText || '').trim();
  const upstreamStatus = err?.response?.status || null;
  const { code: upstreamCode, message: upstreamMessage } =
    typeof extractUpstreamErrorCode === 'function'
      ? extractUpstreamErrorCode(err)
      : { code: null, message: null };
  let response = null;
  const secondarySkipBrandLike = Boolean(
    typeof detectBrandEntities === 'function'
      ? detectBrandEntities(normalizedQueryText, { candidateProducts: [] })?.brand_like
      : false,
  );
  const skipSecondaryFallback =
    typeof shouldSkipSecondaryFallbackAfterResolverMiss === 'function'
      ? shouldSkipSecondaryFallbackAfterResolverMiss(resolverFirstResult, normalizedQueryText, {
          disableSkipAfterResolverMiss: auroraFallbackOverrides?.disableSkipAfterResolverMiss,
          queryClass: traceQueryClass,
          brandLike: secondarySkipBrandLike,
        })
      : false;
  const allowResolverFallback =
    typeof shouldAllowResolverFallback === 'function'
      ? shouldAllowResolverFallback(operation)
      : false;
  const allowSecondaryFallback =
    typeof shouldAllowSecondaryFallback === 'function'
      ? shouldAllowSecondaryFallback(operation, {
          forceSecondaryFallback: auroraFallbackOverrides?.forceSecondaryFallback,
        })
      : false;
  const allowInvokeFallback =
    typeof shouldAllowInvokeFallback === 'function'
      ? shouldAllowInvokeFallback(operation, {
          forceInvokeFallback: auroraFallbackOverrides?.forceInvokeFallback,
        })
      : false;
  const bypassSkipSecondaryFallback =
    typeof shouldBypassSecondaryFallbackSkipOnPrimaryException === 'function'
      ? shouldBypassSecondaryFallbackSkipOnPrimaryException({ err })
      : false;
  const allowResolverFallbackOnException =
    operation === 'find_products_multi' &&
    allowResolverFallback &&
    (!skipSecondaryFallback || bypassSkipSecondaryFallback);
  const allowSecondaryFallbackOnException =
    operation === 'find_products_multi' &&
    allowSecondaryFallback &&
    allowInvokeFallback &&
    (!skipSecondaryFallback || bypassSkipSecondaryFallback);

  if (normalizedQueryText) {
    const fallbackReason = upstreamStatus
      ? `upstream_status_${upstreamStatus}`
      : err?.code === 'ECONNABORTED'
        ? 'upstream_timeout'
        : 'upstream_exception';

    if (allowResolverFallbackOnException) {
      try {
        const resolverFallback = await queryResolveSearchFallback({
          queryParams: resolverQueryParams,
          checkoutToken,
          reason: 'resolver_after_exception',
          requestSource: metadata?.source,
          timeoutMs: resolverTimeoutMs,
        });
        if (
          resolverFallback &&
          resolverFallback.status >= 200 &&
          resolverFallback.status < 300 &&
          resolverFallback.usableCount > 0
        ) {
          response = {
            status: resolverFallback.status,
            data: withProxySearchFallbackMetadata(resolverFallback.data, {
              applied: true,
              reason: 'resolver_after_exception',
              route: 'invoke_exception_resolver',
              upstream_status: upstreamStatus,
              upstream_error_code: upstreamCode || err?.code || null,
              upstream_error_message: upstreamMessage || err?.message || null,
            }),
          };
        }
      } catch (resolverErr) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            { err: resolverErr?.message || String(resolverErr) },
            `${operation} resolver fallback failed after upstream exception`,
          );
        }
      }
    }

    if (!response && allowSecondaryFallbackOnException) {
      try {
        const fallback = await queryFindProductsMultiFallback({
          queryParams: resolverQueryParams,
          checkoutToken,
          reason: fallbackReason,
          requestSource: metadata?.source,
        });
        if (
          fallback &&
          fallback.status >= 200 &&
          fallback.status < 300 &&
          fallback.usableCount > 0 &&
          typeof isProxySearchFallbackRelevant === 'function' &&
          isProxySearchFallbackRelevant(fallback.data, normalizedQueryText)
        ) {
          response = {
            status: fallback.status,
            data: withProxySearchFallbackMetadata(fallback.data, {
              applied: true,
              reason: fallbackReason,
              route: 'invoke_exception_fallback_invoke',
              upstream_status: upstreamStatus,
              upstream_error_code: upstreamCode || err?.code || null,
              upstream_error_message: upstreamMessage || err?.message || null,
            }),
          };
        }
      } catch (fallbackErr) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            { err: fallbackErr?.message || String(fallbackErr) },
            `${operation} invoke fallback failed after upstream exception`,
          );
        }
      }
    }
  }

  if (
    !response &&
    operation === 'find_products_multi' &&
    crossMerchantCacheProtectedResponse &&
    Array.isArray(crossMerchantCacheProtectedResponse.products) &&
    crossMerchantCacheProtectedResponse.products.length > 0
  ) {
    response = {
      status: 200,
      data: withProxySearchFallbackMetadata(
        normalizeAgentProductsListResponse(crossMerchantCacheProtectedResponse, {
          limit: queryParams?.limit,
          offset: queryParams?.offset,
        }),
        {
          applied: false,
          reason: 'primary_exception_cache_guard',
          route: 'invoke_exception_cache_guard',
          upstream_status: upstreamStatus,
          upstream_error_code: upstreamCode || err?.code || null,
          upstream_error_message: upstreamMessage || err?.message || null,
        },
      ),
    };
  }

  if (!response) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(
        {
          operation,
          upstream_status: upstreamStatus,
          upstream_code: err?.code || null,
          soft_code: upstreamCode || null,
          soft_message: upstreamMessage || null,
        },
        `${operation} upstream failed; returning soft fallback empty payload`,
      );
    }
    response = {
      status: 200,
      data: buildProxySearchSoftFallbackResponse({
        queryParams,
        reason: 'error_soft_fallback',
        upstreamStatus,
        upstreamCode: upstreamCode || err?.code || null,
        upstreamMessage: upstreamMessage || err?.message || null,
        route: 'invoke_exception',
        intent: effectiveIntent,
        queryClass: traceQueryClass,
        queryText: normalizedQueryText,
        querySource: 'agent_products_error_fallback',
      }),
    };
  }

  return {
    handled: true,
    response,
  };
}

module.exports = {
  handleInvokeSearchExceptionFallback,
};
