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
// The backend's failure/refusal codes, mapped to plain language. A code is NEVER shown to the buyer.
//
// COMPOUND CODES. The backend writes codes such as `paid_sent:<n>:<variant>:<code>`, `bound_sent:<n>:<code>` and
// `binding_refused:<kind>:<status>`. Every code is lower-cased and split on ':', and EVERY segment is tested.
//
// Rules, in order:
//   1. OUTCOME UNKNOWN WINS. Any segment that is an outcome-unknown or hold code (money may have moved, or the
//      purchase is held for a human) makes the purchase outcome_unknown: "We're checking with the store — don't try
//      again", never "wasn't placed", never a retry hint. Matched by the list AND by shape, so a new code of that
//      family is caught without a change here.
//   2. Otherwise the first segment on a named list gives that list's wording. Only some lists carry a hint that the
//      buyer may start again from the chat.
//   3. Otherwise the state's generic wording: neutral, and without a "try again" hint.

const OUTCOME_UNKNOWN_CODES = new Set([
  // The order may exist.
  'outcome_unknown', 'vic_order_outcome_unknown', 'vic_order_unresolved', 'vic_submit_unresolved',
  'pending_write_unreconcilable', 'vic_status_inconsistent', 'vic_order_mismatch', 'checkout_outcome_unknown',
  'charge_pending',
  // Money may have moved, or the purchase is held for a human.
  'paid_sent', 'money_result_seen', 'money_result_parked', 'vic_held',
  'vic_order_stale', 'vic_total_over_approved', 'vic_currency_mismatch', 'vic_currency_missing', 'vic_total_missing',
  'vic_approved_amount_missing',
  // The rail's checkout step.
  'checkout_confirm_unresolved', 'checkout_confirm_error_card', 'checkout_confirm_conflict', 'checkout_payment_no_order',
  'checkout_unknown_timeout', 'checkout_unknown_script_error', 'checkout_total_over_approved', 'checkout_result_overdue',
  'checkout_cancel_unresolved', 'checkout_order_id_card_shaped',
]);
const OUTCOME_UNKNOWN_SHAPE_RE = /(?:outcome_unknown|unresolved|unreconcil|parked|inconsistent|charge_pending|money_result)/;

/** On a COMPLETED purchase: the order was placed, but the final total could not be read. */
const TOTAL_UNPARSED_CODES = new Set(['checkout_total_unparsed']);

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
    codes: ['vic_quote_over_limit', 'amount_over_limit'],
    title: 'The total was higher than allowed',
    message: "The total came in above the amount that can be approved, so the order wasn't placed.",
    retry_hint: false,
  },
  {
    // The rail's checkout step stopped BEFORE anything was submitted to the store.
    kind: 'not_submitted',
    codes: ['checkout_captcha_failed', 'checkout_form_error', 'checkout_pay_disabled', 'checkout_setup_incomplete',
      'checkout_contact_incomplete', 'checkout_ceiling_over_cap', 'checkout_ceiling_over_rail_limit',
      'checkout_price_missing', 'checkout_currency_unsupported', 'checkout_confirm_not_accepted',
      'checkout_schema_incomplete'],
    title: "This purchase didn't go through",
    message: "The store's checkout couldn't be completed, so no order was sent to the store.",
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
    title: "This purchase didn't complete",
    message: 'Go back to the chat for the latest on this purchase.',
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

const SEGMENT_RE = /^[a-z0-9_]{1,64}$/;

/** Every well-formed segment of every code: lower-cased, split on ':'. */
function codeSegments(codes) {
  const out = [];
  for (const code of Array.isArray(codes) ? codes : []) {
    if (typeof code !== 'string' || code.length > 512) continue;
    for (const part of code.toLowerCase().split(':')) {
      const seg = part.trim();
      if (SEGMENT_RE.test(seg)) out.push(seg);
    }
  }
  return out;
}

/** True when any segment of the code (or codes) is outcome-unknown or a hold. */
function isOutcomeUnknownCode(code) {
  return codeSegments(Array.isArray(code) ? code : [code])
    .some((seg) => OUTCOME_UNKNOWN_CODES.has(seg) || OUTCOME_UNKNOWN_SHAPE_RE.test(seg));
}

/** The plain-language outcome for a terminal non-completed state, from its codes. Null for any other state. */
function outcomeFor(state, codes) {
  if (!GENERIC_BY_STATE[state]) return null;
  const segments = codeSegments(codes);
  if (isOutcomeUnknownCode(segments)) return { ...OUTCOME_UNKNOWN_COPY };
  for (const seg of segments) {
    const group = REASON_BY_CODE.get(seg);
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
 * @param {{ purchaseId: string, hostedHosts: string[], embed?: boolean, now?: number, linkExpiresAt?: number,
 *           linkTtlMinutes?: number }} opts
 *        linkExpiresAt is the link token's `exp` (unix seconds); linkTtlMinutes its lifetime, for the page's copy
 */
function projectPurchaseView(body, { purchaseId, hostedHosts = [], embed = false, now, linkExpiresAt, linkTtlMinutes } = {}) {
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
    // A page with no readable deadline is not shown: the buyer could be sent to a page that has silently lapsed.
    // The URL goes out in its PARSED, re-serialized form (what the allowlist judged), never the raw string.
    if (isAllowedHostedUrl(url, hostedHosts) && expires.iso && !expires.past) {
      action = { kind: expectedKind, url: new URL(url).href, expires_at: expires.iso, open_mode: embed ? 'embed' : 'popup' };
    }
  }

  const codes = [detail.refusal_reason, detail.last_error_code, src.refusal_reason, src.last_error_code,
    src.failure_code, src.refusal_code, src.error_code];

  let order = null;
  if (state === 'completed') {
    const refRaw = [src.order_reference, detail.order_reference, src.merchant_order_id, detail.merchant_order_id]
      .find((v) => typeof v === 'string' && ORDER_REF_RE.test(v.trim()));
    const statusRaw = [detail.merchant_order_status_url, src.merchant_order_status_url, src.merchant_order_url]
      .find((v) => typeof v === 'string');
    order = {
      reference: refRaw ? refRaw.trim() : null,
      status_url: merchantOrderUrlAllowed(statusRaw, merchantDomain) ? new URL(statusRaw).href : null,
      // Placed, but the rail could not read the final total: the page says "see your email receipt".
      total_unparsed: codeSegments(codes).some((seg) => TOTAL_UNPARSED_CODES.has(seg)),
    };
  }

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
    link_ttl_minutes: Number.isSafeInteger(linkTtlMinutes) && linkTtlMinutes > 0 ? linkTtlMinutes : null,
  };
}

module.exports = {
  ACTION_KIND_FOR_STATE,
  KNOWN_STATES,
  POLL_MAX_SECONDS,
  POLL_MIN_SECONDS,
  codeSegments,
  isOutcomeUnknownCode,
  outcomeFor,
  projectPurchaseView,
  screenFor,
};
