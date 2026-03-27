const { buildAccessScope } = require('../../../../modules/contracts/accessScope');
const { buildRateLimitProfile } = require('../../../../modules/contracts/rateLimitProfile');

function resolvePartnerPolicyTierKey(identity = {}) {
  if (identity.principal_type === 'internal') return 'internal';
  if (identity.principal_type === 'partner' && identity.partner_tier === 'flagship') {
    return 'flagship_partner';
  }
  if (identity.principal_type === 'partner' && identity.partner_tier === 'approved') {
    return 'approved_partner';
  }
  if (identity.principal_type === 'mcp_agent') return 'generic_mcp_agent';
  if (identity.principal_type === 'public_agent') return 'public_api_agent';
  return 'unknown';
}

function resolvePartnerTierPolicy(identity = {}, options = {}) {
  const tierKey = resolvePartnerPolicyTierKey(identity);
  const allowPartnerOrchestration = Boolean(options.allow_partner_orchestration);
  const allowCheckout = Boolean(options.allow_checkout_handoff);

  const policyByTier = {
    internal: {
      access_scope: buildAccessScope({
        allowed_layers: ['orchestration', 'decisioning', 'execution_facing'],
        allowed_sources: ['search', 'shopping_agent', 'aurora-bff'],
        allow_execution_handoff: true,
        allow_checkout_handoff: allowCheckout,
        result_depth: 'deep_resolution',
        max_results_per_request: 25,
        max_pages: 3,
        max_variant_expansions: 12,
        allow_deep_offer_fields: true,
      }),
      rate_limit_profile: buildRateLimitProfile({
        profile_id: 'internal',
        requests_per_minute: 240,
        burst_limit: 40,
        max_concurrency: 20,
        daily_request_cap: 50000,
      }),
    },
    flagship_partner: {
      access_scope: buildAccessScope({
        allowed_layers: allowPartnerOrchestration
          ? ['orchestration', 'decisioning', 'execution_facing']
          : ['decisioning', 'execution_facing'],
        allowed_sources: ['search', 'shopping_agent'],
        allow_execution_handoff: true,
        allow_checkout_handoff: allowCheckout,
        result_depth: 'deep_resolution',
        max_results_per_request: 12,
        max_pages: 2,
        max_variant_expansions: 4,
        allow_deep_offer_fields: true,
      }),
      rate_limit_profile: buildRateLimitProfile({
        profile_id: 'flagship_partner',
        requests_per_minute: 90,
        burst_limit: 20,
        max_concurrency: 8,
        daily_request_cap: 12000,
      }),
    },
    approved_partner: {
      access_scope: buildAccessScope({
        allowed_layers: allowPartnerOrchestration ? ['orchestration', 'decisioning', 'execution_facing'] : ['decisioning', 'execution_facing'],
        allowed_sources: ['search', 'shopping_agent'],
        allow_execution_handoff: true,
        allow_checkout_handoff: false,
        result_depth: 'bounded_results',
        max_results_per_request: 8,
        max_pages: 1,
        max_variant_expansions: 2,
        allow_deep_offer_fields: false,
      }),
      rate_limit_profile: buildRateLimitProfile({
        profile_id: 'approved_partner',
        requests_per_minute: 45,
        burst_limit: 10,
        max_concurrency: 4,
        daily_request_cap: 5000,
      }),
    },
    public_api_agent: {
      access_scope: buildAccessScope({
        allowed_layers: ['decisioning', 'execution_facing'],
        allowed_sources: ['search', 'shopping_agent'],
        allow_execution_handoff: true,
        allow_checkout_handoff: false,
        result_depth: 'bounded_results',
        max_results_per_request: 6,
        max_pages: 1,
        max_variant_expansions: 1,
        allow_deep_offer_fields: false,
      }),
      rate_limit_profile: buildRateLimitProfile({
        profile_id: 'public_api_agent',
        requests_per_minute: 20,
        burst_limit: 5,
        max_concurrency: 2,
        daily_request_cap: 2000,
      }),
    },
    generic_mcp_agent: {
      access_scope: buildAccessScope({
        allowed_layers: ['decisioning', 'execution_facing'],
        allowed_sources: ['search', 'shopping_agent'],
        allow_execution_handoff: true,
        allow_checkout_handoff: false,
        result_depth: 'summary_only',
        max_results_per_request: 4,
        max_pages: 1,
        max_variant_expansions: 0,
        allow_deep_offer_fields: false,
      }),
      rate_limit_profile: buildRateLimitProfile({
        profile_id: 'generic_mcp_agent',
        requests_per_minute: 12,
        burst_limit: 3,
        max_concurrency: 1,
        daily_request_cap: 1000,
      }),
    },
    unknown: {
      access_scope: buildAccessScope({
        allowed_layers: [],
        allowed_sources: [],
        allow_execution_handoff: false,
        allow_checkout_handoff: false,
        result_depth: 'summary_only',
        max_results_per_request: 0,
        max_pages: 0,
        max_variant_expansions: 0,
        allow_deep_offer_fields: false,
      }),
      rate_limit_profile: buildRateLimitProfile({
        profile_id: 'unknown',
        requests_per_minute: 0,
        burst_limit: 0,
        max_concurrency: 0,
        daily_request_cap: 0,
      }),
    },
  };

  return policyByTier[tierKey] || policyByTier.unknown;
}

module.exports = {
  resolvePartnerPolicyTierKey,
  resolvePartnerTierPolicy,
};
