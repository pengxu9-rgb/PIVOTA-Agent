'use strict';

// Follow-up to #2273 (long-tail catalog beauty brands), two independent flags, both default OFF:
//   GATEWAY_CATALOG_BRAND_ALLOWLIST        -- a brand the retailer ingest onboarded on purpose
//                                             (data/beauty/onboarded_catalog_brands.json)
//                                             qualifies from its FIRST beauty-leaf row;
//   GATEWAY_CATALOG_BRAND_STRIPPED_CATEGORY -- "Danessa Myricks blush": a multi-token stripped
//                                             name leading the query with more words after it.
// Plus one unflagged restriction: `kiss` joins the ordinary-word list (KISS is an onboarded
// brand; "kiss proof lipstick" must never become a KISS filter).

const mockQuery = jest.fn();
jest.mock('../src/db', () => ({ query: (...a) => mockQuery(...a) }));

const cache = require('../src/findProductsMulti/brandDictionaryCache');
const { resolveBeautyBrandBrowseQuery } = require('../src/findProductsMulti/brandLexicon');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const onboarded = require('../data/beauty/onboarded_catalog_brands.json');

const FLAGS = {
  GATEWAY_DYNAMIC_BRAND_DETECT: '1',
  GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT: '1',
  GATEWAY_CATALOG_BRAND_LONG_TAIL: '1',
  GATEWAY_CATALOG_BRAND_ALLOWLIST: '1',
  GATEWAY_CATALOG_BRAND_STRIPPED_CATEGORY: '1',
};

const ROWS = [
  { b: 'danessa myricks beauty', n: 2, nb: 2, nc: 2, nl: 2 },
  { b: 'k18', n: 1, nb: 1, nc: 1, nl: 1 }, // onboarded, 1 row
  { b: 'mielle', n: 1, nb: 1, nc: 1, nl: 0 }, // onboarded, 1 row but not at a leaf
  { b: 'random vendor', n: 1, nb: 1, nc: 1, nl: 1 }, // NOT onboarded, 1 row
  { b: 'kiss', n: 5, nb: 5, nc: 5, nl: 5 }, // onboarded, ordinary word
  { b: 'first aid beauty', n: 10, nb: 10, nc: 10, nl: 10 },
  { b: 'aya skincare', n: 10, nb: 10, nc: 10, nl: 10 },
  { b: 'simihaze beauty', n: 57, nb: 33, nc: 48, nl: 24 }, // stripped: one token, not an ordinary word
  { b: 'round lab', n: 161, nb: 148, nc: 161, nl: 148 },
  { b: 'round lab us', n: 20, nb: 20, nc: 20, nl: 20 },
  // prod 2026-09-26: OPI, 11 beauty rows -- a 3-letter key admissibleKey refuses, so it was
  // never indexed at all. Onboarded, so the allowlist admits it.
  { b: 'opi', n: 11, nb: 11, nc: 11, nl: 5 },
  // a 3-letter brand that is NOT onboarded: stays unindexed whatever its row count
  { b: 'abc', n: 9, nb: 9, nc: 9, nl: 9 },
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

const resolve = (q) => resolveBeautyBrandBrowseQuery(q);
const contract = (q) => buildSearchQualityContract({ rawQuery: q, source: 'shopping-agent-ui' });

describe('onboarded-brand allowlist', () => {
  test('the vendored list is well-formed and carries the canonical spellings', () => {
    expect(Array.isArray(onboarded.brands)).toBe(true);
    const canon = onboarded.brands.map((b) => b.canonical);
    expect(canon).toEqual(expect.arrayContaining(['Danessa Myricks Beauty', 'K18', 'KISS', 'Kiss New York']));
    for (const b of onboarded.brands) expect(typeof b.canonical).toBe('string');
  });

  test('isOnboardedBrand matches canonical and store spellings, accent-folded', () => {
    expect(cache.isOnboardedBrand('Estée Lauder')).toBe(true);
    expect(cache.isOnboardedBrand('Estee Lauder')).toBe(true);
    expect(cache.isOnboardedBrand('TRESemme')).toBe(true);
    expect(cache.isOnboardedBrand('round lab')).toBe(false);
  });

  test('an onboarded brand qualifies from its first beauty-leaf row', () => {
    expect(resolve('K18')).toEqual(expect.objectContaining({ matched: true, brand_key: 'catalog:k18' }));
    expect(contract('K18 hair mask')).toEqual(expect.objectContaining({ query_class: 'brand_category' }));
  });

  test('refusals: not onboarded at 1 row; onboarded but no leaf row; flag off', () => {
    expect(resolve('Random Vendor').matched).toBe(false);
    expect(resolve('Mielle').matched).toBe(false);
    setFlags({ GATEWAY_CATALOG_BRAND_ALLOWLIST: null });
    expect(resolve('K18').matched).toBe(false);
  });
});

describe('short onboarded brand names (OPI)', () => {
  test('flag on: "OPI" and "OPI nail polish" route to the brand', () => {
    expect(cache.isOnboardedBrand('OPI')).toBe(true);
    expect(resolve('OPI')).toEqual(expect.objectContaining({ matched: true, brand_key: 'catalog:opi' }));
    const c = contract('OPI nail polish');
    expect(c.query_class).toBe('brand_category');
    expect(c.hard_constraints.category_path_prefix).toBe('beauty/makeup/nails/nail-polish/');
  });

  test('flag off: a short key never qualifies, even with enough rows (deploy stays inert)', () => {
    setFlags({ GATEWAY_CATALOG_BRAND_ALLOWLIST: null });
    expect(resolve('OPI').matched).toBe(false);
  });

  test('flag off: a short onboarded key never hides another brand in the query', () => {
    // Review of #2274: "opi olaplex" resolved Olaplex on main but nothing on this branch.
    cache.__setBeautyBrandRowsForTest([
      { b: 'opi', n: 11, nb: 11, nc: 11, nl: 5 },
      { b: 'olaplex', n: 44, nb: 44, nc: 44, nl: 44 },
    ]);
    setFlags({ GATEWAY_CATALOG_BRAND_ALLOWLIST: null });
    expect(resolve('opi olaplex')).toEqual(expect.objectContaining({ matched: true, brand_key: 'catalog:olaplex' }));
    expect(resolve('olaplex opi')).toEqual(expect.objectContaining({ matched: true, brand_key: 'catalog:olaplex' }));
  });

  test('a short brand that is not onboarded stays unrouted', () => {
    expect(resolve('abc').matched).toBe(false);
  });
});

describe('ordinary-word brand KISS (unflagged restriction)', () => {
  test('"KISS" alone is the brand; "kiss proof lipstick" is not', () => {
    expect(resolve('KISS')).toEqual(expect.objectContaining({ matched: true, brand_only: true }));
    expect(resolve('kiss proof lipstick').matched).toBe(false);
    const c = contract('kiss proof lipstick');
    expect(c.hard_constraints.brand).toBeNull();
    expect(c.hard_constraints.category_path_prefix).toBe('beauty/makeup/lip/');
  });

  test('the restriction holds with every new flag off', () => {
    setFlags({ GATEWAY_CATALOG_BRAND_ALLOWLIST: null, GATEWAY_CATALOG_BRAND_STRIPPED_CATEGORY: null });
    expect(resolve('kiss proof lipstick').matched).toBe(false);
  });
});

describe('stripped name + more words', () => {
  test('"Danessa Myricks blush" keeps the brand AND the category', () => {
    expect(resolve('Danessa Myricks blush')).toEqual(
      expect.objectContaining({ matched: true, brand_key: 'catalog:danessa myricks beauty', brand_only: false }),
    );
    const c = contract('Danessa Myricks blush');
    expect(c.query_class).toBe('brand_category');
    expect(c.hard_constraints.category_path_prefix).toBe('beauty/makeup/face/blush/');
  });

  test('refusals: not leading; single-token stripped name; ordinary-word stripped name', () => {
    expect(resolve('blush by Danessa Myricks').matched).toBe(false);
    expect(resolve('aya serum').matched).toBe(false); // "aya" is one token, and ordinary
    // one-token stripped name that is NOT on the word list: refused on size alone
    expect(resolve('simihaze lip gloss').matched).toBe(false);
    expect(resolve('Simihaze')).toEqual(expect.objectContaining({ matched: true })); // brand-only still works
    expect(resolve('first aid kit').matched).toBe(false);
  });

  test('a stripped name that is also a real brand spelling does not answer', () => {
    // "round lab" is a real catalog brand: the primary matcher owns it, never the stripped one.
    expect(resolve('Round Lab toner')).toEqual(expect.objectContaining({ brand_key: 'catalog:round lab' }));
  });

  test('flag off: only the brand-only stripped match remains', () => {
    setFlags({ GATEWAY_CATALOG_BRAND_STRIPPED_CATEGORY: null });
    expect(resolve('Danessa Myricks blush').matched).toBe(false);
    expect(resolve('Danessa Myricks').matched).toBe(true);
  });
});
