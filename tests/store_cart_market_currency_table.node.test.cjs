'use strict';

// THE STORE-CART PATH, MARKET BY MARKET: every currency in the answer is the market's currency, or there is no price.
//
// One table over the real `/ucp/mcp` door (create_checkout and get_checkout for a seller Pivota is not connected to),
// with AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET on:
//   markets   US, SG, GB, DE, none, "ZZ" (no such market), "USA" (not a country code)
//   x rows    a seller priced in USD, SGD, GBP, EUR (the product read withholds the money of the last three and says
//             which currency it withheld), plus two rows served by a page the money guard does not cover (a GBP and a
//             USD row that still state their price)
//   x stores  the seller's storefront answers a cart in USD, and in the market's currency
//
// MARKET -> CURRENCY SOURCE (the one a later door-by-market test should use too): `resolveServingCurrency` in
// src/services/buyerMarket.js, over `BUYER_REGION_CURRENCY` in src/auroraBff/buyerRegion.js. This file keeps no
// table of its own: each cell's expected currency is asked of that source. A market the source has no currency for
// (DE today) is not skipped: the right answer for it is the named refusal, and the table says so.
//
// THE RULE ITSELF is `assertAnswerCurrency` (tests/_support/answerCurrencies.cjs), run over the WHOLE response body
// as the door sent it: every price-labelling currency is the market's, every amount has one, no money in text.
//
// IN EVERY CELL: the product read is one request with no market on it, and a seller whose row is in another currency
// than the market's is never contacted.

const test = require('node:test');
const assert = require('node:assert/strict');

const support = require('./_support/storeCartMarketDoor.cjs');
const { assertAnswerCurrency } = require('./_support/answerCurrencies.cjs');
const { resolveServingCurrency } = require('../src/services/buyerMarket');

const { IDS, HOST, ucpCreate, ucpGet, escId } = support;
const door = support.bootDoor({ port: 4474 });
const ucp = (name, args) => door.withFlag(true, () => door.call('/ucp/mcp', name, args));

// The seller rows of the fixture. `catalog`: the row still states its price on a read with no market.
const ROWS = Object.freeze([
  { name: 'USD', currency: 'USD', id: IDS.SIG_USD, host: HOST.A, catalog: true },
  { name: 'SGD', currency: 'SGD', id: IDS.SIG_SGD, host: HOST.S, catalog: false },
  { name: 'GBP', currency: 'GBP', id: IDS.SIG_GBP, host: HOST.G, catalog: false },
  { name: 'EUR', currency: 'EUR', id: IDS.SIG_EUR, host: HOST.E, catalog: false },
  { name: 'GBP (unguarded page)', currency: 'GBP', id: IDS.SIG_GBP_UNGUARDED, host: HOST.V, catalog: true },
  { name: 'USD (unguarded page)', currency: 'USD', id: IDS.SIG_USD_UNGUARDED, host: HOST.U, catalog: true },
]);

// `sent`: what the request carries (undefined = no market). `market`: what it is answered for.
const MARKETS = Object.freeze([
  { label: 'US', sent: 'US', market: 'US' },
  { label: 'SG', sent: 'SG', market: 'SG' },
  { label: 'GB', sent: 'GB', market: 'GB' },
  { label: 'DE', sent: 'DE', market: 'DE' },
  { label: 'none', sent: undefined, market: 'US', assumed: true },
  { label: 'ZZ', sent: 'ZZ', market: 'ZZ' },
  { label: 'USA', sent: 'USA', market: null, invalid: true },
]);

const cells = [];
for (const m of MARKETS) {
  const marketCurrency = m.invalid ? null : (resolveServingCurrency(m.market) || null);
  for (const row of ROWS) {
    for (const storeCurrency of [...new Set(['USD', marketCurrency || row.currency])]) {
      let expected;
      if (m.invalid) expected = 'ucp_market_invalid';
      else if (!marketCurrency) expected = 'market_not_priced';
      else if (row.currency !== marketCurrency) expected = 'seller_not_priced_in_market_currency';
      else if (storeCurrency === marketCurrency) expected = 'priced_by_store';
      else expected = row.catalog ? 'priced_by_catalog' : 'store_not_in_market_currency';
      cells.push({ ...m, marketCurrency, row, storeCurrency, expected });
    }
  }
}

test.before(() => door.listen());
test.after(() => door.close());

test('the table covers what it says, and the source has no currency for DE or ZZ', () => {
  assert.deepEqual(MARKETS.map((m) => (m.invalid ? null : resolveServingCurrency(m.market) || null)), ['USD', 'SGD', 'GBP', null, 'USD', null, null]);
  const count = (expected) => cells.filter((c) => c.expected === expected).length;
  assert.deepEqual({
    cells: cells.length, priced_by_store: count('priced_by_store'), priced_by_catalog: count('priced_by_catalog'),
    store_not_in_market_currency: count('store_not_in_market_currency'), seller_not_priced_in_market_currency: count('seller_not_priced_in_market_currency'),
    market_not_priced: count('market_not_priced'), ucp_market_invalid: count('ucp_market_invalid'),
  }, {
    cells: 66, priced_by_store: 7, priced_by_catalog: 1, store_not_in_market_currency: 2, seller_not_priced_in_market_currency: 26,
    market_not_priced: 20, ucp_market_invalid: 10,
  });
});

const theRead = (signature) => JSON.stringify({ product_ref: { product_id: signature }, include: ['product_overview'] });
const readPayloads = (answer) => answer.upstream.filter((u) => u.op === 'get_pdp_v2').map((u) => u.payload);
const tools = (answer) => answer.store.filter((c) => c.kind === 'tool').map((c) => c.tool);

for (const cell of cells) {
  const { label, sent, market, assumed, marketCurrency, row, storeCurrency, expected } = cell;
  const name = `market ${label} (${marketCurrency || 'no currency'}), seller row in ${row.name}, store answers in ${storeCurrency}`;

  const check = (answer, op) => {
    // The whole body, as sent: the JSON-RPC envelope and the tool result's text inside it.
    const found = assertAnswerCurrency(JSON.parse(answer.raw), marketCurrency, `${name} ${op}`);
    assert.deepEqual(found.textMoney, [], 'no money written in text');
    assert.deepEqual(readPayloads(answer), [theRead(row.id)], 'one product read, with no market on it');
    const servedCurrencies = [...new Set([...found.priceCurrencies.map((c) => c.value), ...found.money.map((m) => m.currency)])];
    if (expected === 'priced_by_store' || expected === 'priced_by_catalog') {
      assert.equal(answer.isError, false);
      assert.equal(answer.value.status, 'requires_escalation');
      assert.equal(answer.value.currency, marketCurrency);
      assert.ok(found.money.length > 0, 'a price is stated');
      assert.deepEqual(servedCurrencies, [marketCurrency], 'every price is in the market currency');
      assert.equal(answer.value.messages[0].code, expected === 'priced_by_store' ? 'checkout.priced_by_seller_storefront' : 'checkout.completes_on_seller_storefront');
      // No market named: the labelled, assumed-US answer; a named market is never labelled as assumed.
      assert.equal(answer.value.market_assumed ? answer.value.market_assumed.code : null, assumed ? 'US' : null);
      return;
    }
    assert.equal(answer.isError, true);
    assert.deepEqual([found.money, found.priceCurrencies], [[], []], 'no price at all');
    const error = answer.value.error;
    assert.equal(typeof error.detail.reason, 'string', 'the refusal is named');
    if (expected === 'ucp_market_invalid') {
      assert.equal(error.code, 'QUOTE_REQUIRED');
      assert.equal(error.detail.reason, 'ucp_market_invalid');
      assert.equal(JSON.stringify(answer.value).includes('USA'), false, 'the value sent is not echoed');
      assert.deepEqual([answer.store, answer.gate], [[], []]);
      return;
    }
    assert.equal(error.code, 'NO_MERCHANT_OFFER');
    if (expected === 'market_not_priced') {
      assert.equal(error.detail.reason, 'market_not_priced');
      assert.deepEqual([answer.store, answer.gate], [[], []], 'neither the seller nor the gate is asked');
      assert.deepEqual(found.currencyMentions, [], 'not even a mention of a currency');
      return;
    }
    assert.equal(error.detail.reason, 'seller_not_priced_in_market_currency');
    assert.equal(error.detail.market_currency, marketCurrency);
    assert.equal(Boolean(error.market_assumed), Boolean(assumed));
    if (expected === 'seller_not_priced_in_market_currency') {
      assert.deepEqual(error.detail.seller_currencies, [row.currency], "the row's own currency is named");
      assert.deepEqual(answer.store, [], 'a seller priced in another currency is never contacted');
    } else {
      // The row is in the market's currency, so the seller was asked; it answered in another one.
      assert.deepEqual(error.detail.seller_currencies, [storeCurrency]);
      assert.deepEqual(tools(answer), [op === 'create_checkout' ? 'create_cart' : 'get_cart']);
    }
    // What is named in the refusal is a MENTION of a currency, never a price in it.
    assert.deepEqual(found.currencyMentions.map((mention) => mention.path.replace(/^.*\./, '')).sort(), ['market_currency', 'seller_currencies']);
  };

  test(`${name}: create_checkout and get_checkout -> ${expected}`, async (t) => {
    door.reset();
    door.setStoreCurrency(row.host, storeCurrency);
    t.after(() => door.setStoreCurrency(row.host, null));
    const created = await ucp('create_checkout', ucpCreate([[row.id, 1]], sent));
    check(created, 'create_checkout');
    if (expected === 'ucp_market_invalid') return; // an id's market is always a two-letter code: nothing to re-read
    // The id this create minted when it priced; otherwise the id a create from before the rule minted for this cell
    // (over a store cart where a store cart could have been built).
    let id = created.isError ? escId({ v: 1, i: [[row.id, 1]], m: market, ...(assumed ? { a: 1 } : {}) }) : created.value.id;
    if (expected === 'store_not_in_market_currency') id = escId({ v: 2, i: [[row.id, 1]], c: `cart_${row.host.split('.')[0]}_0001`, h: row.host, m: market });
    check(await ucp('get_checkout', ucpGet(id)), 'get_checkout');
  });
}
