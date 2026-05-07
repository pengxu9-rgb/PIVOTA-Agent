/**
 * Unit tests for `src/services/canonicalCatalogSearch.js` (Phase 7b Step 1).
 *
 * The helper takes a node-pg-style `query(sql, params)` function via
 * dependency injection. Tests substitute a mock `query` and assert that the
 * generated SQL + params match the expected shape for various inputs.
 *
 * Live-DB sanity check is intentionally OUT OF SCOPE for this Step 1 test
 * file. Run `node tests/_manual/canonical_catalog_search_live.js` against
 * prod (or staging) DATABASE_URL to verify the SQL actually returns rows
 * — that script lives next to this file and is not part of CI.
 */

'use strict';

const {
  fetchCanonicalChainRows,
  __internal,
} = require('../src/services/canonicalCatalogSearch');

function makeMockQuery(rows = []) {
  const calls = [];
  const fn = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    return { rows };
  });
  fn.calls = calls;
  return fn;
}

describe('canonicalCatalogSearch.fetchCanonicalChainRows', () => {
  test('returns [] for empty query without hitting the DB', async () => {
    const query = makeMockQuery([{ product_key: 'should not appear' }]);
    const out = await fetchCanonicalChainRows({ query: '   ', deps: { query } });
    expect(out).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test('throws when deps.query is missing', async () => {
    await expect(
      fetchCanonicalChainRows({ query: 'lipstick', deps: {} }),
    ).rejects.toThrow(/deps\.query is required/);
  });

  test('passes lowered exact query, like-pattern, candidate_limit, row_limit as $1..$4', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'Lipstick',
      limit: 12,
      deps: { query },
    });
    const { params, sql } = query.calls[0];
    expect(params[0]).toBe('lipstick');
    expect(params[1]).toBe('%lipstick%');
    expect(typeof params[2]).toBe('number');
    expect(typeof params[3]).toBe('number');
    expect(params[2]).toBeGreaterThanOrEqual(__internal.CANDIDATE_LIMIT_MIN);
    expect(params[2]).toBeLessThanOrEqual(__internal.CANDIDATE_LIMIT_MAX);
    expect(params[3]).toBeGreaterThanOrEqual(__internal.ROW_LIMIT_MIN);
    expect(params[3]).toBeLessThanOrEqual(__internal.ROW_LIMIT_MAX);
    expect(sql).toMatch(/FROM catalog_products p/);
    expect(sql).toMatch(/JOIN catalog_skus s ON s\.product_key = p\.product_key/);
    expect(sql).toMatch(/JOIN catalog_offers o ON o\.sku_key = c\.sku_key/);
  });

  test('omits merchant clause when merchantId not provided', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    expect(sql).not.toMatch(/p\.merchant_id =/);
    expect(params).toHaveLength(4);
  });

  test('adds merchant clause and binds merchantId when provided', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      merchantId: 'merch_abc',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    expect(params).toHaveLength(5);
    expect(params[4]).toBe('merch_abc');
    expect(sql).toMatch(/AND p\.merchant_id = \$5/);
  });

  test('adds category WHERE + score when categoryPathPrefix provided', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      categoryPathPrefix: 'beauty/makeup/lip/',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    expect(params).toHaveLength(5);
    expect(params[4]).toBe('beauty/makeup/lip/%');
    expect(sql).toMatch(/p\.category_path LIKE \$5/);
    expect(sql).toMatch(/THEN 90 ELSE 0 END/);
  });

  test('combines merchantId + categoryPathPrefix on $5/$6 in order', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      merchantId: 'merch_abc',
      categoryPathPrefix: 'beauty/makeup/lip/',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    expect(params).toHaveLength(6);
    expect(params[4]).toBe('merch_abc');
    expect(params[5]).toBe('beauty/makeup/lip/%');
    expect(sql).toMatch(/AND p\.merchant_id = \$5/);
    expect(sql).toMatch(/p\.category_path LIKE \$6/);
  });

  test('vertical search adds visible_option_labels + ingredient_ids OR clauses', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'niacinamide',
      verticalSearch: true,
      deps: { query },
    });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/visible_option_labels AS TEXT/);
    expect(sql).toMatch(/ingredient_ids AS TEXT/);
    expect(sql).toMatch(/THEN 20 ELSE 0 END/);
    expect(sql).toMatch(/THEN 15 ELSE 0 END/);
  });

  test('vertical search OFF omits the option-label / ingredient branches', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      deps: { query },
    });
    const { sql } = query.calls[0];
    expect(sql).not.toMatch(/visible_option_labels AS TEXT/);
    expect(sql).not.toMatch(/THEN 20 ELSE 0 END/);
  });

  test('rank score includes Phase 6 multi_merchant_canonical +200 bonus', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/p\.pdp_scope = 'multi_merchant_canonical'/);
    expect(sql).toMatch(/THEN 200 ELSE 0 END/);
  });

  test('outer SELECT bumps rank by +10 for internal_merchant offers', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/o\.catalog_track = 'internal_merchant'.+THEN 10 ELSE 0 END AS rank_score/s);
  });

  test('returns the rows array as-is from the underlying query', async () => {
    const fakeRows = [
      { product_key: 'a', offer_id: 'o1', rank_score: 290 },
      { product_key: 'b', offer_id: 'o2', rank_score: 280 },
    ];
    const query = makeMockQuery(fakeRows);
    const out = await fetchCanonicalChainRows({ query: 'lipstick', deps: { query } });
    expect(out).toBe(fakeRows);
  });

  test('limit param bounds row_limit between ROW_LIMIT_MIN and ROW_LIMIT_MAX', async () => {
    const query = makeMockQuery([]);
    // Tiny limit
    await fetchCanonicalChainRows({ query: 'lipstick', limit: 1, deps: { query } });
    expect(query.calls[0].params[3]).toBe(__internal.ROW_LIMIT_MIN);
    // Huge limit
    await fetchCanonicalChainRows({ query: 'lipstick', limit: 10000, deps: { query } });
    expect(query.calls[1].params[3]).toBe(__internal.ROW_LIMIT_MAX);
  });

  test('non-numeric limit falls back to DEFAULT_LIMIT', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', limit: 'xyz', deps: { query } });
    // DEFAULT_LIMIT * 6 = 72, clamped up to ROW_LIMIT_MIN (50 → 72 wins)
    expect(query.calls[0].params[3]).toBe(72);
  });
});

describe('canonicalCatalogSearch.__internal helpers', () => {
  test('normalizeQuery trims + lowercases, returns "" for null/undefined', () => {
    expect(__internal.normalizeQuery('  Lipstick  ')).toBe('lipstick');
    expect(__internal.normalizeQuery(null)).toBe('');
    expect(__internal.normalizeQuery(undefined)).toBe('');
    expect(__internal.normalizeQuery('')).toBe('');
  });

  test('clampLimit handles invalid + boundary cases', () => {
    expect(__internal.clampLimit(undefined, 12, 1, 100)).toBe(12);
    expect(__internal.clampLimit(NaN, 12, 1, 100)).toBe(12);
    expect(__internal.clampLimit(-5, 12, 1, 100)).toBe(12);
    expect(__internal.clampLimit(0, 12, 1, 100)).toBe(12);
    expect(__internal.clampLimit(50, 12, 1, 100)).toBe(50);
    expect(__internal.clampLimit(500, 12, 1, 100)).toBe(100);
    expect(__internal.clampLimit(0.5, 12, 1, 100)).toBe(1); // floor → 0 → fallback
  });
});
