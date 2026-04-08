function firstRouteQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseRouteBoolean(value) {
  const raw = firstRouteQueryValue(value);
  if (raw == null) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function shouldDefaultBeautyMainlineExternalSeed(search = {}, semanticContract = null) {
  const queryText = String(search?.query || search?.q || '').trim().toLowerCase();
  if (!queryText) return false;
  const uiSurface = String(search?.ui_surface || search?.uiSurface || '').trim().toLowerCase();
  if (uiSurface === 'ingredient_plan_guidance_only') return false;
  if (parseRouteBoolean(search?.product_only ?? search?.productOnly) === true) return false;
  const targetStepFamily = String(
    semanticContract?.target_step_family ||
      semanticContract?.targetStepFamily ||
      search?.target_step_family ||
      search?.targetStepFamily ||
      '',
  ).trim().toLowerCase();
  if (targetStepFamily === 'sunscreen') return false;
  return /\b(oily|oil control|sebum|shine control|mattify|mattifying|non-greasy|non greasy)\b/i.test(
    queryText,
  );
}

function createFindProductsSearchRouteEntryRuntime(deps = {}) {
  const {
    resolveGuidanceSearchSessionId,
    firstQueryParamValue,
    buildFindProductsMultiPayloadFromQuery,
    buildFindProductsSearchRequestContract,
    resolveLegacyBeautyCacheOwnerBypass,
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
	    const localMainlineChild = parseRouteBoolean(
	      nextQuery.local_mainline_child ?? nextQuery.localMainlineChild,
	    );
	    if (localMainlineChild !== undefined) {
	      payload.search = {
	        ...(payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
	          ? payload.search
	          : {}),
	        local_mainline_child: localMainlineChild,
	      };
	      payload.metadata = {
	        ...(payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
	          ? payload.metadata
	          : {}),
	        local_mainline_child: localMainlineChild,
	      };
	    }

    const childSafeBeautyMainlineBypass =
      localMainlineChild === true
        ? { bypass: false, semanticContract: null }
        : null;
    const publicSearchSource = String(payload?.metadata?.source || '').trim();
    const rawSearch =
      payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
        ? payload.search
        : {};
    const routeMetadata =
      payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : {};
    const publicBeautyMainlineBypass =
      childSafeBeautyMainlineBypass ||
      resolveLegacyBeautyCacheOwnerBypass({
        search: rawSearch,
        metadata: routeMetadata,
        rawQuery: rawSearch?.query || '',
        queryClass: null,
        strictConstraintQuery: false,
      });
    const explicitShoppingExternalSeedOnly =
      rawSearch?.external_seed_only === true &&
      String(rawSearch?.merchant_id || '').trim() === 'external_seed';
    const explicitStrictCatalogSurfaceRequested = ['agent_api', 'acp', 'ucp'].includes(
      String(
        rawSearch?.catalog_surface ||
          rawSearch?.catalogSurface ||
          routeMetadata?.catalog_surface ||
          routeMetadata?.catalogSurface ||
          '',
      ).trim().toLowerCase(),
    );
    const searchRequestContract =
      typeof buildFindProductsSearchRequestContract === 'function'
        ? buildFindProductsSearchRequestContract({
            surface: 'direct',
            operation: 'find_products_multi',
            search: rawSearch,
            metadata: routeMetadata,
            strictConstraintQuery: explicitStrictCatalogSurfaceRequested,
            beautyMainlineBypass: publicBeautyMainlineBypass,
          })
        : null;
    const forceBeautyMainlineInvokePath =
      String(searchRequestContract?.primary_lane || '').trim() === 'beauty_discovery_mainline' &&
      normalizeSearchUiSurface(
        routeMetadata?.ui_surface ||
          rawSearch?.ui_surface ||
          rawSearch?.uiSurface,
      ) !== 'ingredient_plan_guidance_only' &&
      !explicitShoppingExternalSeedOnly;
    const forceStrictShoppingMainPath =
      String(searchRequestContract?.primary_lane || '').trim() === 'shop_invoke_strict';
    const forceDirectInvokeMainPath =
      forceStrictShoppingMainPath ||
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
      const existingAllowExternalSeed = payload?.search?.allow_external_seed ?? payload?.search?.allowExternalSeed;
      const existingExternalSeedStrategy =
        payload?.search?.external_seed_strategy || payload?.search?.externalSeedStrategy;
      const nextMetadata =
        payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? payload.metadata
          : routeMetadata;
      const shouldDefaultAllowExternalSeed =
        existingAllowExternalSeed === undefined &&
        shouldDefaultBeautyMainlineExternalSeed(
          payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
            ? payload.search
            : {},
          publicBeautyMainlineBypass.semanticContract,
        );
      const shouldSetExternalSeedStrategy =
        !existingExternalSeedStrategy &&
        (
          shouldDefaultAllowExternalSeed ||
          parseRouteBoolean(existingAllowExternalSeed) === true
        );
      payload.search = {
        ...(payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
          ? payload.search
          : {}),
        ...(localMainlineChild !== true && publicBeautyMainlineBypass.semanticContract
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
        ...(shouldDefaultAllowExternalSeed ? { allow_external_seed: true } : {}),
        ...(shouldSetExternalSeedStrategy ? { external_seed_strategy: 'unified_relevance' } : {}),
      };
      payload.metadata = {
        ...nextMetadata,
        search_request_contract: searchRequestContract,
        primary_lane: searchRequestContract?.primary_lane || 'beauty_discovery_mainline',
        primary_retrieval_contract:
          searchRequestContract?.primary_retrieval_contract ||
          'agent_v1_search_beauty_mainline',
        supplement_lanes: Array.isArray(searchRequestContract?.supplement_lanes)
          ? searchRequestContract.supplement_lanes
          : [],
      };
    } else if (searchRequestContract) {
      const nextMetadata =
        payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? payload.metadata
          : routeMetadata;
      payload.metadata = {
        ...nextMetadata,
        search_request_contract: searchRequestContract,
        primary_lane: searchRequestContract.primary_lane || null,
        primary_retrieval_contract:
          searchRequestContract.primary_retrieval_contract || null,
        supplement_lanes: Array.isArray(searchRequestContract.supplement_lanes)
          ? searchRequestContract.supplement_lanes
          : [],
      };
    }

    const finalSearchRequestContract =
      typeof buildFindProductsSearchRequestContract === 'function'
        ? buildFindProductsSearchRequestContract({
            surface: 'direct',
            operation: 'find_products_multi',
            search:
              payload?.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
                ? payload.search
                : rawSearch,
            metadata:
              payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
                ? payload.metadata
                : routeMetadata,
            strictConstraintQuery: explicitStrictCatalogSurfaceRequested,
            beautyMainlineBypass: publicBeautyMainlineBypass,
          })
        : searchRequestContract;
    if (finalSearchRequestContract) {
      payload.metadata = {
        ...(payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? payload.metadata
          : routeMetadata),
        search_request_contract: finalSearchRequestContract,
        primary_lane: finalSearchRequestContract.primary_lane || null,
        primary_retrieval_contract:
          finalSearchRequestContract.primary_retrieval_contract || null,
        supplement_lanes: Array.isArray(finalSearchRequestContract.supplement_lanes)
          ? finalSearchRequestContract.supplement_lanes
          : [],
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
