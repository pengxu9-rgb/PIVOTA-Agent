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
