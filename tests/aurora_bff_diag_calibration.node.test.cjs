const test = require('node:test');
const assert = require('node:assert/strict');

const {
  trainCalibrationModel,
  resolveProviderWeight,
} = require('../src/auroraBff/diagCalibration');

function makeRng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeConcern({ type = 'acne', confidence = 0.5, bbox } = {}) {
  return {
    type,
    confidence,
    severity: 2,
    regions: [
      {
        kind: 'bbox',
        bbox_norm: bbox || { x0: 0.2, y0: 0.2, x1: 0.45, y1: 0.45 },
      },
    ],
  };
}

test('calibration training lowers ECE on synthetic gold labels', () => {
  const rng = makeRng(42);
  const modelOutputs = [];
  const goldLabels = [];

  for (let index = 0; index < 320; index += 1) {
    const rawConfidence = rng();
    const trueProb = Math.min(1, Math.max(0, 0.05 + 0.62 * rawConfidence * rawConfidence));
    const isPositive = rng() < trueProb;
    const inferenceId = `cal_inf_${index}`;
    const bbox = { x0: 0.2, y0: 0.2, x1: 0.45, y1: 0.45 };

    modelOutputs.push({
      inference_id: inferenceId,
      provider: index % 2 === 0 ? 'gemini_provider' : 'gpt_provider',
      quality_grade: index % 3 === 0 ? 'degraded' : 'pass',
      skin_tone_bucket: index % 4 < 2 ? 'deep' : 'light',
      lighting_bucket: index % 5 < 2 ? 'indoor' : 'daylight',
      output_json: {
        concerns: [makeConcern({ type: 'acne', confidence: rawConfidence, bbox })],
      },
    });

    goldLabels.push({
      inference_id: inferenceId,
      qa_status: 'approved',
      concerns: isPositive ? [makeConcern({ type: 'acne', confidence: 1, bbox })] : [],
    });
  }

  const trained = trainCalibrationModel({
    modelOutputs,
    goldLabels,
    options: {
      iou_threshold: 0.3,
      min_group_samples: 12,
    },
  });

  const rawEce = Number(trained.model.training.baseline_metrics.ece || 0);
  const calibratedEce = Number(trained.model.training.calibrated_metrics.ece || 0);
  assert.ok(trained.rows.length >= 300);
  assert.ok(calibratedEce <= rawEce, `expected calibrated ECE <= raw ECE, got raw=${rawEce} calibrated=${calibratedEce}`);
  assert.ok(rawEce - calibratedEce >= 0.01, `expected ECE delta >= 0.01, got ${rawEce - calibratedEce}`);
});

test('provider weights honor type/quality/tone buckets', () => {
  const modelOutputs = [];
  const goldLabels = [];
  let counter = 0;

  function pushPair({ toneBucket, geminiGood, gptGood }) {
    const inferenceId = `bucket_inf_${counter++}`;
    const goodBbox = { x0: 0.2, y0: 0.2, x1: 0.45, y1: 0.45 };
    goldLabels.push({
      inference_id: inferenceId,
      qa_status: 'approved',
      concerns: [makeConcern({ type: 'acne', confidence: 1, bbox: goodBbox })],
    });
    modelOutputs.push({
      inference_id: inferenceId,
      provider: 'gemini_provider',
      quality_grade: 'pass',
      skin_tone_bucket: toneBucket,
      lighting_bucket: 'daylight',
      output_json: {
        concerns: [
          geminiGood
            ? makeConcern({ type: 'acne', confidence: 0.85, bbox: goodBbox })
            : makeConcern({ type: 'redness', confidence: 0.85, bbox: { x0: 0.65, y0: 0.65, x1: 0.9, y1: 0.9 } }),
        ],
      },
    });
    modelOutputs.push({
      inference_id: inferenceId,
      provider: 'gpt_provider',
      quality_grade: 'pass',
      skin_tone_bucket: toneBucket,
      lighting_bucket: 'daylight',
      output_json: {
        concerns: [
          gptGood
            ? makeConcern({ type: 'acne', confidence: 0.85, bbox: goodBbox })
            : makeConcern({ type: 'redness', confidence: 0.85, bbox: { x0: 0.62, y0: 0.62, x1: 0.88, y1: 0.88 } }),
        ],
      },
    });
  }

  for (let index = 0; index < 20; index += 1) {
    pushPair({ toneBucket: 'deep', geminiGood: true, gptGood: false });
    pushPair({ toneBucket: 'light', geminiGood: false, gptGood: true });
  }

  const trained = trainCalibrationModel({
    modelOutputs,
    goldLabels,
    options: {
      iou_threshold: 0.3,
      min_group_samples: 6,
    },
  });

  const geminiDeep = resolveProviderWeight(trained.model, {
    provider: 'gemini_provider',
    type: 'acne',
    qualityGrade: 'pass',
    toneBucket: 'deep',
  });
  const gptDeep = resolveProviderWeight(trained.model, {
    provider: 'gpt_provider',
    type: 'acne',
    qualityGrade: 'pass',
    toneBucket: 'deep',
  });
  const geminiLight = resolveProviderWeight(trained.model, {
    provider: 'gemini_provider',
    type: 'acne',
    qualityGrade: 'pass',
    toneBucket: 'light',
  });
  const gptLight = resolveProviderWeight(trained.model, {
    provider: 'gpt_provider',
    type: 'acne',
    qualityGrade: 'pass',
    toneBucket: 'light',
  });

  assert.ok(geminiDeep > gptDeep, `expected gemini deep weight > gpt deep weight, got ${geminiDeep} <= ${gptDeep}`);
  assert.ok(gptLight > geminiLight, `expected gpt light weight > gemini light weight, got ${gptLight} <= ${geminiLight}`);
});
