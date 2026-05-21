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
    expect(sql).not.toMatch(/LEFT JOIN catalog_skus s ON s\.product_key = c\.product_key/);
    expect(sql).not.toMatch(/LEFT JOIN catalog_offers o ON o\.sku_key = s\.sku_key/);
    expect(sql).toMatch(/p\.pivota_signature_id/);
    expect(sql).toMatch(/p\.pivota_canonical_url/);
  });

  test('filters source-unavailable external-seed catalog rows before canonical recall', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'fenty',
      deps: { query },
    });
    const { sql } = query.calls[0];

    expect(sql).toMatch(/p\.merchant_id = 'external_seed'/);
    expect(sql).toMatch(/source_unavailable_v1,status/);
    expect(sql).toMatch(/external_seed\.source_unavailable\.v1/);
    expect(sql).toMatch(/transaction_readiness_blocker_v1,status/);
    expect(sql).toMatch(/FROM external_product_seeds eps_unavailable/);
  });

  test('omits merchant clause when merchantId not provided', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    expect(sql).not.toMatch(/AND p\.merchant_id = \$\d+/);
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
    await fetchCanonicalChainRows({ query: 'lipstick', includeSkuOffers: true, deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/o\.catalog_track = 'internal_merchant'.+THEN 10 ELSE 0 END AS rank_score/s);
  });

  test('keeps product-level catalog rows on the default recall path', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/NULL::text\s+AS sku_key/);
    expect(sql).toMatch(/NULL::text\s+AS offer_id/);
    expect(sql).toMatch(/COALESCE\(m\.merchant_id, p\.merchant_id\) AS merchant_id/);
  });

  test('can include SKU and offer rows for offer-aware callers', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', includeSkuOffers: true, deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/LEFT JOIN catalog_skus s ON s\.product_key = c\.product_key/);
    expect(sql).toMatch(/LEFT JOIN catalog_offers o ON o\.sku_key = s\.sku_key/);
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

  // ------------------------------------------------------------------------
  // Market-aware recall (2026-05-09): the trigger was Round Lab market=KR
  // products surfacing in US users' canonical_chain results despite the
  // external-seed-direct path already filtering by market. This brings
  // the canonical-chain helper to parity.
  // ------------------------------------------------------------------------

  test('marketId omitted: no market filter (legacy behaviour)', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', deps: { query } });
    const { sql } = query.calls[0];
    // The canonical-scope override token only appears when marketWhere is built
    expect(sql).not.toMatch(/eps\.market\s*=/);
  });

  test('marketId set: SQL filters Path B by eps.market while letting canonical scope + Path A through', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', marketId: 'US', deps: { query } });
    const { sql, params } = query.calls[0];
    // Path A merchant rows pass through (merchant_id != 'external_seed')
    expect(sql).toMatch(/p\.merchant_id != 'external_seed'/);
    // Canonical-scope override (Phase 7a / Path C agent rows surface across markets)
    expect(sql).toMatch(/p\.pdp_scope = 'multi_merchant_canonical'/);
    // Path B filter via EXISTS subquery on external_product_seeds.market
    expect(sql).toMatch(/EXISTS \(\s*SELECT 1 FROM external_product_seeds eps/);
    expect(sql).toMatch(/eps\.market\s*=\s*\$\d+/);
    // Last param is the uppercased market
    expect(params[params.length - 1]).toBe('US');
  });

  test('marketId is uppercased before binding to SQL param', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', marketId: 'kr', deps: { query } });
    const { params } = query.calls[0];
    expect(params[params.length - 1]).toBe('KR');
  });

  test('marketId composes with merchantId + categoryPathPrefix without param-index conflicts', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      merchantId: 'shop_42',
      categoryPathPrefix: 'beauty/makeup/lip/',
      marketId: 'US',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    // Order: $1 query, $2 query_like, $3 candidate_limit, $4 row_limit,
    //        $5 merchant_id, $6 category_path_prefix, $7 market
    expect(params[4]).toBe('shop_42');
    expect(params[5]).toBe('beauty/makeup/lip/%');
    expect(params[6]).toBe('US');
    // SQL references all three in their respective binds
    expect(sql).toMatch(/AND p\.merchant_id = \$5/);
    expect(sql).toMatch(/p\.category_path LIKE \$6/);
    expect(sql).toMatch(/eps\.market\s*=\s*\$7/);
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
