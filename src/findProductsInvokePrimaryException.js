function createFindProductsInvokePrimaryExceptionRuntime(deps = {}) {
  const {
    detectBrandEntities,
    extractUpstreamErrorCode,
    shouldSkipSecondaryFallbackAfterResolverMiss,
    shouldAllowResolverFallback,
    shouldAllowSecondaryFallback,
    shouldAllowInvokeFallback,
    shouldBypassSecondaryFallbackSkipOnPrimaryException,
    queryResolveSearchFallback,
    getResolverFallbackAdoptionDecision,
    buildInvokeResolverFallbackResponse,
    queryFindProductsMultiFallback,
    isProxySearchFallbackRelevant,
    buildProxySearchFallbackMetadataResponse,
    normalizeAgentProductsListResponse,
    buildProxySearchSoftFallbackResponse,
    buildStrictEmptyFallbackResponse,
  } = deps;

  async function handleInvokePrimarySearchException({
    response = null,
    operation = '',
    err = null,
    queryParams = null,
    effectiveIntent = null,
    traceQueryClass = null,
    metadata = null,
    payload = null,
    resolverQueryText = '',
    searchQueryText = '',
    shoppingFreshMainlineSearch = false,
    strictCommerceFindProductsMulti = false,
    semanticOwnerControlled = false,
    requestContract = null,
    executionPlan = null,
    resolverFirstResult = null,
    auroraFallbackOverrides = null,
    forceCreatorHumanApparelFallback = false,
    requestSource = null,
    resolverQueryParams = null,
    checkoutToken = null,
    resolverTimeoutMs = 0,
    publicBrandSearchMainlinePreflight = false,
    publicBrandSearchMainlinePromise = null,
    publicBrandSearchMainlineResolved = null,
    crossMerchantCacheProtectedResponse = null,
    resolverRejectedReason = null,
    resolverRejectedQueryUsed = null,
    logger = null,
  } = {}) {
    if (
      response ||
      (operation !== 'find_products' && operation !== 'find_products_multi')
    ) {
      return {
        response,
        resolverRejectedReason,
        resolverRejectedQueryUsed,
        publicBrandSearchMainlineResolved,
        publicBrandSearchMainlineShortCircuited: false,
      };
    }

    const queryText = resolverQueryText || searchQueryText;
    const upstreamStatus = err?.response?.status || null;
    const { code: upstreamCode, message: upstreamMessage } =
      extractUpstreamErrorCode(err);
    let nextResponse = response;
    let nextResolverRejectedReason = resolverRejectedReason;
    let nextResolverRejectedQueryUsed = resolverRejectedQueryUsed;
    const primaryLane = String(
      executionPlan?.primary_lane || requestContract?.primary_lane || '',
    )
      .trim()
      .toLowerCase();
    const beautyDiscoveryMainlineContract =
      operation === 'find_products_multi' &&
      !strictCommerceFindProductsMulti &&
      primaryLane === 'beauty_discovery_mainline';

    if (shoppingFreshMainlineSearch) {
      nextResponse = {
        status: 200,
        data: buildStrictEmptyFallbackResponse({
          body: null,
          queryParams,
          reason:
            err?.code === 'ECONNABORTED'
              ? 'shopping_mainline_timeout'
              : 'shopping_mainline_exception',
          upstreamStatus,
          upstreamCode: upstreamCode || err?.code || null,
          upstreamMessage: upstreamMessage || err?.message || null,
          route: 'shopping_mainline_primary_exception',
          intent: effectiveIntent,
          queryClass: traceQueryClass,
          queryText,
        }),
      };
    }
    if (operation === 'find_products_multi' && strictCommerceFindProductsMulti) {
      nextResponse = {
        status: 200,
        data: buildProxySearchSoftFallbackResponse({
          queryParams,
          reason: 'strict_surface_exception',
          upstreamStatus,
          upstreamCode: upstreamCode || err?.code || null,
          upstreamMessage: upstreamMessage || err?.message || null,
          route: 'strict_invoke_exception',
          intent: effectiveIntent,
          queryClass: traceQueryClass,
          queryText,
          querySource: 'agent_products_error_fallback',
        }),
      };
    }
    if (beautyDiscoveryMainlineContract) {
      nextResponse = {
        status: 200,
        data: buildStrictEmptyFallbackResponse({
          body: null,
          queryParams,
          reason:
            err?.code === 'ECONNABORTED'
              ? 'beauty_discovery_mainline_timeout'
              : 'beauty_discovery_mainline_exception',
          upstreamStatus,
          upstreamCode: upstreamCode || err?.code || null,
          upstreamMessage: upstreamMessage || err?.message || null,
          route: 'beauty_discovery_mainline_primary_exception',
          intent: effectiveIntent,
          queryClass: traceQueryClass,
          queryText,
        }),
      };
    }
    if (nextResponse) {
      return {
        response: nextResponse,
        resolverRejectedReason: nextResolverRejectedReason,
        resolverRejectedQueryUsed: nextResolverRejectedQueryUsed,
        publicBrandSearchMainlineResolved,
        publicBrandSearchMainlineShortCircuited: false,
      };
    }

    let nextPublicBrandSearchMainlineResolved = publicBrandSearchMainlineResolved;
    let publicBrandSearchMainlineShortCircuited = false;
    if (
      publicBrandSearchMainlinePreflight &&
      publicBrandSearchMainlinePromise
    ) {
      nextPublicBrandSearchMainlineResolved =
        nextPublicBrandSearchMainlineResolved ||
        (await publicBrandSearchMainlinePromise);
      if (nextPublicBrandSearchMainlineResolved) {
        return {
          response: {
            status: 200,
            data: nextPublicBrandSearchMainlineResolved,
          },
          resolverRejectedReason: nextResolverRejectedReason,
          resolverRejectedQueryUsed: nextResolverRejectedQueryUsed,
          publicBrandSearchMainlineResolved:
            nextPublicBrandSearchMainlineResolved,
          publicBrandSearchMainlineShortCircuited: true,
        };
      }
    }

    const secondarySkipBrandLike = Boolean(
      detectBrandEntities(queryText, { candidateProducts: [] })?.brand_like,
    );
    const skipSecondaryFallback = semanticOwnerControlled
      ? true
      : shouldSkipSecondaryFallbackAfterResolverMiss(resolverFirstResult, queryText, {
          disableSkipAfterResolverMiss:
            auroraFallbackOverrides?.disableSkipAfterResolverMiss,
          queryClass: traceQueryClass,
          brandLike: secondarySkipBrandLike,
        });
    const allowResolverFallback = shouldAllowResolverFallback(operation, {
      metadata: {
        ...(metadata || {}),
        source: requestSource || null,
      },
      queryText,
      queryClass: traceQueryClass,
    });
    const allowResolverFallbackEffective = semanticOwnerControlled
      ? false
      : allowResolverFallback;
    const allowSecondaryFallback = semanticOwnerControlled
      ? false
      : shouldAllowSecondaryFallback(operation, {
          forceSecondaryFallback:
            auroraFallbackOverrides?.forceSecondaryFallback ||
            forceCreatorHumanApparelFallback,
        });
    const allowInvokeFallback = semanticOwnerControlled
      ? false
      : shouldAllowInvokeFallback(operation, {
          forceInvokeFallback:
            auroraFallbackOverrides?.forceInvokeFallback ||
            forceCreatorHumanApparelFallback,
        });
    const bypassSkipSecondaryFallback =
      shouldBypassSecondaryFallbackSkipOnPrimaryException({ err });
    const allowResolverFallbackOnException =
      allowResolverFallbackEffective &&
      (!skipSecondaryFallback || bypassSkipSecondaryFallback);
    const allowSecondaryFallbackOnException =
      allowSecondaryFallback &&
      allowInvokeFallback &&
      (!skipSecondaryFallback || bypassSkipSecondaryFallback);

    if (queryText) {
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
            requestSource,
            timeoutMs: resolverTimeoutMs,
          });
          if (
            resolverFallback &&
            resolverFallback.status >= 200 &&
            resolverFallback.status < 300 &&
            resolverFallback.usableCount > 0
          ) {
            const resolverAdoption = getResolverFallbackAdoptionDecision({
              result: resolverFallback,
              queryText,
              queryClass: traceQueryClass,
            });
            if (resolverAdoption.adopt) {
              nextResponse = buildInvokeResolverFallbackResponse({
                result: resolverFallback,
                fallbackReason: 'resolver_after_exception',
                route: 'invoke_exception_resolver',
                upstreamStatus,
                upstreamErrorCode: upstreamCode || err?.code || null,
                upstreamErrorMessage: upstreamMessage || err?.message || null,
              });
            } else {
              nextResolverRejectedReason =
                resolverAdoption.reason || nextResolverRejectedReason;
              nextResolverRejectedQueryUsed =
                resolverAdoption.resolveQueryUsed || nextResolverRejectedQueryUsed;
            }
          }
        } catch (resolverErr) {
          logger?.warn(
            { err: resolverErr?.message || String(resolverErr) },
            `${operation} resolver fallback failed after upstream exception`,
          );
        }
      }

      if (!nextResponse && allowSecondaryFallbackOnException) {
        try {
          const fallback = await queryFindProductsMultiFallback({
            queryParams: resolverQueryParams,
            checkoutToken,
            reason: fallbackReason,
            requestSource,
            });
          if (
            fallback &&
            fallback.status >= 200 &&
            fallback.status < 300 &&
            fallback.usableCount > 0 &&
            isProxySearchFallbackRelevant(fallback.data, queryText)
          ) {
            nextResponse = buildProxySearchFallbackMetadataResponse({
              status: fallback.status,
              body: fallback.data,
              patch: {
                applied: true,
                reason: fallbackReason,
                route: 'invoke_exception_fallback_invoke',
                upstream_status: upstreamStatus,
                upstream_error_code: upstreamCode || err?.code || null,
                upstream_error_message: upstreamMessage || err?.message || null,
              },
            });
          }
        } catch (fallbackErr) {
          logger?.warn(
            { err: fallbackErr?.message || String(fallbackErr) },
            `${operation} invoke fallback failed after upstream exception`,
          );
        }
      }
    }

    if (
      !nextResponse &&
      operation === 'find_products_multi' &&
      !shoppingFreshMainlineSearch &&
      crossMerchantCacheProtectedResponse &&
      Array.isArray(crossMerchantCacheProtectedResponse.products) &&
      crossMerchantCacheProtectedResponse.products.length > 0
    ) {
      nextResponse = buildProxySearchFallbackMetadataResponse({
        status: 200,
        body: normalizeAgentProductsListResponse(crossMerchantCacheProtectedResponse, {
          limit: queryParams?.limit,
          offset: queryParams?.offset,
        }),
        patch: {
          applied: false,
          reason: 'primary_exception_cache_guard',
          route: 'invoke_exception_cache_guard',
          upstream_status: upstreamStatus,
          upstream_error_code: upstreamCode || err?.code || null,
          upstream_error_message: upstreamMessage || err?.message || null,
        },
      });
    }

    if (!nextResponse) {
      logger?.warn(
        {
          operation,
          upstream_status: upstreamStatus,
          upstream_code: err?.code || null,
          soft_code: upstreamCode || null,
          soft_message: upstreamMessage || null,
        },
        `${operation} upstream failed; returning soft fallback empty payload`,
      );
      nextResponse = {
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
          queryText,
          querySource: 'agent_products_error_fallback',
          slotStateInput: metadata?.slot_state || payload?.context || null,
        }),
      };
    }

    return {
      response: nextResponse,
      resolverRejectedReason: nextResolverRejectedReason,
      resolverRejectedQueryUsed: nextResolverRejectedQueryUsed,
      publicBrandSearchMainlineResolved:
        nextPublicBrandSearchMainlineResolved,
      publicBrandSearchMainlineShortCircuited,
    };
  }

  return {
    handleInvokePrimarySearchException,
  };
}

module.exports = {
  createFindProductsInvokePrimaryExceptionRuntime,
};
