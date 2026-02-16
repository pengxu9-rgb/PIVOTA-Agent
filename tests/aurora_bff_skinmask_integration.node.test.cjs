const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');
const {
  bboxNormToMask,
  decodeRleBinary,
  encodeRleBinary,
  leakageScore,
  coverageScore,
  countOnes,
} = require('../src/auroraBff/evalAdapters/common/metrics');

function buildAnalysisFixture() {
  return {
    photo_findings: [
      {
        finding_id: 'pf_redness_skinmask_case',
        issue_type: 'redness',
        severity: 3,
        confidence: 0.82,
        geometry: {
          bbox: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
        },
      },
    ],
  };
}

function buildDiagnosisInternalFixture() {
  return {
    orig_size_px: { w: 1080, h: 1440 },
    skin_bbox_norm: { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9 },
    face_crop_margin_scale: 1.2,
  };
}

function buildDiagnosisInternalWithFaceCropFixture() {
  return {
    ...buildDiagnosisInternalFixture(),
    face_crop: {
      coord_space: 'orig_px_v1',
      bbox_px: { x: 108, y: 120, w: 864, h: 1200 },
      orig_size_px: { w: 1080, h: 1440 },
      render_size_px_hint: { w: 384, h: 512 },
    },
  };
}

function getModuleMask(payload, moduleId, gridSize = 64) {
  const row = Array.isArray(payload && payload.modules) ? payload.modules.find((item) => item.module_id === moduleId) : null;
  assert.ok(row, `module ${moduleId} should exist`);
  assert.equal(row.mask_grid, gridSize);
  assert.equal(typeof row.mask_rle_norm, 'string');
  const decoded = decodeRleBinary(row.mask_rle_norm, gridSize * gridSize);
  assert.ok(decoded instanceof Uint8Array);
  return decoded;
}

function getModuleBox(payload, moduleId) {
  const row = Array.isArray(payload && payload.modules) ? payload.modules.find((item) => item.module_id === moduleId) : null;
  assert.ok(row && row.box, `module ${moduleId} should include box`);
  return row.box;
}

function unionBoxesMask(boxes, gridSize = 64) {
  const out = new Uint8Array(gridSize * gridSize);
  for (const box of Array.isArray(boxes) ? boxes : []) {
    const mask = bboxNormToMask(box, gridSize, gridSize);
    for (let i = 0; i < out.length; i += 1) {
      if (mask[i]) out[i] = 1;
    }
  }
  return out;
}

test('skinmask intersection reduces leakage while preserving coverage and valid geometry', () => {
  const analysis = buildAnalysisFixture();
  const diagnosisInternal = buildDiagnosisInternalFixture();

  const skinMaskGrid = 64;
  const skinMask = bboxNormToMask({ x: 0.2, y: 0.1, w: 0.6, h: 0.8 }, skinMaskGrid, skinMaskGrid);
  const skinMaskPayload = {
    mask_grid: skinMaskGrid,
    mask_rle_norm: encodeRleBinary(skinMask),
  };

  const off = buildPhotoModulesCard({
    requestId: 'skinmask_off_case',
    analysis,
    usedPhotos: true,
    photoQuality: { grade: 'pass', reasons: [] },
    diagnosisInternal,
    language: 'EN',
    ingredientRecEnabled: false,
    productRecEnabled: false,
  });
  const on = buildPhotoModulesCard({
    requestId: 'skinmask_on_case',
    analysis,
    usedPhotos: true,
    photoQuality: { grade: 'pass', reasons: [] },
    diagnosisInternal,
    language: 'EN',
    ingredientRecEnabled: false,
    productRecEnabled: false,
    skinMask: skinMaskPayload,
  });

  assert.ok(off && off.card && off.card.payload);
  assert.ok(on && on.card && on.card.payload);

  const offMask = getModuleMask(off.card.payload, 'forehead', skinMaskGrid);
  const onMask = getModuleMask(on.card.payload, 'forehead', skinMaskGrid);

  assert.ok(countOnes(offMask) > 0);
  assert.ok(countOnes(onMask) > 0);

  const leakageOff = leakageScore(offMask, skinMask);
  const leakageOn = leakageScore(onMask, skinMask);
  assert.ok(leakageOn < leakageOff, `expected leakage to drop: on=${leakageOn}, off=${leakageOff}`);

  const coverageOff = coverageScore(offMask, skinMask);
  const coverageOn = coverageScore(onMask, skinMask);
  assert.ok(coverageOn >= coverageOff - 1e-6, `coverage should not regress: on=${coverageOn}, off=${coverageOff}`);

  const regions = Array.isArray(on.card.payload.regions) ? on.card.payload.regions : [];
  assert.ok(regions.length >= 1);
  for (const region of regions) {
    if (region.bbox) {
      assert.ok(region.bbox.x >= 0 && region.bbox.x <= 1);
      assert.ok(region.bbox.y >= 0 && region.bbox.y <= 1);
      assert.ok(region.bbox.w >= 0 && region.bbox.w <= 1);
      assert.ok(region.bbox.h >= 0 && region.bbox.h <= 1);
    }
  }

  const geometryCounts = Array.isArray(on.metrics && on.metrics.geometryDropCounts) ? on.metrics.geometryDropCounts : [];
  for (const row of geometryCounts) {
    assert.ok(Number(row.count) >= 0);
  }
});

test('dynamic skinmask picks center face component and keeps chin below mouth band', () => {
  const analysis = buildAnalysisFixture();
  const diagnosisInternal = buildDiagnosisInternalWithFaceCropFixture();
  const skinMaskGrid = 64;
  const disjointFaceLike = unionBoxesMask(
    [
      { x: 0.02, y: 0.08, w: 0.28, h: 0.84 },
      { x: 0.45, y: 0.09, w: 0.3, h: 0.8 },
    ],
    skinMaskGrid,
  );
  const skinMaskPayload = {
    mask_grid: skinMaskGrid,
    mask_rle_norm: encodeRleBinary(disjointFaceLike),
  };

  const built = buildPhotoModulesCard({
    requestId: 'skinmask_multi_component_center_pick',
    analysis,
    usedPhotos: true,
    photoQuality: { grade: 'pass', reasons: [] },
    diagnosisInternal,
    language: 'EN',
    ingredientRecEnabled: false,
    productRecEnabled: false,
    skinMask: skinMaskPayload,
    internalTestMode: true,
  });
  assert.ok(built && built.card && built.card.payload);
  const payload = built.card.payload;
  assert.ok(payload.internal_debug);
  assert.equal(payload.internal_debug.module_box_mode, 'dynamic_skinmask');
  assert.equal(payload.internal_debug.module_box_dynamic_applied, true);
  assert.equal(payload.internal_debug.face_oval_mask_source, 'skinmask_component');
  assert.ok(Number(payload.internal_debug.face_oval_component_count) >= 2);

  const anchors = payload.internal_debug.module_box_anchors || {};
  assert.ok(anchors.face_center && Number(anchors.face_center.x) > 0.42);

  const noseBox = getModuleBox(payload, 'nose');
  const chinBox = getModuleBox(payload, 'chin');
  const noseCenterX = Number(noseBox.x) + Number(noseBox.w) / 2;
  assert.ok(noseCenterX > 0.42, `nose should stay on center component, got x=${noseCenterX}`);
  assert.ok(Number(chinBox.y) > Number(noseBox.y) + (Number(noseBox.h) * 0.65));

  const mouthY = Number(anchors.mouth_row && anchors.mouth_row.y);
  if (Number.isFinite(mouthY)) {
    assert.ok(Number(chinBox.y) >= mouthY + 0.02, `chin should be below mouth anchor, chinY=${chinBox.y}, mouthY=${mouthY}`);
  }
});
