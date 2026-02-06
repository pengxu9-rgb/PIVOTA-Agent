const crypto = require('crypto');

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

function parseBoolEnv(value, fallback = false) {
  const v = normalizeToken(value);
  if (!v) return fallback;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return fallback;
}

function parsePercentEnv(value, fallback = 0) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function hashToBucket0to99(requestId) {
  const id = String(requestId == null ? '' : requestId);
  const digest = crypto.createHash('sha256').update(id).digest();
  const n = digest.readUInt32BE(0);
  return n % 100;
}

function normalizeDiagPipelineVersion(raw) {
  const v = normalizeToken(raw);
  if (v === 'legacy') return 'legacy';
  if (v === 'v2') return 'v2';
  return null;
}

function getDiagRolloutDecision({ requestId } = {}) {
  const versionOverride = normalizeDiagPipelineVersion(process.env.DIAG_PIPELINE_VERSION);
  const shadowMode = parseBoolEnv(process.env.DIAG_SHADOW_MODE, false);
  const canaryPercent = parsePercentEnv(process.env.DIAG_CANARY_PERCENT, 0);
  const llmKillSwitch = parseBoolEnv(process.env.LLM_KILL_SWITCH, false);

  const bucket = hashToBucket0to99(requestId);
  const canarySelected = bucket < canaryPercent;

  const selectedVersion = versionOverride || (canarySelected ? 'v2' : 'legacy');
  const reason = versionOverride ? 'forced' : canarySelected ? 'canary' : 'default';

  return {
    selectedVersion,
    reason,
    shadowMode,
    canaryPercent,
    canaryBucket: bucket,
    llmKillSwitch,
  };
}

module.exports = {
  getDiagRolloutDecision,
  normalizeDiagPipelineVersion,
  parseBoolEnv,
  parsePercentEnv,
  hashToBucket0to99,
};

