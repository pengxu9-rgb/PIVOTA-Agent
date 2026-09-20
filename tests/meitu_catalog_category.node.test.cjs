'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals: { inferCatalogMirrorCategory } } = require('../scripts/sync-external-seeds-to-catalog.cjs');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const { resolveBackfillCurrency, deriveSourceBackedCategoryFromProductText } =
  require('../scripts/backfill-external-product-seeds-catalog.js');

function row(title) {
  return { title, domain: 'jsmbeauty.sg', seed_data: {}, status: 'active' };
}

test('merchant lip-pression serum gloss is indexed as lip gloss', () => {
  const shape = inferCatalogMirrorCategory(row('LIP-PRESSION Metal Serum Gloss'));
  assert.equal(shape.productType, 'Lip Gloss');
  assert.equal(shape.categoryPath, 'beauty/makeup/lip/gloss');
});

test('a bundle mentioning the same gloss remains a set', () => {
  const shape = inferCatalogMirrorCategory(row('Artist Cushion Blush + LIP-PRESSION Metal Serum Gloss Set'));
  assert.notEqual(shape.categoryPath, 'beauty/makeup/lip/gloss');
});

test('another merchant and an explicit category are not overridden', () => {
  assert.notEqual(
    inferCatalogMirrorCategory({ ...row('LIP-PRESSION Metal Serum Gloss'), domain: 'other.example' }).categoryPath,
    'beauty/makeup/lip/gloss',
  );
  assert.equal(
    inferCatalogMirrorCategory({
      ...row('LIP-PRESSION Metal Serum Gloss'),
      seed_data: { product_type: 'Hair Serum', category_path: 'beauty/haircare/treatment/serum' },
    }).categoryPath,
    'beauty/haircare/treatment/serum',
  );
});

test('the exact product and shade wording resolves to lip makeup', () => {
  for (const query of ['Metal Serum Gloss', 'metal serum gloss core drop']) {
    const contract = buildSearchQualityContract({ rawQuery: query, market: 'SG' });
    assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/makeup/lip/');
  }
});

test('ordinary skincare serum stays in the skincare tree', () => {
  const contract = buildSearchQualityContract({ rawQuery: 'hyaluronic serum', market: 'SG' });
  assert.equal(contract.hard_constraints.category_path_prefix, 'beauty/skincare/treat/');
});

test('backfill preserves source-confirmed SGD on a US-partition seed', () => {
  const variant = { price: '30.00', currency: 'SGD' };
  assert.equal(resolveBackfillCurrency({
    selectedSnapshotVariant: variant,
    effectiveSnapshotVariants: [variant, { ...variant }],
    row: { market: 'US', price_currency: 'SGD' },
    seedData: {}, snapshot: {},
  }), 'SGD');
  assert.equal(resolveBackfillCurrency({
    selectedSnapshotVariant: variant,
    effectiveSnapshotVariants: [variant, { currency: 'USD' }],
    row: { market: 'US', price_currency: 'SGD' },
    seedData: {}, snapshot: {},
  }), 'USD');
});

test('backfill labels only the source-verified merchant line as lip gloss', () => {
  const product = { title: 'LIP-PRESSION Metal Serum Gloss' };
  assert.equal(deriveSourceBackedCategoryFromProductText(product, { domain: 'jsmbeauty.sg' })?.category, 'Lip Gloss');
  assert.notEqual(deriveSourceBackedCategoryFromProductText(product, { domain: 'other.example' })?.category, 'Lip Gloss');
  assert.notEqual(deriveSourceBackedCategoryFromProductText(
    { title: 'LIP-PRESSION Metal Serum Gloss Set' }, { domain: 'jsmbeauty.sg' },
  )?.category, 'Lip Gloss');
});
