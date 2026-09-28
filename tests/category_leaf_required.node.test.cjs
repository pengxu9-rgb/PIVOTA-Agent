'use strict';

// The bare-domain half of this PR (`if (existingCategoryPath)` treating `beauty` as a
// categorisation) was superseded on main by #2204 (c4fe916a7): a stored path that is an ANCESTOR of
// the requested prefix now admits the row on its own title/product_type, which covers the stranded
// `beauty` cohort ("Cloud Eau de Parfum", "Cosmic Kylie Jenner Eau de Parfum", ...). Only the
// product_type half remains here.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// ---------------------------------------------------------------------------------------------
// `canonical_catalog` IS A PROVENANCE VALUE WEARING A TAXONOMY FIELD.
//
// It names where a row came from, not what the product is, and it is invented at serve time —
// nothing stores it. It is not inert: `resolveBeautyCoarseStepFamily` reads `product_type` FIRST
// when resolving a candidate's step, so a correctly-categorised perfume arrived at ranking with no
// step at all. On the live index 30 of 50 rows returned for "eau de parfum" carry the placeholder
// and exactly ONE says `fragrance`.

test('the canonical builder does not invent a product_type', () => {
  const at = SERVER_SRC.indexOf('function buildCanonicalChainMainlineProduct');
  const region = at > 0 ? SERVER_SRC.slice(at, at + 9000) : SERVER_SRC;
  assert.doesNotMatch(region, /product_type:\s*category\s*\|\|\s*'canonical_catalog'/,
    'the placeholder must not come back');
  assert.match(SERVER_SRC, /\.\.\.\(resolvedProductType \? \{ product_type: resolvedProductType \} : \{\}\)/,
    'product_type is emitted only when it is real, like price and currency above it');
  assert.match(SERVER_SRC, /const resolvedProductType = firstNonEmptyString\(category, categoryPathLeaf\)/,
    'and it falls back to the category-path LEAF, which is a real product type');
});

test('the leaf of a category path is what a product type should say', () => {
  // Lifted from source for the same reason as the predicate above: server.js boots a listener.
  const at = SERVER_SRC.indexOf('const categoryPathLeaf = String(categoryPathText');
  assert.ok(at > 0, 'the leaf extraction must exist');
  const src = SERVER_SRC.slice(at, SERVER_SRC.indexOf(';', SERVER_SRC.indexOf(".pop() || ''", at)) + 1);
  const leafOf = new Function('categoryPathText', `${src} return categoryPathLeaf;`);
  assert.equal(leafOf('beauty/fragrance/perfume'), 'perfume');
  assert.equal(leafOf('beauty/makeup/face/bronzer'), 'bronzer');
  assert.equal(leafOf('beauty/skincare/treat/serum'), 'serum');
  // A bare domain yields `beauty`, which is not a product type — but it is also not a FICTION, and
  // the row it describes is exactly the cohort the ancestor rescue in the search gate admits.
  assert.equal(leafOf('beauty'), 'beauty');
  assert.equal(leafOf(''), '');
  assert.equal(leafOf(null), '');
});

test('a real perfume resolves a step once the placeholder is gone', () => {
  // The measurement that made this worth doing, run against the real resolver.
  const { resolveBeautyCoarseStepFamily } = require('../src/shared/beautyRecoCoarseClassifier');
  const title = 'ABSOLUS ALLEGORIA Tabac Sahara';   // names no category in its own words
  const withPlaceholder = resolveBeautyCoarseStepFamily({
    title, product_type: 'canonical_catalog', catalog_category_path: 'beauty/fragrance/perfume',
  }) || {};
  const withLeaf = resolveBeautyCoarseStepFamily({
    title, product_type: 'perfume', catalog_category_path: 'beauty/fragrance/perfume',
  }) || {};
  assert.equal(withPlaceholder.candidate_step, null, 'this is what the placeholder cost');
  assert.equal(withLeaf.candidate_step, 'fragrance');
  assert.equal(withLeaf.candidate_step_source, 'structured_category');
});
