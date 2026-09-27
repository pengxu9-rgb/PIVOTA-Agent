'use strict';

// The invoke door's last line (src/services/servingCurrencyGuard.js): Peng 2026-09-26, a row priced
// in another currency than the buyer's never leaves the door, whichever lane built the page.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const {
  enforceServingCurrency, filterProductsToServingCurrency, requestedMarketOf, servingCurrencyFor, GUARDED_OPERATIONS,
  CURRENCY_REQUIRED_OPERATIONS,
} = require(path.join(ROOT, 'src/services/servingCurrencyGuard'));

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

test('the card\'s currency is read as the price contract reads it: offers, variants, codes, the seed snapshot', () => {
  const body = () => ({ products: [
    { product_id: 'usd_in_variants', price: 20, variants: [{ price: 20, currency: 'USD' }] },
    { product_id: 'usd_in_offers', offers: [{ price_amount: 18, priceCurrency: 'USD' }] },
    { product_id: 'sgd_in_offers', offers: [{ amount: 24, currency: 'SGD' }] },
    { product_id: 'sgd_code', price: 24, currency_code: 'SGD' },
    { product_id: 'sgd_snapshot', seed_data: { snapshot: { price_amount: 24, price_currency: 'SGD' } } },
    { product_id: 'usd_written_unreadable_amount', price: 'n/a', currency: 'USD' },
  ] });
  const kept = ['usd_in_variants', 'usd_in_offers', 'usd_written_unreadable_amount'];
  // Strict (fpm): a USD card whose currency sits only in variants[]/offers[] is NOT 'unknown'.
  assert.deepStrictEqual(ids(enforceServingCurrency({ operation: 'find_products_multi', payload: {}, body: body() })), kept);
  // Lenient (discovery): an SGD card shaped that way no longer slips through.
  const discovery = enforceServingCurrency({ operation: 'get_discovery_feed', payload: {}, body: body() });
  assert.deepStrictEqual(ids(discovery), kept);
  assert.deepStrictEqual(discovery.metadata.serving_currency_guard.dropped_currencies, ['SGD']);
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

test('every guarded operation drops another currency; only find_products_multi also drops a price with no currency', () => {
  assert.deepStrictEqual([...GUARDED_OPERATIONS].sort(), ['find_products', 'find_products_multi', 'find_similar_products', 'get_discovery_feed']);
  assert.deepStrictEqual([...CURRENCY_REQUIRED_OPERATIONS], ['find_products_multi']);
  assert.deepStrictEqual(ids(enforceServingCurrency({ operation: 'find_products_multi', payload: {}, body: page() })), ['usd', 'usd_price_currency']);
  // The discovery feed's full-detail cards carry no `currency` field at all: a missing one there is
  // not evidence of a wrong price, so it is kept -- but SGD and JPY still go.
  for (const operation of ['find_products', 'get_discovery_feed']) {
    assert.deepStrictEqual(ids(enforceServingCurrency({ operation, payload: {}, body: page() })), ['usd', 'none', 'usd_price_currency'], operation);
  }
});

test('any other operation, or a page with nothing to drop, is returned as the same object', () => {
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

// The recommendation surfaces' filter (similar products): every product there is NEW to the buyer.
test('a similar card is kept only when every currency it states is the serving one', () => {
  const cards = [
    { product_id: 'usd', price: 20, currency: 'USD' },
    { product_id: 'usd_nested', price: { amount: 20, currency: 'usd' } },
    { product_id: 'sgd', price: 20, currency: 'SGD' },
    // Recall stamped USD, card enrichment then copied in an SGD price object: which is it? Neither.
    { product_id: 'stamped_usd_sgd_price', price: { amount: 30, currency: 'SGD' }, currency: 'USD' },
    { product_id: 'pricing_jpy', price: 20, currency: 'USD', pricing: { current: { amount: 2000, currency: 'JPY' } } },
    { product_id: 'priced_no_currency', price: 20 },
    { product_id: 'unpriced', title: 'no price at all', currency: 'USD' },
    { product_id: 'unpriced_sgd_label', title: 'no price at all', currency: 'SGD' },
  ];
  const kept = (currency) => filterProductsToServingCurrency(cards, currency).map((p) => p.product_id);
  assert.deepStrictEqual(kept('USD'), ['usd', 'usd_nested', 'unpriced', 'unpriced_sgd_label']);
  assert.deepStrictEqual(kept('SGD'), ['sgd', 'unpriced', 'unpriced_sgd_label']);
  // A market nothing is priced in keeps nothing -- not even an unpriced card.
  assert.deepStrictEqual(kept(null), []);
  assert.deepStrictEqual(kept(''), []);
  assert.deepStrictEqual(filterProductsToServingCurrency(null, 'USD'), []);
});

test('find_similar_products is guarded at the door, leniently like the discovery feed', () => {
  const body = { products: [{ product_id: 'usd', currency: 'USD' }, { product_id: 'jpy', currency: 'JPY' }, { product_id: 'none', price: 3 }] };
  assert.deepStrictEqual(ids(enforceServingCurrency({ operation: 'find_similar_products', payload: { market: 'US' }, body })), ['usd', 'none']);
  assert.deepStrictEqual(ids(enforceServingCurrency({ operation: 'find_similar_products', payload: { market: 'JP' }, body })), ['jpy', 'none']);
});
