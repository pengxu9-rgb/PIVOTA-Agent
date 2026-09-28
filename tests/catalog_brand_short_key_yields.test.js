'use strict';

// GATEWAY_CATALOG_SHORT_KEY_YIELDS (default OFF). With GATEWAY_CATALOG_BRAND_ALLOWLIST on, a
// short onboarded key (OPI) is visible to matchCatalogBeautyBrand, whose same-length spans
// are scanned left to right -- so "opi" (token 0) ended the search before "olaplex" (token 1)
// was looked at. Live 2026-09-26 (gateway-00163-ncx): "opi olaplex" served 6 OPI rows. With
// this flag a short key is held back and answers only when no regular brand in the query does.

const mockQuery = jest.fn();
jest.mock('../src/db', () => ({ query: (...a) => mockQuery(...a) }));

const cache = require('../src/findProductsMulti/brandDictionaryCache');
const { resolveBeautyBrandBrowseQuery } = require('../src/findProductsMulti/brandLexicon');

const FLAGS = {
  GATEWAY_DYNAMIC_BRAND_DETECT: '1',
  GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT: '1',
  GATEWAY_CATALOG_BRAND_LONG_TAIL: '1',
  GATEWAY_CATALOG_BRAND_ALLOWLIST: '1',
  GATEWAY_CATALOG_BRAND_STRIPPED_CATEGORY: '1',
  GATEWAY_CATALOG_SHORT_KEY_YIELDS: '1',
};

const ROWS = [
  // prod 2026-09-26: 11 beauty rows, 5 at a beauty leaf; onboarded, 3-letter key
  { b: 'opi', n: 11, nb: 11, nc: 11, nl: 5 },
  { b: 'olaplex', n: 44, nb: 44, nc: 44, nl: 44 },
  { b: 'round lab', n: 161, nb: 148, nc: 161, nl: 148 },
  // a regular catalog brand that is NOT beauty
  { b: 'acme hardware', n: 40, nb: 0, nc: 40, nl: 0 },
  // a non-beauty brand whose shorter span IS a beauty brand
  { b: 'olaplex tools', n: 30, nb: 0, nc: 30, nl: 0 },
  // another short onboarded key (the static lexicon also lists NYX, so the catalog matcher is
  // exercised directly below)
  { b: 'nyx', n: 20, nb: 20, nc: 20, nl: 20 },
  // prod 2026-09-26: a 3-row brand that is also an ordinary word (brandLexicon's
  // AMBIGUOUS_SINGLE_WORD_CATALOG_BRANDS) -- and "Bubble Bath" is an OPI shade
  { b: 'bubble', n: 3, nb: 3, nc: 3, nl: 3 },
  // an ordinary-word brand that is NOT beauty
  { b: 'hersteller', n: 12, nb: 0, nc: 12, nl: 0 },
  // a non-beauty brand that CONTAINS the short key
  { b: 'opi tools', n: 25, nb: 0, nc: 25, nl: 0 },
];

const saved = {};
function setFlags(overrides = {}) {
  for (const [k, v] of Object.entries({ ...FLAGS, ...overrides })) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}
beforeEach(() => {
  for (const k of Object.keys(FLAGS)) saved[k] = process.env[k];
  cache.__setBrandSetForTest(ROWS.map((r) => r.b));
  cache.__setBeautyBrandRowsForTest(ROWS);
  setFlags();
});
afterEach(() => {
  for (const k of Object.keys(FLAGS)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  cache.__setBrandSetForTest([]);
});

const brandKey = (q) => {
  const r = resolveBeautyBrandBrowseQuery(q);
  return r.matched ? r.brand_key : null;
};

describe('flag ON: a short onboarded key yields to a regular brand anywhere in the query', () => {
  test.each([
    ['opi olaplex', 'catalog:olaplex'],
    ['olaplex opi', 'catalog:olaplex'],
    ['opi round lab toner', 'catalog:round lab'],
    ['OPI', 'catalog:opi'],
    ['OPI nail polish', 'catalog:opi'],
  ])('%s -> %s', (q, expected) => {
    expect(brandKey(q)).toBe(expected);
  });

  test('an ordinary-word brand never outranks the short key ("opi bubble bath" is an OPI shade)', () => {
    expect(brandKey('opi bubble bath')).toBe('catalog:opi');
    expect(brandKey('bubble bath opi')).toBe('catalog:opi');
  });

  test('with no short key, an ordinary-word brand behaves exactly as before', () => {
    expect(brandKey('bubble')).toBe('catalog:bubble'); // brand-only still resolves
    expect(brandKey('bubble bath')).toBeNull(); // refused as ambiguous, as on main
    expect(brandKey('bubble olaplex')).toBeNull(); // it still ends the search for regular brands
    expect(brandKey('hersteller')).toBeNull(); // not beauty: refused, never held back as a fallback
  });

  test('a non-beauty regular brand does not hide the short key, in either order', () => {
    expect(brandKey('opi acme hardware')).toBe('catalog:opi');
    expect(brandKey('acme hardware opi')).toBe('catalog:opi');
  });

  test('a non-beauty regular brand still refuses the query when no short key is present', () => {
    expect(brandKey('acme hardware')).toBeNull();
    expect(brandKey('olaplex tools')).toBeNull();
  });

  test('the longest brand still wins: a refused non-beauty brand never falls back to its own sub-span', () => {
    // "olaplex tools" is the brand; "olaplex" inside it must not answer. OPI, elsewhere, may.
    expect(brandKey('olaplex tools opi')).toBe('catalog:opi');
  });

  test('a short key INSIDE the refused brand is part of it, not a fallback (review of #2281)', () => {
    expect(brandKey('opi tools')).toBeNull();
    expect(brandKey('opi tools kit')).toBeNull();
  });

  test('brand_only and alias follow the brand that answers', () => {
    const r = (q) => resolveBeautyBrandBrowseQuery(q);
    expect(r('opi olaplex')).toEqual(expect.objectContaining({ brand_key: 'catalog:olaplex', brand_only: false }));
    expect(r('bubble opi')).toEqual(expect.objectContaining({ brand_key: 'catalog:opi', alias: 'opi', brand_only: false }));
    expect(r('OPI')).toEqual(expect.objectContaining({ brand_key: 'catalog:opi', brand_only: true }));
  });
});

describe('flag ON: the deferred short key is the first QUALIFYING one', () => {
  const catalogKey = (q) => {
    const hit = cache.matchCatalogBeautyBrand(q);
    return hit ? hit.brand : null;
  };

  test('of two short keys, the first in scan order answers', () => {
    expect(catalogKey('opi nyx')).toBe('opi');
    expect(catalogKey('nyx opi')).toBe('nyx');
  });

  test('a short key that does not qualify is never deferred', () => {
    // no row at a beauty leaf: the allowlist refuses OPI, so nothing answers
    cache.__setBeautyBrandRowsForTest([{ b: 'opi', n: 11, nb: 11, nc: 11, nl: 0 }]);
    expect(catalogKey('opi')).toBeNull();
  });
});

describe('flag OFF: byte-identical to #2274 (pinned, including the live defect)', () => {
  beforeEach(() => setFlags({ GATEWAY_CATALOG_SHORT_KEY_YIELDS: null }));

  test.each([
    ['opi olaplex', 'catalog:opi'], // the live defect this flag fixes
    ['olaplex opi', 'catalog:olaplex'],
    ['OPI', 'catalog:opi'],
    ['OPI nail polish', 'catalog:opi'],
    ['opi acme hardware', null], // the longer non-beauty span refuses first
    ['acme hardware opi', null],
    ['acme hardware', null],
    ['olaplex tools opi', null],
    ['bubble bath', null],
    ['bubble olaplex', null],
    ['bubble', 'catalog:bubble'],
    ['opi tools', null],
  ])('%s -> %s', (q, expected) => {
    expect(brandKey(q)).toBe(expected);
  });
});

describe('the allowlist still gates short keys completely', () => {
  test.each([null, '1'])('allowlist off, yields=%s: OPI is invisible and Olaplex answers', (yields) => {
    setFlags({ GATEWAY_CATALOG_BRAND_ALLOWLIST: null, GATEWAY_CATALOG_SHORT_KEY_YIELDS: yields });
    expect(brandKey('OPI')).toBeNull();
    expect(brandKey('opi olaplex')).toBe('catalog:olaplex');
  });
});
