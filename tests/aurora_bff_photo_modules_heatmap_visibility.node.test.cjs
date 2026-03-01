const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPhotoModulesCard } = require('../src/auroraBff/photoModulesV1');

function buildDiagnosisInternalFixture() {
  return {
    orig_size_px: { w: 1080, h: 1440 },
    skin_bbox_norm: { x0: 0.18, y0: 0.1, x1: 0.84, y1: 0.9 },
    face_crop_margin_scale: 1.2,
  };
}

function summarizeHeatmap(values) {
  const normalized = Array.isArray(values)
    ? values.map((value) => Math.max(0, Math.min(1, Number(value) || 0)))
    : [];
  if (!normalized.length) return { max: 0, p90: 0 };
  normalized.sort((a, b) => a - b);
  const p90Index = Math.min(normalized.length - 1, Math.floor(0.9 * (normalized.length - 1)));
  return {
    max: normalized[normalized.length - 1],
    p90: normalized[p90Index],
  };
}

test('photo modules: low-signal heatmap is replaced by proxy with visibility floor', () => {
  const built = buildPhotoModulesCard({
    requestId: 'heatmap_visibility_proxy_floor',
    analysis: {
      photo_findings: [
        {
          finding_id: 'pf_low_signal',
          issue_type: 'shine',
          severity: 2,
          confidence: 0.66,
          geometry: {
            bbox: { x: 0.4, y: 0.3, w: 0.22, h: 0.22 },
            heatmap: {
              grid: { w: 8, h: 8 },
              values: new Array(8 * 8).fill(0.01),
            },
          },
        },
      ],
    },
    usedPhotos: true,
    photoQuality: { grade: 'degraded', reasons: ['glare'] },
    diagnosisInternal: buildDiagnosisInternalFixture(),
    language: 'EN',
    ingredientRecEnabled: false,
    productRecEnabled: false,
  });

  assert.ok(built && built.card && built.card.payload);
  const payload = built.card.payload;
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const proxyRegion = regions.find((region) => region.region_id === 'pf_low_signal_heatmap_proxy');
  assert.ok(proxyRegion, 'expected low-signal heatmap to be replaced by proxy');
  assert.equal(String(proxyRegion.signal_stats && proxyRegion.signal_stats.source), 'proxy');
  const stats = summarizeHeatmap(proxyRegion.heatmap && proxyRegion.heatmap.values);
  assert.ok(stats.max >= 0.55, `proxy max too low: ${stats.max}`);
  assert.ok(stats.p90 >= 0.18, `proxy p90 too low: ${stats.p90}`);

  const evidenceRegionIds = payload.modules
    .flatMap((moduleRow) => (Array.isArray(moduleRow.issues) ? moduleRow.issues : []))
    .filter((issue) => issue.issue_type === 'shine')
    .flatMap((issue) => (Array.isArray(issue.evidence_region_ids) ? issue.evidence_region_ids : []));
  assert.ok(evidenceRegionIds.includes('pf_low_signal_heatmap_proxy'));
});

test('photo modules: high-signal raw heatmap keeps raw signal stats', () => {
  const values = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      values.push(Math.min(1, 0.32 + ((x + y) / 14) * 0.48));
    }
  }
  const built = buildPhotoModulesCard({
    requestId: 'heatmap_visibility_raw_signal',
    analysis: {
      photo_findings: [
        {
          finding_id: 'pf_raw_signal',
          issue_type: 'texture',
          severity: 2,
          confidence: 0.73,
          geometry: {
            bbox: { x: 0.25, y: 0.28, w: 0.3, h: 0.3 },
            heatmap: {
              grid: { w: 8, h: 8 },
              values,
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
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const rawRegion = regions.find((region) => region.region_id === 'pf_raw_signal_heatmap');
  assert.ok(rawRegion, 'expected raw heatmap region to remain');
  assert.equal(String(rawRegion.signal_stats && rawRegion.signal_stats.source), 'raw');
  assert.ok(Number(rawRegion.signal_stats && rawRegion.signal_stats.max) >= 0.2);
  assert.ok(Number(rawRegion.signal_stats && rawRegion.signal_stats.p90) >= 0.12);
});
