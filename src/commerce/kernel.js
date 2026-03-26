const {
  adaptLegacyResponseToV2,
  normalizeV2InvokeRequest,
} = require('./contracts');

function createCommerceKernel({
  executeLegacyInvoke,
  defaultClientChannel = 'shop',
} = {}) {
  if (typeof executeLegacyInvoke !== 'function') {
    throw new Error('createCommerceKernel requires executeLegacyInvoke');
  }

  return {
    async invoke({
      body,
      headers,
      version = 'v1',
      clientChannel = defaultClientChannel,
      routeContext = {},
      invokeAuth = null,
    } = {}) {
      const normalizedVersion = String(version || 'v1').trim().toLowerCase();
      if (normalizedVersion === 'v2') {
        const normalized = normalizeV2InvokeRequest(body, {
          defaultClientChannel: clientChannel,
        });
        const legacyResponse = await executeLegacyInvoke({
          body: normalized.legacyRequest,
          headers,
          routeContext: {
            ...routeContext,
            client_channel: clientChannel,
          },
          invokeAuth,
        });
        return {
          ...legacyResponse,
          body: adaptLegacyResponseToV2({
            canonicalOperation: normalized.canonicalOperation,
            legacyOperation: normalized.legacyOperation,
            response: legacyResponse,
            clientChannel,
          }),
          canonicalOperation: normalized.canonicalOperation,
          legacyOperation: normalized.legacyOperation,
        };
      }

      return executeLegacyInvoke({
        body,
        headers,
        routeContext: {
          ...routeContext,
          client_channel: clientChannel,
        },
        invokeAuth,
      });
    },
  };
}

module.exports = {
  createCommerceKernel,
};
