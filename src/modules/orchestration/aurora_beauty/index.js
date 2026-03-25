const {
  createAuroraOrchestrationInput,
  createAuroraOrchestrationOutput,
} = require('../../contracts/auroraContracts');

async function handleAuroraBeautyOrchestration(input = {}) {
  const normalized = createAuroraOrchestrationInput(input);
  return createAuroraOrchestrationOutput({
    context: normalized.context,
    status: normalized.messages.length > 0 ? 'delegated' : 'completed',
    delegation_plan: normalized.messages.length > 0 ? 'call_decisioning' : 'stay_in_layer',
    next_layer: normalized.messages.length > 0 ? 'decisioning' : null,
    orchestration_notes: ['milestone0_orchestration_facade'],
  });
}

module.exports = {
  handleAuroraBeautyOrchestration,
};
