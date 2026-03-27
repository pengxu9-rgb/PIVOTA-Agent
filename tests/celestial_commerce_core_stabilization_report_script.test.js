const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Celestial commerce-core stabilization report script', () => {
  test('produces a HOLD decision when local gates pass but amber and manual review remain', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-stabilization-report-'));
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'generate_celestial_commerce_core_stabilization_report.js',
    );

    const snapshotPath = path.join(outDir, 'snapshot.json');
    const stepsPath = path.join(outDir, 'steps.json');
    const readinessSummaryPath = path.join(outDir, 'readiness-summary.json');
    const gatewayDailySummaryPath = path.join(outDir, 'gateway-daily-summary.json');
    const stagingMatrixSummaryPath = path.join(outDir, 'staging-matrix.json');

    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          completed: ['gateway governance'],
          incomplete: ['aurora clarify ownership'],
          deferred: ['prod rollout'],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      stepsPath,
      JSON.stringify(
        {
          steps: [
            { name: 'boundary', status: 'pass', log: '/tmp/boundary.log' },
            { name: 'milestone0', status: 'pass', log: '/tmp/milestone0.log' },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      readinessSummaryPath,
      JSON.stringify(
        {
          scorecard: {
            prompt_intent: 'amber',
            commerce_search_contract: 'green',
            gateway_invocation_access_governance: 'green',
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      gatewayDailySummaryPath,
      JSON.stringify(
        {
          shadow_summary: {
            readiness_status: 'green',
          },
          alerts: {
            overall_status: 'green',
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      stagingMatrixSummaryPath,
      JSON.stringify(
        {
          summary: {
            total_cases: 4,
            pass_count: 3,
            fail_count: 0,
            review_required_count: 1,
            infra_blocked_count: 1,
            auth_degraded_count: 1,
            blocking_failures: 0,
          },
          results: [],
        },
        null,
        2,
      ),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--repo-root',
        repoRoot,
        '--out-dir',
        outDir,
        '--snapshot',
        snapshotPath,
        '--steps',
        stepsPath,
        '--readiness-summary',
        readinessSummaryPath,
        '--readiness-report',
        '/tmp/readiness.md',
        '--gateway-daily-summary',
        gatewayDailySummaryPath,
        '--gateway-daily-report',
        '/tmp/gateway-daily.md',
        '--staging-matrix-summary',
        stagingMatrixSummaryPath,
        '--staging-matrix-report',
        '/tmp/staging-matrix.md',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );

    const payload = JSON.parse(String(stdout || '').trim());
    const summary = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
    const report = fs.readFileSync(payload.markdown_path, 'utf8');

    expect(payload.decision).toBe('HOLD');
    expect(summary.decision.label).toBe('HOLD for architecture stabilization');
    expect(summary.decision.hold_reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('staging infrastructure blocked live acceptance'),
        expect.stringContaining('emergency auth fallback'),
        expect.stringContaining('readiness amber dimensions'),
        expect.stringContaining('manual reviews still pending'),
      ]),
    );
    expect(report).toContain('# Celestial Commerce Core Stabilization Review');
    expect(report).toContain('HOLD for architecture stabilization');
    expect(report).toContain('gateway governance');
  });

  test('suppresses staging manual-pending hold reason when aurora manual review completed cleanly', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-core-stabilization-report-manual-'));
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'generate_celestial_commerce_core_stabilization_report.js',
    );

    const snapshotPath = path.join(outDir, 'snapshot.json');
    const stepsPath = path.join(outDir, 'steps.json');
    const readinessSummaryPath = path.join(outDir, 'readiness-summary.json');
    const gatewayDailySummaryPath = path.join(outDir, 'gateway-daily-summary.json');
    const stagingMatrixSummaryPath = path.join(outDir, 'staging-matrix.json');
    const auroraManualSummaryPath = path.join(outDir, 'aurora-manual.json');

    fs.writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          completed: ['gateway governance', 'aurora manual review'],
          incomplete: ['aurora clarify ownership'],
          deferred: ['prod rollout'],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      stepsPath,
      JSON.stringify(
        {
          steps: [
            { name: 'boundary', status: 'pass', log: '/tmp/boundary.log' },
            { name: 'milestone0', status: 'pass', log: '/tmp/milestone0.log' },
            { name: 'aurora_manual_review', status: 'pass', log: '/tmp/aurora-manual.log' },
          ],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      readinessSummaryPath,
      JSON.stringify(
        {
          scorecard: {
            prompt_intent: 'amber',
            commerce_search_contract: 'green',
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      gatewayDailySummaryPath,
      JSON.stringify(
        {
          shadow_summary: { readiness_status: 'green' },
          alerts: { overall_status: 'green' },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      stagingMatrixSummaryPath,
      JSON.stringify(
        {
          summary: {
            total_cases: 12,
            pass_count: 9,
            fail_count: 0,
            review_required_count: 3,
            infra_blocked_count: 0,
            auth_degraded_count: 0,
            blocking_failures: 0,
          },
          results: [],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      auroraManualSummaryPath,
      JSON.stringify(
        {
          pass_count: 3,
          fail_count: 0,
          review_required_count: 0,
        },
        null,
        2,
      ),
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--repo-root',
        repoRoot,
        '--out-dir',
        outDir,
        '--snapshot',
        snapshotPath,
        '--steps',
        stepsPath,
        '--readiness-summary',
        readinessSummaryPath,
        '--readiness-report',
        '/tmp/readiness.md',
        '--gateway-daily-summary',
        gatewayDailySummaryPath,
        '--gateway-daily-report',
        '/tmp/gateway-daily.md',
        '--staging-matrix-summary',
        stagingMatrixSummaryPath,
        '--staging-matrix-report',
        '/tmp/staging-matrix.md',
        '--aurora-manual-summary',
        auroraManualSummaryPath,
        '--aurora-manual-report',
        '/tmp/aurora-manual.md',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );

    const payload = JSON.parse(String(stdout || '').trim());
    const summary = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
    const report = fs.readFileSync(payload.markdown_path, 'utf8');

    expect(payload.decision).toBe('HOLD');
    expect(summary.decision.hold_reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('readiness amber dimensions')]),
    );
    expect(summary.decision.hold_reasons).not.toEqual(
      expect.arrayContaining([expect.stringContaining('manual reviews still pending')]),
    );
    expect(report).toContain('Aurora Manual Review');
    expect(report).toContain('pass_count');
  });
});
