const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Celestial gateway governance report script', () => {
  test('writes markdown and json artifacts for the readiness report pipeline', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-report-'));
    const scriptPath = path.join(
      __dirname,
      '..',
      'scripts',
      'generate_celestial_commerce_gateway_governance_report.js',
    );

    const stdout = execFileSync(process.execPath, [scriptPath, '--out-dir', outDir], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    const payload = JSON.parse(String(stdout || '').trim());

    expect(payload.readiness_status).toBe('green');
    expect(fs.existsSync(payload.json_path)).toBe(true);
    expect(fs.existsSync(payload.markdown_path)).toBe(true);

    const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
    const markdown = fs.readFileSync(payload.markdown_path, 'utf8');
    expect(json.readiness_status).toBe('green');
    expect(markdown).toContain('# Gateway Governance Shadow Summary');
  });

  test('ingests runtime shadow samples into the generated report when provided', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-report-runtime-'));
    const scriptPath = path.join(
      __dirname,
      '..',
      'scripts',
      'generate_celestial_commerce_gateway_governance_report.js',
    );
    const runtimeSamplePath = path.join(
      __dirname,
      '..',
      'scripts',
      'fixtures',
      'celestial_commerce_gateway_governance_shadow_runtime_sample.ndjson',
    );

    const stdout = execFileSync(
      process.execPath,
      [scriptPath, '--out-dir', outDir, '--runtime-sample', runtimeSamplePath],
      {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
      },
    );
    const payload = JSON.parse(String(stdout || '').trim());
    const json = JSON.parse(fs.readFileSync(payload.json_path, 'utf8'));
    const markdown = fs.readFileSync(payload.markdown_path, 'utf8');

    expect(payload.runtime_shadow_events).toBe(3);
    expect(json.runtime_sample_path).toBe(runtimeSamplePath);
    expect(json.runtime_samples.shadow_events).toBe(3);
    expect(json.runtime_samples.coverage.would_enforce_count).toBe(2);
    expect(markdown).toContain('## Runtime Shadow Samples');
    expect(markdown).toContain('Runtime sample:');
  });
});
