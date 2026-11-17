'use strict';

// CHECKOUT ANSWERS THAT SAY WHAT HAPPENED, THROUGH THE REAL TOOL DOORS (`/mcp` complete_checkout_session and
// create_payment_link, `/ucp/mcp` complete_checkout), over HTTP, with the gateway's own transport making what it makes
// of each backend answer:
//
//   - the order exists and its payment page call gets no readable answer (no answer, a 5xx, a page from in front of
//     the backend, a 2xx with nothing in it): CHECKOUT_OUTCOME_UNKNOWN, not retriable, with the order id; the same key
//     is told the same; another key is told QUOTE_ALREADY_USED with that order id; the session reads `completed`;
//   - the order call is answered with something that is not an order: CHECKOUT_OUTCOME_UNKNOWN, no order id known;
//   - no address to ship to: refused by name before any order (the dialect's own update tool named);
//   - the backend refuses the buyer context from its prologue: named and terminal, and the corrected retry orders;
//   - cancel by session id (the upstream cancel off): canceled only when true.
// In every market this path can price (US, SG, GB, DE, none) and one it cannot (ZZ), no new answer states money, and
// no answer asks the backend for a second order or a second payment page.
// See tests/_support/quoteClaimReleaseDoor.cjs for what is real and what is stubbed. Every name is a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./_support/quoteClaimReleaseDoor.cjs');
const { curatedUpstreamRefusal, mapUpstreamErrorToKernelCode } = require('../src/services/commerceKernelErrorMapping');

const { IDS, ANSWERS } = fx;
const CALLERS = ['mcp_complete', 'mcp_payment_link', 'ucp_complete'];
const PRICED_MARKETS = ['US', 'SG', 'GB', 'DE'];
let door;
let keys;
let KERNEL_ANSWERED_REFUSALS;

test.before(async () => {
  ({ KERNEL_ANSWERED_REFUSALS } = await import('../safety-kernel/src/errors.js'));
  keys = await fx.mintKeys();
  door = fx.bootDoor({ port: 5651, keys, env: { AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1' } });
  await door.listen();
});
test.after(async () => { if (door) await door.close(); });

let seq = 0;
const freshKey = () => { seq += 1; return `idem-honest-${String(seq).padStart(5, '0')}`; };
const buyerFor = (n) => ({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': `sess-h-${String(n).padStart(5, '0')}` });
const UCP_AGENT = Object.freeze({ 'ucp-agent': { profile: 'https://agent.example/profile' } });
const ucpMeta = (key) => ({ ...UCP_AGENT, ...(key ? { 'idempotency-key': key } : {}) });
const destination = (m) => ({ methods: [{ destinations: [{ first_name: 'Buyer', last_name: 'One', street_address: '1 Example Road', address_locality: 'Exampleton', postal_code: '00001', address_country: m }] }] });
const nativeQuote = (market) => ({ merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], customer_email: 'buyer@example.test', ...(market ? { shipping_address: fx.address(market) } : {}) });
const ucpCheckout = (market) => ({ line_items: [{ item: { id: IDS.PRODUCT }, quantity: 1 }], buyer: { email: 'buyer@example.test' }, ...(market ? { fulfillment: destination(market) } : {}) });
const ucp = (h) => h.caller === 'ucp_complete';

/** A priced session through the caller's own door; `market` null = no address anywhere. */
async function open(caller, market) {
  seq += 1;
  const buyer = buyerFor(seq);
  const r = caller === 'ucp_complete'
    ? await door.call('create_checkout', { meta: ucpMeta(freshKey()), checkout: ucpCheckout(market) }, { buyer, door: '/ucp/mcp' })
    : await door.call('create_checkout_session', { idempotency_key: freshKey(), quote: nativeQuote(market) }, { buyer });
  return { caller, market, buyer, r, id: r.value && (r.value.session_id || r.value.id), currency: r.value && r.value.currency };
}
// One grant per session: a retry with the same key must be the same request (a fresh grant is another body).
async function grantFor(h) {
  if (!h.grant) h.grant = await keys.mintGrant({ sessionId: h.id, currency: h.currency, maxAmount: fx.UNIT_MINOR });
  return h.grant;
}
async function attempt(h, key, extra = {}) {
  const token = await grantFor(h);
  if (ucp(h)) return door.call('complete_checkout', { meta: ucpMeta(key), id: h.id, checkout: { payment: { method: 'ucp_handler', token } } }, { buyer: h.buyer, door: '/ucp/mcp' });
  if (h.caller === 'mcp_complete') return door.call('complete_checkout_session', { idempotency_key: key, session_id: h.id, payment_authorization: { method: 'acp_delegated_token', token }, ...extra }, { buyer: h.buyer });
  return door.call('create_payment_link', { idempotency_key: key, session_id: h.id, customer_email: 'buyer@example.test', ...extra }, { buyer: h.buyer });
}
const read = (h) => (ucp(h)
  ? door.call('get_checkout', { meta: ucpMeta(), id: h.id }, { buyer: h.buyer, door: '/ucp/mcp' })
  : door.call('get_checkout_session', { session_id: h.id }, { buyer: h.buyer }));
const sent = (r, path) => r.upstream.filter((c) => c.path === path).length;
const ORDERS = '/agent/v2/orders';
const PAGES = '/agent/v2/payments/checkout-sessions';
const errorOf = (r) => (r.value && r.value.error) || {};
const currencyOf = (r) => r.value && r.value.currency;
const orderIdOf = (h, r) => (h.caller === 'mcp_payment_link' ? r.value.order_id : (r.value.order && r.value.order.order_id) || r.value.order_id || (r.value.order && r.value.order.id));
/** No answer below states money: no amount, no currency code. */
function assertNoMoney(r, label) {
  assert.equal(/"(?:amount|amount_total|total|currency)"|USD|SGD|GBP|EUR/.test(JSON.stringify(errorOf(r))), false, `${label}: ${r.raw.slice(0, 300)}`);
}
const UNKNOWN_WORDS = {
  payment_outcome_unknown_after_order: /whether its payment step went through is unknown/,
  payment_link_outcome_unknown_after_order: /whether its payment page was opened is unknown/,
  order_create_outcome_unknown: /its id is not known/,
};
// `answered`: the order call was refused by the store at a status with words of its own (a 403, a 429).
function assertUnknown(r, reason, orderId, label, { answered } = {}) {
  const e = errorOf(r);
  assert.equal(r.isError, true, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(Object.keys(e), ['code', 'message', 'retriable', 'recovery', 'detail'], label);
  assert.equal(e.code, 'CHECKOUT_OUTCOME_UNKNOWN', label);
  assert.equal(e.retriable, false, label);
  assert.deepEqual(e.detail, { reason, order_id: orderId }, label);
  if (answered) {
    const words = KERNEL_ANSWERED_REFUSALS[answered];
    assert.deepEqual([e.message, e.recovery], [`${words.message} Sending this call again with the same idempotency_key returns this same answer.`, words.recovery], label);
    assert.equal(/no readable answer|may have been accepted|nothing was ordered/i.test(r.raw), false, `${label}: ${r.raw.slice(0, 300)}`);
    assertNoMoney(r, label);
    return;
  }
  assert.match(e.message, UNKNOWN_WORDS[reason], label);
  assert.match(e.message, orderId ? /do not start another checkout/i : /Do not place a new order for this purchase without the buyer/, label);
  if (orderId) assert.match(e.recovery, /get_order/, label);
  assertNoMoney(r, label);
}
function assertSpentNamingOrder(r, orderId, label) {
  const e = errorOf(r);
  assert.equal(e.code, 'QUOTE_ALREADY_USED', `${label}: ${r.raw.slice(0, 300)}`);
  if (orderId) {
    assert.deepEqual(e.detail, { reason: 'session_already_ordered', order_id: orderId }, label);
    assert.match(e.recovery, /detail\.order_id with get_order/, label);
  } else {
    // No order is known: none is named, and the words say whether one was placed is not known (never "read that order").
    assert.deepEqual(e.detail, { reason: 'checkout_session_order_outcome_unknown' }, `${label}: no order is known, none is named`);
    assert.match(e.message, /^An order was asked for on this checkout session, and whether it was placed is not known/, label);
    assert.equal(/get_order|already used to place an order/.test(e.message + e.recovery), false, label);
    assert.match(e.recovery, /an order may exist/, label);
  }
  assertNoMoney(r, label);
}
const each = (fn) => async () => { for (const caller of CALLERS) await fn(caller); };
/** A session whose order call's outcome is unknown: `order_outcome_unknown` on /mcp; UCP's `complete_in_progress` plus `order_outcome: 'unknown'`. */
function assertUnknownStatus(h, got, label) {
  assert.equal(got.isError, false, `${label}: ${got.raw.slice(0, 300)}`);
  if (ucp(h)) assert.deepEqual([got.value.status, got.value.order_outcome, got.value.order_id], ['complete_in_progress', 'unknown', null], label);
  else assert.deepEqual([got.value.status, got.value.order_id, 'order_outcome' in got.value], ['order_outcome_unknown', null, false], label);
}

// ---- A: the payment page call after the order exists -----------------------------------------------------------------

const PAGE_FAILURES = {
  timeout: () => ANSWERS.timeout(),
  connection_lost: () => ANSWERS.connectionLost(),
  page_502: () => ANSWERS.badGateway(),
  page_504: () => ANSWERS.gatewayTimeout(),
  busy_503: () => ANSWERS.busy(),
  internal_500: () => ANSWERS.internalError(),
  empty_200: () => ANSWERS.raw(200, ''),
  unparseable_200: () => ANSWERS.raw(200, '<html>ok</html>'),
  empty_object_200: () => ANSWERS.raw(200, {}),
};

test('A: an unreadable payment page answer after the order exists is an unknown outcome with the order id, on every tool door, in every priced market; nothing is asked twice', each(async (caller) => {
  for (const [shape, answer] of Object.entries(PAGE_FAILURES)) {
    for (const market of PRICED_MARKETS) {
      const label = `${caller} ${shape} ${market}`;
      const h = await open(caller, market);
      assert.equal(h.r.isError, false, `${label}: ${h.r.raw.slice(0, 300)}`);
      door.paymentScript.push(answer());
      const key = freshKey();
      const first = await attempt(h, key);
      const reason = caller === 'mcp_payment_link' ? 'payment_link_outcome_unknown_after_order' : 'payment_outcome_unknown_after_order';
      const orderId = door.orders.at(-1).order_id;
      assertUnknown(first, reason, orderId, label);
      assert.deepEqual([sent(first, ORDERS), sent(first, PAGES)], [1, 1], label);
      const same = await attempt(h, key);
      assertUnknown(same, reason, orderId, `${label} same key`);
      assert.deepEqual(same.upstream, [], `${label} same key: nothing sent`);
      const other = await attempt(h, freshKey());
      assertSpentNamingOrder(other, orderId, `${label} another key`);
      assert.deepEqual(other.upstream.filter((c) => c.path === ORDERS || c.path === PAGES), [], `${label} another key: nothing sent`);
      const got = await read(h);
      assert.equal(got.isError, false, label);
      assert.deepEqual([got.value.status, got.value.order_id], ['completed', orderId], `${label}: the session reads as the order it became`);
      if (!ucp(h)) {
        const cancel = await door.call('cancel_checkout_session', { idempotency_key: freshKey(), session_id: h.id }, { buyer: h.buyer });
        assert.deepEqual(errorOf(cancel).detail, { reason: 'session_already_ordered', canceled: false, order_id: orderId }, label);
        // With the upstream cancel off nothing reaches the store: never "cancel it by the order_id" (that would only mark
        // this gateway's row and leave the payment page payable); read the order, and say who can cancel it.
        assert.match(errorOf(cancel).recovery, /get_order \(detail\.order_id\)/, label);
        assert.match(errorOf(cancel).recovery, /cannot cancel it at the store/, label);
        assert.equal(/cancel it by/i.test(errorOf(cancel).recovery + errorOf(cancel).message), false, label);
      }
    }
  }
}));

test('A: a refusal the backend answered by name for the payment page (409 ORDER_CANCELED) is answered as before', each(async (caller) => {
  if (caller === 'mcp_payment_link') return; // the payment link reads its page through the same lane; covered at the kernel
  const h = await open(caller, 'SG');
  door.paymentScript.push(ANSWERS.raw(409, { status: 'error', error: { code: 'CONFLICT', message: 'ORDER_CANCELED', details: { error: 'ORDER_CANCELED' } }, detail: { error: 'ORDER_CANCELED' } }));
  const first = await attempt(h, freshKey());
  assert.equal(errorOf(first).code, 'ORDER_CANCELED', first.raw.slice(0, 300));
  assert.equal(errorOf(first).retriable, false);
}));

test('Q1: an order call with no readable answer (no answer, a lost connection, a 5xx, a page from in front of the backend) is an unknown outcome with no order id; nothing is asked twice', each(async (caller) => {
  const SHAPES = { timeout: () => ANSWERS.timeout(), timeout_landed: () => ANSWERS.timeout({ landed: true }), connection_lost: () => ANSWERS.connectionLost(), connection_refused: () => ANSWERS.connectionRefused(), page_502: () => ANSWERS.badGateway(), page_504: () => ANSWERS.gatewayTimeout(), busy_503: () => ANSWERS.busy(), internal_500: () => ANSWERS.internalError() };
  for (const [shape, answer] of Object.entries(SHAPES)) {
    for (const market of PRICED_MARKETS) {
      const label = `${caller} ${shape} ${market}`;
      const h = await open(caller, market);
      door.orderScript.push(answer());
      const key = freshKey();
      const first = await attempt(h, key);
      assertUnknown(first, 'order_create_outcome_unknown', null, label);
      assert.match(errorOf(first).recovery, /store may hold an order/, label);
      assert.equal(/get_order/.test(errorOf(first).recovery), false, `${label}: no id, no get_order`);
      assert.deepEqual([sent(first, ORDERS), sent(first, PAGES)], [1, 0], label);
      const same = await attempt(h, key);
      assertUnknown(same, 'order_create_outcome_unknown', null, `${label} same key`);
      assert.deepEqual(same.upstream, [], `${label} same key: nothing sent`);
      const other = await attempt(h, freshKey());
      assertSpentNamingOrder(other, null, `${label} another key`);
      assert.equal(sent(other, ORDERS), 0, label);
      const got = await read(h);
      assertUnknownStatus(h, got, label);
      if (!ucp(h)) {
        const cancel = await door.call('cancel_checkout_session', { idempotency_key: freshKey(), session_id: h.id }, { buyer: h.buyer });
        assert.equal(errorOf(cancel).detail?.reason, 'session_order_outcome_unknown', label);
      }
    }
  }
}));

test('Q1: an order call the backend refused below 500 in a way that keeps the claim (a consumed quote, its out-of-stock 400, a 403, a 429) is an unknown outcome, never retriable; a terminal name (an expired quote) is answered as before', each(async (caller) => {
  // A 403 the backend did not name as terminal, and every 429, say what the store answered; the others keep their words.
  for (const [answer, answered] of [[ANSWERS.quoteConsumed, 'refused'], [ANSWERS.insufficientInventory, 'refused'], [ANSWERS.validationFailed, 'refused'],
    [ANSWERS.checkoutQuoteRequired, 'refused'], [() => ANSWERS.raw(401, { status: 'error', error: { code: 'UNAUTHORIZED', message: 'UNAUTHORIZED', details: {} }, detail: {} }), 'refused'],
    [() => ANSWERS.raw(409, { status: 'error', error: { code: 'CONFLICT', message: 'CONFLICT', details: {} }, detail: {} }), 'refused'],
    [() => ANSWERS.raw(408, { status: 'error', error: { code: 'REQUEST_TIMEOUT', message: 'REQUEST_TIMEOUT', details: {} }, detail: {} })],
    [ANSWERS.notAuthorized, 'refused'], [() => ANSWERS.raw(403, { status: 'error', error: { code: 'FORBIDDEN', message: 'FORBIDDEN', details: {} }, detail: {} }), 'refused'],
    [() => ANSWERS.raw(429, { status: 'error', error: { code: 'RATE_LIMIT_EXCEEDED', message: 'RATE_LIMIT_EXCEEDED', details: { error: 'RATE_LIMIT_EXCEEDED' } }, detail: { error: 'RATE_LIMIT_EXCEEDED' } }), 'rate_limited'],
    [ANSWERS.rateLimited, 'rate_limited'], [ANSWERS.rateLimitedCoded, 'rate_limited'], [() => ANSWERS.rateLimited({ landed: true }), 'rate_limited']]) {
    for (const market of PRICED_MARKETS) {
      const h = await open(caller, market);
      door.orderScript.push(answer());
      const key = freshKey();
      const first = await attempt(h, key);
      const label = `${caller} ${market} ${first.raw.slice(0, 200)}`;
      assertUnknown(first, 'order_create_outcome_unknown', null, label, { answered });
      const same = await attempt(h, key);
      assertUnknown(same, 'order_create_outcome_unknown', null, `${label} same key`, { answered });
      assert.equal(same.raw, first.raw, `${label}: the same answer, byte for byte`);
      assert.equal(errorOf(await attempt(h, freshKey())).code, 'QUOTE_ALREADY_USED');
      assert.equal(sent(first, ORDERS) + sent(same, ORDERS), 1, `${label}: one order call, ever`);
      assertUnknownStatus(h, await read(h), label);
    }
  }
  const h = await open(caller, 'SG');
  door.orderScript.push(ANSWERS.quoteExpired());
  const first = await attempt(h, freshKey());
  assert.deepEqual([errorOf(first).code, errorOf(first).retriable], ['QUOTE_EXPIRED', false], first.raw.slice(0, 300));
}));

test('Q3: a seller not taking orders (the backend\'s listed 403 MERCHANT_NOT_ACCEPTING_ORDERS) is named and terminal on every tool door, in every priced market, and gives the session back', each(async (caller) => {
  const { ERROR_CATALOG } = await import('../safety-kernel/src/errors.js');
  const words = ERROR_CATALOG.MERCHANT_NOT_ACCEPTING_ORDERS.userMessage;
  assert.match(words, /^This seller is not taking orders, so nothing was ordered and nothing was charged\./);
  assert.equal(ERROR_CATALOG.MERCHANT_NOT_ACCEPTING_ORDERS.retriable, false);
  for (const market of PRICED_MARKETS) {
    const label = `${caller} ${market}`;
    const h = await open(caller, market);
    door.orderScript.push(ANSWERS.merchantNotAccepting());
    const key = freshKey();
    const first = await attempt(h, key);
    assert.equal(first.http, 200, label);
    assert.deepEqual(errorOf(first), { code: 'MERCHANT_NOT_ACCEPTING_ORDERS', message: words, retriable: false, detail: { reason: 'merchant_not_accepting_orders' }, recovery: ERROR_CATALOG.MERCHANT_NOT_ACCEPTING_ORDERS.recovery }, `${label}: ${first.raw.slice(0, 300)}`);
    assert.deepEqual([sent(first, ORDERS), sent(first, PAGES)], [1, 0], label);
    assertNoMoney(first, label);
    // Given back: the same key is a first attempt, and this time the backend makes the order.
    const again = await attempt(h, key);
    assert.equal(again.isError, false, `${label}: ${again.raw.slice(0, 300)}`);
    assert.equal(sent(again, ORDERS), 1, label);
  }
}));

test('Q3: on the ACP door a seller not taking orders is answered 409 MERCHANT_NOT_ACCEPTING_ORDERS in the catalog\'s words, and the session is given back', async () => {
  const { ERROR_CATALOG } = await import('../safety-kernel/src/errors.js');
  for (const market of ['US', 'SG', 'GB']) {
    const created = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address(market) }, { key: freshKey() });
    const grant = await keys.mintGrant({ sessionId: created.body.id, currency: created.body.currency, maxAmount: created.body.totals.total });
    door.orderScript.push(ANSWERS.merchantNotAccepting());
    const key = freshKey();
    const done = await door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key });
    assert.equal(done.raw, JSON.stringify({ type: 'error', code: 'MERCHANT_NOT_ACCEPTING_ORDERS', message: ERROR_CATALOG.MERCHANT_NOT_ACCEPTING_ORDERS.userMessage, detail: { reason: 'merchant_not_accepting_orders' } }), market);
    assert.equal(done.http, 409, market);
    const again = await door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key });
    assert.equal(again.http, 200, `${market}: ${again.raw.slice(0, 300)}`);
    assert.equal(again.body.order.currency, created.body.currency, market);
  }
});

test('P1-1: a refused caller assertion that keeps the claim (replay, stale, subject, no reason), with the order made by the first copy, is never "nothing was done" on /mcp, /ucp/mcp, invoke or ACP: the unknown outcome, the claim kept, no second order', async () => {
  const { KERNEL_ANSWERED_REFUSALS: words } = await import('../safety-kernel/src/errors.js');
  for (const reason of ['replay', 'stale', 'subject', undefined]) {
    for (const caller of [...CALLERS, 'invoke', 'acp']) {
      const label = `${caller} ${reason}`;
      const made = door.orders.length;
      let first; let same; let other;
      if (caller === 'invoke') {
        seq += 1;
        const buyer = buyerFor(seq);
        const q = await door.invoke('preview_quote', { quote: nativeQuote('SG') }, { buyer });
        const order = (k) => door.invoke('create_order', { idempotency_key: k, order: { quote_id: q.body.quote_id, customer_email: 'buyer@example.test', shipping_address: { ...fx.address('SG'), recipient_name: 'Buyer One' } } }, { buyer });
        door.orderScript.push({ ...ANSWERS.partnerAssertion(reason), landed: true });
        const key = freshKey();
        first = await order(key); same = await order(key); other = await order(freshKey());
        assert.deepEqual([first.http, first.body.code, first.body.message, first.body.recovery], [409, 'CHECKOUT_OUTCOME_UNKNOWN', words.refused.message, words.refused.recovery], `${label}: ${first.raw.slice(0, 300)}`);
        assert.equal(same.raw, first.raw, label);
        assert.equal(other.body.code, 'QUOTE_ALREADY_USED', label);
      } else if (caller === 'acp') {
        const created = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address('SG') }, { key: freshKey() });
        const grant = await keys.mintGrant({ sessionId: created.body.id, currency: created.body.currency, maxAmount: created.body.totals.total });
        const complete = (k) => door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key: k });
        door.orderScript.push({ ...ANSWERS.partnerAssertion(reason), landed: true });
        const key = freshKey();
        first = await complete(key); same = await complete(key); other = await complete(freshKey());
        assert.deepEqual([first.http, first.body.code, first.body.message], [409, 'CHECKOUT_OUTCOME_UNKNOWN', words.refused.message], `${label}: ${first.raw.slice(0, 300)}`);
        assert.equal(same.body.code, 'CHECKOUT_OUTCOME_UNKNOWN', label);
        assert.equal(other.body.code, 'QUOTE_ALREADY_USED', label);
      } else {
        const h = await open(caller, 'SG');
        door.orderScript.push({ ...ANSWERS.partnerAssertion(reason), landed: true });
        const key = freshKey();
        first = await attempt(h, key); same = await attempt(h, key); other = await attempt(h, freshKey());
        assertUnknown(first, 'order_create_outcome_unknown', null, label, { answered: 'refused' });
        assert.equal(same.raw, first.raw, label);
        assert.equal(errorOf(other).code, 'QUOTE_ALREADY_USED', label);
      }
      for (const r of [first, same, other]) assert.equal(/nothing was (?:done|written)|could not confirm the account/i.test(r.raw), false, `${label}: ${r.raw.slice(0, 300)}`);
      assert.equal(sent(first, ORDERS), 1, label);
      assert.equal(sent(same, ORDERS) + sent(other, ORDERS), 0, `${label}: no second order call`);
      assert.equal(door.orders.length, made + 1, `${label}: the first copy's order, and no other`);
    }
  }
  // A listed reason (decided before any store read) is the named refusal as raised, and gives the session back.
  for (const caller of CALLERS) {
    const h = await open(caller, 'GB');
    door.orderScript.push(ANSWERS.partnerAssertion('path'));
    const key = freshKey();
    const first = await attempt(h, key);
    assert.equal(errorOf(first).code, 'PARTNER_ASSERTION_REJECTED', `${caller}: ${first.raw.slice(0, 300)}`);
    const again = await attempt(h, key);
    assert.equal(again.isError, false, `${caller}: ${again.raw.slice(0, 300)}`);
  }
});

test('P1-1 (after the order): a refused caller assertion on the payment step or the payment page, for every reason, listed ones too, is never "nothing was done" on /mcp, /ucp/mcp or ACP: the unknown outcome with the order id; the same key is told the same; another key names the order', async () => {
  const { KERNEL_ANSWERED_AFTER_ORDER } = await import('../safety-kernel/src/errors.js');
  for (const reason of ['replay', 'stale', 'path']) {
    for (const caller of [...CALLERS, 'acp']) {
      for (const market of ['US', 'SG', 'GB']) {
        const label = `${caller} ${reason} ${market}`;
        const madeBefore = door.orders.length;
        let first; let same; let other;
        if (caller === 'acp') {
          const created = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address(market) }, { key: freshKey() });
          const grant = await keys.mintGrant({ sessionId: created.body.id, currency: created.body.currency, maxAmount: created.body.totals.total });
          const complete = (k) => door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key: k });
          door.paymentScript.push(ANSWERS.partnerAssertion(reason));
          const key = freshKey();
          first = await complete(key); same = await complete(key); other = await complete(freshKey());
          assert.deepEqual([first.http, first.body.code, first.body.message], [409, 'CHECKOUT_OUTCOME_UNKNOWN', KERNEL_ANSWERED_AFTER_ORDER.payment_outcome_unknown_after_order.message], `${label}: ${first.raw.slice(0, 300)}`);
          assert.equal(same.body.code, 'CHECKOUT_OUTCOME_UNKNOWN', label);
          assert.equal(other.body.code, 'QUOTE_ALREADY_USED', label);
        } else {
          const h = await open(caller, market);
          door.paymentScript.push(ANSWERS.partnerAssertion(reason));
          const key = freshKey();
          first = await attempt(h, key); same = await attempt(h, key); other = await attempt(h, freshKey());
          const why = caller === 'mcp_payment_link' ? 'payment_link_outcome_unknown_after_order' : 'payment_outcome_unknown_after_order';
          const orderId = door.orders.at(-1).order_id;
          assert.deepEqual([errorOf(first).code, errorOf(first).retriable, errorOf(first).detail, errorOf(first).message], ['CHECKOUT_OUTCOME_UNKNOWN', false, { reason: why, order_id: orderId }, KERNEL_ANSWERED_AFTER_ORDER[why].message], `${label}: ${first.raw.slice(0, 300)}`);
          assert.equal(same.raw, first.raw, `${label}: the same key, the same answer (never "Starting fresh")`);
          assertSpentNamingOrder(other, orderId, `${label} another key`);
          assert.equal(currencyOf(await read(h)), h.currency, label);
        }
        for (const r of [first, same, other]) assert.equal(/nothing was (?:done|written)|could not confirm the account|Starting fresh/i.test(r.raw), false, `${label}: ${r.raw.slice(0, 300)}`);
        assert.equal(sent(first, ORDERS) + sent(first, PAGES), 2, `${label}: one order call and one page call`);
        assert.equal(sent(same, ORDERS) + sent(same, PAGES) + sent(other, ORDERS) + sent(other, PAGES), 0, `${label}: nothing more asked`);
        assert.equal(door.orders.length, madeBefore + 1, label);
      }
    }
  }
});

test('Q3: the mapping names a seller not taking orders only on the order op, at 403, from the route\'s own detail', () => {
  const named = { operation: 'create_order', status: 403, upstreamCode: 'MERCHANT_NOT_ACCEPTING_ORDERS', upstreamDetail: { error: 'MERCHANT_NOT_ACCEPTING_ORDERS', message: 'placeholder', merchant_id: 'merch_shop_a' } };
  assert.equal(mapUpstreamErrorToKernelCode(named), 'MERCHANT_NOT_ACCEPTING_ORDERS');
  assert.ok(curatedUpstreamRefusal(named), 'curated');
  assert.deepEqual(curatedUpstreamRefusal(named).acp_detail, { reason: 'merchant_not_accepting_orders' });
  for (const [label, input] of [
    ['another op', { ...named, operation: 'submit_payment' }],
    ['another status', { ...named, status: 409 }],
    ['no status (a refusal the private backend hop raised)', { ...named, status: null, upstreamCode: null, upstreamDetail: null }],
    ['no route detail', { ...named, upstreamDetail: null }],
    ['a route detail naming another code', { ...named, upstreamDetail: { error: 'FORBIDDEN' } }],
    ['a route detail that is prose', { ...named, upstreamDetail: 'Not authorized for this merchant' }],
    ['the status-derived code', { ...named, upstreamCode: 'FORBIDDEN' }],
    ['a bare 403', { operation: 'create_order', status: 403 }],
  ]) {
    assert.equal(mapUpstreamErrorToKernelCode(input), 'MERCHANT_UNAVAILABLE', label);
    assert.equal(curatedUpstreamRefusal(input), null, label);
  }
});

test('A.5: an order call answered with something that is not an order is an unknown outcome with no order id; the claim is kept and no second order is asked for', each(async (caller) => {
  for (const [shape, answer] of Object.entries({ unparseable_200: () => ANSWERS.raw(200, '<html>ok</html>', { landed: true }), empty_200: () => ANSWERS.raw(200, '', { landed: true }), no_order_200: () => ANSWERS.raw(200, { status: 'success' }, { landed: true }) })) {
    const label = `${caller} ${shape}`;
    const h = await open(caller, 'GB');
    door.orderScript.push(answer());
    const key = freshKey();
    const first = await attempt(h, key);
    assertUnknown(first, 'order_create_outcome_unknown', null, label);
    assert.deepEqual([sent(first, ORDERS), sent(first, PAGES)], [1, 0], label);
    assertUnknown(await attempt(h, key), 'order_create_outcome_unknown', null, `${label} same key`);
    const other = await attempt(h, freshKey());
    assertSpentNamingOrder(other, null, `${label} another key`);
    assert.equal(sent(other, ORDERS), 0, label);
    const got = await read(h);
    assertUnknownStatus(h, got, label);
  }
}));

// ---- B: no address to ship to --------------------------------------------------------------------------------------

test('B: a session with no address anywhere is refused by name before any order on every tool door, and the corrected request orders once', each(async (caller) => {
  const h = await open(caller, null);
  assert.equal(h.r.isError, false, h.r.raw.slice(0, 300));
  const key = freshKey();
  const first = await attempt(h, key);
  const e = errorOf(first);
  assert.equal(e.code, 'QUOTE_REQUIRED', first.raw.slice(0, 300));
  assert.equal(e.retriable, false);
  assert.equal(e.detail.reason, 'acp_fulfillment_address_required');
  assert.deepEqual(e.detail.missing_fields, ['name', 'address_line1', 'city', 'postal_code', 'country']);
  assert.match(e.message, ucp(h) ? /`update_checkout` tool/ : /`update_checkout_session` tool/);
  assert.match(e.message, /no order was created/);
  assert.deepEqual(first.upstream, [], 'nothing was sent: no order, no page');
  assertNoMoney(first, caller);
  if (ucp(h)) {
    // UCP's completion carries no address: re-price with one, then complete the checkout the update answers with.
    const updated = await door.call('update_checkout', { meta: ucpMeta(freshKey()), id: h.id, checkout: ucpCheckout('US') }, { buyer: h.buyer, door: '/ucp/mcp' });
    assert.equal(updated.isError, false, updated.raw.slice(0, 300));
    const h2 = { ...h, id: updated.value.session_id || updated.value.id, currency: updated.value.currency, grant: null };
    const done = await attempt(h2, key);
    assert.equal(done.isError, false, done.raw.slice(0, 300));
    assert.equal(sent(done, ORDERS), 1);
  } else {
    const done = await attempt(h, key, { shipping_address: fx.address('US') });
    assert.equal(done.isError, false, done.raw.slice(0, 300));
    assert.equal(sent(done, ORDERS), 1);
  }
}));

test('B: the backend\'s prologue refusal of the buyer context is named and terminal on every tool door; the same key then orders once', each(async (caller) => {
  for (const market of PRICED_MARKETS) {
    const h = await open(caller, market);
    door.orderScript.push(ANSWERS.invalidBuyer());
    const key = freshKey();
    const first = await attempt(h, key);
    const expected = curatedUpstreamRefusal({ operation: 'create_order', status: 400, upstreamCode: 'INVALID_BUYER_CONTEXT', upstreamDetail: { error: 'INVALID_BUYER_CONTEXT' } });
    assert.deepEqual(errorOf(first), { code: 'QUOTE_REQUIRED', message: expected.acp_message, retriable: false, detail: expected.acp_detail }, `${caller} ${market}`);
    assert.equal(sent(first, ORDERS), 1);
    const again = await attempt(h, key);
    assert.equal(again.isError, false, `${caller} ${market}: ${again.raw.slice(0, 300)}`);
    assert.equal(sent(again, ORDERS), 1, `${caller} ${market}: one order`);
  }
}));

test('B: the mapping grants the named code only on the order op, the exact status, and the route\'s own detail', () => {
  const named = { operation: 'create_order', status: 400, upstreamCode: 'INVALID_BUYER_CONTEXT', upstreamDetail: { error: 'INVALID_BUYER_CONTEXT' } };
  assert.equal(mapUpstreamErrorToKernelCode(named), 'QUOTE_REQUIRED');
  for (const [label, input] of [
    ['another op', { ...named, operation: 'preview_quote' }],
    ['another status', { ...named, status: 409 }],
    ['a 5xx', { ...named, status: 503 }],
    ['no route detail', { ...named, upstreamDetail: null }],
    ['a route detail naming another code', { ...named, upstreamDetail: { error: 'INVALID_QUOTE' } }],
    ['a list detail', { ...named, upstreamDetail: [{ error: 'INVALID_BUYER_CONTEXT' }] }],
    ['another code', { ...named, upstreamCode: 'INVALID_QUOTE' }],
  ]) {
    assert.equal(mapUpstreamErrorToKernelCode(input), 'MERCHANT_UNAVAILABLE', label);
    assert.equal(curatedUpstreamRefusal(input), null, label);
  }
});

// ---- C, D: cancel and read back -----------------------------------------------------------------------------------------

test('C: cancel by session id of a session with no order cancels it truly (its claim is taken): a later complete or payment link is refused and asks the backend for nothing', async () => {
  for (const market of PRICED_MARKETS) {
    for (const then of CALLERS) {
      // The session is opened on the caller's own door and cancelled through `/mcp` (the UCP dialect has no cancel
      // tool; both doors share one kernel, and the buyer is the same).
      const h = await open(then, market);
      const cancel = await door.call('cancel_checkout_session', { idempotency_key: freshKey(), session_id: h.id }, { buyer: h.buyer });
      assert.equal(cancel.isError, false, cancel.raw.slice(0, 300));
      assert.deepEqual(cancel.value, { session_id: h.id, order_id: null, status: 'canceled' }, market);
      assert.deepEqual(cancel.upstream, []);
      const after = await attempt(h, freshKey());
      // Told the truth: it was canceled. Never "already used to place an order", never get_order.
      assert.deepEqual(errorOf(after), {
        code: 'QUOTE_ALREADY_USED',
        message: 'This checkout was canceled, so it cannot be completed or paid. No order was placed from it.',
        retriable: false,
        detail: { reason: 'session_canceled' },
        recovery: 'do not complete this checkout; start a new checkout only if the buyer wants to buy',
      }, `${market} ${then}: ${after.raw.slice(0, 300)}`);
      assert.deepEqual(after.upstream.filter((c) => c.path === ORDERS || c.path === PAGES), [], `${market} ${then}: 0 order calls`);
      assert.equal((await read(h)).value.status, 'canceled', market);
    }
  }
});

test('5: cancel by order id with the upstream cancel off is never canceled: the caller\'s own order is refused by name (its page stays open), an id never held and another caller\'s order get one not-found answer; nothing is sent', async () => {
  for (const market of PRICED_MARKETS) {
    const label = market;
    const h = await open('mcp_payment_link', market);
    const linked = await attempt(h, freshKey());
    assert.equal(linked.isError, false, `${label}: ${linked.raw.slice(0, 300)}`);
    const orderId = linked.value.order_id;
    const own = await door.call('cancel_checkout_session', { idempotency_key: freshKey(), order_id: orderId }, { buyer: h.buyer });
    assert.deepEqual(errorOf(own), {
      code: 'OPERATION_NOT_ALLOWED',
      message: 'This order cannot be canceled from here: no cancellation reaches the store, so any payment page opened for it stays open until it expires.',
      retriable: false,
      detail: { reason: 'order_cancel_not_available', canceled: false, order_id: orderId, order_status: 'created' },
      recovery: 'do not tell the buyer the order was canceled; read the order with get_order (detail.order_id); this gateway cannot cancel it at the store: if the buyer no longer wants it, the buyer should not pay, or should ask the merchant to cancel it',
    }, `${label}: ${own.raw.slice(0, 300)}`);
    assert.deepEqual(own.upstream, [], `${label}: nothing sent`);
    // The session id the session-cancel refusal hands out leads here too: the same refusal.
    const both = await door.call('cancel_checkout_session', { idempotency_key: freshKey(), session_id: h.id, order_id: orderId }, { buyer: h.buyer });
    assert.equal(errorOf(both).detail?.reason, 'order_cancel_not_available', label);
    const got = await read(h);
    assert.deepEqual([got.value.status, got.value.order_id, got.value.order_status], ['completed', orderId, 'created'], `${label}: the order is as it was`);
    // Never held, and another caller's (another buyer session on this door): byte-equal answers.
    const neverHeld = await door.call('cancel_checkout_session', { idempotency_key: 'idem-cxl-same-key', order_id: 'ord_never_held' }, { buyer: h.buyer });
    const others = await door.call('cancel_checkout_session', { idempotency_key: 'idem-cxl-same-key', order_id: 'ord_never_held' }, { buyer: buyerFor(999000) });
    const foreign = await door.call('cancel_checkout_session', { idempotency_key: 'idem-cxl-same-key', order_id: orderId }, { buyer: buyerFor(999001) });
    assert.equal(errorOf(neverHeld).code, 'QUOTE_NOT_FOUND', neverHeld.raw.slice(0, 300));
    assert.equal(foreign.raw, neverHeld.raw, `${label}: another caller's order reads exactly as one never held`);
    assert.equal(others.raw, neverHeld.raw, label);
    assert.equal(foreign.raw.includes(orderId), false, label);
    for (const r of [neverHeld, others, foreign]) assert.deepEqual(r.upstream, [], label);
    assert.equal((await read(h)).value.order_status, 'created', label);
  }
  // The ACP door: a completed session's cancel (it cancels by its order) is refused too, and the session stays completed.
  for (const market of ['US', 'SG', 'GB']) {
    const created = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address(market) }, { key: freshKey() });
    const grant = await keys.mintGrant({ sessionId: created.body.id, currency: created.body.currency, maxAmount: created.body.totals.total });
    const done = await door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key: freshKey() });
    assert.equal(done.http, 200, done.raw.slice(0, 300));
    const cancel = await door.acp('POST', `/checkout_sessions/${created.body.id}/cancel`, {}, { key: freshKey() });
    assert.deepEqual([cancel.http, cancel.body.code], [409, 'OPERATION_NOT_ALLOWED'], `${market}: ${cancel.raw.slice(0, 300)}`);
    // P3-3: its own words, never the catalog's "That action is not available here."
    assert.deepEqual(cancel.body.detail, { reason: 'cannot_cancel_paid_or_pending', canceled: false, order_status: 'charge_pending' }, market);
    assert.match(cancel.body.message, /^This checkout session's order has a payment under way, so it was not canceled, and the payment's outcome is not known yet\./, market);
    // P3 (d): a refund is the merchant's only if it is charged; never said outright for a payment still under way.
    assert.match(cancel.body.message, /if it is charged, a refund is the merchant's to make/, market);
    assert.match(cancel.body.message, /GET \/checkout_sessions\/\{checkout_session_id\}/, market);
    assert.deepEqual(cancel.upstream, [], market);
    const got = await door.acp('GET', `/checkout_sessions/${created.body.id}`);
    assert.deepEqual([got.body.status, got.body.order], ['checkout.completed', { id: done.body.order.id, status: 'charge_pending' }], `${market}: ${got.raw.slice(0, 300)}`);
  }
});

test('P3-4/P3-3: the flag-off order-id cancel words follow the order\'s status on /mcp and on ACP: unpaid (a page may be open), failed (no page is promised), canceled (it reads canceled; read it)', async () => {
  const mount = await door.app._debug.__agentCheckoutStrict.getCommerceMount();
  const setStatus = async (orderId, status) => { const o = await mount.kernel._orderStore.get(orderId); assert.ok(o, orderId); await mount.kernel._orderStore.set(orderId, { ...o, status }); };
  for (const [status, mcpWords, acpWords] of [
    ['created', /any payment page opened for it stays open until it expires/, /any payment page opened for it stays open until it expires/],
    ['failed', /^This order cannot be canceled from here: no cancellation reaches the store\. Its payment did not go through\.$/, /Its payment did not go through\./],
    ['canceled', /^This order already reads canceled here\. This call did not cancel anything and sent nothing to the store\.$/, /already reads canceled here\. This request did not cancel anything/],
  ]) {
    for (const market of ['US', 'SG', 'GB']) {
      const label = `${status} ${market}`;
      const h = await open('mcp_payment_link', market);
      const linked = await attempt(h, freshKey());
      assert.equal(linked.isError, false, `${label}: ${linked.raw.slice(0, 300)}`);
      await setStatus(linked.value.order_id, status);
      const own = await door.call('cancel_checkout_session', { idempotency_key: freshKey(), order_id: linked.value.order_id }, { buyer: h.buyer });
      const e = errorOf(own);
      assert.deepEqual([e.code, e.retriable, e.detail], ['OPERATION_NOT_ALLOWED', false, { reason: 'order_cancel_not_available', canceled: false, ...(status === 'canceled' ? { already_canceled: true } : {}), order_id: linked.value.order_id, order_status: status }], `${label}: ${own.raw.slice(0, 300)}`);
      assert.match(e.message, mcpWords, label);
      assert.match(e.recovery, /get_order \(detail\.order_id\)/, label);
      if (status !== 'created') assert.equal(/payment page/i.test(e.message + e.recovery), false, `${label}: ${e.message}`);
      assert.deepEqual(own.upstream, [], label);
      // ACP: a session whose order is in that status.
      const created = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address(market) }, { key: freshKey() });
      const grant = await keys.mintGrant({ sessionId: created.body.id, currency: created.body.currency, maxAmount: created.body.totals.total });
      const done = await door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key: freshKey() });
      assert.equal(done.http, 200, done.raw.slice(0, 300));
      await setStatus(done.body.order.id, status);
      const cancel = await door.acp('POST', `/checkout_sessions/${created.body.id}/cancel`, {}, { key: freshKey() });
      assert.deepEqual([cancel.http, cancel.body.code, cancel.body.detail], [409, 'OPERATION_NOT_ALLOWED', { reason: 'order_cancel_not_available', canceled: false, ...(status === 'canceled' ? { already_canceled: true } : {}), order_status: status }], `${label}: ${cancel.raw.slice(0, 300)}`);
      assert.match(cancel.body.message, acpWords, label);
      assert.match(cancel.body.message, /GET \/checkout_sessions\/\{checkout_session_id\}/, label);
      assert.equal(/get_order|not available here/.test(cancel.body.message), false, label);
      if (status !== 'created') assert.equal(/payment page/i.test(cancel.body.message), false, label);
      assert.deepEqual(cancel.upstream, [], label);
    }
  }
});

test('the strict invoke route: an order call with no readable answer is an unknown outcome, and a same-key resend really is told the same', async () => {
  for (const market of PRICED_MARKETS) {
    seq += 1;
    const buyer = buyerFor(seq);
    const q = await door.invoke('preview_quote', { quote: nativeQuote(market) }, { buyer });
    assert.equal(q.http, 200, q.raw.slice(0, 300));
    door.orderScript.push(ANSWERS.timeout({ landed: true }));
    const order = (key) => door.invoke('create_order', { idempotency_key: key, order: { quote_id: q.body.quote_id, customer_email: 'buyer@example.test', shipping_address: { ...fx.address(market), recipient_name: 'Buyer One' } } }, { buyer });
    const key = freshKey();
    const first = await order(key);
    assert.deepEqual([first.http, first.body.code, first.body.retriable], [409, 'CHECKOUT_OUTCOME_UNKNOWN', false], first.raw.slice(0, 300));
    assert.match(first.body.recovery, /re-sending the same call returns this same answer/);
    const same = await order(key);
    assert.equal(same.raw, first.raw, `${market}: the same answer, byte for byte`);
    assert.equal(same.http, 409, market);
    assert.equal(sent(same, ORDERS), 0, market);
    const other = await order(freshKey());
    // P3 (a): the claim names no order, so not "read the order this session already placed (get_order)", and 409.
    assert.deepEqual([other.http, other.body.code, other.body.detail], [409, 'QUOTE_ALREADY_USED', { reason: 'checkout_session_order_outcome_unknown' }], `${market}: ${other.raw.slice(0, 300)}`);
    assert.match(other.body.message, /^An order was asked for on this checkout session, and whether it was placed is not known/, market);
    assert.equal(/get_order|already used to place an order/.test(other.raw), false, market);
    assert.equal(sent(first, ORDERS) + sent(same, ORDERS) + sent(other, ORDERS), 1, `${market}: one order call, ever`);
  }
  // The store's refusals of the order call on this route: a 429 and an unnamed 403 are the same 409, in their own words;
  // a seller not taking orders is named: 409, never 405, in the catalog's words and with its reason.
  const { ERROR_CATALOG } = await import('../safety-kernel/src/errors.js');
  for (const [answer, http, code, words] of [
    [ANSWERS.rateLimited, 409, 'CHECKOUT_OUTCOME_UNKNOWN', /rate limiting/],
    [ANSWERS.notAuthorized, 409, 'CHECKOUT_OUTCOME_UNKNOWN', /^The order service refused this order request\./],
    [ANSWERS.merchantNotAccepting, 409, 'MERCHANT_NOT_ACCEPTING_ORDERS', null],
  ]) {
    seq += 1;
    const buyer = buyerFor(seq);
    const q = await door.invoke('preview_quote', { quote: nativeQuote('GB') }, { buyer });
    door.orderScript.push(answer());
    const key = freshKey();
    const order = () => door.invoke('create_order', { idempotency_key: key, order: { quote_id: q.body.quote_id, customer_email: 'buyer@example.test', shipping_address: { ...fx.address('GB'), recipient_name: 'Buyer One' } } }, { buyer });
    const first = await order();
    assert.deepEqual([first.http, first.body.code, first.body.retriable], [http, code, false], first.raw.slice(0, 300));
    if (code === 'MERCHANT_NOT_ACCEPTING_ORDERS') {
      assert.deepEqual([first.body.message, first.body.detail, first.body.recovery], [ERROR_CATALOG.MERCHANT_NOT_ACCEPTING_ORDERS.userMessage, { reason: 'merchant_not_accepting_orders' }, ERROR_CATALOG.MERCHANT_NOT_ACCEPTING_ORDERS.recovery], first.raw.slice(0, 300));
      assert.equal(/use the correct tool|not available here/i.test(first.raw), false, first.raw.slice(0, 300));
    }
    if (words) {
      assert.match(first.body.message, words, first.raw.slice(0, 300));
      assert.equal(/no readable answer|may have been accepted/i.test(first.raw), false, first.raw.slice(0, 300));
      const same = await order();
      assert.equal(same.raw, first.raw, 'the same answer, byte for byte');
      assert.equal(sent(same, ORDERS), 0);
    }
  }
});

test('Q3: the ACP door reads a session whose order call is unknown as in progress, with order_outcome unknown; and an order it did not record as completed', async () => {
  for (const market of ['US', 'SG', 'GB']) {
    const created = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address(market) }, { key: freshKey() });
    assert.equal(created.http, 201, created.raw.slice(0, 300));
    const grant = await keys.mintGrant({ sessionId: created.body.id, currency: created.body.currency, maxAmount: created.body.totals.total });
    door.orderScript.push(ANSWERS.timeout());
    const done = await door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key: freshKey() });
    assert.deepEqual([done.http, done.body.code], [409, 'CHECKOUT_OUTCOME_UNKNOWN'], done.raw.slice(0, 300));
    const got = await door.acp('GET', `/checkout_sessions/${created.body.id}`);
    assert.deepEqual([got.http, got.body.status, got.body.order_outcome, got.body.order], [200, 'checkout.in_progress', 'unknown', undefined], `${market}: ${got.raw.slice(0, 300)}`);
    // An order exists and its payment page answered nothing readable: the session reads as the order it became.
    const c2 = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address(market) }, { key: freshKey() });
    const g2 = await keys.mintGrant({ sessionId: c2.body.id, currency: c2.body.currency, maxAmount: c2.body.totals.total });
    door.paymentScript.push(ANSWERS.busy());
    const d2 = await door.acp('POST', `/checkout_sessions/${c2.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: g2 } }, { key: freshKey() });
    assert.deepEqual([d2.http, d2.body.code], [409, 'CHECKOUT_OUTCOME_UNKNOWN'], d2.raw.slice(0, 300));
    const got2 = await door.acp('GET', `/checkout_sessions/${c2.body.id}`);
    assert.deepEqual([got2.body.status, got2.body.order && got2.body.order.id, 'order_outcome' in got2.body], ['checkout.completed', door.orders.at(-1).order_id, false], got2.raw.slice(0, 300));
    // N-4: the order's own status beside its id: its payment step was asked for and is not known to have gone
    // through (charge_pending), so not paid.
    assert.deepEqual(got2.body.order, { id: door.orders.at(-1).order_id, status: 'charge_pending' }, got2.raw.slice(0, 300));
    // An order this door did record (its completion answered): the same shape, with the kernel's status of it.
    const c3 = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address(market) }, { key: freshKey() });
    const g3 = await keys.mintGrant({ sessionId: c3.body.id, currency: c3.body.currency, maxAmount: c3.body.totals.total });
    const d3 = await door.acp('POST', `/checkout_sessions/${c3.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: g3 } }, { key: freshKey() });
    assert.equal(d3.http, 200, d3.raw.slice(0, 300));
    const got3 = await door.acp('GET', `/checkout_sessions/${c3.body.id}`);
    assert.deepEqual([got3.body.status, got3.body.order, 'order_outcome' in got3.body], ['checkout.completed', { id: d3.body.order.id, status: 'charge_pending' }, false], got3.raw.slice(0, 300));
    assert.equal(got3.body.currency, c3.body.currency, `${market}: the currency it was priced in`);
  }
});

test('8: an order the kernel holds in a status no read knows (an expired one) is never read as completed: /mcp, UCP and ACP all say so, with its id', async () => {
  const mount = await door.app._debug.__agentCheckoutStrict.getCommerceMount();
  const expire = async (orderId) => { const o = await mount.kernel._orderStore.get(orderId); assert.ok(o, orderId); await mount.kernel._orderStore.set(orderId, { ...o, status: 'expired' }); };
  for (const caller of ['mcp_complete', 'ucp_complete']) {
    for (const market of PRICED_MARKETS) {
      const label = `${caller} ${market}`;
      const h = await open(caller, market);
      const done = await attempt(h, freshKey());
      assert.equal(done.isError, false, `${label}: ${done.raw.slice(0, 300)}`);
      const orderId = door.orders.at(-1).order_id;
      await expire(orderId);
      const got = await read(h);
      assert.equal(got.isError, false, label);
      if (ucp(h)) assert.deepEqual([got.value.status, got.value.order_outcome, got.value.order_id, got.value.order_status], ['complete_in_progress', 'status_unknown', orderId, 'expired'], label);
      else assert.deepEqual([got.value.status, got.value.order_id, got.value.order_status], ['order_status_unknown', orderId, 'expired'], label);
      assert.equal(got.value.currency, h.currency, label);
    }
  }
  const created = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }], fulfillment_address: fx.address('SG') }, { key: freshKey() });
  const grant = await keys.mintGrant({ sessionId: created.body.id, currency: created.body.currency, maxAmount: created.body.totals.total });
  const done = await door.acp('POST', `/checkout_sessions/${created.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key: freshKey() });
  assert.equal(done.http, 200, done.raw.slice(0, 300));
  await expire(done.body.order.id);
  const got = await door.acp('GET', `/checkout_sessions/${created.body.id}`);
  assert.deepEqual([got.body.status, got.body.order_outcome, got.body.order], ['checkout.in_progress', 'status_unknown', { id: done.body.order.id, status: 'expired' }], got.raw.slice(0, 300));
});

test('N-6: on the UCP door, update_checkout of a session whose order call is unknown answers a new session, and says the one it was sent is complete_in_progress, with order_outcome unknown', async () => {
  for (const market of PRICED_MARKETS) {
    const h = await open('ucp_complete', market);
    door.orderScript.push(ANSWERS.timeout());
    const done = await attempt(h, freshKey());
    assertUnknown(done, 'order_create_outcome_unknown', null, market);
    const updated = await door.call('update_checkout', { meta: ucpMeta(freshKey()), id: h.id, checkout: ucpCheckout(market) }, { buyer: h.buyer, door: '/ucp/mcp' });
    assert.equal(updated.isError, false, updated.raw.slice(0, 300));
    assert.notEqual(updated.value.id || updated.value.session_id, h.id, `${market}: a separate session`);
    assert.deepEqual(updated.value.previous_session, { session_id: h.id, status: 'complete_in_progress', order_id: null, order_outcome: 'unknown' }, `${market}: ${updated.raw.slice(0, 400)}`);
    assert.equal(updated.value.currency, h.currency, market);
    assert.equal(sent(updated, ORDERS), 0, market);
  }
});

test('6: the ACP door refuses to re-price a session whose claim is held (an order with an unknown payment step, an unknown order call, a cancellation); nothing is priced, and no completion makes a second order', async () => {
  const cart = (market, quantity = 1) => ({ merchant_id: IDS.SELLER, items: [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity }], fulfillment_address: fx.address(market) });
  for (const market of ['US', 'SG', 'GB']) {
    for (const [shape, script, code, status] of [
      ['after a completion whose payment page answered nothing readable', () => door.paymentScript.push(ANSWERS.busy()), 'QUOTE_ALREADY_USED', 'checkout.completed'],
      ['after a completion whose order call answered nothing', () => door.orderScript.push(ANSWERS.timeout({ landed: true })), 'QUOTE_ALREADY_USED', 'checkout.in_progress'],
      ['after a cancellation', null, 'ORDER_CANCELED', 'canceled'],
    ]) {
      const label = `${market} ${shape}`;
      const created = await door.acp('POST', '/checkout_sessions', cart(market), { key: freshKey() });
      assert.equal(created.http, 201, created.raw.slice(0, 300));
      const id = created.body.id;
      const ordersBefore = door.orders.length;
      if (script) {
        script();
        const grant = await keys.mintGrant({ sessionId: id, currency: created.body.currency, maxAmount: created.body.totals.total });
        const done = await door.acp('POST', `/checkout_sessions/${id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant } }, { key: freshKey() });
        assert.deepEqual([done.http, done.body.code], [409, 'CHECKOUT_OUTCOME_UNKNOWN'], `${label}: ${done.raw.slice(0, 300)}`);
      } else {
        assert.equal((await door.acp('POST', `/checkout_sessions/${id}/cancel`, {}, { key: freshKey() })).http, 200, label);
      }
      const updated = await door.acp('POST', `/checkout_sessions/${id}`, cart(market, 2), { key: freshKey() });
      assert.deepEqual([updated.http, updated.body.code], [409, code], `${label}: ${updated.raw.slice(0, 300)}`);
      assert.equal(updated.upstream.filter((c) => c.path === '/agent/v2/quotes/preview').length, 0, `${label}: nothing priced`);
      const got = await door.acp('GET', `/checkout_sessions/${id}`);
      assert.equal(got.body.status, status, `${label}: ${got.raw.slice(0, 300)}`);
      if (status !== 'canceled') assert.equal(got.body.currency, created.body.currency, label);
      // Another completion: never a second order, never a second payment page.
      const grant2 = await keys.mintGrant({ sessionId: id, currency: created.body.currency, maxAmount: created.body.totals.total * 2 });
      const again = await door.acp('POST', `/checkout_sessions/${id}/complete`, { payment_data: { method: 'acp_delegated_token', token: grant2 } }, { key: freshKey() });
      assert.notEqual(again.http, 200, `${label}: ${again.raw.slice(0, 300)}`);
      assert.deepEqual(again.upstream.filter((c) => c.path === ORDERS || c.path === PAGES), [], label);
      assert.ok(door.orders.length - ordersBefore <= 1, label);
      // P3-2: an order call whose outcome is unknown is never told the catalog's "already used to place an order ...
      // get_order": the update and another completion are told what is known, in this door's words.
      if (status === 'checkout.in_progress') {
        for (const r of [updated, again]) {
          assert.deepEqual([r.http, r.body.code, r.body.detail], [409, 'QUOTE_ALREADY_USED', { reason: 'checkout_session_order_outcome_unknown' }], `${label}: ${r.raw.slice(0, 300)}`);
          assert.match(r.body.message, /^An order was asked for on this checkout session, and whether it was placed is not known/, label);
          assert.match(r.body.message, /GET \/checkout_sessions\/\{checkout_session_id\}/, label);
          assert.equal(/get_order|already used to place an order/.test(r.body.message), false, label);
        }
      }
    }
  }
});

test('D: a completed session reads as completed with its order id, and an update of it says the id it was sent is already ordered', async () => {
  for (const market of PRICED_MARKETS) {
    const h = await open('mcp_complete', market);
    const done = await attempt(h, freshKey());
    assert.equal(done.isError, false, done.raw.slice(0, 300));
    const orderId = orderIdOf(h, done);
    const got = await read(h);
    assert.deepEqual([got.value.status, got.value.order_id, got.value.currency], ['completed', orderId, h.currency], market);
    const updated = await door.call('update_checkout_session', { idempotency_key: freshKey(), session_id: h.id, quote: nativeQuote(market) }, { buyer: h.buyer });
    assert.equal(updated.isError, false, updated.raw.slice(0, 300));
    assert.notEqual(updated.value.session_id, h.id, `${market}: a separate session, as before`);
    assert.deepEqual(updated.value.previous_session, { session_id: h.id, status: 'completed', order_id: orderId, order_status: 'charge_pending' }, market);
    assert.equal(got.value.order_status, 'charge_pending', `${market}: completed as a session, not paid`);
  }
});

test('the tools/call completion line counts the kernel\'s unknown outcomes by their own reason', () => {
  const { loggedToolErrorReason } = require('../src/observability/mcpToolErrorReasons');
  for (const reason of ['payment_outcome_unknown_after_order', 'payment_link_outcome_unknown_after_order', 'order_create_outcome_unknown',
    'acp_fulfillment_address_required', 'buyer_context_refused', 'session_already_ordered', 'session_order_outcome_unknown',
    'session_not_ordered_not_canceled', 'session_canceled', 'merchant_not_accepting_orders', 'order_cancel_not_available']) {
    assert.equal(loggedToolErrorReason(reason), reason, reason);
  }
});

// ---- the markets nothing is priced for ---------------------------------------------------------------------------

test('ZZ: a market this path cannot price is refused at create on every tool door, and no order or payment page is ever asked for', each(async (caller) => {
  const h = await open(caller, 'ZZ');
  assert.equal(h.r.isError, true, h.r.raw.slice(0, 300));
  assert.deepEqual(h.r.upstream.filter((c) => c.path === ORDERS || c.path === PAGES), []);
}));
