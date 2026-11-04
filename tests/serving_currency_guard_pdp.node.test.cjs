'use strict';

// withholdOffMarketMoney (src/services/servingCurrencyGuard.js): get_pdp_v2's reading of the serving-currency rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const { withholdOffMarketMoney } = require('../src/services/servingCurrencyGuard');

const offMarketCurrencies = (product, servingCurrency) => withholdOffMarketMoney(product, servingCurrency).withheld;

test('a product priced only in the serving currency has no off-market currency', () => {
  assert.deepEqual(offMarketCurrencies({ price: 16, currency: 'SGD', variants: [{ price: 16, currency: 'SGD' }] }, 'SGD'), []);
  assert.deepEqual(offMarketCurrencies({ price: { amount: 10, currency: 'usd' } }, 'USD'), [], 'case-insensitive');
});

test('every stated currency other than the serving one is reported, product and variants alike', () => {
  assert.deepEqual(offMarketCurrencies({ price: 16, currency: 'SGD' }, 'USD'), ['SGD']);
  assert.deepEqual(offMarketCurrencies({ price: 10, currency: 'USD', variants: [{ price: 10, currency: 'USD' }, { price: 900, currency: 'JPY' }] }, 'USD'), ['JPY']);
  assert.deepEqual(offMarketCurrencies({ price: 10, currency: 'USD', variants: [{ pricing: { current: { amount: 9, currency: 'AUD' } }, price: 9 }] }, 'USD'), ['AUD']);
  assert.deepEqual(offMarketCurrencies({ price: 1, currency: 'SGD', price_currency: 'USD' }, 'USD'), ['SGD'], 'a mixed record is off-market');
});

test('nothing priced, nothing judged; with no serving currency nothing is judged either', () => {
  assert.deepEqual(offMarketCurrencies({ title: 'x', variants: [{ sku: 'a' }] }, 'USD'), []);
  assert.deepEqual(offMarketCurrencies({ price: 5, currency: 'USD' }, null), []);
  assert.deepEqual(offMarketCurrencies(null, 'USD'), []);
  assert.deepEqual(offMarketCurrencies({ price: 5 }, 'USD'), [], 'a price with no currency is left to the builder (toVariantPrice drops it)');
});

test('withholdOffMarketMoney: only the off-market money goes; the record, its stock and its other fields stay', () => {
  const product = {
    title: 'T', in_stock: true, currency: 'SGD', price: 16, pricing: { current: { amount: 16, currency: 'SGD' } },
    variants: [{ sku: 'a', price: 16, currency: 'SGD', in_stock: true }, { sku: 'b', price: 10, currency: 'USD', in_stock: true }],
  };
  const { product: next, withheld } = withholdOffMarketMoney(product, 'USD');
  assert.deepEqual(withheld, ['SGD']);
  assert.equal(next.price, undefined);
  assert.equal(next.pricing, undefined);
  assert.equal(next.title, 'T');
  assert.equal(next.in_stock, true, 'stock is not touched');
  assert.equal(next.variants[0].price, undefined);
  assert.equal(next.variants[0].sku, 'a');
  assert.equal(next.variants[1].price, 10, 'a variant in the serving currency keeps its money');
  assert.equal(product.price, 16, 'the input is not mutated');
});

test('withholdOffMarketMoney: the same object back when nothing is off-market, or there is no serving currency', () => {
  const ok = { price: 10, currency: 'USD', variants: [{ price: 10, currency: 'USD' }] };
  assert.equal(withholdOffMarketMoney(ok, 'USD').product, ok);
  assert.deepEqual(withholdOffMarketMoney(ok, 'USD').withheld, []);
  const sgd = { price: 16, currency: 'SGD' };
  assert.equal(withholdOffMarketMoney(sgd, null).product, sgd, 'an unkeyable market judges nothing');
  assert.equal(withholdOffMarketMoney(sgd, '').product, sgd);
  assert.equal(withholdOffMarketMoney(null, 'USD').product, null);
});

test('get_product_detail\'s unscoped hop forwards the agent\'s market to get_pdp_v2, and only a real one', () => {
  const { unscopedDetailPdpRequest } = require('../src/services/pdpDetailHop');
  assert.deepEqual(unscopedDetailPdpRequest('sig_x', { market: ' SG ' }), {
    operation: 'get_pdp_v2', payload: { product_ref: { product_id: 'sig_x' }, include: ['product_overview'], market: 'SG' },
  });
  for (const payload of [{}, { market: '' }, { market: '  ' }, { market: 7 }, null, undefined]) {
    assert.deepEqual(unscopedDetailPdpRequest('sig_x', payload).payload, { product_ref: { product_id: 'sig_x' }, include: ['product_overview'] });
  }
});

test('an unpriced record that only states a currency withholds nothing and reports nothing', () => {
  const product = { title: 'T', currency: 'SGD', variants: [{ sku: 'a', currency: 'SGD' }] };
  const { product: next, withheld } = withholdOffMarketMoney(product, 'USD');
  assert.equal(next, product, 'returned as is');
  assert.deepEqual(withheld, []);
  assert.deepEqual(offMarketCurrencies(product, 'USD'), []);
});

test('server.js builds the unscoped detail hop with that helper (the market forward is not an inline twin)', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.match(source, /requestBody = unscopedDetailPdpRequest\(pid, payload, options\?\.market\);/);
  assert.doesNotMatch(source, /operation: 'get_pdp_v2',\s*\n\s*payload: \{ product_ref: \{ product_id: pid \}, include: \['product_overview'\] \},/);
});

test('the hop takes the market the executor declared beside the payload, then the payload\'s own', () => {
  const { unscopedDetailPdpRequest } = require('../src/services/pdpDetailHop');
  assert.equal(unscopedDetailPdpRequest('sig_x', {}, ' SG ').payload.market, 'SG');
  assert.equal(unscopedDetailPdpRequest('sig_x', { market: 'US' }, 'SG').payload.market, 'SG');
  assert.equal(unscopedDetailPdpRequest('sig_x', { market: 'SG' }, '  ').payload.market, 'SG');
  assert.equal(unscopedDetailPdpRequest('sig_x', { market: 'SG' }, undefined).payload.market, 'SG');
});

test('a variant that states no currency is priced in the product\'s, and is withheld with it', () => {
  const product = {
    currency: 'CAD', price: { amount: 42, currency: 'CAD' },
    variants: [{ variant_id: 'v1', price: 42 }, { variant_id: 'v2', price: '55.00' }],
  };
  const { product: next, withheld } = withholdOffMarketMoney(product, 'USD');
  assert.deepEqual(withheld, ['CAD']);
  assert.equal(next.price, undefined);
  assert.deepEqual(next.variants.map((v) => v.price), [undefined, undefined]);
  // ...but a product in the serving currency leaves its currency-less variants priced.
  const usd = { currency: 'USD', price: 42, variants: [{ variant_id: 'v1', price: 42 }] };
  assert.equal(withholdOffMarketMoney(usd, 'USD').product, usd);
});

test('a headline withheld beside a variant kept in the serving currency relabels the product, never the money', () => {
  const product = {
    currency: 'CAD', price_currency: 'CAD', price: { amount: 42, currency: 'CAD' },
    variants: [{ variant_id: 'v1', price: 42, currency: 'CAD' }, { variant_id: 'v2', price: 30, currency: 'USD' }],
  };
  const { product: next, withheld } = withholdOffMarketMoney(product, 'USD');
  assert.deepEqual(withheld, ['CAD']);
  assert.equal(next.price, undefined);
  assert.equal(next.currency, 'USD', 'the builder labels the kept variant with the product currency');
  assert.equal(next.price_currency, 'USD');
  assert.equal(next.variants[0].price, undefined);
  assert.deepEqual([next.variants[1].price, next.variants[1].currency], [30, 'USD']);
  // nothing kept: the labels stay as they were (there is no money left to label)
  const lone = { currency: 'CAD', price: 42, variants: [{ variant_id: 'v1', price: 42 }] };
  assert.equal(withholdOffMarketMoney(lone, 'USD').product.currency, 'CAD');
  // an unpriced variant kept as is holds no money either: no relabel
  const unpricedVariant = { currency: 'CAD', price: 42, variants: [{ variant_id: 'v1', title: 'Small' }] };
  assert.equal(withholdOffMarketMoney(unpricedVariant, 'USD').product.currency, 'CAD');
});

test('a currency only the source snapshot or the offers state is not this page\'s money', () => {
  const product = {
    title: 'T', price: 20, currency: 'USD',
    seed_data: { snapshot: { price_amount: 27.9, price_currency: 'SGD' } },
    offers: [{ price: 27.9, currency: 'SGD' }],
  };
  const { product: next, withheld } = withholdOffMarketMoney(product, 'USD');
  assert.equal(next, product);
  assert.deepEqual(withheld, []);
  const unpriced = { title: 'T', seed_data: { snapshot: { price_amount: 27.9, price_currency: 'SGD' } } };
  assert.deepEqual(withholdOffMarketMoney(unpriced, 'USD').withheld, []);
});

test('every money field of a withheld record goes: compare-at, original and list prices too', () => {
  const product = {
    currency: 'SGD', price: 16, price_min: 12, price_max: 20, compare_at_price: 20, compareAtPrice: 20,
    original_price: 22, originalPrice: 22, list_price: 22, current_price: 16, price_amount: 16,
    pricing: { current: { amount: 16, currency: 'SGD' } }, title: 'T',
  };
  const { product: next } = withholdOffMarketMoney(product, 'USD');
  for (const field of ['price', 'price_min', 'price_max', 'compare_at_price', 'compareAtPrice', 'original_price',
    'originalPrice', 'list_price', 'current_price', 'price_amount', 'pricing']) {
    assert.equal(next[field], undefined, field);
  }
  assert.equal(next.title, 'T');
});

test('the withheld currencies are reported sorted and de-duplicated', () => {
  const product = {
    currency: 'SGD', price: 1,
    variants: [{ price: 1, currency: 'JPY' }, { price: 1, currency: 'AUD' }, { price: 1, currency: 'JPY' }],
  };
  assert.deepEqual(withholdOffMarketMoney(product, 'USD').withheld, ['AUD', 'JPY', 'SGD']);
});

test('an offer quoting only a sale price is judged, and its sale price goes', () => {
  const { product: next, withheld } = withholdOffMarketMoney({ offer_id: 'o', sale_price: 16, salePrice: 16, currency: 'SGD' }, 'USD');
  assert.deepEqual(withheld, ['SGD']);
  assert.equal(next.sale_price, undefined);
  assert.equal(next.salePrice, undefined);
  assert.equal(next.offer_id, 'o');
  assert.deepEqual(withholdOffMarketMoney({ offer_id: 'o', sale_price: 16, currency: 'USD' }, 'USD').withheld, []);
});

test('a withheld offer loses its shipping cost; the rest of its shipping stays', () => {
  const offer = { offer_id: 'o', price: { amount: 16, currency: 'SGD' }, shipping_cost: 5,
    shipping: { method_label: 'Standard', eta_days_range: [3, 5], cost: { amount: 5, currency: 'SGD' } } };
  const { product: next, withheld } = withholdOffMarketMoney(offer, 'USD');
  assert.deepEqual(withheld, ['SGD']);
  assert.deepEqual(next.shipping, { method_label: 'Standard', eta_days_range: [3, 5], cost_withheld: true });
  assert.equal(next.shipping_cost, undefined);
});

test('a price in the serving currency with a shipping cost in another: only the cost goes, and it is reported', () => {
  const offer = { offer_id: 'o', price: { amount: 10, currency: 'USD' }, shipping: { method_label: 'Air', cost: { amount: 5, currency: 'SGD' } } };
  const { product: next, withheld } = withholdOffMarketMoney(offer, 'USD');
  assert.deepEqual(withheld, ['SGD']);
  assert.deepEqual(next.price, { amount: 10, currency: 'USD' });
  assert.deepEqual(next.shipping, { method_label: 'Air', cost_withheld: true });
  const usdShipping = { ...offer, shipping: { cost: { amount: 5, currency: 'usd' } } };
  assert.equal(withholdOffMarketMoney(usdShipping, 'USD').product, usdShipping, 'a cost in the serving currency is untouched');
  const unlabelled = { ...offer, shipping: { cost: { amount: 5 } } };
  assert.equal(withholdOffMarketMoney(unlabelled, 'USD').product, unlabelled, 'a cost stating no currency is not judged');
});

test('pdp metrics: a page left unjudged for want of a serving currency is counted', () => {
  const metrics = require('../src/observability/pdpMetrics');
  metrics.__resetPdpMetricsForTest();
  metrics.recordPdpCurrencyGuardUnjudged({ reason: 'no_serving_currency' });
  metrics.recordPdpCurrencyGuardUnjudged();
  assert.match(metrics.renderPdpMetricsPrometheus(), /^pdp_currency_guard_unjudged_total\{reason="no_serving_currency"\} 2$/m);
  metrics.__resetPdpMetricsForTest();
  assert.doesNotMatch(metrics.renderPdpMetricsPrometheus(), /pdp_currency_guard_unjudged_total\{/);
});

test('a variant quoting only a sale price, in the product\'s currency, is judged by it', () => {
  const product = { currency: 'SGD', price: 18, variants: [{ variant_id: 'v1', sale_price: 16 }] };
  const { product: next, withheld } = withholdOffMarketMoney(product, 'USD');
  assert.deepEqual(withheld, ['SGD']);
  assert.deepEqual(next.variants, [{ variant_id: 'v1' }]);
  // The headline is in the serving currency: the variant's sale price is the product's, and stays.
  const usd = { currency: 'USD', price: 18, variants: [{ variant_id: 'v1', sale_price: 16 }] };
  assert.equal(withholdOffMarketMoney(usd, 'USD').product, usd);
});

test('an off-market headline with a shipping cost in a third currency reports the headline currency only', () => {
  // The shipping cost goes with the rest of the record's money; it is reported only when it is the one off-market
  // amount beside an on-market price (P14 in the PR controller's #2541 mutant set).
  const offer = { offer_id: 'o', price: { amount: 16, currency: 'SGD' }, shipping: { cost: { amount: 500, currency: 'JPY' } } };
  const { product: next, withheld } = withholdOffMarketMoney(offer, 'USD');
  assert.deepEqual(withheld, ['SGD']);
  assert.equal(next.price, undefined);
  assert.deepEqual(next.shipping, { cost_withheld: true });
});

test('a withheld shipping cost is an unknown total, never free shipping (offersPriority)', () => {
  const { computeOfferTotal } = require('../src/offers/offersPriority');
  const known = { offer_id: 'k', price: { amount: 11, currency: 'USD' }, shipping: { cost: { amount: 2, currency: 'USD' } } };
  const withheldCost = withholdOffMarketMoney(
    { offer_id: 'w', price: { amount: 10, currency: 'USD' }, shipping: { cost: { amount: 5, currency: 'SGD' } } }, 'USD',
  ).product;
  assert.equal(computeOfferTotal(known), 13);
  assert.equal(computeOfferTotal(withheldCost), Number.POSITIVE_INFINITY);
  assert.equal(computeOfferTotal({ offer_id: 'n', price: { amount: 10, currency: 'USD' }, shipping: {} }), 10,
    'an offer that never stated a cost is unchanged');
  const { prioritizeOffers } = require('../src/offers/offersPriority');
  assert.deepEqual(prioritizeOffers([withheldCost, known]).map((o) => o.offer_id), ['k', 'w']);
});
