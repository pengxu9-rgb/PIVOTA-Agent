const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runExecFile = promisify(execFile);

function repoPath(...parts) {
  return path.join(__dirname, '..', ...parts);
}

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeNdjson(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

test('release_gate_circle.mjs aggregates reports and outputs PASS/FAIL with recommendation', async () => {
  const root = await makeTempDir('aurora_release_gate_circle_');
  try {
    const scriptPath = repoPath('scripts', 'release_gate_circle.mjs');
    const reportsDir = path.join(root, 'reports');
    await fs.mkdir(reportsDir, { recursive: true });

    const goldJsonl = path.join(reportsDir, 'eval_gold_fake.jsonl');
    await writeNdjson(goldJsonl, [
      {
        sample_hash: 's1',
        source: 'internal',
        strong_module_miou_mean: 0.62,
        forehead_hair_overlap_rate: 0.2,
        under_eye_band_coverage_mean: 0.45,
        under_eye_leakage_bg_mean: 0.08,
        driver_score: 0.9,
        fail_reason: null,
      },
      {
        sample_hash: 's2',
        source: 'lapa',
        strong_module_miou_mean: 0.58,
        forehead_hair_overlap_rate: 0.21,
        under_eye_band_coverage_mean: 0.42,
        under_eye_leakage_bg_mean: 0.09,
        driver_score: 0.8,
        fail_reason: null,
      },
    ]);

    const abJson = path.join(reportsDir, 'eval_gold_ab_fake.json');
    await fs.writeFile(abJson, `${JSON.stringify({
      ok: true,
      recommended_group: 'variant1_forehead_hair_clip',
      groups: [
        {
          group_id: 'baseline',
          delta_vs_baseline: {
            forehead_hair_overlap_rate_mean: 0,
          },
        },
        {
          group_id: 'variant1_forehead_hair_clip',
          delta_vs_baseline: {
            forehead_hair_overlap_rate_mean: -0.04,
          },
        },
      ],
    }, null, 2)}\n`, 'utf8');

    const iaaJson = path.join(reportsDir, 'eval_gold_iaa_fake.json');
    await fs.writeFile(iaaJson, `${JSON.stringify({
      ok: true,
      summary: {
        strong_module_miou_a_vs_b_mean: 0.82,
      },
    }, null, 2)}\n`, 'utf8');

    const crosssetJson = path.join(reportsDir, 'eval_circle_crossset_fake.json');
    await fs.writeFile(crosssetJson, `${JSON.stringify({
      ok: true,
      summaries: [
        { dataset: 'celebamaskhq', leakage_bg_mean: 0.07, leakage_hair_mean: 0.09 },
        { dataset: 'lapa', leakage_bg_mean: 0.08, leakage_hair_mean: 0.11 },
      ],
    }, null, 2)}\n`, 'utf8');

    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--run_id', '20260212_123456789',
      '--gold_jsonl', goldJsonl,
      '--ab_json', abJson,
      '--iaa_json', iaaJson,
      '--crossset_json', crosssetJson,
      '--report_dir', reportsDir,
    ], { cwd: root });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(typeof summary.pass, 'boolean');
    assert.equal(summary.recommended_group, 'variant1_forehead_hair_clip');
    assert.ok(Array.isArray(summary.gate_conditions));
    assert.ok(summary.gate_conditions.length >= 5);

    const reportMdPath = path.join(root, summary.report_md);
    const reportJsonPath = path.join(root, summary.report_json);
    const [mdStat, jsonStat] = await Promise.all([
      fs.stat(reportMdPath),
      fs.stat(reportJsonPath),
    ]);
    assert.ok(mdStat.size > 0);
    assert.ok(jsonStat.size > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

