'use strict';

/*
 * reapAgenticPurchaseClient.js — the gateway's client for pivota-backend's Reap agentic purchase
 * rail (`/agent/v2/commerce/reap/purchases`, backend WP4 #2215/#2219/#2251).
 *
 * The contract is the backend's `docs/reap_agentic_routes.md` (byte-exact JSON captured from the real
 * app); `docs/reap-agentic-lane.md` in THIS repo is the door-side half. Two routes are used:
 *
 *   POST /agent/v2/commerce/reap/purchases        -> 202 {purchase_id, status, poll_after_seconds}
 *   GET  /agent/v2/commerce/reap/purchases/{id}   -> the public purchase view (state, totals, hosted_url…)
 *
 * WHAT THIS MODULE IS NOT. It decides nothing about eligibility, prices nothing and builds no checkout.
 * It performs exactly ONE request per call, bounded, and CLASSIFIES the answer into four kinds the lane
 * (mcp-server/src/ucpReapAgenticLane.js) branches on:
 *
 *   accepted        a 2xx whose body carries what the contract says it carries
 *   refused         a 4xx the backend wrote (`detail.error` — the reason code the contract documents),
 *                   including 404 `not_available_on_this_rail` while the backend dial is off
 *   not_found       GET only, and ONLY a 404 whose `detail.error` is `purchase_not_found`: the purchase does not
 *                   exist or is not this buyer's (the backend answers both alike ON PURPOSE, so an id cannot be
 *                   probed). The door answers it the way it answers any unknown checkout id
 *   unavailable     transport error, timeout, 5xx, a 2xx body that is not the documented shape, and on GET every
 *                   OTHER 4xx — 401/403/429/400, and 404 `not_available_on_this_rail` (the dial turned off
 *                   mid-purchase). NEVER a terminal or "unknown" statement about the purchase: it may exist and
 *                   be progressing, and "unknown" would invite a re-create, i.e. a second purchase
 *   unauthenticated the caller's request context carried no agent API key or no buyer user token. No request
 *                   is made: the backend would 401 it, and the INTERNAL key is never substituted (see AUTH)
 *
 * AUTH — NOT A NEW CREDENTIAL. The backend authenticates the calling AGENT (`X-API-Key`) and the END USER
 * (`X-Agent-User-JWT`), and scopes every purchase to that pair in SQL. The headers are supplied by the host
 * (`authHeaders()`), which in production is `src/server.js::buildInvokeUpstreamAuthHeaders` — the SAME
 * function every strict money op already uses, reading the SAME per-request context — called with
 * `allowInternalFallback: false`. That flag is load-bearing: the internal key would open the purchase under
 * Pivota's own agent id, i.e. for a buyer the calling agent could then never read back, and under an identity
 * the buyer never consented to. So a context with no caller key is `unauthenticated`, not a fallback.
 *
 * BUDGET. The edge resets a response whose first byte is later than ~13 s, and this runs INSIDE a checkout
 * tools/call. One attempt, `timeoutMs` (default 2000, clamped to [50, 2000]) covering connect + headers +
 * body. The timer is deliberately NOT unref()'d (src/services/merchantVariantSource.js `withTimeout` records
 * why: an unref'd timer behind an awaited promise lets the loop drain and the deadline never fires). Both exits
 * clear it.
 *
 * PII. The POST body carries the buyer's email and shipping address — it has to, that is the rail. They go to
 * the backend and NOWHERE else: nothing here logs a body, a header, a URL path segment carrying an id, or a
 * response body. Logs carry an event name, a route label, an HTTP status and a reason code.
 */

const PURCHASES_PATH = '/agent/v2/commerce/reap/purchases';
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 50;
const PURCHASE_ID_RE = /^rp_[0-9a-f]{24}$/;
// The backend's reason vocabulary is snake_case. Anything else is not echoed into a log or a decision.
const REASON_CODE_RE = /^[a-z0-9_]{1,64}$/;
// A response body larger than this is not the documented shape (the largest documented body is < 2 KB).
const MAX_BODY_CHARS = 64 * 1024;

const KIND = Object.freeze({
  accepted: 'accepted',
  refused: 'refused',
  notFound: 'not_found',
  unavailable: 'unavailable',
  unauthenticated: 'unauthenticated',
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

function headerValue(headers, name) {
  if (!isPlainObject(headers)) return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted && nonEmpty(value)) return value.trim();
  }
  return '';
}

/** The reason code the backend wrote, from its house error envelope (`detail.error`), or null. */
function reasonCodeOf(body) {
  const detail = isPlainObject(body) ? body.detail : null;
  const code = isPlainObject(detail) ? detail.error : null;
  return typeof code === 'string' && REASON_CODE_RE.test(code) ? code : null;
}

function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_BODY_CHARS) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {{
 *   baseUrl: string,
 *   authHeaders: () => object,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   logger?: { info?: Function, warn?: Function },
 * }} deps
 */
function createReapAgenticPurchaseClient(deps = {}) {
  const baseUrl = String(deps.baseUrl || '').trim().replace(/\/+$/, '');
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const authHeaders = typeof deps.authHeaders === 'function' ? deps.authHeaders : () => ({});
  const timeoutMs = clampTimeout(deps.timeoutMs);
  const logger = deps.logger && typeof deps.logger.warn === 'function' ? deps.logger : null;

  function log(level, fields) {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.warn;
    try {
      fn.call(logger, { event: 'reap_agentic_backend_call', ...fields }, 'reap agentic backend call');
    } catch {
      // a logging failure must never change a checkout answer
    }
  }

  /** The two required headers, or null. Read per call: they come from the REQUEST's context. */
  function requestHeaders() {
    let supplied;
    try {
      supplied = authHeaders();
    } catch {
      supplied = null;
    }
    const apiKey = headerValue(supplied, 'X-API-Key');
    const userJwt = headerValue(supplied, 'X-Agent-User-JWT');
    if (!apiKey || !userJwt) return null;
    const out = { 'X-API-Key': apiKey, 'X-Agent-User-JWT': userJwt, Accept: 'application/json' };
    // Carried when the host supplies it (the strict lane sends `Authorization: Bearer <agent key>` beside
    // X-API-Key). Never synthesised here.
    const authorization = headerValue(supplied, 'Authorization');
    if (authorization) out.Authorization = authorization;
    return out;
  }

  /** ONE bounded request. Resolves `{ status, body }` or `{ error: 'timeout'|'transport' }`; never throws. */
  async function send(route, url, init) {
    if (!baseUrl || typeof fetchImpl !== 'function') return { error: 'unconfigured' };
    const controller = new AbortController();
    // NOT unref()'d — see the header note. Cleared on every exit below.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
      const status = Number(res && res.status);
      let text = '';
      try {
        text = typeof res.text === 'function' ? await res.text() : '';
      } catch {
        text = '';
      }
      return { status, body: parseJson(text) };
    } catch (err) {
      const aborted = controller.signal.aborted || (err && err.name === 'AbortError');
      return { error: aborted ? 'timeout' : 'transport' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Does THIS request's context carry both credentials the rail needs? Makes no request. */
  function hasCallerCredentials() {
    return requestHeaders() !== null;
  }

  /**
   * Open a purchase. `body` is the backend's request shape, already built by the lane; it is sent as-is and
   * never logged.
   */
  async function startPurchase(body) {
    const headers = requestHeaders();
    if (!headers) {
      log('info', { route: 'start', outcome: KIND.unauthenticated });
      return { kind: KIND.unauthenticated };
    }
    const out = await send('start', `${baseUrl}${PURCHASES_PATH}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (out.error) {
      log('warn', { route: 'start', outcome: KIND.unavailable, code: out.error });
      return { kind: KIND.unavailable, code: out.error };
    }
    if (out.status >= 200 && out.status < 300) {
      const b = out.body;
      if (isPlainObject(b) && typeof b.purchase_id === 'string' && PURCHASE_ID_RE.test(b.purchase_id)
        && nonEmpty(b.status)) {
        log('info', { route: 'start', outcome: KIND.accepted, http_status: out.status });
        return {
          kind: KIND.accepted,
          purchase: {
            id: b.purchase_id,
            state: b.status.trim(),
            poll_after_seconds: b.poll_after_seconds,
          },
        };
      }
      log('warn', { route: 'start', outcome: KIND.unavailable, code: 'malformed', http_status: out.status });
      return { kind: KIND.unavailable, code: 'malformed' };
    }
    if (out.status >= 400 && out.status < 500) {
      const code = reasonCodeOf(out.body) || `http_${out.status}`;
      log('info', { route: 'start', outcome: KIND.refused, code, http_status: out.status });
      return { kind: KIND.refused, code, http_status: out.status };
    }
    const code = Number.isFinite(out.status) && out.status >= 500 ? 'http_5xx' : 'http_unexpected';
    log('warn', { route: 'start', outcome: KIND.unavailable, code, http_status: out.status });
    return { kind: KIND.unavailable, code };
  }

  /** Read one purchase the calling agent + buyer own. */
  async function getPurchase(purchaseId) {
    // Validated HERE as well as in the lane: this string becomes a URL path segment, and a value that is not
    // exactly the backend's id shape (`rp_` + 24 hex) is never sent anywhere.
    if (typeof purchaseId !== 'string' || !PURCHASE_ID_RE.test(purchaseId)) {
      return { kind: KIND.notFound, code: 'invalid_id' };
    }
    const headers = requestHeaders();
    if (!headers) {
      log('info', { route: 'get', outcome: KIND.unauthenticated });
      return { kind: KIND.unauthenticated };
    }
    const out = await send('get', `${baseUrl}${PURCHASES_PATH}/${purchaseId}`, { method: 'GET', headers });
    if (out.error) {
      log('warn', { route: 'get', outcome: KIND.unavailable, code: out.error });
      return { kind: KIND.unavailable, code: out.error };
    }
    if (out.status >= 200 && out.status < 300) {
      if (isPlainObject(out.body)) {
        log('info', { route: 'get', outcome: KIND.accepted, http_status: out.status });
        return { kind: KIND.accepted, purchase: out.body };
      }
      log('warn', { route: 'get', outcome: KIND.unavailable, code: 'malformed', http_status: out.status });
      return { kind: KIND.unavailable, code: 'malformed' };
    }
    if (out.status === 404 && reasonCodeOf(out.body) === 'purchase_not_found') {
      log('info', { route: 'get', outcome: KIND.notFound, code: 'purchase_not_found', http_status: 404 });
      return { kind: KIND.notFound, code: 'purchase_not_found', http_status: 404 };
    }
    if (out.status >= 400 && out.status < 500) {
      const code = reasonCodeOf(out.body) || `http_${out.status}`;
      log('warn', { route: 'get', outcome: KIND.unavailable, code, http_status: out.status });
      return { kind: KIND.unavailable, code, http_status: out.status };
    }
    const code = Number.isFinite(out.status) && out.status >= 500 ? 'http_5xx' : 'http_unexpected';
    log('warn', { route: 'get', outcome: KIND.unavailable, code, http_status: out.status });
    return { kind: KIND.unavailable, code };
  }

  return { startPurchase, getPurchase, hasCallerCredentials, timeoutMs };
}

module.exports = {
  KIND,
  PURCHASES_PATH,
  PURCHASE_ID_RE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  createReapAgenticPurchaseClient,
};
