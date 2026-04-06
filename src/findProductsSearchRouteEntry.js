function createFindProductsSearchRouteEntryRuntime(deps = {}) {
  const {
    resolveGuidanceSearchSessionId,
    firstQueryParamValue,
    buildFindProductsMultiPayloadFromQuery,
    resolveLegacyBeautyCacheOwnerBypass,
    isShoppingSource,
    isAuroraSource,
    normalizeAgentSource,
    runGuidanceServerOwnedLadderSearch,
    persistGuidanceSearchSeenProducts,
    normalizeSearchUiSurface,
    normalizeRecommendationDecisionMode,
    searchExternalSeedOnlyProductsDirect,
    searchIngredientIntentProductsDirect,
  } = deps;

  function persistSeenProductsForRoute(req, payload, responsePayload) {
    return persistGuidanceSearchSeenProducts(
      resolveGuidanceSearchSessionId({ req, query: req.query, metadata: payload?.metadata }),
      Array.isArray(responsePayload?.products) ? responsePayload.products : [],
    );
  }

  function prepareAgentProductsSearchRoute(req) {
    const inferredSessionId = resolveGuidanceSearchSessionId({ req, query: req.query });
    const nextQuery = inferredSessionId
      ? {
          ...(req.query && typeof req.query === 'object' && !Array.isArray(req.query) ? req.query : {}),
          session_id:
            firstQueryParamValue(req.query?.session_id || req.query?.sessionId) ||
            inferredSessionId,
        }
      : (req.query && typeof req.query === 'object' && !Array.isArray(req.query) ? req.query : {});

    const payload = buildFindProductsMultiPayloadFromQuery(nextQuery);
    if (!payload) {
      return {
        invalid: true,
        query: nextQuery,
      };
    }

    const publicSearchSource = String(payload?.metadata?.source || '').trim();
    const rawSearch =
      payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
        ? payload.search
        : {};
    const routeMetadata =
      payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};
    const publicBeautyMainlineBypass = resolveLegacyBeautyCacheOwnerBypass({
      search: rawSearch,
      metadata: routeMetadata,
      rawQuery: rawSearch?.query || '',
      queryClass: null,
      strictConstraintQuery: false,
    });
    const explicitShoppingExternalSeedOnly =
      rawSearch?.external_seed_only === true &&
      String(rawSearch?.merchant_id || '').trim() === 'external_seed';
    const forceStrictShoppingMainPath =
      isShoppingSource(publicSearchSource) && !explicitShoppingExternalSeedOnly;
    const forceAuroraInvokeMainPath = isAuroraSource(publicSearchSource);
    const forceBeautyMainlineInvokePath = publicBeautyMainlineBypass.bypass === true;
    const forceDirectInvokeMainPath =
      forceStrictShoppingMainPath ||
      forceAuroraInvokeMainPath ||
      forceBeautyMainlineInvokePath;

    if (forceStrictShoppingMainPath) {
      payload.search = {
        ...(payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
          ? payload.search
          : {}),
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
        allow_external_seed: false,
      };
      payload.metadata = {
        ...routeMetadata,
        source: normalizeAgentSource(publicSearchSource) || publicSearchSource,
        catalog_surface: 'agent_api',
        commerce_surface: 'agent_api',
      };
    }

    if (forceBeautyMainlineInvokePath) {
      payload.search = {
        ...(payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
          ? payload.search
          : {}),
        ...(publicBeautyMainlineBypass.semanticContract
          ? { semantic_contract: publicBeautyMainlineBypass.semanticContract }
          : {}),
        catalog_surface:
          payload?.search?.catalog_surface ||
          payload?.search?.catalogSurface ||
          'beauty',
        commerce_surface:
          payload?.search?.commerce_surface ||
          payload?.search?.commerceSurface ||
          payload?.search?.catalog_surface ||
          payload?.search?.catalogSurface ||
          'beauty',
      };
    }

    return {
      invalid: false,
      query: nextQuery,
      payload,
      forceDirectInvokeMainPath,
    };
  }

  async function maybeHandleAgentProductsSearchRouteFastpaths({
    req,
    payload = null,
    forceDirectInvokeMainPath = false,
  } = {}) {
    if (!forceDirectInvokeMainPath) {
      const fastpathResponse = await runGuidanceServerOwnedLadderSearch({
        req,
        search:
          payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
            ? payload.search
            : {},
        metadata:
          payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? payload.metadata
            : {},
      });
      if (fastpathResponse) {
        await persistSeenProductsForRoute(req, payload, fastpathResponse);
        return { handled: true, response: fastpathResponse };
      }
    }

    const directExternalSeedSearch =
      payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
        ? payload.search
        : {};
    const directExternalSeedMetadata =
      payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};
    const directUiSurface = normalizeSearchUiSurface(
      directExternalSeedMetadata?.ui_surface ||
        directExternalSeedSearch?.ui_surface ||
        directExternalSeedSearch?.uiSurface,
    );
    const directDecisionMode = normalizeRecommendationDecisionMode(
      directExternalSeedMetadata?.decision_mode ||
        directExternalSeedSearch?.decision_mode ||
        directExternalSeedSearch?.decisionMode,
      { guidanceOnlyDiscovery: directUiSurface === 'ingredient_plan_guidance_only' },
    );
    const directExternalSeedOnly =
      directExternalSeedSearch?.external_seed_only === true &&
      (
        String(directExternalSeedSearch?.merchant_id || '').trim() === 'external_seed' ||
        (
          directUiSurface === 'ingredient_plan_guidance_only' &&
          directDecisionMode === 'guidance_only'
        )
      );

    if (!forceDirectInvokeMainPath && directExternalSeedOnly) {
      const directResponse = await searchExternalSeedOnlyProductsDirect({
        search: {
          ...directExternalSeedSearch,
          merchant_id:
            String(directExternalSeedSearch?.merchant_id || '').trim() ||
            (
              directUiSurface === 'ingredient_plan_guidance_only' &&
              directDecisionMode === 'guidance_only'
                ? 'external_seed'
                : ''
            ),
        },
        metadata: directExternalSeedMetadata,
      });
      if (directResponse) {
        await persistSeenProductsForRoute(req, payload, directResponse);
        return { handled: true, response: directResponse };
      }
    }

    if (!forceDirectInvokeMainPath) {
      const ingredientIntentDirectResponse = await searchIngredientIntentProductsDirect({
        search: directExternalSeedSearch,
        metadata: directExternalSeedMetadata,
      });
      if (ingredientIntentDirectResponse) {
        await persistSeenProductsForRoute(req, payload, ingredientIntentDirectResponse);
        return { handled: true, response: ingredientIntentDirectResponse };
      }
    }

    return {
      handled: false,
    };
  }

  return {
    prepareAgentProductsSearchRoute,
    maybeHandleAgentProductsSearchRouteFastpaths,
  };
}

module.exports = {
  createFindProductsSearchRouteEntryRuntime,
};
