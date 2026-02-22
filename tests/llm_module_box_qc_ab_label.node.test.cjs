const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function writeJsonl(filePath, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runAbLabel({
  llmResultsPath,
  outDir,
  tasksJsonPath,
  extraArgs = [],
}) {
  const scriptPath = path.resolve(__dirname, '../scripts/llm_module_box_qc_ab_label.mjs');
  const args = [
    scriptPath,
    '--llm_results', llmResultsPath,
    '--out', outDir,
    '--tasks_json', tasksJsonPath,
    '--decision_mode', 'consumer',
    '--hard_block_only', 'true',
  ];
  if (Array.isArray(extraArgs) && extraArgs.length) {
    args.push(...extraArgs.map((item) => String(item)));
  }
  const proc = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (proc.status !== 0) {
    throw new Error(`ab_label failed (status=${proc.status}):\nSTDOUT:\n${proc.stdout}\nSTDERR:\n${proc.stderr}`);
  }
}

async function writeTasksJson(tasksJsonPath, sampleHash) {
  const payload = [
    {
      data: {
        sample_hash: sampleHash,
        role_a: 'baseline',
        role_b: 'variant',
        baseline_id: 'baseline_default',
        variant_id: 'variant1_forehead_hair_clip',
      },
    },
  ];
  await fsp.writeFile(tasksJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('ab_label: manual delta guard moves high-delta revise pair into manual queue', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ab-label-manual-delta-hit-'));
  try {
    const llmResultsPath = path.join(tmpDir, 'llm_qc_results.jsonl');
    const outDir = path.join(tmpDir, 'ab_label');
    const tasksJsonPath = path.join(tmpDir, 'tasks.json');
    writeJsonl(llmResultsPath, [
      {
        sample_hash: 'sample_manual_delta_hit',
        source: 'internal',
        side: 'A',
        decision: 'revise',
        confidence: 0.95,
        corrected_modules_count: 3,
        mean_delta_l1: 0.22,
        violations: [],
      },
      {
        sample_hash: 'sample_manual_delta_hit',
        source: 'internal',
        side: 'B',
        decision: 'accept',
        confidence: 0.95,
        corrected_modules_count: 0,
        mean_delta_l1: 0,
        violations: [],
      },
    ]);
    await writeTasksJson(tasksJsonPath, 'sample_manual_delta_hit');

    runAbLabel({
      llmResultsPath,
      outDir,
      tasksJsonPath,
      extraArgs: [
        '--manual_delta_guard_enabled', 'true',
        '--manual_delta_guard_pair_max', '0.19',
        '--manual_delta_guard_min_corrected', '3',
        '--manual_delta_guard_decisions', 'revise',
      ],
    });

    const summary = JSON.parse(await fsp.readFile(path.join(outDir, 'summary.json'), 'utf8'));
    const labels = readJsonl(path.join(outDir, 'ab_labels.jsonl'));
    assert.equal(summary.manual_delta_guard_total, 1);
    assert.equal(summary.manual_review_total, 1);
    assert.equal(summary.manual_review_reasons_counts.manual_delta_guard, 1);
    assert.equal(labels.length, 1);
    assert.equal(Boolean(labels[0].manual_delta_guard_triggered), true);
    assert.equal(Boolean(labels[0].needs_manual_review), true);
    assert.ok(Array.isArray(labels[0].manual_delta_guard_reasons));
    assert.ok(labels[0].manual_delta_guard_reasons.includes('side_a_high_mean_delta'));
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('ab_label: manual delta guard does not trigger for below-threshold revise pair', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ab-label-manual-delta-miss-'));
  try {
    const llmResultsPath = path.join(tmpDir, 'llm_qc_results.jsonl');
    const outDir = path.join(tmpDir, 'ab_label');
    const tasksJsonPath = path.join(tmpDir, 'tasks.json');
    writeJsonl(llmResultsPath, [
      {
        sample_hash: 'sample_manual_delta_miss',
        source: 'internal',
        side: 'A',
        decision: 'revise',
        confidence: 0.95,
        corrected_modules_count: 3,
        mean_delta_l1: 0.15,
        violations: [],
      },
      {
        sample_hash: 'sample_manual_delta_miss',
        source: 'internal',
        side: 'B',
        decision: 'accept',
        confidence: 0.95,
        corrected_modules_count: 0,
        mean_delta_l1: 0,
        violations: [],
      },
    ]);
    await writeTasksJson(tasksJsonPath, 'sample_manual_delta_miss');

    runAbLabel({
      llmResultsPath,
      outDir,
      tasksJsonPath,
      extraArgs: [
        '--manual_delta_guard_enabled', 'true',
        '--manual_delta_guard_pair_max', '0.19',
        '--manual_delta_guard_min_corrected', '3',
        '--manual_delta_guard_decisions', 'revise',
      ],
    });

    const summary = JSON.parse(await fsp.readFile(path.join(outDir, 'summary.json'), 'utf8'));
    const labels = readJsonl(path.join(outDir, 'ab_labels.jsonl'));
    assert.equal(summary.manual_delta_guard_total, 0);
    assert.equal(summary.manual_review_total, 0);
    assert.equal(labels.length, 1);
    assert.equal(Boolean(labels[0].manual_delta_guard_triggered), false);
    assert.equal(Boolean(labels[0].needs_manual_review), false);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
