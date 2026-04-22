const { createShoppingContext } = require('./shoppingContext');
const { normalizeDelegationPlan } = require('./delegationPlan');
const { createBeautyExpertV1Response } = require('./beautyExpertContracts');

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
    prompt_intent: String(input.prompt_intent || '').trim() || null,
    conversation_progress: String(input.conversation_progress || '').trim() || null,
    early_decision: String(input.early_decision || '').trim() || null,
    decision_owner: String(input.decision_owner || '').trim() || 'aurora_orchestration',
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
    beauty_expert_v1:
      input.beauty_expert_v1 && typeof input.beauty_expert_v1 === 'object'
        ? createBeautyExpertV1Response(input.beauty_expert_v1)
        : null,
    next_actions: Array.isArray(input.next_actions)
      ? input.next_actions
          .map((action) =>
            action && typeof action === 'object'
              ? {
                  type: String(action.type || action.action_type || '').trim(),
                  ...(String(action.label || '').trim() ? { label: String(action.label || '').trim() } : {}),
                  ...(action.payload && typeof action.payload === 'object' ? { payload: JSON.parse(JSON.stringify(action.payload)) } : {}),
                }
              : null,
          )
          .filter((action) => action && action.type)
      : [],
    orchestration_notes: Array.isArray(input.orchestration_notes)
      ? input.orchestration_notes.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

module.exports = {
  createAuroraOrchestrationInput,
  createAuroraOrchestrationOutput,
};
