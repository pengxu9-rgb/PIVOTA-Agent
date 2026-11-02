'use strict';

// THE SYNTHETIC HOP LINE: one log line for EVERY outgoing HTTP request a synthetic call makes.
//
// A synthetic call (our own eval client, in enforce; syntheticContext.js) must carry its marker on every hop:
// the signed assertion to the backend, the loopback marker to this gateway's own invoke route. The backend logs
// a verdict only for a request that ARRIVES with the assertion, so a hop that lost it would be invisible there.
// This line makes it visible here, at the one place every hop passes: Node's own client-request channels,
// below every HTTP library this process uses:
//   * `http.client.request.start`: every http/https ClientRequest (axios and anything else built on them);
//   * `undici:request:create`: every fetch.
// So no helper can make a hop that escapes the line, whichever helper it is. (gRPC over http2, the Firestore
// client, is neither channel; it is never a backend hop.)
//
// Per hop: `synthetic_hop { gateway_request_id, target, method, host, path, marker }`.
//   * target: `backend` (a host named by the backend base URLs below), `loopback`, or `external`;
//   * marker: for a backend hop, whether X-Pivota-Synthetic-Assertion is attached; for a loopback hop, whether
//     the loopback marker is; null for an external hop (it has no marker to carry). An external hop names its
//     host only: a third-party path or query can carry keys.
// For a run: every backend and loopback hop says `attached`, and per gateway_request_id the backend's
// `synthetic_assertion_accepted` lines equal its `backend` hops. Outside a synthetic call nothing is logged.

const diagnosticsChannel = require('node:diagnostics_channel');
const { INVOKE_AUTH_CONTEXT } = require('./syntheticContext');
const { SYNTHETIC_ASSERTION_HEADER: ASSERTION_HEADER } = require('./syntheticCallers');
const { LOOPBACK_SYNTHETIC_HEADER: LOOPBACK_HEADER } = require('./loopbackCallerAssertion');

const SYNTHETIC_ASSERTION_HEADER = ASSERTION_HEADER.toLowerCase();
const LOOPBACK_SYNTHETIC_HEADER = LOOPBACK_HEADER.toLowerCase();
// Every environment variable that names a backend base URL this gateway calls (comma lists allowed).
const BACKEND_BASE_ENVS = Object.freeze([
  'PIVOTA_API_BASE',
  'PIVOTA_BACKEND_BASE_URL',
  'REVIEWS_API_BASE',
  'REVIEWS_BACKEND_URL',
  'REVIEWS_BACKEND',
  'PROXY_SEARCH_AURORA_API_BASE',
  'PROXY_SEARCH_AURORA_BACKEND_BASE_URL',
  'AURORA_BFF_RECO_BACKEND_BASE_URLS',
]);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function backendHosts(env = process.env) {
  const hosts = new Set();
  for (const name of BACKEND_BASE_ENVS) {
    for (const raw of String(env[name] || '').split(',')) {
      try {
        const u = new URL(raw.trim());
        hosts.add(u.host.toLowerCase());
        // A base without a port names its host on any port; one with a port, only that port.
        if (!u.port) hosts.add(u.hostname.toLowerCase());
      } catch (_) {
        // Not a URL: names no host.
      }
    }
  }
  return hosts;
}

/**
 * The hop line's fields for one outgoing request, or null outside a synthetic call. Pure apart from the store.
 * @param {{ method: string, origin: string, path: string, hasHeader: (name: string) => boolean }} hop
 */
function hopFields(hop, { env = process.env } = {}) {
  const store = INVOKE_AUTH_CONTEXT.getStore();
  if (!store || store.synthetic !== true) return null;
  let url;
  try {
    url = new URL(String(hop.path || '/'), String(hop.origin));
  } catch (_) {
    url = null;
  }
  const hostname = url ? url.hostname.toLowerCase() : null;
  const host = url ? url.host.toLowerCase() : null;
  const backends = backendHosts(env);
  // A backend base wins over loopback: a backend on a loopback port (a local stack, a test) is still the backend.
  let target = 'external';
  if (host && (backends.has(host) || backends.has(hostname))) target = 'backend';
  else if (hostname && LOOPBACK_HOSTNAMES.has(hostname)) target = 'loopback';
  let marker = null;
  if (target === 'backend') marker = hop.hasHeader(SYNTHETIC_ASSERTION_HEADER) ? 'attached' : 'missing';
  if (target === 'loopback') marker = hop.hasHeader(LOOPBACK_SYNTHETIC_HEADER) ? 'attached' : 'missing';
  return {
    gateway_request_id: typeof store.gw_request_id === 'string' ? store.gw_request_id : null,
    target,
    method: String(hop.method || 'GET').toUpperCase(),
    host: hostname,
    path: target === 'external' || !url ? null : url.pathname,
    marker,
  };
}

function undiciHasHeader(headers, name) {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return true;
    return false;
  }
  if (typeof headers === 'string') return headers.split(/\r?\n/).some((line) => line.toLowerCase().startsWith(`${name}:`));
  return Boolean(headers && typeof headers === 'object' && Object.keys(headers).some((k) => k.toLowerCase() === name));
}

let installed = null;

/**
 * Subscribe once per process. A subscriber never throws: a failure to log must never fail the request.
 * @param {{ log: { info: Function }, env?: object }} deps
 */
function installSyntheticHopLog({ log, env = process.env } = {}) {
  if (installed) return installed;
  const emit = (hop) => {
    try {
      const fields = hopFields(hop, { env });
      if (fields) log.info(fields, 'synthetic_hop');
    } catch (_) {
      // Never break a request over its log line.
    }
  };
  const onHttp = ({ request }) => {
    if (!request) return;
    const protocol = request.protocol || 'http:';
    const hostHeader = typeof request.getHeader === 'function' ? request.getHeader('host') : null;
    emit({
      method: request.method,
      origin: `${protocol}//${hostHeader || request.host}`,
      path: request.path,
      hasHeader: (name) => typeof request.getHeader === 'function' && request.getHeader(name) !== undefined,
    });
  };
  const onUndici = ({ request }) => {
    if (!request) return;
    emit({ method: request.method, origin: request.origin, path: request.path, hasHeader: (name) => undiciHasHeader(request.headers, name) });
  };
  diagnosticsChannel.subscribe('http.client.request.start', onHttp);
  diagnosticsChannel.subscribe('undici:request:create', onUndici);
  installed = {
    uninstall() {
      diagnosticsChannel.unsubscribe('http.client.request.start', onHttp);
      diagnosticsChannel.unsubscribe('undici:request:create', onUndici);
      installed = null;
    },
  };
  return installed;
}

module.exports = { BACKEND_BASE_ENVS, backendHosts, hopFields, installSyntheticHopLog };
