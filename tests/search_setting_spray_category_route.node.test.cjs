'use strict';

// Setting spray is a leaf: beauty/makeup/face/setting-spray (pivota-backend#2547, 2026-10-10).
//
// The QUERY route is behind SEARCH_SETTING_SPRAY_CATEGORY_ROUTE, off by default, because the live setting
// sprays still sit on beauty/makeup, tone/toner and the old gap path until they are re-filed. With the flag
// off every query must route exactly as before (the browse-prefix golden in
// recall_taxonomy_leaf_parity.node.test.cjs pins the wider corpus). The external-seed LABEL is not flagged:
// a seed setting spray is labelled "Setting Spray" instead of "Toner".

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveBeautyCategoryPathPrefixFromText,
  SETTING_SPRAY_CATEGORY_ROUTE_FLAG,
} = require('../src/findProductsMulti/queryUnderstanding');
const {
  resolveBeautyCategoryPathPrefixForQuery,
  inferExternalSeedBeautyCategory,
} = require('../src/services/externalSeedProducts');
const { CANONICAL_CATEGORY_PATHS, toCanonicalCategoryPath, categoryPathHasDoor } = require('../src/services/beautyTaxonomy');

const LEAF = 'beauty/makeup/face/setting-spray';
const PREFIX = `${LEAF}/`;

function withFlag(value, fn) {
  const prior = process.env[SETTING_SPRAY_CATEGORY_ROUTE_FLAG];
  if (value == null) delete process.env[SETTING_SPRAY_CATEGORY_ROUTE_FLAG];
  else process.env[SETTING_SPRAY_CATEGORY_ROUTE_FLAG] = value;
  try {
    return fn();
  } finally {
    if (prior == null) delete process.env[SETTING_SPRAY_CATEGORY_ROUTE_FLAG];
    else process.env[SETTING_SPRAY_CATEGORY_ROUTE_FLAG] = prior;
  }
}

const SETTING_QUERIES = [
  'setting spray',
  'makeup setting spray',
  'setting mist',
  'makeup fixer',
  'fixing spray',
  'mist and fix',
  'urban decay all nighter setting spray',
  'setting spray for oily skin',
  '定妆喷雾',
];

test('the canonical home is the backend leaf, its old gap spelling aliases to it, and recall can reach it', () => {
  assert.equal(CANONICAL_CATEGORY_PATHS.setting_spray, LEAF);
  assert.equal(toCanonicalCategoryPath('beauty/makeup/setting-spray'), LEAF);
  assert.equal(categoryPathHasDoor(LEAF), true);
});

test('with the flag off, a setting-spray query routes exactly as it did before the leaf', () => {
  // captured on origin/main af263a1fc before this change
  const before = {
    'setting spray': ['', ''],
    'makeup setting spray': ['', ''],
    'setting mist': ['', 'beauty/skincare/tone/'],
    'makeup fixer': ['', ''],
    'fixing spray': ['', ''],
    'mist and fix': ['', 'beauty/skincare/tone/'],
    'urban decay all nighter setting spray': ['', ''],
    'setting spray for oily skin': ['', ''],
    '定妆喷雾': ['', ''],
  };
  withFlag(null, () => {
    for (const query of SETTING_QUERIES) {
      assert.deepEqual(
        [resolveBeautyCategoryPathPrefixFromText(query), resolveBeautyCategoryPathPrefixForQuery(query)],
        before[query],
        query,
      );
    }
  });
});

test('with the flag on, a setting-spray query browses the setting-spray leaf', () => {
  withFlag('1', () => {
    for (const query of SETTING_QUERIES) {
      assert.equal(resolveBeautyCategoryPathPrefixFromText(query), PREFIX, query);
      assert.equal(resolveBeautyCategoryPathPrefixForQuery(query), PREFIX, query);
    }
  });
});

test('with the flag on, mists, powders and hair sprays keep their own homes', () => {
  withFlag('1', () => {
    assert.equal(resolveBeautyCategoryPathPrefixFromText('face mist'), 'beauty/skincare/tone/');
    assert.equal(resolveBeautyCategoryPathPrefixFromText('setting powder'), 'beauty/makeup/face/powder/');
    assert.equal(resolveBeautyCategoryPathPrefixFromText('hair spray'), 'beauty/haircare/');
    assert.notEqual(resolveBeautyCategoryPathPrefixFromText('hair fixing spray'), PREFIX);
    assert.notEqual(resolveBeautyCategoryPathPrefixForQuery('hair fixing spray'), PREFIX);
    assert.notEqual(resolveBeautyCategoryPathPrefixFromText('volumizing finishing spray'), PREFIX);
  });
});

test('an external seed setting spray is labelled Setting Spray, not Toner', () => {
  for (const title of [
    'Makeup Fixing Mist',
    'You Mist Makeup-Extending Setting Spray',
    'RMS Beauty Radiance Lock Setting Mist 100ml',
    'Mist & Fix Matte Spray',
    '3CE Makeup Fixer Mist',
  ]) {
    assert.equal(inferExternalSeedBeautyCategory({ title }), 'Setting Spray', title);
  }
  for (const [title, want] of [
    ['Hydrating Face Mist', 'Toner'],
    ['Rose Water Toner', 'Toner'],
    ['Hair Fixing Spray', 'Hair Care'],
  ]) {
    assert.equal(inferExternalSeedBeautyCategory({ title }), want, title);
  }
});
