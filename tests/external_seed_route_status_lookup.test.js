// fetchExternalSeedRouteStatusFromDb answers "what is this ext_ seed's status?"
// for get_pdp_v2's seed-status precheck. It must find NON-active seeds (that is
// its whole job), so it cannot simply add `status = 'active'` to use migration
// 040's partial indexes. It now asks twice per match clause — active rows with
// index-guarded arms, then non-active rows — and must give the same answer the
// single unfiltered statement gave: first clause with any row wins; within a
// clause active beats non-active, then recency, then id.

jest.mock('../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) => fn({ query: jest.fn() })),
}));

const ORIGINAL_ENV = process.env;
const norm = (sql) => String(sql || '').replace(/\s+/g, ' ').trim();

function loadServer() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://127.0.0.1:9',
    PIVOTA_API_KEY: 'test-token',
  };
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  return { lookup: app._debug.fetchExternalSeedRouteStatusFromDb, db };
}

// A tiny external_product_seeds: evaluates the statement's status filter and
// match clause the way Postgres would, so the test checks answers, not strings.
function installTable(db, rows) {
  const sent = [];
  db.query.mockImplementation(async (sql, params) => {
    const text = norm(sql);
    sent.push(text);
    if (!text.includes('FROM external_product_seeds')) return { rows: [] };
    const id = params[0];
    const activeOnly = text.includes("WHERE status = 'active'");
    const inactiveOnly = text.includes("WHERE status IS DISTINCT FROM 'active'");
    const sd = (r) => r.seed_data || {};
    const matches = (r) => {
      if (text.includes('AND external_product_id = $1')) return r.external_product_id === id;
      if (text.includes('AND id::text = $1')) return String(r.id) === id;
      return (
        sd(r).external_product_id === id ||
        sd(r).product_id === id ||
        (sd(r).snapshot || {}).product_id === id
      );
    };
    const hit = rows
      .filter((r) => (activeOnly ? r.status === 'active' : inactiveOnly ? r.status !== 'active' : true))
      .filter(matches)
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0) || String(a.id).localeCompare(String(b.id)));
    return { rows: hit.slice(0, 1) };
  });
  return sent;
}

describe('fetchExternalSeedRouteStatusFromDb', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  test('a full miss asks active-then-non-active per clause, with guarded seed_data arms', async () => {
    const { lookup, db } = loadServer();
    const sent = installTable(db, []);

    await expect(lookup({ productId: 'ext_missing' })).resolves.toBeNull();

    const seedSql = sent.filter((sql) => sql.includes('FROM external_product_seeds'));
    expect(seedSql).toHaveLength(6);
    expect(seedSql.map((sql) => sql.includes("WHERE status = 'active'"))).toEqual([true, false, true, false, true, false]);
    // Active step: guarded arms, so migration 040's partial indexes apply.
    const [activeJson, nonActiveJson] = seedSql.slice(4);
    expect(activeJson).toContain("seed_data ? 'external_product_id' AND seed_data->>'external_product_id' = $1");
    expect(activeJson).toContain("seed_data ? 'product_id' AND seed_data->>'product_id' = $1");
    expect(activeJson).toContain("seed_data ? 'snapshot' AND seed_data->'snapshot'->>'product_id' = $1");
    // Non-active step: no index can serve it, so no guards (they only double the
    // detoast work), but the very same three paths.
    expect(nonActiveJson).not.toContain('seed_data ?');
    expect(nonActiveJson).toContain(
      "(seed_data->>'external_product_id' = $1 OR seed_data->>'product_id' = $1 OR seed_data->'snapshot'->>'product_id' = $1)",
    );
    for (const sql of seedSql) expect(sql).toMatch(/ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id LIMIT 1$/);
  });

  test('finds an INACTIVE seed through seed_data (its job)', async () => {
    const { lookup, db } = loadServer();
    installTable(db, [{ id: 'eps_1', external_product_id: 'other', status: 'paused', seed_data: { product_id: 'ext_a' } }]);

    await expect(lookup({ productId: 'ext_a' })).resolves.toEqual(
      expect.objectContaining({ external_seed_id: 'eps_1', status: 'paused' }),
    );
  });

  test('clause precedence is unchanged: an inactive exact match beats an active seed_data match', async () => {
    const { lookup, db } = loadServer();
    installTable(db, [
      { id: 'eps_exact', external_product_id: 'ext_a', status: 'inactive', updated_at: 1 },
      { id: 'eps_json', external_product_id: 'x', status: 'active', updated_at: 9, seed_data: { product_id: 'ext_a' } },
    ]);

    await expect(lookup({ productId: 'ext_a' })).resolves.toEqual(
      expect.objectContaining({ external_seed_id: 'eps_exact', status: 'inactive' }),
    );
  });

  test('within a clause an active row beats a newer inactive one, and needs one statement', async () => {
    const { lookup, db } = loadServer();
    const sent = installTable(db, [
      { id: 'eps_new_inactive', external_product_id: 'ext_a', status: 'inactive', updated_at: 9 },
      { id: 'eps_old_active', external_product_id: 'ext_a', status: 'active', updated_at: 1 },
    ]);

    await expect(lookup({ productId: 'ext_a' })).resolves.toEqual(
      expect.objectContaining({ external_seed_id: 'eps_old_active', status: 'active' }),
    );
    expect(sent.filter((sql) => sql.includes('FROM external_product_seeds'))).toHaveLength(1);
  });

  test('a NULL status counts as not active, as the old ELSE branch did', async () => {
    const { lookup, db } = loadServer();
    installTable(db, [{ id: 'eps_null', external_product_id: 'ext_a', status: null }]);

    await expect(lookup({ productId: 'ext_a' })).resolves.toEqual(
      expect.objectContaining({ external_seed_id: 'eps_null', status: null }),
    );
  });
});
