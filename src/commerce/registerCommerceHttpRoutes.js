const {
  createExternalInvokeRouteHandler,
} = require('./externalInvokeRoute');

function createAgentProductsSearchViaInvokeHandler({
  buildFindProductsMultiPayloadFromQuery,
  handleInvokeRequest,
} = {}) {
  return async function handleAgentProductsSearchViaInvoke(req, res) {
    const payload = buildFindProductsMultiPayloadFromQuery(req.query);
    if (!payload) {
      return res.status(400).json({
        error: 'INVALID_QUERY',
        message: 'query payload is invalid',
      });
    }

    req.body = {
      operation: 'find_products_multi',
      payload,
      metadata:
        payload?.metadata &&
        typeof payload.metadata === 'object' &&
        !Array.isArray(payload.metadata)
          ? payload.metadata
          : {},
    };

    return handleInvokeRequest(req, res, {
      client_channel: 'shop',
      orchestrator_path: 'external_invoke_route',
      proxy_search_route: true,
    });
  };
}

function createBeautyProductsSearchRedirectHandler({
  firstQueryParamValue,
  buildQueryString,
} = {}) {
  return function handleBeautyProductsSearchRedirect(req, res) {
    const mergedQuery =
      req.query && typeof req.query === 'object' && !Array.isArray(req.query)
        ? { ...req.query }
        : {};
    if (!String(firstQueryParamValue(mergedQuery.source) || '').trim()) {
      mergedQuery.source = 'aurora-bff';
    }
    if (!String(firstQueryParamValue(mergedQuery.catalog_surface) || '').trim()) {
      mergedQuery.catalog_surface = 'beauty';
    }
    const queryString = buildQueryString(mergedQuery);
    return res.redirect(307, `/agent/v1/products/search${queryString}`);
  };
}

function registerCommerceHttpRoutes({
  app,
  requireExternalInvokeAuth,
  handleInvokeRequest,
  commerceKernel,
  invokeAuthContext,
  proxyAgentSearchToBackend,
  buildFindProductsMultiPayloadFromQuery,
  firstQueryParamValue,
  buildQueryString,
  createExternalInvokeRoute = createExternalInvokeRouteHandler,
} = {}) {
  const registerExternalInvokeRoute = (path, clientChannel, version = 'v1') => {
    app.post(
      path,
      requireExternalInvokeAuth,
      createExternalInvokeRoute({
        version,
        clientChannel,
        handleInvokeRequest,
        commerceKernel,
        invokeAuthContext,
      }),
    );
  };

  registerExternalInvokeRoute('/agent/shop/v1/invoke', 'shop');
  registerExternalInvokeRoute('/agent/shop/v2/invoke', 'shop', 'v2');
  registerExternalInvokeRoute('/agent/creator/v1/invoke', 'creator');
  registerExternalInvokeRoute('/agent/creator/v2/invoke', 'creator', 'v2');

  app.get('/agent/v1/products/search', proxyAgentSearchToBackend);
  app.get(
    '/agent/v1/beauty/products/search',
    createBeautyProductsSearchRedirectHandler({
      firstQueryParamValue,
      buildQueryString,
    }),
  );

  return {
    registerExternalInvokeRoute,
    handleAgentProductsSearchViaInvoke: createAgentProductsSearchViaInvokeHandler({
      buildFindProductsMultiPayloadFromQuery,
      handleInvokeRequest,
    }),
  };
}

module.exports = {
  createAgentProductsSearchViaInvokeHandler,
  createBeautyProductsSearchRedirectHandler,
  registerCommerceHttpRoutes,
};
