'use strict';

const {
  MODULE_BOXES,
  bboxNormToMask,
  encodeRleBinary,
} = require('../src/auroraBff/evalAdapters/common/metrics');
const { applyModelBoxCalibration } = require('../src/auroraBff/evalAdapters/common/circlePriorModel');

const PRED_MODULES_MISSING_REASON_DETAILS = Object.freeze({
  QUALITY_GATED: 'QUALITY_GATED',
  MODULEIZER_EXCEPTION: 'MODULEIZER_EXCEPTION',
  CALIBRATION_FAIL: 'CALIBRATION_FAIL',
  CIRCLE_PRIOR_MISSING: 'CIRCLE_PRIOR_MISSING',
  SANITIZER_DROPPED: 'SANITIZER_DROPPED',
  UNKNOWN: 'UNKNOWN',
});

function normalizePredModulesMissingReasonDetail(input) {
  const token = String(input || '').trim().toUpperCase();
  const known = Object.values(PRED_MODULES_MISSING_REASON_DETAILS);
  return known.includes(token) ? token : PRED_MODULES_MISSING_REASON_DETAILS.UNKNOWN;
}

function normalizeQualityGrade(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'pass' || token === 'degraded' || token === 'fail') return token;
  return 'unknown';
}

function toSafeGridSize(value, fallback = 64) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(32, Math.min(256, Math.trunc(n)));
}

function cloneBox(box) {
  return {
    x: Number(box && box.x) || 0,
    y: Number(box && box.y) || 0,
    w: Number(box && box.w) || 0,
    h: Number(box && box.h) || 0,
  };
}

function buildFallbackModules({ gridSize = 64, moduleBoxes = MODULE_BOXES } = {}) {
  const safeGrid = toSafeGridSize(gridSize, 64);
  const sourceBoxes = moduleBoxes && typeof moduleBoxes === 'object' ? moduleBoxes : MODULE_BOXES;
  const modules = [];
  for (const [moduleId, box] of Object.entries(sourceBoxes)) {
    const normalizedBox = cloneBox(box);
    const mask = bboxNormToMask(normalizedBox, safeGrid, safeGrid);
    modules.push({
      module_id: moduleId,
      issues: [],
      actions: [],
      box: normalizedBox,
      mask_grid: safeGrid,
      mask_rle_norm: encodeRleBinary(mask),
    });
  }
  return modules;
}

function ensureModulesForPayload(payload, {
  gridSize = 64,
  moduleBoxes = MODULE_BOXES,
  degradedReason = null,
} = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const currentModules = Array.isArray(source.modules) ? source.modules.filter(Boolean) : [];
  if (currentModules.length > 0) {
    return {
      payload: {
        ...source,
        modules: currentModules,
      },
      fallbackUsed: false,
      degradedReason: null,
    };
  }
  const reasonDetail = normalizePredModulesMissingReasonDetail(degradedReason);
  const fallbackModules = buildFallbackModules({ gridSize, moduleBoxes });
  const nextPayload = {
    ...source,
    used_photos: source.used_photos !== false,
    quality_grade: normalizeQualityGrade(source.quality_grade),
    regions: Array.isArray(source.regions) ? source.regions : [],
    modules: fallbackModules,
    degraded_reason: reasonDetail,
  };
  return {
    payload: nextPayload,
    fallbackUsed: true,
    degradedReason: reasonDetail,
  };
}

function inferPredModulesMissingReasonDetail({
  reasonDetail = null,
  degradedReason = null,
  predictionReason = null,
  qualityGrade = null,
  calibrationFailed = false,
  circleModelEnabled = true,
  regionsCount = 0,
  invalidRegionCount = 0,
} = {}) {
  const explicit = normalizePredModulesMissingReasonDetail(reasonDetail || degradedReason);
  if (explicit !== PRED_MODULES_MISSING_REASON_DETAILS.UNKNOWN) return explicit;

  if (calibrationFailed) return PRED_MODULES_MISSING_REASON_DETAILS.CALIBRATION_FAIL;
  if (!circleModelEnabled) return PRED_MODULES_MISSING_REASON_DETAILS.CIRCLE_PRIOR_MISSING;

  const normalizedQuality = normalizeQualityGrade(qualityGrade);
  if (normalizedQuality === 'fail' || normalizedQuality === 'unknown') {
    return PRED_MODULES_MISSING_REASON_DETAILS.QUALITY_GATED;
  }

  const regions = Number(regionsCount || 0);
  const invalidRegions = Number(invalidRegionCount || 0);
  if (regions > 0 && invalidRegions >= regions) {
    return PRED_MODULES_MISSING_REASON_DETAILS.SANITIZER_DROPPED;
  }

  const token = String(predictionReason || '').trim().toLowerCase();
  if (token.includes('quality')) return PRED_MODULES_MISSING_REASON_DETAILS.QUALITY_GATED;
  if (token.includes('moduleizer') || token.includes('photo_modules') || token.includes('modules_missing')) {
    return PRED_MODULES_MISSING_REASON_DETAILS.MODULEIZER_EXCEPTION;
  }
  if (token.includes('calibration')) return PRED_MODULES_MISSING_REASON_DETAILS.CALIBRATION_FAIL;
  if (token.includes('circle_prior')) return PRED_MODULES_MISSING_REASON_DETAILS.CIRCLE_PRIOR_MISSING;
  if (token.includes('sanitizer')) return PRED_MODULES_MISSING_REASON_DETAILS.SANITIZER_DROPPED;
  return PRED_MODULES_MISSING_REASON_DETAILS.UNKNOWN;
}

function safeApplyCalibration({
  moduleId,
  predMaskRaw,
  gridSize,
  modelBoxes,
  minPixels,
  calibrator = applyModelBoxCalibration,
} = {}) {
  try {
    return {
      mask: calibrator({
        moduleId,
        predMask: predMaskRaw,
        gridSize,
        modelBoxes,
        minPixels,
      }),
      failed: false,
    };
  } catch (_error) {
    return {
      mask: predMaskRaw,
      failed: true,
    };
  }
}

module.exports = {
  PRED_MODULES_MISSING_REASON_DETAILS,
  normalizePredModulesMissingReasonDetail,
  buildFallbackModules,
  ensureModulesForPayload,
  inferPredModulesMissingReasonDetail,
  safeApplyCalibration,
};
