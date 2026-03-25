const { createShoppingContext } = require('./shoppingContext');
const { normalizeDelegationPlan } = require('./delegationPlan');

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((item) => ({
      role: String(item?.role || '').trim() || 'user',
      content: String(item?.content || '').trim(),
    }))
    .filter((item) => item.content);
}

function createAuroraOrchestrationInput(input = {}) {
  return {
    layer: 'orchestration',
    context: createShoppingContext(input.context || {}),
    messages: normalizeMessages(input.messages),
  };
}

function createAuroraOrchestrationOutput(input = {}) {
  return {
    layer: 'orchestration',
    status: String(input.status || '').trim() || 'delegated',
    updated_context: createShoppingContext(input.updated_context || input.context || {}),
    clarification:
      input.clarification && typeof input.clarification === 'object'
        ? {
            question: String(input.clarification.question || '').trim(),
            reason_code: String(input.clarification.reason_code || '').trim(),
            missing_slots: Array.isArray(input.clarification.missing_slots)
              ? input.clarification.missing_slots.map((item) => String(item || '').trim()).filter(Boolean)
              : [],
          }
        : null,
    delegation_plan: normalizeDelegationPlan(input.delegation_plan),
    next_layer:
      input.next_layer === 'decisioning' || input.next_layer === 'execution_facing'
        ? input.next_layer
        : null,
    orchestration_notes: Array.isArray(input.orchestration_notes)
      ? input.orchestration_notes.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

module.exports = {
  createAuroraOrchestrationInput,
  createAuroraOrchestrationOutput,
};
