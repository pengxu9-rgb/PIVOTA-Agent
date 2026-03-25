const { createShoppingContext } = require('./shoppingContext');

function createExecutionFacingInput(input = {}) {
  return {
    layer: 'execution_facing',
    context: createShoppingContext(input.context || {}),
    requested_resolution: String(input.requested_resolution || '').trim() || 'product',
  };
}

function createExecutionFacingOutput(input = {}) {
  return {
    layer: 'execution_facing',
    status: String(input.status || '').trim() || 'not_resolved',
    updated_context: createShoppingContext(input.updated_context || input.context || {}),
    resolved_product:
      input.resolved_product && typeof input.resolved_product === 'object'
        ? { ...input.resolved_product }
        : null,
    resolved_variant:
      input.resolved_variant && typeof input.resolved_variant === 'object'
        ? { ...input.resolved_variant }
        : null,
    resolved_offer:
      input.resolved_offer && typeof input.resolved_offer === 'object'
        ? { ...input.resolved_offer }
        : null,
    serviceability:
      input.serviceability && typeof input.serviceability === 'object'
        ? { ...input.serviceability }
        : null,
    checkout_handoff:
      input.checkout_handoff && typeof input.checkout_handoff === 'object'
        ? { ...input.checkout_handoff }
        : null,
    blockers: Array.isArray(input.blockers)
      ? input.blockers.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
  };
}

module.exports = {
  createExecutionFacingInput,
  createExecutionFacingOutput,
};
