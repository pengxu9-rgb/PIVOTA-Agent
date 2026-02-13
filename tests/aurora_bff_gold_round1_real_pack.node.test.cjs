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

async function createJpeg(filePath, rgb) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: rgb,
    },
  }).jpeg({ quality: 90 }).toFile(filePath);
}

async function writeNdjson(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fs.writeFile(filePath, payload, 'utf8');
}

function reviewRowsFixture() {
  return [
    {
      source: 'internal',
      sample_hash: 'internal_001',
      image_path_rel: 'internal_001.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.31,
      min_module_id: 'nose',
      min_module_pixels: 44,
      module_guard_triggered: false,
      guarded_modules: [],
    },
    {
      source: 'internal',
      sample_hash: 'internal_002',
      image_path_rel: 'internal_002.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.76,
      min_module_id: 'chin',
      min_module_pixels: 24,
      module_guard_triggered: true,
      guarded_modules: ['chin'],
    },
    {
      source: 'lapa',
      sample_hash: 'lapa_001',
      image_path_rel: 'lapa_001.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.81,
      min_module_id: 'forehead',
      min_module_pixels: 38,
      module_guard_triggered: false,
      guarded_modules: [],
    },
    {
      source: 'lapa',
      sample_hash: 'lapa_002',
      image_path_rel: 'lapa_002.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.62,
      min_module_id: 'under_eye_left',
      min_module_pixels: 16,
      module_guard_triggered: true,
      guarded_modules: ['under_eye_left'],
    },
    {
      source: 'lapa',
      sample_hash: 'lapa_003',
      image_path_rel: 'lapa_003.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.43,
      min_module_id: 'nose',
      min_module_pixels: 72,
      module_guard_triggered: false,
      guarded_modules: [],
    },
    {
      source: 'celebamaskhq',
      sample_hash: 'celeb_001',
      image_path_rel: 'celeb_001.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.85,
      min_module_id: 'chin',
      min_module_pixels: 18,
      module_guard_triggered: true,
      guarded_modules: ['chin'],
    },
    {
      source: 'celebamaskhq',
      sample_hash: 'celeb_002',
      image_path_rel: 'celeb_002.jpg',
      ok: true,
      pipeline_mode_used: 'local',
      risk_score: 0.54,
      min_module_id: 'forehead',
      min_module_pixels: 62,
      module_guard_triggered: false,
      guarded_modules: [],
    },
  ];
}

test('gold_round1_real_pack.mjs is deterministic with fixed seed', async () => {
  const root = await makeTempDir('aurora_gold_round1_real_pack_');
  try {
    const scriptPath = repoPath('scripts', 'gold_round1_real_pack.mjs');
    const reviewPath = path.join(root, 'reports', 'review_pack_mixed_20260211_105639451.jsonl');
    const internalDir = path.join(root, 'internal');
    const cacheDir = path.join(root, 'datasets_cache', 'external');
    const lapaDir = path.join(cacheDir, 'lapa');
    const celebaDir = path.join(cacheDir, 'celebamaskhq');

    await Promise.all([
      createJpeg(path.join(internalDir, 'internal_001.jpg'), { r: 110, g: 90, b: 70 }),
      createJpeg(path.join(internalDir, 'internal_002.jpg'), { r: 100, g: 120, b: 60 }),
      createJpeg(path.join(lapaDir, 'lapa_001.jpg'), { r: 90, g: 130, b: 180 }),
      createJpeg(path.join(lapaDir, 'lapa_002.jpg'), { r: 120, g: 100, b: 160 }),
      createJpeg(path.join(lapaDir, 'lapa_003.jpg'), { r: 160, g: 120, b: 110 }),
      createJpeg(path.join(celebaDir, 'celeb_001.jpg'), { r: 140, g: 110, b: 90 }),
      createJpeg(path.join(celebaDir, 'celeb_002.jpg'), { r: 130, g: 140, b: 100 }),
    ]);
    await writeNdjson(reviewPath, reviewRowsFixture());

    const run = async (outDir) => {
      const { stdout } = await runExecFile('node', [
        scriptPath,
        '--run_id', '20260211_105639451',
        '--review_in', reviewPath,
        '--out', outDir,
        '--limit', '6',
        '--bucket_n', '2',
        '--limit_internal', '2',
        '--seed', 'round1_real_seed_fixed',
        '--double_annotate_ratio', '0.5',
        '--internal_dir', internalDir,
        '--cache_dir', cacheDir,
        '--lapa_dir', lapaDir,
        '--celeba_dir', celebaDir,
      ], { cwd: root });
      const payload = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1));
      return payload;
    };

    const outA = path.join(root, 'artifacts', 'gold_round1_real_A');
    const outB = path.join(root, 'artifacts', 'gold_round1_real_B');
    const summaryA = await run(outA);
    const summaryB = await run(outB);

    assert.equal(summaryA.ok, true);
    assert.equal(summaryB.ok, true);
    assert.equal(summaryA.packaged_total, 6);
    assert.equal(summaryB.packaged_total, 6);

    const manifestA = JSON.parse(await fs.readFile(path.join(root, summaryA.artifacts.manifest_json), 'utf8'));
    const manifestB = JSON.parse(await fs.readFile(path.join(root, summaryB.artifacts.manifest_json), 'utf8'));
    const hashesA = manifestA.rows.map((row) => `${row.source}:${row.sample_hash}`);
    const hashesB = manifestB.rows.map((row) => `${row.source}:${row.sample_hash}`);
    assert.deepEqual(hashesA, hashesB);

    const tasksA = JSON.parse(await fs.readFile(path.join(root, summaryA.artifacts.tasks_json), 'utf8'));
    assert.equal(tasksA.length, 6);
    assert.ok(tasksA.every((task) => typeof task.data.image === 'string' && task.data.image.startsWith('file://')));
    assert.ok(tasksA.every((task) => task.metadata && typeof task.metadata.double_annotate === 'boolean'));
    assert.ok(tasksA.some((task) => task.metadata.double_annotate === true));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
