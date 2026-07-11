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
});
