const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const celebaAdapter = require('../src/auroraBff/evalAdapters/celebamaskAdapter');
const { countOnes } = require('../src/auroraBff/evalAdapters/common/metrics');

function makeMask(width, height, fn) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      out[y * width + x] = fn(x, y) ? 255 : 0;
    }
  }
  return out;
}

async function writeGrayPng(filePath, mask, width, height) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const image = sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } });
  await image.png().toFile(filePath);
}

async function writeRgbJpg(filePath, width, height) {
  const raw = Buffer.alloc(width * height * 3, 180);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  await image.jpeg({ quality: 90 }).toFile(filePath);
}

test('celebamask adapter loads sample and derives parsing module masks', async (t) => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'celebamask-adapter-'));
  t.after(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  const cacheRoot = path.join(tmpRoot, 'datasets_cache');
  const cacheExternal = path.join(cacheRoot, 'external');
  const datasetRoot = path.join(cacheExternal, 'celebamaskhq', 'v1');
  const imageRel = path.join('images', 'sample1.jpg');
  const imageAbs = path.join(datasetRoot, imageRel);
  const width = 64;
  const height = 64;
  await writeRgbJpg(imageAbs, width, height);

  const skinMask = makeMask(width, height, (x, y) => x >= 10 && x <= 54 && y >= 8 && y <= 60);
  const hairMask = makeMask(width, height, (x, y) => x >= 8 && x <= 56 && y >= 0 && y <= 14);
  const noseMask = makeMask(width, height, (x, y) => x >= 29 && x <= 35 && y >= 24 && y <= 42);
  const lEyeMask = makeMask(width, height, (x, y) => x >= 18 && x <= 25 && y >= 20 && y <= 24);
  const rEyeMask = makeMask(width, height, (x, y) => x >= 38 && x <= 45 && y >= 20 && y <= 24);

  await writeGrayPng(path.join(datasetRoot, 'masks', 'sample1_skin.png'), skinMask, width, height);
  await writeGrayPng(path.join(datasetRoot, 'masks', 'sample1_hair.png'), hairMask, width, height);
  await writeGrayPng(path.join(datasetRoot, 'masks', 'sample1_nose.png'), noseMask, width, height);
  await writeGrayPng(path.join(datasetRoot, 'masks', 'sample1_l_eye.png'), lEyeMask, width, height);
  await writeGrayPng(path.join(datasetRoot, 'masks', 'sample1_r_eye.png'), rEyeMask, width, height);

  const indexPath = path.join(datasetRoot, 'dataset_index.jsonl');
  const indexRow = {
    sample_id: 'sample1',
    split: 'train',
    image_path: imageRel,
    mask_paths: [
      { part: 'skin', path: 'masks/sample1_skin.png' },
      { part: 'hair', path: 'masks/sample1_hair.png' },
      { part: 'nose', path: 'masks/sample1_nose.png' },
      { part: 'l_eye', path: 'masks/sample1_l_eye.png' },
      { part: 'r_eye', path: 'masks/sample1_r_eye.png' },
    ],
  };
  await fsp.writeFile(indexPath, `${JSON.stringify(indexRow)}\n`, 'utf8');

  const manifestsDir = path.join(cacheRoot, 'manifests');
  await fsp.mkdir(manifestsDir, { recursive: true });
  const manifestPath = path.join(manifestsDir, 'celebamaskhq.manifest.json');
  const manifest = {
    dataset: 'celebamaskhq',
    extract_rel_path: path.relative(tmpRoot, datasetRoot),
    index_rel_path: path.relative(tmpRoot, indexPath),
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const loaded = await celebaAdapter.loadSamples({
    repoRoot: tmpRoot,
    cacheExternalDir: cacheExternal,
    cacheRootDir: cacheRoot,
    limit: 1,
    shuffle: false,
  });
  assert.equal(Array.isArray(loaded.samples), true);
  assert.equal(loaded.samples.length, 1);

  const evalSample = celebaAdapter.toEvalSample(loaded.samples[0]);
  const gt = await celebaAdapter.buildSkinMask(evalSample);
  assert.equal(gt.ok, true);
  assert.equal(gt.width, width);
  assert.equal(gt.height, height);
  assert.ok(gt.module_masks && typeof gt.module_masks === 'object');

  const requiredModules = [
    'forehead',
    'left_cheek',
    'right_cheek',
    'nose',
    'chin',
    'under_eye_left',
    'under_eye_right',
  ];
  for (const moduleId of requiredModules) {
    const moduleMask = gt.module_masks[moduleId];
    assert.ok(moduleMask instanceof Uint8Array, `${moduleId} mask should exist`);
    assert.equal(moduleMask.length, width * height, `${moduleId} mask size mismatch`);
    for (let i = 0; i < moduleMask.length; i += 1) {
      assert.ok(moduleMask[i] === 0 || moduleMask[i] === 1, `${moduleId} should be binary`);
    }
  }

  assert.ok(countOnes(gt.module_masks.forehead) > 0);
  assert.ok(countOnes(gt.module_masks.left_cheek) > 0);
  assert.ok(countOnes(gt.module_masks.right_cheek) > 0);
  assert.ok(countOnes(gt.module_masks.chin) > 0);
  assert.ok(countOnes(gt.module_masks.nose) > 0);
});
