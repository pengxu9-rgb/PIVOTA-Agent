'use strict';

// THE ACP REST DOOR, OVER REAL HTTP: WHAT A SESSION THAT EXISTS IS JUDGED FOR, AND WHAT A SESSION THAT IS OVER ANSWERS.
// The companion of tests/acp_market_currency_door.node.test.cjs (the market matrix).
//
// 1. A COMPLETION IS JUDGED FOR EVERY MARKET THAT APPLIES, NONE IN PLACE OF ANOTHER. The session is paid only if
//      - the country of the address the completion carries is priced in the locked quote's currency, and
//      - that country is the market recorded on the quote, when the quote records one, and
//      - no mark blocks it (a market an earlier request named, that the session's quote is not priced for).
//    What went wrong before: a mark stood IN PLACE of the completion's own address. A mark whose currency happened
//    to be the held quote's passed every completion, wherever it shipped: paid in USD, shipped to SG. Two sequences
//    of ordinary requests reached that, and both are pinned here (the first two tests).
// 2. A MARK IS WRITTEN ONLY WHEN THE HELD QUOTE IS NOT PRICED FOR THE REFUSED MARKET. A refused update whose market
//    the held quote already satisfies (it was the update's new cart that failed) leaves the session as it was.
// 3. A SESSION THAT IS OVER (completed, cancelled) is never re-priced or marked: an update is refused by name before
//    any quote, a read answers the completed checkout or `canceled`, and a second completion never reaches a payment.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/acpMarketDoor.cjs');
const { assertAnswerCurrency, collectAnswerCurrencies } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { cart, completion, quoteMarket } = support;

let door;
test.before(async () => {
  door = support.bootAcpMarketDoor({ port: 5737, backendPort: 5738, buyerKeys: await support.mintBuyerKeys() });
  await door.listen();
});
test.after(() => door.close());

let keySeq = 0;
const freshKey = () => { keySeq += 1; return `idem-acp-session-${String(keySeq).padStart(4, '0')}`; };
const create = (sellerCurrency, m, key = freshKey()) => door.acp('POST', '/checkout_sessions', cart(sellerCurrency, m), { key });
const update = (id, sellerCurrency, m) => door.acp('POST', `/checkout_sessions/${id}`, cart(sellerCurrency, m, 2));
const read = (id) => door.acp('GET', `/checkout_sessions/${id}`);
const complete = (id, m, key = freshKey()) => door.acp('POST', `/checkout_sessions/${id}/complete`, completion(m), { key });
const cancel = (id) => door.acp('POST', `/checkout_sessions/${id}/cancel`, {});
async function created(sellerCurrency, m) {
  const answer = await create(sellerCurrency, m);
  assert.equal(answer.http, 201, answer.raw);
  return answer.body.id;
}
const currencyOf = (m) => resolveServingCurrency(m) || null;

function assertMarketRefused(answer, reason, market, { quotes = 0 } = {}) {
  assert.equal(answer.http, 404, answer.raw);
  assert.equal(answer.body.code, 'NO_MERCHANT_OFFER');
  assert.equal(answer.body.detail.reason, reason);
  assert.equal(answer.body.detail.market, market, 'the refusal names this market');
  assert.equal(answer.quotes.length, quotes);
  assert.deepEqual([answer.orders, answer.payments], [[], []], 'no order and no charge');
  assert.equal(collectAnswerCurrencies(answer.body).money.length, 0);
}
function assertPriced(answer, currency, http = 200) {
  assert.equal(answer.http, http, answer.raw);
  assertAnswerCurrency(JSON.parse(answer.raw), currency, 'a priced session');
  assert.equal(answer.body.currency, currency);
}
function assertPaid(answer, currency, country) {
  assert.equal(answer.http, 200, answer.raw);
  assertAnswerCurrency(JSON.parse(answer.raw), currency, 'a completed order');
  assert.equal(answer.body.order.currency, currency);
  assert.deepEqual([answer.orders.length, answer.payments.length], [1, 1]);
  assert.equal(answer.orders[0].buyer_context.shipping_address.country, country, 'shipped where it was priced for');
  assert.equal(currencyOf(country), currency, 'and paid in that country\'s currency');
}
function assertOver(answer, code) {
  assert.equal(answer.http, 409, answer.raw);
  assert.equal(answer.body.code, code);
  assert.deepEqual(answer.backend, [], 'nothing was priced, ordered or charged');
}

test('the door is on in this boot, and FR and FI are two markets priced in one currency', async () => {
  assert.equal((await create('USD', undefined)).http, 201);
  assert.deepEqual(['FR', 'FI'].map(currencyOf), ['EUR', 'EUR']);
});

// ---- 1. every market that applies ------------------------------------------------------------------------------

test('no address at create; an update for US with a cart priced in SGD is refused; a completion addressed to SG is refused for SG, not paid in USD', async () => {
  const id = await created('USD', undefined);
  // Refused for US: the NEW cart is priced in SGD. The quote the session holds is in USD, which US is priced in.
  assertMarketRefused(await update(id, 'SGD', 'US'), 'seller_not_priced_in_market_currency', 'US', { quotes: 1 });
  // So nothing was marked: the session is as it was.
  assertPriced(await read(id), 'USD');
  // The completion's own address is judged, in its own right.
  assertMarketRefused(await complete(id, 'SG'), 'seller_not_priced_in_market_currency', 'SG');
  // And an update that puts the session right is paid where it was priced for.
  assertPriced(await update(id, 'USD', 'US'), 'USD');
  assertPaid(await complete(id, undefined), 'USD', 'US');
});

test('created for US; the address dropped by an update; an address-less update with a cart priced in SGD refused; a completion addressed to SG is refused, not paid in USD', async () => {
  const id = await created('USD', 'US');
  const dropped = await update(id, 'USD', undefined);
  assertPriced(dropped, 'USD');
  assert.deepEqual(dropped.quotes.map(quoteMarket), ['US'], 'judged for the market the session has');
  assertMarketRefused(await update(id, 'SGD', undefined), 'seller_not_priced_in_market_currency', 'US', { quotes: 1 });
  assertPriced(await read(id), 'USD');
  assertMarketRefused(await complete(id, 'SG'), 'seller_not_priced_in_market_currency', 'SG');
  // A refused completion marks nothing: addressed to the market the session was priced for, it is paid there.
  assertPriced(await read(id), 'USD');
  assertPaid(await complete(id, 'US'), 'USD', 'US');
});

test('the controls: without the refused update, the same completions answer the same', async () => {
  assertMarketRefused(await complete(await created('USD', undefined), 'SG'), 'seller_not_priced_in_market_currency', 'SG');
  const id = await created('USD', 'US');
  assertPriced(await update(id, 'USD', undefined), 'USD');
  assertMarketRefused(await complete(id, 'SG'), 'seller_not_priced_in_market_currency', 'SG');
});

test('a mark and a completion\'s address are both judged, and the refusal names the request\'s own market first', async () => {
  const id = await created('USD', 'US');
  assertMarketRefused(await update(id, 'USD', 'SG'), 'seller_not_priced_in_market_currency', 'SG', { quotes: 1 });
  // A completion addressed elsewhere is refused for where IT is addressed, not for the market the session is marked with.
  assertMarketRefused(await complete(id, 'ZZ'), 'market_not_priced', 'ZZ');
  assertMarketRefused(await complete(id, 'GB'), 'seller_not_priced_in_market_currency', 'GB');
  // ...and neither refusal replaced the mark the refused UPDATE left: an address the quote is priced for is still
  // blocked by it, by its own name, until an update puts the session right.
  assertMarketRefused(await complete(id, 'US'), 'seller_not_priced_in_market_currency', 'SG');
  assertMarketRefused(await complete(id, undefined), 'seller_not_priced_in_market_currency', 'SG');
  assertPriced(await update(id, 'USD', 'US'), 'USD');
  assertPaid(await complete(id, undefined), 'USD', 'US');
});

test('a completion addressed to another country than the session was priced for is refused by name, even in the same currency; an update re-prices it', async () => {
  const id = await created('EUR', 'FR');
  assertPriced(await update(id, 'EUR', undefined), 'EUR'); // priced for FR, the address dropped
  const key = freshKey();
  const moved = await complete(id, 'FI', key);
  assert.equal(moved.http, 400, moved.raw);
  assert.equal(moved.body.code, 'QUOTE_REQUIRED');
  assert.deepEqual(moved.body.detail, { reason: 'market_changed_without_requote', market: 'FI', session_market: 'FR' });
  assert.deepEqual(moved.backend, [], 'no order and no charge');
  // Not a market the session cannot be paid for: nothing is marked, and its own market still completes it.
  assertPriced(await read(id), 'EUR');
  const other = await created('EUR', 'FR');
  assertPriced(await update(other, 'EUR', undefined), 'EUR');
  assertPaid(await complete(other, 'FR'), 'EUR', 'FR');
  // The update carries the new address: re-priced for FI, then paid there, under the key that was refused.
  const repriced = await update(id, 'EUR', 'FI');
  assertPriced(repriced, 'EUR');
  assert.deepEqual(repriced.quotes.map(quoteMarket), ['FI']);
  assertPaid(await complete(id, undefined, key), 'EUR', 'FI');
  // A session that holds its address: a completion naming another country is refused the same way.
  const held = await created('EUR', 'FR');
  assert.equal((await complete(held, 'FI')).body.detail.reason, 'market_changed_without_requote');
  assertPaid(await complete(held, undefined), 'EUR', 'FR');
});

test('a country is two ASCII letters: one that only upper-cases into two is refused, and nothing is asked', async () => {
  for (const country of ['ſg', 'ıt', 'uſ', 'ＵＳ']) { // long s + g, dotless i + t, u + long s, fullwidth US
    const id = await created('USD', undefined);
    for (const answer of [await create('SGD', country), await update(id, 'USD', country), await complete(id, country)]) {
      assert.equal(answer.http, 400, answer.raw);
      assert.deepEqual(answer.body.detail, { reason: 'market_invalid', rejected_field: 'fulfillment_address.country' });
      assert.deepEqual(answer.backend, []);
    }
  }
});

test('the country reaches the backend as the market code it was judged as, in the quote and in the order', async () => {
  const quoted = await create('SGD', ' sg ');
  assertPriced(quoted, 'SGD', 201);
  assert.equal(quoted.quotes[0].buyer_context.shipping_address.country, 'SG', 'the quote is sent the code, not the spelling received');
  assert.equal(quoteMarket(quoted.quotes[0]), 'SG');
  const updated = await update(quoted.body.id, 'SGD', 'Sg');
  assert.equal(updated.quotes[0].buyer_context.shipping_address.country, 'SG');
  const paid = await complete(await created('USD', undefined), 'us\n');
  assertPaid(paid, 'USD', 'US');
});

// ---- 3. a session that is over ---------------------------------------------------------------------------------

test('a completed session: an update is refused by name before any quote, it is read as completed, and it is never paid twice', async () => {
  const id = await created('USD', 'US');
  const key = freshKey();
  assertPaid(await complete(id, undefined, key), 'USD', 'US');

  // An update, for its own market or another: refused, nothing priced, nothing marked.
  for (const m of ['SG', 'US', undefined, 'ZZ']) assertOver(await update(id, 'USD', m), 'QUOTE_ALREADY_USED');
  const after = await read(id);
  assert.equal(after.http, 200, after.raw);
  assert.equal(after.body.order.id.length > 0, true, 'read as the completed checkout, with its order');
  assertAnswerCurrency(JSON.parse(after.raw), 'USD', 'the completed session');

  // A second completion: the same key replays the order, any other key is refused. Neither reaches a payment.
  const replayed = await complete(id, undefined, key);
  assert.equal(replayed.http, 200, replayed.raw);
  assert.deepEqual(replayed.backend, []);
  for (const m of [undefined, 'US', 'SG']) {
    const again = await complete(id, m);
    assert.equal(again.http, 409, again.raw);
    assert.equal(again.body.code, 'QUOTE_ALREADY_USED');
    assert.deepEqual([again.orders, again.payments], [[], []]);
  }
  // Still completed, still unmarked; and a paid order is not cancelled.
  assert.equal((await read(id)).http, 200);
  const cancelled = await cancel(id);
  assert.notEqual(cancelled.http, 200, cancelled.raw);
  assert.equal((await read(id)).body.order.id, after.body.order.id);
});

test('a cancelled session answers `canceled`: read, updated or completed, with a mark or without, and nothing is priced or paid', async () => {
  const plain = await created('USD', 'US');
  const marked = await created('USD', 'US');
  assertMarketRefused(await update(marked, 'USD', 'SG'), 'seller_not_priced_in_market_currency', 'SG', { quotes: 1 });
  assertMarketRefused(await read(marked), 'seller_not_priced_in_market_currency', 'SG');
  for (const id of [plain, marked]) {
    const done = await cancel(id);
    assert.equal(done.http, 200, done.raw);
    const after = await read(id);
    assert.equal(after.http, 200, after.raw);
    assert.deepEqual(after.body, { id, object: 'checkout_session', status: 'canceled' }, 'the cancellation, not a price and not a mark');
    assertOver(await update(id, 'USD', 'US'), 'ORDER_CANCELED');
    assertOver(await complete(id, 'US'), 'ORDER_CANCELED');
    assert.equal((await cancel(id)).http, 200, 'cancelling again is the same answer');
    assert.deepEqual((await read(id)).body.status, 'canceled');
  }
});

test('a create replayed under its key answers what the session is: completed, or canceled', async () => {
  const key = freshKey();
  const first = await create('USD', 'US', key);
  assert.equal(first.http, 201, first.raw);
  assert.equal((await cancel(first.body.id)).http, 200);
  const replay = await create('USD', 'US', key);
  assert.equal(replay.http, 200, replay.raw);
  assert.deepEqual(replay.body, { id: first.body.id, object: 'checkout_session', status: 'canceled' });
});
