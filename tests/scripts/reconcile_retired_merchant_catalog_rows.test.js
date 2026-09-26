jest.mock('../../src/db', () => ({
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  closePool: jest.fn(async () => {}),
}));

const db = require('../../src/db');

const {
  ACTIVE_MERCHANT_STATUSES,
  CONFIRM_TOKEN,
  COHORT_SQL,
  retiredMerchantSql,
  assertWriteConfirmed,
  blockReasonFor,
  summarizeByMerchant,
  fetchCohort,
  fetchIndexableDrift,
  archiveBatch,
  clearIndexableBatch,
  run,
} = require('../../scripts/reconcile-retired-merchant-catalog-rows.cjs');

function safeRow(overrides = {}) {
  return {
    product_key: 'prod::merch_bbd34645bc1950cc::shopify::8410761658554',
    merchant_id: 'merch_bbd34645bc1950cc',
    catalog_track: 'internal_merchant',
    source_domain: 'pivota-review-demo.myshopify.com',
    title: 'Selling Plans Ski Wax',
    sync_status: 'live',
    suppression_reason: null,
    merchant_name: 'Shopify App Review',
    merchant_status: 'inactive',
    merchant_indexable: true,
    has_active_store: false,
    serving_decision: 'blocked',
    index_serving_eligible: false,
    ...overrides,
  };
}

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('blockReasonFor (retirement-proof guards)', () => {
  test('passes a live row under a retired merchant with no active store', () => {
    expect(blockReasonFor(safeRow())).toBeNull();
  });

  test('blocks when a merchant_store is still active — the store is the live fact', () => {
    expect(blockReasonFor(safeRow({ has_active_store: true }))).toBe('active_store_exists');
  });

  test('blocks a row that catalog_row_trust says serves today', () => {
    expect(blockReasonFor(safeRow({ serving_decision: 'public' }))).toBe('row_trust_public');
    expect(blockReasonFor(safeRow({ serving_decision: 'PUBLIC' }))).toBe('row_trust_public');
  });

  test('blocks a row whose content is index serving-eligible', () => {
    expect(blockReasonFor(safeRow({ index_serving_eligible: true }))).toBe('index_serving_eligible');
  });

  test('an already-suppressed row is still archivable — suppression is a different axis', () => {
    expect(blockReasonFor(safeRow({ suppression_reason: 'demo_retired_2026_07' }))).toBeNull();
  });

  test('the active-store guard outranks the trust and index guards', () => {
    expect(blockReasonFor(safeRow({
      has_active_store: true,
      serving_decision: 'public',
      index_serving_eligible: true,
    }))).toBe('active_store_exists');
  });

  test('a non-row input never throws its way past the guards', () => {
    expect(blockReasonFor(null)).toBeNull();
    expect(blockReasonFor('nope')).toBeNull();
  });
});

describe('retirement predicate', () => {
  test('active and observed are the only live merchant statuses', () => {
    expect(ACTIVE_MERCHANT_STATUSES).toEqual(['active', 'observed']);
  });

  test('the predicate is case-insensitive and treats NULL status as retired', () => {
    // coalesce to '' rather than to 'active': a merchant row that exists with
    // no status must not default OPEN the way the missing-row case does.
    expect(retiredMerchantSql('cm')).toBe(
      `lower(coalesce(cm.status, '')) NOT IN ('active', 'observed')`,
    );
  });

  test('the cohort joins catalog_merchants rather than outer-joining it', () => {
    // A missing merchant row is the OPPOSITE defect (mint the row, do not
    // archive a real brand's catalog) and must never enter the write path.
    expect(COHORT_SQL).toContain('JOIN catalog_merchants cm');
    expect(COHORT_SQL).not.toContain('LEFT JOIN catalog_merchants cm');
    expect(COHORT_SQL).toContain(`cp.sync_status = 'live'`);
    expect(COHORT_SQL).toContain(retiredMerchantSql('cm'));
  });
});

describe('assertWriteConfirmed', () => {
  test('a dry run needs no token', () => {
    expect(() => assertWriteConfirmed({ write: false, confirm: '' })).not.toThrow();
  });

  test('a write without the exact token is refused', () => {
    expect(() => assertWriteConfirmed({ write: true, confirm: '' })).toThrow(/Refusing write/);
    expect(() => assertWriteConfirmed({ write: true, confirm: 'yes' })).toThrow(/Refusing write/);
    expect(() => assertWriteConfirmed({ write: true, confirm: CONFIRM_TOKEN })).not.toThrow();
  });
});

describe('archiveBatch', () => {
  test('archives to the terminal state and re-asserts the cohort in the UPDATE', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const landed = await archiveBatch(['a', 'b', 'c']);
    expect(landed).toBe(3);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain(`SET sync_status = 'archived'`);
    // Re-assertions: a row that changed between SELECT and UPDATE is skipped.
    expect(sql).toContain(`AND cp.sync_status = 'live'`);
    expect(sql).toContain('EXISTS (');
    expect(sql).toContain(retiredMerchantSql('cm'));
    expect(sql).toContain('NOT EXISTS (');
    expect(sql).toContain(`lower(coalesce(ms.status, '')) = 'active'`);
    expect(params).toEqual([['a', 'b', 'c']]);
  });

  test('an empty batch issues no query', async () => {
    expect(await archiveBatch([])).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('clearIndexableBatch', () => {
  test('only ever writes TRUE -> FALSE on a retired merchant', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const landed = await clearIndexableBatch(['merch_x']);
    expect(landed).toBe(1);

    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain('SET indexable = FALSE');
    expect(sql).toContain('AND cm.indexable IS TRUE');
    expect(sql).toContain(retiredMerchantSql('cm'));
    // Never flips a hold-out bit back on: pdpRenderability documents
    // indexable=false as the only thing keeping 737 rows out of the sitemap.
    expect(sql).not.toContain('indexable = TRUE,');
  });

  test('an empty batch issues no query', async () => {
    expect(await clearIndexableBatch([])).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('fetchIndexableDrift', () => {
  test('selects only the indexable=TRUE-while-retired direction', async () => {
    await fetchIndexableDrift();
    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain('cm.indexable IS TRUE');
    expect(sql).toContain(retiredMerchantSql('cm'));
  });
});

describe('fetchCohort', () => {
  test('scopes to one merchant when asked, and never widens the cohort', async () => {
    await fetchCohort({ merchantId: 'merch_bbd34645bc1950cc', limit: 5 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('AND cp.merchant_id = $1');
    expect(sql).toContain('LIMIT $2');
    expect(params).toEqual(['merch_bbd34645bc1950cc', 5]);
  });
});

describe('summarizeByMerchant', () => {
  test('counts live and unsuppressed rows per merchant, largest first', () => {
    const rows = [
      safeRow({ product_key: 'p1', suppression_reason: 'demo_retired_2026_07' }),
      safeRow({ product_key: 'p2', suppression_reason: null }),
      safeRow({ product_key: 'p3', merchant_id: 'merch_small', merchant_name: 'Small', suppression_reason: null }),
    ];
    expect(summarizeByMerchant(rows)).toEqual([
      {
        merchant_id: 'merch_bbd34645bc1950cc',
        merchant_name: 'Shopify App Review',
        merchant_status: 'inactive',
        merchant_indexable: true,
        live_rows: 2,
        live_unsuppressed_rows: 1,
      },
      {
        merchant_id: 'merch_small',
        merchant_name: 'Small',
        merchant_status: 'inactive',
        merchant_indexable: true,
        live_rows: 1,
        live_unsuppressed_rows: 1,
      },
    ]);
  });
});

describe('run', () => {
  // fetchCohort -> fetchIndexableDrift -> fetchOrphanMerchantDrift, then writes.
  function mockReads({ cohort = [], indexable = [], orphans = [] } = {}) {
    db.query
      .mockResolvedValueOnce({ rows: cohort, rowCount: cohort.length })
      .mockResolvedValueOnce({ rows: indexable, rowCount: indexable.length })
      .mockResolvedValueOnce({ rows: orphans, rowCount: orphans.length });
  }

  test('a dry run reports drift and writes nothing', async () => {
    mockReads({
      cohort: [safeRow({ product_key: 'p1' }), safeRow({ product_key: 'p2', has_active_store: true })],
      indexable: [{ merchant_id: 'merch_bbd34645bc1950cc', merchant_name: 'Shopify App Review', merchant_status: 'inactive' }],
      orphans: [{ merchant_id: 'merch_cf2dbaf5774a524d', live_rows: 13, live_unsuppressed_rows: 11 }],
    });

    const result = await run({ write: false });

    expect(result.counters).toMatchObject({
      cohort_rows: 2,
      eligible_rows: 1,
      blocked_rows: 1,
      archived_rows: 0,
      indexable_drift_merchants: 1,
      indexable_cleared: 0,
      orphan_merchant_live_rows: 13,
      orphan_merchants: 1,
    });
    expect(result.by_block_reason).toEqual({ active_store_exists: 1 });
    // Exactly the three reads, no writes.
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test('--drift-only reports but does not write even with --write and the token', async () => {
    mockReads({
      cohort: [safeRow({ product_key: 'p1' })],
      indexable: [{ merchant_id: 'merch_x', merchant_name: 'X', merchant_status: 'inactive' }],
    });

    const result = await run({ write: true, confirm: CONFIRM_TOKEN, driftOnly: true });

    expect(result.counters.archived_rows).toBe(0);
    expect(result.counters.indexable_cleared).toBe(0);
    expect(result.counters.cohort_rows).toBe(1);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test('a confirmed write archives eligible rows, clears indexable, and refreshes trust', async () => {
    mockReads({
      cohort: [safeRow({ product_key: 'p1' }), safeRow({ product_key: 'p2' })],
      indexable: [{ merchant_id: 'merch_bbd34645bc1950cc', merchant_name: 'Shopify App Review', merchant_status: 'inactive' }],
    });
    db.query
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })  // archiveBatch
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // clearIndexableBatch
    db.query.mockResolvedValue({ rows: [], rowCount: 0 }); // trust refresh reads

    const result = await run({ write: true, confirm: CONFIRM_TOKEN });

    expect(result.counters.archived_rows).toBe(2);
    expect(result.counters.indexable_cleared).toBe(1);
    expect(result.trust_refresh).not.toBeNull();
    expect(result.trust_refresh.path).not.toBe('skipped_empty');
    // The rollback record — an exact undo set, not a re-derivable cohort.
    expect(result.archived_product_keys).toEqual(['p1', 'p2']);
    expect(result.indexable_cleared_merchant_ids).toEqual(['merch_bbd34645bc1950cc']);
  });

  test('a dry run records no rollback keys', async () => {
    mockReads({
      cohort: [safeRow({ product_key: 'p1' })],
      indexable: [{ merchant_id: 'merch_x', merchant_name: 'X', merchant_status: 'inactive' }],
    });

    const result = await run({ write: false });

    expect(result.archived_product_keys).toEqual([]);
    expect(result.indexable_cleared_merchant_ids).toEqual([]);
  });

  test('a batch whose UPDATE lands zero rows contributes no rollback keys', async () => {
    // Every candidate changed between SELECT and UPDATE, so the re-asserted
    // predicate skipped them all. Recording them would invent an undo for a
    // write that never happened.
    mockReads({ cohort: [safeRow({ product_key: 'p_raced' })] });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await run({ write: true, confirm: CONFIRM_TOKEN, refreshTrustAfter: false });

    expect(result.counters.archived_rows).toBe(0);
    expect(result.archived_product_keys).toEqual([]);
  });

  test('blocked rows are never handed to the archive UPDATE', async () => {
    mockReads({
      cohort: [
        safeRow({ product_key: 'p_safe' }),
        safeRow({ product_key: 'p_public', serving_decision: 'public' }),
        safeRow({ product_key: 'p_eligible', index_serving_eligible: true }),
      ],
    });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // archiveBatch
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await run({ write: true, confirm: CONFIRM_TOKEN, refreshTrustAfter: false });

    const archiveCall = db.query.mock.calls.find(([sql]) => sql.includes(`SET sync_status = 'archived'`));
    expect(archiveCall[1]).toEqual([['p_safe']]);
  });

  test('a write without the token is refused before any query runs', async () => {
    await expect(run({ write: true, confirm: 'nope' })).rejects.toThrow(/Refusing write/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('--no-refresh-trust skips the trust recompute', async () => {
    mockReads({ cohort: [safeRow({ product_key: 'p1' })] });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await run({ write: true, confirm: CONFIRM_TOKEN, refreshTrustAfter: false });

    expect(result.counters.archived_rows).toBe(1);
    expect(result.trust_refresh).toBeNull();
  });
});
