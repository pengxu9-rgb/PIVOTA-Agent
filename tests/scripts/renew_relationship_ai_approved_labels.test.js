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
      // Older than max-age-days: renewal must not extend an AI verdict forever.
      baseRow({ id: 'too_old', created_at: '2025-08-01T00:00:00.000Z' }),
    ];

    const { renewableIds, skipped, suppressionReasons } = evaluateRenewalCandidates(rows, RESOLVABLE, {
      nowMs: NOW_MS,
      maxAgeDays: 180,
    });

    expect(renewableIds).toEqual(['ok_seed', 'ok_catalog', 'ok_group_anchor', 'ok_need_anchor']);
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
    expect(update.params[0]).toEqual(['lbl_1', 'lbl_2']);
    expect(update.params[1]).toBe('45 days');
    expect(JSON.parse(update.params[2])).toEqual({
      verified_at: '2026-08-04T00:00:00.000Z',
      method: 'seed_catalog_active_check+serving_guard',
      operator: 'unit_test',
    });
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
});
