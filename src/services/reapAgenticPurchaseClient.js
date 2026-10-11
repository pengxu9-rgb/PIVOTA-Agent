'use strict';

/*
 * reapAgenticPurchaseClient.js — the gateway's client for pivota-backend's Reap agentic purchase
 * rail (`/agent/v2/commerce/reap/purchases`, backend WP4 #2215/#2219/#2251).
 *
 * The contract is the backend's `docs/reap_agentic_routes.md` (byte-exact JSON captured from the real
 * app); `docs/reap-agentic-lane.md` in THIS repo is the door-side half. Five routes are used:
 *
 *   POST /agent/v2/commerce/reap/purchases        -> 202 {purchase_id, status, poll_after_seconds}
 *   GET  /agent/v2/commerce/reap/purchases/{id}   -> the public purchase view (state, totals, hosted_url…)
 *   POST /agent/v2/commerce/reap/purchases/prepare -> read-only authoritative selection
 *   POST /agent/v2/commerce/reap/purchases/recover -> read-only original-body/key owner lookup
 *   POST /agent/v2/commerce/reap/purchases/{id}/resume -> same-attempt enrollment continuation
 *
 * WHAT THIS MODULE IS NOT. It decides nothing about eligibility, prices nothing and builds no checkout.
 * It performs exactly ONE request per call, bounded, and CLASSIFIES the answer into four kinds the lane
 * (mcp-server/src/ucpReapAgenticLane.js) branches on:
 *
 *   accepted        a 2xx whose body carries what the contract says it carries
 *   refused         a 4xx the backend wrote (`detail.error` — the reason code the contract documents),
 *                   including 404 `not_available_on_this_rail` while the backend dial is off
 *   not_found       GET or read-only recover, and ONLY a 404 whose `detail.error` is `purchase_not_found`: the purchase does not
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

const { readSelectionWitness } = require('./reapSelectionWitness');
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

// Exact create refusal vocabulary/statuses from backend routes/agent_commerce_reap.py
// _REFUSAL_STATUS. Gate/auth responses stay unavailable in every transport;
// they never authorize a different spending lane.
const CREATE_REFUSALS = Object.freeze({
  invalid_request: 400, invalid_address: 400, invalid_return_url: 400,
  currency_unsupported: 400, invalid_offer_code: 400, consent_required: 400,
  merchant_not_eligible: 409, merchant_disabled: 409, merchant_not_purchasable: 409,
  buyer_unlinked: 409, row_not_found: 409, row_unpriced: 409,
  row_price_ambiguous: 409, row_not_shopify: 409, row_variant_unverified: 409,
  seller_identity_unverified: 409, row_currency_mismatch: 409, row_price_stale: 409,
  row_variant_ambiguous: 409, idempotency_conflict: 409, price_changed: 409,
});
// One conservative refusal contract for public and private backend transports.
// A proxy/platform/auth/gate response cannot authorize another spending path.
function canonicalBackendReasonCode(status, body) {
  if (!isPlainObject(body)) return null;
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const reasons = [];
  if (has(body, 'detail')) {
    if (!isPlainObject(body.detail) || typeof body.detail.error !== 'string') return null;
    reasons.push(body.detail.error);
  }
  if (has(body, 'error')) {
    if (typeof body.error === 'string') reasons.push(body.error);
    else if (isPlainObject(body.error)) {
      const e = body.error;
      const expectedClass = { 400: 'INVALID_REQUEST', 404: 'PRODUCT_NOT_FOUND', 409: 'CONFLICT' }[status];
      if (!expectedClass || body.status !== 'error' || e.code !== expectedClass
        || typeof e.message !== 'string' || !isPlainObject(e.details) || typeof e.details.error !== 'string') return null;
      reasons.push(e.message, e.details.error);
    } else return null;
  }
  if (has(body, 'status') && body.status !== 'error') return null;
  const code = reasons[0];
  return typeof code === 'string' && REASON_CODE_RE.test(code) && reasons.every((reason) => reason === code) ? code : null;
}
function canonicalCreateRefusalCode(status, body) {
  const code = canonicalBackendReasonCode(status, body);
  return code && CREATE_REFUSALS[code] === status ? code : null;
}
function isCanonicalOwnerMiss(status, body) {
  return status === 404 && canonicalBackendReasonCode(status, body) === 'purchase_not_found';
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
 *   requireAuthoritativeRefusal?: boolean, // private Cloud Run platform errors are not backend refusals
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
            // Forward only explicit owner-view facts. Older/malformed replies remain unknown.
            ...(['not_dispatched', 'dispatch_started', 'dispatched', 'unknown'].includes(b.checkout_dispatch_state)
              ? { checkout_dispatch_state: b.checkout_dispatch_state } : {}),
            ...(typeof b.contact_reentry_required === 'boolean'
              ? { contact_reentry_required: b.contact_reentry_required } : {}),
          },
        };
      }
      log('warn', { route: 'start', outcome: KIND.unavailable, code: 'malformed', http_status: out.status });
      return { kind: KIND.unavailable, code: 'malformed' };
    }
    if (out.status >= 400 && out.status < 500) {
      const code = canonicalCreateRefusalCode(out.status, out.body);
      if (!code) {
        log('warn', { route: 'start', outcome: KIND.unavailable, code: 'http_4xx_unknown', http_status: out.status });
        return { kind: KIND.unavailable, code: 'http_4xx_unknown' };
      }
      log('info', { route: 'start', outcome: KIND.refused, code, http_status: out.status });
      return { kind: KIND.refused, code, http_status: out.status };
    }
    const code = Number.isFinite(out.status) && out.status >= 500 ? 'http_5xx' : 'http_unexpected';
    log('warn', { route: 'start', outcome: KIND.unavailable, code, http_status: out.status });
    return { kind: KIND.unavailable, code };
  }

  /** Read-only authoritative catalog selection; never opens a purchase or invokes a provider. */
  async function preparePurchase(body) {
    const headers = requestHeaders();
    if (!headers) return { kind: KIND.unauthenticated };
    const out = await send('prepare', `${baseUrl}${PURCHASES_PATH}/prepare`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (out.error) return { kind: KIND.unavailable, code: out.error };
    if (out.status === 200) {
      const selection = isPlainObject(out.body) && Object.keys(out.body).length === 1 ? readSelectionWitness(out.body.selection) : null;
      return selection ? { kind: KIND.accepted, selection } : { kind: KIND.unavailable, code: 'malformed' };
    }
    const code = canonicalCreateRefusalCode(out.status, out.body);
    return code ? { kind: KIND.refused, code, http_status: out.status }
      : { kind: KIND.unavailable, code: 'prepare_unavailable', http_status: out.status };
  }

  /** Read-only exact original-body/key lookup, even while new creates are paused. */
  async function recoverPurchase(body) {
    const headers = requestHeaders();
    if (!headers) return { kind: KIND.unauthenticated };
    const out = await send('recover', `${baseUrl}${PURCHASES_PATH}/recover`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (out.error) return { kind: KIND.unavailable, code: out.error };
    if (out.status >= 200 && out.status < 300) {
      const b = out.body;
      if (isPlainObject(b) && Object.keys(b).length === 2 && b.recovery_status === 'retired'
        && typeof b.reconciliation_id === 'string' && /^[a-f0-9]{32}$/.test(b.reconciliation_id)) {
        log('info', {route:'recover',outcome:'retired',http_status:out.status});
        return {kind:'retired',reconciliation_id:b.reconciliation_id};
      }
      if (isPlainObject(b) && (Object.hasOwn(b,'recovery_status') || Object.hasOwn(b,'reconciliation_id'))) return {kind:KIND.unavailable,code:'malformed'};
      log('info', {route:'recover',outcome:isPlainObject(b) && PURCHASE_ID_RE.test(String(b.id || '')) ? KIND.accepted : KIND.unavailable,http_status:out.status});
      return isPlainObject(out.body) && PURCHASE_ID_RE.test(String(out.body.id || ''))
        ? { kind: KIND.accepted, purchase: out.body }
        : { kind: KIND.unavailable, code: 'malformed' };
    }
    const code = canonicalBackendReasonCode(out.status, out.body) || `http_${out.status}`;
    log('info', {route:'recover',outcome:isCanonicalOwnerMiss(out.status,out.body) ? KIND.notFound : KIND.unavailable,http_status:out.status});
    if (isCanonicalOwnerMiss(out.status, out.body)) return { kind: KIND.notFound, code: 'purchase_not_found' };
    if (out.status >= 400 && out.status < 500) return { kind: KIND.unavailable, code, http_status: out.status };
    return { kind: KIND.unavailable, code: 'http_5xx' };
  }

  /** Continue the same retained attempt with its EXACT original body/key. One request, never create. */
  async function resumePurchase(purchaseId, body) {
    if (typeof purchaseId !== 'string' || !PURCHASE_ID_RE.test(purchaseId)) return { kind: KIND.notFound, code: 'invalid_id' };
    const headers = requestHeaders();
    if (!headers) return { kind: KIND.unauthenticated };
    const out = await send('resume', `${baseUrl}${PURCHASES_PATH}/${purchaseId}/resume`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (out.error) return { kind: KIND.unavailable, code: out.error };
    if (out.status >= 200 && out.status < 300) {
      const purchase = out.body;
      return isPlainObject(purchase) && purchase.id === purchaseId
        ? { kind: KIND.accepted, purchase }
        : { kind: KIND.unavailable, code: 'malformed' };
    }
    // A resume failure is never a create refusal and cannot authorize a new
    // attempt. Preserve the existing attempt even for owner misses/conflicts.
    // Never echo backend-controlled reason text here. A syntactically canonical
    // value can still be a purchase id, buyer detail, or idempotency key.
    const code = 'resume_unavailable';
    log('warn', { route: 'resume', outcome: KIND.unavailable, code, http_status: out.status });
    return { kind: KIND.unavailable, code, http_status: out.status };
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
    if (isCanonicalOwnerMiss(out.status, out.body)) {
      log('info', { route: 'get', outcome: KIND.notFound, code: 'purchase_not_found', http_status: 404 });
      return { kind: KIND.notFound, code: 'purchase_not_found', http_status: 404 };
    }
    if (out.status >= 400 && out.status < 500) {
      const code = canonicalBackendReasonCode(out.status, out.body) || `http_${out.status}`;
      log('warn', { route: 'get', outcome: KIND.unavailable, code, http_status: out.status });
      return { kind: KIND.unavailable, code, http_status: out.status };
    }
    const code = Number.isFinite(out.status) && out.status >= 500 ? 'http_5xx' : 'http_unexpected';
    log('warn', { route: 'get', outcome: KIND.unavailable, code, http_status: out.status });
    return { kind: KIND.unavailable, code };
  }

  return { startPurchase, preparePurchase, recoverPurchase, resumePurchase, getPurchase, hasCallerCredentials, timeoutMs };
}

module.exports = {
  KIND,
  // Shared with src/services/agentPurchaseReadClient.js (the rail-neutral read): ONE reading of the
  // backend's error envelope and of its credential headers, not two that could drift.
  canonicalBackendReasonCode,
  headerValue,
  parseJson,
  PURCHASES_PATH,
  PURCHASE_ID_RE,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  createReapAgenticPurchaseClient,
};
