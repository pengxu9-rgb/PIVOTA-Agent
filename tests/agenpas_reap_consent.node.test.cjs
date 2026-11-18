'use strict';

// AgenPas consent gate and the Reap rail's codes on the page projection (src/agenpas/view.js). Bodies follow the
// backend's unified purchase read, plus the consent contract the backend is building in parallel (docs/agenpas.md,
// "Terms and privacy consent"): `consent = {required, available, step, satisfied, terms_url, privacy_url,
// terms_version, privacy_version, offer: {id, issued_at}}`, and while gated `next_action = {kind, expires_at,
// consent_required: true}` (no url) with `detail.buyer_step` the same marker. Reap codes are enumerated from
// pivota-backend services/reap_agentic_purchase.py. Placeholder merchants and products only. No network.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectPurchaseView, consentToRecord, HELD_CODES, FAILED_CODES, REAP_HELD_CODES, REAP_FAILED_CODES,
  POST_CHECKOUT_GENERIC_CODES,
} = require('../src/agenpas/view');

const PP = 'pp_aaaaaaaaaaaaaaaaaaaaaaaa';
const RP = 'rp_0123456789abcdef01234567';
const AP = 'ap_0123456789abcdef01234567';
const HOSTS = Object.freeze(['pay.partner.example']);
const LEGAL = Object.freeze(['legal.example']);
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const LATER = '2026-11-18T12:20:00Z';
const CARD_PAGE = 'https://pay.partner.example/enroll?s=card-secret-1';
const APPROVE_PAGE = 'https://pay.partner.example/approve?s=approve-secret-2';
const OFFER = Object.freeze({ id: 'offer0123456789abcdef0123456789ab', issued_at: '2026-11-18T11:59:50Z' });

function consent(over = {}) {
  return {
    required: true, available: true, step: 'card_binding', satisfied: false,
    terms_url: 'https://legal.example/terms', privacy_url: 'https://legal.example/privacy',
    terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11', offer: { ...OFFER },
    ...over,
  };
}

function reap(state, extra = {}, detailExtra = {}) {
  return {
    purchase_id: PP, rail: 'reap', executor: 'rail_managed', rail_purchase_id: RP, state, rail_state: state,
    totals: { currency: 'USD', our_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    poll_after_seconds: 15,
    detail: {
      id: RP, state, merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss', quantity: 1, currency: 'USD',
      refusal_reason: null, last_error_code: null, ...detailExtra,
    },
    ...extra,
  };
}

function a2a(state, extra = {}, detailExtra = {}) {
  const body = reap(state, extra, detailExtra);
  return { ...body, rail: 'a2a', rail_purchase_id: AP, detail: { ...body.detail, id: AP } };
}

const CARD_ACTION = Object.freeze({ type: 'open_url', kind: 'card_binding', url: CARD_PAGE, expires_at: LATER });
const APPROVE_ACTION = Object.freeze({ type: 'open_url', kind: 'approval', url: APPROVE_PAGE, expires_at: LATER });
const GATED_CARD = Object.freeze({ kind: 'card_binding', expires_at: LATER, consent_required: true });
const GATED_APPROVE = Object.freeze({ kind: 'approval', expires_at: LATER, consent_required: true });

function project(body, opts = {}) {
  return projectPurchaseView(body, { purchaseId: PP, hostedHosts: HOSTS, now: NOW, linkExpiresAt: Math.floor(NOW / 1000) + 600, linkTtlMinutes: 30, ...opts });
}
const ON = Object.freeze({ consentEnabled: true, legalHosts: LEGAL });

// ---- flags off --------------------------------------------------------------------------------------------------

test('flag off: a body with no consent field projects with exactly the members it always had (no `consent`)', () => {
  for (const body of [a2a('needs_payment_method', { next_action: CARD_ACTION }), a2a('awaiting_buyer_authorization', { next_action: APPROVE_ACTION }),
    a2a('locking'), a2a('placing'), a2a('completed', { order_reference: '#1001' })]) {
    const off = project(body);
    const offExplicit = project(body, { consentEnabled: false, legalHosts: LEGAL });
    assert.equal(Object.hasOwn(off, 'consent'), false);
    assert.equal(JSON.stringify(off), JSON.stringify(offExplicit));
    assert.deepEqual(Object.keys(off), ['purchase_id', 'state', 'screen', 'terminal', 'merchant_domain', 'product_name', 'variant_title',
      'quantity', 'currency', 'amounts', 'action', 'order', 'outcome', 'poll_after_seconds', 'link_expires_at', 'link_ttl_minutes']);
  }
  // The A2A card page is shown exactly as before.
  assert.equal(project(a2a('needs_payment_method', { next_action: CARD_ACTION })).action.url, CARD_PAGE);
});

test('flag on, an A2A body with no consent field (the backend gate off): the hosted page as before, `consent: null`', () => {
  const view = project(a2a('needs_payment_method', { next_action: CARD_ACTION }), ON);
  assert.equal(view.screen, 'add_card');
  assert.equal(view.action.url, CARD_PAGE);
  assert.equal(view.consent, null);
});

// ---- R3-4: a Reap step needs a satisfied consent block, whatever the flags --------------------------------------

for (const [label, opts] of [['flag off', {}], ['flag on', ON]]) {
  test(`R3-4 (${label}): a Reap body with NO consent block never shows its hosted page: "not available right now"`, () => {
    for (const [state, nextAction] of [['needs_payment_method', CARD_ACTION], ['awaiting_buyer_authorization', APPROVE_ACTION]]) {
      const view = project(reap(state, { next_action: nextAction }), opts);
      assert.equal(view.screen, 'unavailable', state);
      assert.equal(view.action, null, state);
      assert.equal(view.terminal, false);
      assert.ok(view.poll_after_seconds >= 2, 'polling goes on');
      const json = JSON.stringify(view);
      assert.equal(json.includes('pay.partner.example'), false, 'the hosted URL string appears nowhere');
    }
  });
}

test('R3-4: an rp_ id alone (no `rail` member) is enough to gate; `rail: a2a` beside an rp_ id still gates (fail closed)', () => {
  const body = reap('needs_payment_method', { next_action: CARD_ACTION });
  delete body.rail;
  assert.equal(project(body, ON).screen, 'unavailable');
  assert.equal(project({ ...reap('needs_payment_method', { next_action: CARD_ACTION }), rail: 'a2a' }, ON).screen, 'unavailable');
  // The link naming an rp_ id gates too.
  const a2aShaped = a2a('needs_payment_method', { next_action: CARD_ACTION });
  assert.equal(project(a2aShaped, { ...ON, purchaseId: RP }).screen, 'unavailable');
});

test('R3-4: a Reap body whose consent block says the step is satisfied shows the hosted page', () => {
  const card = project(reap('needs_payment_method', { next_action: CARD_ACTION, consent: consent({ satisfied: true, offer: undefined }) }), ON);
  assert.equal(card.screen, 'add_card');
  assert.equal(card.action.url, CARD_PAGE);
  assert.equal(card.consent, null);
  const approve = project(reap('awaiting_buyer_authorization', { next_action: APPROVE_ACTION, consent: consent({ step: 'approval', satisfied: true }) }), ON);
  assert.equal(approve.screen, 'approve');
  assert.equal(approve.action.url, APPROVE_PAGE);
  // Satisfied for the OTHER step is not satisfied for this one.
  const wrongStep = project(reap('awaiting_buyer_authorization', { next_action: APPROVE_ACTION, consent: consent({ step: 'card_binding', satisfied: true }) }), ON);
  assert.equal(wrongStep.action, null);
  assert.equal(wrongStep.screen, 'unavailable');
});

// ---- the consent offer ------------------------------------------------------------------------------------------

test('gated and unsatisfied, flag on, a complete offer: the terms are offered, no hosted page even if the body carried one', () => {
  for (const body of [
    reap('needs_payment_method', { next_action: GATED_CARD, consent: consent() }, { buyer_step: GATED_CARD }),
    // A body that (wrongly) still carries the URL: never passed on before the consent.
    reap('needs_payment_method', { next_action: CARD_ACTION, consent: consent() }),
    a2a('needs_payment_method', { next_action: CARD_ACTION, consent: consent() }),
  ]) {
    const view = project(body, ON);
    assert.equal(view.screen, 'add_card');
    assert.equal(view.action, null);
    assert.deepEqual(view.consent, {
      step: 'card_binding', terms_url: 'https://legal.example/terms', privacy_url: 'https://legal.example/privacy', offer: { ...OFFER },
    });
    assert.equal(JSON.stringify(view).includes('card-secret-1'), false);
    // Never to the page: the versions, required/available/satisfied, the rail.
    assert.equal(/terms-2026-11|privacy-2026-11|"rail"|"required"|"satisfied"/.test(JSON.stringify(view)), false);
  }
});

test('the approval consent is offered while the total is confirmed (locking) and on the approval screen', () => {
  const locking = project(reap('locking', { consent: consent({ step: 'approval' }) }), ON);
  assert.equal(locking.screen, 'confirming_total');
  assert.equal(locking.consent.step, 'approval');
  const approve = project(reap('awaiting_buyer_authorization', { next_action: GATED_APPROVE, consent: consent({ step: 'approval' }) }), ON);
  assert.equal(approve.screen, 'approve');
  assert.equal(approve.consent.step, 'approval');
  assert.equal(approve.action, null);
  // A locking Reap body without any consent block: just "Confirming your total" (nothing to do yet).
  const plain = project(reap('locking'), ON);
  assert.equal(plain.screen, 'confirming_total');
  assert.equal(plain.consent, null);
});

test('an incomplete or untrusted consent block is never offered: "not available right now"', () => {
  const cases = {
    unavailable: consent({ available: false }),
    not_required: consent({ required: false }),
    no_offer: consent({ offer: undefined }),
    bad_offer_id: consent({ offer: { id: 'x', issued_at: OFFER.issued_at } }),
    bad_issued_at: consent({ offer: { id: OFFER.id, issued_at: 'yesterday' } }),
    other_legal_host: consent({ terms_url: 'https://elsewhere.example/terms' }),
    http_legal_url: consent({ privacy_url: 'http://legal.example/privacy' }),
    no_terms_version: consent({ terms_version: undefined }),
    long_version: consent({ privacy_version: 'p'.repeat(33) }),
    wrong_step: consent({ step: 'approval' }),
    junk_step: consent({ step: 'authenticate' }),
  };
  for (const [name, block] of Object.entries(cases)) {
    const view = project(reap('needs_payment_method', { next_action: GATED_CARD, consent: block }), ON);
    assert.equal(view.consent, null, name);
    assert.equal(view.action, null, name);
    assert.equal(view.screen, 'unavailable', name);
  }
});

test('the backend gate on while the gateway flag is off: "not available right now", never a dead approve screen', () => {
  for (const body of [
    a2a('needs_payment_method', { next_action: GATED_CARD, consent: consent() }),
    a2a('awaiting_buyer_authorization', { next_action: GATED_APPROVE }, { buyer_step: GATED_APPROVE }),
    a2a('awaiting_buyer_authorization', { next_action: { kind: 'approval', expires_at: LATER } }, { buyer_step: GATED_APPROVE }),
  ]) {
    const view = project(body);
    assert.equal(view.screen, 'unavailable');
    assert.equal(view.action, null);
    assert.equal(Object.hasOwn(view, 'consent'), false);
  }
});

test('the bank check (placing / authenticate) is never gated', () => {
  const view = project(a2a('placing', {
    next_action: { kind: 'authenticate', url: 'https://pay.partner.example/3ds?s=1', expires_at: LATER, consent_required: true },
    consent: consent({ step: 'approval' }),
  }), ON);
  assert.equal(view.screen, 'authenticate');
  assert.equal(view.action.kind, 'authenticate');
  assert.equal(view.consent, null);
});

test('held beats consent: a held purchase offers neither the terms nor a step', () => {
  for (const code of ['checkout_dispatch_unresolved', 'checkout_unresolvable:3:checkout_no_hosted_action']) {
    const view = project(reap('awaiting_buyer_authorization', { next_action: GATED_APPROVE, consent: consent({ step: 'approval' }) }, { last_error_code: code }), ON);
    assert.equal(view.screen, 'outcome_unknown', code);
    assert.equal(view.consent, null);
    assert.equal(view.action, null);
  }
});

test('contact re-entry (Reap contact_reentry_required): "details needed — go back to the chat", no card button, no consent', () => {
  for (const opts of [{}, ON]) {
    const view = project(reap('needs_payment_method', { next_action: CARD_ACTION, consent: consent({ satisfied: true }) }, { contact_reentry_required: true }), opts);
    assert.equal(view.screen, 'details_needed');
    assert.equal(view.action, null);
    assert.equal(view.terminal, false);
    assert.match(view.outcome.message, /Go back to the chat/);
    if (opts.consentEnabled) assert.equal(view.consent, null);
    const offered = project(reap('needs_payment_method', { next_action: GATED_CARD, consent: consent() }, { contact_reentry_required: true }), opts);
    assert.equal(offered.screen, 'details_needed');
    if (opts.consentEnabled) assert.equal(offered.consent, null);
  }
  // Held still wins over the pause.
  assert.equal(project(reap('locking', {}, { contact_reentry_required: true, last_error_code: 'checkout_dispatch_unresolved' })).screen, 'outcome_unknown');
  // Final: the purchase's own outcome, not the pause.
  assert.equal(project(reap('failed', {}, { contact_reentry_required: true })).screen, 'failed');
});

// ---- what a consent records -------------------------------------------------------------------------------------

test('consentToRecord: the step and the versions FROM THE READ, only when the page would offer the terms', () => {
  assert.deepEqual(consentToRecord(reap('needs_payment_method', { next_action: GATED_CARD, consent: consent() }), { purchaseId: PP, consentEnabled: true, legalHosts: LEGAL, now: NOW }),
    { step: 'card_binding', terms_version: 'terms-2026-11', privacy_version: 'privacy-2026-11' });
  assert.deepEqual(consentToRecord(reap('locking', { consent: consent({ step: 'approval' }) }), { purchaseId: PP, consentEnabled: true, legalHosts: LEGAL, now: NOW }).step, 'approval');
  for (const [body, opts] of [
    [reap('needs_payment_method', { next_action: GATED_CARD, consent: consent() }), { consentEnabled: false, legalHosts: LEGAL }],
    [reap('needs_payment_method', { next_action: GATED_CARD, consent: consent({ satisfied: true }) }), { consentEnabled: true, legalHosts: LEGAL }],
    [reap('placing', { consent: consent({ step: 'approval' }) }), { consentEnabled: true, legalHosts: LEGAL }],
    [reap('needs_payment_method', { next_action: GATED_CARD, consent: consent() }, { last_error_code: 'checkout_read_permanent:1:reap_status_404' }), { consentEnabled: true, legalHosts: LEGAL }],
    [reap('needs_payment_method', { next_action: GATED_CARD, consent: consent() }, { contact_reentry_required: true }), { consentEnabled: true, legalHosts: LEGAL }],
    [reap('needs_payment_method', { next_action: GATED_CARD, consent: consent() }), { consentEnabled: true, legalHosts: ['other.example'] }],
  ]) {
    assert.equal(consentToRecord(body, { purchaseId: PP, now: NOW, ...opts }), null);
  }
});

// ---- the Reap rail's codes (R2-6): one row per code, state x wording ---------------------------------------------

const NOT_SENT = /no order was sent/;
const CHECKING = /checking with the store — don't try again/;
const CARD = /card couldn't be set up/;

test('Reap HELD codes (bare and in their compound formats): the checking screen in every state, never "no order was sent"', () => {
  const codes = ['checkout_unresolvable:3:checkout_no_hosted_action', 'checkout_unresolvable:3:operator_found_completed',
    'checkout_unresolvable:4:reap_status_404', 'checkout_read_permanent:1:reap_status_404', 'checkout_read_permanent:2:unknown_checkout_status',
    'checkout_dispatch_unresolved', 'checkout_created_hosted_url_refused'];
  for (const code of codes) {
    for (const state of ['locking', 'awaiting_buyer_authorization', 'placing', 'failed', 'expired']) {
      const view = project(reap(state, {}, { last_error_code: code }), ON);
      assert.equal(view.screen, 'outcome_unknown', `${state} ${code}`);
      assert.match(view.outcome.message, CHECKING, `${state} ${code}`);
      assert.equal(NOT_SENT.test(view.outcome.message), false);
      assert.equal(view.action, null);
    }
    // And against a FAILED code on the same purchase: held wins.
    assert.equal(project(reap('failed', {}, { refusal_reason: 'no_active_enrollment', last_error_code: code })).screen, 'outcome_unknown', code);
  }
  for (const code of REAP_HELD_CODES) assert.equal(HELD_CODES.has(code), true, code);
});

test('a new unresolvable-shaped code is read as a hold (shape += unresolvab)', () => {
  assert.equal(project(reap('failed', {}, { last_error_code: 'checkout_newly_unresolvable' })).screen, 'outcome_unknown');
  assert.equal(project(reap('placing', {}, { last_error_code: 'quote_unresolvable_later' })).screen, 'outcome_unknown');
});

test('Reap FAILED codes (written before any Reap checkout exists): "no order was sent", never the card wording', () => {
  const rows = [
    ['failed', 'enrollment_no_hosted_action'], ['failed', 'enrollment_id_conflict'], ['failed', 'enrollment_row_unreadable'],
    ['failed', 'enrollment_not_activatable'], ['failed', 'enrollment_dead'], ['failed', 'enrollment_create_failed'],
    ['failed', 'enrollment_read_failed'], ['failed', 'no_active_enrollment'], ['failed', 'enrollment_not_active'],
    ['failed', 'quote_id_missing'],
  ];
  assert.deepEqual(rows.map(([, c]) => c).sort(), [...REAP_FAILED_CODES].sort());
  for (const [state, code] of rows) {
    const view = project(reap(state, {}, { last_error_code: code }));
    assert.equal(view.screen, 'failed', code);
    assert.equal(view.outcome.kind, 'not_submitted', code);
    assert.match(view.outcome.message, NOT_SENT, code);
    assert.equal(CARD.test(view.outcome.message), false, code);
    assert.equal(FAILED_CODES.has(code), true, code);
  }
});

test('Reap post-checkout codes: the generic wording, never "no order was sent", never the card wording', () => {
  for (const [state, code] of [['failed', 'checkout_failed'], ['expired', 'checkout_expired'], ['failed', 'checkout_expired'],
    ['failed', 'checkout_id_missing'], ['failed', 'partner_id_malformed']]) {
    const view = project(reap(state, {}, { last_error_code: code }));
    assert.equal(view.screen, state, code);
    assert.equal(view.outcome.kind, state, `${state} ${code}: the state's own generic wording`);
    assert.equal(NOT_SENT.test(view.outcome.message), false, code);
    assert.equal(CARD.test(view.outcome.message), false, code);
    assert.equal(POST_CHECKOUT_GENERIC_CODES.has(code), true);
    // Beside a pre-checkout FAILED code it still keeps "no order was sent" away.
    const both = project(reap(state, {}, { refusal_reason: 'no_active_enrollment', last_error_code: code }));
    assert.equal(NOT_SENT.test(both.outcome.message), false, `${code} + no_active_enrollment`);
  }
});

test('Reap approval_window_lapsed: the approval did not go through in time (no claim of the cause), and it keeps "no order was sent" away', () => {
  const view = project(reap('failed', {}, { last_error_code: 'approval_window_lapsed' }));
  assert.equal(view.outcome.kind, 'approval_timed_out');
  assert.equal(view.outcome.message, "The approval didn't go through in time, so the order wasn't placed. You can start again from the chat.");
  assert.equal(/wasn't approved/.test(view.outcome.message), false, 'never says the buyer did not approve');
  // The A2A rail's own timed-out codes keep their wording.
  assert.match(project(a2a('failed', {}, { last_error_code: 'vic_authorization_expired' })).outcome.message, /wasn't approved in time/);
  const both = project(reap('failed', {}, { refusal_reason: 'quote_id_missing', last_error_code: 'approval_window_lapsed' }));
  assert.equal(both.outcome.kind, 'approval_timed_out');
});

test('Reap buyer_email_missing (resolving -> failed): "some details were missing"', () => {
  const view = project(reap('failed', {}, { last_error_code: 'buyer_email_missing' }));
  assert.equal(view.outcome.kind, 'details_needed');
});

test('Reap pending-step codes (released, non-final) leave the step alone; an unknown partner code gets neutral wording', () => {
  for (const code of ['enrollment_settling', 'enrollment_pending', 'enrollment_link_expired', 'quote_expired', 'checkout_quote_replayed',
    'checkout_read_recovered', 'contact_retention_elapsed', 'transport_error:readtimeout', 'quote_budget_exhausted']) {
    const card = project(reap('needs_payment_method', { next_action: CARD_ACTION, consent: consent({ satisfied: true }) }, { last_error_code: code }), ON);
    assert.equal(card.screen, 'add_card', code);
    assert.equal(card.action.url, CARD_PAGE, code);
  }
  const unknown = project(reap('failed', {}, { last_error_code: 'agentic_resource_not_found' }));
  assert.equal(unknown.outcome.kind, 'failed');
  assert.equal(/try again|no order was sent/i.test(unknown.outcome.message), false);
});

test('the backend\'s dwell: `min_dwell_seconds` (on the block or the offer) reaches the page only when stated and sane', () => {
  const at = (block) => project(reap('needs_payment_method', { next_action: GATED_CARD, consent: block }), ON).consent;
  assert.equal(Object.hasOwn(at(consent()), 'min_dwell_seconds'), false);
  assert.equal(at(consent({ min_dwell_seconds: 3 })).min_dwell_seconds, 3);
  assert.equal(at(consent({ offer: { ...OFFER, min_dwell_seconds: 5 } })).min_dwell_seconds, 5);
  for (const bad of [-1, 1.5, '3', 121, null]) assert.equal(Object.hasOwn(at(consent({ min_dwell_seconds: bad })), 'min_dwell_seconds'), false, String(bad));
});
