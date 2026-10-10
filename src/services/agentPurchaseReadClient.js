'use strict';

/*
 * agentPurchaseReadClient.js — the gateway's client for pivota-backend's rail-neutral purchase read,
 * `GET /agent/v2/commerce/purchases/{pp_id}` (backend payment orchestration P0; contract:
 * pivota-backend docs/agent_purchases_routes.md).
 *
 * WHY IT EXISTS. `get_order` on every door is kernel-scoped: it answers only orders the gateway kernel
 * minted. A purchase on a payment rail (Reap today) lives in the backend's `agent_purchases` ledger under
 * a `pp_` id. This client is the one read that lets `get_order` answer those ids
 * (safety-kernel/src/protocol/canonicalExecutor.js, `readAgentPurchase`).
 *
 * ONE GET, NOTHING ELSE. No create, no advance, no retry. Same four outcome kinds as
 * src/services/reapAgenticPurchaseClient.js, read the same way:
 *
 *   accepted         200 and the body is the purchase this id names (`purchase_id` echoes the id)
 *   not_found        404 `purchase_not_found`: not this buyer's, or does not exist (one answer by design)
 *   unavailable      everything else, including 404 `not_available` (backend dial off), 503
 *                    `state_unmapped`, a timeout or a malformed body. Never a statement about the purchase.
 *   unauthenticated  the request context has no agent key or no buyer token. No request is made, and the
 *                    INTERNAL key is never substituted (`allowInternalFallback: false` at the host): it would
 *                    read under Pivota's own agent id, which owns no buyer's purchase.
 *
 * Logs carry an event name, an outcome, a code and an HTTP status: never an id, a header or a body.
 */

const { KIND, canonicalBackendReasonCode, headerValue, parseJson } = require('./reapAgenticPurchaseClient');

const AGENT_PURCHASES_PATH = '/agent/v2/commerce/purchases';
const AGENT_PURCHASE_ID_RE = /^pp_[0-9a-f]{24}$/;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 50;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
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
function createAgentPurchaseReadClient(deps = {}) {
  const baseUrl = String(deps.baseUrl || '').trim().replace(/\/+$/, '');
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const authHeaders = typeof deps.authHeaders === 'function' ? deps.authHeaders : () => ({});
  const timeoutMs = clampTimeout(deps.timeoutMs);
  const logger = deps.logger && typeof deps.logger.warn === 'function' ? deps.logger : null;

  function log(level, fields) {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.warn;
    try {
      fn.call(logger, { event: 'agent_purchase_backend_read', ...fields }, 'agent purchase backend read');
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
    const out = { 'X-API-Key': apiKey, 'X-Agent-User-JWT': userJwt, Accept: 'application/json' };
    const authorization = headerValue(supplied, 'Authorization');
    if (authorization) out.Authorization = authorization;
    return out;
  }

  /** Read one purchase the calling agent + buyer own. Resolves a `{ kind, ... }`; never throws. */
  async function getPurchase(purchaseId) {
    if (typeof purchaseId !== 'string' || !AGENT_PURCHASE_ID_RE.test(purchaseId)) {
      return { kind: KIND.notFound, code: 'invalid_id' };
    }
    const headers = requestHeaders();
    if (!headers) {
      log('info', { outcome: KIND.unauthenticated });
      return { kind: KIND.unauthenticated };
    }
    if (!baseUrl || typeof fetchImpl !== 'function') {
      log('warn', { outcome: KIND.unavailable, code: 'unconfigured' });
      return { kind: KIND.unavailable, code: 'unconfigured' };
    }

    const controller = new AbortController();
    // NOT unref()'d: an unref'd timer behind an awaited fetch lets the loop drain and the deadline never fires.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let body;
    try {
      const res = await fetchImpl(`${baseUrl}${AGENT_PURCHASES_PATH}/${purchaseId}`, {
        method: 'GET', headers, signal: controller.signal, redirect: 'error',
      });
      status = Number(res && res.status);
      let text = '';
      try {
        text = typeof res.text === 'function' ? await res.text() : '';
      } catch {
        text = '';
      }
      body = parseJson(text);
    } catch (err) {
      const code = controller.signal.aborted || (err && err.name === 'AbortError') ? 'timeout' : 'transport';
      log('warn', { outcome: KIND.unavailable, code });
      return { kind: KIND.unavailable, code };
    } finally {
      clearTimeout(timer);
    }

    if (status === 200) {
      if (isPlainObject(body) && body.purchase_id === purchaseId && typeof body.state === 'string') {
        log('info', { outcome: KIND.accepted, http_status: status });
        return { kind: KIND.accepted, purchase: body };
      }
      log('warn', { outcome: KIND.unavailable, code: 'malformed', http_status: status });
      return { kind: KIND.unavailable, code: 'malformed' };
    }
    const reason = canonicalBackendReasonCode(status, body);
    if (status === 404 && reason === 'purchase_not_found') {
      log('info', { outcome: KIND.notFound, code: reason, http_status: status });
      return { kind: KIND.notFound, code: reason };
    }
    const code = reason || (Number.isFinite(status) && status >= 500 ? 'http_5xx' : `http_${status}`);
    log('warn', { outcome: KIND.unavailable, code, http_status: status });
    return { kind: KIND.unavailable, code, http_status: status };
  }

  return { getPurchase, timeoutMs };
}

module.exports = {
  AGENT_PURCHASES_PATH,
  AGENT_PURCHASE_ID_RE,
  createAgentPurchaseReadClient,
};
