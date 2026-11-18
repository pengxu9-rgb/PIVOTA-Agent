'use strict';

/*
 * How the AgenPas page reads a purchase on the buyer's behalf.
 *
 * WHY NOT THE EXISTING READ CLIENT. src/services/agentPurchaseReadClient.js reads with the CALLER's agent key and
 * buyer token, both of which arrive per request from the partner and are never stored by the gateway. The buyer
 * opening an AgenPas link has neither. So this reader is a server-to-server call, authenticated with a DEDICATED
 * key that grants this one read (X-Internal-Key = AGENPAS_INTERNAL_READ_KEY, not the shared introspection key),
 * naming the owner the VERIFIED link token names:
 *
 *   GET {PIVOTA_API_BASE}/agent/internal/commerce/purchases/{purchase_id}
 *     X-Internal-Key:            AGENPAS_INTERNAL_READ_KEY
 *     X-Agenpas-Agent-Id:        the agent id the link was minted for
 *     X-Agenpas-Agent-User-Ref:  the agent user ref the link was minted for (the gateway's `usr_…` form)
 *   200 -> the SAME unified body as GET /agent/v2/commerce/purchases/{id}
 *   404 purchase_not_found -> not that agent's, or does not exist
 *
 * SCOPE. The backend scopes this read by (agent_id, purchase_id) ONLY. The user ref is sent but the backend does not
 * scope by it: the gateway's `usr_…` ref is not the backend's own agent-user ref, so it cannot. The buyer binding is
 * the link token itself (signed for one purchase, one agent, one user ref).
 *
 * The backend route is being built to this contract (docs/agenpas.md, "Backend contract"): until it is served,
 * every read answers `unavailable` and the page says it cannot load the purchase right now.
 *
 * Outcomes: { kind: 'accepted', purchase } | { kind: 'not_found' } | { kind: 'unavailable', code }. Never throws.
 * Logs carry an event, an outcome, a code and an HTTP status: never an id, a header, a ref or a body.
 *
 * THE ADDRESS WRITE (docs/agenpas.md, "Shipping address"), same authentication:
 *
 *   POST {PIVOTA_API_BASE}/agent/internal/commerce/purchases/{purchase_id}/shipping-address
 *     body: {email, firstName, lastName, phone, addressLine1, addressLine2, city, region, postalCode, country}
 *   200 -> the unified view            422 -> {field_errors: {field: code}}
 *   409 -> already set / state moved   404 -> not that agent's
 *
 * Outcomes: accepted {purchase} | invalid {field_errors} | conflict | not_found | unavailable {code}. The body (the
 * buyer's address) goes to the backend and NOWHERE else: never logged, never part of an outcome.
 */

const { PURCHASE_ID_RE } = require('./linkToken');
const { sanitizeFieldErrors } = require('./shippingAddress');

const INTERNAL_PURCHASES_PATH = '/agent/internal/commerce/purchases';
const TIMEOUT_MS = 2000;
const MAX_BODY_CHARS = 64 * 1024;

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function reasonOf(body) {
  if (!isPlainObject(body)) return null;
  if (isPlainObject(body.detail) && typeof body.detail.error === 'string') return body.detail.error;
  if (typeof body.error === 'string') return body.error;
  return null;
}

/**
 * @param {{ baseUrl: string, internalKey: () => string, fetchImpl?: Function, logger?: object, timeoutMs?: number }} deps
 */
function createBackendPurchaseReader(deps = {}) {
  const baseUrl = String(deps.baseUrl || '').trim().replace(/\/+$/, '');
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const internalKey = typeof deps.internalKey === 'function' ? deps.internalKey : () => '';
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? Math.min(deps.timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
  const logger = deps.logger && typeof deps.logger.warn === 'function' ? deps.logger : null;

  function log(level, fields) {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.warn;
    try {
      fn.call(logger, { event: 'agenpas_purchase_read', ...fields }, 'agenpas purchase read');
    } catch {
      // A logger fault never changes the answer.
    }
  }

  async function read(claims) {
    const purchaseId = claims && claims.purchaseId;
    if (typeof purchaseId !== 'string' || !PURCHASE_ID_RE.test(purchaseId)) return { kind: 'not_found' };
    let key = '';
    try {
      key = String(internalKey() || '').trim();
    } catch {
      key = '';
    }
    if (!baseUrl || !key || typeof fetchImpl !== 'function') {
      log('warn', { outcome: 'unavailable', code: 'unconfigured' });
      return { kind: 'unavailable', code: 'unconfigured' };
    }
    const controller = new AbortController();
    // NOT unref()'d: an unref'd timer behind an awaited fetch lets the loop drain and the deadline never fires.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let body;
    try {
      const res = await fetchImpl(`${baseUrl}${INTERNAL_PURCHASES_PATH}/${purchaseId}`, {
        method: 'GET',
        headers: {
          'X-Internal-Key': key,
          'X-Agenpas-Agent-Id': claims.agentId,
          'X-Agenpas-Agent-User-Ref': claims.userRef,
          Accept: 'application/json',
        },
        signal: controller.signal,
        redirect: 'error',
      });
      status = Number(res && res.status);
      let text = '';
      try {
        text = typeof res.text === 'function' ? await res.text() : '';
      } catch {
        text = '';
      }
      body = text.length > MAX_BODY_CHARS ? undefined : parseJson(text);
    } catch (err) {
      const code = controller.signal.aborted || (err && err.name === 'AbortError') ? 'timeout' : 'transport';
      log('warn', { outcome: 'unavailable', code });
      return { kind: 'unavailable', code };
    } finally {
      clearTimeout(timer);
    }
    if (status === 200 && isPlainObject(body) && typeof body.state === 'string'
      && (body.purchase_id === purchaseId || body.rail_purchase_id === purchaseId)) {
      log('info', { outcome: 'accepted', http_status: status });
      return { kind: 'accepted', purchase: body };
    }
    const reason = reasonOf(body);
    if (status === 404 && reason === 'purchase_not_found') {
      log('info', { outcome: 'not_found', http_status: status });
      return { kind: 'not_found' };
    }
    const code = status === 200 ? 'malformed' : (reason && /^[a-z_]{1,48}$/.test(reason) ? reason : `http_${Number.isFinite(status) ? status : 'unknown'}`);
    log('warn', { outcome: 'unavailable', code, http_status: status });
    return { kind: 'unavailable', code };
  }

  async function submitShippingAddress(claims, address) {
    const purchaseId = claims && claims.purchaseId;
    if (typeof purchaseId !== 'string' || !PURCHASE_ID_RE.test(purchaseId)) return { kind: 'not_found' };
    let key = '';
    try {
      key = String(internalKey() || '').trim();
    } catch {
      key = '';
    }
    if (!baseUrl || !key || typeof fetchImpl !== 'function') {
      log('warn', { op: 'shipping_address', outcome: 'unavailable', code: 'unconfigured' });
      return { kind: 'unavailable', code: 'unconfigured' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let body;
    try {
      const res = await fetchImpl(`${baseUrl}${INTERNAL_PURCHASES_PATH}/${purchaseId}/shipping-address`, {
        method: 'POST',
        headers: {
          'X-Internal-Key': key,
          'X-Agenpas-Agent-Id': claims.agentId,
          'X-Agenpas-Agent-User-Ref': claims.userRef,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(address),
        signal: controller.signal,
        redirect: 'error',
      });
      status = Number(res && res.status);
      let text = '';
      try {
        text = typeof res.text === 'function' ? await res.text() : '';
      } catch {
        text = '';
      }
      body = text.length > MAX_BODY_CHARS ? undefined : parseJson(text);
    } catch (err) {
      const code = controller.signal.aborted || (err && err.name === 'AbortError') ? 'timeout' : 'transport';
      log('warn', { op: 'shipping_address', outcome: 'unavailable', code });
      return { kind: 'unavailable', code };
    } finally {
      clearTimeout(timer);
    }
    if (status === 200 && isPlainObject(body) && typeof body.state === 'string'
      && (body.purchase_id === purchaseId || body.rail_purchase_id === purchaseId)) {
      log('info', { op: 'shipping_address', outcome: 'accepted', http_status: status });
      return { kind: 'accepted', purchase: body };
    }
    if (status === 422) {
      const raw = isPlainObject(body) ? (body.field_errors || (isPlainObject(body.detail) ? body.detail.field_errors : null)) : null;
      log('info', { op: 'shipping_address', outcome: 'invalid', http_status: status });
      return { kind: 'invalid', field_errors: sanitizeFieldErrors(raw) };
    }
    if (status === 409) {
      log('info', { op: 'shipping_address', outcome: 'conflict', http_status: status });
      return { kind: 'conflict' };
    }
    if (status === 404) {
      log('info', { op: 'shipping_address', outcome: 'not_found', http_status: status });
      return { kind: 'not_found' };
    }
    log('warn', { op: 'shipping_address', outcome: 'unavailable', code: status === 200 ? 'malformed' : `http_${Number.isFinite(status) ? status : 'unknown'}`, http_status: status });
    return { kind: 'unavailable', code: status === 200 ? 'malformed' : `http_${status}` };
  }

  return Object.freeze({ read, submitShippingAddress });
}

module.exports = {
  INTERNAL_PURCHASES_PATH,
  createBackendPurchaseReader,
};
