'use strict';

const fs = require('fs');
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
const DEFAULT_SKINMASK_CLASSES = Object.freeze(['background', 'skin', 'hair', 'eyes', 'nose', 'mouth']);
const DEFAULT_SKINMASK_SCHEMA = Object.freeze({
  schema_version: 'aurora.skinmask.schema.v1',
  input: {
    color_space: 'RGB',
    range: '0-1',
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    size: [DEFAULT_INPUT_SIZE, DEFAULT_INPUT_SIZE],
    layout: 'NCHW',
  },
  output: {
    type: 'softmax',
    classes: DEFAULT_SKINMASK_CLASSES,
    skin_class: 'skin',
  },
});

let ortRuntime = undefined;
const sessionCache = new Map();
const schemaCache = new Map();

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

function summarizeChwStats(chw, width, height) {
  if (!(chw instanceof Float32Array)) return null;
  const h = Math.max(1, Math.trunc(Number(height) || 1));
  const w = Math.max(1, Math.trunc(Number(width) || 1));
  const plane = h * w;
  if (chw.length < plane * 3) return null;
  const channels = [];
  for (let c = 0; c < 3; c += 1) {
    const base = c * plane;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < plane; i += 1) {
      const value = Number(chw[base + i] || 0);
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
      sumSq += value * value;
    }
    const mean = sum / plane;
    const variance = Math.max(0, sumSq / plane - mean * mean);
    channels.push({
      min,
      max,
      mean,
      std: Math.sqrt(variance),
    });
  }
  return {
    shape: [1, 3, h, w],
    channels,
  };
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

function normalizeSchemaSize(sizeRaw, fallback = [DEFAULT_INPUT_SIZE, DEFAULT_INPUT_SIZE]) {
  if (Array.isArray(sizeRaw) && sizeRaw.length >= 2) {
    const h = normalizeInputSize(sizeRaw[0], fallback[0]);
    const w = normalizeInputSize(sizeRaw[1], fallback[1]);
    return [h, w];
  }
  return [fallback[0], fallback[1]];
}

function normalizeSchema(schemaRaw, fallbackInputSize = DEFAULT_INPUT_SIZE) {
  const payload = schemaRaw && typeof schemaRaw === 'object' ? schemaRaw : {};
  const inputRaw = payload.input && typeof payload.input === 'object' ? payload.input : {};
  const outputRaw = payload.output && typeof payload.output === 'object' ? payload.output : {};

  const classes = Array.isArray(outputRaw.classes) && outputRaw.classes.length
    ? outputRaw.classes.map((token) => String(token || '').trim()).filter(Boolean)
    : [...DEFAULT_SKINMASK_CLASSES];
  const skinClass = String(outputRaw.skin_class || 'skin').trim() || 'skin';
  let skinClassId = classes.indexOf(skinClass);
  if (skinClassId < 0) skinClassId = DEFAULT_SKIN_CLASS_ID;
  const [inputH, inputW] = normalizeSchemaSize(
    inputRaw.size,
    [normalizeInputSize(fallbackInputSize, DEFAULT_INPUT_SIZE), normalizeInputSize(fallbackInputSize, DEFAULT_INPUT_SIZE)],
  );

  const mean = Array.isArray(inputRaw.mean) && inputRaw.mean.length >= 3
    ? inputRaw.mean.slice(0, 3).map((value, idx) => {
      const fallback = DEFAULT_SKINMASK_SCHEMA.input.mean[idx];
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    })
    : [...DEFAULT_SKINMASK_SCHEMA.input.mean];
  const std = Array.isArray(inputRaw.std) && inputRaw.std.length >= 3
    ? inputRaw.std.slice(0, 3).map((value, idx) => {
      const fallback = DEFAULT_SKINMASK_SCHEMA.input.std[idx];
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    })
    : [...DEFAULT_SKINMASK_SCHEMA.input.std];

  const rangeToken = String(inputRaw.range || DEFAULT_SKINMASK_SCHEMA.input.range).trim();
  const colorSpace = String(inputRaw.color_space || DEFAULT_SKINMASK_SCHEMA.input.color_space).trim().toUpperCase();
  const outputType = String(outputRaw.type || DEFAULT_SKINMASK_SCHEMA.output.type).trim().toLowerCase() === 'sigmoid'
    ? 'sigmoid'
    : 'softmax';

  return {
    schema_version: String(payload.schema_version || DEFAULT_SKINMASK_SCHEMA.schema_version),
    input: {
      color_space: colorSpace === 'BGR' ? 'BGR' : 'RGB',
      range: rangeToken === '0-255' ? '0-255' : '0-1',
      mean,
      std,
      size: [inputH, inputW],
      layout: 'NCHW',
    },
    output: {
      type: outputType,
      classes,
      skin_class: skinClass,
      skin_class_id: Math.max(0, Math.min(classes.length - 1, Math.trunc(Number(skinClassId) || 0))),
    },
  };
}

function resolveSchemaPath(modelPathInput) {
  const explicit = String(process.env.DIAG_SKINMASK_SCHEMA_PATH || '').trim();
  if (explicit) return path.resolve(explicit);
  const modelPath = path.resolve(String(modelPathInput || '').trim());
  if (!modelPath) return null;
  if (modelPath.toLowerCase().endsWith('.onnx')) {
    return modelPath.replace(/\.onnx$/i, '.schema.json');
  }
  return `${modelPath}.schema.json`;
}

function loadSkinmaskSchema(modelPathInput, fallbackInputSize = DEFAULT_INPUT_SIZE) {
  const modelPath = path.resolve(String(modelPathInput || '').trim());
  const cacheKey = `${modelPath}::${normalizeInputSize(fallbackInputSize, DEFAULT_INPUT_SIZE)}`;
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey);

  const schemaPath = resolveSchemaPath(modelPath);
  let rawSchema = null;
  let loaded = false;
  let loadError = null;
  if (schemaPath && fs.existsSync(schemaPath) && fs.statSync(schemaPath).isFile()) {
    try {
      rawSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      loaded = true;
    } catch (error) {
      loadError = String(error && error.message ? error.message : error);
    }
  }
  const schema = normalizeSchema(rawSchema, fallbackInputSize);
  const resolved = {
    ...schema,
    schema_path: schemaPath,
    schema_loaded: loaded,
    schema_load_error: loadError,
  };
  schemaCache.set(cacheKey, resolved);
  return resolved;
}

function logitsToSkinHeatmap(logitsTensor, schema, thresholdValue) {
  const tensor = logitsTensor && typeof logitsTensor === 'object' ? logitsTensor : null;
  if (!tensor || !Array.isArray(tensor.dims) || !tensor.data) return null;
  const dims = tensor.dims.map((value) => Number(value));
  if (dims.length !== 4) return null;
  const data = tensor.data;
  if (!data || typeof data.length !== 'number') return null;

  let channelsFirst = true;
  let channels = 0;
  let h = 0;
  let w = 0;
  if (dims[1] >= 1 && dims[1] <= 64) {
    channels = dims[1];
    h = dims[2];
    w = dims[3];
    channelsFirst = true;
  } else if (dims[3] >= 1 && dims[3] <= 64) {
    channels = dims[3];
    h = dims[1];
    w = dims[2];
    channelsFirst = false;
  } else {
    return null;
  }
  if (!channels || !h || !w) return null;
  const out = new Float32Array(h * w);
  const outputType = schema && schema.output && schema.output.type === 'sigmoid' ? 'sigmoid' : 'softmax';
  const safeSkinClassId = Math.max(
    0,
    Math.min(channels - 1, Math.trunc(Number(schema && schema.output ? schema.output.skin_class_id : DEFAULT_SKIN_CLASS_ID) || 0)),
  );
  const scoreThreshold = Math.max(0.05, Math.min(0.95, Number(thresholdValue || DEFAULT_THRESHOLD)));
  const sigmoid = (v) => 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, v))));
  let skinProbSum = 0;
  const pixelCount = Math.max(1, h * w);

  if (channelsFirst) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const pixelBase = y * w + x;
        if (outputType === 'sigmoid') {
          const raw = Number(data[safeSkinClassId * h * w + pixelBase] || 0);
          const probability = sigmoid(raw);
          out[pixelBase] = probability;
          skinProbSum += probability;
          continue;
        }
        let maxLogit = Number.NEGATIVE_INFINITY;
        let maxClass = 0;
        let skinLogit = Number(data[safeSkinClassId * h * w + pixelBase] || 0);
        for (let c = 0; c < channels; c += 1) {
          const value = Number(data[c * h * w + pixelBase] || 0);
          if (value > maxLogit) {
            maxLogit = value;
            maxClass = c;
          }
        }
        let expSum = 0;
        for (let c = 0; c < channels; c += 1) {
          const value = Number(data[c * h * w + pixelBase] || 0);
          expSum += Math.exp(Math.max(-40, Math.min(40, value - maxLogit)));
        }
        const skinExp = Math.exp(Math.max(-40, Math.min(40, skinLogit - maxLogit)));
        const skinProb = expSum > 0 ? skinExp / expSum : 0;
        skinProbSum += skinProb;
        out[pixelBase] = maxClass === safeSkinClassId ? 1 : 0;
      }
    }
  } else {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const pixelBase = y * w + x;
        if (outputType === 'sigmoid') {
          const raw = Number(data[pixelBase * channels + safeSkinClassId] || 0);
          const probability = sigmoid(raw);
          out[pixelBase] = probability;
          skinProbSum += probability;
          continue;
        }
        let maxLogit = Number.NEGATIVE_INFINITY;
        let maxClass = 0;
        let skinLogit = Number(data[pixelBase * channels + safeSkinClassId] || 0);
        for (let c = 0; c < channels; c += 1) {
          const value = Number(data[pixelBase * channels + c] || 0);
          if (value > maxLogit) {
            maxLogit = value;
            maxClass = c;
          }
        }
        let expSum = 0;
        for (let c = 0; c < channels; c += 1) {
          const value = Number(data[pixelBase * channels + c] || 0);
          expSum += Math.exp(Math.max(-40, Math.min(40, value - maxLogit)));
        }
        const skinExp = Math.exp(Math.max(-40, Math.min(40, skinLogit - maxLogit)));
        const skinProb = expSum > 0 ? skinExp / expSum : 0;
        skinProbSum += skinProb;
        out[pixelBase] = maxClass === safeSkinClassId ? 1 : 0;
      }
    }
  }

  return {
    heatmap: out,
    width: w,
    height: h,
    threshold: scoreThreshold,
    skin_prob_mean: skinProbSum / pixelCount,
  };
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
  allowPriorFallback = true,
  includeDebugStats = false,
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
  const schema = loadSkinmaskSchema(modelPathToken, normalizeInputSize(inputSize, DEFAULT_INPUT_SIZE));
  const schemaInput = schema && schema.input && typeof schema.input === 'object' ? schema.input : DEFAULT_SKINMASK_SCHEMA.input;
  const schemaOutput = schema && schema.output && typeof schema.output === 'object' ? schema.output : DEFAULT_SKINMASK_SCHEMA.output;
  const targetInputH = normalizeInputSize(inputSize, Number(Array.isArray(schemaInput.size) ? schemaInput.size[0] : DEFAULT_INPUT_SIZE));
  const targetInputW = normalizeInputSize(inputSize, Number(Array.isArray(schemaInput.size) ? schemaInput.size[1] : DEFAULT_INPUT_SIZE));
  const scoreThreshold = Math.max(0.05, Math.min(0.95, Number(threshold || DEFAULT_THRESHOLD)));
  const explicitSkinClassId = Number.isFinite(Number(skinClassId))
    ? Math.max(0, Math.trunc(Number(skinClassId)))
    : null;
  const targetSkinClassId = explicitSkinClassId == null
    ? Math.max(0, Math.trunc(Number(schemaOutput.skin_class_id || DEFAULT_SKIN_CLASS_ID)))
    : explicitSkinClassId;
  const inputColorSpace = String(schemaInput.color_space || 'RGB').toUpperCase() === 'BGR' ? 'BGR' : 'RGB';
  const inputRange = String(schemaInput.range || '0-1') === '0-255' ? '0-255' : '0-1';
  const inputMean = Array.isArray(schemaInput.mean) && schemaInput.mean.length >= 3
    ? schemaInput.mean.slice(0, 3).map((value, idx) => {
      const n = Number(value);
      const fallback = DEFAULT_SKINMASK_SCHEMA.input.mean[idx];
      return Number.isFinite(n) ? n : fallback;
    })
    : [...DEFAULT_SKINMASK_SCHEMA.input.mean];
  const inputStd = Array.isArray(schemaInput.std) && schemaInput.std.length >= 3
    ? schemaInput.std.slice(0, 3).map((value, idx) => {
      const n = Number(value);
      const fallback = DEFAULT_SKINMASK_SCHEMA.input.std[idx];
      return Number.isFinite(n) && n > 0 ? n : fallback;
    })
    : [...DEFAULT_SKINMASK_SCHEMA.input.std];

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
      .resize(targetInputW, targetInputH, { fit: 'fill' })
      .raw()
      .toBuffer();
  } catch (error) {
    return { ok: false, reason: 'face_crop_failed', detail: String(error && error.message ? error.message : error) };
  }
  if (!cropRaw || cropRaw.length !== targetInputW * targetInputH * 3) {
    return { ok: false, reason: 'face_crop_invalid' };
  }

  const chw = new Float32Array(3 * targetInputW * targetInputH);
  const size = targetInputW * targetInputH;
  const rangeDivider = inputRange === '0-1' ? 255 : 1;
  for (let i = 0; i < size; i += 1) {
    const o = i * 3;
    const rgb = [
      cropRaw[o] / rangeDivider,
      cropRaw[o + 1] / rangeDivider,
      cropRaw[o + 2] / rangeDivider,
    ];
    const source = inputColorSpace === 'BGR' ? [rgb[2], rgb[1], rgb[0]] : rgb;
    chw[i] = (source[0] - inputMean[0]) / inputStd[0];
    chw[size + i] = (source[1] - inputMean[1]) / inputStd[1];
    chw[size * 2 + i] = (source[2] - inputMean[2]) / inputStd[2];
  }
  const inputTensorStats = includeDebugStats ? summarizeChwStats(chw, targetInputW, targetInputH) : null;

  const inputName = Array.isArray(session.inputNames) && session.inputNames[0] ? session.inputNames[0] : 'pixel_values';
  const outputName = Array.isArray(session.outputNames) && session.outputNames[0] ? session.outputNames[0] : null;
  const inputTensor = new ort.Tensor('float32', chw, [1, 3, targetInputH, targetInputW]);

  let results;
  try {
    results = await session.run({ [inputName]: inputTensor });
  } catch (error) {
    return { ok: false, reason: 'inference_failed', detail: String(error && error.message ? error.message : error) };
  }
  const logitsTensor = outputName ? results[outputName] : Object.values(results || {})[0];
  const logitsMask = logitsToSkinHeatmap(logitsTensor, {
    output: {
      ...schemaOutput,
      skin_class_id: targetSkinClassId,
    },
  }, scoreThreshold);
  if (!logitsMask || !logitsMask.heatmap) {
    return { ok: false, reason: 'logits_parse_failed' };
  }

  let skinMask = resizeHeatmapToMask(
    Array.from(logitsMask.heatmap),
    logitsMask.width,
    logitsMask.height,
    targetGrid,
    targetGrid,
    logitsMask.threshold,
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
  if (allowPriorFallback && !countOnes(skinMask) && priorMask) {
    if (countOnes(priorMask)) skinMask = priorMask;
  } else if (allowPriorFallback && priorMask && countOnes(priorMask)) {
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
  if (allowPriorFallback && !countOnes(skinMask) && priorMask) {
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
    schema_path: schema.schema_path || null,
    schema_loaded: Boolean(schema.schema_loaded),
    schema_version: schema.schema_version || null,
    skin_class_id: targetSkinClassId,
    input_size: [targetInputH, targetInputW],
    output_type: String(schemaOutput.type || 'softmax'),
    mask_grid: targetGrid,
    mask_rle_norm: encodeRleBinary(skinMask),
    positive_pixels: positivePixels,
    positive_ratio: positivePixels / (targetGrid * targetGrid),
    skin_prob_mean: Number.isFinite(Number(logitsMask.skin_prob_mean)) ? Number(logitsMask.skin_prob_mean) : null,
    bbox: maskBoundingNorm(skinMask, targetGrid),
    ...(includeDebugStats
      ? {
          input_tensor_stats: inputTensorStats,
          face_crop_px: { ...faceBox },
        }
      : {}),
  };
}

module.exports = {
  inferSkinMaskOnFaceCrop,
  loadSkinmaskSchema,
};
