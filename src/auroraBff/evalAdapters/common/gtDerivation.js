'use strict';

const path = require('node:path');

const { MODULE_BOXES, moduleMaskFromBox, andMasks, countOnes, encodeRleBinary } = require('./metrics');
const { cropMaskToNorm } = require('./maskUtils');
const { writeJson } = require('./datasetUtils');

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeFaceCropBox(faceCrop, imageWidth, imageHeight) {
  const fallback = {
    x: 0,
    y: 0,
    w: Math.max(1, Math.floor(Number(imageWidth) || 1)),
    h: Math.max(1, Math.floor(Number(imageHeight) || 1)),
  };
  if (!faceCrop || typeof faceCrop !== 'object') return fallback;
  const bbox = faceCrop.bbox_px && typeof faceCrop.bbox_px === 'object' ? faceCrop.bbox_px : null;
  if (!bbox) return fallback;
  const x = clamp(Math.floor(Number(bbox.x)), 0, Math.max(0, fallback.w - 1));
  const y = clamp(Math.floor(Number(bbox.y)), 0, Math.max(0, fallback.h - 1));
  const w = clamp(Math.floor(Number(bbox.w)), 1, fallback.w);
  const h = clamp(Math.floor(Number(bbox.h)), 1, fallback.h);
  return {
    x,
    y,
    w: Math.max(1, Math.min(fallback.w - x, w)),
    h: Math.max(1, Math.min(fallback.h - y, h)),
  };
}

function faceCropFromSkinBBoxNorm({ skinBboxNorm, imageWidth, imageHeight, marginScale = 1.2 }) {
  const width = Math.max(1, Math.floor(Number(imageWidth) || 1));
  const height = Math.max(1, Math.floor(Number(imageHeight) || 1));
  const norm = skinBboxNorm && typeof skinBboxNorm === 'object' ? skinBboxNorm : null;
  if (!norm) {
    return { x: 0, y: 0, w: width, h: height };
  }

  const x0Raw = clamp01(norm.x0);
  const y0Raw = clamp01(norm.y0);
  const x1Raw = clamp01(norm.x1);
  const y1Raw = clamp01(norm.y1);
  const x0 = Math.min(x0Raw, x1Raw);
  const y0 = Math.min(y0Raw, y1Raw);
  const x1 = Math.max(x0Raw, x1Raw);
  const y1 = Math.max(y0Raw, y1Raw);
  const baseW = Math.max(0.01, x1 - x0);
  const baseH = Math.max(0.01, y1 - y0);
  const scale = Number.isFinite(Number(marginScale)) && Number(marginScale) > 0 ? Number(marginScale) : 1.2;
  const centerX = x0 + baseW / 2;
  const centerY = y0 + baseH / 2;
  const cropW = Math.min(1, baseW * scale);
  const cropH = Math.min(1, baseH * scale);
  const cropX0 = clamp01(centerX - cropW / 2);
  const cropY0 = clamp01(centerY - cropH / 2);
  const cropX1 = clamp01(cropX0 + cropW);
  const cropY1 = clamp01(cropY0 + cropH);

  const pxX = Math.max(0, Math.floor(cropX0 * width));
  const pxY = Math.max(0, Math.floor(cropY0 * height));
  const pxW = Math.max(1, Math.round((cropX1 - cropX0) * width));
  const pxH = Math.max(1, Math.round((cropY1 - cropY0) * height));
  return {
    x: pxX,
    y: pxY,
    w: Math.max(1, Math.min(width - pxX, pxW)),
    h: Math.max(1, Math.min(height - pxY, pxH)),
  };
}

function deriveGtModulesFromSkinMask({
  skinMaskImage,
  imageWidth,
  imageHeight,
  faceCropBox,
  gridSize = 128,
  moduleIds,
  moduleBoxes,
}) {
  if (!skinMaskImage || !(skinMaskImage.mask instanceof Uint8Array)) {
    return {
      coord_space: 'face_crop_norm_v1',
      grid: { w: gridSize, h: gridSize },
      skin_mask_rle_norm: '',
      module_masks: [],
      warnings: ['skin_mask_missing'],
    };
  }

  const sourceW = Number(skinMaskImage.width) || Number(imageWidth) || 1;
  const sourceH = Number(skinMaskImage.height) || Number(imageHeight) || 1;
  const crop = normalizeFaceCropBox(faceCropBox, imageWidth || sourceW, imageHeight || sourceH);
  const targetW = Math.max(16, Math.min(512, Math.floor(Number(gridSize) || 128)));
  const targetH = targetW;

  const skinMaskNorm = cropMaskToNorm(skinMaskImage.mask, sourceW, sourceH, crop, targetW, targetH);
  const modules = [];
  const boxLookup = moduleBoxes && typeof moduleBoxes === 'object' ? moduleBoxes : MODULE_BOXES;
  const ids = Array.isArray(moduleIds) && moduleIds.length ? moduleIds : Object.keys(boxLookup);
  for (const moduleId of ids) {
    const moduleMask = moduleMaskFromBox(moduleId, targetW, targetH, boxLookup);
    const gtMask = andMasks(skinMaskNorm, moduleMask);
    modules.push({
      module_id: moduleId,
      coord_space: 'face_crop_norm_v1',
      mask_rle_norm: encodeRleBinary(gtMask),
      positive_pixels: countOnes(gtMask),
    });
  }

  return {
    coord_space: 'face_crop_norm_v1',
    grid: { w: targetW, h: targetH },
    face_crop_bbox_px: crop,
    skin_mask_rle_norm: encodeRleBinary(skinMaskNorm),
    skin_positive_pixels: countOnes(skinMaskNorm),
    module_masks: modules,
    warnings: [],
  };
}

function deriveGtModulesFromImageMasks({
  skinMaskImage,
  moduleMasksImage,
  imageWidth,
  imageHeight,
  faceCropBox,
  gridSize = 128,
  moduleIds,
  moduleBoxes,
}) {
  if (!skinMaskImage || !(skinMaskImage.mask instanceof Uint8Array)) {
    return {
      coord_space: 'face_crop_norm_v1',
      grid: { w: gridSize, h: gridSize },
      skin_mask_rle_norm: '',
      module_masks: [],
      warnings: ['skin_mask_missing'],
    };
  }

  const sourceW = Number(skinMaskImage.width) || Number(imageWidth) || 1;
  const sourceH = Number(skinMaskImage.height) || Number(imageHeight) || 1;
  const crop = normalizeFaceCropBox(faceCropBox, imageWidth || sourceW, imageHeight || sourceH);
  const targetW = Math.max(16, Math.min(512, Math.floor(Number(gridSize) || 128)));
  const targetH = targetW;

  const skinMaskNorm = cropMaskToNorm(skinMaskImage.mask, sourceW, sourceH, crop, targetW, targetH);
  const modules = [];
  const warnings = [];
  const boxLookup = moduleBoxes && typeof moduleBoxes === 'object' ? moduleBoxes : MODULE_BOXES;
  const imageMasks = moduleMasksImage && typeof moduleMasksImage === 'object' ? moduleMasksImage : {};
  const ids = Array.isArray(moduleIds) && moduleIds.length ? moduleIds : Object.keys(boxLookup);

  for (const moduleId of ids) {
    const imageMask = imageMasks[moduleId];
    let gtMaskNorm = null;
    if (imageMask instanceof Uint8Array && imageMask.length === sourceW * sourceH) {
      gtMaskNorm = cropMaskToNorm(imageMask, sourceW, sourceH, crop, targetW, targetH);
      gtMaskNorm = andMasks(gtMaskNorm, skinMaskNorm);
    } else {
      const moduleMaskNorm = moduleMaskFromBox(moduleId, targetW, targetH, boxLookup);
      gtMaskNorm = andMasks(skinMaskNorm, moduleMaskNorm);
      warnings.push(`module_mask_missing:${moduleId}`);
    }
    modules.push({
      module_id: moduleId,
      coord_space: 'face_crop_norm_v1',
      mask_rle_norm: encodeRleBinary(gtMaskNorm),
      positive_pixels: countOnes(gtMaskNorm),
    });
  }

  return {
    coord_space: 'face_crop_norm_v1',
    grid: { w: targetW, h: targetH },
    face_crop_bbox_px: crop,
    skin_mask_rle_norm: encodeRleBinary(skinMaskNorm),
    skin_positive_pixels: countOnes(skinMaskNorm),
    module_masks: modules,
    warnings,
  };
}

function saveDerivedGt(cacheRootDir, dataset, sampleId, payload) {
  const filePath = path.join(cacheRootDir, 'derived_gt', dataset, `${sampleId}.json`);
  writeJson(filePath, payload);
  return filePath;
}

module.exports = {
  normalizeFaceCropBox,
  faceCropFromSkinBBoxNorm,
  deriveGtModulesFromSkinMask,
  deriveGtModulesFromImageMasks,
  saveDerivedGt,
};
