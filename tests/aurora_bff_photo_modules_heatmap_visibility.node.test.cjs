const test = require('node:test');
const assert = require('node:assert/strict');

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
  } catch (err) {
    restore();
    throw err;
  }
}

function loadPhotoModulesBuilder() {
  const moduleId = require.resolve('../src/auroraBff/photoModulesV1');
  delete require.cache[moduleId];
  return require('../src/auroraBff/photoModulesV1').buildPhotoModulesCard;
}

function buildDiagnosisInternalFixture() {
  return {
    orig_size_px: { w: 1080, h: 1440 },
    skin_bbox_norm: { x0: 0.18, y0: 0.1, x1: 0.84, y1: 0.9 },
    face_crop_margin_scale: 1.2,
  };
}

function zeroHeatmapValues(w, h) {
  return Array.from({ length: w * h }, () => 0);
}

function hotspotHeatmapValues(w, h) {
  const values = [];
  const centerX = (w - 1) / 2;
  const centerY = (h - 1) / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x - centerX) / Math.max(1, w / 3);
      const ny = (y - centerY) / Math.max(1, h / 3);
      const radius = Math.sqrt((nx * nx) + (ny * ny));
      const value = radius <= 1 ? 0.85 - (radius * 0.3) : 0.16;
      values.push(Math.max(0, Math.min(1, value)));
    }
  }
  return values;
}

function collectEvidenceRegionIds(payload) {
  const ids = new Set();
  for (const moduleRow of Array.isArray(payload && payload.modules) ? payload.modules : []) {
    for (const issue of Array.isArray(moduleRow && moduleRow.issues) ? moduleRow.issues : []) {
      for (const evidenceId of Array.isArray(issue && issue.evidence_region_ids) ? issue.evidence_region_ids : []) {
        ids.add(String(evidenceId));
      }
    }
  }
  return ids;
}

function maxHeatmapValue(heatmap) {
  const values = Array.isArray(heatmap && heatmap.values) ? heatmap.values : [];
  return values.reduce((max, value) => Math.max(max, Number(value) || 0), 0);
}

test('photo modules heatmap visibility: low-signal heatmap is replaced by bbox proxy and selected by evidence', () =>
  withEnv(
    {
      DIAG_HEATMAP_LOW_SIGNAL_PROXY_ENABLED: 'true',
      DIAG_HEATMAP_LOW_SIGNAL_MAX_THRESHOLD: '0.2',
      DIAG_HEATMAP_LOW_SIGNAL_P90_THRESHOLD: '0.12',
    },
    () => {
      const buildPhotoModulesCard = loadPhotoModulesBuilder();
      const built = buildPhotoModulesCard({
        requestId: 'req_low_signal_proxy_case',
        analysis: {
          photo_findings: [
            {
              finding_id: 'pf_low_signal',
              issue_type: 'redness',
              severity: 3,
              confidence: 0.82,
              geometry: {
                bbox: { x: 0.18, y: 0.2, w: 0.56, h: 0.56 },
                heatmap: {
                  grid: { w: 8, h: 8 },
                  values: zeroHeatmapValues(8, 8),
                },
              },
            },
          ],
        },
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        diagnosisInternal: buildDiagnosisInternalFixture(),
        language: 'EN',
        ingredientRecEnabled: false,
        productRecEnabled: false,
      });

      assert.ok(built && built.card && built.card.payload);
      const payload = built.card.payload;
      const proxyRegion = (payload.regions || []).find((region) => region.region_id === 'pf_low_signal_heatmap_proxy');
      assert.ok(proxyRegion, 'expected proxy heatmap region');
      assert.equal(proxyRegion.type, 'heatmap');
      assert.equal(Array.isArray(proxyRegion.notes), true);
      assert.equal(proxyRegion.notes.includes('heatmap_from_bbox_proxy'), true);
      assert.equal(proxyRegion.notes.includes('heatmap_low_signal_replaced'), true);

      const rawHeatmapRegion = (payload.regions || []).find((region) => region.region_id === 'pf_low_signal_heatmap');
      assert.equal(rawHeatmapRegion, undefined);

      const evidenceIds = collectEvidenceRegionIds(payload);
      assert.equal(evidenceIds.has('pf_low_signal_heatmap_proxy'), true);
      assert.equal(evidenceIds.has('pf_low_signal_heatmap'), false);
      assert.ok(maxHeatmapValue(proxyRegion.heatmap) >= 0.2);
    },
  ));

test('photo modules heatmap visibility: high-signal heatmap keeps original region', () =>
  withEnv(
    {
      DIAG_HEATMAP_LOW_SIGNAL_PROXY_ENABLED: 'true',
      DIAG_HEATMAP_LOW_SIGNAL_MAX_THRESHOLD: '0.2',
      DIAG_HEATMAP_LOW_SIGNAL_P90_THRESHOLD: '0.12',
    },
    () => {
      const buildPhotoModulesCard = loadPhotoModulesBuilder();
      const built = buildPhotoModulesCard({
        requestId: 'req_high_signal_keep_case',
        analysis: {
          photo_findings: [
            {
              finding_id: 'pf_high_signal',
              issue_type: 'texture',
              severity: 2,
              confidence: 0.78,
              geometry: {
                bbox: { x: 0.2, y: 0.24, w: 0.5, h: 0.52 },
                heatmap: {
                  grid: { w: 8, h: 8 },
                  values: hotspotHeatmapValues(8, 8),
                },
              },
            },
          ],
        },
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        diagnosisInternal: buildDiagnosisInternalFixture(),
        language: 'EN',
        ingredientRecEnabled: false,
        productRecEnabled: false,
      });

      assert.ok(built && built.card && built.card.payload);
      const payload = built.card.payload;
      const rawHeatmapRegion = (payload.regions || []).find((region) => region.region_id === 'pf_high_signal_heatmap');
      assert.ok(rawHeatmapRegion, 'expected original heatmap region');
      const proxyRegion = (payload.regions || []).find((region) => region.region_id === 'pf_high_signal_heatmap_proxy');
      assert.equal(proxyRegion, undefined);
    },
  ));

test('photo modules heatmap visibility: low-signal replacement can be disabled by env', () =>
  withEnv(
    {
      DIAG_HEATMAP_LOW_SIGNAL_PROXY_ENABLED: 'false',
      DIAG_HEATMAP_LOW_SIGNAL_MAX_THRESHOLD: '0.2',
      DIAG_HEATMAP_LOW_SIGNAL_P90_THRESHOLD: '0.12',
    },
    () => {
      const buildPhotoModulesCard = loadPhotoModulesBuilder();
      const built = buildPhotoModulesCard({
        requestId: 'req_low_signal_proxy_off_case',
        analysis: {
          photo_findings: [
            {
              finding_id: 'pf_low_signal_off',
              issue_type: 'shine',
              severity: 2,
              confidence: 0.7,
              geometry: {
                bbox: { x: 0.24, y: 0.26, w: 0.46, h: 0.48 },
                heatmap: {
                  grid: { w: 8, h: 8 },
                  values: zeroHeatmapValues(8, 8),
                },
              },
            },
          ],
        },
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        diagnosisInternal: buildDiagnosisInternalFixture(),
        language: 'EN',
        ingredientRecEnabled: false,
        productRecEnabled: false,
      });

      assert.ok(built && built.card && built.card.payload);
      const payload = built.card.payload;
      const rawHeatmapRegion = (payload.regions || []).find((region) => region.region_id === 'pf_low_signal_off_heatmap');
      assert.ok(rawHeatmapRegion, 'expected original low-signal heatmap when proxy is disabled');
      const proxyRegion = (payload.regions || []).find((region) => region.region_id === 'pf_low_signal_off_heatmap_proxy');
      assert.equal(proxyRegion, undefined);
    },
  ));
