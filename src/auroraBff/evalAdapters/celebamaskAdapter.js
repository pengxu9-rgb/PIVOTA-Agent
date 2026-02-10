'use strict';

const {
  resolveDatasetFiles,
  readJsonl,
  pickRows,
  hashSampleId,
  safeResolveUnder,
  summarizeRows,
} = require('./common/datasetUtils');
const { readBinaryMaskFromThreshold, resizeMaskNearest, mergeMasks } = require('./common/maskUtils');

const DATASET = 'celebamaskhq';
const PRIMARY_PARTS = new Set(['skin', 'nose', 'l_eye', 'r_eye', 'l_brow', 'r_brow', 'mouth', 'u_lip', 'l_lip']);

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

    const rawParts = Array.isArray(row && row.mask_paths) ? row.mask_paths : [];
    const partMasks = [];
    for (const partEntry of rawParts) {
      if (!partEntry || typeof partEntry !== 'object') continue;
      const relPath = String(partEntry.path || '').trim();
      if (!relPath) continue;
      const absPath = safeResolveUnder(files.datasetRoot, relPath);
      if (!absPath) continue;
      partMasks.push({
        part: String(partEntry.part || 'unknown').toLowerCase(),
        path: absPath,
      });
    }
    if (!partMasks.length) continue;
    const sourceId = String(row.sample_id || imageRel);
    samples.push({
      dataset: DATASET,
      sample_id: hashSampleId(DATASET, sourceId),
      image_path: imageAbs,
      split: String(row.split || 'unknown'),
      part_masks: partMasks,
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
        label_map: {
          skin_parts: sample.part_masks.map((part) => part.part),
        },
        coord_space: 'image_px',
      },
    ],
    gt_parts: {
      part_masks: sample.part_masks,
    },
    meta: {
      split: sample.split,
      ...sample.meta,
    },
  };
}

async function buildSkinMask(evalSample) {
  const parts = evalSample && evalSample.gt_parts && Array.isArray(evalSample.gt_parts.part_masks)
    ? evalSample.gt_parts.part_masks
    : [];
  if (!parts.length) {
    return {
      ok: false,
      reason: 'mask_parts_missing',
      weak_label: false,
    };
  }

  const preferred = parts.filter((entry) => PRIMARY_PARTS.has(String(entry.part || '').toLowerCase()));
  const useParts = preferred.length ? preferred : parts;

  let merged = null;
  let width = 0;
  let height = 0;
  for (const part of useParts) {
    const parsed = await readBinaryMaskFromThreshold(part.path, 1);
    const currentMask =
      width && height && (parsed.width !== width || parsed.height !== height)
        ? resizeMaskNearest(parsed.mask, parsed.width, parsed.height, width, height)
        : parsed.mask;
    if (!merged) {
      width = parsed.width;
      height = parsed.height;
      merged = currentMask;
    } else {
      merged = mergeMasks(merged, currentMask);
    }
  }

  return {
    ok: Boolean(merged),
    weak_label: false,
    width,
    height,
    mask: merged || null,
    note: preferred.length ? null : 'fallback_all_parts',
  };
}

module.exports = {
  name: DATASET,
  loadSamples,
  toEvalSample,
  buildSkinMask,
};
