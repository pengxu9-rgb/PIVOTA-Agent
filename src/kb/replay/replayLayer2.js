const { z } = require('zod');

const { loadTechniqueKB } = require('../../layer2/kb/loadTechniqueKB');
const { renderSkeletonFromKB } = require('../../layer2/personalization/renderSkeletonFromKB');
const { renderAdjustmentFromSkeleton } = require('../../layer2/personalization/rephraseAdjustments');
const { AdjustmentSkeletonV0Schema } = require('../../layer2/schemas/adjustmentSkeletonV0');

const ReplayCandidateLineSchema = z
  .object({
    jobId: z.string().min(1),
    clusterKey: z.string().optional(),
    priority: z.number().optional(),
    count: z.number().optional(),
    market: z.enum(['US', 'JP']).optional(),
  })
  .passthrough();

function orderSkeletonsByArea(skeletons) {
  const byArea = {
    base: skeletons.find((s) => s.impactArea === 'base'),
    eye: skeletons.find((s) => s.impactArea === 'eye'),
    lip: skeletons.find((s) => s.impactArea === 'lip'),
  };
  if (!byArea.base || !byArea.eye || !byArea.lip) throw new Error('Expected one skeleton per impactArea.');
  return [byArea.base, byArea.eye, byArea.lip];
}

function extractMissingTechniqueIds(warnings) {
  const out = [];
  for (const w of Array.isArray(warnings) ? warnings : []) {
    const m = String(w).match(/^Missing technique card:\s+(\S+)/);
    if (m) out.push(m[1]);
  }
  return Array.from(new Set(out)).sort();
}

function buildDeterministicStepsFromAdjustments({ market, locale, adjustments }) {
  const baseDo = adjustments.find((a) => a.impactArea === 'base')?.do || 'Apply a thin base layer.';
  const eyeDo = adjustments.find((a) => a.impactArea === 'eye')?.do || 'Apply a controlled liner.';
  const lipDo = adjustments.find((a) => a.impactArea === 'lip')?.do || 'Match lip finish and shade family.';
  return [
    { impactArea: 'base', title: 'Prep base', instruction: 'Prep skin and apply primer as needed.' },
    { impactArea: 'base', title: 'Apply base', instruction: baseDo },
    { impactArea: 'base', title: 'Set strategically', instruction: 'Set only where needed to keep the intended finish.' },
    { impactArea: 'eye', title: 'Map eye shape', instruction: 'Map the eye emphasis based on the reference intent.' },
    { impactArea: 'eye', title: 'Apply liner/shadow', instruction: eyeDo },
    { impactArea: 'eye', title: 'Blend edges', instruction: 'Blend edges softly to match the reference finish.' },
    { impactArea: 'lip', title: 'Prep lips', instruction: 'Prep lips and remove excess balm before color.' },
    { impactArea: 'lip', title: 'Apply lip', instruction: lipDo },
  ].map((s, idx) => ({
    ...s,
    market,
    locale,
    stepId: `replay_step_${idx}`,
    order: idx,
  }));
}

function replayFromAdjustmentSkeletons({ market, locale, skeletons }) {
  const parsed = orderSkeletonsByArea(skeletons.map((s) => AdjustmentSkeletonV0Schema.parse(s)));
  const kb = loadTechniqueKB(market);
  const rendered = renderSkeletonFromKB(parsed, kb, { market });
  const missingTechniqueIds = extractMissingTechniqueIds(rendered.warnings);

  const adjustments = rendered.skeletons.map((s) => renderAdjustmentFromSkeleton(s));
  const anyLowConfidence = adjustments.some((a) => a.confidence === 'low');
  const steps = buildDeterministicStepsFromAdjustments({ market, locale, adjustments });

  const usedTechniques = [];
  for (const sk of rendered.skeletons) {
    if (Array.isArray(sk.techniqueRefs)) {
      for (const t of sk.techniqueRefs) usedTechniques.push({ id: t.id, area: t.area });
    }
  }
  const usedTechniquesSorted = usedTechniques
    .map((t) => ({ id: String(t.id), area: t.area }))
    .sort((a, b) => a.area.localeCompare(b.area) || a.id.localeCompare(b.id));

  return {
    ok: true,
    market,
    locale,
    kbFallbackUsed: Boolean(rendered.usedFallback),
    missingTechniqueIds,
    anyLowConfidence,
    usedTechniques: usedTechniquesSorted,
    adjustments,
    steps,
    warnings: rendered.warnings || [],
  };
}

function replayFromOutcomeSample(sample, marketOverride) {
  const market = marketOverride || sample.market;
  const locale = String(sample.locale || 'en').trim() || 'en';
  const skeletons = sample?.replayContext?.adjustmentSkeletons;
  if (!Array.isArray(skeletons) || skeletons.length === 0) {
    return { ok: false, reason: 'missing_replay_context' };
  }
  return replayFromAdjustmentSkeletons({ market, locale, skeletons });
}

module.exports = {
  ReplayCandidateLineSchema,
  replayFromOutcomeSample,
  replayFromAdjustmentSkeletons,
  extractMissingTechniqueIds,
};

