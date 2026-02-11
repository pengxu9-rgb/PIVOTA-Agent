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
const { andMasks, countOnes } = require('./common/metrics');

const DATASET = 'celebamaskhq';
const PRIMARY_PARTS = new Set(['skin', 'nose', 'l_eye', 'r_eye', 'l_brow', 'r_brow', 'mouth', 'u_lip', 'l_lip']);
const SKIN_PARTS = new Set(['skin']);
const FACE_PARTS = new Set(['skin', 'nose', 'l_eye', 'r_eye', 'l_brow', 'r_brow', 'mouth', 'u_lip', 'l_lip']);
const HAIR_PARTS = new Set(['hair']);
const LEFT_EYE_PARTS = new Set(['l_eye', 'left_eye']);
const RIGHT_EYE_PARTS = new Set(['r_eye', 'right_eye']);
const NOSE_PARTS = new Set(['nose']);

const DEFAULT_BANDS = Object.freeze({
  forehead_y1: 0.34,
  cheek_y0: 0.34,
  cheek_y1: 0.74,
  chin_y0: 0.7,
  under_eye_y0: 0.33,
  under_eye_y1: 0.48,
});

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

function createMask(length, fill = 0) {
  return new Uint8Array(Math.max(0, Number(length) || 0)).fill(fill ? 1 : 0);
}

function normalizePart(part) {
  return String(part || '').trim().toLowerCase();
}

function mergePartSet(partMaskMap, partSet) {
  let merged = null;
  for (const partName of partSet) {
    const partMask = partMaskMap.get(partName);
    if (!(partMask instanceof Uint8Array)) continue;
    merged = merged ? mergeMasks(merged, partMask) : new Uint8Array(partMask);
  }
  return merged;
}

function invertMask(mask) {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) {
    out[i] = mask[i] ? 0 : 1;
  }
  return out;
}

function maskBoundingBox(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (!mask[rowOffset + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function buildApproxFaceOvalMask(skinMask, width, height) {
  const bbox = maskBoundingBox(skinMask, width, height);
  if (!bbox) return new Uint8Array(skinMask);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = bbox.minY + bbox.height * 0.56;
  const rx = Math.max(8, bbox.width * 0.56);
  const ry = Math.max(8, bbox.height * 0.62);
  const out = createMask(width * height, 0);
  for (let y = bbox.minY; y <= bbox.maxY; y += 1) {
    const dy = (y - cy) / ry;
    const rowOffset = y * width;
    for (let x = bbox.minX; x <= bbox.maxX; x += 1) {
      const sourceIndex = rowOffset + x;
      if (!skinMask[sourceIndex]) continue;
      const dx = (x - cx) / rx;
      if (dx * dx + dy * dy <= 1.08) out[sourceIndex] = 1;
    }
  }
  return countOnes(out) >= 128 ? out : new Uint8Array(skinMask);
}

function rectMask(width, height, x0, y0, x1, y1) {
  const out = createMask(width * height, 0);
  const left = Math.max(0, Math.min(width - 1, Math.floor(Math.min(x0, x1))));
  const right = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(x0, x1))));
  const top = Math.max(0, Math.min(height - 1, Math.floor(Math.min(y0, y1))));
  const bottom = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(y0, y1))));
  if (right < left || bottom < top) return out;
  for (let y = top; y <= bottom; y += 1) {
    const rowOffset = y * width;
    for (let x = left; x <= right; x += 1) {
      out[rowOffset + x] = 1;
    }
  }
  return out;
}

function maskFromRelativeBand({
  skinMask,
  ovalMask,
  bbox,
  width,
  height,
  x0,
  x1,
  y0,
  y1,
}) {
  if (!bbox) return createMask(width * height, 0);
  const left = bbox.minX + Math.floor(bbox.width * x0);
  const right = bbox.minX + Math.ceil(bbox.width * x1);
  const top = bbox.minY + Math.floor(bbox.height * y0);
  const bottom = bbox.minY + Math.ceil(bbox.height * y1);
  const regionMask = rectMask(width, height, left, top, right, bottom);
  return andMasks(andMasks(regionMask, skinMask), ovalMask);
}

function buildUnderEyeFromEyeMask({
  eyeMask,
  skinMask,
  ovalMask,
  width,
  height,
}) {
  const bbox = maskBoundingBox(eyeMask, width, height);
  if (!bbox) return null;
  const bandHeight = Math.max(6, Math.round(bbox.height * 1.35));
  const y0 = Math.min(height - 1, bbox.maxY + 1);
  const y1 = Math.min(height - 1, y0 + bandHeight);
  const xPad = Math.max(2, Math.round(bbox.width * 0.2));
  const x0 = Math.max(0, bbox.minX - xPad);
  const x1 = Math.min(width - 1, bbox.maxX + xPad);
  const bandMask = rectMask(width, height, x0, y0, x1, y1);
  return andMasks(andMasks(bandMask, skinMask), ovalMask);
}

function buildModuleMasksFromParsing({
  skinMask,
  hairMask,
  noseMask,
  leftEyeMask,
  rightEyeMask,
  width,
  height,
}) {
  const bbox = maskBoundingBox(skinMask, width, height);
  const ovalMask = buildApproxFaceOvalMask(skinMask, width, height);
  const skinInOval = andMasks(skinMask, ovalMask);

  const foreheadMask = maskFromRelativeBand({
    skinMask: skinInOval,
    ovalMask,
    bbox,
    width,
    height,
    x0: 0.15,
    x1: 0.85,
    y0: 0.03,
    y1: DEFAULT_BANDS.forehead_y1,
  });

  const chinMask = maskFromRelativeBand({
    skinMask: skinInOval,
    ovalMask,
    bbox,
    width,
    height,
    x0: 0.28,
    x1: 0.72,
    y0: DEFAULT_BANDS.chin_y0,
    y1: 0.98,
  });

  const leftCheekMask = maskFromRelativeBand({
    skinMask: skinInOval,
    ovalMask,
    bbox,
    width,
    height,
    x0: 0.06,
    x1: 0.48,
    y0: DEFAULT_BANDS.cheek_y0,
    y1: DEFAULT_BANDS.cheek_y1,
  });

  const rightCheekMask = maskFromRelativeBand({
    skinMask: skinInOval,
    ovalMask,
    bbox,
    width,
    height,
    x0: 0.52,
    x1: 0.94,
    y0: DEFAULT_BANDS.cheek_y0,
    y1: DEFAULT_BANDS.cheek_y1,
  });

  let resolvedNoseMask = noseMask ? andMasks(andMasks(noseMask, skinInOval), ovalMask) : null;
  if (!resolvedNoseMask || countOnes(resolvedNoseMask) < 16) {
    resolvedNoseMask = maskFromRelativeBand({
      skinMask: skinInOval,
      ovalMask,
      bbox,
      width,
      height,
      x0: 0.4,
      x1: 0.6,
      y0: 0.3,
      y1: 0.72,
    });
  }

  let underEyeLeftMask = leftEyeMask
    ? buildUnderEyeFromEyeMask({
        eyeMask: leftEyeMask,
        skinMask: skinInOval,
        ovalMask,
        width,
        height,
      })
    : null;
  if (!underEyeLeftMask || countOnes(underEyeLeftMask) < 8) {
    underEyeLeftMask = maskFromRelativeBand({
      skinMask: skinInOval,
      ovalMask,
      bbox,
      width,
      height,
      x0: 0.12,
      x1: 0.44,
      y0: DEFAULT_BANDS.under_eye_y0,
      y1: DEFAULT_BANDS.under_eye_y1,
    });
  }

  let underEyeRightMask = rightEyeMask
    ? buildUnderEyeFromEyeMask({
        eyeMask: rightEyeMask,
        skinMask: skinInOval,
        ovalMask,
        width,
        height,
      })
    : null;
  if (!underEyeRightMask || countOnes(underEyeRightMask) < 8) {
    underEyeRightMask = maskFromRelativeBand({
      skinMask: skinInOval,
      ovalMask,
      bbox,
      width,
      height,
      x0: 0.56,
      x1: 0.88,
      y0: DEFAULT_BANDS.under_eye_y0,
      y1: DEFAULT_BANDS.under_eye_y1,
    });
  }

  const faceWithoutSkin = andMasks(ovalMask, invertMask(skinMask));
  const hairResolved = hairMask instanceof Uint8Array ? hairMask : createMask(width * height, 0);
  const backgroundMask = andMasks(invertMask(skinMask), invertMask(hairResolved));

  return {
    skin_mask: skinMask,
    hair_mask: hairResolved,
    background_mask: backgroundMask,
    face_oval_mask: ovalMask,
    face_non_skin_mask: faceWithoutSkin,
    module_masks: {
      forehead: foreheadMask,
      left_cheek: leftCheekMask,
      right_cheek: rightCheekMask,
      nose: resolvedNoseMask,
      chin: chinMask,
      under_eye_left: underEyeLeftMask,
      under_eye_right: underEyeRightMask,
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

  const preferred = parts.filter((entry) => PRIMARY_PARTS.has(normalizePart(entry.part)));
  const useParts = preferred.length ? preferred : parts;

  const mergedPartMasks = new Map();
  let width = 0;
  let height = 0;
  for (const part of parts) {
    const parsed = await readBinaryMaskFromThreshold(part.path, 1);
    const currentMask =
      width && height && (parsed.width !== width || parsed.height !== height)
        ? resizeMaskNearest(parsed.mask, parsed.width, parsed.height, width, height)
        : parsed.mask;
    if (!width || !height) {
      width = parsed.width;
      height = parsed.height;
    }
    const key = normalizePart(part.part);
    const existing = mergedPartMasks.get(key);
    mergedPartMasks.set(key, existing ? mergeMasks(existing, currentMask) : currentMask);
  }
  const primarySkinMask = mergePartSet(mergedPartMasks, SKIN_PARTS);
  const fallbackSkinMask = mergePartSet(mergedPartMasks, FACE_PARTS);
  const merged = primarySkinMask || fallbackSkinMask;
  if (!(merged instanceof Uint8Array)) {
    return {
      ok: false,
      reason: 'skin_part_missing',
      weak_label: false,
      note: 'parsing_skin_part_missing',
    };
  }

  const derived = buildModuleMasksFromParsing({
    skinMask: merged,
    hairMask: mergePartSet(mergedPartMasks, HAIR_PARTS),
    noseMask: mergePartSet(mergedPartMasks, NOSE_PARTS),
    leftEyeMask: mergePartSet(mergedPartMasks, LEFT_EYE_PARTS),
    rightEyeMask: mergePartSet(mergedPartMasks, RIGHT_EYE_PARTS),
    width,
    height,
  });
  const fallbackAllPartsMask = (() => {
    let acc = null;
    for (const part of useParts) {
      const key = normalizePart(part.part);
      const mask = mergedPartMasks.get(key);
      if (!(mask instanceof Uint8Array)) continue;
      acc = acc ? mergeMasks(acc, mask) : new Uint8Array(mask);
    }
    return acc;
  })();

  return {
    ok: true,
    weak_label: false,
    width,
    height,
    mask: merged,
    background_mask: derived.background_mask,
    hair_mask: derived.hair_mask,
    module_masks: derived.module_masks,
    note: primarySkinMask ? null : 'fallback_face_parts_as_skin',
    label_hint: preferred.length ? null : 'fallback_all_parts',
    face_oval_mask: derived.face_oval_mask,
    face_non_skin_mask: derived.face_non_skin_mask,
    all_parts_mask: fallbackAllPartsMask || null,
  };
}

module.exports = {
  name: DATASET,
  loadSamples,
  toEvalSample,
  buildSkinMask,
};
