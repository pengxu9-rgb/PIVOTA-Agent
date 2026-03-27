function parseBooleanEnv(value, fallback = false) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return fallback;
}

function parseSecretList(...values) {
  const entries = [];
  for (const value of values) {
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => entries.push(item));
  }
  return Array.from(new Set(entries));
}

function resolveInvokeEmergencyAuthFallback({
  apiKey,
  enabled = false,
  allowedApiKeys = [],
  agentId = null,
  onAccept = null,
} = {}) {
  if (enabled !== true) return null;
  if (!Array.isArray(allowedApiKeys) || allowedApiKeys.length === 0) return null;
  if (!allowedApiKeys.includes(String(apiKey || '').trim())) return null;

  const result = {
    valid: true,
    agent_id: agentId || null,
    is_active: true,
    auth_source: 'emergency_fallback',
    cache_hit: false,
  };

  if (typeof onAccept === 'function') {
    onAccept(result);
  }

  return result;
}

module.exports = {
  parseBooleanEnv,
  parseSecretList,
  resolveInvokeEmergencyAuthFallback,
};
