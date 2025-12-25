const { usCompatibilityWeights } = require('./config/usWeights');
const { buildUSRuleCandidates, usFallbackAdjustments } = require('./usRules');

function areaOrder(area) {
  if (area === 'base') return 0;
  if (area === 'eye') return 1;
  return 2;
}

function byScoreDesc(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return String(a.id).localeCompare(String(b.id));
}

function pickBest(list, preferEasy) {
  if (!list.length) return null;
  const sorted = [...list].sort(byScoreDesc);
  if (!preferEasy) return sorted[0];
  const easy = sorted.find((c) => c.difficulty === 'easy');
  return easy || sorted[0];
}

function selectAdjustmentsUS({ preferenceMode, userFace, refFace, deltas }) {
  const userMissing = !userFace;
  const preferEasy = usCompatibilityWeights.preferenceMultipliers[preferenceMode]?.preferEasyAdjustments;

  if (userMissing) {
    const fallbacks = usFallbackAdjustments({ userMissing: true }).sort((a, b) => areaOrder(a.impactArea) - areaOrder(b.impactArea));
    const a0 = fallbacks.find((x) => x.impactArea === 'base');
    const a1 = fallbacks.find((x) => x.impactArea === 'eye');
    const a2 = fallbacks.find((x) => x.impactArea === 'lip');
    return {
      adjustments: [
        { impactArea: a0.impactArea, title: a0.title, because: a0.because, do: a0.do, confidence: a0.confidence, evidence: a0.evidence },
        { impactArea: a1.impactArea, title: a1.title, because: a1.because, do: a1.do, confidence: a1.confidence, evidence: a1.evidence },
        { impactArea: a2.impactArea, title: a2.title, because: a2.because, do: a2.do, confidence: a2.confidence, evidence: a2.evidence },
      ],
      warnings: ['Selfie missing: using safe, generic adjustments focused on matching the reference look.'],
    };
  }

  const candidates = buildUSRuleCandidates({ preferenceMode, userFace, refFace, deltas });
  const fallbacks = usFallbackAdjustments({ userMissing: false });

  const perArea = (area) => candidates.filter((c) => c.impactArea === area);
  const picked = [];

  for (const area of ['base', 'eye', 'lip']) {
    const best = pickBest(perArea(area), Boolean(preferEasy));
    picked.push(best || fallbacks.find((f) => f.impactArea === area));
  }

  const warnings = [];
  const usedFallback = picked.some((p) => String(p.id).startsWith('fallback_'));
  if (usedFallback) warnings.push('Not enough strong signals for all areas; filled with safe, low-risk adjustments.');

  const sorted = picked
    .sort((a, b) => areaOrder(a.impactArea) - areaOrder(b.impactArea))
    .map((a) => ({
      impactArea: a.impactArea,
      title: a.title,
      because: a.because,
      do: a.do,
      confidence: a.confidence,
      evidence: a.evidence,
    }));

  return {
    adjustments: [sorted[0], sorted[1], sorted[2]],
    warnings: warnings.length ? warnings : undefined,
  };
}

module.exports = { selectAdjustmentsUS };

