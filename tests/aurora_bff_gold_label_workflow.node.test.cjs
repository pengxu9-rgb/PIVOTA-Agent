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

async function readNdjson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function repoScript(...parts) {
  return path.join(__dirname, '..', ...parts);
}

function todayKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
}

function todayPrefix() {
  const key = todayKey();
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
}

function makeModelOutput({ inferenceId, provider, quality = 'pass', concernType = 'acne', createdAt }) {
  return {
    schema_version: 'aurora.diag.model_output.v1',
    record_id: `mo_${inferenceId}_${provider}`,
    inference_id: inferenceId,
    created_at: createdAt || `${todayPrefix()}T08:00:00.000Z`,
    provider,
    model_name: `${provider}_model`,
    model_version: 'v1',
    quality_grade: quality,
    skin_tone_bucket: 'medium',
    lighting_bucket: 'daylight',
    region_bucket: 'us',
    device_class: 'mobile',
    output_json: {
      ok: true,
      concerns: [
        {
          type: concernType,
          severity: 2,
          confidence: 0.8,
          quality_sensitivity: 'medium',
          source_model: provider,
          evidence_text: 'sample',
          regions: [
            {
              kind: 'bbox',
              bbox_norm: { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5 },
            },
          ],
        },
      ],
    },
  };
}

function makeHardCase({ inferenceId, reason = 'LOW_AGREEMENT', issueType = 'acne', createdAt }) {
  return {
    schema_version: 'aurora.diag.hard_case_daily.v1',
    created_at: createdAt || `${todayPrefix()}T08:30:00.000Z`,
    inference_id: inferenceId,
    request_id_hash: `req_${inferenceId}`,
    asset_id_hash: `asset_${inferenceId}`,
    disagreement_reason: reason,
    issue_type: issueType,
    quality_summary: {
      quality_grade: 'pass',
      tone_bucket: 'medium',
      lighting_bucket: 'daylight',
      device_class: 'mobile',
    },
    suggested_fix_summary: 'Recheck region alignment.',
  };
}

test('sample_gold_label_tasks outputs Label Studio tasks and respects hard-case prioritization', async () => {
  const root = await makeTempDir('aurora_gold_sample_');
  try {
    const dateKey = todayKey();
    const hardCasesPath = path.join(root, 'reports', 'pseudo_label_job', dateKey, 'hard_cases_daily.jsonl');
    const modelOutputsPath = path.join(root, 'tmp', 'diag_pseudo_label_factory', 'model_outputs.ndjson');
    const outPath = path.join(root, 'out', 'tasks.jsonl');

    await writeNdjson(hardCasesPath, [
      makeHardCase({ inferenceId: 'inf_h1' }),
      makeHardCase({ inferenceId: 'inf_h2', issueType: 'redness' }),
    ]);
    await writeNdjson(modelOutputsPath, [
      makeModelOutput({ inferenceId: 'inf_r1', provider: 'gemini_provider', concernType: 'texture' }),
      makeModelOutput({ inferenceId: 'inf_r1', provider: 'gpt_provider', concernType: 'texture' }),
      makeModelOutput({ inferenceId: 'inf_r2', provider: 'gemini_provider', concernType: 'tone' }),
      makeModelOutput({ inferenceId: 'inf_r2', provider: 'gpt_provider', concernType: 'tone' }),
    ]);

    const scriptPath = repoScript('scripts', 'sample_gold_label_tasks.js');
    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--date',
      dateKey,
      '--out',
      outPath,
      '--total',
      '3',
      '--hardRatio',
      '0.67',
    ], { cwd: root });

    const summary = JSON.parse(stdout);
    assert.equal(summary.output.selected_total, 3);

    const tasks = await readNdjson(outPath);
    assert.equal(tasks.length, 3);
    const hardCount = tasks.filter((task) => task.data.source === 'hard_case').length;
    assert.ok(hardCount >= 2);
    assert.ok(tasks[0].data.schema_version === 'aurora.diag.gold_label_task.v1');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('import_gold_labels normalizes Label Studio export into canonical gold labels', async () => {
  const root = await makeTempDir('aurora_gold_import_');
  try {
    const inPath = path.join(root, 'tasks.json');
    const outPath = path.join(root, 'gold_labels.ndjson');
    const payload = [
      {
        id: 'task_001',
        data: {
          inference_id: 'inf_import_1',
          quality_grade: 'pass',
          tone_bucket: 'deep',
          lighting_bucket: 'indoor',
          region_bucket: 'cn',
        },
        annotations: [
          {
            result: [
              {
                type: 'rectanglelabels',
                value: {
                  x: 10,
                  y: 20,
                  width: 30,
                  height: 40,
                  rectanglelabels: ['acne'],
                },
              },
            ],
          },
        ],
      },
    ];
    await fs.writeFile(inPath, JSON.stringify(payload, null, 2), 'utf8');

    const scriptPath = repoScript('scripts', 'import_gold_labels.js');
    await runExecFile('node', [
      scriptPath,
      '--in',
      inPath,
      '--out',
      outPath,
      '--qaStatus',
      'approved',
      '--annotatorId',
      'annotator_x',
    ], { cwd: root });

    const rows = await readNdjson(outPath);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.schema_version, 'aurora.diag.gold_label.v1');
    assert.equal(row.inference_id, 'inf_import_1');
    assert.equal(row.annotator_id, 'annotator_x');
    assert.equal(Array.isArray(row.concerns), true);
    assert.equal(row.concerns[0].type, 'acne');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
