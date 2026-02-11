#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Blob } from 'node:buffer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const { getAdapter, listAdapters, normalizeDatasetName } = require('../src/auroraBff/evalAdapters/index');
const {
  normalizeCacheDirs,
  readJson,
  toPosix,
  writeJsonl,
  writeText,
} = require('../src/auroraBff/evalAdapters/common/datasetUtils');
const {
  MODULE_BOXES,
  createMask,
  bboxNormToMask,
  polygonNormToMask,
  resizeHeatmapToMask,
  orMaskInto,
  iouScore,
  coverageScore,
  leakageScore,
  countOnes,
  decodeRleBinary,
  moduleMaskFromBox,
} = require('../src/auroraBff/evalAdapters/common/metrics');
const {
  validateModuleBoxes,
} = require('../src/auroraBff/evalAdapters/common/circlePriorModel');
const {
  PRED_MODULES_MISSING_REASON_DETAILS,
  normalizePredModulesMissingReasonDetail,
  ensureModulesForPayload,
  inferPredModulesMissingReasonDetail,
  safeApplyCalibration,
} = require('./eval_circle_local_fallback.cjs');
const {
  faceCropFromSkinBBoxNorm,
  deriveGtModulesFromSkinMask,
  saveDerivedGt,
} = require('../src/auroraBff/evalAdapters/common/gtDerivation');
const { runSkinDiagnosisV1, buildSkinAnalysisFromDiagnosisV1 } = require('../src/auroraBff/skinDiagnosisV1');
const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const { inferSkinMaskOnFaceCrop } = require('../src/auroraBff/skinmaskOnnx');

const DEFAULT_CACHE_DIR = path.join('datasets_cache', 'external');
const DEFAULT_DATASETS = ['lapa', 'celebamaskhq', 'fasseg'];
const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_GRID_SIZE = 128;
const MODULE_MASK_GRID_SIZE = 64;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MARKET = 'EU';
const DEFAULT_LANG = 'en';
const DEFAULT_CIRCLE_MODEL_PATH = path.join('model_registry', 'circle_prior_latest.json');
const DEFAULT_CIRCLE_MODEL_MIN_PIXELS = Number(process.env.CIRCLE_MODEL_MIN_PIXELS || 24);
const DEFAULT_SKINMASK_ENABLED = String(process.env.DIAG_SKINMASK_ENABLED || '').trim().toLowerCase() === 'true';
const DEFAULT_SKINMASK_MODEL_PATH = process.env.DIAG_SKINMASK_MODEL_PATH || path.join('artifacts', 'skinmask_v1.onnx');

const DEFAULT_MIN_MIOU = Number(process.env.EVAL_MIN_MIOU || 0.65);
const DEFAULT_MAX_FAIL_RATE = Number(process.env.EVAL_MAX_FAIL_RATE || 0.05);
const DEFAULT_MAX_LEAKAGE = Number(process.env.EVAL_MAX_LEAKAGE || 0.1);
const DEFAULT_MAX_SKIN_ROI_TOO_SMALL = Number(process.env.EVAL_MAX_SKIN_ROI_TOO_SMALL || 0.2);
const DEFAULT_SKIN_ROI_MIN_PIXELS = Number(process.env.EVAL_SKIN_ROI_MIN_PIXELS || process.env.DIAG_SKINMASK_MIN_PIXELS || 8);

const FAIL_REASONS = Object.freeze({
  NO_INDEX: 'NO_INDEX',
  IMAGE_READ_FAIL: 'IMAGE_READ_FAIL',
  FACE_DETECT_FAIL: 'FACE_DETECT_FAIL',
  LANDMARK_FAIL: 'LANDMARK_FAIL',
  PRED_MODULES_MISSING: 'PRED_MODULES_MISSING',
  GT_MISSING: 'GT_MISSING',
  GT_SKIN_EMPTY: 'GT_SKIN_EMPTY',
  PRED_SKIN_EMPTY: 'PRED_SKIN_EMPTY',
  MODULES_EMPTY: 'MODULES_EMPTY',
  METRIC_SKIP: 'METRIC_SKIP',
  UNKNOWN: 'UNKNOWN',
});

function nowRunKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}_${hh}${mm}${ss}`;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}

function defaultGtStats() {
  return {
    has_gt: false,
    skin_pixels: 0,
    label_values_sample: [],
    gt_kind: 'none',
  };
}

function defaultPredStats() {
  return {
    has_pred_modules: false,
    module_count: 0,
    pred_skin_pixels_est: 0,
  };
}

function defaultMetricStats() {
  return {
    modules_scored: 0,
    miou_mean: 0,
    coverage_mean: 0,
    leakage_mean: 0,
  };
}

function createBaseEvalRow({ dataset, sampleHash, sampleId }) {
  return {
    ok: false,
    dataset: String(dataset || 'unknown'),
    sample_hash: String(sampleHash || ''),
    sample_id: String(sampleId || ''),
    fail_reason: FAIL_REASONS.UNKNOWN,
    reason_detail: null,
    gt_stats: defaultGtStats(),
    pred_stats: defaultPredStats(),
    metric_stats: defaultMetricStats(),
    degraded_reason: null,
    weak_label_only: false,
    note: null,
  };
}

function normalizeFailReason(input) {
  const token = String(input || '').trim().toUpperCase();
  const known = Object.values(FAIL_REASONS);
  return known.includes(token) ? token : FAIL_REASONS.UNKNOWN;
}

function finalizeEvalRow(inputRow) {
  const row = inputRow && typeof inputRow === 'object' ? { ...inputRow } : createBaseEvalRow({});
  const gtStats = row.gt_stats && typeof row.gt_stats === 'object' ? row.gt_stats : defaultGtStats();
  const predStats = row.pred_stats && typeof row.pred_stats === 'object' ? row.pred_stats : defaultPredStats();
  const metricStats = row.metric_stats && typeof row.metric_stats === 'object' ? row.metric_stats : defaultMetricStats();

  const modulesScored = Number(metricStats.modules_scored || 0);
  metricStats.modules_scored = Number.isFinite(modulesScored) ? Math.max(0, Math.trunc(modulesScored)) : 0;
  metricStats.miou_mean = round3(metricStats.miou_mean || 0);
  metricStats.coverage_mean = round3(metricStats.coverage_mean || 0);
  metricStats.leakage_mean = round3(metricStats.leakage_mean || 0);
  gtStats.skin_pixels = Number.isFinite(Number(gtStats.skin_pixels)) ? Math.max(0, Number(gtStats.skin_pixels)) : 0;
  predStats.module_count = Number.isFinite(Number(predStats.module_count)) ? Math.max(0, Number(predStats.module_count)) : 0;
  predStats.pred_skin_pixels_est = Number.isFinite(Number(predStats.pred_skin_pixels_est))
    ? Math.max(0, Number(predStats.pred_skin_pixels_est))
    : 0;

  row.gt_stats = gtStats;
  row.pred_stats = predStats;
  row.metric_stats = metricStats;

  if (metricStats.modules_scored > 0) {
    row.ok = true;
    row.fail_reason = null;
    row.reason_detail = null;
    return row;
  }

  row.ok = false;
  const currentReason = normalizeFailReason(row.fail_reason);
  if (currentReason !== FAIL_REASONS.UNKNOWN) {
    row.fail_reason = currentReason;
    row.reason_detail =
      currentReason === FAIL_REASONS.PRED_MODULES_MISSING
        ? normalizePredModulesMissingReasonDetail(row.reason_detail || row.degraded_reason)
        : null;
    return row;
  }
  if (!predStats.has_pred_modules || predStats.module_count <= 0) {
    row.fail_reason = FAIL_REASONS.PRED_MODULES_MISSING;
    row.reason_detail = normalizePredModulesMissingReasonDetail(row.reason_detail || row.degraded_reason);
    return row;
  }
  if (!gtStats.has_gt) {
    row.fail_reason = FAIL_REASONS.GT_MISSING;
    row.reason_detail = null;
    return row;
  }
  if (gtStats.skin_pixels <= 0) {
    row.fail_reason = FAIL_REASONS.GT_SKIN_EMPTY;
    row.reason_detail = null;
    return row;
  }
  if (predStats.pred_skin_pixels_est <= 0) {
    row.fail_reason = FAIL_REASONS.PRED_SKIN_EMPTY;
    row.reason_detail = null;
    return row;
  }
  row.fail_reason = FAIL_REASONS.MODULES_EMPTY;
  row.reason_detail = null;
  return row;
}

function mapPredictionFailureReason(rawReason) {
  const token = String(rawReason || '').toLowerCase();
  if (!token) return FAIL_REASONS.UNKNOWN;
  if (token.includes('dataset_index_missing') || token.includes('dataset_root_not_found')) return FAIL_REASONS.NO_INDEX;
  if (token.includes('face')) return FAIL_REASONS.FACE_DETECT_FAIL;
  if (token.includes('landmark')) return FAIL_REASONS.LANDMARK_FAIL;
  if (token.includes('photo_modules') || token.includes('modules_missing')) return FAIL_REASONS.PRED_MODULES_MISSING;
  return FAIL_REASONS.UNKNOWN;
}

function topFailReasons(rows) {
  const counts = new Map();
  const total = Array.isArray(rows) ? rows.length : 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.ok) continue;
    const reason = normalizeFailReason(row.fail_reason);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const out = Array.from(counts.entries()).map(([reason, count]) => ({
    reason,
    count,
    pct: total > 0 ? round3(count / total) : 0,
  }));
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.reason.localeCompare(b.reason);
  });
  return out;
}

function predModulesMissingBreakdown(rows) {
  const counts = new Map();
  const allRows = Array.isArray(rows) ? rows : [];
  const missingRows = allRows.filter((row) => row && !row.ok && normalizeFailReason(row.fail_reason) === FAIL_REASONS.PRED_MODULES_MISSING);
  const totalMissing = missingRows.length;
  for (const row of missingRows) {
    const detail = normalizePredModulesMissingReasonDetail(row.reason_detail || row.degraded_reason);
    counts.set(detail, (counts.get(detail) || 0) + 1);
  }
  const out = Array.from(counts.entries()).map(([reasonDetail, count]) => ({
    reason_detail: reasonDetail,
    count,
    pct_of_missing: totalMissing > 0 ? round3(count / totalMissing) : 0,
  }));
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.reason_detail.localeCompare(b.reason_detail);
  });
  return {
    total_missing: totalMissing,
    rows: out,
  };
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseArgs(argv) {
  const out = {
    base_url: process.env.BASE_URL || process.env.BASE || '',
    cache_dir: process.env.CACHE_DIR || DEFAULT_CACHE_DIR,
    datasets: process.env.DATASETS || DEFAULT_DATASETS.join(','),
    limit: parseNumber(process.env.LIMIT, 0, 0, 200000),
    shuffle: parseBoolean(process.env.SHUFFLE, false),
    concurrency: parseNumber(process.env.CONCURRENCY, DEFAULT_CONCURRENCY, 1, 16),
    timeout_ms: parseNumber(process.env.TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 120000),
    market: String(process.env.MARKET || DEFAULT_MARKET),
    lang: String(process.env.LANG || DEFAULT_LANG),
    emit_debug_overlays: parseBoolean(process.env.EMIT_DEBUG_OVERLAYS, false),
    token: String(process.env.TOKEN || process.env.API_TOKEN || ''),
    report_dir: process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    grid_size: parseNumber(process.env.GT_GRID_SIZE, DEFAULT_GRID_SIZE, 64, 512),
    eval_min_miou: parseNumber(process.env.EVAL_MIN_MIOU, DEFAULT_MIN_MIOU, 0, 1),
    eval_max_fail_rate: parseNumber(process.env.EVAL_MAX_FAIL_RATE, DEFAULT_MAX_FAIL_RATE, 0, 1),
    eval_max_leakage: parseNumber(process.env.EVAL_MAX_LEAKAGE, DEFAULT_MAX_LEAKAGE, 0, 1),
    eval_max_skin_roi_too_small: parseNumber(process.env.EVAL_MAX_SKIN_ROI_TOO_SMALL, DEFAULT_MAX_SKIN_ROI_TOO_SMALL, 0, 1),
    skin_roi_min_pixels: parseNumber(process.env.EVAL_SKIN_ROI_MIN_PIXELS, DEFAULT_SKIN_ROI_MIN_PIXELS, 1, 4096),
    circle_model_path: process.env.CIRCLE_MODEL_PATH || DEFAULT_CIRCLE_MODEL_PATH,
    circle_model_calibration: parseBoolean(process.env.CIRCLE_MODEL_CALIBRATION, true),
    circle_model_min_pixels: parseNumber(process.env.CIRCLE_MODEL_MIN_PIXELS, DEFAULT_CIRCLE_MODEL_MIN_PIXELS, 1, 1024),
    skinmask_enabled: parseBoolean(process.env.DIAG_SKINMASK_ENABLED, DEFAULT_SKINMASK_ENABLED),
    skinmask_model_path: process.env.DIAG_SKINMASK_MODEL_PATH || DEFAULT_SKINMASK_MODEL_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--base_url' && next) {
      out.base_url = next;
      i += 1;
      continue;
    }
    if (token === '--cache_dir' && next) {
      out.cache_dir = next;
      i += 1;
      continue;
    }
    if (token === '--datasets' && next) {
      out.datasets = next;
      i += 1;
      continue;
    }
    if (token === '--limit' && next) {
      out.limit = parseNumber(next, out.limit, 0, 200000);
      i += 1;
      continue;
    }
    if (token === '--shuffle') {
      out.shuffle = true;
      continue;
    }
    if (token === '--concurrency' && next) {
      out.concurrency = parseNumber(next, out.concurrency, 1, 16);
      i += 1;
      continue;
    }
    if (token === '--timeout_ms' && next) {
      out.timeout_ms = parseNumber(next, out.timeout_ms, 1000, 120000);
      i += 1;
      continue;
    }
    if (token === '--market' && next) {
      out.market = String(next);
      i += 1;
      continue;
    }
    if (token === '--lang' && next) {
      out.lang = String(next);
      i += 1;
      continue;
    }
    if (token === '--emit_debug_overlays') {
      out.emit_debug_overlays = true;
      continue;
    }
    if (token === '--token' && next) {
      out.token = String(next);
      i += 1;
      continue;
    }
    if (token === '--report_dir' && next) {
      out.report_dir = String(next);
      i += 1;
      continue;
    }
    if (token === '--grid_size' && next) {
      out.grid_size = parseNumber(next, out.grid_size, 64, 512);
      i += 1;
      continue;
    }
    if (token === '--circle_model_path' && next) {
      out.circle_model_path = String(next);
      i += 1;
      continue;
    }
    if (token === '--circle_model_min_pixels' && next) {
      out.circle_model_min_pixels = parseNumber(next, out.circle_model_min_pixels, 1, 1024);
      i += 1;
      continue;
    }
    if (token === '--disable_circle_model_calibration') {
      out.circle_model_calibration = false;
      continue;
    }
    if (token === '--skinmask_enabled') {
      out.skinmask_enabled = true;
      continue;
    }
    if (token === '--disable_skinmask') {
      out.skinmask_enabled = false;
      continue;
    }
    if (token === '--skinmask_model_path' && next) {
      out.skinmask_model_path = String(next);
      i += 1;
      continue;
    }
    if (token === '--eval_max_skin_roi_too_small' && next) {
      out.eval_max_skin_roi_too_small = parseNumber(next, out.eval_max_skin_roi_too_small, 0, 1);
      i += 1;
      continue;
    }
    if (token === '--skin_roi_min_pixels' && next) {
      out.skin_roi_min_pixels = parseNumber(next, out.skin_roi_min_pixels, 1, 4096);
      i += 1;
      continue;
    }
  }

  out.base_url = String(out.base_url || '').replace(/\/+$/, '');
  out.datasets = parseDatasets(out.datasets);
  out.concurrency = Math.max(1, Math.trunc(out.concurrency));
  out.limit = Math.max(0, Math.trunc(out.limit));
  out.timeout_ms = Math.max(1000, Math.trunc(out.timeout_ms));
  out.grid_size = Math.max(64, Math.trunc(out.grid_size));
  out.lang = String(out.lang || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  out.market = String(out.market || 'EU').toUpperCase();
  out.circle_model_min_pixels = Math.max(1, Math.trunc(out.circle_model_min_pixels));
  const circleModelToken = String(out.circle_model_path || '').trim();
  out.circle_model_path = ['none', 'off', 'false'].includes(circleModelToken.toLowerCase()) ? '' : circleModelToken;
  out.skinmask_enabled = Boolean(out.skinmask_enabled);
  const skinmaskModelToken = String(out.skinmask_model_path || '').trim();
  out.skinmask_model_path = ['none', 'off', 'false'].includes(skinmaskModelToken.toLowerCase()) ? '' : skinmaskModelToken;
  out.skin_roi_min_pixels = Math.max(1, Math.trunc(out.skin_roi_min_pixels));
  return out;
}

function parseDatasets(raw) {
  const tokens = String(raw || '')
    .split(',')
    .map((token) => normalizeDatasetName(token))
    .filter(Boolean);
  const deduped = [...new Set(tokens)];
  if (!deduped.length) return [...DEFAULT_DATASETS];
  const unsupported = deduped.filter((name) => !listAdapters().includes(name));
  if (unsupported.length) {
    throw new Error(`unsupported_datasets:${unsupported.join(',')}`);
  }
  return deduped;
}

function hashId(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex').slice(0, 20);
}

async function normalizeImageForPrediction(imageBuffer) {
  try {
    return await sharp(imageBuffer, { failOn: 'none' })
      .rotate()
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch {
    return imageBuffer;
  }
}

function mean(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
  return sum / values.length;
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function sanitizeJsonText(text) {
  const filtered = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 32 || code === 9 || code === 10 || code === 13) filtered.push(text[i]);
  }
  return filtered.join('');
}

function parseLooseJson(text) {
  const raw = String(text || '');
  try {
    return JSON.parse(raw);
  } catch {
    const sanitized = sanitizeJsonText(raw);
    try {
      return JSON.parse(sanitized);
    } catch {
      const start = sanitized.indexOf('{');
      const end = sanitized.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(sanitized.slice(start, end + 1));
      }
      throw new Error('invalid_json_response');
    }
  }
}

function moduleIds(activeModuleBoxes) {
  const source = activeModuleBoxes && typeof activeModuleBoxes === 'object' ? activeModuleBoxes : MODULE_BOXES;
  return Object.keys(source);
}

function validateBBox(box) {
  if (!box || typeof box !== 'object') return false;
  const x = Number(box.x);
  const y = Number(box.y);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite)) return false;
  if (x < 0 || y < 0 || w < 0 || h < 0) return false;
  if (x + w > 1.001 || y + h > 1.001) return false;
  return true;
}

function validatePolygon(poly) {
  if (!poly || typeof poly !== 'object' || !Array.isArray(poly.points) || poly.points.length < 3) return false;
  return poly.points.every((point) => {
    const x = Number(point && point.x);
    const y = Number(point && point.y);
    return Number.isFinite(x) && Number.isFinite(y) && x >= -0.001 && x <= 1.001 && y >= -0.001 && y <= 1.001;
  });
}

function validateHeatmap(heatmap) {
  if (!heatmap || typeof heatmap !== 'object') return false;
  const grid = heatmap.grid && typeof heatmap.grid === 'object' ? heatmap.grid : {};
  const w = Number(grid.w);
  const h = Number(grid.h);
  const values = Array.isArray(heatmap.values) ? heatmap.values : [];
  if (w !== 64 || h !== 64 || values.length !== 4096) return false;
  return values.every((value) => Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1);
}

function regionMaskFromRegion(region, gridSize) {
  const mask = createMask(gridSize, gridSize, 0);
  if (!region || typeof region !== 'object') return { mask, legal: false };

  let legal = true;
  if (region.coord_space !== 'face_crop_norm_v1') legal = false;

  if (region.bbox) {
    legal = validateBBox(region.bbox) && legal;
    const bboxMask = bboxNormToMask(region.bbox, gridSize, gridSize);
    orMaskInto(mask, bboxMask);
  }
  if (region.polygon) {
    legal = validatePolygon(region.polygon) && legal;
    const polygonMask = polygonNormToMask(region.polygon, gridSize, gridSize);
    orMaskInto(mask, polygonMask);
  }
  if (region.heatmap) {
    legal = validateHeatmap(region.heatmap) && legal;
    const grid = region.heatmap.grid || {};
    const intensity = clamp01(region.style && Number(region.style.intensity));
    const heatMask = resizeHeatmapToMask(
      region.heatmap.values || [],
      Number(grid.w || 64),
      Number(grid.h || 64),
      gridSize,
      gridSize,
      0.35,
      intensity || 1,
    );
    orMaskInto(mask, heatMask);
  }

  return { mask, legal };
}

function moduleMasksFromCardPayload(payload, gridSize, activeModuleBoxes) {
  const regions = Array.isArray(payload && payload.regions) ? payload.regions : [];
  const modules = Array.isArray(payload && payload.modules) ? payload.modules : [];
  const regionMap = new Map();
  let invalidRegionCount = 0;
  for (const region of regions) {
    const regionId = String(region && region.region_id ? region.region_id : '').trim();
    if (!regionId) continue;
    const built = regionMaskFromRegion(region, gridSize);
    if (!built.legal) invalidRegionCount += 1;
    regionMap.set(regionId, built.mask);
  }

  const moduleMasks = {};
  const allModuleIds = moduleIds(activeModuleBoxes);
  for (const moduleId of allModuleIds) {
    moduleMasks[moduleId] = createMask(gridSize, gridSize, 0);
  }

  for (const moduleRow of modules) {
    const moduleId = String(moduleRow && moduleRow.module_id ? moduleRow.module_id : '').trim();
    if (!moduleId || !moduleMasks[moduleId]) continue;
    const target = moduleMasks[moduleId];
    const rle = typeof moduleRow.mask_rle_norm === 'string' ? moduleRow.mask_rle_norm.trim() : '';
    if (rle) {
      const sourceGrid = Math.max(16, Math.min(512, Math.trunc(Number(moduleRow.mask_grid || gridSize) || gridSize)));
      const decoded = decodeRleBinary(rle, sourceGrid * sourceGrid);
      if (sourceGrid === gridSize) {
        moduleMasks[moduleId] = decoded;
      } else {
        moduleMasks[moduleId] = resizeHeatmapToMask(Array.from(decoded), sourceGrid, sourceGrid, gridSize, gridSize, 0.5, 1);
      }
      continue;
    }
    const issueRows = Array.isArray(moduleRow && moduleRow.issues) ? moduleRow.issues : [];
    const evidenceIds = new Set();
    for (const issue of issueRows) {
      const ids = Array.isArray(issue && issue.evidence_region_ids) ? issue.evidence_region_ids : [];
      for (const evidenceId of ids) evidenceIds.add(String(evidenceId));
    }
    if (Array.isArray(moduleRow && moduleRow.evidence_region_ids)) {
      for (const evidenceId of moduleRow.evidence_region_ids) evidenceIds.add(String(evidenceId));
    }
    for (const evidenceId of evidenceIds) {
      const regionMask = regionMap.get(String(evidenceId));
      if (regionMask) orMaskInto(target, regionMask);
    }
    if (!countOnes(target) && moduleRow && moduleRow.box && validateBBox(moduleRow.box)) {
      orMaskInto(target, bboxNormToMask(moduleRow.box, gridSize, gridSize));
    }
    if (!countOnes(target)) {
      orMaskInto(target, moduleMaskFromBox(moduleId, gridSize, gridSize, activeModuleBoxes));
    }
  }

  return {
    moduleMasks,
    regionsCount: regions.length,
    invalidRegionCount,
  };
}

function decodeGtModuleMasks(derivedGt, gridSize, activeModuleBoxes) {
  const out = {};
  const moduleRows = Array.isArray(derivedGt && derivedGt.module_masks) ? derivedGt.module_masks : [];
  for (const moduleId of moduleIds(activeModuleBoxes)) {
    const row = moduleRows.find((item) => String(item && item.module_id) === moduleId);
    if (!row || typeof row.mask_rle_norm !== 'string') {
      out[moduleId] = moduleMaskFromBox(moduleId, gridSize, gridSize, activeModuleBoxes);
      continue;
    }
    out[moduleId] = decodeRleBinary(row.mask_rle_norm, gridSize * gridSize);
  }
  return out;
}

async function resolveCircleModelBoxes(modelPathInput) {
  const fallback = validateModuleBoxes(MODULE_BOXES);
  const modelPath = String(modelPathInput || '').trim();
  if (!modelPath) {
    return {
      moduleBoxes: fallback,
      meta: {
        enabled: false,
        path: '',
        reason: 'disabled',
      },
    };
  }
  const resolvedPath = path.resolve(modelPath);
  const stat = await fsp.stat(resolvedPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return {
      moduleBoxes: fallback,
      meta: {
        enabled: false,
        path: toPosix(path.relative(process.cwd(), resolvedPath)),
        reason: 'not_found',
      },
    };
  }
  let payload = null;
  try {
    payload = await readJson(resolvedPath);
  } catch (_error) {
    return {
      moduleBoxes: fallback,
      meta: {
        enabled: false,
        path: toPosix(path.relative(process.cwd(), resolvedPath)),
        reason: 'invalid_json',
      },
    };
  }
  const moduleBoxes = validateModuleBoxes(payload && payload.module_boxes);
  return {
    moduleBoxes,
    meta: {
      enabled: true,
      path: toPosix(path.relative(process.cwd(), resolvedPath)),
      schema_version: payload && payload.schema_version ? String(payload.schema_version) : '',
      generated_at: payload && payload.generated_at ? String(payload.generated_at) : '',
    },
  };
}

function skinMaskBoundingNorm(mask, width, height) {
  if (!(mask instanceof Uint8Array) || !width || !height) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return {
    x0: minX / width,
    y0: minY / height,
    x1: (maxX + 1) / width,
    y1: (maxY + 1) / height,
  };
}

function makeApiHeaders({ uid, lang, token } = {}) {
  const headers = {
    Accept: 'application/json',
    'X-Aurora-UID': uid,
    'X-Lang': String(lang || 'EN').toUpperCase().startsWith('ZH') ? 'CN' : 'EN',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-API-Key'] = token;
  }
  return headers;
}

async function callApiPrediction({
  baseUrl,
  imageBuffer,
  sampleToken,
  timeoutMs,
  market,
  lang,
  token,
}) {
  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), `sample_${sampleToken}.jpg`);
  form.append('use_photo', 'true');
  form.append('market', String(market || 'EU'));
  form.append('lang', String(lang || 'en'));
  form.append('source', 'datasets_eval');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/analysis/skin`, {
      method: 'POST',
      headers: makeApiHeaders({ uid: `eval_${sampleToken}`, lang, token }),
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    return {
      ok: false,
      reason: message.includes('aborted') ? 'api_timeout' : 'api_network_error',
      status: 0,
      payload: null,
    };
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  let parsed;
  try {
    parsed = parseLooseJson(rawText);
  } catch {
    return {
      ok: false,
      reason: 'api_invalid_json',
      status: response.status,
      payload: null,
    };
  }

  const cards = Array.isArray(parsed && parsed.cards) ? parsed.cards : [];
  const modulesCard = cards.find((card) => card && card.type === 'photo_modules_v1');
  const analysisCard = cards.find((card) => card && card.type === 'analysis_summary');
  if (!modulesCard || !modulesCard.payload || typeof modulesCard.payload !== 'object') {
    return {
      ok: false,
      reason: 'photo_modules_card_missing',
      status: response.status,
      payload: null,
      analysis: analysisCard && analysisCard.payload ? analysisCard.payload : null,
    };
  }

  return {
    ok: response.ok,
    reason: response.ok ? null : `api_status_${response.status}`,
    status: response.status,
    payload: modulesCard.payload,
    analysis: analysisCard && analysisCard.payload ? analysisCard.payload : null,
    skinmask_reason: null,
  };
}

function normalizeQualityGradeToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'pass' || token === 'degraded' || token === 'fail') return token;
  return 'unknown';
}

function fallbackFaceCropFromDiagnosisInternal(diagnosisInternal) {
  const internal = diagnosisInternal && typeof diagnosisInternal === 'object' ? diagnosisInternal : {};
  const existing = internal.face_crop && typeof internal.face_crop === 'object' ? internal.face_crop : null;
  if (existing && existing.bbox_px && typeof existing.bbox_px === 'object') return existing;
  const origW = Math.max(1, Math.trunc(Number(internal.orig_size_px && internal.orig_size_px.w) || 1));
  const origH = Math.max(1, Math.trunc(Number(internal.orig_size_px && internal.orig_size_px.h) || 1));
  return {
    coord_space: 'orig_px_v1',
    bbox_px: { x: 0, y: 0, w: origW, h: origH },
    orig_size_px: { w: origW, h: origH },
    render_size_px_hint: { w: Math.max(1, Math.min(origW, 512)), h: Math.max(1, Math.min(origH, 512)) },
  };
}

async function callLocalPrediction({ imageBuffer, sampleToken, lang, skinmaskEnabled, skinmaskModelPath }) {
  const diagnosis = await runSkinDiagnosisV1({
    imageBuffer,
    language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
    profileSummary: null,
    recentLogsSummary: null,
  });
  if (!diagnosis || !diagnosis.ok) {
    return {
      ok: false,
      reason: diagnosis && diagnosis.reason ? diagnosis.reason : 'local_diagnosis_failed',
      payload: null,
      quality: null,
      diagnosisInternal: diagnosis && diagnosis.internal ? diagnosis.internal : null,
      metrics: null,
      skinmask_reason: null,
      degraded_reason: null,
      reason_detail: null,
    };
  }

  const analysis = buildSkinAnalysisFromDiagnosisV1(diagnosis.diagnosis, {
    language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
    profileSummary: null,
  });

  let skinMask = null;
  let skinmaskReason = skinmaskEnabled ? 'model_path_missing' : 'disabled';
  if (skinmaskEnabled && skinmaskModelPath) {
    try {
      const inferred = await inferSkinMaskOnFaceCrop({
        imageBuffer,
        diagnosisInternal: diagnosis.internal || null,
        modelPath: skinmaskModelPath,
      });
      if (inferred && inferred.ok) {
        skinMask = inferred;
        skinmaskReason = 'ok';
      } else {
        skinmaskReason = inferred && inferred.reason ? inferred.reason : 'inference_failed';
      }
    } catch (_error) {
      skinmaskReason = 'inference_failed';
    }
  }

  const quality = diagnosis.diagnosis && diagnosis.diagnosis.quality ? diagnosis.diagnosis.quality : null;
  const qualityGrade = normalizeQualityGradeToken(quality && quality.grade);
  let built = null;
  let localReasonDetail = null;
  try {
    built = buildPhotoModulesCard({
      requestId: sampleToken,
      analysis,
      usedPhotos: true,
      photoQuality: quality,
      photoNotice: null,
      diagnosisInternal: diagnosis.internal || null,
      profileSummary: null,
      language: String(lang || 'en').toLowerCase().startsWith('zh') ? 'CN' : 'EN',
      ingredientRecEnabled: false,
      productRecEnabled: false,
      skinMask,
    });
  } catch (_error) {
    localReasonDetail = PRED_MODULES_MISSING_REASON_DETAILS.MODULEIZER_EXCEPTION;
  }

  const payloadFromBuilder =
    built && built.card && built.card.payload && typeof built.card.payload === 'object'
      ? built.card.payload
      : {
          used_photos: true,
          quality_grade: qualityGrade,
          face_crop: fallbackFaceCropFromDiagnosisInternal(diagnosis.internal || null),
          regions: [],
          modules: [],
        };

  if (!localReasonDetail && (qualityGrade === 'fail' || qualityGrade === 'unknown')) {
    localReasonDetail = PRED_MODULES_MISSING_REASON_DETAILS.QUALITY_GATED;
  }
  if (!localReasonDetail && (!Array.isArray(payloadFromBuilder.modules) || payloadFromBuilder.modules.length <= 0)) {
    localReasonDetail = PRED_MODULES_MISSING_REASON_DETAILS.MODULEIZER_EXCEPTION;
  }
  const ensured = ensureModulesForPayload(payloadFromBuilder, {
    gridSize: MODULE_MASK_GRID_SIZE,
    moduleBoxes: MODULE_BOXES,
    degradedReason: localReasonDetail,
  });

  return {
    ok: true,
    reason: null,
    payload: ensured.payload,
    quality,
    diagnosisInternal: diagnosis.internal || null,
    metrics: built && built.metrics ? built.metrics : null,
    skinmask_reason: skinmaskReason,
    degraded_reason: ensured.degradedReason || null,
    reason_detail: ensured.degradedReason || null,
  };
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runner() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        const item = items[index] || {};
        const fallbackHash = hashId(`${item && item.dataset ? item.dataset : 'unknown'}:${index}:worker_error`);
        results[index] = finalizeEvalRow({
          ...createBaseEvalRow({
            dataset: item && item.dataset ? item.dataset : 'unknown',
            sampleHash: fallbackHash,
            sampleId: item && item.sample && item.sample.sample_id ? item.sample.sample_id : `worker_error_${index}`,
          }),
          fail_reason: FAIL_REASONS.UNKNOWN,
          note: String(error && error.message ? error.message : error),
        });
      }
    }
  }
  const runners = [];
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  for (let i = 0; i < n; i += 1) runners.push(runner());
  await Promise.all(runners);
  return results;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function makeSummaryRows(sampleRows) {
  const buckets = new Map();
  for (const sample of sampleRows) {
    if (!sample || !sample.ok || !Array.isArray(sample.module_scores)) continue;
    for (const row of sample.module_scores) {
      const key = `${sample.dataset}::${row.module_id}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(row);
    }
  }
  const out = [];
  for (const [key, rows] of buckets.entries()) {
    const [dataset, moduleId] = key.split('::');
    const ious = rows.map((row) => Number(row.iou || 0));
    const coverages = rows.map((row) => Number(row.coverage || 0));
    const leakages = rows.map((row) => Number(row.leakage || 0));
    const tooSmall = rows.map((row) => (row && row.roi_too_small ? 1 : 0));
    out.push({
      dataset,
      module_id: moduleId,
      samples: rows.length,
      miou_mean: round3(mean(ious)),
      miou_p50: round3(percentile(ious, 0.5)),
      miou_p90: round3(percentile(ious, 0.9)),
      coverage_mean: round3(mean(coverages)),
      leakage_mean: round3(mean(leakages)),
      roi_too_small_rate: round3(mean(tooSmall)),
    });
  }
  out.sort((a, b) => {
    if (a.dataset !== b.dataset) return a.dataset.localeCompare(b.dataset);
    return a.module_id.localeCompare(b.module_id);
  });
  return out;
}

function makeCsv(rows) {
  const headers = [
    'dataset',
    'module_id',
    'samples',
    'miou_mean',
    'miou_p50',
    'miou_p90',
    'coverage_mean',
    'leakage_mean',
    'roi_too_small_rate',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function renderMarkdown({
  args,
  runKey,
  circleModelMeta,
  sampleRows,
  summaryRows,
  jsonlPath,
  csvPath,
  weakRows,
  failReasonRows,
  predMissingBreakdown,
  softWarnings,
}) {
  const total = sampleRows.length;
  const okRows = sampleRows.filter((row) => row && row.ok);
  const failedRows = sampleRows.filter((row) => !row || !row.ok);
  const faceDetectFails = okRows.filter((row) => row.face_detect_ok === false).length;
  const landmarkFails = okRows.filter((row) => row.landmark_ok === false).length;
  const leakageValues = [];
  const miouValues = [];
  const dropRates = [];
  let roiTooSmallCount = 0;
  let roiEvalCount = 0;
  for (const row of okRows) {
    if (Array.isArray(row.module_scores)) {
      for (const moduleScore of row.module_scores) {
        leakageValues.push(Number(moduleScore.leakage || 0));
        miouValues.push(Number(moduleScore.iou || 0));
      }
    }
    if (Number.isFinite(Number(row.skin_roi_too_small_count))) {
      roiTooSmallCount += Number(row.skin_roi_too_small_count);
    }
    if (Number.isFinite(Number(row.skin_roi_evaluated_count))) {
      roiEvalCount += Number(row.skin_roi_evaluated_count);
    }
    if (Number.isFinite(Number(row.geometry_sanitize_drop_rate))) {
      dropRates.push(Number(row.geometry_sanitize_drop_rate));
    }
  }
  const skinRoiTooSmallRate = roiEvalCount > 0 ? roiTooSmallCount / roiEvalCount : 0;

  const lines = [];
  lines.push('# Circle Accuracy Evaluation');
  lines.push('');
  lines.push(`- run_id: ${runKey}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- mode: ${args.base_url ? 'api' : 'local'}`);
  lines.push(`- datasets: ${args.datasets.join(', ')}`);
  lines.push(`- circle_model_enabled: ${circleModelMeta.enabled ? 'true' : 'false'}`);
  lines.push(`- circle_model_path: ${circleModelMeta.path || 'n/a'}`);
  lines.push(`- circle_model_calibration: ${args.circle_model_calibration ? 'true' : 'false'}`);
  lines.push(`- skinmask_enabled: ${args.skinmask_enabled ? 'true' : 'false'}`);
  lines.push(`- skinmask_model_path: ${args.skinmask_enabled ? (args.skinmask_model_path || 'missing') : 'n/a'}`);
  lines.push(`- samples_total: ${total}`);
  lines.push(`- samples_ok: ${okRows.length}`);
  lines.push(`- samples_failed: ${failedRows.length}`);
  lines.push(`- face_detect_fail_rate: ${round3(total ? faceDetectFails / total : 0)}`);
  lines.push(`- landmark_fail_rate: ${round3(total ? landmarkFails / total : 0)}`);
  lines.push(`- module_mIoU_mean: ${round3(mean(miouValues))}`);
  lines.push(`- leakage_mean: ${round3(mean(leakageValues))}`);
  lines.push(`- skin_roi_too_small_rate: ${round3(skinRoiTooSmallRate)}`);
  lines.push(`- geometry_sanitize_drop_rate_mean: ${dropRates.length ? round3(mean(dropRates)) : 'n/a'}`);
  lines.push('');
  lines.push('## Thresholds (soft gate)');
  lines.push('');
  lines.push(`- module_mIoU >= ${args.eval_min_miou}`);
  lines.push(`- face_detect_fail_rate <= ${args.eval_max_fail_rate}`);
  lines.push(`- leakage_mean <= ${args.eval_max_leakage}`);
  lines.push(`- skin_roi_too_small_rate <= ${args.eval_max_skin_roi_too_small} (pred_pixels < ${args.skin_roi_min_pixels})`);
  lines.push('');

  if (softWarnings.length) {
    lines.push('## Soft Warnings');
    lines.push('');
    for (const warning of softWarnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('## Top Fail Reasons');
  lines.push('');
  lines.push('| fail_reason | count | pct_of_total |');
  lines.push('|---|---:|---:|');
  for (const row of failReasonRows) {
    lines.push(`| ${row.reason} | ${row.count} | ${row.pct} |`);
  }
  if (!failReasonRows.length) {
    lines.push('| - | 0 | 0 |');
  }
  lines.push('');

  lines.push('## PRED_MODULES_MISSING breakdown');
  lines.push('');
  lines.push('| reason_detail | count | pct_of_missing |');
  lines.push('|---|---:|---:|');
  if (predMissingBreakdown && Array.isArray(predMissingBreakdown.rows) && predMissingBreakdown.rows.length) {
    for (const row of predMissingBreakdown.rows) {
      lines.push(`| ${row.reason_detail} | ${row.count} | ${row.pct_of_missing} |`);
    }
  } else {
    lines.push('| - | 0 | 0 |');
  }
  lines.push('');

  lines.push('## Per-Module Summary');
  lines.push('');
  lines.push('| dataset | module | samples | mIoU mean | p50 | p90 | coverage mean | leakage mean | roi_too_small_rate |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const row of summaryRows) {
    lines.push(
      `| ${row.dataset} | ${row.module_id} | ${row.samples} | ${row.miou_mean} | ${row.miou_p50} | ${row.miou_p90} | ${row.coverage_mean} | ${row.leakage_mean} | ${row.roi_too_small_rate} |`,
    );
  }
  lines.push('');

  if (weakRows.length) {
    lines.push('## Weak-Label Datasets');
    lines.push('');
    for (const row of weakRows) {
      lines.push(
        `- ${row.dataset}: samples=${row.samples}, note=${row.note || 'weak_label_only'}, lesion_count_mean=${row.lesion_count_mean == null ? 'n/a' : row.lesion_count_mean}`,
      );
    }
    lines.push('');
  }

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- jsonl: \`${toPosix(path.relative(process.cwd(), jsonlPath))}\``);
  lines.push(`- csv: \`${toPosix(path.relative(process.cwd(), csvPath))}\``);
  if (args.emit_debug_overlays) {
    lines.push(`- debug output: \`outputs/datasets_debug/${runKey}\` (**DO NOT DISTRIBUTE**)`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const cache = normalizeCacheDirs(args.cache_dir);
  const runKey = nowRunKey();
  const circleModel = await resolveCircleModelBoxes(args.circle_model_path);
  const activeModuleBoxes = circleModel.moduleBoxes;
  const resolvedModuleIds = moduleIds(activeModuleBoxes);
  const reportDir = path.resolve(args.report_dir || DEFAULT_REPORT_DIR);
  await ensureDir(reportDir);
  await ensureDir(cache.derivedGtDir);

  const jsonlPath = path.join(reportDir, `eval_circle_${runKey}.jsonl`);
  const csvPath = path.join(reportDir, `eval_circle_summary_${runKey}.csv`);
  const mdPath = path.join(reportDir, `eval_circle_summary_${runKey}.md`);
  const debugDir = path.join('outputs', 'datasets_debug', runKey);
  if (args.emit_debug_overlays) await ensureDir(debugDir);

  const allSamples = [];
  const seedRows = [];
  for (const dataset of args.datasets) {
    const adapter = getAdapter(dataset);
    if (!adapter) throw new Error(`adapter_not_found:${dataset}`);
    try {
      const loaded = await adapter.loadSamples({
        repoRoot,
        cacheExternalDir: cache.cacheExternalDir,
        cacheRootDir: cache.cacheRootDir,
        limit: args.limit || undefined,
        shuffle: args.shuffle,
        seed: runKey,
      });
      for (const sample of loaded.samples || []) {
        allSamples.push({
          dataset,
          adapter,
          sample,
        });
      }
    } catch (error) {
      const detail = String(error && error.message ? error.message : error);
      seedRows.push(finalizeEvalRow({
        ...createBaseEvalRow({
          dataset,
          sampleHash: hashId(`${dataset}:NO_INDEX:${runKey}`),
          sampleId: `${dataset}:no_index`,
        }),
        fail_reason: FAIL_REASONS.NO_INDEX,
        note: detail,
      }));
    }
  }

  if (!allSamples.length && !seedRows.length) {
    throw new Error('no_samples_found_after_prepare');
  }

  const runtimeRows = await runWithConcurrency(allSamples, args.concurrency, async (entry, index) => {
    let evalSample = null;
    try {
      evalSample = entry.adapter.toEvalSample(entry.sample);
    } catch (error) {
      return finalizeEvalRow({
        ...createBaseEvalRow({
          dataset: entry.dataset,
          sampleHash: hashId(`${entry.dataset}:EVAL_SAMPLE:${index}`),
          sampleId: `eval_sample_error_${index}`,
        }),
        fail_reason: FAIL_REASONS.UNKNOWN,
        note: String(error && error.message ? error.message : error),
      });
    }

    const sampleHash = hashId(`${entry.dataset}:${evalSample.sample_id}:${index}`);
    const row = createBaseEvalRow({
      dataset: entry.dataset,
      sampleHash,
      sampleId: evalSample.sample_id,
    });
    row.source_mode = args.base_url ? 'api' : 'local';
    row.gt_stats = {
      ...row.gt_stats,
      has_gt: Boolean(evalSample && Array.isArray(evalSample.gt_masks) && evalSample.gt_masks.length),
      gt_kind: evalSample && Array.isArray(evalSample.gt_masks) && evalSample.gt_masks[0]
        ? String(evalSample.gt_masks[0].kind || 'segmentation')
        : 'none',
    };

    let imageBuffer;
    try {
      imageBuffer = await fsp.readFile(evalSample.image_bytes_path);
    } catch (error) {
      row.fail_reason = FAIL_REASONS.IMAGE_READ_FAIL;
      row.note = String(error && error.message ? error.message : error);
      return finalizeEvalRow(row);
    }
    const normalizedImageBuffer = await normalizeImageForPrediction(imageBuffer);

    const prediction = args.base_url
      ? await callApiPrediction({
          baseUrl: args.base_url,
          imageBuffer: normalizedImageBuffer,
          sampleToken: sampleHash,
          timeoutMs: args.timeout_ms,
          market: args.market,
          lang: args.lang,
          token: args.token,
        })
      : await callLocalPrediction({
          imageBuffer: normalizedImageBuffer,
          sampleToken: sampleHash,
          lang: args.lang,
          skinmaskEnabled: args.skinmask_enabled,
          skinmaskModelPath: args.skinmask_model_path,
        });
    row.skinmask_reason = prediction.skinmask_reason || null;
    row.degraded_reason = prediction.degraded_reason
      ? normalizePredModulesMissingReasonDetail(prediction.degraded_reason)
      : null;

    if (!prediction.ok || !prediction.payload) {
      row.fail_reason = mapPredictionFailureReason(prediction.reason);
      row.note = prediction.reason || 'prediction_failed';
      if (row.fail_reason === FAIL_REASONS.PRED_MODULES_MISSING) {
        row.reason_detail = inferPredModulesMissingReasonDetail({
          reasonDetail: prediction.reason_detail,
          degradedReason: prediction.degraded_reason,
          predictionReason: prediction.reason,
          qualityGrade: prediction.quality && prediction.quality.grade,
          circleModelEnabled: circleModel.meta.enabled,
        });
      }
      return finalizeEvalRow(row);
    }

    const ensuredPayload = ensureModulesForPayload(prediction.payload, {
      gridSize: args.grid_size,
      moduleBoxes: MODULE_BOXES,
      degradedReason: prediction.reason_detail || prediction.degraded_reason,
    });
    const payload = ensuredPayload.payload;
    if (ensuredPayload.fallbackUsed) {
      row.degraded_reason = normalizePredModulesMissingReasonDetail(ensuredPayload.degradedReason);
      row.note = row.note || 'fallback_modules_applied';
    }
    row.pred_stats = {
      has_pred_modules: Boolean(Array.isArray(payload.modules) && payload.modules.length),
      module_count: Array.isArray(payload.modules) ? payload.modules.length : 0,
      pred_skin_pixels_est: 0,
    };
    if (!row.pred_stats.has_pred_modules) {
      row.fail_reason = FAIL_REASONS.PRED_MODULES_MISSING;
      row.note = 'photo_modules_v1 missing modules';
      row.reason_detail = inferPredModulesMissingReasonDetail({
        reasonDetail: prediction.reason_detail,
        degradedReason: row.degraded_reason,
        predictionReason: prediction.reason || 'local_photo_modules_missing',
        qualityGrade: payload && payload.quality_grade,
        circleModelEnabled: circleModel.meta.enabled,
      });
      row.quality_grade = String(payload && payload.quality_grade ? payload.quality_grade : '');
      return finalizeEvalRow(row);
    }

    const gtSkin = await entry.adapter.buildSkinMask(evalSample);
    if (!gtSkin || !gtSkin.ok || !(gtSkin.mask instanceof Uint8Array)) {
      row.fail_reason = FAIL_REASONS.GT_MISSING;
      row.weak_label_only = Boolean(gtSkin && gtSkin.weak_label);
      row.note = gtSkin && gtSkin.note
        ? String(gtSkin.note)
        : (entry.dataset === 'celebamaskhq' ? 'NEED_MASK_MERGE_ADAPTER' : 'gt_missing');
      row.lesion_count_weak = gtSkin && Number.isFinite(Number(gtSkin.lesion_count_weak))
        ? Number(gtSkin.lesion_count_weak)
        : null;
      row.gt_stats = {
        ...row.gt_stats,
        has_gt: false,
        gt_kind: row.weak_label_only ? 'weak' : row.gt_stats.gt_kind,
      };
      return finalizeEvalRow(row);
    }

    const gtSkinPixels = countOnes(gtSkin.mask);
    row.gt_stats = {
      has_gt: true,
      skin_pixels: gtSkinPixels,
      label_values_sample: gtSkinPixels > 0 ? [0, 1] : [0],
      gt_kind: 'segmentation',
    };
    if (!gtSkinPixels) {
      row.fail_reason = FAIL_REASONS.GT_SKIN_EMPTY;
      row.note = 'gt_skin_pixels_zero';
      return finalizeEvalRow(row);
    }

    const fallbackSkinBbox = skinMaskBoundingNorm(gtSkin.mask, gtSkin.width, gtSkin.height);
    const fallbackFaceCrop = faceCropFromSkinBBoxNorm({
      skinBboxNorm: fallbackSkinBbox,
      imageWidth: gtSkin.width,
      imageHeight: gtSkin.height,
      marginScale: 1.2,
    });
    const resolvedFaceCrop = {
      coord_space: 'orig_px_v1',
      bbox_px: fallbackFaceCrop,
      orig_size_px: { w: gtSkin.width, h: gtSkin.height },
      render_size_px_hint: { w: 512, h: 512 },
    };

    const derivedGt = deriveGtModulesFromSkinMask({
      skinMaskImage: {
        mask: gtSkin.mask,
        width: gtSkin.width,
        height: gtSkin.height,
      },
      imageWidth: gtSkin.width,
      imageHeight: gtSkin.height,
      faceCropBox: resolvedFaceCrop,
      gridSize: args.grid_size,
      moduleIds: resolvedModuleIds,
      moduleBoxes: activeModuleBoxes,
    });
    const derivedPayload = {
      schema_version: 'aurora.eval.derived_gt.v1',
      dataset: entry.dataset,
      sample_id: evalSample.sample_id,
      sample_hash: sampleHash,
      generated_at: new Date().toISOString(),
      ...derivedGt,
    };
    const derivedPath = saveDerivedGt(cache.cacheRootDir, entry.dataset, evalSample.sample_id, derivedPayload);

    const gtModuleMasks = decodeGtModuleMasks(derivedGt, args.grid_size, activeModuleBoxes);
    const gtSkinMaskNorm = decodeRleBinary(derivedGt.skin_mask_rle_norm, args.grid_size * args.grid_size);
    const predicted = moduleMasksFromCardPayload(payload, args.grid_size, activeModuleBoxes);
    const predUnionMask = createMask(args.grid_size, args.grid_size, 0);
    const circlePriorMissing = Boolean(args.circle_model_calibration && !circleModel.meta.enabled);
    if (circlePriorMissing && !row.degraded_reason) {
      row.degraded_reason = PRED_MODULES_MISSING_REASON_DETAILS.CIRCLE_PRIOR_MISSING;
    }
    let calibrationFailed = false;

    const moduleScores = [];
    for (const moduleId of resolvedModuleIds) {
      const predMaskRaw = predicted.moduleMasks[moduleId] || createMask(args.grid_size, args.grid_size, 0);
      let predMask = predMaskRaw;
      if (circleModel.meta.enabled && args.circle_model_calibration) {
        const calibrated = safeApplyCalibration({
          moduleId,
          predMaskRaw,
          gridSize: args.grid_size,
          modelBoxes: activeModuleBoxes,
          minPixels: args.circle_model_min_pixels,
        });
        predMask = calibrated.mask || predMaskRaw;
        if (calibrated.failed) calibrationFailed = true;
      }
      orMaskInto(predUnionMask, predMask);
      const gtMask = gtModuleMasks[moduleId];
      const gtPixels = countOnes(gtMask);
      if (!gtPixels) continue;
      const predPixels = countOnes(predMask);
      const roiTooSmall = predPixels < args.skin_roi_min_pixels;
      moduleScores.push({
        module_id: moduleId,
        iou: round3(iouScore(predMask, gtMask)),
        coverage: round3(coverageScore(predMask, gtMask)),
        leakage: round3(leakageScore(predMask, gtSkinMaskNorm)),
        pred_pixels: predPixels,
        gt_pixels: gtPixels,
        roi_too_small: roiTooSmall,
      });
    }
    if (calibrationFailed && !row.degraded_reason) {
      row.degraded_reason = PRED_MODULES_MISSING_REASON_DETAILS.CALIBRATION_FAIL;
    }

    const predSkinPixels = countOnes(predUnionMask);
    row.pred_stats.pred_skin_pixels_est = predSkinPixels;
    if (predSkinPixels <= 0) {
      row.fail_reason = FAIL_REASONS.PRED_SKIN_EMPTY;
    }

    const geometryDropRows = Array.isArray(prediction.metrics && prediction.metrics.geometryDropCounts)
      ? prediction.metrics.geometryDropCounts
      : [];
    const dropped = geometryDropRows.reduce((acc, metricRow) => acc + Number(metricRow && metricRow.count ? metricRow.count : 0), 0);
    const geometrySanitizeDropRate = round3(dropped / Math.max(1, dropped + Number(predicted.regionsCount || 0)));
    const sanitizerDropped = Number(predicted.regionsCount || 0) > 0 && Number(predicted.invalidRegionCount || 0) >= Number(predicted.regionsCount || 0);
    if (sanitizerDropped && !row.degraded_reason) {
      row.degraded_reason = PRED_MODULES_MISSING_REASON_DETAILS.SANITIZER_DROPPED;
    }
    const faceDetectOk = Boolean(payload && payload.face_crop && payload.face_crop.bbox_px);

    row.module_scores = moduleScores;
    row.quality_grade = String(payload && payload.quality_grade ? payload.quality_grade : '');
    row.regions_count = Number(predicted.regionsCount || 0);
    row.invalid_region_count = Number(predicted.invalidRegionCount || 0);
    row.face_detect_ok = faceDetectOk;
    row.landmark_ok = faceDetectOk;
    row.geometry_sanitize_drop_rate = Number.isFinite(geometrySanitizeDropRate) ? geometrySanitizeDropRate : null;
    row.skin_roi_too_small_count = moduleScores.filter((moduleScore) => moduleScore.roi_too_small).length;
    row.skin_roi_evaluated_count = moduleScores.length;
    row.skin_roi_too_small_rate = round3(
      moduleScores.length
        ? moduleScores.filter((moduleScore) => moduleScore.roi_too_small).length / moduleScores.length
        : 0,
    );
    row.weak_label_only = false;
    row.derived_gt_path = toPosix(path.relative(repoRoot, derivedPath));
    row.metric_stats = {
      modules_scored: moduleScores.length,
      miou_mean: round3(mean(moduleScores.map((moduleScore) => Number(moduleScore.iou || 0)))),
      coverage_mean: round3(mean(moduleScores.map((moduleScore) => Number(moduleScore.coverage || 0)))),
      leakage_mean: round3(mean(moduleScores.map((moduleScore) => Number(moduleScore.leakage || 0)))),
    };
    if (!moduleScores.length && row.fail_reason === FAIL_REASONS.UNKNOWN) {
      row.fail_reason = FAIL_REASONS.METRIC_SKIP;
    }

    if (args.emit_debug_overlays) {
      const debugPath = path.join(debugDir, `${entry.dataset}_${sampleHash}.json`);
      await fsp.mkdir(path.dirname(debugPath), { recursive: true });
      await fsp.writeFile(
        debugPath,
        `${JSON.stringify({
          warning: 'DO NOT DISTRIBUTE',
          dataset: entry.dataset,
          sample_hash: sampleHash,
          module_scores: moduleScores,
          quality_grade: row.quality_grade,
          regions_count: row.regions_count,
        }, null, 2)}\n`,
        'utf8',
      );
      row.debug_path = toPosix(path.relative(repoRoot, debugPath));
    }

    return finalizeEvalRow(row);
  });

  const sampleRows = [...seedRows, ...runtimeRows].map((row) => finalizeEvalRow(row));

  writeJsonl(jsonlPath, sampleRows);

  const summaryRows = makeSummaryRows(sampleRows);
  writeText(csvPath, makeCsv(summaryRows));

  const weakBuckets = new Map();
  for (const row of sampleRows) {
    if (!row || !row.weak_label_only) continue;
    if (!weakBuckets.has(row.dataset)) weakBuckets.set(row.dataset, []);
    weakBuckets.get(row.dataset).push(row);
  }
  const weakRows = [];
  for (const [dataset, rows] of weakBuckets.entries()) {
    const lesionValues = rows
      .map((row) => (Number.isFinite(Number(row.lesion_count_weak)) ? Number(row.lesion_count_weak) : null))
      .filter((value) => value != null);
    weakRows.push({
      dataset,
      samples: rows.length,
      lesion_count_mean: lesionValues.length ? round3(mean(lesionValues)) : null,
      note: rows[0] && rows[0].note ? rows[0].note : 'weak_label_only',
    });
  }
  weakRows.sort((a, b) => a.dataset.localeCompare(b.dataset));

  const okRows = sampleRows.filter((row) => row && row.ok && !row.weak_label_only);
  const miouValues = [];
  const leakageValues = [];
  let skinRoiTooSmallCount = 0;
  let skinRoiEvaluatedCount = 0;
  for (const row of okRows) {
    for (const moduleScore of row.module_scores || []) {
      miouValues.push(Number(moduleScore.iou || 0));
      leakageValues.push(Number(moduleScore.leakage || 0));
    }
    skinRoiTooSmallCount += Number(row.skin_roi_too_small_count || 0);
    skinRoiEvaluatedCount += Number(row.skin_roi_evaluated_count || 0);
  }
  const faceDetectFailRate = okRows.length
    ? okRows.filter((row) => row.face_detect_ok === false).length / okRows.length
    : 0;
  const miouMean = mean(miouValues);
  const leakageMean = mean(leakageValues);
  const skinRoiTooSmallRate = skinRoiEvaluatedCount > 0 ? skinRoiTooSmallCount / skinRoiEvaluatedCount : 0;

  const softWarnings = [];
  if (miouMean < args.eval_min_miou) {
    softWarnings.push(`module_mIoU ${round3(miouMean)} < threshold ${args.eval_min_miou}`);
  }
  if (faceDetectFailRate > args.eval_max_fail_rate) {
    softWarnings.push(`face_detect_fail_rate ${round3(faceDetectFailRate)} > threshold ${args.eval_max_fail_rate}`);
  }
  if (leakageMean > args.eval_max_leakage) {
    softWarnings.push(`leakage_mean ${round3(leakageMean)} > threshold ${args.eval_max_leakage}`);
  }
  if (skinRoiTooSmallRate > args.eval_max_skin_roi_too_small) {
    softWarnings.push(
      `skin_roi_too_small_rate ${round3(skinRoiTooSmallRate)} > threshold ${args.eval_max_skin_roi_too_small}`,
    );
  }
  const failReasonRows = topFailReasons(sampleRows);
  const predMissingBreakdown = predModulesMissingBreakdown(sampleRows);

  const markdown = renderMarkdown({
    args,
    runKey,
    circleModelMeta: circleModel.meta,
    sampleRows,
    summaryRows,
    jsonlPath,
    csvPath,
    weakRows,
    failReasonRows,
    predMissingBreakdown,
    softWarnings,
  });
  writeText(mdPath, markdown);

  const payload = {
    ok: true,
    run_id: runKey,
    mode: args.base_url ? 'api' : 'local',
    datasets: args.datasets,
    samples_total: sampleRows.length,
    samples_ok: sampleRows.filter((row) => row && row.ok).length,
    samples_failed: sampleRows.filter((row) => !row || !row.ok).length,
    weak_label_samples: sampleRows.filter((row) => row && row.weak_label_only).length,
    circle_model_enabled: circleModel.meta.enabled,
    circle_model_path: circleModel.meta.path || '',
    circle_model_calibration: args.circle_model_calibration,
    module_miou_mean: round3(miouMean),
    leakage_mean: round3(leakageMean),
    skin_roi_too_small_rate: round3(skinRoiTooSmallRate),
    face_detect_fail_rate: round3(faceDetectFailRate),
    fail_reasons: failReasonRows,
    pred_modules_missing_breakdown: predMissingBreakdown,
    summary_rows: summaryRows.length,
    soft_warnings: softWarnings,
    artifacts: {
      jsonl: toPosix(path.relative(repoRoot, jsonlPath)),
      csv: toPosix(path.relative(repoRoot, csvPath)),
      md: toPosix(path.relative(repoRoot, mdPath)),
    },
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((error) => {
  const message = String(error && error.stack ? error.stack : error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
