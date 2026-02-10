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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_err) {
    return false;
  }
}

function repoScript(...parts) {
  return path.join(__dirname, '..', ...parts);
}

function makeConcern(type, bbox) {
  return {
    type,
    confidence: 0.8,
    severity: 2,
    regions: [
      {
        kind: 'bbox',
        bbox_norm: bbox,
      },
    ],
  };
}

test('eval_region_accuracy computes region/type metrics and writes artifacts', async () => {
  const root = await makeTempDir('aurora_region_eval_');
  try {
    const modelOutputsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson');
    const goldLabelsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson');
    const outJson = path.join(root, 'reports', 'region_accuracy_eval.json');
    const outCsv = path.join(root, 'reports', 'region_accuracy_eval.csv');
    const outMd = path.join(root, 'reports', 'region_accuracy_eval.md');

    const modelOutputs = [
      {
        inference_id: 'inf_1',
        provider: 'gemini_provider',
        output_json: {
          concerns: [
            makeConcern('acne', { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 }),
          ],
        },
      },
      {
        inference_id: 'inf_2',
        provider: 'gemini_provider',
        output_json: {
          concerns: [
            makeConcern('acne', { x0: 0.6, y0: 0.6, x1: 0.9, y1: 0.9 }),
          ],
        },
      },
    ];

    const goldLabels = [
      {
        inference_id: 'inf_1',
        qa_status: 'approved',
        concerns: [
          makeConcern('acne', { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 }),
        ],
      },
      {
        inference_id: 'inf_2',
        qa_status: 'approved',
        concerns: [
          makeConcern('acne', { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 }),
        ],
      },
    ];

    await writeNdjson(modelOutputsPath, modelOutputs);
    await writeNdjson(goldLabelsPath, goldLabels);

    const scriptPath = repoScript('scripts', 'eval_region_accuracy.js');
    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--modelOutputs',
      modelOutputsPath,
      '--goldLabels',
      goldLabelsPath,
      '--iouThreshold',
      '0.3',
      '--outJson',
      outJson,
      '--outCsv',
      outCsv,
      '--outMd',
      outMd,
    ], { cwd: root });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.matched_inference_total, 2);
    assert.equal(summary.overall.tp, 1);
    assert.equal(summary.overall.fp, 1);
    assert.equal(summary.overall.fn, 1);
    assert.equal(summary.overall.precision, 0.5);
    assert.equal(summary.overall.recall, 0.5);
    assert.equal(summary.overall.f1, 0.5);

    const csvRaw = await fs.readFile(outCsv, 'utf8');
    const mdRaw = await fs.readFile(outMd, 'utf8');
    const jsonRaw = JSON.parse(await fs.readFile(outJson, 'utf8'));

    assert.equal(csvRaw.includes('overall'), true);
    assert.equal(mdRaw.includes('Region Accuracy Evaluation'), true);
    assert.equal(Array.isArray(jsonRaw.by_type), true);
    assert.equal(jsonRaw.by_type.length > 0, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('eval_region_accuracy fails with explicit error when gold labels file is missing', async () => {
  const root = await makeTempDir('aurora_region_eval_missing_gold_');
  try {
    const modelOutputsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson');
    const missingGoldLabelsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson');
    const outJson = path.join(root, 'reports', 'region_accuracy_eval.json');

    await writeNdjson(modelOutputsPath, [
      {
        inference_id: 'inf_1',
        provider: 'gemini_provider',
        output_json: {
          concerns: [makeConcern('acne', { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 })],
        },
      },
    ]);

    const scriptPath = repoScript('scripts', 'eval_region_accuracy.js');
    await assert.rejects(
      runExecFile('node', [
        scriptPath,
        '--modelOutputs',
        modelOutputsPath,
        '--goldLabels',
        missingGoldLabelsPath,
        '--outJson',
        outJson,
      ], { cwd: root }),
      (error) => {
        assert.equal(error.code, 2);
        const stdoutPayload = JSON.parse(String(error.stdout || '{}'));
        assert.equal(stdoutPayload.ok, false);
        assert.equal(stdoutPayload.error.code, 'GOLD_LABELS_MISSING');
        assert.match(String(error.stderr || ''), /GOLD_LABELS_MISSING/);
        return true;
      },
    );

    assert.equal(await pathExists(outJson), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('eval_region_accuracy fails with explicit error when gold labels file is empty', async () => {
  const root = await makeTempDir('aurora_region_eval_empty_gold_');
  try {
    const modelOutputsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson');
    const goldLabelsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson');
    const outJson = path.join(root, 'reports', 'region_accuracy_eval.json');

    await writeNdjson(modelOutputsPath, [
      {
        inference_id: 'inf_1',
        provider: 'gemini_provider',
        output_json: {
          concerns: [makeConcern('acne', { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 })],
        },
      },
    ]);
    await writeNdjson(goldLabelsPath, []);

    const scriptPath = repoScript('scripts', 'eval_region_accuracy.js');
    await assert.rejects(
      runExecFile('node', [
        scriptPath,
        '--modelOutputs',
        modelOutputsPath,
        '--goldLabels',
        goldLabelsPath,
        '--outJson',
        outJson,
      ], { cwd: root }),
      (error) => {
        assert.equal(error.code, 3);
        const stdoutPayload = JSON.parse(String(error.stdout || '{}'));
        assert.equal(stdoutPayload.ok, false);
        assert.equal(stdoutPayload.error.code, 'GOLD_LABELS_EMPTY');
        assert.match(String(error.stderr || ''), /GOLD_LABELS_EMPTY/);
        return true;
      },
    );

    assert.equal(await pathExists(outJson), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('eval_region_accuracy can bypass empty-gold guard with allowEmptyGold=true', async () => {
  const root = await makeTempDir('aurora_region_eval_allow_empty_gold_');
  try {
    const modelOutputsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson');
    const goldLabelsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'gold_labels.ndjson');
    const outJson = path.join(root, 'reports', 'region_accuracy_eval.json');

    await writeNdjson(modelOutputsPath, [
      {
        inference_id: 'inf_1',
        provider: 'gemini_provider',
        output_json: {
          concerns: [makeConcern('acne', { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 })],
        },
      },
    ]);
    await writeNdjson(goldLabelsPath, []);

    const scriptPath = repoScript('scripts', 'eval_region_accuracy.js');
    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--modelOutputs',
      modelOutputsPath,
      '--goldLabels',
      goldLabelsPath,
      '--allowEmptyGold',
      'true',
      '--outJson',
      outJson,
    ], { cwd: root });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.overall.samples, 0);
    assert.equal(await pathExists(outJson), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
