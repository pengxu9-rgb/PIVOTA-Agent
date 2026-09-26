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

  // --- separator-spelt brands and short brands (measured live 2026-09-11) ------
  // `search_catalog "A'PIEU"` reported brand_query_detected:false / brand_entities:[]
  // while returning 15 A'pieu products, and `3CE` never entered the dictionary at all.

  // Helper: index raw catalog brand strings exactly as refresh() would, so a test
  // cannot pass by seeding a key the loader would never produce.
  function loadAsRefreshWould(rawBrands) {
    const keys = [];
    for (const raw of rawBrands) {
      for (const alias of cache.brandAliases(raw)) {
        if (cache.admissibleKey(alias)) keys.push(alias);
      }
    }
    cache.__setBrandSetForTest(keys);
    return keys;
  }

  test("an apostrophe-spelt brand matches however the QUERY spells it", () => {
    process.env[FLAG] = '1';
    loadAsRefreshWould(["A'PIEU"]);
    // `normalize` turns the apostrophe into a space, so the query arrives as two
    // tokens; the dictionary must answer to both spellings.
    expect(cache.matchCatalogBrand('a pieu')).toBe('a pieu');
    expect(cache.matchCatalogBrand('apieu')).toBe('apieu');
    expect(cache.matchCatalogBrand('a pieu honey milk lip oil')).toBe('a pieu');
    expect(cache.matchCatalogBrand('apieu lip oil')).toBe('apieu');
  });

  test('the same holds for a brand catalogued WITHOUT the apostrophe', () => {
    process.env[FLAG] = '1';
    loadAsRefreshWould(['APIEU']);
    expect(cache.matchCatalogBrand('apieu')).toBe('apieu');
    // The user typed A'PIEU; normalize split it. The squash must still find it.
    expect(cache.matchCatalogBrand('a pieu')).toBe('apieu');
  });

  test("possessive brands work the same way (kiehl's)", () => {
    process.env[FLAG] = '1';
    loadAsRefreshWould(["Kiehl's"]);
    expect(cache.matchCatalogBrand('kiehl s')).toBe('kiehl s');
    expect(cache.matchCatalogBrand('kiehls')).toBe('kiehls');
  });

  test('a short brand carrying a digit is indexed and matches', () => {
    process.env[FLAG] = '1';
    const keys = loadAsRefreshWould(['3CE']);
    expect(keys).toContain('3ce'); // it must reach the SET, not just the matcher
    expect(cache.matchCatalogBrand('3ce')).toBe('3ce');
    expect(cache.matchCatalogBrand('3ce lip tint')).toBe('3ce');
  });

  test('a short ALL-ALPHABETIC brand stays out — noise is not distinguishable', () => {
    process.env[FLAG] = '1';
    const keys = loadAsRefreshWould(['VDL', 'NYX']);
    expect(keys).toEqual([]);
    expect(cache.matchCatalogBrand('vdl')).toBeNull();
  });

  test('admissibleKey is the SAME rule for the loader and the matcher', () => {
    // A key admitted by one and rejected by the other can never match — the state
    // `3ce` was in when refresh() and matchCatalogBrand() each spelt the floor inline.
    process.env[FLAG] = '1';
    for (const k of ['3ce', 'apieu', 'etude house', 'vdl', 'th', 'the', '']) {
      const admitted = cache.admissibleKey(k);
      cache.__setBrandSetForTest([k]);
      const matched = cache.matchCatalogBrand(k) !== null;
      expect(matched).toBe(admitted && Boolean(k));
    }
  });

  test('stopwords and generic queries still never match', () => {
    process.env[FLAG] = '1';
    loadAsRefreshWould(["A'PIEU", '3CE', 'ETUDE HOUSE']);
    for (const q of ['the', 'beauty', 'serum', 'vitamin c serum', 'lip oil']) {
      expect(cache.matchCatalogBrand(q)).toBeNull();
    }
  });

  test('a catalog brand that IS a stopword is refused ADMISSION, not just unmatched', () => {
    // The previous test cannot fail while the stopword guard is deleted: those words
    // are absent from the set anyway. The guard only bites when the catalog really
    // publishes `brand: "Beauty"` — then it must never become a brand key, or every
    // "beauty gift set" query turns into a brand-scoped one.
    process.env[FLAG] = '1';
    expect(cache.admissibleKey('beauty')).toBe(false);
    expect(cache.admissibleKey('fragrance')).toBe(false);
    const keys = loadAsRefreshWould(['Beauty', 'Fragrance', 'Skincare']);
    expect(keys).toEqual([]);
    // And force the set to hold them anyway: the matcher must still refuse.
    cache.__setBrandSetForTest(['beauty', 'fragrance']);
    expect(cache.matchCatalogBrand('beauty')).toBeNull();
    expect(cache.matchCatalogBrand('best beauty gift')).toBeNull();
  });

  test('the squash never invents a match across unrelated tokens', () => {
    process.env[FLAG] = '1';
    cache.__setBrandSetForTest(['lipoil']);
    // "lip oil" squashes to "lipoil". That IS the documented behaviour of the
    // squash, so pin it: a catalog brand literally named "LipOil" is matched by
    // the two-word query. What must NOT happen is a match with no such brand.
    expect(cache.matchCatalogBrand('lip oil')).toBe('lipoil');
    cache.__setBrandSetForTest(['apieu']);
    expect(cache.matchCatalogBrand('lip oil')).toBeNull();
  });

});
