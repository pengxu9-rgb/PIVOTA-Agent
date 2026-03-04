const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeReportFailureReason,
  deriveSkinDegradeMeta,
} = require('../src/auroraBff/skinDegradeMeta');

test('skin degrade meta: dual failure preserves both reasons and prioritizes report_model_error', () => {
  const out = deriveSkinDegradeMeta({
    renderedAnalysisSource: 'diagnosis_v1_template',
    photoFailureCode: null,
    visionDecisionForReport: {
      decision: 'fallback',
      reasons: ['VISION_UNKNOWN', 'VISION_CV_FALLBACK_USED'],
    },
    reportModelErrored: true,
    reportModelErrorReason: 'TIMEOUT',
  });

  assert.equal(out.degradeReason, 'report_model_error');
  assert.equal(out.visionFailureReason, 'VISION_UNKNOWN');
  assert.equal(out.reportFailureReason, 'TIMEOUT');
});

test('skin degrade meta: vision-only fallback keeps vision reason', () => {
  const out = deriveSkinDegradeMeta({
    renderedAnalysisSource: 'diagnosis_v1_template',
    photoFailureCode: null,
    visionDecisionForReport: {
      decision: 'fallback',
      reasons: ['VISION_UPSTREAM_5XX'],
    },
    reportModelErrored: false,
    reportModelErrorReason: null,
  });

  assert.equal(out.degradeReason, 'VISION_UPSTREAM_5XX');
  assert.equal(out.visionFailureReason, 'VISION_UPSTREAM_5XX');
  assert.equal(out.reportFailureReason, null);
});

test('skin degrade meta: photo-qc fallback keeps photo degrade reason even if report errored', () => {
  const out = deriveSkinDegradeMeta({
    renderedAnalysisSource: 'rule_based_with_photo_qc',
    photoFailureCode: 'DOWNLOAD_URL_FETCH_4XX',
    visionDecisionForReport: {
      decision: 'fallback',
      reasons: ['VISION_IMAGE_FETCH_FAILED'],
    },
    reportModelErrored: true,
    reportModelErrorReason: 'SCHEMA_INVALID',
  });

  assert.equal(out.degradeReason, 'photo_download_url_fetch_4xx');
  assert.equal(out.visionFailureReason, 'VISION_IMAGE_FETCH_FAILED');
  assert.equal(out.reportFailureReason, 'SCHEMA_INVALID');
});

test('normalize report failure reason: maps and sanitizes', () => {
  assert.equal(normalizeReportFailureReason('report_output_invalid'), 'SCHEMA_INVALID');
  assert.equal(normalizeReportFailureReason(' upstream-5xx '), 'UPSTREAM_5XX');
  assert.equal(normalizeReportFailureReason(''), null);
});
