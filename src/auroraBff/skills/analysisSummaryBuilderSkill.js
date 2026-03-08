const { runSkill } = require('./contracts');

function ensureArray(value, max = 8) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max);
}

async function runAnalysisSummaryBuilderSkill({
  requestContext,
  logger,
  analysis,
  lowConfidence = false,
  photosProvided = false,
  photoQc = [],
  usedPhotos = false,
  analysisSource = 'unknown',
  photoNotice = null,
  qualityReport = null,
  diagnosisArtifact = null,
  ingredientPlan = null,
  recommendationReady = false,
  photoPipelineEnabled = false,
} = {}) {
  return runSkill({
    skillName: 'analysis_summary_builder',
    stage: 'analysis_summary_builder',
    provider: 'local_builder',
    requestContext,
    logger,
    run: async () => {
      const payload = {
        analysis: analysis && typeof analysis === 'object' ? analysis : {},
        low_confidence: Boolean(lowConfidence),
        photos_provided: Boolean(photosProvided),
        photo_qc: ensureArray(photoQc, 8),
        used_photos: Boolean(usedPhotos),
        analysis_source: String(analysisSource || 'unknown').trim() || 'unknown',
        ...(photoNotice ? { photo_notice: photoNotice } : {}),
        quality_report:
          qualityReport && typeof qualityReport === 'object'
            ? qualityReport
            : {
                photo_quality: { grade: 'unknown', reasons: [] },
                detector_confidence: 0,
                degraded_mode: 'conservative',
                llm: {
                  vision: { decision: 'skip', reasons: ['quality_report_missing'] },
                  report: { decision: 'skip', reasons: ['quality_report_missing'] },
                },
                reasons: ['quality_report_missing'],
              },
        ...(diagnosisArtifact ? { diagnosis_artifact: diagnosisArtifact } : {}),
        ...(ingredientPlan ? { ingredient_plan: ingredientPlan } : {}),
        recommendation_ready: Boolean(recommendationReady),
        photo_pipeline_enabled: Boolean(photoPipelineEnabled),
      };

      return {
        payload,
        field_missing: analysis && typeof analysis === 'object'
          ? []
          : [{ field: 'analysis', reason: 'analysis_missing' }],
      };
    },
  });
}

module.exports = {
  runAnalysisSummaryBuilderSkill,
};

