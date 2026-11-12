// A storefront checkout's currency follows the buyer's market (AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET): the
// module-level rules. The real-door behaviour (through `/ucp/mcp`, with a backend and stores answering) is in
// tests/store_cart_currency_follows_market_door.node.test.cjs and tests/store_cart_market_currency_table.node.test.cjs.
//
// What is pinned here:
//   - the flag, value by value, and that it is read exactly as its sibling switch in the same file is;
//   - the market's currency comes from the gateway's ONE source (resolveServingCurrency);
//   - THE PRODUCT READ IS THE SAME REQUEST in every flag state and every market: no market, no extra read;
//   - the rule is judged against the REQUEST market's currency, on every currency the line's row is labelled with
//     (the chosen variant's price, the row's own label, the currencies the read withheld), never against the row's;
//   - the seller's answer is held to the MARKET's currency; a row in another currency never reaches a seller;
//   - neither builder can build an answer in another currency than the market's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { MERCHANT_PRICING_FLAG, priceOnMerchantDoor } from '../src/ucpMerchantDoorPricing.js';
import {
  UCP_ESCALATION_FLAG,
  CURRENCY_FOLLOWS_MARKET_FLAG,
  currencyFollowsMarketEnabled,
  ucpEscalationEnabled,
  marketCurrencyOf,
  lineCurrencyLabelsOf,
  tryEscalateUcpCheckout,
  buildEscalationCheckout,
  buildSellerPricedCheckout,
  encodeEscalationId,
} from '../src/ucpCheckoutEscalation.js';

const require = createRequire(import.meta.url);
const { resolveServingCurrency } = require('../../src/services/buyerMarket.js');
const { BUYER_REGION_CURRENCY } = require('../../src/auroraBff/buyerRegion.js');
const { noteWithheldCurrencies, withheldCurrenciesOf, withheldCurrenciesOfPdpResponse } = require('../../src/services/pdpWithheldCurrencies.js');

const OFF = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1' };
const ON = { ...OFF, [CURRENCY_FOLLOWS_MARKET_FLAG]: '1' };
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const HOST = 'store-a.example';
const ENDPOINT = `https://${HOST}/api/ucp/mcp`;
const VARIANT = '44000000000001';
const SECOND_VARIANT = '44000000000002';

const row = (currency, extra = {}) => ({
  product_id: 'sig_row_a', title: 'Calm Serum', price: 25, currency,
  external_redirect_url: `https://${HOST}/products/calm-serum`,
  variants: [{ variant_id: 'sig_row_a', source_variant_id: VARIANT }],
  ...extra,
});
// A row as the product read serves a seller whose money it withheld: no price, no currency on the row, and the
// withheld currencies noted BESIDE it (src/services/pdpWithheldCurrencies.js).
const withheldRow = (...currencies) => ({ ...row(null), price: null, currency: null, __withheld: currencies });
// A product with two real variants, each stating its own price.
const twoVariantRow = (rowCurrency, firstCurrency, secondCurrency) => ({
  product_id: 'sig_row_a', title: 'Calm Serum', price: 25, currency: rowCurrency,
  external_redirect_url: `https://${HOST}/products/calm-serum`,
  variants: [
    { variant_id: VARIANT, source_variant_id: VARIANT, title: 'Small', price: { current: { amount: 25, currency: firstCurrency } } },
    { variant_id: SECOND_VARIANT, source_variant_id: SECOND_VARIANT, title: 'Large', price: { current: { amount: 20, currency: secondCurrency } } },
  ],
});

/**
 * A recording executor serving one row. It records every call exactly as it was made (operation, params) and serves
 * a fresh copy of the row each time, with the withheld currencies noted beside the copy as the real read notes them.
 */
function recordingExecutor(served) {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params: structuredClone(params) });
      const { __withheld: withheld, ...product } = structuredClone(served);
      if (withheld) noteWithheldCurrencies(product, withheld);
      return { product };
    },
  };
}

function sellerCart(currency, { price = 2750, quantity = 1, id = 'cart_0001', variant = VARIANT } = {}) {
  const payload = {
    id, currency, continue_url: `https://${HOST}/cart/c/${id}?key=k`,
    line_items: [{ id: 'line_0', item: { id: GID(variant), title: 'Store item', price }, quantity, totals: [{ type: 'subtotal', amount: price * quantity }, { type: 'total', amount: price * quantity }] }],
    totals: [{ type: 'subtotal', amount: price * quantity }, { type: 'total', amount: price * quantity }],
  };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

function fakeDoor(storeCurrency, variant = VARIANT) {
  const calls = [];
  return {
    calls,
    async endpointFor(host) { calls.push(['discover', host]); return ENDPOINT; },
    async createCart(ep, args) { calls.push(['create_cart', structuredClone(args)]); return sellerCart(storeCurrency, { variant }); },
    async getCart(ep, cartId) { calls.push(['get_cart', cartId]); return sellerCart(storeCurrency, { id: cartId }); },
  };
}
const logOf = () => { const lines = []; return { lines, info: (l) => lines.push(l), warn: (l) => lines.push(l) }; };
const CREATE = { id: 'create_checkout_session', capability: 'checkout' };
const GET = { id: 'get_checkout_session', capability: 'checkout' };
const createParams = (quantity = 1, variantId) => ({ idempotency_key: 'idem-0001', quote: { items: [{ product_id: 'sig_row_a', quantity, ...(variantId ? { variant_id: variantId } : {}) }] } });
const ucpArgs = (country) => (country === undefined ? {} : { checkout: { context: { address_country: country } } });
const rejected = (p) => p.then(() => null, (e) => e);
const allow = async () => ({ offer: true });


const THE_READ = [{ op: 'get_product', params: { payload: { product: { product_id: 'sig_row_a' } } } }];
const escalate = (extra) => tryEscalateUcpCheckout({ ctx: {}, now: NOW, shouldOfferPurchase: allow, ...extra });

describe('the switch and the source', () => {
  // Every value, and what it means. ON is exactly: 1, true, yes, on, enabled, in any letter case, with surrounding
  // whitespace ignored. Everything else is OFF, including rollout words other switches use and any other number.
  const ON_VALUES = ['1', 'true', 'TRUE', 'True', 'yes', 'YES', ' yes ', 'on', 'ON', ' on ', '\ton\n', 'enabled', 'Enabled'];
  const OFF_VALUES = [
    undefined, null, '', ' ', '0', 'false', 'FALSE', 'off', 'OFF', 'no', 'NO', 'enforce', 'shadow', 'observe', 'enable', 'disabled',
    '2', '10', '11', '01', '-1', '1.0', '1 1', 'y', 't', 'ok', 'garbage', 'true1', 'xtrue', 'on!', 'yes,no', 'null', 'undefined', '[object Object]',
  ];

  test('OFF by default; ON for exactly five spellings', () => {
    assert.equal(CURRENCY_FOLLOWS_MARKET_FLAG, 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET');
    assert.equal(currencyFollowsMarketEnabled({}), false);
    for (const v of ON_VALUES) assert.equal(currencyFollowsMarketEnabled({ [CURRENCY_FOLLOWS_MARKET_FLAG]: v }), true, JSON.stringify(v));
    for (const v of OFF_VALUES) assert.equal(currencyFollowsMarketEnabled({ [CURRENCY_FOLLOWS_MARKET_FLAG]: v }), false, JSON.stringify(v));
  });

  test('it is read exactly as the escalation switch in the same file is, value by value', () => {
    for (const v of [...ON_VALUES, ...OFF_VALUES]) {
      assert.equal(currencyFollowsMarketEnabled({ [CURRENCY_FOLLOWS_MARKET_FLAG]: v }), ucpEscalationEnabled({ [UCP_ESCALATION_FLAG]: v }), JSON.stringify(v));
    }
  });

  test('a junk value behaves as OFF through the door itself: a GB create for a USD row is answered as before the rule', async () => {
    for (const v of ['', '0', 'false', 'enforce', '2', 'garbage']) {
      const executor = recordingExecutor(row('USD'));
      const out = await escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs('GB'), env: { ...OFF, [CURRENCY_FOLLOWS_MARKET_FLAG]: v }, merchantDoor: fakeDoor('USD') });
      assert.equal(out.currency, 'USD', JSON.stringify(v));
    }
    for (const v of ['yes', 'TRUE', ' on ']) {
      const err = await rejected(escalate({ op: CREATE, params: createParams(), executor: recordingExecutor(row('USD')), ucpArgs: ucpArgs('GB'), env: { ...OFF, [CURRENCY_FOLLOWS_MARKET_FLAG]: v }, merchantDoor: fakeDoor('USD') }));
      assert.equal(err && err.detail.reason, 'seller_not_priced_in_market_currency', JSON.stringify(v));
    }
  });

  test("a market's currency is the gateway's one source's answer, for every market it prices and for those it does not", () => {
    for (const market of [...Object.keys(BUYER_REGION_CURRENCY), 'DE', 'ZZ', 'IT', 'CN']) {
      assert.equal(marketCurrencyOf(market), resolveServingCurrency(market) || null, market);
    }
    assert.deepEqual(['US', 'GB', 'SG', 'DE', 'ZZ'].map(marketCurrencyOf), ['USD', 'GBP', 'SGD', null, null]);
  });

  test('anything that is not an upper-case two-letter code has no currency: never a default, never US', () => {
    // `''` and `undefined` matter most: the source answers the DEPLOYMENT's currency for silence, and this must not.
    for (const v of ['', ' ', undefined, null, 'us', 'USA', 'en-US', 'US,SG', 'U1', 5, ['US'], {}]) assert.equal(marketCurrencyOf(v), null, JSON.stringify(v));
  });
});

describe('the product read is the same request in every flag state and every market', () => {
  const MARKETS = ['US', 'SG', 'GB', 'DE', 'ZZ', 'USA', 'gb', undefined];

  test('create: one get_product per product, naming the product and nothing else, flag off and on', async () => {
    for (const env of [OFF, ON]) {
      for (const country of MARKETS) {
        for (const served of [row('USD'), row('GBP'), row('SGD'), withheldRow('GBP'), withheldRow('SGD')]) {
          const executor = recordingExecutor(served);
          await rejected(escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs(country), env, merchantDoor: fakeDoor('USD') }));
          assert.deepEqual(executor.seen, THE_READ, `${env === ON ? 'on' : 'off'} ${country} ${served.currency}`);
        }
      }
    }
  });

  test('get_checkout: the same single read, whatever market the id carries, flag off and on', async () => {
    for (const env of [OFF, ON]) {
      for (const code of ['US', 'SG', 'GB', 'DE', 'ZZ']) {
        const executor = recordingExecutor(row('USD'));
        const id = encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], undefined, undefined, { code, assumed: false });
        await rejected(escalate({ op: GET, params: { session_id: id }, executor, ucpArgs: {}, env, merchantDoor: fakeDoor('USD') }));
        assert.deepEqual(executor.seen, THE_READ, `${env === ON ? 'on' : 'off'} ${code}`);
      }
    }
  });

  test('the read never carries a market, a live-read request, or a second argument the flag added', async () => {
    const calls = [];
    const executor = { async execute(...args) { calls.push(args); return { product: row('USD') }; } };
    await escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs('GB'), env: OFF, merchantDoor: fakeDoor('USD') });
    await rejected(escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: fakeDoor('USD') }));
    assert.equal(calls.length, 2);
    const shape = ([op, params, ctx]) => [op, JSON.stringify(params), Object.keys(ctx).sort()];
    assert.deepEqual(shape(calls[1]), shape(calls[0]));
    assert.deepEqual(shape(calls[0]), ['get_product', '{"payload":{"product":{"product_id":"sig_row_a"}}}', ['signal']]);
  });
});

describe('the currencies a row is labelled with', () => {
  const line = { product_id: 'sig_row_a', quantity: 1 };

  test('a priced row: its price currency', () => {
    assert.deepEqual(lineCurrencyLabelsOf(row('USD'), line), ['USD']);
    assert.deepEqual(lineCurrencyLabelsOf(row('gbp'), line), ['GBP'], 'the label is read whatever its letter case');
  });

  test('the CHOSEN variant: its own price currency, beside the row label', () => {
    const r = twoVariantRow('USD', 'USD', 'GBP');
    assert.deepEqual(lineCurrencyLabelsOf(r, { ...line, variant_id: SECOND_VARIANT }), ['GBP', 'USD']);
    assert.deepEqual(lineCurrencyLabelsOf(r, { ...line, variant_id: VARIANT }), ['USD']);
    assert.deepEqual(lineCurrencyLabelsOf(r, line), ['USD'], 'a variant nobody chose says nothing about this line');
  });

  test('a chosen variant that states a currency but no amount is still labelled with it', () => {
    const r = twoVariantRow('USD', 'USD', 'GBP');
    r.variants[1].price = { current: { currency: 'GBP' } };
    assert.deepEqual(lineCurrencyLabelsOf(r, { ...line, variant_id: SECOND_VARIANT }), ['GBP', 'USD']);
  });

  test('an unpriced row: the currencies the read withheld, noted beside that very object', () => {
    const r = { ...row(null), price: null };
    assert.deepEqual(lineCurrencyLabelsOf(r, line), []);
    noteWithheldCurrencies(r, ['sgd', 'EUR', 'EUR', 'nope', 5]);
    assert.deepEqual(lineCurrencyLabelsOf(r, line), ['EUR', 'SGD']);
    assert.deepEqual(lineCurrencyLabelsOf({ ...r }, line), [], 'a copy of the row carries no note: unknown, never guessed');
    assert.deepEqual(Object.keys(r).sort(), Object.keys(row(null)).sort(), 'nothing was added to the row');
    assert.equal(JSON.stringify(r), JSON.stringify({ ...row(null), price: null }));
  });

  test('a PRICED row ignores the note: the price it states is the label', () => {
    const r = row('USD');
    noteWithheldCurrencies(r, ['GBP']);
    assert.deepEqual(lineCurrencyLabelsOf(r, line), ['USD']);
  });

  test('the note is read from the page exactly where the page reports it', () => {
    assert.deepEqual(withheldCurrenciesOfPdpResponse({ metadata: { serving_currency_guard: { withheld_currencies: ['SGD', 'gbp'] } } }), ['GBP', 'SGD']);
    for (const body of [null, {}, { metadata: null }, { metadata: {} }, { metadata: { serving_currency_guard: {} } }, { metadata: { serving_currency_guard: { withheld_currencies: 'USD' } } }, { serving_currency_guard: { withheld_currencies: ['USD'] } }]) {
      assert.deepEqual(withheldCurrenciesOfPdpResponse(body), []);
    }
    const product = {};
    noteWithheldCurrencies(product, []);
    assert.deepEqual(withheldCurrenciesOf(product), []);
    for (const v of [null, undefined, 'x', 5]) { noteWithheldCurrencies(v, ['USD']); assert.deepEqual(withheldCurrenciesOf(v), []); }
    noteWithheldCurrencies(product, ['USD']);
    const got = withheldCurrenciesOf(product);
    got.push('GBP');
    assert.deepEqual(withheldCurrenciesOf(product), ['USD'], 'a caller cannot edit the note');
  });
});

describe("the seller's answer is held to the market's currency", () => {
  const args = (extra) => ({ items: [{ product_id: 'sig_row_a', quantity: 1 }], sellerHost: HOST, market: 'GB', env: OFF, ...extra });

  test('with `marketCurrency`: a store answering in another currency is not shown, and the caller is told which', async () => {
    const door = fakeDoor('USD');
    const log = logOf();
    const storeAnswer = {};
    const priced = await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('GBP')]]), marketCurrency: 'GBP', storeAnswer, merchantDoor: door, log }));
    assert.equal(priced, null);
    assert.deepEqual(storeAnswer, { currency: 'USD' });
    assert.deepEqual(log.lines, [{
      event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'store_currency_not_market_currency',
      market: 'GB', expected_currency: 'GBP', row_currency: 'GBP', store_currency: 'USD', seller_host: HOST,
    }]);
  });

  test('with `marketCurrency`: a row stating ANOTHER currency is never sent to the seller, even when row and store agree', async () => {
    // The row says USD and the store would say USD: they agree with each other, and neither is a price for GB.
    for (const rowsInMarketCurrency of [undefined, false, true]) {
      const door = fakeDoor('USD');
      const log = logOf();
      const priced = await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('USD')]]), marketCurrency: 'GBP', rowsInMarketCurrency, merchantDoor: door, log }));
      assert.equal(priced, null);
      assert.deepEqual(door.calls, [], 'no profile read, no cart');
      assert.deepEqual(log.lines, [{
        event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'row_currency_not_market_currency',
        market: 'GB', expected_currency: 'GBP', row_currency: 'USD', seller_host: HOST,
      }]);
    }
  });

  test('with `marketCurrency`: a store answering in the market\'s currency is priced, in that currency', async () => {
    const log = logOf();
    const priced = await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('GBP')]]), marketCurrency: 'GBP', merchantDoor: fakeDoor('GBP'), log }));
    assert.equal(priced.currency, 'GBP');
    assert.deepEqual(log.lines, [{ event: 'ucp_merchant_door_pricing', outcome: 'priced', seller_host: HOST, lines: 1, source: 'row_id' }]);
  });

  test('a row that states NO currency: sent to the seller only under the market rule AND when its caller says the lines are in the market\'s currency', async () => {
    const unlabelled = { ...row(null), price: null };
    for (const extra of [{}, { marketCurrency: 'GBP' }, { marketCurrency: 'GBP', rowsInMarketCurrency: false }, { marketCurrency: 'GBP', rowsInMarketCurrency: 'yes' }, { rowsInMarketCurrency: true }]) {
      const door = fakeDoor('GBP');
      const log = logOf();
      assert.equal(await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', unlabelled]]), merchantDoor: door, log, ...extra })), null, JSON.stringify(extra));
      assert.deepEqual(door.calls, [], JSON.stringify(extra));
      assert.deepEqual(log.lines, [{ event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'catalog_currency_unknown', seller_host: HOST }]);
    }
    const door = fakeDoor('GBP');
    const priced = await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', unlabelled]]), marketCurrency: 'GBP', rowsInMarketCurrency: true, merchantDoor: door }));
    assert.equal(priced.currency, 'GBP');
    assert.deepEqual(door.calls.map((c) => c[0]), ['discover', 'create_cart']);
    // ... and even then the store is held to the MARKET's currency.
    const storeAnswer = {};
    assert.equal(await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', unlabelled]]), marketCurrency: 'GBP', rowsInMarketCurrency: true, storeAnswer, merchantDoor: fakeDoor('USD') })), null);
    assert.deepEqual(storeAnswer, { currency: 'USD' });
  });

  test('without it (the rule off): the row\'s currency is what the store is held to, and the fallback line is the one it was', async () => {
    assert.equal((await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('USD')]]), merchantDoor: fakeDoor('USD') }))).currency, 'USD');
    const log = logOf();
    const storeAnswer = {};
    assert.equal(await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('USD')]]), merchantDoor: fakeDoor('GBP'), storeAnswer, log })), null);
    assert.deepEqual(log.lines, [{ event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'cart_mismatch', seller_host: HOST }]);
    assert.deepEqual(storeAnswer, {}, 'nothing is reported outside the market rule');
  });

  test('a value that is not a currency code is not a market currency: the row\'s is used', async () => {
    for (const marketCurrency of ['', 'gbp', 'GB', null, 5]) {
      const priced = await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('USD')]]), marketCurrency, merchantDoor: fakeDoor('USD') }));
      assert.equal(priced.currency, 'USD', JSON.stringify(marketCurrency));
    }
  });

  test('the priced line names every variant-id route used, once each', async () => {
    const log = logOf();
    const viaUrl = { ...row('USD'), variants: [{ variant_id: 'sig_row_a' }], destination_url: `https://${HOST}/products/calm-serum?variant=${VARIANT}` };
    await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', viaUrl]]), merchantDoor: fakeDoor('USD'), log }));
    assert.equal(log.lines.at(-1).source, 'url');
  });
});

describe('the escalation, flag ON: the rule is the REQUEST market\'s, on a row read with no market', () => {
  const refusalDetail = (sellerCurrencies, market = 'GB', marketCurrency = 'GBP') => ({
    reason: 'seller_not_priced_in_market_currency', market, market_currency: marketCurrency, seller_currencies: sellerCurrencies,
    storefront_items: ['sig_row_a'], seller_hosts: [HOST], storefront_urls: { sig_row_a: `https://${HOST}/products/calm-serum` },
  });

  test('a row stating another currency than the market\'s: refused by name, and the seller door is never touched', async () => {
    const door = fakeDoor('USD');
    const log = logOf();
    const executor = recordingExecutor(row('USD'));
    const err = await rejected(escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: door, log }));
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.deepEqual(err.detail.acp_detail, refusalDetail(['USD']));
    assert.deepEqual(door.calls, []);
    assert.deepEqual(executor.seen, THE_READ);
    assert.deepEqual(log.lines, [{
      event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency',
      market: 'GB', expected_currency: 'GBP', row_currency: 'USD', seller_host: HOST,
    }]);
  });

  test('row and store agree with each other and not with the market: still refused (the rule is the market\'s, not the row\'s)', async () => {
    // A GBP row whose store answers GBP, asked for by a US buyer and by an SG buyer.
    for (const [country, market, currency] of [['US', 'US', 'USD'], ['SG', 'SG', 'SGD'], [undefined, 'US', 'USD']]) {
      const door = fakeDoor('GBP');
      const err = await rejected(escalate({ op: CREATE, params: createParams(), executor: recordingExecutor(row('GBP')), ucpArgs: ucpArgs(country), env: ON, merchantDoor: door }));
      assert.deepEqual(err.detail.acp_detail, refusalDetail(['GBP'], market, currency), String(country));
      assert.deepEqual(door.calls, [], String(country));
    }
  });

  test('a seller whose money the read withheld in SGD or EUR, for a GB buyer: the SAME named refusal, naming that currency, with one read and no seller call', async () => {
    for (const currency of ['SGD', 'EUR', 'USD']) {
      const door = fakeDoor(currency);
      const executor = recordingExecutor(withheldRow(currency));
      const log = logOf();
      const err = await rejected(escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: door, log }));
      assert.equal(err.code, 'NO_MERCHANT_OFFER', currency);
      assert.deepEqual(err.detail.acp_detail, refusalDetail([currency]), currency);
      assert.match(err.detail.acp_message, new RegExp(`is priced in ${currency}, and a price for GB must be in GBP`));
      assert.deepEqual(door.calls, [], currency);
      assert.deepEqual(executor.seen, THE_READ, currency);
      assert.equal(log.lines[0].row_currency, currency);
    }
  });

  test('the same withheld row for a US buyer (named or assumed): refused by name too', async () => {
    for (const country of ['US', undefined]) {
      const door = fakeDoor('GBP');
      const err = await rejected(escalate({ op: CREATE, params: createParams(), executor: recordingExecutor(withheldRow('GBP')), ucpArgs: ucpArgs(country), env: ON, merchantDoor: door }));
      assert.deepEqual(err.detail.acp_detail, refusalDetail(['GBP'], 'US', 'USD'), String(country));
      assert.equal(err.marketAssumed === true, country === undefined);
      assert.deepEqual(door.calls, []);
    }
  });

  test('a seller whose money the read withheld in the MARKET\'s currency: the seller is asked, and its answer in that currency is shown', async () => {
    const door = fakeDoor('GBP');
    const executor = recordingExecutor(withheldRow('GBP'));
    const out = await escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: door });
    assert.equal(out.currency, 'GBP');
    assert.deepEqual(out.totals.map((t) => t.amount), [2750, 2750]);
    assert.deepEqual(door.calls.map((c) => c[0]), ['discover', 'create_cart']);
    assert.deepEqual(executor.seen, THE_READ);
    // Flag off, the same row is the unpriced answer it always was, and no seller is asked.
    const offDoor = fakeDoor('GBP');
    const err = await rejected(escalate({ op: CREATE, params: createParams(), executor: recordingExecutor(withheldRow('GBP')), ucpArgs: ucpArgs('GB'), env: OFF, merchantDoor: offDoor }));
    assert.equal(err.detail.reason, 'ucp_escalation_item_unpriced');
    assert.deepEqual(offDoor.calls, []);
  });

  test('... and when that seller answers in another currency there is no price to state: refused by name, naming what the storefront answered in', async () => {
    const door = fakeDoor('USD');
    const log = logOf();
    const err = await rejected(escalate({ op: CREATE, params: createParams(), executor: recordingExecutor(withheldRow('GBP')), ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: door, log }));
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.deepEqual(err.detail.acp_detail, refusalDetail(['USD']));
    assert.match(err.detail.acp_message, /storefront \(store-a\.example\) answered in USD, and a price for GB must be in GBP/);
    assert.match(err.detail.acp_message, /the storefront's answer is not shown/);
    assert.doesNotMatch(err.detail.acp_message, /no cart was built/);
    assert.deepEqual(log.lines.map((l) => [l.outcome, l.reason]), [['fallback', 'store_currency_not_market_currency'], ['refused', 'seller_not_priced_in_market_currency']]);
    assert.deepEqual(log.lines[1], {
      event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency',
      market: 'GB', expected_currency: 'GBP', row_currency: null, store_currency: 'USD', seller_host: HOST,
    });
  });

  test('a priced row in the market\'s currency whose seller answers in another: the catalog price in the market\'s currency, the store\'s not shown', async () => {
    const out = await escalate({ op: CREATE, params: createParams(), executor: recordingExecutor(row('GBP')), ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: fakeDoor('USD') });
    assert.equal(out.currency, 'GBP');
    assert.deepEqual(out.totals.map((t) => t.amount), [2500, 2500]);
    assert.equal(JSON.stringify(out).includes('USD'), false);
  });

  test('a row that says nothing about its currency (no price, no label, nothing withheld): the unpriced answer as before, one read, no seller, flag off and on', async () => {
    const silent = { ...row(null), price: null, currency: null };
    for (const env of [OFF, ON]) {
      for (const country of ['US', 'GB']) {
        const executor = recordingExecutor(silent);
        const door = fakeDoor('USD');
        const log = logOf();
        const err = await rejected(escalate({ op: CREATE, params: createParams(), executor, ucpArgs: ucpArgs(country), env, merchantDoor: door, log }));
        assert.equal(err.detail.reason, 'ucp_escalation_item_unpriced');
        assert.deepEqual(executor.seen, THE_READ);
        assert.deepEqual(door.calls, []);
        assert.deepEqual(log.lines, [{ event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'catalog_currency_unknown', seller_host: HOST }], 'the same one line, flag off and on');
      }
    }
  });

  test('a gate decline still comes first: the currency rule does not run for a seller the gate refuses', async () => {
    const declines = [];
    const log = logOf();
    const out = await escalate({
      op: CREATE, params: createParams(), executor: recordingExecutor(row('USD')), ucpArgs: ucpArgs('GB'),
      env: { ...ON, MERCHANT_PURCHASABILITY_GATE_ENABLED: '1' }, merchantDoor: fakeDoor('USD'), shouldOfferPurchase: async () => ({ offer: false }), declines, log,
    });
    assert.equal(out, null);
    assert.deepEqual(declines, ['merchant_not_purchasable']);
    assert.deepEqual(log.lines, []);
  });

  test('US, USD row, USD store: the answer and everything sent are the same with the flag off and on', async () => {
    const run = async (env) => {
      const executor = recordingExecutor(row('USD'));
      const door = fakeDoor('USD');
      const log = logOf();
      const out = await escalate({ op: CREATE, params: createParams(2), executor, ucpArgs: ucpArgs('US'), env, merchantDoor: door, log });
      return { out: JSON.stringify(out), seen: executor.seen, calls: door.calls, log: log.lines };
    };
    assert.deepEqual(await run(ON), await run(OFF));
  });

  test('a re-read: the rule is applied with the market the id carries, on the same single read; a row in another currency is refused and its cart is not read', async () => {
    const door = fakeDoor('USD');
    const executor = recordingExecutor(row('USD'));
    const id = encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], 'cart_0001', HOST, { code: 'GB', assumed: false });
    const err = await rejected(escalate({ op: GET, params: { session_id: id }, executor, ucpArgs: {}, env: ON, merchantDoor: door }));
    assert.deepEqual(err.detail.acp_detail, refusalDetail(['USD']));
    assert.deepEqual(door.calls, []);
    assert.deepEqual(executor.seen, THE_READ);
    // A withheld GBP row for the GB id: the cart is read and shown in GBP; when the cart answers USD it is refused by name.
    const gbp = fakeDoor('GBP');
    const out = await escalate({ op: GET, params: { session_id: id }, executor: recordingExecutor(withheldRow('GBP')), ucpArgs: {}, env: ON, merchantDoor: gbp });
    assert.equal(out.currency, 'GBP');
    assert.deepEqual(gbp.calls.map((c) => c[0]), ['discover', 'get_cart']);
    const usd = await rejected(escalate({ op: GET, params: { session_id: id }, executor: recordingExecutor(withheldRow('GBP')), ucpArgs: {}, env: ON, merchantDoor: fakeDoor('USD') }));
    assert.deepEqual(usd.detail.acp_detail, refusalDetail(['USD']));
  });
});

describe('the chosen variant\'s price is part of the rule', () => {
  test('a chosen variant priced in another currency than the market\'s, on a row labelled with the market\'s: refused by name, no seller call', async () => {
    // US buyer, row USD, chosen variant GBP;  GB buyer, row GBP, chosen variant USD.
    for (const [country, rowCurrency, variantCurrency, market, marketCurrency] of [['US', 'USD', 'GBP', 'US', 'USD'], ['GB', 'GBP', 'USD', 'GB', 'GBP']]) {
      const door = fakeDoor(rowCurrency, SECOND_VARIANT);
      const executor = recordingExecutor(twoVariantRow(rowCurrency, rowCurrency, variantCurrency));
      const err = await rejected(escalate({ op: CREATE, params: createParams(1, SECOND_VARIANT), executor, ucpArgs: ucpArgs(country), env: ON, merchantDoor: door }));
      assert.ok(err, `${country}: an answer was built`);
      assert.equal(err.code, 'NO_MERCHANT_OFFER', country);
      assert.equal(err.detail.acp_detail.reason, 'seller_not_priced_in_market_currency', country);
      assert.deepEqual([err.detail.acp_detail.market, err.detail.acp_detail.market_currency, err.detail.acp_detail.seller_currencies], [market, marketCurrency, [variantCurrency]], country);
      assert.deepEqual(door.calls, [], `${country}: the seller was contacted for a variant priced in another currency`);
      assert.deepEqual(executor.seen, THE_READ);
    }
  });

  test('the same product with the OTHER variant chosen (priced in the market\'s currency) is priced', async () => {
    const door = fakeDoor('USD', VARIANT);
    const out = await escalate({ op: CREATE, params: createParams(1, VARIANT), executor: recordingExecutor(twoVariantRow('USD', 'USD', 'GBP')), ucpArgs: ucpArgs('US'), env: ON, merchantDoor: door });
    assert.equal(out.currency, 'USD');
    assert.deepEqual(door.calls.map((c) => c[0]), ['discover', 'create_cart']);
  });

  test('flag off: that variant is answered as it was (its own currency), so the refusal above is the rule\'s doing', async () => {
    const out = await escalate({ op: CREATE, params: createParams(1, SECOND_VARIANT), executor: recordingExecutor(twoVariantRow('USD', 'USD', 'GBP')), ucpArgs: ucpArgs('US'), env: { [UCP_ESCALATION_FLAG]: '1' } });
    assert.equal(out.currency, 'GBP');
  });
});

describe('no answer can be BUILT in another currency than the market\'s', () => {
  const build = (r, extra = {}) => buildEscalationCheckout({
    id: 'esc_x', items: [{ product_id: 'sig_row_a', quantity: 1 }], rows: new Map([['sig_row_a', r]]),
    continueUrl: `https://${HOST}/products/calm-serum`, now: NOW, env: {}, ...extra,
  });
  const thrown = (fn) => { try { fn(); return null; } catch (err) { return err; } };

  test('the catalog builder: a row priced in another currency is refused by name; in the market\'s it is built; with no market currency nothing is checked', () => {
    const err = thrown(() => build(row('USD'), { marketCurrency: 'GBP' }));
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.deepEqual(err.detail.acp_detail, { reason: 'seller_not_priced_in_market_currency', market_currency: 'GBP', seller_currencies: ['USD'], storefront_items: ['sig_row_a'] });
    assert.equal(build(row('GBP'), { marketCurrency: 'GBP' }).currency, 'GBP');
    assert.equal(build(row('USD')).currency, 'USD');
    assert.equal(JSON.stringify(build(row('USD'), { marketCurrency: 'USD' })), JSON.stringify(build(row('USD'))), 'the check adds nothing to an answer it passes');
  });

  test('the catalog builder: the CHOSEN variant\'s price is what is checked', () => {
    const items = [{ product_id: 'sig_row_a', quantity: 1, variant_id: SECOND_VARIANT }];
    const err = thrown(() => build(twoVariantRow('USD', 'USD', 'GBP'), { items, marketCurrency: 'USD' }));
    assert.equal(err.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual(err.detail.acp_detail.seller_currencies, ['GBP']);
    assert.equal(build(twoVariantRow('USD', 'USD', 'GBP'), { items, marketCurrency: 'GBP' }).currency, 'GBP');
  });

  test('the catalog builder: a market currency that is not a currency code builds nothing (it is never treated as "no rule")', () => {
    for (const marketCurrency of [null, '', 'gbp', 'GB', 5, 'USDX']) {
      const err = thrown(() => build(row('USD'), { marketCurrency }));
      assert.equal(err && err.detail.acp_detail.reason, 'seller_not_priced_in_market_currency', JSON.stringify(marketCurrency));
    }
  });

  test('the seller-priced builder: an answer in another currency is refused by name; in the market\'s it is built', () => {
    const priced = (currency) => ({ currency, continueUrl: `https://${HOST}/cart/c/cart_0001`, lineItems: [], totals: [], sellerMessageCodes: [], cartId: 'cart_0001' });
    const err = thrown(() => buildSellerPricedCheckout({ id: 'esc_x', priced: priced('USD'), sellerHost: HOST, now: NOW, env: {}, marketCurrency: 'GBP' }));
    assert.equal(err.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual(err.detail.acp_detail.seller_currencies, ['USD']);
    assert.equal(buildSellerPricedCheckout({ id: 'esc_x', priced: priced('GBP'), sellerHost: HOST, now: NOW, env: {}, marketCurrency: 'GBP' }).currency, 'GBP');
    assert.equal(buildSellerPricedCheckout({ id: 'esc_x', priced: priced('USD'), sellerHost: HOST, now: NOW, env: {} }).currency, 'USD');
  });
});
