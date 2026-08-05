jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: jest.fn(async () => {}),
}));

const db = require('../../src/db');

const {
  CONFIRM_TOKEN,
  COHORT_SQL,
  assertWriteConfirmed,
  blockReasonFor,
  fetchCohort,
  archiveBatch,
  run,
} = require('../../scripts/archive-stranded-external-seed-mirrors.cjs');

function safeRow(overrides = {}) {
  return {
    product_key: 'prod::external_seed::external_seed::ext_a',
    content_key: 'ck_shared',
    title: 'Boox Page',
    sync_status: 'live',
    canonical_key: 'prod::merch_x::shopify::1',
    canonical_exists: true,
    canonical_sync_status: 'live',
    canonical_content_key: 'ck_shared',
    canonical_title: 'Boox Page',
    ...overrides,
  };
}

describe('blockReasonFor (duplicate-proof guards)', () => {
  test('passes a row whose canonical is live and shares content_key + title', () => {
    expect(blockReasonFor(safeRow())).toBeNull();
  });

  test('title comparison ignores case and surrounding whitespace', () => {
    expect(blockReasonFor(safeRow({ title: '  boox PAGE ' }))).toBeNull();
  });

  test('blocks when the canonical row is missing or not live', () => {
    expect(blockReasonFor(safeRow({ canonical_exists: false }))).toBe('canonical_missing');
    expect(blockReasonFor(safeRow({ canonical_sync_status: 'archived' }))).toBe('canonical_not_live');
  });

  test('blocks when content_key differs — the duplicate proof', () => {
    expect(blockReasonFor(safeRow({ canonical_content_key: 'ck_other' }))).toBe('content_key_mismatch');
  });

  test('blocks when the stranded row has no content_key at all', () => {
    expect(blockReasonFor(safeRow({ content_key: null, canonical_content_key: null })))
      .toBe('content_key_mismatch');
  });

  test('blocks when titles disagree', () => {
    expect(blockReasonFor(safeRow({ canonical_title: 'Something Else' }))).toBe('title_mismatch');
  });

  test('is null-safe on garbage input', () => {
    expect(() => blockReasonFor(null)).not.toThrow();
    expect(blockReasonFor(null)).toBe('canonical_missing');
  });
});

describe('cohort SQL', () => {
  test('selects only live external_referral rows with no active seed back-pointer', () => {
    expect(COHORT_SQL).toContain(`cp.catalog_track = 'external_referral'`);
    expect(COHORT_SQL).toContain(`cp.sync_status = 'live'`);
    expect(COHORT_SQL).toContain('NOT EXISTS');
    expect(COHORT_SQL).toContain('a.attached_product_key = cp.product_key');
    // The seed must itself be active and re-pointed somewhere else.
    expect(COHORT_SQL).toContain(`eps.status = 'active'`);
    expect(COHORT_SQL).toContain(`coalesce(eps.attached_product_key, '') NOT IN ('', cp.product_key)`);
  });

  test('domain and limit filters are parameterized, not interpolated', async () => {
    db.query.mockClear();
    await fetchCohort({ domain: 'Example.COM', limit: 25 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(params).toEqual(['example.com', 25]);
  });
});

describe('archiveBatch', () => {
  beforeEach(() => db.query.mockClear());

  test('re-asserts the cohort predicate so stale rows are skipped, and never touches the index', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 2 });
    const landed = await archiveBatch(['k1', 'k2']);
    expect(landed).toBe(2);

    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain(`SET sync_status = 'archived'`);
    // Guards repeated inside the UPDATE, not trusted from the SELECT.
    expect(sql).toContain(`cp.sync_status = 'live'`);
    expect(sql).toContain(`cp.catalog_track = 'external_referral'`);
    expect(sql).toContain('NOT EXISTS');
    // index_pipeline_state is keyed on the SHARED content_key and belongs to
    // the surviving canonical row — touching it would de-index the survivor.
    expect(sql).not.toMatch(/index_pipeline_state/i);
    expect(sql).not.toMatch(/serving_eligible/i);
  });

  test('writes nothing when the batch is empty', async () => {
    await expect(archiveBatch([])).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('write confirm gate', () => {
  beforeEach(() => {
    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  test('write intent without the exact token throws before any db access', async () => {
    await expect(run({ write: true, batchSize: 10 })).rejects.toThrow(
      `Refusing write without --confirm ${CONFIRM_TOKEN}`,
    );
    await expect(run({ write: true, confirm: 'nope', batchSize: 10 })).rejects.toThrow(/Refusing write/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('assertWriteConfirmed is the shared gate', () => {
    expect(() => assertWriteConfirmed({ write: true })).toThrow(/Refusing write/);
    expect(() => assertWriteConfirmed({ write: true, confirm: CONFIRM_TOKEN })).not.toThrow();
    expect(() => assertWriteConfirmed({ write: false })).not.toThrow();
  });
});

describe('run() partitioning', () => {
  test('dry-run reports eligible vs blocked and issues no UPDATE', async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [
        safeRow({ product_key: 'k_ok' }),
        safeRow({ product_key: 'k_bad_ck', canonical_content_key: 'ck_other' }),
        safeRow({ product_key: 'k_dead_canon', canonical_sync_status: 'archived' }),
      ],
    });

    const result = await run({ write: false, batchSize: 10 });
    expect(result.counters).toEqual({
      cohort_rows: 3,
      eligible_rows: 1,
      blocked_rows: 2,
      archived_rows: 0,
    });
    expect(result.by_block_reason).toEqual({ content_key_mismatch: 1, canonical_not_live: 1 });
    expect(result.sample[0].product_key).toBe('k_ok');
    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toContain('UPDATE catalog_products');
    }
  });

  test('write mode archives only eligible rows, in batches', async () => {
    db.query.mockReset();
    db.query.mockResolvedValueOnce({
      rows: [
        safeRow({ product_key: 'k1' }),
        safeRow({ product_key: 'k2' }),
        safeRow({ product_key: 'k3', canonical_title: 'Different' }),
      ],
    });
    db.query.mockResolvedValue({ rowCount: 1 });

    const result = await run({ write: true, confirm: CONFIRM_TOKEN, batchSize: 1 });
    expect(result.counters.eligible_rows).toBe(2);
    expect(result.counters.blocked_rows).toBe(1);
    // batchSize 1 -> two separate UPDATE calls, each landing 1
    expect(result.counters.archived_rows).toBe(2);

    const updateCalls = db.query.mock.calls.filter(([sql]) => sql.includes('UPDATE catalog_products'));
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0][1]).toEqual([['k1']]);
    expect(updateCalls[1][1]).toEqual([['k2']]);
  });
});
