'use strict';

// PARITY: every final-state code the backend WRITES, on both rails, is on an explicit gateway list, and reads honest
// wording. A new backend code fails this test instead of silently landing in "checking" or the neutral copy.
//
// Enumerated from the backend SOURCE (not from memory), each with its write site:
//   A2A at pivota-backend 54874e2a5: services/payment_orchestration/a2a_rail_worker.py (every
//     `ledger.transition_as_holder(..., to_state="failed"|"refused"|"expired", ...)`, `_token_failed`, `_checkout_failed`,
//     `_cancel_checkout`), db/a2a_rail_ledger.py (the expiry sweep `_EXPIRE_SQL` ~:1266, the operator resolve ~:901).
//   The rp_ rail at pivota-backend 54874e2a5 (its rp_-rail sources identical to origin/main 5ff890580):
//     services/reap_agentic_purchase.py (every `_move(..., "failed"|"refused"|"expired", ...)`),
//     db/reap_agentic_ledger.py (the sweeps `_EXPIRE_OVERDUE_SQL` ~:2282, `_FAIL_EXHAUSTED_SQL` ~:2361, contact re-entry
//     ~:2680), services/reap_checkout_recovery.py (`manual_provider_<status>` ~:126), routes/agent_commerce_reap.py
//     (`duplicate_idempotency_key` ~:2594), and the client's resolution reasons (services/reap_agentic_client.py).
// A compound code is written here in a representative spelling (`<prefix>:<kind>:<status>`); every segment is read.
// NOT enumerable: the partner's own error codes the rp_-rail worker lowercases into `last_error_code` on a failed row
// (`_error_code(partner)`); on a failed row an unrecognised one reads "checking" by design.
// Re-pin to one backend main SHA once the backend half merges. Placeholder ids only. No network.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectPurchaseView, isKnownFinalCode, HELD_CODES, FINAL_CHECKING_CODES,
} = require('../src/agenpas/view');

const BACKEND = Object.freeze({
  a2a: {
    failed: [
      'binding_page_invalid', 'binding_answer_unrecognised', 'binding_refused:refused:400', 'card_binding_failed',
      'card_binding_disabled', 'card_binding_expired', 'token_method_unavailable', 'token_currency_unsupported',
      'token_payer_missing', 'approval_page_invalid', 'token_failed', 'token_answer_unrecognised', 'token_refused:refused:400',
      'checkout_contact_incomplete', 'checkout_relay_refused', 'token_mismatch', 'approval_answer_unrecognised',
      'pay_step_unavailable', 'reconcile_exhausted', 'token_request_unresolved', 'vic_currency_unsupported',
      'vic_method_missing', 'vic_contact_missing', 'vic_amount_invalid', 'vic_order_refused:http_error',
      'vic_quote_unrecognised', 'vic_quote_refused:http_error', 'vic_quote_currency_mismatch', 'vic_quote_price_changed',
      'vic_quote_over_limit', 'vic_quote_invalid', 'vic_page_missing', 'vic_page_invalid', 'vic_order_unresolved',
      'vic_authorization_declined', 'vic_buyer_abandoned', 'vic_checkout_failed', 'checkout_card_unavailable:network_token_missing',
      'checkout_token_unavailable', 'checkout_setup_incomplete', 'checkout_setup_unrecognised',
      'checkout_setup_refused:http_error:400', 'checkout_confirm_refused:http_error:422', 'checkout_captcha_failed',
      'checkout_form_error', 'checkout_pay_disabled', 'checkout_confirm_total_refused', 'checkout_lock_invalid',
      'checkout_price_missing', 'attempts_exhausted', 'contact_purged', 'operator_confirmed_not_charged',
    ],
    refused: [
      'buyer_email_required', 'buyer_approval_missing', 'token_id_unstorable', 'checkout_currency_unsupported',
      'checkout_ceiling_over_cap', 'checkout_ceiling_over_rail_limit',
    ],
    // `shipping_address_not_collected`: a2a_rail_worker.py:536 (opened -> expired, capture turned off while waiting).
    expired: ['shipping_address_expired', 'vic_authorization_expired', 'buyer_action_expired', 'stale', 'shipping_address_not_collected'],
  },
  reap: {
    failed: [
      'buyer_email_missing', 'enrollment_no_hosted_action', 'enrollment_id_conflict', 'enrollment_create_failed',
      'enrollment_read_failed', 'partner_id_malformed', 'enrollment_row_unreadable', 'enrollment_not_activatable',
      'enrollment_dead', 'no_active_enrollment', 'quote_id_missing', 'enrollment_not_active', 'checkout_id_missing',
      'checkout_failed', 'checkout_expired', 'approval_window_lapsed', 'attempts_exhausted', 'contact_reentry_lapsed',
      'manual_provider_failed',
    ],
    refused: [
      'merchant_not_completable', 'invalid_offer_code', 'offer_code_malformed', 'cart_link_rejected', 'card_payment_unavailable',
      'quote_unfulfillable', 'variant_unavailable', 'offer_code_rejected', 'no_shipping_option', 'price_unverifiable',
      'preflight_refused', 'price_changed', 'cart_link_disabled', 'cart_link_invalid', 'unverified_single_variant',
      'duplicate_idempotency_key', 'no_products_returned', 'no_product_name_supplied', 'merchant_not_in_results',
      'no_exact_name_match', 'ambiguous_name_match', 'product_id_not_in_reap_namespace', 'product_has_no_option_axes',
      'variant_title_unusable', 'no_variant_title_supplied', 'single_variant_product_has_no_variant_id',
      'resolved_id_not_in_reap_namespace', 'ambiguous_on_axis:color', 'duplicate_axis_name:size',
      'label_too_long_to_compare:color', 'value_has_no_option_id:size', 'search:no_products_returned',
      'details:http_error', 'options:sole_label_differs:color', 'variant:price_disagrees',
    ],
    expired: ['checkout_expired', 'hosted_url_expired', 'contact_reentry_lapsed', 'manual_provider_expired'],
  },
});

// The exact copies the new lists read (src/agenpas/view.js).
const COPY = Object.freeze({
  not_started: { kind: 'not_started', title: "This purchase didn't go through", message: "It couldn't be completed, so nothing was ordered or charged. You can start again from the chat.", retry_hint: true, outcome_unknown: false },
  address_timed_out: { kind: 'address_timed_out', title: 'This purchase expired', message: "The shipping address wasn't given in time, so nothing was ordered or charged. You can start again from the chat.", retry_hint: true, outcome_unknown: false },
  address_not_collected: { kind: 'address_not_collected', title: "This purchase didn't go through", message: "We can't take the shipping address here any more, so nothing was ordered or charged. Go back to the chat to start again.", retry_hint: true, outcome_unknown: false },
  expired_unused: { kind: 'expired_unused', title: 'This purchase expired', message: "It wasn't completed in time, so nothing was ordered or charged. You can start again from the chat.", retry_hint: true, outcome_unknown: false },
  refused_before_order: { kind: 'refused_before_order', title: "This purchase couldn't be started", message: "The store couldn't take this purchase as it was asked for, so nothing was ordered or charged. Go back to the chat for other options.", retry_hint: false, outcome_unknown: false },
  offer_code_refused: { kind: 'offer_code_refused', title: "The discount code couldn't be used", message: "The discount code wasn't accepted, so the purchase wasn't started and nothing was charged. Go back to the chat to try again without it.", retry_hint: true, outcome_unknown: false },
  details_needed: { kind: 'details_needed', title: 'Some details were missing', message: 'The store needs a bit more information. Go back to the chat to check your details.', retry_hint: true, outcome_unknown: false },
  checkout_refused: { kind: 'checkout_refused', title: "This purchase couldn't be started", message: "Our payment partner couldn't take this purchase. Go back to the chat for other options.", retry_hint: false, outcome_unknown: false },
  card_not_added: { kind: 'card_not_added', title: "Your card couldn't be used", message: "The card couldn't be set up for this purchase, so the order wasn't placed.", retry_hint: true, outcome_unknown: false },
  not_submitted: { kind: 'not_submitted', title: "This purchase didn't go through", message: "The store's checkout couldn't be completed, so no order was sent to the store.", retry_hint: false, outcome_unknown: false },
  post_checkout_failed: { kind: 'failed', title: "This purchase didn't complete", message: 'Go back to the chat for the latest on this purchase.', retry_hint: false, outcome_unknown: false },
  checking: { kind: 'outcome_unknown', title: "We're checking with the store", message: "We're checking with the store — don't try again. Your order may already be in progress, and we'll confirm what happened in the chat.", retry_hint: false, outcome_unknown: true },
});

// Every code the review named, each pinned to its exact outcome in its state.
const PINNED = [
  ['a2a', 'expired', 'shipping_address_expired', 'address_timed_out'],
  ['a2a', 'expired', 'shipping_address_not_collected', 'address_not_collected'],
  ['a2a', 'expired', 'stale', 'expired_unused'],
  ['a2a', 'refused', 'buyer_email_required', 'details_needed'],
  ['a2a', 'failed', 'contact_purged', 'details_needed'],
  ['a2a', 'failed', 'token_payer_missing', 'details_needed'],
  ['a2a', 'failed', 'binding_page_invalid', 'not_submitted'],
  ['a2a', 'refused', 'buyer_approval_missing', 'checkout_refused'],
  ['a2a', 'refused', 'token_id_unstorable', 'checkout_refused'],
  ['a2a', 'failed', 'attempts_exhausted', 'not_started'],
  ['a2a', 'failed', 'reconcile_exhausted', 'not_submitted'],
  ['a2a', 'failed', 'card_binding_expired', 'card_not_added'],
  ['a2a', 'failed', 'vic_checkout_failed', 'post_checkout_failed'],
  ['reap', 'failed', 'attempts_exhausted', 'not_started'],
  ['reap', 'failed', 'contact_reentry_lapsed', 'not_started'],
  ['reap', 'expired', 'contact_reentry_lapsed', 'not_started'],
  ['reap', 'expired', 'hosted_url_expired', 'expired_unused'],
  ['reap', 'failed', 'manual_provider_failed', 'checking'],
  ['reap', 'expired', 'manual_provider_expired', 'checking'],
  ...['merchant_not_completable', 'cart_link_rejected', 'card_payment_unavailable', 'quote_unfulfillable', 'variant_unavailable',
    'no_shipping_option', 'price_unverifiable', 'preflight_refused', 'options:sole_label_differs:color', 'search:no_products_returned',
    'ambiguous_name_match'].map((code) => ['reap', 'refused', code, 'refused_before_order']),
  ...['invalid_offer_code', 'offer_code_malformed', 'offer_code_rejected'].map((code) => ['reap', 'refused', code, 'offer_code_refused']),
];

const ID = { a2a: 'ap_0123456789abcdef01234567', reap: 'rp_0123456789abcdef01234567' };
function outcome(rail, state, code, field = state === 'refused' ? 'refusal_reason' : 'last_error_code') {
  const body = {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail, rail_purchase_id: ID[rail], state, poll_after_seconds: null,
    detail: { id: ID[rail], merchant_domain: 'merchant.example', [field]: code },
  };
  return projectPurchaseView(body, { purchaseId: ID[rail] });
}

test('parity with backend 54874e2a5 (both rails): every final code the backend writes is on an explicit gateway list', () => {
  const missing = [];
  for (const [rail, byState] of Object.entries(BACKEND)) {
    for (const [state, codes] of Object.entries(byState)) {
      for (const code of codes) if (!isKnownFinalCode(state, code)) missing.push(`${rail}/${state}/${code}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('refused / expired backend codes never read "checking" unless they are on HELD or FINAL_CHECKING', () => {
  for (const [rail, byState] of Object.entries(BACKEND)) {
    for (const state of ['refused', 'expired']) {
      for (const code of byState[state]) {
        const view = outcome(rail, state, code);
        const allowed = code.split(':').some((seg) => HELD_CODES.has(seg) || FINAL_CHECKING_CODES.has(seg));
        assert.equal(view.outcome.outcome_unknown, allowed, `${rail}/${state}/${code}`);
        assert.equal(view.screen, allowed ? 'outcome_unknown' : state, `${rail}/${state}/${code}`);
      }
    }
  }
});

test('failed backend codes: only HELD, FINAL_CHECKING and hold codes read "checking"; every listed pre-order code reads its own words', () => {
  for (const [rail, byState] of Object.entries(BACKEND)) {
    for (const code of byState.failed) {
      const view = outcome(rail, 'failed', code, 'last_error_code');
      const allowed = code.split(':').some((seg) => HELD_CODES.has(seg) || FINAL_CHECKING_CODES.has(seg));
      assert.equal(view.outcome.outcome_unknown, allowed, `${rail}/failed/${code}`);
    }
  }
});

for (const [rail, state, code, copy] of PINNED) {
  test(`exact outcome: ${rail} ${state} ${code} -> ${copy}`, () => {
    const view = outcome(rail, state, code);
    assert.deepEqual(view.outcome, COPY[copy]);
    assert.equal(view.screen, copy === 'checking' ? 'outcome_unknown' : state);
    assert.equal(view.terminal, true);
  });
}

test('an unrecognised code: "checking" on a failed row only; refused / expired read their own words (both rails)', () => {
  for (const rail of ['a2a', 'reap']) {
    assert.deepEqual(outcome(rail, 'failed', 'zz_brand_new_code').outcome, COPY.checking, rail);
    assert.equal(outcome(rail, 'refused', 'zz_brand_new_code').outcome.kind, 'refused', rail);
    assert.equal(outcome(rail, 'expired', 'zz_brand_new_code').outcome.kind, 'expired', rail);
    // A hold-SHAPED, unlisted code too (e.g. an unlisted `reap_status_500` the sweep keeps on a pre-checkout row).
    assert.equal(outcome(rail, 'expired', 'reap_status_500', 'last_error_code').outcome.kind, 'expired', rail);
    assert.deepEqual(outcome(rail, 'failed', 'reap_status_500', 'last_error_code').outcome, COPY.checking, rail);
    // An explicit HELD code still reads "checking" in every final state.
    for (const state of ['failed', 'refused', 'expired']) {
      assert.deepEqual(outcome(rail, state, 'checkout_unknown_timeout', 'last_error_code').outcome, COPY.checking, `${rail}/${state}`);
    }
  }
});
