const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Celestial gateway governance alerts script', () => {
  test('evaluates runtime shadow summary against default thresholds', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-alerts-'));
    const repoRoot = path.join(__dirname, '..');
    const reportScript = path.join(repoRoot, 'scripts', 'generate_celestial_commerce_gateway_governance_report.js');
    const alertScript = path.join(repoRoot, 'scripts', 'evaluate_celestial_commerce_gateway_governance_alerts.js');
    const runtimeSamplePath = path.join(
      repoRoot,
      'scripts',
      'fixtures',
      'celestial_commerce_gateway_governance_shadow_runtime_sample.ndjson',
    );

    execFileSync(process.execPath, [reportScript, '--out-dir', outDir, '--runtime-sample', runtimeSamplePath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    const stdout = execFileSync(
      process.execPath,
      [alertScript, '--summary', path.join(outDir, 'gateway_governance_shadow_summary.json'), '--out-dir', outDir],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    const payload = JSON.parse(String(stdout || '').trim());
    const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));

    expect(payload.overall_status).toBe('green');
    expect(json.overall_status).toBe('green');
    expect(json.metrics.runtime_shadow_events).toBe(3);
    expect(json.metrics.merchant_sweep_blocked_events).toBe(1);
  });
});
