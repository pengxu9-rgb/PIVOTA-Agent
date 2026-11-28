'use strict';

// MERCHANT DOOR RELAY — THE RELAY SERVICE. Run as `node src/services/doorRelay/server.js` on its own internal Cloud
// Run service, whose egress (subnet, NAT, address) is not the gateway's. The gateway's merchant-door calls arrive here
// (src/services/doorRelay/relayFetch.js) and leave from here.
//
//   GET  /healthz   -> 200
//   POST /v1/fetch  {url, method, headers: [[name, value], ...], body_b64}
//                -> 200 {status, headers: [[name, value], ...], body_b64}     the merchant answered (any status)
//                -> 4xx/5xx {error_code, message}                             refused or failed, with the SAME codes
//                                                                              the gateway's own transport uses
//
// WHAT IT ENFORCES (each one also holds in the gateway's transport, and is re-checked here because this process is
// the one that opens the socket): https on port 443 only; no userinfo; GET and POST only; never a forbidden name
// (metadata, cluster, Cloud Run, wildcard-IP DNS) or a non-public literal; DNS resolved HERE through the public-only
// lookup, so a name that rebinds to a private address cannot pivot into this service's VPC; a 2 MB response cap; a
// total time cap. The outbound request is made by createPublicNetworkFetch itself, not a copy of it.
//
// REDIRECTS ARE NEVER FOLLOWED. A 3xx goes back to the caller with its Location, and the caller's own redirect rule
// applies there. The relay adds no hop of its own.
//
// HEADERS. Only the JSON `headers` list is forwarded, in its order, with its names as given, minus hop-by-hop headers.
// The headers of the request that reached THIS service (the gateway's Google ID token in Authorization, Cloud Run's
// forwarding headers) are never forwarded: by construction they are not in the list. A list entry whose value equals
// this request's own Authorization is refused, so a caller bug cannot copy our token to a merchant.
//
// LOGS. One line per call: method, target HOST, status, bytes, ms, error_code. Never the path, the query, a header or
// a body (continue_url and tokens live there).
//
// NO SECRETS. This service holds and reads none. It reads PORT and its own numeric caps, nothing else from the
// environment (tests/door_relay_server.node.test.cjs pins the list).

const nodeDns = require('node:dns');
const nodeHttp = require('node:http');
const {
  createPublicNetworkFetch,
  forbiddenHostName,
  forbiddenLiteralHost,
} = require('../ucpBuyerAgentClient');

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 8192;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_BYTES = 64 * 1024;
const ALLOWED_METHODS = new Set(['GET', 'POST']);
// Hop-by-hop (RFC 9110 7.6.1) plus the ones this hop must set itself: `host` comes from the URL, `expect` would invite
// a 1xx, and X-Serverless-Authorization is Cloud Run's alternative to Authorization for its own IAM.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'expect', 'x-serverless-authorization',
]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const REFUSAL_STATUS = Object.freeze({
  PIVOTA_RELAY_BAD_REQUEST: 400,
  PIVOTA_RELAY_REQUEST_TOO_LARGE: 413,
  PIVOTA_RELAY_SCHEME: 403,
  PIVOTA_RELAY_PORT: 403,
  PIVOTA_RELAY_METHOD: 403,
  PIVOTA_SSRF_LITERAL: 403,
  PIVOTA_SSRF_NAME: 403,
  PIVOTA_SSRF_REFUSED: 403,
  PIVOTA_SIZE_CAP: 502,
  PIVOTA_UNSUPPORTED_STATUS: 502,
  PIVOTA_REDIRECT_REFUSED: 502,
  PIVOTA_RELAY_TIMEOUT: 504,
});
// Messages are fixed per code: an upstream error's own message can carry the URL.
const REFUSAL_MESSAGE = Object.freeze({
  PIVOTA_RELAY_BAD_REQUEST: 'relay request is malformed',
  PIVOTA_RELAY_REQUEST_TOO_LARGE: 'relay request exceeded the size cap',
  PIVOTA_RELAY_SCHEME: 'merchant endpoint must be https',
  PIVOTA_RELAY_PORT: 'merchant endpoint must be on port 443',
  PIVOTA_RELAY_METHOD: 'merchant endpoint method must be GET or POST',
  PIVOTA_SSRF_LITERAL: 'merchant endpoint must resolve to a public address',
  PIVOTA_SSRF_NAME: 'merchant endpoint host is never a merchant',
  PIVOTA_SSRF_REFUSED: 'merchant endpoint resolved to a non-public address',
  PIVOTA_SIZE_CAP: 'merchant endpoint response exceeded the size cap',
  PIVOTA_UNSUPPORTED_STATUS: 'merchant endpoint returned an unsupported status',
  PIVOTA_REDIRECT_REFUSED: 'merchant endpoint redirected',
  PIVOTA_RELAY_TIMEOUT: 'merchant endpoint did not answer within the relay time cap',
});
const ERRNO_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function refusal(code) {
  const error = new Error(REFUSAL_MESSAGE[code] || 'relay request refused');
  error.code = code;
  return error;
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The only environment this service reads: a port and two numeric caps. */
function configFromEnv() {
  return {
    port: positiveInt(process.env.PORT, DEFAULT_PORT),
    timeoutMs: positiveInt(process.env.DOOR_RELAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxBodyBytes: positiveInt(process.env.DOOR_RELAY_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES),
  };
}

function defaultLogLine(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** Validate the target URL with fixed messages (normalizeBaseUrl's echo the URL). */
function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL_LENGTH) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
  let parsed;
  try { parsed = new URL(raw); } catch { throw refusal('PIVOTA_RELAY_BAD_REQUEST'); }
  if (parsed.protocol !== 'https:') throw refusal('PIVOTA_RELAY_SCHEME');
  if (parsed.username || parsed.password) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
  // WHATWG URL drops a default port, so `https://host:443/` arrives here with port ''. Anything else is refused.
  if (parsed.port !== '') throw refusal('PIVOTA_RELAY_PORT');
  if (forbiddenLiteralHost(parsed.hostname)) throw refusal('PIVOTA_SSRF_LITERAL');
  if (forbiddenHostName(parsed.hostname)) throw refusal('PIVOTA_SSRF_NAME');
  return parsed;
}

/**
 * The headers to send, as an insertion-ordered object (node:https sends names in that order, with their case).
 * Hop-by-hop headers and any header the Connection header names are dropped; a repeated name is joined with ", ".
 */
function forwardableHeaders(list, { relayAuthorization, bodyLength }) {
  if (list === undefined || list === null) return {};
  if (!Array.isArray(list) || list.length > MAX_HEADER_COUNT) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
  let total = 0;
  const pairs = [];
  for (const entry of list) {
    if (!Array.isArray(entry) || entry.length !== 2) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
    const [name, value] = entry;
    if (typeof name !== 'string' || typeof value !== 'string') throw refusal('PIVOTA_RELAY_BAD_REQUEST');
    if (!HEADER_NAME_RE.test(name) || !HEADER_VALUE_RE.test(value)) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
    total += name.length + value.length;
    if (total > MAX_HEADER_BYTES) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
    pairs.push([name, value]);
  }
  const named = new Set();
  for (const [name, value] of pairs) {
    if (name.toLowerCase() === 'connection') {
      for (const token of value.split(',')) if (token.trim()) named.add(token.trim().toLowerCase());
    }
  }
  const out = {};
  const keyOf = new Map(); // lower-case name -> the key used in `out`
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    if (lower === 'authorization' && relayAuthorization && value === relayAuthorization) {
      // Our own ID token in the merchant's header list: a caller bug. Refuse rather than strip, so it is seen.
      throw refusal('PIVOTA_RELAY_BAD_REQUEST');
    }
    if (lower === 'content-length') {
      // Kept only when it states the body we send; the transport frames the body otherwise.
      if (String(bodyLength) !== value.trim()) continue;
    }
    if (keyOf.has(lower)) {
      const key = keyOf.get(lower);
      out[key] = `${out[key]}, ${value}`;
    } else {
      keyOf.set(lower, name);
      out[name] = value;
    }
  }
  return out;
}

function decodeBody(raw, maxBodyBytes) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !BASE64_RE.test(raw) || raw.length % 4 !== 0) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
  if (Math.floor(raw.length / 4) * 3 > maxBodyBytes + 2) throw refusal('PIVOTA_RELAY_REQUEST_TOO_LARGE');
  const body = Buffer.from(raw, 'base64');
  if (body.length > maxBodyBytes) throw refusal('PIVOTA_RELAY_REQUEST_TOO_LARGE');
  return body;
}

function readRequestBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > cap) {
        done = true;
        reject(refusal('PIVOTA_RELAY_REQUEST_TOO_LARGE'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (error) => { if (!done) { done = true; reject(error); } });
  });
}

function sendJson(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** The code a failure reaches the gateway with: ours as-is, an errno (ECONNRESET, ENOTFOUND, a TLS code) as-is. */
function errorCodeOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code && Object.prototype.hasOwnProperty.call(REFUSAL_STATUS, code)) return code;
  if (code && ERRNO_CODE_RE.test(code)) return code;
  return 'PIVOTA_RELAY_UPSTREAM';
}

/**
 * The request handler. Everything that touches the network is injectable; tests inject `transport` (a fake upstream)
 * or `lookup` (a fake resolver behind the real transport) and never reach a real host.
 * @param {{
 *   transport?: (url: string, init: object) => Promise<Response>,  // default createPublicNetworkFetch(lookup)
 *   lookup?: Function,                                             // default dns.lookup, behind the public-only lookup
 *   log?: (entry: object) => void,
 *   timeoutMs?: number,
 *   maxBodyBytes?: number,
 *   now?: () => number,
 * }} [options]
 */
function createDoorRelayHandler(options = {}) {
  const transport = typeof options.transport === 'function'
    ? options.transport
    : createPublicNetworkFetch(options.lookup || nodeDns.lookup);
  const log = typeof options.log === 'function' ? options.log : defaultLogLine;
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBodyBytes = positiveInt(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  // JSON overhead on top of a base64 body: the URL, the header list, the keys.
  const maxRequestBytes = Math.ceil(maxBodyBytes / 3) * 4 + MAX_URL_LENGTH + MAX_HEADER_BYTES * 2 + 4096;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  async function relay(req, res) {
    const started = now();
    const line = { event: 'door_relay_fetch', severity: 'INFO', method: null, host: null, status: null, bytes: 0, ms: 0, error_code: null };
    const finish = (fields) => {
      Object.assign(line, fields, { ms: Math.max(0, now() - started) });
      if (line.error_code) line.severity = 'WARNING';
      try { log(line); } catch { /* a broken logger never breaks a call */ }
    };

    let target;
    let init;
    try {
      const raw = await readRequestBody(req, maxRequestBytes);
      let request;
      try { request = JSON.parse(raw.toString('utf8')); } catch { throw refusal('PIVOTA_RELAY_BAD_REQUEST'); }
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw refusal('PIVOTA_RELAY_BAD_REQUEST');
      const method = typeof request.method === 'string' ? request.method.toUpperCase() : 'GET';
      if (!ALLOWED_METHODS.has(method)) throw refusal('PIVOTA_RELAY_METHOD');
      line.method = method;
      target = parseTarget(request.url);
      line.host = target.hostname;
      const body = decodeBody(request.body_b64, maxBodyBytes);
      if (body && method === 'GET') throw refusal('PIVOTA_RELAY_BAD_REQUEST');
      const headers = forwardableHeaders(request.headers, {
        relayAuthorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
        bodyLength: body ? body.length : 0,
      });
      init = { method, headers, body };
    } catch (error) {
      const code = errorCodeOf(error);
      const status = REFUSAL_STATUS[code] || 400;
      finish({ status, error_code: code });
      sendJson(res, status, { error_code: code, message: REFUSAL_MESSAGE[code] || 'relay request refused' });
      return;
    }

    // One total time cap over connect, send and the buffered response. The caller hanging up aborts too.
    const ac = new AbortController();
    let timedOut = false;
    let callerGone = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    timer.unref?.();
    const onClose = () => { if (!res.writableEnded) { callerGone = true; ac.abort(); } };
    res.once('close', onClose);
    try {
      // No `redirect` option: the transport then neither follows nor refuses a 3xx, it returns it.
      const answer = await transport(target.toString(), { ...init, signal: ac.signal });
      const bodyBuffer = Buffer.from(await answer.arrayBuffer());
      const headers = [];
      for (const [name, value] of answer.headers) headers.push([name, value]);
      finish({ status: answer.status, bytes: bodyBuffer.length });
      sendJson(res, 200, { status: answer.status, headers, body_b64: bodyBuffer.toString('base64') });
    } catch (error) {
      if (callerGone) {
        finish({ error_code: 'PIVOTA_RELAY_CALLER_GONE' });
        return;
      }
      const code = timedOut ? 'PIVOTA_RELAY_TIMEOUT' : errorCodeOf(error);
      const status = REFUSAL_STATUS[code] || 502;
      finish({ status, error_code: code });
      sendJson(res, status, {
        error_code: code,
        message: REFUSAL_MESSAGE[code] || `merchant endpoint request failed (${code})`,
      });
    } finally {
      clearTimeout(timer);
      res.removeListener('close', onClose);
    }
  }

  return function doorRelayHandler(req, res) {
    // Route on the path alone; the query string is never read or logged.
    const path = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (path === '/v1/fetch') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error_code: 'PIVOTA_RELAY_BAD_REQUEST', message: 'POST only' });
        return;
      }
      relay(req, res).catch(() => {
        sendJson(res, 500, { error_code: 'PIVOTA_RELAY_UPSTREAM', message: 'relay failed' });
      });
      return;
    }
    sendJson(res, 404, { error_code: 'PIVOTA_RELAY_BAD_REQUEST', message: 'not found' });
  };
}

function startDoorRelayServer(config = configFromEnv(), options = {}) {
  const server = nodeHttp.createServer(createDoorRelayHandler({ ...options, timeoutMs: config.timeoutMs, maxBodyBytes: config.maxBodyBytes }));
  // Slow-client bounds on the inbound side; the outbound side has its own time cap.
  server.requestTimeout = config.timeoutMs + 5_000;
  server.headersTimeout = 10_000;
  server.listen(config.port);
  return server;
}

if (require.main === module) {
  const server = startDoorRelayServer();
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

module.exports = {
  createDoorRelayHandler,
  startDoorRelayServer,
  configFromEnv,
  forwardableHeaders,
  parseTarget,
  HOP_BY_HOP,
  REFUSAL_STATUS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
};
