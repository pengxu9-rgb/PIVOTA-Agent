'use strict';

// A FAILED ACP CREATE DOES NOT KEEP THE CALLER'S KEY (the real gateway app, offline).
//
// `POST /acp/checkout_sessions` claims the caller's Idempotency-Key before it asks the backend for a quote. A create
// the backend failed used to leave that claim behind with no session, so the retry a retriable 503 invites was
// answered 404 QUOTE_NOT_FOUND for fifteen minutes. Pinned here, through the route, the real transport and the real
// error mapping (safety-kernel/test/acpCreateClaimRelease.test.js holds every interleaving, on an injected clock):
//   - the backend ANSWERS an error: the door's answer is what it was, and the same key is a first create at once,
//     with exactly one quote behind the one session; the third call replays it and sends nothing anywhere;
//   - the backend does NOT answer (the deadline passes, the connection is lost): the door's answer is what it was;
//     the same key is told the outcome is unknown and asks nothing more of the backend, until the claim's lease
//     ends; then it is a first create;
//   - two creates under one key while the first is being priced: one quote request, one session.
// The cart ships to US, SG and GB (priced in that market's currency by the stub backend, from the gateway's own
// market source), to DE (the stub backend refuses a market it has no currency for, by name) and to nowhere named.

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./_support/intakeKeyQtyDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

let door;

test.before(async () => {
  door = fx.bootDoor({ port: 5471, buyerKeys: await fx.mintBuyerKeys() });
  await door.listen();
});
test.after(async () => { if (door) await door.close(); });
// A scripted answer a failed test did not use is not left for the next test's request.
test.beforeEach(() => { door.quoteScript.length = 0; });

const LEASE_MS = 2 * 60 * 1000;
const UNAVAILABLE = { type: 'error', code: 'MERCHANT_UNAVAILABLE', message: 'The merchant is temporarily unreachable. Please try again shortly.' };
const OUTCOME_UNKNOWN = {
  type: 'error', code: 'CHECKOUT_OUTCOME_UNKNOWN',
  message: 'The checkout request may have been accepted. Its outcome is unknown. Keep the same request and reference when checking again; do not start another purchase.',
};

let keySeq = 0;
const freshKey = () => { keySeq += 1; return `idem-claim-${String(keySeq).padStart(4, '0')}`; };
const quoteRequests = (r) => r.upstream.filter((c) => c.path === '/agent/v2/quotes/preview');
/** The connected merchant's cart. `market` null = the cart names no destination. */
const cartFor = (market, quantity = 1) => ({
  ...fx.acpCart(quantity),
  ...(market === null ? {} : {
    fulfillment_address: { name: 'Example Buyer', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000', country: market },
  }),
});
const create = (market, key, quantity) => door.acp('POST', '/checkout_sessions', cartFor(market, quantity), { key });

// THE STUB BACKEND'S PRICING BY MARKET. The fixture prices the merchant's cart in USD. A cart that names a
// destination is priced in that market's currency, read from the gateway's one market source; a market that source
// has no currency for is refused by name. A cart that names no destination keeps the fixture's answer.
const MARKET_NOT_PRICED = 'MARKET_NOT_PRICED';
const priceForMarket = (body, priced) => {
  const country = body.buyer_context && body.buyer_context.shipping_address && body.buyer_context.shipping_address.country;
  if (!country) return priced();
  const currency = resolveServingCurrency(country);
  if (!currency) return [422, { detail: { code: MARKET_NOT_PRICED, market: country } }];
  const [status, answer] = priced();
  return [status, { ...answer, currency }];
};
const expectedCurrency = (market) => (market === null ? 'USD' : resolveServingCurrency(market));

function assertSession(r, http, market, label) {
  assert.equal(r.http, http, `${label}: ${r.raw.slice(0, 300)}`);
  assert.equal(r.body.object, 'checkout_session', label);
  assert.equal(r.body.currency, expectedCurrency(market), `${label}: priced in the request market's currency`);
  assertAnswerCurrency(r.body, expectedCurrency(market), label);
  return r.body.id;
}

for (const market of ['US', 'SG', 'GB', null]) {
  test(`ACP REST, market ${market}: the backend answers 503; the same key then creates one session with one quote, and replays it`, async () => {
    const key = freshKey();
    door.quoteScript.push(() => [503, { detail: 'placeholder outage' }]);
    const failed = await create(market, key);
    assert.equal(failed.http, 503, failed.raw.slice(0, 300));
    assert.deepEqual(failed.body, UNAVAILABLE, 'the failure itself is answered as it always was');
    assert.equal(quoteRequests(failed).length, 1);

    door.quoteScript.push(priceForMarket);
    const created = await create(market, key);
    const id = assertSession(created, 201, market, 'the retry is a first create');
    assert.equal(quoteRequests(created).length, 1, 'exactly one quote for the session');

    const again = await create(market, key);
    assert.equal(assertSession(again, 200, market, 'the replay'), id, 'the same session');
    assert.deepEqual(again.upstream, [], 'a replay sends nothing to the backend');
    assert.deepEqual(again.store, []);
    const read = await door.acp('GET', `/checkout_sessions/${id}`, undefined, {});
    assert.equal(assertSession(read, 200, market, 'the read'), id);
  });
}

test('ACP REST, market DE: the backend refuses the market by name; nothing is priced, and the key is a first create afterwards', async () => {
  const key = freshKey();
  assert.equal(resolveServingCurrency('DE'), null, 'the market source has no currency for this market');
  door.quoteScript.push(priceForMarket);
  const refused = await create('DE', key);
  assert.equal(refused.http, 503, refused.raw.slice(0, 300));
  assert.deepEqual(refused.body, UNAVAILABLE, 'this door relays the backend\'s refusal as it always did');
  assertAnswerCurrency(refused.body, null, 'a refusal states no price');
  assert.equal(quoteRequests(refused)[0].body.buyer_context.shipping_address.country, 'DE', 'the backend was asked for the market the request named');
  door.quoteScript.push(priceForMarket);
  const sameAgain = await create('DE', key);
  assert.equal(sameAgain.http, 503, 'the same market under the same key is asked, and refused, again');
  assert.equal(quoteRequests(sameAgain).length, 1);
  door.quoteScript.push(priceForMarket);
  assertSession(await create('GB', key), 201, 'GB', 'the same key, a priced market');
});

const ANSWERED = [
  ['500', () => [500, { detail: 'placeholder' }], 503, 'MERCHANT_UNAVAILABLE'],
  ['502', () => [502, 'bad gateway'], 503, 'MERCHANT_UNAVAILABLE'],
  ['504', () => [504, 'gateway timeout'], 503, 'MERCHANT_UNAVAILABLE'],
  ['429', () => [429, { detail: 'placeholder' }], 503, 'MERCHANT_UNAVAILABLE'],
  ['422 with a refusal code', () => [422, { detail: { code: 'PLACEHOLDER_REFUSAL' } }], 503, 'MERCHANT_UNAVAILABLE'],
  ['409 OUT_OF_STOCK', () => [409, { error: { code: 'OUT_OF_STOCK', message: 'OUT_OF_STOCK' } }], 409, 'OUT_OF_STOCK'],
  ['200 with no pricing', () => [200, { quote_id: 'q_placeholder', currency: 'USD' }], 503, 'MERCHANT_UNAVAILABLE'],
];
for (const [name, step, http, code] of ANSWERED) {
  test(`ACP REST: the backend answers ${name}: ${http} ${code}, and the same key is usable at once`, async () => {
    const key = freshKey();
    door.quoteScript.push(step);
    const failed = await create('SG', key, 2);
    assert.equal(failed.http, http, failed.raw.slice(0, 300));
    assert.equal(failed.body.code, code);
    assert.equal(quoteRequests(failed).length, 1, 'asked once, not retried by the transport');
    door.quoteScript.push(priceForMarket);
    const created = await create('SG', key, 2);
    const id = assertSession(created, 201, 'SG', 'the retry');
    assert.equal(created.body.totals.total, 2 * fx.CONNECTED_UNIT_MINOR);
    const again = await create('SG', key, 2);
    assert.equal(assertSession(again, 200, 'SG', 'the replay'), id);
    assert.deepEqual(again.upstream, []);
  });
}

const failWith = (message, code) => () => Object.assign(new Error(message), { code });
const NOT_ANSWERED = [
  ['the deadline passes', failWith('timeout of 60000ms exceeded', 'ECONNABORTED')],
  ['the socket times out', failWith('connect ETIMEDOUT', 'ETIMEDOUT')],
  ['the connection is reset', failWith('socket hang up', 'ECONNRESET')],
];
for (const [name, step] of NOT_ANSWERED) {
  test(`ACP REST: the backend does not answer (${name}): the key is held for the lease and asks nothing more, then is a first create`, async (t) => {
    const key = freshKey();
    door.quoteScript.push(step);
    const failed = await create('GB', key);
    assert.equal(failed.http, 503, failed.raw.slice(0, 300));
    assert.deepEqual(failed.body, UNAVAILABLE, 'the failure itself is answered as it always was');
    assert.equal(quoteRequests(failed).length, 1);

    for (const [label, market, quantity] of [['the same request', 'GB', 1], ['another cart', 'US', 3]]) {
      const held = await create(market, key, quantity);
      assert.equal(held.http, 409, `${label}: ${held.raw.slice(0, 300)}`);
      assert.deepEqual(held.body, OUTCOME_UNKNOWN, label);
      assert.deepEqual(held.upstream, [], `${label}: nothing more is asked of the backend`);
    }

    // The clock the gateway reads, moved past the claim's lease. Only `Date` is replaced: no timer waits on it.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + LEASE_MS + 1 });
    door.quoteScript.push(priceForMarket);
    const created = await create('GB', key);
    const id = assertSession(created, 201, 'GB', 'after the lease');
    assert.equal(quoteRequests(created).length, 1);
    const again = await create('GB', key);
    assert.equal(assertSession(again, 200, 'GB', 'the replay'), id, 'one session for the key');
    assert.deepEqual(again.upstream, []);
  });
}

/** A quote request that waits inside the stub backend until the test lets it go. */
function heldQuote() {
  let enter;
  let open;
  const entered = new Promise((resolve) => { enter = resolve; });
  const opened = new Promise((resolve) => { open = resolve; });
  const step = async (body, priced) => { enter(); return (await opened)(body, priced); };
  /** Wait until `request` is inside the stub backend. One answered without reaching it fails here, at once. */
  const reachedBy = (request) => Promise.race([
    entered,
    request.then((r) => { throw new Error(`answered without reaching the backend: ${r.http} ${r.raw.slice(0, 200)}`); }),
  ]);
  return { step, reachedBy, open };
}

test('ACP REST: a second create under the key while the first is being priced sends nothing; one quote, one session', async () => {
  const key = freshKey();
  const held = heldQuote();
  door.quoteScript.push(held.step);
  const first = create('SG', key);
  try {
    await held.reachedBy(first);
    const second = await create('SG', key);
    assert.equal(second.http, 409, second.raw.slice(0, 300));
    assert.deepEqual(second.body, OUTCOME_UNKNOWN);
    assert.equal(quoteRequests(second).length, 0, 'the second create asked the backend for nothing');
  } finally {
    held.open(priceForMarket); // always: a held request would keep the listener from closing
  }
  const id = assertSession(await first, 201, 'SG', 'the first create');
  const again = await create('SG', key);
  assert.equal(assertSession(again, 200, 'SG', 'the second create, again'), id);
  assert.deepEqual(again.upstream, []);
});

test('ACP REST: the first create fails cleanly while a second is refused; the next try creates the one session', async () => {
  const key = freshKey();
  const held = heldQuote();
  door.quoteScript.push(held.step);
  const first = create('US', key);
  try {
    await held.reachedBy(first);
    assert.deepEqual((await create('US', key)).body, OUTCOME_UNKNOWN);
  } finally {
    held.open(() => [503, { detail: 'placeholder outage' }]);
  }
  const failed = await first;
  assert.equal(failed.http, 503, failed.raw.slice(0, 300));
  assert.deepEqual(failed.body, UNAVAILABLE);
  door.quoteScript.push(priceForMarket);
  const created = await create('US', key);
  const id = assertSession(created, 201, 'US', 'after the first failed');
  assert.equal(quoteRequests(created).length, 1);
  assert.equal(assertSession(await create('US', key), 200, 'US', 'the replay'), id);
});
