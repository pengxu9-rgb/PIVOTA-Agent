const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('Celestial gateway governance smoke handoff script', () => {
  test('extracts runtime shadow events from an authoritative search matrix report', () => {
    const repoRoot = path.join(__dirname, '..');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-governance-smoke-handoff-'));
    const scriptPath = path.join(
      repoRoot,
      'scripts',
      'extract_celestial_commerce_gateway_governance_shadow_from_search_matrix.js',
    );
    const inputPath = path.join(outDir, 'search_stability_matrix.json');
    const outputPath = path.join(outDir, 'gateway_governance_shadow_runtime_sample.ndjson');

    fs.writeFileSync(
      inputPath,
      JSON.stringify(
        {
          summary: {
            generated_at: '2026-03-30T03:10:00.000Z',
          },
          rows: [
            {
              round: 1,
              case_id: 'case_shadow',
              family: 'merchant_query',
              query: 'IPSA products',
              gateway_governance: {
                mode: 'shadow',
                invocation_surface: 'authenticated_commerce_invoke',
                observed_action: 'block',
                effective_action: 'allow',
                would_enforce: true,
                reason_codes: ['layer_not_allowed'],
                observed_phase: 'query_governance',
              },
            },
            {
              round: 1,
              case_id: 'case_none',
              family: 'strict_ingredient',
              query: 'niacinamide serum',
            },
          ],
        },
        null,
        2,
      ),
    );

    const stdout = execFileSync(process.execPath, [scriptPath, '--input', inputPath, '--out', outputPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    const payload = JSON.parse(String(stdout || '').trim());
    const lines = fs
      .readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(payload.total_rows).toBe(2);
    expect(payload.governance_candidate_records).toBe(1);
    expect(payload.shadow_candidate_records).toBe(1);
    expect(lines).toEqual([
      expect.objectContaining({
        source: 'authoritative_commerce_smoke',
        mode: 'shadow',
        invocation_surface: 'authenticated_commerce_invoke',
        observed_action: 'block',
        effective_action: 'allow',
        would_enforce: true,
        reason_codes: ['layer_not_allowed'],
        case_id: 'case_shadow',
      }),
    ]);
  });
});
