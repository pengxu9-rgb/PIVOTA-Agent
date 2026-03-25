const {
  createShoppingAgentDecisioningInput,
  createShoppingAgentDecisioningOutput,
} = require('../../contracts/shoppingAgentContracts');

async function handleShoppingAgentDecisioning(input = {}) {
  const normalized = createShoppingAgentDecisioningInput(input);
  return createShoppingAgentDecisioningOutput({
    context: normalized.context,
    status: 'no_match',
    ranked_candidates: [],
    compare_matrix: [],
    delegation_plan: 'stay_in_layer',
  });
}

module.exports = {
  handleShoppingAgentDecisioning,
};
