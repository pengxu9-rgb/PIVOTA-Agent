const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FAIL_REASONS,
  createBaseEvalRow,
  finalizeEvalRow,
} = require('../scripts/eval_circle_fail_reason.cjs');

test('eval fail reason: missing GT resolves to GT_MISSING', () => {
  const row = createBaseEvalRow({ dataset: 'fasseg', sampleHash: 'a', sampleId: 's1' });
  row.pred_stats = { has_pred_modules: true, module_count: 2, pred_skin_pixels_est: 120 };
  row.gt_stats = { has_gt: false, skin_pixels: 0, label_values_sample: [], gt_kind: 'none' };
  row.metric_stats = { modules_scored: 0, miou_mean: 0, coverage_mean: 0, leakage_mean: 0 };

  const out = finalizeEvalRow(row);
  assert.equal(out.ok, false);
  assert.equal(out.fail_reason, FAIL_REASONS.GT_MISSING);
});

test('eval fail reason: gt skin empty resolves to GT_SKIN_EMPTY', () => {
  const row = createBaseEvalRow({ dataset: 'fasseg', sampleHash: 'b', sampleId: 's2' });
  row.pred_stats = { has_pred_modules: true, module_count: 3, pred_skin_pixels_est: 100 };
  row.gt_stats = { has_gt: true, skin_pixels: 0, label_values_sample: [0], gt_kind: 'segmentation' };
  row.metric_stats = { modules_scored: 0, miou_mean: 0, coverage_mean: 0, leakage_mean: 0 };

  const out = finalizeEvalRow(row);
  assert.equal(out.ok, false);
  assert.equal(out.fail_reason, FAIL_REASONS.GT_SKIN_EMPTY);
});

test('eval fail reason: missing predicted modules resolves to PRED_MODULES_MISSING', () => {
  const row = createBaseEvalRow({ dataset: 'fasseg', sampleHash: 'c', sampleId: 's3' });
  row.pred_stats = { has_pred_modules: false, module_count: 0, pred_skin_pixels_est: 0 };
  row.gt_stats = { has_gt: true, skin_pixels: 140, label_values_sample: [0, 1], gt_kind: 'segmentation' };
  row.metric_stats = { modules_scored: 0, miou_mean: 0, coverage_mean: 0, leakage_mean: 0 };

  const out = finalizeEvalRow(row);
  assert.equal(out.ok, false);
  assert.equal(out.fail_reason, FAIL_REASONS.PRED_MODULES_MISSING);
  assert.equal(out.reason_detail, 'UNKNOWN');
});

test('samples_ok semantics: modules_scored == 0 is not ok', () => {
  const row = createBaseEvalRow({ dataset: 'fasseg', sampleHash: 'd', sampleId: 's4' });
  row.pred_stats = { has_pred_modules: true, module_count: 3, pred_skin_pixels_est: 100 };
  row.gt_stats = { has_gt: true, skin_pixels: 140, label_values_sample: [0, 1], gt_kind: 'segmentation' };
  row.metric_stats = { modules_scored: 0, miou_mean: 0, coverage_mean: 0, leakage_mean: 0 };

  const out = finalizeEvalRow(row);
  assert.equal(out.ok, false);
  assert.equal(out.metric_stats.modules_scored, 0);
});

test('eval fail reason: missing predicted modules keeps known reason_detail', () => {
  const row = createBaseEvalRow({ dataset: 'fasseg', sampleHash: 'e', sampleId: 's5' });
  row.pred_stats = { has_pred_modules: false, module_count: 0, pred_skin_pixels_est: 0 };
  row.gt_stats = { has_gt: true, skin_pixels: 140, label_values_sample: [0, 1], gt_kind: 'segmentation' };
  row.metric_stats = { modules_scored: 0, miou_mean: 0, coverage_mean: 0, leakage_mean: 0 };
  row.reason_detail = 'SANITIZER_DROPPED';

  const out = finalizeEvalRow(row);
  assert.equal(out.ok, false);
  assert.equal(out.fail_reason, FAIL_REASONS.PRED_MODULES_MISSING);
  assert.equal(out.reason_detail, 'SANITIZER_DROPPED');
});
