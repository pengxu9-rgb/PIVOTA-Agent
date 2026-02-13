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

test('eval_gold_iaa.mjs outputs IAA summary and top disagreement artifacts', async () => {
  const root = await makeTempDir('aurora_eval_gold_iaa_');
  try {
    const fixturePath = repoPath('tests', 'fixtures', 'gold_labeling', 'label_studio_export_real_round1.json');
    const iaaScript = repoPath('scripts', 'eval_gold_iaa.mjs');
    const reportDir = path.join(root, 'reports');
    const exportPath = path.join(root, 'label_studio_export_round1_20260212_123456789.json');

    const payload = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    assert.ok(Array.isArray(payload) && payload.length >= 1);
    const firstTask = payload[0];
    const firstAnn = firstTask.annotations[0];
    const secondAnn = JSON.parse(JSON.stringify(firstAnn));
    secondAnn.id = 9002;
    secondAnn.created_at = '2026-02-12T02:00:00.000Z';
    secondAnn.updated_at = '2026-02-12T02:10:00.000Z';
    secondAnn.completed_by = { email: 'annotator_real_b@local' };
    const tweak = secondAnn.result.find((row) => row && row.value && Array.isArray(row.value.polygonlabels) && row.value.polygonlabels[0] === 'nose');
    if (tweak && Array.isArray(tweak.value.points) && tweak.value.points[0]) {
      tweak.value.points[0][0] = Number(tweak.value.points[0][0]) + 2;
    }
    firstTask.annotations = [firstAnn, secondAnn];
    await fs.writeFile(exportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const { stdout } = await runExecFile('node', [
      iaaScript,
      '--ls_export', exportPath,
      '--run_id', '20260212_123456789',
      '--report_dir', reportDir,
      '--grid_size', '128',
      '--min_miou_threshold', '0.75',
    ], { cwd: root });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.ok(summary.comparable_task_pairs >= 1);
    assert.ok(Object.prototype.hasOwnProperty.call(summary, 'strong_module_miou_a_vs_b_mean'));
    assert.equal(typeof summary.soft_gate_pass, 'boolean');

    const reportMdPath = path.join(root, summary.report_md);
    const reportJsonlPath = path.join(root, summary.report_jsonl);
    const reportJsonPath = path.join(root, summary.report_json);
    const [mdStat, jsonlStat, jsonStat] = await Promise.all([
      fs.stat(reportMdPath),
      fs.stat(reportJsonlPath),
      fs.stat(reportJsonPath),
    ]);
    assert.ok(mdStat.size > 0);
    assert.ok(jsonlStat.size > 0);
    assert.ok(jsonStat.size > 0);

    const reportJson = JSON.parse(await fs.readFile(reportJsonPath, 'utf8'));
    assert.equal(reportJson.ok, true);
    assert.ok(Array.isArray(reportJson.top_disagreement_tasks));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

