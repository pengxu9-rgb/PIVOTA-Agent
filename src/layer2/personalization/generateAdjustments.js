const { LookSpecV0Schema } = require('../schemas/lookSpecV0');

const { FaceProfileV0Schema } = require('../../layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../../layer1/schemas/similarityReportV0');

const { runAdjustmentRulesUS } = require('./rules/runAdjustmentRulesUS');
const { Layer2AdjustmentV0Schema, rephraseAdjustments } = require('./rephraseAdjustments');
const { loadTechniqueKBUS } = require('../kb/loadTechniqueKBUS');
const { renderSkeletonFromKB } = require('./renderSkeletonFromKB');

async function generateAdjustments(input) {
  if (input.market !== 'US') throw new Error('Only market=US is supported for Layer2 personalization.');

  const locale = String(input.locale || 'en').trim() || 'en';
  const lookSpec = LookSpecV0Schema.parse(input.lookSpec);
  const userFace = input.userFaceProfile == null ? null : FaceProfileV0Schema.parse(input.userFaceProfile);
  const refFace = input.refFaceProfile == null ? null : FaceProfileV0Schema.parse(input.refFaceProfile);
  const similarityReport =
    input.similarityReport == null ? null : SimilarityReportV0Schema.parse(input.similarityReport);
  const warnings = [];
  if (refFace == null) warnings.push('Missing refFaceProfile: rules will use safer defaults.');
  if (userFace == null) warnings.push('Missing userFaceProfile: rules will use safer defaults.');

  const preferenceMode = input.preferenceMode ?? (similarityReport ? String(similarityReport.preferenceMode || 'structure') : 'structure');

  const skeletons = runAdjustmentRulesUS({
    userFaceProfile: userFace,
    refFaceProfile: refFace,
    similarityReport,
    lookSpec,
    preferenceMode,
  });

  const kb = loadTechniqueKBUS();
  const rendered = renderSkeletonFromKB(skeletons, kb, {
    userFaceProfile: userFace,
    refFaceProfile: refFace,
    similarityReport,
    lookSpec,
    preferenceMode,
  });
  warnings.push(...(rendered.warnings || []));

  const rephrased = await rephraseAdjustments({
    market: 'US',
    locale,
    skeletons: rendered.skeletons,
    provider: input.provider,
  });

  const parsed = rephrased.adjustments.map((a) => Layer2AdjustmentV0Schema.parse(a));
  for (const a of parsed) {
    if (!a.evidence?.length) {
      warnings.push(`Adjustment ${a.impactArea} missing evidence: using skeleton evidenceKeys.`);
      const sk = rendered.skeletons.find((s) => s.impactArea === a.impactArea);
      if (sk) a.evidence = sk.evidenceKeys;
    }
  }
  warnings.push(...(rephrased.warnings || []));
  return { adjustments: parsed, warnings };
}

module.exports = {
  generateAdjustments,
  Layer2AdjustmentV0Schema,
};
