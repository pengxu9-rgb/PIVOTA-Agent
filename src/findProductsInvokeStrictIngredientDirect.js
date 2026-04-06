function createFindProductsInvokeStrictIngredientDirectRuntime(deps = {}) {
  const {
    searchIngredientIntentProductsDirect,
    resolveInvokeSearchContractBridgeMeta,
  } = deps;

  async function maybeApplyInvokeStrictIngredientDirect({
    response = null,
    operation = '',
    autoStrictSearchSourceBeautyDirectSearch = false,
    strictFindProductsMultiDecision = null,
    findProductsMultiSearchPayload = null,
    rawFindProductsMultiQueryText = '',
    rawUserQuery = '',
    queryParams = null,
    metadata = null,
    strictCommerceFindProductsMulti = false,
    strictBeautyDirectSearch = false,
    semanticOwnerControlled = false,
    logger = null,
  } = {}) {
    let nextResponse = response;
    let nextSearchContractBridgeMeta = resolveInvokeSearchContractBridgeMeta({
      operation,
      strictCommerceFindProductsMulti,
      strictBeautyDirectSearch,
      semanticOwnerControlled,
    });

    if (
      nextResponse ||
      operation !== 'find_products_multi' ||
      !autoStrictSearchSourceBeautyDirectSearch ||
      strictFindProductsMultiDecision?.strictConstraintQuery !== true
    ) {
      return {
        response: nextResponse,
        searchContractBridgeMeta: nextSearchContractBridgeMeta,
      };
    }

    try {
      const localIngredientDirectResponse =
        await searchIngredientIntentProductsDirect({
          search: {
            ...(findProductsMultiSearchPayload &&
            typeof findProductsMultiSearchPayload === 'object' &&
            !Array.isArray(findProductsMultiSearchPayload)
              ? findProductsMultiSearchPayload
              : {}),
            query: String(
              rawFindProductsMultiQueryText ||
                rawUserQuery ||
                findProductsMultiSearchPayload?.query ||
                '',
            ).trim(),
            ...(queryParams?.limit != null ? { limit: queryParams.limit } : {}),
            ...(queryParams?.page != null ? { page: queryParams.page } : {}),
            ...(queryParams?.offset != null ? { offset: queryParams.offset } : {}),
            ...(queryParams?.target_step_family
              ? { target_step_family: queryParams.target_step_family }
              : {}),
            ...(queryParams?.query_step_strength
              ? { query_step_strength: queryParams.query_step_strength }
              : {}),
            ...(queryParams?.semantic_family
              ? { semantic_family: queryParams.semantic_family }
              : {}),
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
          },
          metadata: {
            ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
              ? metadata
              : {}),
            source: String(metadata?.source || 'search').trim() || 'search',
            catalog_surface: 'beauty',
            commerce_surface: 'beauty',
          },
        });
      const localIngredientDirectProducts = Array.isArray(
        localIngredientDirectResponse?.products,
      )
        ? localIngredientDirectResponse.products
        : [];
      const localIngredientDirectQuerySource = String(
        localIngredientDirectResponse?.metadata?.query_source || '',
      ).trim();
      if (
        localIngredientDirectProducts.length > 0 ||
        localIngredientDirectQuerySource.startsWith('agent_products_ingredient_')
      ) {
        nextResponse = {
          status: 200,
          data: localIngredientDirectResponse,
        };
        nextSearchContractBridgeMeta = resolveInvokeSearchContractBridgeMeta({
          operation,
          strictCommerceFindProductsMulti,
          strictBeautyDirectSearch,
          semanticOwnerControlled,
          explicitResolvedContract: 'shop_invoke_strict',
        });
      }
    } catch (localIngredientDirectErr) {
      logger?.warn(
        {
          err: localIngredientDirectErr?.message || String(localIngredientDirectErr),
          query: String(
            rawFindProductsMultiQueryText ||
              rawUserQuery ||
              findProductsMultiSearchPayload?.query ||
              '',
          ).trim(),
        },
        'strict ingredient local direct recall failed; continuing to products/search upstream',
      );
    }

    return {
      response: nextResponse,
      searchContractBridgeMeta: nextSearchContractBridgeMeta,
    };
  }

  return {
    maybeApplyInvokeStrictIngredientDirect,
  };
}

module.exports = {
  createFindProductsInvokeStrictIngredientDirectRuntime,
};
