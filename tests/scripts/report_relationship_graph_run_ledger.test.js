const {
  buildRunLedgerReport,
  buildRunLedgerSql,
  formatRunLedgerText,
  parseArgs,
  runReport,
} = require('../../scripts/report-relationship-graph-run-ledger');

const NOW = new Date('2026-06-08T12:00:00.000Z');

function row(overrides = {}) {
  return {
    run_id: 'relgraph_sync_routine_20260608T090023',
    run_kind: 'sync_routine',
    trigger: 'railway_cron',
    routine_run_id: 'relgraph_routine_20260608T090023',
    market: 'US',
    status: 'passed',
    dry_run: true,
    apply_sync: false,
    apply_build: false,
    apply_review: false,
    cutoff: '2026-06-07T12:00:00.000Z',
    selector_updated_since: '2026-06-07T12:00:00.000Z',
    selector_sources: ['catalog_products', 'external_product_seeds'],
    selector_limit: 250,
    affected_count: 250,
    anchor_count: 128,
    edge_count: 3065,
    rejected_count: 100,
    reviewed_count: 0,
    approved_count: 0,
    review_rejected_count: 0,
    applied_count: 0,
    serving_total_rows: 8404,
    serving_safe_rows: 8404,
    serving_suppressed_rows: 0,
    serving_suppressed_pct: 0,
    db_lock_requested: true,
    db_lock_acquired: true,
    failed_step: null,
    generated_at: '2026-06-08T11:45:00.000Z',
    completed_at: '2026-06-08T11:46:00.000Z',
    created_at: '2026-06-08T11:46:01.000Z',
    updated_at: '2026-06-08T11:46:01.000Z',
    ...overrides,
  };
}

describe('report-relationship-graph-run-ledger', () => {
  test('parseArgs accepts operator freshness and failure gates', () => {
    const options = parseArgs([
      '--trigger',
      'railway_cron',
      '--hours',
      '24',
      '--max-age-minutes',
      '180',
      '--fail-on-empty',
      '--fail-on-latest-failed',
      '--json',
    ], { now: NOW });

    expect(options).toEqual(expect.objectContaining({
      market: 'US',
      trigger: 'railway_cron',
      since: '2026-06-07T12:00:00.000Z',
      maxAgeMinutes: 180,
      failOnEmpty: true,
      failOnLatestFailed: true,
      json: true,
    }));
  });

  test('buildRunLedgerSql uses parameterized filters', () => {
    const { sql, params } = buildRunLedgerSql({
      market: 'us',
      trigger: 'railway_cron',
      status: 'passed',
      runKind: 'sync_routine',
      since: '2026-06-07T00:00:00Z',
      limit: 5,
    });

    expect(sql).toMatch(/FROM relationship_graph_routine_runs/);
    expect(sql).toMatch(/upper\(market\) = \$1/);
    expect(sql).toMatch(/trigger = \$2/);
    expect(sql).toMatch(/status = \$3/);
    expect(sql).toMatch(/run_kind = \$4/);
    expect(sql).toMatch(/generated_at >= \$5/);
    expect(sql).toMatch(/LIMIT \$6::int/);
    expect(params).toEqual([
      'US',
      'railway_cron',
      'passed',
      'sync_routine',
      '2026-06-07T00:00:00.000Z',
      5,
    ]);
  });

  test('buildRunLedgerReport passes when latest run is fresh and passed', () => {
    const report = buildRunLedgerReport([row()], {
      maxAgeMinutes: 30,
      failOnEmpty: true,
      failOnLatestFailed: true,
      limit: 10,
    }, { now: NOW });

    expect(report.ok).toBe(true);
    expect(report.latest_age_minutes).toBe(15);
    expect(report.checks).toEqual({
      has_runs: true,
      latest_passed: true,
      latest_fresh: true,
    });
    expect(report.latest.run_id).toBe('relgraph_sync_routine_20260608T090023');
  });

  test('buildRunLedgerReport fails for empty or failed stale latest runs when gates are enabled', () => {
    const empty = buildRunLedgerReport([], {
      failOnEmpty: true,
    }, { now: NOW });
    expect(empty.ok).toBe(false);
    expect(empty.checks.has_runs).toBe(false);

    const failed = buildRunLedgerReport([
      row({
        status: 'failed',
        failed_step: 'relationship_graph_routine',
        generated_at: '2026-06-08T08:00:00.000Z',
      }),
    ], {
      failOnLatestFailed: true,
      maxAgeMinutes: 60,
    }, { now: NOW });
    expect(failed.ok).toBe(false);
    expect(failed.checks.latest_passed).toBe(false);
    expect(failed.checks.latest_fresh).toBe(false);
  });

  test('formatRunLedgerText includes compact counters and lock state', () => {
    const report = buildRunLedgerReport([row()], {}, { now: NOW });
    const text = formatRunLedgerText(report);

    expect(text).toContain('relationship graph run ledger: ok');
    expect(text).toContain('latest=relgraph_sync_routine_20260608T090023');
    expect(text).toContain('affected anchors edges reviewed applied safe suppressed');
    expect(text).toContain('250 128 3065 0 0 8404 0 acquired');
  });

  test('runReport delegates to injectable query function', async () => {
    const queryFn = jest.fn(async () => ({ rows: [row()] }));

    const report = await runReport({
      market: 'US',
      trigger: 'railway_cron',
      limit: 1,
    }, { queryFn, now: NOW });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toMatch(/relationship_graph_routine_runs/);
    expect(queryFn.mock.calls[0][1]).toEqual(['US', 'railway_cron', 1]);
    expect(report.ok).toBe(true);
    expect(report.runs).toHaveLength(1);
  });
});
