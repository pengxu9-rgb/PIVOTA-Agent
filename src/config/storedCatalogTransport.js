'use strict';

// Defense inside the ordinary catalog HTTP path. The independent rehearsal
// network/DB guard still owns auth, Reap and transports outside shared Axios.
function assertStoredCatalogHttp(config = {}, env = process.env) {
  if (env.GATEWAY_STORED_CATALOG_REHEARSAL !== '1') return config;
  let url;
  try { url = new URL(config.url, config.baseURL); } catch (_) { /* fail closed */ }
  const port = Number(env.PORT) > 0 ? Number(env.PORT) : 8080;
  if (!url || url.origin !== `http://127.0.0.1:${port}` ||
      url.username || url.password || url.pathname !== '/agent/shop/v1/invoke') {
    const error = new Error('Stored catalog rehearsal cannot dispatch remote catalog HTTP');
    error.code = 'STORED_CATALOG_REMOTE_READ_DISABLED';
    throw error;
  }
  // A permitted self-call must never redirect to a remote origin.
  return { ...config, maxRedirects: 0 };
}

function installStoredCatalogHttpGuard(axios, env = process.env) {
  if (env.GATEWAY_STORED_CATALOG_REHEARSAL !== '1') return null;
  return axios.interceptors.request.use(config => assertStoredCatalogHttp(config, env));
}
module.exports = { assertStoredCatalogHttp, installStoredCatalogHttpGuard };
