const { runSkinStateSelectionSkill } = require('./skills/skinStateSelectionSkill');
const { runPhotoCaptureQualitySkill } = require('./skills/photoCaptureQualitySkill');
const { runPhotoSkinAnalysisSkill } = require('./skills/photoSkinAnalysisSkill');
const { runPhotoRegionSelectionSkill } = require('./skills/photoRegionSelectionSkill');
const { runAnalysisSummaryBuilderSkill } = require('./skills/analysisSummaryBuilderSkill');
const { runIngredientRecommendationSkill } = require('./skills/ingredientRecommendationSkill');
const { runProductRecommendationSkill } = require('./skills/productRecommendationSkill');
const { emitSkillTelemetry } = require('./telemetryExperiment');

async function runDiagnosisOrchestrator({
  requestContext,
  logger = null,
  mode = 'analysis',
  input = {},
} = {}) {
  const skills = {};
  const executionOrder = [];

  const runAndTrack = async (skillKey, runner, payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const result = await runner({
      requestContext,
      logger,
      ...payload,
    });
    skills[skillKey] = result;
    executionOrder.push(skillKey);
    emitSkillTelemetry({ logger, requestContext, result });
    return result;
  };

  if (input.skinStateSelection) {
    await runAndTrack('skin_state_selection', runSkinStateSelectionSkill, input.skinStateSelection);
  }
  if (input.photoCaptureQuality) {
    await runAndTrack('photo_capture_quality', runPhotoCaptureQualitySkill, input.photoCaptureQuality);
  }
  if (input.photoSkinAnalysis) {
    await runAndTrack('photo_skin_analysis', runPhotoSkinAnalysisSkill, input.photoSkinAnalysis);
  }
  if (input.photoRegionSelection) {
    await runAndTrack('photo_region_selection', runPhotoRegionSelectionSkill, input.photoRegionSelection);
  }
  if (input.analysisSummaryBuilder) {
    await runAndTrack('analysis_summary_builder', runAnalysisSummaryBuilderSkill, input.analysisSummaryBuilder);
  }
  if (input.ingredientRecommendation) {
    await runAndTrack('ingredient_recommendation', runIngredientRecommendationSkill, input.ingredientRecommendation);
  }
  if (input.productRecommendation) {
    await runAndTrack('product_recommendation', runProductRecommendationSkill, input.productRecommendation);
  }

  const allResults = Object.values(skills);
  const successCount = allResults.filter((item) => item && item.ok).length;
  const failCount = allResults.length - successCount;

  return {
    mode: String(mode || 'analysis').trim() || 'analysis',
    request_id: requestContext && requestContext.request_id ? String(requestContext.request_id) : null,
    trace_id: requestContext && requestContext.trace_id ? String(requestContext.trace_id) : null,
    execution_order: executionOrder,
    skills,
    summary: {
      total: allResults.length,
      succeeded: successCount,
      failed: failCount,
    },
  };
}

module.exports = {
  runDiagnosisOrchestrator,
};

