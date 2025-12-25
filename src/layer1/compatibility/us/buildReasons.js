function buildReasonsUS({ userFace, refFace, fitScore, deltas }) {
  const userMissing = !userFace;
  const top = [...deltas].sort((a, b) => b.severity - a.severity).slice(0, 2).map((d) => d.key);

  const r1 = {
    title: fitScore >= 75 ? 'This reference is a good fit' : fitScore >= 55 ? 'This reference is workable' : 'This reference will need careful adjustment',
    copy: userMissing
      ? 'We can still guide you toward the reference look, but accuracy is limited without a selfie.'
      : 'Your selfie and the reference share enough structure cues to make this look achievable with technique.',
    evidence: ['ref.quality.valid', ...(userFace ? ['user.quality.valid'] : ['missing:userFaceProfile']), 'score.fitScore'],
  };

  const r2 = {
    title: 'The main emphasis areas are adjustable',
    copy: 'We’ll focus on placement and finish choices in base, eye, and lip to match the reference mood without relying on identity.',
    evidence: ['score.scoreBreakdown.adaptabilityBonus', ...top.map((k) => `delta:${k}`)],
  };

  const r3 = {
    title: 'You’ll get a clear 3-part plan',
    copy: 'We provide exactly three actionable adjustments (base, eye, lip), each tied to measurable differences and quality signals.',
    evidence: ['report.adjustments[base]', 'report.adjustments[eye]', 'report.adjustments[lip]'],
  };

  return [r1, r2, r3];
}

module.exports = { buildReasonsUS };

