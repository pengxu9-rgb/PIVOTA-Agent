jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: jest.fn(async () => {}),
}));

const db = require('../../src/db');

const {
  CONFIRM_TOKEN,
  DEFAULT_BATCH_SIZE,
  ALIAS_BUNDLE_PATHS,
  RECALL_DOC_FIELD_ORDER,
  assertWriteConfirmed,
  buildRecallDocProjection,
  buildDriftPredicateSql,
  normalizeAvailability,
  textOf,
  fetchDriftMetric,
  fetchOrphanedMirrorMetric,
  fetchDriftedBatch,
  landBatch,
  reconcile,
} = require('../../scripts/reconcile-catalog-recall-doc.cjs');

const gapScope = require('../fixtures/adr020_phase1_gap_scope.json');

function fixtureSeedRow() {
  return {
    product_key: 'prod::external_seed::external_seed::ext_fixture1',
    seed_id: 'ext_fixture1',
    title: 'Ginseng Cleansing Oil',
    domain: 'beautyofjoseon.com',
    canonical_url: 'https://beautyofjoseon.com/products/ginseng-cleansing-oil',
    destination_url: 'https://beautyofjoseon.com/products/ginseng-cleansing-oil?ref=x',
    market: 'us',
    tool: 'beauty',
    availability: 'In Stock',
    seed_data: {
      brand: 'Beauty of Joseon',
      derived: {
        recall: {
          retrieval_title: 'Beauty of Joseon Ginseng Cleansing Oil',
          retrieval_summary: 'Lightweight cleansing oil with ginseng seed oil',
          retrieval_body: 'Dissolves sunscreen and makeup without stripping',
          brand: 'Beauty of Joseon',
          category: 'cleansing oil',
          ingredient_tokens: 'ginseng-seed-oil soybean-oil',
          alias_tokens: 'boj cleansing oil',
        },
      },
      snapshot: {
        availability: 'OutOfStock',
        product: {
          search_aliases: ['ginseng oil cleanser', 'BOJ oil'],
        },
        aliases: 'joseon ginseng oil',
      },
    },
  };
}

describe('buildRecallDocProjection (pure doc builder)', () => {
  test('projects every seed-lane searchable field into a lowercased line-per-field doc', () => {
    const projection = buildRecallDocProjection(fixtureSeedRow());

    expect(projection.recall_doc).toBe(projection.recall_doc.toLowerCase());

    const lines = projection.recall_doc.split('\n');
    // One line per field, in migration-057 arm order.
    expect(lines).toHaveLength(RECALL_DOC_FIELD_ORDER.length);
    expect(lines[RECALL_DOC_FIELD_ORDER.indexOf('title')]).toBe('ginseng cleansing oil');
    expect(lines[RECALL_DOC_FIELD_ORDER.indexOf('domain')]).toBe('beautyofjoseon.com');

    // urls
    expect(projection.recall_doc).toContain('https://beautyofjoseon.com/products/ginseng-cleansing-oil');
    expect(projection.recall_doc).toContain('?ref=x');
    // derived.recall retrieval fields
    expect(projection.recall_doc).toContain('lightweight cleansing oil with ginseng seed oil');
    expect(projection.recall_doc).toContain('dissolves sunscreen and makeup without stripping');
    // brand + category chains
    expect(projection.recall_doc).toContain('beauty of joseon');
    expect(projection.recall_doc).toContain('cleansing oil');
    // ingredient tokens
    expect(projection.recall_doc).toContain('ginseng-seed-oil soybean-oil');
    // alias bundle: top-level alias_tokens, nested snapshot.product array items,
    // and snapshot string alias all land on the alias line
    const aliasLine = lines[RECALL_DOC_FIELD_ORDER.indexOf('alias_bundle')];
    expect(aliasLine).toContain('boj cleansing oil');
    expect(aliasLine).toContain('ginseng oil cleanser');
    expect(aliasLine).toContain('boj oil');
    expect(aliasLine).toContain('joseon ginseng oil');
  });

  test('maps market, tool, and availability scoping', () => {
    const projection = buildRecallDocProjection(fixtureSeedRow());
    expect(projection.recall_market).toBe('US');
    expect(projection.recall_tool).toBe('beauty');
    expect(projection.recall_availability).toBe('in_stock');
  });

  test('falls back through seed_data/snapshot for availability when the column is empty', () => {
    const row = fixtureSeedRow();
    row.availability = null;
    // seed_data.availability absent -> snapshot.availability used
    expect(buildRecallDocProjection(row).recall_availability).toBe('out_of_stock');

    row.seed_data.availability = 'Available';
    expect(buildRecallDocProjection(row).recall_availability).toBe('in_stock');
  });

  test('is null-safe on missing or malformed seed_data', () => {
    expect(() => buildRecallDocProjection(null)).not.toThrow();
    expect(() => buildRecallDocProjection({})).not.toThrow();

    const minimal = buildRecallDocProjection({
      title: 'Bare Title',
      domain: 'example.com',
      seed_data: null,
    });
    expect(minimal.recall_doc).toContain('bare title');
    expect(minimal.recall_doc).toContain('example.com');
    expect(minimal.recall_doc.split('\n')).toHaveLength(RECALL_DOC_FIELD_ORDER.length);
    expect(minimal.recall_market).toBeNull();
    expect(minimal.recall_tool).toBeNull();
    expect(minimal.recall_availability).toBeNull();

    const garbage = buildRecallDocProjection({ seed_data: 'not-json{{{', market: 'jp' });
    expect(garbage.recall_market).toBe('JP');
    expect(garbage.recall_doc.split('\n')).toHaveLength(RECALL_DOC_FIELD_ORDER.length);
  });

  test('accepts seed_data delivered as a JSON string', () => {
    const row = fixtureSeedRow();
    row.seed_data = JSON.stringify(row.seed_data);
    row.availability = null; // exercise snapshot fallback through the parsed string
    const projection = buildRecallDocProjection(row);
    expect(projection.recall_doc).toContain('boj cleansing oil');
    expect(projection.recall_availability).toBe('out_of_stock');
  });

  test('alias bundle covers all 13 seed-lane alias paths', () => {
    expect(ALIAS_BUNDLE_PATHS).toHaveLength(13);
    const joined = ALIAS_BUNDLE_PATHS.map((p) => p.join('.'));
    expect(joined).toContain('derived.recall.alias_tokens');
    expect(joined).toContain('snapshot.product.search_aliases');
    expect(joined).toContain('snapshot.product.searchAliases');
    expect(joined).toContain('snapshot.product.aliases');
  });
});

describe('textOf / normalizeAvailability helpers', () => {
  test('textOf flattens arrays and tolerates odd shapes', () => {
    expect(textOf(['a', ['b', 'c'], null, 'd'])).toBe('a b c d');
    expect(textOf('plain')).toBe('plain');
    expect(textOf(42)).toBe('42');
    expect(textOf(null)).toBe('');
    expect(textOf({ k: 'v' })).toBe('{"k":"v"}');
  });

  test('normalizeAvailability mirrors normalizeSeedAvailability', () => {
    expect(normalizeAvailability('In Stock')).toBe('in_stock');
    expect(normalizeAvailability('instock')).toBe('in_stock');
    expect(normalizeAvailability('OOS')).toBe('out_of_stock');
    expect(normalizeAvailability('preorder')).toBe('preorder');
    expect(normalizeAvailability('')).toBeNull();
    expect(normalizeAvailability(undefined)).toBeNull();
  });
});

describe('drift predicate SQL builder', () => {
  test('flags never-projected and stale rows against the seed clock', () => {
    const sql = buildDriftPredicateSql('cp', 'eps');
    expect(sql).toContain('cp.recall_doc IS NULL');
    expect(sql).toContain('cp.recall_doc_updated_at IS NULL');
    expect(sql).toContain('cp.recall_doc_updated_at < eps.updated_at');
  });

  test('respects custom aliases', () => {
    const sql = buildDriftPredicateSql('p', 's');
    expect(sql).toContain('p.recall_doc IS NULL');
    expect(sql).toContain('p.recall_doc_updated_at < s.updated_at');
  });
});

describe('landBatch convergence stamp', () => {
  beforeEach(() => {
    db.query.mockClear();
  });

  test('stamps recall_doc_updated_at from the seed clock observed at select time, never now()', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const seedTs = new Date('2026-07-30T01:02:03Z');
    const landed = await landBatch([
      {
        product_key: 'prod::external_seed::external_seed::ext_a',
        seed_updated_at: seedTs,
        projection: {
          recall_doc: 'doc a',
          recall_market: 'US',
          recall_tool: 'beauty',
          recall_availability: 'in_stock',
        },
      },
      {
        product_key: 'prod::external_seed::external_seed::ext_b',
        seed_updated_at: null, // seed with no clock -> COALESCE(now()) in SQL
        projection: {
          recall_doc: 'doc b',
          recall_market: null,
          recall_tool: null,
          recall_availability: null,
        },
      },
    ]);

    expect(landed).toBe(1);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];

    // The stamp must come from the observed seed clock so a seed updated
    // between SELECT and UPDATE stays drift-flagged (convergence guarantee).
    expect(sql).toContain('recall_doc_updated_at = COALESCE(d.seed_updated_at, now())');
    expect(sql).not.toMatch(/recall_doc_updated_at\s*=\s*now\(\)/);
    expect(sql).toContain('unnest($6::timestamptz[]) AS seed_updated_at');

    expect(params).toHaveLength(6);
    expect(params[5]).toEqual([seedTs, null]);
  });

  test('lands nothing without touching the db when the batch is empty', async () => {
    await expect(landBatch([])).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('script conventions', () => {
  test('write path is gated behind an explicit confirm token', () => {
    expect(CONFIRM_TOKEN).toBe('RECONCILE_CATALOG_RECALL_DOC_PROJECTION');
    expect(DEFAULT_BATCH_SIZE).toBe(200);
  });
});

describe('reconcile() write confirm gate', () => {
  beforeEach(() => {
    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  test('write intent without the confirm token throws before any db access', async () => {
    await expect(reconcile({ write: true, batchSize: 5, maxRows: 5 })).rejects.toThrow(
      `Refusing write without --confirm ${CONFIRM_TOKEN}`,
    );
    await expect(
      reconcile({ write: true, confirm: 'WRONG_TOKEN', batchSize: 5, maxRows: 5 }),
    ).rejects.toThrow(`--confirm ${CONFIRM_TOKEN}`);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('proceeds when --write carries the exact confirm token', async () => {
    const result = await reconcile({
      write: true,
      confirm: CONFIRM_TOKEN,
      batchSize: 5,
      maxRows: 5,
    });
    expect(result.counters.rows_scanned).toBe(0);
    expect(result.counters.updates_landed).toBe(0);
    expect(db.query).toHaveBeenCalled(); // reached the batch fetch past the gate
  });

  test('dry-run needs no token and never writes', async () => {
    const result = await reconcile({ write: false, batchSize: 5, maxRows: 5 });
    expect(result.counters.updates_landed).toBe(0);
    // Only the drifted-batch SELECT ran; no UPDATE landed.
    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toContain('UPDATE catalog_products');
    }
  });

  test('assertWriteConfirmed is the shared gate', () => {
    expect(() => assertWriteConfirmed({ write: true })).toThrow(/Refusing write/);
    expect(() => assertWriteConfirmed({ write: true, confirm: CONFIRM_TOKEN })).not.toThrow();
    expect(() => assertWriteConfirmed({ write: false })).not.toThrow();
  });
});

describe('seed clock precision round-trip', () => {
  test('batch SELECT reads eps.updated_at::text so microseconds survive the JS Date round-trip', async () => {
    // Regression: node-pg parses bare timestamptz into a ms-precision JS Date;
    // stamping that back left recall_doc_updated_at up to 999µs behind
    // eps.updated_at, re-flagging every row forever (prod 2026-07-31:
    // 10,579/10,579 "stale", max_staleness 999µs).
    db.query.mockClear();
    await fetchDriftedBatch({ batchSize: 5, offset: 0 });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain('eps.updated_at::text AS seed_updated_at');
    expect(sql).not.toMatch(/eps\.updated_at AS seed_updated_at/);
  });
});

describe('orphaned mirror metric', () => {
  beforeEach(() => {
    db.query.mockClear();
  });

  test('counts external_referral rows with no ACTIVE attached seed, split by live sync_status', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ orphaned_mirror_count: 1963, orphaned_mirror_live_count: 1925 }],
    });
    await expect(fetchOrphanedMirrorMetric()).resolves.toEqual({
      orphaned_mirror_count: 1963,
      orphaned_mirror_live_count: 1925,
    });

    const sql = db.query.mock.calls[0][0];
    // Anti-join over the same back-pointer the reconciler projects through:
    // a row only counts as orphaned when no active seed carries its key.
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('eps.attached_product_key = cp.product_key');
    expect(sql).toContain(`eps.status = 'active'`);
    expect(sql).toContain(`cp.catalog_track = 'external_referral'`);
    expect(sql).toContain(`cp.sync_status = 'live'`);
  });

  test('is null-safe on an empty result', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(fetchOrphanedMirrorMetric()).resolves.toEqual({
      orphaned_mirror_count: 0,
      orphaned_mirror_live_count: 0,
    });
  });

  test('fetchDriftMetric folds the orphan counters into the drift report', async () => {
    // Orphans sit outside the attached-seed lateral join, so drift_total can
    // read 0 while unprojectable rows exist — the folded counters make the
    // --drift-only report surface that class (prod 2026-07-31: 3 gap-scope
    // acceptance products were orphaned while drift_total showed 0).
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            attached_rows_total: 10579,
            recall_doc_null: 0,
            recall_doc_stale: 0,
            drift_total: 0,
            max_staleness: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ orphaned_mirror_count: 1963, orphaned_mirror_live_count: 1925 }],
      });

    const metric = await fetchDriftMetric();
    expect(metric).toEqual({
      attached_rows_total: 10579,
      recall_doc_null: 0,
      recall_doc_stale: 0,
      drift_total: 0,
      converged_pct: 100,
      max_staleness: null,
      orphaned_mirror_count: 1963,
      orphaned_mirror_live_count: 1925,
    });
  });
});

describe('phase 1 acceptance corpus fixture', () => {
  test('carries the 15 gap queries / 71 unique products measured 2026-07-30', () => {
    expect(gapScope.gap_query_count).toBe(15);
    expect(gapScope.gap_queries).toHaveLength(15);
    const ids = new Set();
    for (const q of gapScope.gap_queries) {
      expect(Array.isArray(q.only_in_seed)).toBe(true);
      for (const p of q.only_in_seed) ids.add(p.external_product_id);
    }
    expect(ids.size).toBe(71);
    expect(gapScope.source).toContain('audit-recall-lane-parity.cjs');
  });
});
