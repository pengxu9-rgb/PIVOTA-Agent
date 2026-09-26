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
  const cached = await overlayLiveMerchantSearchPrices(original, { fetchImpl });
  assert.equal(calls, 1);
  assert.equal(cached.metadata.live_merchant_price.attempted, true);
  assert.equal(cached.metadata.live_merchant_price.fetch_attempt_count, 0);
  assert.equal(cached.metadata.live_merchant_price.cache_hit_count, 1);
  const wrongCurrency = await overlayLiveMerchantSearchPrices({ products: [{ ...card, currency: 'USD' }] }, { fetchImpl });
  assert.equal(wrongCurrency.products[0].price, 28.2);
  assert.equal(wrongCurrency.products[0].price_source, 'catalog_offer');
  assert.equal(wrongCurrency.metadata.live_merchant_price.failure_reasons.currency_mismatch, 1);
  const unavailable = await overlayLiveMerchantSearchPrices({ products: [{ ...card, destination_url: 'https://another-shop.sg/products/foo' }] }, {
    fetchImpl: async () => { throw new Error('unavailable'); },
  });
  assert.equal(unavailable.products[0].price, 28.2);
  assert.equal(unavailable.products[0].price_source, 'catalog_offer');
  assert.equal(unavailable.metadata.live_merchant_price.failure_reasons.network_error, 1);
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

test('sends merchant-compatible headers and reports an HTTP refusal without claiming a live price', async () => {
  const product = { ...card, destination_url: 'https://header-shop.sg/products/unique' };
  let request;
  const live = await overlayLiveMerchantSearchPrices({ products: [product] }, {
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => body };
    },
  });
  assert.equal(request.url, 'https://header-shop.sg/products/unique.json');
  assert.match(request.init.headers['User-Agent'], /PivotaCatalog\/1\.0/);
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.equal(request.init.redirect, 'error');
  assert.equal(live.products[0].price, 30);
  assert.equal(live.metadata.live_merchant_price.fetch_attempt_count, 1);

  const denied = await overlayLiveMerchantSearchPrices({ products: [{ ...product, destination_url: 'https://denied-shop.sg/products/unique' }] }, {
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  assert.equal(denied.products[0].price, 28.2);
  assert.equal(denied.products[0].price_source, 'catalog_offer');
  assert.equal(denied.metadata.live_merchant_price.verified_count, 0);
  assert.equal(denied.metadata.live_merchant_price.failure_reasons.http_403, 1);
});

test('deduplicates simultaneous product JSON reads for distinct variants', async () => {
  let calls = 0;
  const variants = [
    { ...card, source_variant_id: '50856826536257', destination_url: 'https://dedupe-shop.sg/products/unique' },
    { ...card, source_variant_id: '50865870831937', destination_url: 'https://dedupe-shop.sg/products/unique' },
  ];
  const result = await overlayLiveMerchantSearchPrices({ products: variants }, {
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, json: async () => body };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.products.map((p) => p.price), [30, 30]);
  assert.equal(result.metadata.live_merchant_price.fetch_attempt_count, 1);
  assert.equal(result.metadata.live_merchant_price.verified_count, 2);
});

test('twenty slow same-host reads respect one page deadline', async () => {
  const products = Array.from({ length: 20 }, (_, i) => ({
    ...card, destination_url: `https://slow-shop.sg/products/unique-${i}`,
  }));
  let calls = 0;
  const started = Date.now();
  const result = await overlayLiveMerchantSearchPrices({ products }, {
    timeoutMs: 1000,
    pageDeadlineMs: 35,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      calls += 1;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  });
  assert.ok(Date.now() - started < 500);
  assert.equal(calls, 4);
  assert.equal(result.metadata.live_merchant_price.deadline_exceeded, true);
  assert.equal(result.metadata.live_merchant_price.failure_reasons.deadline_exceeded, 20);
  assert.ok(result.products.every((p) => p.price === 28.2 && p.price_source === 'catalog_offer'));
});

test('a variant id that only restates the product (the ::canonical sku) or a placeholder is not a variant', () => {
  const retailer = {
    product_key: 'ext:retailer:05c4febd54ff507122aae7a55440d7c6', price: 46, currency: 'USD',
    destination_url: 'https://bluemercury.com/products/moroccanoil-intense-hydrating-mask',
  };
  // bluemercury.com 2026-09-25: the card carried the product key as its variant -> variant_missing.
  assert.equal(targetOf({ ...retailer, source_variant_id: retailer.product_key }).variant, '');
  assert.equal(targetOf({ ...retailer, source_variant_id: 'default' }).variant, '');
  assert.equal(targetOf({ ...retailer, source_variant_id: '9001-default' }).variant, '');
  // the URL's own ?variant= still applies once the restated id is set aside
  assert.equal(targetOf({ ...retailer, source_variant_id: retailer.product_key,
    destination_url: `${retailer.destination_url}?variant=31691919065163` }).variant, '31691919065163');
  // a real variant id is untouched
  assert.equal(targetOf({ ...retailer, source_variant_id: '31691919065163' }).variant, '31691919065163');
  // single-variant store product: verified with no variant named
  const one = { product: { variants: [{ id: 31691919065163, price: '46.00', price_currency: 'USD' }] } };
  assert.deepEqual(verifiedPrice(one, targetOf({ ...retailer, source_variant_id: retailer.product_key }).variant),
    { amount: 46, currency: 'USD' });
});
