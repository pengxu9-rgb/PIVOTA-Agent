/**
 * The canonical search SQL serves each product's BEST-OFFER listing, which can be a sibling of the
 * listing recall ranked (src/services/canonicalCatalogSearch.js, skuOfferJoinSql; the SQL itself is
 * pinned on real PostgreSQL in tests/integration/canonical_offer_availability_postgres.test.js).
 * This file pins the two JS seams that read that row:
 *
 *   * the card builder names the recalled listing ONLY when the served one differs, so a card
 *     served from its own listing is byte-identical to before;
 *   * the seed/canonical lane merge treats the recalled listing as covered, so a seed row for it
 *     cannot come back as a second card for the same product.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');

const { buildCanonicalChainMainlineProduct, mergeCanonicalChainProductsWithSeedProducts } = app._debug;

function row(overrides = {}) {
  return {
    merchant_id: 'merch_sokoglam',
    merchant_name: 'sokoglam.com',
    product_key: 'ext:retailer:sokoglam',
    platform: 'external_seed',
    source_product_id: 'retailer:sokoglam',
    product_title: 'Purito Oat-in Calming Gel Cream',
    brand: 'Purito SEOUL',
    category_path: 'beauty/skincare/moisturize/cream',
    canonical_url: 'https://sokoglam.com/products/purito-seoul-oat-in-calming-gel-cream',
    product_payload: {},
    content_key: 'ck_3801b85d6e1869e274492eaac9734deb',
    pivota_signature_id: 'sig_sokoglam',
    pivota_canonical_url: 'https://agent.pivota.cc/products/sig_sokoglam',
    availability: 'in_stock',
    currency: 'USD',
    merchant_effective_price: '19.50',
    rank_score: 290,
    ...overrides,
  };
}

test('a card served from a SIBLING listing names the listing recall ranked, and sells from the served one', () => {
  const card = buildCanonicalChainMainlineProduct(row({
    recalled_product_key: 'ext:retailer:ohlolly',
    recalled_source_product_id: 'retailer:ohlolly',
  }));
  assert.deepEqual(card.recalled_listing, {
    product_key: 'ext:retailer:ohlolly',
    source_product_id: 'retailer:ohlolly',
  });
  // Every seller field is the served listing's.
  assert.equal(card.merchant_id, 'merch_sokoglam');
  assert.equal(card.merchant_name, 'sokoglam.com');
  assert.equal(card.product_id, 'sig_sokoglam');
  assert.equal(card.product_key, 'ext:retailer:sokoglam');
  assert.equal(card.destination_url, 'https://sokoglam.com/products/purito-seoul-oat-in-calming-gel-cream');
  assert.equal(card.price, 19.5);
  assert.equal(card.availability, 'in_stock');
  assert.equal(card.in_stock, true);
});

test('a card served from its OWN listing is byte-identical to the card built without the recalled columns', () => {
  const own = row({ recalled_product_key: 'ext:retailer:sokoglam', recalled_source_product_id: 'retailer:sokoglam' });
  const withColumns = buildCanonicalChainMainlineProduct(own);
  const { recalled_product_key: _k, recalled_source_product_id: _s, ...before } = own;
  assert.equal(JSON.stringify(withColumns), JSON.stringify(buildCanonicalChainMainlineProduct(before)));
  assert.equal('recalled_listing' in withColumns, false);
});

test('the lane merge treats the recalled listing as covered: its seed row is not a second card', () => {
  const canonical = buildCanonicalChainMainlineProduct(row({
    recalled_product_key: 'ext:retailer:ohlolly',
    recalled_source_product_id: 'retailer:ohlolly',
  }));
  const seedForRecalled = {
    id: 'seed_ohlolly', product_id: 'seed_ohlolly', attached_product_key: 'ext:retailer:ohlolly',
    title: 'Purito Oat-in Calming Gel Cream', merchant_id: 'merch_ohlolly',
  };
  const seedBySourceId = {
    id: 'seed_ohlolly_2', product_id: 'seed_ohlolly_2', source_product_id: 'retailer:ohlolly',
    title: 'Purito Oat-in Calming Gel Cream', merchant_id: 'merch_ohlolly',
  };
  const unrelatedSeed = { id: 'seed_other', product_id: 'seed_other', attached_product_key: 'ext:retailer:other', title: 'Other' };
  const merged = mergeCanonicalChainProductsWithSeedProducts([seedForRecalled, seedBySourceId, unrelatedSeed], [canonical]);
  assert.deepEqual(merged.products.map((product) => product.id), ['seed_other', 'sig_sokoglam']);
  assert.equal(merged.canonical_dedupe_count, 2);
});
