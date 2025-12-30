const { normalizeLookSpecToV1 } = require('../schemas/lookSpecV1');

const { FaceProfileV0Schema } = require('../../layer1/schemas/faceProfileV0');
const { SimilarityReportV0Schema } = require('../../layer1/schemas/similarityReportV0');

const { runAdjustmentRulesUS } = require('./rules/runAdjustmentRulesUS');
const { Layer2AdjustmentV0Schema, rephraseAdjustments } = require('./rephraseAdjustments');
const { loadTechniqueKB } = require('../kb/loadTechniqueKB');
const { renderSkeletonFromKB } = require('./renderSkeletonFromKB');

async function generateAdjustments(input) {
  if (input.market !== 'US' && input.market !== 'JP') throw new Error('MARKET_NOT_SUPPORTED');

  const locale = String(input.locale || 'en').trim() || 'en';
  const lookSpec = normalizeLookSpecToV1(input.lookSpec);
  const userFace = input.userFaceProfile == null ? null : FaceProfileV0Schema.parse(input.userFaceProfile);
  const refFace = input.refFaceProfile == null ? null : FaceProfileV0Schema.parse(input.refFaceProfile);
  const similarityReport =
    input.similarityReport == null ? null : SimilarityReportV0Schema.parse(input.similarityReport);
  const userProfile = input.userProfile ?? null;
  const userSignals = input.userSignals ?? null;
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
    userProfile,
    userSignals,
    ...(input.enableExtendedAreas === true ? { enableExtendedAreas: true } : {}),
    ...(input.enableSelfieLookSpec === true ? { enableSelfieLookSpec: true } : {}),
    ...(input.enableTriggerMatching === true ? { enableTriggerMatching: true } : {}),
  });

  const kb = loadTechniqueKB(input.market);
  const rendered = renderSkeletonFromKB(skeletons, kb, {
    market: input.market,
    locale,
    userFaceProfile: userFace,
    refFaceProfile: refFace,
    similarityReport,
    lookSpec,
    preferenceMode,
    userProfile,
    userSignals,
    ...(input.enableTriggerMatching === true ? { enableTriggerMatching: true } : {}),
  });
  warnings.push(...(rendered.warnings || []));

  // Ensure skeletons are tagged to the request market for downstream telemetry/replay.
  const skeletonsForTelemetry = (rendered.allSkeletons ?? rendered.skeletons).map((s) => ({ ...s, market: input.market }));
  const skeletonsForRephrase = rendered.skeletons.map((s) => ({ ...s, market: input.market }));

  const rephrased = await rephraseAdjustments({
    market: input.market,
    locale,
    skeletons: skeletonsForRephrase,
    provider: input.provider,
    promptPack: input.promptPack,
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
  const usedFallback = Boolean(rendered.usedFallback) || Boolean(rephrased.usedFallback);
  return { adjustments: parsed, warnings, usedFallback, skeletons: skeletonsForTelemetry };
}

module.exports = {
  generateAdjustments,
  Layer2AdjustmentV0Schema,
};
