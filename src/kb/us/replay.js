const { loadTechniqueKBUS } = require('../../layer2/kb/loadTechniqueKBUS');
const { renderSkeletonFromKB } = require('../../layer2/personalization/renderSkeletonFromKB');

function replayOutcomeSampleUS(sample) {
  const skeletons = sample?.replayContext?.adjustmentSkeletons;
  if (!Array.isArray(skeletons) || skeletons.length === 0) {
    return {
      ok: false,
      reason: 'missing_replay_context',
    };
  }

  const kb = loadTechniqueKBUS();
  const rendered = renderSkeletonFromKB(skeletons, kb, {});

  const usedTechniques = [];
  for (const sk of rendered.skeletons || []) {
    if (Array.isArray(sk.techniqueRefs)) {
      for (const t of sk.techniqueRefs) usedTechniques.push({ id: t.id, area: t.area });
    }
  }

  return {
    ok: true,
    previous: {
      anyFallbackUsed: Boolean(sample?.qualityFlags?.anyFallbackUsed),
      usedTechniques: sample?.usedTechniques || [],
    },
    replay: {
      kbFallbackUsed: Boolean(rendered.usedFallback),
      usedTechniques,
    },
  };
}

module.exports = {
  replayOutcomeSampleUS,
};

