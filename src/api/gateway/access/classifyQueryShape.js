function classifyQueryShape(input = {}) {
  const normalizedRequest = input.normalized_request || {};
  const governanceHints =
    normalizedRequest.governance_hints && typeof normalizedRequest.governance_hints === 'object'
      ? normalizedRequest.governance_hints
      : {};
  const requestedLayer = normalizedRequest.requested_layer || input.requested_layer || null;
  const taskType = normalizedRequest.task_type || input.task_type || null;
  const operation = normalizedRequest.normalized_operation || input.operation || '';

  const queryClasses = new Set();
  if (
    governanceHints.near_exact_resolution === true ||
    operation === 'resolve_offer' ||
    operation === 'resolve_variant'
  ) {
    queryClasses.add('near_exact_resolution');
  } else if (taskType === 'exact_product' || requestedLayer === 'execution_facing') {
    queryClasses.add('exact_resolution');
  } else if (String(operation).includes('compare')) {
    queryClasses.add('decisioning_compare');
  } else {
    queryClasses.add('interactive_discovery');
  }

  if ((governanceHints.merchant_filters || []).length > 1 || governanceHints.repeated_merchant_queries > 0) {
    queryClasses.add('merchant_sweep_probe');
  }
  if ((governanceHints.category_filters || []).length > 1 || governanceHints.repeated_category_queries > 0) {
    queryClasses.add('category_sweep_probe');
  }
  if ((governanceHints.requested_variant_expansions || 0) > 0) {
    queryClasses.add('variant_fanout_probe');
  }
  if ((governanceHints.requested_page || 1) > 1 || governanceHints.repeated_page_turns > 0) {
    queryClasses.add('deep_pagination_probe');
  }

  return {
    query_classes: Array.from(queryClasses),
    signals: {
      merchant_filter_count: (governanceHints.merchant_filters || []).length,
      category_filter_count: (governanceHints.category_filters || []).length,
      requested_page: governanceHints.requested_page || 1,
      requested_variant_expansions: governanceHints.requested_variant_expansions || 0,
      repeated_merchant_queries: governanceHints.repeated_merchant_queries || 0,
      repeated_category_queries: governanceHints.repeated_category_queries || 0,
      repeated_page_turns: governanceHints.repeated_page_turns || 0,
    },
  };
}

module.exports = {
  classifyQueryShape,
};
