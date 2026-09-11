'use strict';

// Covers the catalog brand-dictionary cache + its read-only debugState() used
// by the /internal/diag/brand-dict diagnostic. The cache reads
// GATEWAY_DYNAMIC_BRAND_DETECT via process.env at call time, so each test sets
// it explicitly and restores afterward.

const cache = require('../src/findProductsMulti/brandDictionaryCache');

const FLAG = 'GATEWAY_DYNAMIC_BRAND_DETECT';
let prevFlag;

beforeEach(() => {
  prevFlag = process.env[FLAG];
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prevFlag;
  cache.__setBrandSetForTest([]);
});

describe('brandDictionaryCache', () => {
  test('enabled() accepts 1/true/yes/on (case-insensitive) and rejects others', () => {
    for (const v of ['1', 'true', 'TRUE', 'Yes', 'on', ' on ']) {
      process.env[FLAG] = v;
      expect(cache.enabled()).toBe(true);
    }
    for (const v of ['0', 'false', 'enabled', 'y', '"1"', '']) {
      process.env[FLAG] = v;
      expect(cache.enabled()).toBe(false);
    }
  });

  test('matchCatalogBrand returns null when flag is off (even with a populated set)', () => {
    process.env[FLAG] = '0';
    cache.__setBrandSetForTest(['skin1004']);
    expect(cache.matchCatalogBrand('skin1004')).toBeNull();
  });

  test('matchCatalogBrand finds a brand span within a longer query when enabled', () => {
    process.env[FLAG] = '1';
    cache.__setBrandSetForTest(['skin1004', 'beauty of joseon']);
    expect(cache.matchCatalogBrand('skin1004')).toBe('skin1004');
    expect(cache.matchCatalogBrand('best skin1004 toner')).toBe('skin1004');
    expect(cache.matchCatalogBrand('beauty of joseon serum')).toBe('beauty of joseon');
  });

  test('matchCatalogBrand does not false-positive on generic queries', () => {
    process.env[FLAG] = '1';
    cache.__setBrandSetForTest(['skin1004']);
    expect(cache.matchCatalogBrand('vitamin c serum')).toBeNull();
  });

  test('brandAliases indexes the leading segment of a piped brand + tagline', () => {
    // "Biodance | Better Formula for Better Glow" must yield a matchable
    // "biodance" alias (the incident: a bare brand query missed the full span).
    expect(cache.brandAliases('Biodance | Better Formula for Better Glow')).toEqual([
      'biodance better formula for better glow',
      'biodance',
    ]);
    // The tagline segment is NOT indexed on its own (no false brand hits).
    expect(cache.brandAliases('Biodance | Better Formula for Better Glow')).not.toContain(
      'better formula for better glow',
    );
    // Clean single-segment brands yield exactly one alias (no dup).
    expect(cache.brandAliases('ACROPASS')).toEqual(['acropass']);
    // Newline separator handled too.
    expect(cache.brandAliases('Rovectin\nSkin Essentials')).toContain('rovectin');
  });

  test('a piped brand is detectable by its leading token once loaded', () => {
    process.env[FLAG] = '1';
    // Mirror what refresh() builds from the raw brand row.
    cache.__setBrandSetForTest(cache.brandAliases('Biodance | Better Formula for Better Glow'));
    expect(cache.matchCatalogBrand('biodance')).toBe('biodance');
    expect(cache.matchCatalogBrand('biodance collagen mask')).toBe('biodance');
  });

  test('debugState exposes counts + config, never the brand list', () => {
    process.env[FLAG] = '1';
    cache.__setBrandSetForTest(['skin1004', 'anuko']);
    const s = cache.debugState();
    expect(s.enabled).toBe(true);
    expect(s.flag_raw_present).toBe(true);
    expect(s.cache_size).toBe(2);
    expect(typeof s.ttl_ms).toBe('number');
    expect(typeof s.min_len).toBe('number');
    // must not leak the actual brand strings
    expect(JSON.stringify(s)).not.toMatch(/skin1004|anuko/);
  });
});
