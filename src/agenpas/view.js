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
 *
 * CONSENT (docs/agenpas.md, "Terms and privacy consent"). The backend's internal read may carry
 * `consent = {required, available, step, satisfied, terms_url, privacy_url, terms_version, privacy_version,
 * offer: {id, issued_at}}`, and while its gate holds the hosted page back, `next_action` / `detail.buyer_step` say
 * `consent_required: true` with no URL. The card and approval steps are GATED when the purchase is on the Reap rail
 * (always: R3-4, whatever the backend sent), or when the body says consent is required. A gated step shows its hosted
 * page ONLY when the consent block says that step is satisfied; otherwise, with AGENPAS_CONSENT_ENABLED on and a
 * complete offer, the page offers the terms (`consent`: the step, the two links and the offer, nothing else); with
 * anything missing, the screen is `unavailable` ("not available right now"). With the flag off no `consent` member is
 * added, and a body without any consent field projects exactly as before.
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

/** The step a consent is taken for, by state: the approval consent may be taken while the total is confirmed. */
const CONSENT_STEP_FOR_STATE = Object.freeze({
  needs_payment_method: 'card_binding',
  locking: 'approval',
  awaiting_buyer_authorization: 'approval',
});
const GATED_KINDS = new Set(['card_binding', 'approval']);
// The backend's consent block: versions are at most 32 printable characters (no space at either end); the offer id is
// the backend's HMAC in hex or base64(url); issued_at is echoed back EXACTLY (it is an HMAC input), so only an
// ISO-8601 UTC instant is accepted.
const CONSENT_VERSION_RE = /^[\x21-\x7e](?:[\x20-\x7e]{0,30}[\x21-\x7e])?$/;
const CONSENT_OFFER_ID_RE = /^[A-Za-z0-9+/=_-]{16,128}$/;
const CONSENT_ISSUED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/;
// The backend's minimum dwell, when it states one (`consent.min_dwell_seconds`, or the offer's): whole seconds.
const CONSENT_MAX_DWELL_SECONDS = 120;

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
// Mirrors pivota-backend 732733b93 (services/payment_orchestration/a2a_rail_worker.py: `_CHECKOUT_HOLD_CODES` (23),
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

// ---- the Reap rail's codes (pivota-backend services/reap_agentic_purchase.py, enumerated from its code) -----------
//
// HELD: a Reap checkout may exist, or its outcome is not known.
//   checkout_unresolvable:<n>:<why>    a checkout we cannot read or resolve (incl. :operator_found_completed, an
//                                      operator attached a checkout that COMPLETED): human review
//   checkout_read_permanent:<n>:<why>  a permanent-shaped read failure of a live checkout (counting towards the above);
//                                      held from placing on only (PRE_PLACING_SOFT_HELD_CODES)
//   checkout_dispatch_unresolved       the create crossed the dispatch boundary with no usable answer
//   checkout_created_hosted_url_refused  Reap created the checkout but its hosted page was refused
// FAILED ("no order was sent"): ONLY codes written before any checkout create (enrollment failures, no active card,
// the quote answered without an id, Reap's ENROLLMENT_NOT_ACTIVE refusal of the create, which creates nothing).
// POST-CHECKOUT (never "no order was sent", never the card wording; the state's generic wording): checkout_failed,
// checkout_expired, checkout_id_missing, partner_id_malformed (also written after a checkout exists).
// approval_window_lapsed: the approval timed out (a named reason, also post-checkout).
// buyer_email_missing (resolving -> failed): "some details were missing".
const REAP_HELD_CODES = Object.freeze([
  'checkout_unresolvable', 'checkout_read_permanent', 'checkout_dispatch_unresolved', 'checkout_created_hosted_url_refused',
]);
const REAP_FAILED_CODES = Object.freeze([
  'enrollment_no_hosted_action', 'enrollment_id_conflict', 'enrollment_row_unreadable', 'enrollment_not_activatable',
  'enrollment_dead', 'enrollment_create_failed', 'enrollment_read_failed', 'no_active_enrollment', 'enrollment_not_active',
  'quote_id_missing',
]);
/**
 * HELD only from `placing` on and in final states. `checkout_read_permanent:<n>` is written after ONE permanent-shaped
 * read failure, below the backend's limit (3, then `checkout_unresolvable`), while the row may still wait in
 * awaiting_approval with a live page; the UCP lane keeps that page too. So before placing it does not drop the step
 * (the buyer has approved nothing yet, and Reap's own page decides); once the buyer has approved, it is held.
 */
const PRE_PLACING_SOFT_HELD_CODES = new Set(['checkout_read_permanent']);
/**
 * PROGRESS, not a hold: codes the Reap worker writes ONLY from a READ (the checkout poll's GET) or from a retry whose
 * result cannot mean money moved, so they keep the state's own wording (in placing: "Placing your order…") and never
 * the checking copy. Explicit, so the hold shape and the `reap_` rule below never decide them; a HELD code beside one
 * still wins. Verified in pivota-backend 0b2749d28 (services/reap_agentic_purchase.py, services/reap_agentic_client.py):
 *   reap_status_503       client `_get` / `_post` f"reap_status_{status}" (client.py:2018, :2321). Written as
 *                         last_error_code only by (a) `_release_checkout_read_failure` after `get_checkout` (GET, the
 *                         poll; purchase.py:4280 -> :4239), and (b) the quote / enrollment POSTs (pre-checkout; a
 *                         quote or a card enrollment moves no money). The checkout CREATE never writes it: undispatched
 *                         it has no HTTP answer; dispatched and not ok it is `checkout_dispatch_unresolved` (or the
 *                         hosted-url hold), purchase.py:4110-4166.
 *   checkout_read_failed  the poll's own fallback when `get_checkout` failed without a code (purchase.py:4280), GET only.
 *   transport_error       `_TRANSPORT_PREFIX` (purchase.py:662), `transport_error:<Type>`: a network failure released
 *                         for retry. From the checkout poll's GET, and from quote / enrollment calls; a dispatched
 *                         checkout create that failed in transport is `checkout_dispatch_unresolved` instead, and one
 *                         that RAISED is `poller_advance_raised:<Type>` (jobs/reap_agentic_purchase_poll.py:956).
 * NOT listed (they fail the test): `checkout_read_recovered` (purchase.py:4283) is also written on a row whose create
 * answer was lost and that an operator attached (services/reap_checkout_recovery.py:408, then the poll);
 * `poller_advance_raised:*` can follow a raised checkout create; other `reap_status_*` are left to the rule below.
 */
const REAP_PROGRESS_CODES = new Set(['reap_status_503', 'checkout_read_failed', 'transport_error']);
/** An unlisted Reap partner status (`reap_status_<n>` and any other `reap_*` code) is read as a hold from placing on. */
const REAP_UNLISTED_PREFIX = 'reap_';
/** Codes that say a checkout may have existed: they keep a FAILED code from saying "no order was sent". */
const POST_CHECKOUT_GENERIC_CODES = new Set(['checkout_failed', 'checkout_expired', 'checkout_id_missing', 'partner_id_malformed']);
const POST_CHECKOUT_CODES = new Set([...POST_CHECKOUT_GENERIC_CODES, 'approval_window_lapsed']);

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
  // REAP (pivota-backend services/reap_agentic_purchase.py): only the codes written BEFORE any Reap checkout exists.
  ...REAP_FAILED_CODES,
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
  // The provider reported payment-reached without success: money may have moved.
  'checkout_payment_reached_unconfirmed',
  'money_result_seen',
  // _VIC_HOLD_CODES
  'vic_order_stale', 'vic_total_over_approved', 'vic_currency_mismatch', 'vic_currency_missing', 'vic_total_missing',
  'vic_approved_amount_missing', 'vic_submit_unresolved',
  // The other outcome-unknown codes the worker writes.
  'outcome_unknown', 'vic_order_outcome_unknown', 'pending_write_unreconcilable',
  'vic_status_inconsistent', 'vic_order_mismatch', 'checkout_outcome_unknown', 'charge_pending', 'money_result_parked',
  'vic_held',
  // The Reap rail's (see above).
  ...REAP_HELD_CODES,
]);

/** Paused before the checkout step; not terminal. */
const PARKED_CODES = new Set(['checkout_step_disabled', 'checkout_schema_incomplete']);

const OUTCOME_UNKNOWN_SHAPE_RE = /(?:outcome_unknown|unresolved|unresolvab|unreconcil|unrecognised|unrecognized|ambiguous|mismatch|parked|inconsistent|charge_pending|money_result)/;

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
    // Reap's `approval_window_lapsed` is the backend's best reading, not a diagnosis (a late approval that then failed
    // reads the same): the copy says the order was not placed, and does not say the buyer failed to approve.
    kind: 'approval_timed_out',
    codes: ['approval_window_lapsed'],
    title: "The approval didn't go through in time",
    message: "The approval didn't go through in time, so the order wasn't placed. You can start again from the chat.",
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
    codes: ['invalid_address', 'consent_required', 'vic_contact_missing', 'buyer_email_missing'],
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
  return FAILED_CODES.has(seg) || HELD_CODES.has(seg) || PARKED_CODES.has(seg) || REASON_BY_CODE.has(seg)
    || POST_CHECKOUT_GENERIC_CODES.has(seg) || REAP_PROGRESS_CODES.has(seg);
}

/** A code the explicit lists do not name, with the hold shape or the `reap_` prefix (an unlisted Reap code). */
function isHoldShaped(seg) {
  return !isExplicit(seg) && (OUTCOME_UNKNOWN_SHAPE_RE.test(seg) || seg.startsWith(REAP_UNLISTED_PREFIX));
}

/** What the codes say, by the precedence above: 'failed' | 'held' | a named group | 'generic' | 'shape_unknown' | null. */
function classify(segments) {
  if (segments.some((seg) => HELD_CODES.has(seg))) return { kind: 'held' };
  // A code that says a checkout may have existed keeps a FAILED code from claiming "no order was sent".
  if (segments.some((seg) => FAILED_CODES.has(seg)) && !segments.some((seg) => POST_CHECKOUT_CODES.has(seg))) return { kind: 'failed' };
  const named = segments.map((seg) => REASON_BY_CODE.get(seg)).find(Boolean);
  if (named) return { kind: 'named', group: named };
  if (segments.some((seg) => POST_CHECKOUT_GENERIC_CODES.has(seg))) return { kind: 'generic' };
  if (segments.some(isHoldShaped)) return { kind: 'shape_unknown' };
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
    const held = c && c.kind === 'held'
      && (!preplacing || segments.some((seg) => HELD_CODES.has(seg) && !PRE_PLACING_SOFT_HELD_CODES.has(seg)));
    if (held || (c && c.kind === 'shape_unknown' && !preplacing)) return { ...HELD_COPY };
    if (segments.some((seg) => PARKED_CODES.has(seg))) return state === 'placing' ? { ...HELD_COPY } : { ...PARKED_COPY };
    return null;
  }
  if (!GENERIC_BY_STATE[state]) return null;
  if (c && c.kind === 'failed') {
    // HELD has already won above if any hold code is present. "You weren't charged" is said ONLY when nothing else on
    // the purchase is even hold-SHAPED: a claim that strong needs a clean record; otherwise, the checking wording.
    if (segments.some((seg) => OPERATOR_NOT_CHARGED_CODES.has(seg))) {
      const holdShaped = segments.some(isHoldShaped);
      return holdShaped ? { ...OUTCOME_UNKNOWN_COPY } : { ...NOT_CHARGED_COPY };
    }
    return { ...NOT_SUBMITTED_COPY };
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

/** The rail a body is on: 'reap' when ANY of its fields says so (fail closed), 'a2a', or null. */
function railOf(src, detail, purchaseId) {
  const ids = [src.rail_purchase_id, detail.id, purchaseId].filter((v) => typeof v === 'string');
  if (src.rail === 'reap' || detail.rail === 'reap' || ids.some((v) => v.startsWith('rp_'))) return 'reap';
  if (src.rail === 'a2a' || ids.some((v) => v.startsWith('ap_'))) return 'a2a';
  return null;
}

/** The backend's consent block, validated field by field (a link off the legal hosts, or not https, is dropped). */
function consentBlockOf(raw, legalHosts) {
  if (!isPlainObject(raw)) return null;
  const legalUrl = (u) => (isAllowedHostedUrl(u, legalHosts) ? new URL(u).href : null);
  const version = (v) => (typeof v === 'string' && CONSENT_VERSION_RE.test(v) ? v : null);
  const offerRaw = isPlainObject(raw.offer) ? raw.offer : null;
  const offer = offerRaw && typeof offerRaw.id === 'string' && CONSENT_OFFER_ID_RE.test(offerRaw.id)
    && typeof offerRaw.issued_at === 'string' && CONSENT_ISSUED_AT_RE.test(offerRaw.issued_at)
    ? { id: offerRaw.id, issued_at: offerRaw.issued_at } : null;
  const dwellRaw = raw.min_dwell_seconds !== undefined ? raw.min_dwell_seconds : (offerRaw ? offerRaw.min_dwell_seconds : undefined);
  const minDwell = Number.isSafeInteger(dwellRaw) && dwellRaw >= 0 && dwellRaw <= CONSENT_MAX_DWELL_SECONDS ? dwellRaw : null;
  return {
    min_dwell_seconds: minDwell,
    required: raw.required === true,
    available: raw.available === true,
    satisfied: raw.satisfied === true,
    step: GATED_KINDS.has(raw.step) ? raw.step : null,
    terms_url: legalUrl(raw.terms_url),
    privacy_url: legalUrl(raw.privacy_url),
    terms_version: version(raw.terms_version),
    privacy_version: version(raw.privacy_version),
    offer,
  };
}

/** A block the buyer can accept now, for `step`: required, available, unsatisfied, complete. */
function isOfferable(block, step) {
  return Boolean(block && block.required && block.available && !block.satisfied && block.step === step
    && block.terms_url && block.privacy_url && block.terms_version && block.privacy_version && block.offer);
}

const DETAILS_NEEDED_COPY = Object.freeze({
  kind: 'details_needed',
  title: 'Some details are needed',
  message: 'Your contact details need to be entered again before this purchase can go on. Go back to the chat to continue.',
  retry_hint: false,
  outcome_unknown: false,
});

/**
 * The view and, when the page would offer the terms, what a consent for it records (`record`: step and the two
 * versions FROM THIS READ). Internal: projectPurchaseView returns the view; consentToRecord the record.
 */
function buildView(body, { purchaseId, hostedHosts = [], embed = false, now, linkExpiresAt, linkTtlMinutes, consentEnabled = false, legalHosts = [] } = {}) {
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

  // THE CONSENT GATE. A card / approval step is gated on the Reap rail (always, R3-4: whatever the body says), and on
  // any rail whose body says consent is required (the backend's gate marker, or its consent block). A gated step
  // shows its hosted page only once the block says THAT step is satisfied: until then no URL reaches the page, even
  // one the body carried.
  const block = consentBlockOf(src.consent !== undefined ? src.consent : detail.consent, legalHosts);
  const buyerStep = [src.buyer_step, detail.buyer_step].find(isPlainObject) || null;
  const marked = Boolean((rawAction && rawAction.consent_required === true) || (buyerStep && buyerStep.consent_required === true));
  const rail = railOf(src, detail, purchaseId);
  const gated = GATED_KINDS.has(expectedKind) && (rail === 'reap' || marked || Boolean(block && block.required));
  const satisfiedFor = (step) => Boolean(block && block.satisfied && block.step === step);
  if (gated && !satisfiedFor(expectedKind)) action = null;
  const consentStep = CONSENT_STEP_FOR_STATE[state] || null;
  const offerable = consentEnabled && consentStep && !satisfiedFor(consentStep) && isOfferable(block, consentStep);
  // Gated, unsatisfied and nothing the buyer can accept here (the flag off, an incomplete block, no block at all):
  // "not available right now". Never a dead approve screen.
  const unavailable = gated && !satisfiedFor(expectedKind) && !offerable;

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

  let outcome = outcomeFor(state, codes);
  // A held purchase offers the buyer NO step, whatever the rail still lists: approving or adding a card on an order
  // that may already be on its way to the store is exactly what "don't try again" forbids.
  if (outcome && outcome.outcome_unknown) action = null;
  let screen = screenFor(state, { actionKind: action ? action.kind : null, outcome });
  // The rail paused the purchase for the buyer's contact details (Reap's `contact_reentry_required`): no card button,
  // no consent; the chat takes the details. Held still wins (screenFor already said outcome_unknown).
  if (!terminal && screen !== 'outcome_unknown' && pick('contact_reentry_required') === true) {
    action = null;
    outcome = { ...DETAILS_NEEDED_COPY };
    screen = 'details_needed';
  }
  if (unavailable && (screen === 'add_card' || screen === 'approve')) screen = 'unavailable';
  const consentScreen = screen === 'add_card' || screen === 'approve' || screen === 'confirming_total';
  let consent = null;
  let record = null;
  if (offerable && consentScreen) {
    // The versions shown are the very values recorded (`record`, below): the buyer sees what the record names.
    consent = {
      step: consentStep, terms_url: block.terms_url, privacy_url: block.privacy_url,
      terms_version: block.terms_version, privacy_version: block.privacy_version, offer: { ...block.offer },
    };
    // Only when the backend states it (the page then waits at least that long plus a second; else its own 4 s).
    if (block.min_dwell_seconds !== null) consent.min_dwell_seconds = block.min_dwell_seconds;
    record = { step: consentStep, terms_version: block.terms_version, privacy_version: block.privacy_version };
  }

  let poll = null;
  if (!terminal) {
    const n = Number(src.poll_after_seconds);
    poll = Number.isFinite(n) && n > 0 ? Math.min(POLL_MAX_SECONDS, Math.max(POLL_MIN_SECONDS, Math.round(n))) : POLL_DEFAULT_SECONDS;
  }

  const view = {
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
  // Only while AGENPAS_CONSENT_ENABLED is on: off, the view has exactly the members it always had.
  if (consentEnabled) view.consent = consent;
  return { view, record };
}

/**
 * Project one backend body for the page.
 * @param {object} body  the backend's unified purchase body
 * @param {{ purchaseId: string, hostedHosts: string[], embed?: boolean, now?: number, linkExpiresAt?: number,
 *           linkTtlMinutes?: number, consentEnabled?: boolean, legalHosts?: string[] }} opts
 *        linkExpiresAt is the link token's `exp` (unix seconds); linkTtlMinutes its lifetime, for the page's copy;
 *        consentEnabled is AGENPAS_CONSENT_ENABLED, legalHosts AGENPAS_LEGAL_HOSTS
 */
function projectPurchaseView(body, opts = {}) {
  return buildView(body, opts).view;
}

/**
 * What accepting the terms on this body would record, or null when the page would not offer them (nothing to accept,
 * a held / paused purchase, the wrong state, the flag off): `{ step, terms_version, privacy_version }`, the versions
 * taken from THIS read, never from the browser.
 */
function consentToRecord(body, opts = {}) {
  return buildView(body, { ...opts, consentEnabled: opts.consentEnabled === true }).record;
}

module.exports = {
  ACTION_KIND_FOR_STATE,
  CONSENT_STEP_FOR_STATE,
  KNOWN_STATES,
  POLL_MAX_SECONDS,
  POLL_MIN_SECONDS,
  FAILED_CODES,
  HELD_CODES,
  POST_CHECKOUT_GENERIC_CODES,
  REAP_FAILED_CODES,
  REAP_HELD_CODES,
  REAP_PROGRESS_CODES,
  codeSegments,
  consentToRecord,
  isOutcomeUnknownCode,
  outcomeFor,
  projectPurchaseView,
  screenFor,
};
