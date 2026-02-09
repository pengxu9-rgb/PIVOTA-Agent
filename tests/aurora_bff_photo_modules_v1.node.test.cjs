const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const { resetVisionMetrics, renderVisionMetricsPrometheus } = require('../src/auroraBff/visionMetrics');

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
