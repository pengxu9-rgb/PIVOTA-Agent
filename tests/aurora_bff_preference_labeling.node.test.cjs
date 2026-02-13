const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runExecFile = promisify(execFile);

function repoPath(...parts) {
  return path.join(__dirname, '..', ...parts);
}

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeImageJpg(filePath, color) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const width = 256;
  const height = 256;
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let i = 0; i < raw.length; i += channels) {
    raw[i] = color[0];
    raw[i + 1] = color[1];
    raw[i + 2] = color[2];
  }
  await sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 92 }).toFile(filePath);
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fs.writeFile(filePath, payload, 'utf8');
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function readNdjson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function fileSha256(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function createExternalIndex(indexPath, imageRelPaths) {
  const rows = imageRelPaths.map((rel, i) => ({
    sample_id: `idx_${i + 1}`,
    image_path: rel,
    split: 'train',
  }));
  await writeJsonl(indexPath, rows);
}

function buildMockLsExport(tasks) {
  return tasks.map((task, idx) => {
    const data = task.data || {};
    const baseChoice = idx % 4 === 0 ? 'A' : idx % 4 === 1 ? 'B' : idx % 4 === 2 ? 'tie' : 'cannot_tell';
    const first = {
      id: `ann_${idx}_a`,
      created_at: '2026-02-12T01:00:00.000Z',
      updated_at: '2026-02-12T01:02:00.000Z',
      completed_by: { id: 101, email: 'annotator_a@example.com' },
      result: [
        { from_name: 'overall_choice', type: 'choices', value: { choices: [baseChoice] } },
        { from_name: 'overall_confidence', type: 'rating', value: { rating: (idx % 5) + 1, max: 5 } },
        {
          from_name: 'overall_reasons',
          type: 'choices',
          value: {
            choices: idx % 2 === 0
              ? ['overall_similar']
              : ['hairline_forehead_ambiguous', 'blur_or_low_res'],
          },
        },
        { from_name: 'pref_nose', type: 'choices', value: { choices: [idx % 2 === 0 ? 'A' : 'B'] } },
        { from_name: 'pref_forehead', type: 'choices', value: { choices: [idx % 3 === 0 ? 'B' : 'A'] } },
        { from_name: 'pref_left_cheek', type: 'choices', value: { choices: ['tie'] } },
        { from_name: 'pref_right_cheek', type: 'choices', value: { choices: [idx % 5 === 0 ? 'cannot_tell' : 'A'] } },
        { from_name: 'pref_chin', type: 'choices', value: { choices: ['A'] } },
        { from_name: 'notes', type: 'textarea', value: { text: [`note-a-${idx}`] } },
      ],
    };

    const annotations = [first];
    if (String(data.task_batch || '').toUpperCase() === 'OVERLAP') {
      annotations.push({
        id: `ann_${idx}_b`,
        created_at: '2026-02-12T01:05:00.000Z',
        updated_at: '2026-02-12T01:06:00.000Z',
        completed_by: { id: 202, email: 'annotator_b@example.com' },
        result: [
          { from_name: 'overall_choice', type: 'choices', value: { choices: ['B'] } },
          { from_name: 'overall_confidence', type: 'rating', value: { rating: 2, max: 5 } },
          { from_name: 'overall_reasons', type: 'choices', value: { choices: ['occlusion_or_shadow'] } },
          { from_name: 'pref_nose', type: 'choices', value: { choices: ['B'] } },
          { from_name: 'pref_forehead', type: 'choices', value: { choices: ['B'] } },
          { from_name: 'pref_chin', type: 'choices', value: { choices: ['A'] } },
          { from_name: 'notes', type: 'textarea', value: { text: ['note-b'] } },
        ],
      });
    }

    return {
      id: task.id || `task_${idx}`,
      data,
      annotations,
    };
  });
}

test('preference scripts support --help', async () => {
  const scripts = [
    'preference_round1_pack.mjs',
    'preference_round1_real_runbook.mjs',
    'preference_label_import.mjs',
    'eval_preference.mjs',
    'preference_adjudication_pack.mjs',
    'preference_release_gate.mjs',
    'preference_merge_adjudication.mjs',
    'preference_eval_final.mjs',
    'preference_diagnostics.mjs',
    'preference_next_variants.mjs',
  ];
  for (const script of scripts) {
    const scriptPath = repoPath('scripts', script);
    const { stdout } = await runExecFile('node', [scriptPath, '--help'], { cwd: repoPath() });
    assert.match(stdout, /Usage:/);
  }
});

test('preference_round1_pack hard filter gate blocks obviously bad samples before tasks export', async () => {
  const root = await makeTempDir('aurora_pref_hard_gate_v1_');
  try {
    const scriptPath = repoPath('scripts', 'preference_round1_pack.mjs');
    const reviewPath = path.join(root, 'review_pack_mixed.jsonl');
    const internalDir = path.join(root, 'internal');
    const imagePath = path.join(internalDir, 'p1.jpg');
    const outDir = path.join(root, 'artifacts', 'preference_round1_test');

    await writeImageJpg(imagePath, [150, 120, 100]);
    await writeJsonl(reviewPath, [
      {
        source: 'internal',
        sample_hash: 'hard_gate_sample_01',
        image_path: imagePath,
        ok: true,
        pipeline_mode_used: 'local',
      },
    ]);

    await assert.rejects(
      () => runExecFile('node', [
        scriptPath,
        '--run_id', '20260213_200001001',
        '--review_in', reviewPath,
        '--out', outDir,
        '--seed', 'hard_gate_seed_v1',
        '--limit_internal', '1',
        '--limit_lapa', '0',
        '--limit_celeba', '0',
        '--internal_dir', internalDir,
        '--mock_pipeline', 'true',
        '--hard_filter_gate', 'true',
        '--hard_filter_min_module_pixels', '1000',
        '--hard_filter_fail_on_empty', 'true',
      ], { cwd: repoPath() }),
      (error) => {
        assert.equal(error && error.code, 4);
        assert.match(String(error && error.stderr || ''), /hard_filter_gate_failed/);
        return true;
      },
    );

    const manifest = await readJson(path.join(outDir, 'manifest.json'));
    assert.equal(Array.isArray(manifest.rows), true);
    assert.equal(manifest.rows.length, 0);
    assert.equal(Array.isArray(manifest.excluded), true);
    assert.ok(
      manifest.excluded.some((row) => String(row && row.reason || '').includes('hard_filter_module_pixels_min')),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_round1_pack hard filter can require non-template mask_rle coverage', async () => {
  const root = await makeTempDir('aurora_pref_hard_gate_mask_rle_');
  try {
    const scriptPath = repoPath('scripts', 'preference_round1_pack.mjs');
    const reviewPath = path.join(root, 'review_pack_mixed.jsonl');
    const internalDir = path.join(root, 'internal');
    const imagePath = path.join(internalDir, 'p1.jpg');
    const outDir = path.join(root, 'artifacts', 'preference_round1_test');

    await writeImageJpg(imagePath, [150, 120, 100]);
    await writeJsonl(reviewPath, [
      {
        source: 'internal',
        sample_hash: 'hard_gate_mask_rle_sample_01',
        image_path: imagePath,
        ok: true,
        pipeline_mode_used: 'local',
      },
    ]);

    await runExecFile('node', [
      scriptPath,
      '--run_id', '20260213_230001001',
      '--review_in', reviewPath,
      '--out', outDir,
      '--seed', 'hard_gate_seed_mask_rle_v1',
      '--limit_internal', '1',
      '--limit_lapa', '0',
      '--limit_celeba', '0',
      '--internal_dir', internalDir,
      '--mock_pipeline', 'true',
      '--hard_filter_gate', 'true',
      '--hard_filter_require_quality_pass', 'false',
      '--hard_filter_max_guarded_modules', '99',
      '--hard_filter_min_module_pixels', '0',
      '--hard_filter_min_dynamic_score', '0',
      '--hard_filter_min_box_plausibility', '0',
      '--hard_filter_min_mask_rle_ratio', '0.2',
      '--hard_filter_require_all_strong_modules', 'false',
      '--hard_filter_fail_on_empty', 'true',
    ], { cwd: repoPath() });

    const manifest = await readJson(path.join(outDir, 'manifest.json'));
    assert.equal(Array.isArray(manifest.rows), true);
    assert.equal(manifest.rows.length, 1);
    assert.equal(Array.isArray(manifest.excluded), true);
    assert.equal(manifest.excluded.length, 0);
    const first = manifest.rows[0];
    assert.ok(first && Array.isArray(first.baseline_module_rows));
    const strong = new Set(['nose', 'forehead', 'left_cheek', 'right_cheek', 'chin']);
    const strongRows = first.baseline_module_rows.filter((row) => strong.has(String(row && row.module_id || '')));
    assert.ok(strongRows.length >= 5);
    const withMask = strongRows.filter((row) => typeof row.mask_rle_norm === 'string' && row.mask_rle_norm.trim());
    assert.ok(withMask.length >= 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_round1_real_runbook deterministic split/order/flip with batch files', async () => {
  const root = await makeTempDir('aurora_pref_real_det_v2_');
  try {
    const runId = '20260212_190001001';
    const internalDir = path.join(root, 'internal_clean');
    const lapaRoot = path.join(root, 'datasets_cache', 'external', 'lapa');
    const celebaRoot = path.join(root, 'datasets_cache', 'external', 'celebamaskhq');

    const internalFiles = [
      path.join('setA', 'internal_01.jpg'),
      path.join('setA', 'internal_02.jpg'),
      path.join('setB', 'internal_03.jpg'),
    ];
    const lapaFiles = [
      path.join('nested', 'lapa_01.jpg'),
      path.join('nested', 'lapa_02.jpg'),
      path.join('nested', 'lapa_03.jpg'),
    ];
    const celebaFiles = [
      path.join('deep', 'celeb_01.jpg'),
      path.join('deep', 'celeb_02.jpg'),
      path.join('deep', 'celeb_03.jpg'),
    ];

    for (const rel of internalFiles) await writeImageJpg(path.join(internalDir, rel), [160, 120, 100]);
    for (const rel of lapaFiles) await writeImageJpg(path.join(lapaRoot, rel), [110, 170, 140]);
    for (const rel of celebaFiles) await writeImageJpg(path.join(celebaRoot, rel), [120, 130, 190]);

    const lapaIndex = path.join(lapaRoot, 'index.jsonl');
    const celebaIndex = path.join(celebaRoot, 'index.jsonl');
    await createExternalIndex(lapaIndex, lapaFiles);
    await createExternalIndex(celebaIndex, celebaFiles);

    const scriptPath = repoPath('scripts', 'preference_round1_real_runbook.mjs');
    const outA = path.join(root, 'artifacts', 'outA');
    const outB = path.join(root, 'artifacts', 'outB');

    const commonArgs = [
      scriptPath,
      '--run_id', runId,
      '--internal_dir', internalDir,
      '--external_index_lapa', lapaIndex,
      '--external_index_celeba', celebaIndex,
      '--seed', 'pref_real_seed_v2_det',
      '--limit_internal', '2',
      '--limit_lapa', '2',
      '--limit_celeba', '2',
      '--target_total', '6',
      '--overlap_ratio', '0.25',
      '--overlap_min', '2',
      '--max_edge', '512',
      '--mock_pipeline', 'true',
      '--concurrency', '2',
    ];

    await runExecFile('node', [...commonArgs, '--out', outA], { cwd: repoPath() });
    await runExecFile('node', [...commonArgs, '--out', outB], { cwd: repoPath() });

    const manifestA = await readJson(path.join(outA, 'manifest.json'));
    const manifestB = await readJson(path.join(outB, 'manifest.json'));

    const tasksAllA = await readJson(path.join(outA, 'tasks_all.json'));
    const tasksAllB = await readJson(path.join(outB, 'tasks_all.json'));
    const tasksBatchAA = await readJson(path.join(outA, 'tasks_batch_a.json'));
    const tasksBatchAB = await readJson(path.join(outB, 'tasks_batch_a.json'));
    const tasksBatchBA = await readJson(path.join(outA, 'tasks_batch_b.json'));
    const tasksBatchBB = await readJson(path.join(outB, 'tasks_batch_b.json'));
    const tasksOverlapA = await readJson(path.join(outA, 'tasks_overlap.json'));
    const tasksOverlapB = await readJson(path.join(outB, 'tasks_overlap.json'));

    assert.equal(tasksAllA.length, 6);
    assert.equal(tasksAllB.length, 6);
    assert.equal(manifestA.overlap.overlap_count, 2);
    assert.equal(manifestB.overlap.overlap_count, 2);

    const ids = (tasks) => tasks.map((task) => String(task?.data?.sample_id || ''));
    assert.deepEqual(ids(tasksAllA), ids(tasksAllB));
    assert.deepEqual(ids(tasksBatchAA), ids(tasksBatchAB));
    assert.deepEqual(ids(tasksBatchBA), ids(tasksBatchBB));
    assert.deepEqual(ids(tasksOverlapA), ids(tasksOverlapB));
    assert.deepEqual(manifestA.flip_map, manifestB.flip_map);
    assert.deepEqual(manifestA.batch_assignment, manifestB.batch_assignment);
    assert.ok(manifestA.overlay_diff_summary);
    assert.ok(manifestA.overlay_diff_summary.by_module);
    assert.ok(manifestA.overlay_diff_summary.by_module.forehead);

    const overlapIds = new Set(ids(tasksOverlapA));
    const batchAIds = new Set(ids(tasksBatchAA));
    const batchBIds = new Set(ids(tasksBatchBA));
    for (const sampleId of overlapIds) {
      assert.ok(batchAIds.has(sampleId));
      assert.ok(batchBIds.has(sampleId));
    }

    const rowA = manifestA.rows[0];
    const rowB = manifestB.rows.find((row) => row.sample_id === rowA.sample_id);
    assert.ok(rowA);
    assert.ok(rowB);
    assert.ok(typeof rowA.overlay_diff_ratio === 'number');
    assert.ok(typeof rowA.overlay_diff_pixels === 'number');
    assert.ok(rowA.overlay_bbox && typeof rowA.overlay_bbox === 'object');
    assert.ok(typeof rowA.overlay_zoom === 'number');
    assert.ok(rowA.overlay_diff_modules && typeof rowA.overlay_diff_modules === 'object');
    assert.ok(Object.keys(rowA.overlay_diff_modules).length >= 1);

    const taskA = tasksAllA.find((task) => String(task?.data?.sample_id || '') === rowA.sample_id);
    const taskB = tasksAllB.find((task) => String(task?.data?.sample_id || '') === rowA.sample_id);
    assert.ok(taskA);
    assert.ok(taskB);

    const imageAPath1 = String(taskA.data.image_a_path || '');
    const imageAPath2 = String(taskB.data.image_a_path || '');
    const hash1 = await fileSha256(imageAPath1);
    const hash2 = await fileSha256(imageAPath2);
    assert.equal(hash1, hash2);

    const [metaA, metaB] = await Promise.all([
      sharp(imageAPath1, { failOn: 'none' }).metadata(),
      sharp(imageAPath2, { failOn: 'none' }).metadata(),
    ]);
    assert.equal(metaA.width, metaB.width);
    assert.equal(metaA.height, metaB.height);
    assert.ok(Number(metaA.width) > 0 && Number(metaA.height) > 0);

    const { data: raw, info } = await sharp(imageAPath1, { failOn: 'none' }).raw().toBuffer({ resolveWithObject: true });
    const width = Number(info.width);
    const height = Number(info.height);
    const channels = Number(info.channels);
    let brightTopRightCount = 0;
    // Inset is placed in top-right with a bright white border; scan a small corner window.
    for (let y = 4; y < Math.min(24, height - 1); y += 1) {
      for (let x = Math.max(1, width - 24); x < Math.max(1, width - 2); x += 1) {
        const idx = ((y * width) + x) * channels;
        const r = raw[idx] || 0;
        const g = raw[idx + 1] || 0;
        const b = raw[idx + 2] || 0;
        if (r >= 180 && g >= 180 && b >= 180) {
          brightTopRightCount += 1;
        }
      }
    }
    assert.ok(brightTopRightCount >= 5, `expected inset/border highlights near top-right, found=${brightTopRightCount}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_label_import parses confidence/reasons/task_batch and unflips winner', async () => {
  const root = await makeTempDir('aurora_pref_import_v2_');
  try {
    const runId = '20260212_190001002';
    const importScript = repoPath('scripts', 'preference_label_import.mjs');

    const manifestPath = path.join(root, 'manifest.json');
    const exportPath = path.join(root, 'label_studio_export_preference.json');
    const outPath = path.join(root, 'preference_labels.ndjson');

    await fs.writeFile(manifestPath, `${JSON.stringify({
      run_id: runId,
      flip_map: {
        sample_flip_01: {
          role_a: 'variant',
          role_b: 'baseline',
          flipped: true,
        },
      },
      rows: [
        {
          sample_id: 'sample_flip_01',
          source: 'internal',
          role_a: 'variant',
          role_b: 'baseline',
          baseline_id: 'baseline_default',
          variant_id: 'variant1_forehead_hair_clip',
          task_batch: 'OVERLAP',
        },
      ],
    }, null, 2)}\n`, 'utf8');

    await fs.writeFile(exportPath, `${JSON.stringify([
      {
        id: 'task_1',
        data: {
          sample_id: 'sample_flip_01',
          source: 'internal',
        },
        annotations: [
          {
            id: 'ann_1',
            created_at: '2026-02-12T03:00:00.000Z',
            updated_at: '2026-02-12T03:01:00.000Z',
            completed_by: { id: 9001 },
            result: [
              { from_name: 'overall_choice', type: 'choices', value: { choices: ['A'] } },
              { from_name: 'overall_confidence', type: 'rating', value: { rating: 4, max: 5 } },
              { from_name: 'overall_reasons', type: 'choices', value: { choices: ['blur_or_low_res', 'overall_similar'] } },
              { from_name: 'pref_nose', type: 'choices', value: { choices: ['A'] } },
            ],
          },
        ],
      },
    ], null, 2)}\n`, 'utf8');

    const { stdout } = await runExecFile('node', [
      importScript,
      '--run_id', runId,
      '--in', exportPath,
      '--manifest', manifestPath,
      '--out', outPath,
      '--report_dir', root,
    ], { cwd: repoPath() });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.imported_rows, 1);
    assert.equal(summary.rows_with_invalid_choices, 0);
    assert.equal(summary.missing_confidence_count, 0);

    const rows = await readNdjson(outPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].winner, 'variant1');
    assert.equal(rows[0].confidence_int, 4);
    assert.deepEqual(rows[0].reasons, ['blur_or_low_res', 'overall_similar']);
    assert.equal(rows[0].task_batch, 'OVERLAP');

    await fs.stat(path.join(root, `preference_import_qc_${runId}.md`));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('eval_preference overlap IAA counts correct, risk features propagate, and release gate runs', async () => {
  const root = await makeTempDir('aurora_pref_eval_v2_');
  try {
    const runId = '20260212_190001003';
    const internalDir = path.join(root, 'internal');
    const lapaRoot = path.join(root, 'datasets_cache', 'external', 'lapa');
    const celebaRoot = path.join(root, 'datasets_cache', 'external', 'celebamaskhq');

    const internalFiles = ['i/int_01.jpg', 'i/int_02.jpg', 'i/int_03.jpg', 'i/int_04.jpg', 'i/int_05.jpg'];
    const lapaFiles = ['l/lapa_01.jpg', 'l/lapa_02.jpg', 'l/lapa_03.jpg', 'l/lapa_04.jpg', 'l/lapa_05.jpg'];
    const celebaFiles = ['c/celeb_01.jpg', 'c/celeb_02.jpg', 'c/celeb_03.jpg', 'c/celeb_04.jpg', 'c/celeb_05.jpg'];

    for (const rel of internalFiles) await writeImageJpg(path.join(internalDir, rel), [150, 110, 100]);
    for (const rel of lapaFiles) await writeImageJpg(path.join(lapaRoot, rel), [100, 170, 140]);
    for (const rel of celebaFiles) await writeImageJpg(path.join(celebaRoot, rel), [120, 130, 180]);

    const lapaIndex = path.join(lapaRoot, 'index.jsonl');
    const celebaIndex = path.join(celebaRoot, 'index.jsonl');
    await createExternalIndex(lapaIndex, lapaFiles);
    await createExternalIndex(celebaIndex, celebaFiles);

    const runbookScript = repoPath('scripts', 'preference_round1_real_runbook.mjs');
    const importScript = repoPath('scripts', 'preference_label_import.mjs');
    const evalScript = repoPath('scripts', 'eval_preference.mjs');
    const adjScript = repoPath('scripts', 'preference_adjudication_pack.mjs');
    const gateScript = repoPath('scripts', 'preference_release_gate.mjs');

    const outRoot = path.join(root, 'artifacts', `preference_round1_${runId}`);
    const reportDir = path.join(root, 'reports');

    await runExecFile('node', [
      runbookScript,
      '--run_id', runId,
      '--internal_dir', internalDir,
      '--external_index_lapa', lapaIndex,
      '--external_index_celeba', celebaIndex,
      '--seed', 'pref_real_seed_v2',
      '--limit_internal', '5',
      '--limit_lapa', '5',
      '--limit_celeba', '5',
      '--target_total', '15',
      '--overlap_ratio', '0.3',
      '--overlap_min', '4',
      '--mock_pipeline', 'true',
      '--out', outRoot,
      '--max_edge', '512',
    ], { cwd: repoPath() });

    const tasksAllPath = path.join(outRoot, 'tasks_all.json');
    const manifestPath = path.join(outRoot, 'manifest.json');
    const tasks = await readJson(tasksAllPath);
    const manifest = await readJson(manifestPath);

    // Inject non-zero risk features for one sample to verify propagation into eval jsonl.
    const sampleWithRisk = manifest.rows[0].sample_id;
    manifest.rows[0].risk_features = {
      hair_overlap_est: 0.42,
      leakage_bg_est_mean: 0.13,
      min_module_pixels: 9,
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const exportPayload = buildMockLsExport(tasks);
    const lsExportPath = path.join(outRoot, `label_studio_export_preference_${runId}.json`);
    await fs.writeFile(lsExportPath, `${JSON.stringify(exportPayload, null, 2)}\n`, 'utf8');

    const labelsPath = path.join(outRoot, 'preference_labels.ndjson');
    await runExecFile('node', [
      importScript,
      '--run_id', runId,
      '--in', lsExportPath,
      '--manifest', manifestPath,
      '--out', labelsPath,
      '--report_dir', reportDir,
    ], { cwd: repoPath() });

    const { stdout: evalStdout } = await runExecFile('node', [
      evalScript,
      '--run_id', runId,
      '--labels', labelsPath,
      '--manifest', manifestPath,
      '--report_dir', reportDir,
    ], { cwd: repoPath() });

    const evalSummary = JSON.parse(evalStdout);
    assert.equal(evalSummary.ok, true);
    assert.equal(evalSummary.samples_total, 15);
    assert.ok(evalSummary.iaa.overlap_samples_total >= 4);
    assert.ok(evalSummary.iaa.overlap_samples_labeled_by_2plus >= 4);
    assert.ok(Array.isArray(evalSummary.iaa.per_annotator_pair));
    assert.ok(evalSummary.iaa.per_annotator_pair.length >= 1);

    const evalRows = await readNdjson(path.join(root, evalSummary.artifacts.report_jsonl));
    const risky = evalRows.find((row) => row.sample_id === sampleWithRisk);
    assert.ok(risky);
    assert.equal(risky.hair_overlap_est, 0.42);
    assert.equal(risky.leakage_bg_est_mean, 0.13);
    assert.equal(risky.min_module_pixels, 9);

    const evalMdPath = path.join(root, evalSummary.artifacts.report_md);
    const evalMd = await fs.readFile(evalMdPath, 'utf8');
    assert.match(evalMd, /## Win-Rate CI \(Wilson\)/);
    assert.match(evalMd, /## Confidence Stratified/);
    assert.match(evalMd, /## IAA Per Annotator Pair/);

    const adjudicationOut = path.join(outRoot, 'adjudication');
    const { stdout: adjStdout } = await runExecFile('node', [
      adjScript,
      '--run_id', runId,
      '--eval_jsonl', path.join(root, evalSummary.artifacts.report_jsonl),
      '--manifest', manifestPath,
      '--out', adjudicationOut,
      '--limit', '5',
    ], { cwd: repoPath() });
    const adjSummary = JSON.parse(adjStdout);
    assert.equal(adjSummary.ok, true);
    assert.equal(adjSummary.selected_total, 5);

    const { stdout: gateStdout } = await runExecFile('node', [
      gateScript,
      '--run_id', runId,
      '--eval_jsonl', path.join(root, evalSummary.artifacts.report_jsonl),
      '--eval_md', path.join(root, evalSummary.artifacts.report_md),
      '--eval_json', path.join(root, evalSummary.artifacts.report_json),
      '--manifest', manifestPath,
      '--report_dir', reportDir,
    ], { cwd: repoPath() });
    const gateSummary = JSON.parse(gateStdout);
    assert.equal(gateSummary.ok, true);
    assert.ok(['SHIP_VARIANT1', 'KEEP_BASELINE', 'NEED_ADJUDICATION'].includes(gateSummary.verdict));
    await fs.stat(path.join(root, gateSummary.artifacts.release_gate_md));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_label_import multi-export is deterministic and order-independent', async () => {
  const root = await makeTempDir('aurora_pref_import_multi_v3_');
  try {
    const runId = '20260212_210001001';
    const importScript = repoPath('scripts', 'preference_label_import.mjs');
    const manifestPath = path.join(root, 'manifest.json');
    const exportAPath = path.join(root, 'export_a.json');
    const exportBPath = path.join(root, 'export_b.json');
    const outABPath = path.join(root, 'labels_ab.ndjson');
    const outBAPath = path.join(root, 'labels_ba.ndjson');

    await fs.writeFile(manifestPath, `${JSON.stringify({
      run_id: runId,
      rows: [
        {
          sample_id: 's1',
          source: 'internal',
          role_a: 'baseline',
          role_b: 'variant',
          baseline_id: 'baseline_default',
          variant_id: 'variant1_forehead_hair_clip',
          task_batch: 'A',
        },
        {
          sample_id: 's2',
          source: 'lapa',
          role_a: 'baseline',
          role_b: 'variant',
          baseline_id: 'baseline_default',
          variant_id: 'variant1_forehead_hair_clip',
          task_batch: 'B',
        },
      ],
      flip_map: {},
    }, null, 2)}\n`, 'utf8');

    await fs.writeFile(exportAPath, `${JSON.stringify([
      {
        id: 'task_s1_old',
        data: { sample_id: 's1', source: 'internal' },
        annotations: [
          {
            id: 'ann_old',
            created_at: '2026-02-12T01:00:00.000Z',
            updated_at: '2026-02-12T01:00:00.000Z',
            completed_by: { id: 1001 },
            result: [
              { from_name: 'overall_choice', type: 'choices', value: { choices: ['A'] } },
              { from_name: 'overall_confidence', type: 'rating', value: { rating: 3, max: 5 } },
            ],
          },
        ],
      },
    ], null, 2)}\n`, 'utf8');

    await fs.writeFile(exportBPath, `${JSON.stringify([
      {
        id: 'task_s1_new',
        data: { sample_id: 's1', source: 'internal' },
        annotations: [
          {
            id: 'ann_new',
            created_at: '2026-02-12T02:00:00.000Z',
            updated_at: '2026-02-12T02:00:00.000Z',
            completed_by: { id: 1001 },
            result: [
              { from_name: 'overall_choice', type: 'choices', value: { choices: ['B'] } },
              { from_name: 'overall_confidence', type: 'rating', value: { rating: 5, max: 5 } },
            ],
          },
        ],
      },
      {
        id: 'task_s2',
        data: { sample_id: 's2', source: 'lapa' },
        annotations: [
          {
            id: 'ann_s2',
            created_at: '2026-02-12T02:10:00.000Z',
            updated_at: '2026-02-12T02:10:00.000Z',
            completed_by: { id: 1002 },
            result: [
              { from_name: 'overall_choice', type: 'choices', value: { choices: ['tie'] } },
              { from_name: 'overall_confidence', type: 'rating', value: { rating: 4, max: 5 } },
            ],
          },
        ],
      },
    ], null, 2)}\n`, 'utf8');

    const { stdout: stdoutAB } = await runExecFile('node', [
      importScript,
      '--run_id', runId,
      '--exports', `${exportAPath},${exportBPath}`,
      '--manifest', manifestPath,
      '--out', outABPath,
      '--report_dir', root,
    ], { cwd: repoPath() });

    const { stdout: stdoutBA } = await runExecFile('node', [
      importScript,
      '--run_id', runId,
      '--exports', `${exportBPath},${exportAPath}`,
      '--manifest', manifestPath,
      '--out', outBAPath,
      '--report_dir', root,
    ], { cwd: repoPath() });

    const summaryAB = JSON.parse(stdoutAB);
    const summaryBA = JSON.parse(stdoutBA);
    assert.equal(summaryAB.ok, true);
    assert.equal(summaryBA.ok, true);
    assert.equal(summaryAB.imported_rows, 2);
    assert.equal(summaryAB.duplicate_rows_dropped, 1);
    assert.equal(summaryBA.duplicate_rows_dropped, 1);

    const rowsAB = await readNdjson(outABPath);
    const rowsBA = await readNdjson(outBAPath);
    const stripImportedAt = (rows) => rows.map((row) => {
      const next = { ...row };
      delete next.imported_at;
      return next;
    });
    assert.deepEqual(stripImportedAt(rowsAB), stripImportedAt(rowsBA));

    const s1 = rowsAB.find((row) => row.sample_id === 's1');
    assert.ok(s1);
    assert.equal(s1.winner, 'variant1');
    assert.match(String(s1.source_export_file || ''), /export_b\.json$/);
    assert.ok(s1.imported_at);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_merge_adjudication applies adjudication override by sample/module', async () => {
  const root = await makeTempDir('aurora_pref_merge_v3_');
  try {
    const mergeScript = repoPath('scripts', 'preference_merge_adjudication.mjs');
    const basePath = path.join(root, 'base_labels.ndjson');
    const adjPath = path.join(root, 'adj_labels.ndjson');
    const outPath = path.join(root, 'merged_labels.ndjson');

    await writeJsonl(basePath, [
      {
        schema_version: 'aurora.preference_labels.v1',
        sample_id: 's1',
        module_id: 'overall',
        winner: 'baseline',
        rater_id: 'rater_a',
        annotation_id: 'base_ann_s1',
        updated_at: '2026-02-12T01:00:00.000Z',
      },
      {
        schema_version: 'aurora.preference_labels.v1',
        sample_id: 's2',
        module_id: 'overall',
        winner: 'variant1',
        rater_id: 'rater_a',
        annotation_id: 'base_ann_s2',
        updated_at: '2026-02-12T01:00:00.000Z',
      },
    ]);

    await writeJsonl(adjPath, [
      {
        schema_version: 'aurora.preference_labels.v1',
        sample_id: 's1',
        module_id: 'overall',
        winner: 'variant1',
        rater_id: 'rater_adj',
        annotation_id: 'adj_ann_s1',
        updated_at: '2026-02-12T03:00:00.000Z',
      },
      {
        schema_version: 'aurora.preference_labels.v1',
        sample_id: 's3',
        module_id: 'overall',
        winner: 'tie',
        rater_id: 'rater_adj',
        annotation_id: 'adj_ann_s3',
        updated_at: '2026-02-12T03:10:00.000Z',
      },
    ]);

    const { stdout } = await runExecFile('node', [
      mergeScript,
      '--run_id', '20260212_210001002',
      '--base_labels', basePath,
      '--adj_labels', adjPath,
      '--out', outPath,
      '--report_dir', root,
    ], { cwd: repoPath() });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.adjudicated_pairs_count, 2);
    assert.equal(summary.overridden_pairs_count, 1);
    assert.equal(summary.missing_pairs_in_base_count, 1);

    const merged = await readNdjson(outPath);
    const s1Rows = merged.filter((row) => row.sample_id === 's1');
    assert.equal(s1Rows.length, 1);
    assert.equal(s1Rows[0].decision_source, 'adjudication');
    assert.equal(s1Rows[0].winner, 'variant1');

    const s2Rows = merged.filter((row) => row.sample_id === 's2');
    assert.equal(s2Rows.length, 1);
    assert.equal(s2Rows[0].decision_source, 'main');

    const s3Rows = merged.filter((row) => row.sample_id === 's3');
    assert.equal(s3Rows.length, 1);
    assert.equal(s3Rows[0].decision_source, 'adjudication');

    await fs.stat(path.join(root, 'preference_merge_adjudication_qc_20260212_210001002.md'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_eval_final emits pre/post sections and expected artifacts when ADJ_EXPORTS exists', async () => {
  const root = await makeTempDir('aurora_pref_final_v3_');
  try {
    const finalScript = repoPath('scripts', 'preference_eval_final.mjs');
    const runId = '20260212_210001003';
    const manifestPath = path.join(root, 'manifest.json');
    const baseExportPath = path.join(root, 'base_export.json');
    const adjExportPath = path.join(root, 'adj_export.json');
    const outDir = path.join(root, 'artifacts', 'final');
    const reportDir = path.join(root, 'reports');

    await fs.writeFile(manifestPath, `${JSON.stringify({
      run_id: runId,
      rows: [
        {
          sample_id: 's1',
          source: 'internal',
          role_a: 'baseline',
          role_b: 'variant',
          baseline_id: 'baseline_default',
          variant_id: 'variant1_forehead_hair_clip',
          task_batch: 'OVERLAP',
        },
        {
          sample_id: 's2',
          source: 'lapa',
          role_a: 'baseline',
          role_b: 'variant',
          baseline_id: 'baseline_default',
          variant_id: 'variant1_forehead_hair_clip',
          task_batch: 'A',
        },
      ],
      flip_map: {},
      overlap: { sample_ids: ['s1'], overlap_count: 1 },
    }, null, 2)}\n`, 'utf8');

    await fs.writeFile(baseExportPath, `${JSON.stringify([
      {
        id: 'base_task_1',
        data: { sample_id: 's1', source: 'internal' },
        annotations: [
          {
            id: 'base_ann_s1',
            created_at: '2026-02-12T04:00:00.000Z',
            updated_at: '2026-02-12T04:01:00.000Z',
            completed_by: { id: 333 },
            result: [
              { from_name: 'overall_choice', type: 'choices', value: { choices: ['A'] } },
              { from_name: 'overall_confidence', type: 'rating', value: { rating: 4, max: 5 } },
              { from_name: 'pref_forehead', type: 'choices', value: { choices: ['A'] } },
            ],
          },
        ],
      },
      {
        id: 'base_task_2',
        data: { sample_id: 's2', source: 'lapa' },
        annotations: [
          {
            id: 'base_ann_s2',
            created_at: '2026-02-12T04:10:00.000Z',
            updated_at: '2026-02-12T04:11:00.000Z',
            completed_by: { id: 334 },
            result: [
              { from_name: 'overall_choice', type: 'choices', value: { choices: ['A'] } },
              { from_name: 'overall_confidence', type: 'rating', value: { rating: 5, max: 5 } },
              { from_name: 'pref_forehead', type: 'choices', value: { choices: ['A'] } },
            ],
          },
        ],
      },
    ], null, 2)}\n`, 'utf8');

    await fs.writeFile(adjExportPath, `${JSON.stringify([
      {
        id: 'adj_task_1',
        data: { sample_id: 's1', source: 'internal', adjudication: true },
        annotations: [
          {
            id: 'adj_ann_s1',
            created_at: '2026-02-12T05:00:00.000Z',
            updated_at: '2026-02-12T05:01:00.000Z',
            completed_by: { id: 999 },
            result: [
              { from_name: 'overall_choice', type: 'choices', value: { choices: ['B'] } },
              { from_name: 'overall_confidence', type: 'rating', value: { rating: 5, max: 5 } },
              { from_name: 'pref_forehead', type: 'choices', value: { choices: ['B'] } },
            ],
          },
        ],
      },
    ], null, 2)}\n`, 'utf8');

    const { stdout } = await runExecFile('node', [
      finalScript,
      '--run_id', runId,
      '--manifest', manifestPath,
      '--base_exports', baseExportPath,
      '--adj_exports', adjExportPath,
      '--out_dir', outDir,
      '--report_dir', reportDir,
    ], { cwd: repoPath() });

    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.adjudication_applied, true);
    assert.ok(summary.artifacts.final_report_md);
    assert.ok(summary.artifacts.final_summary_json);

    const finalMdPath = path.join(repoPath(), summary.artifacts.final_report_md);
    const finalMd = await fs.readFile(finalMdPath, 'utf8');
    assert.match(finalMd, /## Pre-Adjudication/);
    assert.match(finalMd, /## Post-Adjudication/);
    assert.match(finalMd, /## Delta Summary/);
    assert.match(finalMd, /s1/);

    const mergedPath = path.join(repoPath(), summary.artifacts.merged_labels_ndjson);
    const mergedRows = await readNdjson(mergedPath);
    const s1 = mergedRows.find((row) => row.sample_id === 's1');
    assert.ok(s1);
    assert.equal(s1.decision_source, 'adjudication');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writePreferenceDiagnosticsFixture(root, runId) {
  const manifestPath = path.join(root, 'manifest.json');
  const evalJsonlPath = path.join(root, `eval_preference_${runId}.jsonl`);
  const labelsPath = path.join(root, 'preference_labels_merged.ndjson');

  await fs.writeFile(manifestPath, `${JSON.stringify({
    run_id: runId,
    overlap: { sample_ids: ['d_s1', 'd_s2'], overlap_count: 2 },
    rows: [
      {
        sample_id: 'd_s1',
        source: 'internal',
        task_batch: 'OVERLAP',
        risk_features: {
          hair_overlap_est: 0.31,
          leakage_bg_est_mean: 0.11,
          min_module_pixels: 14,
          overlay_diff_pixels: 9,
          overlay_diff_ratio: 0.005,
          overlay_focus_module: 'right_cheek',
        },
        module_guard_triggered: true,
      },
      {
        sample_id: 'd_s2',
        source: 'lapa',
        task_batch: 'OVERLAP',
        risk_features: {
          hair_overlap_est: 0.06,
          leakage_bg_est_mean: 0.03,
          min_module_pixels: 90,
          overlay_diff_pixels: 24,
          overlay_diff_ratio: 0.02,
          overlay_focus_module: 'forehead',
        },
        module_guard_triggered: false,
      },
      {
        sample_id: 'd_s3',
        source: 'celebamaskhq',
        task_batch: 'A',
        risk_features: {
          hair_overlap_est: 0.22,
          leakage_bg_est_mean: 0.17,
          min_module_pixels: 20,
          overlay_diff_pixels: 68,
          overlay_diff_ratio: 0.08,
          overlay_focus_module: 'forehead',
        },
        module_guard_triggered: true,
      },
      {
        sample_id: 'd_s4',
        source: 'internal',
        task_batch: 'B',
        risk_features: {
          hair_overlap_est: 0.01,
          leakage_bg_est_mean: 0.01,
          min_module_pixels: 160,
          overlay_diff_pixels: 96,
          overlay_diff_ratio: 0.12,
          overlay_focus_module: 'nose',
        },
        module_guard_triggered: false,
      },
    ],
  }, null, 2)}\n`, 'utf8');

  await writeJsonl(evalJsonlPath, [
    {
      sample_id: 'd_s1',
      source: 'internal',
      cannot_tell_rate: 0.5,
      disagreement_rate: 0.5,
      low_confidence_rate: 1,
      split_close_score: 0.9,
      contentious_score: 0.7,
      annotators_total: 2,
      total_votes: 2,
      hair_overlap_est: 0.31,
      leakage_bg_est_mean: 0.11,
      min_module_pixels: 14,
      overlay_diff_pixels: 9,
      overlay_diff_ratio: 0.005,
    },
    {
      sample_id: 'd_s2',
      source: 'lapa',
      cannot_tell_rate: 0,
      disagreement_rate: 0,
      low_confidence_rate: 0,
      split_close_score: 0.1,
      contentious_score: 0,
      annotators_total: 2,
      total_votes: 2,
      hair_overlap_est: 0.06,
      leakage_bg_est_mean: 0.03,
      min_module_pixels: 90,
      overlay_diff_pixels: 24,
      overlay_diff_ratio: 0.02,
    },
    {
      sample_id: 'd_s3',
      source: 'celebamaskhq',
      cannot_tell_rate: 1,
      disagreement_rate: 0,
      low_confidence_rate: 1,
      split_close_score: 0.95,
      contentious_score: 0.85,
      annotators_total: 1,
      total_votes: 1,
      hair_overlap_est: 0.22,
      leakage_bg_est_mean: 0.17,
      min_module_pixels: 20,
      overlay_diff_pixels: 68,
      overlay_diff_ratio: 0.08,
    },
    {
      sample_id: 'd_s4',
      source: 'internal',
      cannot_tell_rate: 0,
      disagreement_rate: 0,
      low_confidence_rate: 0,
      split_close_score: 0.2,
      contentious_score: 0,
      annotators_total: 1,
      total_votes: 1,
      hair_overlap_est: 0.01,
      leakage_bg_est_mean: 0.01,
      min_module_pixels: 160,
      overlay_diff_pixels: 96,
      overlay_diff_ratio: 0.12,
    },
  ]);

  await writeJsonl(labelsPath, [
    {
      schema_version: 'aurora.preference_labels.v1',
      sample_id: 'd_s1',
      source: 'internal',
      winner: 'baseline',
      confidence_int: 2,
      rater_id: 'rater_a',
      annotation_id: 'ann_s1_a',
      task_batch: 'OVERLAP',
      per_module_choice: {
        nose: 'baseline',
        forehead: 'baseline',
        left_cheek: 'tie',
        right_cheek: 'baseline',
        chin: 'baseline',
      },
      updated_at: '2026-02-12T10:00:00.000Z',
    },
    {
      schema_version: 'aurora.preference_labels.v1',
      sample_id: 'd_s1',
      source: 'internal',
      winner: 'variant1',
      confidence_int: 2,
      rater_id: 'rater_b',
      annotation_id: 'ann_s1_b',
      task_batch: 'OVERLAP',
      per_module_choice: {
        nose: 'variant1',
        forehead: 'variant1',
        left_cheek: 'tie',
        right_cheek: 'cannot_tell',
        chin: 'baseline',
      },
      updated_at: '2026-02-12T10:05:00.000Z',
    },
    {
      schema_version: 'aurora.preference_labels.v1',
      sample_id: 'd_s2',
      source: 'lapa',
      winner: 'tie',
      confidence_int: 4,
      rater_id: 'rater_a',
      annotation_id: 'ann_s2_a',
      task_batch: 'OVERLAP',
      per_module_choice: {
        nose: 'tie',
        forehead: 'tie',
        left_cheek: 'tie',
        right_cheek: 'tie',
        chin: 'tie',
      },
      updated_at: '2026-02-12T10:10:00.000Z',
    },
    {
      schema_version: 'aurora.preference_labels.v1',
      sample_id: 'd_s2',
      source: 'lapa',
      winner: 'tie',
      confidence_int: 4,
      rater_id: 'rater_b',
      annotation_id: 'ann_s2_b',
      task_batch: 'OVERLAP',
      per_module_choice: {
        nose: 'tie',
        forehead: 'tie',
        left_cheek: 'tie',
        right_cheek: 'tie',
        chin: 'tie',
      },
      updated_at: '2026-02-12T10:15:00.000Z',
    },
    {
      schema_version: 'aurora.preference_labels.v1',
      sample_id: 'd_s3',
      source: 'celebamaskhq',
      winner: 'cannot_tell',
      confidence_int: 1,
      rater_id: 'rater_a',
      annotation_id: 'ann_s3_a',
      task_batch: 'A',
      per_module_choice: {
        nose: 'cannot_tell',
        forehead: 'cannot_tell',
        left_cheek: 'tie',
        right_cheek: 'cannot_tell',
        chin: 'variant1',
      },
      updated_at: '2026-02-12T10:20:00.000Z',
    },
    {
      schema_version: 'aurora.preference_labels.v1',
      sample_id: 'd_s4',
      source: 'internal',
      winner: 'variant1',
      confidence_int: 5,
      rater_id: 'rater_a',
      annotation_id: 'ann_s4_a',
      task_batch: 'B',
      per_module_choice: {
        nose: 'variant1',
        forehead: 'variant1',
        left_cheek: 'variant1',
        right_cheek: 'variant1',
        chin: 'variant1',
      },
      updated_at: '2026-02-12T10:30:00.000Z',
    },
  ]);

  return {
    manifestPath,
    evalJsonlPath,
    labelsPath,
  };
}

test('preference_diagnostics deterministic ordering (ignoring generated_at)', async () => {
  const root = await makeTempDir('aurora_pref_diag_det_v1_');
  try {
    const runId = '20260212_230001001';
    const script = repoPath('scripts', 'preference_diagnostics.mjs');
    const outDir = path.join(root, 'reports');

    const fixture = await writePreferenceDiagnosticsFixture(root, runId);

    const runOnce = async () => {
      const { stdout } = await runExecFile('node', [
        script,
        '--run_id', runId,
        '--manifest', fixture.manifestPath,
        '--eval_jsonl', fixture.evalJsonlPath,
        '--labels', fixture.labelsPath,
        '--out_dir', outDir,
      ], { cwd: repoPath() });
      return JSON.parse(stdout);
    };

    const first = await runOnce();
    const firstJson = await readJson(path.join(repoPath(), first.artifacts.diagnostics_json));
    const firstMd = await fs.readFile(path.join(repoPath(), first.artifacts.diagnostics_md), 'utf8');

    const second = await runOnce();
    const secondJson = await readJson(path.join(repoPath(), second.artifacts.diagnostics_json));
    const secondMd = await fs.readFile(path.join(repoPath(), second.artifacts.diagnostics_md), 'utf8');

    const stripGenerated = (obj) => {
      const clone = JSON.parse(JSON.stringify(obj));
      delete clone.generated_at;
      return clone;
    };
    const stripGeneratedLine = (md) => String(md).split('\n').filter((line) => !line.startsWith('- generated_at:')).join('\n');

    assert.deepEqual(stripGenerated(firstJson), stripGenerated(secondJson));
    assert.equal(stripGeneratedLine(firstMd), stripGeneratedLine(secondMd));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_diagnostics bucketization and Wilson CI are present', async () => {
  const root = await makeTempDir('aurora_pref_diag_bucket_v1_');
  try {
    const runId = '20260212_230001002';
    const script = repoPath('scripts', 'preference_diagnostics.mjs');
    const outDir = path.join(root, 'reports');
    const fixture = await writePreferenceDiagnosticsFixture(root, runId);

    const { stdout } = await runExecFile('node', [
      script,
      '--run_id', runId,
      '--manifest', fixture.manifestPath,
      '--eval_jsonl', fixture.evalJsonlPath,
      '--labels', fixture.labelsPath,
      '--out_dir', outDir,
    ], { cwd: repoPath() });
    const summary = JSON.parse(stdout);

    const diagnosticsJson = await readJson(path.join(repoPath(), summary.artifacts.diagnostics_json));
    assert.equal(diagnosticsJson.ok, true);

    const hairBuckets = diagnosticsJson.slices.by_risk_hair.map((row) => row.slice_key);
    assert.ok(hairBuckets.some((key) => String(key).includes('high')));
    assert.ok(hairBuckets.some((key) => String(key).includes('low')));
    const overlayBuckets = diagnosticsJson.slices.by_overlay_diff.map((row) => row.slice_key);
    assert.ok(overlayBuckets.length >= 2);

    const sourceRows = diagnosticsJson.slices.by_source;
    assert.ok(sourceRows.length >= 2);
    assert.ok(sourceRows.some((row) => row.baseline_wilson_low != null || row.variant1_wilson_low != null));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_diagnostics overlay consistency gate passes with consistent manifest/eval overlay fields', async () => {
  const root = await makeTempDir('aurora_pref_diag_overlay_gate_pass_v1_');
  try {
    const runId = '20260212_230001002b';
    const script = repoPath('scripts', 'preference_diagnostics.mjs');
    const outDir = path.join(root, 'reports');
    const fixture = await writePreferenceDiagnosticsFixture(root, runId);

    const { stdout } = await runExecFile('node', [
      script,
      '--run_id', runId,
      '--manifest', fixture.manifestPath,
      '--eval_jsonl', fixture.evalJsonlPath,
      '--labels', fixture.labelsPath,
      '--out_dir', outDir,
    ], { cwd: repoPath() });
    const summary = JSON.parse(stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.overlay_consistency_gate.pass, true);
    assert.equal(summary.overlay_consistency_gate.rates.coverage_rate, 1);
    assert.equal(summary.overlay_consistency_gate.rates.consistency_rate, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_diagnostics overlay consistency gate fails on mismatched overlay_diff_ratio', async () => {
  const root = await makeTempDir('aurora_pref_diag_overlay_gate_fail_v1_');
  try {
    const runId = '20260212_230001002c';
    const script = repoPath('scripts', 'preference_diagnostics.mjs');
    const outDir = path.join(root, 'reports');
    const fixture = await writePreferenceDiagnosticsFixture(root, runId);

    const evalRows = await readNdjson(fixture.evalJsonlPath);
    evalRows[0].overlay_diff_ratio = 0.25; // mismatch vs manifest=0.005
    delete evalRows[1].overlay_diff_ratio; // missing in eval
    await writeJsonl(fixture.evalJsonlPath, evalRows);

    await assert.rejects(
      () => runExecFile('node', [
        script,
        '--run_id', runId,
        '--manifest', fixture.manifestPath,
        '--eval_jsonl', fixture.evalJsonlPath,
        '--labels', fixture.labelsPath,
        '--out_dir', outDir,
      ], { cwd: repoPath() }),
      (error) => {
        assert.equal(error && error.code, 3);
        assert.match(String(error && error.stderr || ''), /overlay_consistency_gate_failed/);
        assert.match(String(error && error.stderr || ''), /d_s1/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_diagnostics outputs exactly 5 actionable recommendations with required fields', async () => {
  const root = await makeTempDir('aurora_pref_diag_actions_v1_');
  try {
    const runId = '20260212_230001003';
    const script = repoPath('scripts', 'preference_diagnostics.mjs');
    const outDir = path.join(root, 'reports');
    const fixture = await writePreferenceDiagnosticsFixture(root, runId);

    const { stdout } = await runExecFile('node', [
      script,
      '--run_id', runId,
      '--manifest', fixture.manifestPath,
      '--eval_jsonl', fixture.evalJsonlPath,
      '--labels', fixture.labelsPath,
      '--out_dir', outDir,
    ], { cwd: repoPath() });
    const summary = JSON.parse(stdout);
    const diagnosticsJson = await readJson(path.join(repoPath(), summary.artifacts.diagnostics_json));

    assert.equal(Array.isArray(diagnosticsJson.actions), true);
    assert.equal(diagnosticsJson.actions.length, 5);
    for (const action of diagnosticsJson.actions) {
      assert.ok(String(action.title || '').trim());
      assert.ok(String(action.what_to_change || '').trim());
      assert.ok(String(action.target_slice || '').trim());
      assert.ok(String(action.why || '').trim());
      assert.ok(String(action.validate || '').trim());
    }

    const contentiousPath = path.join(repoPath(), diagnosticsJson.contentious_export.path);
    const contentiousRows = await readNdjson(contentiousPath);
    assert.ok(contentiousRows.length >= 1);
    assert.ok(contentiousRows[0].sample_id);
    assert.ok(contentiousRows[0].risk_features);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function writePreferenceNextVariantsFixture(root, runId) {
  const manifestPath = path.join(root, 'manifest_round1.json');
  const contentiousPath = path.join(root, `preference_contentious_${runId}.jsonl`);
  const crosssetPath = path.join(root, `eval_circle_crossset_${runId}.json`);

  const sampleRows = [];
  const sampleDefs = [
    ['internal', 'n_int_01', [140, 120, 100], true, 0.31, 0.14, 12],
    ['internal', 'n_int_02', [150, 110, 90], false, 0.07, 0.03, 120],
    ['internal', 'n_int_03', [155, 115, 95], true, 0.24, 0.11, 18],
    ['lapa', 'n_lapa_01', [100, 160, 130], false, 0.04, 0.04, 88],
    ['lapa', 'n_lapa_02', [102, 162, 132], false, 0.18, 0.09, 26],
    ['lapa', 'n_lapa_03', [104, 164, 134], true, 0.28, 0.15, 16],
    ['celebamaskhq', 'n_celeba_01', [120, 130, 180], false, 0.11, 0.08, 64],
    ['celebamaskhq', 'n_celeba_02', [122, 132, 182], false, 0.05, 0.02, 132],
    ['celebamaskhq', 'n_celeba_03', [124, 134, 184], true, 0.22, 0.13, 20],
  ];

  for (const [source, sampleId, color, guardTriggered, hair, leakBg, minPixels] of sampleDefs) {
    const imgPath = path.join(root, 'round1_thumbs', source, `${sampleId}.jpg`);
    await writeImageJpg(imgPath, color);
    sampleRows.push({
      sample_id: sampleId,
      sample_hash: sampleId,
      source,
      role_a: 'baseline',
      role_b: 'variant',
      baseline_id: 'baseline_default',
      variant_id: 'variant1_forehead_hair_clip',
      input_thumb_path: imgPath,
      image_a_path: imgPath,
      image_b_path: imgPath,
      module_guard_triggered: guardTriggered,
      risk_features: {
        hair_overlap_est: hair,
        leakage_bg_est_mean: leakBg,
        min_module_pixels: minPixels,
      },
      guarded_modules: guardTriggered ? ['forehead'] : [],
    });
  }

  await fs.writeFile(manifestPath, `${JSON.stringify({
    run_id: runId,
    rows: sampleRows,
  }, null, 2)}\n`, 'utf8');

  await writeJsonl(contentiousPath, [
    {
      sample_id: 'n_int_01',
      source: 'internal',
      cannot_tell_rate: 0.6,
      disagreement_rate: 0.6,
      low_confidence_rate: 0.7,
      risk_features: { hair_overlap_est: 0.31, leakage_bg_est_mean: 0.14, min_module_pixels: 12 },
    },
    {
      sample_id: 'n_int_03',
      source: 'internal',
      cannot_tell_rate: 0.4,
      disagreement_rate: 0.5,
      low_confidence_rate: 0.4,
      risk_features: { hair_overlap_est: 0.24, leakage_bg_est_mean: 0.11, min_module_pixels: 18 },
    },
    {
      sample_id: 'n_lapa_03',
      source: 'lapa',
      cannot_tell_rate: 0.5,
      disagreement_rate: 0.5,
      low_confidence_rate: 0.5,
      risk_features: { hair_overlap_est: 0.28, leakage_bg_est_mean: 0.15, min_module_pixels: 16 },
    },
    {
      sample_id: 'n_celeba_03',
      source: 'celebamaskhq',
      cannot_tell_rate: 0.7,
      disagreement_rate: 0.4,
      low_confidence_rate: 0.8,
      risk_features: { hair_overlap_est: 0.22, leakage_bg_est_mean: 0.13, min_module_pixels: 20 },
    },
  ]);

  await fs.writeFile(crosssetPath, `${JSON.stringify({
    ok: true,
    run_id: runId,
    summaries: [
      {
        dataset: 'celebamaskhq',
        strong_module_miou_mean: 0.36,
        leakage_bg_mean: 0.03,
        leakage_hair_mean: 0.08,
      },
      {
        dataset: 'lapa',
        strong_module_miou_mean: 0.34,
        leakage_bg_mean: 0.04,
        leakage_hair_mean: 0.09,
      },
    ],
  }, null, 2)}\n`, 'utf8');

  return {
    manifestPath,
    contentiousPath,
    crosssetPath,
  };
}

test('preference_next_variants is deterministic and outputs overlap-aware round2 pack', async () => {
  const root = await makeTempDir('aurora_pref_next_det_v1_');
  try {
    const runId = '20260213_000001001';
    const fixture = await writePreferenceNextVariantsFixture(root, runId);
    const script = repoPath('scripts', 'preference_next_variants.mjs');
    const outA = path.join(root, 'outA');
    const outB = path.join(root, 'outB');

    const common = [
      script,
      '--run_id', runId,
      '--next_run_id', `${runId}_r2`,
      '--contentious', fixture.contentiousPath,
      '--manifest', fixture.manifestPath,
      '--seed', 'pref_next_seed_v1',
      '--max_candidates', '4',
      '--top_k', '2',
      '--target_total', '9',
      '--overlap_ratio', '0.33',
      '--overlap_min', '3',
      '--crossset_jsonl', fixture.crosssetPath,
      '--mock_pipeline', 'true',
      '--max_edge', '512',
      '--concurrency', '2',
    ];

    await runExecFile('node', [...common, '--out_dir', outA], { cwd: repoPath() });
    await runExecFile('node', [...common, '--out_dir', outB], { cwd: repoPath() });

    const candA = await readJson(path.join(outA, 'candidates.json'));
    const candB = await readJson(path.join(outB, 'candidates.json'));
    const recA = await readJson(path.join(outA, 'recommended.json'));
    const recB = await readJson(path.join(outB, 'recommended.json'));
    const manifestA = await readJson(path.join(outA, 'manifest.json'));
    const manifestB = await readJson(path.join(outB, 'manifest.json'));
    const tasksA = await readJson(path.join(outA, 'tasks.json'));
    const tasksB = await readJson(path.join(outB, 'tasks.json'));

    const normalizeCandidates = (obj) => ({
      score_source: obj.score_source,
      max_candidates: obj.max_candidates,
      top_k: obj.top_k,
      analysis: obj.analysis,
      baseline_metrics: obj.baseline_metrics,
      candidates: (obj.candidates || []).map((row) => ({
        id: row.id,
        score: row.score,
        valid: row.valid,
        invalid_reasons: row.invalid_reasons,
      })),
    });
    const normalizeRecommended = (obj) => (obj.recommended || []).map((row) => ({
      id: row.id,
      score: row.score,
      valid: row.valid,
      rationale: row.rationale,
    }));
    const normalizeManifest = (obj) => ({
      selection: obj.selection,
      overlap: obj.overlap,
      batch_counts: obj.batch_counts,
      candidate_ids: (obj.recommended || []).map((row) => row.id),
      batch_assignment: obj.batch_assignment,
      rows: (obj.rows || []).map((row) => ({
        candidate_id: row.candidate_id,
        sample_id: row.sample_id,
        task_batch: row.task_batch,
        role_a: row.role_a,
        role_b: row.role_b,
      })),
    });

    assert.deepEqual(normalizeCandidates(candA), normalizeCandidates(candB));
    assert.deepEqual(normalizeRecommended(recA), normalizeRecommended(recB));
    assert.deepEqual(normalizeManifest(manifestA), normalizeManifest(manifestB));
    assert.deepEqual(tasksA.map((task) => task.id), tasksB.map((task) => task.id));

    assert.ok(Array.isArray(candA.candidates));
    assert.ok(candA.candidates.length <= 4);
    assert.equal(recA.recommended.length, 2);
    for (const row of recA.recommended) {
      assert.ok(String(row.rationale || '').trim().length > 0);
    }

    const expectedTasks = Number(manifestA.selection.selected_total || 0) * Number(recA.recommended.length || 0);
    assert.equal(tasksA.length, expectedTasks);
    assert.ok(Number(manifestA.overlap.overlap_count || 0) >= 3);

    const overlapIds = new Set(manifestA.overlap.sample_ids || []);
    const overlapRows = (manifestA.rows || []).filter((row) => overlapIds.has(row.sample_id));
    assert.equal(overlapRows.length, overlapIds.size * recA.recommended.length);
    for (const row of overlapRows) {
      assert.equal(row.task_batch, 'OVERLAP');
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('preference_next_variants excludes invalid candidates from top-k recommendations', async () => {
  const root = await makeTempDir('aurora_pref_next_constraints_v1_');
  try {
    const runId = '20260213_000001002';
    const fixture = await writePreferenceNextVariantsFixture(root, runId);
    const script = repoPath('scripts', 'preference_next_variants.mjs');
    const outDir = path.join(root, 'out');

    await runExecFile('node', [
      script,
      '--run_id', runId,
      '--next_run_id', `${runId}_r2`,
      '--contentious', fixture.contentiousPath,
      '--manifest', fixture.manifestPath,
      '--seed', 'pref_next_seed_constraints',
      '--max_candidates', '8',
      '--top_k', '3',
      '--target_total', '9',
      '--overlap_ratio', '0.25',
      '--overlap_min', '3',
      '--mock_pipeline', 'true',
      '--out_dir', outDir,
    ], { cwd: repoPath() });

    const candidates = await readJson(path.join(outDir, 'candidates.json'));
    const recommended = await readJson(path.join(outDir, 'recommended.json'));

    const invalid = candidates.candidates.filter((row) => row.valid === false);
    assert.ok(invalid.length >= 1);

    const recommendedIds = new Set(recommended.recommended.map((row) => row.id));
    for (const inv of invalid) {
      assert.equal(recommendedIds.has(inv.id), false);
    }
    for (const row of recommended.recommended) {
      assert.equal(row.valid, true);
      assert.ok(String(row.rationale || '').trim());
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
