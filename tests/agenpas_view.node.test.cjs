'use strict';

// AgenPas page projection (src/agenpas/view.js) and the gateway-side hosted URL allowlist (src/agenpas/hostedUrl.js).
// Bodies follow the backend's unified purchase read (pivota-backend docs/agent_purchases_routes.md). Placeholder
// merchants and products only. No network.

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectPurchaseView, screenFor, outcomeFor, isOutcomeUnknownCode, codeSegments, KNOWN_STATES } = require('../src/agenpas/view');
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
  const badCurrency = project({ ...unified('routing'), totals: { currency: 'usd<', our_price_minor: -5 } });
  assert.equal(badCurrency.currency, 'USD'); // falls back to detail.currency
  assert.equal(badCurrency.amounts.unit_price_minor, null);
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

test('outcome-unknown codes say "checking with the store — don\'t try again" and never offer a retry', () => {
  for (const code of ['vic_order_outcome_unknown', 'outcome_unknown', 'vic_submit_unresolved', 'pending_write_unreconcilable', 'some_new_outcome_unknown_code']) {
    assert.equal(isOutcomeUnknownCode(code), true, code);
    for (const state of ['failed', 'refused', 'expired']) {
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

test('an unknown code (or junk) gets the state\'s generic wording without a retry for failed/refused', () => {
  const failed = outcomeFor('failed', ['brand_new_code', '<b>Traceback</b>']);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.retry_hint, false);
  assert.equal(failed.outcome_unknown, false);
  assert.equal(outcomeFor('refused', []).kind, 'refused');
  assert.equal(outcomeFor('expired', [null]).kind, 'expired');
  assert.equal(outcomeFor('completed', ['vic_order_outcome_unknown']), null);
  assert.equal(outcomeFor('placing', []), null);
  assert.equal(outcomeFor('locking', ['vic_order_outcome_unknown']), null);
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
  assert.equal(project(unified('failed', {}, { last_error_code: 'paid_sent:1:v:some_new_code' })).outcome.kind, 'failed');
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
  const view = project(unified('failed', {}, { last_error_code: 'a_code_nobody_has_seen' }));
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
  'checkout_unknown_timeout', 'checkout_unknown_script_error', 'checkout_cancel_unresolved', 'money_result_seen',
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
  'checkout_setup_refused', 'checkout_confirm_refused', 'checkout_confirm_total_refused', 'checkout_confirm_window_passed',
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
    for (const state of ['routing', 'locking', 'placing']) {
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
