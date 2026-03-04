const { BLOCK_LEVEL } = require('./safetyEngineV1');

function normalizeLevel(value, fallback = 'low') {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'low' || token === 'medium' || token === 'high') return token;
  return fallback;
}

function evaluatePolicySafetyGuard({
  phase = 'analysis',
  safetyDecision = null,
  boundaryDecision = null,
  artifactGate = null,
  confidenceLevel = 'low',
} = {}) {
  const out = {
    phase: String(phase || 'analysis').trim() || 'analysis',
    blocked: false,
    require_info: false,
    degrade: false,
    reason: 'none',
    confidence_level: normalizeLevel(confidenceLevel, 'low'),
    actions: [],
  };

  if (boundaryDecision && typeof boundaryDecision === 'object' && boundaryDecision.block) {
    out.blocked = true;
    out.reason = 'safety_boundary';
    out.actions = ['seek_medical_care', 'pause_strong_actives'];
    return out;
  }

  if (safetyDecision && typeof safetyDecision === 'object') {
    if (safetyDecision.block_level === BLOCK_LEVEL.BLOCK) {
      out.blocked = true;
      out.reason = 'safety_block';
      out.actions = ['safe_alternatives'];
      return out;
    }
    if (safetyDecision.block_level === BLOCK_LEVEL.REQUIRE_INFO) {
      out.require_info = true;
      out.reason = 'safety_require_info';
      out.actions = ['answer_safety_question'];
      return out;
    }
  }

  if (artifactGate && typeof artifactGate === 'object' && artifactGate.ok === false) {
    out.blocked = true;
    out.reason = 'artifact_missing';
    out.actions = ['upload_daylight_and_indoor_white', 'run_low_confidence_baseline'];
    return out;
  }

  const phaseToken = String(phase || '').trim().toLowerCase();
  if ((phaseToken.includes('reco') || phaseToken.includes('recommend')) && out.confidence_level === 'low') {
    out.degrade = true;
    out.reason = 'low_confidence';
    out.actions = ['upload_daylight_and_indoor_white', 'update_current_routine'];
    return out;
  }

  return out;
}

module.exports = {
  evaluatePolicySafetyGuard,
};

