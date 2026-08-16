const {
  APPLY_CONFIRM_TOKEN,
  evaluateRenewalCandidates,
  parseArgs,
  runRenewal,
} = require('../../scripts/renew-relationship-ai-approved-labels');

const NOW_MS = new Date('2026-08-04T00:00:00.000Z').getTime();
const RESOLVABLE = new Set(['ext_active_seed', 'catalog_key_1', 'pg_group_1']);

function baseRow(overrides = {}) {
  return {
    id: 'lbl_1',
    anchor_type: 'product',
    anchor_ref: 'product:ext_active_seed',
    candidate_product_ref: 'ext_active_seed',
    relation_type: 'competitive_alternative',
    label_state: 'ai_approved',
    anchor_snapshot: {},
    candidate_snapshot: {},
    created_at: '2026-07-01T00:00:00.000Z',
    last_verified_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeQueryFn({ rows = [], seeds = [], catalog = [], groups = [], updateRowCount = 0, calls = [] } = {}) {
  return async (sql, params) => {
    calls.push({ sql, params });
    if (/UPDATE relationship_candidate_labels/.test(sql)) {
      return { rowCount: updateRowCount, rows: [] };
    }
    if (/FROM relationship_candidate_labels/.test(sql)) {
      return { rows };
    }
    if (/FROM external_product_seeds/.test(sql)) {
      return { rows: seeds };
    }
    if (/FROM catalog_products/.test(sql)) {
      return { rows: catalog };
    }
    if (/FROM product_group_members/.test(sql)) {
      return { rows: groups };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
}

// Serves `total` rows in pages of `batchSize`, recording an ordered event log of
// label SELECTs and per-row evaluations. Interleaving is the observable proxy
// for "does not materialize the backlog": a version that accumulates emits every
// select before the first eval, a streaming one alternates.
function pagingHarness({ total, batchSize }) {
  const events = [];
  let served = 0;
  const queryFn = async (sql) => {
    if (/UPDATE relationship_candidate_labels/.test(sql)) return { rowCount: 0, rows: [] };
    if (/FROM relationship_candidate_labels/.test(sql)) {
      events.push('select');
      const take = Math.max(0, Math.min(batchSize, total - served));
      const rows = [];
      for (let i = 0; i < take; i += 1) {
        served += 1;
        rows.push(baseRow({ id: `lbl_${served}`, expires_at: `2026-08-${String(served).padStart(2, '0')}T00:00:00.000Z` }));
      }
      return { rows };
    }
    return { rows: [] };
  };
  const suppressionFn = (row) => {
    events.push(`eval:${row.id}`);
    return [];
  };
  return { events, queryFn, suppressionFn };
}

describe('renew-relationship-ai-approved-labels', () => {
  test('parseArgs is dry-run by default and fails closed on apply without confirmation', () => {
    const options = parseArgs([]);
    expect(options.apply).toBe(false);
    expect(options.windowDays).toBe(14);
    expect(options.maxAgeDays).toBe(180);
    expect(options.market).toBe('');

    expect(() => parseArgs(['--apply'])).toThrow(new RegExp(APPLY_CONFIRM_TOKEN));
    expect(() => parseArgs(['--apply', '--confirm', 'wrong'])).toThrow(new RegExp(APPLY_CONFIRM_TOKEN));
    expect(parseArgs(['--apply', '--confirm', APPLY_CONFIRM_TOKEN]).apply).toBe(true);
  });

  test('evaluateRenewalCandidates keeps rows that verify and skips the rest with reasons', () => {
    const rows = [
      baseRow({ id: 'ok_seed' }),
      baseRow({ id: 'ok_catalog', anchor_ref: 'catalog_key_1', candidate_product_ref: 'product:catalog_key_1' }),
      baseRow({ id: 'ok_group_anchor', anchor_ref: 'product:pg_group_1' }),
      baseRow({ id: 'ok_need_anchor', anchor_type: 'need', anchor_ref: 'need:hydration' }),
      baseRow({ id: 'gone_candidate', candidate_product_ref: 'ext_retired_seed' }),
      baseRow({ id: 'gone_anchor', anchor_ref: 'product:ext_retired_seed' }),
      // The live serving guard quarantines ai_approved dupes.
      baseRow({ id: 'suppressed_dupe', relation_type: 'dupe' }),
      // Verdict older than max-age-days: renewal must not extend it forever.
      // A prior renewal's first_verified_at pins the ORIGINAL verdict date
      // regardless of the fresher last_verified_at.
      baseRow({
        id: 'too_old_verdict',
        last_verified_at: '2026-07-20T00:00:00.000Z',
        provenance: { re_verify: { first_verified_at: '2025-08-01T00:00:00.000Z' } },
      }),
      // Backfilled cohort shape: ancient created_at but a recent verdict —
      // MUST stay renewable (age is keyed on the verdict, never created_at).
      baseRow({ id: 'ok_backfilled', created_at: '2025-01-01T00:00:00.000Z' }),
    ];

    const { renewableIds, skipped, suppressionReasons } = evaluateRenewalCandidates(rows, RESOLVABLE, {
      nowMs: NOW_MS,
      maxAgeDays: 180,
    });

    expect(renewableIds).toEqual(['ok_seed', 'ok_catalog', 'ok_group_anchor', 'ok_need_anchor', 'ok_backfilled']);
    expect(skipped).toEqual({
      suppressed: 1,
      anchor_unresolvable: 1,
      candidate_unresolvable: 1,
      age_capped: 1,
    });
    expect(suppressionReasons.ai_approved_dupe_quarantined).toBe(1);
  });

  test('runRenewal dry-run issues no UPDATE and reports the renewable backlog', async () => {
    const calls = [];
    const queryFn = fakeQueryFn({
      rows: [baseRow()],
      seeds: [{ k1: 'seed_row_id', k2: 'ext_active_seed', k3: '' }],
      calls,
    });

    const report = await runRenewal({ queryFn, generatedAt: '2026-08-04T00:00:00.000Z' });

    expect(report.mode).toBe('dry-run');
    expect(report.ok).toBe(true);
    expect(report.scanned_rows).toBe(1);
    expect(report.renewable_count).toBe(1);
    expect(report.renewed_count).toBe(0);
    expect(calls.some(({ sql }) => /UPDATE/.test(sql))).toBe(false);

    const selectSql = calls.find(({ sql }) => /FROM relationship_candidate_labels/.test(sql)).sql;
    expect(selectSql).toContain("label_state = 'ai_approved'");

    // The catalog ref set must use the live serving predicate, not bare existence.
    const catalogSql = calls.find(({ sql }) => /FROM catalog_products/.test(sql)).sql;
    expect(catalogSql).toContain('catalog_merchants');
    expect(catalogSql).toContain('merchant_stores');
  });

  test('runRenewal apply updates only ai_approved rows and never touches label_state', async () => {
    const calls = [];
    const queryFn = fakeQueryFn({
      rows: [baseRow({ id: 'lbl_1' }), baseRow({ id: 'lbl_2' })],
      seeds: [{ k2: 'ext_active_seed' }],
      updateRowCount: 2,
      calls,
    });

    const report = await runRenewal({
      apply: true,
      queryFn,
      generatedAt: '2026-08-04T00:00:00.000Z',
      operator: 'unit_test',
    });

    expect(report.mode).toBe('apply');
    expect(report.ok).toBe(true);
    expect(report.renewed_count).toBe(2);
    expect(report.applied_count).toBe(2);

    const update = calls.find(({ sql }) => /UPDATE relationship_candidate_labels/.test(sql));
    expect(update.sql).toContain("AND label_state = 'ai_approved'");
    // The SET clause must never assign label_state (renewal preserves review state).
    expect(update.sql.split('WHERE')[0]).not.toContain('label_state');
    // first_verified_at must be preserved from the row's own prior value
    // (existing first_verified_at, else the pre-update last_verified_at) so the
    // original verdict date survives the last_verified_at overwrite.
    expect(update.sql).toContain("provenance #>> '{re_verify,first_verified_at}'");
    expect(update.sql).toContain('to_char(last_verified_at');
    expect(update.params[0]).toEqual(['lbl_1', 'lbl_2']);
    expect(update.params[1]).toBe('45 days');
    expect(update.params[2]).toBe('2026-08-04T00:00:00.000Z');
    expect(update.params[3]).toBe('seed_catalog_active_check+serving_guard');
    expect(update.params[4]).toBe('unit_test');
  });

  test('runRenewal apply with nothing renewable issues no UPDATE and stays ok', async () => {
    const calls = [];
    const queryFn = fakeQueryFn({
      rows: [baseRow({ candidate_product_ref: 'ext_retired_seed' })],
      seeds: [{ k2: 'ext_active_seed' }],
      calls,
    });

    const report = await runRenewal({ apply: true, queryFn, generatedAt: '2026-08-04T00:00:00.000Z' });

    expect(report.renewable_count).toBe(0);
    expect(report.renewed_count).toBe(0);
    expect(report.ok).toBe(true);
    expect(calls.some(({ sql }) => /UPDATE/.test(sql))).toBe(false);
  });

  test('row loading paginates by keyset cursor instead of one unbounded SELECT', async () => {
    const { loadExpiringAiApprovedRows } = require('../../scripts/renew-relationship-ai-approved-labels');
    const batch1 = Array.from({ length: 2 }, (_, i) => baseRow({
      id: `lbl_${i}`,
      expires_at: `2026-08-1${i}T00:00:00.000Z`,
    }));
    const batch2 = [baseRow({ id: 'lbl_last', expires_at: '2026-08-20T00:00:00.000Z' })];
    const calls = [];
    const queryFn = async (sql, params) => {
      calls.push({ sql, params });
      return { rows: calls.length === 1 ? batch1 : batch2 };
    };

    const rows = await loadExpiringAiApprovedRows({ queryFn, batchSize: 2 });

    expect(rows.map((r) => r.id)).toEqual(['lbl_0', 'lbl_1', 'lbl_last']);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).not.toContain('(expires_at, id) >');
    // Second batch resumes from the previous batch's last (expires_at, id).
    expect(calls[1].sql).toContain('(expires_at, id) >');
    expect(calls[1].params).toContain('2026-08-11T00:00:00.000Z');
    expect(calls[1].params).toContain('lbl_1');
  });

  // The OOM guard. Keyset paging alone did NOT bound memory — the old loader
  // pushed every page into one array, so a 4GB V8 heap died on the expiring
  // backlog in production (2026-08-11T10:37Z) with the pagination test above
  // still green. These assert the rows are CONSUMED per batch, not just fetched
  // per batch, which is the property that actually caps resident memory.
  test('runRenewal evaluates each batch before fetching the next', async () => {
    const { events, queryFn, suppressionFn } = pagingHarness({ total: 6, batchSize: 2 });

    await runRenewal({ queryFn, suppressionFn, batchSize: 2, generatedAt: '2026-08-04T00:00:00.000Z' });

    const firstSelect = events.indexOf('select');
    const secondSelect = events.indexOf('select', firstSelect + 1);
    expect(secondSelect).toBeGreaterThan(-1);
    // An accumulating loader emits select,select,select,... with no eval in between.
    const betweenSelects = events.slice(firstSelect + 1, secondSelect);
    expect(betweenSelects).toEqual(['eval:lbl_1', 'eval:lbl_2']);
  });

  test('runRenewal never holds more than one batch of rows in flight', async () => {
    const { events, queryFn, suppressionFn } = pagingHarness({ total: 6, batchSize: 2 });

    const report = await runRenewal({ queryFn, suppressionFn, batchSize: 2, generatedAt: '2026-08-04T00:00:00.000Z' });

    // Every row is still scanned exactly once — streaming must not lose rows.
    expect(report.scanned_rows).toBe(6);
    expect(events.filter((e) => e.startsWith('eval:'))).toEqual([
      'eval:lbl_1', 'eval:lbl_2', 'eval:lbl_3', 'eval:lbl_4', 'eval:lbl_5', 'eval:lbl_6',
    ]);
    // Max evals seen between two consecutive selects never exceeds one batch.
    const selectIdx = events.reduce((acc, e, i) => (e === 'select' ? [...acc, i] : acc), []);
    const spans = selectIdx.map((start, i) => (
      events.slice(start + 1, selectIdx[i + 1] === undefined ? events.length : selectIdx[i + 1])
    ));
    for (const span of spans) expect(span.length).toBeLessThanOrEqual(2);
  });

  test('streaming still folds counters and ids across every batch', async () => {
    // Half the rows suppressed, alternating, so a fold that drops or double-counts
    // a batch cannot produce these totals by accident.
    const events = [];
    let served = 0;
    const queryFn = async (sql) => {
      if (/UPDATE relationship_candidate_labels/.test(sql)) return { rowCount: 2, rows: [] };
      if (/FROM relationship_candidate_labels/.test(sql)) {
        const take = Math.max(0, Math.min(2, 4 - served));
        const rows = [];
        for (let i = 0; i < take; i += 1) {
          served += 1;
          rows.push(baseRow({ id: `lbl_${served}`, expires_at: `2026-08-0${served}T00:00:00.000Z` }));
        }
        return { rows };
      }
      if (/FROM external_product_seeds/.test(sql)) return { rows: [{ k1: 'ext_active_seed' }] };
      return { rows: [] };
    };
    const suppressionFn = (row) => {
      events.push(row.id);
      return Number(row.id.slice(-1)) % 2 === 0 ? ['ai_approved_dupe_quarantined'] : [];
    };

    const report = await runRenewal({
      apply: true,
      confirm: APPLY_CONFIRM_TOKEN,
      queryFn,
      suppressionFn,
      batchSize: 2,
      generatedAt: '2026-08-04T00:00:00.000Z',
    });

    expect(report.scanned_rows).toBe(4);
    expect(report.renewable_count).toBe(2);          // lbl_1, lbl_3 — one per batch
    expect(report.skipped.suppressed).toBe(2);       // lbl_2, lbl_4 — one per batch
    expect(report.suppression_reasons).toEqual({ ai_approved_dupe_quarantined: 2 });
    expect(report.skipped_total).toBe(2);
  });

  test('runRenewal apply that renews zero of a non-empty renewable set fails loudly', async () => {
    const queryFn = fakeQueryFn({
      rows: [baseRow({ id: 'lbl_1' })],
      seeds: [{ k2: 'ext_active_seed' }],
      updateRowCount: 0,
    });

    const report = await runRenewal({ apply: true, queryFn, generatedAt: '2026-08-04T00:00:00.000Z' });

    expect(report.renewable_count).toBe(1);
    expect(report.renewed_count).toBe(0);
    expect(report.ok).toBe(false);
  });

  // The 2026-08-12 production run spent the parent's whole 20-minute budget in
  // this step and was SIGKILLed: no report, no renewals, no idea which phase was
  // slow. These pin the three properties that stop that from repeating.
  describe('scan deadline', () => {
    // Advances 400ms per label SELECT, so a budget is spent in whole batches.
    function timedPagingHarness({ total, batchSize, msPerSelect = 400 }) {
      const harness = pagingHarness({ total, batchSize });
      const state = { now: 0 };
      const queryFn = async (sql, params) => {
        if (/FROM relationship_candidate_labels/.test(sql)) state.now += msPerSelect;
        return harness.queryFn(sql, params);
      };
      return { ...harness, queryFn, clock: () => state.now };
    }

    test('parseArgs reads --deadline-ms and defaults it off', () => {
      expect(parseArgs([]).deadlineMs).toBe(0);
      expect(parseArgs(['--deadline-ms', '90000']).deadlineMs).toBe(90000);
    });

    test('stops scanning at a batch boundary once the budget is spent', async () => {
      const { queryFn, suppressionFn, clock, events } = timedPagingHarness({ total: 100, batchSize: 10 });

      const report = await runRenewal({
        queryFn,
        suppressionFn,
        clock,
        batchSize: 10,
        deadlineMs: 1000,
        generatedAt: '2026-08-04T00:00:00.000Z',
      });

      // 3 selects * 400ms crosses 1000ms; the 4th is never issued.
      expect(report.batches_scanned).toBe(3);
      expect(report.scanned_rows).toBe(30);
      expect(report.truncated).toBe(true);
      expect(events.filter((e) => e === 'select')).toHaveLength(3);
    });

    test('applies what it verified before truncating — partial progress is durable', async () => {
      const calls = [];
      const { queryFn, suppressionFn, clock } = timedPagingHarness({ total: 100, batchSize: 10 });
      const recordingQueryFn = async (sql, params) => {
        calls.push({ sql, params });
        if (/UPDATE relationship_candidate_labels/.test(sql)) return { rowCount: params[0].length, rows: [] };
        // pagingHarness serves no ref rows; without a resolvable anchor every
        // row would skip and there would be nothing to apply.
        if (/FROM external_product_seeds/.test(sql)) return { rows: [{ k2: 'ext_active_seed' }] };
        return queryFn(sql, params);
      };

      const report = await runRenewal({
        apply: true,
        queryFn: recordingQueryFn,
        suppressionFn,
        clock,
        batchSize: 10,
        deadlineMs: 1000,
        generatedAt: '2026-08-04T00:00:00.000Z',
      });

      const update = calls.find(({ sql }) => /UPDATE relationship_candidate_labels/.test(sql));
      expect(update).toBeDefined();
      expect(update.params[0]).toHaveLength(30);
      expect(report.renewed_count).toBe(30);
      expect(report.truncated).toBe(true);
      expect(report.ok).toBe(true);
    });

    test('a budget spent before the first batch is not reported as success', async () => {
      const { queryFn, suppressionFn } = pagingHarness({ total: 100, batchSize: 10 });
      // Start stamp, then a clock already past the budget: the ref-set load ate
      // the whole thing before the first batch could be read.
      let tick = 0;
      const clock = () => (tick++ === 0 ? 0 : 5000);

      const report = await runRenewal({
        queryFn,
        suppressionFn,
        clock,
        batchSize: 10,
        deadlineMs: 1000,
        generatedAt: '2026-08-04T00:00:00.000Z',
      });

      expect(report.scanned_rows).toBe(0);
      expect(report.truncated).toBe(true);
      expect(report.ok).toBe(false);
    });

    test('no deadline scans the whole backlog', async () => {
      const { queryFn, suppressionFn, clock } = timedPagingHarness({ total: 100, batchSize: 10 });

      const report = await runRenewal({
        queryFn,
        suppressionFn,
        clock,
        batchSize: 10,
        generatedAt: '2026-08-04T00:00:00.000Z',
      });

      expect(report.scanned_rows).toBe(100);
      expect(report.truncated).toBe(false);
      expect(report.deadline_ms).toBeNull();
    });

    // stderr progress is the only output a run that outlives its parent leaves
    // behind — the /tmp report dies with the container.
    test('reports scan progress per batch as it goes', async () => {
      const progress = [];
      const { queryFn, suppressionFn, clock } = timedPagingHarness({ total: 30, batchSize: 10 });

      await runRenewal({
        queryFn,
        suppressionFn,
        clock,
        batchSize: 10,
        onProgress: (event) => progress.push(event),
        generatedAt: '2026-08-04T00:00:00.000Z',
      });

      const scans = progress.filter((event) => event.phase === 'scan');
      expect(scans).toHaveLength(3);
      expect(scans[2]).toMatchObject({ batch: 3, rows: 10, scanned_rows: 30 });
      expect(scans[2].elapsed_ms).toBeGreaterThan(scans[0].elapsed_ms);
      expect(progress.some((event) => event.phase === 'ref_set')).toBe(true);
    });
  });
});
