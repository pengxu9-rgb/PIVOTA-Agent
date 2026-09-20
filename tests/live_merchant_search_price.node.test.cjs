const test = require('node:test');
const assert = require('node:assert/strict');
const { targetOf, verifiedPrice, overlayLiveMerchantSearchPrices } = require('../src/services/liveMerchantSearchPrice');

const body = { product: { variants: [
  { id: 50856826536257, price: '30.00', price_currency: 'SGD' },
  { id: 50865870831937, price: '30.00', price_currency: 'SGD' },
] } };
const card = {
  product_id: 'sig_jsm', price: 28.2, currency: 'SGD',
  destination_url: 'https://jsmbeauty.sg/products/lip-pression-metal-serum-gloss',
};

test('uses the merchant PDP and an exact variant, or unanimity across variants', () => {
  assert.equal(targetOf({ ...card, source_variant_id: '50856826536257' }).variant, '50856826536257');
  assert.deepEqual(verifiedPrice(body, '50856826536257'), { amount: 30, currency: 'SGD' });
  assert.deepEqual(verifiedPrice(body, ''), { amount: 30, currency: 'SGD' });
  assert.equal(verifiedPrice(body, '5085682653625'), null);
  assert.equal(verifiedPrice({ product: { variants: [...body.product.variants, { id: 3, price: '31.00', price_currency: 'SGD' }] } }, ''), null);
  assert.equal(targetOf({ destination_url: 'http://localhost/products/lip-pression-metal-serum-gloss' }), null);
  assert.equal(targetOf({ canonical_url: 'https://agent.pivota.cc/products/foo' }), null);
});

test('overlays exact merchant price, retains stored offer on disagreement or failed read, and caches the page', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => body }; };
  const original = { products: [card], metadata: { query_source: 'beauty_external_seed_mainline' } };
  const live = await overlayLiveMerchantSearchPrices(original, { fetchImpl });
  assert.equal(live.products[0].price, 30);
  assert.equal(live.products[0].price_amount, 30);
  assert.equal(live.products[0].price_source, 'merchant_live');
  assert.equal(live.metadata.live_merchant_price.drift_count, 1);
  assert.equal(original.products[0].price, 28.2);
  await overlayLiveMerchantSearchPrices(original, { fetchImpl });
  assert.equal(calls, 1);
  const wrongCurrency = await overlayLiveMerchantSearchPrices({ products: [{ ...card, currency: 'USD' }] }, { fetchImpl });
  assert.equal(wrongCurrency.products[0].price, 28.2);
  assert.equal(wrongCurrency.products[0].price_source, 'catalog_offer');
  const unavailable = await overlayLiveMerchantSearchPrices({ products: [{ ...card, destination_url: 'https://another-shop.sg/products/foo' }] }, {
    fetchImpl: async () => { throw new Error('unavailable'); },
  });
  assert.equal(unavailable.products[0].price, 28.2);
  assert.equal(unavailable.products[0].price_source, 'catalog_offer');
});

test('limits one storefront to four concurrent reads on a served page', async () => {
  let active = 0;
  let peak = 0;
  const cards = Array.from({ length: 9 }, (_, i) => ({
    ...card, destination_url: `https://concurrency-shop.sg/products/unique-${i}`,
  }));
  await overlayLiveMerchantSearchPrices({ products: cards }, {
    fetchImpl: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return { ok: true, json: async () => body };
    },
  });
  assert.equal(peak, 4);
});
