'use strict';

// THE STORE-CART PATH, MARKET BY MARKET: every currency in the answer is the market's currency, or there is no price.
//
// One table over the real `/ucp/mcp` door (create_checkout and get_checkout for a seller Pivota is not connected to),
// with AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET on: markets US, SG, GB, DE and none, crossed with the currency the
// seller's catalog row is priced in (the market's own, and USD where the market's own is not USD).
//
// MARKET -> CURRENCY SOURCE (the one a later door-by-market test should use too): `resolveServingCurrency` in
// src/services/buyerMarket.js, over `BUYER_REGION_CURRENCY` in src/auroraBff/buyerRegion.js. This file keeps no
// table of its own: each row's expected currency is asked of that source. A market the source has no currency for
// (DE today) is not skipped: the right answer for it is the named refusal, and the table says so.
//
// THE RULE ITSELF is `assertAnswerCurrency` (tests/_support/answerCurrencies.cjs): it walks the whole answer and
// holds every price-labelling currency to the market's, and every quoted amount to having one.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/storeCartMarketDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { IDS, ucpCreate, ucpGet, escId } = support;
const door = support.bootDoor({ port: 4474 });
const ucp = (name, args) => door.withFlag(true, () => door.call('/ucp/mcp', name, args));

// The seller rows of the fixture, by the currency their catalog row is priced in.
const ROW = Object.freeze({ USD: IDS.SIG_USD, GBP: IDS.SIG_GBP, SGD: IDS.SIG_SGD, EUR: IDS.SIG_EUR });
// What the market's "own" row is when the source prices the market in nothing: the currency its buyers pay in.
const OWN_ROW_WITHOUT_A_SOURCE_CURRENCY = Object.freeze({ DE: 'EUR' });

const MARKETS = ['US', 'SG', 'GB', 'DE', null]; // null = the request names no market
const cells = [];
for (const market of MARKETS) {
  // No market named is answered as US, labelled; its currency is the assumed market's.
  const marketCurrency = resolveServingCurrency(market === null ? 'US' : market);
  const own = marketCurrency || OWN_ROW_WITHOUT_A_SOURCE_CURRENCY[market];
  for (const rowCurrency of [...new Set([own, 'USD'])]) cells.push({ market, marketCurrency, rowCurrency });
}

test.before(() => door.listen());
test.after(() => door.close());

test('the table covers what it says: eight cells, and the source has no currency for DE', () => {
  assert.deepEqual(cells.map((c) => `${c.market || 'none'}:${c.marketCurrency || '-'}:${c.rowCurrency}`), [
    'US:USD:USD', 'SG:SGD:SGD', 'SG:SGD:USD', 'GB:GBP:GBP', 'GB:GBP:USD', 'DE:-:EUR', 'DE:-:USD', 'none:USD:USD',
  ]);
});

for (const { market, marketCurrency, rowCurrency } of cells) {
  const name = `market ${market || 'none'} (${marketCurrency || 'no currency'}), seller row in ${rowCurrency}`;
  const expected = !marketCurrency ? 'market_not_priced' : rowCurrency === marketCurrency ? 'priced' : 'seller_not_priced_in_market_currency';

  test(`${name}: create_checkout -> ${expected}`, async () => {
    const created = await ucp('create_checkout', ucpCreate([[ROW[rowCurrency], 1]], market === null ? undefined : market));
    const found = assertAnswerCurrency(created.value, marketCurrency, name);
    if (expected === 'priced') {
      assert.equal(created.isError, false);
      assert.equal(created.value.status, 'requires_escalation');
      assert.equal(created.value.currency, marketCurrency);
      assert.ok(found.money.length > 0, 'a price is stated');
      assert.ok(found.priceCurrencies.every((c) => c.value === marketCurrency));
      // No market named: today's labelled, assumed-US answer; a named market is never labelled as assumed.
      assert.equal(created.value.market_assumed ? created.value.market_assumed.code : null, market === null ? 'US' : null);
    } else {
      assert.equal(created.isError, true);
      assert.equal(created.value.error.code, 'NO_MERCHANT_OFFER');
      assert.equal(created.value.error.detail.reason, expected);
      assert.deepEqual(found.money, [], 'no price at all');
      assert.deepEqual(found.priceCurrencies, []);
      assert.deepEqual(created.store, [], 'and no seller was contacted');
    }
  });

  test(`${name}: get_checkout -> ${expected}`, async () => {
    // The id a create for this cell mints when it prices; otherwise the id a create from before the rule minted.
    const created = await ucp('create_checkout', ucpCreate([[ROW[rowCurrency], 1]], market === null ? undefined : market));
    const id = created.isError
      ? escId({ v: 1, i: [[ROW[rowCurrency], 1]], m: market === null ? 'US' : market, ...(market === null ? { a: 1 } : {}) })
      : created.value.id;
    const got = await ucp('get_checkout', ucpGet(id));
    const found = assertAnswerCurrency(got.value, marketCurrency, name);
    if (expected === 'priced') {
      assert.equal(got.isError, false);
      assert.equal(got.value.currency, marketCurrency);
      assert.ok(found.money.length > 0);
      assert.equal(got.value.market_assumed ? got.value.market_assumed.code : null, market === null ? 'US' : null);
    } else {
      assert.equal(got.isError, true);
      assert.equal(got.value.error.detail.reason, expected);
      assert.deepEqual(found.money, []);
      assert.deepEqual(found.priceCurrencies, []);
      assert.deepEqual(got.store, []);
    }
  });
}
