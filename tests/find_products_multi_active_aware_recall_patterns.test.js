'use strict';

// Phase 2 WS2c recall patterns + WS2b fast-lane SQL arms, both gated by
// PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED. Locks in: query-named actives become
// standalone %token% patterns (so "soy firming cream" recalls on %soy%), benefit
// concepts stay rank-only, and the fast lane matches
// derived.recall.{ingredient_tokens,alias_tokens} ONLY when the flag is on.

const SERVER_PATH = require.resolve('../src/server.js');

function loadServer(flags = {}, { dbMock = null } = {}) {
  // DATABASE_URL: queryBeautyExternalSeedRowsFast fail-closes to empty without
  // it — the db module is mocked, so a dummy value is safe (same idiom as the
  // invoke integration tests).
  const env = dbMock ? { DATABASE_URL: 'postgres://test', ...flags } : { ...flags };
  const KEYS = ['PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED', 'DATABASE_URL'];
  let mod;
  jest.isolateModules(() => {
    if (dbMock) jest.doMock('../src/db', () => dbMock);
    const prev = {};
    for (const key of KEYS) {
      prev[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      mod = require(SERVER_PATH);
    } finally {
      for (const key of KEYS) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });
  return mod._debug;
}

describe('buildBeautyExternalSeedRecallPatterns — WS2c active tokenization', () => {
  const intent = { families: [], normalized: '', brandBrowse: null, safety: [] };

  test('flag ON: pushes the named active surface forms as standalone patterns', () => {
    const { buildBeautyExternalSeedRecallPatterns: build } = loadServer({
      PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: 'true',
    });
    const patterns = build({ queryText: 'niacinamide serum for dark spots', intent });
    expect(patterns).toContain('%niacinamide%');
    expect(patterns).toContain('%nicotinamide%');
    expect(patterns.length).toBeLessThanOrEqual(14);
  });

  test('flag ON: "soy firming cream" pushes soy surface forms', () => {
    const { buildBeautyExternalSeedRecallPatterns: build } = loadServer({
      PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: 'true',
    });
    const patterns = build({ queryText: 'soy firming cream', intent });
    expect(patterns.some((p) => p.includes('soy'))).toBe(true);
  });

  test('flag ON: benefit-only queries push NO ingredient expansions (concept:true skipped)', () => {
    const { buildBeautyExternalSeedRecallPatterns: build } = loadServer({
      PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: 'true',
    });
    const withFlag = build({ queryText: 'brightening dark spot care', intent });
    const { buildBeautyExternalSeedRecallPatterns: buildOff } = loadServer({});
    const withoutFlag = buildOff({ queryText: 'brightening dark spot care', intent });
    // brightening is concept:true — its ingredient surface forms (vitamin c,
    // arbutin, ...) must NOT be pushed as recall patterns.
    expect(withFlag).toEqual(withoutFlag);
  });

  test('flag OFF (default): output identical to baseline', () => {
    const { buildBeautyExternalSeedRecallPatterns: buildOff } = loadServer({});
    const { buildBeautyExternalSeedRecallPatterns: buildFalse } = loadServer({
      PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: 'false',
    });
    const q = 'niacinamide serum for dark spots';
    expect(buildOff({ queryText: q, intent })).toEqual(buildFalse({ queryText: q, intent }));
    expect(buildOff({ queryText: q, intent })).not.toContain('%nicotinamide%');
  });

  test('active patterns take priority over trailing expansions under the 14-cap', () => {
    const { buildBeautyExternalSeedRecallPatterns: build } = loadServer({
      PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: 'true',
    });
    // A query naming two actives — both must survive the cap.
    const patterns = build({ queryText: 'niacinamide retinol night serum', intent });
    expect(patterns).toContain('%niacinamide%');
    expect(patterns).toContain('%retinol%');
    expect(patterns.length).toBeLessThanOrEqual(14);
  });
});

describe('queryBeautyExternalSeedRowsFast — WS2b gated ingredient/alias token SQL arms', () => {
  function makeDbMock() {
    const calls = [];
    return {
      calls,
      mock: {
        query: jest.fn(async (sql, params) => {
          calls.push({ sql: String(sql), params });
          return { rows: [] };
        }),
        withClient: jest.fn(async (fn) =>
          fn({
            query: async (sql, params) => {
              calls.push({ sql: String(sql), params });
              return { rows: [] };
            },
          }),
        ),
      },
    };
  }

  async function capturedSeedSql(flags) {
    const db = makeDbMock();
    const dbg = loadServer(flags, { dbMock: db.mock });
    // DATABASE_URL is read at CALL time (fail-closed guard), not module load —
    // keep it set for the duration of the call.
    const prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://test';
    try {
      await dbg.queryBeautyExternalSeedRowsFast({
        market: 'US',
        queryText: 'niacinamide serum for dark spots',
        intent: { families: [], normalized: 'niacinamide serum for dark spots', brandBrowse: null, safety: [] },
        inStockOnly: false,
        limit: 20,
        toolScope: 'all_tools',
      });
    } finally {
      if (prevDbUrl == null) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDbUrl;
    }
    return db.calls
      .map((c) => c.sql)
      .filter((sql) => sql.includes('FROM external_product_seeds'))
      .join('\n---\n');
  }

  test('flag ON: SQL matches derived.recall ingredient_tokens + alias_tokens', async () => {
    const sql = await capturedSeedSql({ PIVOT_BEAUTY_ACTIVE_AWARE_RECALL_ENABLED: 'true' });
    expect(sql).toContain("seed_data#>>'{derived,recall,ingredient_tokens}'");
    expect(sql).toContain("seed_data#>>'{derived,recall,alias_tokens}'");
  });

  test('flag OFF: the token arms are absent (SQL clause unchanged)', async () => {
    const sql = await capturedSeedSql({});
    expect(sql).toContain('FROM external_product_seeds'); // sanity: lane ran
    expect(sql).not.toContain("{derived,recall,ingredient_tokens}");
    expect(sql).not.toContain("{derived,recall,alias_tokens}");
  });

  test('attached serving filter uses the index-matching coalesce predicate', async () => {
    const sql = await capturedSeedSql({});
    if (sql.includes('attached_product_key')) {
      expect(sql).toContain("coalesce(attached_product_key, '') <> ''");
      expect(sql).not.toContain('attached_product_key IS NOT NULL');
    }
  });
});
