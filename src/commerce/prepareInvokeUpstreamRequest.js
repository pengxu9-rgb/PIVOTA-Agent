const {
  buildCommerceInvokeUpstreamRequest: buildCommerceInvokeUpstreamRequestBase,
} = require('./invokeUpstreamRequest');
const {
  handleFindSimilarProductsInvoke: handleFindSimilarProductsInvokeBase,
} = require('./catalog/findSimilarProducts');
const { getInvokeRoute: getInvokeRouteBase } = require('./invokeRoutes');
const {
  applyShoppingCatalogQueryGuards: applyShoppingCatalogQueryGuardsBase,
  isCreatorUiSource: isCreatorUiSourceBase,
  getProxySearchApiBase: getProxySearchApiBaseBase,
} = require('./catalog/searchGuards');

async function prepareInvokeUpstreamRequest({
  operation,
  payload,
  effectivePayload,
  metadata,
  creatorId,
  checkoutToken,
  pivotaApiBase,
  searchLimitMax,
  applyShoppingCatalogQueryGuards = applyShoppingCatalogQueryGuardsBase,
  getCreatorConfig,
  uniqueStrings,
  isCreatorUiSource = isCreatorUiSourceBase,
  proxySearchCreatorScopeToConfig,
  now,
  hasDatabase,
  findSimilarCreatorFromCache,
  getProxySearchApiBase = getProxySearchApiBaseBase,
  buildCommerceInvokeUpstreamRequest = buildCommerceInvokeUpstreamRequestBase,
  handleFindSimilarProductsInvoke = handleFindSimilarProductsInvokeBase,
  getInvokeRoute = getInvokeRouteBase,
  logger,
} = {}) {
  const route = typeof getInvokeRoute === 'function' ? getInvokeRoute(operation) : null;
  if (!route) {
    return {
      handled: true,
      statusCode: 400,
      body: {
        error: 'UNSUPPORTED_OPERATION',
        operation,
      },
    };
  }

  const invokeSource = String(metadata?.source || '').trim().toLowerCase();
  const searchInvokeBase =
    operation === 'find_products_multi' || operation === 'find_products'
      ? getProxySearchApiBase(invokeSource)
      : pivotaApiBase;

  let url = `${searchInvokeBase}${route.path}`;
  let requestBody = {};
  let queryParams = {};
  let resolvedOfferId = null;
  let resolvedMerchantId = null;
  const productDetail = {
    merchantId: null,
    productId: null,
    cacheKey: null,
    debug: false,
    bypassCache: false,
  };

  let requestBuilderHandled = false;
  try {
    const builtCommerceRequest = await buildCommerceInvokeUpstreamRequest({
      operation,
      effectivePayload,
      payload,
      metadata,
      creatorId,
      checkoutToken,
      url,
      pivotaApiBase,
      searchLimitMax,
      applyShoppingCatalogQueryGuards,
      getCreatorConfig,
      uniqueStrings,
      isCreatorUiSource,
      proxySearchCreatorScopeToConfig,
    });
    if (builtCommerceRequest) {
      requestBuilderHandled = true;
      if (typeof builtCommerceRequest.url === 'string') {
        url = builtCommerceRequest.url;
      }
      if (builtCommerceRequest.requestBody && typeof builtCommerceRequest.requestBody === 'object') {
        requestBody = builtCommerceRequest.requestBody;
      }
      if (builtCommerceRequest.queryParams && typeof builtCommerceRequest.queryParams === 'object') {
        queryParams = builtCommerceRequest.queryParams;
      }
      if (Object.prototype.hasOwnProperty.call(builtCommerceRequest, 'resolvedOfferId')) {
        resolvedOfferId = builtCommerceRequest.resolvedOfferId;
      }
      if (Object.prototype.hasOwnProperty.call(builtCommerceRequest, 'resolvedMerchantId')) {
        resolvedMerchantId = builtCommerceRequest.resolvedMerchantId;
      }
      if (builtCommerceRequest.productDetail && typeof builtCommerceRequest.productDetail === 'object') {
        productDetail.merchantId =
          String(builtCommerceRequest.productDetail.merchantId || '').trim() || null;
        productDetail.productId =
          String(builtCommerceRequest.productDetail.productId || '').trim() || null;
        productDetail.cacheKey =
          String(builtCommerceRequest.productDetail.cacheKey || '').trim() || null;
        productDetail.debug = builtCommerceRequest.productDetail.debug === true;
        productDetail.bypassCache = builtCommerceRequest.productDetail.bypassCache === true;
      }
    }
  } catch (err) {
    return {
      handled: true,
      statusCode: err?.statusCode || 400,
      body: {
        error: err?.code || 'INVALID_REQUEST',
        message: err?.message || 'Invalid request',
      },
    };
  }

  if (!requestBuilderHandled && operation === 'find_similar_products') {
    const similarResult = await handleFindSimilarProductsInvoke({
      payload,
      metadata,
      creatorId,
      now,
      checkoutToken,
      hasDatabase,
      isCreatorUiSource,
      findSimilarCreatorFromCache,
      logger,
    });
    if (similarResult?.handled) {
      return {
        handled: true,
        statusCode: similarResult.statusCode || 200,
        body: similarResult.body,
      };
    }
    if (similarResult?.requestBody && typeof similarResult.requestBody === 'object') {
      requestBody = similarResult.requestBody;
    }
  }

  return {
    handled: false,
    route,
    url,
    requestBody,
    queryParams,
    resolvedOfferId,
    resolvedMerchantId,
    productDetail,
  };
}

module.exports = {
  prepareInvokeUpstreamRequest,
};
