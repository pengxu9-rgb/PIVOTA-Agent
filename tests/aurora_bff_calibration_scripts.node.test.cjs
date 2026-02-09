const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runExecFile = promisify(execFile);

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeNdjson(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fs.writeFile(filePath, payload, 'utf8');
}

function repoScript(...parts) {
  return path.join(__dirname, '..', ...parts);
}

function makeConcern(type, confidence, x0, y0, x1, y1) {
  return {
    type,
    confidence,
    severity: 2,
    regions: [
      {
        kind: 'bbox',
        bbox_norm: { x0, y0, x1, y1 },
      },
    ],
  };
}

test('train_calibrator and eval_calibration run end-to-end', async () => {
  const root = await makeTempDir('aurora_cal_scripts_');
  try {
    const outputsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson');
    const goldPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson');
    const outDir = path.join(root, 'model_registry');
    const aliasPath = path.join(outDir, 'diag_calibration_v1.json');
    const evalOutPath = path.join(root, 'reports', 'calibration_eval.json');

    const outputs = [
      {
        inference_id: 'inf_1',
        provider: 'gemini_provider',
        quality_grade: 'pass',
        skin_tone_bucket: 'light',
        lighting_bucket: 'daylight',
        output_json: { concerns: [makeConcern('acne', 0.9, 0.2, 0.2, 0.5, 0.5)] },
      },
      {
        inference_id: 'inf_2',
        provider: 'gemini_provider',
        quality_grade: 'pass',
        skin_tone_bucket: 'deep',
        lighting_bucket: 'indoor',
        output_json: { concerns: [makeConcern('acne', 0.8, 0.55, 0.55, 0.9, 0.9)] },
      },
      {
        inference_id: 'inf_1',
        provider: 'gpt_provider',
        quality_grade: 'pass',
        skin_tone_bucket: 'light',
        lighting_bucket: 'daylight',
        output_json: { concerns: [makeConcern('acne', 0.85, 0.21, 0.21, 0.49, 0.49)] },
      },
      {
        inference_id: 'inf_2',
        provider: 'gpt_provider',
        quality_grade: 'pass',
        skin_tone_bucket: 'deep',
        lighting_bucket: 'indoor',
        output_json: { concerns: [makeConcern('tone', 0.7, 0.15, 0.15, 0.3, 0.3)] },
      },
    ];
    const gold = [
      {
        inference_id: 'inf_1',
        qa_status: 'approved',
        concerns: [makeConcern('acne', 1, 0.2, 0.2, 0.5, 0.5)],
      },
      {
        inference_id: 'inf_2',
        qa_status: 'approved',
        concerns: [makeConcern('acne', 1, 0.55, 0.55, 0.9, 0.9)],
      },
    ];
    await writeNdjson(outputsPath, outputs);
    await writeNdjson(goldPath, gold);

    const trainScript = repoScript('scripts', 'train_calibrator.js');
    const evalScript = repoScript('scripts', 'eval_calibration.js');

    const train = await runExecFile('node', [
      trainScript,
      '--modelOutputs',
      outputsPath,
      '--goldLabels',
      goldPath,
      '--outDir',
      outDir,
      '--aliasPath',
      aliasPath,
      '--minGroupSamples',
      '1',
    ], { cwd: root });
    const trainSummary = JSON.parse(train.stdout);
    assert.ok(trainSummary.model_version.startsWith('calibrator_v'));
    assert.equal(trainSummary.samples_total > 0, true);

    const evaluate = await runExecFile('node', [
      evalScript,
      '--model',
      aliasPath,
      '--modelOutputs',
      outputsPath,
      '--goldLabels',
      goldPath,
      '--outJson',
      evalOutPath,
    ], { cwd: root });
    const evalSummary = JSON.parse(evaluate.stdout);
    assert.equal(evalSummary.schema_version, 'aurora.diag.calibration_model.v1');
    assert.equal(evalSummary.input_counts.eval_rows > 0, true);
    assert.equal(typeof evalSummary.metrics.calibrated.ece, 'number');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
