const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');

function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch || {})) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

async function makeFaceLikePng() {
  return sharp({
    create: {
      width: 320,
      height: 320,
      channels: 3,
      background: { r: 214, g: 178, b: 160 },
    },
  })
    .composite([
      {
        input: {
          create: {
            width: 190,
            height: 90,
            channels: 3,
            background: { r: 202, g: 168, b: 150 },
          },
        },
        left: 66,
        top: 48,
      },
      {
        input: {
          create: {
            width: 220,
            height: 120,
            channels: 3,
            background: { r: 196, g: 160, b: 141 },
          },
        },
        left: 50,
        top: 152,
      },
    ])
    .png()
    .toBuffer();
}

function buildAnalysisFixture() {
  return {
    photo_findings: [
      {
        finding_id: 'skinmask_fallback_case_1',
        issue_type: 'redness',
        severity: 3,
        confidence: 0.86,
        geometry: {
          bbox: { x: 0.12, y: 0.16, w: 0.64, h: 0.56 },
        },
      },
    ],
  };
}

function buildDiagnosisInternalFixture() {
  return {
    orig_size_px: { w: 1080, h: 1440 },
    skin_bbox_norm: { x0: 0.18, y0: 0.1, x1: 0.84, y1: 0.9 },
    face_crop_margin_scale: 1.2,
  };
}

function buildLogger() {
  const calls = [];
  return {
    calls,
    warn(payload, message) {
      calls.push({ payload, message });
    },
  };
}

test('skinmask fallback: model missing does not block photo_modules card generation', async () => {
  await withEnv(
    {
      DIAG_PHOTO_MODULES_CARD: 'true',
      DIAG_OVERLAY_MODE: 'client',
      DIAG_INGREDIENT_REC: 'false',
      DIAG_PRODUCT_REC: 'false',
      DIAG_SKINMASK_ENABLED: 'true',
      DIAG_SKINMASK_MODEL_PATH: 'artifacts/__missing_skinmask_model__.onnx',
      DIAG_SKINMASK_TIMEOUT_MS: '300',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { __internal } = require('../src/auroraBff/routes');
      const logger = buildLogger();
      const inferred = await __internal.maybeInferSkinMaskForPhotoModules({
        imageBuffer: await makeFaceLikePng(),
        diagnosisInternal: buildDiagnosisInternalFixture(),
        logger,
        requestId: 'skinmask_missing_model_case',
      });

      assert.equal(inferred, null);
      const card = buildPhotoModulesCard({
        requestId: 'skinmask_missing_model_case',
        analysis: buildAnalysisFixture(),
        usedPhotos: true,
        photoQuality: { grade: 'degraded', reasons: ['fallback_test'] },
        diagnosisInternal: buildDiagnosisInternalFixture(),
        language: 'EN',
        ingredientRecEnabled: false,
        productRecEnabled: false,
        skinMask: inferred,
      });
      assert.ok(card && card.card && card.card.type === 'photo_modules_v1');
      assert.equal(card.card.payload.used_photos, true);
      assert.equal(
        logger.calls.some(
          (row) => row && row.payload && row.payload.fallback_reason === 'MODEL_MISSING' && row.message.includes('inference skipped'),
        ),
        true,
      );
    },
  );
});

test('skinmask fallback: inference exception still keeps used_photos card path healthy', async () => {
  await withEnv(
    {
      DIAG_PHOTO_MODULES_CARD: 'true',
      DIAG_OVERLAY_MODE: 'client',
      DIAG_INGREDIENT_REC: 'false',
      DIAG_PRODUCT_REC: 'false',
      DIAG_SKINMASK_ENABLED: 'true',
      DIAG_SKINMASK_MODEL_PATH: 'artifacts/skinmask_v1.onnx',
      DIAG_SKINMASK_TIMEOUT_MS: '300',
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/routes');
      delete require.cache[moduleId];
      const { __internal } = require('../src/auroraBff/routes');
      const logger = buildLogger();
      __internal.__setInferSkinMaskOnFaceCropForTest(async () => {
        throw new Error('forced_skinmask_runtime_error');
      });

      try {
        const inferred = await __internal.maybeInferSkinMaskForPhotoModules({
          imageBuffer: await makeFaceLikePng(),
          diagnosisInternal: buildDiagnosisInternalFixture(),
          logger,
          requestId: 'skinmask_infer_exception_case',
        });
        assert.equal(inferred, null);
        const card = buildPhotoModulesCard({
          requestId: 'skinmask_infer_exception_case',
          analysis: buildAnalysisFixture(),
          usedPhotos: true,
          photoQuality: { grade: 'degraded', reasons: ['fallback_test'] },
          diagnosisInternal: buildDiagnosisInternalFixture(),
          language: 'EN',
          ingredientRecEnabled: false,
          productRecEnabled: false,
          skinMask: inferred,
        });
        assert.ok(card && card.card && card.card.type === 'photo_modules_v1');
        assert.equal(card.card.payload.used_photos, true);
        assert.equal(
          logger.calls.some(
            (row) => row && row.payload && row.payload.fallback_reason === 'ONNX_FAIL' && row.message.includes('inference failed'),
          ),
          true,
        );
      } finally {
        __internal.__resetInferSkinMaskOnFaceCropForTest();
      }
    },
  );
});
