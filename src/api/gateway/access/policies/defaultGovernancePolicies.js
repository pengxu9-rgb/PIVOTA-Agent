const { buildQueryGovernancePolicy } = require('../../../../modules/contracts/queryGovernancePolicy');
const { resolvePartnerPolicyTierKey } = require('./partnerTierPolicies');

function resolveDefaultQueryGovernancePolicy(identity = {}) {
  const tierKey = resolvePartnerPolicyTierKey(identity);

  const policyByTier = {
    internal: buildQueryGovernancePolicy({
      policy_id: 'internal',
      merchant_sweep_limit: 6,
      category_sweep_limit: 6,
      variant_expansion_limit: 12,
      deep_pagination_limit: 3,
      result_window_limit: 25,
      suspicious_pattern_thresholds: {
        repeated_merchant_queries: 12,
        repeated_category_queries: 12,
        repeated_page_turns: 6,
      },
      enforcement: {
        downgrade_to_summary: true,
        truncate_results: true,
        throttle: true,
        block: true,
        require_allowlist_for_checkout: true,
      },
    }),
    flagship_partner: buildQueryGovernancePolicy({
      policy_id: 'flagship_partner',
      merchant_sweep_limit: 0,
      category_sweep_limit: 3,
      variant_expansion_limit: 4,
      deep_pagination_limit: 2,
      result_window_limit: 12,
      suspicious_pattern_thresholds: {
        repeated_merchant_queries: 4,
        repeated_category_queries: 6,
        repeated_page_turns: 3,
      },
      enforcement: {
        downgrade_to_summary: true,
        truncate_results: true,
        throttle: true,
        block: true,
        require_allowlist_for_checkout: true,
      },
    }),
    approved_partner: buildQueryGovernancePolicy({
      policy_id: 'approved_partner',
      merchant_sweep_limit: 0,
      category_sweep_limit: 2,
      variant_expansion_limit: 2,
      deep_pagination_limit: 1,
      result_window_limit: 8,
      suspicious_pattern_thresholds: {
        repeated_merchant_queries: 2,
        repeated_category_queries: 3,
        repeated_page_turns: 1,
      },
      enforcement: {
        downgrade_to_summary: true,
        truncate_results: true,
        throttle: true,
        block: true,
        require_allowlist_for_checkout: true,
      },
    }),
    public_api_agent: buildQueryGovernancePolicy({
      policy_id: 'public_api_agent',
      merchant_sweep_limit: 0,
      category_sweep_limit: 1,
      variant_expansion_limit: 1,
      deep_pagination_limit: 1,
      result_window_limit: 6,
      suspicious_pattern_thresholds: {
        repeated_merchant_queries: 1,
        repeated_category_queries: 2,
        repeated_page_turns: 1,
      },
      enforcement: {
        downgrade_to_summary: true,
        truncate_results: true,
        throttle: true,
        block: true,
        require_allowlist_for_checkout: true,
      },
    }),
    generic_mcp_agent: buildQueryGovernancePolicy({
      policy_id: 'generic_mcp_agent',
      merchant_sweep_limit: 0,
      category_sweep_limit: 1,
      variant_expansion_limit: 0,
      deep_pagination_limit: 1,
      result_window_limit: 4,
      suspicious_pattern_thresholds: {
        repeated_merchant_queries: 1,
        repeated_category_queries: 1,
        repeated_page_turns: 1,
      },
      enforcement: {
        downgrade_to_summary: true,
        truncate_results: true,
        throttle: true,
        block: true,
        require_allowlist_for_checkout: true,
      },
    }),
    unknown: buildQueryGovernancePolicy({
      policy_id: 'unknown',
      merchant_sweep_limit: 0,
      category_sweep_limit: 0,
      variant_expansion_limit: 0,
      deep_pagination_limit: 0,
      result_window_limit: 0,
      suspicious_pattern_thresholds: {
        repeated_merchant_queries: 0,
        repeated_category_queries: 0,
        repeated_page_turns: 0,
      },
      enforcement: {
        downgrade_to_summary: false,
        truncate_results: true,
        throttle: true,
        block: true,
        require_allowlist_for_checkout: true,
      },
    }),
  };

  return policyByTier[tierKey] || policyByTier.unknown;
}

module.exports = {
  resolveDefaultQueryGovernancePolicy,
};
