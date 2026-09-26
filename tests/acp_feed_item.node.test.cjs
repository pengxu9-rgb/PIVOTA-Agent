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

test('amount and currency come from the SAME source — no cross-mixing', () => {
  // N2 from the re-review. Two independent `??` would pair an amount from one
  // shape with a currency from the other, which IS the INR-served-as-USD class.
  // The same invariant is named one layer up in
  // tests/product_entity_index_feed_election.node.test.cjs:229.
  //
  // Both of these were `quotable: true` before this fix — a public feed row
  // whose amount and currency described different things.
  const mixedA = buildAcpFeedItem({ id: 'x', price: 12, price_currency: 'INR' }, {});
  assert.equal(mixedA.currency, undefined, 'a scalar price must not borrow price_currency');
  assert.equal(isQuotableFeedItem(mixedA), false);

  const mixedB = buildAcpFeedItem({ id: 'x', price_amount: 99000, currency: 'USD' }, {});
  assert.equal(mixedB.currency, undefined, 'a price_amount must not borrow the scalar currency');
  assert.equal(isQuotableFeedItem(mixedB), false);
});

test('an explicit price of 0 is refused, not treated as missing', () => {
  // `!= null` rather than truthiness: 0 is a real value the gate must see and
  // reject. Falling through to price_amount here would let a zero-priced row be
  // rescued by a stale alternate amount.
  const zero = buildAcpFeedItem({ id: 'x', price: 0, currency: 'USD', price_amount: 42 }, {});
  assert.equal(zero.price, 0);
  assert.equal(isQuotableFeedItem(zero), false);
});

test('#1852: the mapper EMITS a title — it is now publish-blocking', () => {
  // Review finding: `title` is validated by the gate on the projected item, but
  // the adapter re-maps through buildAcpFeedItem before serialising, and that
  // line was unpinned — setting it to `undefined` left all 9 suites green.
  // Since #1852 a missing title DROPS the row, so on the connected lane this
  // single unpinned line is the difference between a feed and an empty feed.
  const item = buildAcpFeedItem({ id: 'sig_a', title: 'Rice 72 Serum', price: 10, currency: 'USD' }, {});
  assert.equal(item.title, 'Rice 72 Serum');
  const viaName = buildAcpFeedItem({ id: 'sig_a', name: 'Fallback Name', price: 10, currency: 'USD' }, {});
  assert.equal(viaName.title, 'Fallback Name', 'the name fallback must survive too');
});

test('#1851: a merchant id is never published as a brand', () => {
  // PUBLIC feed: `merch_obs_deadbeef` / `external_seed` would be indexed by an
  // ingester as the manufacturer's name. An ABSENT brand is honest — and is
  // already what the index lane's own projection emits. Measured before the
  // change: 0 of 4,375 live rows had an empty brand, so this is hardening.
  const withBrand = buildAcpFeedItem({ id: 'sig_a', brand: 'Anua', merchant_id: 'external_seed' }, {});
  assert.equal(withBrand.brand, 'Anua', 'a real brand still wins');

  for (const mid of ['external_seed', 'merch_obs_deadbeef', 'merch_69d6b67f78c10154']) {
    const bare = buildAcpFeedItem({ id: 'sig_a', merchant_id: mid }, {});
    assert.equal(bare.brand, undefined, `a brandless row must not borrow ${mid}`);
  }
});

test('the TWO-STAGE projection is a pipeline, not a redundant second pass', () => {
  // Recorded because I got this wrong and nearly shipped the "fix": the index
  // lane's `toAcpFeedProduct` emits NO `link` and NO `image_link` — the adapter's
  // second pass through buildAcpFeedItem is what builds them from `id` and
  // `image_url`. Skipping it (the #1850 proposal) would publish a feed with no
  // links at all: far worse than the brand override it was meant to fix.
  const { toAcpFeedProduct } = require('../src/services/acpFeedSource');
  const stage1 = toAcpFeedProduct({ product_entity_id: 'sig_a', title: 'T', image_url: 'https://cdn/x.jpg', price: 10, currency: 'USD', brand: 'Anua' });
  assert.ok(!('link' in stage1), 'stage 1 does NOT build the PDP link — stage 2 does');
  assert.ok(!('image_link' in stage1), 'stage 1 emits image_url; stage 2 renames it');

  const stage2 = buildAcpFeedItem(stage1, { buildPublicProductUrl: (id) => `https://agent.pivota.cc/products/${id}` });
  assert.equal(stage2.link, 'https://agent.pivota.cc/products/sig_a');
  assert.equal(stage2.image_link, 'https://cdn/x.jpg');
  assert.equal(stage2.brand, 'Anua');
});

test('#1851: an EMPTY or NULL brand is not rescued by the merchant id either', () => {
  // Mutant M4 restored the leak for `brand === null` only and survived — the
  // original test used an absent key exclusively. `''` on the wire is arguably
  // worse for an ingester than an absent field, since it reads as "this product
  // asserts it has no brand" rather than "unknown".
  for (const brand of [null, '', undefined]) {
    const item = buildAcpFeedItem({ id: 'sig_a', brand, merchant_id: 'merch_obs_deadbeef' }, {});
    assert.notEqual(item.brand, 'merch_obs_deadbeef', `brand=${JSON.stringify(brand)} must not borrow the merchant id`);
  }
});
