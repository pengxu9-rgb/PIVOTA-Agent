const { createInProcessCommerceClient } = require('./client');
const { executeExpressJsonHandler } = require('./expressInvoker');
const { createCommerceKernel } = require('./kernel');

function createInvokeHandlerBridge() {
  let currentHandler = null;

  const invokeHandlerBridge = (...args) => {
    if (typeof currentHandler !== 'function') {
      const err = new Error('INVOKE_HANDLER_NOT_READY');
      err.code = 'INVOKE_HANDLER_NOT_READY';
      throw err;
    }
    return currentHandler(...args);
  };

  invokeHandlerBridge.set = (handler) => {
    currentHandler = handler;
    return currentHandler;
  };

  invokeHandlerBridge.get = () => currentHandler;

  return invokeHandlerBridge;
}

function createCommerceRuntimeBridge({
  defaultClientChannel = 'shop',
  defaultVersion = 'v1',
  createKernel = createCommerceKernel,
  createInProcessClient = createInProcessCommerceClient,
  executeExpressJson = executeExpressJsonHandler,
} = {}) {
  const invokeHandlerBridge = createInvokeHandlerBridge();
  const commerceKernel = createKernel({
    defaultClientChannel,
    executeLegacyInvoke: ({ body, headers, routeContext, invokeAuth }) =>
      executeExpressJson(invokeHandlerBridge, {
        body,
        headers,
        routeContext,
        invokeAuth,
      }),
  });
  const commerceClient = createInProcessClient({
    kernel: commerceKernel,
    defaultVersion,
    defaultClientChannel,
  });

  return {
    invokeHandlerBridge,
    commerceKernel,
    commerceClient,
  };
}

module.exports = {
  createInvokeHandlerBridge,
  createCommerceRuntimeBridge,
};
