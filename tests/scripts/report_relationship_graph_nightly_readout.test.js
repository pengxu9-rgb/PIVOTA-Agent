jest.mock('../../src/db', () => ({ query: jest.fn(), closePool: jest.fn().mockResolvedValue() }));

const {
  runNightlyReadout,
  loadRecentRuns,
  loadErrorQuarantine,
  loadReviewPool,
  summarizeRuns,
  QUARANTINE_CONSECUTIVE,
} = require('../../scripts/report-relationship-graph-nightly-readout');
const { runHealthJob, parseArgs } = require('../../scripts/run-relgraph-health-job');

const RUN_ROW = {
  generated_at: '2026-11-08T10:37Z',
  trigger: 'cron',
  status: 'passed',
  failed_step: null,
  apply_review: true,
  affected_count: '120',
  edge_count: '340',
  reviewed_count: '121',
  approved_count: '40',
  review_rejected_count: '70',
  review_error_count: '11',
  quarantine_entered_count: '3',
  quarantine_skipped_count: '9',
};

function routedQuery({ runs = [RUN_ROW], quarantine = [], pool = [] } = {}) {
  return jest.fn(async (sql) => {
    if (/FROM relationship_graph_routine_runs/.test(sql)) return { rows: runs };
    if (/relation_type = 'competitive_alternative'/.test(sql)) return { rows: pool };
    if (/provenance \? 'ai_review_error'/.test(sql)) return { rows: quarantine };
    throw new Error(`unexpected sql: ${sql.slice(0, 80)}`);
  });
}

describe('report-relationship-graph-nightly-readout', () => {
  it('maps ledger rows to counters, newest first, as numbers', async () => {
    const q = routedQuery();
    const runs = await loadRecentRuns({ runDays: 7 }, q);
    expect(runs).toEqual([
      expect.objectContaining({
        status: 'passed',
        reviewed: 121,
        approved: 40,
        review_errors: 11,
        quarantine_entered: 3,
        quarantine_skipped: 9,
      }),
    ]);
    expect(q.mock.calls[0][1]).toEqual(['7']);
  });

  it('reads only the sync routine and is bounded', async () => {
    const q = routedQuery();
    await loadRecentRuns({ runDays: 7 }, q);
    const sql = q.mock.calls[0][0];
    expect(sql).toMatch(/run_kind = 'sync_routine'/);
    expect(sql).toMatch(/LIMIT \d+/);
  });

  it('carries no identifiers or text out of the database', async () => {
    const q = routedQuery();
    await runNightlyReadout({}, q);
    for (const [sql] of q.mock.calls) {
      expect(sql).not.toMatch(/routine_run_id|product_ref|anchor_ref|candidate_ref|title|message/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    }
  });

  it('counts quarantined labels with the review rule (consecutive >= 2)', async () => {
    expect(QUARANTINE_CONSECUTIVE).toBe(2);
    const q = routedQuery({
      quarantine: [
        { consecutive: 1, last_code: 'timeout', n: 5 },
        { consecutive: 2, last_code: 'timeout', n: 7 },
        { consecutive: 4, last_code: 'schema', n: 1 },
        { consecutive: null, last_code: 'unknown', n: 2 },
      ],
    });
    const out = await loadErrorQuarantine(q);
    expect(out.quarantined).toBe(8);
    expect(out.buckets).toHaveLength(4);
  });

  it('reports every pool bucket, zero when absent, and ignores unknown buckets', async () => {
    const q = routedQuery({ pool: [{ bucket: 'no_memo', n: 30 }, { bucket: 'surprise', n: 9 }] });
    expect(await loadReviewPool(q)).toEqual({
      error_quarantined: 0,
      has_review_memo: 0,
      error_once: 0,
      no_memo: 30,
    });
  });

  it('summarizes the last run and counts non-passed runs as failed', () => {
    const s = summarizeRuns([
      { generated_at: 'b', status: 'failed', failed_step: 'catalog_sync', reviewed: null },
      { generated_at: 'a', status: 'passed', failed_step: null, reviewed: 100 },
    ]);
    expect(s).toMatchObject({
      last_run_at: 'b',
      last_status: 'failed',
      last_failed_step: 'catalog_sync',
      runs: 2,
      failed_runs: 1,
      reviewed_total: 100,
    });
  });

  it('counts only failed and error as failed; running and skipped are reported, not alarmed', () => {
    const s = summarizeRuns([
      { status: 'running' },
      { status: 'skipped_disabled' },
      { status: 'skipped' },
      { status: 'error' },
      { status: 'failed' },
      { status: 'passed' },
    ]);
    expect(s.failed_runs).toBe(2);
    expect(s.status_counts).toEqual({
      running: 1, skipped_disabled: 1, skipped: 1, error: 1, failed: 1, passed: 1,
    });
  });

  it('summarizes no runs as nulls, not as a healthy night', () => {
    expect(summarizeRuns([])).toMatchObject({ last_run_at: null, last_status: null, runs: 0 });
  });

  it('clamps the run window', async () => {
    const q = routedQuery();
    expect((await runNightlyReadout({ runDays: 999 }, q)).run_days).toBe(35);
    expect((await runNightlyReadout({ runDays: 'x' }, q)).run_days).toBe(7);
  });
});

describe('run-relgraph-health-job carries the readout, report-only', () => {
  const CLEAN_AUDIT = { total_rows: 100, safe_rows: 100, suppressed_rows: 0, suppressed_pct: 0, by_reason: {} };
  const CLEAN_STATUS = { coverage: { total_rows: 900 }, checks: {} };
  const baseDeps = {
    runServingGuardAudit: async () => CLEAN_AUDIT,
    runServingStatusReport: async () => CLEAN_STATUS,
    runNoopAudit: async () => ({ noop: false }),
  };
  const opts = parseArgs([], {});

  it('includes the readout and stays ok', async () => {
    const result = await runHealthJob(opts, {
      ...baseDeps,
      runNightlyReadout: async () => ({ summary: { last_status: 'failed' } }),
    });
    expect(result.ok).toBe(true);
    expect(result.nightly.summary.last_status).toBe('failed');
  });

  it('records a readout failure instead of crashing the job', async () => {
    const result = await runHealthJob(opts, {
      ...baseDeps,
      runNightlyReadout: async () => {
        throw new Error('canceling statement due to statement timeout');
      },
    });
    expect(result.ok).toBe(true);
    expect(result.nightly.error).toMatch(/statement timeout/);
  });

  it('does not let a readout mask a real breach', async () => {
    const result = await runHealthJob(opts, {
      ...baseDeps,
      runServingGuardAudit: async () => ({ ...CLEAN_AUDIT, suppressed_rows: 2 }),
      runNightlyReadout: async () => ({ summary: { last_status: 'passed' } }),
    });
    expect(result.ok).toBe(false);
  });

  it('passes the configured run window through', async () => {
    const seen = [];
    await runHealthJob(parseArgs([], { RELGRAPH_READOUT_RUN_DAYS: '14' }), {
      ...baseDeps,
      runNightlyReadout: async (o) => {
        seen.push(o.runDays);
        return {};
      },
    });
    expect(seen).toEqual([14]);
  });
});
