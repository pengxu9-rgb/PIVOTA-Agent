const { buildAccessScope } = require('../../../modules/contracts/accessScope');
const { resolvePartnerTierPolicy } = require('./policies/partnerTierPolicies');

function resolveAccessScope(input = {}) {
  const identity = input.agent_identity || {};
  const partnerPolicy = resolvePartnerTierPolicy(identity, {
    allow_partner_orchestration: input.allow_partner_orchestration === true,
    allow_checkout_handoff: input.allow_checkout_handoff === true,
  });
  const baseScope = partnerPolicy.access_scope;

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
