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

test('eval_gold_ab.mjs supports --help', async () => {
  const abScript = repoPath('scripts', 'eval_gold_ab.mjs');
  const { stdout } = await runExecFile('node', [abScript, '--help'], { cwd: repoPath() });
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--gold_labels <path>/);
  assert.match(stdout, /--variant3_sweep <csv>/);
});

test('eval_gold_ab.mjs outputs recommended_group and core metrics', async () => {
  const root = await makeTempDir('aurora_eval_gold_ab_');
  try {
    const fixturePath = repoPath('tests', 'fixtures', 'gold_labeling', 'label_studio_export_real_round1.json');
    const importScript = repoPath('scripts', 'gold_label_import.mjs');
    const abScript = repoPath('scripts', 'eval_gold_ab.mjs');

    const goldPath = path.join(root, 'artifacts', 'gold_labels_round1.ndjson');
    await runExecFile('node', [
      importScript,
      '--in', fixturePath,
      '--out', goldPath,
      '--qa_status', 'approved',
    ], { cwd: root });
    const goldRows = await readNdjson(goldPath);
    assert.equal(goldRows.length, 2);

    const predRows = goldRows.map((row) => ({
      sample_hash: row.sample_hash,
      source: row.source,
      pred_skin_mask_rle_norm: row.skin_mask.rle_norm,
      pred_oval_mask_rle_norm: row.face_oval_mask.rle_norm,
      module_masks: row.module_masks,
      modules_count: 7,
      quality_grade: 'pass',
    }));
    const predPath = path.join(root, 'reports', 'pred_gold_ab_fixture.jsonl');
    await writeNdjson(predPath, predRows);

    const { stdout } = await runExecFile('node', [
      abScript,
      '--gold_labels', goldPath,
      '--pred_jsonl', predPath,
      '--report_dir', path.join(root, 'reports'),
      '--grid_size', '128',
      '--rerun_local', 'false',
      '--variant3_sweep', '8:0.2,12:0.25,16:0.3',
      '--under_eye_min_coverage', '0.05',
    ], { cwd: root });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(typeof summary.recommended_group, 'string');
    assert.ok(summary.recommended_group.length > 0);

    const reportJsonPath = path.join(root, summary.report_json);
    const reportPayload = JSON.parse(await fs.readFile(reportJsonPath, 'utf8'));
    assert.equal(reportPayload.ok, true);
    assert.equal(typeof reportPayload.recommended_group, 'string');
    assert.ok(Array.isArray(reportPayload.groups));
    assert.ok(reportPayload.groups.length >= 4);
    assert.ok(reportPayload.groups.every((row) => row.metrics && Object.prototype.hasOwnProperty.call(row.metrics, 'strong_module_miou_mean')));
    assert.ok(reportPayload.groups.every((row) => row.metrics && Object.prototype.hasOwnProperty.call(row.metrics, 'forehead_hair_overlap_rate_mean')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
