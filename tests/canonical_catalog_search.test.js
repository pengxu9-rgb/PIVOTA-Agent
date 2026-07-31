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

    // ADR-009: the source-unavailable suppression gates on platform, not the
    // legacy merchant_id='external_seed' bucket, so merch_obs_ seeds are covered.
    expect(sql).toMatch(/AND NOT \(\s*COALESCE\(p\.platform, ''\) = 'external_seed'/);
    expect(sql).not.toMatch(/AND NOT \(\s*p\.merchant_id = 'external_seed'/);
    expect(sql).toMatch(/source_unavailable_v1,status/);
    expect(sql).toMatch(/external_seed\.source_unavailable\.v1/);
    expect(sql).toMatch(/transaction_readiness_blocker_v1,status/);
    expect(sql).toMatch(/FROM external_product_seeds eps_unavailable/);
  });

  test('market filter gates external seeds by platform, not legacy merchant_id (ADR-009)', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'sunscreen',
      marketId: 'US',
      deps: { query },
    });
    const { sql, params } = query.calls[0];

    // The market filter must exempt only NON-external-seed (Path A) rows via
    // platform — a merchant_id check let merch_obs_ external seeds skip the
    // per-market filter (KR seed leaking into US recall). COALESCE keeps
    // NULL-platform connected rows on the Path A (pass-through) side.
    expect(sql).toMatch(/COALESCE\(p\.platform, ''\) <> 'external_seed'/);
    expect(sql).not.toMatch(/p\.merchant_id != 'external_seed'/);
    expect(sql).toMatch(/pdp_scope = 'multi_merchant_canonical'/);
    expect(sql).toMatch(/eps\.market =/);
    expect(params).toContain('US');
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

  test('adds category exact-leaf + descendant WHERE and score when categoryPathPrefix provided', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      categoryPathPrefix: 'beauty/makeup/lip/',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    expect(params).toHaveLength(6);
    expect(params[4]).toBe('beauty/makeup/lip');
    expect(params[5]).toBe('beauty/makeup/lip/%');
    expect(sql).toMatch(/p\.category_path = \$5 OR p\.category_path LIKE \$6/);
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
    expect(params).toHaveLength(7);
    expect(params[4]).toBe('merch_abc');
    expect(params[5]).toBe('beauty/makeup/lip');
    expect(params[6]).toBe('beauty/makeup/lip/%');
    expect(sql).toMatch(/AND p\.merchant_id = \$5/);
    expect(sql).toMatch(/p\.category_path = \$6 OR p\.category_path LIKE \$7/);
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

  test('neutrality: outer SELECT does NOT boost internal_merchant offers', async () => {
    // P0.3 firewall — ownership is not a ranking signal. The old +10
    // internal_merchant boost was removed (matches pivota-backend).
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', includeSkuOffers: true, deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).not.toMatch(/THEN 10 ELSE 0 END AS rank_score/);
    expect(sql).toMatch(/c\.rank_score AS rank_score/);
  });

  test('default eligibility gates on serving_eligible (buyable)', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/ips\.serving_eligible = TRUE/);
    expect(sql).not.toMatch(/ips\.index_eligible = TRUE/);
  });

  test("eligibility:'index_eligible' gates on the OFFER-FREE citable column", async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', eligibility: 'index_eligible', deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/ips\.index_eligible = TRUE/);
    expect(sql).not.toMatch(/ips\.serving_eligible = TRUE/);
  });

  test('unknown eligibility falls back to serving_eligible (injection-safe)', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'lipstick', eligibility: 'DROP TABLE x', deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/ips\.serving_eligible = TRUE/);
    expect(sql).not.toMatch(/DROP TABLE/);
  });

  test('tokenMatch OFF (default) adds no token clause — buyable SQL unchanged', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'hair butter for damaged hair', deps: { query } });
    const { sql, params } = query.calls[0];
    expect(sql).not.toMatch(/\) >= \d+\)/); // no token-overlap threshold
    expect(params).toHaveLength(4); // only $1..$4, no token binds
  });

  test('tokenMatch ON adds token-overlap WHERE + rank + binds for multi-token query', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'hair butter for damaged hair',
      tokenMatch: true,
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    // overlap threshold in WHERE + a *25 token rank bonus
    expect(sql).toMatch(/\) >= 2\)/);
    expect(sql).toMatch(/\* 25\)/);
    // tokens: hair, butter, damaged ("for" is a stopword, dup "hair" deduped)
    expect(params).toContain('%hair%');
    expect(params).toContain('%butter%');
    expect(params).toContain('%damaged%');
    expect(params).not.toContain('%for%');
  });

  test('tokenMatch ON with a single significant token adds no token clause', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'anuko', tokenMatch: true, deps: { query } });
    const { sql, params } = query.calls[0];
    expect(sql).not.toMatch(/\) >= \d+\)/);
    expect(params).toHaveLength(4);
  });

  test('buyable tokenMatch lane (serving_eligible) keeps merchant_name + source_product_id + plain overlap', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'hair butter for damaged hair',
      tokenMatch: true, // default eligibility = serving_eligible
      deps: { query },
    });
    const { sql } = query.calls[0];
    // byte-identical buyable form: cross-table + source_product_id arms retained,
    // token clause is the plain arithmetic threshold (no any-token superset guard)
    expect(sql).toMatch(/OR LOWER\(COALESCE\(m\.merchant_name, ''\)\) LIKE \$2/);
    expect(sql).toMatch(/OR LOWER\(COALESCE\(p\.source_product_id, ''\)\) LIKE \$2/);
    expect(sql).toMatch(/OR \(\([^]*?\) >= 2\)/);
    expect(sql).not.toMatch(/AND \(\([^]*?\) >= 2\)\)/); // no sargable AND-recheck wrapper
  });

  test('citable tokenMatch lane (index_eligible) is sargable: drops merchant_name/source_product_id, adds any-token guard', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'hair butter for damaged hair',
      tokenMatch: true,
      eligibility: 'index_eligible',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    // the two non-sargable OR-arms are gone from the text WHERE
    expect(sql).not.toMatch(/OR LOWER\(COALESCE\(m\.merchant_name, ''\)\) LIKE \$2/);
    expect(sql).not.toMatch(/OR LOWER\(COALESCE\(p\.source_product_id, ''\)\) LIKE \$2/);
    // token clause is now (any-token superset) AND (exact overlap >= minTokens)
    expect(sql).toMatch(/AND \(\([^]*?\) >= 2\)\)/);
    // same token binds as the plain form — no extra params, exact-match semantics
    expect(params).toContain('%hair%');
    expect(params).toContain('%butter%');
    expect(params).toContain('%damaged%');
    // the eligibility gate flips to the index_eligible column
    expect(sql).toMatch(/ips\.index_eligible = TRUE/);
    // merchant_name is still available for the rank bonus (only the WHERE arm dropped)
    expect(sql).toMatch(/LOWER\(COALESCE\(m\.merchant_name, ''\)\)\s+=\s+\$1\s+THEN\s+90/);
  });

  test('citable non-tokenMatch lane keeps the full clause (index_eligible alone does not rewrite)', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'lipstick',
      eligibility: 'index_eligible', // tokenMatch OFF
      deps: { query },
    });
    const { sql } = query.calls[0];
    // without tokenMatch the sargable rewrite must NOT engage — full clause intact
    expect(sql).toMatch(/OR LOWER\(COALESCE\(m\.merchant_name, ''\)\) LIKE \$2/);
    expect(sql).toMatch(/OR LOWER\(COALESCE\(p\.source_product_id, ''\)\) LIKE \$2/);
    expect(sql).toMatch(/ips\.index_eligible = TRUE/);
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
    // Path A merchant rows pass through (COALESCE(platform,'') <> 'external_seed'
    // — ADR-009, gated on platform so merch_obs_ external seeds still get the
    // market filter; COALESCE keeps NULL-platform connected rows on Path A)
    expect(sql).toMatch(/COALESCE\(p\.platform, ''\) <> 'external_seed'/);
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
    //        $5 merchant_id, $6 category_path_exact, $7 category_path_prefix, $8 market
    expect(params[4]).toBe('shop_42');
    expect(params[5]).toBe('beauty/makeup/lip');
    expect(params[6]).toBe('beauty/makeup/lip/%');
    expect(params[7]).toBe('US');
    // SQL references all three in their respective binds
    expect(sql).toMatch(/AND p\.merchant_id = \$5/);
    expect(sql).toMatch(/p\.category_path = \$6 OR p\.category_path LIKE \$7/);
    expect(sql).toMatch(/eps\.market\s*=\s*\$8/);
  });

  test('brandFilter scopes category canonical recall to the requested brand', async () => {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'fenty lipstick',
      categoryPathPrefix: 'beauty/makeup/lip/',
      marketId: 'US',
      brandFilter: { canonical: 'Fenty Beauty', alias: 'fenty', brand_key: 'fenty_beauty' },
      deps: { query },
    });
    const { sql, params } = query.calls[0];

    expect(params[4]).toBe('beauty/makeup/lip');
    expect(params[5]).toBe('beauty/makeup/lip/%');
    expect(params[6]).toBe('US');
    expect(params).toContain('%fenty beauty%');
    expect(params).toContain('%fentybeauty%');
    expect(params).toContain('%fenty%');
    expect(sql).toMatch(/p\.category_path = \$5 OR p\.category_path LIKE \$6/);
    expect(sql).toMatch(/eps\.market\s*=\s*\$7/);
    expect(sql).toMatch(/AND \(\(\s*lower\(concat_ws\(' ',\s*p\.brand,/);
    expect(sql).toMatch(/FROM external_product_seeds eps_brand/);
    expect(sql).toMatch(/eps_brand\.external_product_id = p\.source_product_id/);
    expect(sql).toMatch(/eps_brand\.seed_data->'derived'->'recall'->>'brand_name'/);
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

  test('buildBrandFilterTerms normalizes canonical brand, alias, and compact brand key', () => {
    expect(
      __internal.buildBrandFilterTerms({
        canonical: 'Fenty Beauty',
        alias: 'fenty',
        brand_key: 'fenty_beauty',
      }),
    ).toEqual(['fenty beauty', 'fenty']);
  });
});

describe('canonicalCatalogSearch recall_doc match lane (ADR-020, flag-gated)', () => {
  const FLAG = 'CANONICAL_CATALOG_RECALL_DOC_MATCH';
  const savedFlag = process.env[FLAG];

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  test('flag off (unset) -> SQL contains no recall_doc reference (serving unchanged)', async () => {
    delete process.env[FLAG];
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'vitamin c serum',
      marketId: 'US',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    expect(sql).not.toMatch(/recall_doc/);
    expect(sql).not.toMatch(/recall_market/);
    expect(params.some((p) => Array.isArray(p))).toBe(false);
  });

  test.each(['off', 'false', '0', 'disabled', ''])(
    'flag value %p stays off',
    async (value) => {
      process.env[FLAG] = value;
      const query = makeMockQuery([]);
      await fetchCanonicalChainRows({ query: 'lip balm', deps: { query } });
      expect(query.calls[0].sql).not.toMatch(/recall_doc/);
    },
  );

  test.each(['enabled', 'on', '1', 'true', ' TRUE '])(
    'flag value %p turns the lane on',
    async (value) => {
      process.env[FLAG] = value;
      const query = makeMockQuery([]);
      await fetchCanonicalChainRows({ query: 'lip balm', deps: { query } });
      expect(query.calls[0].sql).toMatch(/p\.recall_doc LIKE ANY\(\$\d+::text\[\]\)/);
    },
  );

  test('flag on + marketId -> LIKE ANY arm, recall_market guard, patterns param appended', async () => {
    process.env[FLAG] = 'enabled';
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'Vitamin C Serum',
      marketId: 'us',
      deps: { query },
    });
    const { sql, params } = query.calls[0];

    expect(sql).toMatch(/p\.recall_doc IS NOT NULL/);
    const armMatch = sql.match(/p\.recall_doc LIKE ANY\(\$(\d+)::text\[\]\)/);
    expect(armMatch).not.toBeNull();
    const patternsIdx = Number(armMatch[1]) - 1;
    const patterns = params[patternsIdx];
    expect(Array.isArray(patterns)).toBe(true);
    expect(patterns).toEqual(
      expect.arrayContaining(['%vitamin c serum%', '%vitamin c%', '%c serum%', '%vitamin%', '%serum%']),
    );

    const guardMatch = sql.match(
      /p\.recall_market IS NULL OR p\.recall_market = \$(\d+)/,
    );
    expect(guardMatch).not.toBeNull();
    expect(params[Number(guardMatch[1]) - 1]).toBe('US');

    // Regression guard: appending the recall-doc binds must not renumber the
    // fixed leading params.
    expect(params[0]).toBe('vitamin c serum');
    expect(params[1]).toBe('%vitamin c serum%');

    // Every $N referenced in the SQL must resolve to a supplied param.
    const maxBind = Math.max(
      ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
    );
    expect(maxBind).toBe(params.length);
  });

  test('flag on without marketId -> no recall_market guard', async () => {
    process.env[FLAG] = 'on';
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'niacinamide toner', deps: { query } });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/p\.recall_doc LIKE ANY/);
    expect(sql).not.toMatch(/recall_market/);
  });

  test('flag on -> citable sargable lane (tokenMatch + index_eligible) also gains the arm', async () => {
    process.env[FLAG] = 'true';
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'hair butter damaged',
      tokenMatch: true,
      eligibility: 'index_eligible',
      deps: { query },
    });
    expect(query.calls[0].sql).toMatch(/p\.recall_doc LIKE ANY/);
  });

  test('flag on + categoryPathPrefix -> no recall_doc arm and no orphan binds (08P01 guard)', async () => {
    process.env[FLAG] = 'enabled';
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'vitamin c serum',
      categoryPathPrefix: 'beauty/skincare/serum/',
      marketId: 'US',
      deps: { query },
    });
    const { sql, params } = query.calls[0];
    // The category branch of whereClause discards textWhereClause, so the
    // recall-doc arm (and its patterns/market-guard binds) must not be built
    // at all — otherwise the statement declares fewer $n placeholders than
    // supplied params and Postgres rejects every category-lane query (08P01).
    expect(sql).not.toMatch(/recall_doc/);
    expect(sql).not.toMatch(/recall_market/);
    expect(params.some((p) => Array.isArray(p))).toBe(false);
    // The assertion that would have caught the bug: the highest $n referenced
    // in the SQL must equal the number of supplied params.
    const maxBind = Math.max(
      ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
    );
    expect(maxBind).toBe(params.length);
  });

  test('flag off leaves no blank-line artifact where the arm would interpolate (buyable lane)', async () => {
    delete process.env[FLAG];
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'hair butter for damaged hair',
      tokenMatch: true,
      deps: { query },
    });
    const { sql } = query.calls[0];
    // tokenWhere is the last arm of textWhereClause; with the flag off the
    // clause must close immediately after it (pre-recall-doc bytes), with no
    // extra indent-only line from an empty `${recallDocWhere}` interpolation.
    expect(sql).toMatch(/\) >= 2\)\n  \)/);
    expect(sql).not.toMatch(/\) >= 2\)\n *\n/);
  });

  test('flag off leaves no blank-line artifact on the citable sargable lane either', async () => {
    delete process.env[FLAG];
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'hair butter for damaged hair',
      tokenMatch: true,
      eligibility: 'index_eligible',
      deps: { query },
    });
    const { sql } = query.calls[0];
    expect(sql).toMatch(/\) >= 2\)\)\n  \)/);
    expect(sql).not.toMatch(/\) >= 2\)\)\n *\n/);
  });

  test('flag unset vs flag=disabled -> byte-identical SQL and params', async () => {
    delete process.env[FLAG];
    const q1 = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'vitamin c serum',
      marketId: 'US',
      tokenMatch: true,
      deps: { query: q1 },
    });
    process.env[FLAG] = 'disabled';
    const q2 = makeMockQuery([]);
    await fetchCanonicalChainRows({
      query: 'vitamin c serum',
      marketId: 'US',
      tokenMatch: true,
      deps: { query: q2 },
    });
    expect(q2.calls[0].sql).toBe(q1.calls[0].sql);
    expect(q2.calls[0].params).toEqual(q1.calls[0].params);
  });

  test('flag is read per call, not at module load', async () => {
    delete process.env[FLAG];
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'sunscreen', deps: { query } });
    expect(query.calls[0].sql).not.toMatch(/recall_doc/);
    process.env[FLAG] = 'enabled';
    await fetchCanonicalChainRows({ query: 'sunscreen', deps: { query } });
    expect(query.calls[1].sql).toMatch(/p\.recall_doc LIKE ANY/);
  });
});

describe('canonicalCatalogSearch rank v2 + market-exemption fix (ADR-020, flag-gated)', () => {
  const RANK_FLAG = 'CANONICAL_CATALOG_RANK_V2';
  const DOC_FLAG = 'CANONICAL_CATALOG_RECALL_DOC_MATCH';
  const savedRank = process.env[RANK_FLAG];
  const savedDoc = process.env[DOC_FLAG];

  afterEach(() => {
    if (savedRank === undefined) delete process.env[RANK_FLAG];
    else process.env[RANK_FLAG] = savedRank;
    if (savedDoc === undefined) delete process.env[DOC_FLAG];
    else process.env[DOC_FLAG] = savedDoc;
  });

  // Option combos exercised for flag-off byte-identity. Covers the plain path,
  // market/merchant/category binds, tokenMatch (plain + citable sargable),
  // brandFilter, and the offer fan-out.
  const COMBOS = [
    { name: 'base', args: { query: 'vitamin c serum' } },
    { name: 'market', args: { query: 'vitamin c serum', marketId: 'US' } },
    {
      name: 'merchant+category+market',
      args: {
        query: 'vitamin c serum',
        merchantId: 'merch_abc',
        categoryPathPrefix: 'beauty/skincare/serum/',
        marketId: 'kr',
      },
    },
    {
      name: 'tokenMatch buyable',
      args: { query: 'hair butter for damaged hair', tokenMatch: true, marketId: 'US' },
    },
    {
      name: 'tokenMatch citable sargable',
      args: {
        query: 'hair butter for damaged hair',
        tokenMatch: true,
        eligibility: 'index_eligible',
      },
    },
    {
      name: 'brandFilter+offers',
      args: {
        query: 'fenty lipstick',
        includeSkuOffers: true,
        brandFilter: { canonical: 'Fenty Beauty' },
        marketId: 'US',
      },
    },
  ];

  async function capture(args) {
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ ...args, deps: { query } });
    return query.calls[0];
  }

  describe.each([
    ['recall-doc flag off', () => delete process.env[DOC_FLAG]],
    ['recall-doc flag on', () => { process.env[DOC_FLAG] = 'enabled'; }],
  ])('flag-off byte-identity (%s)', (_label, setDocFlag) => {
    test.each(COMBOS)(
      'combo $name: SQL and params identical across unset and every off spelling',
      async ({ args }) => {
        setDocFlag();
        delete process.env[RANK_FLAG];
        const baseline = await capture(args);

        // Legacy shape preserved: +200 provenance arm, no v2 markers.
        expect(baseline.sql).toMatch(/THEN 200 ELSE 0 END/);
        expect(baseline.sql).not.toMatch(/LIKE \$2\s+THEN 120 ELSE 0 END/);
        expect(baseline.sql).not.toMatch(/p\.recall_doc LIKE \$2/);
        expect(baseline.sql).not.toMatch(
          /pdp_scope = 'multi_merchant_canonical'\s+THEN\s+20 ELSE/,
        );
        if (args.marketId) {
          // Market exemption stays the bare legacy pass-through.
          expect(baseline.sql).toMatch(/OR p\.pdp_scope = 'multi_merchant_canonical'\s*\n\s*OR EXISTS/);
          expect(baseline.sql).not.toMatch(
            /pdp_scope = 'multi_merchant_canonical' AND \(p\.recall_market/,
          );
        }

        for (const value of ['', '0', 'false', 'off', 'disabled', 'no']) {
          process.env[RANK_FLAG] = value;
          const run = await capture(args);
          expect(run.sql).toBe(baseline.sql);
          expect(run.params).toEqual(baseline.params);
        }
      },
    );
  });

  test('flag off: base combo pushes no extra binds (params stay $1..$4)', async () => {
    delete process.env[RANK_FLAG];
    delete process.env[DOC_FLAG];
    const { params } = await capture({ query: 'vitamin c serum' });
    expect(params).toHaveLength(4);
  });

  test.each(['enabled', 'on', '1', 'true', ' TRUE '])(
    'flag value %p turns rank v2 on',
    async (value) => {
      process.env[RANK_FLAG] = value;
      const { sql } = await capture({ query: 'lip balm' });
      expect(sql).toMatch(/LIKE \$2\s+THEN 120 ELSE 0 END/);
      expect(sql).not.toMatch(/THEN 200 ELSE 0 END/);
    },
  );

  test('flag on: rank arms are title-phrase 120, all-token coverage 80, recall_doc 60, scope 20', async () => {
    process.env[RANK_FLAG] = 'enabled';
    delete process.env[DOC_FLAG];
    const { sql, params } = await capture({ query: 'Vitamin C Serum' });

    // +120 phrase-in-title (reuses $2 = '%vitamin c serum%')
    expect(sql).toMatch(
      /CASE WHEN LOWER\(COALESCE\(p\.title, ''\)\) LIKE \$2\s+THEN 120 ELSE 0 END/,
    );
    // +80 all-token coverage: tokens vitamin + serum ('c' < 3 chars dropped),
    // AND-joined (title OR brand) pairs with fresh binds.
    expect(sql).toMatch(
      /\(LOWER\(COALESCE\(p\.title, ''\)\) LIKE \$(\d+) OR LOWER\(COALESCE\(p\.brand, ''\)\) LIKE \$\1\) AND \(LOWER\(COALESCE\(p\.title, ''\)\) LIKE \$(\d+) OR LOWER\(COALESCE\(p\.brand, ''\)\) LIKE \$\2\)/,
    );
    expect(sql).toMatch(/\)\)\s+THEN\s+80 ELSE 0 END/); // coverage arm (paren-closed), distinct from brand-exact = $1 THEN 80
    expect(params).toContain('%vitamin%');
    expect(params).toContain('%serum%');
    // +60 recall_doc phrase hit (rank arm — present even with the recall-doc
    // MATCH lane flag off; it scores, it does not recall)
    expect(sql).toMatch(
      /CASE WHEN p\.recall_doc IS NOT NULL AND p\.recall_doc LIKE \$2\s+THEN\s+60 ELSE 0 END/,
    );
    // provenance bonus scaled 200 -> 20
    expect(sql).toMatch(
      /CASE WHEN p\.pdp_scope = 'multi_merchant_canonical'\s+THEN\s+20 ELSE 0 END/,
    );
    expect(sql).not.toMatch(/THEN 200 ELSE 0 END/);
    // recall-doc MATCH lane stayed off: no LIKE ANY arm in the WHERE
    expect(sql).not.toMatch(/LIKE ANY/);

    // existing identity-exact arms keep their weights
    expect(sql).toMatch(/= \$1\s+THEN 105 ELSE 0 END/);
    expect(sql).toMatch(/= \$1\s+THEN 100 ELSE 0 END/);
    expect(sql).toMatch(/= \$1\s+THEN\s+90 ELSE 0 END/);
    expect(sql).toMatch(/= \$1\s+THEN\s+80 ELSE 0 END/);
  });

  test('flag on: no significant tokens -> coverage arm omitted, other v2 arms intact', async () => {
    process.env[RANK_FLAG] = 'enabled';
    delete process.env[DOC_FLAG];
    // 'bb' is < 3 chars; no significant tokens survive.
    const { sql, params } = await capture({ query: 'bb' });
    expect(sql).toMatch(/THEN 120 ELSE 0 END/);
    expect(sql).toMatch(/THEN\s+60 ELSE 0 END/);
    expect(sql).toMatch(/THEN\s+20 ELSE 0 END/);
    expect(sql).not.toMatch(/\)\)\s+THEN\s+80 ELSE 0 END/); // no coverage arm
    expect(params).toHaveLength(4); // no coverage binds pushed
  });

  test('flag on + marketId: canonical-scope exemption tightens to recall_market', async () => {
    process.env[RANK_FLAG] = 'enabled';
    delete process.env[DOC_FLAG];
    const { sql, params } = await capture({ query: 'sunscreen', marketId: 'us' });

    const m = sql.match(
      /OR \(p\.pdp_scope = 'multi_merchant_canonical' AND \(p\.recall_market IS NULL OR p\.recall_market = \$(\d+)\)\)/,
    );
    expect(m).not.toBeNull();
    expect(params[Number(m[1]) - 1]).toBe('US');
    // bare unconditional exemption is gone
    expect(sql).not.toMatch(/OR p\.pdp_scope = 'multi_merchant_canonical'\s*\n\s*OR EXISTS/);
    // Path A + eps.market arms untouched
    expect(sql).toMatch(/COALESCE\(p\.platform, ''\) <> 'external_seed'/);
    expect(sql).toMatch(/eps\.market\s*=\s*\$\d+/);
  });

  test('flag on without marketId: no market filter and no recall_market guard', async () => {
    process.env[RANK_FLAG] = 'enabled';
    delete process.env[DOC_FLAG];
    const { sql } = await capture({ query: 'sunscreen' });
    expect(sql).not.toMatch(/recall_market/);
    expect(sql).not.toMatch(/eps\.market/);
  });

  test('both flags on: combined SQL sane, params numbering intact (max $n === params.length)', async () => {
    process.env[RANK_FLAG] = 'enabled';
    process.env[DOC_FLAG] = 'enabled';
    // NOTE: no categoryPathPrefix here — on the category branch the
    // !categoryBind guard in the recall-doc lane skips building (and binding)
    // the LIKE ANY arm entirely (pinned by the '08P01 guard' test in the
    // recall-doc describe above), so this combo exercises the text branch,
    // where the recall-doc lane and the rank-v2 arms actually coexist. The
    // category-branch rank-arm bind integrity has its own test below.
    const { sql, params } = await capture({
      query: 'hair butter for damaged hair',
      tokenMatch: true,
      marketId: 'US',
      merchantId: 'merch_abc',
    });

    // rank v2 arms + tightened exemption + recall-doc LIKE ANY lane coexist
    expect(sql).toMatch(/THEN 120 ELSE 0 END/);
    expect(sql).toMatch(
      /pdp_scope = 'multi_merchant_canonical' AND \(p\.recall_market IS NULL OR p\.recall_market = \$\d+\)/,
    );
    expect(sql).toMatch(/p\.recall_doc LIKE ANY\(\$\d+::text\[\]\)/);
    expect(sql).not.toMatch(/THEN 200 ELSE 0 END/);

    // every $N referenced resolves to a supplied param, and none are unused
    const maxBind = Math.max(
      ...[...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])),
    );
    expect(maxBind).toBe(params.length);
    // fixed leading binds not renumbered
    expect(params[0]).toBe('hair butter for damaged hair');
    expect(params[1]).toBe('%hair butter for damaged hair%');
  });

  test('flag on + categoryPathPrefix: rank-arm binds stay integral on the category branch (08P01 guard)', async () => {
    process.env[RANK_FLAG] = 'enabled';
    delete process.env[DOC_FLAG];
    const { sql, params } = await capture({
      query: 'vitamin c serum',
      categoryPathPrefix: 'beauty/skincare/serum/',
      marketId: 'US',
      tokenMatch: true,
    });

    // Category branch active: whereClause takes the category form and
    // discards the text arms — but rank_score is always computed, so every
    // rank-v2 bind pushed above must still be referenced there.
    expect(sql).toMatch(
      /p\.category_path IS NOT NULL AND \(p\.category_path = \$\d+ OR p\.category_path LIKE \$\d+\) AND \$2::text IS NOT NULL/,
    );

    // Coverage-arm binds ('vitamin' + 'serum'; 'c' < 3 chars dropped) are
    // pushed AND referenced inside the rank_score coverage CASE.
    const cov = sql.match(
      /\(LOWER\(COALESCE\(p\.title, ''\)\) LIKE \$(\d+) OR LOWER\(COALESCE\(p\.brand, ''\)\) LIKE \$\1\) AND \(LOWER\(COALESCE\(p\.title, ''\)\) LIKE \$(\d+) OR LOWER\(COALESCE\(p\.brand, ''\)\) LIKE \$\2\)/,
    );
    expect(cov).not.toBeNull();
    expect(params[Number(cov[1]) - 1]).toBe('%vitamin%');
    expect(params[Number(cov[2]) - 1]).toBe('%serum%');
    expect(sql).toMatch(/\)\)\s+THEN\s+80 ELSE 0 END/); // coverage arm present

    // The 08P01 pin: highest $n referenced === number of supplied params —
    // no rank-arm / tokenScore / market bind may be pushed-but-orphaned when
    // the category branch discards textWhereClause.
    const maxBind = Math.max(
      ...[...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])),
    );
    expect(maxBind).toBe(params.length);
  });

  test('rank v2 flag is read per call, not at module load', async () => {
    delete process.env[RANK_FLAG];
    delete process.env[DOC_FLAG];
    const query = makeMockQuery([]);
    await fetchCanonicalChainRows({ query: 'sunscreen', deps: { query } });
    expect(query.calls[0].sql).toMatch(/THEN 200 ELSE 0 END/);
    process.env[RANK_FLAG] = 'enabled';
    await fetchCanonicalChainRows({ query: 'sunscreen', deps: { query } });
    expect(query.calls[1].sql).toMatch(/THEN 120 ELSE 0 END/);
    expect(query.calls[1].sql).not.toMatch(/THEN 200 ELSE 0 END/);
  });

  test('__internal.buildSignificantTokens matches the tokenMatch lane rules', () => {
    expect(__internal.buildSignificantTokens('hair butter for damaged hair')).toEqual([
      'hair', 'butter', 'damaged',
    ]);
    expect(__internal.buildSignificantTokens('vitamin c serum')).toEqual(['vitamin', 'serum']);
    expect(__internal.buildSignificantTokens('bb')).toEqual([]);
  });

  test('__internal.isRankV2Enabled honors enabled/on/1/true only', () => {
    for (const v of ['enabled', 'on', '1', 'true', ' TRUE ']) {
      expect(__internal.isRankV2Enabled({ CANONICAL_CATALOG_RANK_V2: v })).toBe(true);
    }
    for (const v of ['', '0', 'false', 'off', 'disabled', 'yes-ish', undefined]) {
      expect(__internal.isRankV2Enabled({ CANONICAL_CATALOG_RANK_V2: v })).toBe(false);
    }
  });
});

describe('__internal.buildRecallDocMatchPatterns', () => {
  const build = (q) => __internal.buildRecallDocMatchPatterns(q);

  test('phrase + adjacent bigrams + significant long tokens, all %-wrapped', () => {
    expect(build('vitamin c serum')).toEqual([
      '%vitamin c serum%',
      '%vitamin c%',
      '%c serum%',
      '%vitamin%',
      '%serum%',
    ]);
  });

  test('lowercases and trims input', () => {
    expect(build('  Vitamin C SERUM ')).toEqual(build('vitamin c serum'));
    for (const p of build('Fenty GLOSS Bomb')) {
      expect(p).toBe(p.toLowerCase());
    }
  });

  test('single-token query emits just the phrase pattern (deduped)', () => {
    expect(build('lipstick')).toEqual(['%lipstick%']);
  });

  test('tokens shorter than 4 chars and stopwords are excluded from single-token patterns', () => {
    const patterns = build('best gel for dry skin');
    // "best"/"for" are stopwords, "gel"/"dry" are < 4 chars, "skin" qualifies.
    expect(patterns).toContain('%skin%');
    expect(patterns).not.toContain('%best%');
    expect(patterns).not.toContain('%for%');
    expect(patterns).not.toContain('%gel%');
    expect(patterns).not.toContain('%dry%');
    // Bigrams stay verbatim over the raw token sequence (LIKE needs contiguity).
    expect(patterns).toContain('%best gel%');
    expect(patterns).toContain('%gel for%');
    expect(patterns).toContain('%for dry%');
    expect(patterns).toContain('%dry skin%');
  });

  test('caps at RECALL_DOC_PATTERN_CAP patterns', () => {
    const longQuery = Array.from({ length: 30 }, (_, i) => `ingredient${i}`).join(' ');
    const patterns = build(longQuery);
    expect(patterns.length).toBe(__internal.RECALL_DOC_PATTERN_CAP);
    expect(__internal.RECALL_DOC_PATTERN_CAP).toBe(16);
  });

  test('empty / null query -> []', () => {
    expect(build('')).toEqual([]);
    expect(build('   ')).toEqual([]);
    expect(build(null)).toEqual([]);
    expect(build(undefined)).toEqual([]);
  });
});
