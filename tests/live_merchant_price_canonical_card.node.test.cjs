/**
 * The seam between the canonical card builder (src/server.js, buildCanonicalChainMainlineProduct) and
 * the live price verifier (src/services/liveMerchantSearchPrice.js, targetOf). The verifier recognises a
 * restated variant id by the card fields it reads; those must be the fields the builder writes, so this
 * builds the card from a row rather than by hand.
 *
 * Row shape: live kissusa.com product, after pivota-backend #2391. Its 139-char product_key cannot fit
 * catalog_skus.source_variant_id (VARCHAR(128)), so the canonical sku restates the source_product_id.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';

const app = require('../src/server');
const { targetOf } = require('../src/services/liveMerchantSearchPrice');

const { buildCanonicalChainMainlineProduct } = app._debug;

const SOURCE_PRODUCT_ID =
  'kiss-kiss-haunt-halloween-press-on-fake-glue-nails-midnight-makeover-french-design-black-white-medium-almond-glow-in-the-dark';

function row(overrides = {}) {
  return {
    merchant_id: 'merch_kissusa',
    merchant_name: 'kissusa.com',
    product_key: `ext:${SOURCE_PRODUCT_ID}::44f3c737`,
    platform: 'external_seed',
    source_product_id: SOURCE_PRODUCT_ID,
    source_variant_id: SOURCE_PRODUCT_ID,
    product_title: 'Kiss Haunt Halloween Press On Fake Glue Nails - Midnight Makeover',
    brand: 'KISS',
    category_path: 'beauty/nails/press-on-nails',
    canonical_url: 'https://www.kissusa.com/products/kiss-haunt-halloween-midnight-makeover',
    product_payload: {},
    pivota_signature_id: 'sig_kiss_haunt',
    pivota_canonical_url: 'https://agent.pivota.cc/products/sig_kiss_haunt',
    availability: 'in_stock',
    currency: 'USD',
    merchant_effective_price: '9.99',
    rank_score: 290,
    ...overrides,
  };
}

test('a long-key card built from its row names no variant when its sku restates the source_product_id', () => {
  const card = buildCanonicalChainMainlineProduct(row());
  assert.equal(card.product_key.length, 139);
  assert.equal(card.source_variant_id, SOURCE_PRODUCT_ID);
  // product_id is the signature id on this card, so it could not have recognised the restatement
  assert.equal(card.product_id, 'sig_kiss_haunt');
  assert.equal(targetOf(card).url, 'https://www.kissusa.com/products/kiss-haunt-halloween-midnight-makeover.json');
  assert.equal(targetOf(card).variant, '');
});

test('the same card built with a real Shopify variant id still names that variant', () => {
  const card = buildCanonicalChainMainlineProduct(row({ source_variant_id: '45199259336801' }));
  assert.equal(targetOf(card).variant, '45199259336801');
});
