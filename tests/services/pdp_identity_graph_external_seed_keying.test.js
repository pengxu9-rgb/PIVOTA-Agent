// Regression guard for ADR-009 external-seed identity keying.
//
// fetchBackfillProducts must (a) SELECT the catalog row's real merchant_id as
// catalog_merchant_id, and (b) NOT pin the catalog join to the legacy
// 'external_seed' bucket (cp.merchant_id = $1) — otherwise per-brand observed
// sellers (merch_obs_…) never link to their catalog row, pdp_identity_listing
// stays keyed on 'external_seed', the catalog_row_trust join
// (pil.merchant_id = cp.merchant_id) never matches, and observed-seller external
// seeds get no identity_confidence (un-trusted, un-served). Prod-verified on the
// Mojawa pilot (pil re-keyed merch_obs_, trust 0.92, citation deposit fired).

const { _internals } = require('../../src/services/pdpIdentityGraph');
const { fetchBackfillProducts } = _internals;

function makeCapturingQueryFn(captured) {
  return jest.fn(async (sql) => {
    captured.push(String(sql || ''));
    // Column introspection (if any) → advertise the columns fetchBackfillProducts
    // reads; every data query returns no rows so the builder loop is a no-op.
    if (/information_schema\.columns/i.test(String(sql))) {
      return {
        rows: ['merchant_id', 'platform_product_id', 'product_data', 'cached_at']
          .map((column_name) => ({ column_name })),
      };
    }
    return { rows: [] };
  });
}

function externalSeedSql(captured) {
  return captured.find((sql) => /FROM external_product_seeds e/i.test(sql)) || '';
}

describe('fetchBackfillProducts external-seed catalog keying (ADR-009)', () => {
  test('selects the catalog row merchant_id as catalog_merchant_id', async () => {
    const captured = [];
    await fetchBackfillProducts({
      externalProductIds: ['mojawa_us_1'],
      queryFn: makeCapturingQueryFn(captured),
    });
    const sql = externalSeedSql(captured);
    expect(sql).toMatch(/FROM external_product_seeds e/i);
    expect(sql).toMatch(/cp\.merchant_id\s+AS\s+catalog_merchant_id/i);
  });

  test('does NOT pin the catalog join to the legacy external_seed bucket', async () => {
    const captured = [];
    await fetchBackfillProducts({
      externalProductIds: ['mojawa_us_1'],
      queryFn: makeCapturingQueryFn(captured),
    });
    const sql = externalSeedSql(captured);
    // The join keeps product_key + platform, but must not re-introduce the
    // merchant_id = $1 (external_seed) predicate that dropped merch_obs_ rows.
    const joinBlock = sql.slice(sql.indexOf('LEFT JOIN catalog_products cp'));
    expect(joinBlock).toMatch(/cp\.product_key\s*=\s*e\.attached_product_key/i);
    expect(joinBlock).not.toMatch(/cp\.merchant_id\s*=\s*\$1/i);
  });

  // Behavioral guard for the load-bearing line: the emitted identity row must be
  // keyed on the catalog row's real seller (catalog_merchant_id), with the legacy
  // bucket only as the null fallback. Returns one external_product_seeds row so
  // the builder loop actually runs (the SQL-shape tests above no-op the loop).
  function seedRow(overrides) {
    return {
      id: 'external_brand_crawl::mojawa_us_1',
      external_product_id: 'mojawa_us_1',
      title: 'Mojawa Purra Run Bone Conduction Headphones',
      domain: 'mojawa.com',
      destination_url: 'https://mojawa.com/products/purra-run',
      canonical_url: 'https://mojawa.com/products/purra-run',
      seed_data: { snapshot: { title: 'Mojawa Purra Run', brand: 'Mojawa' }, brand: 'Mojawa' },
      attached_product_key: 'prod::merch_obs_abc::external_seed::mojawa_us_1',
      ...overrides,
    };
  }
  function queryFnReturning(rows) {
    return jest.fn(async (sql) => {
      if (/information_schema\.columns/i.test(String(sql))) {
        return { rows: ['merchant_id', 'platform_product_id', 'product_data', 'cached_at'].map((column_name) => ({ column_name })) };
      }
      if (/FROM external_product_seeds e/i.test(String(sql))) return { rows };
      return { rows: [] };
    });
  }

  test('keys the emitted identity row on catalog_merchant_id (the observed seller)', async () => {
    const out = await fetchBackfillProducts({
      externalProductIds: ['mojawa_us_1'],
      queryFn: queryFnReturning([seedRow({ catalog_merchant_id: 'merch_obs_abc' })]),
    });
    const row = out.find((r) => r.product_id === 'mojawa_us_1' && r.source_kind === 'external_seed');
    expect(row).toBeTruthy();
    expect(row.merchant_id).toBe('merch_obs_abc');
  });

  test('falls back to external_seed when the seed has no catalog row', async () => {
    const out = await fetchBackfillProducts({
      externalProductIds: ['mojawa_us_1'],
      queryFn: queryFnReturning([seedRow({ catalog_merchant_id: null, attached_product_key: null })]),
    });
    const row = out.find((r) => r.product_id === 'mojawa_us_1' && r.source_kind === 'external_seed');
    expect(row).toBeTruthy();
    expect(row.merchant_id).toBe('external_seed');
  });
});
