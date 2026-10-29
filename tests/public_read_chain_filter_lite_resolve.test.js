'use strict';

// The public-search chain filter reads only the exact signature row's own columns, so it resolves each row
// in the 'lite' shape: same verdict, without the identity-listing and identity-group follow-up queries the
// default 'rich' shape issues per row.

const ORIGINAL_ENV = process.env;
const SIG = 'sig_5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

function exactSeedRow(overrides = {}) {
  return {
    merchant_id: 'external_seed',
    platform: 'external_seed',
    source_product_id: 'ext_synthetic_1',
    product_key: 'prod::external_seed::external_seed::ext_synthetic_1',
    source_system: 'external_product_seeds_mirror_v1',
    pivota_signature_id: SIG,
    external_seed_id: 101,
    external_seed_external_product_id: 'ext_synthetic_1',
    external_seed_status: 'active',
    external_seed_route_lane: 0,
    ...overrides,
  };
}

function loadServer(exactRow, envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '2000',
    ...envOverrides,
  };
  const seenSql = [];
  const query = jest.fn(async (sql) => {
    const text = String(sql);
    seenSql.push(text);
    if (text.includes('cp.pivota_signature_id = $1')) return { rows: exactRow ? [exactRow] : [] };
    // An approved identity listing, so the rich shape goes on to fetch the group.
    if (text.includes('FROM pdp_identity_listing pil')) {
      return { rows: [{ sellable_item_group_id: 'sig_group_synthetic', identity_status: 'approved', live_read_enabled: true }] };
    }
    return { rows: [] };
  });
  jest.doMock('../src/db', () => ({
    query,
    queryWithStatementTimeout: query,
    withClient: jest.fn(),
    getPool: jest.fn(() => ({})),
    closePool: jest.fn(),
  }));
  // eslint-disable-next-line global-require
  return { app: require('../src/server'), seenSql };
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('public-read chain filter resolves rows in the lite shape', () => {
  test.each([
    ['active seed (kept)', exactSeedRow(), 0],
    ['inactive seed (provably dead, dropped)', exactSeedRow({ external_seed_status: 'inactive' }), 1],
    ['no seed behind a seed-routed row (dropped)', exactSeedRow({ external_seed_id: null, external_seed_status: null }), 1],
  ])('%s: same verdict as the rich shape, from the exact query alone', async (_label, row, expectedDropped) => {
    const lite = loadServer(row);
    const liteResult = await lite.app._debug.filterPublicReadChainResolvableRows([{ product_id: SIG }]);
    const rich = loadServer(row, { PUBLIC_READ_CHAIN_FILTER_LITE_RESOLVE: 'false' });
    const richResult = await rich.app._debug.filterPublicReadChainResolvableRows([{ product_id: SIG }]);

    expect(liteResult.droppedCount).toBe(expectedDropped);
    expect(richResult.droppedCount).toBe(expectedDropped);
    expect(lite.seenSql.some((sql) => sql.includes('FROM pdp_identity_listing pil'))).toBe(false);
    expect(lite.seenSql.length).toBeLessThan(rich.seenSql.length);
  });

  test('the rich shape (kill switch) still issues the identity follow-ups it always did', async () => {
    const rich = loadServer(exactSeedRow(), { PUBLIC_READ_CHAIN_FILTER_LITE_RESOLVE: 'false' });
    await rich.app._debug.filterPublicReadChainResolvableRows([{ product_id: SIG }]);
    expect(rich.seenSql.some((sql) => sql.includes('FROM pdp_identity_listing pil'))).toBe(true);
  });
});
