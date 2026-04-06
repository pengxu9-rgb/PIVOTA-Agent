function createFindProductsInvokePrimaryUpstreamRuntime(deps = {}) {
  const { resolveInvokeSearchContractBridgeMeta } = deps;

  async function callInvokePrimaryUpstream({
    response = null,
    operation = '',
    axiosConfig = null,
    callTrackedUpstream = null,
    strictCommerceFindProductsMulti = false,
    strictBeautyDirectSearch = false,
    semanticOwnerControlled = false,
    productDetailCacheMeta = null,
    searchContractBridgeMeta = null,
  } = {}) {
    let nextResponse = response;
    let nextProductDetailCacheMeta = productDetailCacheMeta;
    let nextSearchContractBridgeMeta = searchContractBridgeMeta;

    if (nextResponse) {
      return {
        response: nextResponse,
        productDetailCacheMeta: nextProductDetailCacheMeta,
        searchContractBridgeMeta: nextSearchContractBridgeMeta,
      };
    }

    nextResponse = await callTrackedUpstream(operation, axiosConfig);
    if (operation === 'find_products' || operation === 'find_products_multi') {
      nextSearchContractBridgeMeta = resolveInvokeSearchContractBridgeMeta({
        operation,
        strictCommerceFindProductsMulti,
        strictBeautyDirectSearch,
        semanticOwnerControlled,
      });
    }
    if (operation === 'get_product_detail') {
      nextProductDetailCacheMeta = { hit: false, source: 'upstream' };
    }

    return {
      response: nextResponse,
      productDetailCacheMeta: nextProductDetailCacheMeta,
      searchContractBridgeMeta: nextSearchContractBridgeMeta,
    };
  }

  return {
    callInvokePrimaryUpstream,
  };
}

module.exports = {
  createFindProductsInvokePrimaryUpstreamRuntime,
};
