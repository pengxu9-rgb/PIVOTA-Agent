'use strict';

// Drives the REAL loader. The sibling suite seeds the cache directly, which
// cannot observe `refresh()` dropping (or failing to drop) an inadmissible key —
// a test that re-implements the admission rule passes while the loader skips it.
// Here the only thing under test is what refresh() puts in the set.

const mockQuery = jest.fn();
jest.mock('../src/db', () => ({ query: (...a) => mockQuery(...a) }));

const cache = require('../src/findProductsMulti/brandDictionaryCache');

const FLAG = 'GATEWAY_DYNAMIC_BRAND_DETECT';
let prevFlag;

beforeEach(() => {
  prevFlag = process.env[FLAG];
  process.env[FLAG] = '1';
  mockQuery.mockReset();
  cache.__setBrandSetForTest([]);
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prevFlag;
  cache.__setBrandSetForTest([]);
});

function rowsFor(brands) {
  mockQuery.mockResolvedValue({ rows: brands.map((b, i) => ({ b, n: 100 - i })) });
}

describe('brandDictionaryCache.refresh (the real loader)', () => {
  test('indexes both spellings of a separator-spelt brand', async () => {
    rowsFor(["A'PIEU", 'ETUDE HOUSE']);
    await cache.refresh();
    const set = cache.getBrandSet();
    expect(set.has('a pieu')).toBe(true);
    expect(set.has('apieu')).toBe(true);
    expect(set.has('etude house')).toBe(true);
    expect(set.has('etudehouse')).toBe(true);
    // and the whole point: the query spelling that used to miss now resolves
    expect(cache.matchCatalogBrand('apieu')).toBe('apieu');
    expect(cache.matchCatalogBrand('a pieu')).toBe('a pieu');
  });

  test('a short brand with a digit survives the loader; an alphabetic one does not', async () => {
    rowsFor(['3CE', 'VDL']);
    await cache.refresh();
    expect(cache.getBrandSet().has('3ce')).toBe(true);
    expect(cache.getBrandSet().has('vdl')).toBe(false);
    expect(cache.matchCatalogBrand('3ce lip tint')).toBe('3ce');
  });

  test('the LOADER refuses a stopword brand — not merely the matcher', async () => {
    rowsFor(['Beauty', 'Fragrance', 'Skincare', 'Missha']);
    await cache.refresh();
    const set = cache.getBrandSet();
    expect(set.has('beauty')).toBe(false);
    expect(set.has('fragrance')).toBe(false);
    expect(set.has('missha')).toBe(true);
    expect(set.size).toBe(1);
  });

  // A polluted brand field, brand + tagline in one string (#1771). The SQL lowercases it; the
  // loader must still find the brand in front of the separator.
  test('a piped brand + tagline is detectable by the brand alone', async () => {
    rowsFor(['biodance | better formula for better glow']);
    await cache.refresh();
    const set = cache.getBrandSet();
    expect(set.has('biodance')).toBe(true);
    expect(cache.matchCatalogBrand('biodance')).toBe('biodance');
    expect(cache.matchCatalogBrand('biodance collagen mask')).toBe('biodance');
    // Only the FIRST segment is a brand: the tagline alone is never a key, so a query made of
    // marketing words cannot be scoped to this brand.
    expect(set.has('better formula for better glow')).toBe(false);
    expect(cache.matchCatalogBrand('better glow serum')).toBeNull();
  });

  test('a newline separates a tagline the same way', async () => {
    rowsFor(['rovectin\nskin essentials']);
    await cache.refresh();
    expect(cache.matchCatalogBrand('rovectin cream')).toBe('rovectin');
    expect(cache.getBrandSet().has('skin essentials')).toBe(false);
  });

  test('the leading segment gets the separator squash too, and still passes admission', async () => {
    rowsFor(["a'pieu | pure block", 'spf | sun care']);
    await cache.refresh();
    const set = cache.getBrandSet();
    expect(set.has('a pieu')).toBe(true);
    expect(set.has('apieu')).toBe(true);
    // A stopword in front of the pipe is refused like any stopword brand.
    expect(set.has('spf')).toBe(false);
  });

  test('a brand with no tagline separator loads exactly as before', async () => {
    rowsFor(["A'PIEU", 'ETUDE HOUSE', 'Missha']);
    await cache.refresh();
    expect([...cache.getBrandSet()].sort()).toEqual(
      ['a pieu', 'apieu', 'etude house', 'etudehouse', 'missha'].sort());
  });

  test('a db failure keeps the prior cache rather than emptying it', async () => {
    rowsFor(['Missha']);
    await cache.refresh();
    expect(cache.getBrandSet().has('missha')).toBe(true);
    mockQuery.mockRejectedValue(new Error('connection reset'));
    await cache.refresh();
    expect(cache.getBrandSet().has('missha')).toBe(true);
  });
});
