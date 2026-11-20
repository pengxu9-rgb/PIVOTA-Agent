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
 *   409 consent_required -> the step's terms are not accepted yet (nothing written; the page goes back to them)
 *   409 (shipping_address_conflict, or any other) -> already set / state moved   404 -> not that agent's
 *
 * Outcomes: accepted {purchase} | invalid {field_errors} | consent_required | conflict | not_found | unavailable {code}. The body (the
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
      // The app's error envelope names the reason in `detail.error` (reasonOf): `consent_required` (the step's terms
      // are not on record; nothing was written) or `shipping_address_conflict` (and any other 409: as before).
      if (reasonOf(body) === 'consent_required') {
        log('info', { op: 'shipping_address', outcome: 'consent_required', http_status: status });
        return { kind: 'consent_required' };
      }
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

/*
 * THE CONSENT WRITE (docs/agenpas.md, "Terms and privacy consent"). The buyer accepted Pivota's Terms of Service and
 * Privacy Policy on the AgenPas page; the gateway records it server-to-server, for the agent the verified link names,
 * with its OWN key (the read key stays read-only):
 *
 *   POST {PIVOTA_API_BASE}/agent/internal/commerce/purchases/{purchase_id}/consents
 *     X-Internal-Key:      AGENPAS_INTERNAL_CONSENT_KEY
 *     X-Agenpas-Agent-Id:  the agent id the link was minted for
 *     {step, offer_id, issued_at, terms_version, privacy_version}
 *   201 / 200 -> recorded (a repeat is idempotent)
 *   409 consent_stale -> the offer or a version moved on (the page reads again)
 *   409 consent_too_soon -> the offer is younger than the backend's dwell (the page waits, then the buyer presses again)
 *   400 / 404 -> refused (nothing recorded)
 *   503 / anything else -> unavailable
 *
 * Outcomes: { kind: 'recorded' } | { kind: 'stale' } | { kind: 'too_soon' } | { kind: 'refused', code } |
 * { kind: 'unavailable', code }.
 * Never throws. Logs carry an outcome, a code and an HTTP status only.
 */
const CONSENT_SUBPATH = '/consents';

function createBackendConsentWriter(deps = {}) {
  const baseUrl = String(deps.baseUrl || '').trim().replace(/\/+$/, '');
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const internalKey = typeof deps.internalKey === 'function' ? deps.internalKey : () => '';
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? Math.min(deps.timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
  const logger = deps.logger && typeof deps.logger.warn === 'function' ? deps.logger : null;

  function log(level, fields) {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.warn;
    try {
      fn.call(logger, { event: 'agenpas_consent_write', ...fields }, 'agenpas consent write');
    } catch {
      // A logger fault never changes the answer.
    }
  }

  async function record(claims, consent) {
    const purchaseId = claims && claims.purchaseId;
    if (typeof purchaseId !== 'string' || !PURCHASE_ID_RE.test(purchaseId) || !isPlainObject(consent)) {
      return { kind: 'refused', code: 'bad_request' };
    }
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
    // Exactly the contract's five members, in a fixed order: nothing else from the browser can ride along.
    const payload = JSON.stringify({
      step: consent.step,
      offer_id: consent.offer_id,
      issued_at: consent.issued_at,
      terms_version: consent.terms_version,
      privacy_version: consent.privacy_version,
    });
    const controller = new AbortController();
    // NOT unref()'d (see read above).
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let body;
    try {
      const res = await fetchImpl(`${baseUrl}${INTERNAL_PURCHASES_PATH}/${purchaseId}${CONSENT_SUBPATH}`, {
        method: 'POST',
        headers: {
          'X-Internal-Key': key,
          'X-Agenpas-Agent-Id': claims.agentId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: payload,
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
    const reason = reasonOf(body);
    const code = reason && /^[a-z_]{1,48}$/.test(reason) ? reason : `http_${Number.isFinite(status) ? status : 'unknown'}`;
    if (status === 200 || status === 201) {
      log('info', { outcome: 'recorded', http_status: status });
      return { kind: 'recorded' };
    }
    if (status === 409) {
      // `consent_too_soon`: the offer is younger than the backend's dwell (nothing moved on; try again shortly).
      const kind = code === 'consent_too_soon' ? 'too_soon' : 'stale';
      log('info', { outcome: kind, code, http_status: status });
      return { kind, code };
    }
    if (status === 400 || status === 404) {
      log('info', { outcome: 'refused', code, http_status: status });
      return { kind: 'refused', code };
    }
    log('warn', { outcome: 'unavailable', code, http_status: status });
    return { kind: 'unavailable', code };
  }

  return Object.freeze({ record });
}

module.exports = {
  CONSENT_SUBPATH,
  INTERNAL_PURCHASES_PATH,
  createBackendConsentWriter,
  createBackendPurchaseReader,
};
