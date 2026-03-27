const PRINCIPAL_TYPES = new Set(['internal', 'partner', 'public_agent', 'mcp_agent', 'unknown']);
const PARTNER_TIERS = new Set(['flagship', 'approved', 'none']);
const TRUST_TIERS = new Set(['high', 'medium', 'low', 'unknown']);
const ENVIRONMENTS = new Set(['prod', 'staging', 'dev']);
const AUTH_STRENGTHS = new Set(['strong', 'medium', 'weak', 'unknown']);

function normalizeToken(value, allowedValues, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return allowedValues.has(normalized) ? normalized : fallback;
}

function buildAgentIdentity(input = {}) {
  return {
    principal_id: String(input.principal_id || '').trim() || 'unknown:anonymous',
    principal_type: normalizeToken(input.principal_type, PRINCIPAL_TYPES, 'unknown'),
    org_id: String(input.org_id || '').trim() || null,
    agent_id: String(input.agent_id || '').trim() || null,
    partner_tier: normalizeToken(input.partner_tier, PARTNER_TIERS, 'none'),
    trust_tier: normalizeToken(input.trust_tier, TRUST_TIERS, 'unknown'),
    environment: normalizeToken(input.environment, ENVIRONMENTS, 'prod'),
    auth_strength: normalizeToken(input.auth_strength, AUTH_STRENGTHS, 'unknown'),
  };
}

module.exports = {
  buildAgentIdentity,
};
