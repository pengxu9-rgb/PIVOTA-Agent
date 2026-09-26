'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internals: { inferCatalogMirrorCategory } } = require('../scripts/sync-external-seeds-to-catalog.cjs');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const { buildExternalSeedRecallDoc } = require('../src/services/externalSeedRecall');
const { resolveBackfillCurrency, deriveSourceBackedCategoryFromProductText, resolveBackfillCategory } =
  require('../scripts/backfill-external-product-seeds-catalog.js');

function row(title) {
  return { title, external_product_id: 'jungsaemmool:615e47aee567b863',
    domain: 'jsmbeauty.sg', seed_data: {}, status: 'active' };
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
  assert.notEqual(
    inferCatalogMirrorCategory({ ...row('LIP-PRESSION Metal Serum Gloss'), external_product_id: 'another:product' }).categoryPath,
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
  const exact = {
    selectedSnapshotVariant: variant,
    effectiveSnapshotVariants: [variant, { ...variant }],
    hasExtractedVariants: true,
    row: { market: 'US', price_currency: 'SGD', external_product_id: 'jungsaemmool:615e47aee567b863' },
    seedData: {}, snapshot: {},
  };
  assert.equal(resolveBackfillCurrency(exact), 'SGD');
  for (const change of [
    { hasExtractedVariants: false },
    { effectiveSnapshotVariants: [variant, { currency: 'USD' }] },
    { effectiveSnapshotVariants: [variant, { price: '20.00' }] },
    { seedData: { pricing: { current: { currency: 'USD' } } } },
  ]) {
    assert.throws(() => resolveBackfillCurrency({ ...exact, ...change }), /reviewed_meitu_source_currency_conflict/);
  }
  assert.equal(resolveBackfillCurrency({
    ...exact, row: { market: 'US', price_currency: 'SGD', external_product_id: 'another:product' },
  }), 'USD');
});

test('backfill labels only the source-verified merchant line as lip gloss', () => {
  const product = { title: 'LIP-PRESSION Metal Serum Gloss' };
  const reviewed = { domain: 'jsmbeauty.sg', external_product_id: 'jungsaemmool:615e47aee567b863' };
  assert.equal(deriveSourceBackedCategoryFromProductText(product, reviewed)?.category, 'Lip Gloss');
  assert.notEqual(deriveSourceBackedCategoryFromProductText(product, { ...reviewed, domain: 'other.example' })?.category, 'Lip Gloss');
  assert.notEqual(deriveSourceBackedCategoryFromProductText(
    { title: 'LIP-PRESSION Metal Serum Gloss Set' }, reviewed,
  )?.category, 'Lip Gloss');
  assert.notEqual(deriveSourceBackedCategoryFromProductText(
    { title: 'Artist Cushion Blush + LIP-PRESSION Metal Serum Gloss' }, reviewed,
  )?.category, 'Lip Gloss');
  assert.notEqual(deriveSourceBackedCategoryFromProductText(product, {
    ...reviewed, seed_data: { product_family: 'set_or_collection' },
  })?.category, 'Lip Gloss');
});

test('reviewed merchant Lip Gloss outranks only generic extracted Serum', () => {
  const representativeProduct = { title: 'LIP-PRESSION Metal Serum Gloss' };
  const reviewed = { domain: 'jsmbeauty.sg', external_product_id: 'jungsaemmool:615e47aee567b863' };
  const input = { representativeProduct, row: reviewed, existingCategory: '', identityRepairBackfill: false };
  assert.equal(resolveBackfillCategory({ ...input, extractedCategory: 'Serum' }).nextCategory, 'Lip Gloss');
  assert.equal(resolveBackfillCategory({ ...input, extractedCategory: 'Hair Serum' }).nextCategory, 'Hair Serum');
  assert.equal(resolveBackfillCategory({ ...input, extractedCategory: 'Serum', row: { ...reviewed, domain: 'other.example' } }).nextCategory, 'Serum');
  assert.equal(resolveBackfillCategory({ ...input, extractedCategory: 'Serum', representativeProduct: { title: 'LIP-PRESSION Metal Serum Gloss Set' } }).nextCategory, 'Serum');
});

test('reviewed Lip Gloss survives title-first recall document classification', () => {
  const targetRow = row('LIP-PRESSION Metal Serum Gloss');
  const seedData = {
    title: targetRow.title,
    category: 'Lip Gloss',
  };
  assert.equal(buildExternalSeedRecallDoc({ row: targetRow, seedData, snapshot: { category: 'Lip Gloss' } }).category, 'Lip Gloss');
  assert.notEqual(buildExternalSeedRecallDoc({ row: { ...targetRow, domain: 'other.example' }, seedData, snapshot: { category: 'Lip Gloss' } }).category, 'Lip Gloss');
  assert.notEqual(buildExternalSeedRecallDoc({ row: targetRow, seedData: { ...seedData, category: 'Hair Serum' }, snapshot: { category: 'Lip Gloss' } }).category, 'Lip Gloss');
  assert.notEqual(buildExternalSeedRecallDoc({ row: targetRow, seedData, snapshot: {} }).category, 'Lip Gloss');
});
