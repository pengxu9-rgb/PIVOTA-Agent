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
// The backend's failure / refusal / hold codes, mapped to plain language. A code is NEVER shown to the buyer.
// Mirrors pivota-backend 354670505 (services/payment_orchestration/a2a_rail_worker.py: `_CHECKOUT_HOLD_CODES` (22),
// `_VIC_HOLD_CODES`, and the worker's terminal and parking codes).
//
// SEGMENTS. Codes are lower-cased and split on ':'. `paid_sent:<n>:<variant>:<code>`, `bound_sent:<n>:<code>`: the
// step prefixes are BOOKKEEPING and are skipped (`paid` is the approval-page step: the rail mints a token and nothing
// is charged). A code with a suffix (`checkout_card_unavailable:<why>`, `checkout_setup_refused:<kind>:<status>`,
// `checkout_confirm_refused:http_error:422`) matches on its head segment, because every segment is read.
//
// PRECEDENCE, highest first, over ALL the segments of ALL the codes on the purchase (refusal_reason and
// last_error_code alike):
//   1. HELD (the purchase is held for a check; money may have moved): outcome_unknown, "don't try again", no retry.
//      If ANYTHING on the purchase says money may have moved, the page never says "no order was sent".
//   2. FAILED (terminal, nothing was submitted to the store): the not_submitted wording.
//   3. the other NAMED lists (declined, approval timed out, card, price, refusals, ...): their wording.
//   4. the SHAPE heuristic (a new code of the hold families): outcome_unknown.
//   5. the state's generic wording: neutral, no "try again".
// Every explicit list beats the shape in both directions: `checkout_setup_unrecognised` is a FAILED code although its
// name has the shape of a hold, and `vic_quote_mismatch` is a pre-submit price check.
// While NOT terminal: a HELD (or hold-shaped) code in `placing` shows the checking screen, and a PARKED code (the
// rail paused the purchase before its checkout step) shows "Getting things ready…"; polling goes on in both.

/** Terminal, nothing submitted to the store. */
const FAILED_CODES = new Set([
  'checkout_contact_incomplete', 'checkout_relay_refused', 'checkout_lock_invalid', 'checkout_price_missing',
  'checkout_token_unavailable', 'checkout_card_unavailable', 'checkout_setup_incomplete', 'checkout_setup_unrecognised',
  'checkout_setup_refused', 'checkout_confirm_refused', 'checkout_confirm_total_refused',
  'checkout_captcha_failed', 'checkout_form_error', 'checkout_pay_disabled', 'token_currency_unsupported',
  'token_request_unresolved', 'pay_step_unavailable',
  // Pre-store terminal failures whose names have the shape of a hold (the backend ends each before anything reaches
  // the store; `vic_order_unresolved`: "the submit made nothing"). Listed so the shape never words them as unknown.
  'binding_answer_unrecognised', 'approval_answer_unrecognised', 'token_answer_unrecognised', 'token_mismatch',
  'vic_quote_unrecognised', 'vic_quote_currency_mismatch', 'vic_order_unresolved',
  // An OPERATOR ended a held checkout after checking the provider's side: no order and no charge
  // (pivota-backend jobs/a2a_rail_operator.py). Its own wording below.
  'operator_confirmed_not_charged',
]);

/** The one FAILED code whose wording may say the buyer was not charged: a human verified it at the provider. */
const OPERATOR_NOT_CHARGED_CODES = new Set(['operator_confirmed_not_charged']);

/** Held for a check (the backend keeps the purchase in `paying`): the order may exist, or money may have moved. */
const HELD_CODES = new Set([
  // _CHECKOUT_HOLD_CODES
  'checkout_confirm_unresolved', 'checkout_confirm_unrecognised', 'checkout_confirm_text_only',
  'checkout_confirm_error_card', 'checkout_confirm_conflict', 'checkout_confirm_ambiguous_4xx',
  'checkout_setup_submitted', 'checkout_setup_unresolved', 'checkout_task_invalid', 'checkout_task_mismatch',
  'checkout_result_unrecognised', 'checkout_result_overdue', 'checkout_total_unverified', 'checkout_total_over_approved',
  'checkout_payment_no_order', 'checkout_order_id_card_shaped', 'checkout_unknown_timeout',
  'checkout_unknown_script_error', 'checkout_cancel_unresolved', 'checkout_confirm_pending_check',
  'checkout_confirm_not_sent', 'checkout_paying_without_task',
  'money_result_seen',
  // _VIC_HOLD_CODES
  'vic_order_stale', 'vic_total_over_approved', 'vic_currency_mismatch', 'vic_currency_missing', 'vic_total_missing',
  'vic_approved_amount_missing', 'vic_submit_unresolved',
  // The other outcome-unknown codes the worker writes.
  'outcome_unknown', 'vic_order_outcome_unknown', 'pending_write_unreconcilable',
  'vic_status_inconsistent', 'vic_order_mismatch', 'checkout_outcome_unknown', 'charge_pending', 'money_result_parked',
  'vic_held',
]);

/** Paused before the checkout step; not terminal. */
const PARKED_CODES = new Set(['checkout_step_disabled', 'checkout_schema_incomplete']);

const OUTCOME_UNKNOWN_SHAPE_RE = /(?:outcome_unknown|unresolved|unreconcil|unrecognised|unrecognized|ambiguous|mismatch|parked|inconsistent|charge_pending|money_result)/;

const OUTCOME_UNKNOWN_COPY = Object.freeze({
  kind: 'outcome_unknown',
  title: "We're checking with the store",
  message: "We're checking with the store — don't try again. Your order may already be in progress, and we'll confirm what happened in the chat.",
  retry_hint: false,
  outcome_unknown: true,
});

const HELD_COPY = Object.freeze({
  kind: 'held',
  title: "We're checking with the store",
  message: "We're checking with the store — don't try again. This can take a while; we'll confirm what happened in the chat.",
  retry_hint: false,
  outcome_unknown: true,
});

const PARKED_COPY = Object.freeze({
  kind: 'parked',
  title: 'Getting things ready…',
  message: 'This is taking a little longer than usual. This page updates on its own.',
  retry_hint: false,
  outcome_unknown: false,
});

const NOT_CHARGED_COPY = Object.freeze({
  kind: 'not_charged',
  title: "This purchase didn't go through",
  message: "This purchase didn't go through and you weren't charged. You can start again from the chat.",
  retry_hint: true,
  outcome_unknown: false,
});

const NOT_SUBMITTED_COPY = Object.freeze({
  kind: 'not_submitted',
  title: "This purchase didn't go through",
  message: "The store's checkout couldn't be completed, so no order was sent to the store.",
  retry_hint: false,
  outcome_unknown: false,
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
    codes: ['binding_refused', 'token_refused', 'token_failed', 'token_method_unavailable', 'method_not_listed',
      'vic_method_missing'],
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
    // The rail's own refusals of the checkout (refusal_reason): plain refusal wording.
    kind: 'checkout_refused',
    codes: ['checkout_currency_unsupported', 'checkout_ceiling_over_cap', 'checkout_ceiling_over_rail_limit'],
    title: "This purchase couldn't be started",
    message: "Our payment partner couldn't take this purchase. Go back to the chat for other options.",
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
    message: "It wasn't completed in time. Go back to the chat to check on it or to start again.",
    retry_hint: true,
  },
});

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const SEGMENT_RE = /^[a-z0-9_]{1,64}$/;
/** Step prefixes: bookkeeping, never matched against any list. */
const BOOKKEEPING_SEGMENTS = new Set(['paid_sent', 'bound_sent']);

/** Every well-formed segment of every code: lower-cased, split on ':', step prefixes skipped. A field holding a
 * list of codes is read as those codes (one level). */
function codeSegments(codes) {
  const out = [];
  const flat = (Array.isArray(codes) ? codes : []).flatMap((c) => (Array.isArray(c) ? c : [c]));
  for (const code of flat) {
    if (typeof code !== 'string' || code.length > 512) continue;
    for (const part of code.toLowerCase().split(':')) {
      const seg = part.trim();
      if (SEGMENT_RE.test(seg) && !BOOKKEEPING_SEGMENTS.has(seg)) out.push(seg);
    }
  }
  return out;
}

function isExplicit(seg) {
  return FAILED_CODES.has(seg) || HELD_CODES.has(seg) || PARKED_CODES.has(seg) || REASON_BY_CODE.has(seg);
}

/** What the codes say, by the precedence above: 'failed' | 'held' | a named group | 'shape_unknown' | null. */
function classify(segments) {
  if (segments.some((seg) => HELD_CODES.has(seg))) return { kind: 'held' };
  if (segments.some((seg) => FAILED_CODES.has(seg))) return { kind: 'failed' };
  const named = segments.map((seg) => REASON_BY_CODE.get(seg)).find(Boolean);
  if (named) return { kind: 'named', group: named };
  if (segments.some((seg) => !isExplicit(seg) && OUTCOME_UNKNOWN_SHAPE_RE.test(seg))) return { kind: 'shape_unknown' };
  return null;
}

/** True when the codes, by the precedence above, say the outcome is unknown (held, or hold-shaped). */
function isOutcomeUnknownCode(code) {
  const c = classify(codeSegments(Array.isArray(code) ? code : [code]));
  return Boolean(c) && (c.kind === 'held' || c.kind === 'shape_unknown');
}

/**
 * The plain-language outcome for the state, from its codes:
 *   failed / refused / expired  -> by the precedence above
 *   ANY state not yet final     -> the checking wording while held (an EXPLICIT HELD code before placing; held or
 *                                  hold-shaped from placing on): the page then shows no buyer step at all (a held
 *                                  VIC row can still be in awaiting_buyer_authorization);
 *                                  else, while parked: "Getting things ready…", except in placing, where a confirm may
 *                                  already have gone out, so the checking wording; else null
 *   completed                   -> null
 */
// Before `placing` the buyer may still have a step to take, and the backend's own READ-RETRY codes have the hold shape
// (`vic_status:unrecognised`, `paid_sent:<n>:await:await_answer_unrecognised`, `vic_quote:unrecognised:<n>`); one of
// them sticks on the row for the whole approval window. So there, only an EXPLICIT HELD code drops the step: the shape
// fallback applies from `placing` on (where a confirm may have gone out) and in final states.
const PRE_PLACING_STATES = new Set(['routing', 'needs_payment_method', 'locking', 'awaiting_buyer_authorization', 'unknown']);

function outcomeFor(state, codes) {
  const segments = codeSegments(codes);
  const c = classify(segments);
  if (!TERMINAL_STATES.has(state)) {
    const preplacing = PRE_PLACING_STATES.has(state);
    if (c && (c.kind === 'held' || (c.kind === 'shape_unknown' && !preplacing))) return { ...HELD_COPY };
    if (segments.some((seg) => PARKED_CODES.has(seg))) return state === 'placing' ? { ...HELD_COPY } : { ...PARKED_COPY };
    return null;
  }
  if (!GENERIC_BY_STATE[state]) return null;
  if (c && c.kind === 'failed') {
    // HELD has already won above if any hold code is present.
    return segments.some((seg) => OPERATOR_NOT_CHARGED_CODES.has(seg)) ? { ...NOT_CHARGED_COPY } : { ...NOT_SUBMITTED_COPY };
  }
  if (c && (c.kind === 'held' || c.kind === 'shape_unknown')) return { ...OUTCOME_UNKNOWN_COPY };
  if (c && c.kind === 'named') {
    const { codes: _codes, ...copy } = c.group;
    return { ...copy, outcome_unknown: false };
  }
  return { ...GENERIC_BY_STATE[state], outcome_unknown: false };
}

/**
 * The screen the page shows. `state` is the unified state; `actionKind` the vetted action's kind, or null.
 *   routing                          -> preparing
 *   needs_payment_method             -> add_card
 *   locking                          -> confirming_total (the merchant prices the exact cart; nothing approved yet)
 *   awaiting_buyer_authorization     -> approve
 *   placing                          -> placing, or authenticate while the bank's check page is offered, or
 *                                       outcome_unknown (NOT terminal: polling goes on) while a hold code is set
 *   ANY state with a held (or hold-shaped) code -> outcome_unknown, with the buyer step dropped
 *   any non-terminal with a parked code (and no action to take) -> parked (NOT terminal)
 *   completed                        -> done
 *   failed / refused / expired       -> failed / refused / expired, or outcome_unknown for a held code
 *   anything else                    -> unknown (keep polling; claim nothing)
 */
function screenFor(state, { actionKind = null, outcome = null } = {}) {
  // Held, in any state: the checking screen, never a buyer step.
  if (outcome && outcome.outcome_unknown) return 'outcome_unknown';
  if (outcome && outcome.kind === 'parked' && !actionKind) return 'parked';
  switch (state) {
    case 'routing': return 'preparing';
    case 'needs_payment_method': return 'add_card';
    case 'locking': return 'confirming_total';
    case 'awaiting_buyer_authorization': return 'approve';
    case 'placing':
      if (outcome && outcome.outcome_unknown) return 'outcome_unknown';
      return actionKind === 'authenticate' ? 'authenticate' : 'placing';
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
  // Two currencies that disagree: no amount is shown at all (none could be trusted to be in the right currency).
  // A currency that is not an ISO 4217 upper-case code (e.g. 'eur') also counts as a disagreement.
  const presentCurrencies = [totals.currency, pick('currency')].filter((c) => c !== undefined && c !== null && c !== '');
  const currencies = presentCurrencies.filter((c) => typeof c === 'string' && CURRENCY_RE.test(c));
  const currencyConflict = currencies.length !== presentCurrencies.length || new Set(currencies).size > 1;
  const currency = currencyConflict ? null : currencies[0] || null;
  const amount = (value) => (currencyConflict ? null : minor(value));

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
      // A completed purchase always carries a verified final total; only two disagreeing currencies hide it (the
      // page then says "see your email receipt").
      total_unparsed: currencyConflict,
    };
  }

  const outcome = outcomeFor(state, codes);
  // A held purchase offers the buyer NO step, whatever the rail still lists: approving or adding a card on an order
  // that may already be on its way to the store is exactly what "don't try again" forbids.
  if (outcome && outcome.outcome_unknown) action = null;
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
      unit_price_minor: amount(totals.our_price_minor),
      quoted_total_minor: amount(totals.quoted_total_minor),
      final_total_minor: amount(totals.final_total_minor),
      shipping_minor: amount(totals.shipping_minor),
      tax_minor: amount(totals.tax_minor),
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
  FAILED_CODES,
  HELD_CODES,
  codeSegments,
  isOutcomeUnknownCode,
  outcomeFor,
  projectPurchaseView,
  screenFor,
};
