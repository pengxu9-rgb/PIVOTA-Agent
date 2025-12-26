const { z } = require('zod');

const { AdjustmentSkeletonV0Schema } = require('../../schemas/adjustmentSkeletonV0');
const { LookSpecV0Schema } = require('../../schemas/lookSpecV0');

const { US_ADJUSTMENT_RULES, US_ADJUSTMENT_FALLBACK_RULES } = require('./usAdjustmentRules');

const PreferenceModeSchema = z.enum(['structure', 'vibe', 'ease']);

function runAdjustmentRulesUS(input) {
  const lookSpec = LookSpecV0Schema.parse(input.lookSpec);
  if (lookSpec.market !== 'US') throw new Error('runAdjustmentRulesUS only supports market=US.');

  const preferenceMode = PreferenceModeSchema.parse(input.preferenceMode);

  const ctx = {
    userFaceProfile: input.userFaceProfile ?? null,
    refFaceProfile: input.refFaceProfile ?? null,
    similarityReport: input.similarityReport ?? null,
    lookSpec,
    preferenceMode,
  };

  const outByArea = {};
  const areas = ['base', 'eye', 'lip'];
  for (const area of areas) {
    const candidates = US_ADJUSTMENT_RULES.filter((r) => r.impactArea === area && r.matches(ctx));
    let chosen = null;
    if (candidates.length) {
      const built = candidates.map((r) => r.build(ctx));
      if (preferenceMode === 'ease') {
        const sorted = candidates
          .map((r, idx) => ({ r, idx }))
          .sort((a, b) => a.r.difficulty - b.r.difficulty || a.r.ruleId.localeCompare(b.r.ruleId));
        chosen = built[sorted[0].idx];
      } else {
        const sorted = built
          .map((s) => AdjustmentSkeletonV0Schema.parse(s))
          .sort((a, b) => b.severity - a.severity || a.ruleId.localeCompare(b.ruleId));
        chosen = sorted[0];
      }
    } else {
      chosen = US_ADJUSTMENT_FALLBACK_RULES[area].build(ctx);
    }

    outByArea[area] = AdjustmentSkeletonV0Schema.parse(chosen);
  }

  return [outByArea.base, outByArea.eye, outByArea.lip];
}

module.exports = {
  runAdjustmentRulesUS,
};
