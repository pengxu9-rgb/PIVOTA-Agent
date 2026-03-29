const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Celestial gateway governance fetch script', () => {
  test('exports raw Railway logs and reports governance candidate counts', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-fetch-'));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-fetch-bin-'));
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'fetch_celestial_commerce_gateway_governance_logs.js',
    );
    const fixturePath = path.join(
      repoRoot,
      'scripts',
      'fixtures',
      'celestial_commerce_gateway_governance_raw_log_sample.ndjson',
    );
    const outputPath = path.join(outDir, 'gateway_governance_raw_log_export.ndjson');
    const metadataPath = path.join(outDir, 'gateway_governance_raw_log_export.json');
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
    cat "${fixturePath}"
    ;;
  *)
    echo "unexpected railway command: \${cmd}" >&2
    exit 1
    ;;
esac
`,
      { mode: 0o755 },
    );

    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--out',
        outputPath,
        '--metadata-out',
        metadataPath,
        '--project',
        'Pivota Agent',
        '--environment',
        'production',
        '--service',
        'PIVOTA-Agent',
        '--lines',
        '4',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
        },
        encoding: 'utf8',
      },
    );

    const payload = JSON.parse(String(stdout || '').trim());
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const exportedLines = fs
      .readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);

    expect(payload.railway_project).toBe('Pivota Agent');
    expect(payload.railway_environment).toBe('production');
    expect(payload.railway_service).toBe('PIVOTA-Agent');
    expect(payload.total_log_lines).toBe(4);
    expect(payload.parsed_json_lines).toBe(4);
    expect(payload.governance_candidate_records).toBe(3);
    expect(payload.shadow_candidate_records).toBe(2);
    expect(exportedLines).toHaveLength(4);
    expect(metadata.governance_candidate_records).toBe(3);
  });
});
