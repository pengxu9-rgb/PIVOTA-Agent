const { createInvocationContext } = require('../../../modules/contracts/invocationContext');
const { buildGatewayInvocationProfile } = require('./buildInvocationProfile');

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function buildGatewayInvocationContext(input = {}) {
  const base = input.invocation_context && typeof input.invocation_context === 'object'
    ? input.invocation_context
    : (input.invocationContext && typeof input.invocationContext === 'object'
      ? input.invocationContext
      : {});

  return createInvocationContext({
    ...base,
    request_id: base.request_id || input.request_id || input.requestId,
    invocation_profile: buildGatewayInvocationProfile(input),
    surface_request_type: base.surface_request_type || input.surface_request_type || input.request_type,
    normalized_operation: base.normalized_operation || input.operation || input.normalized_operation,
    correlation_id: base.correlation_id || input.correlation_id || input.correlationId,
    callback: {
      ...clonePlainObject(base.callback),
      ...clonePlainObject(input.callback),
    },
    continuation: {
      ...clonePlainObject(base.continuation),
      ...clonePlainObject(input.continuation),
    },
    client_hints: {
      ...clonePlainObject(base.client_hints),
      ...clonePlainObject(input.client_hints),
    },
    raw_auth_claims: {
      ...clonePlainObject(base.raw_auth_claims),
      ...clonePlainObject(input.raw_auth_claims),
    },
    surface_metadata: {
      ...clonePlainObject(base.surface_metadata),
      ...clonePlainObject(input.surface_metadata),
    },
  });
}

module.exports = {
  buildGatewayInvocationContext,
};
