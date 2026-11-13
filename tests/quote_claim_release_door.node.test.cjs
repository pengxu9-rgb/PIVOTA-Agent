'use strict';

// THE QUOTE'S SINGLE-USE CLAIM AFTER A FAILED ORDER, THROUGH THE REAL DOORS: `/mcp` complete_checkout_session,
// `/mcp` create_payment_link and the ACP REST complete route, over HTTP, with the gateway's own transport making
// what it makes of each backend answer.
//
//   - The backend REFUSES FROM ITS PROLOGUE, before it could have written an order (one of nine listed
//     status-and-code answers: a bad buyer context, a quote that is not the caller's, a pre-flight refusal, ...):
//     the failing call is answered exactly as before, and the same key then creates the order, once.
//   - ANYTHING ELSE keeps the claim, and the same key and another key are told what they were told before
//     (QUOTE_ALREADY_USED) with NO second order asked for, whether or not the first one was made:
//       - every 5xx, the backend's own coded busy 503 included (it can follow a written order);
//       - "quote already consumed", and every refusal of the backend's write step (its out-of-stock is a 400
//         "Insufficient inventory"), because that step can run twice inside one request;
//       - no answer (the deadline passed, the connection was lost or refused), and a status from in front of the
//         backend (a page, not the backend's envelope).
//   - An order the backend made and this gateway then refused (its total or currency is not the quote's): kept.
//
// Every backend error here is in the backend's own wire envelope (the fixture pins it, and so does a test below).
//
// The kernel-level suite (safety-kernel/test/quoteClaimRelease.test.js) holds what needs an injected clock or a
// failing store: expiry, races on both stores, a write that fails after the order exists.
// See tests/_support/quoteClaimReleaseDoor.cjs for what is real and what is stubbed. Every name is a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./_support/quoteClaimReleaseDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { IDS, ANSWERS, PRICED_IN, UNIT_MINOR, BEFORE_ANY_ORDER, NOT_PROVABLY_BEFORE } = fx;
const CALLERS = ['mcp_complete', 'mcp_payment_link', 'acp_complete'];
const MARKETS = ['US', 'SG', 'GB', 'DE', null];
let door;
let keys;

test.before(async () => {
  keys = await fx.mintKeys();
  door = fx.bootDoor({ port: 5611, keys });
  await door.listen();
});
test.after(async () => { if (door) await door.close(); });

// ---- the three callers, one shape ---------------------------------------------------------------------------------

let seq = 0;
const freshKey = () => { seq += 1; return `idem-claim-${String(seq).padStart(5, '0')}`; };
// `/mcp` binds a session to the caller's own connection; one buyer session per checkout keeps the checkouts apart.
const buyerFor = (n) => ({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': `sess-${String(n).padStart(5, '0')}` });
const cartItems = [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }];

/** A priced session for `market` (null: the request names no country), opened through the caller's own door. */
async function open(caller, market) {
  seq += 1;
  if (caller === 'acp_complete') {
    const r = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items: cartItems, ...(market ? { fulfillment_address: fx.address(market) } : {}) }, { key: freshKey() });
    assert.equal(r.http, 201, r.raw.slice(0, 300));
    const grant = await keys.mintGrant({ sessionId: r.body.id, currency: r.body.currency, maxAmount: r.body.totals.total });
    return { caller, market, id: r.body.id, currency: r.body.currency, total: r.body.totals.total, grant, opened: r };
  }
  const buyer = buyerFor(seq);
  const quote = { merchant_id: IDS.SELLER, items: cartItems, customer_email: 'buyer@example.test', ...(market ? { shipping_address: fx.address(market) } : {}) };
  const r = await door.call('create_checkout_session', { idempotency_key: freshKey(), quote }, { buyer });
  assert.equal(r.isError, false, r.raw.slice(0, 300));
  const grant = await keys.mintGrant({ sessionId: r.value.session_id, currency: r.value.currency, maxAmount: r.value.totals.total });
  return { caller, market, id: r.value.session_id, buyer, currency: r.value.currency, total: r.value.totals.total, grant, opened: r };
}
/** One attempt at the order. `{ ok, code, order_id, currency, amount, answer (parsed), raw, upstream }`. */
async function attempt(h, key) {
  if (h.caller === 'acp_complete') {
    const r = await door.acp('POST', `/checkout_sessions/${h.id}/complete`, { payment_data: { method: 'acp_delegated_token', token: h.grant } }, { key });
    const ok = r.http === 200;
    return { ok, http: r.http, code: ok ? null : r.body && r.body.code, order_id: ok ? r.body.order.id : null, currency: ok ? r.body.order.currency : null, amount: ok ? r.body.order.amount_total : null, answer: r.body, raw: r.raw, upstream: r.upstream };
  }
  const r = h.caller === 'mcp_complete'
    ? await door.call('complete_checkout_session', { idempotency_key: key, session_id: h.id, payment_authorization: { method: 'acp_delegated_token', token: h.grant } }, { buyer: h.buyer })
    : await door.call('create_payment_link', { idempotency_key: key, session_id: h.id, customer_email: 'buyer@example.test' }, { buyer: h.buyer });
  const ok = !r.isError && r.http === 200;
  const order = ok ? (h.caller === 'mcp_complete' ? r.value.order : r.value) : null;
  return { ok, http: r.http, code: ok ? null : r.value && r.value.error && r.value.error.code, order_id: order && order.order_id, currency: order && order.currency, amount: order && order.amount_total, answer: r.value, raw: r.raw, upstream: r.upstream };
}
const ordersAsked = (r) => r.upstream.filter((c) => c.path === '/agent/v2/orders');
const each = (fn) => async () => { for (const caller of CALLERS) await fn(caller); };

// What each door answers for a code, in full: the failing attempt's answer is pinned to the byte.
const MESSAGES = {
  MERCHANT_UNAVAILABLE: 'The merchant is temporarily unreachable. Please try again shortly.',
  OUT_OF_STOCK: 'An item just went out of stock. Let me re-quote what is available.',
  QUOTE_EXPIRED: 'The price quote expired. Let me refresh it.',
  PRICE_CHANGED: 'The price changed since you confirmed. Here is the updated total.',
  NO_MERCHANT_OFFER: 'This product has no purchasable merchant offer attached, so no detail is available. This will not change on retry.',
  PARTNER_ASSERTION_REJECTED: 'Pivota could not confirm the account this request was made for, so nothing was done. Retrying the same call will not change this.',
  QUOTE_ALREADY_USED: 'This checkout session was already used to place an order, so it can\'t be used again. Read that order first (get_order) before doing anything else; start a new checkout only if the buyer wants another order.',
};
const RETRIABLE = { MERCHANT_UNAVAILABLE: true };
const ACP_STATUS = { MERCHANT_UNAVAILABLE: 503, OUT_OF_STOCK: 409, QUOTE_EXPIRED: 409, PRICE_CHANGED: 409, QUOTE_ALREADY_USED: 409, NO_MERCHANT_OFFER: 404, PARTNER_ASSERTION_REJECTED: 409 };
// What the gateway answers the FAILING attempt for each scripted backend answer (unchanged by the claim rule).
const FIRST_CODE = { partnerAssertionRejected: 'PARTNER_ASSERTION_REJECTED', partnerAssertionReplay: 'PARTNER_ASSERTION_REJECTED', partnerAssertionStale: 'PARTNER_ASSERTION_REJECTED', partnerAssertionNoReason: 'PARTNER_ASSERTION_REJECTED', quoteExpired: 'QUOTE_EXPIRED', quoteMismatch: 'PRICE_CHANGED', merchantNotFound: 'NO_MERCHANT_OFFER' };
const firstCode = (answer) => FIRST_CODE[answer] || 'MERCHANT_UNAVAILABLE';
/** Wait until the backend holds the request; if the call answers first it never got there, so fail with its answer. */
const atBackend = (held, running) => Promise.race([held.reached, running.then((r) => { throw new Error(`the call answered before it reached the backend: ${r.raw.slice(0, 300)}`); })]);
function assertRefused(h, r, code, label) {
  assert.equal(r.ok, false, `${label}: ${r.raw.slice(0, 300)}`);
  if (h.caller === 'acp_complete') {
    assert.equal(r.http, ACP_STATUS[code], `${label}: ${r.raw.slice(0, 300)}`);
    assert.equal(r.raw, JSON.stringify({ type: 'error', code, message: MESSAGES[code] }), label);
  } else {
    assert.equal(r.http, 200, label);
    assert.equal(r.raw, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message: MESSAGES[code], retriable: RETRIABLE[code] === true } }, null, 2) }] } }), label);
  }
  // A refusal states no price in any currency.
  const found = assertAnswerCurrency(JSON.parse(r.raw), marketCurrency(h.market), label);
  assert.deepEqual([found.priceCurrencies.length, found.money.length, found.textMoney.length], [0, 0, 0], `${label}: a refusal states no price`);
}
/**
 * The currency an answer for `market` may state. The gateway's one source (resolveServingCurrency) knows US, SG and
 * GB, and the fixture's backend prices those markets in exactly that currency. It has none for DE: this path does
 * not ask it (a kernel-priced session is in whatever currency the backend quoted), so for DE the bar is the
 * currency the backend priced the request in, and no other.
 */
function marketCurrency(market) {
  const gateway = resolveServingCurrency(market);
  const backend = PRICED_IN[market ?? 'none'];
  if (gateway) assert.equal(backend, gateway, `the fixture prices ${market} in the gateway's currency for it`);
  return gateway || backend;
}
function assertOrdered(h, r, label) {
  assert.equal(r.ok, true, `${label}: ${r.raw.slice(0, 400)}`);
  assert.equal(r.currency, marketCurrency(h.market), `${label}: the order is in the request market's currency`);
  assert.equal(r.currency, h.currency, `${label}: and in the session's`);
  assert.equal(r.amount, UNIT_MINOR, `${label}: at the locked total`);
  assertAnswerCurrency(JSON.parse(r.raw), marketCurrency(h.market), label);
  const made = door.orders.find((o) => o.order_id === r.order_id);
  assert.ok(made, `${label}: the backend made that order`);
  assert.equal(made.currency, marketCurrency(h.market), `${label}: the backend's order is in that currency too`);
}

test('the markets: US, SG and GB are priced in the gateway\'s own currency for them; DE has none there and is not refused on this path', () => {
  assert.equal(resolveServingCurrency('US'), 'USD');
  assert.equal(resolveServingCurrency('SG'), 'SGD');
  assert.equal(resolveServingCurrency('GB'), 'GBP');
  assert.equal(resolveServingCurrency('DE'), null);
  for (const m of ['US', 'SG', 'GB']) assert.equal(PRICED_IN[m], resolveServingCurrency(m), m);
});

// ---- the backend's wire shape -------------------------------------------------------------------------------------

test('the fixture answers in the backend\'s own error envelope: the status-derived code outside, the route\'s code in details.error', () => {
  const meta = { timestamp: '2026-01-01T00:00:00.000000Z', request_id: null };
  const docs = 'https://docs.backend.quote-claim.test/errors';
  // A coded route error (an object detail naming `error`).
  assert.deepEqual(ANSWERS.busy(), {
    kind: 'reply', landed: false, status: 503, headers: { 'Retry-After': '1' },
    body: {
      status: 'error',
      error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'TEMPORARY_UNAVAILABLE', details: { error: 'TEMPORARY_UNAVAILABLE', message: 'Temporary database busy. Please retry shortly.' }, documentation_url: docs },
      metadata: meta,
      detail: { error: 'TEMPORARY_UNAVAILABLE', message: 'Temporary database busy. Please retry shortly.' },
    },
  });
  assert.deepEqual(ANSWERS.invalidBuyer().body, {
    status: 'error',
    error: { code: 'INVALID_REQUEST', message: 'INVALID_BUYER_CONTEXT', details: { error: 'INVALID_BUYER_CONTEXT', message: 'buyer_context.customer_email is required for order creation' }, documentation_url: docs },
    metadata: meta,
    detail: { error: 'INVALID_BUYER_CONTEXT', message: 'buyer_context.customer_email is required for order creation' },
  });
  assert.equal(ANSWERS.invalidBuyer().status, 400);
  assert.deepEqual(ANSWERS.quoteConsumed().body.error, { code: 'CONFLICT', message: 'QUOTE_CONSUMED', details: { error: 'QUOTE_CONSUMED', message: 'Quote already consumed', details: { order_id: 'ord_placeholder' } }, documentation_url: docs });
  // Out of stock: an object detail that names NO code. Only the status-derived code is there.
  assert.deepEqual(ANSWERS.insufficientInventory(), {
    kind: 'reply', landed: false, status: 400,
    body: {
      status: 'error',
      error: { code: 'INVALID_REQUEST', message: 'Invalid request format or parameters', details: { message: 'Insufficient inventory', items: [] }, documentation_url: docs },
      metadata: meta,
      detail: { message: 'Insufficient inventory', items: [] },
    },
  });
  // A string detail.
  assert.deepEqual(ANSWERS.badGatewayFromBackend().body, {
    status: 'error',
    error: { code: 'EXTERNAL_SERVICE_ERROR', message: 'Created order could not be reloaded', details: { error: 'Created order could not be reloaded' }, documentation_url: docs },
    metadata: meta,
    detail: 'Created order could not be reloaded',
  });
  assert.deepEqual(ANSWERS.merchantNotFound().body.error, { code: 'PRODUCT_NOT_FOUND', message: 'Merchant not found', details: { error: 'Merchant not found' }, documentation_url: docs });
  // A request-validation 422 leaves the backend as a 400.
  assert.equal(ANSWERS.validationFailed().status, 400);
  assert.deepEqual(ANSWERS.validationFailed().body.error, { code: 'INVALID_REQUEST', message: 'Request validation failed', details: { validation_errors: [{ field: 'body -> quote_id', message: 'Field required', type: 'missing' }] }, documentation_url: docs });
  // Every scripted backend error is in that envelope, with its route detail carried unchanged.
  for (const [name, [status, detail]] of Object.entries({ ...BEFORE_ANY_ORDER, ...NOT_PROVABLY_BEFORE })) {
    const a = ANSWERS[name]();
    assert.deepEqual(Object.keys(a.body), ['status', 'error', 'metadata', 'detail'], name);
    assert.equal(a.body.status, 'error', name);
    assert.deepEqual(a.body.detail, detail, name);
    assert.equal(a.status, status === 422 ? 400 : status, name);
    assert.match(a.body.error.code, /^[A-Z][A-Z_]+$/, `${name}: every backend error carries a code`);
  }
  // The answers that give a claim back are exactly the nine prologue refusals, each naming its code.
  assert.deepEqual(Object.values(BEFORE_ANY_ORDER).map(([status, detail]) => `${status} ${detail.error}`).sort(), [
    '400 INVALID_BUYER_CONTEXT', '400 INVALID_QUOTE', '400 QUOTE_MERCHANT_MISMATCH', '400 QUOTE_REQUIRED_BEFORE_PURCHASE', '400 VARIANT_REQUIRED',
    '404 QUOTE_NOT_FOUND', '409 PARTNER_ASSERTION_REJECTED', '409 PREFLIGHT_FAILED', '409 UNSUPPORTED_COMMERCE_PATH',
  ]);
});

// ---- a refusal before any order ------------------------------------------------------------------------------------

test('a refusal from the backend\'s prologue (400 INVALID_BUYER_CONTEXT): the call fails as before, and the same key then creates the order exactly once, in every market', each(async (caller) => {
  for (const market of MARKETS) {
    const label = `${caller} ${market}`;
    const h = await open(caller, market);
    assert.equal(h.currency, marketCurrency(market), `${label}: the session`);
    assertAnswerCurrency(JSON.parse(h.opened.raw), marketCurrency(market), `${label}: the session`);
    const before = door.orders.length;

    door.orderScript.push(ANSWERS.invalidBuyer());
    const key = freshKey();
    const first = await attempt(h, key);
    assertRefused(h, first, 'MERCHANT_UNAVAILABLE', `${label} first`);
    assert.equal(ordersAsked(first).length, 1, label);
    assert.equal(door.orders.length, before, label);

    const second = await attempt(h, key);
    assertOrdered(h, second, `${label} retry`);
    assert.equal(ordersAsked(second).length, 1, `${label}: the retry asks for the order once`);
    assert.equal(door.orders.length, before + 1, `${label}: exactly one order`);
    // Both requests carried one idempotency key, in the body and in the header.
    assert.equal(ordersAsked(second)[0].body.idempotency_key, ordersAsked(first)[0].body.idempotency_key, label);
    assert.equal(ordersAsked(second)[0].idempotencyKeyHeader, ordersAsked(first)[0].idempotencyKeyHeader, label);
    assert.equal(ordersAsked(second)[0].body.quote_id, ordersAsked(first)[0].body.quote_id, `${label}: for the same backend quote`);

    // Again with the key: the same order, nothing asked of the backend's order route.
    const third = await attempt(h, key);
    assert.equal(third.ok, true, label);
    assert.equal(third.order_id, second.order_id, label);
    assert.equal(ordersAsked(third).length, 0, label);
    // Another key on the spent session: refused, nothing asked.
    const other = await attempt(h, freshKey());
    assertRefused(h, other, 'QUOTE_ALREADY_USED', `${label} another key`);
    assert.equal(ordersAsked(other).length, 0, label);
    assert.equal(door.orders.length, before + 1, label);
  }
}));

test('every listed prologue refusal gives the session back: the next attempt, on the same key or another, is a first attempt', each(async (caller) => {
  for (const answer of Object.keys(BEFORE_ANY_ORDER)) {
    for (const sameKey of [true, false]) {
      const label = `${caller} ${answer} ${sameKey ? 'same key' : 'another key'}`;
      const h = await open(caller, 'SG');
      const before = door.orders.length;
      door.orderScript.push(ANSWERS[answer]());
      const key = freshKey();
      assertRefused(h, await attempt(h, key), firstCode(answer), `${label} first`);
      const retry = await attempt(h, sameKey ? key : freshKey());
      assertOrdered(h, retry, `${label} retry`);
      assert.equal(door.orders.length, before + 1, label);
    }
  }
}));

test('after a released refusal the retry is judged afresh: the backend\'s view of the quote, then the locked total and currency', each(async (caller) => {
  // The backend refuses again from its prologue (released again), then says the quote no longer matches from its
  // write step: relayed, no order, and from then on the session is spent.
  {
    const h = await open(caller, 'GB');
    const before = door.orders.length;
    const key = freshKey();
    door.orderScript.push(ANSWERS.preflightFailed(), ANSWERS.invalidBuyer(), ANSWERS.quoteMismatch());
    assertRefused(h, await attempt(h, key), 'MERCHANT_UNAVAILABLE', `${caller} first`);
    assertRefused(h, await attempt(h, key), 'MERCHANT_UNAVAILABLE', `${caller} second`);
    const third = await attempt(h, key);
    assertRefused(h, third, 'PRICE_CHANGED', `${caller} third`);
    assert.equal(ordersAsked(third).length, 1, caller);
    const fourth = await attempt(h, key);
    assertRefused(h, fourth, 'QUOTE_ALREADY_USED', `${caller} fourth`);
    assert.equal(ordersAsked(fourth).length, 0, caller);
    assert.equal(door.orders.length, before, caller);
  }
  // The backend makes the order at another total, or in another currency: never answered as an order, and from
  // then on nothing more is asked (an order exists).
  for (const overrides of [{ total: '19.00' }, { currency: 'USD' }, { total: null }]) {
    const label = `${caller} ${JSON.stringify(overrides)}`;
    const h = await open(caller, 'GB');
    const before = door.orders.length;
    const key = freshKey();
    door.orderScript.push(ANSWERS.preflightFailed(), ANSWERS.created(overrides));
    assertRefused(h, await attempt(h, key), 'MERCHANT_UNAVAILABLE', `${label} first`);
    const retry = await attempt(h, key);
    assertRefused(h, retry, 'PRICE_CHANGED', `${label} retry`);
    assert.equal(door.orders.length, before + 1, label);
    for (const k of [key, freshKey()]) {
      const after = await attempt(h, k);
      assert.equal(after.ok, false, `${label}: ${after.raw.slice(0, 200)}`);
      assert.equal(ordersAsked(after).length, 0, `${label}: nothing more is asked`);
      assertAnswerCurrency(JSON.parse(after.raw), marketCurrency('GB'), label);
    }
    assert.equal(door.orders.length, before + 1, label);
  }
}));

// ---- where the code and the reason are read from ------------------------------------------------------------------

test('a listed code releases only from the route\'s own detail (error.details.error): the same code in the outer error.code, or in a message, keeps the claim', each(async (caller) => {
  const meta = { timestamp: '2026-01-01T00:00:00.000000Z', request_id: null };
  const envelope = (code, message, details, detail) => ({ status: 'error', error: { code, message, details, documentation_url: 'https://docs.backend.quote-claim.test/errors' }, metadata: meta, detail });
  const KEPT = [
    // The transport reads a code from three places, in this order: details.error, the message, the outer code.
    ['only in the outer error.code', envelope('INVALID_BUYER_CONTEXT', 'Invalid request format or parameters', { message: 'placeholder' }, { message: 'placeholder' })],
    ['only in the message', envelope('INVALID_REQUEST', 'INVALID_BUYER_CONTEXT', { message: 'placeholder' }, { message: 'placeholder' })],
    ['in the message and the outer code, with prose in details.error', envelope('INVALID_BUYER_CONTEXT', 'INVALID_BUYER_CONTEXT', { error: 'the buyer context is not valid' }, 'the buyer context is not valid')],
    ['only in the outer error.code, with no details at all', { status: 'error', error: { code: 'INVALID_BUYER_CONTEXT', message: 'Invalid request format or parameters' }, metadata: meta }],
  ];
  for (const [where, body] of KEPT) {
    for (const landed of [false, true]) {
      const label = `${caller} ${where}${landed ? ' (the order was made)' : ''}`;
      const h = await open(caller, 'SG');
      const before = door.orders.length;
      door.orderScript.push(ANSWERS.raw(400, body, { landed }));
      const key = freshKey();
      const first = await attempt(h, key);
      assertRefused(h, first, 'MERCHANT_UNAVAILABLE', `${label} first`);
      assert.equal(ordersAsked(first).length, 1, label);
      for (const k of [key, freshKey()]) {
        const retry = await attempt(h, k);
        assertRefused(h, retry, 'QUOTE_ALREADY_USED', `${label} retry`);
        assert.deepEqual(retry.upstream, [], `${label}: nothing is sent`);
      }
      assert.equal(door.orders.length, before + (landed ? 1 : 0), label);
    }
  }
  // The releasing form, in the envelope and as the route's bare detail: the raise site named the code.
  for (const [where, body] of [
    ['in details.error', ANSWERS.invalidBuyer().body],
    ['in the route\'s bare detail (no envelope)', { detail: { error: 'INVALID_BUYER_CONTEXT', message: 'placeholder' } }],
  ]) {
    const h = await open(caller, 'SG');
    const before = door.orders.length;
    door.orderScript.push(ANSWERS.raw(400, body));
    const key = freshKey();
    assertRefused(h, await attempt(h, key), 'MERCHANT_UNAVAILABLE', `${caller} ${where} first`);
    assertOrdered(h, await attempt(h, key), `${caller} ${where} retry`);
    assert.equal(door.orders.length, before + 1, `${caller} ${where}`);
  }
}));

test('a refused caller assertion: nine reasons give the session back; replay, stale, no reason and an unknown reason keep it', each(async (caller) => {
  for (const reason of ['no_secret', 'malformed', 'bad_mac', 'op', 'method', 'path', 'resource', 'body', 'subject']) {
    const label = `${caller} ${reason}`;
    const h = await open(caller, 'GB');
    const before = door.orders.length;
    door.orderScript.push(ANSWERS.partnerAssertion(reason));
    const key = freshKey();
    assertRefused(h, await attempt(h, key), 'PARTNER_ASSERTION_REJECTED', `${label} first`);
    assertOrdered(h, await attempt(h, key), `${label} retry`);
    assert.equal(door.orders.length, before + 1, label);
  }
  for (const reason of ['replay', 'stale', undefined, null, '', 7, 'nonce_store_unavailable', 'PATH']) {
    const label = `${caller} reason ${JSON.stringify(reason)}`;
    const h = await open(caller, 'GB');
    const before = door.orders.length;
    // The order was made by the first copy of the request; this answer is the second copy's.
    door.orderScript.push({ ...ANSWERS.partnerAssertion(reason), landed: true });
    const key = freshKey();
    const first = await attempt(h, key);
    assertRefused(h, first, 'PARTNER_ASSERTION_REJECTED', `${label} first`);
    for (const k of [key, freshKey(), key]) {
      const retry = await attempt(h, k);
      assertRefused(h, retry, 'QUOTE_ALREADY_USED', `${label} retry`);
      assert.deepEqual(retry.upstream, [], `${label}: nothing is sent`);
    }
    assert.equal(door.orders.length, before + 1, `${label}: the one order the first copy made, never a second`);
  }
}));

// ---- everything that keeps the claim ---------------------------------------------------

const UNKNOWN = [
  // The backend's own coded answers that are not provably before an order: with nothing behind them, and with
  // the order written before the backend answered (`landed`).
  ...Object.keys(NOT_PROVABLY_BEFORE).flatMap((answer) => [[answer, {}], [answer, { landed: true }]]),
  ['timeout', {}], ['timeout', { landed: true }],
  ['connectionLost', {}], ['connectionLost', { landed: true }],
  ['connectionRefused', {}],
  ['badGateway', {}], ['gatewayTimeout', {}], ['platformUnavailable', {}],
];

test('a busy 503, a consumed quote, out of stock, every other answer not on the list, and no answer: the call fails as before, the claim is kept, and neither the same key nor another sends a second order', each(async (caller) => {
  for (const [answer, opts] of UNKNOWN) {
    const label = `${caller} ${answer}${opts.landed ? ' (the order was made)' : ''}`;
    const h = await open(caller, opts.landed ? 'SG' : 'US');
    const before = door.orders.length;
    door.orderScript.push(ANSWERS[answer](opts));
    const key = freshKey();
    const first = await attempt(h, key);
    assertRefused(h, first, firstCode(answer), `${label} first`);
    assert.equal(ordersAsked(first).length, 1, label);
    for (const k of [key, freshKey(), key]) {
      const retry = await attempt(h, k);
      assertRefused(h, retry, 'QUOTE_ALREADY_USED', `${label} retry`);
      assert.equal(ordersAsked(retry).length, 0, `${label}: no second order is asked for`);
      assert.deepEqual(retry.upstream, [], `${label}: nothing at all is sent`);
    }
    assert.equal(door.orders.length, before + (opts.landed ? 1 : 0), label);
    assert.deepEqual(door.orderScript, [], label);
  }
}));

test('an order the backend made and the gateway refused (not the quote\'s total, not its currency): never a second order', each(async (caller) => {
  for (const overrides of [{ total: '19.00' }, { currency: 'USD' }]) {
    const label = `${caller} ${JSON.stringify(overrides)}`;
    const h = await open(caller, 'SG');
    const before = door.orders.length;
    door.orderScript.push(ANSWERS.created(overrides));
    const key = freshKey();
    assertRefused(h, await attempt(h, key), 'PRICE_CHANGED', `${label} first`);
    assert.equal(door.orders.length, before + 1, label);
    for (const k of [key, freshKey(), key]) {
      const retry = await attempt(h, k);
      assert.equal(retry.ok, false, label);
      // The complete lane reads the claim first; the payment link meets its own order key first.
      assert.equal(retry.code, caller === 'mcp_payment_link' && k === key ? 'IDEMPOTENCY_CONFLICT' : 'QUOTE_ALREADY_USED', `${label}: ${retry.raw.slice(0, 200)}`);
      assert.equal(ordersAsked(retry).length, 0, label);
      assertAnswerCurrency(JSON.parse(retry.raw), marketCurrency('SG'), label);
    }
    assert.equal(door.orders.length, before + 1, label);
  }
}));

// ---- races, over HTTP ----------------------------------------------------------------------------------------------

test('two calls at once with the SAME key while the backend holds the first: one order request in flight, and after its prologue refusal one order', each(async (caller) => {
  const h = await open(caller, 'US');
  const before = door.orders.length;
  const key = freshKey();
  const held = ANSWERS.held(ANSWERS.invalidBuyer());
  door.orderScript.push(held);
  const a = attempt(h, key);
  await atBackend(held, a);
  const b = await attempt(h, key);
  assert.equal(b.ok, false, caller);
  assert.equal(b.code, 'IDEMPOTENCY_CONFLICT', `${caller}: ${b.raw.slice(0, 200)}`);
  assert.equal(ordersAsked(b).length, 0, caller);
  held.release();
  assertRefused(h, await a, 'MERCHANT_UNAVAILABLE', `${caller} first`);
  assertOrdered(h, await attempt(h, key), `${caller} retry`);
  assert.equal(door.orders.length, before + 1, caller);
}));

test('two calls at once with DIFFERENT keys on one session: the second is refused while the first is with the backend, whatever the backend then answers', each(async (caller) => {
  for (const [then, firstAnswer, sessionFree, madeByFirst] of [[ANSWERS.preflightFailed(), 'MERCHANT_UNAVAILABLE', true, 0], [ANSWERS.busy({ landed: true }), 'MERCHANT_UNAVAILABLE', false, 1], [ANSWERS.busy(), 'MERCHANT_UNAVAILABLE', false, 0], [ANSWERS.timeout({ landed: true }), 'MERCHANT_UNAVAILABLE', false, 1], [ANSWERS.created(), null, false, 1]]) {
    const label = `${caller} then ${then.kind}${then.status ? ` ${then.status}` : ''}${then.landed ? ' (order written)' : ''}`;
    const h = await open(caller, 'GB');
    const before = door.orders.length;
    const held = ANSWERS.held(then);
    door.orderScript.push(held);
    const keyA = freshKey();
    const keyB = freshKey();
    const a = attempt(h, keyA);
    await atBackend(held, a);
    const b = await attempt(h, keyB);
    assertRefused(h, b, 'QUOTE_ALREADY_USED', `${label} second`);
    assert.equal(ordersAsked(b).length, 0, label);
    held.release();
    const ra = await a;
    if (firstAnswer) assertRefused(h, ra, firstAnswer, `${label} first`);
    else assertOrdered(h, ra, `${label} first`);
    const again = await attempt(h, keyB);
    if (sessionFree) assertOrdered(h, again, `${label} second key, afterwards`);
    else {
      assertRefused(h, again, 'QUOTE_ALREADY_USED', `${label} second key, afterwards`);
      assert.equal(ordersAsked(again).length, 0, label);
    }
    assert.equal(door.orders.length, before + (sessionFree ? 1 : madeByFirst), `${label}: never two orders`);
  }
}));

// ---- what stays in front of the claim -----------------------------------------------------------------------------

test('a key the intake refuses is refused before anything is claimed or sent, and the session is still good afterwards', each(async (caller) => {
  const h = await open(caller, 'US');
  const before = door.orders.length;
  for (const key of ['short', 'k', 'abcdefg']) {
    const r = await attempt(h, key);
    assert.equal(r.ok, false, caller);
    assert.equal(r.code, 'IDEMPOTENCY_CONFLICT', `${caller} ${key}: ${r.raw.slice(0, 200)}`);
    assert.deepEqual(r.upstream, [], `${caller} ${key}: nothing is sent`);
  }
  assertOrdered(h, await attempt(h, freshKey()), `${caller} afterwards`);
  assert.equal(door.orders.length, before + 1, caller);
}));

test('a payment authorization that does not verify is refused before the claim: no order is asked for and the session is still good', async () => {
  for (const caller of ['mcp_complete', 'acp_complete']) {
    const h = await open(caller, 'SG');
    const before = door.orders.length;
    const bad = await attempt({ ...h, grant: `${h.grant.slice(0, -4)}AAAA` }, freshKey());
    assert.equal(bad.code, 'CONFIRMATION_INVALID', `${caller}: ${bad.raw.slice(0, 200)}`);
    assert.equal(ordersAsked(bad).length, 0, caller);
    assertOrdered(h, await attempt(h, freshKey()), `${caller} afterwards`);
    assert.equal(door.orders.length, before + 1, caller);
  }
});
