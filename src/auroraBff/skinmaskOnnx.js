'use strict';

const path = require('path');
const sharp = require('sharp');
const {
  clamp01,
  bboxNormToMask,
  resizeHeatmapToMask,
  andMasks,
  iouScore,
  countOnes,
  encodeRleBinary,
} = require('./evalAdapters/common/metrics');

const DEFAULT_INPUT_SIZE = Math.max(
  128,
  Math.min(1024, Math.trunc(Number(process.env.DIAG_SKINMASK_INPUT_SIZE || 512) || 512)),
);
const DEFAULT_THRESHOLD = Math.max(
  0.1,
  Math.min(0.95, Number(process.env.DIAG_SKINMASK_THRESHOLD || 0.5)),
);
const DEFAULT_SKIN_CLASS_ID = Math.max(
  0,
  Math.min(16, Math.trunc(Number(process.env.DIAG_SKINMASK_CLASS_ID || 1) || 1)),
);
const DEFAULT_GRID_SIZE = Math.max(
  32,
  Math.min(256, Math.trunc(Number(process.env.DIAG_SKINMASK_GRID || 64) || 64)),
);
const DEFAULT_MARGIN_SCALE = Math.max(
  1,
  Math.min(1.8, Number(process.env.DIAG_SKINMASK_FACE_MARGIN || 1.2)),
);
const DEFAULT_MIN_POSITIVE_RATIO = Math.max(
  0.01,
  Math.min(0.95, Number(process.env.DIAG_SKINMASK_MIN_POSITIVE_RATIO || 0.05)),
);
const DEFAULT_MAX_POSITIVE_RATIO = Math.max(
  DEFAULT_MIN_POSITIVE_RATIO,
  Math.min(0.98, Number(process.env.DIAG_SKINMASK_MAX_POSITIVE_RATIO || 0.92)),
);
const DEFAULT_BBOX_IOU_MIN = Math.max(
  0,
  Math.min(1, Number(process.env.DIAG_SKINMASK_BBOX_IOU_MIN || 0.12)),
);

let ortRuntime = undefined;
const sessionCache = new Map();

function loadOrtRuntime() {
  if (ortRuntime !== undefined) return ortRuntime;
  try {
    ortRuntime = require('onnxruntime-node');
  } catch (_error) {
    ortRuntime = null;
  }
  return ortRuntime;
}

function normalizeGridSize(value, fallback = DEFAULT_GRID_SIZE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(32, Math.min(256, Math.trunc(n)));
}

function normalizeInputSize(value, fallback = DEFAULT_INPUT_SIZE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(128, Math.min(1024, Math.trunc(n)));
}

function clampBoxToImage(box, width, height) {
  const x = Math.max(0, Math.min(width - 1, Math.trunc(Number(box.x) || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.trunc(Number(box.y) || 0)));
  const maxW = Math.max(1, width - x);
  const maxH = Math.max(1, height - y);
  const w = Math.max(1, Math.min(maxW, Math.trunc(Number(box.w) || width)));
  const h = Math.max(1, Math.min(maxH, Math.trunc(Number(box.h) || height)));
  return { x, y, w, h };
}

function faceCropFromSkinBboxNorm(skinBBoxNorm, width, height, marginScale = DEFAULT_MARGIN_SCALE) {
  if (!skinBBoxNorm || typeof skinBBoxNorm !== 'object') return null;
  const x0 = clamp01(Number(skinBBoxNorm.x0));
  const y0 = clamp01(Number(skinBBoxNorm.y0));
  const x1 = clamp01(Number(skinBBoxNorm.x1));
  const y1 = clamp01(Number(skinBBoxNorm.y1));
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const right = Math.max(x0, x1);
  const bottom = Math.max(y0, y1);
  const baseW = Math.max(0.01, right - left);
  const baseH = Math.max(0.01, bottom - top);
  const centerX = left + baseW / 2;
  const centerY = top + baseH / 2;
  const scaledW = Math.min(1, baseW * marginScale);
  const scaledH = Math.min(1, baseH * marginScale);
  const cropX0 = clamp01(centerX - scaledW / 2);
  const cropY0 = clamp01(centerY - scaledH / 2);
  const cropX1 = clamp01(cropX0 + scaledW);
  const cropY1 = clamp01(cropY0 + scaledH);
  const px = {
    x: Math.floor(cropX0 * width),
    y: Math.floor(cropY0 * height),
    w: Math.max(1, Math.round((cropX1 - cropX0) * width)),
    h: Math.max(1, Math.round((cropY1 - cropY0) * height)),
  };
  return clampBoxToImage(px, width, height);
}

function resolveFaceCropBox(diagnosisInternal, width, height) {
  const internal = diagnosisInternal && typeof diagnosisInternal === 'object' ? diagnosisInternal : {};
  const existing = internal.face_crop && typeof internal.face_crop === 'object' ? internal.face_crop : null;
  if (existing && existing.bbox_px && typeof existing.bbox_px === 'object') {
    return clampBoxToImage(existing.bbox_px, width, height);
  }
  if (internal.skin_bbox_norm && typeof internal.skin_bbox_norm === 'object') {
    const marginScale = Number.isFinite(Number(internal.face_crop_margin_scale))
      ? Number(internal.face_crop_margin_scale)
      : DEFAULT_MARGIN_SCALE;
    const fromNorm = faceCropFromSkinBboxNorm(internal.skin_bbox_norm, width, height, marginScale);
    if (fromNorm) return fromNorm;
  }
  return { x: 0, y: 0, w: width, h: height };
}

async function getSession(modelPathInput) {
  const modelPath = String(modelPathInput || '').trim();
  if (!modelPath) return null;
  const ort = loadOrtRuntime();
  if (!ort) return null;
  const resolved = path.resolve(modelPath);
  if (!sessionCache.has(resolved)) {
    const createPromise = (async () => {
      const attempts = [
        { executionProviders: ['cpuExecutionProvider'], graphOptimizationLevel: 'all' },
        { executionProviders: ['cpu'], graphOptimizationLevel: 'all' },
        { graphOptimizationLevel: 'all' },
        {},
      ];
      let lastError = null;
      for (const options of attempts) {
        try {
          return await ort.InferenceSession.create(resolved, options);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('onnx_session_create_failed');
    })();
    sessionCache.set(resolved, createPromise);
  }
  try {
    return await sessionCache.get(resolved);
  } catch (error) {
    sessionCache.delete(resolved);
    throw error;
  }
}

function logitsToSkinMask(logitsTensor, skinClassId) {
  const tensor = logitsTensor && typeof logitsTensor === 'object' ? logitsTensor : null;
  if (!tensor || !Array.isArray(tensor.dims) || !tensor.data) return null;
  const dims = tensor.dims.map((value) => Number(value));
  if (dims.length !== 4) return null;
  const data = tensor.data;
  if (!data || typeof data.length !== 'number') return null;

  let channelsFirst = true;
  let classes = 0;
  let h = 0;
  let w = 0;
  if (dims[1] >= 2 && dims[1] <= 32) {
    classes = dims[1];
    h = dims[2];
    w = dims[3];
    channelsFirst = true;
  } else if (dims[3] >= 2 && dims[3] <= 32) {
    classes = dims[3];
    h = dims[1];
    w = dims[2];
    channelsFirst = false;
  } else {
    return null;
  }
  if (!classes || !h || !w) return null;
  const out = new Float32Array(h * w);
  const safeSkinClassId = Math.max(0, Math.min(classes - 1, Math.trunc(Number(skinClassId) || 0)));

  if (channelsFirst) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const pixelBase = y * w + x;
        let bestClass = 0;
        let bestValue = Number.NEGATIVE_INFINITY;
        for (let c = 0; c < classes; c += 1) {
          const v = Number(data[c * h * w + pixelBase] || 0);
          if (v > bestValue) {
            bestValue = v;
            bestClass = c;
          }
        }
        out[pixelBase] = bestClass === safeSkinClassId ? 1 : 0;
      }
    }
  } else {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const pixelBase = y * w + x;
        let bestClass = 0;
        let bestValue = Number.NEGATIVE_INFINITY;
        for (let c = 0; c < classes; c += 1) {
          const v = Number(data[pixelBase * classes + c] || 0);
          if (v > bestValue) {
            bestValue = v;
            bestClass = c;
          }
        }
        out[pixelBase] = bestClass === safeSkinClassId ? 1 : 0;
      }
    }
  }

  return { mask: out, width: w, height: h };
}

function maskBoundingNorm(mask, gridSize) {
  if (!(mask instanceof Uint8Array) || !mask.length) return null;
  let minX = gridSize;
  let minY = gridSize;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      if (!mask[y * gridSize + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return {
    x: minX / gridSize,
    y: minY / gridSize,
    w: (maxX + 1 - minX) / gridSize,
    h: (maxY + 1 - minY) / gridSize,
  };
}

async function inferSkinMaskOnFaceCrop({
  imageBuffer,
  diagnosisInternal,
  modelPath,
  gridSize,
  inputSize,
  threshold,
  skinClassId,
} = {}) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return { ok: false, reason: 'image_buffer_missing' };
  }
  const modelPathToken = String(modelPath || '').trim();
  if (!modelPathToken) {
    return { ok: false, reason: 'model_path_missing' };
  }
  const ort = loadOrtRuntime();
  if (!ort) {
    return { ok: false, reason: 'onnxruntime_missing' };
  }

  let session = null;
  try {
    session = await getSession(modelPathToken);
  } catch (error) {
    return { ok: false, reason: 'session_load_failed', detail: String(error && error.message ? error.message : error) };
  }
  if (!session) return { ok: false, reason: 'session_unavailable' };

  const targetGrid = normalizeGridSize(gridSize, DEFAULT_GRID_SIZE);
  const targetInput = normalizeInputSize(inputSize, DEFAULT_INPUT_SIZE);
  const scoreThreshold = Math.max(0.1, Math.min(0.95, Number(threshold || DEFAULT_THRESHOLD)));
  const targetSkinClassId = Math.max(0, Math.min(32, Math.trunc(Number(skinClassId || DEFAULT_SKIN_CLASS_ID))));

  let normalized = null;
  try {
    normalized = await sharp(imageBuffer, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true });
  } catch (error) {
    return { ok: false, reason: 'image_decode_failed', detail: String(error && error.message ? error.message : error) };
  }
  const normalizedBuffer = normalized && normalized.data ? normalized.data : null;
  const width = Number(normalized && normalized.info && normalized.info.width);
  const height = Number(normalized && normalized.info && normalized.info.height);
  if (!normalizedBuffer || !width || !height) {
    return { ok: false, reason: 'image_metadata_missing' };
  }

  const faceBox = resolveFaceCropBox(diagnosisInternal, width, height);
  const sharpExtractBox = {
    left: faceBox.x,
    top: faceBox.y,
    width: faceBox.w,
    height: faceBox.h,
  };
  let cropRaw = null;
  try {
    cropRaw = await sharp(normalizedBuffer, { failOn: 'none' })
      .extract(sharpExtractBox)
      .resize(targetInput, targetInput, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch (error) {
    return { ok: false, reason: 'face_crop_failed', detail: String(error && error.message ? error.message : error) };
  }
  if (!cropRaw || cropRaw.length !== targetInput * targetInput * 3) {
    return { ok: false, reason: 'face_crop_invalid' };
  }

  const chw = new Float32Array(3 * targetInput * targetInput);
  const size = targetInput * targetInput;
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < size; i += 1) {
    const o = i * 3;
    const r = cropRaw[o] / 255;
    const g = cropRaw[o + 1] / 255;
    const b = cropRaw[o + 2] / 255;
    chw[i] = (r - mean[0]) / std[0];
    chw[size + i] = (g - mean[1]) / std[1];
    chw[size * 2 + i] = (b - mean[2]) / std[2];
  }

  const inputName = Array.isArray(session.inputNames) && session.inputNames[0] ? session.inputNames[0] : 'pixel_values';
  const outputName = Array.isArray(session.outputNames) && session.outputNames[0] ? session.outputNames[0] : null;
  const inputTensor = new ort.Tensor('float32', chw, [1, 3, targetInput, targetInput]);

  let results;
  try {
    results = await session.run({ [inputName]: inputTensor });
  } catch (error) {
    return { ok: false, reason: 'inference_failed', detail: String(error && error.message ? error.message : error) };
  }
  const logitsTensor = outputName ? results[outputName] : Object.values(results || {})[0];
  const logitsMask = logitsToSkinMask(logitsTensor, targetSkinClassId);
  if (!logitsMask || !logitsMask.mask) {
    return { ok: false, reason: 'logits_parse_failed' };
  }

  let skinMask = resizeHeatmapToMask(
    Array.from(logitsMask.mask),
    logitsMask.width,
    logitsMask.height,
    targetGrid,
    targetGrid,
    scoreThreshold,
    1,
  );
  const priorMask =
    diagnosisInternal && diagnosisInternal.skin_bbox_norm
      ? bboxNormToMask(
          {
            x: clamp01(Number(diagnosisInternal.skin_bbox_norm.x0)),
            y: clamp01(Number(diagnosisInternal.skin_bbox_norm.y0)),
            w: clamp01(Number(diagnosisInternal.skin_bbox_norm.x1) - Number(diagnosisInternal.skin_bbox_norm.x0)),
            h: clamp01(Number(diagnosisInternal.skin_bbox_norm.y1) - Number(diagnosisInternal.skin_bbox_norm.y0)),
          },
          targetGrid,
          targetGrid,
        )
      : null;
  if (!countOnes(skinMask) && priorMask) {
    if (countOnes(priorMask)) skinMask = priorMask;
  } else if (priorMask && countOnes(priorMask)) {
    const totalPixels = targetGrid * targetGrid;
    const predictedPixels = countOnes(skinMask);
    const predictedRatio = predictedPixels / Math.max(1, totalPixels);
    const overlapMask = andMasks(skinMask, priorMask);
    const overlapPixels = countOnes(overlapMask);
    const overlapRatio = overlapPixels / Math.max(1, predictedPixels);
    const iouPrior = iouScore(skinMask, priorMask);
    const suspiciousByRatio =
      predictedRatio < DEFAULT_MIN_POSITIVE_RATIO || predictedRatio > DEFAULT_MAX_POSITIVE_RATIO;
    const suspiciousByPrior = iouPrior < DEFAULT_BBOX_IOU_MIN || overlapRatio < 0.25;
    if (suspiciousByRatio || suspiciousByPrior) {
      skinMask = priorMask;
    }
  }
  if (!countOnes(skinMask) && priorMask) {
    const fallbackMask = bboxNormToMask(
      {
        x: clamp01(Number(diagnosisInternal.skin_bbox_norm.x0)),
        y: clamp01(Number(diagnosisInternal.skin_bbox_norm.y0)),
        w: clamp01(Number(diagnosisInternal.skin_bbox_norm.x1) - Number(diagnosisInternal.skin_bbox_norm.x0)),
        h: clamp01(Number(diagnosisInternal.skin_bbox_norm.y1) - Number(diagnosisInternal.skin_bbox_norm.y0)),
      },
      targetGrid,
      targetGrid,
    );
    if (countOnes(fallbackMask)) skinMask = fallbackMask;
  }

  const positivePixels = countOnes(skinMask);
  return {
    ok: true,
    reason: null,
    model_path: path.resolve(modelPathToken),
    mask_grid: targetGrid,
    mask_rle_norm: encodeRleBinary(skinMask),
    positive_pixels: positivePixels,
    positive_ratio: positivePixels / (targetGrid * targetGrid),
    bbox: maskBoundingNorm(skinMask, targetGrid),
  };
}

module.exports = {
  inferSkinMaskOnFaceCrop,
};
