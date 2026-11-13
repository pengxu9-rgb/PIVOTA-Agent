'use strict';

// THE ACP REST DOOR, MARKET BY MARKET, OVER REAL HTTP: a priced answer for a known buyer market is in that market's
// currency, or the request is refused by name. The companion of tests/kernel_row_market_currency_door.node.test.cjs
// (the `/mcp` door's rows Pivota prices itself), for the door whose requests name the market another way.
//
// WHAT WAS WRONG. This door read no market at all. The pricing engine answers in the SELLER's currency whatever
// market a request names, so a buyer whose fulfillment address is in SG or GB was answered 201 in USD by a seller
// priced in USD, a market this gateway prices nothing in (DE, an unassigned code) was priced like any other, and
// such a session could be completed: money taken in a currency nobody had judged against the buyer's country.
//
// THE MARKET ON THIS DOOR is the `country` of the fulfillment address, which create and update may omit.
//
// THE MATRIX. markets US, SG, GB, DE, ZZ, none  x  a seller priced in USD and one priced in SGD
//   x  create
//      update (of a session created with no address, and of one created in the seller's own market; then the
//              session is read and completed)
//      complete carrying the address (on a session created with no address, and on one created in the seller's
//              own market)                                                                          = 60 cells.
// Each cell says what the door answers AND what it asked of the backend. A priced answer is walked whole
// (assertAnswerCurrency, tests/_support/answerCurrencies.cjs) against the currency the gateway's one market ->
// currency source (`resolveServingCurrency`, src/services/buyerMarket.js) gives. This file keeps no market table.
//
// ONE KIND OF CELL IS NOT "PRICED IN THE MARKET'S CURRENCY OR REFUSED BY NAME", pinned as what it is: NO ADDRESS ON
// A SESSION THAT NEVER HAD A MARKET. Create, and an update of such a session, are priced in the seller's own
// currency, nothing assumed, the quote carrying no market (the decided behaviour for a checkout that names no
// market). A session with no address is not paid without one: that is not this door's judgement to make and takes
// no money here (the order needs an address, and the backend refuses it).
// An update with no address on a session that HAS a market does not take the market away: it is judged for it.
//
// The switches of the other checkout doors (the `/mcp` storefront path, the currency rule) are OFF in this file's
// boot: on this door the rule is not behind them.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/acpMarketDoor.cjs');
const { assertAnswerCurrency, collectAnswerCurrencies } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { cart, completion, quoteMarket, SELLER_OF, UNIT_MINOR } = support;

let door;
let ERROR_CATALOG;
test.before(async () => {
  ({ ERROR_CATALOG } = await import('../safety-kernel/src/errors.js'));
  door = support.bootAcpMarketDoor({ port: 5731, backendPort: 5732, buyerKeys: await support.mintBuyerKeys() });
  await door.listen();
});
test.after(() => door.close());

const MARKETS = Object.freeze(['US', 'SG', 'GB', 'DE', 'ZZ', undefined]);
const SELLER_CURRENCIES = Object.freeze(['USD', 'SGD']);
const label = (m) => (m === undefined ? 'none' : m);
// The market a seller's own currency is the currency of: found in the source, never written here.
const homeOf = (sellerCurrency) => MARKETS.find((m) => m !== undefined && resolveServingCurrency(m) === sellerCurrency);

/** What the rule says about a seller priced in `sellerCurrency` and a buyer in `m`. */
function ruleFor(sellerCurrency, m) {
  if (m === undefined) return { kind: 'no_market' };
  const marketCurrency = resolveServingCurrency(m) || null;
  if (!marketCurrency) return { kind: 'refused', reason: 'market_not_priced', detail: { reason: 'market_not_priced', market: m } };
  if (marketCurrency !== sellerCurrency) {
    return { kind: 'refused', reason: 'seller_not_priced_in_market_currency', detail: { reason: 'seller_not_priced_in_market_currency', market: m, market_currency: marketCurrency, seller_currencies: [sellerCurrency] } };
  }
  return { kind: 'priced', marketCurrency };
}

const create = (sellerCurrency, m, options) => door.acp('POST', '/checkout_sessions', cart(sellerCurrency, m), options);
const update = (id, sellerCurrency, m, quantity = 2) => door.acp('POST', `/checkout_sessions/${id}`, cart(sellerCurrency, m, quantity));
const read = (id) => door.acp('GET', `/checkout_sessions/${id}`);
const complete = (id, m) => door.acp('POST', `/checkout_sessions/${id}/complete`, completion(m));
const cancel = (id) => door.acp('POST', `/checkout_sessions/${id}/cancel`, {});
async function created(sellerCurrency, m) {
  const answer = await create(sellerCurrency, m);
  assert.equal(answer.http, 201, answer.raw);
  return answer.body.id;
}

/** A priced session answer: every money field in `currency`, the amounts the quote's own. */
function assertPricedSession(answer, currency, { http = 200, quantity = 1 } = {}) {
  assert.equal(answer.http, http, answer.raw);
  assertAnswerCurrency(JSON.parse(answer.raw), currency, 'a priced session');
  assert.equal(answer.body.currency, currency);
  assert.deepEqual(answer.body.totals, { subtotal: UNIT_MINOR * quantity, tax: 0, shipping: 0, total: UNIT_MINOR * quantity }, 'nothing is converted');
  assert.ok(collectAnswerCurrencies(answer.body).money.length > 0, 'a price is stated');
}
/** A completion that took the money: one order, one charge, the order in `currency`. */
function assertPaid(answer, currency) {
  assert.equal(answer.http, 200, answer.raw);
  assertAnswerCurrency(JSON.parse(answer.raw), currency, 'a completed order');
  assert.equal(answer.body.order.currency, currency);
  assert.deepEqual([answer.orders.length, answer.payments.length], [1, 1]);
}
/** One of the two market refusals, by name: no price anywhere in it, non-retriable, no order and no charge. */
function assertRefused(answer, rule, { quotes = 0 } = {}) {
  assert.equal(answer.http, 404, answer.raw);
  assert.equal(answer.body.type, 'error');
  assert.equal(answer.body.code, 'NO_MERCHANT_OFFER');
  assert.equal(ERROR_CATALOG[answer.body.code].retriable, false, 'not an answer that invites a retry');
  assert.deepEqual(answer.body.detail, rule.detail, 'the refusal is named, with the market');
  assert.ok(answer.body.message.includes(rule.detail.market));
  assert.doesNotMatch(answer.body.message, /temporarily|try again shortly/i);
  const found = collectAnswerCurrencies(JSON.parse(answer.raw));
  assert.deepEqual([found.money, found.priceCurrencies, found.textMoney], [[], [], []], 'no price, no price label and no money in text');
  assert.equal(answer.quotes.length, quotes, 'the quotes the backend was asked for');
  assert.deepEqual([answer.orders, answer.payments], [[], []], 'no order and no charge');
  if (rule.reason === 'market_not_priced') assert.deepEqual(answer.backend, [], 'nothing at all was asked of the backend');
}

test('the door is on in this boot, and the source prices US, SG and GB and has no currency for DE or ZZ', async () => {
  const answer = await create('USD', undefined);
  assert.equal(answer.http, 201, `the ACP routes must be mounted here: ${answer.raw}`);
  assert.deepEqual(['US', 'SG', 'GB', 'DE', 'ZZ'].map((code) => resolveServingCurrency(code) || null), ['USD', 'SGD', 'GBP', null, null]);
  assert.deepEqual(SELLER_CURRENCIES.map(homeOf), ['US', 'SG']);
  for (const flag of ['AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED', 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET']) assert.equal(process.env[flag], undefined, flag);
});

// ---- the matrix ------------------------------------------------------------------------------------------------

for (const sellerCurrency of SELLER_CURRENCIES) for (const m of MARKETS) {
  const rule = ruleFor(sellerCurrency, m);
  const says = rule.kind === 'refused' ? `refused ${rule.reason}` : rule.kind === 'priced' ? `priced in ${rule.marketCurrency}` : `priced in ${sellerCurrency}, not judged`;
  const cell = `a seller priced in ${sellerCurrency}, market ${label(m)}`;

  test(`create | ${cell}: ${says}`, async () => {
    const answer = await create(sellerCurrency, m);
    if (rule.kind === 'refused') {
      assertRefused(answer, rule, { quotes: rule.reason === 'market_not_priced' ? 0 : 1 });
      assert.deepEqual(answer.quotes.map(quoteMarket), rule.reason === 'market_not_priced' ? [] : [m], 'the one quote carried the market');
      return;
    }
    assertPricedSession(answer, sellerCurrency, { http: 201 });
    assert.deepEqual(answer.backend.map((c) => c.path), ['/agent/v2/quotes/preview'], 'one quote, nothing else');
    assert.deepEqual(answer.quotes.map(quoteMarket), [m === undefined ? null : m], 'the quote carries the market of the address, and none when there is no address');
  });

  for (const from of [undefined, homeOf(sellerCurrency)]) {
    // An update with no address does not take the session's market away: it is judged for the market the session
    // was created for, and its quote carries that market.
    const keepsMarket = m === undefined && from !== undefined;
    test(`update | a session created in ${label(from)} | ${cell}: ${keepsMarket ? `priced in ${sellerCurrency}, judged for ${from}` : says}`, async () => {
      const id = await created(sellerCurrency, from);
      const answer = await update(id, sellerCurrency, m);
      if (rule.kind === 'refused') {
        assertRefused(answer, rule, { quotes: rule.reason === 'market_not_priced' ? 0 : 1 });
        // WHAT THE REFUSED UPDATE LEFT BEHIND: the session still holds the quote it had, and it is now read and
        // completed only against the market that update named. It answers the same refusal and cannot be paid,
        // whatever address a completion carries.
        assertRefused(await read(id), rule);
        assertRefused(await complete(id, undefined), rule);
        assertRefused(await complete(id, homeOf(sellerCurrency)), rule);
        // An update for a market the seller is priced in puts the session right, and it is then paid in that
        // market's currency, to that market.
        const home = homeOf(sellerCurrency);
        assertPricedSession(await update(id, sellerCurrency, home, 3), sellerCurrency, { quantity: 3 });
        assertPricedSession(await read(id), sellerCurrency, { quantity: 3 });
        const paid = await complete(id, undefined);
        assertPaid(paid, sellerCurrency);
        assert.equal(paid.orders[0].buyer_context.shipping_address.country, home);
        return;
      }
      assertPricedSession(answer, sellerCurrency, { quantity: 2 });
      assert.deepEqual(answer.quotes.map(quoteMarket), [m === undefined ? (from === undefined ? null : from) : m], 'the quote carries the update\'s market, else the session\'s, else none');
      assertPricedSession(await read(id), sellerCurrency, { quantity: 2 });
      const done = await complete(id, undefined);
      if (rule.kind === 'priced') {
        assertPaid(done, sellerCurrency);
        assert.equal(done.orders[0].buyer_context.shipping_address.country, m);
        return;
      }
      // No address on the session (the update dropped it, or there never was one) and none on the completion: no
      // money is taken. The refusal is the backend's (an order needs an address), relayed as this door relays any
      // backend refusal.
      assert.equal(rule.kind, 'no_market');
      assert.ok(done.http >= 400, done.raw);
      assert.deepEqual(done.payments, [], 'no charge');
      assert.equal(collectAnswerCurrencies(done.body).money.length, 0, 'no price is stated');
    });

    test(`complete carrying the address | a session created in ${label(from)} | ${cell}: ${rule.kind === 'no_market' && from !== undefined ? `paid in ${sellerCurrency}` : rule.kind === 'no_market' ? 'no money taken' : says}`, async () => {
      const id = await created(sellerCurrency, from);
      const answer = await complete(id, m);
      if (rule.kind === 'refused') {
        assertRefused(answer, rule);
        // A completion refused for its market leaves the same mark a refused update does: the session is not
        // completable with another address afterwards, only after an update that succeeds.
        assertRefused(await complete(id, homeOf(sellerCurrency)), rule);
        assertRefused(await read(id), rule);
        return;
      }
      if (rule.kind === 'priced' || from !== undefined) {
        // The market is known (this address, or the one the session was created with) and was judged.
        assertPaid(answer, sellerCurrency);
        assert.equal(answer.orders[0].buyer_context.shipping_address.country, m === undefined ? from : m);
        return;
      }
      assert.ok(answer.http >= 400, answer.raw);
      assert.deepEqual(answer.payments, [], 'no charge');
    });
  }
}

// ---- in detail -----------------------------------------------------------------------------------------------

test('GB is priced for a seller priced in GBP, and refused for the other two, naming their currencies', async () => {
  const priced = await create('GBP', 'GB');
  assertPricedSession(priced, resolveServingCurrency('GB'), { http: 201 });
  assert.deepEqual(priced.quotes.map(quoteMarket), ['GB']);
  assertPaid(await complete(priced.body.id, undefined), 'GBP');
  for (const sellerCurrency of SELLER_CURRENCIES) assertRefused(await create(sellerCurrency, 'GB'), ruleFor(sellerCurrency, 'GB'), { quotes: 1 });
});

test('a country is read in any letter case and with space around it, and travels upper-cased', async () => {
  const answer = await create('SGD', ' sg ');
  assertPricedSession(answer, 'SGD', { http: 201 });
  assert.deepEqual(answer.quotes.map(quoteMarket), ['SG']);
  assertRefused(await create('USD', 'gb'), ruleFor('USD', 'GB'), { quotes: 1 });
  assertRefused(await create('USD', 'de'), ruleFor('USD', 'DE'));
});

test('a country that is not two letters is refused by name on create, update and complete: nothing asked, nothing echoed, nothing marked', async () => {
  for (const country of ['Singapore', 'S1', 'USA']) {
    const id = await created('USD', 'US');
    for (const answer of [await create('USD', country), await update(id, 'USD', country), await complete(id, country)]) {
      assert.equal(answer.http, 400, answer.raw);
      assert.equal(answer.body.code, 'QUOTE_REQUIRED');
      assert.deepEqual(answer.body.detail, { reason: 'market_invalid', rejected_field: 'fulfillment_address.country' });
      assert.equal(answer.raw.includes(country), false, 'the value is not echoed');
      assert.deepEqual(answer.backend, []);
    }
    // Not a market refusal: the session is as it was, and is paid for the market it was priced for.
    assertPricedSession(await read(id), 'USD');
    assertPaid(await complete(id, undefined), 'USD');
  }
});

test('a market nothing is priced for is refused before the variant read and before the key is claimed', async () => {
  const body = cart('USD', 'DE');
  delete body.items[0].variant_id; // a line that names no variant costs a product read, when it gets that far
  const key = 'idem-acp-market-de-then-us';
  const refused = await door.acp('POST', '/checkout_sessions', body, { key });
  assertRefused(refused, ruleFor('USD', 'DE'));
  // The same key is a first create afterwards: the refusal claimed nothing.
  const retried = await door.acp('POST', '/checkout_sessions', cart('USD', 'US'), { key });
  assertPricedSession(retried, 'USD', { http: 201 });
});

test('a create refused on the quote\'s currency gives the key back: the same key with an address the seller is priced for is a first create', async () => {
  const key = 'idem-acp-market-sg-then-us';
  assertRefused(await door.acp('POST', '/checkout_sessions', cart('USD', 'SG'), { key }), ruleFor('USD', 'SG'), { quotes: 1 });
  const retried = await door.acp('POST', '/checkout_sessions', cart('USD', 'US'), { key });
  assertPricedSession(retried, 'USD', { http: 201 });
  assert.equal(retried.quotes.length, 1, 'one quote for the session');
  const replayed = await door.acp('POST', '/checkout_sessions', cart('USD', 'US'), { key });
  assertPricedSession(replayed, 'USD');
  assert.equal(replayed.body.id, retried.body.id);
  assert.deepEqual(replayed.backend, []);
});

test('a create replayed under its key answers what the session answers: the refusal while it is marked, the session once it is put right', async () => {
  const key = 'idem-acp-market-replayed-create';
  const first = await door.acp('POST', '/checkout_sessions', cart('USD', undefined), { key });
  assert.equal(first.http, 201, first.raw);
  const id = first.body.id;
  assertRefused(await update(id, 'USD', 'SG'), ruleFor('USD', 'SG'), { quotes: 1 });
  assertRefused(await door.acp('POST', '/checkout_sessions', cart('USD', undefined), { key }), ruleFor('USD', 'SG'));
  assertPricedSession(await update(id, 'USD', 'US'), 'USD', { quantity: 2 });
  const replayed = await door.acp('POST', '/checkout_sessions', cart('USD', undefined), { key });
  assertPricedSession(replayed, 'USD', { quantity: 2 });
  assert.equal(replayed.body.id, id);
  assert.deepEqual(replayed.backend, []);
});

// ---- an update and the session's market ----------------------------------------------------------------------------

test('an update with no address on a marked session is judged for the mark: refused, and the mark stays', async () => {
  const id = await created('USD', 'US');
  assertRefused(await update(id, 'USD', 'SG'), ruleFor('USD', 'SG'), { quotes: 1 });
  const answer = await update(id, 'USD', undefined);
  assertRefused(answer, ruleFor('USD', 'SG'), { quotes: 1 });
  assert.deepEqual(answer.quotes.map(quoteMarket), ['SG'], 'the re-quote was asked for the market the session is marked with');
  assertRefused(await read(id), ruleFor('USD', 'SG'));
  assertRefused(await complete(id, 'US'), ruleFor('USD', 'SG'));
});

test('an update with no address cannot move a session out of its market: another seller\'s currency is refused for the market it has', async () => {
  // Created for SG, priced in SGD. The update drops the address and names a seller priced in USD.
  const id = await created('SGD', 'SG');
  const moved = await update(id, 'USD', undefined);
  assertRefused(moved, ruleFor('USD', 'SG'), { quotes: 1 });
  assert.deepEqual(moved.quotes.map(quoteMarket), ['SG']);
  // Nothing was recorded for the refused update: the session is still the SG one, priced in SGD, and is read
  // and paid as that. It was never in USD.
  assertPricedSession(await read(id), 'SGD');
  const paid = await complete(id, undefined);
  assertPaid(paid, 'SGD');
  assert.equal(paid.orders[0].buyer_context.shipping_address.country, 'SG');
});

test('an update with no address keeps the session\'s market: priced for it, and a completion elsewhere is refused', async () => {
  const id = await created('SGD', 'SG');
  const kept = await update(id, 'SGD', undefined);
  assertPricedSession(kept, 'SGD', { quantity: 2 });
  assert.deepEqual(kept.quotes.map(quoteMarket), ['SG']);
  assertRefused(await complete(id, 'US'), ruleFor('SGD', 'US'));
  const other = await created('SGD', 'SG');
  assertPricedSession(await update(other, 'SGD', undefined), 'SGD', { quantity: 2 });
  const paid = await complete(other, 'SG');
  assertPaid(paid, 'SGD');
  assert.equal(paid.orders[0].buyer_context.shipping_address.country, 'SG');
});

test('an address change is judged for the NEW country, in both directions, and the session\'s market follows it', async () => {
  // SG (SGD) -> US with a seller priced in USD -> back to SG with the seller priced in SGD.
  const id = await created('SGD', 'SG');
  const toUs = await update(id, 'USD', 'US');
  assertPricedSession(toUs, 'USD', { quantity: 2 });
  assert.deepEqual(toUs.quotes.map(quoteMarket), ['US']);
  assertPricedSession(await read(id), 'USD', { quantity: 2 });
  // The session's market is now US: an update with no address is judged for US, not for the SG it was created in.
  const kept = await update(id, 'USD', undefined, 3);
  assertPricedSession(kept, 'USD', { quantity: 3 });
  assert.deepEqual(kept.quotes.map(quoteMarket), ['US']);
  assertRefused(await update(id, 'SGD', undefined), ruleFor('SGD', 'US'), { quotes: 1 });
  const toSg = await update(id, 'SGD', 'SG', 4);
  assertPricedSession(toSg, 'SGD', { quantity: 4 });
  assert.deepEqual(toSg.quotes.map(quoteMarket), ['SG']);
  assertPaid(await complete(id, undefined), 'SGD');
  // The same seller, the address moved to a market it is not priced for: refused for the new country in each direction.
  assertRefused(await update(await created('USD', 'US'), 'USD', 'SG'), ruleFor('USD', 'SG'), { quotes: 1 });
  assertRefused(await update(await created('SGD', 'SG'), 'SGD', 'US'), ruleFor('SGD', 'US'), { quotes: 1 });
});

test('a refused address change leaves the session the market it had: once put right, an update with no address is judged for the old market', async () => {
  const id = await created('USD', 'US');
  assertRefused(await update(id, 'USD', 'SG'), ruleFor('USD', 'SG'), { quotes: 1 });
  assertPricedSession(await update(id, 'USD', 'US'), 'USD', { quantity: 2 });
  const kept = await update(id, 'USD', undefined, 3);
  assertPricedSession(kept, 'USD', { quantity: 3 });
  assert.deepEqual(kept.quotes.map(quoteMarket), ['US'], 'US, as before the refused change: SG was never recorded');
});

test('a session created with no address gets a market only from an address: an update with none is priced, not judged', async () => {
  const id = await created('SGD', undefined);
  const still = await update(id, 'SGD', undefined);
  assertPricedSession(still, 'SGD', { quantity: 2 });
  assert.deepEqual(still.quotes.map(quoteMarket), [null]);
  assertPricedSession(await update(id, 'SGD', 'SG', 3), 'SGD', { quantity: 3 });
  // From here it has one, and keeps it.
  const kept = await update(id, 'SGD', undefined, 4);
  assert.deepEqual(kept.quotes.map(quoteMarket), ['SG']);
});

test('a session marked by a refused update can still be cancelled', async () => {
  const id = await created('USD', 'US');
  assertRefused(await update(id, 'USD', 'ZZ'), ruleFor('USD', 'ZZ'));
  const answer = await cancel(id);
  assert.equal(answer.http, 200, answer.raw);
  assert.equal(answer.body.status, 'canceled');
});

test('a refused completion releases its key: the same key completes the session once an update has put it right', async () => {
  const id = await created('USD', undefined);
  const key = 'idem-acp-market-complete-retry';
  assertRefused(await door.acp('POST', `/checkout_sessions/${id}/complete`, completion('SG'), { key }), ruleFor('USD', 'SG'));
  assertPricedSession(await update(id, 'USD', 'US'), 'USD', { quantity: 2 });
  assertPaid(await door.acp('POST', `/checkout_sessions/${id}/complete`, completion(undefined), { key }), 'USD');
});

test('the quote request is the one it was, plus the market: nothing else is added, and never the market\'s currency', async () => {
  const strip = (quoteBody) => { const { request_context: rc, ...rest } = quoteBody; const { request_id: _id, country, ...context } = rc; return { ...rest, request_context: context, country: country === undefined ? null : country }; };
  const named = await create('USD', 'US');
  const unnamed = await create('USD', undefined);
  const { buyer_context: namedBuyer, ...namedRest } = strip(named.quotes[0]);
  const { buyer_context: unnamedBuyer, ...unnamedRest } = strip(unnamed.quotes[0]);
  assert.deepEqual(namedRest, { ...unnamedRest, country: 'US' });
  // The address is in the request with or without the rule; only its presence differs between these two carts.
  assert.equal(namedBuyer.shipping_address.country, 'US');
  assert.equal(unnamedBuyer.shipping_address, undefined);
  assert.equal(JSON.stringify(named.quotes[0]).includes('market_currency'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(named.quotes[0].request_context, 'currency'), false);
});

test('the rule does not depend on the other doors\' switches: the same answers with the storefront path and the currency rule on', async () => {
  const flags = ['AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED', 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET'];
  for (const flag of flags) process.env[flag] = '1';
  try {
    assertRefused(await create('USD', 'SG'), ruleFor('USD', 'SG'), { quotes: 1 });
    assertRefused(await create('USD', 'DE'), ruleFor('USD', 'DE'));
    assertPricedSession(await create('SGD', 'SG'), 'SGD', { http: 201 });
    assertPricedSession(await create('SGD', undefined), 'SGD', { http: 201 });
  } finally {
    for (const flag of flags) delete process.env[flag];
  }
});

// THE DOOR'S RULE IS ITS OWN. The other checkout doors judge a session's market only while their two switches are on.
// This door judges whenever it is on: in every combination of those switches, a session created for SG and priced
// in SGD cannot be re-priced into another seller's currency by an update that omits the address.
for (const [storefront, currencyRule] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`the storefront path ${storefront ? 'on' : 'off'}, the currency rule ${currencyRule ? 'on' : 'off'}: an address-less update naming a seller priced in USD is refused for the session's market (SG)`, async () => {
    const flags = { AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED: storefront, AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET: currencyRule };
    for (const [flag, on] of Object.entries(flags)) { if (on) process.env[flag] = '1'; else delete process.env[flag]; }
    try {
      const id = await created('SGD', 'SG');
      const moved = await update(id, 'USD', undefined);
      assertRefused(moved, ruleFor('USD', 'SG'), { quotes: 1 });
      assert.deepEqual(moved.quotes.map(quoteMarket), ['SG']);
      assertPricedSession(await read(id), 'SGD');
      // The rest of the rule, in the same state of the switches.
      assertRefused(await create('USD', 'SG'), ruleFor('USD', 'SG'), { quotes: 1 });
      assertRefused(await create('USD', 'DE'), ruleFor('USD', 'DE'));
      assertRefused(await complete(await created('USD', undefined), 'SG'), ruleFor('USD', 'SG'));
      const kept = await update(await created('SGD', 'SG'), 'SGD', undefined);
      assertPricedSession(kept, 'SGD', { quantity: 2 });
      assert.deepEqual(kept.quotes.map(quoteMarket), ['SG']);
    } finally {
      for (const flag of Object.keys(flags)) delete process.env[flag];
    }
  });
}

test('with the door off every checkout route is 404 and nothing is asked of the backend', async () => {
  const id = await created('USD', 'US');
  const saved = process.env.AGENT_CHECKOUT_ACP_REST_ENABLED;
  delete process.env.AGENT_CHECKOUT_ACP_REST_ENABLED;
  try {
    for (const answer of [await create('USD', 'SG'), await update(id, 'USD', 'SG'), await read(id), await cancel(id)]) {
      assert.equal(answer.http, 404, answer.raw);
      assert.deepEqual(answer.body, { error: 'not_found' });
      assert.deepEqual(answer.backend, []);
    }
  } finally {
    process.env.AGENT_CHECKOUT_ACP_REST_ENABLED = saved;
  }
});

test('the placeholder sellers are the ones the matrix says they are', () => {
  assert.deepEqual(Object.keys(SELLER_OF), ['USD', 'SGD', 'GBP']);
  for (const [currency, seller] of Object.entries(SELLER_OF)) assert.equal(support.SELLERS[seller], currency);
});
