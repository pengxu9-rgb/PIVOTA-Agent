// The stable browse catalog count is one integer. Every column its source CTEs
// compute that no WHERE clause reads is wasted work — and `search_text` is
// lower(concat_ws(...)) over ~15 seed_data JSON paths, a full JSONB detoast per
// qualifying row. Measured on prod: 1.1s with 49 servable seeds, 8.9s with 3,681,
// same plan. Generic browse reads none of the three derived columns; skipping
// them took it to 1.0s with an identical total.
//
// This file pins that the count projects ONLY what its own filters consume, per
// request shape. It is the only coverage the count builder has — nothing else
// in the suite constructs it — which is how the cost drifted 8x unnoticed.

const SEARCH_TEXT_MARKER = 'concat_ws';
const BRAND_COMPACT_MARKER = 'regexp_replace(';

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

// Both CTEs (internal + external) emit each column, so a REAL projection shows
// the expression at least once; a stubbed one shows only the ''::text constant.
function projectsRealCategoryText(sql) {
  const stubbed = (sql.match(/''::text AS category_text/g) || []).length;
  const total = (sql.match(/AS category_text/g) || []).length;
  return total > stubbed;
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
    // The expensive one: this is the 8x.
    expect(sql).not.toContain(SEARCH_TEXT_MARKER);
    expect(sql).not.toContain(BRAND_COMPACT_MARKER);
    expect(projectsRealCategoryText(sql)).toBe(false);
    // The CTE SHAPE is preserved so the filter clauses are untouched.
    expect(sql).toContain('AS search_text');
    expect(sql).toContain('AS brand_compact');
    expect(sql).toContain('AS category_text');
  });

  test('query text still projects search_text, because the filter reads it', () => {
    const sql = countSql(loadInternals(), { ...BASE, query: { text: 'vitamin c serum' } });
    expect(sql).toContain(SEARCH_TEXT_MARKER);
    expect(sql).toMatch(/search_text LIKE/);
    // But not the ones this shape does not read.
    expect(sql).not.toContain(BRAND_COMPACT_MARKER);
    expect(projectsRealCategoryText(sql)).toBe(false);
  });

  test('category scope still projects category_text, and nothing else', () => {
    const sql = countSql(loadInternals(), { ...BASE, scope: { categories: ['skincare'] } });
    expect(projectsRealCategoryText(sql)).toBe(true);
    expect(sql).toMatch(/category_text = ANY/);
    expect(sql).not.toContain(SEARCH_TEXT_MARKER);
    expect(sql).not.toContain(BRAND_COMPACT_MARKER);
  });

  test('brand scope projects both brand_compact and search_text', () => {
    const sql = countSql(loadInternals(), { ...BASE, scope: { brand_names: ['COSRX'] } });
    // brand_compact for the exact match, search_text for the LIKE pattern.
    expect(sql).toContain(BRAND_COMPACT_MARKER);
    expect(sql).toContain(SEARCH_TEXT_MARKER);
    expect(sql).toMatch(/brand_compact = ANY/);
    expect(projectsRealCategoryText(sql)).toBe(false);
  });
});
