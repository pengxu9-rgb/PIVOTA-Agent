const { resolveSourceProfile, getDefaultEntryLayerForSource } = require('./sourceProfiles');
const { normalizeLayerType } = require('../../modules/contracts/layerType');
const { normalizeTaskType } = require('../../modules/contracts/taskType');
const { createShoppingContext } = require('../../modules/contracts/shoppingContext');
const { handleAuroraBeautyOrchestration } = require('../../modules/orchestration/aurora_beauty');
const { handleShoppingAgentDecisioning } = require('../../modules/decisioning/shopping_agent');
const { handleCommerceResolution } = require('../../modules/execution/commerce_resolution');

const DEFAULT_LAYER_HANDLERS = Object.freeze({
  orchestration: handleAuroraBeautyOrchestration,
  decisioning: handleShoppingAgentDecisioning,
  execution_facing: handleCommerceResolution,
});

function buildCommerceLayerDispatchPlan(input = {}) {
  const sourceProfile = input.source_profile || resolveSourceProfile(input.source);
  const requestedLayer = normalizeLayerType(input.requested_layer);
  const entryLayer =
    requestedLayer ||
    getDefaultEntryLayerForSource(sourceProfile?.source || input.source, 'decisioning');
  return {
    source_profile: sourceProfile,
    entry_layer: entryLayer,
    task_type: normalizeTaskType(input.task_type),
    operation: String(input.operation || '').trim() || null,
  };
}

async function dispatchCommerceLayer(input = {}, options = {}) {
  const plan = buildCommerceLayerDispatchPlan(input);
  const handlers = options.handlers && typeof options.handlers === 'object'
    ? options.handlers
    : DEFAULT_LAYER_HANDLERS;
  const handler = handlers[plan.entry_layer];
  if (typeof handler !== 'function') {
    throw new Error(`COMMERCE_LAYER_HANDLER_MISSING:${plan.entry_layer}`);
  }
  const context = createShoppingContext({
    ...(input.context && typeof input.context === 'object' ? input.context : {}),
    source_profile: plan.source_profile,
    task_type: plan.task_type,
  });
  return handler({
    ...input,
    source_profile: plan.source_profile,
    task_type: plan.task_type,
    context,
  });
}

module.exports = {
  DEFAULT_LAYER_HANDLERS,
  buildCommerceLayerDispatchPlan,
  dispatchCommerceLayer,
};
