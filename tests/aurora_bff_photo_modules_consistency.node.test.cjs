const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');

test('photo consistency: quality fail forces used_photos=false and unavailable status', () => {
  const cards = [
    {
      card_id: 'pm_1',
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'fail',
        modules: [{ module_id: 'forehead', issues: [] }],
      },
    },
    {
      card_id: 'as_1',
      type: 'analysis_summary',
      payload: {
        used_photos: true,
        analysis_source: 'vision_gemini',
        quality_report: { photo_quality: { grade: 'fail' } },
      },
    },
  ];

  const out = __internal.applyPhotoClaimConsistency(cards);
  const analysisCard = out.find((card) => card && card.type === 'analysis_summary');
  assert.equal(analysisCard.payload.used_photos, false);
  assert.equal(analysisCard.payload.photo_analysis_status, 'unavailable');
  assert.equal(analysisCard.payload.photo_analysis_reason, 'photo_quality_fail');
  assert.equal(
    Array.isArray(analysisCard.field_missing) &&
      analysisCard.field_missing.some((row) => row && row.field === 'analysis.used_photos' && row.reason === 'photo_quality_fail'),
    true,
  );
});

test('photo consistency: missing photo modules forces used_photos=false', () => {
  const cards = [
    {
      card_id: 'as_2',
      type: 'analysis_summary',
      payload: {
        used_photos: true,
        analysis_source: 'vision_gemini',
        quality_report: { photo_quality: { grade: 'pass' } },
      },
    },
  ];

  const out = __internal.applyPhotoClaimConsistency(cards);
  const analysisCard = out[0];
  assert.equal(analysisCard.payload.used_photos, false);
  assert.equal(analysisCard.payload.photo_analysis_status, 'unavailable');
  assert.equal(analysisCard.payload.photo_analysis_reason, 'photo_modules_missing');
});

test('photo consistency: non-photo summary is not forced to photo_modules_missing', () => {
  const cards = [
    {
      card_id: 'as_3',
      type: 'analysis_summary',
      payload: {
        used_photos: false,
        analysis_source: 'rules_only_fallback',
      },
    },
  ];

  const out = __internal.applyPhotoClaimConsistency(cards);
  const analysisCard = out[0];
  assert.equal(analysisCard.payload.used_photos, false);
  assert.equal('photo_analysis_status' in analysisCard.payload, false);
  assert.equal('photo_analysis_reason' in analysisCard.payload, false);
});

test('photo consistency: photo_modules_v1 includes mask overlay capability marker', () => {
  const cards = [
    {
      card_id: 'pm_3',
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'pass',
        modules: [],
      },
    },
  ];
  const out = __internal.applyPhotoClaimConsistency(cards);
  const marker = out[0]?.payload?.render_capabilities?.mask_overlay_enabled;
  assert.equal(typeof marker, 'boolean');
});
