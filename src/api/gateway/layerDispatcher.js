const { resolveSourceProfile, getDefaultEntryLayerForSource } = require('./sourceProfiles');
const { normalizeLayerType } = require('../../modules/contracts/layerType');
const { normalizeTaskType } = require('../../modules/contracts/taskType');
const { createShoppingContext } = require('../../modules/contracts/shoppingContext');
const { normalizeInvocationRequest } = require('./invocation/normalizeInvocationRequest');
const { resolveAgentIdentity } = require('./access/resolveAgentIdentity');
const { resolveAccessScope } = require('./access/resolveAccessScope');
const { resolveRateLimitProfile } = require('./access/resolveRateLimitProfile');
const { enforceRateLimits } = require('./access/enforceRateLimits');
const { classifyQueryShape } = require('./access/classifyQueryShape');
const { enforceQueryGovernance } = require('./access/enforceQueryGovernance');
const { resolveDefaultQueryGovernancePolicy } = require('./access/policies/defaultGovernancePolicies');
const { mapGovernedGatewayResponse } = require('./responseMapper');
const { handleAuroraBeautyOrchestration } = require('../../modules/orchestration/aurora_beauty');
const { handleShoppingAgentDecisioning } = require('../../modules/decisioning/shopping_agent');
const { handleCommerceResolution } = require('../../modules/execution/commerce_resolution');

const DEFAULT_LAYER_HANDLERS = Object.freeze({
  orchestration: handleAuroraBeautyOrchestration,
  decisioning: handleShoppingAgentDecisioning,
  execution_facing: handleCommerceResolution,
});

function buildCommerceLayerDispatchPlan(input = {}) {
  const normalizedRequest = normalizeInvocationRequest(input);
  const sourceProfile = normalizedRequest.source_profile || input.source_profile || resolveSourceProfile(input.source);
  const requestedLayer = normalizeLayerType(input.requested_layer);
  const entryLayer =
    requestedLayer ||
    getDefaultEntryLayerForSource(sourceProfile?.source || input.source, 'decisioning');
  return {
    source_profile: sourceProfile,
    entry_layer: entryLayer,
    task_type: normalizedRequest.task_type || normalizeTaskType(input.task_type),
    operation: String(input.operation || '').trim() || null,
    invocation_surface: normalizedRequest.invocation_surface,
  };
}

function buildBlockedGatewayResponse(envelope, phase, action, reasonCodes) {
  return {
    layer: null,
    status: 'blocked',
    phase,
    action,
    reason_codes: Array.isArray(reasonCodes) ? reasonCodes : [],
    gateway_governance: {
      action,
      phase,
      reason_codes: Array.isArray(reasonCodes) ? reasonCodes : [],
      invocation_surface: envelope.invocation_context?.invocation_profile?.surface || null,
      principal_type: envelope.agent_identity?.principal_type || null,
      partner_tier: envelope.agent_identity?.partner_tier || null,
    },
  };
}

function prepareGatewayGovernanceEnvelope(input = {}) {
  const normalizedRequest = normalizeInvocationRequest(input);
  const sourceProfile =
    normalizedRequest.source_profile || input.source_profile || resolveSourceProfile(input.source);
  const requestedLayer =
    normalizeLayerType(input.requested_layer) ||
    getDefaultEntryLayerForSource(sourceProfile?.source || input.source, 'decisioning');
  const agentIdentity = resolveAgentIdentity({
    ...input,
    source_profile: sourceProfile,
    invocation_profile: normalizedRequest.invocation_profile,
    invocation_context: normalizedRequest.invocation_context,
  });
  const accessScope = resolveAccessScope({
    ...input,
    agent_identity: agentIdentity,
    source_profile: sourceProfile,
    requested_layer: requestedLayer,
    requested_result_depth: normalizedRequest.governance_hints.requested_result_depth,
  });
  const rateLimitProfile = resolveRateLimitProfile({
    ...input,
    agent_identity: agentIdentity,
  });
  const rateLimitDecision = enforceRateLimits({
    ...input,
    rate_limit_profile: rateLimitProfile,
  });
  const queryClassification = classifyQueryShape({
    normalized_request: {
      ...normalizedRequest,
      requested_layer: requestedLayer,
    },
  });
  const queryGovernancePolicy = resolveDefaultQueryGovernancePolicy(agentIdentity);
  const queryGovernanceDecision = enforceQueryGovernance({
    normalized_request: {
      ...normalizedRequest,
      requested_layer: requestedLayer,
    },
    source_profile: sourceProfile,
    access_scope: accessScope,
    query_governance_policy: queryGovernancePolicy,
    query_classification: queryClassification,
  });

  return {
    normalized_request: normalizedRequest,
    source_profile: sourceProfile,
    entry_layer: requestedLayer,
    task_type: normalizedRequest.task_type || normalizeTaskType(input.task_type),
    operation: String(input.operation || '').trim() || null,
    invocation_context: normalizedRequest.invocation_context,
    agent_identity: agentIdentity,
    access_scope: accessScope,
    rate_limit_profile: rateLimitProfile,
    rate_limit_decision: rateLimitDecision,
    query_classification: queryClassification,
    query_governance_policy: queryGovernancePolicy,
    query_governance_decision: queryGovernanceDecision,
  };
}

async function dispatchCommerceLayer(input = {}, options = {}) {
  const governanceEnvelope = prepareGatewayGovernanceEnvelope(input);
  const plan = {
    source_profile: governanceEnvelope.source_profile,
    entry_layer: governanceEnvelope.entry_layer,
    task_type: governanceEnvelope.task_type,
    operation: governanceEnvelope.operation,
    invocation_surface: governanceEnvelope.normalized_request.invocation_surface,
  };
  const handlers = options.handlers && typeof options.handlers === 'object'
    ? options.handlers
    : DEFAULT_LAYER_HANDLERS;
  const handler = handlers[plan.entry_layer];
  if (typeof handler !== 'function') {
    throw new Error(`COMMERCE_LAYER_HANDLER_MISSING:${plan.entry_layer}`);
  }
  if (governanceEnvelope.rate_limit_decision.allowed !== true) {
    return buildBlockedGatewayResponse(
      governanceEnvelope,
      'rate_limit',
      governanceEnvelope.rate_limit_decision.action,
      governanceEnvelope.rate_limit_decision.reason_codes,
    );
  }
  if (governanceEnvelope.query_governance_decision.allowed !== true) {
    return buildBlockedGatewayResponse(
      governanceEnvelope,
      'query_governance',
      governanceEnvelope.query_governance_decision.action,
      governanceEnvelope.query_governance_decision.reason_codes,
    );
  }
  const context = createShoppingContext({
    ...(input.context && typeof input.context === 'object' ? input.context : {}),
    source_profile: plan.source_profile,
    task_type: plan.task_type,
  });
  const result = await handler({
    ...input,
    source_profile: plan.source_profile,
    task_type: plan.task_type,
    context,
    invocation_context: governanceEnvelope.invocation_context,
    agent_identity: governanceEnvelope.agent_identity,
    access_scope: governanceEnvelope.access_scope,
    rate_limit_profile: governanceEnvelope.rate_limit_profile,
    query_governance_policy: governanceEnvelope.query_governance_policy,
    query_governance: governanceEnvelope.query_governance_decision,
  });
  return mapGovernedGatewayResponse(result, governanceEnvelope);
}

module.exports = {
  DEFAULT_LAYER_HANDLERS,
  buildCommerceLayerDispatchPlan,
  prepareGatewayGovernanceEnvelope,
  dispatchCommerceLayer,
};
