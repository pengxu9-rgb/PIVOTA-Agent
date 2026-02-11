'use strict';

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

const {
  normalizePredModulesMissingReasonDetail,
} = require('./eval_circle_local_fallback.cjs');

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

module.exports = {
  FAIL_REASONS,
  defaultGtStats,
  defaultPredStats,
  defaultMetricStats,
  createBaseEvalRow,
  normalizeFailReason,
  finalizeEvalRow,
};
