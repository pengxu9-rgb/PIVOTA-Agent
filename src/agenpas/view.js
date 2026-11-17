'use strict';

/*
 * The SAFE projection of the backend's unified purchase view for the buyer's AgenPas page, and the state -> screen
 * mapping the page renders.
 *
 * INPUT. The body of the backend's unified purchase read (pivota-backend docs/agent_purchases_routes.md):
 *   top level  purchase_id, rail, executor, rail_purchase_id, state, rail_state, created_at, totals{...},
 *              poll_after_seconds, next_action{type, kind, url, expires_at}, order_reference, detail{...}
 *   detail     (the rail's owner view) merchant_domain, product_name, variant_title, quantity, currency,
 *              refusal_reason, last_error_code, merchant_order_status_url, ...
 * Read tolerantly: a field is taken from the top level first, then from `detail`, so a flatter body (the same names
 * at the top level, `action` instead of `next_action`) projects the same. Unknown extra fields are ignored.
 *
 * OUTPUT. An ALLOWLIST: only the fields below are ever copied, each validated. Never in it: the rail, the executor,
 * any id other than the purchase id the link names, owner hashes, consent records, raw failure codes, `detail`.
 * A hosted page URL is passed on only when it passes the gateway's own allowlist (hostedUrl.js), its kind matches
 * the state, and it has not expired.
 */

const { isAllowedHostedUrl } = require('./hostedUrl');

const KNOWN_STATES = Object.freeze([
  'routing', 'needs_payment_method', 'locking', 'awaiting_buyer_authorization', 'placing',
  'completed', 'failed', 'refused', 'expired',
]);
const TERMINAL_STATES = new Set(['completed', 'failed', 'refused', 'expired']);

/** The buyer page each kind belongs to, by state. A page offered in any other state is stale and not shown. */
const ACTION_KIND_FOR_STATE = Object.freeze({
  needs_payment_method: 'card_binding',
  awaiting_buyer_authorization: 'approval',
  placing: 'authenticate',
});

const POLL_MIN_SECONDS = 2;
const POLL_MAX_SECONDS = 15;
const POLL_DEFAULT_SECONDS = 5;
const MAX_TEXT_CHARS = 200;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ORDER_REF_RE = /^[A-Za-z0-9#._:/-]{1,64}$/;

// ---- failure reasons -------------------------------------------------------------------------------------------
//
// The backend's failure/refusal codes, mapped to plain language. A code is NEVER shown to the buyer. Three rules:
//   1. An OUTCOME-UNKNOWN code (the order may or may not have been placed) always says "We're checking with the
//      store — don't try again", and never offers a retry. Matched by the list AND by shape, so a new code of that
//      family is caught without a change here.
//   2. Only codes on an explicit list say the buyer may try again from the chat. Everything else does not.
//   3. An unknown code gets the state's generic wording, without a retry hint.

const OUTCOME_UNKNOWN_CODES = new Set([
  'outcome_unknown', 'vic_order_outcome_unknown', 'vic_order_unresolved', 'vic_submit_unresolved',
  'pending_write_unreconcilable', 'money_result_parked', 'vic_status_inconsistent', 'vic_order_mismatch',
  'checkout_outcome_unknown', 'charge_pending',
]);
const OUTCOME_UNKNOWN_SHAPE_RE = /(?:outcome_unknown|unresolved|unreconcil|parked|inconsistent|charge_pending)/;

const OUTCOME_UNKNOWN_COPY = Object.freeze({
  kind: 'outcome_unknown',
  title: "We're checking with the store",
  message: "We're checking with the store — don't try again. Your order may already be in progress, and we'll confirm what happened in the chat.",
  retry_hint: false,
  outcome_unknown: true,
});

const REASON_GROUPS = [
  {
    kind: 'declined',
    codes: ['vic_authorization_declined'],
    title: 'The approval was declined',
    message: "Your card issuer didn't approve this purchase, so the order wasn't placed.",
    retry_hint: true,
  },
  {
    kind: 'approval_timed_out',
    codes: ['vic_authorization_expired', 'vic_authorization_overdue', 'vic_buyer_abandoned'],
    title: 'The approval timed out',
    message: "The purchase wasn't approved in time, so the order wasn't placed.",
    retry_hint: true,
  },
  {
    kind: 'card_not_added',
    codes: ['binding_refused', 'token_refused', 'token_failed', 'token_method_unavailable', 'token_currency_unsupported',
      'method_not_listed', 'vic_method_missing'],
    title: "Your card couldn't be used",
    message: "The card couldn't be set up for this purchase, so the order wasn't placed.",
    retry_hint: true,
  },
  {
    kind: 'price_changed',
    codes: ['price_changed', 'vic_quote_price_changed', 'vic_quote_mismatch', 'row_price_stale'],
    title: 'The price changed',
    message: "The store's price changed before the order was placed, so it wasn't placed.",
    retry_hint: true,
  },
  {
    kind: 'over_approved_amount',
    codes: ['vic_quote_over_limit', 'vic_total_over_approved', 'amount_over_limit'],
    title: 'The total was higher than allowed',
    message: "The final total came in above the amount that can be approved, so the order wasn't placed.",
    retry_hint: false,
  },
  {
    kind: 'not_purchasable',
    codes: ['merchant_not_eligible', 'merchant_disabled', 'merchant_not_purchasable', 'row_not_found', 'row_unpriced',
      'row_price_ambiguous', 'row_not_shopify', 'row_variant_unverified', 'row_variant_ambiguous',
      'row_currency_mismatch', 'seller_identity_unverified', 'currency_unsupported', 'vic_currency_unsupported'],
    title: "This item can't be bought here right now",
    message: "This item can't be bought through AgenPas at the moment. Nothing more needs to be done.",
    retry_hint: false,
  },
  {
    kind: 'details_needed',
    codes: ['invalid_address', 'consent_required', 'vic_contact_missing'],
    title: 'Some details were missing',
    message: 'The store needs a bit more information. Go back to the chat to check your details.',
    retry_hint: true,
  },
];
const REASON_BY_CODE = new Map();
for (const group of REASON_GROUPS) {
  for (const code of group.codes) REASON_BY_CODE.set(code, group);
}

const GENERIC_BY_STATE = Object.freeze({
  failed: {
    kind: 'failed',
    title: "This purchase didn't go through",
    message: 'Something went wrong. Go back to the chat to check what happened before you try again.',
    retry_hint: false,
  },
  refused: {
    kind: 'refused',
    title: "This purchase couldn't be started",
    message: "The store or our payment partner couldn't accept this purchase. Go back to the chat for other options.",
    retry_hint: false,
  },
  expired: {
    kind: 'expired',
    title: 'This purchase expired',
    message: "It wasn't completed in time, so the order wasn't placed. You can start again from the chat.",
    retry_hint: true,
  },
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOutcomeUnknownCode(code) {
  return typeof code === 'string' && (OUTCOME_UNKNOWN_CODES.has(code) || OUTCOME_UNKNOWN_SHAPE_RE.test(code));
}

/** The plain-language outcome for a terminal non-completed state, from its codes. Null for any other state. */
function outcomeFor(state, codes) {
  if (!GENERIC_BY_STATE[state]) return null;
  const list = (Array.isArray(codes) ? codes : []).filter((c) => typeof c === 'string' && /^[a-z0-9_]{1,64}$/.test(c));
  if (list.some(isOutcomeUnknownCode)) return { ...OUTCOME_UNKNOWN_COPY };
  for (const code of list) {
    const group = REASON_BY_CODE.get(code);
    if (group) {
      const { codes: _codes, ...copy } = group;
      return { ...copy, outcome_unknown: false };
    }
  }
  return { ...GENERIC_BY_STATE[state], outcome_unknown: false };
}

/**
 * The screen the page shows. `state` is the unified state; `actionKind` the vetted action's kind, or null.
 *   routing                          -> preparing
 *   needs_payment_method             -> add_card
 *   locking                          -> confirming_total (the merchant prices the exact cart; nothing approved yet)
 *   awaiting_buyer_authorization     -> approve
 *   placing                          -> placing, or authenticate while the bank's check page is offered
 *   completed                        -> done
 *   failed / refused / expired       -> failed / refused / expired, or outcome_unknown for an outcome-unknown code
 *   anything else                    -> unknown (keep polling; claim nothing)
 */
function screenFor(state, { actionKind = null, outcome = null } = {}) {
  switch (state) {
    case 'routing': return 'preparing';
    case 'needs_payment_method': return 'add_card';
    case 'locking': return 'confirming_total';
    case 'awaiting_buyer_authorization': return 'approve';
    case 'placing': return actionKind === 'authenticate' ? 'authenticate' : 'placing';
    case 'completed': return 'done';
    case 'failed':
    case 'refused':
    case 'expired':
      return outcome && outcome.outcome_unknown ? 'outcome_unknown' : state;
    default: return 'unknown';
  }
}

function cleanText(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const out = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!out) return null;
  return out.length > MAX_TEXT_CHARS ? `${out.slice(0, MAX_TEXT_CHARS - 1)}…` : out;
}

function minor(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isoOrNull(value, nowMs) {
  if (typeof value !== 'string') return { iso: null, past: false };
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return { iso: null, past: false };
  return { iso: new Date(t).toISOString(), past: t <= nowMs };
}

function merchantOrderUrlAllowed(url, merchantDomain) {
  if (typeof url !== 'string' || url.length > 2048 || !merchantDomain) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port !== '' && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return host === merchantDomain || host.endsWith(`.${merchantDomain}`);
}

/**
 * Project one backend body for the page.
 * @param {object} body  the backend's unified purchase body
 * @param {{ purchaseId: string, hostedHosts: string[], embed?: boolean, now?: number, linkExpiresAt?: number }} opts
 *        linkExpiresAt is the link token's `exp` (unix seconds)
 */
function projectPurchaseView(body, { purchaseId, hostedHosts = [], embed = false, now, linkExpiresAt } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const src = isPlainObject(body) ? body : {};
  const detail = isPlainObject(src.detail) ? src.detail : {};
  const pick = (name) => (src[name] !== undefined && src[name] !== null ? src[name] : detail[name]);
  const totals = isPlainObject(src.totals) ? src.totals : isPlainObject(detail.totals) ? detail.totals : src;

  const rawState = typeof src.state === 'string' ? src.state : null;
  const state = KNOWN_STATES.includes(rawState) ? rawState : 'unknown';
  const terminal = TERMINAL_STATES.has(state);

  const domainRaw = typeof pick('merchant_domain') === 'string' ? pick('merchant_domain').trim().toLowerCase().replace(/\.$/, '') : '';
  const merchantDomain = DOMAIN_RE.test(domainRaw) ? domainRaw : null;
  const quantity = Number.isSafeInteger(pick('quantity')) && pick('quantity') >= 1 && pick('quantity') <= 99 ? pick('quantity') : null;
  const currency = [totals.currency, pick('currency')].find((c) => typeof c === 'string' && CURRENCY_RE.test(c)) || null;

  // The buyer's action: the unified `next_action`, or a flatter `action` / `buyer_action`.
  const rawAction = [src.next_action, src.action, src.buyer_action].find(isPlainObject) || null;
  let action = null;
  const expectedKind = ACTION_KIND_FOR_STATE[state] || null;
  if (rawAction && expectedKind && rawAction.kind === expectedKind) {
    const url = typeof rawAction.url === 'string' ? rawAction.url : rawAction.action_url;
    const expires = isoOrNull(rawAction.expires_at, nowMs);
    if (isAllowedHostedUrl(url, hostedHosts) && !expires.past) {
      action = { kind: expectedKind, url, expires_at: expires.iso, open_mode: embed ? 'embed' : 'popup' };
    }
  }

  let order = null;
  if (state === 'completed') {
    const refRaw = [src.order_reference, detail.order_reference, src.merchant_order_id, detail.merchant_order_id]
      .find((v) => typeof v === 'string' && ORDER_REF_RE.test(v.trim()));
    const statusRaw = [detail.merchant_order_status_url, src.merchant_order_status_url, src.merchant_order_url]
      .find((v) => typeof v === 'string');
    order = {
      reference: refRaw ? refRaw.trim() : null,
      status_url: merchantOrderUrlAllowed(statusRaw, merchantDomain) ? statusRaw : null,
    };
  }

  const codes = [detail.refusal_reason, detail.last_error_code, src.refusal_reason, src.last_error_code,
    src.failure_code, src.refusal_code, src.error_code];
  const outcome = outcomeFor(state, codes);
  const screen = screenFor(state, { actionKind: action ? action.kind : null, outcome });

  let poll = null;
  if (!terminal) {
    const n = Number(src.poll_after_seconds);
    poll = Number.isFinite(n) && n > 0 ? Math.min(POLL_MAX_SECONDS, Math.max(POLL_MIN_SECONDS, Math.round(n))) : POLL_DEFAULT_SECONDS;
  }

  return {
    purchase_id: purchaseId,
    state,
    screen,
    terminal,
    merchant_domain: merchantDomain,
    product_name: cleanText(pick('product_name')),
    variant_title: cleanText(pick('variant_title')),
    quantity,
    currency,
    amounts: {
      unit_price_minor: minor(totals.our_price_minor),
      quoted_total_minor: minor(totals.quoted_total_minor),
      final_total_minor: minor(totals.final_total_minor),
      shipping_minor: minor(totals.shipping_minor),
      tax_minor: minor(totals.tax_minor),
    },
    action,
    order,
    outcome,
    poll_after_seconds: poll,
    link_expires_at: Number.isSafeInteger(linkExpiresAt) ? new Date(linkExpiresAt * 1000).toISOString() : null,
  };
}

module.exports = {
  ACTION_KIND_FOR_STATE,
  KNOWN_STATES,
  POLL_MAX_SECONDS,
  POLL_MIN_SECONDS,
  isOutcomeUnknownCode,
  outcomeFor,
  projectPurchaseView,
  screenFor,
};
