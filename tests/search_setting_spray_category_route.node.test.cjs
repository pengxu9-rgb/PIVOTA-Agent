'use strict';

// Setting spray is a leaf: beauty/makeup/face/setting-spray (pivota-backend#2547, 2026-10-10).
//
// The QUERY route is behind SEARCH_SETTING_SPRAY_CATEGORY_ROUTE, off by default, because the live setting
// sprays still sit on beauty/makeup, tone/toner and the old gap path until they are re-filed. With the flag
// off every query must route exactly as before (the browse-prefix golden in
// recall_taxonomy_leaf_parity.node.test.cjs pins the wider corpus). The external-seed LABEL is behind the
// same flag: a seed's `category` reaches search filters, routine steps and partner payloads, so with it
// off every seed keeps the label it had before the leaf.

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

test('with the flag on, an external seed setting spray is labelled Setting Spray, not Toner', () => {
  withFlag('1', () => {
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
      // another area's fixer, or a bare fix spray, keeps the label it had
      ['Lash Fixing Mist', 'Toner'],
      ['Brow Setting Spray', ''],
      ['Lace Wig Fixing Spray', ''],
      ['Stain Fix Spray', ''],
    ]) {
      assert.equal(inferExternalSeedBeautyCategory({ title }), want, title);
    }
  });
});

test('with the flag on, a DESCRIPTION never makes a seed a setting spray', () => {
  // many face mists say "use as a setting spray"
  withFlag('1', () => {
    assert.equal(inferExternalSeedBeautyCategory({
      title: 'Facial Spray with Aloe, Herbs and Rosewater',
      description: 'Refreshing facial mist. Spritz over makeup as a setting spray.',
    }), 'Toner');
    assert.equal(inferExternalSeedBeautyCategory({ title: 'Rose Water', description: 'Use as a toner or a setting spray.' }), 'Toner');
    assert.equal(inferExternalSeedBeautyCategory({ title: 'Dewy Skin', description: 'A setting spray that locks makeup.' }), '');
  });
});

test('with the flag on, a combined "Setting Spray and Powder" shelf takes the spray only for a spray title', () => {
  withFlag('1', () => {
    const shelf = 'Setting Spray and Powder';
    assert.equal(inferExternalSeedBeautyCategory({ title: 'All Nighter Setting Spray', explicitCategory: shelf }), 'Setting Spray');
    for (const title of ['Translucent Powder', 'Setting Spray & Powder Duo', 'Hydrating Face Mist']) {
      assert.equal(inferExternalSeedBeautyCategory({ title, explicitCategory: shelf }), 'Powder', title);
    }
  });
});

// inferExternalSeedBeautyCategory on origin/main 6cffb14a4, before the leaf (captured 2026-10-30).
const LABELS_ON_MAIN = [
  {"title": "Facial Spray with Aloe, Herbs and Rosewater", "description": "Refreshing facial mist. Spritz over makeup as a setting spray.", "label": "Toner"},
  {"title": "Rose Water", "description": "Use as a toner or a setting spray.", "label": "Toner"},
  {"title": "Hydrating Toner", "explicitCategory": "Face Mist & Setting Spray", "label": "Toner"},
  {"title": "Makeup Fixing Toner", "label": "Toner"},
  {"title": "Primer and Setting Spray", "label": ""},
  {"title": "Mist & Fix", "description": "For hair and makeup.", "label": "Toner"},
  {"title": "Makeup Fixing Mist", "label": "Toner"},
  {"title": "You Mist Makeup-Extending Setting Spray", "label": "Toner"},
  {"title": "All Nighter Setting Spray", "label": ""},
  {"title": "Hydrating Face Mist", "label": "Toner"},
  {"title": "Rose Water Toner", "label": "Toner"},
  {"title": "Hair Fixing Spray", "label": "Hair Care"},
  {"title": "Brow Setting Spray", "label": ""},
  {"title": "Lash Fixing Mist", "label": "Toner"},
  {"title": "Lace Wig Fixing Spray", "label": ""},
  {"title": "Stain Fix Spray", "label": ""},
  {"title": "Setting Spray SPF 30", "label": "Sunscreen"},
  {"title": "Dewy Skin", "description": "A setting spray that locks makeup.", "label": ""},
  {"title": "Glow Drops", "explicitCategory": "Setting Spray", "label": "Setting Spray"},
  {"title": "Translucent Powder", "explicitCategory": "Setting Spray and Powder", "label": "Powder"}
];

test('with the flag off, every seed keeps the label it had on main', () => {
  for (const value of [null, '', '0', 'off', 'false']) {
    withFlag(value, () => {
      for (const { label, ...seed } of LABELS_ON_MAIN) {
        assert.equal(inferExternalSeedBeautyCategory(seed), label, `${JSON.stringify(seed)} flag=${value}`);
      }
    });
  }
});

test('with the flag on, the setting-spray route declines other areas and sun-protection asks', () => {
  withFlag('1', () => {
    for (const query of ['brow setting spray', 'lash fixing mist', 'lace wig fixing spray', 'stain fix spray', 'quick fix spray']) {
      assert.notEqual(resolveBeautyCategoryPathPrefixFromText(query), PREFIX, query);
    }
    for (const query of ['setting spray spf', 'setting spray spf 30', 'sunscreen setting spray']) {
      assert.equal(resolveBeautyCategoryPathPrefixFromText(query), 'beauty/skincare/sun/', query);
    }
    assert.equal(resolveBeautyCategoryPathPrefixFromText('face and body setting spray'), PREFIX);
  });
});
