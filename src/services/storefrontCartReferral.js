'use strict';

/*
 * storefrontCartReferral.js — the referral for a store cart the checkout door builds, gateway side.
 *
 * WHY. The checkout door can build a cart on a seller's own UCP endpoint and hand the buyer that cart's link
 * (mcp-server/src/ucpMerchantDoorPricing.js). The door reads the product with the gateway's own key, so the catalog
 * link it holds is the seller's direct page, not a stamped referral hop: there was nothing to carry onto the cart
 * link, no click was recorded, and a purchase from such a cart could not be joined to us or to the partner.
 *
 * WHAT THIS DOES, behind AGENT_CHECKOUT_UCP_CART_REFERRAL_ENABLED (default OFF, read per call by the door). ONE
 * backend call just before the door sends `create_cart` (POST /agent/v2/storefront-cart-referrals, pivota-backend
 * routes/agent_storefront_referrals.py). The backend writes one click row and answers the tracking members a
 * normal referral destination carries (`utm_*`, `pvt_click_id`), built by its own referral builders. The door
 * carries them on the cart link and, when it sends one, in the cart's `attribution`.
 *
 * WHOSE REFERRAL. The call is made with this gateway's own key. With PARTNER_IDENTITY_FORWARDING_ENABLED on and a
 * partner on the request, it also carries the partner's REQUEST-BOUND assertion (signed over the exact bytes sent),
 * and the backend records the click for that partner. With no partner on the request the call is still sent, and
 * the backend records the click for no agent: it is our evidence of the hand-off and no partner's.
 *
 * WHAT IS SENT. The seller host, the market the buyer named and the observed seller's id. Nothing about the buyer.
 *
 * NEVER FAILS THE CHECKOUT. Every outcome that is not a well-formed referral (the backend dark, down, slow or
 * refusing; an answer that is not exactly tracking members) resolves `{ kind: 'unavailable' | 'refused' }`. The
 * door then follows its named miss policy (ucpMerchantDoorPricing.js REFERRAL_MISS_POLICY).
 *
 * Logs carry an event, an outcome, a code and an HTTP status: never the click id, a header or a body.
 */

const {
  ISSUING_AGENT_ASSERTION_HEADER,
  STOREFRONT_CART_REFERRAL_ENV,
  STOREFRONT_CART_REFERRAL_OP,
  storefrontCartReferralFlagOn,
} = require('../attribution/issuingAgentAssertion');

const STOREFRONT_CART_REFERRALS_PATH = '/agent/v2/storefront-cart-referrals';
// THE TIME THIS CALL MAY TAKE. It sits inside the door's own budget (5 s for discovery plus one cart call, the cart
// call alone capped at 3.5 s), before the cart call. One second leaves the store its full 3.5 s with half a second
// for a cached discovery, and is several times what one authenticated insert takes on the backend; a slower answer
// is a miss, not a slower checkout.
const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 1000;
const MIN_TIMEOUT_MS = 50;

// The same shapes the door's own carrier accepts (ucpMerchantDoorPricing.js): a tracking member name, and a value of
// unreserved characters only, so a carried value can never be a URL and needs no encoding.
const TRACKING_KEY_RE = /^(utm_[a-z0-9_]{1,40}|pvt_[a-z0-9_]{1,40})$/i;
const TRACKING_VALUE_RE = /^[A-Za-z0-9._~-]{1,200}$/;
const CLICK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CLICK_ID_MEMBER = 'pvt_click_id';
const MAX_MEMBERS = 12;

const OUTCOME = Object.freeze({ minted: 'minted', refused: 'refused', unavailable: 'unavailable' });

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

function refusalCode(body) {
  if (!isPlainObject(body)) return null;
  if (isPlainObject(body.detail) && typeof body.detail.error === 'string') return body.detail.error;
  if (typeof body.error === 'string') return body.error;
  if (isPlainObject(body.error) && isPlainObject(body.error.details) && typeof body.error.details.error === 'string') {
    return body.error.details.error;
  }
  return null;
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

/**
 * The referral a backend answer carries: `{ clickId, pairs }` (the members in the backend's own order), or null when
 * the answer is not EXACTLY tracking members naming one click id. All or nothing: a partly readable answer is no
 * referral, so a cart never carries half of one. Pure.
 */
function readReferralAnswer(body) {
  if (!isPlainObject(body) || typeof body.click_id !== 'string' || !CLICK_ID_RE.test(body.click_id)) return null;
  if (!isPlainObject(body.attribution)) return null;
  const entries = Object.entries(body.attribution);
  if (entries.length === 0 || entries.length > MAX_MEMBERS) return null;
  const pairs = [];
  for (const [key, value] of entries) {
    if (!TRACKING_KEY_RE.test(key) || typeof value !== 'string' || !TRACKING_VALUE_RE.test(value)) return null;
    pairs.push([key, value]);
  }
  if (body.attribution[CLICK_ID_MEMBER] !== body.click_id) return null;
  return { clickId: body.click_id, pairs };
}

/**
 * @param {{
 *   baseUrl: string,
 *   authHeaders: () => (object|null),     // the gateway's own key; null when it has none (nothing is sent)
 *   signRequest: ({ op, method, url, rid, rawBody }) => object,   // the partner's assertion, or {} for no partner
 *   fetchImpl?: Function,
 *   timeoutMs?: number,
 *   logger?: { info?: Function, warn?: Function },
 * }} deps
 */
function createStorefrontCartReferralClient(deps = {}) {
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
      fn.call(logger, { event: 'ucp_storefront_cart_referral_call', ...fields }, 'ucp storefront cart referral');
    } catch {
      // A logger fault must never change the answer.
    }
  }

  /**
   * Mint one referral. Resolves `{ kind: 'minted', clickId, pairs, attributed }` (`attributed`: the call named a
   * partner) or `{ kind: 'refused' | 'unavailable', code }`; never throws.
   */
  async function mint({ seller_host: sellerHost, market, merchant_id: merchantId } = {}) {
    if (!baseUrl || typeof fetchImpl !== 'function') return { kind: OUTCOME.unavailable, code: 'unconfigured' };
    const body = { seller_host: sellerHost };
    if (typeof market === 'string' && market) body.market = market;
    if (typeof merchantId === 'string' && merchantId) body.merchant_id = merchantId;
    const url = `${baseUrl}${STOREFRONT_CART_REFERRALS_PATH}`;
    // Serialised ONCE: a partner assertion is hashed over exactly these bytes, and exactly these bytes are sent.
    const rawBody = JSON.stringify(body);
    let base;
    let signed;
    try { base = authHeaders(); } catch { base = null; }
    if (!isPlainObject(base)) {
      log('warn', { outcome: OUTCOME.unavailable, code: 'unconfigured' });
      return { kind: OUTCOME.unavailable, code: 'unconfigured' };
    }
    try { signed = signRequest({ op: STOREFRONT_CART_REFERRAL_OP, method: 'POST', url, rid: null, rawBody }); } catch { signed = null; }
    const assertion = isPlainObject(signed) ? signed[ISSUING_AGENT_ASSERTION_HEADER] : null;
    const headers = { ...base, ...(assertion ? { [ISSUING_AGENT_ASSERTION_HEADER]: assertion } : {}) };
    const controller = new AbortController();
    // NOT unref()'d: an unref'd timer behind an awaited fetch lets the loop drain and the deadline never fires.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status;
    let parsed;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: rawBody,
        signal: controller.signal,
        redirect: 'error',
      });
      status = Number(res && res.status);
      let text = '';
      try { text = typeof res.text === 'function' ? await res.text() : ''; } catch { text = ''; }
      parsed = parseJson(text);
    } catch (err) {
      const code = controller.signal.aborted || (err && err.name === 'AbortError') ? 'timeout' : 'transport';
      log('warn', { outcome: OUTCOME.unavailable, code });
      return { kind: OUTCOME.unavailable, code };
    } finally {
      clearTimeout(timer);
    }
    if (status === 200) {
      const referral = readReferralAnswer(parsed);
      if (referral) {
        log('info', { outcome: OUTCOME.minted, attributed: Boolean(assertion), http_status: status });
        return { kind: OUTCOME.minted, clickId: referral.clickId, pairs: referral.pairs, attributed: Boolean(assertion) };
      }
      log('warn', { outcome: OUTCOME.unavailable, code: 'malformed_answer', http_status: status });
      return { kind: OUTCOME.unavailable, code: 'malformed_answer' };
    }
    // The backend's own snake-case refusal code, else the status: never free text.
    const named = refusalCode(parsed);
    const code = named && /^[A-Za-z0-9_]{1,64}$/.test(named) ? named : `http_${status}`;
    const kind = status >= 500 || !Number.isFinite(status) ? OUTCOME.unavailable : OUTCOME.refused;
    log('warn', { outcome: kind, code, http_status: status });
    return { kind, code };
  }

  return { mint, timeoutMs };
}

module.exports = {
  CLICK_ID_MEMBER,
  DEFAULT_TIMEOUT_MS,
  OUTCOME,
  STOREFRONT_CART_REFERRALS_PATH,
  STOREFRONT_CART_REFERRAL_ENV,
  STOREFRONT_CART_REFERRAL_OP,
  createStorefrontCartReferralClient,
  readReferralAnswer,
  storefrontCartReferralFlagOn,
};
