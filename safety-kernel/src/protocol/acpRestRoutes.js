const DEFAULT_BASE_PATH = '';

/**
 * Framework-neutral ACP route table over `createAcpRestAdapter`.
 *
 * Route handlers return `{ status, body, headers }` and deliberately forward `rawBody` as captured by the
 * HTTP layer. They never JSON.stringify `req.body`, because ACP signatures bind the exact signed bytes.
 */
export function createAcpRouteHandlers(adapter, { basePath = DEFAULT_BASE_PATH } = {}) {
  if (!adapter) throw new Error('createAcpRouteHandlers requires an ACP adapter');
  const routes = [
    ['POST', '/checkout_sessions', adapter.createCheckoutSession],
    ['POST', '/checkout_sessions/:checkout_session_id/complete', adapter.completeCheckoutSession],
    ['POST', '/checkout_sessions/:checkout_session_id/cancel', adapter.cancelCheckoutSession],
    ['POST', '/checkout_sessions/:checkout_session_id', adapter.updateCheckoutSession],
    ['GET', '/checkout_sessions/:checkout_session_id', adapter.getCheckoutSession],
    ['GET', '/feed', adapter.productFeed],
  ];

  return routes.map(([method, path, handler]) => ({
    method,
    path: joinPath(basePath, path),
    handler: async (req) => addJsonHeader(await handler(normalizeAcpRouteRequest(req))),
  }));
}

/** Mount on an Express-style app. Install a raw-body capture middleware before these routes. */
export function mountAcpRoutes(app, adapter, opts = {}) {
  if (!app) throw new Error('mountAcpRoutes requires an Express-style app');
  for (const route of createAcpRouteHandlers(adapter, opts)) {
    const mount = app[route.method.toLowerCase()];
    if (typeof mount !== 'function') throw new Error(`app is missing ${route.method.toLowerCase()}()`);
    mount.call(app, route.path, async (req, res) => {
      const out = await route.handler(req);
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
      return res.status(out.status).json(out.body);
    });
  }
}

export function normalizeAcpRouteRequest(req) {
  return {
    headers: req?.headers ?? {},
    rawBody: rawBodyString(req?.rawBody),
    body: req?.body,
    params: req?.params ?? {},
  };
}

function addJsonHeader(out) {
  return {
    status: out.status,
    body: out.body,
    headers: { 'content-type': 'application/json', ...(out.headers ?? {}) },
  };
}

function rawBodyString(rawBody) {
  if (typeof rawBody === 'string') return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody).toString('utf8');
  return undefined;
}

function joinPath(basePath, path) {
  const base = typeof basePath === 'string' ? basePath.trim() : '';
  if (!base || base === '/') return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
