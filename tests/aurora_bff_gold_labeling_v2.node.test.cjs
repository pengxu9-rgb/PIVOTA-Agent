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

async function readNdjson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeNdjson(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fs.writeFile(filePath, payload, 'utf8');
}

test('gold_label_import.mjs imports Label Studio fixture into normalized NDJSON', async () => {
  const root = await makeTempDir('aurora_gold_labeling_import_');
  try {
    const fixturePath = repoPath('tests', 'fixtures', 'gold_labeling', 'label_studio_export_mock.json');
    const outPath = path.join(root, 'artifacts', 'gold_labels.ndjson');
    const scriptPath = repoPath('scripts', 'gold_label_import.mjs');

    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--in', fixturePath,
      '--out', outPath,
      '--qa_status', 'approved',
      '--annotator', 'test_annotator',
    ], { cwd: root });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.imported_rows, 2);
    assert.ok(summary.label_coverage.skin >= 2);

    const rows = await readNdjson(outPath);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.schema_version, 'aurora.gold_labels.v1');
      assert.equal(typeof row.sample_hash, 'string');
      assert.ok(row.labels && row.labels.skin && Array.isArray(row.labels.skin.points_norm));
      const points = row.labels.skin.points_norm;
      assert.ok(points.length >= 3);
      for (const point of points) {
        assert.ok(point.x >= 0 && point.x <= 1);
        assert.ok(point.y >= 0 && point.y <= 1);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('eval_gold.mjs evaluates imported fixture labels and writes reports', async () => {
  const root = await makeTempDir('aurora_gold_labeling_eval_');
  try {
    const fixturePath = repoPath('tests', 'fixtures', 'gold_labeling', 'label_studio_export_mock.json');
    const importScript = repoPath('scripts', 'gold_label_import.mjs');
    const evalScript = repoPath('scripts', 'eval_gold.mjs');

    const goldPath = path.join(root, 'artifacts', 'gold_labels.ndjson');
    await runExecFile('node', [
      importScript,
      '--in', fixturePath,
      '--out', goldPath,
      '--qa_status', 'approved',
      '--annotator', 'test_annotator',
    ], { cwd: root });

    const goldRows = await readNdjson(goldPath);
    assert.equal(goldRows.length, 2);

    const predRows = goldRows.map((row) => ({
      sample_hash: row.sample_hash,
      source: row.source,
      pred_skin_points_norm: row.labels.skin.points_norm,
      pred_oval_points_norm: row.labels.face_oval.points_norm,
      modules_count: 5,
      module_pixels_map: {
        chin: 320,
        forehead: 280,
      },
      quality_grade: 'pass',
    }));
    const predPath = path.join(root, 'reports', 'pred_fixture.jsonl');
    await writeNdjson(predPath, predRows);

    const calibrationPath = path.join(root, 'artifacts', 'calibration_train_samples.ndjson');
    const reportDir = path.join(root, 'reports');
    const { stdout } = await runExecFile('node', [
      evalScript,
      '--gold_labels', goldPath,
      '--pred_jsonl', predPath,
      '--report_dir', reportDir,
      '--calibration_out', calibrationPath,
      '--grid_size', '128',
      '--rerun_local', 'false',
    ], { cwd: root });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.samples_total, 2);
    assert.ok(summary.samples_scored >= 2);

    const mdPath = path.join(root, summary.report_md);
    const csvPath = path.join(root, summary.report_csv);
    const jsonlPath = path.join(root, summary.report_jsonl);
    const calPath = path.join(root, summary.calibration_train_samples);

    const [mdStat, csvStat, jsonlStat, calStat] = await Promise.all([
      fs.stat(mdPath),
      fs.stat(csvPath),
      fs.stat(jsonlPath),
      fs.stat(calPath),
    ]);
    assert.ok(mdStat.size > 0);
    assert.ok(csvStat.size > 0);
    assert.ok(jsonlStat.size > 0);
    assert.ok(calStat.size > 0);

    const evalRows = await readNdjson(jsonlPath);
    assert.equal(evalRows.length, 2);
    assert.ok(evalRows.every((row) => typeof row.skin_iou === 'number'));

    const calibrationRows = await readNdjson(calPath);
    assert.ok(calibrationRows.length >= 2);
    assert.ok(calibrationRows.every((row) => row.model_output && row.gold_label));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
