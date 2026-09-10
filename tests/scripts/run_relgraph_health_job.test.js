jest.mock('../../src/db', () => ({ query: jest.fn(), closePool: jest.fn().mockResolvedValue() }));

const {
  parseArgs,
  evaluateServingGuard,
  runHealthJob,
} = require('../../scripts/run-relgraph-health-job');

const CLEAN = { total_rows: 100, safe_rows: 100, suppressed_rows: 0, suppressed_pct: 0, by_reason: {} };

describe('run-relgraph-health-job', () => {
  // --- the gate, ported from the workflow's inline node -e --------------------------------------
  // It must behave identically to what it replaces, or the migration silently changes the alarm.

  it('passes a clean report', () => {
    const gate = evaluateServingGuard(CLEAN, { maxSuppressedRows: 0, maxSuppressedPct: 0 });
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  it('fails on suppressed rows above the max', () => {
    const gate = evaluateServingGuard(
      { ...CLEAN, suppressed_rows: 3 },
      { maxSuppressedRows: 0, maxSuppressedPct: 0 },
    );
    expect(gate.ok).toBe(false);
    expect(gate.violations[0]).toMatchObject({ metric: 'suppressed_rows', observed: 3, max: 0 });
  });

  it('fails on suppressed percentage above the max', () => {
    const gate = evaluateServingGuard(
      { ...CLEAN, suppressed_pct: 12.5 },
      { maxSuppressedRows: 999, maxSuppressedPct: 5 },
    );
    expect(gate.ok).toBe(false);
    expect(gate.violations[0]).toMatchObject({ metric: 'suppressed_pct', observed: 12.5 });
  });

  it('fails on ANY occurrence of a critical reason, regardless of the row thresholds', () => {
    const gate = evaluateServingGuard(
      { ...CLEAN, by_reason: { identity_unverifiable: 1 } },
      { maxSuppressedRows: 999, maxSuppressedPct: 99, criticalReasons: ['identity_unverifiable'] },
    );
    expect(gate.ok).toBe(false);
    expect(gate.violations[0]).toMatchObject({ metric: 'critical_reason', observed: 1, max: 0 });
  });

  it('ignores a reason that is not on the critical list', () => {
    // The control: without this, "everything fails" would pass the test above.
    const gate = evaluateServingGuard(
      { ...CLEAN, by_reason: { some_other_reason: 5 } },
      { maxSuppressedRows: 999, maxSuppressedPct: 99, criticalReasons: ['identity_unverifiable'] },
    );
    expect(gate.ok).toBe(true);
  });

  it('reads a missing report as zeroes rather than NaN', () => {
    const gate = evaluateServingGuard({}, { maxSuppressedRows: 0, maxSuppressedPct: 0 });
    expect(gate.ok).toBe(true);
    expect(gate.suppressed_rows).toBe(0);
  });

  // --- the two checks combine into one verdict --------------------------------------------------

  const fakes = (guard, noop) => ({
    runServingGuardAudit: jest.fn().mockResolvedValue(guard),
    runNoopAudit: jest.fn().mockResolvedValue(noop),
  });

  it('is ok when both checks are clean', async () => {
    const r = await runHealthJob(
      { market: 'US', maxSuppressedRows: 0, maxSuppressedPct: 0, criticalReasons: [] },
      fakes(CLEAN, { noop: false, verdict: 'applying' }),
    );
    expect(r.ok).toBe(true);
  });

  it('fails when the serving guard is breached', async () => {
    const r = await runHealthJob(
      { market: 'US', maxSuppressedRows: 0, maxSuppressedPct: 0, criticalReasons: [] },
      fakes({ ...CLEAN, suppressed_rows: 9 }, { noop: false, verdict: 'applying' }),
    );
    expect(r.ok).toBe(false);
  });

  it('REPORTS a no-op ledger without failing, unless asked to fail', async () => {
    const opts = { market: 'US', maxSuppressedRows: 0, maxSuppressedPct: 0, criticalReasons: [] };
    const noop = { noop: true, verdict: 'runs_pass_without_applying' };

    const reported = await runHealthJob(opts, fakes(CLEAN, noop));
    expect(reported.ok).toBe(true);
    expect(reported.noop.verdict).toBe('runs_pass_without_applying');

    const enforced = await runHealthJob({ ...opts, failOnNoop: true }, fakes(CLEAN, noop));
    expect(enforced.ok).toBe(false);
  });

  it('still runs the no-op check when the serving guard already failed', async () => {
    // A job that short-circuits on the first failure hides the second finding, and then the fix
    // for one lands and the alarm stays red for the other with nothing saying why.
    const f = fakes({ ...CLEAN, suppressed_rows: 9 }, { noop: true, verdict: 'runs_pass_without_applying' });
    const r = await runHealthJob(
      { market: 'US', maxSuppressedRows: 0, maxSuppressedPct: 0, criticalReasons: [] },
      f,
    );
    expect(f.runNoopAudit).toHaveBeenCalled();
    expect(r.noop.noop).toBe(true);
  });

  // --- args -------------------------------------------------------------------------------------

  it('keeps the workflow defaults it replaces', () => {
    const a = parseArgs([], {});
    expect(a.market).toBe('US');
    expect(a.maxSuppressedRows).toBe(0);
    expect(a.maxSuppressedPct).toBe(0);
    expect(a.failOnNoop).toBe(false);
  });

  it('takes thresholds from env, so the Cloud Run job sets them without argv commas', () => {
    const a = parseArgs([], {
      RELGRAPH_MAX_SUPPRESSED_ROWS: '5',
      RELGRAPH_CRITICAL_REASONS: 'a, b ,',
      RELGRAPH_FAIL_ON_NOOP: 'true',
    });
    expect(a.maxSuppressedRows).toBe(5);
    expect(a.criticalReasons).toEqual(['a', 'b']);
    expect(a.failOnNoop).toBe(true);
  });
});
