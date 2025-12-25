const { usCompatibilityWeights } = require('./config/usWeights');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(x) {
  return clamp(x, 0, 1);
}

function getDelta(deltas, key) {
  return deltas.find((d) => d.key === key);
}

function absPoseMax(quality) {
  const p = quality?.pose;
  if (!p) return 0;
  return Math.max(Math.abs(p.yawDeg || 0), Math.abs(p.pitchDeg || 0), Math.abs(p.rollDeg || 0));
}

function scoreFitUS({ preferenceMode, userFace, refFace, deltas }) {
  const pref = usCompatibilityWeights.preferenceMultipliers[preferenceMode] || usCompatibilityWeights.preferenceMultipliers.structure;
  const w = usCompatibilityWeights;

  let geometryFit = 60;
  const geomWeight = w.geometry;
  const geomKeys = Object.keys(geomWeight);
  for (const k of geomKeys) {
    const d = getDelta(deltas, `geometry.${k}`);
    const sev = clamp01(d?.severity ?? 0);
    geometryFit -= (geomWeight[k] * pref.geometryScale * sev) / 2; // normalize weights into 0..60
  }
  geometryFit = clamp(geometryFit, 0, 60);

  let riskPenalty = 0;
  if (!userFace) riskPenalty += w.risk.missingSelfie * pref.riskScale;
  if (userFace && (!userFace.quality.valid || !refFace.quality.valid)) riskPenalty += w.risk.invalidQuality * pref.riskScale;

  const poseRisk = absPoseMax(userFace?.quality || refFace.quality);
  if (poseRisk >= 18) riskPenalty += w.risk.poseLarge * pref.riskScale;
  if (userFace?.quality?.occlusionFlags?.faceBorderCutoff || refFace.quality.occlusionFlags.faceBorderCutoff) {
    riskPenalty += w.risk.faceBorderCutoff * pref.riskScale;
  }

  riskPenalty = clamp(riskPenalty, 0, 25);

  let adaptabilityBonus = 0;
  const adaptable = w.adaptability;
  for (const [k, wk] of Object.entries(adaptable)) {
    const d = getDelta(deltas, `geometry.${k}`);
    const sev = clamp01(d?.severity ?? 0);
    adaptabilityBonus += wk * pref.adaptabilityScale * sev;
  }
  adaptabilityBonus = clamp(adaptabilityBonus, 0, 15);

  const fitScore = clamp(Math.round(geometryFit - riskPenalty + adaptabilityBonus), 0, 100);

  const confidence = (() => {
    if (!userFace) return 'low';
    if (userFace.quality.valid && refFace.quality.valid) return 'high';
    return 'medium';
  })();

  const warnings = [];
  if (!userFace) warnings.push('Selfie missing: confidence is limited.');
  if (!refFace.quality.valid) warnings.push('Reference photo quality is low; results may be less stable.');

  return {
    fitScore,
    confidence,
    scoreBreakdown: {
      geometryFit: Math.round(geometryFit),
      riskPenalty: Math.round(riskPenalty),
      adaptabilityBonus: Math.round(adaptabilityBonus),
    },
    warnings: warnings.length ? warnings : undefined,
  };
}

module.exports = { scoreFitUS };

