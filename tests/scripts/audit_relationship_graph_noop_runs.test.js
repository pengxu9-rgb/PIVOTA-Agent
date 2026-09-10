jest.mock('../../src/db', () => ({
  query: jest.fn(),
  closePool: jest.fn().mockResolvedValue(undefined),
}));

const { query } = require('../../src/db');
const {
  parseArgs,
  loadRunFacts,
  classifyRunFacts,
  runNoopAudit,
} = require('../../scripts/audit-relationship-graph-noop-runs');

describe('audit-relationship-graph-noop-runs', () => {
  beforeEach(() => query.mockReset());

  // --- the contradiction, proved BOTH ways ----------------------------------------------------
  // A check that says "clean" in every state is indistinguishable from a healthy system. Each of
  // these has a partner that must produce the opposite verdict.

  it('fires when a recent run passed and nothing in the window applied anything', () => {
    const out = classifyRunFacts({ recent_passed: 1, window_passed: 14, window_max_applied: 0 });
    expect(out.noop).toBe(true);
    expect(out.verdict).toBe('runs_pass_without_applying');
  });

  it('is silent when a run in the window applied something', () => {
    // The control. An implementation that ignored applied_count passes the test above and dies here.
    const out = classifyRunFacts({ recent_passed: 1, window_passed: 14, window_max_applied: 17 });
    expect(out.noop).toBe(false);
    expect(out.verdict).toBe('applying');
  });

  it('separates a DEAD CRON from a no-op one', () => {
    // Nothing has run lately: also "nothing applied", but a different defect with a different fix.
    // Reporting it as runs_pass_without_applying would send someone to debug the wrong thing.
    const out = classifyRunFacts({ recent_passed: 0, window_passed: 0, window_max_applied: 0 });
    expect(out.noop).toBe(false);
    expect(out.verdict).toBe('no_recent_passing_run');
  });

  it('treats a missing applied_count as zero, not as unknown', () => {
    const out = classifyRunFacts({ recent_passed: 2, window_max_applied: null });
    expect(out.noop).toBe(true);
  });

  // --- the query ------------------------------------------------------------------------------

  it('reads both facts in ONE query so they describe the same instant', async () => {
    query.mockResolvedValue({
      rows: [{ recent_passed: 1, window_passed: 9, window_max_applied: 0, last_passed_at: 'x' }],
    });
    await loadRunFacts({ windowDays: 14, recentHours: 48 });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('relationship_graph_routine_runs');
    expect(sql).toContain('applied_count');
    // it must NOT reach for the edges view — that was the defect this replaced
    expect(sql).not.toContain('product_relationship_edges');
    expect(params).toEqual(['48', '14']);
  });

  it('coerces absent counts to 0 rather than NaN', async () => {
    query.mockResolvedValue({ rows: [{}] });
    const facts = await loadRunFacts({ windowDays: 14, recentHours: 48 });
    expect(facts.recent_passed).toBe(0);
    expect(facts.window_max_applied).toBe(0);
    expect(facts.last_passed_at).toBeNull();
  });

  it('reports the whole shape, not just the verdict', async () => {
    query.mockResolvedValue({
      rows: [{ recent_passed: 3, window_passed: 14, window_max_applied: 0, last_passed_at: 't' }],
    });
    const report = await runNoopAudit({ windowDays: 14, recentHours: 48 });
    expect(report).toMatchObject({
      window_days: 14,
      recent_hours: 48,
      recent_passed: 3,
      window_passed: 14,
      window_max_applied: 0,
      noop: true,
      verdict: 'runs_pass_without_applying',
    });
  });

  // --- args -----------------------------------------------------------------------------------

  it('defaults to report-only; failing the build is opt-in', () => {
    expect(parseArgs([]).failOnNoop).toBe(false);
    expect(parseArgs(['--fail-on-noop']).failOnNoop).toBe(true);
  });

  it('clamps nonsense windows instead of passing them to SQL', () => {
    expect(parseArgs(['--window-days', 'banana']).windowDays).toBe(14);
    expect(parseArgs(['--window-days', '-5']).windowDays).toBe(1);
    expect(parseArgs(['--recent-hours', '99999']).recentHours).toBe(24 * 30);
  });
});
