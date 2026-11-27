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
 *
 * THE ADDRESS STEP'S CONSENT (A2A only). While the backend's gate holds the shipping-address form back, the body says
 * `next_action` / `detail.buyer_step` = {kind: "shipping_address", consent_required: true, expires_at} with NO
 * `fields_missing`, and the consent block is offered for step `shipping_address`. Until that block says satisfied the
 * view carries no `address_request` (no form, even if the body listed fields): with the flag on and a complete offer the
 * screen is `shipping_address` with `consent` (the terms first); otherwise `unavailable`. With collection off it stays
 * `shipping_address_elsewhere`. Once satisfied, the backend's form (`fields_missing`) projects exactly as before.
 */

const { isAllowedHostedUrl } = require('./hostedUrl');
const { ACTION_KIND: SHIPPING_STEP, STATE: SHIPPING_STATE, readAddressRequest } = require('./shippingAddress');
const { productImageUrlFor } = require('./productImage');

const KNOWN_STATES = Object.freeze([
  'routing', 'needs_payment_method', 'locking', 'awaiting_buyer_authorization', 'placing',
  'completed', 'failed', 'refused', 'expired',
  // The backend MAY name the address step as a state of its own (docs/agenpas.md, "Shipping address").
  'needs_shipping_address',
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
// `shipping_address`: the A2A rail's address form is a consent-gated step too (the owner's decision, 11-20): it has no
// state of its own (`routing` while the rail waits for the buyer's contact) and no hosted page; what the gate holds
// back is the form itself (docs/agenpas.md, "Shipping address").
const GATED_KINDS = new Set(['card_binding', 'approval', 'shipping_address']);
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
// Mirrors pivota-backend ec53ab7f6 (the hold sets unchanged since be#2910 a7d9b523a; services/payment_orchestration/a2a_rail_worker.py: `_CHECKOUT_HOLD_CODES` (25),
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
//   5. a code nothing above recognises: from placing on and on a FAILED row, the checking wording (outcome_unknown,
//      no retry); on a refused / expired row (both before any money step) the state's own wording, and the hold shape
//      (4) does not apply there either; before placing it changes nothing.
//   6. no code at all: the state's generic wording.
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
  // The quote step's own fallback when the partner named no code (quoting -> failed, before the checkout create).
  'quote_failed',
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
// `vic_checkout_failed` (A2A): the rail answered "failed" for a checkout in `paying` (the confirm went out): the state's
// generic wording, never "no order was sent".
// `checkout_create_failed`: a HOLD (release) code only (reap_agentic_purchase.py `_hold` when nothing left the process),
// never written on a final row; the extractor's flow-insensitive harvest finds it beside the quote step's failures, so
// it is listed here conservatively (the generic wording, never "no order was sent").
const POST_CHECKOUT_GENERIC_CODES = new Set(['checkout_failed', 'checkout_expired', 'checkout_id_missing', 'partner_id_malformed',
  'vic_checkout_failed', 'checkout_create_failed']);
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
  // A2A pre-store failures (pivota-backend a2a_rail_worker.py, all from opened / needs_payment_method / quoting, before
  // any confirm): a card or approval page the rail sent that we will not store or show; the VIC order / quote refused
  // or invalid; an unseen card-binding or token write past its reconcile limit (it "charged nothing").
  'binding_page_invalid', 'approval_page_invalid', 'vic_page_missing', 'vic_page_invalid', 'vic_amount_invalid',
  'vic_quote_invalid', 'vic_order_refused', 'vic_quote_refused', 'reconcile_exhausted',
  // An OPERATOR ended a held checkout after checking the provider's side: no order and no charge
  // (pivota-backend jobs/a2a_rail_operator.py). Its own wording below.
  'operator_confirmed_not_charged',
  // An OPERATOR closed a `checkout_payment_reached_declined` hold (or a legacy `checkout_payment_reached_unconfirmed`
  // one, with a bound lookup) after the provider confirmed IN WRITING that the payment was declined: no authorization
  // approved or captured, no order at the merchant (pivota-backend jobs/a2a_rail_operator.py `close-declined`,
  // db/a2a_rail_ledger.py). Its own wording below.
  'operator_confirmed_declined',
  // REAP (pivota-backend services/reap_agentic_purchase.py): only the codes written BEFORE any Reap checkout exists.
  ...REAP_FAILED_CODES,
]);

/**
 * Final codes that read "checking" in EVERY final state, refused and expired included: an operator closed an rp_-rail row
 * whose checkout EXISTED (`manual_provider_<status>`, pivota-backend services/reap_checkout_recovery.py, from
 * awaiting_approval / processing with a `checkout_unresolvable:` hold). The buyer hears the outcome from the chat.
 */
const FINAL_CHECKING_CODES = new Set(['manual_provider_expired', 'manual_provider_failed']);

/**
 * The only FAILED codes whose wording may say the buyer was not charged: a human verified it at the provider
 * (`operator_confirmed_not_charged`), or the provider confirmed a decline in writing (`operator_confirmed_declined`).
 */
const OPERATOR_NOT_CHARGED_CODES = new Set(['operator_confirmed_not_charged']);
const OPERATOR_DECLINED_CODES = new Set(['operator_confirmed_declined']);

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
  // The provider reported payment-reached with success EXACTLY false and no order id: a measured decline, but still
  // a payment-reached hold until a human closes it on the provider's written word (`operator_confirmed_declined`).
  'checkout_payment_reached_declined',
  // After the confirm, the provider's answer echoed a card code and was scrubbed: held, and one of the backend's seven
  // payment-reached codes (`_CHECKOUT_PAYMENT_REACHED_CODES`): never "not charged".
  'checkout_answer_scrubbed',
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

/** On a COMPLETED purchase: the order IS placed, but the merchant's order number was not kept (withheld because it
 * looked card-shaped, or invalid): `merchant_order_id` is null. Neither a hold nor a failure. */
const COMPLETED_REFERENCE_CODES = new Set(['checkout_order_reference_withheld', 'checkout_order_reference_invalid',
  'vic_order_reference_invalid']);

/** The worker's ordinary progress codes (routine retries and reconciliation; not holds): the screen is the state's own.
 * `checkout_placing` is written while the checkout is being placed, and also after a lookup finds it in progress.
 * They never override a HELD code (HELD is decided first). Anomalies (`transition_refused`, `rail_refused`,
 * `no_step_for_state`, `vic_order_step_disabled`, `checkout_answer_unrecognised`) are deliberately NOT here: from
 * placing on they keep the checking wording. */
const PROGRESS_CODES = new Set(['checkout_placing', 'checkout_ready', 'checkout_read', 'await_read', 'reconciled']);

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

const DECLINED_COPY = Object.freeze({
  kind: 'payment_declined',
  title: 'Your payment was declined',
  message: "The payment was declined, so the order wasn't placed and you weren't charged. You can start again from the chat.",
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

/**
 * The rp_ rail's refusal reasons (`refusal_reason` on a `refused` row; pivota-backend services/reap_agentic_purchase.py
 * `_QUOTE_REFUSAL_KINDS`, `_preflight_refusal_reason`, `_cart_link_verdict`, `_single_variant_verdict`,
 * `_price_verdict`, `merchant_not_completable`, routes/agent_commerce_reap.py `duplicate_idempotency_key`, and the
 * client's resolution reasons, services/reap_agentic_client.py, which reach the column verbatim). Compound reasons
 * match on a segment (`ambiguous_on_axis:<axis>`, `value_has_no_option_id:<axis>`). `price_changed` is its own group.
 * The generic heads `search:`, `details:`, `options:`, `variant:` are matched only on a refused row (below).
 */
const REAP_REFUSAL_REASONS = Object.freeze([
  'merchant_not_completable', 'cart_link_rejected', 'card_payment_unavailable', 'quote_unfulfillable',
  'variant_unavailable', 'no_shipping_option', 'price_unverifiable', 'preflight_refused', 'cart_link_disabled',
  'cart_link_invalid', 'unverified_single_variant', 'duplicate_idempotency_key', 'resolve_failed',
  'cart_link_quote_unbuildable',
  'no_products_returned', 'no_product_name_supplied', 'merchant_not_in_results', 'no_exact_name_match',
  'ambiguous_name_match', 'product_id_not_in_reap_namespace', 'product_has_no_option_axes', 'variant_title_unusable',
  'no_variant_title_supplied', 'single_variant_product_has_no_variant_id', 'resolved_id_not_in_reap_namespace',
  'ambiguous_on_axis', 'duplicate_axis_name', 'label_too_long_to_compare', 'value_has_no_option_id',
]);
/** The client's compound refusal heads (`search:<reason>`, `details:<err>`, `options:<reason>`, `variant:<mismatch>`). */
const REAP_REFUSAL_HEADS = new Set(['search', 'details', 'options', 'variant']);
/**
 * Codes too generic to match on any other row, read ONLY on a refused rp_-rail row (all before the checkout create):
 * `invalid_request` (a `_row_scope` refusal), and the preflight witness's `preflight_interrupted` / `unverified`
 * (its `last_error_code` beside a refusal reason).
 */
const REAP_REFUSED_ONLY_CODES = new Set(['invalid_request', 'preflight_interrupted', 'unverified',
  // The quote verdict's and the cart-link verdict's own codes (`QuoteCheck(False, reason, code)`, `_cart_link_verdict`):
  // always beside a listed refusal reason, which decides the wording.
  'quote_adjustments_unsupported', 'quote_amounts_unreadable', 'quote_currency_mismatch', 'quote_items_mismatch',
  'quote_items_subtotal_mismatch', 'quote_no_shipping_option', 'quote_row_unverifiable', 'quote_shipping_not_reconciled',
  'quote_shipping_options_malformed', 'quote_total_not_reconciled', 'cart_link_quantity_mismatch']);
/** `cart_link_<reason>` (the cart-link verdict's run-time code), read on a refused row only. */
const REAP_REFUSED_ONLY_PREFIXES = Object.freeze(['cart_link_']);

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
    // `buyer_action_expired`: the approval page lapsed before the buyer approved (the paid step mints a token; nothing
    // is charged), e.g. `paid_sent:2:<variant>:buyer_action_expired`.
    codes: ['vic_authorization_expired', 'vic_authorization_overdue', 'vic_buyer_abandoned', 'buyer_action_expired'],
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
      'vic_method_missing', 'card_binding_failed', 'card_binding_disabled', 'card_binding_expired'],
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
    // `buyer_approval_missing` (A2A, quoting -> refused): the rail minted a token with no buyer approval step, which
    // this flow never uses (`token_id_unstorable` beside it: that token's id could not be kept). Nothing was charged.
    codes: ['checkout_currency_unsupported', 'checkout_ceiling_over_cap', 'checkout_ceiling_over_rail_limit',
      'buyer_approval_missing', 'token_id_unstorable'],
    title: "This purchase couldn't be started",
    message: "Our payment partner couldn't take this purchase. Go back to the chat for other options.",
    retry_hint: false,
  },
  {
    kind: 'not_purchasable',
    codes: ['merchant_not_eligible', 'merchant_disabled', 'merchant_not_purchasable', 'row_not_found', 'row_unpriced',
      'row_price_ambiguous', 'row_not_shopify', 'row_variant_unverified', 'row_variant_ambiguous',
      'row_currency_mismatch', 'seller_identity_unverified', 'currency_unsupported', 'vic_currency_unsupported',
      // The rp_ rail's pilot scope (`_row_scope`, quoting -> refused before the checkout create).
      'pilot_scope_invalid', 'pilot_scope_refused'],
    title: "This item can't be bought here right now",
    message: "This item can't be bought through AgenPaz at the moment. Nothing more needs to be done.",
    retry_hint: false,
  },
  {
    kind: 'details_needed',
    // A2A: `buyer_email_required` (opened -> refused, no email to bind a card), `contact_purged` (opened /
    // needs_payment_method -> failed, the contact was deleted after its retention), `token_payer_missing` (the token
    // needs the payer's name and email).
    codes: ['invalid_address', 'consent_required', 'vic_contact_missing', 'buyer_email_missing', 'buyer_email_required',
      'contact_purged', 'token_payer_missing'],
    title: 'Some details were missing',
    message: 'The store needs a bit more information. Go back to the chat to check your details.',
    retry_hint: true,
  },
  // ---- definite pre-order endings (every write site checked: docs/agenpas.md, "Final states") ----
  {
    // A2A `attempts_exhausted` (opened -> failed); rp_-rail `attempts_exhausted` and `contact_reentry_lapsed` (both SQL
    // statements require `checkout_dispatch_key IS NULL`: no checkout was ever sent).
    kind: 'not_started',
    codes: ['attempts_exhausted', 'contact_reentry_lapsed'],
    title: "This purchase didn't go through",
    message: "It couldn't be completed, so nothing was ordered or charged. You can start again from the chat.",
    retry_hint: true,
  },
  {
    // A2A `shipping_address_expired` (opened -> expired): the address step lapsed.
    kind: 'address_timed_out',
    codes: ['shipping_address_expired'],
    title: 'This purchase expired',
    message: "The shipping address wasn't given in time, so nothing was ordered or charged. You can start again from the chat.",
    retry_hint: true,
  },
  {
    // A2A `shipping_address_not_collected` (expired): the row waited for the address when collection was turned off.
    kind: 'address_not_collected',
    codes: ['shipping_address_not_collected'],
    title: "This purchase didn't go through",
    message: "We can't take the shipping address here any more, so nothing was ordered or charged. Go back to the chat to start again.",
    retry_hint: true,
  },
  {
    // The expiry sweeps' own codes for rows that never reached a payment: A2A `stale` (no pending write, never
    // `paying`), rp_-rail `hosted_url_expired` (no checkout id, no dispatch key).
    kind: 'expired_unused',
    codes: ['stale', 'hosted_url_expired'],
    title: 'This purchase expired',
    message: "It wasn't completed in time, so nothing was ordered or charged. You can start again from the chat.",
    retry_hint: true,
  },
  {
    // rp_-rail refusals (resolving / quoting -> refused, every one before the checkout create's dispatch): the item, the
    // cart link or the quote could not be taken as asked.
    kind: 'refused_before_order',
    codes: REAP_REFUSAL_REASONS,
    title: "This purchase couldn't be started",
    message: "The store couldn't take this purchase as it was asked for, so nothing was ordered or charged. Go back to the chat for other options.",
    retry_hint: false,
  },
  {
    kind: 'offer_code_refused',
    codes: ['invalid_offer_code', 'offer_code_malformed', 'offer_code_rejected'],
    title: "The discount code couldn't be used",
    message: "The discount code wasn't accepted, so the purchase wasn't started and nothing was charged. Go back to the chat to try again without it.",
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
    || COMPLETED_REFERENCE_CODES.has(seg) || PROGRESS_CODES.has(seg)
    || POST_CHECKOUT_GENERIC_CODES.has(seg) || REAP_PROGRESS_CODES.has(seg) || FINAL_CHECKING_CODES.has(seg);
}

/** A code the explicit lists do not name, with the hold shape or the `reap_` prefix (an unlisted Reap code). */
function isHoldShaped(seg) {
  return !isExplicit(seg) && (OUTCOME_UNKNOWN_SHAPE_RE.test(seg) || seg.startsWith(REAP_UNLISTED_PREFIX));
}

/** What the codes say, by the precedence above: 'failed' | 'held' | a named group | 'generic' | 'shape_unknown' | null. */
function classify(segments) {
  if (segments.some((seg) => HELD_CODES.has(seg))) return { kind: 'held' };
  if (segments.some((seg) => FINAL_CHECKING_CODES.has(seg))) return { kind: 'final_checking' };
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
  return Boolean(c) && (c.kind === 'held' || c.kind === 'shape_unknown' || c.kind === 'final_checking');
}

/** The refusal group a refused row's compound client reason names by its head (`options:<reason>`, ...), or null. */
function refusalHeadGroup(codes) {
  const flat = (Array.isArray(codes) ? codes : []).flatMap((c) => (Array.isArray(c) ? c : [c]));
  const named = flat.some((code) => {
    if (typeof code !== 'string') return false;
    const head = code.trim().toLowerCase().split(':')[0];
    return REAP_REFUSAL_HEADS.has(head) || REAP_REFUSED_ONLY_PREFIXES.some((p) => head.startsWith(p))
      || codeSegments([code]).some((seg) => REAP_REFUSED_ONLY_CODES.has(seg));
  });
  return named ? REASON_BY_CODE.get(REAP_REFUSAL_REASONS[0]) : null;
}

/**
 * True when a final code is on an explicit list for that state (any segment), or, on a refused row, has a known
 * client refusal head. The terminal-code parity test holds every code the backend writes to this.
 */
function isKnownFinalCode(state, code) {
  if (typeof code !== 'string') return false;
  if (codeSegments([code]).some((seg) => isExplicit(seg))) return true;
  return state === 'refused' && refusalHeadGroup([code]) !== null;
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
const PRE_PLACING_STATES = new Set(['routing', 'needs_payment_method', 'locking', 'awaiting_buyer_authorization', 'needs_shipping_address', 'unknown']);

/**
 * True when a code is on the purchase that the gateway does not recognise at all: none of its segments is on an
 * explicit list or has the hold shape (a brand-new code, a malformed or oversized one, a bare `paid_sent:<n>:<v>`).
 * Nothing known says the order was not placed, so from `placing` on and in final states it is read as "checking".
 */
function hasUnrecognisedCode(codes) {
  const flat = (Array.isArray(codes) ? codes : []).flatMap((c) => (Array.isArray(c) ? c : [c]));
  return flat.some((code) => {
    if (typeof code !== 'string' || code.trim() === '') return false;
    return !codeSegments([code]).some((seg) => isExplicit(seg) || OUTCOME_UNKNOWN_SHAPE_RE.test(seg));
  });
}

function outcomeFor(state, codes) {
  const segments = codeSegments(codes);
  const c = classify(segments);
  // Only when nothing on any list (or of the hold shape) decides: explicit lists and the shape keep their precedence.
  const unrecognised = !c && hasUnrecognisedCode(codes);
  if (!TERMINAL_STATES.has(state)) {
    const preplacing = PRE_PLACING_STATES.has(state);
    const held = c && c.kind === 'held'
      && (!preplacing || segments.some((seg) => HELD_CODES.has(seg) && !PRE_PLACING_SOFT_HELD_CODES.has(seg)));
    if (held || (c && (c.kind === 'shape_unknown' || c.kind === 'final_checking') && !preplacing)) return { ...HELD_COPY };
    // Before placing an unrecognised code changes nothing: the buyer's step stays.
    if (unrecognised && !preplacing && !segments.some((seg) => PARKED_CODES.has(seg))) return { ...HELD_COPY };
    if (segments.some((seg) => PARKED_CODES.has(seg))) return state === 'placing' ? { ...HELD_COPY } : { ...PARKED_COPY };
    return null;
  }
  if (!GENERIC_BY_STATE[state]) return null;
  // `refused` and `expired` end a purchase BEFORE any money step on both rails (every write site checked against the
  // backend source: docs/agenpas.md, "Final states"). There only an explicit HELD or FINAL_CHECKING code reads
  // "checking"; a hold-shaped or unrecognised code reads the state's own wording. `failed` (which can follow a confirm)
  // keeps the checking wording for both.
  const definite = state === 'refused' || state === 'expired';
  if (c && c.kind === 'final_checking') return { ...OUTCOME_UNKNOWN_COPY };
  if (c && c.kind === 'failed') {
    // HELD has already won above if any hold code is present. "You weren't charged" is said ONLY when nothing else on
    // the purchase is even hold-SHAPED: a claim that strong needs a clean record; otherwise, the checking wording.
    const declined = segments.some((seg) => OPERATOR_DECLINED_CODES.has(seg));
    if (declined || segments.some((seg) => OPERATOR_NOT_CHARGED_CODES.has(seg))) {
      const holdShaped = segments.some(isHoldShaped);
      if (holdShaped) return { ...OUTCOME_UNKNOWN_COPY };
      return declined ? { ...DECLINED_COPY } : { ...NOT_CHARGED_COPY };
    }
    return { ...NOT_SUBMITTED_COPY };
  }
  if (c && (c.kind === 'held' || (c.kind === 'shape_unknown' && !definite))) return { ...OUTCOME_UNKNOWN_COPY };
  // An unrecognised code on a failed purchase: the checking wording, never "no order was sent", never a retry.
  if (unrecognised && !definite) return { ...OUTCOME_UNKNOWN_COPY };
  const headGroup = state === 'refused' && (!c || c.kind === 'shape_unknown') ? refusalHeadGroup(codes) : null;
  if (headGroup) {
    const { codes: _codes, ...copy } = headGroup;
    return { ...copy, outcome_unknown: false };
  }
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
 *   locking                          -> confirming_total (the merchant prices the exact cart; nothing approved yet),
 *                                       or choose_card while the backend's card_choice waits on the buyer (flag on)
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
    case 'needs_shipping_address': return 'preparing';
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

// ---- the card the purchase pays with ------------------------------------------------------------------------------
//
// The backend's top-level `payment_card = {network, last4}` (pivota-backend docs/agent_purchases_routes.md, behind its
// AGENPAS_PAYMENT_CARD_ENABLED): the two display attributes of the card a BOUND checkout pays with. Read only from the
// top level (never `detail`), shown only on the approval screen and on "Your order is placed": a card the purchase may
// still not use (before its checkout), or on a held / stopped purchase, is never named. The network becomes a label
// from this fixed list (the partner's word is never shown as is); an unknown one is "Card". No field at all without
// exactly four digits.
const CARD_SCREENS = new Set(['approve', 'done']);
const LAST4_RE = /^[0-9]{4}$/;
const CARD_NETWORK_LABELS = Object.freeze({
  visa: 'Visa',
  mastercard: 'Mastercard',
  mc: 'Mastercard',
  amex: 'American Express',
  americanexpress: 'American Express',
  discover: 'Discover',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cup: 'UnionPay',
  diners: 'Diners Club',
  dinersclub: 'Diners Club',
});

function cardLabelFor(network) {
  const key = typeof network === 'string' ? network.toLowerCase().replace(/[\s_-]+/g, '') : '';
  return Object.prototype.hasOwnProperty.call(CARD_NETWORK_LABELS, key) ? CARD_NETWORK_LABELS[key] : 'Card';
}

function paymentCardFor(raw, screen) {
  if (!CARD_SCREENS.has(screen) || !isPlainObject(raw)) return null;
  const last4 = typeof raw.last4 === 'string' ? raw.last4 : '';
  if (!LAST4_RE.test(last4)) return null;
  return { label: cardLabelFor(raw.network), last4 };
}

// ---- the buyer's card choice (AGENPAS_CARD_PICKER_ENABLED) --------------------------------------------------------
//
// The backend's top-level `card_choice = {confirmed, expires_at, cards: [{handle, network, last4, added_at, selected}]}`
// (pivota-backend docs/agent_purchases_routes.md, behind its AGENPAS_CARD_PICKER_ENABLED): an A2A purchase whose order is
// locked waits for the buyer to confirm the card BEFORE any token is asked for. Read only from the top level (never
// `detail`). Every card is checked again and never repaired: one bad card (a handle out of shape, or no four digits:
// two cards the buyer cannot tell apart are no choice), two selected, or a deadline already passed, and there is no
// choice at all (the page then says "not available right now", never a spinner). `handle` names the card for this purchase only
// (never the rail's card id); the network becomes a label from the fixed list above; `added_on` is a real calendar
// date (YYYY-MM-DD) or null.
const CARD_HANDLE_RE = /^[0-9a-f]{24}$/;
const CARD_CHOICE_MAX = 10;
const CARD_ADDED_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[T ]|$)/;

function cardChoiceFor(raw, nowMs) {
  if (!isPlainObject(raw) || !Array.isArray(raw.cards)) return null;
  if (raw.cards.length < 1 || raw.cards.length > CARD_CHOICE_MAX) return null;
  const cards = [];
  const seen = new Set();
  for (const c of raw.cards) {
    if (!isPlainObject(c) || typeof c.handle !== 'string' || !CARD_HANDLE_RE.test(c.handle) || seen.has(c.handle)) return null;
    seen.add(c.handle);
    if (typeof c.last4 !== 'string' || !LAST4_RE.test(c.last4)) return null;
    const last4 = c.last4;
    const match = typeof c.added_at === 'string' ? CARD_ADDED_RE.exec(c.added_at) : null;
    // A real calendar date only (2026-02-31 is none).
    const added = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).getUTCDate() === +match[3] ? match : null;
    cards.push({
      handle: c.handle,
      label: cardLabelFor(c.network),
      last4,
      added_on: added ? `${added[1]}-${added[2]}-${added[3]}` : null,
      selected: c.selected === true,
    });
  }
  if (cards.filter((c) => c.selected).length !== 1) return null;
  const confirmed = raw.confirmed === true;
  if (!confirmed) {
    const expires = isoOrNull(raw.expires_at, nowMs);
    if (!expires.iso || expires.past) return null;
  }
  // The buyer asked to add a new card (the backend's `new_card`): the page waits for the card page.
  return raw.new_card === true && !confirmed ? { confirmed, new_card: true, cards } : { confirmed, cards };
}

// ---- the agent's name ---------------------------------------------------------------------------------------------
//
// The backend's top-level `agent_display_name` (pivota-backend docs/agent_purchases_routes.md): a name set by hand,
// else the agent's developer-portal name after the backend's block list, lookalike and rename checks (backend only;
// not repeated here). Read only from the top level (never `detail`). The page says "Requested by <name>". The same shape the backend checks
// (db/agents.clean_buyer_display_name), checked again here and NEVER repaired: a name that fails is no member at all,
// so the page shows no line rather than an altered name. 1-64 code points, NFC, no surrounding space, the only space
// U+0020 and never two in a row, no control / format (bidi, zero-width) / surrogate / private-use / unassigned code
// point or line / paragraph separator, at least one letter or digit.
const AGENT_NAME_MAX_CHARS = 64;
const AGENT_NAME_REFUSED_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
const AGENT_NAME_BAD_SPACE_RE = /[^\S ]| {2}/u;
const AGENT_NAME_LETTER_RE = /[\p{L}\p{N}]/u;

function agentDisplayNameFor(raw) {
  if (typeof raw !== 'string' || !raw || raw !== raw.trim()) return null;
  if ([...raw].length > AGENT_NAME_MAX_CHARS || raw.normalize('NFC') !== raw) return null;
  if (AGENT_NAME_REFUSED_RE.test(raw) || AGENT_NAME_BAD_SPACE_RE.test(raw)) return null;
  return AGENT_NAME_LETTER_RE.test(raw) ? raw : null;
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

/** The body asks for the buyer's shipping address (the form, or the consent-gated marker), A2A wording. */
function isShippingStep(state, rawAction, buyerStep) {
  return state === SHIPPING_STATE || Boolean(rawAction && rawAction.kind === SHIPPING_STEP)
    || Boolean(buyerStep && buyerStep.kind === SHIPPING_STEP);
}

/** The backend's gate marker on the address step: `consent_required: true` on its next_action or its buyer_step. */
function shippingMarked(rawAction, buyerStep) {
  return Boolean((rawAction && rawAction.kind === SHIPPING_STEP && rawAction.consent_required === true)
    || (buyerStep && buyerStep.kind === SHIPPING_STEP && buyerStep.consent_required === true));
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
function buildView(body, {
  purchaseId, hostedHosts = [], embed = false, now, linkExpiresAt, linkTtlMinutes, collectShipping = false,
  consentEnabled = false, legalHosts = [], cardPicker = false,
} = {}) {
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
    // The order number was withheld (or invalid) and not kept: the page points to the store's confirmation email.
    if (!order.reference && codeSegments(codes).some((seg) => COMPLETED_REFERENCE_CODES.has(seg))) order.reference_withheld = true;
  }

  let outcome = outcomeFor(state, codes);
  // A held purchase offers the buyer NO step, whatever the rail still lists: approving or adding a card on an order
  // that may already be on its way to the store is exactly what "don't try again" forbids.
  if (outcome && outcome.outcome_unknown) action = null;
  let screen = screenFor(state, { actionKind: action ? action.kind : null, outcome });

  // THE ADDRESS STEP (shippingAddress.js): the buyer gives the shipping address / email the partner did not send. Never
  // while held. With AGENPAS_COLLECT_SHIPPING off the page only says to add it in the chat, and the view carries no
  // `address_request` (every other view is byte-identical either way).
  // Consent-gated (A2A; the header above): no form until the block says THIS step is satisfied, whatever the body
  // listed; the terms are offered on the address screen, or the step is "not available right now".
  const held = Boolean(outcome && outcome.outcome_unknown);
  const shippingGated = !held && !terminal && rail !== 'reap' && PRE_PLACING_STATES.has(state)
    && isShippingStep(state, rawAction, buyerStep)
    && (shippingMarked(rawAction, buyerStep) || Boolean(block && block.required && block.step === SHIPPING_STEP))
    && !satisfiedFor(SHIPPING_STEP);
  const shippingOfferable = shippingGated && consentEnabled && isOfferable(block, SHIPPING_STEP);
  // A marker without a field list is never a form (it would read as "every field"), satisfied or not.
  const markerOnly = shippingMarked(rawAction, null) && !Array.isArray(rawAction.fields_missing);
  // The rp_ rail never takes an address on this page, whatever a body carries: "add it in the chat".
  const reapAddress = rail === 'reap' && !held && !terminal && PRE_PLACING_STATES.has(state)
    && isShippingStep(state, rawAction, buyerStep);
  const addressRequest = held || shippingGated || markerOnly || reapAddress ? null : readAddressRequest(state, rawAction, { now: nowMs });
  if (reapAddress) screen = 'shipping_address_elsewhere';
  if (addressRequest) screen = collectShipping ? 'shipping_address' : 'shipping_address_elsewhere';
  else if (shippingGated) screen = !collectShipping ? 'shipping_address_elsewhere' : shippingOfferable ? 'shipping_address' : 'unavailable';

  // The rail paused the purchase for the buyer's contact details (Reap's `contact_reentry_required`): no card button,
  // no consent; the chat takes the details. Held still wins (screenFor already said outcome_unknown).
  if (!terminal && screen !== 'outcome_unknown' && pick('contact_reentry_required') === true) {
    action = null;
    outcome = { ...DETAILS_NEEDED_COPY };
    screen = 'details_needed';
  }
  if (unavailable && (screen === 'add_card' || screen === 'approve')) screen = 'unavailable';
  // THE CARD CHOICE: only while the total is being confirmed (the backend's `locking`: the order is locked, nothing is
  // minted), only on the A2A rail, never while held. Unconfirmed, the buyer picks and approves; confirmed, the page shows
  // the card while the secure page is got ready. The backend takes the card only after the approval step's terms (its
  // consent gate): unaccepted, they are offered here first (`consent_pending`), or, when they cannot be offered, the
  // step is "not available right now". Never an Approve the backend would refuse.
  const cardChoiceShown = cardPicker && screen === 'confirming_total' && rail === 'a2a' && !held
    && src.card_choice !== undefined && src.card_choice !== null;
  let cardChoice = cardChoiceShown ? cardChoiceFor(src.card_choice, nowMs) : null;
  // A choice the backend sent that does not check out: never a spinner until its deadline, never a repaired choice.
  if (cardChoiceShown && !cardChoice) screen = 'unavailable';
  // A new-card request needs no terms check here: the backend records one only after the approval step's terms
  // (its consent check), and the write's own answer carries no consent block (a check on it would flash "not available
  // right now" before the card page; staging run-through 11-27).
  if (cardChoice && !cardChoice.confirmed && !cardChoice.new_card && !satisfiedFor('approval')) {
    if (consentEnabled && isOfferable(block, 'approval')) cardChoice = { ...cardChoice, consent_pending: true };
    else {
      cardChoice = null;
      screen = 'unavailable';
    }
  }
  if (cardChoice) screen = 'choose_card';
  const shippingConsentScreen = shippingOfferable && screen === 'shipping_address';
  const consentScreen = screen === 'add_card' || screen === 'approve' || screen === 'confirming_total'
    || screen === 'choose_card' || shippingConsentScreen;
  const offeredStep = shippingConsentScreen ? SHIPPING_STEP : consentStep;
  let consent = null;
  let record = null;
  if ((shippingConsentScreen || offerable) && consentScreen) {
    // The versions shown are the very values recorded (`record`, below): the buyer sees what the record names.
    consent = {
      step: offeredStep, terms_url: block.terms_url, privacy_url: block.privacy_url,
      terms_version: block.terms_version, privacy_version: block.privacy_version, offer: { ...block.offer },
    };
    // Only when the backend states it (the page then waits at least that long plus a second; else its own 4 s).
    if (block.min_dwell_seconds !== null) consent.min_dwell_seconds = block.min_dwell_seconds;
    record = { step: offeredStep, terms_version: block.terms_version, privacy_version: block.privacy_version };
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
    ...(addressRequest && collectShipping && screen === 'shipping_address' ? { address_request: addressRequest } : {}),
  };
  // Only while AGENPAS_CONSENT_ENABLED is on: off, the view has exactly the members it always had.
  if (consentEnabled) view.consent = consent;
  // Only while the buyer chooses the card: otherwise no member at all (and never with the flag off).
  if (cardChoice) view.card_choice = cardChoice;
  // Only when the backend names the card and the screen may show it: otherwise no member at all.
  const paymentCard = paymentCardFor(src.payment_card, screen);
  if (paymentCard) view.payment_card = paymentCard;
  // Only when the backend names a name of the right shape: otherwise no member at all.
  const agentName = agentDisplayNameFor(src.agent_display_name);
  if (agentName) view.agent_display_name = agentName;
  // THE PRODUCT IMAGE (productImage.js): only a flag. The page never learns the store's URL; it asks
  // /agenpas/api/p/:id/image, which fetches the URL the backend names (top level only, never `detail`) server-side.
  if (productImageUrlFor(src.product_image_url)) view.product_image = true;
  return { view, record, shippingConsentPending: shippingGated };
}

/**
 * Project one backend body for the page.
 * @param {object} body  the backend's unified purchase body
 * @param {{ purchaseId: string, hostedHosts: string[], embed?: boolean, now?: number, linkExpiresAt?: number,
 *           linkTtlMinutes?: number, collectShipping?: boolean, consentEnabled?: boolean, legalHosts?: string[],
 *           cardPicker?: boolean }} opts
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

/**
 * True while the purchase's shipping-address step waits for the buyer's consent (the backend's gate marker or its
 * consent block, and no satisfied consent for `shipping_address`): the address write must not go on.
 */
function shippingConsentPending(body, opts = {}) {
  return buildView(body, opts).shippingConsentPending === true;
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
  REAP_REFUSAL_HEADS,
  REAP_REFUSAL_REASONS,
  FINAL_CHECKING_CODES,
  codeSegments,
  isKnownFinalCode,
  consentToRecord,
  isOutcomeUnknownCode,
  outcomeFor,
  projectPurchaseView,
  screenFor,
  shippingConsentPending,
};
