/**
 * Canonical taxonomy contract (Class 3).
 *
 * The load-bearing property is NOT "every leaf word maps somewhere" — it is
 * that the alias table only ever merges paths that name the same category,
 * and that mapping is idempotent (a reconciler built on it converges).
 */

'use strict';

const {
  CANONICAL_CATEGORY_PATHS,
  CATEGORY_PATH_ALIASES,
  INTENTIONALLY_DISTINCT,
  toCanonicalCategoryPath,
  isCanonicalCategoryPath,
  normalizeCategoryPathText,
} = require('../../src/services/beautyTaxonomy');

describe('toCanonicalCategoryPath', () => {
  test('maps known variants onto their canonical home', () => {
    expect(toCanonicalCategoryPath('beauty/skincare/serum')).toBe('beauty/skincare/treat/serum');
    expect(toCanonicalCategoryPath('beauty/skincare/toner')).toBe('beauty/skincare/tone/toner');
    expect(toCanonicalCategoryPath('beauty/skincare/treat/toner')).toBe('beauty/skincare/tone/toner');
    expect(toCanonicalCategoryPath('beauty/hair/shampoo')).toBe('beauty/haircare/shampoo');
    expect(toCanonicalCategoryPath('beauty/makeup/cheek/bronzer')).toBe('beauty/makeup/face/bronzer');
  });

  test('passes through unknown paths unchanged — never guesses', () => {
    expect(toCanonicalCategoryPath('beauty/wellness/supplements')).toBe('beauty/wellness/supplements');
    expect(toCanonicalCategoryPath('fashion/apparel/pet')).toBe('fashion/apparel/pet');
  });

  test('normalizes case, stray slashes and array input', () => {
    expect(toCanonicalCategoryPath('/Beauty/Skincare/Serum/')).toBe('beauty/skincare/treat/serum');
    expect(toCanonicalCategoryPath(['beauty', 'skincare', 'serum'])).toBe('beauty/skincare/treat/serum');
    expect(toCanonicalCategoryPath('')).toBe('');
    expect(toCanonicalCategoryPath(null)).toBe('');
  });
});

describe('table integrity', () => {
  test('IDEMPOTENT: every alias target is itself canonical (reconciler converges)', () => {
    // If any target were also an alias key, the reconciler would oscillate or
    // need multiple passes to settle.
    for (const [from, to] of Object.entries(CATEGORY_PATH_ALIASES)) {
      expect(toCanonicalCategoryPath(to)).toBe(to);
      expect(from).not.toBe(to);
    }
  });

  test('every alias target is a declared canonical path', () => {
    const canonical = new Set(Object.values(CANONICAL_CATEGORY_PATHS));
    for (const to of Object.values(CATEGORY_PATH_ALIASES)) {
      expect(canonical.has(to)).toBe(true);
    }
  });

  test('paths that legitimately share a leaf word are NEVER merged', () => {
    // The destructive failure mode for this class: lip oil, face oil and body
    // oil all end in "oil" but are different products. A leaf-word rule would
    // collapse them; the curated table must not.
    for (const path of INTENTIONALLY_DISTINCT) {
      expect(toCanonicalCategoryPath(path)).toBe(path);
      expect(isCanonicalCategoryPath(path)).toBe(true);
    }
  });

  test('no canonical path is also an alias key', () => {
    for (const path of Object.values(CANONICAL_CATEGORY_PATHS)) {
      expect(Object.prototype.hasOwnProperty.call(CATEGORY_PATH_ALIASES, path)).toBe(false);
    }
  });

  test('normalizeCategoryPathText is stable under repetition', () => {
    const once = normalizeCategoryPathText('/Beauty//Skincare/Serum/');
    expect(normalizeCategoryPathText(once)).toBe(once);
    expect(once).toBe('beauty/skincare/serum');
  });
});
