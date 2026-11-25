'use strict';

// AgenPas page projection (src/agenpas/view.js) and the gateway-side hosted URL allowlist (src/agenpas/hostedUrl.js).
// Bodies follow the backend's unified purchase read (pivota-backend docs/agent_purchases_routes.md). Placeholder
// merchants and products only. No network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectPurchaseView, screenFor, outcomeFor, isOutcomeUnknownCode, codeSegments, KNOWN_STATES, HELD_CODES, FAILED_CODES } = require('../src/agenpas/view');
const { isAllowedHostedUrl } = require('../src/agenpas/hostedUrl');

const PP = 'pp_aaaaaaaaaaaaaaaaaaaaaaaa';
const AP = 'ap_0123456789abcdef01234567';
const HOSTS = Object.freeze(['pay.partner.example']);
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const CARD_PAGE = 'https://pay.partner.example/bind?session=s1';
const APPROVE_PAGE = 'https://pay.partner.example/approve?session=s2';

function unified(state, extra = {}, detailExtra = {}) {
  return {
    purchase_id: PP,
    rail: 'a2a',
    executor: 'rail_managed',
    rail_purchase_id: AP,
    state,
    rail_state: state,
    created_at: '2026-11-17T11:59:00+00:00',
    totals: { currency: 'USD', our_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 },
    poll_after_seconds: 15,
    detail: {
      id: AP,
      state,
      merchant_domain: 'merchant.example',
      product_key: 'prod::m_fixture::shopify::1001',
      product_name: 'Sample Lip Gloss',
      variant_title: 'Rose 04',
      quantity: 2,
      currency: 'USD',
      refusal_reason: null,
      last_error_code: null,
      consent_version: 'terms-fixture',
      consented_at: '2026-11-17T11:58:00+00:00',
      agent_user_ref_hash: 'owner-hash-fixture',
      agent_id: 'agent_fixture',
      ...detailExtra,
    },
    ...extra,
  };
}

function project(body, opts = {}) {
  return projectPurchaseView(body, { purchaseId: AP, hostedHosts: HOSTS, now: NOW, linkExpiresAt: Math.floor(NOW / 1000) + 600, linkTtlMinutes: 30, ...opts });
}

// ---- the allowlist ---------------------------------------------------------------------------------------------

test('hosted URL allowlist: https on an exactly-listed host only', () => {
  assert.equal(isAllowedHostedUrl(CARD_PAGE, HOSTS), true);
  assert.equal(isAllowedHostedUrl('https://PAY.partner.example./x', HOSTS), true);
  assert.equal(isAllowedHostedUrl('https://pay.partner.example:443/x', HOSTS), true);
  for (const bad of [
    'http://pay.partner.example/bind', // not https
    'javascript:alert(1)',
    'data:text/html,hi',
    '//pay.partner.example/bind',
    'https://evil.example/bind',
    'https://pay.partner.example.evil.example/bind', // suffix trick
    'https://sub.pay.partner.example/bind', // no wildcard
    'https://user:pw@pay.partner.example/bind', // userinfo
    'https://pay.partner.example:8443/bind', // non-default port
    `https://pay.partner.example/${'a'.repeat(5000)}`,
    '', null, undefined, 42,
  ]) assert.equal(isAllowedHostedUrl(bad, HOSTS), false, String(bad).slice(0, 60));
});

test('hosted URL allowlist: empty (the default) refuses everything', () => {
  assert.equal(isAllowedHostedUrl(CARD_PAGE, []), false);
  assert.equal(isAllowedHostedUrl(CARD_PAGE, undefined), false);
});

// ---- the projection --------------------------------------------------------------------------------------------

const ALLOWED_KEYS = [
  'action', 'amounts', 'currency', 'link_expires_at', 'link_ttl_minutes', 'merchant_domain', 'order', 'outcome', 'poll_after_seconds',
  'product_name', 'purchase_id', 'quantity', 'screen', 'state', 'terminal', 'variant_title',
].sort();

test('projection: exactly the allowlisted fields; no rail, executor, other ids, owner hashes, consent or detail', () => {
  const body = unified('needs_payment_method', {
    next_action: { type: 'open_url', kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-11-17T12:15:00+00:00' },
    agent_user_ref_hash: 'top-level-owner-hash', member_id: 'mem_fixture', stack: 'Traceback (most recent call last)…',
  });
  const view = project(body);
  assert.deepEqual(Object.keys(view).sort(), ALLOWED_KEYS);
  const text = JSON.stringify(view);
  for (const leaked of [PP, 'a2a', 'rail_managed', 'owner-hash-fixture', 'top-level-owner-hash', 'mem_fixture',
    'agent_fixture', 'terms-fixture', 'prod::m_fixture', 'Traceback']) {
    assert.equal(text.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.equal(view.purchase_id, AP);
  assert.equal(view.state, 'needs_payment_method');
  assert.equal(view.screen, 'add_card');
  assert.equal(view.terminal, false);
  assert.equal(view.merchant_domain, 'merchant.example');
  assert.equal(view.product_name, 'Sample Lip Gloss');
  assert.equal(view.variant_title, 'Rose 04');
  assert.equal(view.quantity, 2);
  assert.equal(view.currency, 'USD');
  assert.deepEqual(view.amounts, { unit_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: null, shipping_minor: 399, tax_minor: 150 });
  assert.deepEqual(view.action, { kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-11-17T12:15:00.000Z', open_mode: 'popup' });
  assert.equal(view.poll_after_seconds, 15);
  assert.equal(view.link_expires_at, new Date(NOW + 600_000).toISOString());
  assert.equal(view.link_ttl_minutes, 30);
});

test('projection: a flatter body (fields at the top level, `action`) projects the same', () => {
  const flat = {
    purchase_id: AP, state: 'awaiting_buyer_authorization', merchant_domain: 'merchant.example', product_name: 'Sample Lip Gloss',
    variant_title: null, quantity: 1, currency: 'USD', our_price_minor: 1800, quoted_total_minor: 2100,
    action: { kind: 'approval', url: APPROVE_PAGE, expires_at: '2026-11-17T12:10:00Z' }, poll_after_seconds: 5,
  };
  const view = project(flat);
  assert.equal(view.screen, 'approve');
  assert.equal(view.amounts.quoted_total_minor, 2100);
  assert.equal(view.action.url, APPROVE_PAGE);
});

test('projection: the action is dropped unless allowlisted, https, the right kind for the state, and unexpired', () => {
  const base = (action, state = 'needs_payment_method') => project(unified(state, { next_action: action })).action;
  const ok = { kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-11-17T12:15:00Z' };
  assert.ok(base(ok));
  assert.equal(base({ ...ok, url: 'http://pay.partner.example/bind' }), null);
  assert.equal(base({ ...ok, url: 'https://unknown.example/bind' }), null);
  assert.equal(base({ ...ok, url: 'javascript:alert(1)' }), null);
  assert.equal(base({ ...ok, kind: 'approval' }), null); // stale page from another state
  assert.equal(base(ok, 'awaiting_buyer_authorization'), null);
  assert.equal(base({ ...ok, expires_at: '2026-11-17T11:00:00Z' }), null); // expired
  assert.equal(base({ ...ok, expires_at: undefined }), null); // no deadline: never shown
  assert.equal(base({ ...ok, expires_at: 'soon' }), null);
  assert.equal(project(unified('needs_payment_method', { next_action: ok }), { hostedHosts: [] }).action, null); // default empty list
  assert.equal(project(unified('completed', { next_action: ok })).action, null);
});

test('projection: the action URL is the parsed, re-serialized URL, never the raw string', () => {
  const raw = 'https://PAY.Partner.Example:443/bind?session=s1';
  const view = project(unified('needs_payment_method', { next_action: { kind: 'card_binding', url: raw, expires_at: '2026-11-17T12:15:00Z' } }));
  assert.equal(view.action.url, 'https://pay.partner.example/bind?session=s1');
});

test('projection: embed mode marks the action for framing', () => {
  const view = project(unified('needs_payment_method', { next_action: { kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-11-17T12:15:00Z' } }), { embed: true });
  assert.equal(view.action.open_mode, 'embed');
});

test('projection: text is cleaned and capped; a bad domain, currency or quantity is dropped', () => {
  const view = project(unified('routing', {}, {
    product_name: `  Sample\u0000 Lip\nGloss ${'x'.repeat(400)}`, merchant_domain: 'not a domain<script>', quantity: 1000,
  }));
  assert.equal(view.product_name.startsWith('Sample Lip Gloss'), true);
  assert.ok(view.product_name.length <= 200);
  assert.equal(view.merchant_domain, null);
  assert.equal(view.quantity, null);
  // A malformed currency is a disagreement with detail.currency: no currency, no amounts.
  const badCurrency = project({ ...unified('routing'), totals: { currency: 'usd<', our_price_minor: 1800 } });
  assert.equal(badCurrency.currency, null);
  assert.equal(badCurrency.amounts.unit_price_minor, null);
  const negative = project({ ...unified('routing'), totals: { currency: 'USD', our_price_minor: -5 } });
  assert.equal(negative.currency, 'USD');
  assert.equal(negative.amounts.unit_price_minor, null);
});

test('projection: completed carries the order reference and a merchant-domain order page only', () => {
  const done = unified('completed', { order_reference: '#1001', poll_after_seconds: null, totals: { currency: 'USD', final_total_minor: 2297 } },
    { merchant_order_status_url: 'https://shop.merchant.example/orders/1001' });
  const view = project(done);
  assert.equal(view.screen, 'done');
  assert.equal(view.terminal, true);
  assert.equal(view.poll_after_seconds, null);
  assert.deepEqual(view.order, { reference: '#1001', status_url: 'https://shop.merchant.example/orders/1001', total_unparsed: false });
  assert.equal(view.amounts.final_total_minor, 2297);
  const offDomain = project(unified('completed', { order_reference: '#1001' }, { merchant_order_status_url: 'https://platform.example/orders/1' }));
  assert.equal(offDomain.order.status_url, null);
  const httpPage = project(unified('completed', { order_reference: '#1001' }, { merchant_order_status_url: 'http://merchant.example/orders/1' }));
  assert.equal(httpPage.order.status_url, null);
});

test('projection: poll interval is clamped to 2..15 s, defaults to 5, and is null once terminal', () => {
  assert.equal(project(unified('placing', { poll_after_seconds: 0.5 })).poll_after_seconds, 2);
  assert.equal(project(unified('placing', { poll_after_seconds: 30 })).poll_after_seconds, 15);
  assert.equal(project(unified('placing', { poll_after_seconds: null })).poll_after_seconds, 5);
  assert.equal(project(unified('failed', { poll_after_seconds: 30 })).poll_after_seconds, null);
});

// ---- state -> screen -------------------------------------------------------------------------------------------

test('every unified state maps to a screen, and an unknown state maps to `unknown` (keep polling, claim nothing)', () => {
  const expected = {
    routing: 'preparing',
    needs_payment_method: 'add_card',
    locking: 'confirming_total',
    awaiting_buyer_authorization: 'approve',
    placing: 'placing',
    completed: 'done',
    failed: 'failed',
    refused: 'refused',
    expired: 'expired',
    // Without an address request in the view (or with collection off, see the address tests): just "getting ready".
    needs_shipping_address: 'preparing',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...KNOWN_STATES].sort());
  for (const [state, screen] of Object.entries(expected)) assert.equal(screenFor(state), screen, state);
  assert.equal(screenFor('placing', { actionKind: 'authenticate' }), 'authenticate');
  for (const odd of ['some_future_state', '', undefined, null, 'COMPLETED', '__proto__']) assert.equal(screenFor(odd), 'unknown');
  const view = project(unified('some_future_state'));
  assert.equal(view.state, 'unknown');
  assert.equal(view.screen, 'unknown');
  assert.equal(view.terminal, false);
  assert.equal(view.outcome, null);
  assert.ok(view.poll_after_seconds >= 2);
});

test('placing with a vetted bank check page shows the authenticate screen', () => {
  const view = project(unified('placing', { next_action: { kind: 'authenticate', url: 'https://pay.partner.example/3ds', expires_at: '2026-11-17T12:15:00Z' } }));
  assert.equal(view.screen, 'authenticate');
  assert.equal(view.action.kind, 'authenticate');
});

// ---- failure wording -------------------------------------------------------------------------------------------

// The exact final copies (src/agenpas/view.js): "checking" on a failed row, and the refused / expired rows' own words.
const FINAL_CHECKING_COPY = Object.freeze({
  kind: 'outcome_unknown', title: "We're checking with the store",
  message: "We're checking with the store — don't try again. Your order may already be in progress, and we'll confirm what happened in the chat.",
  retry_hint: false, outcome_unknown: true,
});
const STATE_COPY = Object.freeze({
  refused: {
    kind: 'refused', title: "This purchase couldn't be started",
    message: "The store or our payment partner couldn't accept this purchase. Go back to the chat for other options.",
    retry_hint: false, outcome_unknown: false,
  },
  expired: {
    kind: 'expired', title: 'This purchase expired',
    message: "It wasn't completed in time. Go back to the chat to check on it or to start again.",
    retry_hint: true, outcome_unknown: false,
  },
});

test('outcome-unknown codes say "checking with the store — don\'t try again" and never offer a retry', () => {
  for (const code of ['vic_order_outcome_unknown', 'outcome_unknown', 'vic_submit_unresolved', 'pending_write_unreconcilable', 'some_new_outcome_unknown_code']) {
    assert.equal(isOutcomeUnknownCode(code), true, code);
    // A hold-SHAPED code (not on the HELD list) reads "checking" only on a failed row: refused / expired end before
    // any money step on both rails, so there it reads the state's own words.
    const states = code === 'some_new_outcome_unknown_code' ? ['failed'] : ['failed', 'refused', 'expired'];
    if (code === 'some_new_outcome_unknown_code') {
      for (const state of ['refused', 'expired']) {
        const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: code }));
        assert.equal(view.screen, state);
        assert.deepEqual(view.outcome, STATE_COPY[state], state);
      }
    }
    for (const state of states) {
      const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: code }));
      assert.equal(view.screen, 'outcome_unknown');
      assert.equal(view.outcome.outcome_unknown, true);
      assert.equal(view.outcome.retry_hint, false);
      assert.match(view.outcome.message, /checking with the store — don't try again/);
    }
  }
  // One outcome-unknown code among others still wins.
  const mixed = project(unified('failed', {}, { refusal_reason: 'vic_authorization_declined', last_error_code: 'vic_order_outcome_unknown' }));
  assert.equal(mixed.screen, 'outcome_unknown');
});

test('known codes map to plain language; the raw code never reaches the page', () => {
  const declined = project(unified('failed', {}, { last_error_code: 'vic_authorization_declined' }));
  assert.equal(declined.screen, 'failed');
  assert.equal(declined.outcome.kind, 'declined');
  assert.equal(declined.outcome.retry_hint, true);
  assert.equal(JSON.stringify(declined).includes('vic_authorization_declined'), false);
  const refused = project(unified('refused', {}, { refusal_reason: 'merchant_not_purchasable' }));
  assert.equal(refused.outcome.kind, 'not_purchasable');
  assert.equal(refused.outcome.retry_hint, false);
});

test('an unrecognised code (or junk) on a final purchase gets the checking wording; no code gets the generic wording', () => {
  const failed = outcomeFor('failed', ['brand_new_code', '<b>Traceback</b>']);
  assert.equal(failed.kind, 'outcome_unknown');
  assert.equal(failed.retry_hint, false);
  assert.equal(failed.outcome_unknown, true);
  assert.equal(outcomeFor('failed', []).kind, 'failed');
  assert.equal(outcomeFor('refused', []).kind, 'refused');
  assert.equal(outcomeFor('expired', [null]).kind, 'expired');
  assert.equal(outcomeFor('completed', ['vic_order_outcome_unknown']), null);
  assert.equal(outcomeFor('placing', []), null);
  // Held in ANY state not yet final (review round 2, P2-1).
  assert.equal(outcomeFor('locking', ['vic_order_outcome_unknown']).kind, 'held');
  assert.equal(outcomeFor('locking', ['brand_new_code']), null);
});

// ---- compound and new codes (the backend's real formats) -------------------------------------------------------

test('codes are lower-cased and split on ":"; every segment is read', () => {
  // The step prefixes are bookkeeping and are skipped.
  assert.deepEqual(codeSegments(['PAID_SENT:2:Rose-04:VIC_ORDER_STALE', 'bound_sent:1:token_failed', null, 7]),
    ['2', 'vic_order_stale', '1', 'token_failed']);
});

const MONEY_MAY_HAVE_MOVED = [
  'money_result_seen', 'vic_order_stale', 'vic_total_over_approved', 'vic_currency_mismatch', 'vic_currency_missing',
  'vic_total_missing', 'vic_approved_amount_missing', 'vic_submit_unresolved',
  'checkout_confirm_unresolved', 'checkout_confirm_error_card', 'checkout_confirm_conflict', 'checkout_payment_no_order',
  'checkout_unknown_timeout', 'checkout_unknown_script_error', 'checkout_total_over_approved', 'checkout_result_overdue',
  'checkout_cancel_unresolved', 'checkout_order_id_card_shaped',
];

test('money-may-have-moved / hold codes are outcome_unknown, bare or inside the compound formats, and win over everything', () => {
  for (const code of MONEY_MAY_HAVE_MOVED) {
    for (const spelled of [code, code.toUpperCase(), `paid_sent:3:sku-1:${code}`, `bound_sent:1:${code}`]) {
      for (const state of ['failed', 'refused', 'expired']) {
        const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: spelled }));
        assert.equal(view.screen, 'outcome_unknown', `${state} ${spelled}`);
        assert.equal(view.outcome.retry_hint, false);
        assert.equal(/wasn't placed|try again from|start again/.test(view.outcome.message), false);
        assert.match(view.outcome.message, /don't try again/);
      }
    }
  }
  // Wins over a named code elsewhere, in either field and either order.
  const mixed = project(unified('failed', {}, { refusal_reason: 'binding_refused:card:402', last_error_code: 'paid_sent:1:v:vic_order_stale' }));
  assert.equal(mixed.screen, 'outcome_unknown');
});

test('paid_sent is the approval step, not a charge: only its code segment decides', () => {
  // An approval that expired: the ordinary wording, never "don't try again".
  for (const state of ['failed', 'expired']) {
    const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: 'paid_sent:2:scheme:buyer_action_expired' }));
    assert.notEqual(view.screen, 'outcome_unknown', state);
    assert.equal(view.outcome.outcome_unknown, false);
    assert.equal(/don't try again/.test(view.outcome.message), false);
  }
  assert.equal(isOutcomeUnknownCode('paid_sent:2:scheme:buyer_action_expired'), false);
  assert.equal(isOutcomeUnknownCode('paid_sent'), false);
  assert.equal(isOutcomeUnknownCode('bound_sent:1:x'), false);
  // A hold / unknown code behind the prefix still decides.
  const unresolved = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'paid_sent:3:scheme:vic_submit_unresolved' }));
  assert.equal(unresolved.screen, 'outcome_unknown');
  assert.equal(unresolved.outcome.retry_hint, false);
  // An unrecognised code behind the prefix: the checking wording (review: unknown codes are never neutral once final).
  assert.equal(project(unified('failed', {}, { last_error_code: 'paid_sent:1:v:some_new_code' })).outcome.kind, 'outcome_unknown');
  // buyer_action_expired itself is named: the approval timed out.
  assert.equal(project(unified('failed', {}, { last_error_code: 'paid_sent:2:scheme:buyer_action_expired' })).outcome.kind, 'approval_timed_out');
});

test('binding_refused:<kind>:<status> reads as the card not being usable', () => {
  const view = project(unified('failed', {}, { refusal_reason: 'binding_refused:card_type:422' }));
  assert.equal(view.outcome.kind, 'card_not_added');
});

test('checkout_total_unparsed: retired by the backend; a completed purchase shows its verified total as usual', () => {
  const view = project(unified('completed', { order_reference: '#1001', totals: { currency: 'USD', final_total_minor: 2297 } },
    { last_error_code: 'checkout_total_unparsed' }));
  assert.equal(view.screen, 'done');
  assert.equal(view.order.total_unparsed, false);
  assert.equal(view.amounts.final_total_minor, 2297);
});

test('the generic failed wording is neutral: no "try again", no claim the order was not placed', () => {
  const view = project(unified('failed', {}, { last_error_code: null }));
  assert.equal(view.outcome.kind, 'failed');
  assert.equal(view.outcome.retry_hint, false);
  assert.equal(/try again|wasn't placed/i.test(`${view.outcome.title} ${view.outcome.message}`), false);
});

// ---- review round 3 -------------------------------------------------------------------------------------------

test('every backend hold code is outcome_unknown (cross-checked with _CHECKOUT_HOLD_CODES and _VIC_HOLD_CODES)', () => {
  const CHECKOUT_HOLD = ['checkout_confirm_unresolved', 'checkout_confirm_unrecognised', 'checkout_task_invalid',
    'checkout_task_mismatch', 'checkout_result_unrecognised', 'checkout_result_overdue', 'checkout_total_over_approved',
    'checkout_unknown_timeout', 'checkout_unknown_script_error', 'checkout_confirm_error_card', 'checkout_payment_no_order',
    'checkout_order_id_card_shaped', 'checkout_cancel_unresolved', 'checkout_confirm_conflict', 'checkout_confirm_ambiguous_4xx'];
  const VIC_HOLD = ['vic_order_stale', 'vic_total_over_approved', 'vic_currency_mismatch', 'vic_currency_missing',
    'vic_total_missing', 'vic_approved_amount_missing', 'vic_submit_unresolved'];
  for (const code of [...CHECKOUT_HOLD, ...VIC_HOLD]) {
    assert.equal(isOutcomeUnknownCode(code), true, code);
    assert.equal(project(unified('failed', {}, { last_error_code: `paid_sent:1:scheme:${code}` })).screen, 'outcome_unknown', code);
  }
  // The shape catches a new code of those families, but never overrides a code a named group already words.
  assert.equal(isOutcomeUnknownCode('checkout_something_unrecognised'), true);
  assert.equal(isOutcomeUnknownCode('vic_quote_mismatch'), false);
  assert.equal(project(unified('failed', {}, { last_error_code: 'vic_quote_mismatch' })).outcome.kind, 'price_changed');
});

test('placing with a hold code: the checking screen, NOT terminal (polling goes on), never "under a minute"', () => {
  const view = project(unified('placing', { poll_after_seconds: 5 }, { last_error_code: 'checkout_confirm_ambiguous_4xx' }));
  assert.equal(view.screen, 'outcome_unknown');
  assert.equal(view.terminal, false);
  assert.equal(view.poll_after_seconds, 5);
  assert.equal(view.outcome.kind, 'held');
  assert.equal(view.outcome.retry_hint, false);
  assert.match(view.outcome.message, /don't try again/);
  assert.equal(/minute/.test(view.outcome.message), false);
  // Without a hold code, placing is placing.
  assert.equal(project(unified('placing')).screen, 'placing');
  assert.equal(project(unified('placing')).outcome, null);
});

test('two currencies that disagree: no amount at all, and a completed order says "see your email receipt"', () => {
  const body = unified('awaiting_buyer_authorization', { totals: { currency: 'USD', our_price_minor: 1800, quoted_total_minor: 2349, final_total_minor: 2297, shipping_minor: 399, tax_minor: 150 } },
    { currency: 'EUR' });
  const view = project(body);
  assert.equal(view.currency, null);
  assert.deepEqual(view.amounts, { unit_price_minor: null, quoted_total_minor: null, final_total_minor: null, shipping_minor: null, tax_minor: null });
  const done = project({ ...body, state: 'completed', order_reference: '#1001' });
  assert.equal(done.order.total_unparsed, true);
  assert.equal(done.amounts.final_total_minor, null);
  // Agreeing (or only one) currency: amounts as before.
  assert.equal(project(unified('awaiting_buyer_authorization', {}, { currency: 'USD' })).amounts.quoted_total_minor, 2349);
});

test('the expired wording makes no claim the order was not placed', () => {
  const view = project(unified('expired', { poll_after_seconds: null }));
  assert.equal(view.outcome.kind, 'expired');
  assert.equal(/wasn't placed|nothing was charged/i.test(view.outcome.message), false);
});

// ---- backend 2fe07431c: one test per code ----------------------------------------------------------------------

const HELD = [
  'checkout_confirm_unresolved', 'checkout_confirm_unrecognised', 'checkout_confirm_text_only', 'checkout_confirm_error_card',
  'checkout_confirm_conflict', 'checkout_confirm_ambiguous_4xx', 'checkout_setup_submitted', 'checkout_setup_unresolved',
  'checkout_task_invalid', 'checkout_task_mismatch', 'checkout_result_unrecognised', 'checkout_result_overdue',
  'checkout_total_unverified', 'checkout_total_over_approved', 'checkout_payment_no_order', 'checkout_order_id_card_shaped',
  'checkout_unknown_timeout', 'checkout_unknown_script_error', 'checkout_cancel_unresolved',
  'checkout_confirm_pending_check', 'checkout_confirm_not_sent', 'checkout_paying_without_task',
  'checkout_payment_reached_unconfirmed', 'checkout_payment_reached_declined', 'checkout_answer_scrubbed', 'money_result_seen',
  'vic_order_stale', 'vic_total_over_approved', 'vic_currency_mismatch', 'vic_currency_missing', 'vic_total_missing',
  'vic_approved_amount_missing', 'vic_submit_unresolved',
];
for (const code of HELD) {
  test(`HELD ${code}: placing shows the checking screen and keeps polling; a terminal state is outcome_unknown, never a retry`, () => {
    const held = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: `paid_sent:1:scheme:${code}` }));
    assert.equal(held.screen, 'outcome_unknown');
    assert.equal(held.terminal, false);
    assert.equal(held.poll_after_seconds, 15);
    assert.equal(held.outcome.kind, 'held');
    for (const state of ['failed', 'refused', 'expired']) {
      const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: code }));
      assert.equal(view.screen, 'outcome_unknown', state);
      assert.equal(view.outcome.retry_hint, false);
      assert.match(view.outcome.message, /don't try again/);
    }
  });
}

const FAILED = [
  'checkout_contact_incomplete', 'checkout_relay_refused', 'checkout_lock_invalid', 'checkout_price_missing',
  'checkout_token_unavailable', 'checkout_card_unavailable', 'checkout_setup_incomplete', 'checkout_setup_unrecognised',
  'checkout_setup_refused', 'checkout_confirm_refused', 'checkout_confirm_total_refused',
  'checkout_captcha_failed', 'checkout_form_error', 'checkout_pay_disabled', 'token_currency_unsupported',
  'token_request_unresolved', 'pay_step_unavailable',
];
for (const code of FAILED) {
  test(`FAILED ${code}: terminal not_submitted wording, no retry, never outcome_unknown`, () => {
    const view = project(unified('failed', { poll_after_seconds: null }, { last_error_code: code }));
    assert.equal(view.screen, 'failed');
    assert.equal(view.outcome.kind, 'not_submitted');
    assert.equal(view.outcome.outcome_unknown, false);
    assert.equal(view.outcome.retry_hint, false);
    assert.equal(isOutcomeUnknownCode(code), false);
  });
}

// The suffixed spellings the backend writes, exactly: they match on their head segment.
for (const spelled of ['checkout_card_unavailable:token_inactive', 'checkout_card_unavailable:no_method',
  'checkout_setup_refused:card:402', 'checkout_setup_refused:http_error:500', 'checkout_confirm_refused:http_error:400',
  'checkout_confirm_refused:http_error:422']) {
  test(`FAILED ${spelled}: matches on its head segment`, () => {
    const view = project(unified('failed', { poll_after_seconds: null }, { last_error_code: spelled }));
    assert.equal(view.outcome.kind, 'not_submitted');
    assert.equal(view.screen, 'failed');
  });
}

test('FAILED checkout_setup_unrecognised beats the hold-shaped name (explicit list over the shape)', () => {
  assert.equal(isOutcomeUnknownCode('checkout_setup_unrecognised'), false);
  assert.equal(project(unified('failed', {}, { last_error_code: 'checkout_setup_unrecognised' })).outcome.kind, 'not_submitted');
  // And the other direction: an explicit HELD code whose name has no hold shape still holds.
  assert.equal(isOutcomeUnknownCode('checkout_setup_submitted'), true);
  assert.equal(isOutcomeUnknownCode('checkout_confirm_text_only'), true);
});

test('HELD beats FAILED: refusal_reason a FAILED code, last_error_code a HELD code -> outcome_unknown', () => {
  const view = project(unified('failed', {}, { refusal_reason: 'checkout_relay_refused', last_error_code: 'checkout_confirm_unresolved' }));
  assert.equal(view.screen, 'outcome_unknown');
  assert.equal(view.outcome.kind, 'outcome_unknown');
  assert.equal(view.outcome.retry_hint, false);
  assert.match(view.outcome.message, /don't try again/);
  assert.equal(/no order was sent/.test(view.outcome.message), false);
});

test('HELD beats FAILED in either field and inside one compound code', () => {
  const swapped = project(unified('failed', {}, { refusal_reason: 'money_result_seen', last_error_code: 'checkout_setup_refused:card:402' }));
  assert.equal(swapped.screen, 'outcome_unknown');
  const compound = project(unified('failed', {}, { last_error_code: 'paid_sent:2:scheme:checkout_confirm_refused:vic_submit_unresolved' }));
  assert.equal(compound.screen, 'outcome_unknown');
  assert.equal(isOutcomeUnknownCode(['checkout_relay_refused', 'checkout_total_unverified']), true);
});

for (const code of ['checkout_currency_unsupported', 'checkout_ceiling_over_cap', 'checkout_ceiling_over_rail_limit']) {
  test(`REFUSED ${code}: plain refusal wording`, () => {
    const view = project(unified('refused', { poll_after_seconds: null }, { refusal_reason: code }));
    assert.equal(view.screen, 'refused');
    assert.equal(view.outcome.kind, 'checkout_refused');
    assert.equal(view.outcome.outcome_unknown, false);
    assert.equal(view.outcome.retry_hint, false);
  });
}

for (const code of ['checkout_step_disabled', 'checkout_schema_incomplete']) {
  test(`PARKED ${code}: not terminal, keeps polling, "Getting things ready…"`, () => {
    // In placing a confirm may already have gone out: the checking wording, never "Getting things ready…".
    const placing = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: code }));
    assert.equal(placing.screen, 'outcome_unknown');
    assert.equal(placing.outcome.kind, 'held');
    assert.equal(placing.terminal, false);
    for (const state of ['routing', 'locking']) {
      const view = project(unified(state, { poll_after_seconds: 15 }, { last_error_code: code }));
      assert.equal(view.screen, 'parked', state);
      assert.equal(view.terminal, false);
      assert.equal(view.poll_after_seconds, 15);
      assert.equal(view.outcome.kind, 'parked');
      assert.equal(view.outcome.title, 'Getting things ready…');
    }
    // A buyer step still on offer wins over the parked wording.
    const action = { kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-11-17T12:15:00Z' };
    assert.equal(project(unified('needs_payment_method', { next_action: action }, { last_error_code: code })).screen, 'add_card');
  });
}

// ---- review round 2 (2e3500a89): probes turned into tests -----------------------------------------------------

const APPROVAL = Object.freeze({ type: 'open_url', kind: 'approval', url: APPROVE_PAGE, expires_at: '2026-11-17T12:15:00Z' });

for (const code of ['vic_status_inconsistent', 'vic_order_mismatch', 'vic_order_stale', 'pending_write_unreconcilable']) {
  test(`HELD ${code} in awaiting_buyer_authorization: the checking screen and NO approve button`, () => {
    const view = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL, poll_after_seconds: 15 }, { last_error_code: code }));
    assert.equal(view.screen, 'outcome_unknown');
    assert.equal(view.action, null);
    assert.equal(view.terminal, false);
    assert.equal(view.outcome.kind, 'held');
  });
}

test('HELD in every state not yet final drops the buyer step (card binding, approval, bank check)', () => {
  const steps = {
    needs_payment_method: { kind: 'card_binding', url: CARD_PAGE, expires_at: '2026-11-17T12:15:00Z' },
    awaiting_buyer_authorization: APPROVAL,
    placing: { kind: 'authenticate', url: 'https://pay.partner.example/3ds', expires_at: '2026-11-17T12:15:00Z' },
  };
  for (const [state, step] of Object.entries(steps)) {
    const plain = project(unified(state, { next_action: step }));
    assert.ok(plain.action, `${state} without a hold offers its step`);
    const held = project(unified(state, { next_action: step }, { last_error_code: 'money_result_seen' }));
    assert.equal(held.action, null, state);
    assert.equal(held.screen, 'outcome_unknown', state);
  }
  for (const state of ['routing', 'locking', 'some_future_state']) {
    assert.equal(project(unified(state, {}, { last_error_code: 'checkout_unknown_timeout' })).screen, 'outcome_unknown', state);
  }
});

for (const code of ['binding_answer_unrecognised', 'approval_answer_unrecognised', 'token_answer_unrecognised',
  'token_mismatch', 'vic_quote_unrecognised', 'vic_quote_currency_mismatch', 'vic_order_unresolved']) {
  test(`FAILED ${code}: a pre-store terminal failure never says "may already be in progress"`, () => {
    for (const state of ['failed', 'refused', 'expired']) {
      const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: code }));
      assert.equal(view.outcome.kind, 'not_submitted', state);
      assert.equal(view.screen, state);
      assert.equal(/in progress|don't try again/.test(view.outcome.message), false);
    }
    assert.equal(isOutcomeUnknownCode(code), false);
  });
}

test('currency: a lower-case or non-ISO currency on either side is a disagreement (no amounts)', () => {
  for (const [a, b] of [['eur', 'USD'], ['USD', 'usd'], ['US$', 'USD'], ['USD', 42], ['EURO', null]]) {
    const view = project({ ...unified('awaiting_buyer_authorization', {}, { currency: b }), totals: { currency: a, quoted_total_minor: 2349, our_price_minor: 1800 } });
    assert.equal(view.currency, null, `${a}/${b}`);
    assert.equal(view.amounts.quoted_total_minor, null);
  }
  const ok = project({ ...unified('awaiting_buyer_authorization', {}, { currency: null }), totals: { currency: 'USD', quoted_total_minor: 2349 } });
  assert.equal(ok.currency, 'USD');
  assert.equal(ok.amounts.quoted_total_minor, 2349);
});

// The reviewer's precedence probe (mixed.cjs): refusal_reason + last_error_code, in four states.
const MIXED = [
  // name, refusal_reason, last_error_code, terminal outcome kind, placing outcome kind[, refused / expired kind]
  ['hold+fail', 'checkout_confirm_refused:http_error:422', 'checkout_unknown_timeout', 'outcome_unknown', 'held'],
  ['fail+hold reversed', 'checkout_unknown_timeout', 'checkout_lock_invalid', 'outcome_unknown', 'held'],
  ['suffixed hold in paid_sent', null, 'paid_sent:2:scheme:checkout_setup_unresolved', 'outcome_unknown', 'held'],
  ['suffixed fail', null, 'checkout_card_unavailable:network_token_missing', 'not_submitted', null],
  ['unknown+fail', 'zz_new_code', 'checkout_lock_invalid', 'not_submitted', null],
  ['named+hold', 'vic_quote_mismatch', 'outcome_unknown:http_error', 'outcome_unknown', 'held'],
  ['named+fail', 'price_changed', 'checkout_relay_refused', 'not_submitted', null],
  ['upper hold', null, 'CHECKOUT_UNKNOWN_TIMEOUT', 'outcome_unknown', 'held'],
  ['dash hold (not a code shape: unrecognised)', null, 'checkout-unknown-timeout', 'outcome_unknown', 'held', 'generic'],
  ['space-padded', null, ' checkout_setup_unresolved ', 'outcome_unknown', 'held'],
  ['named beats a shape-only segment', null, 'token_refused:money_result:', 'card_not_added', null],
  ['unknown only', null, 'zz_brand_new', 'outcome_unknown', 'held', 'generic'],
  ['unknown shapey', null, 'zz_new_unresolved_thing', 'outcome_unknown', 'held', 'generic'],
  ['fail beats shape', 'checkout_lock_invalid', 'zz_new_unresolved_thing', 'not_submitted', null],
  ['named beats shape', 'binding_refused', 'zz_new_unresolved_thing', 'card_not_added', null],
  ['code over 512 chars is unrecognised', null, `${'x'.repeat(520)}:checkout_unknown_timeout`, 'outcome_unknown', 'held', 'generic'],
  ['segment over 64 chars is unrecognised', null, `checkout_unknown_timeout_${'x'.repeat(60)}`, 'outcome_unknown', 'held', 'generic'],
  ['a list of codes is read', ['checkout_unknown_timeout'], 'checkout_lock_invalid', 'outcome_unknown', 'held'],
];
for (const [name, rr, le, terminalKind, placingKind, definiteKind = terminalKind] of MIXED) {
  test(`precedence probe: ${name}`, () => {
    for (const state of ['failed', 'refused', 'expired']) {
      const view = projectPurchaseView({ state, detail: { refusal_reason: rr, last_error_code: le } }, { purchaseId: AP, hostedHosts: [] });
      const expected = state === 'failed' ? terminalKind : definiteKind;
      if (expected === 'generic' && state !== 'failed') assert.deepEqual(view.outcome, STATE_COPY[state], state);
      else assert.equal(view.outcome.kind, expected === 'generic' ? state : expected, state);
      if (expected === 'outcome_unknown') assert.deepEqual(view.outcome, FINAL_CHECKING_COPY, state);
    }
    const placing = projectPurchaseView({ state: 'placing', detail: { refusal_reason: rr, last_error_code: le } }, { purchaseId: AP, hostedHosts: [] });
    assert.equal(placing.outcome ? placing.outcome.kind : null, placingKind);
  });
}

// ---- backend a2d16c353: the new and changed codes, one test each -----------------------------------------------

const HELD_COPY_RE = /We're checking with the store — don't try again/;

test('HELD checkout_confirm_pending_check (interrupted between paying and the confirm\'s answer): the checking screen', () => {
  const placing = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: 'checkout_confirm_pending_check' }));
  assert.equal(placing.screen, 'outcome_unknown');
  assert.equal(placing.terminal, false);
  assert.equal(placing.action, null);
  assert.match(placing.outcome.message, HELD_COPY_RE);
});

test('HELD checkout_confirm_not_sent (token exchange failed twice): still held, the normal checking copy', () => {
  const placing = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: 'checkout_confirm_not_sent' }));
  assert.equal(placing.screen, 'outcome_unknown');
  assert.equal(placing.outcome.kind, 'held');
  assert.match(placing.outcome.message, HELD_COPY_RE);
  assert.equal(/no order was sent/.test(placing.outcome.message), false);
  const failed = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'checkout_confirm_not_sent' }));
  assert.equal(failed.screen, 'outcome_unknown');
  assert.equal(failed.outcome.retry_hint, false);
});

test('checkout_confirm_not_verified (removed by the backend): not on the FAILED list; unrecognised, so the checking wording', () => {
  const view = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'checkout_confirm_not_verified' }));
  assert.equal(view.screen, 'outcome_unknown');
  assert.equal(view.outcome.retry_hint, false);
  assert.equal(/no order was sent|wasn't placed/i.test(view.outcome.message), false);
});

test('HELD checkout_paying_without_task: the checking screen while placing, outcome_unknown once final', () => {
  const placing = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: 'checkout_paying_without_task' }));
  assert.equal(placing.screen, 'outcome_unknown');
  assert.equal(placing.terminal, false);
  assert.equal(placing.action, null);
  assert.match(placing.outcome.message, HELD_COPY_RE);
  const failed = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'checkout_paying_without_task' }));
  assert.equal(failed.screen, 'outcome_unknown');
  assert.equal(failed.outcome.retry_hint, false);
});

test('removed checkout_confirm_window_passed: no longer a FAILED code; now unrecognised, so the checking wording', () => {
  const view = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'checkout_confirm_window_passed' }));
  assert.equal(view.outcome.kind, 'outcome_unknown');
  assert.equal(view.outcome.retry_hint, false);
  assert.equal(/no order was sent|wasn't placed/i.test(view.outcome.message), false);
});

test('HELD checkout_confirm_ambiguous_4xx now also for 401 and 429: held, whatever the suffix', () => {
  for (const spelled of ['checkout_confirm_ambiguous_4xx', 'checkout_confirm_ambiguous_4xx:http_error:401',
    'checkout_confirm_ambiguous_4xx:http_error:429', 'checkout_confirm_ambiguous_4xx:http_error:409']) {
    const view = project(unified('placing', {}, { last_error_code: spelled }));
    assert.equal(view.screen, 'outcome_unknown', spelled);
  }
});

test('HELD checkout_setup_unresolved in paying (a setup 403 / error card now writes it): the checking screen', () => {
  for (const spelled of ['checkout_setup_unresolved', 'checkout_setup_unresolved:http_error:403', 'checkout_setup_unresolved:error_card']) {
    const view = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: spelled }));
    assert.equal(view.screen, 'outcome_unknown', spelled);
    assert.equal(view.terminal, false);
    assert.match(view.outcome.message, HELD_COPY_RE);
  }
  // checkout_setup_refused:<kind>:<status> still exists and is still FAILED.
  assert.equal(project(unified('failed', {}, { last_error_code: 'checkout_setup_refused:http_error:400' })).outcome.kind, 'not_submitted');
});

test('parity with backend ec53ab7f6 (hold sets unchanged since be#2910 a7d9b523a): the explicit HELD list is exactly the 25 checkout holds, the 7 VIC holds, money_result_seen and the gateway extras', () => {
  const BACKEND_CHECKOUT_HOLD = ['checkout_answer_scrubbed', 'checkout_cancel_unresolved', 'checkout_confirm_ambiguous_4xx', 'checkout_confirm_conflict',
    'checkout_confirm_error_card', 'checkout_confirm_not_sent', 'checkout_confirm_pending_check', 'checkout_confirm_text_only',
    'checkout_confirm_unrecognised', 'checkout_confirm_unresolved', 'checkout_order_id_card_shaped', 'checkout_paying_without_task',
    'checkout_payment_no_order', 'checkout_payment_reached_declined', 'checkout_payment_reached_unconfirmed', 'checkout_result_overdue', 'checkout_result_unrecognised', 'checkout_setup_submitted',
    'checkout_setup_unresolved', 'checkout_task_invalid', 'checkout_task_mismatch', 'checkout_total_over_approved',
    'checkout_total_unverified', 'checkout_unknown_script_error', 'checkout_unknown_timeout'];
  const BACKEND_VIC_HOLD = ['vic_approved_amount_missing', 'vic_currency_mismatch', 'vic_currency_missing', 'vic_order_stale',
    'vic_submit_unresolved', 'vic_total_missing', 'vic_total_over_approved'];
  // Outcome-unknown codes the worker writes outside those two sets (kept explicit, so the shape never decides them).
  const GATEWAY_EXTRAS = ['money_result_seen', 'outcome_unknown', 'vic_order_outcome_unknown', 'pending_write_unreconcilable',
    'vic_status_inconsistent', 'vic_order_mismatch', 'checkout_outcome_unknown', 'charge_pending', 'money_result_parked', 'vic_held'];
  // The Reap rail's (pivota-backend services/reap_agentic_purchase.py; tests/agenpas_reap_consent.node.test.cjs).
  const REAP_HOLD = ['checkout_unresolvable', 'checkout_read_permanent', 'checkout_dispatch_unresolved', 'checkout_created_hosted_url_refused'];
  assert.equal(BACKEND_CHECKOUT_HOLD.length, 25);
  assert.equal(BACKEND_VIC_HOLD.length, 7);
  // Membership in the EXPLICIT list, not the outcome: the shape regex alone must not be able to satisfy this.
  assert.deepEqual([...HELD_CODES].sort(), [...BACKEND_CHECKOUT_HOLD, ...BACKEND_VIC_HOLD, ...GATEWAY_EXTRAS, ...REAP_HOLD].sort());
  for (const code of HELD_CODES) assert.equal(FAILED_CODES.has(code), false, `${code} is on both lists`);
  // And each is decisive against a FAILED code on the same purchase (precedence, not the shape).
  for (const code of [...BACKEND_CHECKOUT_HOLD, ...BACKEND_VIC_HOLD]) {
    const view = project(unified('failed', {}, { refusal_reason: 'checkout_relay_refused', last_error_code: code }));
    assert.equal(view.screen, 'outcome_unknown', code);
  }
});

// ---- review v3 (2a444e65d): read-retry codes before placing keep the buyer's step --------------------------------

for (const code of ['vic_status:unrecognised', 'paid_sent:2:await:await_answer_unrecognised']) {
  test(`retry ${code} in awaiting_buyer_authorization: Approve stays, the normal approval screen`, () => {
    const view = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL, poll_after_seconds: 15 }, { last_error_code: code }));
    assert.equal(view.screen, 'approve');
    assert.ok(view.action);
    assert.equal(view.action.kind, 'approval');
    assert.equal(view.outcome, null);
    // From placing on, the same shape is still treated as a hold.
    assert.equal(project(unified('placing', {}, { last_error_code: code })).screen, 'outcome_unknown');
  });
}

test('retry vic_quote:unrecognised:3 in locking: "Confirming your total", not the checking screen', () => {
  const view = project(unified('locking', { poll_after_seconds: 5 }, { last_error_code: 'vic_quote:unrecognised:3' }));
  assert.equal(view.screen, 'confirming_total');
  assert.equal(view.outcome, null);
  for (const state of ['routing', 'needs_payment_method', 'some_future_state']) {
    assert.notEqual(project(unified(state, {}, { last_error_code: 'vic_quote:unrecognised:3' })).screen, 'outcome_unknown', state);
  }
});

test('an explicit HELD code in awaiting_buyer_authorization still drops Approve (next to the retry codes)', () => {
  for (const code of ['vic_status_inconsistent', 'money_result_seen', 'outcome_unknown:http_error']) {
    const view = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL }, { last_error_code: code }));
    assert.equal(view.screen, 'outcome_unknown', code);
    assert.equal(view.action, null, code);
  }
  // A retry code beside an explicit hold: the hold wins.
  const both = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL },
    { refusal_reason: 'vic_status:unrecognised', last_error_code: 'vic_order_stale' }));
  assert.equal(both.action, null);
});

// ---- backend 354670505: the operator's terminal code -----------------------------------------------------------

test('FAILED operator_confirmed_not_charged: "you weren\'t charged" (a human checked the provider), start again from the chat', () => {
  const view = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'operator_confirmed_not_charged' }));
  assert.equal(view.screen, 'failed');
  assert.equal(view.outcome.kind, 'not_charged');
  assert.equal(view.outcome.outcome_unknown, false);
  assert.equal(view.outcome.retry_hint, true);
  assert.equal(view.outcome.message, "This purchase didn't go through and you weren't charged. You can start again from the chat.");
  assert.equal(isOutcomeUnknownCode('operator_confirmed_not_charged'), false);
});

test('operator_confirmed_not_charged: HELD still wins when a hold code is also on the purchase', () => {
  for (const [rr, le] of [['checkout_confirm_unresolved', 'operator_confirmed_not_charged'], ['operator_confirmed_not_charged', 'money_result_seen']]) {
    const view = project(unified('failed', {}, { refusal_reason: rr, last_error_code: le }));
    assert.equal(view.screen, 'outcome_unknown', `${rr} + ${le}`);
    assert.equal(/weren't charged/.test(view.outcome.message), false);
  }
});

test('"weren\'t charged" is said for the two operator codes (not_charged, declined) and NO other code', () => {
  const every = [...HELD_CODES, ...FAILED_CODES, 'vic_authorization_declined', 'binding_refused', 'price_changed',
    'checkout_currency_unsupported', 'merchant_not_purchasable', 'invalid_address', 'zz_unknown', 'checkout_step_disabled'];
  for (const code of every) {
    for (const state of ['failed', 'refused', 'expired', 'placing', 'awaiting_buyer_authorization']) {
      const view = project(unified(state, {}, { last_error_code: code }));
      const text = view.outcome ? `${view.outcome.title} ${view.outcome.message}` : '';
      const operator = code === 'operator_confirmed_not_charged' || code === 'operator_confirmed_declined';
      assert.equal(/charged/i.test(text), operator && state !== 'placing' && state !== 'awaiting_buyer_authorization', `${state} ${code}`);
    }
  }
});

test('parity: the explicit FAILED list is exactly the backend\'s nothing-submitted codes plus the two operator codes', () => {
  const EXPECTED_FAILED = ['checkout_contact_incomplete', 'checkout_relay_refused', 'checkout_lock_invalid', 'checkout_price_missing',
    'checkout_token_unavailable', 'checkout_card_unavailable', 'checkout_setup_incomplete', 'checkout_setup_unrecognised',
    'checkout_setup_refused', 'checkout_confirm_refused', 'checkout_confirm_total_refused', 'checkout_captcha_failed',
    'checkout_form_error', 'checkout_pay_disabled', 'token_currency_unsupported', 'token_request_unresolved', 'pay_step_unavailable',
    'binding_answer_unrecognised', 'approval_answer_unrecognised', 'token_answer_unrecognised', 'token_mismatch',
    'vic_quote_unrecognised', 'vic_quote_currency_mismatch', 'vic_order_unresolved', 'operator_confirmed_not_charged',
    'operator_confirmed_declined',
    // A2A pre-store failures listed in the fix round (pivota-backend a2a_rail_worker.py, all before any confirm).
    'binding_page_invalid', 'approval_page_invalid', 'vic_page_missing', 'vic_page_invalid', 'vic_amount_invalid',
    'vic_quote_invalid', 'vic_order_refused', 'vic_quote_refused', 'reconcile_exhausted',
    // The Reap rail's codes written before any checkout exists (tests/agenpas_reap_consent.node.test.cjs).
    'enrollment_no_hosted_action', 'enrollment_id_conflict', 'enrollment_row_unreadable', 'enrollment_not_activatable',
    'enrollment_dead', 'enrollment_create_failed', 'enrollment_read_failed', 'no_active_enrollment', 'enrollment_not_active',
    'quote_id_missing', 'quote_failed'];
  assert.deepEqual([...FAILED_CODES].sort(), [...EXPECTED_FAILED].sort());
});

test('operator_confirmed_not_charged beside a hold-SHAPED code (vic_status:unrecognised, either field): the checking wording, never "charged"', () => {
  for (const [rr, le] of [['vic_status:unrecognised', 'operator_confirmed_not_charged'], ['operator_confirmed_not_charged', 'vic_status:unrecognised'],
    [null, 'operator_confirmed_not_charged:zz_new_unresolved_thing']]) {
    const view = project(unified('failed', { poll_after_seconds: null }, { refusal_reason: rr, last_error_code: le }));
    assert.equal(view.screen, 'outcome_unknown', `${rr} + ${le}`);
    assert.equal(view.outcome.retry_hint, false);
    assert.equal(/charged/i.test(`${view.outcome.title} ${view.outcome.message}`), false);
  }
  // Alone (or beside a code with no hold shape), it says "you weren't charged".
  for (const [rr, le] of [[null, 'operator_confirmed_not_charged'], ['zz_plain_new_code', 'operator_confirmed_not_charged']]) {
    const view = project(unified('failed', { poll_after_seconds: null }, { refusal_reason: rr, last_error_code: le }));
    assert.equal(view.outcome.kind, 'not_charged', `${rr} + ${le}`);
    assert.match(view.outcome.message, /you weren't charged/);
  }
});

// ---- backend 732733b93 -----------------------------------------------------------------------------------------

test('HELD checkout_payment_reached_unconfirmed: the checking screen in placing, outcome_unknown once final, never "charged"', () => {
  const placing = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: 'checkout_payment_reached_unconfirmed' }));
  assert.equal(placing.screen, 'outcome_unknown');
  assert.equal(placing.terminal, false);
  assert.equal(placing.action, null);
  assert.match(placing.outcome.message, /We're checking with the store — don't try again/);
  for (const state of ['failed', 'refused', 'expired']) {
    const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: 'checkout_payment_reached_unconfirmed' }));
    assert.equal(view.screen, 'outcome_unknown', state);
    assert.equal(view.outcome.retry_hint, false);
    assert.equal(/charged/i.test(`${view.outcome.title} ${view.outcome.message}`), false);
  }
  // Beside operator_confirmed_not_charged (either field): HELD wins, the checking wording, never "charged".
  for (const [rr, le] of [['checkout_payment_reached_unconfirmed', 'operator_confirmed_not_charged'],
    ['operator_confirmed_not_charged', 'checkout_payment_reached_unconfirmed']]) {
    const view = project(unified('failed', {}, { refusal_reason: rr, last_error_code: le }));
    assert.equal(view.screen, 'outcome_unknown', `${rr} + ${le}`);
    assert.equal(/charged/i.test(`${view.outcome.title} ${view.outcome.message}`), false);
  }
});

// ---- unrecognised codes (controller P3, after gw#2599) ----------------------------------------------------------

const UNRECOGNISED = ['zz_brand_new_code', 'checkout_something_new', 'paid_sent:3:scheme:zz_new_step_code', 'not a code at all'];

for (const code of UNRECOGNISED) {
  test(`unrecognised ${JSON.stringify(code)}: placing -> the checking screen`, () => {
    const view = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: code }));
    assert.equal(view.screen, 'outcome_unknown');
    assert.equal(view.outcome.kind, 'held');
    assert.equal(view.terminal, false);
  });
  test(`unrecognised ${JSON.stringify(code)}: failed -> outcome_unknown (exact copy); refused / expired -> the state's own words`, () => {
    const failed = project(unified('failed', { poll_after_seconds: null }, { last_error_code: code }));
    assert.equal(failed.screen, 'outcome_unknown');
    assert.deepEqual(failed.outcome, FINAL_CHECKING_COPY);
    for (const state of ['refused', 'expired']) {
      const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: code }));
      assert.equal(view.screen, state, state);
      assert.deepEqual(view.outcome, STATE_COPY[state], state);
    }
  });
  test(`unrecognised ${JSON.stringify(code)}: awaiting_buyer_authorization -> Approve stays`, () => {
    const view = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL }, { last_error_code: code }));
    assert.equal(view.screen, 'approve');
    assert.ok(view.action);
    assert.equal(view.outcome, null);
  });
}

test('unrecognised codes never override an explicit list: FAILED, named and PARKED keep their wording', () => {
  assert.equal(project(unified('failed', {}, { refusal_reason: 'zz_new', last_error_code: 'checkout_relay_refused' })).outcome.kind, 'not_submitted');
  assert.equal(project(unified('failed', {}, { refusal_reason: 'zz_new', last_error_code: 'vic_authorization_declined' })).outcome.kind, 'declined');
  assert.equal(project(unified('locking', {}, { refusal_reason: 'zz_new', last_error_code: 'checkout_step_disabled' })).screen, 'parked');
  // No code at all: the generic wording (with expired keeping its hint).
  assert.equal(project(unified('expired', { poll_after_seconds: null })).outcome.kind, 'expired');
});

// ---- backend f59f4fe37: the withheld order number -------------------------------------------------------------

for (const code of ['checkout_order_reference_withheld', 'checkout_order_reference_invalid']) {
  test(`COMPLETED ${code}: placed, the verified total, the order number "in the store's confirmation email"`, () => {
    const withTotal = project(unified('completed', { poll_after_seconds: null, totals: { currency: 'USD', final_total_minor: 2297 } },
      { last_error_code: code, merchant_order_id: null }));
    assert.equal(withTotal.screen, 'done');
    assert.equal(withTotal.terminal, true);
    assert.equal(withTotal.outcome, null);
    assert.equal(withTotal.order.reference, null);
    assert.equal(withTotal.order.reference_withheld, true);
    assert.equal(withTotal.amounts.final_total_minor, 2297);
    // Without a total: still placed, still the email line; no amount is made up.
    const noTotal = project(unified('completed', { poll_after_seconds: null, totals: { currency: 'USD' } }, { last_error_code: code }));
    assert.equal(noTotal.screen, 'done');
    assert.equal(noTotal.order.reference_withheld, true);
    assert.equal(noTotal.amounts.final_total_minor, null);
    // Not a hold, not a failure: never the checking wording, in any state.
    assert.equal(isOutcomeUnknownCode(code), false);
    assert.equal(FAILED_CODES.has(code), false);
    assert.equal(HELD_CODES.has(code), false);
    assert.equal(project(unified('placing', {}, { last_error_code: code })).screen, 'placing');
  });
}

test('a completed order WITH its number: no withheld flag, whatever the code', () => {
  const view = project(unified('completed', { order_reference: '#1001', poll_after_seconds: null }, { last_error_code: 'checkout_order_reference_withheld' }));
  assert.equal(view.order.reference, '#1001');
  assert.equal(Object.hasOwn(view.order, 'reference_withheld'), false);
  assert.equal(Object.hasOwn(project(unified('completed', { order_reference: '#1001' })).order, 'reference_withheld'), false);
});

// ---- backend 4dc09ce55 (DAVV) ----------------------------------------------------------------------------------

test('HELD checkout_answer_scrubbed (after the confirm, a card code was echoed): checking while placing, outcome_unknown once final, never "charged"', () => {
  const placing = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: 'checkout_answer_scrubbed' }));
  assert.equal(placing.screen, 'outcome_unknown');
  assert.equal(placing.terminal, false);
  for (const state of ['failed', 'refused', 'expired']) {
    const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: 'checkout_answer_scrubbed' }));
    assert.equal(view.screen, 'outcome_unknown', state);
    assert.equal(view.outcome.retry_hint, false);
    assert.equal(/charged/i.test(view.outcome.message), false);
  }
  // Beside the operator code, HELD wins.
  assert.equal(project(unified('failed', {}, { refusal_reason: 'checkout_answer_scrubbed', last_error_code: 'operator_confirmed_not_charged' })).screen, 'outcome_unknown');
});

test('FAILED checkout_card_unavailable:davv_missing: not_submitted on its head segment, no retry', () => {
  const view = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'checkout_card_unavailable:davv_missing' }));
  assert.equal(view.screen, 'failed');
  assert.equal(view.outcome.kind, 'not_submitted');
  assert.equal(view.outcome.retry_hint, false);
  assert.equal(isOutcomeUnknownCode('checkout_card_unavailable:davv_missing'), false);
});

test('checkout_placing (also written after a lookup finds the checkout in progress): the normal placing screen', () => {
  const view = project(unified('placing', { poll_after_seconds: 5 }, { last_error_code: 'checkout_placing' }));
  assert.equal(view.screen, 'placing');
  assert.equal(view.outcome, null);
  assert.equal(view.terminal, false);
  assert.equal(isOutcomeUnknownCode('checkout_placing'), false);
  // And it never hides a buyer step before placing.
  const approve = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL }, { last_error_code: 'checkout_placing' }));
  assert.equal(approve.screen, 'approve');
});

// ---- progress codes vs anomalies (decision after 34e647cce) -----------------------------------------------------

for (const code of ['checkout_placing', 'checkout_ready', 'checkout_read', 'await_read', 'reconciled']) {
  test(`PROGRESS ${code}: the normal placing screen; Approve stays before placing; a HELD code beside it still wins`, () => {
    const placing = project(unified('placing', { poll_after_seconds: 5 }, { last_error_code: code }));
    assert.equal(placing.screen, 'placing');
    assert.equal(placing.outcome, null);
    const approve = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL }, { last_error_code: code }));
    assert.equal(approve.screen, 'approve');
    assert.ok(approve.action);
    for (const [rr, le] of [[code, 'checkout_confirm_unresolved'], ['money_result_seen', code]]) {
      const held = project(unified('placing', {}, { refusal_reason: rr, last_error_code: le }));
      assert.equal(held.screen, 'outcome_unknown', `${rr} + ${le}`);
      assert.equal(held.outcome.kind, 'held');
    }
  });
}

for (const code of ['transition_refused', 'rail_refused', 'no_step_for_state', 'vic_order_step_disabled', 'checkout_answer_unrecognised']) {
  test(`ANOMALY ${code}: the checking wording from placing on; nothing changes before placing`, () => {
    const placing = project(unified('placing', { poll_after_seconds: 5 }, { last_error_code: code }));
    assert.equal(placing.screen, 'outcome_unknown');
    assert.equal(placing.outcome.kind, 'held');
    const failed = project(unified('failed', { poll_after_seconds: null }, { last_error_code: code }));
    assert.equal(failed.screen, 'outcome_unknown');
    assert.equal(failed.outcome.retry_hint, false);
    const approve = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL }, { last_error_code: code }));
    assert.equal(approve.screen, 'approve');
    assert.ok(approve.action);
  });
}

test('parity with backend ec53ab7f6: the 7 _CHECKOUT_PAYMENT_REACHED_CODES are all HELD and never read as "not charged" or "declined"', () => {
  const PAYMENT_REACHED = ['checkout_answer_scrubbed', 'checkout_order_id_card_shaped', 'checkout_payment_no_order',
    'checkout_payment_reached_declined', 'checkout_payment_reached_unconfirmed', 'checkout_total_over_approved',
    'checkout_total_unverified'];
  assert.equal(PAYMENT_REACHED.length, 7);
  for (const code of PAYMENT_REACHED) {
    assert.equal(HELD_CODES.has(code), true, code);
    for (const [rr, le] of [[code, 'operator_confirmed_not_charged'], ['operator_confirmed_not_charged', code],
      [code, 'operator_confirmed_declined'], ['operator_confirmed_declined', code]]) {
      const view = project(unified('failed', {}, { refusal_reason: rr, last_error_code: le }));
      assert.equal(view.screen, 'outcome_unknown', `${rr} + ${le}`);
      assert.equal(/charged/i.test(`${view.outcome.title} ${view.outcome.message}`), false);
    }
  }
});

// ---- backend be#2910 (a7d9b523a): the measured decline hold and the operator's close-declined ----------------------

const DECLINED_MESSAGE = "The payment was declined, so the order wasn't placed and you weren't charged. You can start again from the chat.";

test('HELD checkout_payment_reached_declined: the checking screen in placing, outcome_unknown once final, never "charged" or "declined"', () => {
  const placing = project(unified('placing', { poll_after_seconds: 15 }, { last_error_code: 'checkout_payment_reached_declined' }));
  assert.equal(placing.screen, 'outcome_unknown');
  assert.equal(placing.terminal, false);
  assert.equal(placing.action, null);
  assert.equal(placing.outcome.kind, 'held');
  assert.match(placing.outcome.message, /We're checking with the store — don't try again/);
  assert.equal(isOutcomeUnknownCode('checkout_payment_reached_declined'), true);
  // An explicit hold: before placing too, it drops the buyer's step.
  const approve = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL }, { last_error_code: 'checkout_payment_reached_declined' }));
  assert.equal(approve.screen, 'outcome_unknown');
  assert.equal(approve.action, null);
  for (const state of ['failed', 'refused', 'expired']) {
    const view = project(unified(state, { poll_after_seconds: null }, { last_error_code: 'checkout_payment_reached_declined' }));
    assert.equal(view.screen, 'outcome_unknown', state);
    assert.equal(view.outcome.retry_hint, false);
    assert.equal(/charged|declined/i.test(`${view.outcome.title} ${view.outcome.message}`), false, state);
  }
});

test('FAILED operator_confirmed_declined: "your payment was declined … you weren\'t charged", start again from the chat, polling stops', () => {
  const view = project(unified('failed', { poll_after_seconds: null }, { last_error_code: 'operator_confirmed_declined' }));
  assert.equal(view.screen, 'failed');
  assert.equal(view.terminal, true);
  assert.equal(view.action, null);
  assert.deepEqual(view.outcome, {
    kind: 'payment_declined', title: 'Your payment was declined', message: DECLINED_MESSAGE, retry_hint: true, outcome_unknown: false,
  });
  assert.equal(isOutcomeUnknownCode('operator_confirmed_declined'), false);
  // In either field.
  assert.equal(project(unified('failed', {}, { refusal_reason: 'operator_confirmed_declined' })).outcome.kind, 'payment_declined');
});

test('operator_confirmed_declined: HELD wins beside any hold code; a hold-SHAPED code gives the checking wording; never "declined" then', () => {
  for (const other of ['checkout_payment_reached_declined', 'checkout_payment_reached_unconfirmed', 'checkout_confirm_unresolved',
    'money_result_seen', 'vic_status:unrecognised', 'zz_new_unresolved_thing']) {
    for (const [rr, le] of [[other, 'operator_confirmed_declined'], ['operator_confirmed_declined', other]]) {
      const view = project(unified('failed', { poll_after_seconds: null }, { refusal_reason: rr, last_error_code: le }));
      assert.equal(view.screen, 'outcome_unknown', `${rr} + ${le}`);
      assert.equal(view.outcome.retry_hint, false);
      assert.equal(/charged|declined/i.test(`${view.outcome.title} ${view.outcome.message}`), false, `${rr} + ${le}`);
    }
  }
  // Beside a code with no hold shape: still the declined wording.
  const plain = project(unified('failed', {}, { refusal_reason: 'zz_plain_new_code', last_error_code: 'operator_confirmed_declined' }));
  assert.equal(plain.outcome.kind, 'payment_declined');
  // Beside the other operator code: the declined wording (both say not charged; the decline is the more specific).
  const both = project(unified('failed', {}, { refusal_reason: 'operator_confirmed_not_charged', last_error_code: 'operator_confirmed_declined' }));
  assert.equal(both.outcome.kind, 'payment_declined');
});

// ---- the card the purchase pays with (backend AGENPAS_PAYMENT_CARD_ENABLED) ----------------------------------------

const APPROVAL_ACTION = { type: 'open_url', kind: 'approval', url: APPROVE_PAGE, expires_at: '2026-11-17T12:10:00Z' };

test('card: shown as a fixed label and four digits on the approval screen and on "order placed" only', () => {
  const card = { network: 'VISA', last4: '4242' };
  const approve = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL_ACTION, payment_card: card }));
  assert.equal(approve.screen, 'approve');
  assert.deepEqual(approve.payment_card, { label: 'Visa', last4: '4242' });
  const done = project(unified('completed', { payment_card: card, order_reference: 'ORD-1' }));
  assert.equal(done.screen, 'done');
  assert.deepEqual(done.payment_card, { label: 'Visa', last4: '4242' });
});

test('card: never on any other screen, whatever the body says', () => {
  const card = { network: 'VISA', last4: '4242' };
  for (const state of ['routing', 'needs_payment_method', 'locking', 'placing', 'failed', 'refused', 'expired', 'unknown_state']) {
    const view = project(unified(state, { payment_card: card }));
    assert.equal('payment_card' in view, false, state);
  }
  // A held approval (the checking screen) names no card either.
  const held = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL_ACTION, payment_card: card },
    { last_error_code: 'checkout_unresolvable:3:checkout_read' }));
  assert.notEqual(held.screen, 'approve');
  assert.equal('payment_card' in held, false);
});

test('card: only from the top level, never from detail', () => {
  const view = project(unified('awaiting_buyer_authorization', { next_action: APPROVAL_ACTION },
    { payment_card: { network: 'VISA', last4: '4242' } }));
  assert.equal(view.screen, 'approve');
  assert.equal('payment_card' in view, false);
});

test('card: the network is a label from the fixed list (unknown: "Card"); no member without exactly four digits', () => {
  const at = (card) => project(unified('awaiting_buyer_authorization', { next_action: APPROVAL_ACTION, payment_card: card })).payment_card;
  assert.deepEqual(at({ network: 'MASTERCARD', last4: '5454' }), { label: 'Mastercard', last4: '5454' });
  assert.deepEqual(at({ network: 'American Express', last4: '0005' }), { label: 'American Express', last4: '0005' });
  assert.deepEqual(at({ network: 'union_pay', last4: '1234' }), { label: 'UnionPay', last4: '1234' });
  assert.deepEqual(at({ network: null, last4: '1234' }), { label: 'Card', last4: '1234' });
  assert.deepEqual(at({ network: '<b>Evil Bank</b>', last4: '1234' }), { label: 'Card', last4: '1234' });
  assert.deepEqual(at({ network: 'constructor', last4: '1234' }), { label: 'Card', last4: '1234' });
  for (const bad of [{ network: 'VISA' }, { network: 'VISA', last4: '424' }, { network: 'VISA', last4: '42424' },
    { network: 'VISA', last4: 4242 }, { network: 'VISA', last4: '42a2' }, { network: 'VISA', last4: '4242\n' }, 'VISA 4242', ['4242'], null]) {
    assert.equal(at(bad), undefined, JSON.stringify(bad));
  }
});
