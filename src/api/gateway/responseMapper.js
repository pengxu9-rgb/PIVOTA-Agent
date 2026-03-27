const { shapeGovernedResult } = require('./access/shapeGovernedResult');

function mapGovernedGatewayResponse(result = {}, envelope = {}) {
  return shapeGovernedResult(result, envelope);
}

function resolveGatewayGovernanceShadowMode(routeContext = {}, defaultShadowMode = true) {
  if (routeContext && routeContext.gateway_governance_shadow_mode === true) return true;
  if (routeContext && routeContext.gateway_governance_shadow_mode === false) return false;
  return defaultShadowMode;
}

function mergeInvokeGatewayAuditMetadata(body, audit) {
  if (!audit || !body || typeof body !== 'object' || Array.isArray(body)) return body;
  const existingMetadata =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata
      : {};

  return {
    ...body,
    metadata: {
      ...existingMetadata,
      gateway_invocation: audit.invocation,
      gateway_governance: {
        mode: audit.mode,
        source: audit.source,
        entry_layer: audit.entry_layer,
        task_type: audit.task_type,
        effective_action: audit.effective_action,
        observed_phase: audit.observed_phase,
        observed_action: audit.observed_action,
        would_enforce: audit.would_enforce,
        reason_codes: audit.reason_codes,
        access: audit.access,
        rate_limit: audit.rate_limit,
        query_governance: audit.query_governance,
      },
    },
  };
}

module.exports = {
  mapGovernedGatewayResponse,
  mergeInvokeGatewayAuditMetadata,
  resolveGatewayGovernanceShadowMode,
};
