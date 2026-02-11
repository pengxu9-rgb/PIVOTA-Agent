'use strict';

const {
  resolveDatasetFiles,
  readJsonl,
  pickRows,
  hashSampleId,
  safeResolveUnder,
  summarizeRows,
} = require('./common/datasetUtils');
const { readMaskLabelImage, maskFromAllowedLabelValues } = require('./common/maskUtils');
const { countOnes } = require('./common/metrics');

const DATASET = 'fasseg';
const PRIMARY_SKIN_LABEL = 1;
const FALLBACK_LABELS = [2, 3, 4, 5, 255];

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

    const maskRel = String(
      row && typeof row.mask_path === 'string' && row.mask_path.trim()
        ? row.mask_path
        : row && typeof row.annotation_path === 'string'
          ? row.annotation_path
          : '',
    ).trim();
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
        label_map: { skin: PRIMARY_SKIN_LABEL },
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

  const labelImage = await readMaskLabelImage(maskPath);
  const backgroundMask = maskFromAllowedLabelValues(labelImage, [0]);
  const hairMask = maskFromAllowedLabelValues(labelImage, [2]);
  const primaryMask = maskFromAllowedLabelValues(labelImage, [PRIMARY_SKIN_LABEL]);
  const primaryCount = countOnes(primaryMask);
  if (primaryCount >= 128) {
    return {
      ok: true,
      weak_label: false,
      width: labelImage.width,
      height: labelImage.height,
      mask: primaryMask,
      background_mask: backgroundMask,
      hair_mask: hairMask,
      note: null,
    };
  }

  let bestMask = primaryMask;
  let bestCount = primaryCount;
  let bestLabel = PRIMARY_SKIN_LABEL;
  for (const label of FALLBACK_LABELS) {
    const candidate = maskFromAllowedLabelValues(labelImage, [label]);
    const candidateCount = countOnes(candidate);
    if (candidateCount > bestCount) {
      bestMask = candidate;
      bestCount = candidateCount;
      bestLabel = label;
    }
  }

  if (bestCount < 64) {
    return {
      ok: false,
      reason: 'skin_label_not_found',
      weak_label: true,
      note: 'fasseg_label_map_unknown',
    };
  }

  return {
    ok: true,
    weak_label: bestLabel !== PRIMARY_SKIN_LABEL,
    width: labelImage.width,
    height: labelImage.height,
    mask: bestMask,
    background_mask: backgroundMask,
    hair_mask: hairMask,
    note: bestLabel === PRIMARY_SKIN_LABEL ? null : `fallback_label_${bestLabel}`,
  };
}

module.exports = {
  name: DATASET,
  loadSamples,
  toEvalSample,
  buildSkinMask,
};
