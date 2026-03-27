const { normalizeInvocationRequest } = require('../invocation/normalizeInvocationRequest');

function createGatewayAdapter(surface, adapterMetadata = {}) {
  return {
    surface,
    normalizeEnvelope(input = {}) {
      return normalizeInvocationRequest({
        ...input,
        invocation_surface: surface,
        surface_metadata: {
          adapter_surface: surface,
          ...adapterMetadata,
          ...(input.surface_metadata && typeof input.surface_metadata === 'object' ? input.surface_metadata : {}),
        },
      });
    },
  };
}

module.exports = {
  createGatewayAdapter,
};
