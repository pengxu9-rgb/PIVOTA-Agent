const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRED_MODULES_MISSING_REASON_DETAILS,
  ensureModulesForPayload,
  inferPredModulesMissingReasonDetail,
  safeApplyCalibration,
} = require('../scripts/eval_circle_local_fallback.cjs');

test('fallback modules: circle prior missing still returns complete module set', () => {
  const payload = {
    used_photos: true,
    quality_grade: 'pass',
    regions: [],
    modules: [],
  };
  const out = ensureModulesForPayload(payload, {
    gridSize: 64,
    degradedReason: PRED_MODULES_MISSING_REASON_DETAILS.CIRCLE_PRIOR_MISSING,
  });

  assert.equal(out.fallbackUsed, true);
  assert.ok(Array.isArray(out.payload.modules));
  assert.ok(out.payload.modules.length > 0);
  assert.equal(out.payload.degraded_reason, PRED_MODULES_MISSING_REASON_DETAILS.CIRCLE_PRIOR_MISSING);
});

test('fallback modules: calibration throw uses raw mask and records fail detail', () => {
  const predMaskRaw = Uint8Array.from([1, 0, 1, 0]);
  const calibrated = safeApplyCalibration({
    moduleId: 'nose',
    predMaskRaw,
    gridSize: 2,
    modelBoxes: {
      nose: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    },
    minPixels: 1,
    calibrator: () => {
      throw new Error('forced_calibrator_error');
    },
  });
  assert.equal(calibrated.failed, true);
  assert.deepEqual(Array.from(calibrated.mask), Array.from(predMaskRaw));

  const detail = inferPredModulesMissingReasonDetail({
    calibrationFailed: true,
    circleModelEnabled: true,
  });
  assert.equal(detail, PRED_MODULES_MISSING_REASON_DETAILS.CALIBRATION_FAIL);
});

test('fallback modules: sanitizer dropped reason is diagnosable and fallback remains available', () => {
  const detail = inferPredModulesMissingReasonDetail({
    regionsCount: 12,
    invalidRegionCount: 12,
    circleModelEnabled: true,
    qualityGrade: 'pass',
  });
  assert.equal(detail, PRED_MODULES_MISSING_REASON_DETAILS.SANITIZER_DROPPED);

  const out = ensureModulesForPayload(
    {
      used_photos: true,
      quality_grade: 'degraded',
      regions: [],
      modules: [],
    },
    {
      gridSize: 64,
      degradedReason: detail,
    },
  );
  assert.equal(out.fallbackUsed, true);
  assert.ok(out.payload.modules.length > 0);
  assert.equal(out.payload.degraded_reason, PRED_MODULES_MISSING_REASON_DETAILS.SANITIZER_DROPPED);
});
