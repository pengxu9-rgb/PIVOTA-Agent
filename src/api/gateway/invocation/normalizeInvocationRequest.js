const { resolveSourceProfile } = require('../sourceProfiles');
const { normalizeLayerType } = require('../../../modules/contracts/layerType');
const { normalizeTaskType } = require('../../../modules/contracts/taskType');
const { resolveInvocationSurface } = require('./resolveInvocationSurface');
const { buildGatewayInvocationProfile } = require('./buildInvocationProfile');
const { buildGatewayInvocationContext } = require('./buildInvocationContext');

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstNonEmpty(...value);
      if (nested) return nested;
      continue;
    }
    const token = String(value || '').trim();
    if (token) return token;
  }
  return '';
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  const token = String(value || '').trim();
  return token ? [token] : [];
}

function asPositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function normalizeResultDepth(value, fallback = 'summary_only') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (['summary_only', 'bounded_results', 'deep_resolution'].includes(normalized)) return normalized;
  return fallback;
}

function buildGovernanceHints(input = {}) {
  const payloadSearch =
    input.payload &&
    input.payload.search &&
    typeof input.payload.search === 'object' &&
    !Array.isArray(input.payload.search)
      ? input.payload.search
      : {};
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const normalizedNeed =
    context.normalized_need && typeof context.normalized_need === 'object' ? context.normalized_need : {};
  const governanceHints =
    input.governance_hints && typeof input.governance_hints === 'object' ? input.governance_hints : {};

  return {
    query_text: firstNonEmpty(
      input.query,
      payloadSearch.query,
      normalizedNeed.query,
      context.raw_user_goal,
    ) || null,
    merchant_filters: asStringArray(
      governanceHints.merchant_filters ||
        governanceHints.merchant_filter ||
        payloadSearch.merchant ||
        payloadSearch.merchant_ids ||
        payloadSearch.merchantIds ||
        normalizedNeed.merchant_preferences,
    ),
    category_filters: asStringArray(
      governanceHints.category_filters ||
        governanceHints.category_filter ||
        payloadSearch.category ||
        normalizedNeed.category_constraints,
    ),
    requested_page: asPositiveInteger(
      governanceHints.requested_page || governanceHints.page || payloadSearch.page,
      1,
    ),
    requested_result_depth: normalizeResultDepth(
      governanceHints.requested_result_depth ||
        governanceHints.result_depth ||
        input.requested_result_depth,
      'summary_only',
    ),
    requested_variant_expansions: asPositiveInteger(
      governanceHints.requested_variant_expansions ||
        governanceHints.variant_expansions ||
        payloadSearch.variant_expansions ||
        payloadSearch.variantExpansions,
      payloadSearch.expand_variants === true ? 1 : 0,
    ),
    request_checkout_handoff:
      governanceHints.request_checkout_handoff === true ||
      input.request_checkout_handoff === true ||
      String(input.operation || '').trim() === 'checkout_handoff',
    near_exact_resolution:
      governanceHints.near_exact_resolution === true ||
      governanceHints.query_class === 'near_exact_resolution',
    repeated_merchant_queries: asPositiveInteger(governanceHints.repeated_merchant_queries, 0),
    repeated_category_queries: asPositiveInteger(governanceHints.repeated_category_queries, 0),
    repeated_page_turns: asPositiveInteger(governanceHints.repeated_page_turns, 0),
  };
}

function normalizeInvocationRequest(input = {}) {
  const sourceProfile = input.source_profile || resolveSourceProfile(input.source);
  return {
    invocation_surface: resolveInvocationSurface(input),
    invocation_profile: buildGatewayInvocationProfile(input),
    invocation_context: buildGatewayInvocationContext(input),
    source_profile: sourceProfile,
    source: sourceProfile?.source || String(input.source || '').trim() || null,
    requested_layer: normalizeLayerType(input.requested_layer),
    task_type: normalizeTaskType(input.task_type),
    normalized_operation: String(input.operation || '').trim() || null,
    governance_hints: buildGovernanceHints(input),
  };
}

module.exports = {
  normalizeInvocationRequest,
};
