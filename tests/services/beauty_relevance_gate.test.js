/**
 * Unit tests for the shared beauty relevance gate (Class 2 consolidation).
 *
 * These pin the module's own contract. The server.js delegates are exercised
 * by the existing lane suites (find_products_multi_*, integration/*) — if a
 * delegate drifts from the module, those break; if the vocabulary drifts,
 * these break. One home, two layers of pins.
 */

'use strict';

const gate = require('../../src/services/beautyRelevanceGate');

describe('normalizeSearchTextForMatch', () => {
  test('lowercases, strips punctuation, preserves CJK, collapses whitespace', () => {
    expect(gate.normalizeSearchTextForMatch('Vitamin-C 精华 Serum!')).toBe('vitamin c 精华 serum');
    expect(gate.normalizeSearchTextForMatch('  a   b  ')).toBe('a b');
    expect(gate.normalizeSearchTextForMatch(null)).toBe('');
  });
});

describe('extractSkincareFormIntents', () => {
  test('recognizes exactly the four form words', () => {
    expect(gate.extractSkincareFormIntents('niacinamide serum')).toEqual(['serum']);
    expect(gate.extractSkincareFormIntents('gentle cleanser and toner')).toEqual(['cleanser', 'toner']);
  });
  test('bare ingredient queries yield NO form intent — this is why the category floor exists', () => {
    expect(gate.extractSkincareFormIntents('niacinamide')).toEqual([]);
    expect(gate.extractSkincareFormIntents('salicylic acid')).toEqual([]);
  });
});

describe('productMatchesSkincareFormIntent', () => {
  test('serum family matches serum/essence/ampoule forms and CJK', () => {
    expect(gate.productMatchesSkincareFormIntent({ title: 'Intense Biome Ampoule' }, 'serum')).toBe(true);
    expect(gate.productMatchesSkincareFormIntent({ title: '烟酰胺精华' }, 'serum')).toBe(true);
    expect(gate.productMatchesSkincareFormIntent({ title: 'Niacinamide Body Wash' }, 'serum')).toBe(false);
  });
  test('empty intent passes everything; empty product text fails', () => {
    expect(gate.productMatchesSkincareFormIntent({ title: 'anything' }, '')).toBe(true);
    expect(gate.productMatchesSkincareFormIntent({}, 'serum')).toBe(false);
  });
});

describe('filterProductsBySkincareFormIntents', () => {
  test('no intents -> not applied, list untouched', () => {
    const products = [{ title: 'A' }, { title: 'B' }];
    const out = gate.filterProductsBySkincareFormIntents(products, []);
    expect(out.applied).toBe(false);
    expect(out.products).toHaveLength(2);
    expect(out.filtered_out_count).toBe(0);
  });
  test('intents filter and count', () => {
    const out = gate.filterProductsBySkincareFormIntents(
      [{ title: 'Niacinamide Serum' }, { title: 'Niacinamide Body Wash' }],
      ['serum'],
    );
    expect(out.applied).toBe(true);
    expect(out.products.map((p) => p.title)).toEqual(['Niacinamide Serum']);
    expect(out.filtered_out_count).toBe(1);
  });
});

describe('category path helpers', () => {
  test('productMatchesCategoryPathPrefix: exact and descendant match, fail-closed on missing path', () => {
    const p = { category_path: 'beauty/skincare/serum' };
    expect(gate.productMatchesCategoryPathPrefix(p, 'beauty/skincare')).toBe(true);
    expect(gate.productMatchesCategoryPathPrefix(p, 'beauty/skincare/serum')).toBe(true);
    expect(gate.productMatchesCategoryPathPrefix(p, 'beauty/makeup')).toBe(false);
    expect(gate.productMatchesCategoryPathPrefix({}, 'beauty/skincare')).toBe(false);
    expect(gate.productMatchesCategoryPathPrefix(p, '')).toBe(false);
  });
  test('array-shaped category_path joins on /', () => {
    expect(
      gate.productMatchesCategoryPathPrefix({ category_path: ['beauty', 'skincare', 'serum'] }, 'beauty/skincare'),
    ).toBe(true);
  });
  test('categoryPathParentScope: parent of a multi-segment prefix; identity for single segment; empty for none', () => {
    // The floor semantics from PR #1889: treat/ scoped up to skincare so the
    // competing taxonomies (treat/serum, flat serum, bare skincare) all pass.
    expect(gate.categoryPathParentScope('beauty/skincare/treat/')).toBe('beauty/skincare');
    expect(gate.categoryPathParentScope('beauty')).toBe('beauty');
    expect(gate.categoryPathParentScope('')).toBe('');
    expect(gate.categoryPathParentScope(null)).toBe('');
  });
});

describe('titleMatchesForm (shared measurement vocabulary)', () => {
  test('recognizes synonyms that naive substring scoring misses', () => {
    // These four are the exact cases that made substring scoring report
    // toner precision as 3/10 when the true value was 9/10.
    expect(gate.titleMatchesForm('Pixi Glow Tonic', 'toner')).toBe(true);
    expect(gate.titleMatchesForm('Revitalising Cleansing Gel', 'cleanser')).toBe(true);
    expect(gate.titleMatchesForm('Shade and Illuminate Contour Duo', 'bronzer')).toBe(true);
    expect(gate.titleMatchesForm('Niacinamide 10% Ampoule', 'serum')).toBe(true);
  });

  test('still rejects the wrong form — synonym-aware, not permissive', () => {
    expect(gate.titleMatchesForm('Niacinamide Smoothing Body Wash', 'serum')).toBe(false);
    expect(gate.titleMatchesForm('Volumizing Mascara', 'toner')).toBe(false);
    expect(gate.titleMatchesForm('', 'serum')).toBe(false);
    expect(gate.titleMatchesForm('Some Serum', '')).toBe(false);
  });

  test('unknown form falls back to substring rather than matching everything', () => {
    expect(gate.titleMatchesForm('Mystery Widget', 'widget')).toBe(true);
    expect(gate.titleMatchesForm('Mystery Widget', 'gadget')).toBe(false);
  });

  test('serving-side form filter keeps its historical vocabulary (no leak)', () => {
    // The wider measurement vocabulary must not change recall: the strict
    // filter handles only the four skincare forms it always did. "bronzer" is
    // measurement-only, so as a serving intent it falls through to substring.
    expect(gate.productMatchesSkincareFormIntent({ title: 'Intense Biome Ampoule' }, 'serum')).toBe(true);
    expect(gate.productMatchesSkincareFormIntent({ title: 'Shade and Illuminate Contour Duo' }, 'bronzer')).toBe(false);
  });
});
