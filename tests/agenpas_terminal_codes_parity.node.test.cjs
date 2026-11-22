'use strict';

// PARITY: every final-state code the backend writes, on both rails, is on an explicit gateway list and reads honest
// wording.
//
// The list is a MIRROR of the backend at one commit: tests/fixtures/agenpas_backend_final_codes.backend.json, generated
// from the backend source (read only, `git show`) by scripts/agenpas/extract_backend_final_codes.py. A new backend code
// fails this test only once the fixture is REGENERATED at the new commit, so regenerate it on every re-pin:
//
//   python3 -I scripts/agenpas/extract_backend_final_codes.py --repo <pivota-backend checkout> --sha <sha> \
//     > tests/fixtures/agenpas_backend_final_codes.backend.json
//
// If the backend ships its own contract file of final codes, pass it as `--contract <path>`: the extractor merges it.
// The fixture's `dynamic` list names the write sites whose codes are built at run time (a partner's own codes on a
// failed rp_-rail row read "checking" by design). Placeholder ids only. No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  projectPurchaseView, isKnownFinalCode, HELD_CODES, FINAL_CHECKING_CODES,
} = require('../src/agenpas/view');

const PINNED_BACKEND_SHA = '838643e34';
const MIRROR = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agenpas_backend_final_codes.backend.json'), 'utf8'));
const BACKEND = Object.freeze({ a2a: MIRROR.a2a, reap: MIRROR.reap });

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
  not_purchasable: { kind: 'not_purchasable', title: "This item can't be bought here right now", message: "This item can't be bought through AgenPas at the moment. Nothing more needs to be done.", retry_hint: false, outcome_unknown: false },
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
  ...['pilot_scope_invalid', 'pilot_scope_refused'].map((code) => ['reap', 'refused', code, 'not_purchasable']),
  ...['invalid_request', 'resolve_failed', 'cart_link_quote_unbuildable'].map((code) => ['reap', 'refused', code, 'refused_before_order']),
  ['reap', 'failed', 'quote_failed', 'not_submitted'],
  ['reap', 'failed', 'checkout_create_failed', 'post_checkout_failed'],
];

const ID = { a2a: 'ap_0123456789abcdef01234567', reap: 'rp_0123456789abcdef01234567' };
function outcome(rail, state, code, field = state === 'refused' ? 'refusal_reason' : 'last_error_code') {
  const body = {
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail, rail_purchase_id: ID[rail], state, poll_after_seconds: null,
    detail: { id: ID[rail], merchant_domain: 'merchant.example', [field]: code },
  };
  return projectPurchaseView(body, { purchaseId: ID[rail] });
}

test('the mirror is the pinned backend commit, and it names both rails\' three final states', () => {
  assert.equal(MIRROR.backend_sha, PINNED_BACKEND_SHA);
  assert.equal(MIRROR.generated_by, 'scripts/agenpas/extract_backend_final_codes.py');
  for (const rail of ['a2a', 'reap']) for (const state of ['failed', 'refused', 'expired']) assert.ok(BACKEND[rail][state].length > 0, `${rail}/${state}`);
  // The codes the review named are in the mirror (found at their write sites, not typed in).
  for (const [rail, state, code] of [['a2a', 'expired', 'shipping_address_not_collected'], ['reap', 'refused', 'pilot_scope_invalid'],
    ['reap', 'refused', 'pilot_scope_refused'], ['reap', 'failed', 'attempts_exhausted'], ['a2a', 'expired', 'stale']]) {
    assert.ok(BACKEND[rail][state].includes(code), `${rail}/${state}/${code}`);
  }
});

test('parity with backend 838643e34 (both rails): every final code in the mirror is on an explicit gateway list', () => {
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

test('the quote / cart-link verdict codes ride beside a refusal reason, which decides the wording; alone on a refused row they read refused-before-order', () => {
  const both = (reason, code) => projectPurchaseView({
    purchase_id: 'pp_aaaaaaaaaaaaaaaaaaaaaaaa', rail: 'reap', rail_purchase_id: ID.reap, state: 'refused', poll_after_seconds: null,
    detail: { id: ID.reap, merchant_domain: 'merchant.example', refusal_reason: reason, last_error_code: code },
  }, { purchaseId: ID.reap }).outcome;
  assert.equal(both('price_changed', 'quote_items_subtotal_mismatch').kind, 'price_changed');
  assert.deepEqual(both('price_unverifiable', 'quote_items_mismatch'), COPY.refused_before_order);
  assert.deepEqual(both('cart_link_invalid', 'cart_link_quantity_mismatch'), COPY.refused_before_order);
  for (const code of ['quote_total_not_reconciled', 'cart_link_quantity_mismatch', 'cart_link_market_country']) {
    assert.deepEqual(outcome('reap', 'refused', code, 'last_error_code').outcome, COPY.refused_before_order, code);
    // Never read on another row: on a failed row the hold-shaped ones keep "checking".
  }
  assert.deepEqual(outcome('reap', 'failed', 'quote_items_mismatch', 'last_error_code').outcome, COPY.checking);
});
