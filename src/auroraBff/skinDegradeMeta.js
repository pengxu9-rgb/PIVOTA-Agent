const { normalizeVisionReason, pickPrimaryVisionReason } = require('./visionPolicy');

function normalizeReportFailureReason(reason) {
  const token = String(reason || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!token) return null;

  if (token === 'REPORT_OUTPUT_INVALID') return 'SCHEMA_INVALID';
  if (token === 'REPORT_SEMANTIC_INVALID') return 'SEMANTIC_INVALID';
  return token;
}

function deriveSkinDegradeMeta({
  renderedAnalysisSource,
  photoFailureCode,
  visionDecisionForReport,
  reportModelErrored,
  reportModelErrorReason,
} = {}) {
  const visionFailureReason =
    visionDecisionForReport && visionDecisionForReport.decision === 'fallback'
      ? normalizeVisionReason(pickPrimaryVisionReason(visionDecisionForReport.reasons)) || 'VISION_FALLBACK'
      : null;
  const reportFailureReason = reportModelErrored
    ? normalizeReportFailureReason(reportModelErrorReason) || 'UNKNOWN'
    : null;

  const degradeReason = (() => {
    if (renderedAnalysisSource === 'baseline_low_confidence') return 'baseline_low_confidence';
    if (renderedAnalysisSource === 'retake') return 'photo_quality_fail';
    if (renderedAnalysisSource === 'rule_based_with_photo_qc') {
      if (photoFailureCode === 'MISSING_PRIMARY_INPUT') return 'missing_primary_input';
      if (photoFailureCode) return `photo_${String(photoFailureCode).trim().toLowerCase()}`;
      return 'photo_qc_degraded';
    }
    if (reportFailureReason) return 'report_model_error';
    if (visionFailureReason) return visionFailureReason;
    return null;
  })();

  return {
    degradeReason,
    visionFailureReason,
    reportFailureReason,
  };
}

module.exports = {
  normalizeReportFailureReason,
  deriveSkinDegradeMeta,
};
