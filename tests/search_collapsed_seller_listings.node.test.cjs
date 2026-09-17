/**
 * A collapsed SELLER must stay reachable from the card that replaced it.
 *
 * WHY THIS FILE EXISTS. `dedupeBeautyProductsByDisplayKey` drops by brand + canonical title, so
 * the second retailer's listing of one product is indistinguishable from a duplicate row and was
 * dropped with no trace. Measured in prod 2026-09-17 on the Pyunkang Yul two-retailer canary:
 * `search_catalog` returned ONE card marked `multi_merchant_canonical` carrying one seller, while
 * the catalog held two converged listings — and the competing offer was reachable only by a
 * `content_key` no door hands out. The drop had no counter and no test, which is what hid it.
 *
 * The rule under test: the survivor records a collapsed listing ONLY when both carry the SAME
 * non-empty `content_key` — the identity the catalog itself converged them on. Anything else
 * (shade variants, different products with a shared title) drops exactly as it did before, because
 * claiming those are the same product would be an invention.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');

const { dedupeBeautyProductsByDisplayKey } = app._debug;

const CONTENT_KEY = 'ck_5dc9474321d1d597668670aebfd7543a';

function listing(overrides = {}) {
  return {
    id: overrides.product_key,
    product_id: overrides.product_key,
    title: 'Pyunkang Yul Deep Clear Cleansing Balm',
    brand: 'Pyunkang Yul',
    merchant_id: 'merch_obs_8c4e7afb1bf09b9a',
    merchant_name: 'eyurs.com',
    catalog_product_key: overrides.product_key,
    pdp_scope: 'multi_merchant_canonical',
    ...overrides,
  };
}

const EYURS = () =>
  listing({
    product_key: 'ext:retailer:1aed0be4ea653d0b3a0d8557ecf6a2c5',
    pivota_signature_id: 'sig_b97a3180c7c8868edd3bd2417f8def27',
    content_key: CONTENT_KEY,
  });

const OHLOLLY = () =>
  listing({
    product_key: 'ext:retailer:6ea79af5aac0c62fe1dba093340b6dd1',
    pivota_signature_id: 'sig_9905aa12d3d261e632b1363bcd911984',
    content_key: CONTENT_KEY,
    merchant_id: 'merch_obs_c43a84f5b02f2dba',
    merchant_name: 'ohlolly.com',
  });

test('a collapsed listing on the same content_key is recorded on the surviving card', () => {
  const out = dedupeBeautyProductsByDisplayKey([EYURS(), OHLOLLY()]);

  assert.equal(out.length, 1, 'one product still means one card');
  const [card] = out;
  assert.equal(card.product_key, 'ext:retailer:1aed0be4ea653d0b3a0d8557ecf6a2c5');
  assert.deepEqual(card.other_seller_listings, [
    {
      product_key: 'ext:retailer:6ea79af5aac0c62fe1dba093340b6dd1',
      merchant_id: 'merch_obs_c43a84f5b02f2dba',
      merchant_name: 'ohlolly.com',
      pivota_signature_id: 'sig_9905aa12d3d261e632b1363bcd911984',
      content_key: CONTENT_KEY,
    },
  ]);
  assert.equal(card.seller_listing_count, 2, 'the card counts itself and the seller it replaced');
});

test('the recorded listing keys are the ones the other doors accept', () => {
  // The entry exists to be CALLED: `get_offers` / `get_product` take a listing product_key or its
  // signature. An entry carrying only a merchant name would name a seller an agent cannot reach.
  const [card] = dedupeBeautyProductsByDisplayKey([EYURS(), OHLOLLY()]);
  for (const entry of card.other_seller_listings) {
    assert.match(entry.product_key, /^ext:retailer:[0-9a-f]{32}$/);
    assert.match(entry.pivota_signature_id, /^sig_[0-9a-f]{32}$/);
  }
});

test('three sellers all land on the card, once each', () => {
  const third = listing({
    product_key: 'ext:retailer:aaaa0be4ea653d0b3a0d8557ecf6a2c5',
    content_key: CONTENT_KEY,
    merchant_id: 'merch_obs_third',
    merchant_name: 'third.example',
  });
  const [card] = dedupeBeautyProductsByDisplayKey([EYURS(), OHLOLLY(), third, OHLOLLY()]);

  assert.deepEqual(
    card.other_seller_listings.map((entry) => entry.product_key),
    ['ext:retailer:6ea79af5aac0c62fe1dba093340b6dd1', 'ext:retailer:aaaa0be4ea653d0b3a0d8557ecf6a2c5'],
    'a repeat of the same listing must not be recorded twice',
  );
  assert.equal(card.seller_listing_count, 3);
});

test('a dropped row with a DIFFERENT content_key claims nothing', () => {
  // Two products that merely share a title are not two sellers of one product. This is the case
  // the old behaviour got right, and widening the claim here would invent convergence.
  const otherProduct = OHLOLLY();
  otherProduct.content_key = 'ck_a_different_product';

  const out = dedupeBeautyProductsByDisplayKey([EYURS(), otherProduct]);

  assert.equal(out.length, 1, 'it still collapses');
  assert.equal(out[0].other_seller_listings, undefined);
  assert.equal(out[0].seller_listing_count, undefined);
});

test('a dropped row with NO content_key claims nothing', () => {
  const unkeyed = OHLOLLY();
  delete unkeyed.content_key;

  const out = dedupeBeautyProductsByDisplayKey([EYURS(), unkeyed]);

  assert.equal(out.length, 1);
  assert.equal(out[0].other_seller_listings, undefined);
});

test('a survivor with no content_key records nothing, whatever the dropped row carries', () => {
  const unkeyedKeeper = EYURS();
  delete unkeyedKeeper.content_key;

  const out = dedupeBeautyProductsByDisplayKey([unkeyedKeeper, OHLOLLY()]);

  assert.equal(out.length, 1);
  assert.equal(out[0].other_seller_listings, undefined);
});

test('the same listing arriving twice is not recorded as its own competitor', () => {
  const out = dedupeBeautyProductsByDisplayKey([EYURS(), EYURS()]);

  assert.equal(out.length, 1);
  assert.equal(out[0].other_seller_listings, undefined, 'one listing is one seller');
});

test('cards that do not collapse are untouched', () => {
  const different = listing({
    product_key: 'ext:retailer:bbbb0be4ea653d0b3a0d8557ecf6a2c5',
    content_key: CONTENT_KEY,
    title: 'Pyunkang Yul Essence Toner',
  });

  const out = dedupeBeautyProductsByDisplayKey([EYURS(), different]);

  assert.equal(out.length, 2, 'different titles are different cards');
  assert.equal(out[0].other_seller_listings, undefined);
  assert.equal(out[1].other_seller_listings, undefined);
});

/**
 * THE SEAM. Everything above is inert unless the card the search lane actually builds carries
 * `content_key`. The canonical chain SELECT has always returned it (`canonicalCatalogSearch.js`
 * selects `p.content_key` and `c.content_key`) and the card projection dropped it on the floor,
 * which is why a real collapse had nothing to compare. Testing the collapse alone would pass with
 * the defect still in place.
 */
const { buildCanonicalChainMainlineProduct } = app._debug;

function canonicalRow(overrides = {}) {
  return {
    product_key: 'ext:retailer:1aed0be4ea653d0b3a0d8557ecf6a2c5',
    merchant_id: 'merch_obs_8c4e7afb1bf09b9a',
    platform: 'external_seed',
    source_product_id: 'retailer:1aed0be4ea653d0b3a0d8557ecf6a2c5',
    // `product_title`, not `title`: that is the alias the canonical chain SELECT emits, and the
    // builder reads only that one. A fixture keyed on `title` builds a card whose title is the
    // SIGNATURE id, which silently cannot collapse — this file's first draft did exactly that.
    product_title: 'Pyunkang Yul Deep Clear Cleansing Balm',
    brand: 'Pyunkang Yul',
    content_key: CONTENT_KEY,
    pivota_signature_id: 'sig_b97a3180c7c8868edd3bd2417f8def27',
    pdp_scope: 'multi_merchant_canonical',
    ...overrides,
  };
}

test('the canonical chain card carries the content_key the row already had', () => {
  const card = buildCanonicalChainMainlineProduct(canonicalRow());
  assert.equal(card.content_key, CONTENT_KEY);
  assert.equal(card.product_key, 'ext:retailer:1aed0be4ea653d0b3a0d8557ecf6a2c5');
});

test('a row with no content_key builds a card that asserts none', () => {
  const card = buildCanonicalChainMainlineProduct(canonicalRow({ content_key: null }));
  assert.equal('content_key' in card, false, 'absent, not an empty string claiming an identity');
});

test('end to end: two built cards collapse into one that names both sellers', () => {
  const cards = [
    buildCanonicalChainMainlineProduct(canonicalRow()),
    buildCanonicalChainMainlineProduct(
      canonicalRow({
        product_key: 'ext:retailer:6ea79af5aac0c62fe1dba093340b6dd1',
        merchant_id: 'merch_obs_c43a84f5b02f2dba',
        source_product_id: 'retailer:6ea79af5aac0c62fe1dba093340b6dd1',
        pivota_signature_id: 'sig_9905aa12d3d261e632b1363bcd911984',
      }),
    ),
  ];

  const out = dedupeBeautyProductsByDisplayKey(cards);

  assert.equal(out.length, 1);
  assert.equal(out[0].seller_listing_count, 2);
  assert.deepEqual(
    out[0].other_seller_listings.map((entry) => entry.product_key),
    ['ext:retailer:6ea79af5aac0c62fe1dba093340b6dd1'],
  );
});
