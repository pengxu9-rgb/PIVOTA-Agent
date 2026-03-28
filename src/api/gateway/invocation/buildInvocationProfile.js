const { buildInvocationProfile } = require('../../../modules/contracts/invocationProfile');
const { resolveInvocationSurface } = require('./resolveInvocationSurface');

function buildGatewayInvocationProfile(input = {}) {
  return buildInvocationProfile({
    ...input.invocation_profile,
    ...input.invocationProfile,
    ...input,
    surface: resolveInvocationSurface(input),
  });
}

module.exports = {
  buildGatewayInvocationProfile,
};
