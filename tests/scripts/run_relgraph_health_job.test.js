jest.mock('../../src/db', () => ({ query: jest.fn(), closePool: jest.fn().mockResolvedValue() }));

const {
  parseArgs,
  evaluateServingGuard,
  evaluateExpiryRisk,
  runHealthJob,
  DEFAULT_CRITICAL_REASONS,
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

  const HEALTHY_STATUS = {
    checks: { expiring_14d_pct: { status: 'pass' }, total_rows: { status: 'pass' } },
    coverage: { total_rows: 8000 },
  };
  const fakes = (guard, noop, status = HEALTHY_STATUS) => ({
    runServingGuardAudit: jest.fn().mockResolvedValue(guard),
    runNoopAudit: jest.fn().mockResolvedValue(noop),
    runServingStatusReport: jest.fn().mockResolvedValue(status),
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

  it('keeps the workflow defaults it replaces — INCLUDING the critical reasons', () => {
    // The first port defaulted criticalReasons to [], and the Cloud Run job does not set the env
    // var, so that check would have silently never fired. Exactly the defect this job reports.
    const a = parseArgs([], {});
    expect(a.market).toBe('US');
    expect(a.maxSuppressedRows).toBe(0);
    expect(a.maxSuppressedPct).toBe(0);
    expect(a.failOnNoop).toBe(false);
    expect(a.criticalReasons).toEqual([
      'ai_approved_dupe_quarantined',
      'candidate_ref_unresolvable_nested_product_prefix',
      'anchor_ref_unresolvable_nested_product_prefix',
    ]);
    expect(DEFAULT_CRITICAL_REASONS).toHaveLength(3);
    // and the expiry alarm's thresholds, the workflow's second step
    expect(a.maxExpiring14dPct).toBe(30);
    expect(a.minTotalRows).toBe(500);
  });

  it('an empty env var does NOT blank the critical reasons', () => {
    expect(parseArgs([], { RELGRAPH_CRITICAL_REASONS: '' }).criticalReasons)
      .toEqual(DEFAULT_CRITICAL_REASONS);
    expect(parseArgs([], { RELGRAPH_CRITICAL_REASONS: 'only_this' }).criticalReasons)
      .toEqual(['only_this']);
  });

  // --- expiry risk: the retired workflow's SECOND step ------------------------------------------

  it('passes a healthy serving set', () => {
    expect(evaluateExpiryRisk(HEALTHY_STATUS).ok).toBe(true);
  });

  it('fails when too much of the serving set expires within 14 days', () => {
    expect(evaluateExpiryRisk({
      checks: { expiring_14d_pct: { status: 'fail' }, total_rows: { status: 'pass' } },
      coverage: { total_rows: 8000 },
    }).ok).toBe(false);
  });

  it('fails when the serving set falls below the floor', () => {
    expect(evaluateExpiryRisk({
      checks: { expiring_14d_pct: { status: 'pass' }, total_rows: { status: 'fail' } },
      coverage: { total_rows: 100 },
    }).ok).toBe(false);
  });

  it('fails on an EMPTY serving set even though 0% of 0 rows is expiring', () => {
    // The cliff has already happened; a percentage check alone reads that as perfect health.
    const out = evaluateExpiryRisk({
      checks: { expiring_14d_pct: { status: 'pass' }, total_rows: { status: 'pass' } },
      coverage: { total_rows: 0 },
    });
    expect(out.ok).toBe(false);
    expect(out.violations.map((v) => v.metric)).toContain('serving_empty');
  });

  it('runs the expiry check over ALL markets, and FORWARDS both thresholds', async () => {
    // The thresholds are load-bearing, not decoration: report-relationship-graph-serving-status's
    // maxGate/thresholdGate return `not_applicable` — never `fail` — when the threshold is null.
    // An unforwarded threshold is therefore an alarm that can never fire, silently. DEFAULT_THRESHOLDS
    // carries neither of these two keys, so there is no fallback to save it.
    const f = fakes(CLEAN, { noop: false });
    await runHealthJob(
      { market: 'US', maxSuppressedRows: 0, maxSuppressedPct: 0, criticalReasons: [],
        maxExpiring14dPct: 30, minTotalRows: 500 },
      f,
    );
    expect(f.runServingStatusReport).toHaveBeenCalledWith(
      expect.objectContaining({
        market: '',
        thresholds: expect.objectContaining({ maxExpiring14dPct: 30, minTotalRows: 500 }),
      }),
    );
  });

  it('an unthresholded status report is SILENT — which is why forwarding is checked above', () => {
    // The shape the status report actually returns when no threshold was passed. Documented here so
    // the assertion above reads as a real requirement rather than an arbitrary call-shape pin.
    const out = evaluateExpiryRisk({
      checks: {
        expiring_14d_pct: { status: 'not_applicable', threshold: null },
        total_rows: { status: 'not_applicable', threshold: null },
      },
      coverage: { total_rows: 8000 },
    });
    expect(out.ok).toBe(true);
  });

  it('fails the job when only the expiry alarm trips', async () => {
    const r = await runHealthJob(
      { market: 'US', maxSuppressedRows: 0, maxSuppressedPct: 0, criticalReasons: [],
        maxExpiring14dPct: 30, minTotalRows: 500 },
      fakes(CLEAN, { noop: false }, {
        checks: { expiring_14d_pct: { status: 'fail' }, total_rows: { status: 'pass' } },
        coverage: { total_rows: 8000 },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.expiry.ok).toBe(false);
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
