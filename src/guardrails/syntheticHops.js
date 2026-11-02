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
//
// A hop is attributed to the invoke store active when its request is FINISHED: http publishes from
// ClientRequest._finish (req.end()), undici at the end of the Request constructor, both after the headers are
// final. A real request costs one store lookup here and nothing else: the subscribers return before they touch it.

const diagnosticsChannel = require('node:diagnostics_channel');
const { INVOKE_AUTH_CONTEXT } = require('./syntheticContext');
const { SYNTHETIC_ASSERTION_HEADER: ASSERTION_HEADER } = require('./syntheticCallers');
const { LOOPBACK_SYNTHETIC_HEADER: LOOPBACK_HEADER } = require('./loopbackCallerAssertion');

const SYNTHETIC_ASSERTION_HEADER = ASSERTION_HEADER.toLowerCase();
const LOOPBACK_SYNTHETIC_HEADER = LOOPBACK_HEADER.toLowerCase();
// Every environment variable that names a backend base URL this gateway calls (lists split as
// src/auroraBff/routes.js splits them).
const BACKEND_BASE_ENVS = Object.freeze([
  'PIVOTA_API_BASE',
  'PIVOTA_BACKEND_BASE_URL',
  'REVIEWS_API_BASE',
  'REVIEWS_BACKEND_URL',
  'REVIEWS_BACKEND',
  'PROXY_SEARCH_AURORA_API_BASE',
  'PROXY_SEARCH_AURORA_BACKEND_BASE_URL',
  'AURORA_BFF_RECO_BACKEND_BASE_URLS',
  'AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS',
]);
// server.js's own default when PIVOTA_API_BASE is unset.
const DEFAULT_PIVOTA_API_BASE = 'http://localhost:8080';
const LIST_SPLIT = /[\s,;|]+/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// A hostname without a trailing dot ("api.test." is "api.test"), lower-cased.
function normalHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '');
}

// Memoised on the variables' values: recomputed only when one of them changes.
let hostsMemo = { key: null, hosts: null };
function backendHosts(env = process.env) {
  const values = BACKEND_BASE_ENVS.map((name) => {
    const v = String(env[name] || '').trim();
    return name === 'PIVOTA_API_BASE' && !v ? DEFAULT_PIVOTA_API_BASE : v;
  });
  const key = values.join('\n');
  if (hostsMemo.key === key) return hostsMemo.hosts;
  const hosts = new Set();
  for (const value of values) {
    for (const raw of value.split(LIST_SPLIT)) {
      if (!raw) continue;
      try {
        const u = new URL(raw);
        const hostname = normalHostname(u.hostname);
        // A base without a port names its host on any port; one with a port, only that port.
        hosts.add(u.port ? `${hostname}:${u.port}` : hostname);
      } catch (_) {
        // Not a URL: names no host.
      }
    }
  }
  hostsMemo = { key, hosts };
  return hosts;
}

function syntheticStore() {
  const store = INVOKE_AUTH_CONTEXT.getStore();
  return store && store.synthetic === true ? store : null;
}

/**
 * The hop line's fields for one outgoing request, or null outside a synthetic call.
 * @param {{ method: string, origin: string, path: string, hasHeader: (name: string) => boolean }} hop
 * @param {{ env?: object, store?: object }} [opts] store: the synthetic store, when the caller already read it.
 */
function hopFields(hop, { env = process.env, store = syntheticStore() } = {}) {
  if (!store || store.synthetic !== true) return null;
  let url;
  try {
    url = new URL(String(hop.path || '/'), String(hop.origin));
  } catch (_) {
    url = null;
  }
  const hostname = url ? normalHostname(url.hostname) : null;
  const host = url ? (url.port ? `${hostname}:${url.port}` : hostname) : null;
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

// Node's undici hands the request headers over as a flat [name, value, ...] array. Anything else reads as no
// header, so a marker can only ever be reported missing, never attached, by mistake.
function undiciHasHeader(headers, name) {
  if (!Array.isArray(headers)) return false;
  for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return true;
  return false;
}

let installed = null;

/**
 * Subscribe once per process. A subscriber never throws: a failure to log must never fail the request.
 * @param {{ log: { info: Function }, env?: object }} deps
 */
function installSyntheticHopLog({ log, env = process.env } = {}) {
  if (installed) return installed;
  // Each handler: the store FIRST, and back out of a real request before touching it; the whole body in a
  // try, since a subscriber's throw becomes an uncaughtException and would take the process down.
  const onHttp = (message) => {
    try {
      const store = syntheticStore();
      if (!store) return;
      const request = message && message.request;
      if (!request) return;
      const protocol = request.protocol || 'http:';
      const hostHeader = typeof request.getHeader === 'function' ? request.getHeader('host') : null;
      const fields = hopFields({
        method: request.method,
        origin: `${protocol}//${hostHeader || request.host}`,
        path: request.path,
        hasHeader: (name) => typeof request.getHeader === 'function' && request.getHeader(name) !== undefined,
      }, { env, store });
      if (fields) log.info(fields, 'synthetic_hop');
    } catch (_) {
      // Never break a request, or the process, over its log line.
    }
  };
  const onUndici = (message) => {
    try {
      const store = syntheticStore();
      if (!store) return;
      const request = message && message.request;
      if (!request) return;
      const fields = hopFields(
        { method: request.method, origin: request.origin, path: request.path, hasHeader: (name) => undiciHasHeader(request.headers, name) },
        { env, store },
      );
      if (fields) log.info(fields, 'synthetic_hop');
    } catch (_) {
      // Never break a request, or the process, over its log line.
    }
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

module.exports = { BACKEND_BASE_ENVS, DEFAULT_PIVOTA_API_BASE, backendHosts, hopFields, installSyntheticHopLog };
