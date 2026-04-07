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

  function isPlainRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function normalizeAuthoritativeNoFallbackResponseBody(
    body,
    {
      querySource = 'agent_products_search',
      primaryPath = 'upstream_stage',
      reason = 'primary_exception_no_fallback',
      decisionLockReason = 'authoritative_no_fallback',
    } = {},
  ) {
    if (!isPlainRecord(body)) return body;

    const metadata = isPlainRecord(body.metadata) ? body.metadata : {};
    const routeHealth = isPlainRecord(metadata.route_health) ? metadata.route_health : {};
    const searchTrace = isPlainRecord(metadata.search_trace) ? metadata.search_trace : {};
    const searchDecision = isPlainRecord(metadata.search_decision)
      ? metadata.search_decision
      : {};
    const proxySearchFallback = isPlainRecord(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : {};
    const contractBridge = isPlainRecord(metadata.contract_bridge)
      ? metadata.contract_bridge
      : {};

    return {
      ...body,
      metadata: {
        ...metadata,
        query_source: querySource,
        legacy_contract: false,
        contract_bridge: {
          ...contractBridge,
          legacy_fallback: false,
        },
        proxy_search_fallback: {
          ...proxySearchFallback,
          applied: false,
          reason: proxySearchFallback.reason || reason,
        },
        route_health: {
          ...routeHealth,
          fallback_triggered: false,
          fallback_reason: null,
          primary_path_used: primaryPath,
        },
        search_trace: {
          ...searchTrace,
          fallback_reason: null,
          primary_path_used: primaryPath,
        },
        search_decision: {
          ...searchDecision,
          fallback_reason: null,
          primary_path_used: primaryPath,
          decision_authority: querySource,
          decision_locked: true,
          decision_lock_reason: decisionLockReason,
        },
      },
    };
  }

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
    authoritativeHardCut = false,
    hardCutAuthorityQuerySource = null,
    hardCutAuthorityPrimaryPath = null,
    semanticOwnerControlled = false,
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
    const normalizedAuthorityQuerySource =
      String(hardCutAuthorityQuerySource || 'agent_products_search').trim() ||
      'agent_products_search';
    const normalizedAuthorityPrimaryPath =
      String(hardCutAuthorityPrimaryPath || 'upstream_stage').trim() ||
      'upstream_stage';
    let nextResponse = response;
    let nextResolverRejectedReason = resolverRejectedReason;
    let nextResolverRejectedQueryUsed = resolverRejectedQueryUsed;

    if (shoppingFreshMainlineSearch) {
      const shoppingMainlineReason =
        err?.code === 'ECONNABORTED'
          ? 'shopping_mainline_timeout'
          : 'shopping_mainline_exception';
      const body = buildStrictEmptyFallbackResponse({
        body: null,
        queryParams,
        reason: shoppingMainlineReason,
        upstreamStatus,
        upstreamCode: upstreamCode || err?.code || null,
        upstreamMessage: upstreamMessage || err?.message || null,
        route: 'shopping_mainline_primary_exception',
        intent: effectiveIntent,
        queryClass: traceQueryClass,
        queryText,
        ...(authoritativeHardCut
          ? { querySource: normalizedAuthorityQuerySource }
          : {}),
      });
      nextResponse = {
        status: 200,
        data: authoritativeHardCut
          ? normalizeAuthoritativeNoFallbackResponseBody(body, {
              querySource: normalizedAuthorityQuerySource,
              primaryPath: normalizedAuthorityPrimaryPath,
              reason: shoppingMainlineReason,
            })
          : body,
      };
    }
    if (operation === 'find_products_multi' && strictCommerceFindProductsMulti) {
      const body = buildProxySearchSoftFallbackResponse({
        queryParams,
        reason: 'strict_surface_exception',
        upstreamStatus,
        upstreamCode: upstreamCode || err?.code || null,
        upstreamMessage: upstreamMessage || err?.message || null,
        route: 'strict_invoke_exception',
        intent: effectiveIntent,
        queryClass: traceQueryClass,
        queryText,
        querySource: authoritativeHardCut
          ? normalizedAuthorityQuerySource
          : 'agent_products_error_fallback',
      });
      nextResponse = {
        status: 200,
        data: authoritativeHardCut
          ? normalizeAuthoritativeNoFallbackResponseBody(body, {
              querySource: normalizedAuthorityQuerySource,
              primaryPath: normalizedAuthorityPrimaryPath,
              reason: 'strict_surface_exception',
            })
          : body,
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

    if (authoritativeHardCut) {
      const strictEmpty = buildStrictEmptyFallbackResponse({
        body: null,
        queryParams,
        reason:
          err?.code === 'ECONNABORTED'
            ? 'primary_exception_no_fallback_timeout'
            : 'primary_exception_no_fallback',
        upstreamStatus,
        upstreamCode: upstreamCode || err?.code || null,
        upstreamMessage: upstreamMessage || err?.message || null,
        route: 'invoke_exception_authoritative_no_fallback',
        intent: effectiveIntent,
        queryClass: traceQueryClass,
        queryText,
        querySource: normalizedAuthorityQuerySource,
      });
      const strictMetadata =
        strictEmpty?.metadata && typeof strictEmpty.metadata === 'object' && !Array.isArray(strictEmpty.metadata)
          ? strictEmpty.metadata
          : {};
      const proxySearchFallback =
        strictMetadata.proxy_search_fallback &&
        typeof strictMetadata.proxy_search_fallback === 'object' &&
        !Array.isArray(strictMetadata.proxy_search_fallback)
          ? strictMetadata.proxy_search_fallback
          : {};
      nextResponse = {
        status: 200,
        data: {
          ...strictEmpty,
          metadata: {
            ...strictMetadata,
            query_source: normalizedAuthorityQuerySource,
            legacy_contract: false,
            proxy_search_fallback: {
              ...proxySearchFallback,
              applied: false,
              reason:
                proxySearchFallback.reason ||
                (err?.code === 'ECONNABORTED'
                  ? 'primary_exception_no_fallback_timeout'
                  : 'primary_exception_no_fallback'),
            },
            route_health: {
              ...(
                strictMetadata.route_health &&
                typeof strictMetadata.route_health === 'object' &&
                !Array.isArray(strictMetadata.route_health)
                  ? strictMetadata.route_health
                  : {}
              ),
              fallback_triggered: false,
              fallback_reason: null,
              primary_path_used: normalizedAuthorityPrimaryPath,
            },
            search_trace: {
              ...(
                strictMetadata.search_trace &&
                typeof strictMetadata.search_trace === 'object' &&
                !Array.isArray(strictMetadata.search_trace)
                  ? strictMetadata.search_trace
                  : {}
              ),
              fallback_reason: null,
              primary_path_used: normalizedAuthorityPrimaryPath,
            },
            search_decision: {
              ...(
                strictMetadata.search_decision &&
                typeof strictMetadata.search_decision === 'object' &&
                !Array.isArray(strictMetadata.search_decision)
                  ? strictMetadata.search_decision
                  : {}
              ),
              primary_path_used: normalizedAuthorityPrimaryPath,
              decision_authority: normalizedAuthorityQuerySource,
              decision_locked: true,
              decision_lock_reason: 'primary_exception_authority',
            },
          },
        },
      };
      return {
        response: nextResponse,
        resolverRejectedReason: nextResolverRejectedReason,
        resolverRejectedQueryUsed: nextResolverRejectedQueryUsed,
        publicBrandSearchMainlineResolved:
          nextPublicBrandSearchMainlineResolved,
        publicBrandSearchMainlineShortCircuited,
      };
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
