'use strict';

// The invoke door's last line (src/services/servingCurrencyGuard.js): Peng 2026-09-26, a row priced
// in another currency than the buyer's never leaves the door, whichever lane built the page.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { enforceServingCurrency, requestedMarketOf, servingCurrencyFor, GUARDED_OPERATIONS } =
  require(path.join(ROOT, 'src/services/servingCurrencyGuard'));

const page = () => ({
  status: 'success',
  total: 5,
  products: [
    { product_id: 'usd', currency: 'USD' },
    { product_id: 'sgd', currency: 'SGD' },
    { product_id: 'jpy_lower', currency: ' jpy ' },
    { product_id: 'none', price: 12 },
    { product_id: 'usd_price_currency', price_currency: 'usd' },
  ],
  metadata: { query_source: 'x' },
});
const ids = (body) => body.products.map((p) => p.product_id);

test('a silent request is a US request: only USD rows leave, a row with no currency does not', () => {
  const out = enforceServingCurrency({ operation: 'find_products_multi', payload: { search: { query: 'x' } }, metadata: {}, body: page() });
  assert.deepStrictEqual(ids(out), ['usd', 'usd_price_currency']);
  assert.strictEqual(out.total, 2);
  assert.deepStrictEqual(out.metadata.serving_currency_guard,
    { serving_currency: 'USD', dropped_count: 3, dropped_currencies: ['JPY', 'SGD', 'unknown'] });
  assert.strictEqual(out.metadata.query_source, 'x', 'existing metadata kept');
});

test('a card with no price at all quotes no currency and is left alone; a price with no currency is not', () => {
  const body = { products: [
    { product_id: 'unpriced', price_absent_reason: 'no_offer_derived_price' },
    { product_id: 'blank_price', price: '' },
    { product_id: 'priced_no_currency', price_amount: 9 },
    { product_id: 'price_min_no_currency', price_min: 0 },
    { product_id: 'nested', price: { amount: 5, currency: 'usd' } },
    { product_id: 'nested_sgd', price: { amount: 5, currency: 'SGD' } },
  ] };
  const out = enforceServingCurrency({ operation: 'find_products_multi', payload: {}, body });
  assert.deepStrictEqual(ids(out), ['unpriced', 'blank_price', 'nested']);
  // Even a market with no known currency keeps a card that quotes none.
  const unpriced = enforceServingCurrency({ operation: 'find_products_multi', payload: { market: 'ZZ' }, body });
  assert.deepStrictEqual(ids(unpriced), ['unpriced', 'blank_price']);
});

test('an SG buyer keeps SGD and loses USD -- from the request, or from what the door bound', () => {
  const fromRequest = enforceServingCurrency({ operation: 'find_products_multi', payload: { search: { market: 'sg' } }, body: page() });
  assert.deepStrictEqual(ids(fromRequest), ['sgd']);
  const fromMetadata = enforceServingCurrency({ operation: 'find_products_multi', payload: {}, metadata: { market: 'SG' }, body: page() });
  assert.deepStrictEqual(ids(fromMetadata), ['sgd']);
  const flat = enforceServingCurrency({ operation: 'find_products_multi', payload: { query: 'x', market: 'SG' }, body: page() });
  assert.deepStrictEqual(ids(flat), ['sgd']);
});

test('the door\'s own bind wins over re-reading the request, so the guard cannot disagree with the SQL', () => {
  const observation = { market_observed: true, market_serving_currency: 'SGD' };
  const out = enforceServingCurrency({ operation: 'find_products_multi', observation, payload: {}, body: page() });
  assert.deepStrictEqual(ids(out), ['sgd']);
  // The door bound a market with no known currency: nothing leaves.
  const unpriced = enforceServingCurrency({ operation: 'find_products_multi',
    observation: { market_observed: true, market_serving_currency: null }, payload: {}, body: page() });
  assert.deepStrictEqual(ids(unpriced), []);
  // An observation the door never made does not count.
  assert.strictEqual(servingCurrencyFor({ observation: { market_observed: false }, payload: { market: 'JP' } }), 'JPY');
});

test('a market with no known currency gets nothing', () => {
  for (const market of ['ZZ', 'en-US', 'US,SG']) {
    const out = enforceServingCurrency({ operation: 'find_products_multi', payload: { search: { market } }, body: page() });
    assert.deepStrictEqual(ids(out), [], market);
    assert.strictEqual(out.metadata.serving_currency_guard.serving_currency, null);
  }
});

test('every guarded operation is guarded; any other body is returned as the same object', () => {
  for (const operation of GUARDED_OPERATIONS) {
    assert.deepStrictEqual(ids(enforceServingCurrency({ operation, payload: {}, body: page() })), ['usd', 'usd_price_currency'], operation);
  }
  assert.deepStrictEqual([...GUARDED_OPERATIONS].sort(), ['find_products', 'find_products_multi', 'get_discovery_feed']);
  const body = page();
  assert.strictEqual(enforceServingCurrency({ operation: 'get_pdp_v2', payload: {}, body }), body);
  const clean = { products: [{ currency: 'USD' }], total: 1 };
  assert.strictEqual(enforceServingCurrency({ operation: 'find_products_multi', payload: {}, body: clean }), clean,
    'nothing dropped: untouched, no guard metadata');
});

test('never throws, whatever the body', () => {
  for (const body of [null, undefined, 'x', 7, [], {}, { products: null }, { products: [] }, { products: [null, 3, 'x', []] },
    { products: [{ currency: { code: 'USD' } }], total: null }, { products: [{ currency: 'USD' }], metadata: 'x' }]) {
    assert.doesNotThrow(() => enforceServingCurrency({ operation: 'find_products_multi', payload: null, metadata: null, body }), JSON.stringify(body));
  }
  const junk = enforceServingCurrency({ operation: 'find_products_multi', payload: {}, body: { products: [null, { currency: 'USD' }], total: null } });
  assert.deepStrictEqual(junk.products, [{ currency: 'USD' }]);
  assert.strictEqual(junk.total, null, 'a null total is not invented into a number');
});

test('requestedMarketOf reads the door\'s precedence: search.market || metadata.market', () => {
  assert.strictEqual(requestedMarketOf({ search: { market: 'SG' } }, { market: 'US' }), 'SG');
  assert.strictEqual(requestedMarketOf({ search: { market: '' } }, { market: 'US' }), 'US');
  assert.strictEqual(requestedMarketOf({ search: 'oops', market: 'JP' }, {}), 'JP');
  assert.strictEqual(requestedMarketOf(null, null), undefined);
});
