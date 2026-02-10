const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parsePrometheusSnapshot,
  computeCounterDelta,
  diffPromSnapshots,
  resolveWindowSince,
  compareSmokeResultQuality,
  evaluateThresholds,
  observeGuardHit,
  checkRequiredArtifacts,
} = require('../scripts/shadow_acceptance');

test('shadow acceptance: Prometheus parser extracts status and reason counters', () => {
  const metrics = `
# HELP verify_calls_total ...
verify_calls_total{status="attempt"} 12
verify_calls_total{status="success"} 10
verify_calls_total{status="fail"} 2
verify_calls_total{status="skip"} 3
verify_calls_total{status="guard"} 1
verify_fail_total{reason="TIMEOUT",provider="gemini_provider",http_status_class="timeout"} 2
verify_fail_total{reason="UPSTREAM_5XX",provider="gemini_provider",http_status_class="5xx"} 1
verify_skip_total{reason="VERIFY_BUDGET_GUARD"} 1
verify_budget_guard_total 1
verify_circuit_open_total 0
`;

  const parsed = parsePrometheusSnapshot(metrics);
  assert.equal(parsed.verify_calls_total, 28);
  assert.equal(parsed.verify_fail_total, 3);
  assert.equal(parsed.verify_budget_guard_total, 1);
  assert.equal(parsed.calls_by_status.find((item) => item.status === 'success').count, 10);
  assert.equal(parsed.fail_by_reason.find((item) => item.reason === 'TIMEOUT').count, 2);
});

test('shadow acceptance: snapshot delta calculation is stable', () => {
  const before = parsePrometheusSnapshot(`
verify_calls_total{status="attempt"} 2
verify_calls_total{status="success"} 1
verify_fail_total{reason="UPSTREAM_5XX",provider="gemini_provider",http_status_class="5xx"} 1
verify_budget_guard_total 0
`);
  const after = parsePrometheusSnapshot(`
verify_calls_total{status="attempt"} 7
verify_calls_total{status="success"} 4
verify_calls_total{status="guard"} 2
verify_fail_total{reason="UPSTREAM_5XX",provider="gemini_provider",http_status_class="5xx"} 1
verify_budget_guard_total 2
`);

  const delta = diffPromSnapshots(before, after);
  assert.equal(delta.verify_calls_total, 10);
  assert.equal(delta.status_delta.success, 3);
  assert.equal(delta.status_delta.guard, 2);
  assert.equal(delta.verify_budget_guard_total, 2);
  assert.equal(delta.unstable, false);
});

test('shadow acceptance: counter reset returns non-negative deltas', () => {
  const before = parsePrometheusSnapshot(`
verify_calls_total{status="attempt"} 120
verify_calls_total{status="success"} 119
verify_calls_total{status="fail"} 1
verify_fail_total{reason="TIMEOUT",provider="gemini_provider",http_status_class="timeout"} 1
verify_budget_guard_total 4
`);
  const after = parsePrometheusSnapshot(`
verify_calls_total{status="attempt"} 5
verify_calls_total{status="success"} 4
verify_calls_total{status="fail"} 1
verify_fail_total{reason="TIMEOUT",provider="gemini_provider",http_status_class="timeout"} 1
verify_budget_guard_total 0
`);

  const delta = diffPromSnapshots(before, after);
  assert.equal(delta.verify_calls_total, 10);
  assert.equal(delta.status_delta.success, 4);
  assert.equal(delta.status_delta.fail, 0);
  assert.equal(delta.verify_budget_guard_total, 0);
  assert.equal(delta.unstable, true);
  assert.equal(delta.reset_detected.verify_calls_total, true);
  assert.equal(delta.reset_detected.status_delta.success, true);
});

test('shadow acceptance: computeCounterDelta keeps counter-reset increments', () => {
  const stable = computeCounterDelta(10, 15);
  assert.equal(stable.delta, 5);
  assert.equal(stable.resetDetected, false);
  const reset = computeCounterDelta(100, 7);
  assert.equal(reset.delta, 7);
  assert.equal(reset.resetDetected, true);
});

test('shadow acceptance: smoke result comparator favors better used_photos ratio', () => {
  const current = {
    used_photos_ratio: 0.6,
    renderable_card_ratio: 1,
    used_photos_true: 3,
    total_calls: 5,
  };
  const better = {
    used_photos_ratio: 0.8,
    renderable_card_ratio: 0.8,
    used_photos_true: 4,
    total_calls: 5,
  };
  const notBetter = {
    used_photos_ratio: 0.6,
    renderable_card_ratio: 1,
    used_photos_true: 3,
    total_calls: 5,
  };
  assert.equal(compareSmokeResultQuality(better, current), true);
  assert.equal(compareSmokeResultQuality(notBetter, current), false);
});

test('shadow acceptance: window since clamps to run start for stale input', () => {
  const result = resolveWindowSince({
    requestedSince: '2026-02-10T01:00:00.000Z',
    runStartIso: '2026-02-10T02:00:00.000Z',
  });
  assert.equal(result.requested_since_utc, '2026-02-10T01:00:00.000Z');
  assert.equal(result.effective_since_utc, '2026-02-10T02:00:00.000Z');
  assert.equal(result.clamped_to_run_start, true);
});

test('shadow acceptance: window since keeps future input', () => {
  const result = resolveWindowSince({
    requestedSince: '2026-02-10T03:00:00.000Z',
    runStartIso: '2026-02-10T02:00:00.000Z',
  });
  assert.equal(result.requested_since_utc, '2026-02-10T03:00:00.000Z');
  assert.equal(result.effective_since_utc, '2026-02-10T03:00:00.000Z');
  assert.equal(result.clamped_to_run_start, false);
});

test('shadow acceptance: guard observation accepts skip+budget guard counters', () => {
  const observed = observeGuardHit({
    status_delta: { skip: 9, guard: 0 },
    verify_budget_guard_total: 9,
  });
  assert.equal(observed.hit, true);
  assert.equal(observed.guardStatusDelta, 0);
  assert.equal(observed.skipStatusDelta, 9);
  assert.equal(observed.budgetGuardDelta, 9);
});

test('shadow acceptance: threshold checks flag breached rates', () => {
  const checks = evaluateThresholds({
    shadowSummary: {
      rates: {
        pass_fail_rate: 0.04,
        timeout_rate_vs_calls: 0.03,
        upstream_5xx_rate_vs_calls: 0.01,
      },
    },
    thresholds: {
      max_pass_fail_rate: 0.05,
      max_timeout_rate: 0.02,
      max_upstream_5xx_rate: 0.02,
    },
  });

  const timeout = checks.find((item) => item.key === 'timeout_rate_vs_calls');
  const passFail = checks.find((item) => item.key === 'pass_fail_rate');
  assert.equal(passFail.pass, true);
  assert.equal(timeout.pass, false);
});

test('shadow acceptance: artifact presence checker reports missing paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_shadow_acceptance_'));
  try {
    const verifyMd = path.join(root, 'verify_daily.md');
    const pseudo = path.join(root, 'pseudo.ndjson');
    const hard = path.join(root, 'hard.jsonl');
    const summary = path.join(root, 'summary.json');

    await fs.writeFile(verifyMd, '# ok\n', 'utf8');
    await fs.writeFile(pseudo, '', 'utf8');
    await fs.writeFile(hard, '', 'utf8');

    const result = await checkRequiredArtifacts({
      verify_daily_md: verifyMd,
      pseudo_labels_daily: pseudo,
      hard_cases_daily: hard,
      job_summary: summary,
    });
    assert.equal(result.pass, false);
    assert.equal(result.missing.includes(summary), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
