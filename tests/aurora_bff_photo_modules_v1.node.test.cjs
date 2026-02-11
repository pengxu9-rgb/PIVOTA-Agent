const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const { resetVisionMetrics, renderVisionMetricsPrometheus } = require('../src/auroraBff/visionMetrics');
const { decodeRleBinary, countOnes } = require('../src/auroraBff/evalAdapters/common/metrics');

function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function loadRoutesInternal() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const mod = require('../src/auroraBff/routes');
  return { moduleId, internal: mod.__internal };
}

function unloadRoutes(moduleId) {
  if (moduleId) delete require.cache[moduleId];
}

function loadPhotoModulesBuilder() {
  const moduleId = require.resolve('../src/auroraBff/photoModulesV1');
  delete require.cache[moduleId];
  const mod = require('../src/auroraBff/photoModulesV1');
  return { moduleId, buildPhotoModulesCard: mod.buildPhotoModulesCard };
}

function unloadPhotoModules(moduleId) {
  if (moduleId) delete require.cache[moduleId];
}

function makeHeatmapValues(w, h) {
  const values = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const base = (x + y) / Math.max(1, (w - 1) + (h - 1));
      const noisy = x === 0 && y === 0 ? -0.4 : x === w - 1 && y === h - 1 ? 1.8 : base;
      values.push(noisy);
    }
  }
  return values;
}

function makeAnalysisFixture() {
  return {
    photo_findings: [
      {
        finding_id: 'pf_redness',
        issue_type: 'redness',
        severity: 3,
        confidence: 0.84,
        geometry: {
          bbox: { x: -0.2, y: 0.2, w: 0.7, h: 0.5 },
          polygon: {
            points: [
              { x: -0.1, y: 0.22 },
              { x: 0.56, y: 0.22 },
              { x: 0.6, y: 0.58 },
              { x: 0.1, y: 0.58 },
              { x: -0.1, y: 0.22 },
            ],
          },
          heatmap: {
            grid: { w: 8, h: 8 },
            values: makeHeatmapValues(8, 8),
          },
        },
      },
      {
        finding_id: 'pf_shine',
        issue_type: 'shine',
        severity: 2,
        confidence: 0.7,
        geometry: {
          bbox: { x: 0.46, y: 0.3, w: 0.25, h: 0.25 },
        },
      },
    ],
  };
}

function makeDiagnosisInternalFixture() {
  return {
    orig_size_px: { w: 1080, h: 1440 },
    skin_bbox_norm: { x0: 0.19, y0: 0.11, x1: 0.81, y1: 0.9 },
    face_crop_margin_scale: 1.2,
  };
}

function makeDiagnosisInternalWithFaceCropFixture() {
  return {
    ...makeDiagnosisInternalFixture(),
    face_crop: {
      coord_space: 'orig_px_v1',
      bbox_px: { x: 108, y: 120, w: 864, h: 1200 },
      orig_size_px: { w: 1080, h: 1440 },
      render_size_px_hint: { w: 384, h: 512 },
    },
  };
}

test('photo modules card: emits face_crop_norm regions and sanitized heatmap/bounds', () => {
  const built = buildPhotoModulesCard({
    requestId: 'req_photo_modules_1',
    analysis: makeAnalysisFixture(),
    usedPhotos: true,
    photoQuality: { grade: 'pass', reasons: ['blur', 'glare'] },
    photoNotice: 'Photo analysis completed.',
    diagnosisInternal: makeDiagnosisInternalFixture(),
    profileSummary: { barrierStatus: 'impaired', sensitivity: 'high' },
    language: 'EN',
    ingredientRecEnabled: true,
    productRecEnabled: false,
  });

  assert.ok(built && built.card);
  assert.equal(built.card.type, 'photo_modules_v1');
  const payload = built.card.payload;
  assert.equal(payload.used_photos, true);
  assert.equal(payload.quality_grade, 'pass');
  assert.equal(payload.face_crop.coord_space, 'orig_px_v1');
  assert.equal(payload.regions.length > 0, true);

  for (const region of payload.regions) {
    assert.equal(region.coord_space, 'face_crop_norm_v1');
    assert.ok(region.style && typeof region.style === 'object');
    if (region.bbox) {
      assert.ok(region.bbox.x >= 0 && region.bbox.x <= 1);
      assert.ok(region.bbox.y >= 0 && region.bbox.y <= 1);
      assert.ok(region.bbox.w >= 0 && region.bbox.w <= 1);
      assert.ok(region.bbox.h >= 0 && region.bbox.h <= 1);
    }
    if (region.polygon && Array.isArray(region.polygon.points)) {
      for (const point of region.polygon.points) {
        assert.ok(point.x >= 0 && point.x <= 1);
        assert.ok(point.y >= 0 && point.y <= 1);
      }
    }
    if (region.heatmap) {
      assert.equal(region.heatmap.grid.w, 64);
      assert.equal(region.heatmap.grid.h, 64);
      assert.equal(region.heatmap.values.length, 64 * 64);
      assert.ok(region.heatmap.values.every((value) => Number(value) >= 0 && Number(value) <= 1));
    }
  }

  const regionIds = new Set(payload.regions.map((region) => region.region_id));
  for (const module of payload.modules) {
    for (const issue of module.issues || []) {
      const evidenceIds = Array.isArray(issue.evidence_region_ids) ? issue.evidence_region_ids : [];
      assert.ok(evidenceIds.length >= 1);
      for (const evidenceId of evidenceIds) {
        assert.equal(regionIds.has(evidenceId), true);
      }
    }
  }

  const serialized = JSON.stringify(payload).toLowerCase();
  assert.equal(serialized.includes('overlay_url'), false);
  assert.equal(serialized.includes('.png'), false);
});

test('photo modules card: only emits for used_photos=true and quality pass/degraded', () => {
  const analysis = makeAnalysisFixture();
  const diagnosisInternal = makeDiagnosisInternalFixture();

  const disabledByPhotos = buildPhotoModulesCard({
    requestId: 'req_photo_modules_2',
    analysis,
    usedPhotos: false,
    photoQuality: { grade: 'pass', reasons: [] },
    diagnosisInternal,
    language: 'EN',
    ingredientRecEnabled: true,
    productRecEnabled: false,
  });
  assert.equal(disabledByPhotos, null);

  const disabledByQuality = buildPhotoModulesCard({
    requestId: 'req_photo_modules_3',
    analysis,
    usedPhotos: true,
    photoQuality: { grade: 'fail', reasons: ['blur'] },
    diagnosisInternal,
    language: 'EN',
    ingredientRecEnabled: true,
    productRecEnabled: false,
  });
  assert.equal(disabledByQuality, null);
});

test('routes helper: flag off does not emit card, flag on emits and records metrics', () =>
  withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      DIAG_PHOTO_MODULES_CARD: 'false',
      DIAG_OVERLAY_MODE: 'client',
      DIAG_INGREDIENT_REC: 'true',
      DIAG_PRODUCT_REC: 'false',
    },
    () => {
      resetVisionMetrics();
      const offLoaded = loadRoutesInternal();
      const offCard = offLoaded.internal.maybeBuildPhotoModulesCardForAnalysis({
        requestId: 'req_photo_modules_4',
        analysis: makeAnalysisFixture(),
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        photoNotice: 'notice',
        diagnosisInternal: makeDiagnosisInternalFixture(),
        profileSummary: { barrierStatus: 'healthy', sensitivity: 'low' },
        language: 'EN',
      });
      unloadRoutes(offLoaded.moduleId);
      assert.equal(offCard, null);

      return withEnv(
        {
          AURORA_BFF_USE_MOCK: 'true',
          DIAG_PHOTO_MODULES_CARD: 'true',
          DIAG_OVERLAY_MODE: 'client',
          DIAG_INGREDIENT_REC: 'true',
          DIAG_PRODUCT_REC: 'false',
        },
        () => {
          const onLoaded = loadRoutesInternal();
          const onCard = onLoaded.internal.maybeBuildPhotoModulesCardForAnalysis({
            requestId: 'req_photo_modules_5',
            analysis: makeAnalysisFixture(),
            usedPhotos: true,
            photoQuality: { grade: 'degraded', reasons: ['glare'] },
            photoNotice: 'notice',
            diagnosisInternal: makeDiagnosisInternalFixture(),
            profileSummary: { barrierStatus: 'impaired', sensitivity: 'high' },
            language: 'EN',
          });
          unloadRoutes(onLoaded.moduleId);
          assert.ok(onCard && onCard.type === 'photo_modules_v1');

          const metrics = renderVisionMetricsPrometheus();
          assert.match(metrics, /photo_modules_card_emitted_total\{quality_grade="degraded"\} 1/);
          assert.match(metrics, /regions_emitted_total\{region_type="bbox",issue_type="redness"\}/);
          assert.match(metrics, /modules_issue_count_histogram\{module_id="[^"]+",issue_type="redness"\}/);
          assert.match(metrics, /ingredient_actions_emitted_total\{module_id="[^"]+",issue_type="redness"\}/);
          assert.match(metrics, /geometry_sanitizer_drop_total\{reason="[^"]+",region_type="bbox"\}/);
        },
      );
    },
  ));

test('photo modules card: face oval clip enabled keeps module mask pixels <= disabled', () =>
  withEnv(
    {
      DIAG_FACE_OVAL_CLIP: 'false',
      DIAG_MODULE_SHRINK_CHIN: '1',
      DIAG_MODULE_SHRINK_FOREHEAD: '1',
      DIAG_MODULE_SHRINK_CHEEK: '1',
      DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO: '0',
      DIAG_FACE_OVAL_CLIP_MIN_PIXELS: '1',
    },
    () => {
      const offLoaded = loadPhotoModulesBuilder();
      const offCard = offLoaded.buildPhotoModulesCard({
        requestId: 'req_photo_modules_clip_off',
        analysis: makeAnalysisFixture(),
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        photoNotice: 'notice',
        diagnosisInternal: makeDiagnosisInternalWithFaceCropFixture(),
        profileSummary: { barrierStatus: 'impaired', sensitivity: 'high' },
        language: 'EN',
        ingredientRecEnabled: true,
        productRecEnabled: false,
      });
      unloadPhotoModules(offLoaded.moduleId);
      assert.ok(offCard && offCard.card && offCard.card.payload);

      return withEnv(
        {
          DIAG_FACE_OVAL_CLIP: 'true',
          DIAG_MODULE_SHRINK_CHIN: '1',
          DIAG_MODULE_SHRINK_FOREHEAD: '1',
          DIAG_MODULE_SHRINK_CHEEK: '1',
          DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO: '0',
          DIAG_FACE_OVAL_CLIP_MIN_PIXELS: '1',
        },
        () => {
          const onLoaded = loadPhotoModulesBuilder();
          const onCard = onLoaded.buildPhotoModulesCard({
            requestId: 'req_photo_modules_clip_on',
            analysis: makeAnalysisFixture(),
            usedPhotos: true,
            photoQuality: { grade: 'pass', reasons: [] },
            photoNotice: 'notice',
            diagnosisInternal: makeDiagnosisInternalWithFaceCropFixture(),
            profileSummary: { barrierStatus: 'impaired', sensitivity: 'high' },
            language: 'EN',
            ingredientRecEnabled: true,
            productRecEnabled: false,
          });
          unloadPhotoModules(onLoaded.moduleId);
          assert.ok(onCard && onCard.card && onCard.card.payload);

          const offModules = new Map(
            (offCard.card.payload.modules || []).map((moduleRow) => [moduleRow.module_id, moduleRow]),
          );
          const onModules = new Map(
            (onCard.card.payload.modules || []).map((moduleRow) => [moduleRow.module_id, moduleRow]),
          );
          for (const [moduleId, offModule] of offModules.entries()) {
            const onModule = onModules.get(moduleId);
            assert.ok(onModule, `missing module ${moduleId}`);
            const offGrid = Number(offModule.mask_grid || 64);
            const onGrid = Number(onModule.mask_grid || 64);
            const offMask = decodeRleBinary(String(offModule.mask_rle_norm || ''), offGrid * offGrid);
            const onMask = decodeRleBinary(String(onModule.mask_rle_norm || ''), onGrid * onGrid);
            const offPixels = countOnes(offMask);
            const onPixels = countOnes(onMask);
            assert.ok(
              onPixels <= offPixels,
              `module ${moduleId} clip expected <= off pixels, got on=${onPixels} off=${offPixels}`,
            );
          }
        },
      );
    },
  ));

test('photo modules card: face oval clip too small falls back and marks degraded reason', () =>
  withEnv(
    {
      DIAG_FACE_OVAL_CLIP: 'true',
      DIAG_FACE_OVAL_CLIP_MIN_KEEP_RATIO: '1',
      DIAG_FACE_OVAL_CLIP_MIN_PIXELS: '1',
      DIAG_MODULE_SHRINK_CHIN: '1',
      DIAG_MODULE_SHRINK_FOREHEAD: '1',
      DIAG_MODULE_SHRINK_CHEEK: '1',
    },
    () => {
      const loaded = loadPhotoModulesBuilder();
      const built = loaded.buildPhotoModulesCard({
        requestId: 'req_photo_modules_clip_too_small',
        analysis: makeAnalysisFixture(),
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        photoNotice: 'notice',
        diagnosisInternal: makeDiagnosisInternalWithFaceCropFixture(),
        profileSummary: { barrierStatus: 'impaired', sensitivity: 'high' },
        language: 'EN',
        ingredientRecEnabled: true,
        productRecEnabled: false,
      });
      unloadPhotoModules(loaded.moduleId);
      assert.ok(built && built.card && built.card.payload);

      const payload = built.card.payload;
      assert.equal(Array.isArray(payload.degraded_reasons), true);
      assert.equal(payload.degraded_reasons.includes('FACE_OVAL_CLIP_TOO_SMALL'), true);
      assert.equal(payload.degraded_reason, 'FACE_OVAL_CLIP_TOO_SMALL');

      const modules = Array.isArray(payload.modules) ? payload.modules : [];
      const degradedCount = modules.filter((moduleRow) => moduleRow && moduleRow.degraded_reason === 'FACE_OVAL_CLIP_TOO_SMALL').length;
      assert.ok(degradedCount > 0, 'expected at least one module with FACE_OVAL_CLIP_TOO_SMALL');
    },
  ));

test('photo modules card: internal_debug includes shrink_factors_used for all modules', () =>
  withEnv(
    {
      DIAG_MODULE_SHRINK_CHIN: '0.8',
      DIAG_MODULE_SHRINK_FOREHEAD: '0.88',
      DIAG_MODULE_SHRINK_CHEEK: '0.9',
      DIAG_MODULE_SHRINK_UNDER_EYE: '0.95',
      DIAG_MODULE_SHRINK_NOSE: '0.95',
    },
    () => {
      const loaded = loadPhotoModulesBuilder();
      const built = loaded.buildPhotoModulesCard({
        requestId: 'req_photo_modules_shrink_debug',
        analysis: makeAnalysisFixture(),
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        photoNotice: 'notice',
        diagnosisInternal: makeDiagnosisInternalWithFaceCropFixture(),
        profileSummary: { barrierStatus: 'impaired', sensitivity: 'high' },
        language: 'EN',
        ingredientRecEnabled: true,
        productRecEnabled: false,
        internalTestMode: true,
      });
      unloadPhotoModules(loaded.moduleId);
      assert.ok(built && built.card && built.card.payload);
      const payload = built.card.payload;
      assert.ok(payload.internal_debug && payload.internal_debug.shrink_factors_used);
      const factors = payload.internal_debug.shrink_factors_used;
      assert.equal(factors.chin, 0.8);
      assert.equal(factors.forehead, 0.88);
      assert.equal(factors.left_cheek, 0.9);
      assert.equal(factors.right_cheek, 0.9);
      assert.equal(factors.under_eye_left, 0.95);
      assert.equal(factors.under_eye_right, 0.95);
      assert.equal(factors.nose, 0.95);
    },
  ));
