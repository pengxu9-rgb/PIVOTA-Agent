const ALLOWED_INVOKE_PROXY_HEADERS = [
  'x-gateway-request-id',
  'server-timing',
  'x-gateway-retries',
  'x-upstream-request-id',
];

function copyInvokeHeaders(
  targetRes,
  sourceHeaders,
  allowedHeaders = ALLOWED_INVOKE_PROXY_HEADERS,
) {
  for (const headerName of allowedHeaders) {
    const value = sourceHeaders?.[headerName];
    if (value == null) continue;
    targetRes.setHeader(headerName, value);
  }
}

function buildInvokeRouteContext(req, clientChannel, orchestratorPath) {
  return {
    client_channel: clientChannel,
    orchestrator_path: orchestratorPath,
    key_fingerprint: req?.invokeAuth?.key_fingerprint || null,
    agent_id: req?.invokeAuth?.agent_id || null,
    auth_mode: req?.invokeAuth?.auth_mode || null,
    auth_source: req?.invokeAuth?.auth_source || null,
    path: req?.path || '/internal/commerce/invoke',
    query: req?.query || {},
    params: req?.params || {},
    socket: req?.socket || null,
  };
}

function buildInvokeAuthContextValue(req) {
  return {
    api_key: req?.invokeAuth?.raw_token || null,
    agent_id: req?.invokeAuth?.agent_id || null,
    auth_mode: req?.invokeAuth?.auth_mode || null,
    auth_source: req?.invokeAuth?.auth_source || null,
  };
}

async function handleExternalInvokeRoute({
  req,
  res,
  version = 'v1',
  clientChannel,
  handleInvokeRequest,
  commerceKernel,
  buildInvokeRouteContextFn = buildInvokeRouteContext,
  copyInvokeHeadersFn = copyInvokeHeaders,
} = {}) {
  const normalizedVersion = String(version || 'v1').trim().toLowerCase();

  if (normalizedVersion === 'v1') {
    return handleInvokeRequest(
      req,
      res,
      buildInvokeRouteContextFn(req, clientChannel, 'external_invoke_route'),
    );
  }

  try {
    const response = await commerceKernel.invoke({
      body: req.body,
      headers: req.headers,
      version: normalizedVersion,
      clientChannel,
      routeContext: buildInvokeRouteContextFn(req, clientChannel, 'external_invoke_route_v2'),
      invokeAuth: req.invokeAuth,
    });
    copyInvokeHeadersFn(res, response.headers);
    return res.status(response.statusCode).json(response.body);
  } catch (err) {
    const statusCode = Number(err?.statusCode || err?.status || 0) || 400;
    return res.status(statusCode).json({
      error: err?.code || 'INVALID_REQUEST',
      message: err?.message || 'Invalid invoke request',
    });
  }
}

function createExternalInvokeRouteHandler({
  version = 'v1',
  clientChannel,
  handleInvokeRequest,
  commerceKernel,
  invokeAuthContext,
  buildInvokeAuthContext = buildInvokeAuthContextValue,
  handleExternalInvoke = handleExternalInvokeRoute,
  buildInvokeRouteContextFn = buildInvokeRouteContext,
  copyInvokeHeadersFn = copyInvokeHeaders,
} = {}) {
  return async function externalInvokeRouteHandler(req, res) {
    return invokeAuthContext.run(buildInvokeAuthContext(req), async () =>
      handleExternalInvoke({
        req,
        res,
        version,
        clientChannel,
        handleInvokeRequest,
        commerceKernel,
        buildInvokeRouteContextFn,
        copyInvokeHeadersFn,
      }),
    );
  };
}

module.exports = {
  ALLOWED_INVOKE_PROXY_HEADERS,
  copyInvokeHeaders,
  buildInvokeRouteContext,
  buildInvokeAuthContextValue,
  handleExternalInvokeRoute,
  createExternalInvokeRouteHandler,
};
