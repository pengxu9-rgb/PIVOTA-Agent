'use strict';

// Defense inside the ordinary catalog HTTP path. The independent rehearsal
// network/DB guard still owns auth, Reap and transports outside shared Axios.
function assertStoredCatalogHttp(config = {}, env = process.env, validatedHop = null) {
  if (env.GATEWAY_STORED_CATALOG_REHEARSAL !== '1') return config;
  let url;
  try { url = new URL(config.url, config.baseURL); } catch (_) { /* fail closed */ }
  const port = Number(env.PORT) > 0 ? Number(env.PORT) : 8080;
  const selfInvoke = url && url.origin === `http://127.0.0.1:${port}` &&
    url.pathname === '/agent/shop/v1/invoke' && !url.username && !url.password && !url.hash;
  let privateIntrospection = false;
  if (url && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/agent/internal/auth/introspect' &&
      String(config.method || '').toUpperCase() === 'POST') {
    let hop = validatedHop;
    if (!hop && (env.GATEWAY_BACKEND_ID_TOKEN_AUDIENCE || env.GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN)) {
      // The private-hop package validates stable receiving audience + exact tag
      // destination. Constructing it is config-only; it performs no metadata I/O.
      try { hop = require('../services/privateBackendHop').createPrivateBackendHop({ env }); }
      catch (_) { /* An absent or invalid paired private-hop contract refuses. */ }
    }
    privateIntrospection = Boolean(hop?.enabled && hop.accepts(url.href));
  }
  if (!selfInvoke && !privateIntrospection) {
    const error = new Error('Stored catalog rehearsal cannot dispatch remote catalog HTTP');
    error.code = 'STORED_CATALOG_REMOTE_READ_DISABLED';
    throw error;
  }
  // Neither a permitted self-call nor private introspection may redirect.
  return { ...config, maxRedirects: 0 };
}

function installStoredCatalogHttpGuard(axios, env = process.env) {
  if (env.GATEWAY_STORED_CATALOG_REHEARSAL !== '1') return null;
  return axios.interceptors.request.use(config => assertStoredCatalogHttp(config, env));
}
module.exports = { assertStoredCatalogHttp, installStoredCatalogHttpGuard };
