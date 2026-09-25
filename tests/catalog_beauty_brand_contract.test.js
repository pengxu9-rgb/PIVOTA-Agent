'use strict';

// Brand-only agent-door queries ("Round Lab", "Kose Suncut", "Bondi Sands")
// classed target_domain=other because the contract only knew the ~60-brand
// static lexicon, and fell to the backend lane that serves price "0". Measured
// on gateway ba1acf136386, 2026-09-24. This suite pins the fix:
//   * a brand the catalog stocks as predominantly beauty resolves as a beauty
//     brand (GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT, default OFF);
//   * self-tan vocabulary routes to beauty/body/tanning/.
// Every accept case has a refusing twin.

const mockQuery = jest.fn();
jest.mock('../src/db', () => ({ query: (...a) => mockQuery(...a) }));

const cache = require('../src/findProductsMulti/brandDictionaryCache');
const { resolveBeautyBrandBrowseQuery } = require('../src/findProductsMulti/brandLexicon');
const {
  buildSearchQualityContract,
  resolveBeautyCategoryPathPrefixFromText,
} = require('../src/findProductsMulti/queryUnderstanding');
const { buildBrandIdentityPredicate } = require('../src/services/canonicalSearchQualitySql');

const DETECT = 'GATEWAY_DYNAMIC_BRAND_DETECT';
const CONTRACT = 'GATEWAY_CATALOG_BEAUTY_BRAND_CONTRACT';

// Shapes and counts taken from the prod catalog, 2026-09-25 (b, n, nb, nc).
const PROD_ROWS = [
  { b: 'round lab', n: 161, nb: 148, nc: 161 },
  { b: 'round lab us', n: 20, nb: 20, nc: 20 },
  { b: 'kosé', n: 24, nb: 24, nc: 24 },
  { b: 'bondi sands', n: 17, nb: 17, nc: 17 },
  { b: 'charlotte tilbury', n: 17, nb: 17, nc: 17 },
  { b: 'gr', n: 138, nb: 22, nc: 138 },
  { b: 'ipsa', n: 2, nb: 2, nc: 2 },
  { b: 'whipped', n: 30, nb: 30, nc: 30 },
  { b: 'bubble', n: 12, nb: 12, nc: 12 },
  { b: 'new balance', n: 80, nb: 0, nc: 80 },
  { b: 'thankyoufarmer', n: 9, nb: 9, nc: 9 },
  { b: 'public goods', n: 181, nb: 176, nc: 179 },
  { b: 'nullpath brand', n: 40, nb: 2, nc: 2 },
];

const saved = {};
function setFlags({ detect = '1', contract = '1' } = {}) {
  for (const [k, v] of [[DETECT, detect], [CONTRACT, contract]]) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  saved[DETECT] = process.env[DETECT];
  saved[CONTRACT] = process.env[CONTRACT];
  mockQuery.mockReset();
  cache.__setBrandSetForTest(PROD_ROWS.map((r) => r.b));
  cache.__setBeautyBrandRowsForTest(PROD_ROWS);
  setFlags();
});
afterEach(() => {
  for (const k of [DETECT, CONTRACT]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  cache.__setBrandSetForTest([]);
});

describe('matchCatalogBeautyBrand', () => {
  test('a predominantly-beauty catalog brand matches, under its canonical key for either spelling', () => {
    expect(cache.matchCatalogBeautyBrand('round lab')).toEqual(expect.objectContaining({ brand: 'round lab' }));
    expect(cache.matchCatalogBeautyBrand('roundlab')).toEqual(expect.objectContaining({ brand: 'round lab' }));
  });

  test('longest span wins: "round lab us" is its own brand, not round lab', () => {
    expect(cache.matchCatalogBeautyBrand('round lab us toner')).toEqual(expect.objectContaining({ brand: 'round lab us' }));
  });

  test('accents fold on the loader side: kosé is indexed as kose (it used to be `kos`, inadmissible)', () => {
    expect(cache.matchCatalogBeautyBrand('kose suncut')).toEqual(expect.objectContaining({ brand: 'kose' }));
  });

  test('share is over CATEGORISED rows; bare-beauty-root brands qualify, mixed ones do not', () => {
    expect(cache.matchCatalogBeautyBrand('charlotte tilbury')).not.toBeNull();
    // 22 of 138 categorised rows are beauty -> mixed (fashion/apparel) brand
    expect(cache.matchCatalogBeautyBrand('gr')).toBeNull();
    expect(cache.matchCatalogBeautyBrand('new balance')).toBeNull();
    // 2 categorised rows, both beauty: under MIN_BEAUTY_ROWS
    expect(cache.matchCatalogBeautyBrand('nullpath brand')).toBeNull();
    expect(cache.matchCatalogBeautyBrand('ipsa')).toBeNull();
  });

  test('a non-beauty longest match does not fall back to a shorter sub-span', () => {
    cache.__setBeautyBrandRowsForTest([
      { b: 'lab series', n: 50, nb: 0, nc: 50 },
      { b: 'series', n: 10, nb: 10, nc: 10 },
    ]);
    expect(cache.matchCatalogBeautyBrand('lab series')).toBeNull();
  });

  test('either flag off -> null, whatever the cache holds', () => {
    setFlags({ contract: null });
    expect(cache.matchCatalogBeautyBrand('round lab')).toBeNull();
    setFlags({ detect: null, contract: '1' });
    expect(cache.matchCatalogBeautyBrand('round lab')).toBeNull();
  });

  test('the REAL loader reads nb/nc; a row without them never qualifies', async () => {
    cache.__setBeautyBrandRowsForTest([]);
    mockQuery.mockResolvedValue({
      rows: [
        { b: 'round lab', n: '161', nb: '148', nc: '161' },
        { b: 'missha', n: '40' },
      ],
    });
    await cache.refresh();
    expect(mockQuery.mock.calls[0][0]).toMatch(/category_path = 'beauty' OR category_path LIKE 'beauty\/%'/);
    expect(cache.matchCatalogBeautyBrand('round lab')).not.toBeNull();
    expect(cache.matchCatalogBeautyBrand('missha')).toBeNull();
    // the detection set is untouched by the new columns
    expect(cache.getBrandSet().has('missha')).toBe(true);
    expect(cache.getBrandSet().has('round lab')).toBe(true);
  });
});

describe('resolveBeautyBrandBrowseQuery with a catalog beauty brand', () => {
  test('brand-only query resolves as a brand_browse beauty brand', () => {
    expect(resolveBeautyBrandBrowseQuery('Round Lab')).toEqual(
      expect.objectContaining({
        matched: true,
        brand_key: 'catalog:round lab',
        brand: 'round lab',
        brand_only: true,
        detection_mode: 'catalog_beauty',
      }),
    );
  });

  test('brand + line name is a brand, not brand-only', () => {
    expect(resolveBeautyBrandBrowseQuery('Kose Suncut')).toEqual(
      expect.objectContaining({ matched: true, brand_key: 'catalog:kose', brand_only: false }),
    );
  });

  test('a static lexicon brand still wins and keeps its reviewed key', () => {
    expect(resolveBeautyBrandBrowseQuery('Tarte')).toEqual(
      expect.objectContaining({ matched: true, brand_key: 'tarte', detection_mode: 'static_beauty' }),
    );
  });

  test('an ordinary-word brand is a brand only when the query is the brand alone', () => {
    expect(resolveBeautyBrandBrowseQuery('Whipped')).toEqual(expect.objectContaining({ matched: true, brand_only: true }));
    expect(resolveBeautyBrandBrowseQuery('whipped body butter').matched).toBe(false);
    expect(resolveBeautyBrandBrowseQuery('bubble bath').matched).toBe(false);
  });

  test('an unambiguous single-word brand is claimed with a category word', () => {
    expect(resolveBeautyBrandBrowseQuery('thankyoufarmer sunscreen')).toEqual(
      expect.objectContaining({ matched: true, brand_key: 'catalog:thankyoufarmer', brand_only: false }),
    );
  });

  test('flag off: byte-identical to before (no catalog match)', () => {
    setFlags({ contract: null });
    const out = resolveBeautyBrandBrowseQuery('Round Lab');
    expect(out.matched).toBe(false);
    expect(out.detection_mode).toBeNull();
  });
});

describe('search quality contract', () => {
  const contract = (q) => buildSearchQualityContract({ rawQuery: q, source: 'shopping-agent-ui' });

  test('"Round Lab" -> beauty / brand_browse with a hard brand', () => {
    const c = contract('Round Lab');
    expect(c.target_domain).toBe('beauty');
    expect(c.query_class).toBe('brand_browse');
    expect(c.hard_constraints.brand).toEqual({ brand_key: 'catalog:round lab', canonical: 'round lab', alias: 'round lab' });
  });

  test('"Bondi Sands" and "Kose Suncut" -> beauty', () => {
    expect(contract('Bondi Sands').target_domain).toBe('beauty');
    expect(contract('Kose Suncut').target_domain).toBe('beauty');
  });

  test('"Round Lab toner" keeps the brand AND the category', () => {
    const c = contract('Round Lab toner');
    expect(c.query_class).toBe('brand_category');
    expect(c.hard_constraints.brand).toEqual(expect.objectContaining({ brand_key: 'catalog:round lab' }));
    expect(c.hard_constraints.category_path_prefix).toBe('beauty/skincare/tone/');
  });

  test('refusals: non-beauty and unstocked brands keep today\'s classification', () => {
    expect(contract('New Balance').target_domain).toBe('other');
    expect(contract('IPSA').target_domain).toBe('other');
    expect(contract('whipped cream dispenser').hard_constraints.brand).toBeNull();
  });

  test('flag off: the contract is unchanged for the reported queries', () => {
    setFlags({ contract: null });
    for (const q of ['Round Lab', 'Kose Suncut', 'Bondi Sands']) {
      const c = contract(q);
      expect(c.target_domain).toBe('other');
      expect(c.query_class).toBe('ambiguous_or_non_shopping');
      expect(c.hard_constraints.brand).toBeNull();
    }
  });
});

describe('brand identity SQL for a catalog brand', () => {
  test('binds the space-stripped identity the row index carries', () => {
    const params = [];
    const sql = buildBrandIdentityPredicate({ brand_key: 'catalog:round lab', canonical: 'round lab', alias: 'round lab' }, 'p.brand', params);
    expect(sql).toMatch(/md5\(/);
    expect(params[0]).toEqual(['roundlab']);
  });

  test('kose binds kose; the SQL side folds the row\'s é to match', () => {
    const params = [];
    buildBrandIdentityPredicate({ brand_key: 'catalog:kose', canonical: 'kose', alias: 'kose' }, 'p.brand', params);
    expect(params[0]).toEqual(['kose']);
  });
});

describe('self-tan vocabulary', () => {
  const prefix = (q) => resolveBeautyCategoryPathPrefixFromText(q);

  test.each([
    'self tanner',
    'self-tanning foam',
    'Bondi Sands self tanning foam',
    'selftanner',
    'sunless tanner',
    'fake tan',
    'gradual tan lotion',
    'tanning mousse',
    'tanning drops',
    'bronzing drops',
    'self tanning body mist',
    'tanning lotion',
    '美黑',
  ])('accepts %s', (q) => {
    expect(prefix(q)).toBe('beauty/body/tanning/');
  });

  test.each([
    ['bronzer', 'beauty/makeup/face/bronzer/'],
    ['body mist', 'beauty/fragrance/'],
    ['tanning oil spf 30', 'beauty/skincare/sun/'],
    ['tanning bed', ''],
    ['tanning salon', ''],
    ['leather tanning', ''],
    ['tan boots', ''],
    ['tan', ''],
  ])('refuses %s (-> %s)', (q, expected) => {
    expect(prefix(q)).toBe(expected);
  });

  test('"self tanner" contract: beauty / category_browse, not clarify', () => {
    setFlags({ detect: null, contract: null });
    const c = buildSearchQualityContract({ rawQuery: 'self tanner', source: 'shopping-agent-ui' });
    expect(c.target_domain).toBe('beauty');
    expect(c.query_class).toBe('category_browse');
    expect(c.clarification_allowed).toBe(false);
    expect(c.hard_constraints.category_path_prefix).toBe('beauty/body/tanning/');
  });
});
