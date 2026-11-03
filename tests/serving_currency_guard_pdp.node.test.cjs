'use strict';

// offMarketCurrencies (src/services/servingCurrencyGuard.js): the PDP's reading of the serving-currency rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const { offMarketCurrencies, withholdOffMarketMoney } = require('../src/services/servingCurrencyGuard');

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

test('nothing priced, nothing judged; a market nothing is priced for makes every price off-market', () => {
  assert.deepEqual(offMarketCurrencies({ title: 'x', variants: [{ sku: 'a' }] }, 'USD'), []);
  assert.deepEqual(offMarketCurrencies({ price: 5, currency: 'USD' }, null), ['USD']);
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
  assert.match(source, /requestBody = unscopedDetailPdpRequest\(pid, payload\);/);
  assert.doesNotMatch(source, /operation: 'get_pdp_v2',\s*\n\s*payload: \{ product_ref: \{ product_id: pid \}, include: \['product_overview'\] \},/);
});
