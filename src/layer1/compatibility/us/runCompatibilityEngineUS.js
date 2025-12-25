const { SimilarityReportV0Schema } = require('../../schemas/similarityReportV0');
const { computeDeltasUS } = require('./computeDeltas');
const { scoreFitUS } = require('./scoreFit');
const { selectAdjustmentsUS } = require('./selectAdjustments');
const { buildReasonsUS } = require('./buildReasons');

const userControls = {
  modes: [
    { mode: 'structure', label: 'Structure', description: 'Prioritize facial structure alignment.' },
    { mode: 'vibe', label: 'Vibe', description: 'Prioritize the overall vibe and adaptable emphasis.' },
    { mode: 'ease', label: 'Ease', description: 'Prioritize low-risk, easy-to-replicate adjustments.' },
  ],
  defaultMode: 'structure',
};

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function runCompatibilityEngineUS({ market, preferenceMode, userFaceProfile, refFaceProfile, locale }) {
  if (market !== 'US') throw new Error('US-only engine');
  if (refFaceProfile.market !== 'US') throw new Error('Reference FaceProfile market mismatch');
  if (userFaceProfile && userFaceProfile.market !== 'US') throw new Error('User FaceProfile market mismatch');

  const deltas = computeDeltasUS({ userFace: userFaceProfile || null, refFace: refFaceProfile });
  const scored = scoreFitUS({ preferenceMode, userFace: userFaceProfile || null, refFace: refFaceProfile, deltas });
  const selected = selectAdjustmentsUS({ preferenceMode, userFace: userFaceProfile || null, refFace: refFaceProfile, deltas });
  const reasons = buildReasonsUS({ preferenceMode, userFace: userFaceProfile || null, refFace: refFaceProfile, fitScore: scored.fitScore, deltas, locale });

  const topDeltas = [...deltas]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 5)
    .map((d) => ({
      key: d.key,
      userValue: d.userValue,
      refValue: d.refValue,
      severity: clamp01(d.severity),
      explanationKey: d.explanationKey,
      evidence: d.evidence,
    }));

  const report = {
    version: 'v0',
    market: 'US',
    preferenceMode,
    confidence: scored.confidence,
    fitScore: scored.fitScore,
    scoreBreakdown: scored.scoreBreakdown,
    reasons,
    topDeltas,
    adjustments: selected.adjustments,
    layer2Hints: {
      base: selected.adjustments.filter((a) => a.impactArea === 'base').map(() => 'base.finish.match_reference'),
      eye: selected.adjustments.filter((a) => a.impactArea === 'eye').map(() => 'eye.liner.direction.match_reference'),
      lip: selected.adjustments.filter((a) => a.impactArea === 'lip').map(() => 'lip.finish.match_reference'),
    },
    userControls,
    warnings: [...(scored.warnings || []), ...(selected.warnings || [])].length
      ? [...(scored.warnings || []), ...(selected.warnings || [])]
      : undefined,
  };

  return SimilarityReportV0Schema.parse(report);
}

module.exports = { runCompatibilityEngineUS };

