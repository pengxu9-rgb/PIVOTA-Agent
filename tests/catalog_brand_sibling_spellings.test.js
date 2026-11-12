'use strict';

// One brand, two catalog spellings: a retailer writes the bare name ("Zentora"), the brand's
// own store writes the name plus a market word ("Zentora USA"). Each spelling is its own
// dictionary key and a brand constraint is an equality on ONE key, so "zentora sunscreen" was
// scoped to the retailer's rows and the store's product was never recalled.
// GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS (default OFF) binds the matched key AND the keys that
// are equal to it once a trailing market / channel word is removed. This suite pins:
//   * the resolver: both directions, never a prefix, the suffix subset, the ambiguous lists,
//     static-lexicon brands, unqualified keys, a cold dictionary, the family cap;
//   * the SQL both recall lanes bind, flag off (what main binds) and on;
//   * the metadata count.
// Every brand name here is a placeholder.

const mockQuery = jest.fn();
jest.mock('../src/db', () => ({ query: (...a) => mockQuery(...a) }));
const mockWarn = jest.fn();
jest.mock('../src/logger', () => ({ warn: (...a) => mockWarn(...a), info: () => {}, error: () => {}, debug: () => {} }));

const cache = require('../src/findProductsMulti/brandDictionaryCache');
const {
  resolveBeautyBrandBrowseQuery,
  resolveBoundBrandSiblingSpellings,
  REVIEWED_NOT_SIBLING_SPELLINGS,
} = require('../src/findProductsMulti/brandLexicon');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const {
  buildBrandIdentityPredicate,
  brandIdentityBindKeys,
  buildCanonicalSearchQualitySql,
  CANONICAL_OWN_BRAND_SQL,
} = require('../src/services/canonicalSearchQualitySql');
const { buildSeedSearchOfferScope, SEED_OWN_BRAND_SQL } = require('../src/services/seedSearchOfferScope');

// A static-lexicon brand, taken from the reviewed roster rather than named here: the first one
// whose leading alias resolves, alone, as a static beauty brand.
const reviewedAliases = require('../data/beauty/meitu_brand_aliases.json');
const [STATIC_KEY, STATIC_ALIASES] = Object.entries(reviewedAliases).find(([key, aliases]) => {
  const hit = resolveBeautyBrandBrowseQuery(aliases[0]);
  return hit.detection_mode === 'static_beauty' && hit.brand_key === key && /^[a-z]+( [a-z]+)*$/.test(aliases[0]);
});
const STATIC_NAME = STATIC_ALIASES[0];

const DETECT = 'GATEWAY_DYNAMIC_BRAND_DETECT';
const CONTRACT = 'GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT';
const SIBLINGS = 'GATEWAY_CATALOG_BRAND_SIBLING_SPELLINGS';
const FLAGS = [DETECT, CONTRACT, SIBLINGS, 'GATEWAY_CATALOG_BRAND_LONG_TAIL', 'GATEWAY_CATALOG_BRAND_ALLOWLIST'];

const beauty = (b, n) => ({ b, n, nb: n, nc: n, nl: n });
// (b, n, nb, nc, nl) as the loader reads them.
const ROWS = [
  beauty('zentora', 5), // the bare spelling: another retailer's rows
  beauty('zentora usa', 189), // the brand's own store
  beauty('zentora labs', 12), // a DIFFERENT brand sharing the first word: "labs" is not a suffix
  beauty('lumavelle', 40),
  beauty('lumavelle uk', 22),
  beauty('lumavelle official store', 9), // two suffix words in a row
  beauty('noble', 30),
  beauty('noble pegasus', 14), // a different brand; "pegasus" is not a suffix
  beauty('quillbright', 25), // one spelling only
  beauty('brisa', 20),
  beauty('brisa beauty', 18), // "beauty" is part of a brand name: NOT a sibling suffix
  beauty('lime', 11), // on the ambiguous stripped-name list
  beauty('lime uk', 15),
  beauty('whipped', 11), // on the ambiguous single-word list
  beauty('whipped usa', 15),
  beauty('orrin', 16),
  { b: 'orrin jp', n: 2, nb: 2, nc: 2, nl: 0 }, // in the dictionary, does not qualify (2 rows)
  { b: 'orrin store', n: 60, nb: 3, nc: 60, nl: 3 }, // in the dictionary, mostly not beauty
  beauty('hale-wyn', 8),
  beauty('halewyn usa', 8), // same family once spaces and hyphens are squashed
  beauty(`${STATIC_NAME} usa`, 10), // a catalog spelling the STATIC lexicon already names
];

const saved = {};
function setFlags(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
}
const catalog = (key) => ({ brand_key: `catalog:${key}`, canonical: key, alias: key });
const siblingsOf = (key) => resolveBoundBrandSiblingSpellings(catalog(key));

beforeEach(() => {
  for (const name of FLAGS) saved[name] = process.env[name];
  mockQuery.mockReset();
  mockWarn.mockReset();
  cache.__setBrandSetForTest(ROWS.map((row) => row.b));
  cache.__setBeautyBrandRowsForTest(ROWS);
  setFlags({ [DETECT]: '1', [CONTRACT]: '1', [SIBLINGS]: 'on', GATEWAY_CATALOG_BRAND_LONG_TAIL: null, GATEWAY_CATALOG_BRAND_ALLOWLIST: null });
});
afterEach(() => {
  for (const name of FLAGS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  cache.__setBrandSetForTest([]);
});

describe('the sibling resolver', () => {
  test('bare typed -> the suffixed family members', () => {
    expect(siblingsOf('zentora')).toEqual(['zentora usa']);
    expect(siblingsOf('lumavelle')).toEqual(['lumavelle official store', 'lumavelle uk']);
  });

  test('suffixed typed -> the bare key and the other suffixed members', () => {
    expect(siblingsOf('zentora usa')).toEqual(['zentora']);
    expect(siblingsOf('lumavelle uk')).toEqual(['lumavelle', 'lumavelle official store']);
    expect(siblingsOf('lumavelle official store')).toEqual(['lumavelle', 'lumavelle uk']);
  });

  test('never a prefix: a different brand sharing the first word is not a sibling, either way', () => {
    expect(siblingsOf('zentora')).not.toContain('zentora labs');
    expect(siblingsOf('zentora usa')).not.toContain('zentora labs');
    expect(siblingsOf('zentora labs')).toEqual([]);
    expect(siblingsOf('noble')).toEqual([]);
    expect(siblingsOf('noble pegasus')).toEqual([]);
  });

  test('a single-spelling brand has no sibling', () => {
    expect(siblingsOf('quillbright')).toEqual([]);
  });

  test('"beauty" and its kin are brand-name words, not sibling suffixes', () => {
    expect(siblingsOf('brisa')).toEqual([]);
    expect(siblingsOf('brisa beauty')).toEqual([]);
    expect([...cache.SIBLING_SPELLING_SUFFIXES].sort()).toEqual(
      ['global', 'jp', 'kr', 'official', 'store', 'uk', 'us', 'usa'],
    );
    for (const word of ['beauty', 'cosmetics', 'cosmetic', 'makeup', 'skincare']) {
      cache.__setBeautyBrandRowsForTest([beauty('brisa', 20), beauty(`brisa ${word}`, 18)]);
      expect(siblingsOf('brisa')).toEqual([]);
      expect(siblingsOf(`brisa ${word}`)).toEqual([]);
    }
  });

  test.each(['us', 'usa', 'uk', 'jp', 'kr', 'global', 'official', 'store'])(
    'the market / channel word "%s" makes a sibling, both ways',
    (word) => {
      cache.__setBeautyBrandRowsForTest([beauty('brisa', 20), beauty(`brisa ${word}`, 18)]);
      expect(siblingsOf('brisa')).toEqual([`brisa ${word}`]);
      expect(siblingsOf(`brisa ${word}`)).toEqual(['brisa']);
    },
  );

  test('a family name on either ambiguous list binds nothing', () => {
    expect(siblingsOf('lime')).toEqual([]);
    expect(siblingsOf('lime uk')).toEqual([]);
    expect(siblingsOf('whipped')).toEqual([]);
    expect(siblingsOf('whipped usa')).toEqual([]);
    // premise: nothing but the two lists stands between these families and a binding
    expect(cache.resolveBrandSiblingSpellings('lime').siblings).toEqual(['lime uk']);
    expect(cache.resolveBrandSiblingSpellings('whipped').siblings).toEqual(['whipped usa']);
  });

  // Review of the first version: "global", "global store" and "global us" bound together.
  test.each(['global', 'official', 'store'])('a name that is only the channel word "%s" is no family name', (word) => {
    const rows = [beauty(word, 30), beauty(`${word} store`, 20), beauty(`${word} us`, 15), beauty(`${word} official uk`, 12)];
    cache.__setBeautyBrandRowsForTest(rows);
    for (const row of rows) {
      // premise: each is a dictionary brand on its own
      expect(cache.matchCatalogBeautyBrand(row.b)).toEqual(expect.objectContaining({ brand: row.b }));
      expect(siblingsOf(row.b)).toEqual([]);
      expect(brandIdentityBindKeys(catalog(row.b))).toEqual([row.b.replace(/ /g, '')]);
    }
  });

  test('a channel word INSIDE a longer name does not disqualify it', () => {
    cache.__setBeautyBrandRowsForTest([beauty('global velora', 30), beauty('global velora uk', 20), beauty('velora store house', 9), beauty('velora store house us', 9)]);
    expect(siblingsOf('global velora')).toEqual(['global velora uk']);
    expect(siblingsOf('global velora uk')).toEqual(['global velora']);
    expect(siblingsOf('velora store house')).toEqual(['velora store house us']);
  });

  // The dictionary's own key rule (brandDictionaryCache.admissibleKey: 4 letters, or 3 with a
  // digit, and not a stop word), applied to the family name as the family is keyed (squashed).
  test.each([
    ['ma', false], ['k2', false], ['abc', false], ['ab c', false], ['ab-c', false], ['a-b', false], ['skin', false], ['the', false],
    ['k2x', true], ['abcd', true], ['ab cd', true], ['ab-cd', true], ['a1 b', true],
  ])('family name "%s": a family = %s', (name, isFamily) => {
    cache.__setBeautyBrandRowsForTest([beauty(`${name} us`, 20), beauty(`${name} store`, 15), beauty(`${name} jp`, 12)]);
    // premise: the suffixed spellings are dictionary brands either way
    expect(cache.matchCatalogBeautyBrand(`${name} us`)).toEqual(expect.objectContaining({ brand: `${name} us` }));
    expect(siblingsOf(`${name} us`)).toEqual(isFamily ? [`${name} jp`, `${name} store`] : []);
    expect(siblingsOf(`${name} store`)).toEqual(isFamily ? [`${name} jp`, `${name} us`] : []);
    expect(cache.admissibleKey(name.replace(/[ -]/g, ''))).toBe(isFamily);
  });

  // The dictionary keeps only a-z, 0-9, "&" and "-" of a raw brand, so a mixed-script brand keys
  // as its Latin part: a name that is not the brand's. Placeholder letters, no real brand.
  describe('a key must be written in full by some catalog spelling', () => {
    test('a mixed-script brand whose key is only its Latin part forms no family, either way', () => {
      cache.__setBeautyBrandRowsForTest([beauty('가나다 velmora', 30), beauty('velmora store', 20), beauty('velmora uk', 12)]);
      // premise: the dictionary does hold the folded key, and the Latin spellings are a family
      expect(cache.matchCatalogBeautyBrand('velmora')).toEqual(expect.objectContaining({ brand: 'velmora' }));
      expect(siblingsOf('velmora')).toEqual([]);
      expect(siblingsOf('velmora store')).toEqual(['velmora uk']);
      expect(siblingsOf('velmora uk')).toEqual(['velmora store']);
    });

    test('...and the review\'s case: "<other-script letters> global" beside Latin "global store"', () => {
      cache.__setBeautyBrandRowsForTest([beauty('가나다 global', 30), beauty('global store', 20), beauty('global us', 12)]);
      for (const key of ['global', 'global store', 'global us']) expect(siblingsOf(key)).toEqual([]);
    });

    test('a suffixed spelling that lost letters is not bound as a sibling', () => {
      cache.__setBeautyBrandRowsForTest([beauty('zentora', 30), beauty('zentora αβγ usa', 20), beauty('zentora uk', 12)]);
      expect(cache.matchCatalogBeautyBrand('zentora usa')).toEqual(expect.objectContaining({ brand: 'zentora usa' }));
      expect(siblingsOf('zentora')).toEqual(['zentora uk']);
      expect(siblingsOf('zentora usa')).toEqual([]);
    });

    test('one spelling that writes the key in full is enough: a mixed-script namesake does not take the family away', () => {
      cache.__setBeautyBrandRowsForTest([beauty('가나다 velmora', 30), beauty('velmora', 9), beauty('velmora store', 20)]);
      expect(siblingsOf('velmora')).toEqual(['velmora store']);
      expect(siblingsOf('velmora store')).toEqual(['velmora']);
    });

    test('accents, case-free punctuation and digits are not lost letters', () => {
      cache.__setBeautyBrandRowsForTest([beauty('lumière', 30), beauty('lumiere uk', 20), beauty("a'velle 21", 9), beauty('a velle 21 us', 9)]);
      expect(siblingsOf('lumiere')).toEqual(['lumiere uk']);
      expect(siblingsOf('lumiere uk')).toEqual(['lumiere']);
      expect(siblingsOf('a velle 21')).toEqual(['a velle 21 us']);
    });

    test('a digit the key drops is a lost character too', () => {
      cache.__setBeautyBrandRowsForTest([beauty('velmora ٣', 30), beauty('velmora uk', 20)]);
      expect(siblingsOf('velmora')).toEqual([]);
    });

    test('the REAL loader marks whole keys', async () => {
      cache.__setBrandSetForTest([]);
      mockQuery.mockResolvedValue({ rows: [beauty('가나다 velmora', 30), beauty('velmora store', 20), beauty('zentora', 5), beauty('zentora usa', 9)] });
      await cache.refresh();
      expect(siblingsOf('velmora')).toEqual([]);
      expect(siblingsOf('zentora')).toEqual(['zentora usa']);
    });
  });

  // P2-2 of the review: a brand NAMED "<name> store" beside another brand "<name>" cannot be told
  // from a storefront by any string rule. The reviewed list is where that is pinned.
  describe('the reviewed list of spellings that are another brand', () => {
    const listed = (keys, fn) => {
      for (const key of keys) REVIEWED_NOT_SIBLING_SPELLINGS.add(key);
      try { return fn(); } finally { for (const key of keys) REVIEWED_NOT_SIBLING_SPELLINGS.delete(key); }
    };

    test('ships empty: only data is added after the family listing is reviewed', () => {
      expect(REVIEWED_NOT_SIBLING_SPELLINGS).toBeInstanceOf(Set);
      expect(REVIEWED_NOT_SIBLING_SPELLINGS.size).toBe(0);
    });

    test('a listed spelling binds nothing and is bound by nothing; the rest of its family is untouched', () => {
      listed(['lumavelle official store'], () => {
        expect(siblingsOf('lumavelle official store')).toEqual([]);
        expect(siblingsOf('lumavelle')).toEqual(['lumavelle uk']);
        expect(siblingsOf('lumavelle uk')).toEqual(['lumavelle']);
        expect(brandIdentityBindKeys(catalog('lumavelle'))).toEqual(['lumavelle', 'lumavelleuk']);
        expect(siblingsOf('zentora')).toEqual(['zentora usa']);
      });
      expect(siblingsOf('lumavelle')).toEqual(['lumavelle official store', 'lumavelle uk']);
    });

    test('a two-spelling family with one listed binds nothing in either direction', () => {
      listed(['zentora usa'], () => {
        expect(siblingsOf('zentora')).toEqual([]);
        expect(siblingsOf('zentora usa')).toEqual([]);
        expect(brandIdentityBindKeys(catalog('zentora'))).toEqual(['zentora']);
      });
    });

    test('listing the bare name keeps it apart from every suffixed spelling, which still bind each other', () => {
      listed(['lumavelle'], () => {
        expect(siblingsOf('lumavelle')).toEqual([]);
        expect(siblingsOf('lumavelle uk')).toEqual(['lumavelle official store']);
        expect(siblingsOf('lumavelle official store')).toEqual(['lumavelle uk']);
      });
    });
  });

  test('a member that does not itself qualify as a beauty brand is not bound', () => {
    // premise: both are in the dictionary and in the family
    expect(cache.matchCatalogBeautyBrand('orrin jp')).toBeNull();
    expect(cache.matchCatalogBeautyBrand('orrin store')).toBeNull();
    expect(siblingsOf('orrin')).toEqual([]);
    // ...and it stays not a hard brand when typed itself
    expect(buildSearchQualityContract({ rawQuery: 'orrin store serum' }).hard_constraints.brand).toBeNull();
    // a qualifying third member is still bound, the unqualified ones still are not
    cache.__setBeautyBrandRowsForTest([...ROWS, beauty('orrin uk', 7)]);
    expect(siblingsOf('orrin')).toEqual(['orrin uk']);
    expect(siblingsOf('orrin uk')).toEqual(['orrin']);
  });

  test('spacing and hyphens do not split a family, and one row identity is not two spellings', () => {
    expect(siblingsOf('hale-wyn')).toEqual(['halewyn usa']);
    expect(siblingsOf('halewyn usa')).toEqual(['hale-wyn']);
    // premise: loaded solid-first, the two spellings are two dictionary entries in one family
    cache.__setBeautyBrandRowsForTest([beauty('velmora', 9), beauty('vel mora', 9), beauty('velmora uk', 9)]);
    expect(cache.matchCatalogBeautyBrand('velmora').brand).toBe('velmora');
    expect(cache.matchCatalogBeautyBrand('vel mora').brand).toBe('vel mora');
    expect(siblingsOf('vel mora')).toEqual(['velmora uk']);
    expect(siblingsOf('velmora')).toEqual(['velmora uk']);
    expect(siblingsOf('velmora uk')).toEqual(['vel mora', 'velmora']);
    expect(brandIdentityBindKeys(catalog('velmora uk'))).toEqual(['velmorauk', 'velmora']);
  });

  test('a static-lexicon brand keeps its single key, whatever the catalog holds', () => {
    const staticBrand = resolveBeautyBrandBrowseQuery(`${STATIC_NAME} lipstick`);
    expect(staticBrand.detection_mode).toBe('static_beauty');
    expect(staticBrand.brand_key).toBe(STATIC_KEY);
    expect(resolveBoundBrandSiblingSpellings(staticBrand)).toEqual([]);
    expect(resolveBoundBrandSiblingSpellings({ brand_key: STATIC_KEY, canonical: `${STATIC_NAME} usa`, alias: `${STATIC_NAME} usa` })).toEqual([]);
    // a key with no "catalog:" origin has no family even when its text is a family member
    expect(resolveBoundBrandSiblingSpellings({ brand_key: 'zentora', canonical: 'zentora', alias: 'zentora' })).toEqual([]);
    expect(resolveBoundBrandSiblingSpellings({ canonical: 'zentora', alias: 'zentora' })).toEqual([]);
    expect(resolveBoundBrandSiblingSpellings(null)).toEqual([]);
  });

  test('a sibling the static lexicon names is left to that reviewed brand', () => {
    const rows = [beauty(`${STATIC_NAME} beauty`, 9), beauty(`${STATIC_NAME} beauty uk`, 9), beauty(`${STATIC_NAME} beauty jp`, 9), beauty('zentora', 5), beauty('zentora usa', 9)];
    cache.__setBeautyBrandRowsForTest(rows);
    // premise: the dictionary alone would bind the two market spellings
    expect(cache.resolveBrandSiblingSpellings(`${STATIC_NAME} beauty`).siblings).toEqual([`${STATIC_NAME} beauty jp`, `${STATIC_NAME} beauty uk`]);
    expect(siblingsOf(`${STATIC_NAME} beauty`)).toEqual([]);
    // ...and a family the lexicon does not name is untouched by that check
    expect(siblingsOf('zentora')).toEqual(['zentora usa']);
  });

  test('a cold dictionary binds nothing, and no brand is detected at all', async () => {
    cache.__setBrandSetForTest([]);
    expect(siblingsOf('zentora')).toEqual([]);
    expect(siblingsOf('zentora usa')).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled(); // the resolver itself never kicks a load
    expect(buildSearchQualityContract({ rawQuery: 'zentora sunscreen' }).hard_constraints.brand).toBeNull();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockQuery).toHaveBeenCalledTimes(1); // detection kicked the warm, as today
  });

  test('a key the dictionary does not hold binds nothing', () => {
    expect(siblingsOf('zentora uk')).toEqual([]);
    expect(siblingsOf('')).toEqual([]);
  });

  test.each([['1'], ['true'], ['yes'], ['on'], ['ON'], [' On ']])('flag value %j is on', (value) => {
    setFlags({ [SIBLINGS]: value });
    expect(cache.siblingSpellingsEnabled()).toBe(true);
    expect(siblingsOf('zentora')).toEqual(['zentora usa']);
  });

  test.each([[null], [''], ['0'], ['false'], ['off'], ['no'], ['enabled']])('flag value %j is off', (value) => {
    setFlags({ [SIBLINGS]: value });
    expect(cache.siblingSpellingsEnabled()).toBe(false);
    expect(siblingsOf('zentora')).toEqual([]);
    expect(siblingsOf('zentora usa')).toEqual([]);
  });

  test('the flag is read per call', () => {
    const brand = catalog('zentora');
    expect(resolveBoundBrandSiblingSpellings(brand)).toEqual(['zentora usa']);
    setFlags({ [SIBLINGS]: null });
    expect(resolveBoundBrandSiblingSpellings(brand)).toEqual([]);
    setFlags({ [SIBLINGS]: '1' });
    expect(resolveBoundBrandSiblingSpellings(brand)).toEqual(['zentora usa']);
  });

  test('the dictionary flags gate it too: with either off there is no catalog brand to widen', () => {
    setFlags({ [CONTRACT]: null });
    expect(siblingsOf('zentora')).toEqual([]);
    setFlags({ [CONTRACT]: '1', [DETECT]: null });
    expect(siblingsOf('zentora')).toEqual([]);
  });

  test('a family at the cap is bound whole; one past it binds the matched key only and logs once', () => {
    const words = ['us', 'usa', 'uk', 'jp', 'kr', 'global', 'official', 'store'];
    expect(cache.MAX_BRAND_FAMILY_SPELLINGS).toBe(8);
    const atCap = [beauty('velora', 9), ...words.slice(0, 7).map((word) => beauty(`velora ${word}`, 9))];
    cache.__setBeautyBrandRowsForTest(atCap);
    expect(siblingsOf('velora')).toHaveLength(7);
    expect(mockWarn).not.toHaveBeenCalled();

    cache.__setBeautyBrandRowsForTest([...atCap, beauty('velora store', 9)]);
    expect(siblingsOf('velora')).toEqual([]);
    expect(siblingsOf('velora uk')).toEqual([]);
    expect(cache.resolveBrandSiblingSpellings('velora')).toEqual({ siblings: [], capped: true });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [fields, message] = mockWarn.mock.calls[0];
    expect(fields).toEqual({ event: 'brand_sibling_spellings_over_cap', spellings: 9, cap: 8 });
    expect(message).toMatch(/^brand_sibling_spellings_over_cap/);
    expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/velora/);
    // a fresh dictionary load logs again, once
    cache.__setBeautyBrandRowsForTest([...atCap, beauty('velora store', 9)]);
    siblingsOf('velora');
    siblingsOf('velora');
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  test('the REAL loader builds the family index', async () => {
    cache.__setBrandSetForTest([]);
    mockQuery.mockResolvedValue({ rows: ROWS.map((row) => ({ ...row, b: row.b, n: String(row.n) })) });
    await cache.refresh();
    expect(siblingsOf('zentora')).toEqual(['zentora usa']);
    expect(siblingsOf('zentora labs')).toEqual([]);
  });

  test('stripBrandSuffixes is unchanged for its existing callers', () => {
    expect(cache.stripBrandSuffixes('brisa beauty usa')).toBe('brisa');
    expect(cache.stripBrandSuffixes('usa')).toBe('usa');
    expect(cache.brandFamilyName('brisa beauty usa')).toBe('brisa beauty');
    expect(cache.brandFamilyName('brisa usa beauty')).toBe('brisa usa beauty');
  });
});

describe('the contract', () => {
  const contract = (rawQuery) => buildSearchQualityContract({ rawQuery, source: 'shopping-agent-ui' });

  test.each([['on'], [null]])('names the same single key with the flag %j: the family is not written into it', (flag) => {
    setFlags({ [SIBLINGS]: flag });
    expect(contract('zentora sunscreen').hard_constraints.brand).toEqual({
      brand_key: 'catalog:zentora', canonical: 'zentora', alias: 'zentora',
    });
    expect(contract('zentora usa sunscreen').hard_constraints.brand).toEqual({
      brand_key: 'catalog:zentora usa', canonical: 'zentora usa', alias: 'zentora usa',
    });
    expect(contract('zentora labs sunscreen').hard_constraints.brand.brand_key).toBe('catalog:zentora labs');
  });
});

describe('the brand keys both recall lanes bind', () => {
  // What main binds for these brands (flag off): pinned as literals, not recomputed.
  const MAIN = {
    zentora: ['zentora'],
    'zentora usa': ['zentorausa'],
    'zentora labs': ['zentoralabs'],
    'brisa beauty': ['brisabeauty', 'brisa'],
    lumavelle: ['lumavelle'],
  };

  test.each(Object.entries(MAIN))('flag off: %s binds exactly what main binds', (key, expected) => {
    setFlags({ [SIBLINGS]: null });
    expect(brandIdentityBindKeys(catalog(key))).toEqual(expected);
  });

  test('flag on: the family is appended after today\'s keys; brands without one are unchanged', () => {
    expect(brandIdentityBindKeys(catalog('zentora'))).toEqual(['zentora', 'zentorausa']);
    expect(brandIdentityBindKeys(catalog('zentora usa'))).toEqual(['zentorausa', 'zentora']);
    expect(brandIdentityBindKeys(catalog('lumavelle'))).toEqual(['lumavelle', 'lumavelleofficialstore', 'lumavelleuk']);
    expect(brandIdentityBindKeys(catalog('zentora labs'))).toEqual(MAIN['zentora labs']);
    expect(brandIdentityBindKeys(catalog('brisa beauty'))).toEqual(MAIN['brisa beauty']);
    expect(brandIdentityBindKeys(catalog('quillbright'))).toEqual(['quillbright']);
  });

  test('a sibling is bound verbatim: the predicate\'s own "beauty" shortening is not applied to it', () => {
    cache.__setBeautyBrandRowsForTest([beauty('brisa beauty', 18), beauty('brisa beauty usa', 9), beauty('brisa usa', 9), beauty('brisa', 20)]);
    // main already binds "brisa" for "brisa beauty"; the sibling adds its own identity and no shortening of it
    expect(brandIdentityBindKeys(catalog('brisa beauty'))).toEqual(['brisabeauty', 'brisa', 'brisabeautyusa']);
    expect(brandIdentityBindKeys(catalog('brisa'))).toEqual(['brisa', 'brisausa']);
  });

  test('flag on: a static brand binds its reviewed aliases and nothing else', () => {
    const staticBrand = { brand_key: STATIC_KEY, canonical: STATIC_NAME, alias: STATIC_NAME };
    const on = brandIdentityBindKeys(staticBrand);
    setFlags({ [SIBLINGS]: null });
    expect(on).toEqual(brandIdentityBindKeys(staticBrand));
    expect(on).not.toContain(`${STATIC_NAME} usa`.replace(/ /g, ''));
  });

  const md5 = (value) => require('crypto').createHash('md5').update(value, 'utf8').digest('hex');
  const lanes = (key) => {
    const canonicalParams = ['q', '%q%'];
    const canonical = buildCanonicalSearchQualitySql({
      contract: { target_domain: 'beauty', query_class: 'brand_category', effective_query: `${key} sunscreen`,
        hard_constraints: { brand: catalog(key), category_path_prefix: 'beauty/skincare/sun/' } },
      params: canonicalParams, categoryPredicate: 'p.category_path LIKE $3', defaultWhere: 'TRUE', defaultBrandWhere: '',
    });
    const seedParams = [];
    const seed = buildSeedSearchOfferScope({ brand: { contract: 'brand_browse', ...catalog(key), brand: key } }, seedParams);
    return { canonical, canonicalParams, seed, seedParams };
  };

  test('both lanes bind ONE key list, in one = ANY, never a pattern (flag on and off)', () => {
    for (const flag of ['on', null]) {
      setFlags({ [SIBLINGS]: flag });
      for (const key of ['zentora', 'zentora usa', 'lumavelle uk', 'zentora labs', 'quillbright']) {
        const expected = brandIdentityBindKeys(catalog(key));
        const { canonical, canonicalParams, seed, seedParams } = lanes(key);
        // canonical: the two brand binds are the first two the builder adds
        expect(canonicalParams[2]).toEqual(expected);
        expect(canonicalParams[3]).toEqual(expected.map(md5));
        // seed: the brand binds are the only ones this scope adds
        expect(seedParams).toEqual([expected, expected.map(md5)]);
        for (const [sql, fullBind, hashBind] of [[canonical.brandWhere, '$3', '$4'], [seed, '$1', '$2']]) {
          expect(sql).toContain(`= ANY(${hashBind}::text[])`);
          expect(sql).toContain(`= ANY(${fullBind}::text[])`);
          expect(sql).not.toMatch(/\bI?LIKE\b/i);
          expect(sql.match(/= ANY\(/g)).toHaveLength(2);
        }
      }
    }
  });

  test('the generated SQL text does not depend on the flag or on the family: only the bound arrays do', () => {
    const on = lanes('zentora');
    setFlags({ [SIBLINGS]: null });
    const off = lanes('zentora');
    expect(on.canonical).toEqual(off.canonical);
    expect(on.seed).toBe(off.seed);
    expect(off.canonicalParams[2]).toEqual(['zentora']);
    expect(on.canonicalParams[2]).toEqual(['zentora', 'zentorausa']);
    expect(off.seedParams[0]).toEqual(['zentora']);
    expect(on.seedParams[0]).toEqual(['zentora', 'zentorausa']);
    // everything after the brand binds is identical
    expect(on.canonicalParams.slice(4)).toEqual(off.canonicalParams.slice(4));
  });

  test('flag off: the predicate and its binds are what main generates, byte for byte', () => {
    setFlags({ [SIBLINGS]: null });
    const params = [];
    const sql = buildBrandIdentityPredicate(catalog('zentora'), 'p.brand', params);
    expect(params).toEqual([['zentora'], ['964a0d53a4cd1d8787a8ef8a5a510005']]);
    expect(require('crypto').createHash('sha256').update(sql).digest('hex')).toBe(
      'da3993900ccb00d3fb17fccc066f35a313584fd8ba73767e560fe3d457499c89',
    );
    expect(CANONICAL_OWN_BRAND_SQL).toContain('p.brand');
    expect(SEED_OWN_BRAND_SQL).toBeTruthy();
  });
});
