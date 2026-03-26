const {
  createInvokeRequestHandler,
} = require('./createInvokeRequestHandler');
const {
  registerCommerceHttpRoutes,
} = require('./registerCommerceHttpRoutes');
const {
  createCommerceRuntimeBridge,
} = require('./runtimeBridge');

function createCommerceEntrypoints({
  defaultClientChannel = 'shop',
  defaultVersion = 'v1',
  createRuntimeBridge = createCommerceRuntimeBridge,
  registerRoutes = registerCommerceHttpRoutes,
  createInvokeHandler = createInvokeRequestHandler,
} = {}) {
  const runtime = createRuntimeBridge({
    defaultClientChannel,
    defaultVersion,
  });

  return {
    commerceKernel: runtime.commerceKernel,
    commerceClient: runtime.commerceClient,
    invokeHandlerBridge: runtime.invokeHandlerBridge,
    registerHttpRoutes: (routeConfig = {}) =>
      registerRoutes({
        ...routeConfig,
        handleInvokeRequest: runtime.invokeHandlerBridge,
        commerceKernel: runtime.commerceKernel,
      }),
    bindInvokeHandler: (invokeHandlerConfig = {}) =>
      runtime.invokeHandlerBridge.set(createInvokeHandler(invokeHandlerConfig)),
  };
}

module.exports = {
  createCommerceEntrypoints,
};
