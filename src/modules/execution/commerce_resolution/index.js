const {
  createExecutionFacingInput,
  createExecutionFacingOutput,
} = require('../../contracts/executionFacingContracts');

async function handleCommerceResolution(input = {}) {
  const normalized = createExecutionFacingInput(input);
  return createExecutionFacingOutput({
    context: normalized.context,
    status: 'not_resolved',
    blockers: ['milestone0_execution_facade_not_yet_bound'],
  });
}

module.exports = {
  handleCommerceResolution,
};
