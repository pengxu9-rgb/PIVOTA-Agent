'use strict';

const { cloudRunAudience, createRefreshingCloudRunIdTokenProvider } = require('./cloudRunIdentityToken');
const AUDIENCE_ENV = 'GATEWAY_BACKEND_ID_TOKEN_AUDIENCE';
const TARGET_ENV = 'GATEWAY_BACKEND_ID_TOKEN_TARGET_ORIGIN';

function hopError(code) {
  const error = new Error(code); // Never include URLs, headers, tokens or transport errors.
  error.code = code;
  return error;
}
function serviceOrigin(raw) {
  const origin = cloudRunAudience(raw);
  return origin && new URL(origin).hostname.endsWith('.run.app') ? origin : null;
}
function tokenIsUsable(token, audience, now) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    // Sanity checks on our metadata response, NOT signature verification. Cloud Run verifies it.
    return claims.aud === audience && Number.isFinite(claims.exp) && claims.exp * 1000 > now();
  } catch { return false; }
}

/** Explicit private receiving service; no credentials inferred from a caller/merchant URL. */
function createPrivateBackendHop({ env = process.env, metadataFetch, now = Date.now } = {}) {
  const rawAudience = String(env[AUDIENCE_ENV] || '').trim();
  const rawTarget = String(env[TARGET_ENV] || '').trim();
  const enabled = Boolean(rawAudience || rawTarget);
  const audience = serviceOrigin(rawAudience);
  const targetOrigin = serviceOrigin(rawTarget);
  if (enabled) {
    const stableHost = audience && new URL(audience).hostname;
    const targetHost = targetOrigin && new URL(targetOrigin).hostname;
    if (!stableHost || stableHost.includes('---') || !targetHost
      || !(targetHost === stableHost || (targetHost.endsWith(`---${stableHost}`)
        && /^[a-z0-9][a-z0-9-]*$/.test(targetHost.slice(0, -(stableHost.length + 3)))))) {
      throw hopError('backend_iam_configuration_invalid');
    }
  }
  const provider = enabled ? createRefreshingCloudRunIdTokenProvider({
    audience, fetchImpl: metadataFetch || globalThis.fetch, now,
  }) : null;
  function accepts(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === targetOrigin && !parsed.username && !parsed.password && !parsed.hash;
    } catch { return false; }
  }
  function assertDestination(url) {
    if (enabled && !accepts(url)) throw hopError('backend_iam_destination_refused');
  }
  async function headers(url, supplied = {}) {
    if (!enabled) return supplied;
    assertDestination(url); // BEFORE touching metadata or application transport.
    let token;
    try { token = await provider.getToken(); } catch { throw hopError('backend_iam_token_unavailable'); }
    if (typeof token !== 'string' || !tokenIsUsable(token, audience, now)) {
      throw hopError('backend_iam_token_unavailable');
    }
    const out = {};
    for (const [key, value] of Object.entries(supplied || {})) {
      if (key.toLowerCase() !== 'x-serverless-authorization') out[key] = value;
    }
    return { ...out, 'X-Serverless-Authorization': `Bearer ${token}` };
  }
  function wrapFetch(fetchImpl = globalThis.fetch) {
    return async (url, init = {}) => {
      const response = await fetchImpl(url, {
        ...init, headers: await headers(url, init.headers), ...(enabled ? { redirect: 'error' } : {}),
      });
      if (enabled && [401, 403].includes(Number(response?.status))) throw hopError('backend_iam_rejected');
      return response;
    };
  }
  function installAxios(instance, { backendBaseUrl, introspectUrl } = {}) {
    if (!enabled) return null;
    assertDestination(backendBaseUrl);
    if (introspectUrl) assertDestination(introspectUrl);
    // Axios is also used for public merchant reads. Those never receive our platform token.
    instance.interceptors.response.use((response) => {
      if (accepts(new URL(response.config.url, response.config.baseURL || backendBaseUrl).href)
        && [401, 403].includes(Number(response.status))) throw hopError('backend_iam_rejected');
      return response;
    }, (error) => {
      const response = error?.response;
      if (response && accepts(new URL(response.config.url, response.config.baseURL || backendBaseUrl).href)
        && [401, 403].includes(Number(response.status))) throw hopError('backend_iam_rejected');
      throw error;
    });
    return instance.interceptors.request.use(async (config) => {
      const url = new URL(config.url, config.baseURL || backendBaseUrl).href;
      if (new URL(url).origin !== targetOrigin) return config;
      assertDestination(url);
      config.headers = await headers(url, config.headers?.toJSON?.() || config.headers);
      config.maxRedirects = 0; // credentials may never follow a redirect to another service.
      return config;
    });
  }
  return Object.freeze({ enabled, audience, targetOrigin, accepts, assertDestination, headers, wrapFetch, installAxios });
}
module.exports = { AUDIENCE_ENV, TARGET_ENV, createPrivateBackendHop };
