const { createShoppingContext } = require('./shoppingContext');
const { normalizeDelegationPlan } = require('./delegationPlan');

function normalizeRankedCandidates(list) {
  if (!Array.isArray(list)) return [];
  return list.map((candidate) => ({
    product_ref:
      candidate && typeof candidate.product_ref === 'object' && candidate.product_ref
        ? { ...candidate.product_ref }
        : {},
    variant_refs: Array.isArray(candidate?.variant_refs)
      ? candidate.variant_refs.map((item) => ({ ...(item || {}) }))
      : [],
    score: Number(candidate?.score || 0) || 0,
    confidence: Number(candidate?.confidence || 0) || 0,
    matched_constraints: Array.isArray(candidate?.matched_constraints)
      ? candidate.matched_constraints.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    rationale: Array.isArray(candidate?.rationale)
      ? candidate.rationale.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  }));
}

function createShoppingAgentDecisioningInput(input = {}) {
  return {
    layer: 'decisioning',
    context: createShoppingContext(input.context || {}),
  };
}

function createShoppingAgentDecisioningOutput(input = {}) {
  return {
    layer: 'decisioning',
    status: String(input.status || '').trim() || 'no_match',
    updated_context: createShoppingContext(input.updated_context || input.context || {}),
    ranked_candidates: normalizeRankedCandidates(input.ranked_candidates),
    compare_matrix: Array.isArray(input.compare_matrix) ? input.compare_matrix.map((item) => ({ ...(item || {}) })) : [],
    delegation_plan: normalizeDelegationPlan(input.delegation_plan),
  };
}

module.exports = {
  createShoppingAgentDecisioningInput,
  createShoppingAgentDecisioningOutput,
};
