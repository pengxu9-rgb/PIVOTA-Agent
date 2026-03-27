const { buildRateLimitProfile } = require('../../../modules/contracts/rateLimitProfile');
const { resolvePartnerTierPolicy } = require('./policies/partnerTierPolicies');

function resolveRateLimitProfile(input = {}) {
  const identity = input.agent_identity || {};
  const partnerPolicy = resolvePartnerTierPolicy(identity, {
    allow_partner_orchestration: input.allow_partner_orchestration === true,
    allow_checkout_handoff: input.allow_checkout_handoff === true,
  });

  return buildRateLimitProfile({
    ...partnerPolicy.rate_limit_profile,
    ...input.rate_limit_profile,
  });
}

module.exports = {
  resolveRateLimitProfile,
};
