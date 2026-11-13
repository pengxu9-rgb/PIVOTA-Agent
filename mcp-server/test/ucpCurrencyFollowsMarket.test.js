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
  checkoutSwitchOn,
  ucpEscalationEnabled,
  marketCurrencyOf,
  lineCurrencyLabelsOf,
  tryEscalateUcpCheckout,
  escalationRecordIdOf,
  buildEscalationCheckout,
  buildSellerPricedCheckout,
  encodeEscalationId,
} from '../src/ucpCheckoutEscalation.js';

import {
  MCP_STOREFRONT_ESCALATION_FLAG,
  MCP_STOREFRONT_PATH,
  mcpStorefrontCartPath,
  mcpStorefrontCartSurface,
  mcpStorefrontEscalationEnabled,
} from '../src/mcpStorefrontCart.js';
import { createCommerceToolSurface, commerceToolDefinitions } from '../src/commerceToolSurface.js';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { resolveServingCurrency } = require('../../src/services/buyerMarket.js');
const { BUYER_REGION_CURRENCY } = require('../../src/auroraBff/buyerRegion.js');
const { noteWithheldCurrencies, noteWithheldCurrenciesOfPdpResponse, withheldCurrenciesOf, withheldCurrenciesOfPdpResponse } = require('../../src/services/pdpWithheldCurrencies.js');
const { unscopedDetailPdpRequest } = require('../../src/services/pdpDetailHop.js');

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
    noteWithheldCurrencies(r, ['sgd', 'EUR', 'EUR', 'nope', 'US', 5]);
    assert.deepEqual(withheldCurrenciesOf(r), ['EUR', 'SGD'], 'the note keeps currency codes only, once each, sorted');
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

  test('THE READ THE DOOR MAKES ASKS FOR NO OFFERS, which is the only reason the withheld list may label a row', () => {
    // The page reports ONE `withheld_currencies` list: the card's own withheld currencies merged with those of every
    // offer on the page (other sellers' money). The door reads its rows through the unscoped detail hop, and that hop
    // asks for the product overview only, so no offer is built and the list is the card's alone.
    const WHY = [
      "the unscoped detail hop must ask get_pdp_v2 for include: ['product_overview'] and nothing else.",
      "With offers on the page, metadata.serving_currency_guard.withheld_currencies also lists OTHER SELLERS' currencies,",
      'and the storefront checkout would label a seller\'s unpriced row with them (and ask the wrong store for a cart).',
      'If the hop must include offers, the page has to report the card\'s own withheld currencies separately first.',
    ].join(' ');
    const asked = [
      unscopedDetailPdpRequest('sig_row_a', { product: { product_id: 'sig_row_a' } }, undefined),
      unscopedDetailPdpRequest('sig_row_a', { product: { product_id: 'sig_row_a' } }, 'GB'),
      // Nothing a caller puts in its own payload widens what the hop asks for.
      unscopedDetailPdpRequest('sig_row_a', { product: { product_id: 'sig_row_a' }, include: ['offers', 'similar'], market: 'SG' }, undefined),
      unscopedDetailPdpRequest('sig_row_a', { include: ['offers'], options: { include: ['offers'] }, offers: true }, 'US'),
    ];
    for (const request of asked) {
      assert.equal(request.operation, 'get_pdp_v2');
      assert.deepEqual(request.payload.include, ['product_overview'], WHY);
      assert.deepEqual(Object.keys(request.payload).filter((key) => !['product_ref', 'include', 'market'].includes(key)), [], WHY);
      assert.equal(JSON.stringify(request).includes('offers'), false, WHY);
    }
  });

  test('noting what a page withheld never throws, whatever the page or the product is', () => {
    const product = {};
    assert.equal(noteWithheldCurrenciesOfPdpResponse(product, { metadata: { serving_currency_guard: { withheld_currencies: ['GBP'] } } }), true);
    assert.deepEqual(withheldCurrenciesOf(product), ['GBP']);
    const throwing = { get metadata() { throw new Error('unreadable'); } };
    const untouched = {};
    assert.equal(noteWithheldCurrenciesOfPdpResponse(untouched, throwing), false);
    assert.deepEqual(withheldCurrenciesOf(untouched), []);
    const badList = { metadata: { serving_currency_guard: { get withheld_currencies() { throw new Error('unreadable'); } } } };
    assert.equal(noteWithheldCurrenciesOfPdpResponse({}, badList), false);
    for (const [p, b] of [[null, null], [undefined, undefined], ['x', 5], [Object.freeze({}), { metadata: { serving_currency_guard: { withheld_currencies: ['USD'] } } }]]) {
      assert.doesNotThrow(() => noteWithheldCurrenciesOfPdpResponse(p, b));
    }
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
        // Flag on, one more line says the rule could say nothing about this row (see the next test).
        const fallback = { event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'catalog_currency_unknown', seller_host: HOST };
        const unlabelled = { event: 'ucp_merchant_door_pricing', outcome: 'unlabelled', reason: 'row_currency_unknown', market: country, expected_currency: country === 'GB' ? 'GBP' : 'USD', lines: 1 };
        assert.deepEqual(log.lines, env === ON ? [unlabelled, fallback] : [fallback]);
      }
    }
  });

  test('A LOST NOTE IS VISIBLE: a withheld row that reaches the door as a copy is answered safely, and one line says the rule had nothing to read', async () => {
    // The read withheld GBP and noted it, and something between the read and the door copied the row: the note is gone.
    const copying = { async execute() { const product = { ...row(null), price: null, currency: null }; noteWithheldCurrencies(product, ['GBP']); return { product: { ...product } }; } };
    for (const [op, params, args] of [
      [CREATE, createParams(2), ucpArgs('GB')],
      [GET, { session_id: encodeEscalationId([{ product_id: 'sig_row_a', quantity: 2 }], 'cart_0001', HOST, { code: 'GB', assumed: false }) }, {}],
    ]) {
      const door = fakeDoor('GBP');
      const log = logOf();
      const err = await rejected(escalate({ op, params, executor: copying, ucpArgs: args, env: ON, merchantDoor: door, log }));
      assert.equal(err.detail.reason, 'ucp_escalation_item_unpriced', `${op.id}: no price is shown`);
      assert.deepEqual(door.calls, [], `${op.id}: and no seller is asked`);
      const line = log.lines.find((l) => l.outcome === 'unlabelled');
      assert.deepEqual(line, { event: 'ucp_merchant_door_pricing', outcome: 'unlabelled', reason: 'row_currency_unknown', market: 'GB', expected_currency: 'GBP', lines: 1 }, op.id);
      // A count and a market: no product id, no seller host, no cart id, no buyer data.
      assert.deepEqual(Object.keys(line).sort(), ['event', 'expected_currency', 'lines', 'market', 'outcome', 'reason']);
      assert.equal(JSON.stringify(line).includes('sig_row_a') || JSON.stringify(line).includes(HOST) || JSON.stringify(line).includes('cart_0001'), false);
    }
    // The same row with its note intact logs no such line (it is priced by the seller), and neither does a priced row.
    for (const served of [withheldRow('GBP'), row('GBP')]) {
      const log = logOf();
      const out = await escalate({ op: CREATE, params: createParams(), executor: recordingExecutor(served), ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: fakeDoor('GBP'), log });
      assert.equal(out.currency, 'GBP');
      assert.deepEqual(log.lines.map((l) => l.outcome), ['priced']);
    }
    // Flag off the rule does not run, so it says nothing.
    const offLog = logOf();
    await rejected(escalate({ op: CREATE, params: createParams(), executor: copying, ucpArgs: ucpArgs('GB'), env: OFF, merchantDoor: fakeDoor('GBP'), log: offLog }));
    assert.equal(offLog.lines.some((l) => l.outcome === 'unlabelled'), false);
  });

  test('two unlabelled lines of one cart are one log line with a count of two', async () => {
    const silent = (id) => ({ ...row(null), product_id: id, price: null, currency: null });
    const executor = { async execute(op, params) { return { product: silent(params.payload.product.product_id) }; } };
    const log = logOf();
    const params = { idempotency_key: 'idem-0002', quote: { items: [{ product_id: 'sig_row_a', quantity: 1 }, { product_id: 'sig_row_b', quantity: 1 }] } };
    await rejected(escalate({ op: CREATE, params, executor, ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: fakeDoor('GBP'), log }));
    assert.deepEqual(log.lines.filter((l) => l.outcome === 'unlabelled'), [{ event: 'ucp_merchant_door_pricing', outcome: 'unlabelled', reason: 'row_currency_unknown', market: 'GB', expected_currency: 'GBP', lines: 2 }]);
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
    const log = logOf();
    const id = encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], 'cart_0001', HOST, { code: 'GB', assumed: false });
    const err = await rejected(escalate({ op: GET, params: { session_id: id }, executor, ucpArgs: {}, env: ON, merchantDoor: door, log }));
    assert.deepEqual(err.detail.acp_detail, refusalDetail(['USD']));
    assert.deepEqual(door.calls, []);
    assert.deepEqual(executor.seen, THE_READ);
    // The seller door was not even entered for it: the one line is the refusal's.
    assert.deepEqual(log.lines, [{
      event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency',
      market: 'GB', expected_currency: 'GBP', row_currency: 'USD', seller_host: HOST,
    }]);
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

  // THE DOOR HANDS ITS BUILDER THE MARKET'S CURRENCY. The pre-check and the builder read the same row, so to show the
  // builder is really the last step the row is changed BETWEEN them: the seller door (asked after the pre-check, before
  // the build) fails, and while failing re-labels the row. An answer in the row's new currency must not be built.
  test('create and re-read: a row that changes currency after the pre-check is still not answered in another currency', async () => {
    const relabelling = (product) => ({
      async endpointFor() { return ENDPOINT; },
      async createCart() { product.currency = 'USD'; return { ok: false, status: 500 }; },
      async getCart() { product.currency = 'USD'; return { ok: false, status: 500 }; },
    });
    const created = row('GBP');
    const err = await rejected(escalate({ op: CREATE, params: createParams(), executor: { async execute() { return { product: created }; } }, ucpArgs: ucpArgs('GB'), env: ON, merchantDoor: relabelling(created) }));
    assert.equal(created.currency, 'USD', 'the row was re-labelled under the door');
    assert.ok(err, 'create: an answer was built in the new currency');
    assert.equal(err.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual([err.detail.acp_detail.market_currency, err.detail.acp_detail.seller_currencies], ['GBP', ['USD']]);

    const reread = row('GBP');
    const id = encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], 'cart_0001', HOST, { code: 'GB', assumed: false });
    const again = await rejected(escalate({ op: GET, params: { session_id: id }, executor: { async execute() { return { product: reread }; } }, ucpArgs: {}, env: ON, merchantDoor: relabelling(reread) }));
    assert.equal(reread.currency, 'USD');
    assert.ok(again, 're-read: an answer was built in the new currency');
    assert.equal(again.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    // Flag off, the same sequence answers in whatever the row says at build time, as it always did.
    const offRow = row('GBP');
    const out = await escalate({ op: CREATE, params: createParams(), executor: { async execute() { return { product: offRow }; } }, ucpArgs: ucpArgs('GB'), env: OFF, merchantDoor: relabelling(offRow) });
    assert.equal(out.currency, 'USD');
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

// ---- the `/mcp` storefront path requires the rule ------------------------------------------------------------------

describe('the /mcp storefront path runs only with the currency rule on', () => {
  const ON_VALUES = ['1', 'true', 'TRUE', 'yes', ' on ', 'enabled'];
  const OFF_VALUES = [undefined, '', ' ', '0', 'false', 'off', 'no', 'enforce', '2', 'garbage'];
  const envOf = (mcp, currency) => ({ [MCP_STOREFRONT_ESCALATION_FLAG]: mcp, [CURRENCY_FOLLOWS_MARKET_FLAG]: currency });
  async function withEnv(vars, fn) {
    const before = {};
    for (const [k, v] of Object.entries(vars)) { before[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
  function recordingSurface() {
    const calls = [];
    const tools = commerceToolDefinitions.map((t) => ({ ...t }));
    return { calls, tools, isCommerceTool: () => true, callTool: (...args) => { calls.push(args); return Promise.resolve('answer'); } };
  }
  const CHECKOUT_TOOLS = ['create_checkout_session', 'get_checkout_session', 'update_checkout_session', 'complete_checkout_session', 'cancel_checkout_session', 'create_payment_link'];

  test('the three states: on needs BOTH switches; the path\'s own switch with the rule off is its own state, not "on"', () => {
    assert.deepEqual(MCP_STOREFRONT_PATH, { on: 'on', off: 'off', needsCurrencyRule: 'needs_currency_rule' });
    for (const mcp of [...ON_VALUES, ...OFF_VALUES]) {
      for (const currency of [...ON_VALUES, ...OFF_VALUES]) {
        const expected = !ON_VALUES.includes(mcp) ? 'off' : ON_VALUES.includes(currency) ? 'on' : 'needs_currency_rule';
        assert.equal(mcpStorefrontCartPath(envOf(mcp, currency)), expected, JSON.stringify([mcp, currency]));
      }
    }
    assert.equal(mcpStorefrontCartPath({}), 'off');
  });

  test('both switches are read by ONE reader: each agrees with it on every value, and so with each other', () => {
    for (const v of [...ON_VALUES, ...OFF_VALUES, 'True', 'YES', 'On', '\ton\n', 'Enabled', '10', '01', 'y', 'true1', 'xon']) {
      const byReader = checkoutSwitchOn({ A_SWITCH: v }, 'A_SWITCH');
      assert.equal(mcpStorefrontEscalationEnabled({ [MCP_STOREFRONT_ESCALATION_FLAG]: v }), byReader, JSON.stringify(v));
      assert.equal(currencyFollowsMarketEnabled({ [CURRENCY_FOLLOWS_MARKET_FLAG]: v }), byReader, JSON.stringify(v));
      assert.equal(ucpEscalationEnabled({ [UCP_ESCALATION_FLAG]: v }), byReader, JSON.stringify(v));
      // The path with the other switch held on is exactly that one reader's answer.
      assert.equal(mcpStorefrontCartPath(envOf(v, '1')) === 'on', byReader, JSON.stringify(v));
      assert.equal(mcpStorefrontCartPath(envOf('1', v)) === 'on', byReader, JSON.stringify(v));
    }
    assert.equal(checkoutSwitchOn(null, 'A_SWITCH'), false);
    assert.equal(checkoutSwitchOn({}, 'A_SWITCH'), false);
  });

  test('the view: with its switch on and the rule off, every call and the tool list are the wrapped surface\'s own, as with its switch off', async () => {
    for (const [mcp, currency, marked] of [[undefined, undefined, false], ['1', undefined, false], [undefined, '1', false], ['1', '0', false], ['1', 'enforce', false], ['1', '1', true]]) {
      const inner = recordingSurface();
      const lines = [];
      const view = mcpStorefrontCartSurface(inner, { log: { info: (line) => lines.push(line) } });
      const observe = () => {};
      const session = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
      await withEnv(envOf(mcp, currency), async () => {
        const args = { quote: {} };
        const options = { observe };
        for (const tool of CHECKOUT_TOOLS) assert.equal(await view.callTool(tool, args, session, options), 'answer');
        await view.callTool('search_catalog', args, session, options);
        const label = JSON.stringify([mcp, currency]);
        assert.equal(view.tools === inner.tools, !marked, `${label}: the tool list`);
        assert.equal(inner.calls.length, 7);
        for (const [i, call] of inner.calls.entries()) {
          assert.equal(call[1], args, `${label}: the caller's own arguments object`);
          assert.equal(call[2], session);
          const isCheckout = i < 6;
          if (marked && isCheckout) assert.deepEqual(call[3], { observe, storefrontCartDoor: true }, label);
          else assert.equal(call[3], options, `${label}: the caller's own options object, nothing added`);
        }
        // ONE line per checkout call in the one state it explains, and none in any other state or for any other tool.
        const expected = mcp === '1' && !marked
          ? CHECKOUT_TOOLS.map((tool) => ({ event: 'mcp_storefront_cart_path', outcome: 'not_run', reason: 'currency_follows_market_off', tool }))
          : [];
        assert.deepEqual(lines, expected, label);
      });
    }
  });

  test('the line carries nothing from the request, and a logger that throws does not fail the call', async () => {
    const inner = recordingSurface();
    const lines = [];
    const view = mcpStorefrontCartSurface(inner, { log: { info: (...args) => lines.push(args) } });
    await withEnv(envOf('1', undefined), async () => {
      await view.callTool('get_checkout_session', { session_id: 'esc_secret_id', market: 'GB' }, { user_ref: 'buyer_secret', acp_session_id: 'sess_secret' });
    });
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0][0]).sort(), ['event', 'outcome', 'reason', 'tool']);
    assert.equal(/secret|esc_|GB/.test(JSON.stringify(lines[0])), false);
    const throwing = mcpStorefrontCartSurface(inner, { log: { info: () => { throw new Error('log down'); } } });
    await withEnv(envOf('1', undefined), async () => {
      assert.equal(await throwing.callTool('create_checkout_session', {}, {}), 'answer');
    });
    for (const log of [null, undefined, {}, { info: 'x' }]) {
      const quiet = mcpStorefrontCartSurface(inner, log === undefined ? {} : { log });
      await withEnv(envOf('1', undefined), async () => { assert.equal(await quiet.callTool('create_checkout_session', {}, {}), 'answer'); });
    }
  });

  test('the flags are read per call: turning the rule off turns the path off on the next call', async () => {
    const inner = recordingSurface();
    const view = mcpStorefrontCartSurface(inner, { log: null });
    for (const [currency, marked] of [['1', true], [undefined, false], ['1', true], ['0', false]]) {
      await withEnv(envOf('1', currency), async () => { await view.callTool('create_checkout_session', {}, {}); });
      assert.equal(Boolean(inner.calls.at(-1)[3] && inner.calls.at(-1)[3].storefrontCartDoor), marked, String(currency));
    }
  });

  // The whole native door at module level: the real surface behind the real view, a recording executor and seller door.
  const SELLER = 'merch_obs_000000000000000a';
  const nativeRow = (currency, extra = {}) => ({ ...row(currency), merchant_id: SELLER, ...extra });
  const nativeCreateArgs = (market, extra = {}) => ({
    idempotency_key: 'idem-0009',
    quote: { merchant_id: SELLER, items: [{ product_id: 'sig_row_a', quantity: 1 }], customer_email: 'buyer@example.test' },
    ...(market === undefined ? {} : { market }),
    ...extra,
  });
  function nativeDoor(served, storeCurrency) {
    const seen = [];
    const executor = {
      seen,
      async execute(op, params) {
        seen.push({ op, params: structuredClone(params) });
        if (op !== 'get_product') return { session_id: 'q_kernel', status: 'ready_for_payment' };
        const { __withheld: withheld, ...product } = structuredClone(served);
        if (withheld) noteWithheldCurrencies(product, withheld);
        return { product };
      },
    };
    const door = fakeDoor(storeCurrency);
    const lines = [];
    const surface = createCommerceToolSurface(executor, { cache: false, merchantDoor: door, log: { info: (l) => lines.push(l), warn: () => {} } });
    const view = mcpStorefrontCartSurface(surface, { log: { info: (l) => lines.push(l) } });
    return { view, executor, door, lines };
  }
  const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
  const ARMED = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1', MERCHANT_PURCHASABILITY_GATE_ENABLED: undefined };
  const call = (d, tool, args, flags) => withEnv({ ...ARMED, ...flags }, () => d.view.callTool(tool, args, SESSION).then((value) => ({ value }), (error) => ({ error })));
  const BOTH = envOf('1', '1');

  test('both on, create: the currency is the REQUEST market\'s; a seller in another currency is refused by name with no store call; DE and ZZ are refused by name', async () => {
    // GB buyer, USD seller.
    let d = nativeDoor(nativeRow('USD'), 'USD');
    let out = await call(d, 'create_checkout_session', nativeCreateArgs('GB'), BOTH);
    assert.equal(out.error.code, 'NO_MERCHANT_OFFER');
    assert.equal(out.error.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual([out.error.detail.acp_detail.market, out.error.detail.acp_detail.market_currency, out.error.detail.acp_detail.seller_currencies], ['GB', 'GBP', ['USD']]);
    assert.deepEqual(d.door.calls, [], 'no store call');
    assert.deepEqual(d.executor.seen.map((s) => [s.op, JSON.stringify(s.params)]), [['get_product', '{"payload":{"product":{"product_id":"sig_row_a"}}}']], 'one product read, no market on it, and the kernel is not asked');
    // GB buyer, a seller whose money the read withheld in GBP: priced in GBP by the store, in the native shape.
    d = nativeDoor({ ...withheldRow('GBP'), merchant_id: SELLER }, 'GBP');
    out = await call(d, 'create_checkout_session', nativeCreateArgs('GB'), BOTH);
    assert.equal(out.value.status, 'completes_on_seller_storefront');
    assert.equal(out.value.currency, 'GBP');
    assert.deepEqual(d.door.calls.map((c) => c[0]), ['discover', 'create_cart']);
    // ... and when that store answers in USD: the named refusal, nothing in USD shown.
    d = nativeDoor({ ...withheldRow('GBP'), merchant_id: SELLER }, 'USD');
    out = await call(d, 'create_checkout_session', nativeCreateArgs('GB'), BOTH);
    assert.equal(out.error.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual(out.error.detail.acp_detail.seller_currencies, ['USD']);
    // US buyer, USD seller: priced in USD.
    d = nativeDoor(nativeRow('USD'), 'USD');
    out = await call(d, 'create_checkout_session', nativeCreateArgs('US'), BOTH);
    assert.equal(out.value.currency, 'USD');
    // Markets with no currency: refused by name, no store call, never answered as US.
    for (const market of ['DE', 'ZZ']) {
      d = nativeDoor(nativeRow('USD'), 'USD');
      out = await call(d, 'create_checkout_session', nativeCreateArgs(market), BOTH);
      assert.equal(out.error.code, 'NO_MERCHANT_OFFER', market);
      assert.equal(out.error.detail.acp_detail.reason, 'market_not_priced', market);
      assert.deepEqual(d.door.calls, [], market);
    }
    // A missing or malformed market keeps this door's own refusals, as without the rule.
    d = nativeDoor(nativeRow('USD'), 'USD');
    out = await call(d, 'create_checkout_session', nativeCreateArgs(undefined), BOTH);
    assert.equal(out.error.detail.acp_detail.reason, 'market_required_for_seller_storefront');
    out = await call(d, 'create_checkout_session', nativeCreateArgs('USA'), BOTH);
    assert.equal(out.error.code, 'INVALID_ARGUMENTS');
    assert.deepEqual(d.door.calls, []);
  });

  test('the path\'s switch on and the rule off: the GB create that would be answered in USD at the seller is the answer the door gives with the path off, and no store is called', async () => {
    const answers = {};
    for (const [name, flags] of [['off', envOf(undefined, undefined)], ['mcp_only', envOf('1', undefined)], ['rule_only', envOf(undefined, '1')]]) {
      const d = nativeDoor(nativeRow('USD'), 'USD');
      const withMarket = await call(d, 'create_checkout_session', nativeCreateArgs('GB'), flags);
      const noMarket = await call(d, 'create_checkout_session', nativeCreateArgs(undefined), flags);
      const reread = await call(d, 'get_checkout_session', { session_id: encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], 'cart_0001', HOST, { code: 'GB', assumed: false }) }, flags);
      assert.deepEqual(d.door.calls, [], `${name}: no store call`);
      answers[name] = JSON.stringify([
        withMarket.error && [withMarket.error.code, withMarket.error.message], noMarket.value || [noMarket.error.code, noMarket.error.detail],
        reread.value || [reread.error.code, reread.error.detail], d.executor.seen,
      ]);
      assert.equal(withMarket.error.code, 'INVALID_ARGUMENTS', `${name}: \`market\` is not an argument while the path is not on`);
      assert.equal(d.lines.filter((l) => l.event === 'mcp_storefront_cart_path').length, name === 'mcp_only' ? 3 : 0, name);
    }
    assert.equal(answers.mcp_only, answers.off);
    assert.equal(answers.rule_only, answers.off);
  });

  test('both on, re-read and update: an id minted for GB over a USD seller\'s cart is re-judged, not replayed; update states no price', async () => {
    // An id as a create made BEFORE the rule would have minted it (GB, a USD store cart).
    const id = encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], 'cart_0001', HOST, { code: 'GB', assumed: false });
    let d = nativeDoor(nativeRow('USD'), 'USD');
    let out = await call(d, 'get_checkout_session', { session_id: id }, BOTH);
    assert.equal(out.error.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual(d.door.calls, [], 'the cart is not read');
    // The id's own market is the one judged: the same seller and cart under a US id is served, in USD.
    const usId = encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], 'cart_0001', HOST, { code: 'US', assumed: false });
    d = nativeDoor(nativeRow('USD'), 'USD');
    out = await call(d, 'get_checkout_session', { session_id: usId }, BOTH);
    assert.equal(out.value.currency, 'USD');
    assert.deepEqual(d.door.calls.map((c) => c[0]), ['discover', 'get_cart']);
    // DE id and an id with no market.
    d = nativeDoor(nativeRow('USD'), 'USD');
    out = await call(d, 'get_checkout_session', { session_id: encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], undefined, undefined, { code: 'DE', assumed: false }) }, BOTH);
    assert.equal(out.error.detail.acp_detail.reason, 'market_not_priced');
    out = await call(d, 'get_checkout_session', { session_id: encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }]) }, BOTH);
    assert.equal(out.error.code, 'OPERATION_NOT_ALLOWED');
    assert.deepEqual(d.door.calls, []);
    // update / complete / cancel / payment link on such an id: refused as this door always refuses them, with no price,
    // no product read and no store call. There is no stored answer to replay on this door: every call is computed.
    for (const [tool, args] of [
      ['update_checkout_session', { idempotency_key: 'idem-0011', session_id: id, quote: { items: [{ product_id: 'sig_row_a', quantity: 2 }] } }],
      ['complete_checkout_session', { idempotency_key: 'idem-0012', session_id: id, payment_authorization: { type: 'none' } }],
      ['cancel_checkout_session', { idempotency_key: 'idem-0013', session_id: id }],
    ]) {
      d = nativeDoor(nativeRow('USD'), 'USD');
      out = await call(d, tool, args, BOTH);
      assert.equal(out.error.code, 'OPERATION_NOT_ALLOWED', tool);
      assert.equal(/\d+\.\d\d|USD|GBP/.test(JSON.stringify([out.error.message, out.error.detail])), false, `${tool}: no price, no currency`);
      assert.deepEqual([d.door.calls, d.executor.seen], [[], []], tool);
    }
  });
});

// ---- the hand-off record and the rule ------------------------------------------------------------------------------

describe('a hand-off is recorded only for a checkout the currency rule lets out', () => {
  // The record's two switches, as the hand-off record's own tests set them.
  const RECORDING = { UCP_STOREFRONT_HANDOFF_RECORD_ENABLED: '1', PARTNER_IDENTITY_FORWARDING_ENABLED: '1' };
  const CLICK = 'clk_00112233445566778899aabb';
  const LINK = `https://${HOST}/products/calm-serum?utm_source=pivota&utm_medium=agent&pvt_click_id=${CLICK}`;
  const SELLER = 'merch_obs_000000000000000a';
  const recorded = (served) => ({ ...served, merchant_id: SELLER, external_redirect_url: LINK, price_as_of: '2026-01-10T09:00:00Z' });
  function recorder() {
    const calls = [];
    return { calls, async record(fields) { calls.push(structuredClone(fields)); return { kind: 'recorded' }; } };
  }
  const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const run = (served, country, env, door, rec, op = CREATE, params = createParams(2)) => rejected(
    escalate({ op, params, executor: recordingExecutor(served), ucpArgs: ucpArgs(country), env: { ...env, ...RECORDING }, merchantDoor: door, handoffRecorder: rec })
      .then((out) => { const e = new Error('answered'); e.answer = out; return Promise.reject(e); }),
  );

  test('a refused create writes NO record and makes no record call: seller in another currency, market not priced, storefront answered in another currency, row with no label', async () => {
    const cases = [
      ['GB buyer, USD seller', recorded(row('USD')), 'GB', 'USD', 'seller_not_priced_in_market_currency', []],
      ['SG buyer, a seller withheld in GBP', recorded(withheldRow('GBP')), 'SG', 'GBP', 'seller_not_priced_in_market_currency', []],
      ['DE buyer (no currency)', recorded(row('USD')), 'DE', 'USD', 'market_not_priced', []],
      ['ZZ buyer (no such market)', recorded(row('USD')), 'ZZ', 'USD', 'market_not_priced', []],
      ['GB buyer, GBP seller whose storefront answers USD', recorded(withheldRow('GBP')), 'GB', 'USD', 'seller_not_priced_in_market_currency', ['discover', 'create_cart']],
      ['GB buyer, a row that says nothing', recorded({ ...row(null), price: null }), 'GB', 'GBP', 'ucp_escalation_item_unpriced', []],
    ];
    for (const [label, served, country, storeCurrency, reason, doorCalls] of cases) {
      const rec = recorder();
      const door = fakeDoor(storeCurrency);
      const err = await run(served, country, ON, door, rec);
      assert.equal(err.answer, undefined, `${label}: an answer was given`);
      assert.equal((err.detail.acp_detail || err.detail).reason, reason, label);
      assert.deepEqual(rec.calls, [], `${label}: a hand-off was recorded for a refused checkout`);
      assert.deepEqual(door.calls.map((c) => c[0]), doorCalls, label);
    }
    // Before the rule (flag off) the first of these IS handed out, in USD, and recorded: the refusal is the rule's.
    const rec = recorder();
    const before = await run(recorded(row('USD')), 'GB', OFF, fakeDoor('USD'), rec);
    assert.equal(before.answer.currency, 'USD');
    assert.equal(rec.calls.length, 1);
  });

  test('a row re-labelled after the pre-check: the builder refuses, and nothing was recorded for it', async () => {
    const product = recorded(row('GBP'));
    const rec = recorder();
    const relabelling = { async endpointFor() { return ENDPOINT; }, async createCart() { product.currency = 'USD'; return { ok: false, status: 500 }; } };
    const err = await rejected(escalate({
      op: CREATE, params: createParams(), executor: { async execute() { return { product }; } }, ucpArgs: ucpArgs('GB'),
      env: { ...ON, ...RECORDING }, merchantDoor: relabelling, handoffRecorder: rec,
    }));
    assert.equal(err.detail.acp_detail.reason, 'seller_not_priced_in_market_currency');
    assert.deepEqual(rec.calls, []);
  });

  test('a create priced by the seller in the market\'s currency writes exactly one record, with the fields the hand-off record always carries', async () => {
    const rec = recorder();
    const door = fakeDoor('GBP');
    const { answer } = await run(recorded(withheldRow('GBP')), 'GB', ON, door, rec, CREATE, createParams(1));
    assert.equal(answer.currency, 'GBP');
    const recordId = escalationRecordIdOf(answer.id);
    assert.match(recordId, /^esh_[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(rec.calls, [{
      record_id: recordId, binding: sha(answer.id), seller_host: HOST, currency: 'GBP', quoted_total_minor: 2750,
      quote_source: 'seller_cart', buyer_market: 'GB', referral_click_id: CLICK, price_as_of: new Date(NOW).toISOString(), merchant_id: SELLER,
    }]);
    assert.equal(answer.quote_source, 'seller_cart');
    assert.deepEqual(door.calls.map((c) => c[0]), ['discover', 'create_cart']);
  });

  test('a create answered from the catalogue in the market\'s currency writes exactly one record, for the totals it shows', async () => {
    const rec = recorder();
    // No seller pricing: the catalogue answer. Its GBP price is the market's.
    const { answer } = await run(recorded(row('GBP')), 'GB', { [UCP_ESCALATION_FLAG]: '1', [CURRENCY_FOLLOWS_MARKET_FLAG]: '1' }, undefined, rec);
    assert.deepEqual([answer.currency, answer.quote_source], ['GBP', 'catalogue_fallback']);
    const recordId = escalationRecordIdOf(answer.id);
    assert.deepEqual(rec.calls, [{
      record_id: recordId, binding: sha(answer.id), seller_host: HOST, currency: 'GBP', quoted_total_minor: 5000,
      quote_source: 'catalogue_fallback', buyer_market: 'GB', referral_click_id: CLICK, price_as_of: '2026-01-10T09:00:00.000Z', merchant_id: SELLER,
    }]);
  });

  test('US, USD seller: the record written with the rule on is the record written with it off', async () => {
    const one = async (env) => {
      const rec = recorder();
      const { answer } = await run(recorded(row('USD')), 'US', env, fakeDoor('USD'), rec, CREATE, createParams(1));
      const [fields] = rec.calls;
      assert.equal(rec.calls.length, 1);
      assert.equal(fields.binding, sha(answer.id));
      const { record_id: _id, binding: _binding, ...rest } = fields;
      return rest;
    };
    assert.deepEqual(await one(ON), await one(OFF));
    assert.deepEqual(await one(ON), {
      seller_host: HOST, currency: 'USD', quoted_total_minor: 2750, quote_source: 'seller_cart', buyer_market: 'US',
      referral_click_id: CLICK, price_as_of: new Date(NOW).toISOString(), merchant_id: SELLER,
    });
  });
});
