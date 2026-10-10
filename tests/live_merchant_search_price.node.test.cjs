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

test('a long-key canonical sku restates the source_product_id, not the product key (pivota-backend #2391)', async () => {
  // Live kissusa.com row, derived by the backend's own derive_product_key / bounded_source_product_id: its
  // 139-char product_key cannot fit catalog_skus.source_variant_id (VARCHAR(128)), so the canonical sku
  // restates the 125-char source_product_id instead. The card's product_id is the signature id, not it.
  const sourceProductId =
    'kiss-kiss-haunt-halloween-press-on-fake-glue-nails-midnight-makeover-french-design-black-white-medium-almond-glow-in-the-dark';
  const kiss = {
    product_key: `ext:${sourceProductId}::44f3c737`, product_id: 'sig_kiss_haunt', source_product_id: sourceProductId,
    price: 9.99, currency: 'USD', destination_url: 'https://www.kissusa.com/products/kiss-haunt-halloween-midnight-makeover',
  };
  assert.equal(kiss.product_key.length, 139);
  assert.equal(targetOf({ ...kiss, source_variant_id: sourceProductId }).variant, '');
  // the cases that already held are unchanged on the same card
  assert.equal(targetOf({ ...kiss, source_variant_id: kiss.product_key }).variant, '');
  assert.equal(targetOf({ ...kiss, source_variant_id: 'default' }).variant, '');
  assert.equal(targetOf({ ...kiss, source_variant_id: `${sourceProductId}-default` }).variant, '');
  assert.equal(targetOf({ ...kiss, source_variant_id: sourceProductId,
    destination_url: `${kiss.destination_url}?variant=45199259336800` }).variant, '45199259336800');

  // end to end: before, the slug went to Shopify as a variant id and came back variant_missing
  const store = { product: { variants: [
    { id: 45199259336800, price: '9.99', price_currency: 'USD' },
    { id: 45199259336801, price: '9.99', price_currency: 'USD' },
  ] } };
  const live = await overlayLiveMerchantSearchPrices(
    { products: [{ ...kiss, source_variant_id: sourceProductId }] },
    { fetchImpl: async () => ({ ok: true, json: async () => store }) },
  );
  assert.equal(live.products[0].price_source, 'merchant_live');
  assert.equal(live.metadata.live_merchant_price.verified_count, 1);
  assert.deepEqual(live.metadata.live_merchant_price.failure_reasons, {});
});

test('a real Shopify variant id is still used, even on a card whose source_product_id is numeric', () => {
  const pdp = 'https://www.kissusa.com/products/kiss-haunt-halloween-midnight-makeover';
  // brand-store card: a numeric variant id is not a restatement of the slug
  const brand = { product_key: 'ext:kiss-kiss-haunt::44f3c737', source_product_id: 'kiss-kiss-haunt', destination_url: pdp };
  assert.equal(targetOf({ ...brand, source_variant_id: '45199259336801' }).variant, '45199259336801');
  // Shopify-native card: the variant id begins with the product id's digits but continues
  // alphanumerically, so it carries identity of its own and must reach the store as a variant
  const native = { product_key: 'merch_x:8123456789', source_product_id: '8123456789', destination_url: pdp };
  assert.equal(targetOf({ ...native, source_variant_id: '81234567890123' }).variant, '81234567890123');
  // and with prices that differ by variant, that id picks the one exact offer
  const shades = { product: { variants: [
    { id: 45199259336800, price: '9.99', price_currency: 'USD' },
    { id: 45199259336801, price: '12.99', price_currency: 'USD' },
  ] } };
  assert.deepEqual(verifiedPrice(shades, targetOf({ ...brand, source_variant_id: '45199259336801' }).variant),
    { amount: 12.99, currency: 'USD' });
  assert.equal(verifiedPrice(shades, targetOf({ ...brand, source_variant_id: 'kiss-kiss-haunt' }).variant), null);
});

test('restating the source_product_id follows isRestatedProductId, in its argument order', () => {
  const pdp = 'https://www.kissusa.com/products/kiss-professional-tippy-toes';
  // A slug over 128 chars is bounded (first 119 + '-' + 8 hex, #2391's bounded_source_product_id); the
  // canonical sku restates that bounded value, and so does the card.
  const bounded =
    'kiss-kiss-professional-full-cover-press-on-fake-toenails-tippy-toes-130-toenails-includes-nail-glue-solid-white-short-s-1d9aaaa1';
  const long = { product_key: 'ext:kiss-kiss-professional-full-cover-press-on-fake-toenails-tippy-toes-130-toenails-includes-nail-glue-solid-white-short-squoval-pedicure::1d9aaaa1',
    source_product_id: bounded, destination_url: pdp };
  assert.equal(bounded.length, 128);
  assert.equal(long.product_key.length, 148);
  assert.equal(targetOf({ ...long, source_variant_id: bounded }).variant, '');
  // the product id plus a separator restates it too, as the safety kernel judges it
  const slug = { product_key: 'ext:kiss-haunt-nails::0badc0de', source_product_id: 'kiss-haunt-nails', destination_url: pdp };
  assert.equal(targetOf({ ...slug, source_variant_id: 'kiss-haunt-nails:1' }).variant, '');
  // but a variant id is never judged a restatement because the PRODUCT id extends IT
  assert.equal(targetOf({ ...slug, source_variant_id: 'kiss' }).variant, 'kiss');
});

test('a live price carries its own as-of; a failed read keeps the catalog as-of', async () => {
  const catalogCard = {
    ...card, destination_url: 'https://freshness-shop.sg/products/serum-gloss',
    price_as_of: '2026-09-01T05:15:00.000Z',
  };
  const live = await overlayLiveMerchantSearchPrices({ products: [catalogCard] }, {
    fetchImpl: async () => ({ ok: true, json: async () => body }),
  });
  assert.equal(live.products[0].price, 30);
  assert.equal(live.products[0].price_source, 'merchant_live');
  assert.ok(Date.parse(live.products[0].price_as_of) > Date.parse(catalogCard.price_as_of));

  const failed = await overlayLiveMerchantSearchPrices({
    products: [{ ...catalogCard, destination_url: 'https://freshness-down.sg/products/serum-gloss' }],
  }, { fetchImpl: async () => { throw new Error('unavailable'); } });
  assert.equal(failed.products[0].price, 28.2);
  assert.equal(failed.products[0].price_source, 'catalog_offer');
  assert.equal(failed.products[0].price_as_of, catalogCard.price_as_of);
});

// ---- a product page Shopify says is gone (judydoll "Sheer Tinted Highlighter", 2026-10-09) ------------------------
const { DROP_GONE_FLAG } = require('../src/services/liveMerchantSearchPrice');
const storefrontProductPage = require('../src/services/storefrontProductPage');

const shopifyGone = () => new Response('{"errors":"Not Found"}', { status: 404, headers: { 'powered-by': 'Shopify' } });
const removed = {
  product_id: 'sig_d4f93c2b9b88ac7bd32f44d13ebe9d31', price: 12.99, currency: 'USD', availability: 'in_stock',
  destination_url: 'https://judydoll.com/products/sheer-tinted-highlighter?variant=49869804110101',
};
const kept = { ...card, product_id: 'sig_kept', destination_url: 'https://kept-shop.sg/products/live-one' };
const routeFetch = (calls) => async (url) => {
  calls.push(url);
  return url.includes('sheer-tinted-highlighter') ? shopifyGone() : { ok: true, json: async () => body };
};

test('flag OFF: a Shopify 404 is counted as gone but the card is served exactly as before', async () => {
  storefrontProductPage.resetForTests();
  const calls = [];
  const out = await overlayLiveMerchantSearchPrices({ products: [removed, kept] }, { fetchImpl: routeFetch(calls), env: {} });
  assert.deepEqual(out.products.map((p) => p.product_id), ['sig_d4f93c2b9b88ac7bd32f44d13ebe9d31', 'sig_kept']);
  assert.equal(out.products[0].price, 12.99);
  assert.equal(out.products[0].price_source, 'catalog_offer');
  const meta = out.metadata.live_merchant_price;
  assert.equal(meta.failure_reasons.http_404, 1);
  assert.equal(meta.gone_count, 1);
  assert.equal(meta.dropped_gone_count, 0);
  // and the verdict is shared with the checkout's own check
  assert.deepEqual(storefrontProductPage.knownGone('https://judydoll.com/products/sheer-tinted-highlighter.json'), { status: 404 });
});

test('flag ON: the gone card leaves the page; the live one is served and verified', async () => {
  storefrontProductPage.resetForTests();
  const calls = [];
  const out = await overlayLiveMerchantSearchPrices({ products: [removed, kept] }, {
    fetchImpl: routeFetch(calls), env: { [DROP_GONE_FLAG]: '1' },
  });
  assert.deepEqual(out.products.map((p) => p.product_id), ['sig_kept']);
  assert.equal(out.products[0].price_source, 'merchant_live');
  assert.equal(out.metadata.live_merchant_price.gone_count, 1);
  assert.equal(out.metadata.live_merchant_price.dropped_gone_count, 1);
});

test('flag ON: a 404 WITHOUT Shopify\'s stamp, a 403, or a timeout never drops a card', async () => {
  storefrontProductPage.resetForTests();
  const env = { [DROP_GONE_FLAG]: 'true' };
  const cases = [
    async () => new Response('', { status: 404, headers: { server: 'AkamaiNetStorage' } }),
    async () => new Response('', { status: 404, headers: { 'powered-by': 'Shopify', 'cf-mitigated': 'challenge' } }),
    async () => new Response('', { status: 403, headers: { 'powered-by': 'Shopify' } }),
    async () => { throw new Error('ECONNRESET'); },
  ];
  for (const [i, fetchImpl] of cases.entries()) {
    const product = { ...removed, destination_url: `https://not-gone-${i}.example/products/a` };
    const out = await overlayLiveMerchantSearchPrices({ products: [product] }, { fetchImpl, env });
    assert.equal(out.products.length, 1, `case ${i} dropped a card`);
    assert.equal(out.metadata.live_merchant_price.gone_count, 0);
  }
});

test('a page remembered as gone is not fetched again, and two cards on it are both dropped', async () => {
  storefrontProductPage.resetForTests();
  storefrontProductPage.noteGone('https://judydoll.com/products/sheer-tinted-highlighter.json', 404);
  const calls = [];
  const twin = { ...removed, product_id: 'sig_twin', source_variant_id: '49869804077333' };
  // its own URL: the overlay's success cache would otherwise serve the kept card from the test above
  const freshKept = { ...kept, destination_url: 'https://kept-shop.sg/products/live-two' };
  const out = await overlayLiveMerchantSearchPrices({ products: [removed, freshKept, twin] }, {
    fetchImpl: routeFetch(calls), env: { [DROP_GONE_FLAG]: 'on' },
  });
  assert.deepEqual(out.products.map((p) => p.product_id), ['sig_kept']);
  assert.ok(!calls.some((u) => u.includes('sheer-tinted-highlighter')), 'the remembered page was fetched again');
  assert.equal(out.metadata.live_merchant_price.fetch_attempt_count, 1);
  assert.equal(out.metadata.live_merchant_price.dropped_gone_count, 2);
});
