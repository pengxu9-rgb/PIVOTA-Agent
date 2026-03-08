const { runSkill } = require('./contracts');

async function runPhotoSkinAnalysisSkill({
  requestContext,
  logger,
  imageBuffer,
  language,
  profileSummary,
  recentLogsSummary,
  profiler,
  qualityGateConfig,
  severityThresholdsOverrides,
} = {}) {
  return runSkill({
    skillName: 'photo_skin_analysis',
    stage: 'photo_skin_analysis',
    provider: 'skin_diagnosis_v1',
    requestContext,
    logger,
    run: async () => {
      const skinDiagnosisV1 = require('../skinDiagnosisV1');

      if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
        const err = new Error('image_buffer_missing');
        err.code = 'IMAGE_BUFFER_MISSING';
        err.degrade_to = 'rule_based';
        err.retryable = false;
        throw err;
      }

      const diagnosisResult = await skinDiagnosisV1.runSkinDiagnosisV1({
        imageBuffer,
        language,
        profileSummary,
        recentLogsSummary,
        profiler,
        qualityGateConfig,
        severityThresholdsOverrides,
      });

      if (!diagnosisResult || diagnosisResult.ok !== true || !diagnosisResult.diagnosis) {
        const err = new Error(diagnosisResult && diagnosisResult.reason ? String(diagnosisResult.reason) : 'diagnosis_failed');
        err.code = 'PHOTO_DIAGNOSIS_FAILED';
        err.degrade_to = 'rule_based';
        err.retryable = false;
        throw err;
      }

      const diagnosis = diagnosisResult.diagnosis;
      const diagnosisPolicy = skinDiagnosisV1.summarizeDiagnosisForPolicy(diagnosis);
      const analysisFromDiagnosis = skinDiagnosisV1.buildSkinAnalysisFromDiagnosisV1(diagnosis, { language, profileSummary });

      return {
        diagnosis,
        diagnosis_internal: diagnosisResult.internal || null,
        diagnosis_policy: diagnosisPolicy || null,
        analysis_from_diagnosis: analysisFromDiagnosis || null,
        quality: diagnosis && diagnosis.quality && typeof diagnosis.quality === 'object'
          ? diagnosis.quality
          : null,
      };
    },
  });
}

module.exports = {
  runPhotoSkinAnalysisSkill,
};
