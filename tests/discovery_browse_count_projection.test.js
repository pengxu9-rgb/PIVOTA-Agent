// The stable browse catalog count is one integer. Every column its source CTEs
// compute that no WHERE clause reads is wasted work — and `search_text` is
// lower(concat_ws(...)) over ~15 seed_data JSON paths, a full JSONB detoast per
// qualifying row. Measured on prod: 1.1s with 49 servable seeds, 8.9s with 3,681,
// same plan. Generic browse reads none of the three derived columns; skipping
// them took it to 1.0s with an identical total.
//
// Which shapes reach the count is decided by shouldUseStableBrowseCatalogTotal:
// generic, category-only, and query+category. Query-only and brand-scoped never
// do. So the brand test below pins a path only the test can reach today — it is
// kept because the gate must still be correct if that predicate ever widens.
//
// The count is built from TWO CTEs (internal products_cache, external seeds),
// UNION ALL'd. Every assertion here is PER ARM, on purpose: a projection that
// is real in one arm and stubbed in the other is type-valid SQL that returns a
// silently WRONG COUNT (one arm compares against ''), and a "does the marker
// appear anywhere" check reads that as fine. This is the only coverage the
// count builder has — nothing else in the suite constructs it — which is how
// an 8x cost drift went unnoticed.

const CTE_ARMS = 2;

function loadInternals() {
  jest.resetModules();
  process.env.DATABASE_URL = 'postgres://count-projection-test';
  jest.doMock('../src/db', () => ({ query: jest.fn(() => Promise.resolve({ rows: [] })) }));
  // eslint-disable-next-line global-require
  return require('../src/services/discoveryFeed')._internals;
}

function countSql(internals, request) {
  const normalized = internals.normalizeDiscoveryRequest(request);
  return internals.buildStableBrowseCatalogCountQuery(normalized, { includeIdentityJoin: true }).sql;
}

const count = (sql, re) => (sql.match(re) || []).length;

// For each derived column: how many arms project the REAL expression, and how
// many project the ''::text stub. Real + stub must always equal CTE_ARMS.
function projection(sql) {
  const stubbedSearch = count(sql, /''::text AS search_text/g);
  const stubbedBrand = count(sql, /''::text AS brand_compact/g);
  const stubbedCategory = count(sql, /''::text AS category_text/g);
  return {
    search: { real: CTE_ARMS - stubbedSearch, stubbed: stubbedSearch },
    brand: { real: CTE_ARMS - stubbedBrand, stubbed: stubbedBrand },
    category: { real: CTE_ARMS - stubbedCategory, stubbed: stubbedCategory },
    // Independent evidence the "real" arms really carry the expression, so a
    // future rename of the stub can't make every arm read as real.
    concatWs: count(sql, /concat_ws/g),
    regexpReplace: count(sql, /regexp_replace\(/g),
  };
}

function expectShape(sql, { search, brand, category }) {
  const p = projection(sql);
  // Every column is emitted in every arm — the CTE shape is preserved.
  expect(count(sql, /AS search_text/g)).toBe(CTE_ARMS);
  expect(count(sql, /AS brand_compact/g)).toBe(CTE_ARMS);
  expect(count(sql, /AS category_text/g)).toBe(CTE_ARMS);
  // And each column is uniformly real or uniformly stubbed across BOTH arms.
  expect(p.search).toEqual({ real: search ? CTE_ARMS : 0, stubbed: search ? 0 : CTE_ARMS });
  expect(p.brand).toEqual({ real: brand ? CTE_ARMS : 0, stubbed: brand ? 0 : CTE_ARMS });
  expect(p.category).toEqual({ real: category ? CTE_ARMS : 0, stubbed: category ? 0 : CTE_ARMS });
  // The expensive expressions appear once per REAL arm and nowhere else.
  expect(p.concatWs).toBe(search ? CTE_ARMS : 0);
  expect(p.regexpReplace).toBe(brand ? CTE_ARMS : 0);
}

const BASE = { surface: 'browse_products', page: 1, limit: 24 };

describe('stable browse catalog count projects only what its filters read', () => {
  const prevDatabaseUrl = process.env.DATABASE_URL;
  afterEach(() => {
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    jest.resetModules();
  });

  test('generic browse computes none of the derived text columns', () => {
    const sql = countSql(loadInternals(), BASE);
    expectShape(sql, { search: false, brand: false, category: false });
  });

  test('query text projects search_text in both arms, because the filter reads it', () => {
    const sql = countSql(loadInternals(), { ...BASE, query: { text: 'vitamin c serum' } });
    expectShape(sql, { search: true, brand: false, category: false });
    expect(sql).toMatch(/search_text LIKE/);
  });

  test('category scope projects category_text in both arms, and nothing else', () => {
    const sql = countSql(loadInternals(), { ...BASE, scope: { categories: ['skincare'] } });
    expectShape(sql, { search: false, brand: false, category: true });
    expect(sql).toMatch(/category_text = ANY/);
  });

  test('query text plus category scope projects both, in both arms', () => {
    // A live shape: shouldUseStableBrowseCatalogTotal admits it, and it is the
    // one that still pays the search_text detoast — correct, just not faster.
    const sql = countSql(loadInternals(), {
      ...BASE,
      query: { text: 'vitamin c serum' },
      scope: { categories: ['skincare'] },
    });
    expectShape(sql, { search: true, brand: false, category: true });
  });

  test('brand scope projects brand_compact and search_text in both arms', () => {
    const sql = countSql(loadInternals(), { ...BASE, scope: { brand_names: ['COSRX'] } });
    expectShape(sql, { search: true, brand: true, category: false });
    expect(sql).toMatch(/brand_compact = ANY/);
  });

  test('a filter clause that reads a column always forces its projection', () => {
    // The gates are derived FROM the built clauses, not restated beside them.
    // Pin that: for every shape, if any clause mentions a column, that column
    // is really projected — the wrong-count failure this file exists to catch.
    const internals = loadInternals();
    const shapes = [
      BASE,
      { ...BASE, query: { text: 'retinol' } },
      { ...BASE, scope: { categories: ['makeup'] } },
      { ...BASE, scope: { brand_names: ['Anua'] } },
      { ...BASE, query: { text: 'toner' }, scope: { categories: ['skincare'] } },
    ];
    for (const shape of shapes) {
      const sql = countSql(internals, shape);
      const whereStart = sql.indexOf('filtered AS (');
      const filterSql = sql.slice(whereStart);
      const p = projection(sql);
      if (/search_text/.test(filterSql.replace(/AS search_text/g, ''))) expect(p.search.real).toBe(CTE_ARMS);
      if (/brand_compact/.test(filterSql.replace(/AS brand_compact/g, ''))) expect(p.brand.real).toBe(CTE_ARMS);
      if (/category_text/.test(filterSql.replace(/AS category_text/g, ''))) expect(p.category.real).toBe(CTE_ARMS);
    }
  });
});
