'use strict';

// MERCHANT DOOR RELAY — THE GATEWAY SIDE.
//
// WHAT IT IS FOR. Every gateway call to a merchant's UCP door used to leave from the gateway's default egress, which
// is also the address payment partners allowlist. With MERCHANT_DOOR_RELAY=on, merchant-door calls instead go to a
// small internal Cloud Run service (src/services/doorRelay/server.js) that has its own egress and makes the call.
// This module is the fetch-compatible client for that service: `relayFetch(url, options)` takes the same arguments
// as the hardened merchant transport (ucpBuyerAgentClient's createPublicNetworkFetch) and resolves to a WHATWG
// Response, or rejects with the SAME coded errors (PIVOTA_SSRF_REFUSED, PIVOTA_SIZE_CAP, ...), so a caller cannot tell
// which path carried its request.
//
// WHO USES IT. Only merchant-door callers: ucpBuyerAgentClient's default merchant fetch and the Shopify catalog
// attribution client. A payment partner never goes through the relay (tests/door_relay_wiring.node.test.cjs pins the
// list of files that may name this module).
//
// THE TWO HEADER SETS. The relay hop carries `Authorization: Bearer <Google ID token>` (Cloud Run IAM checks it).
// The merchant's own headers — RFC 9421 Signature / Signature-Input / Content-Digest, UCP-Agent, and a merchant
// bearer token when the client is at the token tier — travel INSIDE the JSON body as an ordered list of pairs. The
// relay forwards only that list, so our ID token is never a header the merchant can see.
//
// SWITCH. MERCHANT_DOOR_RELAY = off (default; anything but `on`) | on, plus MERCHANT_DOOR_RELAY_URL (the relay's
// https origin). On with a missing or invalid URL fails CLOSED: door calls reject with PIVOTA_RELAY_UNCONFIGURED.
// They never fall back to the gateway's own egress, which is the address this exists to keep merchants off.

const MERCHANT_DOOR_RELAY_FLAG = 'MERCHANT_DOOR_RELAY';
const MERCHANT_DOOR_RELAY_URL_ENV = 'MERCHANT_DOOR_RELAY_URL';
const RELAY_FETCH_PATH = '/v1/fetch';
// The relay's own total cap is 10 s; the hop waits a little longer so the relay's coded timeout arrives first.
const DEFAULT_HOP_TIMEOUT_MS = 12_000;
// The same bound as ucpBuyerAgentClient's MAX_MERCHANT_RESPONSE_BYTES (a test pins the two equal). Not imported:
// ucpBuyerAgentClient requires this module, and a require cycle would hand one side a half-built export object.
const MAX_MERCHANT_RESPONSE_BYTES = 2 * 1024 * 1024;
const METADATA_IDENTITY_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const ID_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const ID_TOKEN_MAX_LIFETIME_MS = 55 * 60 * 1000;
const ID_TOKEN_FALLBACK_TTL_MS = 10 * 60 * 1000;
const METADATA_TIMEOUT_MS = 3_000;
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
// Codes that mean "the time cap fired". They reach the caller as AbortError, the name every merchant-door caller
// already reads as a timeout (ucpBuyerAgentClient's fetchWithPolicy does not retry it, classifyUcpFailure calls it
// `timeout`).
const TIMEOUT_CODES = new Set(['PIVOTA_RELAY_TIMEOUT']);

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  if (TIMEOUT_CODES.has(code)) error.name = 'AbortError';
  return error;
}

function abortError() {
  // Same shape as createPublicNetworkFetch's abort.
  const error = new Error('merchant endpoint request aborted');
  error.name = 'AbortError';
  return error;
}

/** The switch, read per call. Anything but `on` is off. */
function merchantDoorRelayMode(env = process.env) {
  const v = String((env && env[MERCHANT_DOOR_RELAY_FLAG]) || '').trim().toLowerCase();
  return v === 'on' ? 'on' : 'off';
}

/**
 * The relay's origin, or null. https only, no userinfo, no path beyond `/`, no query or fragment: the value is both
 * the endpoint and the ID token's audience, so anything else is a misconfiguration, refused rather than guessed at.
 */
function validRelayOrigin(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  let parsed;
  try { parsed = new URL(s); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  return parsed.origin;
}

/** Ordered [name, value] pairs from whatever a fetch caller passes as `headers`. */
function headerPairs(headers) {
  if (!headers) return [];
  const pairs = [];
  const push = (name, value) => {
    if (value === undefined || value === null) return;
    pairs.push([String(name), String(value)]);
  };
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    // A WHATWG Headers (or anything shaped like one).
    for (const [name, value] of headers) push(name, value);
  } else if (Array.isArray(headers)) {
    for (const entry of headers) if (Array.isArray(entry) && entry.length === 2) push(entry[0], entry[1]);
  } else if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) push(name, value);
  }
  return pairs;
}

function bodyBase64(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8').toString('base64');
  if (Buffer.isBuffer(body)) return body.toString('base64');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('base64');
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64');
  throw codedError('merchant door relay carries string or byte bodies only', 'PIVOTA_RELAY_BAD_REQUEST');
}

function jwtExpiryMs(token) {
  try {
    const part = token.split('.')[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(json.exp) && json.exp > 0 ? json.exp * 1000 : null;
  } catch { return null; }
}

/**
 * Google ID tokens for an audience, from the Cloud Run metadata server, cached until shortly before expiry. The token
 * is never logged and never leaves this process except as the relay hop's Authorization header.
 */
function createMetadataIdTokenProvider({
  fetchImpl = (...a) => globalThis.fetch(...a),
  now = Date.now,
  refreshSkewMs = ID_TOKEN_REFRESH_SKEW_MS,
  timeoutMs = METADATA_TIMEOUT_MS,
} = {}) {
  const cache = new Map(); // audience -> { token, refreshAtMs }
  const inflight = new Map(); // audience -> Promise<string>
  async function mint(audience) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    let token = null;
    try {
      const res = await fetchImpl(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`, {
        method: 'GET',
        headers: { 'Metadata-Flavor': 'Google' },
        redirect: 'error',
        signal: ac.signal,
      });
      if (res && res.status === 200) {
        const text = (await res.text()).trim();
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) token = text;
      }
    } catch {
      token = null;
    } finally {
      clearTimeout(timer);
    }
    if (!token) throw codedError('merchant door relay identity token unavailable', 'PIVOTA_RELAY_IDENTITY');
    const t = now();
    const exp = jwtExpiryMs(token);
    const refreshAtMs = exp === null
      ? t + ID_TOKEN_FALLBACK_TTL_MS
      : Math.min(exp - refreshSkewMs, t + ID_TOKEN_MAX_LIFETIME_MS);
    if (refreshAtMs <= t) throw codedError('merchant door relay identity token unavailable', 'PIVOTA_RELAY_IDENTITY');
    cache.set(audience, { token, refreshAtMs });
    return token;
  }
  return async function idTokenFor(audience) {
    const hit = cache.get(audience);
    if (hit && now() < hit.refreshAtMs) return hit.token;
    if (!inflight.has(audience)) {
      inflight.set(audience, mint(audience).finally(() => inflight.delete(audience)));
    }
    return inflight.get(audience);
  };
}

function toResponse(envelope, redirectMode) {
  const status = Number(envelope && envelope.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw codedError('merchant door relay answered an unreadable envelope', 'PIVOTA_RELAY_UNAVAILABLE');
  }
  if (status < 200) {
    throw codedError(`merchant endpoint returned an unsupported status ${status}`, 'PIVOTA_UNSUPPORTED_STATUS');
  }
  if (redirectMode === 'error' && status >= 300 && status < 400) {
    throw codedError('merchant endpoint redirected', 'PIVOTA_REDIRECT_REFUSED');
  }
  const headers = new Headers();
  for (const [name, value] of headerPairs(envelope.headers)) {
    try { headers.append(name, value); } catch { /* a header no fetch Response can carry is dropped */ }
  }
  const body = typeof envelope.body_b64 === 'string' ? Buffer.from(envelope.body_b64, 'base64') : Buffer.alloc(0);
  if (body.length > MAX_MERCHANT_RESPONSE_BYTES) {
    throw codedError('merchant endpoint response exceeded the size cap', 'PIVOTA_SIZE_CAP');
  }
  // Null-body statuses as toFetchResponse handles them: `new Response(body, {status: 204})` throws.
  if (status === 204 || status === 205 || status === 304) return new Response(null, { status, headers });
  return new Response(body, { status, headers });
}

/**
 * A fetch-compatible function that sends ONE merchant request through the relay.
 * @param {{
 *   relayUrl: string,                 // the relay's https origin (also the ID token audience)
 *   idTokenProvider?: (audience: string) => Promise<string>,
 *   timeoutMs?: number,               // bound on the whole hop
 *   hopFetch?: Function,              // the fetch that reaches the relay (default: global fetch, read per call)
 * }} config
 */
function createRelayFetch({ relayUrl, idTokenProvider, timeoutMs = DEFAULT_HOP_TIMEOUT_MS, hopFetch } = {}) {
  const origin = validRelayOrigin(relayUrl);
  if (!origin) throw codedError('merchant door relay URL must be an https origin', 'PIVOTA_RELAY_UNCONFIGURED');
  const endpoint = `${origin}${RELAY_FETCH_PATH}`;
  const tokenFor = typeof idTokenProvider === 'function' ? idTokenProvider : createMetadataIdTokenProvider();
  const send = typeof hopFetch === 'function' ? hopFetch : (...a) => globalThis.fetch(...a);

  return async function relayFetch(url, options = {}) {
    const signal = options.signal;
    if (signal && signal.aborted) throw abortError();
    const payload = JSON.stringify({
      url: String(url),
      method: String(options.method || 'GET').toUpperCase(),
      headers: headerPairs(options.headers),
      body_b64: bodyBase64(options.body),
    });

    const ac = new AbortController();
    let hopTimedOut = false;
    const timer = setTimeout(() => { hopTimedOut = true; ac.abort(); }, timeoutMs);
    timer.unref?.();
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const failed = (fallback) => {
      if (signal && signal.aborted) return abortError();
      if (hopTimedOut) return codedError('merchant door relay timed out', 'PIVOTA_RELAY_TIMEOUT');
      return fallback;
    };
    try {
      let token;
      try {
        token = await Promise.race([
          tokenFor(origin),
          new Promise((_, reject) => {
            if (ac.signal.aborted) reject(abortError());
            ac.signal.addEventListener('abort', () => reject(abortError()), { once: true });
          }),
        ]);
      } catch (error) {
        throw failed(error && error.code ? error : codedError('merchant door relay identity token unavailable', 'PIVOTA_RELAY_IDENTITY'));
      }
      let hop;
      let text;
      try {
        hop = await send(endpoint, {
          method: 'POST',
          // The ONLY place the ID token goes. The merchant's headers are inside `payload`.
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: payload,
          // The relay never redirects; a 3xx on the hop is a fault, not a hop to take with our token.
          redirect: 'error',
          signal: ac.signal,
        });
        text = await hop.text();
      } catch {
        throw failed(codedError('merchant door relay unreachable', 'PIVOTA_RELAY_UNAVAILABLE'));
      }
      let envelope = null;
      try { envelope = JSON.parse(text); } catch { envelope = null; }
      if (hop.status !== 200) {
        const code = envelope && typeof envelope.error_code === 'string' && ERROR_CODE_RE.test(envelope.error_code)
          ? envelope.error_code
          : null;
        if (!code) {
          // Cloud Run's own refusals (401/403 on IAM, 429, 503) have no envelope.
          const error = codedError('merchant door relay unavailable', 'PIVOTA_RELAY_UNAVAILABLE');
          error.relayStatus = hop.status;
          throw error;
        }
        const message = typeof envelope.message === 'string' && envelope.message.length <= 200
          ? envelope.message
          : 'merchant door relay refused the request';
        throw codedError(message, code);
      }
      return toResponse(envelope, options.redirect);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

// One relay fetch per relay origin per process, so the ID token cache is shared by every client built from env.
const relayFetchByOrigin = new Map();
const warnedKeys = new Set();
let moduleLogger;
function defaultLogger() {
  if (moduleLogger === undefined) {
    try { moduleLogger = require('../../logger'); } catch { moduleLogger = null; }
  }
  return moduleLogger;
}

function refusingFetch() {
  return async () => {
    throw codedError('merchant door relay is on but has no valid URL', 'PIVOTA_RELAY_UNCONFIGURED');
  };
}

/**
 * The merchant-door fetch the environment asks for: null when the relay is off (the caller keeps its own transport,
 * unchanged), the relay fetch when it is on with a valid URL, and a fetch that always refuses when it is on without
 * one. The URL's value is never logged.
 */
function merchantDoorFetchFromEnv({ env = process.env, logger } = {}) { // logger: { warn } or () => { warn }
  if (merchantDoorRelayMode(env) !== 'on') return null;
  const origin = validRelayOrigin(env && env[MERCHANT_DOOR_RELAY_URL_ENV]);
  if (!origin) {
    // `logger` may be a thunk, so a caller with the relay off never resolves (or loads) a logger at all.
    const given = typeof logger === 'function' ? logger() : logger;
    const log = given && typeof given.warn === 'function' ? given : defaultLogger();
    if (!warnedKeys.has('unconfigured') && log && typeof log.warn === 'function') {
      warnedKeys.add('unconfigured');
      log.warn({ event: 'merchant_door_relay_unconfigured', flag: MERCHANT_DOOR_RELAY_FLAG },
        'merchant door relay is on but MERCHANT_DOOR_RELAY_URL is missing or not an https origin; door calls refuse');
    }
    return refusingFetch();
  }
  let fetchFn = relayFetchByOrigin.get(origin);
  if (!fetchFn) {
    fetchFn = createRelayFetch({ relayUrl: origin });
    relayFetchByOrigin.set(origin, fetchFn);
  }
  return fetchFn;
}

/** Tests only: forget the per-process relay fetches and the warn-once state. */
function resetMerchantDoorRelayState() {
  relayFetchByOrigin.clear();
  warnedKeys.clear();
}

module.exports = {
  MERCHANT_DOOR_RELAY_FLAG,
  MERCHANT_DOOR_RELAY_URL_ENV,
  RELAY_FETCH_PATH,
  MAX_MERCHANT_RESPONSE_BYTES,
  METADATA_IDENTITY_URL,
  merchantDoorRelayMode,
  validRelayOrigin,
  headerPairs,
  createMetadataIdTokenProvider,
  createRelayFetch,
  merchantDoorFetchFromEnv,
  resetMerchantDoorRelayState,
};
