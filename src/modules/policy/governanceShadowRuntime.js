function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function collectGovernanceReasonCodes(gatewayGovernanceAudit = null) {
  if (!isPlainRecord(gatewayGovernanceAudit)) return [];
  return uniqueStrings(
    []
      .concat(Array.isArray(gatewayGovernanceAudit.reason_codes) ? gatewayGovernanceAudit.reason_codes : [])
      .concat(
        Array.isArray(gatewayGovernanceAudit.query_governance?.reason_codes)
          ? gatewayGovernanceAudit.query_governance.reason_codes
          : [],
      ),
  );
}

function applyGovernanceShadowRuntimeMetadata({
  metadata = {},
  gatewayGovernanceAudit = null,
  operation = '',
} = {}) {
  const normalizedMetadata = isPlainRecord(metadata) ? { ...metadata } : {};
  const normalizedOperation = String(operation || '').trim().toLowerCase();
  if (!['find_products', 'find_products_multi'].includes(normalizedOperation)) {
    return normalizedMetadata;
  }
  if (!isPlainRecord(gatewayGovernanceAudit)) return normalizedMetadata;

  const mode = String(gatewayGovernanceAudit.mode || '').trim().toLowerCase();
  const observedAction = String(gatewayGovernanceAudit.observed_action || '').trim().toLowerCase();
  const invocationSurface = String(gatewayGovernanceAudit.invocation?.surface || '').trim().toLowerCase();
  const source = String(normalizedMetadata.source || '').trim().toLowerCase();
  const governanceReasonCodes = collectGovernanceReasonCodes(gatewayGovernanceAudit);
  const hasLayerNotAllowed = governanceReasonCodes.includes('layer_not_allowed');
  const auroraOrchestrationSource = source === 'aurora-bff' || source === 'aurora-chatbox';

  if (
    mode !== 'shadow' ||
    observedAction !== 'block' ||
    gatewayGovernanceAudit.would_enforce !== true ||
    invocationSurface !== 'direct_api' ||
    !auroraOrchestrationSource ||
    !hasLayerNotAllowed
  ) {
    return normalizedMetadata;
  }

  const existingRuntime =
    normalizedMetadata.governance_shadow_runtime &&
    isPlainRecord(normalizedMetadata.governance_shadow_runtime)
      ? normalizedMetadata.governance_shadow_runtime
      : {};

  return {
    ...normalizedMetadata,
    source: 'search',
    governance_shadow_runtime: {
      ...existingRuntime,
      source_override_applied: true,
      source_override_from: source,
      source_override_to: 'search',
      reason: 'layer_not_allowed_shadow_direct_api_stable_search',
      reason_codes: governanceReasonCodes,
      invocation_surface: invocationSurface,
    },
  };
}

module.exports = {
  applyGovernanceShadowRuntimeMetadata,
};
