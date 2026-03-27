const { buildAccessScope } = require('../../../modules/contracts/accessScope');
const { resolvePartnerTierPolicy } = require('./policies/partnerTierPolicies');

function unionStrings(...groups) {
  return Array.from(
    new Set(
      groups
        .flat()
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function shouldAllowImplicitAuroraInvokeOrchestration(input = {}) {
  const identity = input.agent_identity || {};
  const sourceProfile = input.source_profile || {};
  const normalizedRequest = input.normalized_request || {};
  const rawAuthClaims =
    input.invocation_context &&
    input.invocation_context.raw_auth_claims &&
    typeof input.invocation_context.raw_auth_claims === 'object'
      ? input.invocation_context.raw_auth_claims
      : {};

  if (identity.principal_type !== 'public_agent') return false;
  if (String(sourceProfile.source || '').trim() !== 'aurora-bff') return false;
  if (String(normalizedRequest.invocation_surface || '').trim() !== 'direct_api') return false;
  if (rawAuthClaims.auth_strength !== 'strong') return false;
  if (rawAuthClaims.auth_degraded === true) return false;
  if (rawAuthClaims.invocation_surface_declared === true) return false;
  return true;
}

function resolveAccessScope(input = {}) {
  const identity = input.agent_identity || {};
  const partnerPolicy = resolvePartnerTierPolicy(identity, {
    allow_partner_orchestration: input.allow_partner_orchestration === true,
    allow_checkout_handoff: input.allow_checkout_handoff === true,
  });
  const baseScope = partnerPolicy.access_scope;

  if (shouldAllowImplicitAuroraInvokeOrchestration(input)) {
    return buildAccessScope({
      ...baseScope,
      allowed_layers: unionStrings(baseScope.allowed_layers || [], ['orchestration']),
      allowed_sources: unionStrings(baseScope.allowed_sources || [], ['aurora-bff']),
    });
  }

  return buildAccessScope({
    ...baseScope,
    merchant_allowlist:
      input.merchant_allowlist && input.merchant_allowlist.length
        ? input.merchant_allowlist
        : baseScope.merchant_allowlist,
    category_allowlist:
      input.category_allowlist && input.category_allowlist.length
        ? input.category_allowlist
        : baseScope.category_allowlist,
  });
}

module.exports = {
  resolveAccessScope,
};
