const { usGateThresholds } = require('./usGateThresholds');

const HARD_REJECT_REASONS = new Set([
  'FACE_BORDER_CUTOFF',
  'LIGHTING_LOW_CONFIDENCE',
  'SHARPNESS_LOW_CONFIDENCE',
  'FACE_TOO_SMALL',
  'FACE_TOO_LARGE',
  'GEOMETRY_FAILED',
]);

const SOFT_DEGRADE_REASONS = new Set([
  'POSE_YAW_TOO_LARGE',
  'POSE_PITCH_TOO_LARGE',
  'POSE_ROLL_TOO_LARGE',
  'EYES_BORDER_RISK',
  'MOUTH_BORDER_RISK',
]);

function hasReason(quality, set) {
  return Array.isArray(quality.rejectReasons) && quality.rejectReasons.some((r) => set.has(r));
}

function exceedsPoseSoft(quality) {
  const pose = quality.pose || { yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  return (
    Math.abs(pose.yawDeg) > usGateThresholds.pose.maxAbsYawDegSoft ||
    Math.abs(pose.pitchDeg) > usGateThresholds.pose.maxAbsPitchDegSoft ||
    Math.abs(pose.rollDeg) > usGateThresholds.pose.maxAbsRollDegSoft
  );
}

function evalRefHardReject(ref) {
  const q = ref.quality;
  const reasons = [];

  if (!q.valid) reasons.push('REF_INVALID');
  if (q.occlusionFlags?.faceBorderCutoff) reasons.push('REF_FACE_BORDER_CUTOFF');
  if (q.lightingScore < usGateThresholds.image.minLightingScoreHard) reasons.push('REF_LIGHTING_TOO_LOW');
  if (q.sharpnessScore < usGateThresholds.image.minSharpnessScoreHard) reasons.push('REF_SHARPNESS_TOO_LOW');
  if (hasReason(q, HARD_REJECT_REASONS)) reasons.push('REF_HARD_REJECT_REASON');
  if (q.faceCount !== 1) reasons.push('REF_FACE_COUNT_NOT_ONE');

  return reasons;
}

function evalUserDegrade(user) {
  const q = user.quality;
  const reasons = [];

  if (!q.valid) reasons.push('SELFIE_INVALID');
  if (q.occlusionFlags?.faceBorderCutoff) reasons.push('SELFIE_FACE_BORDER_CUTOFF');
  if (hasReason(q, HARD_REJECT_REASONS)) reasons.push('SELFIE_HARD_REJECT_REASON');
  if (hasReason(q, SOFT_DEGRADE_REASONS) || exceedsPoseSoft(q)) reasons.push('SELFIE_SOFT_DEGRADE_REASON');

  return reasons;
}

// Evaluates server-side gate as a safety net (frontend already performs gating).
// - hard_reject: block downstream processing
// - soft_degrade: allow but warn
// - ok: proceed
function evaluateLayer1Gate(bundle) {
  const reasons = [];

  const refHard = evalRefHardReject(bundle.refFaceProfile);
  if (refHard.length) {
    reasons.push(...refHard);
    return { gate: 'hard_reject', reasons };
  }

  if (!bundle.userFaceProfile) {
    reasons.push('MISSING_SELFIE');
  } else {
    reasons.push(...evalUserDegrade(bundle.userFaceProfile));
  }

  if (bundle.similarityReport?.confidence === 'low') {
    reasons.push('REPORT_LOW_CONFIDENCE');
  }
  if (Array.isArray(bundle.similarityReport?.warnings) && bundle.similarityReport.warnings.length) {
    reasons.push('REPORT_WARNINGS_PRESENT');
  }

  if (reasons.length) return { gate: 'soft_degrade', reasons };
  return { gate: 'ok', reasons: [] };
}

module.exports = { evaluateLayer1Gate };

