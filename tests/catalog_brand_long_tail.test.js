'use strict';

// Long-tail catalog beauty brands (GATEWAY_CATALOG_BRAND_LONG_TAIL, default OFF).
//
// Measured on prod 2026-09-25, gateway 13b29b90: Danessa Myricks Beauty arrived through a
// retailer ingest with 2 rows (both beauty). "Danessa Myricks Beauty" matched the catalog key
// but sat below MIN_BEAUTY_ROWS=3, and "Danessa Myricks" matched NO key at all -- the catalog
// holds only the store spelling with its "Beauty" suffix. Both classed ambiguous and served
// nothing useful. Every accept below has a refusing twin.

const mockQuery = jest.fn();
jest.mock('../src/db', () => ({ query: (...a) => mockQuery(...a) }));

const cache = require('../src/findProductsMulti/brandDictionaryCache');
const { resolveBeautyBrandBrowseQuery } = require('../src/findProductsMulti/brandLexicon');
const { buildSearchQualityContract } = require('../src/findProductsMulti/queryUnderstanding');
const { buildBrandIdentityPredicate } = require('../src/services/canonicalSearchQualitySql');

const FLAGS = {
  GATEWAY_DYNAMIC_BRAND_DETECT: '1',
  GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT: '1',
  GATEWAY_CATALOG_BRAND_LONG_TAIL: '1',
};

// (b, n, nb, nc) shaped like prod catalog_products counts.
const ROWS = [
  { b: 'danessa myricks beauty', n: 2, nb: 2, nc: 2, nl: 2 },
  { b: 'natasha denona', n: 2, nb: 2, nc: 2, nl: 2 },
  // misfile: diet-drink sticks at bare beauty/makeup (prod 2026-09-25)
  { b: 'shake baby', n: 2, nb: 2, nc: 2, nl: 0 },
  { b: 'round lab', n: 161, nb: 148, nc: 161 },
  { b: 'round lab us', n: 20, nb: 20, nc: 20 },
  { b: 'self beauty', n: 1, nb: 1, nc: 1 },
  { b: 'aya skincare', n: 10, nb: 10, nc: 10 },
  { b: 'first aid beauty', n: 10, nb: 10, nc: 10 },
  { b: 'glowy', n: 2, nb: 2, nc: 2, nl: 2 },
  { b: 'mixed goods co', n: 3, nb: 2, nc: 3, nl: 2 },
  { b: 'one row brand', n: 1, nb: 1, nc: 1, nl: 1 },
  { b: 'celimax', n: 2, nb: 2, nc: 2 },
  { b: 'celimax us', n: 8, nb: 8, nc: 8 },
  { b: 'celimax jp', n: 60, nb: 3, nc: 60 },
  { b: 'simihaze beauty', n: 57, nb: 33, nc: 48 },
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

describe('long-tail row floor', () => {
  test('a 2-row, all-beauty, multi-token brand qualifies', () => {
    expect(resolve('Danessa Myricks Beauty')).toEqual(
      expect.objectContaining({ matched: true, brand_key: 'catalog:danessa myricks beauty', brand_only: true }),
    );
    expect(resolve('Natasha Denona')).toEqual(expect.objectContaining({ matched: true }));
  });

  test('a 2-row SINGLE-token brand keeps the 3-row floor', () => {
    expect(resolve('Glowy').matched).toBe(false);
  });

  test('2 beauty rows of 3 categorised is not all-beauty -> not qualified', () => {
    expect(resolve('Mixed Goods Co').matched).toBe(false);
  });

  test('2 all-beauty rows that are NOT at a beauty leaf do not qualify (misfile guard)', () => {
    expect(resolve('Shake Baby').matched).toBe(false);
  });

  test('a 1-row multi-token brand stays below the floor', () => {
    expect(resolve('One Row Brand').matched).toBe(false);
  });

  test('flag off: the 3-row floor is unchanged', () => {
    setFlags({ GATEWAY_CATALOG_BRAND_LONG_TAIL: null });
    expect(resolve('Danessa Myricks Beauty').matched).toBe(false);
    expect(resolve('Natasha Denona').matched).toBe(false);
    // a brand over the floor is unaffected by the new flag either way
    expect(resolve('Round Lab').matched).toBe(true);
  });
});

describe('suffix-stripped names', () => {
  test('"Danessa Myricks" names "Danessa Myricks Beauty" when it is the whole query', () => {
    for (const q of ['Danessa Myricks', 'danessa myricks', 'Danessa Myricks makeup', 'shop Danessa Myricks']) {
      expect(resolve(q)).toEqual(
        expect.objectContaining({ matched: true, brand_key: 'catalog:danessa myricks beauty', brand_only: true }),
      );
    }
    expect(resolve('Simihaze')).toEqual(expect.objectContaining({ brand_key: 'catalog:simihaze beauty' }));
  });

  test('a stripped name is NOT claimed with extra words (no span search)', () => {
    expect(resolve('Danessa Myricks blush').matched).toBe(false);
  });

  test('stripped names that are ordinary words are refused even alone', () => {
    expect(resolve('first aid').matched).toBe(false);
    expect(resolve('self').matched).toBe(false);
    expect(resolve('aya').matched).toBe(false);
    // the full store spelling still resolves normally
    expect(resolve('Aya Skincare')).toEqual(expect.objectContaining({ matched: true, brand_key: 'catalog:aya skincare' }));
  });

  test('a stripped name never shadows a real catalog brand of that spelling', () => {
    // "celimax" is itself a catalog brand (2 rows, single token -> not qualified); the
    // well-stocked "celimax us" must not answer for it.
    expect(resolve('Celimax').matched).toBe(false);
  });

  test('two brands stripping to one name: the better-stocked one is chosen', () => {
    cache.__setBeautyBrandRowsForTest([
      { b: 'acme beauty', n: 3, nb: 3, nc: 3 },
      { b: 'acme cosmetics', n: 9, nb: 9, nc: 9 },
    ]);
    expect(resolve('Acme')).toEqual(expect.objectContaining({ brand_key: 'catalog:acme cosmetics' }));
  });

  test('flag off: no stripped matching', () => {
    setFlags({ GATEWAY_CATALOG_BRAND_LONG_TAIL: null });
    expect(resolve('Danessa Myricks').matched).toBe(false);
    expect(resolve('Simihaze').matched).toBe(false);
  });
});

describe('loader', () => {
  test('the REAL loader reads nl; a long-tail brand needs leaf rows', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { b: 'danessa myricks beauty', n: '2', nb: '2', nc: '2', nl: '2' },
        { b: 'shake baby', n: '2', nb: '2', nc: '2', nl: '0' },
      ],
    });
    await cache.refresh();
    expect(mockQuery.mock.calls[0][0]).toContain("COUNT(*) FILTER (WHERE category_path ~ '^beauty/[^/]+/[^/]+') AS nl");
    expect(resolve('Danessa Myricks').matched).toBe(true);
    expect(resolve('Shake Baby').matched).toBe(false);
  });
});

describe('contract and brand identity', () => {
  test('the three reported queries get a beauty contract with the brand', () => {
    expect(contract('Danessa Myricks')).toEqual(
      expect.objectContaining({ target_domain: 'beauty', query_class: 'brand_browse' }),
    );
    expect(contract('Danessa Myricks Beauty').hard_constraints.brand).toEqual(
      expect.objectContaining({ brand_key: 'catalog:danessa myricks beauty' }),
    );
    const blush = contract('Danessa Myricks Beauty blush');
    expect(blush.query_class).toBe('brand_category');
    expect(blush.hard_constraints.category_path_prefix).toBe('beauty/makeup/face/blush/');
  });

  test('the identity bind carries the store spelling the rows hold', () => {
    const c = contract('Danessa Myricks');
    const params = [];
    buildBrandIdentityPredicate(c.hard_constraints.brand, 'p.brand', params);
    expect(params[0]).toEqual(expect.arrayContaining(['danessamyricksbeauty', 'danessamyricks']));
  });
});
