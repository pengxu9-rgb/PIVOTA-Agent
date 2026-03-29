const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Gateway governance daily summary script', () => {
  test('builds daily summary from raw gateway logs with alert evaluation', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-daily-'));
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_gateway_governance_daily_summary.sh');
    const rawLogPath = path.join(
      repoRoot,
      'scripts',
      'fixtures',
      'celestial_commerce_gateway_governance_raw_log_sample.ndjson',
    );

    const stdout = execFileSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OUT_DIR: outDir,
        GATEWAY_GOVERNANCE_LOG_INPUT_PATH: rawLogPath,
      },
      encoding: 'utf8',
    });

    const match = String(stdout || '').match(/Gateway governance daily summary:\s+(.+)/);
    expect(match).toBeTruthy();
    const reportPath = String(match[1]).trim();
    const summaryPath = path.join(path.dirname(reportPath), 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const report = fs.readFileSync(reportPath, 'utf8');

    expect(summary.extract_status).toBe('pass');
    expect(summary.shadow_summary.readiness_status).toBe('green');
    expect(summary.alerts.overall_status).toBe('green');
    expect(report).toContain('# Gateway Governance Daily Summary');
    expect(report).toContain('## Alert Results');
  });

  test('can auto-fetch raw gateway logs before building the daily summary', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-daily-auto-'));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-daily-bin-'));
    const repoRoot = path.join(__dirname, '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'run_gateway_governance_daily_summary.sh');
    const rawLogPath = path.join(
      repoRoot,
      'scripts',
      'fixtures',
      'celestial_commerce_gateway_governance_raw_log_sample.ndjson',
    );
    const railwayStubPath = path.join(binDir, 'railway');

    fs.writeFileSync(
      railwayStubPath,
      `#!/usr/bin/env bash
set -euo pipefail
cmd="\${1:-}"
shift || true
case "\${cmd}" in
  link)
    exit 0
    ;;
  logs)
    cat "${rawLogPath}"
    ;;
  *)
    echo "unexpected railway command: \${cmd}" >&2
    exit 1
    ;;
esac
`,
      { mode: 0o755 },
    );

    const stdout = execFileSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        OUT_DIR: outDir,
        GATEWAY_GOVERNANCE_AUTO_FETCH: '1',
        GATEWAY_GOVERNANCE_FETCH_LINES: '4',
      },
      encoding: 'utf8',
    });

    const match = String(stdout || '').match(/Gateway governance daily summary:\s+(.+)/);
    expect(match).toBeTruthy();
    const reportPath = String(match[1]).trim();
    const summaryPath = path.join(path.dirname(reportPath), 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const report = fs.readFileSync(reportPath, 'utf8');

    expect(summary.fetch_status).toBe('pass');
    expect(summary.extract_status).toBe('pass');
    expect(summary.shadow_summary.readiness_status).toBe('green');
    expect(report).toContain('Raw export step: pass');
  });
});
