'use strict';

/*
 * agentPurchaseCreateClient.js — the gateway's client for pivota-backend's rail-neutral purchase CREATE,
 * `POST /agent/v2/commerce/purchases` (backend payment orchestration P2c; the backend picks the payment rail).
 *
 * The body is the backend Reap route's cart-link create body plus an optional `payment_preference.rail`. The
 * backend answers 202 with a purchase on the rail it chose: an A2A-rail purchase as
 * `{purchase_id: "ap_…", rail: "a2a", state, rail_state, poll_after_seconds, variant_title}`, or a request it
 * handed to the Reap route in that route's own shape (`{purchase_id: "rp_…", status, …}`).
 *
 * ONE POST, NOTHING ELSE. No retry, no read: the caller reads the purchase back through
 * src/services/agentPurchaseReadClient.js. Outcomes, the same five kinds as src/services/reapAgenticPurchaseClient.js:
 *
 *   accepted         202 with a well-formed id on a known rail: `{ purchaseId, rail, state }`
 *   refused          a 400/409 whose reason is on CREATE_REFUSALS, in the backend's documented envelope: the backend
 *                    DEFINITELY opened nothing for this body (`{ code, http_status }`)
 *   unavailable      everything else: a 404 (dark door, or a rail choice it cannot honour), a 401/403, a 5xx, a
 *                    timeout, a malformed or oversized body. NEVER a statement that nothing was created: the caller
 *                    must treat the outcome as unknown and retry the SAME idempotency key, or read the purchase.
 *   rejected         401: the backend refused the caller's credentials, before any write (no retry can fix it)
 *   unauthenticated  the request context has no agent key or no buyer token: no request is made, and the INTERNAL
 *                    key is never substituted (`allowInternalFallback: false` at the host)
 *
 * PII. The body carries the buyer's email and address: to the backend and nowhere else. Logs carry an event
 * name, an outcome, a reason code and an HTTP status; never a body, a header or an id.
 */

const { KIND, canonicalBackendReasonCode, headerValue, parseJson } = require('./reapAgenticPurchaseClient');

const AGENT_PURCHASES_PATH = '/agent/v2/commerce/purchases';
// Longer than the read's 2 s: the backend create does more (eligibility, the catalog read, the click, one
// transaction). Still well inside the edge's ~13 s first-byte limit, together with the 2 s read-back.
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 50;
const MAX_BODY_CHARS = 64 * 1024;
// A rail's own purchase id: the A2A rail's (`ap_`) or Reap's (`rp_`), each `<prefix><24 hex>`.
const RAIL_PURCHASE_ID_RE = /^(?:ap|rp)_[0-9a-f]{24}$/;
const RAIL_BY_PREFIX = Object.freeze({ ap_: 'a2a', rp_: 'reap' });
const STATE_RE = /^[a-z_]{1,32}$/;

// The backend's DEFINITE create refusals (routes/agent_commerce_reap.py `_REFUSAL_STATUS`, which the rail-neutral
// door shares, plus that door's own `amount_over_limit`). Only these, at exactly this status, say "nothing was
// opened". A gate answer (404) is deliberately absent: it never authorizes another route.
const CREATE_REFUSALS = Object.freeze({
  invalid_request: 400, invalid_address: 400, invalid_return_url: 400,
  currency_unsupported: 400, invalid_offer_code: 400, consent_required: 400,
  merchant_not_eligible: 409, merchant_disabled: 409, merchant_not_purchasable: 409,
  buyer_unlinked: 409, row_not_found: 409, row_unpriced: 409,
  row_price_ambiguous: 409, row_not_shopify: 409, row_variant_unverified: 409,
  seller_identity_unverified: 409, row_currency_mismatch: 409, row_price_stale: 409,
  row_variant_ambiguous: 409, idempotency_conflict: 409, price_changed: 409,
  amount_over_limit: 409,
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

/** The rail a purchase id belongs to, or null. */
function railOf(purchaseId) {
  if (typeof purchaseId !== 'string' || !RAIL_PURCHASE_ID_RE.test(purchaseId)) return null;
  return RAIL_BY_PREFIX[purchaseId.slice(0, 3)] || null;
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
function createAgentPurchaseCreateClient(deps = {}) {
  const baseUrl = String(deps.baseUrl || '').trim().replace(/\/+$/, '');
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const authHeaders = typeof deps.authHeaders === 'function' ? deps.authHeaders : () => ({});
  const timeoutMs = clampTimeout(deps.timeoutMs);
  const logger = deps.logger && typeof deps.logger.warn === 'function' ? deps.logger : null;

  function log(level, fields) {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.warn;
    try {
      fn.call(logger, { event: 'agent_purchase_backend_create', ...fields }, 'agent purchase backend create');
    } catch {
      // A logger fault must never change the answer.
    }
  }

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
    const out = {
      'X-API-Key': apiKey, 'X-Agent-User-JWT': userJwt, Accept: 'application/json', 'Content-Type': 'application/json',
    };
    const authorization = headerValue(supplied, 'Authorization');
    if (authorization) out.Authorization = authorization;
    return out;
  }

  /** True when this request carries both credentials the backend needs (no request is made). */
  function hasCallerCredentials() {
    return requestHeaders() !== null;
  }

  /** Open one purchase. Resolves a `{ kind, ... }`; never throws. */
  async function startPurchase(body) {
    if (!isPlainObject(body)) return { kind: KIND.unavailable, code: 'invalid_body' };
    const headers = requestHeaders();
    if (!headers) {
      log('info', { outcome: KIND.unauthenticated });
      return { kind: KIND.unauthenticated };
    }
    if (!baseUrl || typeof fetchImpl !== 'function') {
      log('warn', { outcome: KIND.unavailable, code: 'unconfigured' });
      return { kind: KIND.unavailable, code: 'unconfigured' };
    }
    let payload;
    try {
      payload = JSON.stringify(body);
    } catch {
      return { kind: KIND.unavailable, code: 'invalid_body' };
    }

    const controller = new AbortController();
    // NOT unref()'d: an unref'd timer behind an awaited fetch lets the loop drain and the deadline never fires.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let parsed;
    try {
      const res = await fetchImpl(`${baseUrl}${AGENT_PURCHASES_PATH}`, {
        method: 'POST', headers, body: payload, signal: controller.signal, redirect: 'error',
      });
      status = Number(res && res.status);
      let text = '';
      try {
        text = typeof res.text === 'function' ? await res.text() : '';
      } catch {
        text = '';
      }
      parsed = text.length > MAX_BODY_CHARS ? undefined : parseJson(text);
    } catch (err) {
      const code = controller.signal.aborted || (err && err.name === 'AbortError') ? 'timeout' : 'transport';
      log('warn', { outcome: KIND.unavailable, code });
      return { kind: KIND.unavailable, code };
    } finally {
      clearTimeout(timer);
    }

    if (status === 202) {
      const purchaseId = isPlainObject(parsed) ? parsed.purchase_id : undefined;
      const rail = railOf(purchaseId);
      // The A2A answer names its rail; Reap's own body does not (it has `status`). Either way the id decides.
      const stated = isPlainObject(parsed) && typeof parsed.rail === 'string' ? parsed.rail : rail;
      const state = rail === 'a2a' ? parsed.rail_state : parsed && parsed.status;
      if (rail && stated === rail && typeof state === 'string' && STATE_RE.test(state)) {
        log('info', { outcome: KIND.accepted, code: rail, http_status: status });
        return { kind: KIND.accepted, purchaseId, rail, state };
      }
      log('warn', { outcome: KIND.unavailable, code: 'malformed', http_status: status });
      return { kind: KIND.unavailable, code: 'malformed', http_status: status };
    }
    const reason = canonicalBackendReasonCode(status, parsed);
    if (status === 401) {
      log('info', { outcome: 'rejected', http_status: status });
      return { kind: 'rejected' };
    }
    if (reason && CREATE_REFUSALS[reason] === status) {
      log('info', { outcome: KIND.refused, code: reason, http_status: status });
      return { kind: KIND.refused, code: reason, http_status: status };
    }
    const code = reason || (Number.isFinite(status) && status >= 500 ? 'http_5xx' : `http_${status}`);
    log('warn', { outcome: KIND.unavailable, code, http_status: status });
    return { kind: KIND.unavailable, code, http_status: status };
  }

  return { startPurchase, hasCallerCredentials, timeoutMs };
}

module.exports = {
  AGENT_PURCHASES_PATH,
  CREATE_REFUSALS,
  RAIL_PURCHASE_ID_RE,
  createAgentPurchaseCreateClient,
  railOf,
};
