const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Gateway governance shadow sample extract script', () => {
  test('extracts normalized shadow-mode records from raw gateway logs', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-shadow-extract-'));
    const scriptPath = path.join(
      __dirname,
      '..',
      'scripts',
      'extract_gateway_governance_shadow_sample.js',
    );
    const inputPath = path.join(
      __dirname,
      '..',
      'scripts',
      'fixtures',
      'celestial_commerce_gateway_governance_raw_log_sample.ndjson',
    );
    const outputPath = path.join(outDir, 'gateway_governance_shadow_sample.ndjson');

    const stdout = execFileSync(process.execPath, [scriptPath, '--input', inputPath, '--out', outputPath], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    const payload = JSON.parse(String(stdout || '').trim());
    const lines = fs
      .readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(payload.total_records).toBe(4);
    expect(payload.extracted_records).toBe(2);
    expect(payload.filtered_non_shadow_records).toBe(1);
    expect(payload.ignored_records).toBe(1);
    expect(lines).toHaveLength(2);
    expect(lines[0].mode).toBe('shadow');
    expect(lines[0].request_id).toBe('gw_req_1');
    expect(lines[0].observed_action).toBe('block');
    expect(lines[1].observed_action).toBe('downgrade');
  });
});
