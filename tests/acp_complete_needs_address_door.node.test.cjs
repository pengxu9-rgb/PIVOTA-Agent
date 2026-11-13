'use strict';

// THE ACP REST DOOR, OVER REAL HTTP: A COMPLETION WITH NO ADDRESS TO SHIP TO IS REFUSED BY NAME, BEFORE ANY ORDER.
//
// WHAT WAS WRONG. An address is optional on create and on update, so a session can reach its completion with none:
// not on the quote it holds, and not on the completion request. The door passed such a completion on. The order
// lane refused it (an order needs a shipping address), and the door relayed that as 503 "temporarily unreachable":
// an answer that invites a retry which can never succeed, after an order had been asked for.
//
// THE RULE. The address an order would be created with is the session's quote's, completed by the completion
// request's. When that is not a complete address, the completion is refused 400 QUOTE_REQUIRED /
// `acp_fulfillment_address_required`, naming the missing fields and where to supply them, with NOTHING asked of the
// backend. The caller's Idempotency-Key is not used up: the same key completes the session once it has an address.
// It is the address that is required, not only a market: a session that kept its market through an update that
// dropped the address is refused the same way. The market rule answers first (a session marked for a market it is
// not priced for answers that), and every address this door accepts names a market that is then judged.
//
// The stub backend refuses an order with no address the way the real one does (tests/_support/acpMarketDoor.cjs),
// so a completion that reached it would be seen here as an order call.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/acpMarketDoor.cjs');
const { assertAnswerCurrency, collectAnswerCurrencies } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { cart, completion } = support;

let door;
let ERROR_CATALOG;
test.before(async () => {
  ({ ERROR_CATALOG } = await import('../safety-kernel/src/errors.js'));
  door = support.bootAcpMarketDoor({ port: 5735, backendPort: 5736, buyerKeys: await support.mintBuyerKeys() });
  await door.listen();
});
test.after(() => door.close());

const REQUIRED = ['name', 'address_line1', 'city', 'postal_code', 'country'];
let keySeq = 0;
const freshKey = () => { keySeq += 1; return `idem-acp-address-${String(keySeq).padStart(4, '0')}`; };
const create = (sellerCurrency, m) => door.acp('POST', '/checkout_sessions', cart(sellerCurrency, m));
const update = (id, sellerCurrency, m) => door.acp('POST', `/checkout_sessions/${id}`, cart(sellerCurrency, m, 2));
const complete = (id, m, key = freshKey()) => door.acp('POST', `/checkout_sessions/${id}/complete`, completion(m), { key });
async function created(sellerCurrency, m) {
  const answer = await create(sellerCurrency, m);
  assert.equal(answer.http, 201, answer.raw);
  return answer.body.id;
}

/** The named refusal: a client-class answer that does not invite a retry, with nothing asked of the backend. */
function assertAddressRequired(answer) {
  assert.equal(answer.http, 400, answer.raw);
  assert.equal(answer.body.type, 'error');
  assert.equal(answer.body.code, 'QUOTE_REQUIRED');
  assert.equal(ERROR_CATALOG[answer.body.code].retriable, false);
  assert.deepEqual(answer.body.detail, { reason: 'acp_fulfillment_address_required', missing_fields: REQUIRED, required_fields: REQUIRED });
  assert.match(answer.body.message, /POST \/checkout_sessions\/\{checkout_session_id\}/, 'says where to supply the address');
  assert.match(answer.body.message, /with this completion request/);
  assert.doesNotMatch(answer.body.message, /temporarily|try again shortly/i);
  assert.deepEqual(answer.backend, [], 'nothing was asked of the backend: no order, no charge');
  const found = collectAnswerCurrencies(JSON.parse(answer.raw));
  assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []]);
}
function assertPaid(answer, currency, country) {
  assert.equal(answer.http, 200, answer.raw);
  assertAnswerCurrency(JSON.parse(answer.raw), currency, 'a completed order');
  assert.equal(answer.body.order.currency, currency);
  assert.deepEqual([answer.orders.length, answer.payments.length], [1, 1]);
  assert.equal(answer.orders[0].buyer_context.shipping_address.country, country);
}
function assertMarketRefused(answer, reason, market) {
  assert.equal(answer.http, 404, answer.raw);
  assert.equal(answer.body.code, 'NO_MERCHANT_OFFER');
  assert.equal(answer.body.detail.reason, reason);
  assert.equal(answer.body.detail.market, market);
  assert.deepEqual([answer.orders, answer.payments], [[], []]);
}

test('the door is on in this boot', async () => {
  const answer = await create('USD', undefined);
  assert.equal(answer.http, 201, `the ACP routes must be mounted here: ${answer.raw}`);
});

for (const sellerCurrency of ['USD', 'SGD']) {
  const home = ['US', 'SG', 'GB'].find((m) => resolveServingCurrency(m) === sellerCurrency);

  test(`no address anywhere (a seller priced in ${sellerCurrency}): refused by name; the same key then completes with the address on the completion`, async () => {
    const id = await created(sellerCurrency, undefined);
    const key = freshKey();
    assertAddressRequired(await complete(id, undefined, key));
    // Asked again unchanged: the same answer, and still nothing asked of the backend.
    assertAddressRequired(await complete(id, undefined, key));
    assertPaid(await complete(id, home, key), sellerCurrency, home);
  });

  test(`no address anywhere (a seller priced in ${sellerCurrency}): the same key completes after an update supplies the address`, async () => {
    const id = await created(sellerCurrency, undefined);
    const key = freshKey();
    assertAddressRequired(await complete(id, undefined, key));
    assert.equal((await update(id, sellerCurrency, home)).http, 200);
    assertPaid(await complete(id, undefined, key), sellerCurrency, home);
  });

  test(`a session that kept its market (${home}) through an update that dropped the address: refused the same way, then paid with an address in that market`, async () => {
    const id = await created(sellerCurrency, home);
    assert.equal((await update(id, sellerCurrency, undefined)).http, 200);
    const key = freshKey();
    assertAddressRequired(await complete(id, undefined, key));
    assertPaid(await complete(id, home, key), sellerCurrency, home);
  });

  test(`a session created with an address in ${home} completes with no address on the completion (unchanged)`, async () => {
    assertPaid(await complete(await created(sellerCurrency, home), undefined), sellerCurrency, home);
  });

  test(`the market rule still answers for the address a completion brings (a seller priced in ${sellerCurrency})`, async () => {
    for (const m of ['US', 'SG', 'GB', 'DE', 'ZZ']) {
      const id = await created(sellerCurrency, undefined);
      const marketCurrency = resolveServingCurrency(m) || null;
      const answer = await complete(id, m);
      if (!marketCurrency) assertMarketRefused(answer, 'market_not_priced', m);
      else if (marketCurrency !== sellerCurrency) assertMarketRefused(answer, 'seller_not_priced_in_market_currency', m);
      else assertPaid(answer, sellerCurrency, m);
    }
  });
}

test('the market rule answers first: a session marked by a refused update answers the market refusal, with or without an address', async () => {
  const id = await created('USD', undefined);
  assertMarketRefused(await update(id, 'USD', 'SG'), 'seller_not_priced_in_market_currency', 'SG');
  assertMarketRefused(await complete(id, undefined), 'seller_not_priced_in_market_currency', 'SG');
  assertMarketRefused(await complete(id, 'US'), 'seller_not_priced_in_market_currency', 'SG');
});

test('a session kept in its market with no address is refused for an address in another market, and paid for one in its own', async () => {
  const id = await created('SGD', 'SG');
  assert.equal((await update(id, 'SGD', undefined)).http, 200);
  assertAddressRequired(await complete(id, undefined));
  const other = await created('SGD', 'SG');
  assert.equal((await update(other, 'SGD', undefined)).http, 200);
  assertMarketRefused(await complete(other, 'US'), 'seller_not_priced_in_market_currency', 'US');
});

test('the refusal does not mark the session: it is read as before, and can be cancelled', async () => {
  const id = await created('USD', undefined);
  assertAddressRequired(await complete(id, undefined));
  const read = await door.acp('GET', `/checkout_sessions/${id}`);
  assert.equal(read.http, 200, read.raw);
  assert.equal(read.body.currency, 'USD');
  const cancelled = await door.acp('POST', `/checkout_sessions/${id}/cancel`, {});
  assert.equal(cancelled.http, 200, cancelled.raw);
});

test('with the door off the completion route is 404 and nothing is asked of the backend', async () => {
  const id = await created('USD', undefined);
  const saved = process.env.AGENT_CHECKOUT_ACP_REST_ENABLED;
  delete process.env.AGENT_CHECKOUT_ACP_REST_ENABLED;
  try {
    const answer = await complete(id, undefined);
    assert.equal(answer.http, 404, answer.raw);
    assert.deepEqual(answer.body, { error: 'not_found' });
    assert.deepEqual(answer.backend, []);
  } finally {
    process.env.AGENT_CHECKOUT_ACP_REST_ENABLED = saved;
  }
});
