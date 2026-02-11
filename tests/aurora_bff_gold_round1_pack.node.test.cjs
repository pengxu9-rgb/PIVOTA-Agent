const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');

const runExecFile = promisify(execFile);

function repoPath(...parts) {
  return path.join(__dirname, '..', ...parts);
}

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

async function createJpeg(filePath, rgb) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: rgb,
    },
  })
    .jpeg({ quality: 92 })
    .toFile(filePath);
}

function makeReviewRows() {
  return [
    {
      source: 'internal',
      sample_hash: 'internal_ok_001',
      image_path_rel: 'internal_ok.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.7,
      min_module_id: 'nose',
      min_module_pixels: 44,
      module_guard_triggered: false,
    },
    {
      source: 'internal',
      sample_hash: 'internal_heic_disguised',
      image_path_rel: 'internal_heic_disguised.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.9,
      min_module_id: 'under_eye_left',
      min_module_pixels: 12,
      module_guard_triggered: true,
    },
    {
      source: 'lapa',
      sample_hash: 'lapa_ok_001',
      image_path_rel: 'lapa_ok_001.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.8,
      min_module_id: 'nose',
      min_module_pixels: 52,
      module_guard_triggered: false,
    },
    {
      source: 'lapa',
      sample_hash: 'lapa_ok_002',
      image_path_rel: 'lapa_ok_002.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.4,
      min_module_id: 'under_eye_left',
      min_module_pixels: 70,
      module_guard_triggered: true,
    },
    {
      source: 'lapa',
      sample_hash: 'lapa_fail_001',
      image_path_rel: 'lapa_fail_001.jpg',
      ok: false,
      pipeline_mode_used: 'local',
      fail_reason: 'LOCAL_DIAGNOSIS_FAIL',
      reason_detail: 'LANDMARK_FAIL',
      error_stack: 'LANDMARK_FAIL\nat local_pipeline',
    },
    {
      source: 'celebamaskhq',
      sample_hash: 'celeba_ok_001',
      image_path_rel: 'celeba_ok_001.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.6,
      min_module_id: 'nose',
      min_module_pixels: 60,
      module_guard_triggered: false,
    },
    {
      source: 'celebamaskhq',
      sample_hash: 'celeba_ok_002',
      image_path_rel: 'celeba_ok_002.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.3,
      min_module_id: 'under_eye_left',
      min_module_pixels: 66,
      module_guard_triggered: true,
    },
  ];
}

test('gold_round1_pack.mjs creates deterministic pack, excludes fail rows, and converts HEIC-disguised samples', async () => {
  const root = await makeTempDir('aurora_gold_round1_pack_');
  try {
    const scriptPath = repoPath('scripts', 'gold_round1_pack.mjs');
    const reviewPath = path.join(root, 'reports', 'review_pack_mixed_20260211_105639451.jsonl');
    const internalDir = path.join(root, 'internal');
    const cacheDir = path.join(root, 'datasets_cache', 'external');
    const lapaDir = path.join(cacheDir, 'lapa');
    const celebaDir = path.join(cacheDir, 'celebamaskhq');
    const reportDir = path.join(root, 'reports');
    const outRootA = path.join(root, 'artifacts', 'gold_round1_20260211_105639451_a');
    const outRootB = path.join(root, 'artifacts', 'gold_round1_20260211_105639451_b');

    await Promise.all([
      createJpeg(path.join(internalDir, 'internal_ok.jpg'), { r: 120, g: 90, b: 60 }),
      createJpeg(path.join(lapaDir, 'lapa_ok_001.jpg'), { r: 100, g: 140, b: 180 }),
      createJpeg(path.join(lapaDir, 'lapa_ok_002.jpg'), { r: 80, g: 120, b: 160 }),
      createJpeg(path.join(celebaDir, 'celeba_ok_001.jpg'), { r: 150, g: 110, b: 90 }),
      createJpeg(path.join(celebaDir, 'celeba_ok_002.jpg'), { r: 130, g: 170, b: 110 }),
    ]);

    const heicLikeBytes = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypheic', 'ascii'),
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x6d, 0x69, 0x66, 0x31, 0x6d, 0x73, 0x66, 0x31]),
    ]);
    await fs.writeFile(path.join(internalDir, 'internal_heic_disguised.jpg'), heicLikeBytes);

    const converterScript = path.join(root, 'heic_converter_mock.mjs');
    await fs.writeFile(
      converterScript,
      [
        '#!/usr/bin/env node',
        "import fs from 'node:fs';",
        `fs.copyFileSync(${JSON.stringify(path.join(internalDir, 'internal_ok.jpg'))}, process.argv[3]);`,
      ].join('\n'),
      'utf8',
    );
    await fs.chmod(converterScript, 0o755);

    await writeNdjson(reviewPath, makeReviewRows());

    const baseArgs = [
      scriptPath,
      '--run_id', '20260211_105639451',
      '--review_jsonl', reviewPath,
      '--report_dir', reportDir,
      '--internal_dir', internalDir,
      '--cache_dir', cacheDir,
      '--lapa_dir', lapaDir,
      '--celeba_dir', celebaDir,
      '--limit_internal', '38',
      '--limit_lapa', '50',
      '--limit_celeba', '50',
      '--top_risk', '30',
      '--random_count', '20',
      '--seed', 'gold_round1_seed_v1',
      '--heic_convert_cmd', converterScript,
      '--convert_heic', 'true',
    ];

    const runA = await runExecFile('node', [...baseArgs, '--out_root', outRootA], { cwd: root });
    const summaryA = JSON.parse(runA.stdout.trim().split('\n').filter(Boolean).at(-1));
    assert.equal(summaryA.ok, true);
    assert.equal(summaryA.convert_success_count, 1);
    assert.equal(summaryA.heic_mismatch_count, 1);
    assert.equal(summaryA.selected_packaged, 6);

    const tasksPathA = path.join(root, summaryA.artifacts.tasks_json);
    const manifestPathA = path.join(root, summaryA.artifacts.manifest_json);
    const selectedPathA = path.join(root, summaryA.artifacts.selected_jsonl);
    const triagePathA = path.join(root, summaryA.artifacts.lapa_triage_md);

    const tasks = JSON.parse(await fs.readFile(tasksPathA, 'utf8'));
    assert.equal(tasks.length, 6);
    for (const task of tasks) {
      assert.equal(typeof task.data.image, 'string');
      assert.ok(task.data.image.startsWith('images/'));
      assert.equal(typeof task.meta.sample_hash, 'string');
      assert.equal(typeof task.meta.source, 'string');
      assert.equal(task.meta.run_id, '20260211_105639451');
      assert.ok(['internal', 'lapa', 'celebamaskhq'].includes(task.meta.source));
    }
    assert.ok(!tasks.some((task) => task.meta.sample_hash === 'lapa_fail_001'));

    const manifest = JSON.parse(await fs.readFile(manifestPathA, 'utf8'));
    assert.equal(manifest.stats.convert_success_count, 1);
    assert.ok(manifest.rows.some((row) => row.sample_hash === 'internal_heic_disguised' && row.transcode && row.transcode.heic_mismatch));

    const selectedRowsA = await readNdjson(selectedPathA);
    const triageText = await fs.readFile(triagePathA, 'utf8');
    assert.ok(triageText.includes('lapa_fail_001'));
    assert.ok(triageText.includes('LANDMARK_FAIL'));

    const imageFiles = await fs.readdir(path.join(outRootA, 'images', 'internal'));
    assert.ok(imageFiles.every((name) => name.endsWith('.jpg')));

    const runB = await runExecFile('node', [...baseArgs, '--out_root', outRootB], { cwd: root });
    const summaryB = JSON.parse(runB.stdout.trim().split('\n').filter(Boolean).at(-1));
    const selectedRowsB = await readNdjson(path.join(root, summaryB.artifacts.selected_jsonl));
    assert.deepEqual(
      selectedRowsA.map((row) => `${row.source}:${row.sample_hash}`),
      selectedRowsB.map((row) => `${row.source}:${row.sample_hash}`),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
