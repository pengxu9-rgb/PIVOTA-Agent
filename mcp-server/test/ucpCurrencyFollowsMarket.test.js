// A storefront checkout's currency follows the buyer's market (AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET): the
// module-level rules. The real-door behaviour (through `/ucp/mcp`, with a backend and stores answering) is in
// tests/store_cart_currency_follows_market_door.node.test.cjs and tests/store_cart_market_currency_table.node.test.cjs.
//
// What is pinned here:
//   - the flag, and that the market's currency comes from the gateway's ONE source (resolveServingCurrency);
//   - the internal product read carries the market only with the flag on, never asks for a live read, and is the
//     byte-same request as before with the flag off;
//   - the seller's answer is held to the MARKET's currency, not to the catalog row's;
//   - a row that is not in the market's currency never reaches a seller.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { MERCHANT_PRICING_FLAG, priceOnMerchantDoor } from '../src/ucpMerchantDoorPricing.js';
import {
  UCP_ESCALATION_FLAG,
  CURRENCY_FOLLOWS_MARKET_FLAG,
  currencyFollowsMarketEnabled,
  marketCurrencyOf,
  tryEscalateUcpCheckout,
  encodeEscalationId,
} from '../src/ucpCheckoutEscalation.js';

const require = createRequire(import.meta.url);
const { resolveServingCurrency } = require('../../src/services/buyerMarket.js');
const { BUYER_REGION_CURRENCY } = require('../../src/auroraBff/buyerRegion.js');

const OFF = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1' };
const ON = { ...OFF, [CURRENCY_FOLLOWS_MARKET_FLAG]: '1' };
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const HOST = 'store-a.example';
const ENDPOINT = `https://${HOST}/api/ucp/mcp`;
const VARIANT = '44000000000001';

const row = (currency, extra = {}) => ({
  product_id: 'sig_row_a', title: 'Calm Serum', price: 25, currency,
  external_redirect_url: `https://${HOST}/products/calm-serum`,
  variants: [{ variant_id: 'sig_row_a', source_variant_id: VARIANT }],
  ...extra,
});

/** An executor serving one row per market the read names (`null` key = a read that names none). */
function executorByMarket(byMarket) {
  const seen = [];
  return {
    seen,
    async execute(op, params) {
      seen.push({ op, params: structuredClone(params) });
      const market = Object.prototype.hasOwnProperty.call(params.payload, 'market') ? params.payload.market : null;
      const served = Object.prototype.hasOwnProperty.call(byMarket, market) ? byMarket[market] : byMarket.null;
      return { product: structuredClone(served) };
    },
  };
}

function sellerCart(currency, { price = 2750, quantity = 1, id = 'cart_0001' } = {}) {
  const payload = {
    id, currency, continue_url: `https://${HOST}/cart/c/${id}?key=k`,
    line_items: [{ id: 'line_0', item: { id: GID(VARIANT), title: 'Store item', price }, quantity, totals: [{ type: 'subtotal', amount: price * quantity }, { type: 'total', amount: price * quantity }] }],
    totals: [{ type: 'subtotal', amount: price * quantity }, { type: 'total', amount: price * quantity }],
  };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

function fakeDoor(storeCurrency) {
  const calls = [];
  return {
    calls,
    async endpointFor(host) { calls.push(['discover', host]); return ENDPOINT; },
    async createCart(ep, args) { calls.push(['create_cart', structuredClone(args)]); return sellerCart(storeCurrency); },
    async getCart(ep, cartId) { calls.push(['get_cart', cartId]); return sellerCart(storeCurrency, { id: cartId }); },
  };
}
const logOf = () => { const lines = []; return { lines, info: (l) => lines.push(l), warn: (l) => lines.push(l) }; };
const CREATE = { id: 'create_checkout_session', capability: 'checkout' };
const GET = { id: 'get_checkout_session', capability: 'checkout' };
const createParams = (quantity = 1) => ({ idempotency_key: 'idem-0001', quote: { items: [{ product_id: 'sig_row_a', quantity }] } });
const ucpArgs = (country) => (country === undefined ? {} : { checkout: { context: { address_country: country } } });
const rejected = (p) => p.then(() => null, (e) => e);
const allow = async () => ({ offer: true });

describe('the switch and the source', () => {
  test('OFF by default; truthy spellings only', () => {
    assert.equal(CURRENCY_FOLLOWS_MARKET_FLAG, 'AGENT_CHECKOUT_UCP_CURRENCY_FOLLOWS_MARKET');
    assert.equal(currencyFollowsMarketEnabled({}), false);
    for (const v of ['', '0', 'false', 'off', 'no']) assert.equal(currencyFollowsMarketEnabled({ [CURRENCY_FOLLOWS_MARKET_FLAG]: v }), false, v);
    for (const v of ['1', 'true', 'on', ' YES ', 'enabled']) assert.equal(currencyFollowsMarketEnabled({ [CURRENCY_FOLLOWS_MARKET_FLAG]: v }), true, v);
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

describe('the product read', () => {
  test('flag OFF: the read is exactly the request it was, whatever market the checkout names', async () => {
    for (const country of ['US', 'GB', 'DE', undefined]) {
      const executor = executorByMarket({ null: row('USD') });
      await tryEscalateUcpCheckout({ op: CREATE, params: createParams(), ctx: {}, executor, ucpArgs: ucpArgs(country), env: OFF, now: NOW, merchantDoor: fakeDoor('USD'), shouldOfferPurchase: allow });
      assert.deepEqual(executor.seen.map((s) => s.params), [{ payload: { product: { product_id: 'sig_row_a' } } }], String(country));
    }
  });

  test('flag ON: the read carries the market beside the product (never inside it), and never asks for a live read', async () => {
    for (const [country, market] of [['US', 'US'], ['gb', 'GB'], [undefined, 'US']]) {
      const executor = executorByMarket({ null: row('USD'), GB: row('GBP'), US: row('USD') });
      await tryEscalateUcpCheckout({ op: CREATE, params: createParams(), ctx: {}, executor, ucpArgs: ucpArgs(country), env: ON, now: NOW, merchantDoor: fakeDoor(market === 'GB' ? 'GBP' : 'USD'), shouldOfferPurchase: allow });
      assert.deepEqual(executor.seen.map((s) => s.params), [{ payload: { product: { product_id: 'sig_row_a' }, market } }], String(country));
    }
  });

  test('flag ON, a market with no currency: the read names no market (it is never read as another one)', async () => {
    const executor = executorByMarket({ null: row('USD') });
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: createParams(), ctx: {}, executor, ucpArgs: ucpArgs('DE'), env: ON, now: NOW, merchantDoor: fakeDoor('USD'), shouldOfferPurchase: allow }));
    assert.equal(err.detail.reason, 'market_not_priced');
    assert.deepEqual(executor.seen.map((s) => s.params), [{ payload: { product: { product_id: 'sig_row_a' } } }]);
  });

  test("flag ON, a re-read: the read is for the market the id carries", async () => {
    const executor = executorByMarket({ null: row('USD'), GB: row('GBP') });
    const id = encodeEscalationId([{ product_id: 'sig_row_a', quantity: 1 }], undefined, undefined, { code: 'GB', assumed: false });
    const out = await tryEscalateUcpCheckout({ op: GET, params: { session_id: id }, ctx: {}, executor, ucpArgs: {}, env: ON, now: NOW, merchantDoor: fakeDoor('GBP'), shouldOfferPurchase: allow });
    assert.equal(out.currency, 'GBP');
    assert.deepEqual(executor.seen.map((s) => s.params), [{ payload: { product: { product_id: 'sig_row_a' }, market: 'GB' } }]);
  });
});

describe("the seller's answer is held to the market's currency", () => {
  const args = (extra) => ({ items: [{ product_id: 'sig_row_a', quantity: 1 }], sellerHost: HOST, market: 'GB', env: OFF, ...extra });

  test('with `marketCurrency`: a store answering in the ROW\'s currency is still not the market\'s, and is not shown', async () => {
    // The row says USD and the store says USD: they agree with each other, and neither is a price for GB.
    const door = fakeDoor('USD');
    const log = logOf();
    const priced = await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('USD')]]), marketCurrency: 'GBP', merchantDoor: door, log }));
    assert.equal(priced, null);
    assert.deepEqual(log.lines, [{
      event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'store_currency_not_market_currency',
      market: 'GB', expected_currency: 'GBP', row_currency: 'USD', store_currency: 'USD', seller_host: HOST,
    }]);
  });

  test('with `marketCurrency`: a store answering in the market\'s currency is priced, in that currency', async () => {
    const log = logOf();
    const priced = await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('GBP')]]), marketCurrency: 'GBP', merchantDoor: fakeDoor('GBP'), log }));
    assert.equal(priced.currency, 'GBP');
    assert.deepEqual(log.lines, [{ event: 'ucp_merchant_door_pricing', outcome: 'priced', seller_host: HOST, lines: 1, source: 'row_id' }]);
  });

  test('without it (the rule off): the row\'s currency is what the store is held to, and the fallback line is the one it was', async () => {
    assert.equal((await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('USD')]]), merchantDoor: fakeDoor('USD') }))).currency, 'USD');
    const log = logOf();
    assert.equal(await priceOnMerchantDoor(args({ rows: new Map([['sig_row_a', row('USD')]]), merchantDoor: fakeDoor('GBP'), log })), null);
    assert.deepEqual(log.lines, [{ event: 'ucp_merchant_door_pricing', outcome: 'fallback', reason: 'cart_mismatch', seller_host: HOST }]);
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

describe('the escalation, flag ON', () => {
  test('a row stating another currency than the market\'s: refused by name, and the seller door is never touched', async () => {
    const door = fakeDoor('USD');
    const log = logOf();
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: createParams(), ctx: {}, executor: executorByMarket({ null: row('USD') }), ucpArgs: ucpArgs('GB'), env: ON, now: NOW, merchantDoor: door, shouldOfferPurchase: allow, log }));
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.deepEqual(err.detail.acp_detail, {
      reason: 'seller_not_priced_in_market_currency', market: 'GB', market_currency: 'GBP', seller_currencies: ['USD'],
      storefront_items: ['sig_row_a'], seller_hosts: [HOST], storefront_urls: { sig_row_a: `https://${HOST}/products/calm-serum` },
    });
    assert.deepEqual(door.calls, []);
    assert.deepEqual(log.lines, [{
      event: 'ucp_merchant_door_pricing', outcome: 'refused', reason: 'seller_not_priced_in_market_currency',
      market: 'GB', expected_currency: 'GBP', row_currency: 'USD', seller_host: HOST,
    }]);
  });

  test('a gate decline still comes first: the currency rule does not run for a seller the gate refuses', async () => {
    const declines = [];
    const log = logOf();
    const out = await tryEscalateUcpCheckout({
      op: CREATE, params: createParams(), ctx: {}, executor: executorByMarket({ null: row('USD') }), ucpArgs: ucpArgs('GB'),
      env: { ...ON, MERCHANT_PURCHASABILITY_GATE_ENABLED: '1' }, now: NOW, merchantDoor: fakeDoor('USD'), shouldOfferPurchase: async () => ({ offer: false }), declines, log,
    });
    assert.equal(out, null);
    assert.deepEqual(declines, ['merchant_not_purchasable']);
    assert.deepEqual(log.lines, []);
  });

  test('a US checkout whose row is unpriced reads nothing extra and is answered as an unpriced row, as before', async () => {
    const unpriced = { ...row('USD'), price: null, currency: null };
    for (const env of [OFF, ON]) {
      const executor = executorByMarket({ null: unpriced, US: unpriced });
      const door = fakeDoor('USD');
      const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: createParams(), ctx: {}, executor, ucpArgs: ucpArgs('US'), env, now: NOW, merchantDoor: door, shouldOfferPurchase: allow }));
      assert.equal(err.detail.reason, 'ucp_escalation_item_unpriced');
      assert.equal(executor.seen.length, 1);
      assert.deepEqual(door.calls, []);
    }
  });

  test('a GB checkout whose row is unpriced with and without a market: still the unpriced answer, no price, no seller', async () => {
    const unpriced = { ...row('USD'), price: null, currency: null };
    const executor = executorByMarket({ null: unpriced, GB: unpriced });
    const door = fakeDoor('USD');
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: createParams(), ctx: {}, executor, ucpArgs: ucpArgs('GB'), env: ON, now: NOW, merchantDoor: door, shouldOfferPurchase: allow }));
    assert.equal(err.detail.reason, 'ucp_escalation_item_unpriced');
    assert.deepEqual(executor.seen.map((s) => s.params.payload.market ?? null), ['GB', null]);
    assert.deepEqual(door.calls, []);
  });

  test('the second read failing does not fail the checkout: the row is answered as unpriced', async () => {
    const unpriced = { ...row('USD'), price: null, currency: null };
    let n = 0;
    const executor = { async execute() { n += 1; if (n > 1) throw new Error('read failed'); return { product: structuredClone(unpriced) }; } };
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: createParams(), ctx: {}, executor, ucpArgs: ucpArgs('GB'), env: ON, now: NOW, merchantDoor: fakeDoor('USD'), shouldOfferPurchase: allow }));
    assert.equal(err.detail.reason, 'ucp_escalation_item_unpriced');
    assert.equal(n, 2);
  });
});
