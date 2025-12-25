const { usDeltaThresholds } = require('./config/usDeltaThresholds');

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function severityFromDiff(diffAbs, soft, hard) {
  if (!(hard > 0)) return 0;
  if (diffAbs <= soft) return 0;
  const denom = Math.max(1e-6, hard - soft);
  return clamp01((diffAbs - soft) / denom);
}

function evidenceFor(key) {
  const [group, name] = String(key).split('.');
  if (group === 'geometry') return [`user.geometry.${name}`, `ref.geometry.${name}`];
  if (group === 'categorical') return [`user.categorical.${name}`, `ref.categorical.${name}`];
  return [`user.${key}`, `ref.${key}`];
}

function addDelta(deltas, d) {
  deltas.push({
    key: d.key,
    userValue: d.userValue,
    refValue: d.refValue,
    severity: clamp01(d.severity),
    signedDiff: d.signedDiff,
    explanationKey: d.explanationKey,
    evidence: Array.isArray(d.evidence) && d.evidence.length ? d.evidence : evidenceFor(d.key),
  });
}

/**
 * @typedef {import('../../schemas/faceProfileV0').FaceProfileV0} FaceProfileV0
 */

/**
 * @returns {Array<{key:string,userValue:(number|string|null),refValue:(number|string),severity:number,signedDiff?:number,explanationKey:string,evidence:string[]}>}
 */
function computeDeltasUS({ userFace, refFace }) {
  const deltas = [];
  const t = usDeltaThresholds;

  const userMissing = !userFace;
  const geomKeys = Object.keys(t.geometry);

  for (const k of geomKeys) {
    const key = `geometry.${k}`;
    const refValue = refFace.geometry[k];
    if (userMissing) {
      addDelta(deltas, {
        key,
        userValue: null,
        refValue,
        severity: t.missingSelfie.geometrySeverity,
        explanationKey: 'missing_selfie',
        evidence: ['missing:userFaceProfile', `ref.geometry.${k}`],
      });
      continue;
    }
    const userValue = userFace.geometry[k];
    const diff = Number(userValue) - Number(refValue);
    const diffAbs = Math.abs(diff);
    const sev = severityFromDiff(diffAbs, t.geometry[k].soft, t.geometry[k].hard);
    addDelta(deltas, {
      key,
      userValue,
      refValue,
      severity: sev,
      signedDiff: diff,
      explanationKey: sev > 0 ? 'geometry_mismatch' : 'geometry_close',
      evidence: evidenceFor(key),
    });
  }

  const catKeys = Object.keys(t.categorical);
  for (const k of catKeys) {
    const key = `categorical.${k}`;
    const refValue = refFace.categorical[k];
    if (userMissing) {
      addDelta(deltas, {
        key,
        userValue: null,
        refValue,
        severity: t.missingSelfie.categoricalSeverity,
        explanationKey: 'missing_selfie',
        evidence: ['missing:userFaceProfile', `ref.categorical.${k}`],
      });
      continue;
    }
    const userValue = userFace.categorical[k];
    const mismatch = String(userValue) !== String(refValue);
    addDelta(deltas, {
      key,
      userValue,
      refValue,
      severity: mismatch ? t.categorical[k].severity : 0,
      explanationKey: mismatch ? 'categorical_mismatch' : 'categorical_match',
      evidence: evidenceFor(key),
    });
  }

  return deltas;
}

module.exports = { computeDeltasUS };

