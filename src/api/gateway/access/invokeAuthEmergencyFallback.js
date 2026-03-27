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
  errorCode = null,
  allowedErrorCodes = ['AUTH_INTROSPECT_UNAVAILABLE'],
  enabled = false,
  allowedApiKeys = [],
  agentId = null,
  onAccept = null,
} = {}) {
  if (enabled !== true) return null;
  const normalizedErrorCode = String(errorCode || '').trim() || null;
  const normalizedAllowedErrorCodes = Array.isArray(allowedErrorCodes)
    ? Array.from(
        new Set(
          allowedErrorCodes
            .map((item) => String(item || '').trim())
            .filter(Boolean),
        ),
      )
    : [];
  if (
    normalizedAllowedErrorCodes.length > 0 &&
    !normalizedAllowedErrorCodes.includes(normalizedErrorCode)
  ) {
    return null;
  }
  if (!Array.isArray(allowedApiKeys) || allowedApiKeys.length === 0) return null;
  if (!allowedApiKeys.includes(String(apiKey || '').trim())) return null;

  const result = {
    valid: true,
    agent_id: agentId || null,
    is_active: true,
    auth_source: 'emergency_fallback',
    cache_hit: false,
    auth_degraded: true,
    auth_degraded_reason: normalizedErrorCode || 'AUTH_INTROSPECT_UNAVAILABLE',
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
