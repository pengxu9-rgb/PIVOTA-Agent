'use strict';

// The beauty direct call after context build (creator_direct) must take exactly the requests that
// the two calls it replaced took (#2279): mainline_direct, which sat before the creator lanes, and
// the old creator_direct. Both old gates are written out here as they stood on main before
// 3c9f16fd8, and the new gate is checked against their union over every combination of inputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isBeautyDirectAfterContextEligible } = require('../src/findProductsMulti/beautyDirectGate');

const KEYS = [
  'directRecallEnabled',
  'canonicalSigEntityMode',
  'hasQueryText',
  'beautyLike',
  'searchQualityContractApplied',
  'hasMerchantScope',
  'pivotBeautyContract',
  'productOnly',
  'strictCommerce',
  'shoppingCanonicalMainlineEligible',
];

function oldMainlineDirect(g) {
  return (
    g.directRecallEnabled &&
    !g.canonicalSigEntityMode &&
    g.pivotBeautyContract &&
    g.hasQueryText &&
    (g.beautyLike || g.searchQualityContractApplied) &&
    !g.hasMerchantScope
  );
}

function oldCreatorDirect(g) {
  return (
    g.directRecallEnabled &&
    !g.productOnly &&
    !g.canonicalSigEntityMode &&
    (!g.strictCommerce || g.searchQualityContractApplied) &&
    g.hasQueryText &&
    (g.pivotBeautyContract || g.shoppingCanonicalMainlineEligible || g.searchQualityContractApplied) &&
    (g.beautyLike || g.searchQualityContractApplied) &&
    !g.hasMerchantScope
  );
}

test('the gate equals the union of the two gates it replaced, for every input', () => {
  let mismatches = 0;
  for (let mask = 0; mask < 2 ** KEYS.length; mask += 1) {
    const g = Object.fromEntries(KEYS.map((key, i) => [key, Boolean((mask >> i) & 1)]));
    const expected = Boolean(oldMainlineDirect(g) || oldCreatorDirect(g));
    if (isBeautyDirectAfterContextEligible(g) !== expected) mismatches += 1;
  }
  assert.equal(mismatches, 0);
});

const pivot = {
  directRecallEnabled: true,
  canonicalSigEntityMode: false,
  hasQueryText: true,
  beautyLike: true,
  searchQualityContractApplied: false,
  hasMerchantScope: false,
  pivotBeautyContract: true,
  productOnly: false,
  strictCommerce: false,
  shoppingCanonicalMainlineEligible: false,
};

test('a pivot contract request skips the product_only and strict conditions', () => {
  assert.equal(isBeautyDirectAfterContextEligible({ ...pivot, productOnly: true }), true);
  assert.equal(isBeautyDirectAfterContextEligible({ ...pivot, strictCommerce: true }), true);
});

test('the pivot detector is only called once the cheap conditions hold', () => {
  let calls = 0;
  const detector = () => {
    calls += 1;
    return true;
  };
  assert.equal(isBeautyDirectAfterContextEligible({ ...pivot, hasMerchantScope: true, pivotBeautyContract: detector }), false);
  assert.equal(isBeautyDirectAfterContextEligible({ ...pivot, beautyLike: false, pivotBeautyContract: detector }), false);
  assert.equal(calls, 0);
  assert.equal(isBeautyDirectAfterContextEligible({ ...pivot, pivotBeautyContract: detector }), true);
  assert.equal(calls, 1);
});

test('any other request keeps them', () => {
  const shopping = { ...pivot, pivotBeautyContract: false, shoppingCanonicalMainlineEligible: true };
  assert.equal(isBeautyDirectAfterContextEligible(shopping), true);
  assert.equal(isBeautyDirectAfterContextEligible({ ...shopping, productOnly: true }), false);
  assert.equal(isBeautyDirectAfterContextEligible({ ...shopping, strictCommerce: true }), false);
  assert.equal(
    isBeautyDirectAfterContextEligible({ ...shopping, strictCommerce: true, searchQualityContractApplied: true }),
    true,
  );
});
