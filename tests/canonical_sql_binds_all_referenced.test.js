// Every bind pushed into `params` must be referenced by the statement that runs. PostgreSQL rejects
// an unreferenced bind for the WHOLE query with 42P18 "could not determine data type of parameter
// $N" -- which is how gateway 80371af8 failed every beauty search in production (2026-09-15) and
// was rolled back: the search-quality contract replaced the WHERE that referenced the recall_doc
// binds. This drives the real SQL builders with no database, so every jest shard catches the class.
const { fetchCanonicalChainRows } = require('../src/services/canonicalCatalogSearch');
const { buildSeedSearchOfferScope } = require('../src/services/seedSearchOfferScope');

const unreferencedBinds = (sql, params) =>
  params.map((_, i) => i + 1).filter((n) => !new RegExp(`\\$${n}(?!\\d)`).test(sql));

const PROD_CANONICAL_FLAGS = {
  CANONICAL_CATALOG_CATEGORY_BROWSE_TEXT_UNION: 'on',
  CANONICAL_CATALOG_DETERMINISTIC_TIEBREAK: 'enabled',
  CANONICAL_CATALOG_FORM_AGREEMENT: 'enabled',
  CANONICAL_CATALOG_RANK_V2: 'enabled',
  CANONICAL_CATALOG_RECALL_DOC_MATCH: 'enabled',
  CANONICAL_CATALOG_SET_DIVERSITY: 'enabled',
};

const apieu = { brand_key: 'apieu', canonical: "A'pieu", brand: "A'pieu", alias: 'apieu' };
const CONTRACTS = {
  brand_browse: {
    target_domain: 'beauty',
    query_class: 'brand_browse',
    effective_query: "A'pieu",
    hard_constraints: { brand: apieu },
  },
  category: {
    target_domain: 'beauty',
    query_class: 'category',
    effective_query: 'lightweight moisturizer face moisturizer',
    hard_constraints: { category_path_prefix: 'beauty/skincare/moisturize' },
  },
  exact_anchor: {
    target_domain: 'beauty',
    query_class: 'exact_product',
    effective_query: "A'pieu Oily Hair Dry Powder",
    hard_constraints: { brand: apieu, exact_product_anchor: 'Oily Hair Dry Powder' },
  },
};

describe('canonical and seed recall SQL reference every bind they push', () => {
  let priorEnv;
  beforeEach(() => {
    priorEnv = { ...process.env };
    Object.assign(process.env, PROD_CANONICAL_FLAGS);
  });
  afterEach(() => {
    process.env = priorEnv;
  });

  const capture = async (args) => {
    const calls = [];
    await fetchCanonicalChainRows({
      limit: 20,
      marketId: 'US',
      markets: ['US'],
      includeSkuOffers: true,
      categoryMode: 'category_browse',
      ...args,
      deps: {
        query: async (sql, params = []) => {
          calls.push({ sql, params });
          return { rows: [] };
        },
      },
    });
    expect(calls.length).toBeGreaterThan(0);
    return calls;
  };

  test.each([
    ['brand_browse', { query: "A'pieu" }],
    ['category', { query: 'lightweight moisturizer face moisturizer', categoryPathPrefix: 'beauty/skincare/moisturize' }],
    ['exact_anchor', { query: "A'pieu Oily Hair Dry Powder" }],
  ])('search-quality contract %s under production flags', async (name, args) => {
    const calls = await capture({ ...args, searchQualityContract: CONTRACTS[name] });
    // The recall_doc arm must actually have been built, or this case cannot see the defect.
    expect(calls.some(({ params }) => params.some((value) => Array.isArray(value) && value.some((v) => /%/.test(String(v)))))).toBe(true);
    for (const { sql, params } of calls) expect(unreferencedBinds(sql, params)).toEqual([]);
  });

  test.each([
    ['non-numeric min after a currency', [{ currency: 'USD', min: 'cheap', max: 20 }]],
    ['non-numeric max after a currency', [{ currency: 'SGD', min: 5, max: 'NaN' }]],
    ['valid range', [{ currency: 'USD', min: 5, max: 20 }]],
  ])('canonical offer-scope price range: %s', async (_label, priceRanges) => {
    const calls = await capture({
      query: 'moisturizer',
      categoryPathPrefix: 'beauty/skincare/moisturize',
      offerScope: { inStockOnly: true, markets: ['US'], currency: null, priceRanges },
    });
    for (const { sql, params } of calls) expect(unreferencedBinds(sql, params)).toEqual([]);
  });

  test.each([
    ['non-numeric min after a currency', [{ currency: 'USD', min: 'cheap' }], 'FALSE'],
    ['non-numeric max after a currency', [{ currency: 'SGD', max: 'NaN' }], 'FALSE'],
    ['valid range', [{ currency: 'USD', min: 5, max: 20 }], '>='],
  ])('seed offer-scope price range: %s', (_label, priceRanges, marker) => {
    // Leading binds stand in for the scope query's own market/tool/limit binds, which the real SQL references.
    const params = ['US', '*', 200];
    const fragment = buildSeedSearchOfferScope({ priceRanges, inStockOnly: true }, params);
    const sql = `SELECT 1 WHERE market = $1 AND tool = $2 ${fragment} LIMIT $3`;
    expect(sql).toContain(marker);
    expect(unreferencedBinds(sql, params)).toEqual([]);
  });
});
