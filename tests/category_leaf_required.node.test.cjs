'use strict';

// A BARE DOMAIN IS NOT A CATEGORY.
//
// The search-quality gate used `existingCategoryPath` truthiness as proof a row had been
// categorised, and `beauty` is a namespace, not an answer to "what is this". The effect was that a
// row with a USELESS path was treated more confidently than a row with none: the per-category text
// rescue only ran when the path was ABSENT, so a bad path was strictly worse than no path.
//
// Measured on the live index for `beauty/fragrance/`: of 50 rows returned for "eau de parfum", 19
// are not on a fragrance path and 16 sit on bare `beauty` — the entire Ariana Grande line (Cloud,
// Ari, God Is A Woman, r.e.m.), Cosmic Kylie Jenner, every PixiPerfume. Six of eight sampled eau de
// parfums were rejected as `category_mismatch`, and the fragrance regex would have admitted all six.
// The live agent door declined a citrus EDT saying the candidates it was shown were "rose or
// amber/gourmand-leaning" — the small correctly-pathed subset.

process.env.AURORA_BFF_USE_MOCK = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// server.js is not requirable in a unit test (it boots a listener), so the predicate is lifted from
// source and evaluated. The extraction is asserted, so a rename or a deletion fails here rather than
// silently testing a stale copy.
function loadPredicate() {
  const at = SERVER_SRC.indexOf('function categoryPathIsCategorised(');
  assert.ok(at > 0, 'categoryPathIsCategorised must exist in server.js');
  const end = SERVER_SRC.indexOf('\n}', at) + 2;
  // eslint-disable-next-line no-new-func
  return new Function(`${SERVER_SRC.slice(at, end)}; return categoryPathIsCategorised;`)();
}

test('a bare domain is not a categorisation; a real path is', () => {
  const categorised = loadPredicate();
  for (const p of ['beauty', 'beauty/', '/beauty/', '', null, undefined, '   ']) {
    assert.equal(categorised(p), false, `${JSON.stringify(p)} must not count as categorised`);
  }
  for (const p of ['beauty/fragrance', 'beauty/fragrance/perfume', 'beauty/skincare/treat/serum', 'beauty/makeup/face/blush']) {
    assert.equal(categorised(p), true, `${p} must count as categorised`);
  }
});

test('the gate consults the predicate, not raw truthiness', () => {
  // The defect was one identifier. Pin the call site so restoring `if (existingCategoryPath)` fails
  // here — the behaviour it guards is otherwise only observable through a live search.
  const at = SERVER_SRC.indexOf("const existingCategoryPath = firstSearchProductCategoryPath");
  assert.ok(at > 0, 'the gate must still compute existingCategoryPath');
  const block = SERVER_SRC.slice(at, at + 2400);
  assert.match(block, /if \(categoryPathIsCategorised\(existingCategoryPath\)\) \{/,
    'the category_mismatch branch must test for a CATEGORISED path, not a truthy string');
  assert.doesNotMatch(block, /if \(existingCategoryPath\) \{\s*\n\s*if \(!pathMatches\)/,
    'the raw-truthiness branch must not come back');
});

test('the rows this unblocks, and the one it deliberately does not', () => {
  const categorised = loadPredicate();
  // Real titles and paths from the live index, verbatim.
  const stranded = [
    ['Cloud Eau de Parfum - 3.4 oz', 'beauty'],
    ['God Is A Woman Eau de Parfum - 0.33 oz', 'beauty'],
    ['Cosmic Kylie Jenner Eau de Parfum', 'beauty'],
    ['PixiPerfume Eau de Parfum - PixiMimosa', 'beauty'],
  ];
  for (const [title, p] of stranded) {
    assert.equal(categorised(p), false, `${title}: falls through to the text rescue`);
  }
  // A WRONG path is a data error, not a missing one. Flaura Eau De Parfum is stored under
  // beauty/makeup/face/blush and stays rejected: letting title text override a specific category
  // claim would make the stored category advisory everywhere. It belongs to the backfill.
  assert.equal(categorised('beauty/makeup/face/blush'), true,
    'a wrong-but-specific path is still a categorisation, and this gate does not second-guess it');
});

// ---------------------------------------------------------------------------------------------
// `canonical_catalog` IS A PROVENANCE VALUE WEARING A TAXONOMY FIELD.
//
// It names where a row came from, not what the product is, and it is invented at serve time —
// nothing stores it. It is not inert: `resolveBeautyCoarseStepFamily` reads `product_type` FIRST
// when resolving a candidate's step, so a correctly-categorised perfume arrived at ranking with no
// step at all. On the live index 30 of 50 rows returned for "eau de parfum" carry the placeholder
// and exactly ONE says `fragrance`.

test('the canonical builder does not invent a product_type', () => {
  const at = SERVER_SRC.indexOf('function buildCanonicalChainSearchProduct');
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
  // the row it describes is exactly the cohort the predicate above routes to the text rescue.
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
