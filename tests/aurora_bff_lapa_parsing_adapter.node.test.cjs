const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const lapaAdapter = require('../src/auroraBff/evalAdapters/lapaAdapter');
const { countOnes } = require('../src/auroraBff/evalAdapters/common/metrics');

function makeLabelMask(width, height, fill = 0) {
  return new Uint8Array(width * height).fill(fill);
}

function fillRect(mask, width, height, x0, y0, x1, y1, value) {
  const left = Math.max(0, Math.min(width - 1, Math.floor(Math.min(x0, x1))));
  const right = Math.max(0, Math.min(width - 1, Math.floor(Math.max(x0, x1))));
  const top = Math.max(0, Math.min(height - 1, Math.floor(Math.min(y0, y1))));
  const bottom = Math.max(0, Math.min(height - 1, Math.floor(Math.max(y0, y1))));
  for (let y = top; y <= bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x <= right; x += 1) {
      mask[rowOffset + x] = value;
    }
  }
}

async function writeGrayPng(filePath, mask, width, height) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const image = sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } });
  await image.png().toFile(filePath);
}

async function writeRgbJpg(filePath, width, height) {
  const raw = Buffer.alloc(width * height * 3, 170);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const image = sharp(raw, { raw: { width, height, channels: 3 } });
  await image.jpeg({ quality: 90 }).toFile(filePath);
}

test('lapa adapter loads parsing_gt sample and derives module masks', async (t) => {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lapa-adapter-'));
  t.after(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  const cacheRoot = path.join(tmpRoot, 'datasets_cache');
  const cacheExternal = path.join(cacheRoot, 'external');
  const datasetRoot = path.join(cacheExternal, 'lapa', 'v1');
  const imageRel = path.join('images', 'sample1.jpg');
  const maskRel = path.join('labels', 'sample1.png');
  const imageAbs = path.join(datasetRoot, imageRel);
  const maskAbs = path.join(datasetRoot, maskRel);
  const width = 64;
  const height = 64;

  await writeRgbJpg(imageAbs, width, height);
  const labelMask = makeLabelMask(width, height, 0);
  fillRect(labelMask, width, height, 10, 8, 54, 60, 1);   // skin
  fillRect(labelMask, width, height, 8, 0, 56, 14, 10);   // hair
  fillRect(labelMask, width, height, 29, 24, 35, 42, 6);  // nose
  fillRect(labelMask, width, height, 18, 20, 25, 24, 4);  // left_eye
  fillRect(labelMask, width, height, 38, 20, 45, 24, 5);  // right_eye
  await writeGrayPng(maskAbs, labelMask, width, height);

  const indexPath = path.join(datasetRoot, 'dataset_index.jsonl');
  const indexRow = {
    sample_id: 'sample1',
    split: 'train',
    image_path: imageRel,
    mask_path: maskRel,
  };
  await fsp.mkdir(path.dirname(indexPath), { recursive: true });
  await fsp.writeFile(indexPath, `${JSON.stringify(indexRow)}\n`, 'utf8');

  const manifestsDir = path.join(cacheRoot, 'manifests');
  await fsp.mkdir(manifestsDir, { recursive: true });
  const manifestPath = path.join(manifestsDir, 'lapa.manifest.json');
  const manifest = {
    dataset: 'lapa',
    extract_rel_path: path.relative(tmpRoot, datasetRoot),
    index_rel_path: path.relative(tmpRoot, indexPath),
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const loaded = await lapaAdapter.loadSamples({
    repoRoot: tmpRoot,
    cacheExternalDir: cacheExternal,
    cacheRootDir: cacheRoot,
    limit: 1,
    shuffle: false,
  });
  assert.equal(Array.isArray(loaded.samples), true);
  assert.equal(loaded.samples.length, 1);

  const evalSample = lapaAdapter.toEvalSample(loaded.samples[0]);
  const gt = await lapaAdapter.buildSkinMask(evalSample);
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
    assert.ok(countOnes(moduleMask) > 0, `${moduleId} should have positive pixels`);
  }

  assert.ok(gt.hair_mask instanceof Uint8Array);
  assert.ok(gt.background_mask instanceof Uint8Array);
  assert.ok(countOnes(gt.hair_mask) > 0);
  assert.ok(countOnes(gt.background_mask) > 0);
});

