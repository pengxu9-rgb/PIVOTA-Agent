'use strict';

/*
 * storefrontHandoffRecord.js — the UCP storefront hand-off record (FIX_PLAN O-02), gateway side.
 *
 * WHY. The UCP door answers a checkout for a seller Pivota does not transact with `requires_escalation` and a
 * `continue_url` on the seller's storefront (mcp-server/src/ucpCheckoutEscalation.js). Its `esc_` id was unsigned
 * and stateless: nothing recorded that the hand-off happened, for which partner, with what quoted total from
 * which source, and `get_order` on the id answered QUOTE_NOT_FOUND.
 *
 * WHAT THIS ADDS, behind UCP_STOREFRONT_HANDOFF_RECORD_ENABLED (default OFF) AND the O-04 partner-identity flag
 * (PARTNER_IDENTITY_FORWARDING_ENABLED; the record's partner is the agent that assertion names):
 *   - a RECORD ID (`esh_` + 22 base64url chars = 128 random bits) minted here and carried INSIDE the esc id the
 *     door hands out (member `r`);
 *   - ONE backend write per hand-off (POST /agent/v2/storefront-handoffs, pivota-backend
 *     routes/agent_storefront_handoffs.py): the record id, the sha256 of the FULL esc id (`binding`), the
 *     referral click id, seller host, buyer market, quoted total + currency, quote source and price_as_of. The
 *     partner is the backend's adoption of the signed assertion, never a body field;
 *   - ONE backend read for get_order on an esc id (POST /agent/v2/storefront-handoffs/read).
 *
 * WHY A BOUND RECORD ID AND NOT A SIGNATURE. A forged esc id must not read a hand-off, and a real one must read
 * only ITS hand-off. The record id cannot be guessed (128 random bits), and the backend answers it only together
 * with the sha256 of the esc id it was recorded under, and only to the partner that recorded it. An id lifted
 * into an esc id with other items or another cart does not match. No new secret is needed, and the esc id stays
 * readable by the stateless get_checkout re-read exactly as before.
 *
 * NEVER FAILS THE CHECKOUT. A write that is not confirmed (no partner on the request, backend off or down, a
 * refusal) is logged, and the door hands out the esc id WITHOUT `r`: byte-identical to the id it handed out
 * before this module existed.
 *
 * Logs carry an event, an outcome, a code and an HTTP status: never an id, a header or a body.
 */

const crypto = require('crypto');
const {
  ISSUING_AGENT_ASSERTION_HEADER,
  STOREFRONT_HANDOFF_RECORD_ENV,
  STOREFRONT_HANDOFF_RECORD_OP,
  STOREFRONT_HANDOFF_READ_OP,
  storefrontHandoffFlagOn,
  storefrontHandoffRecordEnabled,
} = require('../attribution/issuingAgentAssertion');

const STOREFRONT_HANDOFFS_PATH = '/agent/v2/storefront-handoffs';
const HANDOFF_RECORD_ID_RE = /^esh_[A-Za-z0-9_-]{22}$/;
const QUOTE_SOURCE = Object.freeze({ sellerCart: 'seller_cart', catalogueFallback: 'catalogue_fallback' });
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 50;

const OUTCOME = Object.freeze({
  recorded: 'recorded',
  accepted: 'accepted',
  notFound: 'not_found',
  notOwner: 'not_owner',
  unattributed: 'unattributed',
  refused: 'refused',
  unavailable: 'unavailable',
  assertionRejected: 'assertion_rejected',
});

// The backend's refusals of the partner assertion itself (O-04): PARTNER_ASSERTION_REJECTED (the request-bound token
// failed a check: stale, replayed, bound to another request) and partner_identity_required (no partner was adopted
// from it). Neither says anything about the hand-off, and the same read is refused the same way every time.
const ASSERTION_REFUSAL_CODES = new Set(['PARTNER_ASSERTION_REJECTED', 'partner_identity_required']);

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mintHandoffRecordId() {
  return `esh_${crypto.randomBytes(16).toString('base64url')}`;
}

/** The binding the backend stores and checks: sha256 hex of the esc id exactly as handed out. */
function escalationIdBinding(escalationId) {
  return crypto.createHash('sha256').update(String(escalationId), 'utf8').digest('hex');
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

/** The backend's refusal code: `detail.error` (the /agent error wrapper keeps it), else a bare `error`. */
function refusalCode(body) {
  if (!isPlainObject(body)) return null;
  if (isPlainObject(body.detail) && typeof body.detail.error === 'string') return body.detail.error;
  if (typeof body.error === 'string') return body.error;
  if (isPlainObject(body.error) && isPlainObject(body.error.details) && typeof body.error.details.error === 'string') {
    return body.error.details.error;
  }
  return null;
}

/** The backend's snake_case refusal reason (e.g. `stale`, `replay`), or null: our own vocabulary only. */
function refusalReason(body) {
  if (!isPlainObject(body)) return null;
  const raw = isPlainObject(body.detail) && typeof body.detail.reason === 'string'
    ? body.detail.reason
    : (isPlainObject(body.error) && isPlainObject(body.error.details) ? body.error.details.reason : null);
  return typeof raw === 'string' && /^[a-z0-9_]{1,32}$/.test(raw) ? raw : null;
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/**
 * THE PARTNER ASSERTION IS REQUEST-BOUND (v2, O-04 review P2-2): `signRequest` is called once per send, over the
 * exact body string this client then sends, its method, URL and `rid`, and returns the X-Pivota-Issuing-Agent header
 * (src/attribution/issuingAgentAssertion.js boundIssuingAgentAssertionHeaders). `rid` is the hand-off RECORD ID on
 * both calls (the body's `record_id`), which is what the backend's routes bind (`resource=("body", "record_id")`).
 * No header from it means the request names no partner, and nothing is sent.
 *
 * @param {{
 *   baseUrl: string,
 *   authHeaders: () => (object|null),     // the gateway's own key; null when it has none (nothing is sent)
 *   signRequest: ({ op, method, url, rid, rawBody }) => object,
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   logger?: { info?: Function, warn?: Function },
 * }} deps
 */
function createStorefrontHandoffClient(deps = {}) {
  const baseUrl = String(deps.baseUrl || '').trim().replace(/\/+$/, '');
  const fetchImpl = typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch;
  const authHeaders = typeof deps.authHeaders === 'function' ? deps.authHeaders : () => null;
  const signRequest = typeof deps.signRequest === 'function' ? deps.signRequest : () => ({});
  const timeoutMs = clampTimeout(deps.timeoutMs);
  const logger = deps.logger && typeof deps.logger.warn === 'function' ? deps.logger : null;

  function log(level, fields) {
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.warn;
    try {
      fn.call(logger, { event: 'ucp_storefront_handoff_record', ...fields }, 'ucp storefront hand-off record');
    } catch {
      // A logger fault must never change the answer.
    }
  }

  async function post(op, path, body) {
    if (!baseUrl || typeof fetchImpl !== 'function') return { kind: OUTCOME.unavailable, code: 'unconfigured' };
    const url = `${baseUrl}${path}`;
    // Serialised ONCE: the assertion is hashed over exactly these bytes, and exactly these bytes are sent.
    const rawBody = JSON.stringify(body);
    let base;
    let signed;
    try { base = authHeaders(); } catch { base = null; }
    try { signed = signRequest({ op, method: 'POST', url, rid: body.record_id, rawBody }); } catch { signed = null; }
    // No partner assertion on this request: the backend would refuse it (partner_identity_required), so it is
    // never sent. The record is a partner's or nobody's.
    if (!isPlainObject(base) || !isPlainObject(signed) || !signed[ISSUING_AGENT_ASSERTION_HEADER]) {
      return { kind: OUTCOME.unattributed };
    }
    const headers = { ...base, [ISSUING_AGENT_ASSERTION_HEADER]: signed[ISSUING_AGENT_ASSERTION_HEADER] };
    const controller = new AbortController();
    // NOT unref()'d: an unref'd timer behind an awaited fetch lets the loop drain and the deadline never fires.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: rawBody,
        signal: controller.signal,
        redirect: 'error',
      });
      const status = Number(res && res.status);
      let text = '';
      try { text = typeof res.text === 'function' ? await res.text() : ''; } catch { text = ''; }
      return { status, body: parseJson(text) };
    } catch (err) {
      const code = controller.signal.aborted || (err && err.name === 'AbortError') ? 'timeout' : 'transport';
      return { kind: OUTCOME.unavailable, code };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Record one hand-off. Resolves `{ kind: 'recorded' | 'unattributed' | 'refused' | 'unavailable' }`; never throws. */
  async function record(fields) {
    const answered = await post(STOREFRONT_HANDOFF_RECORD_OP, STOREFRONT_HANDOFFS_PATH, fields);
    if (answered.kind) {
      log('info', { op: 'record', outcome: answered.kind, code: answered.code || null });
      return answered;
    }
    const { status, body } = answered;
    if (status === 200 && isPlainObject(body) && body.record_id === fields.record_id && body.status === 'handed_off') {
      log('info', { op: 'record', outcome: OUTCOME.recorded, http_status: status });
      return { kind: OUTCOME.recorded };
    }
    const code = refusalCode(body) || `http_${status}`;
    const kind = status >= 500 || !Number.isFinite(status) ? OUTCOME.unavailable : OUTCOME.refused;
    log('warn', { op: 'record', outcome: kind, code, http_status: status });
    return { kind, code };
  }

  /**
   * Read one hand-off for get_order. Resolves `{ kind: 'accepted', handoff } | { kind: 'not_found' } |
   * { kind: 'not_owner' } | { kind: 'unattributed' } | { kind: 'assertion_rejected', code, reason } |
   * { kind: 'unavailable', code }`; never throws.
   */
  async function read(recordId, escalationId) {
    if (!HANDOFF_RECORD_ID_RE.test(String(recordId || ''))) return { kind: OUTCOME.notFound };
    const answered = await post(STOREFRONT_HANDOFF_READ_OP, `${STOREFRONT_HANDOFFS_PATH}/read`, {
      record_id: recordId,
      binding: escalationIdBinding(escalationId),
    });
    if (answered.kind) {
      log('info', { op: 'read', outcome: answered.kind, code: answered.code || null });
      return answered;
    }
    const { status, body } = answered;
    const code = refusalCode(body);
    if (status === 200 && isPlainObject(body) && body.record_id === recordId && typeof body.status === 'string') {
      log('info', { op: 'read', outcome: OUTCOME.accepted, http_status: status });
      return { kind: OUTCOME.accepted, handoff: body };
    }
    if (status === 404 && code === 'handoff_not_found') {
      log('info', { op: 'read', outcome: OUTCOME.notFound, http_status: status });
      return { kind: OUTCOME.notFound };
    }
    // 409 since the backend stopped answering 403 for it (O-02 review G-1: under the private backend hop a 403 is
    // thrown as `backend_iam_rejected` before it reaches here). 403 is still read, for a backend not yet on 409.
    if ((status === 409 || status === 403) && code === 'not_owner') {
      log('info', { op: 'read', outcome: OUTCOME.notOwner, http_status: status });
      return { kind: OUTCOME.notOwner };
    }
    // The backend refused the partner assertion, not the hand-off (O-04 delta review P3-7): non-retriable, like the
    // same refusal on every other op, never a retriable "unavailable".
    if (status === 409 && ASSERTION_REFUSAL_CODES.has(code)) {
      const reason = refusalReason(body);
      log('warn', { op: 'read', outcome: OUTCOME.assertionRejected, code, reason, http_status: status });
      return { kind: OUTCOME.assertionRejected, code, reason };
    }
    // Anything else (the backend dark, partner identity not adopted, 5xx, a malformed body) says nothing about
    // the hand-off.
    log('warn', { op: 'read', outcome: OUTCOME.unavailable, code: code || `http_${status}`, http_status: status });
    return { kind: OUTCOME.unavailable, code: code || `http_${status}` };
  }

  return { record, read, timeoutMs };
}

module.exports = {
  HANDOFF_RECORD_ID_RE,
  OUTCOME,
  QUOTE_SOURCE,
  STOREFRONT_HANDOFFS_PATH,
  STOREFRONT_HANDOFF_RECORD_ENV,
  createStorefrontHandoffClient,
  escalationIdBinding,
  mintHandoffRecordId,
  storefrontHandoffFlagOn,
  storefrontHandoffRecordEnabled,
};
