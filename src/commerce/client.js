const axios = require('axios');

function buildInvokeUrl(baseUrl, clientChannel, version) {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  const normalizedChannel = String(clientChannel || 'shop').trim().toLowerCase() || 'shop';
  const normalizedVersion = String(version || 'v1').trim().toLowerCase() || 'v1';
  if (!normalizedBaseUrl) return null;
  return `${normalizedBaseUrl}/agent/${normalizedChannel}/${normalizedVersion}/invoke`;
}

function createRemoteCommerceClient({
  resolveBaseUrl,
  buildHeaders,
  defaultVersion = 'v1',
  defaultClientChannel = 'shop',
  timeoutMs = 20_000,
} = {}) {
  return {
    mode: 'remote',
    async invoke(body, options = {}) {
      const version = String(options.version || defaultVersion || 'v1').trim().toLowerCase();
      const clientChannel = String(
        options.clientChannel || defaultClientChannel || 'shop',
      ).trim().toLowerCase() || 'shop';
      const baseUrl =
        typeof resolveBaseUrl === 'function'
          ? resolveBaseUrl({ body, options })
          : resolveBaseUrl;
      const url = buildInvokeUrl(baseUrl, clientChannel, version);
      if (!url) {
        const err = new Error('Commerce client base URL is not configured');
        err.code = 'COMMERCE_CLIENT_UNCONFIGURED';
        throw err;
      }

      const resolvedHeaders =
        typeof buildHeaders === 'function' ? await buildHeaders({ body, options }) : buildHeaders || {};
      const response = await axios.post(url, body, {
        timeout: Number(options.timeoutMs || timeoutMs) || timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          ...(resolvedHeaders || {}),
          ...(options.headers || {}),
        },
        validateStatus: () => true,
      });

      return {
        statusCode: Number(response?.status || 0) || 502,
        body: response?.data,
        headers: response?.headers || {},
      };
    },
  };
}

function createInProcessCommerceClient({
  kernel,
  defaultVersion = 'v1',
  defaultClientChannel = 'shop',
} = {}) {
  if (!kernel || typeof kernel.invoke !== 'function') {
    throw new Error('createInProcessCommerceClient requires a commerce kernel');
  }

  return {
    mode: 'in_process',
    invoke(body, options = {}) {
      return kernel.invoke({
        body,
        headers: options.headers,
        version: options.version || defaultVersion,
        clientChannel: options.clientChannel || defaultClientChannel,
        routeContext: options.routeContext,
        invokeAuth: options.invokeAuth,
      });
    },
  };
}

module.exports = {
  buildInvokeUrl,
  createInProcessCommerceClient,
  createRemoteCommerceClient,
};
