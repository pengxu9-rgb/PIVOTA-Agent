'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  analyzeRows,
  makeCurrentContentKey,
  makeProposedBrandPrefixContentKey,
  normalizeTitle,
  stripLeadingBrandPrefixFromNormalizedTitle,
} = require('../../scripts/dry-run-brand-prefix-remap.cjs');

test('proposed algorithm strips a leading brand prefix before hashing', () => {
  const brand = 'The Ordinary';
  const unprefixedTitle = 'Niacinamide 10% + Zinc 1%';
  const prefixedTitle = 'The Ordinary Niacinamide 10% + Zinc 1%';

  assert.equal(
    stripLeadingBrandPrefixFromNormalizedTitle(brand, prefixedTitle),
    normalizeTitle(unprefixedTitle),
  );
  assert.equal(
    makeProposedBrandPrefixContentKey(brand, prefixedTitle, null),
    makeCurrentContentKey(brand, unprefixedTitle, null),
  );
  assert.notEqual(
    makeCurrentContentKey(brand, prefixedTitle, null),
    makeProposedBrandPrefixContentKey(brand, prefixedTitle, null),
  );
});

test('analysis counts cross-source groups that collapse under proposed keys', () => {
  const brand = 'The Ordinary';
  const targetKey = makeCurrentContentKey(brand, 'Niacinamide 10% + Zinc 1%', null);
  const currentPrefixedKey = makeCurrentContentKey(brand, 'The Ordinary Niacinamide 10% + Zinc 1%', null);

  const analysis = analyzeRows([
    {
      product_key: 'prod_a',
      brand,
      title: 'The Ordinary Niacinamide 10% + Zinc 1%',
      current_ck: currentPrefixedKey,
      source_system: 'source_a',
      gtin: '',
      positive_offer_count: 1,
      live_identity_count: 0,
    },
    {
      product_key: 'prod_b',
      brand,
      title: 'Niacinamide 10% + Zinc 1%',
      current_ck: targetKey,
      source_system: 'source_b',
      gtin: '',
      positive_offer_count: 0,
      live_identity_count: 1,
    },
  ]);

  assert.equal(analysis.changedRows.length, 1);
  assert.equal(analysis.collapseGroups.length, 1);
  assert.equal(analysis.proposedMergedRowsWithPositiveOffers.length, 1);
  assert.equal(analysis.proposedMergedRowsWithLiveIdentity.length, 1);
});
