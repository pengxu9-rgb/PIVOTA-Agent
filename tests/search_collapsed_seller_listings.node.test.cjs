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

/**
 * THE CLAIM IS "ANOTHER SELLER", so the code must check the seller. `content_key` is
 * make_content_key(brand, title, gtin) and carries NO merchant component: one store's two listings
 * of one product share it, and this repo measures 474 content_keys serving identical content under
 * 2-7 signatures. The first draft of this change counted those as competition.
 */
test('two listings from the SAME merchant are not a second seller', () => {
  const twin = OHLOLLY();
  twin.merchant_id = 'merch_obs_8c4e7afb1bf09b9a'; // the keeper's own merchant
  twin.merchant_name = 'eyurs.com';

  const out = dedupeBeautyProductsByDisplayKey([EYURS(), twin]);

  assert.equal(out.length, 1, 'it still collapses the duplicate page');
  assert.equal(out[0].other_seller_listings, undefined, 'one store is not competition');
  assert.equal(out[0].seller_listing_count, undefined);
});

test('a dropped listing with no merchant id names nobody, so it claims nothing', () => {
  const anonymous = OHLOLLY();
  delete anonymous.merchant_id;

  const out = dedupeBeautyProductsByDisplayKey([EYURS(), anonymous]);

  assert.equal(out[0].other_seller_listings, undefined);
});

test('a keeper with no merchant id cannot say another seller differs from it', () => {
  const anonymousKeeper = EYURS();
  delete anonymousKeeper.merchant_id;

  const out = dedupeBeautyProductsByDisplayKey([anonymousKeeper, OHLOLLY()]);

  assert.equal(out[0].other_seller_listings, undefined);
});

test('a second listing from a merchant already recorded is not counted twice', () => {
  const again = OHLOLLY();
  again.product_key = 'ext:retailer:cccc0be4ea653d0b3a0d8557ecf6a2c5';

  const [card] = dedupeBeautyProductsByDisplayKey([EYURS(), OHLOLLY(), again]);

  assert.equal(card.other_seller_listings.length, 1, 'one seller is one entry');
  assert.equal(card.seller_listing_count, 2);
});

test('a merchant_name that is really the brand fallback is left off the entry', () => {
  // `merchant_name` falls back to the brand when the catalog_merchants join misses. "Sold by
  // Pyunkang Yul" for an unnamed reseller reads as a brand-direct offer, which is a different
  // claim entirely. The id stays; the name goes.
  const unnamed = OHLOLLY();
  unnamed.merchant_name = 'Pyunkang Yul';

  const [card] = dedupeBeautyProductsByDisplayKey([EYURS(), unnamed]);

  assert.equal(card.other_seller_listings.length, 1);
  assert.equal('merchant_name' in card.other_seller_listings[0], false);
  assert.equal(card.other_seller_listings[0].merchant_id, 'merch_obs_c43a84f5b02f2dba');
});

test('the seller list is capped and says when it truncated', () => {
  const many = [EYURS()];
  for (let i = 0; i < 30; i += 1) {
    const seller = OHLOLLY();
    seller.product_key = `ext:retailer:${String(i).padStart(32, '0')}`;
    seller.merchant_id = `merch_obs_${i}`;
    seller.merchant_name = `seller-${i}.example`;
    many.push(seller);
  }

  const [card] = dedupeBeautyProductsByDisplayKey(many);

  assert.equal(card.other_seller_listings.length, 8, 'capped like every other list on this card');
  assert.equal(card.seller_listing_count, 9);
  assert.equal(card.other_seller_listings_truncated, true, 'truncation is stated, never silent');
});

test('a card never lists its OWN other key as a rival seller', () => {
  // The seed lane carries product_key and catalog_product_key independently, so comparing only
  // the first lets a card cite itself.
  const keeper = EYURS();
  keeper.catalog_product_key = 'ext:retailer:6ea79af5aac0c62fe1dba093340b6dd1';

  const out = dedupeBeautyProductsByDisplayKey([keeper, OHLOLLY()]);

  assert.equal(out[0].other_seller_listings, undefined, 'that key is the keeper itself');
});

test('a non-string content_key converges nothing', () => {
  // Two distinct objects both stringify to '[object Object]' and would compare equal.
  const keeper = EYURS();
  const other = OHLOLLY();
  keeper.content_key = { ck: 1 };
  other.content_key = { ck: 2 };

  const out = dedupeBeautyProductsByDisplayKey([keeper, other]);

  assert.equal(out[0].other_seller_listings, undefined);
});
