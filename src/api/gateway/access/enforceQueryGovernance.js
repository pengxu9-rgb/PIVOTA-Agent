function rankResultDepth(value) {
  if (value === 'deep_resolution') return 3;
  if (value === 'bounded_results') return 2;
  return 1;
}

function pickResultDepth(requested, allowed) {
  return rankResultDepth(requested) <= rankResultDepth(allowed) ? requested : allowed;
}

function enforceQueryGovernance(input = {}) {
  const accessScope = input.access_scope || {};
  const policy = input.query_governance_policy || {};
  const classification = input.query_classification || {};
  const normalizedRequest = input.normalized_request || {};
  const sourceProfile = input.source_profile || {};
  const reasonCodes = [];

  const requestedLayer = normalizedRequest.requested_layer || sourceProfile.default_entry_layer || null;
  if (requestedLayer && !(accessScope.allowed_layers || []).includes(requestedLayer)) {
    return {
      allowed: false,
      action: 'block',
      reason_codes: ['layer_not_allowed'],
      effective_result_depth: accessScope.result_depth || 'summary_only',
      max_results_per_request: accessScope.max_results_per_request || 0,
      max_pages: accessScope.max_pages || 0,
      max_variant_expansions: accessScope.max_variant_expansions || 0,
    };
  }

  if (sourceProfile.source && !(accessScope.allowed_sources || []).includes(sourceProfile.source)) {
    return {
      allowed: false,
      action: 'block',
      reason_codes: ['source_not_allowed'],
      effective_result_depth: accessScope.result_depth || 'summary_only',
      max_results_per_request: accessScope.max_results_per_request || 0,
      max_pages: accessScope.max_pages || 0,
      max_variant_expansions: accessScope.max_variant_expansions || 0,
    };
  }

  const governanceHints =
    normalizedRequest.governance_hints && typeof normalizedRequest.governance_hints === 'object'
      ? normalizedRequest.governance_hints
      : {};

  if (governanceHints.request_checkout_handoff === true && accessScope.allow_checkout_handoff !== true) {
    return {
      allowed: false,
      action: 'block',
      reason_codes: ['checkout_handoff_not_allowed'],
      effective_result_depth: accessScope.result_depth || 'summary_only',
      max_results_per_request: accessScope.max_results_per_request || 0,
      max_pages: accessScope.max_pages || 0,
      max_variant_expansions: accessScope.max_variant_expansions || 0,
    };
  }

  if (
    classification.query_classes &&
    classification.query_classes.includes('merchant_sweep_probe') &&
    (policy.merchant_sweep_limit || 0) <= 0
  ) {
    return {
      allowed: false,
      action: 'block',
      reason_codes: ['merchant_sweep_blocked'],
      effective_result_depth: accessScope.result_depth || 'summary_only',
      max_results_per_request: accessScope.max_results_per_request || 0,
      max_pages: accessScope.max_pages || 0,
      max_variant_expansions: accessScope.max_variant_expansions || 0,
    };
  }

  if (
    classification.query_classes &&
    classification.query_classes.includes('category_sweep_probe') &&
    classification.signals.category_filter_count > (policy.category_sweep_limit || 0) &&
    (policy.category_sweep_limit || 0) >= 0
  ) {
    return {
      allowed: false,
      action: 'block',
      reason_codes: ['category_sweep_blocked'],
      effective_result_depth: accessScope.result_depth || 'summary_only',
      max_results_per_request: accessScope.max_results_per_request || 0,
      max_pages: accessScope.max_pages || 0,
      max_variant_expansions: accessScope.max_variant_expansions || 0,
    };
  }

  if ((classification.signals.requested_page || 1) > (accessScope.max_pages || 0) && (accessScope.max_pages || 0) >= 0) {
    return {
      allowed: false,
      action: 'block',
      reason_codes: ['deep_pagination_blocked'],
      effective_result_depth: accessScope.result_depth || 'summary_only',
      max_results_per_request: accessScope.max_results_per_request || 0,
      max_pages: accessScope.max_pages || 0,
      max_variant_expansions: accessScope.max_variant_expansions || 0,
    };
  }

  if (
    classification.signals.repeated_merchant_queries > (policy.suspicious_pattern_thresholds?.repeated_merchant_queries || 0) &&
    (policy.suspicious_pattern_thresholds?.repeated_merchant_queries || 0) > 0
  ) {
    return {
      allowed: false,
      action: 'throttle',
      reason_codes: ['repeated_merchant_queries_throttled'],
      effective_result_depth: accessScope.result_depth || 'summary_only',
      max_results_per_request: accessScope.max_results_per_request || 0,
      max_pages: accessScope.max_pages || 0,
      max_variant_expansions: accessScope.max_variant_expansions || 0,
    };
  }

  let action = 'allow';
  let effectiveResultDepth = pickResultDepth(
    governanceHints.requested_result_depth || accessScope.result_depth || 'summary_only',
    accessScope.result_depth || 'summary_only',
  );
  if (effectiveResultDepth !== (governanceHints.requested_result_depth || effectiveResultDepth)) {
    action = 'downgrade';
    reasonCodes.push('result_depth_downgraded');
  }

  let maxResultsPerRequest = Math.min(
    accessScope.max_results_per_request || 0,
    policy.result_window_limit || accessScope.max_results_per_request || 0,
  );
  let maxVariantExpansions = Math.min(
    accessScope.max_variant_expansions || 0,
    policy.variant_expansion_limit || accessScope.max_variant_expansions || 0,
  );
  const requestedVariants = classification.signals.requested_variant_expansions || 0;
  if (requestedVariants > maxVariantExpansions) {
    action = action === 'allow' ? 'truncate' : action;
    reasonCodes.push('variant_expansion_truncated');
  }

  return {
    allowed: true,
    action,
    reason_codes: reasonCodes,
    effective_result_depth: effectiveResultDepth,
    max_results_per_request: maxResultsPerRequest,
    max_pages: accessScope.max_pages || 0,
    max_variant_expansions: maxVariantExpansions,
  };
}

module.exports = {
  enforceQueryGovernance,
};
