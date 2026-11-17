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

test.before(async () => {
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
function assertUnknown(r, reason, orderId, label) {
  const e = errorOf(r);
  assert.equal(r.isError, true, `${label}: ${r.raw.slice(0, 300)}`);
  assert.deepEqual(Object.keys(e), ['code', 'message', 'retriable', 'recovery', 'detail'], label);
  assert.equal(e.code, 'CHECKOUT_OUTCOME_UNKNOWN', label);
  assert.equal(e.retriable, false, label);
  assert.deepEqual(e.detail, { reason, order_id: orderId }, label);
  assert.match(e.message, UNKNOWN_WORDS[reason], label);
  assert.match(e.message, /do not start another checkout/i, label);
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
    assert.equal(e.detail, undefined, `${label}: no order is known, none is named`);
  }
  assertNoMoney(r, label);
}
const each = (fn) => async () => { for (const caller of CALLERS) await fn(caller); };

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
        assert.match(errorOf(cancel).recovery, /detail\.order_id/, label);
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
    assert.deepEqual([got.value.status, got.value.order_id], ['order_outcome_unknown', null], label);
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

test('C: cancel by session id of a session with no order says it was not canceled, and the session can still be completed', async () => {
  const h = await open('mcp_complete', 'US');
  const cancel = await door.call('cancel_checkout_session', { idempotency_key: freshKey(), session_id: h.id }, { buyer: h.buyer });
  assert.equal(cancel.isError, true, cancel.raw.slice(0, 300));
  assert.deepEqual(errorOf(cancel).detail, { reason: 'session_not_ordered_not_canceled', canceled: false });
  assert.match(errorOf(cancel).message, /was not canceled and can still be completed/);
  assert.deepEqual(cancel.upstream, []);
  const done = await attempt(h, freshKey());
  assert.equal(done.isError, false, done.raw.slice(0, 300));
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
    assert.deepEqual(updated.value.previous_session, { session_id: h.id, status: 'completed', order_id: orderId }, market);
  }
});

test('the tools/call completion line counts the kernel\'s unknown outcomes by their own reason', () => {
  const { loggedToolErrorReason } = require('../src/observability/mcpToolErrorReasons');
  for (const reason of ['payment_outcome_unknown_after_order', 'payment_link_outcome_unknown_after_order', 'order_create_outcome_unknown']) {
    assert.equal(loggedToolErrorReason(reason), reason, reason);
  }
});

// ---- the markets nothing is priced for ---------------------------------------------------------------------------

test('ZZ: a market this path cannot price is refused at create on every tool door, and no order or payment page is ever asked for', each(async (caller) => {
  const h = await open(caller, 'ZZ');
  assert.equal(h.r.isError, true, h.r.raw.slice(0, 300));
  assert.deepEqual(h.r.upstream.filter((c) => c.path === ORDERS || c.path === PAGES), []);
}));
