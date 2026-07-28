'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAcpFeedItem, isQuotableFeedItem } = require('../src/acpFeedItem');

const pdp = (id) => `https://agent.pivota.cc/products/${id}`;
const ATTRIBUTED = 'https://api.pivota.cc/r?token=eyJ2IjowfQ==.c2lnbmF0dXJl';

test('D1: link = canonical PDP; attributed /r link rides as external_redirect_url', () => {
  const item = buildAcpFeedItem(
    {
      product_id: 'ext_abc123',
      title: 'Barrier Cream',
      description: 'desc',
      external_redirect_url: ATTRIBUTED,
      image_url: 'https://cdn.example/i.jpg',
      price: 21,
      currency: 'USD',
      in_stock: true,
      merchant_id: null,
      brand: 'ANUKO',
    },
    { buildPublicProductUrl: pdp },
  );
  assert.equal(item.link, pdp('ext_abc123'), 'feed link must be the Pivota PDP, not the merchant URL');
  assert.equal(item.external_redirect_url, ATTRIBUTED, 'attributed /r link must ride along verbatim');
  assert.equal(item.id, 'ext_abc123');
  assert.equal(item.image_link, 'https://cdn.example/i.jpg', 'backend image_url shape is mapped');
  assert.equal(item.availability, 'in_stock');
  assert.equal(item.brand, 'ANUKO');
});

test('fallback chain: no product id → attributed link; neither → o.link ?? o.url', () => {
  const noId = buildAcpFeedItem(
    { title: 'X', external_redirect_url: ATTRIBUTED, url: 'https://brand.example/p' },
    { buildPublicProductUrl: pdp },
  );
  assert.equal(noId.link, ATTRIBUTED);

  const bare = buildAcpFeedItem({ title: 'X', url: 'https://brand.example/p' }, { buildPublicProductUrl: pdp });
  assert.equal(bare.link, 'https://brand.example/p');
  assert.equal(bare.external_redirect_url, undefined);
});

test('offer-shaped input: affiliate_url counts as the attributed link', () => {
  const item = buildAcpFeedItem(
    { id: 'p9', title: 'Y', affiliate_url: ATTRIBUTED },
    { buildPublicProductUrl: pdp },
  );
  assert.equal(item.external_redirect_url, ATTRIBUTED);
  assert.equal(item.link, pdp('p9'));
});

test('defaultFeedItem parity: availability derivation and image fallbacks preserved', () => {
  const out = buildAcpFeedItem({ id: 'a', title: 't', in_stock: false, images: ['https://i/1.jpg'] }, {});
  assert.equal(out.availability, 'out_of_stock');
  assert.equal(out.image_link, 'https://i/1.jpg');
  assert.equal(out.link, undefined, 'no URL fabricated without id/builder or source urls');
});

test('the mapper reads price_amount/price_currency, so the gate stops dropping priced rows', () => {
  // F1 from the #1846 Opus review. `isQuotableFeedItem` runs on the MAPPED item,
  // so any money shape the mapper cannot see becomes `price: undefined` and the
  // row is DROPPED — a priced product withheld because the mapper did not look.
  //
  // `toAcpFeedProduct` (services/acpFeedSource:116-117) has always read
  // `price ?? price_amount`. The two lanes disagreed; this closes it.
  const mapped = buildAcpFeedItem(
    { id: 'sig_abc', title: 'T', price_amount: 19.5, price_currency: 'USD' },
    { buildPublicProductUrl: (id) => `https://agent.pivota.cc/products/${id}` },
  );
  assert.equal(mapped.price, 19.5);
  assert.equal(mapped.currency, 'USD');
  assert.equal(isQuotableFeedItem(mapped), true, 'a row priced via price_amount must survive the gate');
});

test('top-level price still WINS over price_amount when both are present', () => {
  // Pins the `??` direction. Reversed, a stale `price_amount` would silently
  // override the authoritative `price` — a wrong number on a public feed, which
  // is worse than the dropped row this fix exists to prevent.
  const mapped = buildAcpFeedItem(
    { id: 'sig_abc', price: 10, currency: 'USD', price_amount: 999, price_currency: 'INR' },
    {},
  );
  assert.equal(mapped.price, 10);
  assert.equal(mapped.currency, 'USD');
});

test('an amount with no currency in EITHER shape is still refused', () => {
  // The widening must not weaken the INR-served-as-USD guard: currency is never
  // defaulted, whichever key the amount arrived under.
  assert.equal(isQuotableFeedItem(buildAcpFeedItem({ id: 'x', price_amount: 19.5 }, {})), false);
  assert.equal(isQuotableFeedItem(buildAcpFeedItem({ id: 'x', price_amount: 19.5, price_currency: '  ' }, {})), false);
});
