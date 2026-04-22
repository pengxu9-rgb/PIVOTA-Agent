const { buildAgentIdentity } = require('../../../modules/contracts/agentIdentity');

function deriveTrustTier(principalType, authStrength, partnerTier) {
  if (principalType === 'internal') return 'high';
  if (principalType === 'partner' && partnerTier === 'flagship' && authStrength === 'strong') return 'high';
  if (principalType === 'partner' && authStrength !== 'unknown') return 'medium';
  if (principalType === 'mcp_agent') return 'low';
  if (principalType === 'public_agent') return authStrength === 'strong' ? 'medium' : 'low';
  return 'unknown';
}

function resolveAgentIdentity(input = {}) {
  if (input.agent_identity && typeof input.agent_identity === 'object') {
    return buildAgentIdentity(input.agent_identity);
  }

  const sourceProfile =
    input.source_profile && typeof input.source_profile === 'object' ? input.source_profile : {};
  const invocationProfile = input.invocation_profile && typeof input.invocation_profile === 'object'
    ? input.invocation_profile
    : {};
  const rawAuthClaims =
    input.invocation_context &&
    input.invocation_context.raw_auth_claims &&
    typeof input.invocation_context.raw_auth_claims === 'object'
      ? input.invocation_context.raw_auth_claims
      : {};
  const hasExplicitInvocationSurface = Boolean(input.invocation_surface || input.invocationSurface);
  const hasRawClaims = Object.keys(rawAuthClaims).length > 0;

  let principalType = 'unknown';
  if (
    !hasExplicitInvocationSurface &&
    !hasRawClaims &&
    (
      sourceProfile.source === 'aurora-bff' ||
      sourceProfile.source === 'shopping_agent' ||
      sourceProfile.source === 'creator_agent'
    )
  ) {
    principalType = 'internal';
  } else if (rawAuthClaims.internal === true || input.internal === true) {
    principalType = 'internal';
  } else if (rawAuthClaims.partner_tier || rawAuthClaims.partner_id || rawAuthClaims.org_id) {
    principalType = 'partner';
  } else if (invocationProfile.surface === 'mcp') {
    principalType = 'mcp_agent';
  } else if (invocationProfile.surface) {
    principalType = 'public_agent';
  }

  const authStrength = rawAuthClaims.auth_strength || rawAuthClaims.authStrength || (
    principalType === 'internal' || principalType === 'partner' ? 'strong' : 'unknown'
  );
  const partnerTier = rawAuthClaims.partner_tier || rawAuthClaims.partnerTier || 'none';

  return buildAgentIdentity({
    principal_id:
      rawAuthClaims.principal_id ||
      rawAuthClaims.sub ||
      rawAuthClaims.agent_id ||
      `${principalType}:${invocationProfile.surface || 'unknown'}`,
    principal_type: principalType,
    org_id: rawAuthClaims.org_id || rawAuthClaims.orgId,
    agent_id: rawAuthClaims.agent_id || rawAuthClaims.agentId,
    partner_tier: partnerTier,
    trust_tier: deriveTrustTier(principalType, authStrength, partnerTier),
    environment: input.environment || rawAuthClaims.environment || 'prod',
    auth_strength: authStrength,
  });
}

module.exports = {
  resolveAgentIdentity,
};
