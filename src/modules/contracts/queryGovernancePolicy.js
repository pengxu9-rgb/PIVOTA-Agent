const QUERY_CLASSES = Object.freeze([
  'interactive_discovery',
  'decisioning_compare',
  'exact_resolution',
  'near_exact_resolution',
  'merchant_sweep_probe',
  'category_sweep_probe',
  'variant_fanout_probe',
  'deep_pagination_probe',
]);

function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function normalizeQueryClasses(input) {
  if (!Array.isArray(input)) return [];
  const normalized = new Set();
  for (const item of input) {
    const token = String(item || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (QUERY_CLASSES.includes(token)) normalized.add(token);
  }
  return Array.from(normalized);
}

function buildQueryGovernancePolicy(input = {}) {
  const suspiciousThresholds =
    input.suspicious_pattern_thresholds &&
    typeof input.suspicious_pattern_thresholds === 'object' &&
    !Array.isArray(input.suspicious_pattern_thresholds)
      ? input.suspicious_pattern_thresholds
      : {};

  return {
    policy_id: String(input.policy_id || '').trim() || 'default',
    query_classes: normalizeQueryClasses(input.query_classes),
    merchant_sweep_limit: normalizePositiveInteger(input.merchant_sweep_limit, 0),
    category_sweep_limit: normalizePositiveInteger(input.category_sweep_limit, 0),
    variant_expansion_limit: normalizePositiveInteger(input.variant_expansion_limit, 0),
    deep_pagination_limit: normalizePositiveInteger(input.deep_pagination_limit, 1),
    result_window_limit: normalizePositiveInteger(input.result_window_limit, 10),
    suspicious_pattern_thresholds: {
      repeated_merchant_queries: normalizePositiveInteger(
        suspiciousThresholds.repeated_merchant_queries,
        0,
      ),
      repeated_category_queries: normalizePositiveInteger(
        suspiciousThresholds.repeated_category_queries,
        0,
      ),
      repeated_page_turns: normalizePositiveInteger(suspiciousThresholds.repeated_page_turns, 0),
    },
    enforcement: {
      downgrade_to_summary:
        !input.enforcement || input.enforcement.downgrade_to_summary !== false,
      truncate_results: !input.enforcement || input.enforcement.truncate_results !== false,
      throttle: Boolean(input.enforcement && input.enforcement.throttle),
      block: !input.enforcement || input.enforcement.block !== false,
      require_allowlist_for_checkout:
        !input.enforcement || input.enforcement.require_allowlist_for_checkout !== false,
    },
  };
}

module.exports = {
  QUERY_CLASSES,
  buildQueryGovernancePolicy,
};
