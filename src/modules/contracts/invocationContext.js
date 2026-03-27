const { randomUUID } = require('crypto');
const { buildInvocationProfile, cloneInvocationProfile } = require('./invocationProfile');

const ALLOWED_TOP_LEVEL_KEYS = Object.freeze([
  'request_id',
  'invocation_profile',
  'surface_request_type',
  'normalized_operation',
  'correlation_id',
  'callback',
  'continuation',
  'client_hints',
  'raw_auth_claims',
  'surface_metadata',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clonePlainObject(value) {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function validateInvocationContextShape(input = {}) {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      unknown_top_level_keys: ['<non_object>'],
    };
  }
  const unknownTopLevelKeys = Object.keys(input).filter((key) => !ALLOWED_TOP_LEVEL_KEYS.includes(key));
  return {
    ok: unknownTopLevelKeys.length === 0,
    unknown_top_level_keys: unknownTopLevelKeys,
  };
}

function createInvocationContext(input = {}) {
  const validation = validateInvocationContextShape(input);
  if (!validation.ok) {
    throw new Error(
      `INVOCATION_CONTEXT_INVALID:unknown_top_level_keys=${validation.unknown_top_level_keys.join(',')}`,
    );
  }

  return {
    request_id: String(input.request_id || '').trim() || `inv_${randomUUID()}`,
    invocation_profile: input.invocation_profile
      ? cloneInvocationProfile(input.invocation_profile)
      : buildInvocationProfile({}),
    surface_request_type: String(input.surface_request_type || '').trim() || null,
    normalized_operation: String(input.normalized_operation || '').trim() || null,
    correlation_id: String(input.correlation_id || '').trim() || null,
    callback: clonePlainObject(input.callback),
    continuation: clonePlainObject(input.continuation),
    client_hints: clonePlainObject(input.client_hints),
    raw_auth_claims: clonePlainObject(input.raw_auth_claims),
    surface_metadata: clonePlainObject(input.surface_metadata),
  };
}

module.exports = {
  ALLOWED_TOP_LEVEL_KEYS,
  validateInvocationContextShape,
  createInvocationContext,
};
