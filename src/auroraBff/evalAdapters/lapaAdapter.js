'use strict';

const path = require('node:path');

const {
  resolveDatasetFiles,
  readJsonl,
  pickRows,
  hashSampleId,
  safeResolveUnder,
  summarizeRows,
} = require('./common/datasetUtils');
const { readBinaryMaskFromLabelValues } = require('./common/maskUtils');

const DATASET = 'lapa';
const SKIN_LABEL_VALUES = [1];

async function loadSamples({ repoRoot, cacheExternalDir, cacheRootDir, limit, shuffle, seed } = {}) {
  const files = await resolveDatasetFiles({
    dataset: DATASET,
    repoRoot,
    cacheExternalDir,
    cacheRootDir,
  });
  const rows = await readJsonl(files.indexPath);
  const selected = pickRows(rows, { limit, shuffle, seed });
  const samples = [];
  for (const row of selected) {
    const imageRel = String(row && row.image_path ? row.image_path : '').trim();
    if (!imageRel) continue;
    const imageAbs = safeResolveUnder(files.datasetRoot, imageRel);
    if (!imageAbs) continue;
    const maskRel = String(row && row.mask_path ? row.mask_path : '').trim();
    if (!maskRel) continue;
    const maskAbs = safeResolveUnder(files.datasetRoot, maskRel);
    if (!maskAbs) continue;

    const sourceId = String(row.sample_id || imageRel);
    samples.push({
      dataset: DATASET,
      sample_id: hashSampleId(DATASET, sourceId),
      image_path: imageAbs,
      mask_path: maskAbs,
      split: String(row.split || 'unknown'),
      meta: {
        source_sample_id: String(row.sample_id || ''),
      },
    });
  }
  return {
    dataset: DATASET,
    samples,
    summary: summarizeRows(rows),
    manifest: files.manifest,
  };
}

function toEvalSample(sample) {
  return {
    dataset: DATASET,
    sample_id: sample.sample_id,
    image_bytes_path: sample.image_path,
    gt_masks: [
      {
        kind: 'segmentation',
        label_map: { skin: SKIN_LABEL_VALUES },
        mask_path: sample.mask_path,
        coord_space: 'image_px',
      },
    ],
    gt_parts: {
      skin_mask_path: sample.mask_path,
    },
    meta: {
      split: sample.split,
      ...sample.meta,
    },
  };
}

async function buildSkinMask(evalSample) {
  const gt = evalSample && Array.isArray(evalSample.gt_masks) ? evalSample.gt_masks[0] : null;
  const maskPath = gt && typeof gt.mask_path === 'string' ? gt.mask_path : '';
  if (!maskPath) {
    return {
      ok: false,
      reason: 'mask_path_missing',
      weak_label: false,
    };
  }
  const parsed = await readBinaryMaskFromLabelValues(maskPath, SKIN_LABEL_VALUES);
  return {
    ok: true,
    weak_label: false,
    width: parsed.width,
    height: parsed.height,
    mask: parsed.mask,
    note: null,
  };
}

module.exports = {
  name: DATASET,
  loadSamples,
  toEvalSample,
  buildSkinMask,
};
